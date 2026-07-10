CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  story_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  lang TEXT NOT NULL,
  model TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (story_id, kind, lang)
);

CREATE TABLE IF NOT EXISTS tags (
  story_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (story_id, tag)
);

CREATE TABLE IF NOT EXISTS article_extracts (
  story_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  char_count INTEGER,
  raw_article_ref TEXT,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS daily_rankings (
  day TEXT NOT NULL,
  story_id INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  score INTEGER,
  mode TEXT,
  PRIMARY KEY (day, story_id)
);

CREATE TABLE IF NOT EXISTS raw_blobs (
  story_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  sha256 TEXT,
  size_bytes INTEGER,
  fetched_at TEXT,
  PRIMARY KEY (story_id, kind)
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'));