import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { benchModelDirName, benchSummaryRelPath, writeBenchSummaryMarkdown } from "../eval/bench-summaries";

describe("benchModelDirName", () => {
  test("encodes slashes and colons", () => {
    expect(benchModelDirName("nvidia/nemotron-3-nano-30b-a3b:free")).toBe(
      "nvidia__nemotron-3-nano-30b-a3b__free"
    );
  });
});

describe("benchSummaryRelPath", () => {
  test("nests under run id and model dir", () => {
    const rel = benchSummaryRelPath({
      runId: "2026-07-10T09-28-12.745Z",
      model: "m/x:free",
      articleId: 45_640_678,
      repeat: 0,
    });
    expect(rel).toContain("data/bench/summaries/2026-07-10T09-28-12.745Z/m__x__free/45640678.md");
  });
});

describe("writeBenchSummaryMarkdown", () => {
  test("writes front matter and body", async () => {
    const prev = process.cwd();
    const dir = await mkdtemp(join(tmpdir(), "hn-bench-"));
    process.chdir(dir);
    try {
      const rel = await writeBenchSummaryMarkdown({
        runId: "test-run",
        article: { id: 1, title: "Hello", url: "https://x", articleSlice: "slice" },
        record: {
          model: "m/a",
          articleId: 1,
          repeat: 0,
          latencyMs: 10,
          outputChars: 5,
          heuristic: { ok: true, triggers: [] },
        },
        summaryText: "Summary body",
      });
      const text = await readFile(join(dir, rel), "utf8");
      expect(text).toContain("model: m/a");
      expect(text).toContain("Summary body");
    } finally {
      process.chdir(prev);
      await rm(dir, { recursive: true, force: true });
    }
  });
});