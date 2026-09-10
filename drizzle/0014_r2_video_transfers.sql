ALTER TABLE movies ADD COLUMN r2_storage_key TEXT;
ALTER TABLE movies ADD COLUMN r2_video_bytes INTEGER;
ALTER TABLE movies ADD COLUMN transfer_token TEXT;
ALTER TABLE movies ADD COLUMN transfer_lease_until INTEGER;
ALTER TABLE movies ADD COLUMN transfer_error TEXT;
CREATE INDEX idx_movies_transfer_queue ON movies(ingest_status, transfer_lease_until);
