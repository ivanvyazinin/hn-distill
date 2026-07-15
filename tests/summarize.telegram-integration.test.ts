import { describe, expect, test } from "bun:test";

import { pathFor } from "@config/paths";
import type { CommentsSummary, NormalizedStory, PostSummary } from "@config/schemas";
import { buildTelegramMessage } from "@utils/telegram";

import { processSingleStory, type Services } from "../pipeline/summarize";
import type { MetaStore, ProcessingStateUpdate } from "../utils/meta-store";
import type { ObjectStore } from "../utils/object-store";
import { withEnvPatch } from "./helpers";

class FailingCommentsStore implements ObjectStore {
  readonly values: Map<string, string> = new Map<string, string>();
  commentsReadFailures: number;
  commentsWrites: number;
  failCommentsReadsAfterWrite: boolean;
  failCommentsWrites: boolean;
  private rejectCommentsReads: boolean;

  constructor() {
    this.commentsReadFailures = 0;
    this.commentsWrites = 0;
    this.failCommentsReadsAfterWrite = false;
    this.failCommentsWrites = false;
    this.rejectCommentsReads = false;
  }

  async getText(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async putText(key: string, body: string): Promise<void> {
    this.values.set(key, body);
  }

  async getJson<T>(key: string): Promise<T | null> {
    if (key.endsWith(".comments.json") && this.rejectCommentsReads) {
      this.commentsReadFailures += 1;
      throw new Error("comments refresh unavailable");
    }
    const value = this.values.get(key);
    return value === undefined ? null : (JSON.parse(value) as T);
  }

  async putJson(key: string, value: unknown): Promise<void> {
    if (key.endsWith(".comments.json") && this.failCommentsWrites) {
      this.commentsWrites += 1;
      throw new Error("comments persistence unavailable");
    }
    this.values.set(key, JSON.stringify(value));
    if (key.endsWith(".comments.json") && this.failCommentsReadsAfterWrite) {
      this.rejectCommentsReads = true;
    }
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
}

describe("local comments-to-Telegram integration", () => {
  test("an applied v2 result is published without a fallible refresh read", async () => {
    const storyId = 91_002;
    const story: NormalizedStory = {
      id: storyId,
      title: "Current comments publication",
      url: null,
      by: "alice",
      timeISO: "2026-07-15T01:00:00.000Z",
      commentIds: [91_012],
      score: 100,
      descendants: 1,
    };
    const postSummary: PostSummary = {
      id: storyId,
      lang: "en",
      summary: "The article describes how to publish the current comments result safely.",
      inputHash: "legacy-post-hash",
      createdISO: "2026-07-15T01:00:00.000Z",
    };
    const legacyComments: CommentsSummary = {
      id: storyId,
      lang: "en",
      summary: "- This legacy teaser must not be published after v2 succeeds.",
      inputHash: "legacy-comments-hash",
      sampleComments: [91_012],
      createdISO: "2026-07-15T01:00:00.000Z",
    };
    const store = new FailingCommentsStore();
    await store.putJson(pathFor.rawItem(storyId), story);
    await store.putJson(pathFor.rawComments(storyId), [
      {
        id: 91_012,
        by: "bob",
        parent: storyId,
        timeISO: "2026-07-15T01:01:00.000Z",
        textPlain:
          "The current comments result should be used directly after persistence, without depending on another storage read.",
        depth: 0,
      },
    ]);
    await store.putJson(pathFor.postSummary(storyId), postSummary);
    await store.putJson(pathFor.commentsSummary(storyId), legacyComments);
    store.failCommentsReadsAfterWrite = true;

    const processingUpdates: ProcessingStateUpdate[] = [];
    const meta = {
      getArticleExtract: async () => {},
      getTelegramLedger: async () => ({ sentIds: [] }),
      markTelegramSent: async () => {},
      replaceTags: async () => {},
      upsertProcessingState: async (_id: number, update: ProcessingStateUpdate) => {
        processingUpdates.push(update);
      },
      upsertSummary: async () => {},
    } as unknown as MetaStore;

    const sentTexts: string[] = [];
    const http = {
      json: async (_url: string, init: RequestInit) => {
        if (typeof init.body !== "string") {
          throw new TypeError("Expected Telegram request body to be a string");
        }
        const body = JSON.parse(init.body) as { text: string };
        sentTexts.push(body.text);
        return { ok: true, result: { message_id: 7002 } };
      },
    };
    const openrouter = {
      chat: async () => {
        throw new Error("degraded comments must not call legacy chat");
      },
      chatStructured: async () => {
        throw new Error("degraded comments must not call structured chat");
      },
    };
    const services = {
      http,
      openrouter,
      guardTagsClient: openrouter,
      fetchArticleMarkdown: async () => ({ md: "", sourceKind: "empty" as const }),
    } as unknown as Services;

    await withEnvPatch(
      {
        SUMMARY_LANG: "en",
        SITE: "https://hckr.top",
        TAGS_MAX_PER_STORY: 0,
        TELEGRAM_BOT_TOKEN: "TEST_TOKEN",
        TELEGRAM_CHAT_ID: "TEST_CHAT",
        TELEGRAM_ENABLE: true,
        TELEGRAM_MESSAGE_DELAY_MS: 0,
        TELEGRAM_STREAM: true,
      },
      async () => {
        await processSingleStory(services, storyId, store, meta);
      }
    );

    const persisted = JSON.parse(store.values.get(pathFor.commentsSummary(storyId)) ?? "null") as CommentsSummary;
    const expected = buildTelegramMessage(
      {
        id: story.id,
        title: story.title,
        url: story.url,
        hnUrl: `https://news.ycombinator.com/item?id=${story.id}`,
        postSummary: postSummary.summary,
        commentsSummary: persisted.summary,
        timeISO: story.timeISO,
      },
      "https://hckr.top",
      { language: "en" }
    );

    expect(persisted.formatVersion).toBe(2);
    expect(persisted.summary).not.toBe(legacyComments.summary);
    expect(store.commentsReadFailures).toBe(0);
    expect(sentTexts).toEqual([expected]);
    expect(processingUpdates.length).toBe(1);
    expect(processingUpdates[0]?.commentsStatus).toBe("ok");
    expect(typeof processingUpdates[0]?.commentsPolicyVersion).toBe("string");
    expect(processingUpdates[0]?.commentsInputHash).toBe(persisted.inputHash);
  });

  test("comments persistence failure publishes the legacy teaser once without stamping v2 policy", async () => {
    const storyId = 91_001;
    const story: NormalizedStory = {
      id: storyId,
      title: "Reliable queue migration",
      url: null,
      by: "alice",
      timeISO: "2026-07-15T00:00:00.000Z",
      commentIds: [91_011],
      score: 100,
      descendants: 1,
    };
    const postSummary: PostSummary = {
      id: storyId,
      lang: "en",
      summary: "The article describes a safe migration from polling to a durable queue.",
      inputHash: "legacy-post-hash",
      createdISO: "2026-07-15T00:00:00.000Z",
    };
    const legacyComments: CommentsSummary = {
      id: storyId,
      lang: "en",
      summary: "- Operators disagree about switching all traffic at once versus a gradual canary rollout.",
      inputHash: "legacy-comments-hash",
      sampleComments: [91_011],
      createdISO: "2026-07-15T00:00:00.000Z",
    };
    const store = new FailingCommentsStore();
    await store.putJson(pathFor.rawItem(storyId), story);
    await store.putJson(pathFor.rawComments(storyId), [
      {
        id: 91_011,
        by: "bob",
        parent: storyId,
        timeISO: "2026-07-15T00:01:00.000Z",
        textPlain:
          "A gradual canary rollout is safer because operators can compare errors and latency before switching all traffic.",
        depth: 0,
      },
    ]);
    await store.putJson(pathFor.postSummary(storyId), postSummary);
    await store.putJson(pathFor.commentsSummary(storyId), legacyComments);
    store.failCommentsWrites = true;

    const processingUpdates: ProcessingStateUpdate[] = [];
    const sentMessageIds: number[] = [];
    const meta = {
      getArticleExtract: async () => {},
      getTelegramLedger: async () => ({ sentIds: [] }),
      markTelegramSent: async (_id: number, messageId: number) => {
        sentMessageIds.push(messageId);
      },
      replaceTags: async () => {},
      upsertProcessingState: async (_id: number, update: ProcessingStateUpdate) => {
        processingUpdates.push(update);
      },
      upsertSummary: async () => {},
    } as unknown as MetaStore;

    const sentTexts: string[] = [];
    const http = {
      json: async (_url: string, init: RequestInit) => {
        if (typeof init.body !== "string") {
          throw new TypeError("Expected Telegram request body to be a string");
        }
        const body = JSON.parse(init.body) as { text: string };
        sentTexts.push(body.text);
        return { ok: true, result: { message_id: 7001 } };
      },
    };
    const openrouter = {
      chat: async () => {
        throw new Error("comments degraded path must not call legacy chat");
      },
      chatStructured: async () => {
        throw new Error("comments degraded path must not call structured chat");
      },
    };
    const services = {
      http,
      openrouter,
      guardTagsClient: openrouter,
      fetchArticleMarkdown: async () => ({ md: "", sourceKind: "empty" as const }),
    } as unknown as Services;

    await withEnvPatch(
      {
        SUMMARY_LANG: "en",
        SITE: "https://hckr.top",
        TAGS_MAX_PER_STORY: 0,
        TELEGRAM_BOT_TOKEN: "TEST_TOKEN",
        TELEGRAM_CHAT_ID: "TEST_CHAT",
        TELEGRAM_ENABLE: true,
        TELEGRAM_MESSAGE_DELAY_MS: 0,
        TELEGRAM_STREAM: true,
      },
      async () => {
        await processSingleStory(services, storyId, store, meta);
        await processSingleStory(services, storyId, store, meta);
      }
    );

    const expected = buildTelegramMessage(
      {
        id: story.id,
        title: story.title,
        url: story.url,
        hnUrl: `https://news.ycombinator.com/item?id=${story.id}`,
        postSummary: postSummary.summary,
        commentsSummary: legacyComments.summary,
        timeISO: story.timeISO,
      },
      "https://hckr.top",
      { language: "en" }
    );

    expect(store.commentsWrites).toBe(2);
    expect(await store.getJson(pathFor.commentsSummary(storyId))).toEqual(legacyComments);
    expect(sentTexts).toEqual([expected]);
    expect(sentTexts[0]).toContain("Comments");
    expect(sentMessageIds).toEqual([7001]);
    expect(processingUpdates.length).toBe(2);
    expect(processingUpdates.every((update) => update.commentsStatus === "missing")).toBeTrue();
    expect(processingUpdates.every((update) => update.commentsPolicyVersion === undefined)).toBeTrue();
    expect(processingUpdates.every((update) => update.commentsInputHash === undefined)).toBeTrue();
  });
});
