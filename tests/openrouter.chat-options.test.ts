import { describe, expect, test } from "bun:test";

import type { HttpClient, SafeRequestInit } from "../utils/http-client.ts";
import { OpenRouter } from "../utils/openrouter.ts";

describe("OpenRouter.chat option forwarding", () => {
  test("forwards requestTimeoutMs and transportRetries into http.json", async () => {
    let seen: SafeRequestInit | undefined;
    const http = {
      json: async <T>(_url: string, init?: SafeRequestInit): Promise<T> => {
        seen = init;
        return {
          choices: [{ message: { role: "assistant", content: "ok" } }],
        } as T;
      },
    } as HttpClient;

    const or = new OpenRouter(http, "key", "model", "https://example.test/chat");
    await or.chat([{ role: "user", content: "hi" }], {
      label: "comments-compress",
      requestTimeoutMs: 1234,
      transportRetries: 0,
    });

    expect(seen?.timeoutMs).toBe(1234);
    expect(seen?.retries).toBe(0);
  });
});
