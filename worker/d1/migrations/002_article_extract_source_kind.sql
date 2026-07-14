-- Record how a story's article content was fetched/parsed so the HTML-only
-- garbage detector's verdict (article vs no-article) has provenance.
-- Additive column; on a fresh DB schema.sql already includes it and the local
-- sqlite migrate() tolerates the resulting "duplicate column" no-op.
ALTER TABLE article_extracts ADD COLUMN source_kind TEXT;

INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, datetime('now'));
