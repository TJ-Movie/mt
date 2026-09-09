import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const moviesTable = sqliteTable('movies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  tagline: text('tagline').notNull(),
  description: text('description').notNull(),
  releaseYear: integer('release_year').notNull(),
  runtime: text('runtime').notNull(),
  rating: real('rating').notNull(),
  contentType: text('content_type').notNull().default('movie'),
  genre: text('genre').notNull(),
  director: text('director').notNull(),
  castJson: text('cast_json').notNull(),
  languagesJson: text('languages_json').notNull(),
  poster: text('poster').notNull(),
  backdrop: text('backdrop').notNull(),
  featured: integer('featured', { mode: 'boolean' }).notNull().default(false),
  publicationStatus: text('publication_status').notNull().default('draft'),
  rightsStatus: text('rights_status').notNull().default('pending'),
  rightsVerifiedAt: text('rights_verified_at'),
  rightsExpiresAt: text('rights_expires_at'),
  rightsReviewer: text('rights_reviewer'),
  rightsReference: text('rights_reference'),
  officialWatchUrl: text('official_watch_url'),
  telegramUrl: text('telegram_url'),
  telegramChannel: text('telegram_channel'),
  subtitleUrl: text('subtitle_url'),
  downloadSourcesJson: text('download_sources_json').notNull().default('[]'),
  streamingSourcesJson: text('streaming_sources_json').notNull().default('[]'),
  episodesJson: text('episodes_json').notNull().default('[]'),
  revision: integer('revision').notNull().default(1),
  createdBy: text('created_by').notNull(),
  updatedBy: text('updated_by').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  imdbId: text('imdb_id'),
  storageKey: text('storage_key'),
  ingestStatus: text('ingest_status').notNull().default('none'),
}, (table) => [
  uniqueIndex('idx_movies_slug_unique').on(table.slug),
  index('idx_movies_publication_featured').on(table.publicationStatus, table.featured),
  index('idx_movies_rights_status').on(table.rightsStatus),
]);

export const auditEventsTable = sqliteTable('audit_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actorUserId: text('actor_user_id').notNull(),
  actorEmail: text('actor_email').notNull(),
  action: text('action').notNull(),
  movieId: integer('movie_id'),
  movieSlug: text('movie_slug'),
  changedFieldsJson: text('changed_fields_json').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_audit_events_created_at').on(table.createdAt),
  index('idx_audit_events_movie_id').on(table.movieId),
]);

export const appSettingsTable = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const movieCommentsTable = sqliteTable('movie_comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  movieSlug: text('movie_slug').notNull(),
  displayName: text('display_name').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull().default('visible'),
  createdAt: text('created_at').notNull(),
}, (table) => [index('idx_movie_comments_slug_status').on(table.movieSlug, table.status)]);

export const publicRateLimitsTable = sqliteTable('public_rate_limits', {
  scope: text('scope').notNull(),
  clientHash: text('client_hash').notNull(),
  windowStart: integer('window_start').notNull(),
  requestCount: integer('request_count').notNull().default(1),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_public_rate_limits_key').on(table.scope, table.clientHash, table.windowStart),
  index('idx_public_rate_limits_window').on(table.windowStart),
]);

export const approvedDomainsTable = sqliteTable('approved_domains', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  domain: text('domain').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
}, (table) => [uniqueIndex('idx_approved_domains_domain').on(table.domain)]);

export const sourceReportsTable = sqliteTable('source_reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  movieSlug: text('movie_slug').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourceLabel: text('source_label').notNull(),
  sourceUrl: text('source_url').notNull(),
  reason: text('reason').notNull(),
  details: text('details').notNull().default(''),
  status: text('status').notNull().default('open'),
  createdAt: text('created_at').notNull(),
  reviewedAt: text('reviewed_at'),
  reviewedBy: text('reviewed_by'),
}, (table) => [
  index('idx_source_reports_status_created').on(table.status, table.createdAt),
  index('idx_source_reports_movie_slug').on(table.movieSlug),
]);
