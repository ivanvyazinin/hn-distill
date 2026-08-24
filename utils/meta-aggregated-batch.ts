import { env } from "@config/env";
import { HN } from "@utils/hn";
import { log } from "@utils/log";
import { recordDrop } from "@utils/summary-drops";
import { checkSummaryHeuristics, languageGateFromEnv } from "@utils/summary-heuristics";

import type { AggregatedItem } from "@config/schemas";

const DROP_SUMMARY_REASONS: Record<string, true> = {
  empty: true,
  too_short: true,
  too_few_words: true,
  refusal: true,
  apology: true,
  policy: true,
  artifact: true,
  bullets_only: true,
  meta_instructions: true,
  redirects_to_article: true,
  content_free: true,
  repetition_run: true,
  low_unique_ratio: true,
  url_encoded_noise: true,
};

const POST_SUMMARY_ARTIFACT = "<｜begin▁of▁sentence｜>";

export type PostSummaryGuardPersisted = {
  ok?: boolean;
  verdict?: string;
  reasons?: string[];
  confidence?: number;
};

// Single publish-time sanitizer for both aggregation branches (object-store
// files and DB rows): strips artifacts, applies the guard veto, then heuristics.
export function sanitizePostSummaryForPublish(
  summary: string | undefined,
  options: { id: number; guard?: PostSummaryGuardPersisted }
): string | undefined {
  if (summary === undefined || summary.length === 0) {
    return undefined;
  }
  const cleaned = summary.replaceAll(POST_SUMMARY_ARTIFACT, "").replaceAll("\uFFFD", "").trim();
  if (cleaned.length === 0) {
    return undefined;
  }

  const { id, guard } = options;
  if (guard && guard.ok === false) {
    log.debug("aggregate", "Dropping summary flagged by guard", {
      id,
      verdict: guard.verdict,
      reasons: guard.reasons,
    });
    recordDrop({
      id,
      stage: "guard",
      reasons: guard.verdict === undefined ? ["guard"] : [guard.verdict],
    });
    return undefined;
  }

  const heuristics = checkSummaryHeuristics(cleaned, {
    minChars: env.POST_SUMMARY_MIN_CHARS,
    language: env.SUMMARY_LANG,
    kind: "post",
    languageGate: languageGateFromEnv(env),
  });
  const blocking = heuristics.triggers.filter((trigger) => DROP_SUMMARY_REASONS[trigger.reason] === true);
  if (blocking.length > 0) {
    const reasons = blocking.map((t) => t.reason);
    log.debug("aggregate", "Dropping summary after heuristics", { id, triggers: reasons });
    recordDrop({ id, stage: "heuristics", reasons });
    return undefined;
  }

  if (!heuristics.ok) {
    log.info("aggregate", "Summary passed with non-blocking triggers", {
      id,
      triggers: heuristics.triggers.map((t) => t.reason),
    });
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

export type PresentCommentsSummary = {
  present: true;
  summary: string;
};

// The DB contract stores only the rendered string. Row presence is therefore
// the v2 marker for an intentional empty result; legacy zero-comment runs did
// not persist a comments summary row.
export type SummaryMap = Map<number, { post?: string; comments?: PresentCommentsSummary }>;
export type TagsMap = Map<number, string[]>;

export function presentCommentsSummary(summary: string): PresentCommentsSummary {
  return { present: true, summary };
}

export function resolveCommentsSummary(
  persisted: PresentCommentsSummary | undefined,
  fallback?: string
): string | undefined {
  return persisted === undefined ? fallback : persisted.summary;
}

export function buildAggregatedItemsFromRows(
  stories: StoryRow[],
  summaries: SummaryMap,
  tagsByStory: TagsMap
): AggregatedItem[] {
  const items: AggregatedItem[] = [];
  for (const story of stories) {
    const sum = summaries.get(story.id);
    const tags = [...new Set(tagsByStory.get(story.id) ?? [])];
    const postSummary = sanitizePostSummaryForPublish(sum?.post, { id: story.id });
    items.push({
      id: story.id,
      title: story.title,
      url: story.url,
      by: story.by,
      timeISO: story.timeISO,
      postSummary,
      commentsSummary: resolveCommentsSummary(sum?.comments),
      score: story.score ?? undefined,
      commentsCount: story.descendants ?? undefined,
      hnUrl: HN.itemUrl(story.id),
      domain: extractDomain(story.url),
      ...(tags.length > 0 ? { tags } : {}),
    });
  }
  return items;
}
