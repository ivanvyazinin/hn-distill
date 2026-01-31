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
