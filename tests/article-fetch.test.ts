import { describe, expect, test } from "bun:test";

import {
  buildJinaReaderUrl,
  DEFAULT_ARTICLE_READER_BASE_URL,
  fetchViaJinaReader,
  isCloudflareChallengeError,
  looksLikeCloudflareChallenge,
  MIN_READER_MD_CHARS,
} from "../utils/article-fetch";
import { HttpError, type HttpClient, type SafeRequestInit } from "../utils/http-client";

const CF_BODY =
  '<!DOCTYPE html><html><title>Just a moment...</title><script src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/..."></script></html>';

describe("looksLikeCloudflareChallenge", () => {
  test("detects common challenge markers", () => {
    expect(looksLikeCloudflareChallenge(CF_BODY)).toBe(true);
    expect(looksLikeCloudflareChallenge("Enable JavaScript and cookies to continue")).toBe(true);
    expect(looksLikeCloudflareChallenge("Attention Required! | Cloudflare")).toBe(true);
    expect(looksLikeCloudflareChallenge("Checking your browser before accessing example.com")).toBe(true);
  });

  test("rejects normal article html/markdown", () => {
    expect(looksLikeCloudflareChallenge("# Hello\n\nWorld of Minecraft maps.")).toBe(false);
    expect(looksLikeCloudflareChallenge("<html><body><p>Article body</p></body></html>")).toBe(false);
    expect(looksLikeCloudflareChallenge("")).toBe(false);
    expect(looksLikeCloudflareChallenge()).toBe(false);
  });
});

describe("isCloudflareChallengeError", () => {
  test("403 always qualifies (with or without body markers)", () => {
    expect(isCloudflareChallengeError(new HttpError("https://x.test", 403, `HTTP 403 ${CF_BODY}`))).toBe(true);
    expect(isCloudflareChallengeError(new HttpError("https://x.test", 403, "HTTP 403 Forbidden"))).toBe(true);
  });

  test("503 only with challenge markers", () => {
    expect(isCloudflareChallengeError(new HttpError("https://x.test", 503, `HTTP 503 ${CF_BODY}`))).toBe(true);
    expect(isCloudflareChallengeError(new HttpError("https://x.test", 503, "HTTP 503 upstream"))).toBe(false);
  });

  test("non-challenge errors are rejected", () => {
    expect(isCloudflareChallengeError(new HttpError("https://x.test", 404, "HTTP 404 not found"))).toBe(false);
    expect(isCloudflareChallengeError(new HttpError("https://x.test", 500, "HTTP 500 boom"))).toBe(false);
    expect(isCloudflareChallengeError(new Error("network down"))).toBe(false);
    expect(isCloudflareChallengeError("string")).toBe(false);
  });

  test("status-less error with challenge body still qualifies", () => {
    expect(isCloudflareChallengeError(new HttpError("https://x.test", undefined, CF_BODY))).toBe(true);
  });
});

describe("buildJinaReaderUrl", () => {
  test("prefixes absolute URL once", () => {
    expect(buildJinaReaderUrl("https://2b2t.place/1million")).toBe(
      "https://r.jina.ai/https://2b2t.place/1million"
    );
  });

  test("does not double-prefix", () => {
    const once = "https://r.jina.ai/https://example.com/a";
    expect(buildJinaReaderUrl(once)).toBe(once);
  });

  test("respects custom base", () => {
    expect(buildJinaReaderUrl("https://example.com", "https://reader.test")).toBe(
      "https://reader.test/https://example.com"
    );
  });

  test("strips trailing slash on base", () => {
    expect(buildJinaReaderUrl("https://example.com", "https://r.jina.ai/")).toBe(
      "https://r.jina.ai/https://example.com"
    );
  });
});

describe("fetchViaJinaReader", () => {
  test("returns trimmed markdown and sends reader headers", async () => {
    type Call = { url: string; init?: SafeRequestInit | undefined };
    const calls: Call[] = [];
    const md = ["# Title", "", "Prose paragraph about the world."].join("\n");
    const http = {
      text: async (url: string, init?: SafeRequestInit) => {
        calls.push(init === undefined ? { url } : { url, init });
        return `  ${md}  `;
      },
    } as unknown as HttpClient;

    const out = await fetchViaJinaReader(http, "https://example.com/a", {
      apiKey: "jk_test",
      baseUrl: DEFAULT_ARTICLE_READER_BASE_URL,
    });
    expect(out).toBe(md);
    expect(out.startsWith("# Title")).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://r.jina.ai/https://example.com/a");
    expect(calls[0]?.init?.headers?.["x-respond-with"]).toBe("markdown");
    expect(calls[0]?.init?.headers?.["Authorization"]).toBe("Bearer jk_test");
    expect(calls[0]?.init?.headers?.["Accept"]).toBe("text/plain");
  });

  test("omits Authorization when no api key", async () => {
    type Call = { init?: SafeRequestInit | undefined };
    const calls: Call[] = [];
    const http = {
      text: async (_url: string, init?: SafeRequestInit) => {
        calls.push(init === undefined ? {} : { init });
        return `# Ok\n\n${"x".repeat(MIN_READER_MD_CHARS)}`;
      },
    } as unknown as HttpClient;
    await fetchViaJinaReader(http, "https://example.com");
    expect(calls[0]?.init?.headers?.["Authorization"]).toBeUndefined();
  });

  test("rejects empty / short body", async () => {
    const http = {
      text: async () => "short",
    } as unknown as HttpClient;
    await expect(fetchViaJinaReader(http, "https://example.com")).rejects.toThrow(/empty\/short/iu);
  });

  test("rejects challenge body from reader", async () => {
    const http = {
      text: async () => `${CF_BODY}${" ".repeat(MIN_READER_MD_CHARS)}`,
    } as unknown as HttpClient;
    await expect(fetchViaJinaReader(http, "https://example.com")).rejects.toThrow(/challenge/iu);
  });
});
