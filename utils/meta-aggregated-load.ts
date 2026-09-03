import { env } from "@config/env";
import {
  buildAggregatedItemsFromRows,
  presentCommentsSummary,
  type StoryRow,
  type SummaryMap,
  type TagsMap,
} from "@utils/meta-aggregated-batch";
import { chunkArray, inPlaceholders, SQL_IN_CHUNK_SIZE } from "@utils/sql-chunks";

import type { AggregatedItem } from "@config/schemas";
import type { SqlDriver } from "@utils/sql-driver";


/**
 * Single aggregated-item loader shared by SQLite and D1 backends: chunked
 * SELECT of stories/summaries/tags, assembled by buildAggregatedItemsFromRows.
 */
export async function getAggregatedItemsOverDriver(driver: SqlDriver, storyIds: number[]): Promise<AggregatedItem[]> {
  if (storyIds.length === 0) {
    return [];
  }
  const stories: StoryRow[] = [];
  for (const chunk of chunkArray(storyIds, SQL_IN_CHUNK_SIZE)) {
    const ph = inPlaceholders(chunk.length);
    const rows = await driver
      .prepare(`SELECT id, title, url, by, timeISO, score, descendants FROM stories WHERE id IN (${ph})`)
      .all(...chunk);
    stories.push(...(rows as StoryRow[]));
  }
  const idSet = new Set(stories.map((s) => s.id));
  const ids = [...idSet];
  const [summaries, tagsByStory] = await Promise.all([loadSummariesForIds(driver, ids), loadTagsForIds(driver, ids)]);
  return buildAggregatedItemsFromRows(stories, summaries, tagsByStory);
}

async function loadSummariesForIds(driver: SqlDriver, ids: number[]): Promise<SummaryMap> {
  const map: SummaryMap = new Map();
  if (ids.length === 0) {
    return map;
  }
  for (const chunk of chunkArray(ids, SQL_IN_CHUNK_SIZE)) {
    const ph = inPlaceholders(chunk.length);
    const rows = await driver
      .prepare(
        `SELECT story_id, kind, summary, provenance FROM summaries WHERE lang = ? AND kind IN ('post','comments') AND story_id IN (${ph})`
      )
      .all(env.SUMMARY_LANG, ...chunk);
    for (const row of rows as Array<{ story_id: number; kind: string; summary: string; provenance: string | null }>) {
      let entry = map.get(row.story_id);
      if (!entry) {
        entry = {};
        map.set(row.story_id, entry);
      }
      if (row.kind === "post") {
        entry.post = row.summary;
      } else if (row.kind === "comments") {
        entry.comments = {
          ...presentCommentsSummary(row.summary),
          ...(row.provenance === "structured" || row.provenance === "fallback" ? { provenance: row.provenance } : {}),
        };
      }
    }
  }
  return map;
}

async function loadTagsForIds(driver: SqlDriver, ids: number[]): Promise<TagsMap> {
  const map: TagsMap = new Map();
  if (ids.length === 0) {
    return map;
  }
  for (const chunk of chunkArray(ids, SQL_IN_CHUNK_SIZE)) {
    const ph = inPlaceholders(chunk.length);
    const rows = await driver.prepare(`SELECT story_id, tag FROM tags WHERE story_id IN (${ph})`).all(...chunk);
    for (const row of rows as Array<{ story_id: number; tag: string }>) {
      const list = map.get(row.story_id) ?? [];
      list.push(row.tag);
      map.set(row.story_id, list);
    }
  }
  return map;
}

const CHILD_TABLES_BY_STORY_ID = [
  "summaries",
  "tags",
  "article_extracts",
  "raw_blobs",
  "daily_rankings",
  "processing_state",
  "telegram_ledger",
] as const;

/** Deletes low-score stories plus their child-table rows, one atomic batch per chunk. */
export async function deleteStoriesBelowScoreOverDriver(driver: SqlDriver, minScore: number): Promise<number[]> {
  const rows = await driver.prepare("SELECT id FROM stories WHERE COALESCE(score, 0) < ?").all(minScore);
  const ids = (rows as Array<{ id: number }>).map((r) => r.id);
  if (ids.length === 0) {
    return [];
  }
  for (const chunk of chunkArray(ids, SQL_IN_CHUNK_SIZE)) {
    const ph = inPlaceholders(chunk.length);
    await driver.batch([
      ...CHILD_TABLES_BY_STORY_ID.map((table) => ({
        sql: `DELETE FROM ${table} WHERE story_id IN (${ph})`,
        params: chunk,
      })),
      { sql: `DELETE FROM stories WHERE id IN (${ph})`, params: chunk },
    ]);
  }
  return ids;
}
