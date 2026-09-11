UPDATE movies SET runtime = CASE imdb_id
  WHEN 'tt0499549' THEN '2h 42m'
  WHEN 'tt1630029' THEN '3h 12m'
  WHEN 'tt7286456' THEN '2h 02m'
  ELSE runtime END,
  tagline = CASE WHEN trim(COALESCE(tagline, '')) = '' THEN 'Watch ' || title || ' in HD' ELSE tagline END
WHERE publication_status = 'draft' AND trim(COALESCE(runtime, '')) = '';
