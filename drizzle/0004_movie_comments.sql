CREATE TABLE IF NOT EXISTS movie_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  movie_slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movie_comments_slug_status ON movie_comments(movie_slug, status);
