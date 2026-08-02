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
 * Site publish bar: at least one of the two bodies must carry content.
 *
 * Requiring the post summary used to drop the whole card when the article was
 * unreachable (paywall/bot protection) or the guard rejected the draft, even
 * though the discussion summary was already generated and paid for. Three
 * stories were lost that way over 2026-07-29..08-01, two of them above 550
 * points. The templates already render a comments-only card.
 */
export function hasPublishableBody(item: {
  postSummary?: string | undefined;
  commentsSummary?: string | undefined;
}): boolean {
  return (item.postSummary ?? "").trim().length > 0 || (item.commentsSummary ?? "").trim().length > 0;
}

/**
 * Full site-publish eligibility: engagement gate + at least one usable body.
 * An item that clears the score/comments bar with neither summary still must
 * not become an empty card.
 */
export function isSitePublishable(
  item: {
    score?: number | undefined;
    commentsCount?: number | undefined;
    postSummary?: string | undefined;
    commentsSummary?: string | undefined;
  },
  thresholds: EngagementThresholds
): boolean {
  return (
    passesEngagementGate(
      { score: item.score, comments: item.commentsCount },
      thresholds
    ) && hasPublishableBody(item)
  );
}
