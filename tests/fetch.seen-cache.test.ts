import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Services } from "../scripts/fetch-hn.mts";
import { makeMockHttp, mockPaths, withEnvPatch, withTempDir, type RouteValue } from "./helpers";

const SEEN_TELEGRAM_SEED = {
  lastHash: "digest-hash-abc",
  lastIds: [101],
  sentAtISO: "2026-08-24T00:00:00.000Z",
};

// Dynamic imports below are intentional: @scripts/fetch-hn.mts and @utils/fs-store
// bind config paths at module init, so they must load AFTER mockPaths(base) has
// redirected PATHS into the temp dir (same pattern as tests/pipeline.idempotency.test.ts).

describe("fetch seen-cache foreign namespaces", () => {
  test("fetch preserves non-numeric keys (telegram) across runs", async () => {
    await withTempDir(async (base) => {
      const { PATHS } = mockPaths(base);
      const storyId = 101;
      const commentId = 201;
      const story = {
        id: storyId,
        type: "story",
        title: "Test story",
        by: "alice",
        time: 1_700_000_000,
        url: "https://example.com/article",
        score: 100,
        descendants: 1,
        kids: [commentId],
      };
      const comment = {
        id: commentId,
        type: "comment",
        text: "<p>Hello</p>",
        by: "bob",
        time: 1_700_000_500,
        parent: storyId,
        kids: [],
      };

      // Stale story entry forces seenCacheChanged=true on the first run, so the
      // write-back path (extras merge) is exercised, not just the read path.
      await mkdir(dirname(PATHS.seenCache), { recursive: true });
      const seed = {
        [String(storyId)]: { seenTopLevel: [] as number[], seenByDepth: {}, updatedISO: "2026-08-01T00:00:00.000Z" },
        telegram: SEEN_TELEGRAM_SEED,
      };
      await writeFile(PATHS.seenCache, JSON.stringify(seed, null, 2));

      const routes: Record<string, RouteValue> = {
        "/\\/topstories\\.json$/": [storyId],
        [`/\\/item\\/${storyId}\\.json$/`]: story,
        [`/\\/item\\/${commentId}\\.json$/`]: comment,
      };
      const services = { http: makeMockHttp(routes).http } as Services;

      const { main: fetchMain } = await import("@scripts/fetch-hn.mts");

      await withEnvPatch(
        {
          TOP_N: 1,
          MAX_COMMENTS_PER_STORY: 10,
          MAX_DEPTH: 2,
          CONCURRENCY: 2,
        } as const,
        async () => {
          await fetchMain(services);
          const afterFirstRun = JSON.parse(await readFile(PATHS.seenCache, "utf8")) as Record<string, { seenTopLevel?: number[] } | undefined> & {
            telegram?: unknown;
          };
          expect(afterFirstRun.telegram).toEqual(SEEN_TELEGRAM_SEED);
          expect(afterFirstRun[String(storyId)]?.seenTopLevel).toEqual([commentId]);

          await fetchMain(services);
          const afterSecondRun = await readFile(PATHS.seenCache, "utf8");
          expect(JSON.parse(afterSecondRun)).toEqual(afterFirstRun);
        }
      );
    });
  });

  test("legacy seenKids entries still migrate to seenTopLevel", async () => {
    await withTempDir(async (base) => {
      const { PATHS } = mockPaths(base);

      await mkdir(dirname(PATHS.seenCache), { recursive: true });
      await writeFile(
        PATHS.seenCache,
        JSON.stringify({
          "7": { seenKids: [11, 12], seenByDepth: { "0": [11], "1": [12] }, updatedISO: "2026-07-01T00:00:00.000Z" },
        })
      );

      const [{ readSeenCache }, { createFsStore }] = await Promise.all([
        import("@scripts/fetch-hn.mts"),
        import("@utils/fs-store"),
      ]);
      const { entries } = await readSeenCache(createFsStore());
      expect(entries[7]).toEqual({
        seenTopLevel: [11, 12],
        seenByDepth: { "0": [11], "1": [12] },
        updatedISO: "2026-07-01T00:00:00.000Z",
      });
    });
  });
});
