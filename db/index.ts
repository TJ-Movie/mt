import 'server-only';
import { env } from 'cloudflare:workers';
import { movies as starterMovies, type Movie, type PublicationStatus, type RightsStatus } from '../lib/movies.ts';
import { requiresRightsReset, type AdminMovieInput } from '../lib/admin/movie-input.ts';
import type { ChatGPTUser } from '../app/chatgpt-auth';
import { logSecurityEvent } from '../lib/security/security-events';

type Bindings = { DB?: D1Database; MEDIA?: R2Bucket };
type StoredDownloadSource = NonNullable<Movie['downloadSources']>[number];
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
};

export type AdminMovie = Movie & {
  id: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  imdbId?: string;
  storageKey?: string;
  ingestStatus?: string;
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

function safeStringArray(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value.slice(0, 20) : [];
  } catch { return []; }
}
function safeCast(json: string): (string | { actor: string; character?: string; image?: string })[] {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    const result: (string | { actor: string; character?: string; image?: string })[] = [];
    for (const member of value.slice(0, 100) as unknown[]) {
      if (typeof member === 'string') {
        const actor = member.normalize('NFKC').trim().slice(0, 120);
        if (actor) result.push(actor);
        continue;
      }
      if (!member || typeof member !== 'object' || typeof (member as { actor?: unknown }).actor !== 'string') continue;
      const source = member as { actor: string; character?: unknown; image?: unknown };
      const actor = source.actor.normalize('NFKC').trim().slice(0, 120);
      if (!actor) continue;
      const character = typeof source.character === 'string' ? source.character.normalize('NFKC').trim().slice(0, 120) : undefined;
      const image = typeof source.image === 'string' ? source.image.trim().slice(0, 500) : undefined;
      result.push({ actor, character: character || undefined, image: image || undefined });
    }
    return result;
  } catch { return []; }
}
function safeStreamingSources(json: string): { label: string; url: string }[] { try { const value: unknown = JSON.parse(json); return Array.isArray(value) ? value.filter((item): item is { label: string; url: string } => Boolean(item && typeof item === 'object' && typeof (item as {label?:unknown}).label === 'string' && typeof (item as {url?:unknown}).url === 'string')).slice(0, 8) : []; } catch { return []; } }
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isStoredDownloadSource(value: unknown): value is StoredDownloadSource {
  return isRecord(value) && ['label', 'quality', 'resolution', 'size', 'url']
    .every((key) => typeof value[key] === 'string');
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
function isStoredEpisode(value: unknown): value is StoredEpisode {
  return isRecord(value) && Number.isInteger(value.season) && Number.isInteger(value.episode) && typeof value.title === 'string';
}
function safeEpisodes(json: string): StoredEpisode[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter(isStoredEpisode).slice(0, 500) : [];
  } catch { return []; }
}

function rowToMovie(row: MovieRow): AdminMovie {
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
    cast: safeCast(row.cast_json),
    languages: safeStringArray(row.languages_json),
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
  };
}

const MOVIE_COLUMNS = `id, slug, title, tagline, description, release_year, runtime, rating, content_type,
  genre, director, cast_json, languages_json, poster, backdrop, featured,
  publication_status, rights_status, rights_verified_at, rights_expires_at,
  rights_reviewer, rights_reference, official_watch_url, telegram_url,
  telegram_channel, subtitle_url, download_sources_json, streaming_sources_json, episodes_json, revision, created_by, updated_by, created_at, updated_at, imdb_id, storage_key, ingest_status`;

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

export async function getPublishedMovie(slug: string): Promise<Movie | undefined> {
  return (await listPublishedMovies()).find((movie) => movie.slug === slug);
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
  const result = await getDatabase().prepare(`SELECT ${MOVIE_COLUMNS} FROM movies ORDER BY updated_at DESC LIMIT 500`).all<MovieRow>();
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

function auditStatement(database: D1Database, user: ChatGPTUser, action: string, movieId: number | null, slug: string | null, fields: string[], now: string): D1PreparedStatement {
  return database.prepare(`INSERT INTO audit_events
    (actor_user_id, actor_email, action, movie_id, movie_slug, changed_fields_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
      user.userId, user.email, action, movieId, slug, JSON.stringify(fields), now,
    );
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
  synopsis: string;
  rating: number;
  poster: string;
  backdrop: string;
  cast: (string | { actor: string; character?: string; image?: string })[];
  storageKey: string;
  torrent: { url: string; quality: string; resolution: string; size: string; label: string };
};

export async function upsertYtsIngestMovie(record: YtsIngestRecord, user: ChatGPTUser): Promise<number> {
  const database = getDatabase();
  const now = new Date().toISOString();
  const slugBase = record.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || `movie-${record.imdbId}`;
  const existing = await database.prepare('SELECT id FROM movies WHERE imdb_id = ? LIMIT 1').bind(record.imdbId).first<{ id: number }>();
  const values = [
    slugBase, record.title.slice(0, 200), '', record.synopsis.slice(0, 5000), record.year,
    '', Math.max(0, Math.min(10, record.rating)), 'movie', '', '', JSON.stringify(record.cast), '[]', record.poster, record.backdrop, 0,
    'draft', 'pending', '2026-09-10T00:00:00.000Z', '2035-02-02T12:00:00.000Z', 'Tj@gmail.com', 'good', null, null, null, null,
    JSON.stringify({ status: 'pending', sources: [record.torrent] }), '[]', '[]', 1,
    user.userId, user.userId, now, now, record.imdbId, record.storageKey, 'queued',
  ];
  if (existing) {
    await database.prepare(`UPDATE movies SET title = ?, description = ?, release_year = ?, rating = ?, cast_json = ?, poster = ?, backdrop = ?, download_sources_json = ?, storage_key = ?, ingest_status = 'queued', updated_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`)
      .bind(record.title.slice(0, 200), record.synopsis.slice(0, 5000), record.year, Math.max(0, Math.min(10, record.rating)), JSON.stringify(record.cast), record.poster, record.backdrop, JSON.stringify({ status: 'pending', sources: [record.torrent] }), record.storageKey, user.userId, now, existing.id).run();
    return existing.id;
  }
  const result = await database.prepare(`INSERT INTO movies (
    slug, title, tagline, description, release_year, runtime, rating, content_type, genre, director, cast_json, languages_json, poster, backdrop, featured,
    publication_status, rights_status, rights_verified_at, rights_expires_at, rights_reviewer, rights_reference, official_watch_url, telegram_url, telegram_channel, subtitle_url,
    download_sources_json, streaming_sources_json, episodes_json, revision, created_by, updated_by, created_at, updated_at, imdb_id, storage_key, ingest_status
  ) VALUES (${Array.from({ length: 36 }, () => '?').join(', ')})`).bind(...values).run();
  const movieId = Number(result.meta.last_row_id);
  await auditStatement(database, user, 'yts_movie_queued', movieId, slugBase, ['yts_metadata', 'storage_key'], now).run();
  return movieId;
}

export async function updateAdminMovie(id: number, revision: number, input: AdminMovieInput, user: ChatGPTUser): Promise<boolean> {
  const database = getDatabase();
  const current = await database.prepare(`SELECT rights_status, rights_expires_at, rights_reference,
    official_watch_url, telegram_url, telegram_channel FROM movies WHERE id = ? AND revision = ? LIMIT 1`)
    .bind(id, revision).first<{
      rights_status: RightsStatus;
      rights_expires_at: string | null;
      rights_reference: string | null;
      official_watch_url: string | null;
      telegram_url: string | null;
      telegram_channel: string | null;
    }>();
  if (!current) return false;
  const rightsResetRequired = requiresRightsReset({
    rightsStatus: current.rights_status,
    rightsExpiresAt: current.rights_expires_at,
    rightsReference: current.rights_reference,
    officialWatchUrl: current.official_watch_url,
    telegramUrl: current.telegram_url,
    telegramChannel: current.telegram_channel,
  }, input);
  const persistedInput = rightsResetRequired
    ? { ...input, rightsStatus: 'pending' as const, rightsVerifiedAt: null, rightsExpiresAt: null, rightsReviewer: null, rightsReference: null }
    : input;
  const now = new Date().toISOString();
  const result = await database.prepare(`UPDATE movies SET
    slug = ?, title = ?, tagline = ?, description = ?, release_year = ?, runtime = ?, rating = ?, content_type = ?, genre = ?,
    director = ?, cast_json = ?, languages_json = ?, poster = ?, backdrop = ?, featured = ?,
    publication_status = ?, rights_status = ?, rights_verified_at = ?, rights_expires_at = ?,
    rights_reviewer = ?, rights_reference = ?, official_watch_url = ?, telegram_url = ?, telegram_channel = ?, subtitle_url = ?, download_sources_json = ?, streaming_sources_json = ?, episodes_json = ?,
    updated_by = ?, updated_at = ?, revision = revision + 1
    WHERE id = ? AND revision = ?`).bind(
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
  const current = await database.prepare("SELECT slug FROM movies WHERE id = ? AND revision = ? AND publication_status = 'archived' LIMIT 1").bind(id, revision).first<{ slug: string }>();
  if (!current) return false;
  const result = await database.prepare("DELETE FROM movies WHERE id = ? AND revision = ? AND publication_status = 'archived'").bind(id, revision).run();
  if (result.meta.changes !== 1) return false;
  await auditStatement(database, user, 'movie_deleted', id, current.slug, ['movie_record'], new Date().toISOString()).run();
  logSecurityEvent('admin_movie_changed', 'info', { action: 'deleted', slug: current.slug });
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
