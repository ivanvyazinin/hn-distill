import { formatISO } from "date-fns";
import { z } from "zod";

import { SCORE_MIN_AGGREGATE } from "@config/constants";
import { env } from "@config/env";
import { PATHS, pathFor } from "@config/paths";
import {
  AggregatedFileSchema,
  AggregatedItemSchema,
  CommentsSummarySchema,
  IndexSchema,
  NormalizedCommentSchema,
  PostSummarySchema,
  TagsSummarySchema,
  type AggregatedFile,
  type AggregatedItem,
  type NormalizedComment,
  type NormalizedStory,
} from "@config/schemas";
import { compressedStateFor } from "@utils/comments-compress";
import { renderCommentsSummaryParts, renderCompressedParagraphMarkdown } from "@utils/comments-render";
import { isoWeekKey, toDateKeyUTC } from "@utils/date-keys";
import {
  hasPublishablePostSummary,
  isSitePublishable,
  passesEngagementGate,
  type EngagementThresholds,
} from "@utils/engagement-gate";
import { HN } from "@utils/hn";
import { log } from "@utils/log";
import {
  presentCommentsSummary,
  resolveCommentsSummary,
  sanitizePostSummaryForPublish,
  type PostSummaryGuardPersisted,
} from "@utils/meta-aggregated-batch";
import { createNoopMetaStore } from "@utils/noop-meta-store";
import { readJsonSafe, readJsonSafeOrStore, type ObjectStore } from "@utils/object-store";
import { reportDrops, resetDrops } from "@utils/summary-drops";

import type { MetaStore } from "@utils/meta-store";


// Relaxed schema sufficient for aggregation; matches what tests write.
const AggregationStorySchema = z.object({
  id: z.number(),
  title: z.string(),
  // Explicitly allow null and use null as a fallback default for invalid values.
  // eslint-disable-next-line unicorn/no-null
  url: z.union([z.string(), z.null()]).optional().catch(null),
  by: z.string(),
  timeISO: z.string(), // accept any string; invalid dates handled later
  score: z.number().optional(),
  descendants: z.number().optional(),
  // commentIds not required for aggregation
});

function engagementThresholdsFromEnv(): EngagementThresholds {
  return {
    minScore: env.SUMMARIZE_MIN_SCORE,
    minComments: env.SUMMARIZE_MIN_COMMENTS,
  };
}

async function loadStoryOnly(
  id: number,
  store: ObjectStore
): Promise<NormalizedStory | undefined> {
  const storyLoose = await readJsonSafe(store, pathFor.rawItem(id), AggregationStorySchema.nullable());
  if (!storyLoose) {
    return undefined;
  }
  // Cast to NormalizedStory for downstream use; fields we read are present.
  return storyLoose as unknown as NormalizedStory;
}

async function loadStoryPayload(
  id: number,
  store: ObjectStore
): Promise<{
  comments: NormalizedComment[];
  postSummary: unknown;
  commentsSummary: unknown;
  tagsSummary: unknown;
}> {
  const [comments, postSummary, commentsSummary, tagsSummary] = await Promise.all([
    readJsonSafeOrStore<NormalizedComment[]>(store, pathFor.rawComments(id), NormalizedCommentSchema.array(), []),
    readJsonSafe(store, pathFor.postSummary(id), PostSummarySchema.nullable()),
    readJsonSafe(store, pathFor.commentsSummary(id), CommentsSummarySchema.nullable()),
    readJsonSafe(store, pathFor.tagsSummary(id), TagsSummarySchema.nullable()),
  ]);
  return { comments, postSummary, commentsSummary, tagsSummary };
}

export function extractDomain(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return undefined;
  }
}

export function buildAggregatedItem(
  story: NormalizedStory,
  comments: NormalizedComment[],
  postSummary: unknown,
  commentsSummary: unknown,
  tagsSummary: unknown
): AggregatedItem {
  const fb = fallbackFromRaw(story, comments);
  const domain = extractDomain(story.url ?? undefined);
  const rawTags = ((tagsSummary as { tags?: Array<{ name: string }> } | undefined)?.tags ?? []).map(
    (t: { name: string }) => t.name
  );
  const tags = [...new Set(rawTags)];

  const rawPostSummary = (postSummary as { summary?: string } | undefined)?.summary;
  const commentsSummaryRecord = commentsSummary as
    | {
        summary?: unknown;
        formatVersion?: unknown;
        structured?: unknown;
        degraded?: unknown;
        lang?: unknown;
      }
    | undefined;
  const rawCommentsSummary = commentsSummaryRecord?.summary;
  const persistedCommentsSummary =
    typeof rawCommentsSummary === "string" &&
    (rawCommentsSummary.length > 0 || commentsSummaryRecord?.formatVersion === 2)
      ? presentCommentsSummary(rawCommentsSummary)
      : undefined;
  const postGuard = (postSummary as { guard?: PostSummaryGuardPersisted } | undefined)?.guard;
  const cleanedPostSummary = sanitizePostSummaryForPublish(rawPostSummary, {
    id: story.id,
    ...(postGuard ? { guard: postGuard } : {}),
  });

  let commentsInsights: AggregatedItem["commentsInsights"];
  let compressedCommentsSummary: string | undefined;
  if (
    commentsSummaryRecord?.formatVersion === 2 &&
    commentsSummaryRecord.degraded === undefined &&
    commentsSummaryRecord.structured !== undefined &&
    commentsSummaryRecord.structured !== null
  ) {
    const parsed = CommentsSummarySchema.safeParse(commentsSummaryRecord);
    if (parsed.success && parsed.data.structured !== undefined) {
      const language = parsed.data.lang === "en" ? "en" : "ru";
      if (compressedStateFor(parsed.data) === "usable" && parsed.data.compressed) {
        compressedCommentsSummary = renderCompressedParagraphMarkdown(parsed.data.compressed.text);
      } else {
        commentsInsights = renderCommentsSummaryParts(parsed.data.structured, {
          language,
          comments,
        });
      }
    }
  }

  // Comments-only rescue: no post body, but the discussion recap rendered from
  // a real v2 LLM result (structured insights or usable compressed paragraph).
  // Degraded fallbacks, legacy freeform summaries and unparseable records never
  // set the marker, so the 2026-08-02 flood class stays unpublished while
  // URL-less or article-unreachable stories with a real recap get through.
  const commentsOnly =
    !hasPublishablePostSummary({ postSummary: cleanedPostSummary }) &&
    (commentsInsights !== undefined || compressedCommentsSummary !== undefined);
  return {
    id: story.id,
    title: story.title,
    url: story.url,
    by: story.by,
    timeISO: story.timeISO,
    postSummary: cleanedPostSummary,
    commentsSummary:
      compressedCommentsSummary ??
      resolveCommentsSummary(persistedCommentsSummary, fb.commentsSummary),
    ...(commentsInsights === undefined ? {} : { commentsInsights }),
    ...(commentsOnly ? { commentsOnly: true } : {}),
    score: story.score,
    commentsCount: story.descendants ?? comments.length,
    hnUrl: HN.itemUrl(story.id),
    domain,
    ...(tags.length > 0 ? { tags } : {}),
  };
}


export async function readAggregates(storyIds: number[], store: ObjectStore): Promise<AggregatedItem[]> {
  const gate = engagementThresholdsFromEnv();
  resetDrops();
  const results = await Promise.all(
    storyIds.map(async (id) => {
      log.debug("aggregate", "Aggregating story", { id });

      // Cheap prefilter: load raw story first and skip before comments/summaries/tags I/O.
      const story = await loadStoryOnly(id, store);
      if (!story) {
        log.warn("aggregate", "Missing story; skipping", { id });
        return;
      }

      const score = typeof story.score === "number" ? story.score : 0;
      if (score < SCORE_MIN_AGGREGATE) {
        log.debug("aggregate", "Skipping story due to low score", { id, score, min: SCORE_MIN_AGGREGATE });
        return;
      }

      if (
        !passesEngagementGate(
          { score: story.score, comments: story.descendants },
          gate
        )
      ) {
        log.info("aggregate", "Skipping story below engagement threshold", {
          id: story.id,
          score: story.score,
          descendants: story.descendants,
          minScore: gate.minScore,
          minComments: gate.minComments,
        });
        return;
      }

      const { comments, postSummary, commentsSummary, tagsSummary } = await loadStoryPayload(id, store);
      const item = buildAggregatedItem(story, comments, postSummary, commentsSummary, tagsSummary);
      // Post-less cards pass only with the commentsOnly rescue marker (real LLM
      // discussion recap, never raw fallback). See isSitePublishable.
      if (!isSitePublishable(item, gate)) {
        log.info("aggregate", "Skipping story without publishable postSummary or rescued comments", { id: story.id });
        return;
      }
      return item;
    })
  );

  await reportDrops(store);

  const items: AggregatedItem[] = [];
  for (const item of results) {
    if (item) {
      items.push(item);
    }
  }
  return items;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const FALLBACK_SUMMARY_LENGTH = 280;

export function fallbackFromRaw(
  _story: NormalizedStory,
  comments: NormalizedComment[]
): { postSummary?: string | undefined; commentsSummary?: string | undefined } {
  const combined = comments
    .map((c) => c.textPlain)
    .join(" ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  const commentsSummary: string | undefined = combined ? combined.slice(0, FALLBACK_SUMMARY_LENGTH) : undefined;
  return { postSummary: undefined, commentsSummary };
}

function parseIsoSafe(iso?: string): number {
  if (typeof iso !== "string") {
    return Number.NaN;
  }
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : Number.NaN;
}

export function sortItemsDesc(a: AggregatedItem, b: AggregatedItem): number {
  const ta = parseIsoSafe(a.timeISO);
  const tb = parseIsoSafe(b.timeISO);
  const aHas = Number.isFinite(ta);
  const bHas = Number.isFinite(tb);
  if (aHas && bHas) {
    return tb - ta; // newer first
  }
  if (aHas && !bHas) {
    return -1; // valid dates before invalid
  }
  if (!aHas && bHas) {
    return 1;
  }
  return b.id - a.id; // deterministic for both invalid: by id desc
}

export async function main(store: ObjectStore, meta?: MetaStore, options?: { fromDb?: boolean }): Promise<AggregatedFile> {
  // A REAL store is required for the DB branch: a Noop must never select it.
  const hasRealMeta = meta !== undefined;
  const fromDb = options?.fromDb === true && hasRealMeta;
  const metaStore = meta ?? createNoopMetaStore();

  const previous = await readJsonSafeOrStore<AggregatedFile>(store, PATHS.aggregated, AggregatedFileSchema, {
    updatedISO: new Date(0).toISOString(),
    items: [],
  });

  const aggregatedExists = (await store.getText(PATHS.aggregated)) !== null;

  let sorted: AggregatedItem[];
  const changedIds = new Set<number>();

  const gate = engagementThresholdsFromEnv();

  if (fromDb) {
    // Production path (AGGREGATE_FROM_DB=true): the drop bookkeeping lives here,
    // not in readAggregates, which this branch never calls.
    resetDrops();
    const storyIds = await metaStore.listStoryIdsForAggregate(SCORE_MIN_AGGREGATE);
    const latestItems = await metaStore.getAggregatedItems(storyIds);
    await reportDrops(store);
    for (const it of latestItems) {
      const prev = previous.items.find((p) => p.id === it.id);
      if (!prev || !jsonEqual(prev, it)) {
        changedIds.add(it.id);
      }
    }
    // Drop gate-skipped / empty-summary rows (and stale previous DB materializations).
    sorted = latestItems.filter((it) => isSitePublishable(it, gate)).sort(sortItemsDesc);
  } else {
    const index = await readJsonSafeOrStore<{ updatedISO: string; storyIds: number[] }>(store, PATHS.index, IndexSchema, {
      updatedISO: new Date(0).toISOString(),
      storyIds: [],
    });
    const latestItems = await readAggregates(index.storyIds, store);
    const byId = new Map<number, AggregatedItem>();
    for (const it of previous.items) {
      byId.set(it.id, it);
    }
    for (const it of latestItems) {
      const prev = byId.get(it.id);
      if (prev && jsonEqual(prev, it)) {
        continue;
      }
      byId.set(it.id, it);
      changedIds.add(it.id);
    }
    // Re-filter previous.items too: a once-published row that later falls below the
    // engagement bar (or lost its summary) must leave the site on the next run.
    const merged = [...byId.values()].filter((it) => {
      const s = typeof it.score === "number" ? it.score : 0;
      return s >= SCORE_MIN_AGGREGATE && isSitePublishable(it, gate);
    });
    sorted = merged.sort(sortItemsDesc);
  }

  // Both branches above already filtered by isSitePublishable; this pass only
  // validates the schema.
  const safeItems = sorted.filter((it) => {
    try {
      AggregatedItemSchema.parse(it);
      return true;
    } catch (error) {
      log.warn("aggregate", "Dropping invalid item during validation", {
        id: (it as { id?: number }).id,
        error: String(error),
      });
      return false;
    }
  });

  const itemsEqual = jsonEqual(safeItems, previous.items);
  const shouldWriteAggregated = !itemsEqual || !aggregatedExists;
  const payload: AggregatedFile = {
    updatedISO: shouldWriteAggregated ? formatISO(new Date()) : previous.updatedISO,
    items: shouldWriteAggregated ? safeItems : previous.items,
  };

  if (!shouldWriteAggregated) {
    log.info("aggregate", "Aggregated output unchanged; skipping write", {
      path: PATHS.aggregated,
      items: previous.items.length,
    });
    return payload;
  }

  await store.putJson(PATHS.aggregated, payload, { pretty: true, contentType: "application/json" });
  log.info("aggregate", "Aggregated file written", {
    path: PATHS.aggregated,
    items: payload.items.length,
    updated: changedIds.size,
    prev: previous.items.length,
  });

  // Emit compact client-side search index (newest-first like aggregated.json)
  try {
    type SearchRow = {
      id: number;
      title: string;
      tags: string[];
      domain?: string;
      timeISO: string;
      score: number;
    };

    const searchRows: SearchRow[] = payload.items.map((it) => {
      const base: Omit<SearchRow, "domain"> & { domain?: string } = {
        id: it.id,
        title: it.title,
        tags: Array.isArray(it.tags) ? it.tags : [],
        timeISO: it.timeISO,
        score: typeof it.score === "number" ? it.score : 0,
      };
      return it.domain ? { ...base, domain: it.domain } : base;
    });

    await store.putJson(PATHS.search, searchRows, { pretty: false, contentType: "application/json" });
    log.info("aggregate", "Search index written", { path: PATHS.search, items: searchRows.length });
  } catch (error) {
    log.warn("aggregate", "Failed to write search index", { error: String(error) });
  }

  // Additional grouped outputs for historical slices
  try {
    const { items, updatedISO } = payload;
    const byDay: Record<string, number[]> = {};
    const byWeek: Record<string, number[]> = {};

    for (const it of items) {
      const dkey = toDateKeyUTC(it.timeISO);
      const wkey = isoWeekKey(it.timeISO);
      (byDay[dkey] ??= []).push(it.id);
      (byWeek[wkey] ??= []).push(it.id);
    }
    await store.putJson(PATHS.grouped.daily, { updatedISO, byDate: byDay }, { pretty: true, contentType: "application/json" });
    await store.putJson(PATHS.grouped.weekly, { updatedISO, byWeek }, { pretty: true, contentType: "application/json" });
    log.info("aggregate", "Grouped files written", {
      daily: PATHS.grouped.daily,
      weekly: PATHS.grouped.weekly,
      days: Object.keys(byDay).length,
      weeks: Object.keys(byWeek).length,
    });
  } catch (error) {
    log.warn("aggregate", "Failed to write grouped files", { error: String(error) });
  }

  return payload;
}
