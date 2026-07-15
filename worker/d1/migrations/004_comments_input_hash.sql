-- Input hash successfully persisted for the applied comments policy.
ALTER TABLE processing_state ADD COLUMN comments_input_hash TEXT;

INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, datetime('now'));
