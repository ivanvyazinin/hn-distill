import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import type { Services } from "../scripts/fetch-hn.mts";
import { makeMockHttp, mockPaths, withEnvPatch, withTempDir } from "./helpers";

async function snapshotDir(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  async function walk(dir: string): Promise<void> {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = relative(root, full);
      result[rel] = await readFile(full, "utf8");
    }
  }

  await walk(root);
  return result;
}

describe("pipeline idempotency", () => {
  test("second run with identical inputs leaves data untouched", async () => {
    await withTempDir(async (base) => {
      const { PATHS } = mockPaths(base);
      const envPatch = {
        TOP_N: 1,
        MAX_COMMENTS_PER_STORY: 10,
        MAX_DEPTH: 2,
        CONCURRENCY: 2,
      } as const;

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

      const routes: Record<string, unknown> = {
        "/\\/topstories\\.json$/": [storyId],
        [`/\\/item\\/${storyId}\\.json$/`]: story,
        [`/\\/item\\/${commentId}\\.json$/`]: comment,
      };
      const mock = makeMockHttp(routes);
      const services = { http: mock.http } as Services;

      const { main: fetchMain } = await import("@scripts/fetch-hn.mts");
      const { main: aggregateMain } = await import("@scripts/aggregate.mts");

      async function runPipeline(): Promise<void> {
        await fetchMain(services);
        await aggregateMain();
      }

      await withEnvPatch(envPatch, async () => {
        await runPipeline();
        const before = await snapshotDir(PATHS.dataDir);

        await runPipeline();
        const after = await snapshotDir(PATHS.dataDir);

        expect(after).toEqual(before);
      });
    });
  });
});
