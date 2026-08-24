import { describe, expect, test } from "bun:test";

import { COMMENTS_POLICY_VERSION } from "../config/env";
import type { CommentsInsights, CommentsSummary, NormalizedStory } from "../config/schemas";
import { computeCommentsChanged } from "../pipeline/summarize";
import type { ObjectStore } from "../utils/object-store";
import { story as makeStory, withEnvPatch } from "./helpers";

// Behavior freeze for computeCommentsChanged (pipeline/summarize.ts): pins the
// exact verdict of every staleness arm BEFORE the planned refactor. Each case
// records the ordering contract:
//   1. !existing                          -> true
//   2. degraded === "generation-failed"   -> true (ignores cooldown)
//   3. compress enabled + v2 + structured + not degraded +
//      compressedStateFor === "retryable" -> true (ignores cooldown)
//   4. inside cooldown                    -> false
//   5. policyVersion mismatch             -> true
//   6. +N descendants regen gate          -> delta > COMMENTS_REGEN_MIN_NEW_COMMENTS
//   7. else rebuild hash from store       -> formatVersion !== 2 || hash mismatch

class MemoryStore implements ObjectStore {
  readonly values: Map<string, string> = new Map<string, string>();

  async getText(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async putText(key: string, body: string): Promise<void> {
    this.values.set(key, body);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const value = this.values.get(key);
    return value === undefined ? null : (JSON.parse(value) as T);
  }

  async putJson(key: string, value: unknown): Promise<void> {
    this.values.set(key, JSON.stringify(value));
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
}

const INSIGHTS: CommentsInsights = {
  bottom_line: "Тред добавляет практический опыт измерений перед миграцией.",
  insights: [
    { kind: "consensus", text: "Участники согласны, что задержки нужно измерить до миграции." },
  ],
  best_quote: null,
};

const NOW = Date.parse("2026-08-24T12:00:00.000Z");

function healthyV2(over: Partial<CommentsSummary> = {}): CommentsSummary {
  return {
    id: 1,
    lang: "ru",
    summary: "- Здоровое саммари",
    formatVersion: 2,
    structured: INSIGHTS,
    degraded: undefined,
    inputHash: "frozen-input-hash",
    policyVersion: COMMENTS_POLICY_VERSION,
    createdISO: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

describe("comments staleness freeze", () => {
  test("no existing summary -> changed (true)", async () => {
    const story = makeStory({ id: 1 });
    const store = new MemoryStore();

    await withEnvPatch({ COMMENTS_COMPRESS_MODEL: "" }, async () => {
      expect(await computeCommentsChanged(story, null, "ru", 3_600_000, NOW, store)).toBeTrue();
      expect(await computeCommentsChanged(story, undefined, "ru", 3_600_000, NOW, store)).toBeTrue();
    });
  });

  test("degraded generation-failed ignores cooldown -> true", async () => {
    const story = makeStory({ id: 2 });
    const store = new MemoryStore();
    const fallback = healthyV2({
      degraded: "generation-failed",
      summary: "Карточка без саммари: генерация не удалась.",
      structured: undefined,
    });

    // createdISO one minute ago, cooldown one hour — still forced regen.
    await withEnvPatch({ COMMENTS_COMPRESS_MODEL: "" }, async () => {
      expect(await computeCommentsChanged(story, fallback, "ru", 3_600_000, NOW, store)).toBeTrue();
    });
  });

  test("compress-retryable structured blob ignores cooldown -> true", async () => {
    const story = makeStory({ id: 3 });
    const store = new MemoryStore();
    // No `compressed` field + structured present => compressedStateFor === "retryable".
    const pendingCompress = healthyV2({ compressed: undefined });

    await withEnvPatch(
      { SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: "test-model" },
      async () => {
        expect(await computeCommentsChanged(story, pendingCompress, "ru", 3_600_000, NOW, store)).toBeTrue();
      }
    );
  });

  test("healthy v2 blob inside cooldown -> false", async () => {
    const story = makeStory({ id: 4, descendants: 100 });
    const store = new MemoryStore();
    const fresh = healthyV2({ processedDescendants: 100 });

    await withEnvPatch(
      { COMMENTS_COMPRESS_MODEL: "", COMMENTS_REGEN_MIN_NEW_COMMENTS: 5 },
      async () => {
        expect(await computeCommentsChanged(story, fresh, "ru", 3_600_000, NOW, store)).toBeFalse();
      }
    );
  });

  test("cooldownMs=0 falls through cooldown into hash arm; empty store mismatch -> true", async () => {
    const story = makeStory({ id: 5, descendants: 100 });
    const store = new MemoryStore(); // deliberately empty: no rawComments/postSummary
    // No processedDescendants => +N gate cannot fire => hash rebuild on empty
    // store yields [] comments, so the stored inputHash cannot match.
    const legacyHash = healthyV2({
      inputHash: "frozen-input-hash",
      processedDescendants: undefined,
    });

    await withEnvPatch(
      { COMMENTS_COMPRESS_MODEL: "", COMMENTS_REGEN_MIN_NEW_COMMENTS: 5 },
      async () => {
        expect(await computeCommentsChanged(story, legacyHash, "ru", 0, NOW, store)).toBeTrue();
      }
    );
  });

  test("policyVersion mismatch after cooldown expires -> true", async () => {
    const story = makeStory({ id: 6, descendants: 120 });
    const store = new MemoryStore();
    const stalePolicy = healthyV2({
      policyVersion: "0",
      processedDescendants: 120,
      createdISO: new Date(NOW - 2 * 3_600_000).toISOString(),
    });

    await withEnvPatch(
      { COMMENTS_COMPRESS_MODEL: "", COMMENTS_REGEN_MIN_NEW_COMMENTS: 5 },
      async () => {
        expect(await computeCommentsChanged(story, stalePolicy, "ru", 3_600_000, NOW, store)).toBeTrue();
      }
    );
  });

  test("+N descendants gate: delta <= threshold -> false, delta > threshold -> true", async () => {
    const base = makeStory({ id: 7, descendants: 105 });
    const store = new MemoryStore();
    const gated = healthyV2({ processedDescendants: 100, structured: undefined });

    await withEnvPatch(
      { COMMENTS_COMPRESS_MODEL: "", COMMENTS_REGEN_MIN_NEW_COMMENTS: 5 },
      async () => {
        // delta = 105 - 100 = 5, NOT > 5 -> hold (hash path intentionally skipped).
        expect(await computeCommentsChanged(base, gated, "ru", 0, NOW, store)).toBeFalse();
        // delta = 106 - 100 = 6 > 5 -> forced regen even though nothing else moved.
        expect(
          await computeCommentsChanged(
            { ...base, descendants: 106 },
            gated,
            "ru",
            0,
            NOW,
            store
          )
        ).toBeTrue();
        // Negative delta (moderated shrink) counts as within threshold -> hold.
        expect(
          await computeCommentsChanged(
            { ...base, descendants: 98 },
            gated,
            "ru",
            0,
            NOW,
            store
          )
        ).toBeFalse();
      }
    );
  });

  test("legacy blob (no formatVersion) + empty store falls to hash arm -> true", async () => {
    const story = makeStory({ id: 8 });
    const store = new MemoryStore(); // no rawComments / postSummary files
    const legacy: CommentsSummary = {
      id: story.id,
      lang: "ru",
      summary: "- Старое легаси-саммари",
      inputHash: "legacy-hash",
      createdISO: new Date(NOW - 2 * 3_600_000).toISOString(),
      // no formatVersion / structured / policyVersion / processedDescendants
    };

    await withEnvPatch(
      { COMMENTS_COMPRESS_MODEL: "", COMMENTS_REGEN_MIN_NEW_COMMENTS: 5 },
      async () => {
        expect(await computeCommentsChanged(story, legacy, "ru", 3_600_000, NOW, store)).toBeTrue();
      }
    );
  });
});
