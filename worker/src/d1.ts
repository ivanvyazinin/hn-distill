import type { D1DatabaseLike } from "./bindings";

/**
 * Select the pre-Readability extraction backlog independently of the current
 * fetch timestamp/TOP_N. A successful re-extraction writes source_kind and the
 * row naturally leaves this queue. The processing timestamp provides retry
 * backoff when an upstream article remains unavailable.
 *
 * Only remaining raw-SQL helper outside the MetaStore interface: the backlog
 * query has no local-scripts caller, so it has not been promoted.
 */
export async function listLegacyExtractionStoryIds(
  db: D1DatabaseLike,
  limit: number,
  updatedBeforeISO: string
): Promise<number[]> {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const result = await db
    .prepare(
      "SELECT s.id FROM article_extracts a " +
        "JOIN stories s ON s.id = a.story_id " +
        "LEFT JOIN processing_state p ON p.story_id = s.id " +
        "WHERE a.source_kind IS NULL " +
        "AND s.url IS NOT NULL AND TRIM(s.url) != '' " +
        "AND (p.updated_at IS NULL OR p.updated_at < ?) " +
        "ORDER BY COALESCE(p.updated_at, s.updated_at, '') ASC, s.id ASC " +
        "LIMIT ?"
    )
    .bind(updatedBeforeISO, safeLimit)
    .all<{ id: number }>();
  return result.results.map((row) => row.id);
}
