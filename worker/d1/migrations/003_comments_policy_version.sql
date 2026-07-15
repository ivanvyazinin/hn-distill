-- Applied comments summarization policy. NULL marks legacy/unprocessed rows.
ALTER TABLE processing_state ADD COLUMN comments_policy_version TEXT;

INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, datetime('now'));
