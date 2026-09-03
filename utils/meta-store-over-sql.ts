import { getAggregatedItemsOverDriver, deleteStoriesBelowScoreOverDriver } from "@utils/meta-aggregated-load";

import type {
  AggregatedItem,
  NormalizedStory,
} from "@config/schemas";
import type {
  ArticleExtractRow,
  CommentsPolicyState,
  DailyRankingRow,
  LlmUsageRow,
  LlmUsageSummaryRow,
  MetaStore,
  ProcessingStateUpdate,
  RawBlobRow,
  SummaryRow,
  TelegramLedgerSnapshot,
} from "@utils/meta-store";
import type { SqlDriver } from "@utils/sql-driver";

type CommentsPolicyRow = {
  story_id: number;
  comments_policy_version?: string | null;
  comments_input_hash?: string | null;
  updated_at?: string | null;
};

function commentsPolicyStateFromRow(row: CommentsPolicyRow): CommentsPolicyState {
  return {
    commentsPolicyVersion: row.comments_policy_version ?? undefined,
    commentsInputHash: row.comments_input_hash ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  };
}

/**
 * The single MetaStore implementation: pure SQL over a SqlDriver
 * (utils/sql-driver.ts). createSqliteStore wraps it for local scripts;
 * createD1MetaStore wraps it for the worker. Schema migration is a local-only
 * concern — D1 applies schema out of band (see migrate below).
 */
export function createMetaStoreOverDriver(driver: SqlDriver): MetaStore {
  // SQLite binds SQL NULL for absent optional fields.
  // eslint-disable-next-line unicorn/no-null
  const databaseNull = null;

  return {
    async migrate(): Promise<void> {
      // Local SQLite overrides this to apply worker/d1/schema.sql + migrations.
      // D1 schema is applied via wrangler in deploy; no-op at runtime.
    },

    async upsertStory(story: NormalizedStory, rank: number, fetchedISO: string): Promise<void> {
      await driver
        .prepare(
          "INSERT INTO stories (id, title, url, by, timeISO, score, descendants, rank, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET title=excluded.title, url=excluded.url, by=excluded.by, timeISO=excluded.timeISO, score=excluded.score, descendants=excluded.descendants, rank=excluded.rank, updated_at=excluded.updated_at"
        )
        .run(
          story.id,
          story.title,
          story.url,
          story.by,
          story.timeISO,
          story.score ?? databaseNull,
          story.descendants ?? databaseNull,
          rank,
          fetchedISO
        );
    },

    async listStoryIdsForAggregate(minScore: number): Promise<number[]> {
      const rows = (await driver
        .prepare("SELECT id FROM stories WHERE COALESCE(score, 0) >= ? ORDER BY rank ASC, id DESC")
        .all(minScore)) as Array<{ id: number }>;
      return rows.map((r) => r.id);
    },

    getAggregatedItems: async (storyIds: number[]): Promise<AggregatedItem[]> =>
      getAggregatedItemsOverDriver(driver, storyIds),

    async upsertSummary(row: SummaryRow): Promise<void> {
      await driver
        .prepare(
          "INSERT INTO summaries (story_id, kind, lang, model, summary, created_at, provenance) VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(story_id, kind, lang) DO UPDATE SET model=excluded.model, summary=excluded.summary, created_at=excluded.created_at, provenance=excluded.provenance"
        )
        .run(
          row.storyId,
          row.kind,
          row.lang,
          row.model ?? databaseNull,
          row.summary,
          row.createdAt,
          row.provenance ?? databaseNull
        );
    },

    async replaceTags(storyId: number, tags: string[]): Promise<void> {
      await driver.batch([
        { sql: "DELETE FROM tags WHERE story_id = ?", params: [storyId] },
        ...tags.map((tag) => ({
          sql: "INSERT OR IGNORE INTO tags (story_id, tag) VALUES (?, ?)",
          params: [storyId, tag],
        })),
      ]);
    },

    async upsertArticleExtract(row: ArticleExtractRow): Promise<void> {
      await driver
        .prepare(
          "INSERT INTO article_extracts (story_id, status, source_kind, char_count, raw_article_ref, fetched_at) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(story_id) DO UPDATE SET status=excluded.status, source_kind=excluded.source_kind, char_count=excluded.char_count, raw_article_ref=excluded.raw_article_ref, fetched_at=excluded.fetched_at"
        )
        .run(
          row.storyId,
          row.status,
          row.sourceKind ?? databaseNull,
          row.charCount ?? databaseNull,
          row.rawArticleRef ?? databaseNull,
          row.fetchedAt ?? databaseNull
        );
    },

    async getArticleExtract(storyId: number): Promise<ArticleExtractRow | undefined> {
      const row = (await driver
        .prepare(
          "SELECT story_id, status, source_kind, char_count, raw_article_ref, fetched_at FROM article_extracts WHERE story_id = ?"
        )
        .get(storyId)) as
        | {
            story_id: number;
            status: string;
            source_kind: string | null;
            char_count: number | null;
            raw_article_ref: string | null;
            fetched_at: string | null;
          }
        | undefined;
      if (row === undefined) {
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
      await driver
        .prepare(
          "INSERT INTO raw_blobs (story_id, kind, ref, sha256, size_bytes, fetched_at) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(story_id, kind) DO UPDATE SET ref=excluded.ref, sha256=COALESCE(excluded.sha256, raw_blobs.sha256), size_bytes=COALESCE(excluded.size_bytes, raw_blobs.size_bytes), fetched_at=COALESCE(excluded.fetched_at, raw_blobs.fetched_at)"
        )
        .run(
          row.storyId,
          row.kind,
          row.ref,
          row.sha256 ?? databaseNull,
          row.sizeBytes ?? databaseNull,
          row.fetchedAt ?? databaseNull
        );
    },

    async upsertDailyRanking(row: DailyRankingRow): Promise<void> {
      await driver
        .prepare(
          "INSERT INTO daily_rankings (day, story_id, rank, score, mode) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(day, story_id) DO UPDATE SET rank=excluded.rank, score=excluded.score, mode=excluded.mode"
        )
        .run(row.day, row.storyId, row.rank, row.score ?? databaseNull, row.mode ?? databaseNull);
    },

    async upsertProcessingState(storyId: number, state: ProcessingStateUpdate): Promise<void> {
      // Omitted policy fields preserve existing values via COALESCE so legacy
      // error-path upserts do not wipe applied policy state.
      await driver
        .prepare(
          "INSERT INTO processing_state (story_id, post_status, comments_status, comments_policy_version, comments_input_hash, tags_status, updated_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(story_id) DO UPDATE SET post_status=excluded.post_status, comments_status=excluded.comments_status, " +
            // SQL identifiers look like credentials to the generic secret detector.
            // eslint-disable-next-line no-secrets/no-secrets
            "comments_policy_version=COALESCE(excluded.comments_policy_version, processing_state.comments_policy_version), " +
            // eslint-disable-next-line no-secrets/no-secrets
            "comments_input_hash=COALESCE(excluded.comments_input_hash, processing_state.comments_input_hash), " +
            "tags_status=excluded.tags_status, updated_at=excluded.updated_at, error=excluded.error"
        )
        .run(
          storyId,
          state.postStatus,
          state.commentsStatus,
          state.commentsPolicyVersion ?? databaseNull,
          state.commentsInputHash ?? databaseNull,
          state.tagsStatus,
          state.updatedAt,
          state.error ?? databaseNull
        );
    },

    async getCommentsPolicyState(storyId: number): Promise<CommentsPolicyState | undefined> {
      const row = (await driver
        .prepare(
          "SELECT story_id, comments_policy_version, comments_input_hash, updated_at FROM processing_state WHERE story_id = ?"
        )
        .get(storyId)) as CommentsPolicyRow | undefined;
      return row === undefined ? undefined : commentsPolicyStateFromRow(row);
    },

    async getCommentsPolicyStates(storyIds: number[]): Promise<Map<number, CommentsPolicyState>> {
      const states = new Map<number, CommentsPolicyState>();
      const uniqueIds = [...new Set(storyIds)];
      const chunkSize = 90;
      for (let offset = 0; offset < uniqueIds.length; offset += chunkSize) {
        const chunk = uniqueIds.slice(offset, offset + chunkSize);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = (await driver
          .prepare(
            `SELECT story_id, comments_policy_version, comments_input_hash, updated_at FROM processing_state WHERE story_id IN (${placeholders})`
          )
          .all(...chunk)) as CommentsPolicyRow[];
        for (const row of rows) {
          states.set(row.story_id, commentsPolicyStateFromRow(row));
        }
      }
      return states;
    },

    async getTelegramSentIds(ids: number[]): Promise<Set<number>> {
      if (ids.length === 0) {
        return new Set();
      }
      const placeholders = ids.map(() => "?").join(",");
      const rows = (await driver
        .prepare(`SELECT story_id FROM telegram_ledger WHERE story_id IN (${placeholders})`)
        .all(...ids)) as Array<{ story_id: number }>;
      return new Set(rows.map((r) => r.story_id));
    },

    async markTelegramSent(storyId: number, messageId: number, sentAtISO: string): Promise<void> {
      await driver
        .prepare(
          "INSERT INTO telegram_ledger (story_id, sent_at, message_id) VALUES (?, ?, ?) " +
            "ON CONFLICT(story_id) DO UPDATE SET sent_at=excluded.sent_at, message_id=excluded.message_id"
        )
        .run(storyId, sentAtISO, messageId);
    },

    async getTelegramLedger(): Promise<TelegramLedgerSnapshot> {
      const rows = (await driver.prepare("SELECT story_id FROM telegram_ledger ORDER BY sent_at ASC").all()) as Array<{
        story_id: number;
      }>;
      const maxRow = (await driver.prepare("SELECT MAX(sent_at) as m FROM telegram_ledger").get()) as {
        m?: string | null;
      };
      const lastUpdatedISO = maxRow.m ?? undefined;
      return {
        sentIds: rows.map((r) => r.story_id),
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        ...(lastUpdatedISO ? { lastUpdatedISO } : {}),
      };
    },

    async acquireRunLock(key: string, nowISO: string, ttlMs: number, owner: string): Promise<boolean> {
      const row = (await driver.prepare("SELECT locked_at FROM run_lock WHERE key = ?").get(key)) as
        | { locked_at?: string | null }
        | undefined;
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      if (!row?.locked_at) {
        await driver
          .prepare("INSERT OR REPLACE INTO run_lock (key, locked_at, owner) VALUES (?, ?, ?)")
          .run(key, nowISO, owner);
        return true;
      }
      const lockedAt = Date.parse(row.locked_at);
      if (Number.isNaN(lockedAt) || Date.now() - lockedAt > ttlMs) {
        await driver
          .prepare("UPDATE run_lock SET locked_at = ?, owner = ? WHERE key = ?")
          .run(nowISO, owner, key);
        return true;
      }
      return false;
    },

    async listPendingStoryIds(
      limit: number,
      updatedBeforeISO: string,
      fetchedISO: string,
      desiredPolicyVersion: string
    ): Promise<number[]> {
      const safeLimit = Math.max(1, Math.min(limit, 200));
      const rows = (await driver
        .prepare(
          "SELECT s.id FROM stories s " +
            "LEFT JOIN processing_state p ON p.story_id = s.id " +
            "WHERE s.updated_at = ? AND (" +
            "p.story_id IS NULL " +
            "OR ((p.post_status IS NULL OR p.post_status != 'ok' " +
            "OR p.comments_status IS NULL OR p.comments_status != 'ok' " +
            "OR p.tags_status IS NULL OR p.tags_status != 'ok' " +
            "OR p.comments_policy_version IS NULL OR p.comments_policy_version != ?) " +
            "AND (p.updated_at IS NULL OR p.updated_at < ?))" +
            ") " +
            "ORDER BY s.rank ASC, s.id DESC " +
            "LIMIT ?"
        )
        .all(fetchedISO, desiredPolicyVersion, updatedBeforeISO, safeLimit)) as Array<{ id: number }>;
      return rows.map((r) => r.id);
    },

    async getProcessingUpdatedMax(): Promise<string | undefined> {
      const row = (await driver
        .prepare("SELECT MAX(updated_at) as max_updated FROM processing_state")
        .get()) as { max_updated?: string | null };
      const value = row.max_updated;
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },

    async getAggregateState(
      key: string
    ): Promise<{ indexUpdatedISO?: string | null; processingUpdatedISO?: string | null } | undefined> {
      const row = (await driver
        .prepare("SELECT index_updated_iso, processing_updated_iso FROM aggregate_state WHERE key = ?")
        .get(key)) as { index_updated_iso?: string | null; processing_updated_iso?: string | null } | undefined;
      if (!row) {
        return undefined;
      }
      return {
        // eslint-disable-next-line unicorn/no-null
        indexUpdatedISO: row.index_updated_iso ?? null,
        // eslint-disable-next-line unicorn/no-null
        processingUpdatedISO: row.processing_updated_iso ?? null,
      };
    },

    async setAggregateState(
      key: string,
      indexUpdatedISO: string,
      processingUpdatedISO: string | null,
      updatedAtISO: string
    ): Promise<void> {
      await driver
        .prepare(
          "INSERT INTO aggregate_state (key, index_updated_iso, processing_updated_iso, updated_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET index_updated_iso=excluded.index_updated_iso, processing_updated_iso=excluded.processing_updated_iso, updated_at=excluded.updated_at"
        )
        .run(key, indexUpdatedISO, processingUpdatedISO, updatedAtISO);
    },

    async getPagesDeployState(
      key: string
    ): Promise<{ monthKey?: string | null; usedCount?: number | null; lastSlot?: string | null } | undefined> {
      const row = (await driver
        .prepare("SELECT month_key, used_count, last_slot FROM pages_deploy_state WHERE key = ?")
        .get(key)) as { month_key?: string | null; used_count?: number | null; last_slot?: string | null } | undefined;
      if (!row) {
        return undefined;
      }
      // eslint-disable-next-line unicorn/no-null
      const usedCount = typeof row.used_count === "number" ? row.used_count : null;
      return {
        // eslint-disable-next-line unicorn/no-null
        monthKey: row.month_key ?? null,
         
        usedCount,
        // eslint-disable-next-line unicorn/no-null
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
      await driver
        .prepare(
          "INSERT INTO pages_deploy_state (key, month_key, used_count, last_slot, updated_at) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET month_key=excluded.month_key, used_count=excluded.used_count, last_slot=excluded.last_slot, updated_at=excluded.updated_at"
        )
        .run(key, monthKey, usedCount, lastSlot, updatedAtISO);
    },

    deleteStoriesBelowScore: async (minScore: number): Promise<number[]> =>
      deleteStoriesBelowScoreOverDriver(driver, minScore),

    async insertLlmUsage(rows: LlmUsageRow[]): Promise<void> {
      if (rows.length === 0) {
        return;
      }
      await driver.batch(
        rows.map((row) => ({
          sql:
            "INSERT INTO llm_usage (created_at, story_id, label, gateway, model_requested, model_used, attempt, prompt_tokens, completion_tokens, total_tokens, status) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: [
            row.createdAt,
            row.storyId ?? databaseNull,
            row.label,
            row.gateway,
            row.modelRequested,
            row.modelUsed ?? databaseNull,
            row.attempt ?? databaseNull,
            row.promptTokens ?? databaseNull,
            row.completionTokens ?? databaseNull,
            row.totalTokens ?? databaseNull,
            row.status,
          ],
        }))
      );
    },

    async getLlmUsageSummary(): Promise<LlmUsageSummaryRow[]> {
      const rows = (await driver
        .prepare(
          "SELECT date(created_at) AS day, gateway, label, model_requested, model_used, " +
            "COUNT(*) AS calls, " +
            "SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors, " +
            "SUM(COALESCE(prompt_tokens,0)) AS prompt_tokens, " +
            "SUM(COALESCE(completion_tokens,0)) AS completion_tokens, " +
            "SUM(COALESCE(total_tokens,0)) AS total_tokens " +
            "FROM llm_usage " +
            "GROUP BY day, gateway, label, model_requested, model_used " +
            "ORDER BY day DESC, total_tokens DESC"
        )
        .all()) as Array<{
        day: string;
        gateway: string;
        label: string;
        model_requested: string;
        model_used: string | null;
        calls: number;
        errors: number;
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      }>;
      return rows.map((row) => ({
        day: row.day,
        gateway: row.gateway,
        label: row.label,
        modelRequested: row.model_requested,
        // eslint-disable-next-line unicorn/no-null
        modelUsed: row.model_used ?? null,
        calls: row.calls,
        errors: row.errors,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        totalTokens: row.total_tokens,
      }));
    },
  };
}
