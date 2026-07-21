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
  confidence: number;
  raw: SummaryGuardStructured;
};

type SummaryGuardStructured = z.infer<typeof SummaryGuardSchema>;

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

const GUARD_VERDICTS = [
  "nonsense",
  "not_article",
  "ok",
  "other",
  "refusal",
  "too_generic",
  "too_short",
] as const;

export const SummaryGuardSchema = z.object({
  ok: z.boolean(),
  is_article: z.boolean(),
  refusal: z.boolean(),
  verdict: z.enum(GUARD_VERDICTS),
  // Prompt requests ≤2; permissive local cap avoids rejecting a usable verdict
  // solely because the provider gave one extra explanation.
  reasons: z.array(z.string()).max(8),
  confidence: z.number().min(0).max(1),
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
      enum: [...GUARD_VERDICTS],
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
      content: `You are a strict quality gate for article summaries.
Return exactly one JSON object and always include every key:
{"ok":true,"is_article":true,"refusal":false,"verdict":"ok","reasons":[],"confidence":0.95}

Rules:
- "ok", "is_article", and "refusal" are booleans.
- "verdict" must be one of: nonsense, not_article, ok, other, refusal, too_generic, too_short.
- "confidence" is a number from 0 to 1; never omit it.
- "reasons" is always an array of at most two short strings; use [] when no reason is needed.
- Output JSON only, without Markdown or commentary.`,
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

  const structured = await openrouter.chatStructured<SummaryGuardStructured>(
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

  // Semantic rejection reasons take precedence, but the rendered contract stays
  // bounded to two distinct short reasons even when the model supplied its own list.
  const reasons = [
    ...(isArticle ? [] : ["not_article"]),
    ...(refusal ? ["refusal"] : []),
    ...rawReasons,
  ]
    .map((reason) => reason.trim())
    .filter((reason, index, all) => reason.length > 0 && all.indexOf(reason) === index)
    .slice(0, 2);

  const meetsConfidence = confidence >= minConfidence;
  const guardOk = rawOk && isArticle && !refusal && meetsConfidence;

  let verdict: SummaryGuardVerdictLabel = rawVerdict;
  if (!guardOk) {
    if (!isArticle) {
      verdict = "not_article";
    } else if (refusal) {
      verdict = "refusal";
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
