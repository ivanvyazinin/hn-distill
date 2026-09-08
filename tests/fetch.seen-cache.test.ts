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
  test("writes each fresh complete comment snapshot while preserving foreign cache namespaces", async () => {
    await withTempDir(async (base) => {
      const { PATHS, pathFor } = mockPaths(base);
      const storyId = 101;
      const rootId = 201;
      const replyId = 202;
      const story = {
        id: storyId,
        type: "story",
        title: "Test story",
        by: "alice",
        time: 1_700_000_000,
        url: "https://example.com/article",
        score: 100,
        descendants: 2,
        kids: [rootId],
      };
      let root = {
        id: rootId,
        type: "comment",
        text: "<p>Root</p>",
        by: "bob",
        time: 1_700_000_500,
        parent: storyId,
        kids: [replyId],
      };
      let reply = {
        id: replyId,
        type: "comment",
        text: "<p>Original reply</p>",
        by: "carol",
        time: 1_700_000_600,
        parent: rootId,
        kids: [] as number[],
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
        [`/\\/item\\/${rootId}\\.json$/`]: () => root,
        [`/\\/item\\/${replyId}\\.json$/`]: () => reply,
      };
      const services = { http: makeMockHttp(routes).http } as Services;

      const { main: fetchMain } = await import("@scripts/fetch-hn.mts");
      const readSnapshot = async (): Promise<Array<{ id: number; textPlain: string }>> =>
        JSON.parse(await readFile(pathFor.rawComments(storyId), "utf8")) as Array<{ id: number; textPlain: string }>;

      await withEnvPatch(
        {
          TOP_N: 1,
          MAX_COMMENTS_PER_STORY: 10,
          MAX_DEPTH: 2,
          CONCURRENCY: 2,
        } as const,
        async () => {
          await fetchMain(services);
          expect((await readSnapshot()).map(({ id }) => id)).toEqual([rootId, replyId]);
          const afterFirstRun = JSON.parse(await readFile(PATHS.seenCache, "utf8")) as Record<
            string,
            { seenTopLevel?: number[] } | undefined
          > & {
            telegram?: unknown;
          };
          expect(afterFirstRun.telegram).toEqual(SEEN_TELEGRAM_SEED);
          expect(afterFirstRun[String(storyId)]?.seenTopLevel).toEqual([rootId]);

          await fetchMain(services);
          expect((await readSnapshot()).map(({ id }) => id)).toEqual([rootId, replyId]);
          expect(JSON.parse(await readFile(PATHS.seenCache, "utf8"))).toEqual(afterFirstRun);

          reply = { ...reply, text: "<p>Edited reply</p>" };
          await fetchMain(services);
          expect((await readSnapshot()).find(({ id }) => id === replyId)?.textPlain).toMatch(/^Edited\s+reply$/u);

          root = { ...root, kids: [] };
          await fetchMain(services);
          expect((await readSnapshot()).map(({ id }) => id)).toEqual([rootId]);
          const afterDeletion = JSON.parse(await readFile(PATHS.seenCache, "utf8")) as {
            telegram?: unknown;
            [key: string]: unknown;
          };
          expect(afterDeletion.telegram).toEqual(SEEN_TELEGRAM_SEED);
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
