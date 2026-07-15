
import { env } from "@config/env";


import {
  buildAggregatedItemsFromRows,
  presentCommentsSummary,
  type StoryRow,
  type SummaryMap,
  type TagsMap,
} from "./meta-aggregated-batch";
import { chunkArray, inPlaceholders, SQL_IN_CHUNK_SIZE } from "./sql-chunks";

import type { AggregatedItem } from "@config/schemas";
import type { DatabaseSync } from "node:sqlite";

function loadStoriesChunk(db: DatabaseSync, ids: number[]): StoryRow[] {
  const ph = inPlaceholders(ids.length);
  return db
    .prepare(`SELECT id, title, url, by, timeISO, score, descendants FROM stories WHERE id IN (${ph})`)
    .all(...ids) as StoryRow[];
}

function loadSummariesForIds(db: DatabaseSync, ids: number[]): SummaryMap {
  const map: SummaryMap = new Map();
  for (const chunk of chunkArray(ids, SQL_IN_CHUNK_SIZE)) {
    const ph = inPlaceholders(chunk.length);
    const rows = db
      .prepare(
        `SELECT story_id, kind, summary FROM summaries WHERE lang = ? AND kind IN ('post','comments') AND story_id IN (${ph})`
      )
      .all(env.SUMMARY_LANG, ...chunk) as Array<{ story_id: number; kind: string; summary: string }>;
    for (const row of rows) {
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

function loadTagsForIds(db: DatabaseSync, ids: number[]): TagsMap {
  const map: TagsMap = new Map();
  for (const chunk of chunkArray(ids, SQL_IN_CHUNK_SIZE)) {
    const ph = inPlaceholders(chunk.length);
    const rows = db
      .prepare(`SELECT story_id, tag FROM tags WHERE story_id IN (${ph})`)
      .all(...chunk) as Array<{ story_id: number; tag: string }>;
    for (const row of rows) {
      const list = map.get(row.story_id) ?? [];
      list.push(row.tag);
      map.set(row.story_id, list);
    }
  }
  return map;
}

export function getAggregatedItemsSqlite(db: DatabaseSync, storyIds: number[]): AggregatedItem[] {
  if (storyIds.length === 0) {
    return [];
  }
  const stories: StoryRow[] = [];
  for (const chunk of chunkArray(storyIds, SQL_IN_CHUNK_SIZE)) {
    stories.push(...loadStoriesChunk(db, chunk));
  }
  const ids = stories.map((s) => s.id);
  const summaries = loadSummariesForIds(db, ids);
  const tagsByStory = loadTagsForIds(db, ids);
  return buildAggregatedItemsFromRows(stories, summaries, tagsByStory);
}

export function deleteStoriesBelowScoreSqlite(db: DatabaseSync, minScore: number): number[] {
  const rows = db
    .prepare("SELECT id FROM stories WHERE COALESCE(score, 0) < ?")
    .all(minScore) as Array<{ id: number }>;
  const ids = rows.map((r) => r.id);
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
  db.exec("BEGIN");
  try {
    for (const chunk of chunkArray(ids, SQL_IN_CHUNK_SIZE)) {
      const ph = inPlaceholders(chunk.length);
      for (const table of childTables) {
        db.prepare(`DELETE FROM ${table} WHERE story_id IN (${ph})`).run(...chunk);
      }
      db.prepare(`DELETE FROM stories WHERE id IN (${ph})`).run(...chunk);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return ids;
}
