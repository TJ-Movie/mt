ALTER TABLE movies ADD COLUMN streaming_sources_json TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
CREATE TABLE source_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  movie_slug TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_label TEXT NOT NULL,
  source_url TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT
);
--> statement-breakpoint
CREATE INDEX idx_source_reports_status_created ON source_reports(status, created_at);
--> statement-breakpoint
CREATE INDEX idx_source_reports_movie_slug ON source_reports(movie_slug);
