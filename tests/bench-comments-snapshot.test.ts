import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { snapshotCommentsBench } from "../scripts/bench-comments-snapshot.mts";

import type { NormalizedComment, NormalizedStory, PostSummary } from "../config/schemas.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (path) => await rm(path, { force: true, recursive: true })));
});

async function makeTempLayout(): Promise<{
  root: string;
  commentsDir: string;
  itemsDir: string;
  summariesDir: string;
  outputDir: string;
  manifestPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "hn-comments-snapshot-"));
  tempRoots.push(root);
  const commentsDir = join(root, "data/raw/comments");
  const itemsDir = join(root, "data/raw/items");
  const summariesDir = join(root, "data/summaries");
  const outputDir = join(root, "bench/comments");
  const manifestPath = join(root, "bench/manifest.json");
  await Promise.all([commentsDir, itemsDir, summariesDir, join(root, "bench")].map(async (path) => await mkdir(path, { recursive: true })));
  await writeFile(manifestPath, JSON.stringify({ version: 1, sourceCommit: "keep-me", articleIds: [7] }), "utf8");
  return { root, commentsDir, itemsDir, summariesDir, outputDir, manifestPath };
}

function comments(storyId: number, count: number): NormalizedComment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: storyId * 1000 + index + 1,
    by: `user_${index}`,
    timeISO: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    textPlain: `Deterministic local comment ${index + 1} with enough detail for snapshot testing.`,
    parent: storyId,
    depth: 0,
  }));
}

async function writeLocalStory(
  layout: Awaited<ReturnType<typeof makeTempLayout>>,
  storyId: number,
  count: number,
  title: string
): Promise<void> {
  const story: NormalizedStory = {
    id: storyId,
    title,
    url: `https://example.com/${storyId}`,
    by: "fixture-author",
    timeISO: "2026-01-01T00:00:00.000Z",
    commentIds: [],
  };
  await writeFile(join(layout.itemsDir, `${storyId}.json`), JSON.stringify(story), "utf8");
  await writeFile(join(layout.commentsDir, `${storyId}.json`), JSON.stringify(comments(storyId, count)), "utf8");
}

describe("bench comments snapshot", () => {
  test("selects deterministic local size buckets and preserves manifest fields", async () => {
    const layout = await makeTempLayout();
    await writeLocalStory(layout, 103, 3, "Small thread");
    await writeLocalStory(layout, 102, 25, "Medium thread");
    await writeLocalStory(layout, 101, 38, "Large thread");
    const post: PostSummary = {
      id: 101,
      lang: "en",
      summary: "A deterministic post summary used as candidate context.",
    };
    await writeFile(join(layout.summariesDir, "101.post.json"), JSON.stringify(post), "utf8");

    const result = await snapshotCommentsBench({
      ...layout,
      qualityTargets: { large: 1, medium: 1, small: 1 },
    });

    expect(result).toEqual({
      qualityIds: [101, 102, 103],
      edgeIds: [990_100_001, 990_100_002, 990_100_003, 990_100_004, 990_100_005, 990_100_006],
      provenance: "local-snapshot",
    });
    const largeFixture = JSON.parse(await readFile(join(layout.outputDir, "101.json"), "utf8")) as {
      postTldr?: string;
      comments: unknown[];
    };
    expect(largeFixture.postTldr).toBe(post.summary);
    expect(largeFixture.comments.length).toBe(38);

    const manifest = JSON.parse(await readFile(layout.manifestPath, "utf8")) as Record<string, unknown>;
    expect(manifest["version"]).toBe(1);
    expect(manifest["sourceCommit"]).toBe("keep-me");
    expect(manifest["articleIds"]).toEqual([7]);
    expect(manifest["commentThreadIds"]).toEqual([101, 102, 103]);
    expect(manifest["commentEdgeThreadIds"]).toEqual(result.edgeIds);
  });

  test("refuses fixture overwrite unless explicitly enabled", async () => {
    const layout = await makeTempLayout();
    await writeLocalStory(layout, 101, 38, "Original title");
    const options = {
      ...layout,
      qualityTargets: { large: 1, medium: 0, small: 0 },
    };
    await snapshotCommentsBench(options);
    await writeLocalStory(layout, 101, 38, "Updated title");
    const staleFixturePath = join(layout.outputDir, "123456.json");
    const nonFixturePath = join(layout.outputDir, "notes.json");
    await writeFile(staleFixturePath, "{}", "utf8");
    await writeFile(nonFixturePath, "keep", "utf8");

    await expect(snapshotCommentsBench(options)).rejects.toThrow("Refusing to overwrite existing comments fixtures");
    const beforeOverwrite = await readFile(join(layout.outputDir, "101.json"), "utf8");
    expect(beforeOverwrite).toContain("Original title");

    await snapshotCommentsBench({ ...options, overwrite: true });
    const afterOverwrite = await readFile(join(layout.outputDir, "101.json"), "utf8");
    expect(afterOverwrite).toContain("Updated title");
    await expect(readFile(staleFixturePath, "utf8")).rejects.toThrow();
    expect(await readFile(nonFixturePath, "utf8")).toBe("keep");
  });

  test("marks an empty-source cohort as synthetic without pretending it is production data", async () => {
    const layout = await makeTempLayout();
    const result = await snapshotCommentsBench(layout);
    expect(result.provenance).toBe("synthetic-public-hn-like");
    expect(result.qualityIds.length).toBe(20);
    expect(result.edgeIds.length).toBe(6);

    const qualityFixtures = await Promise.all(
      result.qualityIds.map(async (id) =>
        JSON.parse(await readFile(join(layout.outputDir, `${id}.json`), "utf8")) as { comments: unknown[] }
      )
    );
    expect(qualityFixtures.filter((fixture) => fixture.comments.length >= 38).length).toBe(5);
    expect(
      qualityFixtures.filter((fixture) => fixture.comments.length >= 25 && fixture.comments.length < 38).length
    ).toBe(10);
    expect(
      qualityFixtures.filter((fixture) => fixture.comments.length >= 3 && fixture.comments.length < 25).length
    ).toBe(5);

    const edgeCounts = await Promise.all(
      result.edgeIds.slice(0, 3).map(async (id) => {
        const fixture = JSON.parse(await readFile(join(layout.outputDir, `${id}.json`), "utf8")) as {
          comments: unknown[];
        };
        return fixture.comments.length;
      })
    );
    expect(edgeCounts).toEqual([0, 1, 2]);
    const manifestText = await readFile(layout.manifestPath, "utf8");
    expect(manifestText).toContain("not production conversations");
  });
});
