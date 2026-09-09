CREATE TABLE public_rate_limits (
  scope TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_public_rate_limits_key ON public_rate_limits(scope, client_hash, window_start);
--> statement-breakpoint
CREATE INDEX idx_public_rate_limits_window ON public_rate_limits(window_start);
