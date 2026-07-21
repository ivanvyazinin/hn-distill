import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import type { AggregatedItem } from "../config/schemas";
import { countTags } from "../utils/tag-counts";
import { indexById, loadAggregated } from "../utils/load-aggregated";
import { withEnvPatch } from "./helpers";

function makeItems(): AggregatedItem[] {
  // High engagement so tests stay stable even if gate env is non-zero.
  return [
    { id: 1, title: "A", tags: ["ai", "rust"], postSummary: "summary A", score: 500, commentsCount: 200 },
    { id: 2, title: "B", tags: ["ai"], postSummary: "summary B", score: 500, commentsCount: 200 },
    { id: 3, title: "C", tags: [], postSummary: "summary C", score: 500, commentsCount: 200 },
  ] as unknown as AggregatedItem[];
}

function writeAggregated(path: string, items: AggregatedItem[], updatedISO = "2026-01-01T00:00:00Z"): void {
  writeFileSync(path, JSON.stringify({ items, updatedISO }), "utf8");
}

describe("loadAggregated caching", () => {
  test("returns the same object for repeated loads of an unchanged file (identity)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-agg-"));
    try {
      const path = join(dir, "aggregated.json");
      writeAggregated(path, makeItems());
      const first = loadAggregated(path);
      const second = loadAggregated(path);
      expect(second).toBe(first);
      expect(second.items).toBe(first.items);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("changing mtime invalidates the cache (new object)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-agg-"));
    try {
      const path = join(dir, "aggregated.json");
      writeAggregated(path, makeItems());
      const first = loadAggregated(path);
      // Rewrite with different content and bump mtime forward deterministically.
      writeAggregated(path, [
        ...makeItems(),
        {
          id: 4,
          title: "D",
          tags: ["ai"],
          postSummary: "summary D",
          score: 500,
          commentsCount: 200,
        } as unknown as AggregatedItem,
      ]);
      const bumped = statSync(path).mtimeMs / 1000 + 5;
      utimesSync(path, bumped, bumped);
      const second = loadAggregated(path);
      expect(second).not.toBe(first);
      expect(second.items.length).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("canonicalises an absolute path and a cwd-relative path to one cache entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-agg-"));
    try {
      const abs = join(dir, "aggregated.json");
      writeAggregated(abs, makeItems());
      // The real production pair: index.astro passes an absolute URL pathname, other
      // callers pass the cwd-relative PATHS.aggregated. These are genuinely different
      // strings; resolve(cwd, rel) must map back to the same canonical key as `abs`.
      const rel = relative(process.cwd(), abs);
      expect(rel).not.toBe(abs);
      const viaAbs = loadAggregated(abs);
      const viaRel = loadAggregated(rel);
      expect(viaRel).toBe(viaAbs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fallback evicts the prior entry: valid → corrupt(diff mtime) → restore(orig mtime)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-agg-"));
    try {
      const path = join(dir, "aggregated.json");
      // Fixed epoch-seconds so the cached mtime and the restored mtime are provably
      // identical (same utimesSync arg → same stored mtimeMs), independent of FS clock.
      const T = 1_700_000_000;

      // v1 cached at mtime T (3 items).
      writeAggregated(path, makeItems());
      utimesSync(path, T, T);
      expect(loadAggregated(path).items.length).toBe(3);

      // Corrupt at a DIFFERENT mtime (T+5) → guaranteed cache miss → read throws →
      // the catch branch must evict the key.
      writeFileSync(path, "{ not valid json", "utf8");
      utimesSync(path, T + 5, T + 5);
      expect(loadAggregated(path).items).toEqual([]);

      // Restore different content but back at the ORIGINAL mtime T. Without eviction the
      // stale v1@T entry would still match this mtime and return 3 items; the fix has
      // dropped it, so we must read the fresh v2 (4 items).
      const v2 = [
        ...makeItems(),
        {
          id: 4,
          title: "D",
          tags: ["ai"],
          postSummary: "summary D",
          score: 500,
          commentsCount: 200,
        } as unknown as AggregatedItem,
      ];
      writeAggregated(path, v2);
      utimesSync(path, T, T);
      expect(loadAggregated(path).items.length).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing file is not cached and does not stick", () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-agg-"));
    try {
      const path = join(dir, "aggregated.json");
      const missing = loadAggregated(path);
      expect(missing.items).toEqual([]);
      expect(missing.updatedISO).toBe("—");
      // Now create the file; the previous empty fallback must not be cached.
      writeAggregated(path, makeItems());
      const present = loadAggregated(path);
      expect(present.items.length).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drops items without a publishable postSummary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-agg-"));
    try {
      const path = join(dir, "aggregated.json");
      writeAggregated(path, [
        ...makeItems(),
        { id: 99, title: "empty", tags: [], postSummary: "", score: 500, commentsCount: 200 } as unknown as AggregatedItem,
        { id: 100, title: "missing", tags: [], score: 500, commentsCount: 200 } as unknown as AggregatedItem,
        { id: 101, title: "whitespace", tags: [], postSummary: "   ", score: 500, commentsCount: 200 } as unknown as AggregatedItem,
      ]);
      const loaded = await withEnvPatch({ SUMMARIZE_MIN_SCORE: 0, SUMMARIZE_MIN_COMMENTS: 0 }, async () =>
        loadAggregated(path)
      );
      expect(loaded.items.map((it) => it.id)).toEqual([1, 2, 3]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drops items below engagement threshold even with a postSummary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-agg-"));
    try {
      const path = join(dir, "aggregated.json");
      writeAggregated(path, [
        {
          id: 1,
          title: "below",
          tags: [],
          postSummary: "has body",
          score: 299,
          commentsCount: 99,
        } as unknown as AggregatedItem,
        {
          id: 2,
          title: "score-ok",
          tags: [],
          postSummary: "has body",
          score: 300,
          commentsCount: 0,
        } as unknown as AggregatedItem,
        {
          id: 3,
          title: "comments-ok",
          tags: [],
          postSummary: "has body",
          score: 10,
          commentsCount: 100,
        } as unknown as AggregatedItem,
      ]);
      const loaded = await withEnvPatch(
        { SUMMARIZE_MIN_SCORE: 300, SUMMARIZE_MIN_COMMENTS: 100 },
        async () => loadAggregated(path)
      );
      expect(loaded.items.map((it) => it.id)).toEqual([2, 3]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed JSON is not cached and does not stick", () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-agg-"));
    try {
      const path = join(dir, "aggregated.json");
      writeFileSync(path, "{ not valid json", "utf8");
      const broken = loadAggregated(path);
      expect(broken.items).toEqual([]);
      // Repair the file and bump mtime; a valid load must now succeed.
      writeAggregated(path, makeItems());
      const bumped = statSync(path).mtimeMs / 1000 + 5;
      utimesSync(path, bumped, bumped);
      const fixed = loadAggregated(path);
      expect(fixed.items.length).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("countTags / indexById memoisation", () => {
  test("same array yields the same Map (identity) for countTags and indexById", () => {
    const items = makeItems();
    expect(countTags(items)).toBe(countTags(items));
    expect(indexById(items)).toBe(indexById(items));
  });

  test("different arrays are not mixed up", () => {
    const a = makeItems();
    const b = makeItems();
    expect(countTags(a)).not.toBe(countTags(b));
    expect(indexById(a)).not.toBe(indexById(b));
  });

  test("countTags counts tags correctly", () => {
    const counts = countTags(makeItems());
    expect(counts.get("ai")).toBe(2);
    expect(counts.get("rust")).toBe(1);
  });

  test("indexById is first-wins on duplicate ids", () => {
    const items = [
      { id: 1, title: "first", tags: [] },
      { id: 1, title: "second", tags: [] },
    ] as unknown as AggregatedItem[];
    expect(indexById(items).get(1)?.title).toBe("first");
  });
});
