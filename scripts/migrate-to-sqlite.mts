import { readdir } from "node:fs/promises";

import { z } from "zod";

import { env } from "@config/env";
import { PATHS, pathFor } from "@config/paths";
import {
  AggregatedFileSchema,
  CommentsSummarySchema,
  IndexSchema,
  NormalizedStorySchema,
  PostSummarySchema,
  TagsSummarySchema,
} from "@config/schemas";
import { toDateKeyUTC } from "@utils/date-keys";
import { readJsonSafeOr } from "@utils/json";
import { log } from "@utils/log";
import { openLocalMetaStore } from "@utils/meta-runtime";

async function listSummaryIds(): Promise<number[]> {
  const dir = PATHS.summaries;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const ids = new Set<number>();
  for (const name of entries) {
    const m = /^(\d+)\.(post|comments|tags)\.json$/u.exec(name);
    if (m?.[1]) {
      ids.add(Number.parseInt(m[1], 10));
    }
  }
  return [...ids];
}

export async function main(): Promise<void> {
  const meta = await openLocalMetaStore();
  if (!meta) {
    throw new Error("SQLite meta store unavailable (node:sqlite required; run under Node/tsx)");
  }

  const aggregated = await readJsonSafeOr(PATHS.aggregated, AggregatedFileSchema, {
    updatedISO: new Date(0).toISOString(),
    items: [],
  });

  log.info("migrate", "Backfill from aggregated.json", { items: aggregated.items.length });

  for (const item of aggregated.items) {
    const story = {
      id: item.id,
      title: item.title,
      url: item.url,
      by: item.by,
      timeISO: item.timeISO,
      commentIds: [] as number[],
      score: item.score,
      descendants: item.commentsCount,
    };
    await meta.upsertStory(story, 0, aggregated.updatedISO);
    if (item.postSummary?.trim()) {
      await meta.upsertSummary({
        storyId: item.id,
        kind: "post",
        lang: env.SUMMARY_LANG,
        summary: item.postSummary,
        createdAt: aggregated.updatedISO,
      });
    }
    if (item.commentsSummary?.trim()) {
      await meta.upsertSummary({
        storyId: item.id,
        kind: "comments",
        lang: env.SUMMARY_LANG,
        summary: item.commentsSummary,
        createdAt: aggregated.updatedISO,
      });
    }
    if (item.tags && item.tags.length > 0) {
      await meta.replaceTags(item.id, item.tags);
    }
    await meta.upsertDailyRanking({
      day: toDateKeyUTC(item.timeISO),
      storyId: item.id,
      rank: 0,
      ...(typeof item.score === "number" ? { score: item.score } : {}),
      mode: env.TOP_N_MODE,
    });
  }

  const index = await readJsonSafeOr(PATHS.index, IndexSchema, { updatedISO: new Date(0).toISOString(), storyIds: [] });
  for (const [rank, id] of index.storyIds.entries()) {
    const raw = await readJsonSafeOr(pathFor.rawItem(id), NormalizedStorySchema.nullable(), null);
    if (raw) {
      await meta.upsertStory(raw, rank, index.updatedISO);
      await meta.upsertRawBlob({ storyId: id, kind: "item", ref: pathFor.rawItem(id), fetchedAt: index.updatedISO });
      await meta.upsertRawBlob({
        storyId: id,
        kind: "comments",
        ref: pathFor.rawComments(id),
        fetchedAt: index.updatedISO,
      });
    }
    const post = await readJsonSafeOr(pathFor.postSummary(id), PostSummarySchema.nullable(), null);
    if (post?.summary) {
      await meta.upsertSummary({
        storyId: id,
        kind: "post",
        lang: post.lang,
        ...(post.model ? { model: post.model } : {}),
        summary: post.summary,
        createdAt: post.createdISO ?? index.updatedISO,
      });
    }
    const comments = await readJsonSafeOr(pathFor.commentsSummary(id), CommentsSummarySchema.nullable(), null);
    if (comments?.summary) {
      await meta.upsertSummary({
        storyId: id,
        kind: "comments",
        lang: comments.lang,
        ...(comments.model ? { model: comments.model } : {}),
        summary: comments.summary,
        createdAt: comments.createdISO ?? index.updatedISO,
      });
    }
    const tags = await readJsonSafeOr(pathFor.tagsSummary(id), TagsSummarySchema.nullable(), null);
    if (tags?.tags?.length) {
      await meta.replaceTags(
        id,
        tags.tags.map((t) => t.name)
      );
    }
  }

  const indexIdSet = new Set(index.storyIds);
  const aggregatedIdSet = new Set(aggregated.items.map((it) => it.id));
  const orphanIds = (await listSummaryIds()).filter((id) => !indexIdSet.has(id) && !aggregatedIdSet.has(id));
  for (const id of orphanIds) {
    const post = await readJsonSafeOr(pathFor.postSummary(id), PostSummarySchema.nullable(), null);
    if (post?.summary) {
      await meta.upsertSummary({
        storyId: id,
        kind: "post",
        lang: post.lang,
        ...(post.model ? { model: post.model } : {}),
        summary: post.summary,
        createdAt: post.createdISO ?? aggregated.updatedISO,
      });
    }
    const comments = await readJsonSafeOr(pathFor.commentsSummary(id), CommentsSummarySchema.nullable(), null);
    if (comments?.summary) {
      await meta.upsertSummary({
        storyId: id,
        kind: "comments",
        lang: comments.lang,
        ...(comments.model ? { model: comments.model } : {}),
        summary: comments.summary,
        createdAt: comments.createdISO ?? aggregated.updatedISO,
      });
    }
    const tags = await readJsonSafeOr(pathFor.tagsSummary(id), TagsSummarySchema.nullable(), null);
    if (tags?.tags?.length) {
      await meta.replaceTags(
        id,
        tags.tags.map((t) => t.name)
      );
    }
  }
  log.info("migrate", "Enriched from per-story files", { summaryFiles: orphanIds.length });

  log.info("migrate", "Backfill complete", { db: "data/hn.sqlite" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}