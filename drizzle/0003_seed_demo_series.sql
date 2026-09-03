-- Demo TV series for the first catalogue view. Safe to re-run because slugs are unique.
INSERT OR IGNORE INTO movies (
  slug, title, tagline, description, release_year, runtime, rating, content_type, genre,
  director, cast_json, languages_json, poster, backdrop, featured, publication_status, rights_status,
  rights_verified_at, rights_expires_at, rights_reviewer, rights_reference, official_watch_url,
  telegram_url, telegram_channel, subtitle_url, revision, created_by, updated_by, created_at, updated_at
) VALUES
  ('the-signal-house', 'The Signal House', 'Every episode carries a message.', 'A coastal radio team follows a chain of mysterious broadcasts that connect strangers across oceans.', 2026, '8 episodes', 8.6, 'series', 'Mystery, Thriller', 'Mira Senanayake', '["Asha Fernando","Noah Park","Lina Ortiz"]', '["English","Sinhala","Tamil","Hindi","Spanish","French"]', '/og.png', '/og.png', 0, 'published', 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, 'system-demo', 'system-demo', datetime('now'), datetime('now')),
  ('letters-from-kandy', 'Letters from Kandy', 'The past is still writing back.', 'Three friends restore a forgotten archive and uncover a family story told in many languages.', 2025, '6 episodes', 8.3, 'series', 'Drama, Romance', 'Ishani Rao', '["Maya Dias","Kabir Bose","Sora Kim"]', '["English","Sinhala","Hindi","Tamil","Portuguese"]', '/og.png', '/og.png', 0, 'published', 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, 'system-demo', 'system-demo', datetime('now'), datetime('now'));
