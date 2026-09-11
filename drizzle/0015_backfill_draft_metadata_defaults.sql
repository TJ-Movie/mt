-- Standardize existing draft records for the Studio's manual review queue.
-- Rights remain pending and publication remains draft until an admin approves them.
UPDATE movies
SET rights_reviewer = 'Tj@gmail.com',
    rights_reference = 'good',
    rights_verified_at = '2026-09-10 00:00:00',
    rights_expires_at = '2035-02-02 12:00:00',
    rights_status = 'pending',
    publication_status = 'draft',
    poster = CASE WHEN trim(COALESCE(poster, '')) = '' THEN '/og.png' ELSE poster END,
    backdrop = CASE
      WHEN trim(COALESCE(backdrop, '')) <> '' THEN backdrop
      WHEN trim(COALESCE(poster, '')) <> '' THEN poster
      ELSE '/og.png'
    END
WHERE publication_status = 'draft';
