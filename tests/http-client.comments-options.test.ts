import { afterEach, describe, expect, test } from "bun:test";

import { HttpClient, HttpError } from "../utils/http-client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeClient(overrides: Partial<{ retries: number; timeoutMs: number }> = {}): HttpClient {
  return new HttpClient(
    {
      retries: overrides.retries ?? 1,
      baseBackoffMs: 0,
      timeoutMs: overrides.timeoutMs ?? 500,
      retryOnStatuses: [],
    },
    { headers: {} }
  );
}

describe("HttpClient comments request options", () => {
  test("keeps default retries but allows an opt-in per-request override", async () => {
    let calls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      calls++;
      return calls === 1
        ? new Response("temporary", { status: 503 })
        : Response.json({ ok: true });
    }) as typeof globalThis.fetch;

    const client = makeClient();
    await expect(client.json<{ ok: boolean }>("https://example.test/default")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);

    calls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      calls++;
      return new Response("temporary", { status: 503 });
    }) as typeof globalThis.fetch;

    try {
      await client.json("https://example.test/no-retry", { retries: 0 });
      throw new Error("Expected final 503 response");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(503);
    }
    expect(calls).toBe(1);
  });

  test("per-request timeout aborts the underlying fetch and preserves the cause", async () => {
    let fetchSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener(
          "abort",
          () => {
            reject(fetchSignal?.reason ?? new DOMException("Aborted", "AbortError"));
          },
          { once: true }
        );
      });
    }) as typeof globalThis.fetch;

    const client = makeClient({ retries: 0, timeoutMs: 5000 });
    try {
      await client.json("https://example.test/abort", { timeoutMs: 5 });
      throw new Error("Expected request to time out");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).cause).toBeInstanceOf(DOMException);
      expect(((error as HttpError).cause as DOMException).name).toBe("TimeoutError");
    }
    expect(fetchSignal?.aborted).toBeTrue();
  });

  test("network cause and HTTP status remain distinguishable", async () => {
    const networkCause = new TypeError("socket closed");
    globalThis.fetch = (async (): Promise<Response> => {
      throw networkCause;
    }) as typeof globalThis.fetch;

    const client = makeClient({ retries: 0 });
    try {
      await client.text("https://example.test/network");
      throw new Error("Expected network error");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBeUndefined();
      expect((error as HttpError).cause).toBe(networkCause);
    }

    globalThis.fetch = (async (): Promise<Response> => new Response("bad request", { status: 400 })) as typeof globalThis.fetch;
    try {
      await client.text("https://example.test/status");
      throw new Error("Expected HTTP status error");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
    }
  });
});
