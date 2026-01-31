import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { Miniflare } from "miniflare";

import { pathFor } from "@config/paths";
import type { NormalizedStory } from "@config/schemas";

import { createWorkerStore } from "../worker/src/store";
import { getTelegramSentIds, listPendingStoryIds, markTelegramSent, upsertProcessingState, upsertStory } from "../worker/src/d1";
import worker from "../worker/src/index";

const MINIFLARE_SCRIPT = "export default { fetch() { return new Response('ok'); } };";

async function initDb(db: Awaited<ReturnType<Miniflare["getD1Database"]>>): Promise<void> {
  const schema = await readFile("worker/d1/schema.sql", "utf8");
  const cleaned = schema.replace(/^--.*$/gmu, "");
  const statements = cleaned
    .split(";")
    .map((stmt) => stmt.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}

function mockFetchOnce(handler: (url: string, init?: RequestInit) => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    return handler(url, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("cloudflare infra", () => {
  test("R2 store maps summary keys", async () => {
    const mf = new Miniflare({
      modules: true,
      script: MINIFLARE_SCRIPT,
      r2Buckets: ["DATA_BUCKET"],
    });

    try {
      const bucket = await mf.getR2Bucket("DATA_BUCKET");
      const store = createWorkerStore(bucket);

      await store.putJson(pathFor.postSummary(1), { summary: "hello" }, { pretty: false });
      const obj = await bucket.get("summaries/1.post.json");

      expect(obj).not.toBeNull();
      const text = await obj!.text();
      expect(text).toContain("hello");
    } finally {
      await mf.dispose();
    }
  });

  test("D1 helpers roundtrip", async () => {
    const mf = new Miniflare({
      modules: true,
      script: MINIFLARE_SCRIPT,
      d1Databases: ["DB"],
    });

    try {
      const db = await mf.getD1Database("DB");
      await initDb(db);

      const nowISO = new Date().toISOString();
      const story: NormalizedStory = {
        id: 123,
        title: "Test story",
        url: "https://example.com",
        by: "alice",
        timeISO: nowISO,
        commentIds: [],
        score: 42,
        descendants: 10,
      };

      await upsertStory(db, story, 0, nowISO);
      const row = await db
        .prepare("SELECT id, title, rank FROM stories WHERE id = ?")
        .bind(story.id)
        .first<{ id: number; title: string; rank: number }>();

      expect(row?.id).toBe(story.id);
      expect(row?.title).toBe(story.title);
      expect(row?.rank).toBe(0);

      await markTelegramSent(db, story.id, 9001, nowISO);
      const sent = await getTelegramSentIds(db, [story.id, 999]);

      expect(sent.has(story.id)).toBe(true);
      expect(sent.has(999)).toBe(false);
    } finally {
      await mf.dispose();
    }
  });

  test("pending list respects cooldown", async () => {
    const mf = new Miniflare({
      modules: true,
      script: MINIFLARE_SCRIPT,
      d1Databases: ["DB"],
    });

    try {
      const db = await mf.getD1Database("DB");
      await initDb(db);

      const nowISO = new Date().toISOString();
      const olderISO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      const storyA: NormalizedStory = {
        id: 1001,
        title: "Fresh story",
        url: "https://example.com/a",
        by: "alice",
        timeISO: nowISO,
        commentIds: [],
        score: 10,
        descendants: 0,
      };
      const storyB: NormalizedStory = {
        id: 1002,
        title: "Old story",
        url: "https://example.com/b",
        by: "bob",
        timeISO: nowISO,
        commentIds: [],
        score: 12,
        descendants: 0,
      };

      await upsertStory(db, storyA, 0, nowISO);
      await upsertStory(db, storyB, 1, nowISO);

      await upsertProcessingState(db, storyA.id, {
        postStatus: "missing",
        commentsStatus: "missing",
        tagsStatus: "missing",
        updatedAt: nowISO,
        error: null,
      });
      await upsertProcessingState(db, storyB.id, {
        postStatus: "missing",
        commentsStatus: "missing",
        tagsStatus: "missing",
        updatedAt: olderISO,
        error: null,
      });

      const cutoffISO = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const ids = await listPendingStoryIds(db, 10, cutoffISO, nowISO);

      expect(ids).toEqual([storyB.id]);
    } finally {
      await mf.dispose();
    }
  });

  test("worker scheduled enqueues summaries and writes aggregates", async () => {
    const mf = new Miniflare({
      modules: true,
      script: MINIFLARE_SCRIPT,
      r2Buckets: ["DATA_BUCKET"],
      d1Databases: ["DB"],
    });

    try {
      const bucket = await mf.getR2Bucket("DATA_BUCKET");
      const db = await mf.getD1Database("DB");
      await initDb(db);

      const tasks: unknown[] = [];
      const env = {
        DATA_BUCKET: bucket,
        DB: db,
        TASKS: { send: async (message: unknown) => tasks.push(message) },
        SUMMARY_LANG: "en",
        TOP_N: "1",
        MAX_COMMENTS_PER_STORY: "5",
        MAX_DEPTH: "1",
        CONCURRENCY: "1",
        TELEGRAM_ENABLE: "false",
        TAGS_MAX_PER_STORY: "0",
      };

      const storyId = 4242;
      const story = {
        id: storyId,
        type: "story",
        title: "Test story",
        by: "alice",
        time: 1_700_000_000,
        url: "https://example.com",
        score: 120,
        descendants: 0,
        kids: [],
      };

      const restore = mockFetchOnce((url) => {
        if (url.endsWith("/topstories.json")) {
          return new Response(JSON.stringify([storyId]), { status: 200 });
        }
        if (url.includes(`/item/${storyId}.json`)) {
          return new Response(JSON.stringify(story), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });

      try {
        await worker.scheduled({ scheduledTime: Date.now() }, env as never);
      } finally {
        restore();
      }

      expect(tasks.length).toBe(1);
      expect((tasks[0] as { kind?: string }).kind).toBe("summarize");

      const indexObj = await bucket.get("data/index.json");
      expect(indexObj).not.toBeNull();

      const aggregatedObj = await bucket.get("data/aggregated.json");
      expect(aggregatedObj).not.toBeNull();

      const row = await db
        .prepare("SELECT id FROM stories WHERE id = ?")
        .bind(storyId)
        .first<{ id: number }>();
      expect(row?.id).toBe(storyId);
    } finally {
      await mf.dispose();
    }
  });

  test("worker scheduled runs inline when queue missing", async () => {
    const mf = new Miniflare({
      modules: true,
      script: MINIFLARE_SCRIPT,
      r2Buckets: ["DATA_BUCKET"],
      d1Databases: ["DB"],
    });

    try {
      const bucket = await mf.getR2Bucket("DATA_BUCKET");
      const db = await mf.getD1Database("DB");
      await initDb(db);

      const env = {
        DATA_BUCKET: bucket,
        DB: db,
        SUMMARY_LANG: "en",
        TOP_N: "1",
        MAX_COMMENTS_PER_STORY: "5",
        MAX_DEPTH: "1",
        CONCURRENCY: "1",
        TELEGRAM_ENABLE: "false",
        TAGS_MAX_PER_STORY: "0",
        OPENROUTER_API_KEY: "test-key",
        WORKER_SUMMARIZE_MAX_PER_CRON: "1",
      };

      const storyId = 5150;
      const story = {
        id: storyId,
        type: "story",
        title: "Inline story",
        by: "alice",
        time: 1_700_000_100,
        score: 50,
        descendants: 0,
        kids: [],
      };

      const restore = mockFetchOnce((url) => {
        if (url.endsWith("/topstories.json")) {
          return new Response(JSON.stringify([storyId]), { status: 200 });
        }
        if (url.includes(`/item/${storyId}.json`)) {
          return new Response(JSON.stringify(story), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });

      try {
        await worker.scheduled({ scheduledTime: Date.now() }, env as never);
      } finally {
        restore();
      }

      const aggregatedObj = await bucket.get("data/aggregated.json");
      expect(aggregatedObj).not.toBeNull();

      const row = await db
        .prepare("SELECT post_status, comments_status, tags_status FROM processing_state WHERE story_id = ?")
        .bind(storyId)
        .first<{ post_status: string; comments_status: string; tags_status: string }>();

      expect(row?.post_status).toBe("missing");
      expect(row?.comments_status).toBe("missing");
      expect(row?.tags_status).toBe("missing");
    } finally {
      await mf.dispose();
    }
  });

  test("worker queue summarize updates processing state", async () => {
    const mf = new Miniflare({
      modules: true,
      script: MINIFLARE_SCRIPT,
      r2Buckets: ["DATA_BUCKET"],
      d1Databases: ["DB"],
    });

    try {
      const bucket = await mf.getR2Bucket("DATA_BUCKET");
      const db = await mf.getD1Database("DB");
      await initDb(db);

      const store = createWorkerStore(bucket);
      const nowISO = new Date().toISOString();
      const storyId = 777;
      const story: NormalizedStory = {
        id: storyId,
        title: "Queue story",
        url: null,
        by: "bob",
        timeISO: nowISO,
        commentIds: [],
        score: 88,
        descendants: 0,
      };

      await store.putJson(pathFor.rawItem(storyId), story, { pretty: true });
      await store.putJson(pathFor.rawComments(storyId), [], { pretty: true });

      const env = {
        DATA_BUCKET: bucket,
        DB: db,
        TASKS: { send: async () => {} },
        SUMMARY_LANG: "en",
        OPENROUTER_API_KEY: "test-key",
        TAGS_MAX_PER_STORY: "0",
        TELEGRAM_ENABLE: "false",
      };

      await worker.queue({ messages: [{ body: { kind: "summarize", id: storyId } }] }, env as never);

      const row = await db
        .prepare("SELECT post_status, comments_status, tags_status FROM processing_state WHERE story_id = ?")
        .bind(storyId)
        .first<{ post_status: string; comments_status: string; tags_status: string }>();

      expect(row?.post_status).toBe("missing");
      expect(row?.comments_status).toBe("missing");
      expect(row?.tags_status).toBe("missing");

      const postObj = await bucket.get(`summaries/${storyId}.post.json`);
      expect(postObj).toBeNull();
    } finally {
      await mf.dispose();
    }
  });

  test("worker queue telegram writes ledger and dedupes", async () => {
    const mf = new Miniflare({
      modules: true,
      script: MINIFLARE_SCRIPT,
      r2Buckets: ["DATA_BUCKET"],
      d1Databases: ["DB"],
    });

    try {
      const bucket = await mf.getR2Bucket("DATA_BUCKET");
      const db = await mf.getD1Database("DB");
      await initDb(db);

      let calls = 0;
      const restore = mockFetchOnce((url) => {
        calls += 1;
        if (url.startsWith("https://api.telegram.org/botTEST_TOKEN/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 500 } }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });

      const env = {
        DATA_BUCKET: bucket,
        DB: db,
        TASKS: { send: async () => {} },
        SUMMARY_LANG: "en",
        TELEGRAM_ENABLE: "true",
        TELEGRAM_BOT_TOKEN: "TEST_TOKEN",
        TELEGRAM_CHAT_ID: "TEST_CHAT",
        TELEGRAM_DISABLE_NOTIFICATIONS: "true",
      };

      const item = {
        id: 9001,
        title: "Telegram story",
        url: "https://example.com",
        hnUrl: "https://news.ycombinator.com/item?id=9001",
        postSummary: "hello",
        commentsSummary: undefined,
        timeISO: new Date().toISOString(),
      };

      try {
        await worker.queue({ messages: [{ body: { kind: "telegram", item } }] }, env as never);
        await worker.queue({ messages: [{ body: { kind: "telegram", item } }] }, env as never);
      } finally {
        restore();
      }

      const sent = await getTelegramSentIds(db, [item.id]);
      expect(sent.has(item.id)).toBe(true);
      expect(calls).toBe(1);
    } finally {
      await mf.dispose();
    }
  });

  test("worker queue enforces task timeout", async () => {
    const mf = new Miniflare({
      modules: true,
      script: MINIFLARE_SCRIPT,
      r2Buckets: ["DATA_BUCKET"],
      d1Databases: ["DB"],
    });

    try {
      const bucket = await mf.getR2Bucket("DATA_BUCKET");
      const db = await mf.getD1Database("DB");
      await initDb(db);

      const restore = mockFetchOnce(() => {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response("slow", { status: 200 })), 1100);
        });
      });

      const env = {
        DATA_BUCKET: bucket,
        DB: db,
        TASKS: { send: async () => {} },
        SUMMARY_LANG: "en",
        TELEGRAM_ENABLE: "true",
        TELEGRAM_BOT_TOKEN: "TEST_TOKEN",
        TELEGRAM_CHAT_ID: "TEST_CHAT",
        WORKER_QUEUE_TASK_TIMEOUT_MS: "1000",
      };

      const item = {
        id: 42,
        title: "Slow telegram",
        url: "https://example.com",
        hnUrl: "https://news.ycombinator.com/item?id=42",
        postSummary: "hello",
        commentsSummary: undefined,
        timeISO: new Date().toISOString(),
      };

      try {
        await expect(
          worker.queue({ messages: [{ body: { kind: "telegram", item } }] }, env as never)
        ).rejects.toThrow("Timeout");
      } finally {
        restore();
      }
    } finally {
      await mf.dispose();
    }
  });
});
