import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";

import { env } from "../config/env";
import type { ArticleExtractRow, MetaStore } from "../utils/meta-store";
import { HttpError, type BytesResponse, type HttpClient, type SafeRequestInit } from "../utils/http-client";
import { mockPaths, story as makeStory, withEnvPatch, withTempDir } from "./helpers";

const CF_BODY =
  '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>challenges.cloudflare.com</body></html>';

const READER_MD = `# The largest available Minecraft world

${"The 2b2t place project hosts a multi-terabyte world archive with public browse tools. ".repeat(6)}`;

type HttpCall = { method: "bytes" | "text"; url: string; init?: SafeRequestInit | undefined };

function makeHttpStub(opts: {
  origin?: { error?: HttpError; bytes?: BytesResponse };
  readerText?: string | (() => string);
  readerError?: Error;
}): { http: HttpClient; calls: HttpCall[] } {
  const calls: HttpCall[] = [];
  const http = {
    bytes: async (url: string, init?: SafeRequestInit): Promise<BytesResponse> => {
      calls.push(init === undefined ? { method: "bytes", url } : { method: "bytes", url, init });
      if (opts.origin?.error) {
        throw opts.origin.error;
      }
      if (opts.origin?.bytes) {
        return opts.origin.bytes;
      }
      throw new HttpError(url, 500, "HTTP 500 unexpected origin");
    },
    text: async (url: string, init?: SafeRequestInit): Promise<string> => {
      calls.push(init === undefined ? { method: "text", url } : { method: "text", url, init });
      if (opts.readerError) {
        throw opts.readerError;
      }
      if (typeof opts.readerText === "function") {
        return opts.readerText();
      }
      if (opts.readerText !== undefined) {
        return opts.readerText;
      }
      throw new HttpError(url, 500, "HTTP 500 unexpected reader");
    },
  } as unknown as HttpClient;
  return { http, calls };
}

describe("makeServices reader fallback", () => {
  test("falls back to Jina reader on origin 403 challenge", async () => {
    await withEnvPatch(
      {
        ARTICLE_FETCH_READER_FALLBACK: true,
        JINA_API_KEY: "jk_test_key",
        ARTICLE_READER_BASE_URL: "https://r.jina.ai",
      },
      async () => {
        const { makeServices } = await import("../pipeline/summarize");
        const { http, calls } = makeHttpStub({
          origin: {
            error: new HttpError("https://2b2t.place/1million", 403, `HTTP 403 ${CF_BODY}`),
          },
          readerText: READER_MD,
        });
        const services = makeServices(env, { http });
        const result = await services.fetchArticleMarkdown("https://2b2t.place/1million");
        expect(result.sourceKind).toBe("reader");
        expect(result.md).toContain("Minecraft");
        expect(calls.some((c) => c.method === "bytes")).toBe(true);
        const readerCall = calls.find((c) => c.method === "text");
        expect(readerCall?.url).toBe("https://r.jina.ai/https://2b2t.place/1million");
        expect(readerCall?.init?.headers?.["Authorization"]).toBe("Bearer jk_test_key");
        expect(readerCall?.init?.headers?.["x-respond-with"]).toBe("markdown");
      }
    );
  });

  test("does not call reader when fallback disabled", async () => {
    await withEnvPatch({ ARTICLE_FETCH_READER_FALLBACK: false }, async () => {
      const { makeServices } = await import("../pipeline/summarize");
      const { http, calls } = makeHttpStub({
        origin: {
          error: new HttpError("https://2b2t.place/1million", 403, `HTTP 403 ${CF_BODY}`),
        },
        readerText: READER_MD,
      });
      const services = makeServices(env, { http });
      await expect(services.fetchArticleMarkdown("https://2b2t.place/1million")).rejects.toBeInstanceOf(HttpError);
      expect(calls.filter((c) => c.method === "text").length).toBe(0);
    });
  });

  test("does not call reader on non-challenge 404", async () => {
    await withEnvPatch({ ARTICLE_FETCH_READER_FALLBACK: true }, async () => {
      const { makeServices } = await import("../pipeline/summarize");
      const { http, calls } = makeHttpStub({
        origin: {
          error: new HttpError("https://example.com/missing", 404, "HTTP 404 not found"),
        },
        readerText: READER_MD,
      });
      const services = makeServices(env, { http });
      let thrown: unknown;
      try {
        await services.fetchArticleMarkdown("https://example.com/missing");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).status).toBe(404);
      expect(calls.filter((c) => c.method === "text").length).toBe(0);
    });
  });

  test("rethrows origin error when reader returns empty", async () => {
    await withEnvPatch({ ARTICLE_FETCH_READER_FALLBACK: true }, async () => {
      const { makeServices } = await import("../pipeline/summarize");
      const originErr = new HttpError("https://blocked.example", 403, `HTTP 403 ${CF_BODY}`);
      const { http, calls } = makeHttpStub({
        origin: { error: originErr },
        readerText: "nope",
      });
      const services = makeServices(env, { http });
      let thrown: unknown;
      try {
        await services.fetchArticleMarkdown("https://blocked.example");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).status).toBe(403);
      expect((thrown as HttpError).url).toBe("https://blocked.example");
      expect(calls.filter((c) => c.method === "text").length).toBe(1);
    });
  });

  test("200 HTML challenge body triggers reader fallback", async () => {
    await withEnvPatch({ ARTICLE_FETCH_READER_FALLBACK: true }, async () => {
      const { makeServices } = await import("../pipeline/summarize");
      const encoded = new TextEncoder().encode(CF_BODY);
      const { http, calls } = makeHttpStub({
        origin: {
          bytes: { data: encoded, contentType: "text/html; charset=utf-8" },
        },
        readerText: READER_MD,
      });
      const services = makeServices(env, { http });
      const result = await services.fetchArticleMarkdown("https://cf.example/page");
      expect(result.sourceKind).toBe("reader");
      expect(result.md).toContain("Minecraft");
      expect(calls.filter((c) => c.method === "text").length).toBe(1);
    });
  });
});

describe("getOrFetchArticleMarkdown reader path", () => {
  test("caches reader markdown and records sourceKind=reader", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { createFsStore } = await import("../utils/fs-store");
      const { getOrFetchArticleMarkdown, makeServices } = await import("../pipeline/summarize");

      const store = createFsStore();
      const id = 48_872_401;
      const storyUrl = "https://2b2t.place/1million";
      const s = makeStory({ id, url: storyUrl });
      const path = pathFor.articleMd(id);
      rmSync(path, { force: true });

      const extracts: ArticleExtractRow[] = [];
      const meta = {
        migrate: async () => {},
        upsertArticleExtract: async (row: ArticleExtractRow) => {
          extracts.push(row);
        },
        getArticleExtract: async () => {},
        upsertRawBlob: async () => {},
      } as unknown as MetaStore;

      await withEnvPatch({ ARTICLE_FETCH_READER_FALLBACK: true }, async () => {
        const { http } = makeHttpStub({
          origin: {
            error: new HttpError(storyUrl, 403, `HTTP 403 ${CF_BODY}`),
          },
          readerText: READER_MD,
        });
        const services = makeServices(env, { http });
        const first = await getOrFetchArticleMarkdown(services, s, store, meta);
        expect(first.md).toContain("Minecraft");
        expect(first.extractStatus).toBe("ok");
        expect(existsSync(path)).toBe(true);
        expect(extracts.at(-1)?.sourceKind).toBe("reader");
        expect(extracts.at(-1)?.status).toBe("ok");

        // Second call hits cache — inject a throwing fetch to prove no network.
        const servicesThrow = {
          ...services,
          fetchArticleMarkdown: async () => {
            throw new Error("should not refetch");
          },
        };
        const metaWithExtract = {
          ...meta,
          getArticleExtract: async () => extracts.at(-1),
        } as unknown as MetaStore;
        const second = await getOrFetchArticleMarkdown(servicesThrow, s, store, metaWithExtract);
        expect(second.md).toContain("Minecraft");
      });
    });
  });

  test("bot-protection skip returns empty without caching", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { createFsStore } = await import("../utils/fs-store");
      const { getOrFetchArticleMarkdown, makeServices } = await import("../pipeline/summarize");

      const store = createFsStore();
      const id = 48_872_402;
      const storyUrl = "https://blocked.example/x";
      const s = makeStory({ id, url: storyUrl });
      const path = pathFor.articleMd(id);
      rmSync(path, { force: true });

      await withEnvPatch({ ARTICLE_FETCH_READER_FALLBACK: true }, async () => {
        const { http } = makeHttpStub({
          origin: {
            error: new HttpError(storyUrl, 403, `HTTP 403 ${CF_BODY}`),
          },
          readerText: "x", // too short → reader fails → origin rethrown → empty result
        });
        const services = makeServices(env, { http });
        const result = await getOrFetchArticleMarkdown(services, s, store);
        expect(result.md).toBeUndefined();
        expect(existsSync(path)).toBe(false);
      });
    });
  });
});

