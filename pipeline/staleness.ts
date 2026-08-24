import { COMMENTS_POLICY_VERSION, env, EXTRACT_POLICY_VERSION, type Env } from "@config/env";
import { pathFor } from "@config/paths";
import {
  NormalizedCommentSchema,
  PostSummarySchema,
  type CommentsSummary,
  type NormalizedStory,
} from "@config/schemas";
import { compressedStateFor, isCommentsCompressEnabled } from "@utils/comments-compress";
import { buildCommentsPromptV2, commentsInputHash } from "@utils/comments-thread";
import { sha256Hex } from "@utils/hash";
import { readJsonSafe, readJsonSafeOrStore, type ObjectStore } from "@utils/object-store";

import type { z } from "zod";

type PostSummaryRecord = z.infer<typeof PostSummarySchema>;

/**
 * Single owner of summary-freshness decisions (Phase 1 of
 * docs/plan-architecture-fixes.md): what counts as stale for post summaries and
 * comments summaries, and which input hashes govern regeneration. Selection
 * (local pre-selection, the worker selector) and processing (processSingleStory
 * paths) both ask this module instead of re-deriving gates locally — scripts
 * never assemble input hashes by hand.
 *
 * Known intentional asymmetry preserved until behaviour is unified explicitly:
 * selection (commentsSelectionChanged) treats a policy bump as regen even when
 * the descendants count gate would hold, while stage-1 processing
 * (commentsStage1Verdict) lets a within-threshold count gate keep the blob.
 */

export type ExtractDetectorPolicy = Pick<
  Env,
  "EXTRACT_MAX_DUP_RATIO" | "EXTRACT_MAX_LINK_DENSITY" | "EXTRACT_MIN_PROSE_CHARS"
>;

/**
 * Input hash for a post summary. Includes both the code policy version and the
 * runtime detector thresholds: changing a verdict must also replace the current
 * summary/stub. Keep the inputs identical in processing and pre-selection.
 */
export async function postInputHash(
  lang: string,
  articleSlice: string,
  detectorPolicy: ExtractDetectorPolicy
): Promise<string> {
  const detectorFingerprint = [
    detectorPolicy.EXTRACT_MIN_PROSE_CHARS,
    detectorPolicy.EXTRACT_MAX_LINK_DENSITY,
    detectorPolicy.EXTRACT_MAX_DUP_RATIO,
  ].join("|");
  return await sha256Hex(`${lang}|${EXTRACT_POLICY_VERSION}|${detectorFingerprint}|${articleSlice}`);
}

/** Input hash for a comments summary; policy version comes from this module. */
export async function commentsFreshnessInputHash(language: CommentsSummary["lang"], preparedPrompt: string): Promise<string> {
  return await commentsInputHash(language, COMMENTS_POLICY_VERSION, preparedPrompt);
}

export function isInsideCooldown(iso: string | undefined, now: number, cooldownMs: number): boolean {
  if (iso === undefined || iso.length === 0 || cooldownMs <= 0) {
    return false;
  }
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && now - ts < cooldownMs;
}

/**
 * Second-pass compress is due (and may run even inside a cooldown): only for a
 * healthy structured v2 blob whose compressed field is absent or stale, while
 * the route is actually enabled for this deploy.
 */
export function isCompressRetryable(existing: CommentsSummary | null | undefined): boolean {
  return (
    isCommentsCompressEnabled() &&
    existing !== null &&
    existing !== undefined &&
    existing.formatVersion === 2 &&
    existing.structured !== undefined &&
    existing.degraded === undefined &&
    compressedStateFor(existing) === "retryable"
  );
}

export type CommentsStage1Verdict = {
  /** Blob matches current inputs; only meta repair / lazy compress remains. */
  upToDate: boolean;
  /** Descendants growth stayed within threshold (kept despite hash drift). */
  countGatedFresh: boolean;
  descendantsDelta?: number;
  reason: string;
};

/**
 * Stage-1 freshness as processCommentsSummary applies it (no cooldown arm —
 * callers pre-filter). A deterministic generation-failed fallback never counts
 * as hash-up-to-date; a within-threshold descendants delta can keep an
 * otherwise hash-stale blob.
 */
export function commentsStage1Verdict(input: {
  story: NormalizedStory;
  existing: CommentsSummary;
  currentInputHash: string;
}): CommentsStage1Verdict {
  const { story, existing, currentInputHash } = input;
  const retryableFallback = existing.degraded === "generation-failed";
  const hashUpToDate =
    existing.inputHash === currentInputHash && existing.formatVersion === 2 && !retryableFallback;

  // Count gate on full HN thread size (story.descendants), not the capped fetch.
  // Only healthy (non-degraded) blobs are gated: too-few-comments must keep the
  // hash path so a thin early thread can still upgrade once real comments arrive
  // with growth ≤ threshold. Negative delta (moderated shrink) counts as "within
  // threshold" and keeps the existing summary — rare on HN, inherent to count gating.
  let descendantsDelta: number | undefined;
  if (
    existing.formatVersion === 2 &&
    existing.degraded === undefined &&
    !retryableFallback &&
    env.COMMENTS_REGEN_MIN_NEW_COMMENTS > 0 &&
    existing.policyVersion === COMMENTS_POLICY_VERSION &&
    existing.processedDescendants !== undefined &&
    story.descendants !== undefined
  ) {
    descendantsDelta = story.descendants - existing.processedDescendants;
  }
  const countForcesRegen =
    descendantsDelta !== undefined && descendantsDelta > env.COMMENTS_REGEN_MIN_NEW_COMMENTS;
  const countGatedFresh =
    descendantsDelta !== undefined && descendantsDelta <= env.COMMENTS_REGEN_MIN_NEW_COMMENTS;
  const upToDate = !countForcesRegen && (hashUpToDate || countGatedFresh);

  let reason = "hash-drift";
  if (upToDate) {
    reason = hashUpToDate ? "hash-up-to-date" : "descendants-delta-within-threshold";
  } else if (countForcesRegen) {
    reason = "descendants-delta-over-threshold";
  } else if (existing.degraded === "generation-failed") {
    reason = "generation-failed-retryable";
  }
  return {
    upToDate,
    countGatedFresh,
    ...(descendantsDelta === undefined ? {} : { descendantsDelta }),
    reason,
  };
}

export type CommentsSelectionVerdict = {
  /** True when selection must pick the story for processing. */
  changed: boolean;
  reason: string;
};

/**
 * Freshness as selection sees it (local pre-selection and the worker selector).
 * Ordering matters and is pinned by tests/summarize.staleness-freeze.test.ts:
 * generation-failed and compress-retryable ignore cooldown; cooldown short-
 * circuits BEFORE the policy-bump check; a within-threshold descendants delta
 * does not override a policy bump here (unlike stage-1 above).
 */
export async function commentsSelectionChanged(input: {
  story: NormalizedStory;
  existing: CommentsSummary | null | undefined;
  language: Env["SUMMARY_LANG"];
  cooldownMs: number;
  now: number;
  store: ObjectStore;
}): Promise<CommentsSelectionVerdict> {
  const { story, existing, language, cooldownMs, now, store } = input;
  if (!existing) {
    return { changed: true, reason: "no-existing-summary" };
  }
  // A deterministic fallback is intentionally not protected by the normal
  // cooldown: it exists only to keep the card visible until generation works.
  if (existing.degraded === "generation-failed") {
    return { changed: true, reason: "generation-failed-retryable" };
  }
  // Compress retry must run even inside cooldown — but only when compress is
  // actually enabled. With COMMENTS_COMPRESS_MODEL="" or SUMMARY_LANG=en every
  // structured blob would otherwise look eternally retryable and starve real work.
  if (isCompressRetryable(existing)) {
    return { changed: true, reason: "compress-retryable" };
  }
  if (isInsideCooldown(existing.createdISO, now, cooldownMs)) {
    return { changed: false, reason: "cooldown" };
  }
  // Policy bump always forces regen, even when the count gate would hold.
  if (existing.policyVersion !== undefined && existing.policyVersion !== COMMENTS_POLICY_VERSION) {
    return { changed: true, reason: "policy-version-changed" };
  }
  // Cheap short-circuit on full HN thread size (story.descendants), not the capped
  // fetch sample. Threshold 0 disables. Blobs without processedDescendants, or
  // stories without descendants, fall through to inputHash (one regen backfills
  // the field). Negative delta (moderated shrink) is "within threshold".
  if (
    env.COMMENTS_REGEN_MIN_NEW_COMMENTS > 0 &&
    existing.formatVersion === 2 &&
    existing.degraded === undefined &&
    existing.policyVersion === COMMENTS_POLICY_VERSION &&
    existing.processedDescendants !== undefined &&
    story.descendants !== undefined
  ) {
    const delta = story.descendants - existing.processedDescendants;
    return delta > env.COMMENTS_REGEN_MIN_NEW_COMMENTS
      ? { changed: true, reason: "descendants-delta-over-threshold" }
      : { changed: false, reason: "descendants-delta-within-threshold" };
  }
  const comments = await readJsonSafeOrStore<NormalizedComment[]>(
    store,
    pathFor.rawComments(story.id),
    NormalizedCommentSchema.array() as unknown as z.ZodType<NormalizedComment[]>,
    []
  );
  const postSummary = await readJsonSafe(store, pathFor.postSummary(story.id), PostSummarySchema);
  const prepared = buildCommentsPromptV2({
    story,
    comments,
    ...(postSummary === undefined ? {} : { postSummary }),
    language,
    maxChars: env.COMMENTS_PROMPT_MAX_CHARS,
  });
  const hash = await commentsInputHash(language, COMMENTS_POLICY_VERSION, prepared.prompt);
  return existing.formatVersion !== 2 || existing.inputHash !== hash
    ? { changed: true, reason: "hash-drift" }
    : { changed: false, reason: "hash-up-to-date" };
}

type NormalizedComment = z.infer<typeof NormalizedCommentSchema>;

export type PostSelectionVerdict = {
  changed: boolean;
  reason: string;
};

/**
 * Post freshness as pre-selection applies it (computePostChanged semantics):
 * missing → changed; ONLY_IF_MISSING mode → unchanged; cooldown on createdISO →
 * unchanged; without cached article bytes we cannot detect input drift →
 * unchanged. The article-slice builder is injected to keep this module free of
 * pipeline imports.
 */
export async function postSelectionChanged(input: {
  story: NormalizedStory;
  existingPost: PostSummaryRecord | null | undefined;
  summaryLang: string;
  detectorPolicy: ExtractDetectorPolicy;
  postSummaryOnlyIfMissing: boolean;
  cooldownMs: number;
  now: number;
  getCachedArticleMarkdown: (story: NormalizedStory) => Promise<string | undefined>;
  buildArticleSlice: (story: NormalizedStory, articleMd: string) => Promise<string>;
}): Promise<PostSelectionVerdict> {
  const { story, existingPost, summaryLang, detectorPolicy, postSummaryOnlyIfMissing, now, cooldownMs } = input;
  if (!existingPost) {
    return { changed: true, reason: "no-existing-summary" };
  }
  if (postSummaryOnlyIfMissing) {
    return { changed: false, reason: "only-if-missing" };
  }
  if (isInsideCooldown(existingPost.createdISO, now, cooldownMs)) {
    return { changed: false, reason: "cooldown" };
  }
  const cachedMd = await input.getCachedArticleMarkdown(story);
  if (cachedMd === undefined) {
    return { changed: false, reason: "no-cached-article" };
  }
  const slice = await input.buildArticleSlice(story, cachedMd);
  const hash = await postInputHash(summaryLang, slice, detectorPolicy);
  return existingPost.inputHash === hash
    ? { changed: false, reason: "hash-up-to-date" }
    : { changed: true, reason: "hash-drift" };
}
