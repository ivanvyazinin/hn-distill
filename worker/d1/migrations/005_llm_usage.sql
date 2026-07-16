-- Per-attempt LLM usage ledger (tokens + model/gateway/task/status).
CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  story_id INTEGER,
  label TEXT NOT NULL,
  gateway TEXT NOT NULL,
  model_requested TEXT NOT NULL,
  model_used TEXT,
  attempt INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage(created_at);

INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, datetime('now'));
