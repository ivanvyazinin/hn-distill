import { describe, expect, test } from "bun:test";

import { parseEnv } from "../config/env";
import { passesEngagementGate, processSingleStory, type Services } from "../pipeline/summarize";
import { pathFor } from "../config/paths";
import { createUsageCollector } from "../utils/llm-usage";
import type { MetaStore } from "../utils/meta-store";
import type { ObjectStore } from "../utils/object-store";
import { comment as makeComment, story as makeStory, withEnvPatch } from "./helpers";

describe("passesEngagementGate", () => {
  const off = { minScore: 0, minComments: 0 };

  test("both thresholds 0 → everything passes (including score 0/undefined)", () => {
    expect(passesEngagementGate({ score: 0, descendants: 0 }, off)).toBeTrue();
    expect(passesEngagementGate({}, off)).toBeTrue();
    expect(passesEngagementGate({ score: 1000, descendants: 1000 }, off)).toBeTrue();
  });

  test("only minScore=300: below fails, boundary and above pass", () => {
    const t = { minScore: 300, minComments: 0 };
    expect(passesEngagementGate({ score: 299, descendants: 9999 }, t)).toBeFalse();
    expect(passesEngagementGate({ score: 300, descendants: 0 }, t)).toBeTrue();
    expect(passesEngagementGate({ score: 301 }, t)).toBeTrue();
  });

  test("only minComments=100: below fails, boundary and above pass", () => {
    const t = { minScore: 0, minComments: 100 };
    expect(passesEngagementGate({ score: 9999, descendants: 99 }, t)).toBeFalse();
    expect(passesEngagementGate({ descendants: 100 }, t)).toBeTrue();
    expect(passesEngagementGate({ descendants: 101 }, t)).toBeTrue();
  });

  test("both set: OR semantics", () => {
    const t = { minScore: 300, minComments: 100 };
    // low score but high comments → passes
    expect(passesEngagementGate({ score: 50, descendants: 150 }, t)).toBeTrue();
    // high score but low comments → passes
    expect(passesEngagementGate({ score: 400, descendants: 3 }, t)).toBeTrue();
    // both below → fails
    expect(passesEngagementGate({ score: 299, descendants: 99 }, t)).toBeFalse();
  });

  test("missing score/descendants are treated as 0", () => {
    expect(passesEngagementGate({}, { minScore: 300, minComments: 0 })).toBeFalse();
    expect(passesEngagementGate({}, { minScore: 0, minComments: 100 })).toBeFalse();
    expect(passesEngagementGate({}, { minScore: 300, minComments: 100 })).toBeFalse();
    // boundary via the enabled criterion only
    expect(passesEngagementGate({ score: 300 }, { minScore: 300, minComments: 100 })).toBeTrue();
  });
});

describe("parseEnv engagement thresholds", () => {
  test("default to 0/0 (gate off)", () => {
    const parsed = parseEnv({});
    expect(parsed.SUMMARIZE_MIN_SCORE).toBe(0);
    expect(parsed.SUMMARIZE_MIN_COMMENTS).toBe(0);
  });

  test("coerces explicit thresholds", () => {
    const parsed = parseEnv({ SUMMARIZE_MIN_SCORE: "300", SUMMARIZE_MIN_COMMENTS: "100" });
    expect(parsed.SUMMARIZE_MIN_SCORE).toBe(300);
    expect(parsed.SUMMARIZE_MIN_COMMENTS).toBe(100);
  });
});

// Integration: exercise processSingleStory against an in-memory ObjectStore keyed on the REAL
// pathFor, so no module is mocked (mockPaths()/mock.module leaks across files — see
// summarize.usage-wiring.test.ts). This confirms the defense-in-depth gate short-circuits ALL
// LLM + state writes below threshold, and that defaults 0/0 keep processing on.
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

type GateRecorder = { chatCalls: number; upsertStateCalls: number };

const metaNoop = async (): Promise<void> => {};

function makeGateMeta(rec: GateRecorder): MetaStore {
  return {
    migrate: metaNoop,
    upsertSummary: metaNoop,
    replaceTags: metaNoop,
    upsertArticleExtract: metaNoop,
    getArticleExtract: metaNoop,
    upsertRawBlob: metaNoop,
    upsertProcessingState: async () => {
      rec.upsertStateCalls += 1;
    },
    insertLlmUsage: metaNoop,
  } as unknown as MetaStore;
}

const chatStructured = async (): Promise<never> => {
  throw new Error("structured unavailable in this harness");
};

function makeGateServices(rec: GateRecorder, usage: ReturnType<typeof createUsageCollector>): Services {
  const chat = async (): Promise<string> => {
    rec.chatCalls += 1;
    return [
      "- Читатели обсуждают идею и делятся первыми впечатлениями от подхода к решению задачи",
      "- Несколько участников указывают на риски и предлагают более простые альтернативы этому пути",
      "- Автор отвечает на вопросы и обещает опубликовать план дальнейшего развития проекта позже",
    ].join("\n");
  };
  const orMock = { chat, chatStructured } as unknown as Services["openrouter"];
  // sourceKind "text" bypasses the no-article detector, so the post LLM always runs when the gate passes.
  const article = "Инженеры описывают переход к устойчивой очереди, которая восстанавливает работу после перезапусков системы.";
  return {
    http: {} as unknown as Services["http"],
    openrouter: orMock,
    guardTagsClient: orMock,
    fetchArticleMarkdown: async () => ({ md: article, sourceKind: "text" as const }),
    usage,
  } as unknown as Services;
}

function seedBelowThresholdStore(id: number): ObjectStore {
  const store = createMemoryStore();
  // score 10 / descendants 5 → below any positive threshold.
  void store.putJson(pathFor.rawItem(id), makeStory({ id, url: "https://example.com/x", commentIds: [1], score: 10, descendants: 5 }));
  void store.putJson(pathFor.rawComments(id), [
    makeComment({ id: 1, parent: id, textPlain: "First take on the topic", depth: 1 }),
  ]);
  return store;
}

describe("processSingleStory engagement gate", () => {
  test("gate on + below threshold → no LLM, no usage scope, no processing-state write", async () => {
    const rec: GateRecorder = { chatCalls: 0, upsertStateCalls: 0 };
    const usage = createUsageCollector();
    const store = seedBelowThresholdStore(9101);

    await withEnvPatch(
      { TAGS_MAX_PER_STORY: 0, POST_GUARD_ENABLE: false, SUMMARY_LANG: "ru", SUMMARIZE_MIN_SCORE: 300, SUMMARIZE_MIN_COMMENTS: 100 },
      async () => {
        await processSingleStory(makeGateServices(rec, usage), 9101, store, makeGateMeta(rec));
      }
    );

    expect(rec.chatCalls).toBe(0);
    expect(rec.upsertStateCalls).toBe(0);
    expect(usage.size()).toBe(0);
    expect(await store.getJson(pathFor.postSummary(9101))).toBeNull();
  });

  test("gate off (0/0) → the same below-threshold story is processed", async () => {
    const rec: GateRecorder = { chatCalls: 0, upsertStateCalls: 0 };
    const usage = createUsageCollector();
    const store = seedBelowThresholdStore(9102);

    await withEnvPatch(
      { TAGS_MAX_PER_STORY: 0, POST_GUARD_ENABLE: false, SUMMARY_LANG: "ru", SUMMARIZE_MIN_SCORE: 0, SUMMARIZE_MIN_COMMENTS: 0 },
      async () => {
        await processSingleStory(makeGateServices(rec, usage), 9102, store, makeGateMeta(rec));
      }
    );

    expect(rec.chatCalls).toBeGreaterThan(0);
    expect(rec.upsertStateCalls).toBe(1);
  });
});
