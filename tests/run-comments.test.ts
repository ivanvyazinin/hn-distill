import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseEnv } from "../config/env.ts";
import {
  parseCommentsArgs,
  runCommentsCli,
  type CommentsCliEnvironment,
} from "../eval/run-comments.mts";
import { withTempDir } from "./helpers/tempfs";

const STUB_ENV: CommentsCliEnvironment = parseEnv({
  COMMENTS_JUDGE_THREAD_MAX_CHARS: "24000",
  JUDGE_MODEL: "",
  OPENROUTER_MODEL: "",
});

function fixture(id: number, marker: string) {
  return {
    story: {
      id,
      title: `Fixture ${id}`,
      url: `https://example.invalid/${id}`,
    },
    postTldr: "Complete fixture context passed to both candidate variants.",
    comments: [
      {
        id: id * 1000 + 1,
        by: "alice",
        timeISO: "2026-01-01T00:00:00.000Z",
        textPlain: `A complete canonical comment with a unique tail marker: ${marker}`,
        parent: id,
        depth: 0,
      },
    ],
  };
}

async function writeHarnessInput(root: string): Promise<{
  fixturesDir: string;
  manifestPath: string;
}> {
  const fixturesDir = join(root, "comments");
  const manifestPath = join(root, "manifest.json");
  await mkdir(fixturesDir, { recursive: true });
  await Promise.all([
    writeFile(
      manifestPath,
      `${JSON.stringify({ commentThreadIds: [101], commentEdgeThreadIds: [202] })}\n`,
      "utf8"
    ),
    writeFile(join(fixturesDir, "101.json"), `${JSON.stringify(fixture(101, "QUALITY_TAIL"))}\n`, "utf8"),
    writeFile(join(fixturesDir, "202.json"), `${JSON.stringify(fixture(202, "EDGE_TAIL"))}\n`, "utf8"),
  ]);
  return { fixturesDir, manifestPath };
}

describe("comments evaluation CLI", () => {
  test("parses deterministic overrides and enforces paired repeats", () => {
    const options = parseCommentsArgs([
      "--stub-judge",
      "--repeats",
      "3",
      "--seed",
      "17",
      "--out",
      "/tmp/comments.json",
      "--markdown-out",
      "/tmp/comments.md",
    ]);
    expect(options.stubJudge).toBeTrue();
    expect(options.repeats).toBe(3);
    expect(options.seed).toBe(17);
    expect(options.out).toBe("/tmp/comments.json");
    expect(options.markdownOut).toBe("/tmp/comments.md");
    expect(() => parseCommentsArgs(["--repeats", "1"])).toThrow("at least 2");
  });

  test("runs quality and edge fixtures with local stubs and writes explicit JSON and Markdown outputs", async () => {
    await withTempDir(async (root) => {
      const input = await writeHarnessInput(root);
      const resultsPath = join(root, "output", "comments.json");
      const markdownPath = join(root, "output", "comments.md");

      const run = await runCommentsCli(
        [
          "--stub-judge",
          "--manifest",
          input.manifestPath,
          "--fixtures-dir",
          input.fixturesDir,
          "--repeats",
          "2",
          "--seed",
          "1234",
          "--out",
          resultsPath,
          "--markdown-out",
          markdownPath,
        ],
        {
          environment: STUB_ENV,
          now: () => new Date("2026-07-14T12:00:00.000Z"),
        }
      );

      expect(run.result.records.length).toBe(8);
      expect(run.resultsPath).toBe(resultsPath);
      expect(run.markdownPath).toBe(markdownPath);

      const [json, markdown] = await Promise.all([
        readFile(resultsPath, "utf8"),
        readFile(markdownPath, "utf8"),
      ]);
      expect(json).toContain('"generatedAt": "2026-07-14T12:00:00.000Z"');
      expect(json).toContain('"qualityThreadIds"');
      expect(json).toContain("101");
      expect(json).toContain('"edgeThreadIds"');
      expect(json).toContain("202");
      expect(json).toContain('"requestedModel": "stub-v1"');
      expect(json).toContain('"resolvedModel": "stub-v2"');
      expect(json).toContain('"provider": "local-stub"');
      expect(json).toContain('"seed": 1234');
      expect(markdown).toContain("Comments");
    });
  });

  test("real mode checks credentials before constructing services or loading fixtures", async () => {
    let factoryCalls = 0;
    await expect(
      runCommentsCli([], {
        environment: STUB_ENV,
        servicesFactory: () => {
          factoryCalls++;
          throw new Error("services factory called");
        },
      })
    ).rejects.toThrow("OPENROUTER_API_KEY");
    expect(factoryCalls).toBe(0);

    const configured = parseEnv({
      COMMENTS_JUDGE_THREAD_MAX_CHARS: "24000",
      JUDGE_API_KEY: "judge-key",
      JUDGE_MODEL: "judge-model",
      OPENROUTER_API_KEY: "candidate-key",
      OPENROUTER_MODEL: "candidate-model",
    });
    await expect(
      runCommentsCli([], {
        environment: configured,
        servicesFactory: () => {
          factoryCalls++;
          throw new Error("services factory called");
        },
      })
    ).rejects.toThrow("services factory called");
    expect(factoryCalls).toBe(1);
  });
});
