-- Provenance of comments recaps for the commentsOnly rescue marker.
-- Fresh DBs already have the column via schema.sql; this covers existing ones.
ALTER TABLE summaries ADD COLUMN provenance TEXT;

INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (6, datetime('now'));
