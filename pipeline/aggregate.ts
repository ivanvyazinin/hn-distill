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
import { isoWeekKey, toDateKeyUTC } from "@utils/date-keys";
import { HN } from "@utils/hn";
import { log } from "@utils/log";
import {
  compressSourceHash,
  renderCommentsInsightsPlainText,
  resolveCompressedState,
} from "@utils/comments-compress";
import { renderCommentsSummaryParts, renderCompressedParagraphMarkdown } from "@utils/comments-render";
import { presentCommentsSummary, resolveCommentsSummary } from "@utils/meta-aggregated-batch";
import { readJsonSafeOrStore, type ObjectStore } from "@utils/object-store";
import { checkSummaryHeuristics, languageGateFromEnv } from "@utils/summary-heuristics";

import type { MetaStore } from "@utils/meta-store";

type Services = {
  noop?: true;
};

const DROP_SUMMARY_REASONS = new Set([
  "empty",
  "too_short",
  "too_few_words",
  "refusal",
  "apology",
  "policy",
  "artifact",
  "bullets_only",
  "meta_instructions",
  "redirects_to_article",
  "content_free",
  "repetition_run",
  "low_unique_ratio",
  "url_encoded_noise",
]);

export function makeServices(): Services {
  return {};
}

async function loadStoryData(
  id: number,
  store: ObjectStore
): Promise<{
  story: NormalizedStory | undefined;
  comments: NormalizedComment[];
  postSummary: unknown;
  commentsSummary: unknown;
  tagsSummary: unknown;
}> {
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

  const storyLoose = await readJsonSafeOrStore(store, pathFor.rawItem(id), AggregationStorySchema.nullable());
  if (!storyLoose) {
    return {
      story: undefined,
      comments: [],
      postSummary: undefined,
      commentsSummary: undefined,
      tagsSummary: undefined,
    };
  }

  // Cast to NormalizedStory for downstream use; fields we read are present.
  const story = storyLoose as unknown as NormalizedStory;

  const [comments, postSummary, commentsSummary, tagsSummary] = await Promise.all([
    readJsonSafeOrStore<NormalizedComment[]>(store, pathFor.rawComments(id), NormalizedCommentSchema.array(), []),
    readJsonSafeOrStore(store, pathFor.postSummary(id), PostSummarySchema.nullable()),
    readJsonSafeOrStore(store, pathFor.commentsSummary(id), CommentsSummarySchema.nullable()),
    readJsonSafeOrStore(store, pathFor.tagsSummary(id), TagsSummarySchema.nullable()),
  ]);

  return { story, comments, postSummary, commentsSummary, tagsSummary };
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
  const cleanedPostSummary = sanitizePostSummary(rawPostSummary, postGuard, { id: story.id });

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
      const plainText = renderCommentsInsightsPlainText(parsed.data.structured);
      const expectedSourceHash = compressSourceHash(parsed.data.lang, plainText);
      if (resolveCompressedState(parsed.data, expectedSourceHash) === "usable" && parsed.data.compressed) {
        compressedCommentsSummary = renderCompressedParagraphMarkdown(parsed.data.compressed.text);
      } else {
        commentsInsights = renderCommentsSummaryParts(parsed.data.structured, {
          language,
          comments,
        });
      }
    }
  }

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
    score: story.score,
    commentsCount: story.descendants ?? comments.length,
    hnUrl: HN.itemUrl(story.id),
    domain,
    ...(tags.length > 0 ? { tags } : {}),
  };
}

const POST_SUMMARY_ARTIFACT = "<｜begin▁of▁sentence｜>";

type PostSummaryGuardPersisted = {
  ok?: boolean;
  verdict?: string;
  reasons?: string[];
  confidence?: number;
};

function sanitizePostSummary(
  summary: string | undefined,
  guard: PostSummaryGuardPersisted | undefined,
  context: { id: number }
): string | undefined {
  if (!summary) {
    return summary;
  }
  const cleaned = summary.replaceAll(POST_SUMMARY_ARTIFACT, "").trim();
  if (cleaned.length === 0) {
    return undefined;
  }

  if (guard && guard.ok === false) {
    log.warn("aggregate", "Dropping summary flagged by guard", {
      id: context.id,
      verdict: guard.verdict,
      reasons: guard.reasons,
    });
    return undefined;
  }

  const heuristics = checkSummaryHeuristics(cleaned, {
    minChars: env.POST_SUMMARY_MIN_CHARS,
    language: env.SUMMARY_LANG,
    kind: "post",
    languageGate: languageGateFromEnv(env),
  });
  const blocking = heuristics.triggers.filter((trigger) => DROP_SUMMARY_REASONS.has(trigger.reason));
  if (blocking.length > 0) {
    log.warn("aggregate", "Dropping summary after heuristics", {
      id: context.id,
      triggers: blocking.map((t) => t.reason),
    });
    return undefined;
  }

  if (!heuristics.ok) {
    log.info("aggregate", "Summary passed with non-blocking triggers", {
      id: context.id,
      triggers: heuristics.triggers.map((t) => t.reason),
    });
  }

  return cleaned;
}

export async function readAggregates(storyIds: number[], store: ObjectStore): Promise<AggregatedItem[]> {
  const results = await Promise.all(
    storyIds.map(async (id) => {
      log.debug("aggregate", "Aggregating story", { id });

      const { story, comments, postSummary, commentsSummary, tagsSummary } = await loadStoryData(id, store);
      if (!story) {
        log.warn("aggregate", "Missing story; skipping", { id });
        return;
      }

      const score = typeof story.score === "number" ? story.score : 0;
      if (score < SCORE_MIN_AGGREGATE) {
        log.debug("aggregate", "Skipping story due to low score", { id, score, min: SCORE_MIN_AGGREGATE });
        return;
      }

      const item = buildAggregatedItem(story, comments, postSummary, commentsSummary, tagsSummary);
      if (!item.postSummary) {
        log.info("aggregate", "No postSummary for story (will render placeholder)", { id: story.id });
      }
      return item;
    })
  );

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
  const fromDb = options?.fromDb === true && meta !== undefined;

  const previous = await readJsonSafeOrStore<AggregatedFile>(store, PATHS.aggregated, AggregatedFileSchema, {
    updatedISO: new Date(0).toISOString(),
    items: [],
  });

  const aggregatedExists = (await store.getText(PATHS.aggregated)) !== null;

  let sorted: AggregatedItem[];
  const changedIds = new Set<number>();

  if (fromDb && meta) {
    const storyIds = await meta.listStoryIdsForAggregate(SCORE_MIN_AGGREGATE);
    const latestItems = await meta.getAggregatedItems(storyIds);
    for (const it of latestItems) {
      const prev = previous.items.find((p) => p.id === it.id);
      if (!prev || !jsonEqual(prev, it)) {
        changedIds.add(it.id);
      }
    }
    sorted = latestItems.sort(sortItemsDesc);
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
    const merged = [...byId.values()].filter((it) => {
      const s = typeof it.score === "number" ? it.score : 0;
      return s >= SCORE_MIN_AGGREGATE;
    });
    sorted = merged.sort(sortItemsDesc);
  }

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
