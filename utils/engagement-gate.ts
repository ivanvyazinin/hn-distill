/**
 * Engagement gate shared by summarize (LLM spend) and aggregate/site (publish).
 *
 * A story qualifies when NO criterion is enabled (both thresholds 0 → gate off),
 * OR any enabled criterion is met (OR semantics). Boundary values pass
 * (score === minScore → pass). Missing score/comments count as 0.
 *
 * Callers map their own metrics:
 * - raw HN story → { score: story.score, comments: story.descendants }
 * - aggregated item → { score: item.score, comments: item.commentsCount }
 */
export type EngagementMetrics = {
  score?: number | undefined;
  comments?: number | undefined;
};

export type EngagementThresholds = {
  minScore: number;
  minComments: number;
};

export function passesEngagementGate(
  metrics: EngagementMetrics,
  thresholds: EngagementThresholds
): boolean {
  const { minScore, minComments } = thresholds;
  if (!(minScore > 0 || minComments > 0)) {
    return true;
  }
  return (
    (minScore > 0 && (metrics.score ?? 0) >= minScore) ||
    (minComments > 0 && (metrics.comments ?? 0) >= minComments)
  );
}

/** Telegram publish bar: that channel posts the article summary, so it needs one. */
export function hasPublishablePostSummary(item: { postSummary?: string | undefined }): boolean {
  return (item.postSummary ?? "").trim().length > 0;
}

/**
 * Full site-publish eligibility: engagement gate + a non-empty post summary.
 *
 * Accepting a comments-only card looks right in isolation -- it would rescue
 * stories whose article was unreachable -- but it was tried on 2026-08-02 and
 * reverted within the hour. `commentsSummary` is not always an LLM summary:
 * `fallbackFromRaw` fills it with the first 280 characters of raw comment text,
 * and the archive is full of items whose post summary was dropped by the
 * aggregate heuristics. Relaxing the bar published 868 such cards at once,
 * mostly 2025 backlog rendering untranslated raw English snippets.
 *
 * A comments-only card therefore needs the fallback text told apart from a real
 * summary first; see docs/ops/2026-08-01/report.md.
 */
export function isSitePublishable(
  item: {
    score?: number | undefined;
    commentsCount?: number | undefined;
    postSummary?: string | undefined;
  },
  thresholds: EngagementThresholds
): boolean {
  return (
    passesEngagementGate(
      { score: item.score, comments: item.commentsCount },
      thresholds
    ) && hasPublishablePostSummary(item)
  );
}
