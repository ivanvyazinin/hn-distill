import { log } from "@utils/log";

import { HttpError, type HttpClient } from "./http-client";

import type { UsageInput, UsageSink } from "./llm-usage";
import type { z } from "zod";

export type ChatMessage = {
  role: "assistant" | "system" | "user";
  content: string;
};

export type JsonSchema = {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
};

export type StructuredOutputOptions = {
  temperature?: number;
  maxTokens?: number;
  model?: string;
  /** Task attribution for usage accounting ("post" | "comments" | "tags" | "guard"). */
  label?: string;
  jsonExtraction?: "balanced-object" | "strict";
  transportRetries?: number;
  requestTimeoutMs?: number;
  signalUnsupportedResponseFormat?: boolean;
  responseFormat?: {
    type: "json_schema";
    json_schema: {
      name: string;
      strict: boolean;
      schema: JsonSchema;
    };
  };
};

export class UnsupportedResponseFormatError extends Error {
  readonly status: number;

  constructor(error: HttpError) {
    super(`OpenRouter response_format is unsupported: ${error.message}`, { cause: error });
    this.name = "UnsupportedResponseFormatError";
    this.status = error.status ?? 400;
  }
}

type StructuredRetryCount = number;

const DEFAULT_STRUCTURED_MAX_RETRIES: StructuredRetryCount = 3;

const DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function extractFirstBalancedJsonObject(content: string): string {
  for (let start = 0; start < content.length; start++) {
    if (content[start] !== "{") {
      continue;
    }

    let depth = 0;
    let escaped = false;
    let inString = false;

    for (let index = start; index < content.length; index++) {
      const character = content[index];
      if (character === undefined) {
        break;
      }

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      switch (character) {
        case '"':
          inString = true;
          break;
        case "{":
          depth++;
          break;
        case "}":
          depth--;
          if (depth === 0) {
            return content.slice(start, index + 1);
          }
          break;
      }
    }
  }

  throw new SyntaxError("No balanced JSON object found in structured response");
}

function parseStructuredContent(content: string, extraction: StructuredOutputOptions["jsonExtraction"]): unknown {
  const json = extraction === "balanced-object" ? extractFirstBalancedJsonObject(content) : content;
  return JSON.parse(json) as unknown;
}

function isUnsupportedResponseFormatError(error: unknown): error is HttpError {
  if (!(error instanceof HttpError)) {
    return false;
  }
  const { status } = error;
  if (status === undefined || status < 400 || status >= 500 || status === 408 || status === 425 || status === 429) {
    return false;
  }
  const message = error.message.toLowerCase();
  const mentionsFormat =
    message.includes("response_format") || message.includes("response format") || message.includes("json_schema");
  // Groq: "does not support response format `json_schema`". OpenAI-ish: "not supported" / "unsupported".
  const saysUnsupported =
    message.includes("unsupported") ||
    message.includes("not supported") ||
    message.includes("does not support") ||
    message.includes("unknown parameter");
  return mentionsFormat && saysUnsupported;
}

/** Shape of the `usage`/`model` fields the OpenAI-compatible response carries alongside `choices`. */
type UsageResponseFields = {
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
};

/** Fold response usage/model into the partial usage event (only defined fields). */
function usageFieldsFromResponse(
  response: UsageResponseFields
): Pick<UsageInput, "completionTokens" | "modelUsed" | "promptTokens" | "totalTokens"> {
  const { usage, model } = response;
  return {
    ...(model === undefined ? {} : { modelUsed: model }),
    ...(usage?.prompt_tokens === undefined ? {} : { promptTokens: usage.prompt_tokens }),
    ...(usage?.completion_tokens === undefined ? {} : { completionTokens: usage.completion_tokens }),
    ...(usage?.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
  };
}

export class OpenRouter {
  private readonly http: HttpClient;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly url: string;
  private readonly gateway: string;
  private readonly onUsage: UsageSink | undefined;

  constructor(
    http: HttpClient,
    apiKey: string,
    model: string,
    baseUrl?: string,
    options?: { gateway?: string; onUsage?: UsageSink }
  ) {
    this.http = http;
    this.apiKey = apiKey;
    this.model = model;
    this.url = baseUrl !== undefined && baseUrl.length > 0 ? baseUrl : DEFAULT_OPENROUTER_URL;
    // gateway is fixed at construction (the endpoint); the actually-served model is modelUsed.
    this.gateway = options?.gateway ?? "openrouter";
    this.onUsage = options?.onUsage;
  }

  /** Emit exactly one usage event per upstream attempt; no-op unless a sink is wired. */
  private recordUsage(event: Omit<UsageInput, "gateway">): void {
    if (this.onUsage === undefined) {
      return;
    }
    this.onUsage({ gateway: this.gateway, ...event });
  }

  async chat(
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number; model?: string; label?: string }
  ): Promise<string> {
    type ORResp = UsageResponseFields & {
      choices?: Array<{ message?: { role: string; content?: string } }>;
    };
    const modelRequested = options?.model ?? this.model;
    const label = options?.label ?? "unknown";
    log.debug("openrouter", "chat request", {
      model: modelRequested,
      messages: messages.length,
      hasKey: !!this.apiKey,
    });
    // One emit per call: success → ok; empty content → error with tokens (response was read);
    // any throw before the response is read → error without tokens.
    let usageFields: ReturnType<typeof usageFieldsFromResponse> = {};
    try {
      const json: ORResp = await this.http.json<ORResp>(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://hckr.top/",
          "X-Title": "hn-distill",
        },
        body: JSON.stringify({
          model: modelRequested,
          messages,
          ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options?.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
        }),
        retryOnStatuses: [429],
      });
      usageFields = usageFieldsFromResponse(json);
      const content = json.choices?.[0]?.message?.content ?? "";
      if (!content) {
        log.error("openrouter", "Empty content in response");
        throw new Error("OpenRouter: empty content");
      }
      const trimmed = content.trim();
      this.recordUsage({ label, modelRequested, ...usageFields, status: "ok" });
      log.debug("openrouter", "chat response", { contentChars: trimmed.length });
      return trimmed;
    } catch (error) {
      this.recordUsage({ label, modelRequested, ...usageFields, status: "error" });
      throw error;
    }
  }

  private buildStructuredRequestBody(messages: ChatMessage[], options: StructuredOutputOptions): string {
    return JSON.stringify({
      model: options.model ?? this.model,
      messages,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    });
  }

  private async makeStructuredRequest<T>(
    url: string,
    requestBody: string,
    zodSchema: z.ZodSchema<T>,
    attempt: number,
    options: StructuredOutputOptions
  ): Promise<T> {
    type ORResp = UsageResponseFields & {
      choices?: Array<{ message?: { role: string; content?: string } }>;
    };

    const modelRequested = options.model ?? this.model;
    const label = options.label ?? "unknown";
    // Exactly one emit per method call (= one upstream attempt): success → ok; any throw
    // (transport / HTTP / empty content / JSON.parse / Zod) → error, carrying tokens only
    // if the response was already read. The chatStructured retry loop never emits — this
    // is the single choke point, so N loop iterations produce exactly N events.
    let usageFields: ReturnType<typeof usageFieldsFromResponse> = {};
    try {
      const json: ORResp = await this.http.json<ORResp>(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://hckr.top/",
          "X-Title": "hn-distill",
        },
        body: requestBody,
        retryOnStatuses: [429],
        ...(options.transportRetries === undefined ? {} : { retries: options.transportRetries }),
        ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
      });
      usageFields = usageFieldsFromResponse(json);

      const content = json.choices?.[0]?.message?.content ?? "";
      if (!content) {
        throw new Error("Empty content in structured response");
      }

      const trimmed = content.trim();
      const parsed = parseStructuredContent(trimmed, options.jsonExtraction);
      const validated = zodSchema.parse(parsed);

      this.recordUsage({ label, modelRequested, attempt, ...usageFields, status: "ok" });
      log.debug("openrouter", "structured response parsed", {
        contentChars: trimmed.length,
        attempt,
      });
      return validated;
    } catch (error) {
      this.recordUsage({ label, modelRequested, attempt, ...usageFields, status: "error" });
      throw error;
    }
  }

  async chatStructured<T>(
    messages: ChatMessage[],
    options: StructuredOutputOptions,
    zodSchema: z.ZodSchema<T>,
    maxRetries: StructuredRetryCount = DEFAULT_STRUCTURED_MAX_RETRIES
  ): Promise<T> {
    const requestBody = this.buildStructuredRequestBody(messages, options);

    log.debug("openrouter", "structured chat request", {
      model: options.model ?? this.model,
      messages: messages.length,
      hasKey: !!this.apiKey,
      schema: options.responseFormat?.json_schema.name,
      maxRetries,
    });

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.makeStructuredRequest(this.url, requestBody, zodSchema, attempt, options);
      } catch (error: unknown) {
        if (options.signalUnsupportedResponseFormat === true && isUnsupportedResponseFormatError(error)) {
          throw new UnsupportedResponseFormatError(error);
        }

        const isLastAttempt = attempt === maxRetries;
        log.warn("openrouter", `Structured parsing failed (attempt ${attempt}/${maxRetries})`, {
          error: error instanceof Error ? error.message : String(error),
          isLastAttempt,
        });

        if (isLastAttempt) {
          log.error("openrouter", "All structured parsing attempts failed", { error });
          throw new Error(
            `OpenRouter structured output failed after ${maxRetries} attempts: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error }
          );
        }

        await new Promise<void>((resolve: (value: PromiseLike<void> | void) => void) =>
          setTimeout(resolve, 200 * attempt)
        );
      }
    }

    throw new Error("Unexpected end of retry loop");
  }
}
