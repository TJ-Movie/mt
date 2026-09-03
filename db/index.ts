import 'server-only';
import { env } from 'cloudflare:workers';
import { movies as starterMovies, type Movie, type PublicationStatus, type RightsStatus } from '../lib/movies.ts';
import { requiresRightsReset, type AdminMovieInput } from '../lib/admin/movie-input.ts';
import type { ChatGPTUser } from '../app/chatgpt-auth';
import { logSecurityEvent } from '../lib/security/security-events';

type Bindings = { DB?: D1Database; MEDIA?: R2Bucket };

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
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

export type AdminMovie = Movie & {
  id: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type AuditEvent = {
  id: number;
  action: string;
  movieSlug: string | null;
  changedFields: string[];
  actorEmail: string;
  createdAt: string;
};

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
    cast: safeStringArray(row.cast_json),
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
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const MOVIE_COLUMNS = `id, slug, title, tagline, description, release_year, runtime, rating, content_type,
  genre, director, cast_json, languages_json, poster, backdrop, featured,
  publication_status, rights_status, rights_verified_at, rights_expires_at,
  rights_reviewer, rights_reference, official_watch_url, telegram_url,
  telegram_channel, subtitle_url, revision, created_by, updated_by, created_at, updated_at`;

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
    telegram_channel, subtitle_url, revision, created_by, updated_by, created_at, updated_at
  ) VALUES (${Array.from({ length: 30 }, () => '?').join(', ')})`).bind(
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
  return [
    movie.slug, movie.title, movie.tagline, movie.description, movie.year,
    movie.runtime, movie.rating, movie.contentType ?? 'movie', movie.genre, movie.director, JSON.stringify(movie.cast),
    JSON.stringify(movie.languages), movie.poster, movie.backdrop, movie.featured ? 1 : 0,
    movie.publicationStatus, movie.rightsStatus, movie.rightsVerifiedAt ?? null,
    movie.rightsExpiresAt ?? null, movie.rightsReviewer ?? null, movie.rightsReference ?? null,
    movie.officialWatchUrl ?? null, movie.telegramUrl ?? null, movie.telegramChannel ?? null, movie.subtitleUrl ?? null,
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
    telegram_channel, subtitle_url, revision, created_by, updated_by, created_at, updated_at
  ) VALUES (${Array.from({ length: 30 }, () => '?').join(', ')})`).bind(
    ...movieValues(input, user.userId, now),
  ).run();
  const movieId = Number(result.meta.last_row_id);
  await auditStatement(database, user, 'movie_created', movieId, input.slug, ['all_fields'], now).run();
  logSecurityEvent('admin_movie_changed', 'info', { action: 'created', slug: input.slug });
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
    rights_reviewer = ?, rights_reference = ?, official_watch_url = ?, telegram_url = ?, telegram_channel = ?, subtitle_url = ?,
    updated_by = ?, updated_at = ?, revision = revision + 1
    WHERE id = ? AND revision = ?`).bind(
      ...movieValues(persistedInput, user.userId, now).slice(0, 24), user.userId, now, id, revision,
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
