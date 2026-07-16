import { deleteStoriesBelowScoreD1, getAggregatedItemsD1 } from "@utils/meta-aggregated-load-d1";
import type {
  ArticleExtractRow,
  DailyRankingRow,
  MetaStore,
  RawBlobRow,
  SummaryRow,
  TelegramLedgerSnapshot,
} from "@utils/meta-store";

import type { D1DatabaseLike } from "./bindings";
import {
  acquireRunLock,
  getAggregateState,
  getLlmUsageSummary,
  getPagesDeployState,
  getProcessingUpdatedMax,
  getTelegramSentIds,
  insertLlmUsage,
  listPendingStoryIds,
  markTelegramSent,
  setAggregateState,
  setPagesDeployState,
  upsertProcessingState,
  upsertStory,
} from "./d1";

export function createD1MetaStore(db: D1DatabaseLike): MetaStore {
  return {
    async migrate(): Promise<void> {
      // D1 schema applied via wrangler migrations in deploy; no-op at runtime.
    },

    upsertStory: (story, rank, fetchedISO) => upsertStory(db, story, rank, fetchedISO),
    acquireRunLock: (key, nowISO, ttlMs, owner) => acquireRunLock(db, key, nowISO, ttlMs, owner),
    listPendingStoryIds: (limit, updatedBeforeISO, fetchedISO, desiredPolicyVersion) =>
      listPendingStoryIds(db, limit, updatedBeforeISO, fetchedISO, desiredPolicyVersion),
    getProcessingUpdatedMax: () => getProcessingUpdatedMax(db),
    getAggregateState: (key) => getAggregateState(db, key),
    setAggregateState: (key, indexUpdatedISO, processingUpdatedISO, updatedAtISO) =>
      setAggregateState(db, key, indexUpdatedISO, processingUpdatedISO, updatedAtISO),
    getPagesDeployState: (key) => getPagesDeployState(db, key),
    setPagesDeployState: (key, monthKey, usedCount, lastSlot, updatedAtISO) =>
      setPagesDeployState(db, key, monthKey, usedCount, lastSlot, updatedAtISO),
    getTelegramSentIds: (ids) => getTelegramSentIds(db, ids),
    markTelegramSent: (storyId, messageId, sentAtISO) => markTelegramSent(db, storyId, messageId, sentAtISO),
    upsertProcessingState: (storyId, state) => upsertProcessingState(db, storyId, state),

    async listStoryIdsForAggregate(minScore: number): Promise<number[]> {
      const result = await db
        .prepare("SELECT id FROM stories WHERE COALESCE(score, 0) >= ? ORDER BY rank ASC, id DESC")
        .bind(minScore)
        .all<{ id: number }>();
      return result.results.map((r) => r.id);
    },

    getAggregatedItems: (storyIds) => getAggregatedItemsD1(db, storyIds),

    async upsertSummary(row: SummaryRow): Promise<void> {
      await db
        .prepare(
          "INSERT INTO summaries (story_id, kind, lang, model, summary, created_at) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(story_id, kind, lang) DO UPDATE SET model=excluded.model, summary=excluded.summary, created_at=excluded.created_at"
        )
        .bind(row.storyId, row.kind, row.lang, row.model ?? null, row.summary, row.createdAt)
        .run();
    },

    async replaceTags(storyId: number, tags: string[]): Promise<void> {
      const del = db.prepare("DELETE FROM tags WHERE story_id = ?").bind(storyId);
      const inserts = tags.map((tag) => db.prepare("INSERT OR IGNORE INTO tags (story_id, tag) VALUES (?, ?)").bind(storyId, tag));
      if (db.batch) {
        await db.batch([del, ...inserts]);
        return;
      }
      await del.run();
      for (const stmt of inserts) {
        await stmt.run();
      }
    },

    async upsertArticleExtract(row: ArticleExtractRow): Promise<void> {
      await db
        .prepare(
          "INSERT INTO article_extracts (story_id, status, source_kind, char_count, raw_article_ref, fetched_at) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(story_id) DO UPDATE SET status=excluded.status, source_kind=excluded.source_kind, char_count=excluded.char_count, raw_article_ref=excluded.raw_article_ref, fetched_at=excluded.fetched_at"
        )
        .bind(
          row.storyId,
          row.status,
          row.sourceKind ?? null,
          row.charCount ?? null,
          row.rawArticleRef ?? null,
          row.fetchedAt ?? null
        )
        .run();
    },

    async getArticleExtract(storyId: number): Promise<ArticleExtractRow | undefined> {
      const row = await db
        .prepare(
          "SELECT story_id, status, source_kind, char_count, raw_article_ref, fetched_at FROM article_extracts WHERE story_id = ?"
        )
        .bind(storyId)
        .first<{
          story_id: number;
          status: string;
          source_kind: string | null;
          char_count: number | null;
          raw_article_ref: string | null;
          fetched_at: string | null;
        }>();
      if (!row) {
        return undefined;
      }
      const out: ArticleExtractRow = { storyId: row.story_id, status: row.status };
      const sourceKind = row.source_kind ?? undefined;
      if (sourceKind !== undefined) {
        out.sourceKind = sourceKind;
      }
      const charCount = row.char_count ?? undefined;
      if (charCount !== undefined) {
        out.charCount = charCount;
      }
      const rawArticleRef = row.raw_article_ref ?? undefined;
      if (rawArticleRef !== undefined) {
        out.rawArticleRef = rawArticleRef;
      }
      const fetchedAt = row.fetched_at ?? undefined;
      if (fetchedAt !== undefined) {
        out.fetchedAt = fetchedAt;
      }
      return out;
    },

    async upsertRawBlob(row: RawBlobRow): Promise<void> {
      await db
        .prepare(
          "INSERT INTO raw_blobs (story_id, kind, ref, sha256, size_bytes, fetched_at) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(story_id, kind) DO UPDATE SET ref=excluded.ref, sha256=COALESCE(excluded.sha256, raw_blobs.sha256), size_bytes=COALESCE(excluded.size_bytes, raw_blobs.size_bytes), fetched_at=COALESCE(excluded.fetched_at, raw_blobs.fetched_at)"
        )
        .bind(row.storyId, row.kind, row.ref, row.sha256 ?? null, row.sizeBytes ?? null, row.fetchedAt ?? null)
        .run();
    },

    async upsertDailyRanking(row: DailyRankingRow): Promise<void> {
      await db
        .prepare(
          "INSERT INTO daily_rankings (day, story_id, rank, score, mode) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(day, story_id) DO UPDATE SET rank=excluded.rank, score=excluded.score, mode=excluded.mode"
        )
        .bind(row.day, row.storyId, row.rank, row.score ?? null, row.mode ?? null)
        .run();
    },

    async getTelegramLedger(): Promise<TelegramLedgerSnapshot> {
      const rows = await db.prepare("SELECT story_id FROM telegram_ledger ORDER BY sent_at ASC").all<{ story_id: number }>();
      const maxRow = await db.prepare("SELECT MAX(sent_at) as m FROM telegram_ledger").first<{ m?: string | null }>();
      const lastUpdatedISO = maxRow?.m ?? undefined;
      return {
        sentIds: rows.results.map((r) => r.story_id),
        ...(lastUpdatedISO ? { lastUpdatedISO } : {}),
      };
    },

    deleteStoriesBelowScore: (minScore) => deleteStoriesBelowScoreD1(db, minScore),

    insertLlmUsage: (rows) => insertLlmUsage(db, rows),
    getLlmUsageSummary: () => getLlmUsageSummary(db),
  };
}
