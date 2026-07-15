import { env } from "@config/env";



import {
  buildAggregatedItemsFromRows,
  presentCommentsSummary,
  type StoryRow,
  type SummaryMap,
  type TagsMap,
} from "./meta-aggregated-batch";
import { chunkArray, inPlaceholders, SQL_IN_CHUNK_SIZE } from "./sql-chunks";

import type { D1DatabaseLike } from "../worker/src/bindings";
import type { AggregatedItem } from "@config/schemas";

async function loadStoriesChunk(
  db: D1DatabaseLike,
  ids: number[]
): Promise<StoryRow[]> {
  const ph = inPlaceholders(ids.length);
  const result = await db
    .prepare(`SELECT id, title, url, by, timeISO, score, descendants FROM stories WHERE id IN (${ph})`)
    .bind(...ids)
    .all<StoryRow>();
  return result.results;
}

async function loadSummariesForIds(db: D1DatabaseLike, ids: number[]): Promise<SummaryMap> {
  const map: SummaryMap = new Map();
  if (ids.length === 0) {
    return map;
  }
  for (const chunk of chunkArray(ids, SQL_IN_CHUNK_SIZE)) {
    const ph = inPlaceholders(chunk.length);
    const result = await db
      .prepare(
        `SELECT story_id, kind, summary FROM summaries WHERE lang = ? AND kind IN ('post','comments') AND story_id IN (${ph})`
      )
      .bind(env.SUMMARY_LANG, ...chunk)
      .all<{ story_id: number; kind: string; summary: string }>();
    for (const row of result.results) {
      let entry = map.get(row.story_id);
      if (!entry) {
        entry = {};
        map.set(row.story_id, entry);
      }
      if (row.kind === "post") {
        entry.post = row.summary;
      } else if (row.kind === "comments") {
        entry.comments = presentCommentsSummary(row.summary);
      }
    }
  }
  return map;
}

async function loadTagsForIds(db: D1DatabaseLike, ids: number[]): Promise<TagsMap> {
  const map: TagsMap = new Map();
  if (ids.length === 0) {
    return map;
  }
  for (const chunk of chunkArray(ids, SQL_IN_CHUNK_SIZE)) {
    const ph = inPlaceholders(chunk.length);
    const result = await db
      .prepare(`SELECT story_id, tag FROM tags WHERE story_id IN (${ph})`)
      .bind(...chunk)
      .all<{ story_id: number; tag: string }>();
    for (const row of result.results) {
      const list = map.get(row.story_id) ?? [];
      list.push(row.tag);
      map.set(row.story_id, list);
    }
  }
  return map;
}

export async function getAggregatedItemsD1(db: D1DatabaseLike, storyIds: number[]): Promise<AggregatedItem[]> {
  if (storyIds.length === 0) {
    return [];
  }
  const stories: StoryRow[] = [];
  for (const chunk of chunkArray(storyIds, SQL_IN_CHUNK_SIZE)) {
    stories.push(...(await loadStoriesChunk(db, chunk)));
  }
  const idSet = new Set(stories.map((s) => s.id));
  const ids = [...idSet];
  const [summaries, tagsByStory] = await Promise.all([loadSummariesForIds(db, ids), loadTagsForIds(db, ids)]);
  return buildAggregatedItemsFromRows(stories, summaries, tagsByStory);
}

export async function deleteStoriesBelowScoreD1(db: D1DatabaseLike, minScore: number): Promise<number[]> {
  const rows = await db
    .prepare("SELECT id FROM stories WHERE COALESCE(score, 0) < ?")
    .bind(minScore)
    .all<{ id: number }>();
  const ids = rows.results.map((r) => r.id);
  if (ids.length === 0) {
    return [];
  }
  const childTables = [
    "summaries",
    "tags",
    "article_extracts",
    "raw_blobs",
    "daily_rankings",
    "processing_state",
    "telegram_ledger",
  ] as const;
  for (const chunk of chunkArray(ids, SQL_IN_CHUNK_SIZE)) {
    const ph = inPlaceholders(chunk.length);
    const statements = [
      ...childTables.map((table) => db.prepare(`DELETE FROM ${table} WHERE story_id IN (${ph})`).bind(...chunk)),
      db.prepare(`DELETE FROM stories WHERE id IN (${ph})`).bind(...chunk),
    ];
    if (db.batch) {
      await db.batch(statements);
    } else {
      for (const statement of statements) {
        await statement.run();
      }
    }
  }
  return ids;
}
