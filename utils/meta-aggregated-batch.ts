import { env } from "@config/env";
import { HN } from "@utils/hn";
import { log } from "@utils/log";
import { checkSummaryHeuristics } from "@utils/summary-heuristics";

import type { AggregatedItem } from "@config/schemas";

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

export function sanitizePostSummaryDb(summary: string | undefined, context: { id: number }): string | undefined {
  if (summary === undefined || summary.length === 0) {
    return undefined;
  }
  const cleaned = summary.replaceAll("\uFFFD", "").trim();
  if (cleaned.length === 0) {
    return undefined;
  }
  const heuristics = checkSummaryHeuristics(cleaned, {
    minChars: env.POST_SUMMARY_MIN_CHARS,
    language: env.SUMMARY_LANG,
  });
  const blocking = heuristics.triggers.filter((trigger) => DROP_SUMMARY_REASONS.has(trigger.reason));
  if (blocking.length > 0) {
    log.warn("aggregate", "Dropping summary after heuristics", {
      id: context.id,
      triggers: blocking.map((t) => t.reason),
    });
    return undefined;
  }
  return cleaned;
}

function extractDomain(url?: string | null): string | undefined {
  if (url === undefined || url === null || url.length === 0) {
    return undefined;
  }
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return undefined;
  }
}

export type StoryRow = {
  id: number;
  title: string;
  url: string | null;
  by: string;
  timeISO: string;
  score: number | null;
  descendants: number | null;
};

export type SummaryMap = Map<number, { post?: string; comments?: string }>;
export type TagsMap = Map<number, string[]>;

export function buildAggregatedItemsFromRows(
  stories: StoryRow[],
  summaries: SummaryMap,
  tagsByStory: TagsMap
): AggregatedItem[] {
  const items: AggregatedItem[] = [];
  for (const story of stories) {
    const sum = summaries.get(story.id);
    const tags = [...new Set(tagsByStory.get(story.id) ?? [])];
    const postSummary = sanitizePostSummaryDb(sum?.post, { id: story.id });
    items.push({
      id: story.id,
      title: story.title,
      url: story.url,
      by: story.by,
      timeISO: story.timeISO,
      postSummary,
      commentsSummary: sum?.comments,
      score: story.score ?? undefined,
      commentsCount: story.descendants ?? undefined,
      hnUrl: HN.itemUrl(story.id),
      domain: extractDomain(story.url),
      ...(tags.length > 0 ? { tags } : {}),
    });
  }
  return items;
}
