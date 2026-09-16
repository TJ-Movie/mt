ALTER TABLE movies ADD COLUMN enrichment_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE movies ADD COLUMN enrichment_error TEXT;
