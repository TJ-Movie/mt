ALTER TABLE movies ADD COLUMN imdb_id TEXT;
ALTER TABLE movies ADD COLUMN storage_key TEXT;
ALTER TABLE movies ADD COLUMN ingest_status TEXT NOT NULL DEFAULT 'none';
CREATE UNIQUE INDEX IF NOT EXISTS idx_movies_imdb_id_unique ON movies(imdb_id) WHERE imdb_id IS NOT NULL;
