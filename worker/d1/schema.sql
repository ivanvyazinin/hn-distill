-- hn-distill D1 schema
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY,
  title TEXT,
  url TEXT,
  by TEXT,
  timeISO TEXT,
  score INTEGER,
  descendants INTEGER,
  rank INTEGER,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS processing_state (
  story_id INTEGER PRIMARY KEY,
  post_status TEXT,
  comments_status TEXT,
  comments_policy_version TEXT,
  comments_input_hash TEXT,
  tags_status TEXT,
  updated_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS telegram_ledger (
  story_id INTEGER PRIMARY KEY,
  sent_at TEXT,
  message_id INTEGER,
  digest_hash TEXT
);

CREATE TABLE IF NOT EXISTS run_lock (
  key TEXT PRIMARY KEY,
  locked_at TEXT,
  owner TEXT
);

CREATE TABLE IF NOT EXISTS aggregate_state (
  key TEXT PRIMARY KEY,
  index_updated_iso TEXT,
  processing_updated_iso TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS pages_deploy_state (
  key TEXT PRIMARY KEY,
  month_key TEXT,
  used_count INTEGER,
  last_slot TEXT,
  updated_at TEXT
);

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
  source_kind TEXT,
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
