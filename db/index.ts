import 'server-only';
import { env } from 'cloudflare:workers';
import { movies as starterMovies, type Movie, type PublicationStatus, type RightsStatus } from '../lib/movies.ts';
import { allLanguages } from '../lib/catalogue-options.ts';
import { requiresRightsReset, type AdminMovieInput } from '../lib/admin/movie-input.ts';
import { RIGHTS_DEFAULT_REFERENCE, RIGHTS_DEFAULT_REVIEWER } from '../lib/admin/rights-dates.ts';
import type { ChatGPTUser } from '../app/chatgpt-auth';
import { logSecurityEvent } from '../lib/security/security-events';
import { assertLegalTransition } from '../scripts/ingest-state.mjs';
import { parseCastJson } from '../lib/cast.ts';

type Bindings = { DB?: D1Database; MEDIA?: R2Bucket };
type StoredDownloadSource = NonNullable<Movie['downloadSources']>[number] & {
  descriptorKey?: string;
  r2StorageKey?: string;
  r2Bytes?: number;
};
type StoredEpisode = NonNullable<Movie['episodes']>[number];

type MovieRow = {
  id: number;
  slug: string;
  title: string;
  tagline: string;
  description: string;
  release_year: number;
  runtime: string;
  rating: number;
  content_type: 'movie' | 'series';
  genre: string;
  director: string;
  cast_json: string;
  languages_json: string;
  poster: string;
  backdrop: string;
  featured: number;
  publication_status: PublicationStatus;
  rights_status: RightsStatus;
  rights_verified_at: string | null;
  rights_expires_at: string | null;
  rights_reviewer: string | null;
  rights_reference: string | null;
  official_watch_url: string | null;
  telegram_url: string | null;
  telegram_channel: string | null;
  subtitle_url: string | null;
  download_sources_json: string;
  streaming_sources_json: string;
  episodes_json: string;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  imdb_id: string | null;
  storage_key: string | null;
  ingest_status: string;
  r2_720p_key: string | null;
  r2_1080p_key: string | null;
  enrichment_status: string;
  enrichment_error: string | null;
};

export type AdminMovie = Movie & {
  castWarnings?: string[];
  id: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  imdbId?: string;
  storageKey?: string;
  ingestStatus?: string;
  ingest_status?: string | null;
  r2_720p_key?: string | null;
  r2_1080p_key?: string | null;
  enrichmentStatus?: string;
  enrichmentError?: string | null;
};

export type AuditEvent = {
  id: number;
  action: string;
  movieSlug: string | null;
  changedFields: string[];
  actorEmail: string;
  createdAt: string;
};
export type ApprovedDomain = { id: number; domain: string; active: boolean; createdAt: string };
export type SourceReport = { id: number; movieSlug: string; sourceKind: 'stream' | 'download'; sourceLabel: string; sourceUrl: string; reason: string; details: string; status: 'open' | 'disabled' | 'dismissed'; createdAt: string };
export type MovieComment = { id: number; movieSlug: string; displayName: string; body: string; status: 'visible' | 'pending' | 'hidden'; createdAt: string };

function bindings(): Bindings { return env as unknown as Bindings; }

export function getDatabase(): D1Database {
  const database = bindings().DB;
  if (!database) throw new Error('DATABASE_BINDING_UNAVAILABLE');
  return database;
}

export function getMediaBucket(): R2Bucket {
  const bucket = bindings().MEDIA;
  if (!bucket) throw new Error('MEDIA_BINDING_UNAVAILABLE');
  return bucket;
}

type MovieMediaRow = {
  poster: string;
  backdrop: string;
  subtitle_url: string | null;
  cast_json: string;
  episodes_json: string;
  download_sources_json: string;
  streaming_sources_json: string;
  storage_key: string | null;
  r2_storage_key: string | null;
};

const SAFE_R2_CLEANUP_KEY = /^(?:artworks\/\d+\/(?:poster|backdrop)\.jpg|assets\/[a-f0-9-]{36}\/(?:data\.bin|720p\.mp4|1080p\.mp4)|movie-art\/[a-f0-9-]{36}\.(?:jpg|png)|(?:posters|backdrops)\/tt\d{7,10}\.(?:jpg|png)|cast\/tt\d{7,10}-[1-6]\.(?:jpg|png)|subtitles\/[a-f0-9-]{36}\.(?:srt|vtt|zip|7z)|descriptors\/tt\d{7,10}-(?:720p|1080p)\.torrent)$/;

function addR2CleanupKey(keys: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const candidate = value.startsWith('/media/') ? value.slice('/media/'.length) : value.startsWith('https://flixlyra.com/media/') ? value.slice('https://flixlyra.com/media/'.length) : value;
  if (SAFE_R2_CLEANUP_KEY.test(candidate)) keys.add(candidate);
}

function collectNestedR2Keys(keys: Set<string>, value: unknown, depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    addR2CleanupKey(keys, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) collectNestedR2Keys(keys, item, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>).slice(0, 100)) collectNestedR2Keys(keys, item, depth + 1);
  }
}

export function collectMovieR2Keys(row: MovieMediaRow): string[] {
  const keys = new Set<string>();
  for (const value of [row.poster, row.backdrop, row.subtitle_url, row.storage_key, row.r2_storage_key]) addR2CleanupKey(keys, value);
  for (const json of [row.cast_json, row.episodes_json, row.download_sources_json, row.streaming_sources_json]) {
    try { collectNestedR2Keys(keys, JSON.parse(json || 'null')); } catch { /* Ignore malformed legacy JSON. */ }
  }
  return [...keys];
}

function safeStringArray(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value.slice(0, 20) : [];
  } catch { return []; }
}
function safeLanguages(json: string): string[] {
  return [...new Set(safeStringArray(json)
    .flatMap((value) => value.split(/[,;|/]+/).map((item) => item.normalize('NFKC').trim()).filter(Boolean)))]
    .filter((value) => allLanguages.includes(value))
    .slice(0, 20);
}
function safeStreamingSources(json: string): { label: string; url: string }[] { try { const value: unknown = JSON.parse(json); return Array.isArray(value) ? value.filter((item): item is { label: string; url: string } => Boolean(item && typeof item === 'object' && typeof (item as {label?:unknown}).label === 'string' && typeof (item as {url?:unknown}).url === 'string')).slice(0, 8) : []; } catch { return []; } }
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isStoredDownloadSource(value: unknown): value is StoredDownloadSource {
  return isRecord(value) && ['label', 'quality', 'resolution', 'size', 'url']
    .every((key) => typeof value[key] === 'string') &&
    (value.descriptorKey === undefined || typeof value.descriptorKey === 'string') &&
    (value.r2StorageKey === undefined || typeof value.r2StorageKey === 'string') &&
    (value.r2Bytes === undefined || Number.isSafeInteger(value.r2Bytes));
}
function safeSources(json: string): StoredDownloadSource[] {
  try {
    const parsed: unknown = JSON.parse(json);
    const value: unknown[] = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.sources)
        ? parsed.sources
        : [];
    return value.filter(isStoredDownloadSource).slice(0, 12);
  } catch { return []; }
}
function preserveManagedDownloadSources(currentJson: string, incoming: AdminMovieInput['downloadSources']): StoredDownloadSource[] {
  const existing = safeSources(currentJson);
  const managedByQuality = new Map(existing
    .filter((source) => source.descriptorKey || source.r2StorageKey || Number.isSafeInteger(source.r2Bytes))
    .map((source) => [String(source.quality ?? source.resolution).toLowerCase(), source] as const));
  const incomingQualities = new Set(incoming.map((source) => String(source.quality ?? source.resolution).toLowerCase()));
  const merged = incoming.map((source) => {
    const managed = managedByQuality.get(String(source.quality ?? source.resolution).toLowerCase());
    if (!managed) return source;
    return {
      ...source,
      ...(managed.descriptorKey ? { descriptorKey: managed.descriptorKey } : {}),
      ...(managed.r2StorageKey ? { r2StorageKey: managed.r2StorageKey } : {}),
      ...(Number.isSafeInteger(managed.r2Bytes) ? { r2Bytes: managed.r2Bytes } : {}),
    };
  }) as StoredDownloadSource[];
  for (const [quality, managed] of managedByQuality) {
    if (!incomingQualities.has(quality)) merged.push(managed);
  }
  return merged;
}
function isStoredEpisode(value: unknown): value is StoredEpisode {
  return isRecord(value) && Number.isInteger(value.season) && Number.isInteger(value.episode) && typeof value.title === 'string';
}
function safeEpisodes(json: string): StoredEpisode[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter(isStoredEpisode).slice(0, 500) : [];
  } catch { return []; }
}

function availableQualities(row: MovieRow): ('720p' | '1080p')[] {
  const sources = safeSources(row.download_sources_json);
  const qualities = (['720p', '1080p'] as const).filter((quality) => sources.some((source) =>
    String(source.quality ?? source.resolution).toLowerCase() === quality &&
    typeof source.r2StorageKey === 'string' &&
    typeof source.r2Bytes === 'number' &&
    Number.isSafeInteger(source.r2Bytes) &&
    source.r2Bytes > 0));
  return qualities;
}

function rowToMovie(row: MovieRow): AdminMovie {
  const castResult = parseCastJson(row.cast_json);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    tagline: row.tagline,
    description: row.description,
    year: row.release_year,
    runtime: row.runtime,
    rating: row.rating,
    contentType: row.content_type === 'series' ? 'series' : 'movie',
    genre: row.genre,
    director: row.director,
    cast: castResult.members,
    castWarnings: castResult.parseError ? ['CAST_PARSE_ERROR'] : castResult.members.some((member) => !member.image && !member.profileUrl && !member.profileR2Key) ? ['CAST_IMAGE_MISSING'] : [],
    languages: safeLanguages(row.languages_json),
    poster: row.poster,
    backdrop: row.backdrop,
    featured: row.featured === 1,
    publicationStatus: row.publication_status,
    rightsStatus: row.rights_status,
    rightsVerifiedAt: row.rights_verified_at ?? undefined,
    rightsExpiresAt: row.rights_expires_at ?? undefined,
    rightsReviewer: row.rights_reviewer ?? undefined,
    rightsReference: row.rights_reference ?? undefined,
    officialWatchUrl: row.official_watch_url ?? undefined,
    telegramUrl: row.telegram_url ?? undefined,
    telegramChannel: row.telegram_channel ?? undefined,
    subtitleUrl: row.subtitle_url ?? undefined,
    downloadSources: safeSources(row.download_sources_json),
    downloadStatus: (() => { try { const parsed: unknown = JSON.parse(row.download_sources_json); return isRecord(parsed) && parsed.status === 'pending' ? 'pending' : 'available'; } catch { return 'pending'; } })(),
    streamingSources: safeStreamingSources(row.streaming_sources_json),
    episodes: safeEpisodes(row.episodes_json),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    imdbId: row.imdb_id ?? undefined,
    storageKey: row.storage_key ?? undefined,
    ingestStatus: row.ingest_status,
    ingest_status: row.ingest_status,
    // Keep the snake_case fields present in JSON even when a quality is absent.
    // `undefined` would be omitted by JSON serialization, making the UI unable
    // to distinguish an absent quality from an incomplete API payload.
    r2_720p_key: row.r2_720p_key ?? null,
    r2_1080p_key: row.r2_1080p_key ?? null,
    enrichmentStatus: row.enrichment_status,
    enrichmentError: row.enrichment_error,
    availableQualities: availableQualities(row),
  };
}

const MOVIE_COLUMNS = `id, slug, title, tagline, description, release_year, runtime, rating, content_type,
  genre, director, cast_json, languages_json, poster, backdrop, featured,
  publication_status, rights_status, rights_verified_at, rights_expires_at,
  rights_reviewer, rights_reference, official_watch_url, telegram_url,
  telegram_channel, subtitle_url, download_sources_json, streaming_sources_json, episodes_json, revision, created_by, updated_by, created_at, updated_at, imdb_id, storage_key, ingest_status, enrichment_status, enrichment_error,
  (SELECT COALESCE(json_extract(source.value, '$.r2StorageKey'), json_extract(source.value, '$.r2_storage_key'))
   FROM json_each(CASE WHEN json_type(download_sources_json) = 'array' THEN download_sources_json ELSE COALESCE(json_extract(download_sources_json, '$.sources'), '[]') END) AS source
   WHERE lower(COALESCE(json_extract(source.value, '$.quality'), json_extract(source.value, '$.resolution'), '')) = '720p' LIMIT 1) AS r2_720p_key,
  (SELECT COALESCE(json_extract(source.value, '$.r2StorageKey'), json_extract(source.value, '$.r2_storage_key'))
   FROM json_each(CASE WHEN json_type(download_sources_json) = 'array' THEN download_sources_json ELSE COALESCE(json_extract(download_sources_json, '$.sources'), '[]') END) AS source
   WHERE lower(COALESCE(json_extract(source.value, '$.quality'), json_extract(source.value, '$.resolution'), '')) = '1080p' LIMIT 1) AS r2_1080p_key`;

export async function listPublishedMovies(): Promise<Movie[]> {
  try {
    const database = getDatabase();
    const [setting, records] = await database.batch([
      database.prepare("SELECT value FROM app_settings WHERE key = 'catalogue_initialized' LIMIT 1"),
      database.prepare(`SELECT ${MOVIE_COLUMNS} FROM movies WHERE publication_status = 'published' ORDER BY featured DESC, updated_at DESC LIMIT 500`),
    ]);
    const initialized = (setting.results[0] as { value?: string } | undefined)?.value === '1';
    if (!initialized) return starterMovies.filter((movie) => movie.publicationStatus === 'published');
    return (records.results as unknown as MovieRow[]).map(rowToMovie);
  } catch {
    logSecurityEvent('catalogue_database_unavailable', 'error');
    // Local development can render the starter catalogue without Workers bindings.
    // Production fails closed so a database outage cannot resurrect archived titles.
    return process.env.NODE_ENV === 'production'
      ? []
      : starterMovies.filter((movie) => movie.publicationStatus === 'published');
  }
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

type PublishedMoviePageFilters = {
  query: string;
  genre: string;
  language: string;
  contentType: string;
  page: number;
  limit: number;
};

export async function searchPublishedMovies(filters: PublishedMoviePageFilters): Promise<{ movies: Movie[]; total: number } | undefined> {
  try {
    const database = getDatabase();
    const setting = await database.prepare("SELECT value FROM app_settings WHERE key = 'catalogue_initialized' LIMIT 1").first<{ value?: string }>();
    if (setting?.value !== '1') return undefined;

    const where = ["publication_status = 'published'"];
    const params: Array<string | number> = [];
    if (filters.query) {
      const needle = `%${escapeSqlLike(filters.query)}%`;
      where.push('(lower(title) LIKE ? ESCAPE char(92) OR lower(director) LIKE ? ESCAPE char(92) OR lower(cast_json) LIKE ? ESCAPE char(92))');
      params.push(needle, needle, needle);
    }
    if (filters.genre && filters.genre !== 'all') {
      where.push("(',' || lower(replace(genre, ' ', '')) || ',') LIKE ? ESCAPE char(92)");
      params.push(`%,${escapeSqlLike(filters.genre.replaceAll(' ', ''))},%`);
    }
    if (filters.language && filters.language !== 'all languages') {
      where.push("EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(languages_json) = 'array' THEN languages_json ELSE '[]' END) AS language WHERE lower(language.value) = ?)");
      params.push(filters.language);
    }
    if (filters.contentType && filters.contentType !== 'all') {
      where.push('content_type = ?');
      params.push(filters.contentType);
    }
    const predicate = where.join(' AND ');
    const offset = (filters.page - 1) * filters.limit;
    const [count, rows] = await database.batch([
      database.prepare(`SELECT COUNT(*) AS total FROM movies WHERE ${predicate}`).bind(...params),
      database.prepare(`SELECT ${MOVIE_COLUMNS} FROM movies WHERE ${predicate} ORDER BY featured DESC, updated_at DESC LIMIT ? OFFSET ?`).bind(...params, filters.limit, offset),
    ]);
    return {
      movies: (rows.results as unknown as MovieRow[]).map(rowToMovie),
      total: Number((count.results[0] as { total?: number } | undefined)?.total ?? 0),
    };
  } catch {
    logSecurityEvent('catalogue_database_unavailable', 'error');
    return undefined;
  }
}
export async function getPublishedMovie(slug: string): Promise<Movie | undefined> {
  try {
    const row = await getDatabase()
      .prepare(`SELECT ${MOVIE_COLUMNS} FROM movies WHERE slug = ? AND publication_status = 'published' LIMIT 1`)
      .bind(slug)
      .first<MovieRow>();
    return row ? rowToMovie(row) : undefined;
  } catch {
    logSecurityEvent('catalogue_database_unavailable', 'error');
    return undefined;
  }
}

export async function initializeStarterCatalogue(user: ChatGPTUser): Promise<void> {
  const database = getDatabase();
  const setting = await database.prepare("SELECT value FROM app_settings WHERE key = 'catalogue_initialized' LIMIT 1").first<{ value: string }>();
  if (setting?.value === '1') return;
  const now = new Date().toISOString();
  const statements = starterMovies.map((movie) => database.prepare(`INSERT OR IGNORE INTO movies (
    slug, title, tagline, description, release_year, runtime, rating, content_type, genre,
    director, cast_json, languages_json, poster, backdrop, featured,
    publication_status, rights_status, rights_verified_at, rights_expires_at,
    rights_reviewer, rights_reference, official_watch_url, telegram_url,
    telegram_channel, subtitle_url, download_sources_json, streaming_sources_json, episodes_json, revision, created_by, updated_by, created_at, updated_at
  ) VALUES (${Array.from({ length: 33 }, () => '?').join(', ')})`).bind(
    ...movieValues(movie, user.userId, now),
  ));
  statements.push(
    database.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('catalogue_initialized', '1', ?) ON CONFLICT(key) DO NOTHING").bind(now),
    auditStatement(database, user, 'starter_catalogue_initialized', null, null, ['starter_catalogue'], now),
  );
  await database.batch(statements);
}

export async function listAdminMovies(): Promise<AdminMovie[]> {
  const result = await getDatabase().prepare(`SELECT ${MOVIE_COLUMNS} FROM movies ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 500`).all<MovieRow>();
  return result.results.map(rowToMovie);
}

export async function listAuditEvents(): Promise<AuditEvent[]> {
  const result = await getDatabase().prepare(`SELECT id, action, movie_slug, changed_fields_json, actor_email, created_at
    FROM audit_events ORDER BY id DESC LIMIT 100`).all<{
      id: number; action: string; movie_slug: string | null; changed_fields_json: string; actor_email: string; created_at: string;
    }>();
  return result.results.map((row) => ({
    id: row.id,
    action: row.action,
    movieSlug: row.movie_slug,
    changedFields: safeStringArray(row.changed_fields_json),
    actorEmail: row.actor_email,
    createdAt: row.created_at,
  }));
}

function movieValues(movie: Movie | AdminMovieInput, actorId: string, now: string): unknown[] {
  const sources = movie.downloadSources ?? [];
  return [
    movie.slug, movie.title, movie.tagline, movie.description, movie.year,
    movie.runtime, movie.rating, movie.contentType ?? 'movie', movie.genre, movie.director, JSON.stringify(movie.cast),
    JSON.stringify(movie.languages), movie.poster, movie.backdrop, movie.featured ? 1 : 0,
    movie.publicationStatus, movie.rightsStatus, movie.rightsVerifiedAt ?? null,
    movie.rightsExpiresAt ?? null, movie.rightsReviewer ?? null, movie.rightsReference ?? null,
    movie.officialWatchUrl ?? null, movie.telegramUrl ?? null, movie.telegramChannel ?? null, movie.subtitleUrl ?? null, JSON.stringify({ status: movie.downloadStatus ?? (sources.length ? 'available' : 'pending'), sources }), JSON.stringify(movie.streamingSources ?? []), JSON.stringify(movie.episodes ?? []),
    1, actorId, actorId, now, now,
  ];
}


export async function listAdminComments(): Promise<MovieComment[]> {
  const result = await getDatabase().prepare(`SELECT id, movie_slug, display_name, body, status, created_at
    FROM movie_comments ORDER BY id DESC LIMIT 200`).all<{
      id: number; movie_slug: string; display_name: string; body: string;
      status: 'visible' | 'pending' | 'hidden'; created_at: string;
    }>();
  return result.results.map((row) => ({
    id: row.id,
    movieSlug: row.movie_slug,
    displayName: row.display_name,
    body: row.body,
    status: row.status,
    createdAt: row.created_at,
  }));
}

export async function moderateMovieComment(id: number, status: MovieComment['status'], user: ChatGPTUser): Promise<boolean> {
  const database = getDatabase();
  const current = await database.prepare('SELECT movie_slug FROM movie_comments WHERE id = ? LIMIT 1').bind(id).first<{ movie_slug: string }>();
  if (!current) return false;
  const result = await database.prepare('UPDATE movie_comments SET status = ? WHERE id = ?').bind(status, id).run();
  if (result.meta.changes !== 1) return false;
  await auditStatement(database, user, 'comment_moderated', null, current.movie_slug, [`comment:${id}`, `status:${status}`], new Date().toISOString()).run();
  return true;
}
function auditStatement(database: D1Database, user: ChatGPTUser, action: string, movieId: number | null, slug: string | null, fields: string[], now: string): D1PreparedStatement {
  return database.prepare(`INSERT INTO audit_events
    (actor_user_id, actor_email, action, movie_id, movie_slug, changed_fields_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
      user.userId, user.email, action, movieId, slug, JSON.stringify(fields), now,
    );
}

export async function recordYtsDispatchEvent(movieIds: number[], user: ChatGPTUser, status: 'DISPATCH_PENDING' | 'DISPATCH_SUCCEEDED' | 'DISPATCH_FAILED', details: Record<string, string | number | null>): Promise<void> {
  const database = getDatabase();
  const now = new Date().toISOString();
  const fields = Object.entries({ dispatch_status: status, ...details })
    .map(([key, value]) => key + ':' + String(value ?? '').slice(0, 240));
  await database.batch(movieIds.map((movieId) => auditStatement(database, user, 'yts_dispatch_' + status.toLowerCase(), movieId, null, fields, now)));
}
export async function createAdminMovie(input: AdminMovieInput, user: ChatGPTUser): Promise<number> {
  const database = getDatabase();
  const now = new Date().toISOString();
  const result = await database.prepare(`INSERT INTO movies (
    slug, title, tagline, description, release_year, runtime, rating, content_type, genre,
    director, cast_json, languages_json, poster, backdrop, featured,
    publication_status, rights_status, rights_verified_at, rights_expires_at,
    rights_reviewer, rights_reference, official_watch_url, telegram_url,
    telegram_channel, subtitle_url, download_sources_json, streaming_sources_json, episodes_json, revision, created_by, updated_by, created_at, updated_at
  ) VALUES (${Array.from({ length: 33 }, () => '?').join(', ')})`).bind(
    ...movieValues(input, user.userId, now),
  ).run();
  const movieId = Number(result.meta.last_row_id);
  await auditStatement(database, user, 'movie_created', movieId, input.slug, ['all_fields'], now).run();
  logSecurityEvent('admin_movie_changed', 'info', { action: 'created', slug: input.slug });
  return movieId;
}

export type YtsIngestRecord = {
  imdbId: string;
  title: string;
  year: number;
  synopsis?: string;
  rating?: number;
  runtime?: string;
  tagline?: string;
  genre?: string;
  director?: string;
  officialWatchUrl?: string;
  languages?: string[];
  poster?: string;
  backdrop?: string;
  cast?: (string | { actor: string; character?: string; image?: string })[];
  storageKey: string | null;
  torrents: Array<{ url: string; quality: string; resolution: string; size: string; label: string; descriptorKey?: string }>;
};

export async function upsertYtsIngestMovie(record: YtsIngestRecord, user: ChatGPTUser): Promise<number> {
  const database = getDatabase();
  const now = new Date().toISOString();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const slugBase = record.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'movie-' + record.imdbId;
  const existing = await database.prepare('SELECT id, slug, ingest_status, transfer_token, transfer_lease_until, download_sources_json, storage_key, poster, backdrop, rights_status, rights_verified_at, rights_expires_at, rights_reviewer, rights_reference, enrichment_status, enrichment_error FROM movies WHERE imdb_id = ? LIMIT 1').bind(record.imdbId).first<{
    id: number; slug: string; ingest_status: string; transfer_token: string | null; transfer_lease_until: number | null;
    download_sources_json: string; storage_key: string | null; poster: string; backdrop: string;
    rights_status: RightsStatus; rights_verified_at: string | null; rights_expires_at: string | null;
    rights_reviewer: string | null; rights_reference: string | null; enrichment_status: string; enrichment_error: string | null;
  }>();
  const existingSources = existing ? safeSources(existing.download_sources_json) : [];
  const verifiedQualities = new Set(existingSources
    .filter((source) => source.r2StorageKey && Number.isSafeInteger(source.r2Bytes) && Number(source.r2Bytes) > 0)
    .map((source) => String(source.quality ?? source.resolution).toLowerCase()));
  const genre = record.genre?.trim() || 'Drama';
  const director = record.director?.trim() || 'Pending editorial review';
  const cast = record.cast?.length ? record.cast : [{ actor: 'Pending editorial review', character: 'Pending editorial review' }];
  const activeLease = existing?.ingest_status === 'transferring' && Number(existing.transfer_lease_until) > nowSeconds;
  const nextIngestStatus = activeLease ? 'transferring' : verifiedQualities.size >= 2 ? 'ready' : verifiedQualities.size === 1 ? 'half' : 'queued';
  if (existing && existing.ingest_status !== nextIngestStatus) assertLegalTransition(existing.ingest_status as Parameters<typeof assertLegalTransition>[0], nextIngestStatus);
  const downloadSources = existing
    ? preserveManagedDownloadSources(existing.download_sources_json, record.torrents)
    : record.torrents;
  const transferToken = activeLease ? existing.transfer_token : null;
  const transferLeaseUntil = activeLease ? existing.transfer_lease_until : null;
  const downloadPayload = JSON.stringify({ status: verifiedQualities.size ? 'available' : 'pending', sources: downloadSources });
  const title = record.title.slice(0, 200);
  const tagline = record.tagline?.slice(0, 200) || 'Pending editorial review';
  const synopsis = record.synopsis?.slice(0, 5000) || '';
  const runtime = record.runtime || '';
  const rating = Math.max(0, Math.min(10, record.rating ?? 0));
  const languages = JSON.stringify(record.languages ?? []);
  const officialWatchUrl = record.officialWatchUrl ?? null;
  const poster = record.poster || '/og.png';
  const backdrop = record.backdrop || '/og.png';
  if (existing) {
    await database.prepare("UPDATE movies SET title = ?, tagline = CASE WHEN trim(tagline) = '' OR lower(tagline) LIKE 'pending editorial review%' THEN ? ELSE tagline END, description = CASE WHEN trim(description) = '' THEN ? ELSE description END, release_year = CASE WHEN release_year <= 0 THEN ? ELSE release_year END, runtime = CASE WHEN trim(runtime) = '' THEN ? ELSE runtime END, rating = CASE WHEN rating <= 0 THEN ? ELSE rating END, genre = CASE WHEN trim(genre) = '' OR lower(genre) = 'drama' THEN ? ELSE genre END, director = CASE WHEN trim(director) = '' OR lower(director) LIKE 'pending editorial review%' THEN ? ELSE director END, cast_json = CASE WHEN trim(cast_json) IN ('', '[]') OR lower(cast_json) LIKE '%pending editorial review%' THEN ? ELSE cast_json END, languages_json = CASE WHEN trim(languages_json) IN ('', '[]') THEN ? ELSE languages_json END, official_watch_url = COALESCE(official_watch_url, ?), download_sources_json = ?, storage_key = COALESCE(storage_key, ?), ingest_status = ?, transfer_token = ?, transfer_lease_until = ?, transfer_error = NULL, updated_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
      .bind(title, tagline, synopsis, record.year, runtime, rating, genre, director, JSON.stringify(cast), languages, officialWatchUrl, downloadPayload, record.storageKey, nextIngestStatus, transferToken, transferLeaseUntil, user.userId, now, existing.id).run();
    return existing.id;
  }
  const values = [
    slugBase, title, tagline, synopsis, record.year, runtime, rating, 'movie', genre, director, JSON.stringify(cast), languages, poster, backdrop, 0,
    'draft', 'pending', null, null, RIGHTS_DEFAULT_REVIEWER, RIGHTS_DEFAULT_REFERENCE, officialWatchUrl, null, null, null, downloadPayload, '[]', '[]', 1, user.userId, user.userId, now, now, record.imdbId, record.storageKey, 'queued',
  ];
  const result = await database.prepare('INSERT INTO movies (slug, title, tagline, description, release_year, runtime, rating, content_type, genre, director, cast_json, languages_json, poster, backdrop, featured, publication_status, rights_status, rights_verified_at, rights_expires_at, rights_reviewer, rights_reference, official_watch_url, telegram_url, telegram_channel, subtitle_url, download_sources_json, streaming_sources_json, episodes_json, revision, created_by, updated_by, created_at, updated_at, imdb_id, storage_key, ingest_status) VALUES (' + Array.from({ length: 36 }, () => '?').join(', ') + ')').bind(...values).run();
  const movieId = Number(result.meta.last_row_id);
  await auditStatement(database, user, 'yts_movie_queued', movieId, slugBase, ['yts_light_metadata', 'media_sources'], now).run();
  return movieId;
}
export async function updateAdminMovie(id: number, revision: number, input: AdminMovieInput, user: ChatGPTUser): Promise<boolean> {
  const database = getDatabase();
  const current = await database.prepare('SELECT rights_status, rights_expires_at, rights_reference, download_sources_json, official_watch_url, telegram_url, telegram_channel FROM movies WHERE id = ? AND revision = ? LIMIT 1')
    .bind(id, revision).first<{
      rights_status: RightsStatus;
      rights_expires_at: string | null;
      rights_reference: string | null;
      download_sources_json: string;
      official_watch_url: string | null;
      telegram_url: string | null;
      telegram_channel: string | null;
    }>();
  if (!current) return false;
  const preservedInput: AdminMovieInput = {
    ...input,
    downloadSources: preserveManagedDownloadSources(current.download_sources_json, input.downloadSources),
  };
  const rightsResetRequired = requiresRightsReset({
    rightsStatus: current.rights_status,
    rightsExpiresAt: current.rights_expires_at,
    rightsReference: current.rights_reference,
    officialWatchUrl: current.official_watch_url,
    telegramUrl: current.telegram_url,
    telegramChannel: current.telegram_channel,
  }, preservedInput);
  const persistedInput = rightsResetRequired
    ? { ...preservedInput, rightsStatus: 'pending' as const, rightsVerifiedAt: null, rightsExpiresAt: null, rightsReviewer: null, rightsReference: null }
    : preservedInput;
  const now = new Date().toISOString();
  const result = await database.prepare('UPDATE movies SET slug = ?, title = ?, tagline = ?, description = ?, release_year = ?, runtime = ?, rating = ?, content_type = ?, genre = ?, director = ?, cast_json = ?, languages_json = ?, poster = ?, backdrop = ?, featured = ?, publication_status = ?, rights_status = ?, rights_verified_at = ?, rights_expires_at = ?, rights_reviewer = ?, rights_reference = ?, official_watch_url = ?, telegram_url = ?, telegram_channel = ?, subtitle_url = ?, download_sources_json = ?, streaming_sources_json = ?, episodes_json = ?, updated_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?').bind(
    ...movieValues(persistedInput, user.userId, now).slice(0, 28), user.userId, now, id, revision,
  ).run();
  if (result.meta.changes !== 1) return false;
  await auditStatement(database, user, rightsResetRequired ? 'movie_updated_rights_reset' : 'movie_updated', id, persistedInput.slug, rightsResetRequired ? ['movie_record', 'rights_reset'] : ['movie_record'], now).run();
  logSecurityEvent('admin_movie_changed', 'info', { action: rightsResetRequired ? 'updated_rights_reset' : 'updated', slug: persistedInput.slug });
  return true;
}
export async function archiveAdminMovie(id: number, revision: number, user: ChatGPTUser): Promise<boolean> {
  const database = getDatabase();
  const current = await database.prepare('SELECT slug FROM movies WHERE id = ? AND revision = ? LIMIT 1').bind(id, revision).first<{ slug: string }>();
  if (!current) return false;
  const now = new Date().toISOString();
  const result = await database.prepare(`UPDATE movies SET publication_status = 'archived', featured = 0,
    updated_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?`).bind(user.userId, now, id, revision).run();
  if (result.meta.changes !== 1) return false;
  await auditStatement(database, user, 'movie_archived', id, current.slug, ['publicationStatus', 'featured'], now).run();
  logSecurityEvent('admin_movie_changed', 'info', { action: 'archived', slug: current.slug });
  return true;
}

export async function deleteArchivedAdminMovie(id: number, revision: number, user: ChatGPTUser): Promise<boolean> {
  const database = getDatabase();
  const current = await database.prepare(`SELECT slug, poster, backdrop, subtitle_url, cast_json, episodes_json,
    download_sources_json, streaming_sources_json, storage_key, r2_storage_key
    FROM movies WHERE id = ? AND revision = ? AND publication_status = 'archived' LIMIT 1`).bind(id, revision).first<MovieMediaRow & { slug: string }>();
  if (!current) return false;

  const keys = collectMovieR2Keys(current);
  const references = keys.length ? await database.batch(keys.map((key) => database.prepare(`SELECT 1 AS referenced FROM movies
    WHERE id <> ? AND (r2_storage_key = ? OR storage_key = ? OR poster = ? OR backdrop = ? OR subtitle_url = ?
      OR cast_json LIKE ? OR episodes_json LIKE ? OR download_sources_json LIKE ? OR streaming_sources_json LIKE ?)
    LIMIT 1`).bind(id, key, key, `/media/${key}`, `/media/${key}`, `/media/${key}`, `%${key}%`, `%${key}%`, `%${key}%`, `%${key}%`))) : [];
  const deletable = keys.filter((_, index) => !references[index]?.results?.length);
  let deletedR2Objects = 0;
  if (deletable.length) {
    try {
      const bucket = getMediaBucket();
      for (const key of deletable) {
        try {
          await bucket.delete(key);
          deletedR2Objects += 1;
        } catch (error) {
          console.warn(JSON.stringify({ event: 'r2_movie_cleanup_failed', movieId: id, key, error: error instanceof Error ? error.message : String(error) }));
        }
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: 'r2_movie_cleanup_unavailable', movieId: id, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  const result = await database.prepare("DELETE FROM movies WHERE id = ? AND revision = ? AND publication_status = 'archived'").bind(id, revision).run();
  if (result.meta.changes !== 1) return false;
  await auditStatement(database, user, 'movie_deleted', id, current.slug, ['movie_record', ...(deletedR2Objects ? ['r2_media'] : [])], new Date().toISOString()).run();
  logSecurityEvent('admin_movie_changed', 'info', { action: 'deleted', slug: current.slug, r2ObjectsDeleted: deletedR2Objects, r2ObjectsAttempted: deletable.length });
  return true;
}

export async function listApprovedDomains(): Promise<ApprovedDomain[]> {
  const result = await getDatabase().prepare('SELECT id, domain, active, created_at FROM approved_domains ORDER BY domain').all<{id:number;domain:string;active:number;created_at:string}>();
  return result.results.map((row) => ({ id: row.id, domain: row.domain, active: row.active === 1, createdAt: row.created_at }));
}
export async function createApprovedDomain(domain: string, user: ChatGPTUser): Promise<void> {
  const now = new Date().toISOString(); const database = getDatabase();
  await database.batch([database.prepare('INSERT INTO approved_domains (domain, active, created_at) VALUES (?, 1, ?)').bind(domain, now), auditStatement(database, user, 'approved_domain_added', null, null, [domain], now)]);
}
export async function removeApprovedDomain(id: number, user: ChatGPTUser): Promise<boolean> {
  const database = getDatabase(); const row = await database.prepare('SELECT domain FROM approved_domains WHERE id = ?').bind(id).first<{domain:string}>(); if (!row) return false;
  const now = new Date().toISOString(); await database.batch([database.prepare('DELETE FROM approved_domains WHERE id = ?').bind(id), auditStatement(database, user, 'approved_domain_removed', null, null, [row.domain], now)]); return true;
}
export async function assertApprovedSourceDomains(input: AdminMovieInput): Promise<void> {
  const allowed = new Set((await listApprovedDomains()).filter((item) => item.active).map((item) => item.domain));
  const episodeSources = input.episodes.flatMap((episode) => [
    ...(episode.url ? [{ url: episode.url }] : []),
    ...(episode.streamingSources ?? []),
    ...(episode.downloadSources ?? []),
  ]);
  for (const source of [...input.streamingSources, ...input.downloadSources, ...episodeSources]) {
    const target = new URL(source.url);
    const hostname = target.hostname.toLowerCase();
    if (target.protocol !== 'https:' || target.username || target.password || target.port || !allowed.has(hostname)) {
      throw new Error(`UNAPPROVED_DOMAIN:${hostname}`);
    }
  }
}
export async function createSourceReport(input: {movieSlug:string;sourceKind:'stream'|'download';sourceLabel:string;sourceUrl:string;reason:string;details:string}): Promise<void> {
  await getDatabase().prepare("INSERT INTO source_reports (movie_slug, source_kind, source_label, source_url, reason, details, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)").bind(input.movieSlug,input.sourceKind,input.sourceLabel,input.sourceUrl,input.reason,input.details,new Date().toISOString()).run();
}
export async function listSourceReports(): Promise<SourceReport[]> { const result = await getDatabase().prepare("SELECT id,movie_slug,source_kind,source_label,source_url,reason,details,status,created_at FROM source_reports WHERE status = 'open' ORDER BY id DESC LIMIT 200").all<Record<string,unknown>>(); return result.results.map((r) => ({id:Number(r.id),movieSlug:String(r.movie_slug),sourceKind:r.source_kind as 'stream'|'download',sourceLabel:String(r.source_label),sourceUrl:String(r.source_url),reason:String(r.reason),details:String(r.details),status:r.status as 'open'|'disabled'|'dismissed',createdAt:String(r.created_at)})); }
export async function resolveSourceReport(id:number, action:'disabled'|'dismissed', user:ChatGPTUser): Promise<boolean> { const database=getDatabase(); const report=await database.prepare("SELECT movie_slug,source_kind,source_url FROM source_reports WHERE id=? AND status='open'").bind(id).first<{movie_slug:string;source_kind:string;source_url:string}>(); if(!report)return false; const now=new Date().toISOString(); const statements:D1PreparedStatement[]=[]; if(action==='disabled'){ const movie=await database.prepare('SELECT id,download_sources_json,streaming_sources_json FROM movies WHERE slug=?').bind(report.movie_slug).first<{id:number;download_sources_json:string;streaming_sources_json:string}>(); if(movie){ const key=report.source_kind==='stream'?'streaming_sources_json':'download_sources_json'; const raw=report.source_kind==='stream'?movie.streaming_sources_json:movie.download_sources_json; const parsed:unknown=JSON.parse(raw); const kept=Array.isArray(parsed)?parsed.filter((s) => s && typeof s==='object' && (s as {url?:unknown}).url!==report.source_url):[]; statements.push(database.prepare(`UPDATE movies SET ${key}=?, revision=revision+1, updated_by=?, updated_at=? WHERE id=?`).bind(JSON.stringify(kept),user.userId,now,movie.id)); } } statements.push(database.prepare('UPDATE source_reports SET status=?,reviewed_at=?,reviewed_by=? WHERE id=?').bind(action,now,user.userId,id), auditStatement(database,user,`source_report_${action}`,null,report.movie_slug,[report.source_url],now)); await database.batch(statements); return true; }
