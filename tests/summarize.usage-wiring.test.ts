import { describe, expect, test } from "bun:test";

import { pathFor } from "../config/paths";
import { processSingleStory, type Services } from "../pipeline/summarize";
import { createUsageCollector } from "../utils/llm-usage";
import type { LlmUsageRow, MetaStore } from "../utils/meta-store";
import type { ObjectStore } from "../utils/object-store";
import type { ChatMessage } from "../utils/openrouter";
import { comment as makeComment, story as makeStory, withEnvPatch } from "./helpers";

// This suite deliberately avoids mockPaths()/withTempDir(): a process-global mock.module on
// @config/paths leaks into later-loaded suites (e.g. cloudflare.infra). Instead it drives
// processSingleStory against an in-memory ObjectStore keyed on the REAL pathFor, so no module
// is mocked and there is no cross-file state to leak.

const normKey = (key: string): string => key.replace(/^[./]+/u, "");

function createMemoryStore(): ObjectStore {
  const blobs = new Map<string, string>();
  return {
    async getText(key: string): Promise<string | null> {
      return blobs.get(normKey(key)) ?? null;
    },
    async putText(key: string, body: string): Promise<void> {
      blobs.set(normKey(key), body);
    },
    async getJson<T>(key: string): Promise<T | null> {
      const value = blobs.get(normKey(key));
      return value === undefined ? null : (JSON.parse(value) as T);
    },
    async putJson(key: string, value: unknown): Promise<void> {
      blobs.set(normKey(key), JSON.stringify(value));
    },
    async list(prefix: string): Promise<string[]> {
      const normalized = normKey(prefix);
      return [...blobs.keys()].filter((key) => key.startsWith(normalized));
    },
  };
}

type PersistRecorder = { inserted: LlmUsageRow[][]; insertThrows: boolean; upsertStateThrows: boolean };

const metaNoop = async (): Promise<void> => {};

function makeUsageMeta(rec: PersistRecorder): MetaStore {
  return {
    migrate: metaNoop,
    upsertSummary: metaNoop,
    replaceTags: metaNoop,
    upsertArticleExtract: metaNoop,
    getArticleExtract: metaNoop,
    upsertRawBlob: metaNoop,
    upsertProcessingState: async () => {
      if (rec.upsertStateThrows) {
        throw new Error("processing-state write boom");
      }
    },
    insertLlmUsage: async (rows: LlmUsageRow[]) => {
      rec.inserted.push(rows);
      if (rec.insertThrows) {
        throw new Error("persist llm usage boom");
      }
    },
  } as unknown as MetaStore;
}

function makeRecordingServices(usage: ReturnType<typeof createUsageCollector>): Services {
  const chat = async (_m: ChatMessage[], options?: { model?: string; label?: string }): Promise<string> => {
    usage.record({
      label: options?.label ?? "unknown",
      gateway: "openrouter",
      modelRequested: options?.model ?? "primary",
      status: "ok",
      totalTokens: 7,
    });
    return [
      "- Читатели обсуждают идею и делятся первыми впечатлениями от подхода к решению задачи",
      "- Несколько участников указывают на риски и предлагают более простые альтернативы этому пути",
      "- Автор отвечает на вопросы и обещает опубликовать план дальнейшего развития проекта позже",
    ].join("\n");
  };
  const chatStructured = async (_m: ChatMessage[], options?: { model?: string; label?: string }): Promise<never> => {
    usage.record({
      label: options?.label ?? "unknown",
      gateway: "openrouter",
      modelRequested: options?.model ?? "primary",
      status: "error",
    });
    throw new Error("structured unavailable in this harness");
  };
  const orMock = { chat, chatStructured } as unknown as Services["openrouter"];
  // sourceKind "text" bypasses the no-article detector, so the post LLM always runs.
  const article =
    "Инженеры описывают переход от хрупкого цикла опроса к устойчивой очереди, которая восстанавливает " +
    "работу после перезапусков. Миграция добавляет ограниченные повторы, трассировку задач и идемпотентные " +
    "обработчики, поэтому дублирующая доставка остаётся безопасной для системы и её пользователей.";
  return {
    http: {} as unknown as Services["http"],
    openrouter: orMock,
    guardTagsClient: orMock,
    fetchArticleMarkdown: async () => ({ md: article, sourceKind: "text" as const }),
    usage,
  } as unknown as Services;
}

function seedStore(id: number): ObjectStore {
  const store = createMemoryStore();
  // Fire-and-forget puts on a sync Map-backed store resolve immediately; no await needed.
  void store.putJson(pathFor.rawItem(id), makeStory({ id, url: "https://example.com/x", commentIds: [1, 2] }));
  void store.putJson(pathFor.rawComments(id), [
    makeComment({ id: 1, parent: id, textPlain: "First take on the topic", depth: 1 }),
    makeComment({ id: 2, parent: id, textPlain: "A different opinion here", depth: 1 }),
  ]);
  return store;
}

const ENV_PATCH = { TAGS_MAX_PER_STORY: 0, POST_GUARD_ENABLE: false, SUMMARY_LANG: "ru" as const };

describe("processSingleStory usage lifecycle", () => {
  test("drains scoped events to insertLlmUsage with the story id and clears scope", async () => {
    const usage = createUsageCollector();
    const rec: PersistRecorder = { inserted: [], insertThrows: false, upsertStateThrows: false };

    await withEnvPatch(ENV_PATCH, async () => {
      await processSingleStory(makeRecordingServices(usage), 5001, seedStore(5001), makeUsageMeta(rec));
    });

    expect(rec.inserted.length).toBe(1);
    const rows = rec.inserted[0] ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.storyId === 5001)).toBeTrue();
    expect(usage.size()).toBe(0);
  });

  test("no meta store → no crash and the scope is cleared", async () => {
    const usage = createUsageCollector();
    await withEnvPatch(ENV_PATCH, async () => {
      await processSingleStory(makeRecordingServices(usage), 5002, seedStore(5002));
    });
    expect(usage.size()).toBe(0);
  });

  test("a failing insertLlmUsage does not change the outcome (best-effort)", async () => {
    const usage = createUsageCollector();
    const rec: PersistRecorder = { inserted: [], insertThrows: true, upsertStateThrows: false };
    await withEnvPatch(ENV_PATCH, async () => {
      // Must resolve despite the persistence failure.
      await processSingleStory(makeRecordingServices(usage), 5003, seedStore(5003), makeUsageMeta(rec));
    });
    expect(rec.inserted.length).toBe(1);
    expect(usage.size()).toBe(0);
  });

  test("when the body throws, finally still flushes recorded usage (R: drain in finally)", async () => {
    const usage = createUsageCollector();
    const rec: PersistRecorder = { inserted: [], insertThrows: false, upsertStateThrows: true };

    await withEnvPatch(ENV_PATCH, async () => {
      // upsertProcessingState runs inside the try and is not caught locally, so it propagates —
      // the finally must still have drained the events recorded earlier in the run.
      await expect(
        processSingleStory(makeRecordingServices(usage), 5004, seedStore(5004), makeUsageMeta(rec))
      ).rejects.toThrow("processing-state write boom");
    });

    expect(rec.inserted.length).toBe(1);
    const rows = rec.inserted[0] ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.storyId === 5004)).toBeTrue();
    expect(usage.size()).toBe(0);
  });
});
