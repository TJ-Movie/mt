CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`movie_id` integer,
	`movie_slug` text,
	`changed_fields_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_events_created_at` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_movie_id` ON `audit_events` (`movie_id`);--> statement-breakpoint
CREATE TABLE `movies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`tagline` text NOT NULL,
	`description` text NOT NULL,
	`release_year` integer NOT NULL,
	`runtime` text NOT NULL,
	`rating` real NOT NULL,
	`genre` text NOT NULL,
	`director` text NOT NULL,
	`cast_json` text NOT NULL,
	`languages_json` text NOT NULL,
	`poster` text NOT NULL,
	`backdrop` text NOT NULL,
	`featured` integer DEFAULT false NOT NULL,
	`publication_status` text DEFAULT 'draft' NOT NULL,
	`rights_status` text DEFAULT 'pending' NOT NULL,
	`rights_verified_at` text,
	`rights_expires_at` text,
	`rights_reviewer` text,
	`rights_reference` text,
	`official_watch_url` text,
	`telegram_url` text,
	`telegram_channel` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_movies_slug_unique` ON `movies` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_movies_publication_featured` ON `movies` (`publication_status`,`featured`);--> statement-breakpoint
CREATE INDEX `idx_movies_rights_status` ON `movies` (`rights_status`);