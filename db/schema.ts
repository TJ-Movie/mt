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
  revision: integer('revision').notNull().default(1),
  createdBy: text('created_by').notNull(),
  updatedBy: text('updated_by').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
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
