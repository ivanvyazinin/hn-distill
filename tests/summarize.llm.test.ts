import { describe, expect, test } from "bun:test";

import { env } from "../config/env.ts";
import type { Services } from "../scripts/summarize.mts";
import { RateLimitError, summarizeComments } from "../scripts/summarize.mts";
import { HttpError } from "../utils/http-client.ts";
import type { ChatMessage } from "../utils/openrouter";

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

  const orMock = {
    chat,
    chatStructured: async () => {
      throw new Error("not implemented");
    },
  } as unknown as Services["openrouter"];
  const services: Services = {
    http: {} as Services["http"],
    openrouter: orMock,
    guardTagsClient: orMock,
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
  return new HttpError("https://openrouter.ai/api/v1/chat/completions", 429, `HTTP 429 ${JSON.stringify(payload)}`);
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
    expect(calls.length).toBe(1);
    expect(calls[0]?.model).toBe(env.OPENROUTER_MODEL);
  });

  test("falls back to first fallback when primary throws non-rate-limited error", async () => {
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
    expect(calls.length).toBe(2);
    expect(calls[0]?.model).toBe(env.OPENROUTER_MODEL);
    expect(calls[1]?.model).toBe(env.OPENROUTER_FALLBACK_MODEL);
  });

  test("falls back to second fallback when primary and first fallback fail", async () => {
    const { services, calls } = makeServices([
      async () => {
        throw new Error("primary outage");
      },
      async () => {
        throw new Error("first fallback outage");
      },
      async ({ model }) => {
        expect(model).toBe(env.OPENROUTER_FALLBACK_MODEL_2);
        return "Second fallback content";
      },
    ]);

    const result = await summarizeComments(services, 128, PROMPT_TEXT, []);

    expect(result.summary).toBe("Second fallback content");
    expect(result.model).toBe(env.OPENROUTER_FALLBACK_MODEL_2);
    expect(calls.length).toBe(3);
    expect(calls[0]?.model).toBe(env.OPENROUTER_MODEL);
    expect(calls[1]?.model).toBe(env.OPENROUTER_FALLBACK_MODEL);
    expect(calls[2]?.model).toBe(env.OPENROUTER_FALLBACK_MODEL_2);
  });

  test("tries fallback models when primary model hits rate limit", async () => {
    const resetMs = Date.now() + 60_000;
    const { services, calls } = makeServices([
      async () => {
        throw makeRateLimit("free-models-per-day-high-balance", resetMs);
      },
      async () => "fallback success",
    ]);

    const result = await summarizeComments(services, 125, PROMPT_TEXT, []);

    expect(result.summary).toBe("fallback success");
    expect(result.model).toBe(env.OPENROUTER_FALLBACK_MODEL);
    expect(calls.length).toBe(2);
    expect(calls[0]?.model).toBe(env.OPENROUTER_MODEL);
    expect(calls[1]?.model).toBe(env.OPENROUTER_FALLBACK_MODEL);
  });

  test("tries second fallback when first fallback hits rate limit", async () => {
    const resetMs = Date.now() + 120_000;
    const { services, calls } = makeServices([
      async () => {
        throw new Error("primary failure");
      },
      async () => {
        throw makeRateLimit("free-models-per-min", resetMs);
      },
      async () => "second fallback success",
    ]);

    const result = await summarizeComments(services, 126, PROMPT_TEXT, []);

    expect(result.summary).toBe("second fallback success");
    expect(result.model).toBe(env.OPENROUTER_FALLBACK_MODEL_2);
    expect(calls.length).toBe(3);
    expect(calls[0]?.model).toBe(env.OPENROUTER_MODEL);
    expect(calls[1]?.model).toBe(env.OPENROUTER_FALLBACK_MODEL);
    expect(calls[2]?.model).toBe(env.OPENROUTER_FALLBACK_MODEL_2);
  });

  test("removes begin-of-sentence artifact from summaries", async () => {
    const { services } = makeServices([
      async () => `Summary text${"<｜begin▁of▁sentence｜>"}`,
    ]);

    const result = await summarizeComments(services, 130, PROMPT_TEXT, []);

    expect(result.summary).toBe("Summary text");
  });

  test("throws aggregate error when all three models fail", async () => {
    const ERROR_MSG = "failure";
    const { services, calls } = makeServices([
      async () => {
        throw new Error(`primary ${ERROR_MSG}`);
      },
      async () => {
        throw new Error(`first fallback ${ERROR_MSG}`);
      },
      async () => {
        throw new Error(`second fallback ${ERROR_MSG}`);
      },
    ]);

    const error = await summarizeComments(services, 127, PROMPT_TEXT, []).catch((err) => err);

    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect([...aggregate.errors].length).toBe(3);
    expect(calls.length).toBe(3);
  });

  test("surfaces rate limit from second fallback model", async () => {
    const ERROR_MSG = "failure";
    const resetMs = Date.now() + 180_000;
    const { services, calls } = makeServices([
      async () => {
        throw new Error(`primary ${ERROR_MSG}`);
      },
      async () => {
        throw new Error(`first fallback ${ERROR_MSG}`);
      },
      async () => {
        throw makeRateLimit("free-models-per-hour", resetMs);
      },
    ]);

    const error = await summarizeComments(services, 129, PROMPT_TEXT, []).catch((err) => err);

    expect(error).toBeInstanceOf(RateLimitError);
    const rateError = error as RateLimitError;
    expect(rateError.model).toBe(env.OPENROUTER_FALLBACK_MODEL_2);
    expect(rateError.limitScope).toBe("free-models-per-hour");
    expect(rateError.retryDate?.getTime()).toBe(Math.floor(resetMs));
    expect(calls.length).toBe(3);
    expect(calls[2]?.model).toBe(env.OPENROUTER_FALLBACK_MODEL_2);
  });
});
