/**
 * Phase 1 explicit-route adapter for the cheap-Groq comments eval.
 *
 * Runs ONE comments-v2 generation against ONE explicitly chosen Groq model with full
 * telemetry, without the ambient model chain / fallback. It reuses the production prompt
 * (buildCommentsPromptV2), the production Zod schema (CommentsInsightsSchema), and the
 * exact production post-validation (quote provenance → insight ceiling → language/format
 * heuristics → render → min-chars) composed from the same exported building blocks
 * pipeline/summarize.ts uses — so a route only chooses provider/model/output-cap/timeout,
 * it never changes the prompt, schema, or acceptance criteria.
 *
 * Telemetry per attempt: requested + resolved model, prompt/completion/total tokens
 * (via the client's usage sink), HTTP status (413/429/… from the thrown HttpError),
 * and latency. NOTE: the shared HTTP client does not surface response rate-limit
 * headers (HttpError carries only url + status), so retry-after / x-ratelimit-remaining
 * are unavailable here — the caller paces proactively with a local TPM reservation and
 * backs off a fixed amount on a 429. True header introspection would need a client
 * extension (out of Phase 1 scope; noted in the handoff).
 */
import { env } from "@config/env";
import { CommentsInsightsSchema } from "@config/schemas";
import { renderCommentsSummaryMarkdown, validateCommentsQuote } from "@utils/comments-render";
import { buildCommentsPromptV2, buildCommentsSystemInstructionV2 } from "@utils/comments-thread";
import { HttpClient, HttpError } from "@utils/http-client";
import { OpenRouter, type ChatMessage } from "@utils/openrouter";
import { checkCommentsInsightsHeuristics } from "@utils/summary-heuristics";

import type { CommentsInsights, NormalizedComment, NormalizedStory } from "@config/schemas";
import type { UsageInput } from "@utils/llm-usage";

export type CommentsRoute = {
  label: string;
  gateway: "groq";
  model: string;
  maxTokens: number;
  temperature: number;
  requestTimeoutMs: number;
};

export type CommentsRouteAttempt = {
  requestedModel: string;
  resolvedModel?: string;
  status: "error" | "ok";
  httpStatus?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  error?: string;
};

export type CommentsRouteResult = {
  storyId: number;
  validationPassed: boolean;
  rejectedReason?: string;
  summary: string;
  summaryChars: number;
  insights?: CommentsInsights;
  quoteEmitted: boolean;
  /** false ONLY when a quote was emitted but failed provenance (the gate's "provenance failure"). */
  quoteProvenanceOk: boolean;
  promptChars: number;
  includedComments: number;
  attempt: CommentsRouteAttempt;
};

export type CommentsRouteFixture = {
  story: Pick<NormalizedStory, "id" | "title">;
  comments: NormalizedComment[];
};

type ValidationOutcome =
  | { ok: false; reason: string; quoteEmitted: boolean; quoteProvenanceOk: boolean }
  | { ok: true; insights: CommentsInsights; summary: string; quoteEmitted: boolean; quoteProvenanceOk: boolean };

/**
 * Faithful copy of pipeline/summarize.ts `validateCommentsInsightsCandidate`, composed
 * from the same exported helpers so the eval accepts/rejects exactly what production
 * would. Additionally surfaces whether an emitted quote failed provenance (dropped).
 */
function validateCandidateInsights(
  insights: CommentsInsights,
  comments: NormalizedComment[],
  sampleIds: number[],
  maxInsights: number
): ValidationOutcome {
  let effective: CommentsInsights = insights;
  const quoteEmitted = insights.best_quote !== null;
  let quoteProvenanceOk = true;
  if (insights.best_quote !== null) {
    const quote = validateCommentsQuote(insights, comments);
    if (quote === undefined || !sampleIds.includes(quote.commentId)) {
      quoteProvenanceOk = false;
      // eslint-disable-next-line unicorn/no-null -- schema uses null for "no quote"
      effective = { ...insights, best_quote: null };
    }
  }
  if (effective.insights.length > maxInsights) {
    effective = { ...effective, insights: effective.insights.slice(0, maxInsights) };
  }
  const heuristics = checkCommentsInsightsHeuristics(effective, {
    language: env.SUMMARY_LANG,
    minCyrillicRatio: env.COMMENTS_MIN_CYRILLIC_RATIO,
  });
  if (!heuristics.ok) {
    return { ok: false, reason: `heuristics:${heuristics.triggers.map((t) => t.reason).join(",")}`, quoteEmitted, quoteProvenanceOk };
  }
  const summary = renderCommentsSummaryMarkdown(effective, { language: env.SUMMARY_LANG, comments });
  if (summary.trim().length < env.COMMENTS_SUMMARY_MIN_CHARS) {
    return { ok: false, reason: "too_short", quoteEmitted, quoteProvenanceOk };
  }
  return { ok: true, insights: effective, summary, quoteEmitted, quoteProvenanceOk };
}

function findHttpError(error: unknown): HttpError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    if (current instanceof HttpError) {
      return current;
    }
    current = current.cause;
  }
  return undefined;
}

/** Spread only defined token counts — exactOptionalPropertyTypes forbids explicit undefined. */
function tokenFields(
  usage: Pick<UsageInput, "completionTokens" | "promptTokens" | "totalTokens"> | undefined
): Pick<CommentsRouteAttempt, "completionTokens" | "promptTokens" | "totalTokens"> {
  return {
    ...(usage?.promptTokens === undefined ? {} : { promptTokens: usage.promptTokens }),
    ...(usage?.completionTokens === undefined ? {} : { completionTokens: usage.completionTokens }),
    ...(usage?.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
  };
}

export function makeCommentsRouteHttp(): HttpClient {
  return new HttpClient(
    {
      retries: env.HTTP_RETRIES,
      baseBackoffMs: env.HTTP_BACKOFF_MS,
      timeoutMs: env.HTTP_TIMEOUT_MS,
      retryOnStatuses: [408, 425, 500, 502, 503, 504, 522],
    },
    { ua: "hn-distill-eval/1.0 (+https://hckr.top/)", headers: {} }
  );
}

/**
 * One generation, one physical call (transportRetries: 0, maxRetries: 1 → no burst).
 * Uses the Groq gateway with balanced-object JSON extraction, mirroring the production
 * Groq comments hop (Groq llama rejects json_schema, so no response_format).
 */
export async function runCommentsRoute(
  http: HttpClient,
  route: CommentsRoute,
  fixture: CommentsRouteFixture
): Promise<CommentsRouteResult> {
  const prepared = buildCommentsPromptV2({
    story: fixture.story,
    comments: fixture.comments,
    language: env.SUMMARY_LANG,
    maxChars: env.COMMENTS_PROMPT_MAX_CHARS,
  });
  const messages: ChatMessage[] = [
    { role: "system", content: buildCommentsSystemInstructionV2(env.SUMMARY_LANG, prepared.maxInsights) },
    { role: "user", content: prepared.prompt },
  ];

  let usageEvent: UsageInput | undefined;
  const client = new OpenRouter(http, env.GROQ_API_KEY ?? "", route.model, env.GROQ_BASE_URL, {
    gateway: route.gateway,
    onUsage: (event): void => {
      usageEvent = event;
    },
  });

  const base = {
    storyId: fixture.story.id,
    promptChars: prepared.prompt.length,
    includedComments: prepared.sampleIds.length,
  };
  const started = Date.now();
  try {
    const insights = await client.chatStructured(
      messages,
      {
        temperature: route.temperature,
        maxTokens: route.maxTokens,
        model: route.model,
        label: "comments",
        jsonExtraction: "balanced-object",
        transportRetries: 0,
        requestTimeoutMs: route.requestTimeoutMs,
      },
      CommentsInsightsSchema,
      1
    );
    const latencyMs = Date.now() - started;
    const outcome = validateCandidateInsights(insights, fixture.comments, prepared.sampleIds, prepared.maxInsights);
    const attempt: CommentsRouteAttempt = {
      requestedModel: route.model,
      resolvedModel: usageEvent?.modelUsed ?? route.model,
      status: "ok",
      latencyMs,
      ...tokenFields(usageEvent),
    };
    if (outcome.ok) {
      return {
        ...base,
        validationPassed: true,
        summary: outcome.summary,
        summaryChars: outcome.summary.length,
        insights: outcome.insights,
        quoteEmitted: outcome.quoteEmitted,
        quoteProvenanceOk: outcome.quoteProvenanceOk,
        attempt,
      };
    }
    return {
      ...base,
      validationPassed: false,
      rejectedReason: outcome.reason,
      summary: "",
      summaryChars: 0,
      quoteEmitted: outcome.quoteEmitted,
      quoteProvenanceOk: outcome.quoteProvenanceOk,
      attempt,
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const httpError = findHttpError(error);
    const attempt: CommentsRouteAttempt = {
      requestedModel: route.model,
      status: "error",
      latencyMs,
      error: error instanceof Error ? error.message : String(error),
      ...tokenFields(usageEvent),
    };
    // Assign optionals after construction — spreads widen to `T | undefined` under exactOptionalPropertyTypes.
    if (usageEvent?.modelUsed !== undefined) {
      attempt.resolvedModel = usageEvent.modelUsed;
    }
    if (httpError?.status !== undefined) {
      attempt.httpStatus = httpError.status;
    }
    return {
      ...base,
      validationPassed: false,
      rejectedReason: "transport",
      summary: "",
      summaryChars: 0,
      quoteEmitted: false,
      quoteProvenanceOk: true,
      attempt,
    };
  }
}

// Exported for unit testing the composed validator without a live call.
export const __testing = { validateCandidateInsights, findHttpError };
