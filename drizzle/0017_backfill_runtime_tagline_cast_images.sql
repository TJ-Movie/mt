-- Backfill exact YTS runtimes and review-safe taglines for existing drafts.
UPDATE movies SET runtime = CASE imdb_id
 WHEN 'tt1375666' THEN '2h 28m' WHEN 'tt0816692' THEN '2h 49m' WHEN 'tt0468569' THEN '2h 32m'
 WHEN 'tt15398776' THEN '3h 00m' WHEN 'tt0172495' THEN '2h 35m' WHEN 'tt0137523' THEN '2h 19m'
 WHEN 'tt0110912' THEN '2h 34m' WHEN 'tt0133093' THEN '2h 16m' WHEN 'tt15239678' THEN '2h 46m'
 WHEN 'tt0111161' THEN '2h 22m' WHEN 'tt0109830' THEN '2h 22m' WHEN 'tt9362722' THEN '2h 20m'
 WHEN 'tt0482571' THEN '2h 10m' WHEN 'tt0114369' THEN '2h 07m' WHEN 'tt2582802' THEN '1h 46m'
 WHEN 'tt0848228' THEN '2h 23m' WHEN 'tt1745960' THEN '2h 10m' ELSE runtime END,
 tagline = CASE WHEN trim(COALESCE(tagline, '')) = '' THEN 'Watch ' || title || ' in HD' ELSE tagline END,
 cast_json = CASE WHEN json_valid(cast_json) AND json_array_length(cast_json) > 0 THEN
   json_set(cast_json, '$[0].image', '/og.png', '$[1].image', '/og.png', '$[2].image', '/og.png')
   ELSE cast_json END
WHERE publication_status = 'draft';
