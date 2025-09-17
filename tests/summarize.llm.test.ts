import { describe, expect, test } from "bun:test";

import { env } from "../config/env.ts";
import { RateLimitError, summarizeComments } from "../scripts/summarize.mts";
import type { Services } from "../scripts/summarize.mts";
import type { ChatMessage } from "../utils/openrouter";
import { HttpError } from "../utils/http-client.ts";

type Handler = (req: { model: string; messages: ChatMessage[] }) => Promise<string>;

type CallRecord = { model: string; messages: number };

const PROMPT_TEXT = "Prompt text";

function makeServices(handlers: Handler[]): { services: Services; calls: CallRecord[] } {
  let index = 0;
  const calls: CallRecord[] = [];

  const chat = async (messages: ChatMessage[], options?: { model?: string }): Promise<string> => {
    const handler = handlers[index++];
    if (!handler) {
      throw new Error(`Unexpected chat invocation #${index}`);
    }
    const model = options?.model ?? env.OPENROUTER_MODEL;
    calls.push({ model, messages: messages.length });
    return await handler({ model, messages });
  };

  const services: Services = {
    http: {} as Services["http"],
    openrouter: {
      chat,
      chatStructured: async () => {
        throw new Error("not implemented");
      },
    } as unknown as Services["openrouter"],
    fetchArticleMarkdown: async () => "",
  };

  return { services, calls };
}

function makeRateLimit(scope: string, resetMs: number): HttpError {
  const payload = {
    error: {
      message: `Rate limit exceeded: ${scope}. `,
      code: 429,
      metadata: {
        headers: {
          "X-RateLimit-Limit": "2000",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(resetMs),
        },
      },
    },
  };
  return new HttpError(
    "https://openrouter.ai/api/v1/chat/completions",
    429,
    `HTTP 429 ${JSON.stringify(payload)}`
  );
}

describe("summarizeComments LLM handling", () => {
  test("uses primary model when available", async () => {
    const { services, calls } = makeServices([
      async ({ model }) => {
        expect(model).toBe(env.OPENROUTER_MODEL);
        return "  Primary success  ";
      },
    ]);

    const result = await summarizeComments(services, 123, PROMPT_TEXT, []);

    expect(result.summary).toBe("Primary success");
    expect(result.model).toBe(env.OPENROUTER_MODEL);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(env.OPENROUTER_MODEL);
  });

  test("falls back when primary throws non-rate-limited error", async () => {
    const { services, calls } = makeServices([
      async () => {
        throw new Error("primary outage");
      },
      async ({ model }) => {
        expect(model).toBe(env.OPENROUTER_FALLBACK_MODEL);
        return "Fallback content";
      },
    ]);

    const result = await summarizeComments(services, 124, PROMPT_TEXT, []);

    expect(result.summary).toBe("Fallback content");
    expect(result.model).toBe(env.OPENROUTER_FALLBACK_MODEL);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.model).toBe(env.OPENROUTER_MODEL);
    expect(calls[1]?.model).toBe(env.OPENROUTER_FALLBACK_MODEL);
  });

  test("surfaces rate limit from primary model", async () => {
    const resetMs = Date.now() + 60_000;
    const { services, calls } = makeServices([
      async () => {
        throw makeRateLimit("free-models-per-day-high-balance", resetMs);
      },
    ]);

    const error = await summarizeComments(services, 125, PROMPT_TEXT, []).catch((err) => err);

    expect(error).toBeInstanceOf(RateLimitError);
    const rateError = error as RateLimitError;
    expect(rateError.model).toBe(env.OPENROUTER_MODEL);
    expect(rateError.limitScope).toBe("free-models-per-day-high-balance");
    expect(rateError.retryDate?.getTime()).toBe(Math.floor(resetMs));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(env.OPENROUTER_MODEL);
  });

  test("surfaces rate limit from fallback model", async () => {
    const resetMs = Date.now() + 120_000;
    const { services, calls } = makeServices([
      async () => {
        throw new Error("primary failure");
      },
      async () => {
        throw makeRateLimit("free-models-per-min", resetMs);
      },
    ]);

    const error = await summarizeComments(services, 126, PROMPT_TEXT, []).catch((err) => err);

    expect(error).toBeInstanceOf(RateLimitError);
    const rateError = error as RateLimitError;
    expect(rateError.model).toBe(env.OPENROUTER_FALLBACK_MODEL);
    expect(rateError.limitScope).toBe("free-models-per-min");
    expect(rateError.retryDate?.getTime()).toBe(Math.floor(resetMs));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.model).toBe(env.OPENROUTER_FALLBACK_MODEL);
  });

  test("throws aggregate error when both models fail", async () => {
    const { services, calls } = makeServices([
      async () => {
        throw new Error("primary failure");
      },
      async () => {
        throw new Error("fallback failure");
      },
    ]);

    const error = await summarizeComments(services, 127, PROMPT_TEXT, []).catch((err) => err);

    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect([...aggregate.errors]).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
});
