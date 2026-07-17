import { COMMENTS_COMPRESS_POLICY_VERSION, env } from "@config/env";
import { clampToClause } from "@utils/comments-render";
import { sha256HexSync } from "@utils/hash";
import { checkSummaryHeuristics, cyrillicRatio } from "@utils/summary-heuristics";

import type { CommentsInsights, CommentsSummary } from "@config/schemas";

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
 * Strip common model wrappers (code fences, surrounding quotes, "Итоговый текст:"
 * labels) and collapse to a single paragraph, then clamp mid-word cuts.
 */
function stripSurroundingQuotes(value: string): string {
  let text = value.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("«") && text.endsWith("»")) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function stripLeadingResultLabel(value: string): string {
  return value
    .replace(/^(?:\*{0,2}|_{0,2})?итоговый\s+текст(?:\*{0,2}|_{0,2})?\s*[:—-]\s*/iu, "")
    .replace(/^(?:\*{0,2}|_{0,2})?итог(?:\*{0,2}|_{0,2})?\s*[:—-]\s*/iu, "")
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
