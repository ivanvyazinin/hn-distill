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

/** Site/Telegram publish bar: need a non-empty post summary body. */
export function hasPublishablePostSummary(item: { postSummary?: string | undefined }): boolean {
  return (item.postSummary ?? "").trim().length > 0;
}

/**
 * Full site-publish eligibility: engagement gate + non-empty post summary.
 * An item that clears the score/comments bar but whose LLM/guard produced no
 * usable post body still must not become an empty card.
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
