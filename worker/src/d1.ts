import type { NormalizedStory } from "@config/schemas";
import type { D1DatabaseLike } from "./bindings";

export type ProcessingStatus = "ok" | "missing" | "error";

export async function upsertStory(
  db: D1DatabaseLike,
  story: NormalizedStory,
  rank: number,
  fetchedISO: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO stories (id, title, url, by, timeISO, score, descendants, rank, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET title=excluded.title, url=excluded.url, by=excluded.by, timeISO=excluded.timeISO, score=excluded.score, descendants=excluded.descendants, rank=excluded.rank, updated_at=excluded.updated_at"
    )
    .bind(
      story.id,
      story.title,
      story.url,
      story.by,
      story.timeISO,
      story.score ?? null,
      story.descendants ?? null,
      rank,
      fetchedISO
    )
    .run();
}

export async function upsertProcessingState(
  db: D1DatabaseLike,
  storyId: number,
  state: {
    postStatus: ProcessingStatus;
    commentsStatus: ProcessingStatus;
    tagsStatus: ProcessingStatus;
    updatedAt: string;
    error?: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO processing_state (story_id, post_status, comments_status, tags_status, updated_at, error) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(story_id) DO UPDATE SET post_status=excluded.post_status, comments_status=excluded.comments_status, tags_status=excluded.tags_status, updated_at=excluded.updated_at, error=excluded.error"
    )
    .bind(
      storyId,
      state.postStatus,
      state.commentsStatus,
      state.tagsStatus,
      state.updatedAt,
      state.error ?? null
    )
    .run();
}

export async function getTelegramSentIds(db: D1DatabaseLike, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) {
    return new Set();
  }
  const placeholders = ids.map(() => "?").join(",");
  const result = await db
    .prepare(`SELECT story_id FROM telegram_ledger WHERE story_id IN (${placeholders})`)
    .bind(...ids)
    .all<{ story_id: number }>();
  return new Set(result.results.map((row) => row.story_id));
}

export async function markTelegramSent(
  db: D1DatabaseLike,
  storyId: number,
  messageId: number,
  sentAtISO: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO telegram_ledger (story_id, sent_at, message_id) VALUES (?, ?, ?) " +
        "ON CONFLICT(story_id) DO UPDATE SET sent_at=excluded.sent_at, message_id=excluded.message_id"
    )
    .bind(storyId, sentAtISO, messageId)
    .run();
}

export async function acquireRunLock(
  db: D1DatabaseLike,
  key: string,
  nowISO: string,
  ttlMs: number,
  owner: string
): Promise<boolean> {
  const row = await db
    .prepare("SELECT locked_at FROM run_lock WHERE key = ?")
    .bind(key)
    .first<{ locked_at?: string | null }>();

  if (!row || !row.locked_at) {
    await db
      .prepare("INSERT OR REPLACE INTO run_lock (key, locked_at, owner) VALUES (?, ?, ?)")
      .bind(key, nowISO, owner)
      .run();
    return true;
  }

  const lockedAt = Date.parse(row.locked_at);
  if (Number.isNaN(lockedAt) || Date.now() - lockedAt > ttlMs) {
    await db
      .prepare("UPDATE run_lock SET locked_at = ?, owner = ? WHERE key = ?")
      .bind(nowISO, owner, key)
      .run();
    return true;
  }

  return false;
}

export async function listPendingStoryIds(
  db: D1DatabaseLike,
  limit: number,
  updatedBeforeISO: string,
  fetchedISO: string
): Promise<number[]> {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const result = await db
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
    .bind(fetchedISO, updatedBeforeISO, safeLimit)
    .all<{ id: number }>();
  return result.results.map((row) => row.id);
}

export async function getProcessingUpdatedMax(db: D1DatabaseLike): Promise<string | undefined> {
  const row = await db.prepare("SELECT MAX(updated_at) as max_updated FROM processing_state").first<{
    max_updated?: string | null;
  }>();
  const value = row?.max_updated;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function getAggregateState(
  db: D1DatabaseLike,
  key: string
): Promise<{ indexUpdatedISO?: string | null; processingUpdatedISO?: string | null } | undefined> {
  const row = await db
    .prepare("SELECT index_updated_iso, processing_updated_iso FROM aggregate_state WHERE key = ?")
    .bind(key)
    .first<{ index_updated_iso?: string | null; processing_updated_iso?: string | null }>();
  if (!row) {
    return undefined;
  }
  return {
    indexUpdatedISO: row.index_updated_iso ?? null,
    processingUpdatedISO: row.processing_updated_iso ?? null,
  };
}

export async function setAggregateState(
  db: D1DatabaseLike,
  key: string,
  indexUpdatedISO: string,
  processingUpdatedISO: string | null,
  updatedAtISO: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO aggregate_state (key, index_updated_iso, processing_updated_iso, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET index_updated_iso=excluded.index_updated_iso, processing_updated_iso=excluded.processing_updated_iso, updated_at=excluded.updated_at"
    )
    .bind(key, indexUpdatedISO, processingUpdatedISO, updatedAtISO)
    .run();
}

export async function getPagesDeployState(
  db: D1DatabaseLike,
  key: string
): Promise<{ monthKey?: string | null; usedCount?: number | null; lastSlot?: string | null } | undefined> {
  const row = await db
    .prepare("SELECT month_key, used_count, last_slot FROM pages_deploy_state WHERE key = ?")
    .bind(key)
    .first<{ month_key?: string | null; used_count?: number | null; last_slot?: string | null }>();
  if (!row) {
    return undefined;
  }
  return {
    monthKey: row.month_key ?? null,
    usedCount: typeof row.used_count === "number" ? row.used_count : null,
    lastSlot: row.last_slot ?? null,
  };
}

export async function setPagesDeployState(
  db: D1DatabaseLike,
  key: string,
  monthKey: string,
  usedCount: number,
  lastSlot: string,
  updatedAtISO: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO pages_deploy_state (key, month_key, used_count, last_slot, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET month_key=excluded.month_key, used_count=excluded.used_count, last_slot=excluded.last_slot, updated_at=excluded.updated_at"
    )
    .bind(key, monthKey, usedCount, lastSlot, updatedAtISO)
    .run();
}
