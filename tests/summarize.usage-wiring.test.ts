import { describe, expect, test } from "bun:test";

import { createUsageCollector } from "../utils/llm-usage";
import type { LlmUsageRow, MetaStore } from "../utils/meta-store";
import type { ChatMessage } from "../utils/openrouter";
import { comment as makeComment, mockPaths, story as makeStory, withEnvPatch, withTempDir } from "./helpers";

// NOTE: pipeline/summarize is imported ONLY dynamically (inside seedStory), never statically —
// not even `import type`. A static import binds @config/paths before mockPaths swaps it, which
// leaks a stale paths module into other files (e.g. cloudflare.infra) via the process-global
// mock.module registry. Services is therefore referenced structurally via `as never` casts.

// processSingleStory drives the pipeline, so `pipeline/summarize` and the fs store are imported
// dynamically inside withTempDir — the same pattern as summarize.no-article.test.ts — so this
// file's mockPaths mock is established before the module binds config/paths, avoiding the
// process-global mock.module leakage that a static import would otherwise cause.

type PersistRecorder = { inserted: LlmUsageRow[][]; insertThrows: boolean };

const metaNoop = async (): Promise<void> => {};

function makeUsageMeta(rec: PersistRecorder): MetaStore {
  return {
    migrate: metaNoop,
    upsertSummary: metaNoop,
    replaceTags: metaNoop,
    upsertArticleExtract: metaNoop,
    getArticleExtract: metaNoop,
    upsertRawBlob: metaNoop,
    upsertProcessingState: metaNoop,
    insertLlmUsage: async (rows: LlmUsageRow[]) => {
      rec.inserted.push(rows);
      if (rec.insertThrows) {
        throw new Error("persist llm usage boom");
      }
    },
  } as unknown as MetaStore;
}

function makeRecordingServices(usage: ReturnType<typeof createUsageCollector>): never {
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
  const orMock = { chat, chatStructured } as never;
  // sourceKind "text" bypasses the no-article detector, so the post LLM always runs.
  const article =
    "Инженеры описывают переход от хрупкого цикла опроса к устойчивой очереди, которая восстанавливает " +
    "работу после перезапусков. Миграция добавляет ограниченные повторы, трассировку задач и идемпотентные " +
    "обработчики, поэтому дублирующая доставка остаётся безопасной для системы и её пользователей.";
  return {
    http: {} as never,
    openrouter: orMock,
    guardTagsClient: orMock,
    fetchArticleMarkdown: async () => ({ md: article, sourceKind: "text" as const }),
    usage,
  } as never;
}

async function seedStory(base: string, id: number) {
  const { pathFor } = mockPaths(base);
  const { processSingleStory } = await import("../pipeline/summarize");
  const { createFsStore } = await import("../utils/fs-store");
  const store = createFsStore();
  const s = makeStory({ id, url: "https://example.com/x", commentIds: [1, 2] });
  await store.putJson(pathFor.rawItem(id), s);
  await store.putJson(pathFor.rawComments(id), [
    makeComment({ id: 1, parent: id, textPlain: "First take on the topic", depth: 1 }),
    makeComment({ id: 2, parent: id, textPlain: "A different opinion here", depth: 1 }),
  ]);
  return { processSingleStory, store };
}

describe("processSingleStory usage lifecycle", () => {
  test("drains scoped events to insertLlmUsage with the story id and clears scope", async () => {
    await withTempDir(async (base) => {
      const { processSingleStory, store } = await seedStory(base, 5001);
      const usage = createUsageCollector();
      const services = makeRecordingServices(usage);
      const rec: PersistRecorder = { inserted: [], insertThrows: false };

      await withEnvPatch({ TAGS_MAX_PER_STORY: 0, POST_GUARD_ENABLE: false, SUMMARY_LANG: "ru" }, async () => {
        await processSingleStory(services, 5001, store, makeUsageMeta(rec));
      });

      expect(rec.inserted.length).toBe(1);
      const rows = rec.inserted[0] ?? [];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.storyId === 5001)).toBeTrue();
      // Scope cleared and buffer drained after the run.
      expect(usage.size()).toBe(0);
    });
  });

  test("no meta store → no crash and the scope is cleared", async () => {
    await withTempDir(async (base) => {
      const { processSingleStory, store } = await seedStory(base, 5002);
      const usage = createUsageCollector();
      const services = makeRecordingServices(usage);

      await withEnvPatch({ TAGS_MAX_PER_STORY: 0, POST_GUARD_ENABLE: false, SUMMARY_LANG: "ru" }, async () => {
        await processSingleStory(services, 5002, store);
      });

      expect(usage.size()).toBe(0);
    });
  });

  test("a failing insertLlmUsage does not change the outcome (best-effort)", async () => {
    await withTempDir(async (base) => {
      const { processSingleStory, store } = await seedStory(base, 5003);
      const usage = createUsageCollector();
      const services = makeRecordingServices(usage);
      const rec: PersistRecorder = { inserted: [], insertThrows: true };

      await withEnvPatch({ TAGS_MAX_PER_STORY: 0, POST_GUARD_ENABLE: false, SUMMARY_LANG: "ru" }, async () => {
        // Must resolve despite the persistence failure.
        await processSingleStory(services, 5003, store, makeUsageMeta(rec));
      });

      expect(rec.inserted.length).toBe(1);
      expect(usage.size()).toBe(0);
    });
  });
});
