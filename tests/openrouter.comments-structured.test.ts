import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { HttpClient, HttpError, type SafeRequestInit } from "../utils/http-client.ts";
import { OpenRouter, UnsupportedResponseFormatError } from "../utils/openrouter.ts";

type OpenRouterResponse = {
  choices: Array<{ message: { role: "assistant"; content: string } }>;
};

const ValueSchema = z.object({ value: z.string() });

function response(content: string): OpenRouterResponse {
  return { choices: [{ message: { role: "assistant", content } }] };
}

function makeMockHttp(
  implementation: (init?: SafeRequestInit) => Promise<OpenRouterResponse>
): { http: HttpClient; getCalls: () => number } {
  let calls = 0;
  const http = {
    json: async <T>(_url: string, init?: SafeRequestInit): Promise<T> => {
      calls++;
      return (await implementation(init)) as T;
    },
  } as HttpClient;
  return { http, getCalls: () => calls };
}

function makeOpenRouter(http: HttpClient): OpenRouter {
  return new OpenRouter(http, "test-key", "test-model", "https://example.test/chat");
}

describe("OpenRouter comments structured output", () => {
  test("balanced-object extraction handles fences, nested braces, strings, and multiple objects deterministically", async () => {
    const contents = [
      "```json\n{\"value\":\"fenced\"}\n```",
      'prefix {"value":"brace } and escaped \\\"quote\\\""} suffix',
      '{"value":"first"}\n{"value":"second"}',
    ];
    const { http } = makeMockHttp(async () => response(contents.shift() ?? ""));
    const openrouter = makeOpenRouter(http);

    const values: string[] = [];
    for (let index = 0; index < 3; index++) {
      const result = await openrouter.chatStructured(
        [{ role: "user", content: "comments" }],
        { jsonExtraction: "balanced-object", transportRetries: 0 },
        ValueSchema,
        1
      );
      values.push(result.value);
    }

    expect(values).toEqual(["fenced", 'brace } and escaped "quote"', "first"]);
  });

  test("strict parsing remains the default and request payload remains compatible", async () => {
    let body: string | undefined;
    const { http } = makeMockHttp(async (init) => {
      body = typeof init?.body === "string" ? init.body : undefined;
      return response("```json\n{\"value\":\"fenced\"}\n```");
    });
    const openrouter = makeOpenRouter(http);
    const responseFormat = {
      type: "json_schema" as const,
      json_schema: {
        name: "guard_regression",
        strict: true,
        schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      },
    };

    await expect(
      openrouter.chatStructured(
        [{ role: "user", content: "guard" }],
        { responseFormat },
        ValueSchema,
        1
      )
    ).rejects.toThrow("structured output failed after 1 attempts");

    const parsedBody = JSON.parse(body ?? "{}") as Record<string, unknown>;
    expect(parsedBody["response_format"]).toEqual(responseFormat);
    expect(parsedBody["model"]).toBe("test-model");
  });

  test("transportRetries zero prevents nested transport retry multiplication", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      calls++;
      return new Response("temporary", { status: 503 });
    }) as typeof globalThis.fetch;

    try {
      const http = new HttpClient(
        { retries: 2, baseBackoffMs: 0, timeoutMs: 500, retryOnStatuses: [] },
        { headers: {} }
      );
      const openrouter = makeOpenRouter(http);
      try {
        await openrouter.chatStructured(
          [{ role: "user", content: "comments" }],
          { jsonExtraction: "balanced-object", transportRetries: 0 },
          ValueSchema,
          2
        );
        throw new Error("Expected structured transport failure");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("structured output failed after 2 attempts");
        expect((error as Error).cause).toBeInstanceOf(HttpError);
        expect(((error as Error).cause as HttpError).status).toBe(503);
      }
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("unsupported response_format is an opt-in typed signal and never triggers an automatic fallback", async () => {
    let requestBody: string | undefined;
    const unsupported = new HttpError(
      "https://example.test/chat",
      400,
      "HTTP 400 response_format json_schema is not supported by this model"
    );
    const { http, getCalls } = makeMockHttp(async (init) => {
      requestBody = typeof init?.body === "string" ? init.body : undefined;
      throw unsupported;
    });
    const openrouter = makeOpenRouter(http);

    try {
      await openrouter.chatStructured(
        [{ role: "user", content: "comments" }],
        {
          responseFormat: {
            type: "json_schema",
            json_schema: { name: "comments", strict: true, schema: { type: "object" } },
          },
          signalUnsupportedResponseFormat: true,
          transportRetries: 0,
        },
        ValueSchema,
        3
      );
      throw new Error("Expected unsupported response_format signal");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedResponseFormatError);
      expect((error as UnsupportedResponseFormatError).status).toBe(400);
      expect((error as UnsupportedResponseFormatError).cause).toBe(unsupported);
    }

    expect(getCalls()).toBe(1);
    const parsedBody = JSON.parse(requestBody ?? "{}") as Record<string, unknown>;
    expect(parsedBody["response_format"] === undefined).toBeFalse();
  });

  test("Groq 'does not support response format json_schema' is signaled as unsupported", async () => {
    const unsupported = new HttpError(
      "https://api.groq.com/openai/v1/chat/completions",
      400,
      'HTTP 400 {"error":{"message":"This model does not support response format `json_schema`. See supported models at https://console.groq.com/docs/structured-outputs#supported-models","type":"invalid_request_error","param":"response_format"}}'
    );
    const { http, getCalls } = makeMockHttp(async () => {
      throw unsupported;
    });
    const openrouter = makeOpenRouter(http);

    try {
      await openrouter.chatStructured(
        [{ role: "user", content: "comments" }],
        {
          responseFormat: {
            type: "json_schema",
            json_schema: { name: "comments", strict: true, schema: { type: "object" } },
          },
          signalUnsupportedResponseFormat: true,
          transportRetries: 0,
        },
        ValueSchema,
        1
      );
      throw new Error("Expected unsupported response_format signal");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedResponseFormatError);
      expect((error as UnsupportedResponseFormatError).status).toBe(400);
    }

    expect(getCalls()).toBe(1);
  });

  test("model_not_found does not retry the same model id", async () => {
    const missing = new HttpError(
      "https://api.groq.com/openai/v1/chat/completions",
      404,
      'HTTP 404 {"error":{"message":"The model `meta-llama/llama-4-scout-17b-16e-instruct` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}'
    );
    const { http, getCalls } = makeMockHttp(async () => {
      throw missing;
    });
    const openrouter = makeOpenRouter(http);

    await expect(
      openrouter.chatStructured(
        [{ role: "user", content: "tags" }],
        { model: "meta-llama/llama-4-scout-17b-16e-instruct", transportRetries: 0 },
        ValueSchema,
        3
      )
    ).rejects.toThrow(/structured output failed after 1 attempts/u);

    expect(getCalls()).toBe(1);
  });
});
