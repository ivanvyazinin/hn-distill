import { env } from "@config/env";
import {
  CommentsInsightsSchema,
  type CommentsInsights,
  type NormalizedComment,
} from "@config/schemas";
import { buildCommentsSystemInstructionV2, commentsInsightsResponseFormat } from "@utils/comments-thread";
import { HttpError } from "@utils/http-client";
import { log } from "@utils/log";
import {
  UnsupportedResponseFormatError,
  isModelNotFoundError,
  structuredReasoningEffort,
  type ChatMessage,
  type JsonSchema,
  type OpenRouter,
} from "@utils/openrouter";

import type { z } from "zod";

/**
 * Single owner of LLM routing and resilience (Phase 3): model chains per task,
 * rate-limit classification, the TPD breaker, the strict/balanced-object JSON
 * ladder, and per-model provider quirks. Pipeline modules decide WHAT counts as
 * an acceptable answer; this module decides HOW a call is attempted and retried.
 */

const LOG_NAMESPACE_LLM = "summarize/llm";
const LOG_NAMESPACE_COMMENTS = "summarize/comments";
const LOG_NAMESPACE_TAGS = "tags-extract";

export type LlmLogContext = Record<string, unknown>;

/** Structural subset of pipeline Services the route needs. */
export type RouteServices = {
  openrouter: OpenRouter;
  guardTagsClient: OpenRouter;
  /**
   * Official MiniMax API client (MINIMAX_API_KEY). When present, the comments chain
   * prepends a free MiniMax-M3 hop before the Groq/paid ladder. Absent → no hop.
   */
  commentsMinimaxClient?: OpenRouter;
  /** Preferred TPD breaker. When absent, commentsTpdExhaustedModels is adapted. */
  tpdBreaker?: TpdBreaker;
  /**
   * Legacy freeze/compat carrier — same Set identity as tpdBreaker.asSet() when
   * makeServices builds both. Prefer tpdBreaker for new code.
   */
  commentsTpdExhaustedModels?: Set<string>;
};

function ensureError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string") {
    return new Error(error);
  }
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

function parseHttpErrorJson(error: HttpError): unknown {
  const { message } = error;
  const firstSpace = message.indexOf(" ");
  if (firstSpace === -1) {
    return undefined;
  }
  const secondSpace = message.indexOf(" ", firstSpace + 1);
  if (secondSpace === -1) {
    return undefined;
  }
  const jsonPart = message.slice(secondSpace + 1).trim();
  if (!jsonPart) {
    return undefined;
  }
  try {
    return JSON.parse(jsonPart);
  } catch {
    return undefined;
  }
}

function parseRateLimitScope(message?: string): string | undefined {
  if (message === undefined || message.length === 0) {
    return undefined;
  }
  const trimmed = message.trim();
  const prefix = "Rate limit exceeded:";
  if (!trimmed.startsWith(prefix)) {
    return undefined;
  }
  return (
    trimmed
      .slice(prefix.length)
      .replace(/\.\s*$/u, "")
      .trim() || undefined
  );
}

function parseNumberish(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseResetHeader(value: unknown): number | undefined {
  const parsed = parseNumberish(value);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed > 1_000_000_000_000) {
    return Math.floor(parsed);
  }
  if (parsed > 0) {
    return Math.floor(parsed * 1000);
  }
  return undefined;
}

type RateLimitDetails = {
  scope?: string | undefined;
  limit?: number | undefined;
  remaining?: number | undefined;
  resetEpochMs?: number | undefined;
};

function extractRateLimitDetails(error: HttpError): RateLimitDetails | undefined {
  const json = parseHttpErrorJson(error);
  if (json === null || typeof json !== "object") {
    return undefined;
  }
  const errorPayload = (json as { error?: unknown }).error;
  if (errorPayload === null || typeof errorPayload !== "object") {
    return undefined;
  }
  const errorObj = errorPayload as { message?: unknown; metadata?: unknown };
  const { message, metadata } = errorObj;
  const headers =
    metadata !== undefined && metadata !== null && typeof metadata === "object"
      ? (metadata as { headers?: unknown }).headers
      : undefined;

  const headerRecord =
    headers !== undefined && headers !== null && typeof headers === "object"
      ? (headers as Record<string, unknown>)
      : undefined;

  const limit = headerRecord ? parseNumberish(headerRecord["X-RateLimit-Limit"]) : undefined;
  const remaining = headerRecord ? parseNumberish(headerRecord["X-RateLimit-Remaining"]) : undefined;
  const resetEpochMs = headerRecord ? parseResetHeader(headerRecord["X-RateLimit-Reset"]) : undefined;

  const result: RateLimitDetails = {};
  if (typeof message === "string") {
    result.scope = parseRateLimitScope(message);
  }
  if (limit !== undefined) {
    result.limit = limit;
  }
  if (remaining !== undefined) {
    result.remaining = remaining;
  }
  if (resetEpochMs !== undefined) {
    result.resetEpochMs = resetEpochMs;
  }
  return result;
}

type RateLimitErrorInit = RateLimitDetails & {
  model: string;
};

export class RateLimitError extends Error {
  readonly model: string;
  readonly limitScope?: string | undefined;
  readonly limit?: number | undefined;
  readonly remaining?: number | undefined;
  readonly resetEpochMs?: number | undefined;

  constructor(init: RateLimitErrorInit, options?: { cause?: Error }) {
    const parts = ["OpenRouter rate limit hit"];
    if (init.model) {
      parts.push(`model ${init.model}`);
    }
    if (init.scope !== undefined && init.scope.length > 0) {
      parts.push(`(${init.scope})`);
    }
    super(parts.join(" "), options);
    this.name = "RateLimitError";
    this.model = init.model;
    this.limitScope = init.scope ?? undefined;
    this.limit = init.limit ?? undefined;
    this.remaining = init.remaining ?? undefined;
    this.resetEpochMs = init.resetEpochMs ?? undefined;
  }

  get retryDate(): Date | undefined {
    return typeof this.resetEpochMs === "number" ? new Date(this.resetEpochMs) : undefined;
  }

  toLogMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: this.model,
      limitScope: this.limitScope,
      limit: this.limit,
      remaining: this.remaining,
      retryISO: this.retryDate?.toISOString(),
      resetEpochMs: this.resetEpochMs,
      ...extra,
    };
  }
}

class LlmCallError extends Error {
  readonly attempt: "fallback" | "primary";
  readonly model: string;
  readonly context: LlmLogContext;

  constructor(attempt: "fallback" | "primary", model: string, context: LlmLogContext, options: { cause: Error }) {
    super(`OpenRouter ${attempt} call failed for model ${model}`, options);
    this.name = "LlmCallError";
    this.attempt = attempt;
    this.model = model;
    this.context = context;
  }

  describe(): string {
    const causeMessage = this.cause instanceof Error ? this.cause.message : undefined;
    return causeMessage === undefined ? this.message : `${this.message}: ${causeMessage}`;
  }

  toError(): Error {
    return this.cause instanceof Error ? this.cause : this;
  }

  toLogMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: this.model,
      attempt: this.attempt,
      ...this.context,
      error: this.cause instanceof Error ? this.cause.message : this.message,
      ...extra,
    };
  }
}

type LlmResult = { content: string; modelUsed: string };

function classifyOpenRouterError(
  error: unknown,
  attempt: "fallback" | "primary",
  model: string,
  context: LlmLogContext
): LlmCallError | RateLimitError {
  if (error instanceof RateLimitError) {
    return error;
  }

  const httpError = error instanceof HttpError ? error : undefined;
  if (httpError && httpError.status === 429) {
    const details = extractRateLimitDetails(httpError) ?? {};
    return new RateLimitError({ model, ...details }, { cause: ensureError(error) });
  }

  if (error instanceof Error && /HTTP\s+429/u.test(error.message)) {
    return new RateLimitError({ model }, { cause: ensureError(error) });
  }

  return new LlmCallError(attempt, model, context, { cause: ensureError(error) });
}

const LLM_ARTIFACT_BEGIN_OF_SENTENCE = "<｜begin▁of▁sentence｜>";

/**
 * Markdown hard-break hygiene on raw model output: CRLF → LF and >2 trailing
 * spaces trimmed to exactly 2 (outside code fences). Part of the frozen
 * sanitize contract since before Phase 3 — post summaries render through it.
 */
export function preserveMarkdownWhitespace(content: string): string {
  const normalized = content ? content.replaceAll(/\r\n?/gu, "\n") : "";
  const lines = normalized.split("\n");
  const outLines: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      outLines.push(line);
      continue;
    }

    if (inCodeBlock) {
      outLines.push(line);
    } else {
      const body = line.trimEnd();
      const trailing = line.slice(body.length);

      if (trailing.length > 2) {
        outLines.push(`${body}  `); // Trim to 2
      } else {
        outLines.push(line); // Keep as is if <= 2
      }
    }
  }
  return outLines.join("\n");
}

/** Preserve markdown hard breaks, strip the reasoning artifact token, trim. */
export function sanitizeLlmContent(content: string): string {
  const preserved = preserveMarkdownWhitespace(content);
  return preserved.replaceAll(LLM_ARTIFACT_BEGIN_OF_SENTENCE, "").trim();
}

async function callOpenRouterAttempt(
  services: RouteServices,
  messages: ChatMessage[],
  model: string,
  attempt: "fallback" | "primary",
  context: LlmLogContext,
  label: string
): Promise<LlmResult> {
  const logContext = { model, ...context };
  const logMessage = attempt === "primary" ? "Calling LLM" : "Calling fallback LLM";
  log.info(LOG_NAMESPACE_LLM, logMessage, logContext);
  try {
    const content = await services.openrouter.chat(messages, {
      temperature: 0.3,
      maxTokens: env.OPENROUTER_MAX_TOKENS,
      model,
      label,
      // The primary is a reasoning model and spends the entire max_tokens inside its
      // thinking trace unless told not to: 2903 completion / 32s with the flag off vs
      // 176 / 2.6s with it on, same prompt, same output quality. Sent for every model
      // in the chain -- the non-reasoning fallbacks accept and ignore it (probed
      // 2026-08-02), and the comments path already does the same for Groq Qwen.
      reasoningEffort: "none",
    });
    const cleaned = sanitizeLlmContent(content);
    if (attempt === "primary") {
      log.debug(LOG_NAMESPACE_LLM, "LLM response received", {
        summaryChars: cleaned.length,
        ...logContext,
      });
    } else {
      log.info(LOG_NAMESPACE_LLM, "Fallback LLM response received", {
        summaryChars: cleaned.length,
        ...logContext,
      });
    }
    return { content: cleaned, modelUsed: model };
  } catch (rawError) {
    throw classifyOpenRouterError(rawError, attempt, model, context);
  }
}

/** Default production chain: primary, then the two configured fallbacks. */
function defaultModelChain(): string[] {
  return [env.OPENROUTER_MODEL, env.OPENROUTER_FALLBACK_MODEL, env.OPENROUTER_FALLBACK_MODEL_2];
}

async function callOpenRouterWithRetry(
  services: RouteServices,
  messages: ChatMessage[],
  context: LlmLogContext,
  label: string,
  models?: string[]
): Promise<LlmResult> {
  const chain = models === undefined || models.length === 0 ? defaultModelChain() : models;
  const failures: Array<LlmCallError | RateLimitError> = [];

  for (const [index, model] of chain.entries()) {
    const attempt = index === 0 ? "primary" : "fallback";
    try {
      return await callOpenRouterAttempt(services, messages, model, attempt, context, label);
    } catch (error) {
      if (!(error instanceof RateLimitError) && !(error instanceof LlmCallError)) {
        throw error;
      }
      failures.push(error);
      const nextModel = chain[index + 1];
      if (nextModel !== undefined) {
        if (error instanceof RateLimitError) {
          log.warn(LOG_NAMESPACE_LLM, "Rate limit on model; trying next in chain", {
            model,
            next: nextModel,
            chain,
            ...error.toLogMeta(context),
          });
        } else {
          log.warn(LOG_NAMESPACE_LLM, "Model failed; trying next in chain", {
            model,
            next: nextModel,
            chain,
            ...context,
            error: error.cause instanceof Error ? error.cause.message : error.message,
          });
        }
        continue;
      }

      if (error instanceof RateLimitError) {
        log.error(LOG_NAMESPACE_LLM, "Rate limit on all models", {
          chain,
          ...error.toLogMeta(context),
        });
        throw error;
      }
      log.error(LOG_NAMESPACE_LLM, "All models failed", {
        chain,
        ...context,
        errors: failures.map((failure) =>
          failure instanceof LlmCallError ? failure.describe() : failure.message
        ),
      });
      throw new AggregateError(
        failures.map((failure) => (failure instanceof LlmCallError ? failure.toError() : failure)),
        `LLM call failed for models: ${chain.join(", ")}`
      );
    }
  }

  throw new Error("Model chain is empty");
}

/**
 * Text completion over the default/configured model chain. Semantics are pinned
 * by tests/summarize.llm.test.ts (fallback order, AggregateError on total
 * failure, RateLimitError abort).
 */
export async function callLLMWithMessages(
  services: RouteServices,
  messages: ChatMessage[],
  context: LlmLogContext = {},
  label: string,
  models?: string[]
): Promise<LlmResult> {
  const ctx: LlmLogContext = { messages: messages.length, ...context };
  return await callOpenRouterWithRetry(services, messages, ctx, label, models);
}

/**
 * Explicit TPD breaker state. Worker injects ONE instance across an inline cron
 * pass or queue batch; scripts get a fresh one per run.
 * Wraps a Set so freeze tests that inspect services.commentsTpdExhaustedModels
 * keep working on the same identity.
 */
export class TpdBreaker {
  private readonly exhausted: Set<string>;

  constructor(seed?: Set<string>) {
    this.exhausted = seed ?? new Set<string>();
  }

  static fromSet(set: Set<string>): TpdBreaker {
    return new TpdBreaker(set);
  }

  static key(gateway: "groq" | "openrouter", model: string): string {
    return `${gateway}::${model.trim()}`;
  }

  /** Same Set reference used by legacy Services.commentsTpdExhaustedModels. */
  asSet(): Set<string> {
    return this.exhausted;
  }

  isExhausted(gateway: "groq" | "openrouter", model: string): boolean {
    return this.exhausted.has(TpdBreaker.key(gateway, model));
  }

  markExhausted(gateway: "groq" | "openrouter", model: string): void {
    this.exhausted.add(TpdBreaker.key(gateway, model));
  }

  hasKey(key: string): boolean {
    return this.exhausted.has(key);
  }

  addKey(key: string): void {
    this.exhausted.add(key);
  }
}

/** Prefer tpdBreaker; fall back to legacy Set without back-assignment. */
function breakerView(services: RouteServices): TpdBreaker {
  if (services.tpdBreaker !== undefined) {
    return services.tpdBreaker;
  }
  return TpdBreaker.fromSet(services.commentsTpdExhaustedModels ?? new Set<string>());
}

/** Deduped non-empty post-guard model chain from env (or explicit pair). */
export function buildPostGuardModelChain(
  primary: string = env.POST_GUARD_MODEL,
  fallback: string = env.POST_GUARD_FALLBACK_MODEL
): string[] {
  return [primary, fallback]
    .map((model) => model.trim())
    .filter((model, idx, arr) => model.length > 0 && arr.indexOf(model) === idx);
}

/**
 * Run attempt(model) across a chain; first success wins. Transport/domain errors
 * on one model advance to the next (guard freeze: primary fail → fallback).
 */
export async function callAcrossModelChain<T>(
  models: readonly string[],
  attempt: (model: string) => Promise<T>,
  onError?: (model: string, error: unknown) => void
): Promise<{ model: string; value: T } | undefined> {
  for (const model of models) {
    try {
      const value = await attempt(model);
      return { model, value };
    } catch (error) {
      onError?.(model, error);
    }
  }
  return undefined;
}

/** Single labeled chat (compress and other one-shot hops). */
export async function callLabeledChat(
  client: OpenRouter,
  messages: ChatMessage[],
  options: {
    label: string;
    maxTokens: number;
    model: string;
    temperature: number;
    requestTimeoutMs?: number;
    transportRetries?: number;
    reasoningEffort?: "high" | "low" | "medium" | "none";
  }
): Promise<string> {
  const raw = await client.chat(messages, {
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    model: options.model,
    label: options.label,
    ...(options.transportRetries === undefined ? {} : { transportRetries: options.transportRetries }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
  });
  return sanitizeLlmContent(raw);
}

/**
 * Tags/guard-style ladder: strict json_schema structured call, then same-model
 * plain JSON chat on non-model_not_found failures. Domain parse stays in caller
 * via parsePlain.
 */
export async function callStructuredThenPlainJsonFallback<T>(
  client: OpenRouter,
  input: {
    label: string;
    maxTokens: number;
    messagesPlain: ChatMessage[];
    messagesStructured: ChatMessage[];
    model: string;
    parsePlain: (raw: string) => T;
    schemaName: string;
    temperature: number;
    jsonSchema: JsonSchema;
    zodSchema: z.ZodType<T>;
    structuredAttempts?: number;
  }
): Promise<T> {
  const reasoningEffort = structuredReasoningEffort(input.model);
  try {
    return await client.chatStructured<T>(
      input.messagesStructured,
      {
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        model: input.model,
        label: input.label,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: input.schemaName,
            strict: true,
            schema: input.jsonSchema,
          },
        },
      },
      input.zodSchema,
      input.structuredAttempts ?? 2
    );
  } catch (error) {
    // Same model id will keep 404'ing — surface instead of burning a plain-JSON retry.
    if (isModelNotFoundError(error)) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    log.warn(LOG_NAMESPACE_TAGS, "structured outputs failed, falling back to regular JSON", {
      model: input.model,
      label: input.label,
      error: error instanceof Error ? error.message : String(error),
    });

    const jsonResponse = await client.chat(input.messagesPlain, {
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      model: input.model,
      label: input.label,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    });

    try {
      return input.parsePlain(jsonResponse);
    } catch (jsonError) {
      log.error(LOG_NAMESPACE_TAGS, "fallback JSON parsing failed", {
        model: input.model,
        label: input.label,
        error: jsonError instanceof Error ? jsonError.message : String(jsonError),
        response: jsonResponse.slice(0, 200),
      });
      throw new Error(`Failed to parse fallback JSON from LLM: ${String(jsonError)}`);
    }
  }
}

/** Re-export provider quirk helper so task modules can avoid importing openrouter for routing. */
export { structuredReasoningEffort } from "@utils/openrouter";

function hasHttpErrorCause(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    if (current instanceof HttpError) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function findHttpErrorCause(error: unknown): HttpError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    if (current instanceof HttpError) {
      return current;
    }
    current = current.cause;
  }
  return undefined;
}

/** Gateway-prefixed TPD breaker key so Groq exhaustion cannot shadow OpenRouter ids. */
export function commentsTpdExhaustionKey(gateway: "groq" | "openrouter", model: string): string {
  return TpdBreaker.key(gateway, model);
}

function commentsV2Messages(prompt: string, strict: boolean, maxInsights: number): ChatMessage[] {
  const strictInstruction =
    env.SUMMARY_LANG === "ru"
      ? "Строго соблюдай JSON-схему, не отказывайся от анализа и не добавляй вымышленных фактов."
      : "Follow the JSON schema exactly, do not refuse the analysis, and do not invent facts.";
  const system = [
    buildCommentsSystemInstructionV2(env.SUMMARY_LANG, maxInsights),
    ...(strict ? [strictInstruction] : []),
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];
}


/**
 * True only for a proven Groq tokens-per-day exhaustion signal.
 * TPM 429 / bare 429 / timeout / transport must NOT match — those stay retryable.
 */
export function isGroqTpdExhaustionError(error: unknown): boolean {
  const httpError = findHttpErrorCause(error);
  if (httpError?.status !== 429) {
    return false;
  }
  const parts = [httpError.message, error instanceof Error ? error.message : String(error)];
  const blob = parts.join(" ").toLowerCase();
  return blob.includes("tokens per day") || blob.includes("(tpd)") || /\btpd\b/u.test(blob);
}


type CommentsChainStep = {
  gateway: "groq" | "minimax" | "openrouter";
  client: OpenRouter;
  model: string;
  prefersResponseFormat: boolean;
  /** Groq Qwen3.6 / MiniMax-M3 need reasoning_effort=none or the budget burns inside <think>. */
  reasoningEffort?: "high" | "low" | "medium" | "none";
  /** Match smoke / reduce quote-rewrite variance on the candidate hop. */
  temperature: number;
  /** When true, a proven TPD 429 on this Groq step is recorded under gateway-prefixed key. */
  trackTpdExhaustion: boolean;
  /**
   * Per-step base timeout override. The shared budget is tuned for fast Groq hops
   * (7 s); the slow MiniMax-M3 reasoning model needs its own ceiling and still gets
   * capped by the budget's maxCalls/worker-deadline claims at call time.
   */
  requestTimeoutMs?: number;
};

export function buildCommentsModelChain(services: RouteServices): CommentsChainStep[] {
  // Route comments through the Groq client when one exists: it returns reliable
  // non-reasoning JSON, unlike the OpenRouter reasoning models that share the post
  // chain and emit prose instead of JSON. makeServices only builds a distinct
  // guardTagsClient when GROQ_API_KEY is set; otherwise it is the OpenRouter client
  // and we keep the legacy chain, so local/dev and no-Groq deployments still work.
  // Deriving this from the injected client (not ambient env) keeps callers testable.
  const groqEnabled = services.guardTagsClient !== services.openrouter;
  const groqBaseUrl = env.GROQ_BASE_URL;
  const openRouterBaseUrl = env.OPENROUTER_BASE_URL ?? "";
  const breaker = breakerView(services);

  const steps: CommentsChainStep[] = [];
  const seenSteps = new Set<string>();
  const pushStep = (
    stepClient: OpenRouter,
    model: string,
    stepBaseUrl: string,
    gateway: "groq" | "minimax" | "openrouter",
    prefersResponseFormat: boolean,
    options?: {
      reasoningEffort?: CommentsChainStep["reasoningEffort"];
      temperature?: number;
      trackTpdExhaustion?: boolean;
      requestTimeoutMs?: number;
    }
  ): void => {
    const trimmed = model.trim();
    if (trimmed.length === 0) {
      return;
    }
    // Only Groq steps participate in the TPD breaker. OpenRouter paid hop is never keyed
    // under groq::, so a matching model id on paid cannot be disabled by Groq TPD.
    if (gateway === "groq") {
      const exhaustionKey = commentsTpdExhaustionKey("groq", trimmed);
      if (breaker.hasKey(exhaustionKey)) {
        log.info(LOG_NAMESPACE_COMMENTS, "Comments-v2 skipping TPD-exhausted model", {
          gateway,
          model: trimmed,
          exhaustionKey,
        });
        return;
      }
    }
    const key = `${gateway}::${stepBaseUrl}::${trimmed}`;
    if (seenSteps.has(key)) {
      return;
    }
    seenSteps.add(key);
    steps.push({
      client: stepClient,
      gateway,
      model: trimmed,
      prefersResponseFormat,
      temperature: options?.temperature ?? 0.2,
      trackTpdExhaustion: gateway === "groq" && options?.trackTpdExhaustion === true,
      ...(options?.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options?.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
    });
  };

  if (groqEnabled) {
    // Free-first comments primary (2026-08-25): official MiniMax API hop prepended
    // before the paid ladder. reasoning_effort=none (MiniMax-M3 inlines thinking
    // otherwise); temperature keeps the chain default 0.2. MiniMax accepts
    // response_format json_schema but does NOT enforce the schema (returns its own
    // shape), so this hop extracts a balanced object exactly like the Groq hops.
    // The shared 7 s budget is Groq-tuned and M3 answers in ~14 s avg on stage-1 —
    // with it, prod timed out 27/27 (2026-08-25..26); hence the per-hop ceiling.
    // The hop never joins the Groq TPD breaker and is skipped without a client.
    const minimaxModel = env.COMMENTS_MINIMAX_MODEL.trim();
    if (minimaxModel.length > 0 && services.commentsMinimaxClient !== undefined) {
      pushStep(services.commentsMinimaxClient, minimaxModel, env.MINIMAX_BASE_URL, "minimax", false, {
        reasoningEffort: "none",
        requestTimeoutMs: env.COMMENTS_MINIMAX_REQUEST_TIMEOUT_MS,
      });
    } else if (minimaxModel.length > 0) {
      log.warn(LOG_NAMESPACE_COMMENTS, "Comments-v2 COMMENTS_MINIMAX_MODEL set without MINIMAX_API_KEY; starting at the paid ladder", {
        commentsMinimaxModel: minimaxModel,
      });
    }

    // Primary Groq hop.
    pushStep(services.guardTagsClient, env.COMMENTS_MODEL, groqBaseUrl, "groq", false, {
      trackTpdExhaustion: true,
    });

    // Historical ordered fallback list (fallback + optional fallback_2).
    for (const model of [env.COMMENTS_FALLBACK_MODEL, env.COMMENTS_FALLBACK_MODEL_2]) {
      pushStep(services.guardTagsClient, model, groqBaseUrl, "groq", false, { trackTpdExhaustion: true });
    }


    // Paid OpenRouter last resort — timing/SLA intentionally unchanged in this scaffold.
    // gateway "openrouter" → never written/read against the Groq TPD breaker set.
    pushStep(services.openrouter, env.COMMENTS_OPENROUTER_FALLBACK_MODEL, openRouterBaseUrl, "openrouter", true);
  } else {
    for (const model of [env.OPENROUTER_MODEL, env.OPENROUTER_FALLBACK_MODEL, env.OPENROUTER_FALLBACK_MODEL_2]) {
      pushStep(services.openrouter, model, openRouterBaseUrl, "openrouter", true);
    }
  }

  return steps;
}

/** Domain acceptance check, injected so routing stays content-agnostic. */
export type InsightsValidator = (
  insights: CommentsInsights,
  comments: NormalizedComment[],
  sampleIds: number[],
  maxInsights: number
) => { insights: CommentsInsights; summary: string } | undefined;

export type ChainBudget = {
  callsUsed: number;
  maxCalls: number;
  claimRequestTimeoutMs: (preferredMs?: number) => number | undefined;
};

const insightsSchema = CommentsInsightsSchema as unknown as z.ZodSchema<CommentsInsights>;

export async function callStructuredWithModelChain(
  services: RouteServices,
  input: {
    budget: ChainBudget;
    comments: NormalizedComment[];
    maxInsights: number;
    prompt: string;
    sampleIds: number[];
    validate: InsightsValidator;
  }
): Promise<{ insights: CommentsInsights; modelUsed: string; summary: string } | undefined> {
  const steps = buildCommentsModelChain(services);
  // Old contract: a TPD trip must stay visible to later stories even on a
  // hand-built Services that carries neither field — seed-and-assign, like the
  // pre-Phase-3 code did. Production paths always inject tpdBreaker.
  const breaker =
    services.tpdBreaker ??
    TpdBreaker.fromSet((services.commentsTpdExhaustedModels ??= new Set<string>()));

  let stepIndex = 0;
  let strict = false;
  // Provider-derived per step: Groq llama rejects json_schema (400) and a same-model
  // no-format retry would burn a second physical call against COMMENTS_MAX_LLM_CALLS.
  // Start Groq on balanced-object; OpenRouter (Qwen) keeps strict json_schema.
  // UnsupportedResponseFormat may still flip the flag off for a same-model retry on
  // non-Groq providers that advertise schema support incorrectly.
  let useResponseFormat = steps[0]?.prefersResponseFormat ?? false;

  const moveToFallback = (): boolean => {
    stepIndex += 1;
    strict = true;
    const next = steps[stepIndex];
    useResponseFormat = next?.prefersResponseFormat ?? false;
    return next !== undefined;
  };

  while (stepIndex < steps.length) {
    const step = steps[stepIndex];
    if (step === undefined) {
      return undefined;
    }
    const { client, gateway, model, reasoningEffort, temperature, trackTpdExhaustion } = step;

    const requestTimeoutMs = input.budget.claimRequestTimeoutMs(step.requestTimeoutMs);
    if (requestTimeoutMs === undefined) {
      log.warn(LOG_NAMESPACE_COMMENTS, "Comments-v2 request budget or deadline exhausted", {
        callsUsed: input.budget.callsUsed,
        maxCalls: input.budget.maxCalls,
      });
      return undefined;
    }

    try {
      const insights = await client.chatStructured(
        commentsV2Messages(input.prompt, strict, input.maxInsights),
        {
          temperature,
          maxTokens: env.COMMENTS_SUMMARY_MAX_TOKENS,
          model,
          label: "comments",
          jsonExtraction: useResponseFormat ? "strict" : "balanced-object",
          transportRetries: 0,
          requestTimeoutMs,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(useResponseFormat
            ? {
                signalUnsupportedResponseFormat: true,
                responseFormat: {
                  type: "json_schema" as const,
                  json_schema: commentsInsightsResponseFormat(),
                },
              }
            : {}),
        },
        insightsSchema,
        1
      );
      const validated = input.validate(insights, input.comments, input.sampleIds, input.maxInsights);
      if (validated !== undefined) {
        return { insights: validated.insights, modelUsed: model, summary: validated.summary };
      }
      if (!strict) {
        strict = true;
      } else if (!moveToFallback()) {
        return undefined;
      }
    } catch (error) {
      if (useResponseFormat && error instanceof UnsupportedResponseFormatError) {
        useResponseFormat = false;
        strict = true;
        log.warn(LOG_NAMESPACE_COMMENTS, "Comments-v2 response_format unsupported; retrying without it", {
          model,
        });
        continue;
      }
      if (trackTpdExhaustion && gateway === "groq" && isGroqTpdExhaustionError(error)) {
        breaker.addKey(commentsTpdExhaustionKey("groq", model));
        log.warn(LOG_NAMESPACE_COMMENTS, "Comments-v2 marking model TPD-exhausted for this run", {
          gateway,
          model,
          exhaustionKey: commentsTpdExhaustionKey("groq", model),
        });
      }
      log.warn(LOG_NAMESPACE_COMMENTS, "Comments-v2 structured attempt failed", {
        model,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!useResponseFormat || hasHttpErrorCause(error) || strict) {
        if (!moveToFallback()) {
          return undefined;
        }
      } else {
        strict = true;
      }
    }
  }

  return undefined;
}
