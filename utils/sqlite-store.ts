import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import type { AggregatedItem, NormalizedStory } from "@config/schemas";
import {
  deleteStoriesBelowScoreSqlite,
  getAggregatedItemsSqlite,
} from "@utils/meta-aggregated-load-sqlite";
import type {
  ArticleExtractRow,
  DailyRankingRow,
  MetaStore,
  ProcessingStatus,
  RawBlobRow,
  SummaryRow,
  TelegramLedgerSnapshot,
} from "@utils/meta-store";

export function createSqliteStore(dbPath: string): MetaStore {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");

  return {
    async migrate(): Promise<void> {
      const here = dirname(fileURLToPath(import.meta.url));
      const schemaPath = resolve(here, "../worker/d1/schema.sql");
      db.exec(await readFile(schemaPath, "utf8"));

      const migrationDir = resolve(here, "../worker/d1/migrations");
      const migrationFiles = (await readdir(migrationDir))
        .map((name) => ({ name, version: /^(\d+)_.*\.sql$/u.exec(name)?.[1] }))
        .filter((entry): entry is { name: string; version: string } => entry.version !== undefined)
        .sort((a, b) => Number(a.version) - Number(b.version));
      for (const migration of migrationFiles) {
        const version = Number(migration.version);
        const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version);
        if (applied) {
          continue;
        }
        db.exec(await readFile(resolve(migrationDir, migration.name), "utf8"));
        db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))").run(
          version
        );
      }
    },

    async upsertStory(story: NormalizedStory, rank: number, fetchedISO: string): Promise<void> {
      db.prepare(
        "INSERT INTO stories (id, title, url, by, timeISO, score, descendants, rank, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET title=excluded.title, url=excluded.url, by=excluded.by, timeISO=excluded.timeISO, score=excluded.score, descendants=excluded.descendants, rank=excluded.rank, updated_at=excluded.updated_at"
      ).run(
        story.id,
        story.title,
        story.url,
        story.by,
        story.timeISO,
        story.score ?? null,
        story.descendants ?? null,
        rank,
        fetchedISO
      );
    },

    async listStoryIdsForAggregate(minScore: number): Promise<number[]> {
      const rows = db
        .prepare("SELECT id FROM stories WHERE COALESCE(score, 0) >= ? ORDER BY rank ASC, id DESC")
        .all(minScore) as Array<{ id: number }>;
      return rows.map((r) => r.id);
    },

    async getAggregatedItems(storyIds: number[]): Promise<AggregatedItem[]> {
      return getAggregatedItemsSqlite(db, storyIds);
    },

    async upsertSummary(row: SummaryRow): Promise<void> {
      db.prepare(
        "INSERT INTO summaries (story_id, kind, lang, model, summary, created_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(story_id, kind, lang) DO UPDATE SET model=excluded.model, summary=excluded.summary, created_at=excluded.created_at"
      ).run(row.storyId, row.kind, row.lang, row.model ?? null, row.summary, row.createdAt);
    },

    async replaceTags(storyId: number, tags: string[]): Promise<void> {
      const del = db.prepare("DELETE FROM tags WHERE story_id = ?");
      const ins = db.prepare("INSERT OR IGNORE INTO tags (story_id, tag) VALUES (?, ?)");
      db.exec("BEGIN");
      try {
        del.run(storyId);
        for (const tag of tags) {
          ins.run(storyId, tag);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async upsertArticleExtract(row: ArticleExtractRow): Promise<void> {
      db.prepare(
        "INSERT INTO article_extracts (story_id, status, char_count, raw_article_ref, fetched_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(story_id) DO UPDATE SET status=excluded.status, char_count=excluded.char_count, raw_article_ref=excluded.raw_article_ref, fetched_at=excluded.fetched_at"
      ).run(
        row.storyId,
        row.status,
        row.charCount ?? null,
        row.rawArticleRef ?? null,
        row.fetchedAt ?? null
      );
    },

    async upsertRawBlob(row: RawBlobRow): Promise<void> {
      db.prepare(
        "INSERT INTO raw_blobs (story_id, kind, ref, sha256, size_bytes, fetched_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(story_id, kind) DO UPDATE SET ref=excluded.ref, sha256=COALESCE(excluded.sha256, raw_blobs.sha256), size_bytes=COALESCE(excluded.size_bytes, raw_blobs.size_bytes), fetched_at=COALESCE(excluded.fetched_at, raw_blobs.fetched_at)"
      ).run(
        row.storyId,
        row.kind,
        row.ref,
        row.sha256 ?? null,
        row.sizeBytes ?? null,
        row.fetchedAt ?? null
      );
    },

    async upsertDailyRanking(row: DailyRankingRow): Promise<void> {
      db.prepare(
        "INSERT INTO daily_rankings (day, story_id, rank, score, mode) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(day, story_id) DO UPDATE SET rank=excluded.rank, score=excluded.score, mode=excluded.mode"
      ).run(row.day, row.storyId, row.rank, row.score ?? null, row.mode ?? null);
    },

    async upsertProcessingState(
      storyId: number,
      state: {
        postStatus: ProcessingStatus;
        commentsStatus: ProcessingStatus;
        tagsStatus: ProcessingStatus;
        updatedAt: string;
        error?: string | null;
      }
    ): Promise<void> {
      db.prepare(
        "INSERT INTO processing_state (story_id, post_status, comments_status, tags_status, updated_at, error) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(story_id) DO UPDATE SET post_status=excluded.post_status, comments_status=excluded.comments_status, tags_status=excluded.tags_status, updated_at=excluded.updated_at, error=excluded.error"
      ).run(
        storyId,
        state.postStatus,
        state.commentsStatus,
        state.tagsStatus,
        state.updatedAt,
        state.error ?? null
      );
    },

    async getTelegramSentIds(ids: number[]): Promise<Set<number>> {
      if (ids.length === 0) {
        return new Set();
      }
      const placeholders = ids.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT story_id FROM telegram_ledger WHERE story_id IN (${placeholders})`)
        .all(...ids) as Array<{ story_id: number }>;
      return new Set(rows.map((r) => r.story_id));
    },

    async markTelegramSent(storyId: number, messageId: number, sentAtISO: string): Promise<void> {
      db.prepare(
        "INSERT INTO telegram_ledger (story_id, sent_at, message_id) VALUES (?, ?, ?) " +
          "ON CONFLICT(story_id) DO UPDATE SET sent_at=excluded.sent_at, message_id=excluded.message_id"
      ).run(storyId, sentAtISO, messageId);
    },

    async getTelegramLedger(): Promise<TelegramLedgerSnapshot> {
      const rows = db.prepare("SELECT story_id FROM telegram_ledger ORDER BY sent_at ASC").all() as Array<{
        story_id: number;
      }>;
      const maxRow = db.prepare("SELECT MAX(sent_at) as m FROM telegram_ledger").get() as { m?: string | null };
      const lastUpdatedISO = maxRow?.m ?? undefined;
      return {
        sentIds: rows.map((r) => r.story_id),
        ...(lastUpdatedISO ? { lastUpdatedISO } : {}),
      };
    },

    async acquireRunLock(key: string, nowISO: string, ttlMs: number, owner: string): Promise<boolean> {
      const row = db.prepare("SELECT locked_at FROM run_lock WHERE key = ?").get(key) as
        | { locked_at?: string | null }
        | undefined;
      if (!row?.locked_at) {
        db.prepare("INSERT OR REPLACE INTO run_lock (key, locked_at, owner) VALUES (?, ?, ?)").run(key, nowISO, owner);
        return true;
      }
      const lockedAt = Date.parse(row.locked_at);
      if (Number.isNaN(lockedAt) || Date.now() - lockedAt > ttlMs) {
        db.prepare("UPDATE run_lock SET locked_at = ?, owner = ? WHERE key = ?").run(nowISO, owner, key);
        return true;
      }
      return false;
    },

    async listPendingStoryIds(limit: number, updatedBeforeISO: string, fetchedISO: string): Promise<number[]> {
      const safeLimit = Math.max(1, Math.min(limit, 200));
      const rows = db
        .prepare(
          "SELECT s.id FROM stories s " +
            "LEFT JOIN processing_state p ON p.story_id = s.id " +
            "WHERE s.updated_at = ? AND (" +
            "p.story_id IS NULL " +
            "OR ((p.post_status IS NULL OR p.post_status != 'ok' " +
            "OR p.comments_status IS NULL OR p.comments_status != 'ok' " +
            "OR p.tags_status IS NULL OR p.tags_status != 'ok') " +
            "AND (p.updated_at IS NULL OR p.updated_at < ?))" +
            ") " +
            "ORDER BY s.rank ASC, s.id DESC " +
            "LIMIT ?"
        )
        .all(fetchedISO, updatedBeforeISO, safeLimit) as Array<{ id: number }>;
      return rows.map((r) => r.id);
    },

    async getProcessingUpdatedMax(): Promise<string | undefined> {
      const row = db.prepare("SELECT MAX(updated_at) as max_updated FROM processing_state").get() as {
        max_updated?: string | null;
      };
      const value = row?.max_updated;
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },

    async getAggregateState(key: string): Promise<
      { indexUpdatedISO?: string | null; processingUpdatedISO?: string | null } | undefined
    > {
      const row = db
        .prepare("SELECT index_updated_iso, processing_updated_iso FROM aggregate_state WHERE key = ?")
        .get(key) as { index_updated_iso?: string | null; processing_updated_iso?: string | null } | undefined;
      if (!row) {
        return undefined;
      }
      return {
        indexUpdatedISO: row.index_updated_iso ?? null,
        processingUpdatedISO: row.processing_updated_iso ?? null,
      };
    },

    async setAggregateState(
      key: string,
      indexUpdatedISO: string,
      processingUpdatedISO: string | null,
      updatedAtISO: string
    ): Promise<void> {
      db.prepare(
        "INSERT INTO aggregate_state (key, index_updated_iso, processing_updated_iso, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET index_updated_iso=excluded.index_updated_iso, processing_updated_iso=excluded.processing_updated_iso, updated_at=excluded.updated_at"
      ).run(key, indexUpdatedISO, processingUpdatedISO, updatedAtISO);
    },

    async getPagesDeployState(key: string): Promise<
      { monthKey?: string | null; usedCount?: number | null; lastSlot?: string | null } | undefined
    > {
      const row = db
        .prepare("SELECT month_key, used_count, last_slot FROM pages_deploy_state WHERE key = ?")
        .get(key) as { month_key?: string | null; used_count?: number | null; last_slot?: string | null } | undefined;
      if (!row) {
        return undefined;
      }
      return {
        monthKey: row.month_key ?? null,
        usedCount: typeof row.used_count === "number" ? row.used_count : null,
        lastSlot: row.last_slot ?? null,
      };
    },

    async setPagesDeployState(
      key: string,
      monthKey: string,
      usedCount: number,
      lastSlot: string,
      updatedAtISO: string
    ): Promise<void> {
      db.prepare(
        "INSERT INTO pages_deploy_state (key, month_key, used_count, last_slot, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET month_key=excluded.month_key, used_count=excluded.used_count, last_slot=excluded.last_slot, updated_at=excluded.updated_at"
      ).run(key, monthKey, usedCount, lastSlot, updatedAtISO);
    },

    async deleteStoriesBelowScore(minScore: number): Promise<number[]> {
      return deleteStoriesBelowScoreSqlite(db, minScore);
    },
  };
}