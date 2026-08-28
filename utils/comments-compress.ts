import { COMMENTS_COMPRESS_POLICY_VERSION, env } from "@config/env";
import { COMMENTS_DEDUP_THRESHOLD, containment, dedupByContainment } from "@utils/comments-dedup";
import { clampToClause } from "@utils/comments-render";
import { sha256HexSync } from "@utils/hash";
import { checkSummaryHeuristics, cyrillicRatio } from "@utils/summary-heuristics";

import type { CommentsInsights, CommentsSummary } from "@config/schemas";

/** True when the second-pass compress route is active for this deploy. */
export function isCommentsCompressEnabled(): boolean {
  return env.SUMMARY_LANG === "ru" && env.COMMENTS_COMPRESS_MODEL.trim().length > 0;
}

/**
 * Compress hops in order, deduped, empty entries dropped. The fallback exists for
 * transport failures of the free primary slot only — semantic rejects are terminal
 * and never advance to the next hop.
 */
export function commentsCompressModelChain(): string[] {
  // An empty primary is the documented kill switch for the whole route, so the
  // fallback never revives it on its own.
  const primary = env.COMMENTS_COMPRESS_MODEL.trim();
  if (primary.length === 0) {
    return [];
  }
  const fallback = env.COMMENTS_COMPRESS_FALLBACK_MODEL.trim();
  return fallback.length > 0 && fallback !== primary ? [primary, fallback] : [primary];
}

/** Exact compress prompt — do not rephrase; the plan freezes this wording. */
export const COMMENTS_COMPRESS_PROMPT =
  "Сожми текст: убери повторы, канцелярит и лишние пояснения, объедини близкие мысли. Сохрани факты, смысл и важные оговорки. Ничего не добавляй от себя. Верни только итоговый текст.";

const INSIGHT_KIND_PREFIX_RU: Record<CommentsInsights["insights"][number]["kind"], string> = {
  consensus: "",
  dispute: "Спор: ",
  advice: "Совет: ",
};

/**
 * Deterministic plain-text render of structured insights for compress input/hash.
 * Includes bottom_line + every insight (with kind prefixes); best_quote is excluded.
 *
 * Insights are deduped with the same containment pass the display renderer applies
 * (prod 49468642, 2026-08-28): without it a stage-1 near-duplicate reaches the
 * compressor twice while the raw fallback shows it once — input and fallback disagree.
 */
export function renderCommentsInsightsPlainText(insights: CommentsInsights): string {
  const texts = insights.insights.map((insight) => insight.text);
  const survivors = new Set(dedupByContainment(insights.bottom_line, texts));
  const lines = [insights.bottom_line.trim()];
  for (const [index, insight] of insights.insights.entries()) {
    if (!survivors.has(index)) {
      continue;
    }
    const prefix = INSIGHT_KIND_PREFIX_RU[insight.kind];
    lines.push(`${prefix}${insight.text.trim()}`);
  }
  return lines.filter((line) => line.length > 0).join("\n");
}

export function buildCommentsCompressUserPrompt(plainText: string): string {
  return `${COMMENTS_COMPRESS_PROMPT}\n\n${plainText}`;
}

/** Deterministic hash of compress input; sync so aggregate can resolve state without await. */
export function compressSourceHash(language: string, plainText: string): string {
  return sha256HexSync(
    JSON.stringify({
      v: COMMENTS_COMPRESS_POLICY_VERSION,
      language,
      text: plainText,
    })
  );
}

/**
 * Peel a single outer quote pair only when the interior cannot itself be a
 * multi-span quote (e.g. «X» … «Y» must NOT become X» … «Y).
 */
function stripSurroundingQuotes(value: string): string {
  const text = value.trim();
  if (text.length < 2) {
    return text;
  }
  const interior = text.slice(1, -1);
  if (text.startsWith('"') && text.endsWith('"') && !interior.includes('"')) {
    return interior.trim();
  }
  if (text.startsWith("«") && text.endsWith("»") && !interior.includes("«") && !interior.includes("»")) {
    return interior.trim();
  }
  if (text.startsWith("'") && text.endsWith("'") && !interior.includes("'")) {
    return interior.trim();
  }
  return text;
}

function stripLeadingResultLabel(value: string): string {
  // Simple anchored prefixes only — avoid nested quantifiers (ReDoS-prone).
  return value
    .replace(/^\*{0,2}_{0,2}итоговый\s+текст\*{0,2}_{0,2}\s*[:—-]\s*/iu, "")
    .replace(/^\*{0,2}_{0,2}итог\*{0,2}_{0,2}\s*[:—-]\s*/iu, "")
    .trim();
}

export function sanitizeCompressedOutput(raw: string): string {
  let text = raw.trim();
  // Strip a single surrounding fenced block.
  const fence = /^```(?:\w+)?\s*\n?([\s\S]*?)\n?```$/u.exec(text);
  if (fence?.[1] !== undefined) {
    text = fence[1].trim();
  }
  // Quotes may wrap the whole answer including a label — peel both, twice.
  text = stripSurroundingQuotes(text);
  text = stripLeadingResultLabel(text);
  text = stripSurroundingQuotes(text);
  // Collapse to a single paragraph.
  text = text.replaceAll(/\s+/gu, " ").trim();
  return clampToClause(text);
}

export type CompressedValidationResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

const MIN_DUP_SENTENCE_WORDS = 4;

/**
 * Split the single-paragraph compressed output into sentences for repeat
 * detection. Closing quotes (`»`, `"`) end a quoted sentence ("…чинить.» Next"),
 * so they terminate too; over-splitting is safe because fragments below the
 * word gate never enter comparison.
 */
function splitCompressedSentences(text: string): string[] {
  return text
    .split(/(?<=[!"'.?»…])\s+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function countWords(text: string): number {
  const normalized = text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll(/[^\s\p{L}\p{N}]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return normalized.length === 0 ? 0 : normalized.split(" ").length;
}

/**
 * First repeated sentence pair (1-based positions in the reject reason), or
 * undefined. Token-set containment with the same 0.7 bar as the display dedup
 * catches both verbatim repeats and one-fact-twice rewordings; sentences under
 * the word gate are ignored so stock phrases cannot false-positive.
 * Prod basis (49468642, 2026-08-28): the compressor emitted the same thesis
 * twice verbatim (containment 1.0) while the clean remainder peaked at 0.23.
 */
function findDuplicateSentence(text: string): { index: number; prior: number } | undefined {
  const sentences = splitCompressedSentences(text);
  for (let index = 1; index < sentences.length; index += 1) {
    const current = sentences[index];
    if (current === undefined || countWords(current) < MIN_DUP_SENTENCE_WORDS) {
      continue;
    }
    for (let prior = 0; prior < index; prior += 1) {
      const candidate = sentences[prior];
      if (candidate === undefined || countWords(candidate) < MIN_DUP_SENTENCE_WORDS) {
        continue;
      }
      if (containment(current, candidate) >= COMMENTS_DEDUP_THRESHOLD) {
        return { index, prior };
      }
    }
  }
  return undefined;
}

/**
 * Semantic validation of a compressed paragraph against the source plain text.
 * Compression must not expand; RU outputs must pass the cyrillic gate; repeated
 * sentences are a model defect and reject the text (the raw render is the
 * fallback, so a reject never unpublishes the summary).
 */
export function validateCompressedText(
  text: string,
  sourcePlainText: string,
  options: { language: "en" | "ru"; minChars?: number; minCyrillicRatio?: number } = {
    language: "ru",
  }
): CompressedValidationResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty" };
  }
  const minChars = options.minChars ?? env.COMMENTS_SUMMARY_MIN_CHARS;
  if (trimmed.length < minChars) {
    return { ok: false, reason: `too_short:${trimmed.length}<${minChars}` };
  }
  if (trimmed.length > sourcePlainText.length) {
    return { ok: false, reason: `expanded:${trimmed.length}>${sourcePlainText.length}` };
  }
  if (options.language === "ru") {
    const minimum = options.minCyrillicRatio ?? env.COMMENTS_MIN_CYRILLIC_RATIO;
    const ratio = cyrillicRatio(trimmed);
    if (ratio < minimum) {
      return { ok: false, reason: `low_cyrillic_ratio:${ratio.toFixed(3)}` };
    }
  }
  const duplicate = findDuplicateSentence(trimmed);
  if (duplicate !== undefined) {
    return { ok: false, reason: `duplicate_sentence:${duplicate.prior + 1}==${duplicate.index + 1}` };
  }
  const heuristics = checkSummaryHeuristics(trimmed, {
    kind: "comments",
    language: options.language,
    minChars,
  });
  if (!heuristics.ok) {
    return {
      ok: false,
      reason: heuristics.triggers.map((trigger) => trigger.reason).join(","),
    };
  }
  return { ok: true, text: trimmed };
}

/**
 * Reject reasons that are a verdict on the source, not on the model: any hop would
 * fail them the same way, so they end the chain and write the terminal marker.
 */
const TERMINAL_COMPRESS_REJECT_REASONS = new Set(["expanded", "too_short"]);

/**
 * True when a semantic reject looks model-specific and the next hop is worth a call.
 *
 * Evidence (prod 2026-08-27): the free minimax slot drifts into English and trips
 * the cyrillic/latin gates on inputs the paid hop compressed fine on the probe —
 * treating every reject as terminal froze those cards on the raw bullet render.
 * Size verdicts (expanded / too_short) stay terminal: they describe the source.
 */
export function isRetriableCompressReject(reason: string): boolean {
  const tokens = reason
    .split(",")
    .map((part) => part.split(":")[0]?.trim() ?? "")
    .filter((part) => part.length > 0);
  if (tokens.length === 0) {
    return false;
  }
  return tokens.some((token) => !TERMINAL_COMPRESS_REJECT_REASONS.has(token));
}

export type CompressedState = "usable" | "rejected" | "retryable";

/**
 * Sole implementation of the compressed-state table from the plan contract.
 * Used by pipeline, aggregate, and backfill.
 */
export function resolveCompressedState(
  summary: Pick<CommentsSummary, "compressed">,
  expectedSourceHash: string
): CompressedState {
  const compressed = summary.compressed;
  if (compressed === undefined) {
    return "retryable";
  }
  if (compressed.sourceHash !== expectedSourceHash) {
    return "retryable";
  }
  if (compressed.text === "") {
    return "rejected";
  }
  return "usable";
}

/** Expected compress sourceHash for a structured summary, or undefined when nothing to compress. */
export function expectedCompressSourceHash(
  summary: Pick<CommentsSummary, "lang" | "structured">
): string | undefined {
  if (summary.structured === undefined) {
    return undefined;
  }
  return compressSourceHash(summary.lang, renderCommentsInsightsPlainText(summary.structured));
}

/** resolveCompressedState against the summary's own structured payload. */
export function compressedStateFor(
  summary: Pick<CommentsSummary, "lang" | "structured" | "compressed">
): CompressedState | undefined {
  const expected = expectedCompressSourceHash(summary);
  if (expected === undefined) {
    return undefined;
  }
  return resolveCompressedState(summary, expected);
}

/** Permanent HTTP client errors that must not be retried every cron (bad model id, auth, …). */
export function isPermanentCompressHttpError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current instanceof Error && "status" in current) {
      const status = (current as { status?: number }).status;
      if (typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429) {
        return true;
      }
    }
    if (!(current instanceof Error) || current.cause === undefined) {
      break;
    }
    current = current.cause;
  }
  return false;
}
