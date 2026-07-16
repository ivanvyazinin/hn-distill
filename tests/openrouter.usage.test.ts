import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { HttpError, type HttpClient, type SafeRequestInit } from "../utils/http-client.ts";
import { OpenRouter, UnsupportedResponseFormatError } from "../utils/openrouter.ts";

import type { UsageInput } from "../utils/llm-usage.ts";

const ValueSchema = z.object({ value: z.string() });

type ORResp = {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  choices: Array<{ message: { role: "assistant"; content: string } }>;
};

function reply(content: string, extra?: Pick<ORResp, "model" | "usage">): ORResp {
  return { ...extra, choices: [{ message: { role: "assistant", content } }] };
}

function makeMockHttp(implementation: (init?: SafeRequestInit) => Promise<unknown>): HttpClient {
  return {
    json: async <T>(_url: string, init?: SafeRequestInit): Promise<T> => (await implementation(init)) as T,
  } as HttpClient;
}

/** OpenRouter with a capturing usage sink and a fixed gateway. */
function makeWithSink(http: HttpClient, gateway = "groq"): { or: OpenRouter; events: UsageInput[] } {
  const events: UsageInput[] = [];
  const or = new OpenRouter(http, "test-key", "primary-model", "https://example.test/chat", {
    gateway,
    onUsage: (event) => events.push(event),
  });
  return { or, events };
}

describe("OpenRouter usage accounting", () => {
  test("chat success emits one ok event with tokens and response.model as modelUsed", async () => {
    const http = makeMockHttp(async () =>
      reply("hello", { model: "served-model", usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })
    );
    const { or, events } = makeWithSink(http);

    await or.chat([{ role: "user", content: "hi" }], { model: "requested-model", label: "post" });

    expect(events).toEqual([
      {
        label: "post",
        gateway: "groq",
        modelRequested: "requested-model",
        modelUsed: "served-model",
        promptTokens: 12,
        completionTokens: 8,
        totalTokens: 20,
        status: "ok",
      },
    ]);
  });

  test("chat empty content emits exactly one error event carrying the tokens that were read", async () => {
    const http = makeMockHttp(async () => reply("", { model: "served", usage: { prompt_tokens: 5, total_tokens: 5 } }));
    const { or, events } = makeWithSink(http);

    await expect(or.chat([{ role: "user", content: "hi" }], { label: "post" })).rejects.toThrow("empty content");
    expect(events).toEqual([
      {
        label: "post",
        gateway: "groq",
        modelRequested: "primary-model",
        modelUsed: "served",
        promptTokens: 5,
        totalTokens: 5,
        status: "error",
      },
    ]);
  });

  test("chat whitespace-only content is treated as empty → one error event, not ok", async () => {
    const http = makeMockHttp(async () => reply("   \n  ", { model: "served", usage: { total_tokens: 9 } }));
    const { or, events } = makeWithSink(http);

    await expect(or.chat([{ role: "user", content: "hi" }], { label: "post" })).rejects.toThrow("empty content");
    expect(events).toEqual([
      { label: "post", gateway: "groq", modelRequested: "primary-model", modelUsed: "served", totalTokens: 9, status: "error" },
    ]);
  });

  test("chat transport failure emits one error event without tokens", async () => {
    const http = makeMockHttp(async () => {
      throw new HttpError("https://example.test/chat", 503, "HTTP 503 upstream");
    });
    const { or, events } = makeWithSink(http);

    await expect(or.chat([{ role: "user", content: "hi" }], { label: "comments" })).rejects.toThrow();
    expect(events).toEqual([
      { label: "comments", gateway: "groq", modelRequested: "primary-model", status: "error" },
    ]);
  });

  test("structured: invalid-JSON attempt then valid attempt emit error(+tokens) then ok — two events", async () => {
    const bodies = [
      reply("not json at all", { model: "m", usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 } }),
      reply('{"value":"good"}', { model: "m", usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 } }),
    ];
    const http = makeMockHttp(async () => bodies.shift() ?? reply(""));
    const { or, events } = makeWithSink(http);

    const result = await or.chatStructured(
      [{ role: "user", content: "x" }],
      { jsonExtraction: "balanced-object", transportRetries: 0, label: "comments" },
      ValueSchema,
      2
    );

    expect(result.value).toBe("good");
    expect(events.map((e) => [e.status, e.attempt, e.totalTokens])).toEqual([
      ["error", 1, 100],
      ["ok", 2, 104],
    ]);
  });

  test("structured transport failure emits one error per attempt (N attempts → N events, no tokens)", async () => {
    const http = makeMockHttp(async () => {
      throw new HttpError("https://example.test/chat", 500, "HTTP 500 boom");
    });
    const { or, events } = makeWithSink(http);

    await expect(
      or.chatStructured(
        [{ role: "user", content: "x" }],
        { jsonExtraction: "balanced-object", transportRetries: 0, label: "tags" },
        ValueSchema,
        3
      )
    ).rejects.toThrow();

    expect(events.length).toBe(3);
    expect(events.every((e) => e.status === "error" && e.totalTokens === undefined)).toBeTrue();
    expect(events.map((e) => e.attempt)).toEqual([1, 2, 3]);
  });

  test("unsupported response_format emits exactly one error event (no double record)", async () => {
    const unsupported = new HttpError(
      "https://api.groq.com/openai/v1/chat/completions",
      400,
      'HTTP 400 This model does not support response format `json_schema`. param response_format'
    );
    const http = makeMockHttp(async () => {
      throw unsupported;
    });
    const { or, events } = makeWithSink(http);

    await expect(
      or.chatStructured(
        [{ role: "user", content: "x" }],
        {
          responseFormat: { type: "json_schema", json_schema: { name: "c", strict: true, schema: { type: "object" } } },
          signalUnsupportedResponseFormat: true,
          transportRetries: 0,
          label: "comments",
        },
        ValueSchema,
        3
      )
    ).rejects.toBeInstanceOf(UnsupportedResponseFormatError);

    expect(events).toEqual([
      { label: "comments", gateway: "groq", modelRequested: "primary-model", attempt: 1, status: "error" },
    ]);
  });

  test("no sink wired → prior behavior, no throw from accounting", async () => {
    const http = makeMockHttp(async () => reply("ok", { model: "m", usage: { total_tokens: 3 } }));
    const or = new OpenRouter(http, "test-key", "primary-model", "https://example.test/chat");
    expect(await or.chat([{ role: "user", content: "hi" }])).toBe("ok");
  });
});
