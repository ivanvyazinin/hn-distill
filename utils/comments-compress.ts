import { COMMENTS_COMPRESS_POLICY_VERSION, env } from "@config/env";
import { clampToClause } from "@utils/comments-render";
import { sha256HexSync } from "@utils/hash";
import { checkSummaryHeuristics, cyrillicRatio } from "@utils/summary-heuristics";

import type { CommentsInsights, CommentsSummary } from "@config/schemas";

/** True when the second-pass compress route is active for this deploy. */
export function isCommentsCompressEnabled(): boolean {
  return env.SUMMARY_LANG === "ru" && env.COMMENTS_COMPRESS_MODEL.trim().length > 0;
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
 */
export function renderCommentsInsightsPlainText(insights: CommentsInsights): string {
  const lines = [insights.bottom_line.trim()];
  for (const insight of insights.insights) {
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

/**
 * Semantic validation of a compressed paragraph against the source plain text.
 * Compression must not expand; RU outputs must pass the cyrillic gate.
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
