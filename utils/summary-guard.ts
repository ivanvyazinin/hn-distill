import { z } from "zod";

import { log } from "@utils/log";

import type { Env } from "@config/env";
import type { JsonSchema, OpenRouter } from "@utils/openrouter";

export type SummaryGuardVerdictLabel =
  | "nonsense"
  | "not_article"
  | "ok"
  | "other"
  | "refusal"
  | "too_generic"
  | "too_short";

export type SummaryGuardResult = {
  ok: boolean;
  verdict: SummaryGuardVerdictLabel;
  reasons: string[];
  confidence?: number | undefined;
  raw: SummaryGuardStructured;
};

type SummaryGuardStructured = {
  ok: boolean;
  verdict?: SummaryGuardVerdictLabel | undefined;
  reasons?: string[] | undefined;
  confidence?: number | undefined;
  is_article?: boolean | undefined;
  refusal?: boolean | undefined;
};

type SummaryGuardInput = {
  summary: string;
  articleSlice: string;
  envLike: Pick<
    Env,
    | "POST_GUARD_ARTICLE_MAX_CHARS"
    | "POST_GUARD_MAX_TOKENS"
    | "POST_GUARD_MIN_CONFIDENCE"
    | "POST_GUARD_MODEL"
    | "SUMMARY_LANG"
  >;
};

const GUARD_DEBUG_NAMESPACE = "summary-guard" as const;

export const SummaryGuardSchema = z.object({
  ok: z.boolean(),
  is_article: z.boolean().optional(),
  refusal: z.boolean().optional(),
  verdict: z.enum(["nonsense", "not_article", "ok", "other", "refusal", "too_generic", "too_short"]).optional(),
  reasons: z.array(z.string()).max(8).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

/** Provider-facing schema used by production guard calls and model probes. */
export const SummaryGuardStrictJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    is_article: { type: "boolean", description: "true if the summary clearly matches the article" },
    refusal: { type: "boolean", description: "true if the summary is a refusal or policy response" },
    verdict: {
      type: "string",
      enum: ["nonsense", "not_article", "ok", "other", "refusal", "too_generic", "too_short"],
    },
    reasons: {
      type: "array",
      items: { type: "string" },
    },
    confidence: {
      type: "number",
    },
  },
  // Groq structured outputs (strict) require every declared property in `required` and reject
  // maxItems/minimum/maximum. The zod schema still enforces those bounds after parsing.
  required: ["ok", "is_article", "refusal", "verdict", "reasons", "confidence"],
  additionalProperties: false,
};

export async function runSummaryGuard(openrouter: OpenRouter, input: SummaryGuardInput): Promise<SummaryGuardResult> {
  const { articleSlice, summary, envLike } = input;
  const snippet = truncate(articleSlice, envLike.POST_GUARD_ARTICLE_MAX_CHARS);

  const schema = SummaryGuardStrictJsonSchema;

  const messages = [
    {
      role: "system" as const,
      content:
        "You are a strict content quality gate for article summaries. Decide if the candidate summary accurately and safely represents the article excerpt. Respond ONLY in JSON.",
    },
    {
      role: "user" as const,
      content: buildGuardPrompt({
        language: envLike.SUMMARY_LANG,
        summary,
        articleSnippet: snippet,
      }),
    },
  ];

  log.debug(GUARD_DEBUG_NAMESPACE, "Guard request", {
    model: envLike.POST_GUARD_MODEL,
    summaryChars: summary.length,
    articleChars: snippet.length,
  });

  const structured = await openrouter.chatStructured<z.infer<typeof SummaryGuardSchema>>(
    messages,
    {
      temperature: 0.1,
      maxTokens: envLike.POST_GUARD_MAX_TOKENS,
      model: envLike.POST_GUARD_MODEL,
      label: "guard",
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: "summary_guard",
          strict: true,
          schema,
        },
      },
    },
    SummaryGuardSchema,
    2
  );

  const normalized = normalizeGuard(structured, envLike.POST_GUARD_MIN_CONFIDENCE);

  log.info(GUARD_DEBUG_NAMESPACE, "Guard verdict", {
    model: envLike.POST_GUARD_MODEL,
    ok: normalized.ok,
    verdict: normalized.verdict,
    confidence: normalized.confidence,
    reasons: normalized.reasons,
  });

  return normalized;
}

function truncate(input: string, limit: number): string {
  if (input.length <= limit) {
    return input;
  }
  return `${input.slice(0, limit)}…`;
}

function buildGuardPrompt(payload: { language: string; summary: string; articleSnippet: string }): string {
  const lines = [
    `Language: ${payload.language}`,
    "Evaluate whether the candidate summary is acceptable.",
    "Article excerpt:",
    "---",
    payload.articleSnippet,
    "---",
    "Candidate summary:",
    "---",
    payload.summary,
    "---",
    "Respond with JSON following the provided schema.",
  ];
  return lines.join("\n");
}

function normalizeGuard(raw: SummaryGuardStructured, minConfidence: number): SummaryGuardResult {
  const { ok: rawOk, is_article: isArticle, refusal, verdict: rawVerdict, reasons: rawReasons, confidence } = raw;

  const reasons = Array.isArray(rawReasons) ? rawReasons.filter((reason) => reason.trim().length > 0) : [];

  if (isArticle === false && !reasons.includes("not_article")) {
    reasons.push("not_article");
  }

  if (refusal === true && !reasons.includes("refusal")) {
    reasons.push("refusal");
  }

  const meetsConfidence = confidence === undefined || confidence >= minConfidence;
  const guardOk = rawOk && isArticle !== false && refusal !== true && meetsConfidence;

  let verdict: SummaryGuardVerdictLabel = rawVerdict ?? "other";
  if (!guardOk) {
    if (isArticle === false) {
      verdict = "not_article";
    } else if (refusal === true) {
      verdict = "refusal";
    } else if (rawVerdict === undefined) {
      verdict = "other";
    }
  }

  return {
    ok: guardOk,
    verdict,
    reasons,
    confidence,
    raw,
  };
}
