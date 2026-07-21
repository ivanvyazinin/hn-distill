import { describe, expect, test } from "bun:test";

import {
  withTempDir,
  mockPaths,
  story as makeStory,
  comment as makeComment,
  aggItem,
  TEST_ISO,
  withEnvPatch,
} from "./helpers";
import { writeJsonFile } from "@utils/json";
import type { AggregatedItem, NormalizedComment, NormalizedStory, PostSummary } from "@config/schemas";
import { SCORE_MIN_AGGREGATE } from "@config/constants";

const PUBLISHABLE_RU =
  "Эта подробная сводка статьи рассказывает о ключевых тезисах материала, приводит важные цифры и выводы автора, объясняет контекст проблемы и почему тема важна для читателей прямо сейчас, без пустых карточек на главной странице сайта.";

describe("Aggregation & grouping", () => {
  test("readAggregates filters by SCORE_MIN_AGGREGATE and requires postSummary", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { readAggregates } = await import("@scripts/aggregate.mts");

      const storyLow = { id: 74, score: 74, title: "low", timeISO: TEST_ISO, by: "a", url: null };
      const storyHigh = { id: 75, score: 75, title: "high", timeISO: TEST_ISO, by: "b", url: null };
      const storyHighNoSummary = {
        id: 76,
        score: 200,
        title: "high but empty",
        timeISO: TEST_ISO,
        by: "c",
        url: null,
      };

      await writeJsonFile(pathFor.rawItem(74), storyLow);
      await writeJsonFile(pathFor.rawItem(75), storyHigh);
      await writeJsonFile(pathFor.rawItem(76), storyHighNoSummary);
      // Low-score + high-score-without-body must not publish; only real summary does.
      await writeJsonFile(pathFor.postSummary(74), { id: 74, lang: "ru", summary: PUBLISHABLE_RU });
      await writeJsonFile(pathFor.postSummary(75), { id: 75, lang: "ru", summary: PUBLISHABLE_RU });
      await writeJsonFile(pathFor.postSummary(76), {});

      // Gate off (defaults 0/0): score floor + postSummary still apply.
      const items = await withEnvPatch(
        { SUMMARIZE_MIN_SCORE: 0, SUMMARIZE_MIN_COMMENTS: 0 },
        async () => await readAggregates([74, 75, 76])
      );

      expect(items.length).toBe(1);
      expect(items[0]?.id).toBe(75);
      expect(items[0]?.score).toBe(SCORE_MIN_AGGREGATE);
      expect(items[0]?.postSummary).toBe(PUBLISHABLE_RU);
    });
  });

  test("readAggregates drops below engagement threshold even with a valid postSummary", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { readAggregates } = await import("@scripts/aggregate.mts");

      // Below both bars (299/99) — must stay off-site even if an old summary exists.
      await writeJsonFile(pathFor.rawItem(101), {
        id: 101,
        score: 299,
        descendants: 99,
        title: "below",
        timeISO: TEST_ISO,
        by: "a",
        url: null,
      });
      // Passes via score boundary.
      await writeJsonFile(pathFor.rawItem(102), {
        id: 102,
        score: 300,
        descendants: 0,
        title: "score-ok",
        timeISO: TEST_ISO,
        by: "b",
        url: null,
      });
      // Passes via comments boundary (score still above SCORE_MIN_AGGREGATE=75).
      await writeJsonFile(pathFor.rawItem(103), {
        id: 103,
        score: 80,
        descendants: 100,
        title: "comments-ok",
        timeISO: TEST_ISO,
        by: "c",
        url: null,
      });
      // Threshold-pass but missing body.
      await writeJsonFile(pathFor.rawItem(104), {
        id: 104,
        score: 400,
        descendants: 200,
        title: "no-body",
        timeISO: TEST_ISO,
        by: "d",
        url: null,
      });

      for (const id of [101, 102, 103]) {
        await writeJsonFile(pathFor.postSummary(id), { id, lang: "ru", summary: PUBLISHABLE_RU });
      }
      await writeJsonFile(pathFor.postSummary(104), {});

      const items = await withEnvPatch(
        { SUMMARIZE_MIN_SCORE: 300, SUMMARIZE_MIN_COMMENTS: 100 },
        async () => await readAggregates([101, 102, 103, 104])
      );

      expect(items.map((it) => it.id).sort((a, b) => a - b)).toEqual([102, 103]);
    });
  });

  test("buildAggregatedItem uses fallback commentsSummary when LLM missing", async () => {
    await withTempDir(async (base) => {
      mockPaths(base);
      const { buildAggregatedItem, fallbackFromRaw } = await import("@scripts/aggregate.mts");

      const s: NormalizedStory = makeStory({ id: 1, url: null, score: 100, commentIds: [101] });
      const comments: NormalizedComment[] = [makeComment({ id: 101, textPlain: "This is a comment.", parent: s.id })];

      const item = buildAggregatedItem(s, comments, void 0, void 0, void 0);
      const fallback = fallbackFromRaw(s, comments);

      expect(item.postSummary).toBeUndefined();
      expect(item.commentsSummary).toBe(fallback.commentsSummary);
      expect(item.commentsSummary).toContain("This is a comment.");
    });
  });

  test("buildAggregatedItem drops guard-failed summaries", async () => {
    await withTempDir(async (base) => {
      mockPaths(base);
      const { buildAggregatedItem } = await import("@scripts/aggregate.mts");

      const s: NormalizedStory = makeStory({ id: 42, url: null, score: 120, commentIds: [] });

      const postSummary = {
        summary: "As an AI, I cannot comply with that request.",
        guard: { ok: false, verdict: "refusal", reasons: ["refusal"] },
      } satisfies Partial<PostSummary>;

      const item = buildAggregatedItem(s, [], postSummary, void 0, void 0);

      expect(item.postSummary).toBeUndefined();
    });
  });

  test("buildAggregatedItem attaches commentsInsights for v2 structured and skips degraded/legacy", async () => {
    await withTempDir(async (base) => {
      mockPaths(base);
      const { buildAggregatedItem } = await import("@scripts/aggregate.mts");
      const { makeEnCommentsInsights } = await import("./helpers/comments-insights.ts");

      const s: NormalizedStory = makeStory({ id: 99, url: null, score: 120, commentIds: [101] });
      const comments: NormalizedComment[] = [
        makeComment({
          id: 101,
          parent: s.id,
          textPlain:
            "Operational comment with enough length to serve as quote provenance if needed for the fold path.",
        }),
      ];
      const structured = makeEnCommentsInsights();

      const withStructured = buildAggregatedItem(
        s,
        comments,
        void 0,
        {
          id: 99,
          lang: "en",
          summary: "rendered markdown",
          structured,
          formatVersion: 2,
        },
        void 0
      );
      expect(withStructured.commentsInsights !== undefined).toBeTrue();
      expect(withStructured.commentsInsights?.lead).toContain(structured.bottom_line.slice(0, 20));

      const degraded = buildAggregatedItem(
        s,
        comments,
        void 0,
        {
          id: 99,
          lang: "en",
          summary: "### From the discussion\n\n- fallback",
          formatVersion: 2,
          degraded: "too-few-comments",
        },
        void 0
      );
      expect(degraded.commentsInsights).toBeUndefined();

      const legacy = buildAggregatedItem(
        s,
        comments,
        void 0,
        { id: 99, lang: "en", summary: "- old freeform summary" },
        void 0
      );
      expect(legacy.commentsInsights).toBeUndefined();

      const broken = buildAggregatedItem(
        s,
        comments,
        void 0,
        {
          id: 99,
          lang: "en",
          summary: "rendered",
          formatVersion: 2,
          structured: { not: "a valid insights object" },
        },
        void 0
      );
      expect(broken.commentsInsights).toBeUndefined();
    });
  });

  test("buildAggregatedItem prefers usable compressed paragraph and falls back otherwise", async () => {
    await withTempDir(async (base) => {
      mockPaths(base);
      const { buildAggregatedItem } = await import("@scripts/aggregate.mts");
      const { makeRuCommentsInsights } = await import("./helpers/comments-insights.ts");
      const {
        compressSourceHash,
        renderCommentsInsightsPlainText,
      } = await import("../utils/comments-compress.ts");

      const s: NormalizedStory = makeStory({ id: 77, url: null, score: 50, commentIds: [1] });
      const comments: NormalizedComment[] = [
        makeComment({
          id: 1,
          parent: s.id,
          textPlain: "Достаточно длинный комментарий для provenance, если понадобится фолд.",
        }),
      ];
      const structured = makeRuCommentsInsights();
      const sourceHash = compressSourceHash("ru", renderCommentsInsightsPlainText(structured));
      const compressedText =
        "Тред добавляет практический опыт: измерьте задержки перед миграцией и оставьте путь отката.";

      const usable = buildAggregatedItem(
        s,
        comments,
        void 0,
        {
          id: 77,
          lang: "ru",
          summary: "rendered structured markdown",
          structured,
          formatVersion: 2,
          compressed: {
            text: compressedText,
            model: "qwen/qwen3-next-80b-a3b-instruct",
            createdISO: "2026-07-16T12:00:00.000Z",
            sourceHash,
          },
        },
        void 0
      );
      expect(usable.commentsInsights).toBeUndefined();
      expect(usable.commentsSummary).toContain("Тред добавляет");
      expect(usable.commentsSummary).not.toContain("- ");

      const rejected = buildAggregatedItem(
        s,
        comments,
        void 0,
        {
          id: 77,
          lang: "ru",
          summary: "rendered structured markdown",
          structured,
          formatVersion: 2,
          compressed: {
            text: "",
            model: "qwen/qwen3-next-80b-a3b-instruct",
            createdISO: "2026-07-16T12:00:00.000Z",
            sourceHash,
          },
        },
        void 0
      );
      expect(rejected.commentsInsights !== undefined).toBeTrue();

      const absent = buildAggregatedItem(
        s,
        comments,
        void 0,
        {
          id: 77,
          lang: "ru",
          summary: "rendered structured markdown",
          structured,
          formatVersion: 2,
        },
        void 0
      );
      expect(absent.commentsInsights !== undefined).toBeTrue();
    });
  });

  test("main drops stale previous items below engagement threshold", async () => {
    await withTempDir(async (base) => {
      mockPaths(base);
      const { createFsStore } = await import("@utils/fs-store");
      const { PATHS } = await import("@config/paths");
      const { main } = await import("../pipeline/aggregate");

      const stale = {
        id: 201,
        title: "stale below gate",
        url: null,
        by: "a",
        timeISO: TEST_ISO,
        score: 299,
        commentsCount: 99,
        postSummary: PUBLISHABLE_RU,
        commentsSummary: "old comments",
        hnUrl: "https://news.ycombinator.com/item?id=201",
      } as AggregatedItem;

      const keep = {
        id: 202,
        title: "still publishable",
        url: null,
        by: "b",
        timeISO: TEST_ISO,
        score: 400,
        commentsCount: 10,
        postSummary: PUBLISHABLE_RU,
        commentsSummary: "ok comments",
        hnUrl: "https://news.ycombinator.com/item?id=202",
      } as AggregatedItem;

      const store = createFsStore(base);
      await store.putJson(PATHS.aggregated, {
        updatedISO: TEST_ISO,
        items: [stale, keep],
      });
      // Empty index → no fresh rows; merge must still purge stale previous items.
      await store.putJson(PATHS.index, { updatedISO: TEST_ISO, storyIds: [] });

      const out = await withEnvPatch(
        { SUMMARIZE_MIN_SCORE: 300, SUMMARIZE_MIN_COMMENTS: 100 },
        async () => await main(store)
      );

      expect(out.items.map((it) => it.id)).toEqual([202]);
      const rewritten = await store.getJson<{ items: AggregatedItem[] }>(PATHS.aggregated);
      expect(rewritten?.items.map((it) => it.id)).toEqual([202]);
    });
  });

  test("Domain extraction strips www and handles bad URLs gracefully", async () => {
    await withTempDir(async (base) => {
      mockPaths(base);
      const { extractDomain } = await import("@scripts/aggregate.mts");

      expect(extractDomain("https://www.example.com/x")).toBe("example.com");
      expect(extractDomain("https://example.com/y")).toBe("example.com");
      expect(() => extractDomain("not-a-valid-url")).not.toThrow();
      expect(extractDomain("not-a-valid-url")).toBeUndefined();
      expect(extractDomain(undefined as unknown as string)).toBeUndefined();
    });
  });

  test("sortItemsDesc handles invalid dates deterministically", async () => {
    await withTempDir(async (base) => {
      mockPaths(base);
      const { sortItemsDesc } = await import("@scripts/aggregate.mts");

      const itemA: AggregatedItem = aggItem({ id: 1, title: "A", by: "a", timeISO: "2024-01-02T00:00:00Z" }); // Newer
      const itemB: AggregatedItem = aggItem({ id: 2, title: "B", by: "b", timeISO: "2024-01-01T00:00:00Z" }); // Older
      const itemC: AggregatedItem = aggItem({ id: 3, title: "C", by: "c", timeISO: "invalid-date" }); // Invalid

      const sorted = [itemC, itemB, itemA].sort(sortItemsDesc);
      expect(sorted.map((it) => it.title)).toEqual(["A", "B", "C"]);

      // Test deterministic sort for two invalid dates
      const itemD: AggregatedItem = aggItem({ id: 4, title: "D", by: "d", timeISO: "invalid-date-2" });
      const sortedInvalid = [itemC, itemD].sort(sortItemsDesc);
      expect(sortedInvalid.map((it) => it.title)).toEqual(["D", "C"]); // by id desc
    });
  });
});
