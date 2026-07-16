import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { LlmUsageSummaryRow } from "@utils/meta-store";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (path) => await rm(path, { force: true, recursive: true })));
});

async function tempDbPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hn-llm-usage-"));
  tempRoots.push(root);
  return join(root, "meta.sqlite");
}

const execFileAsync = promisify(execFile);

async function runSummary(path: string): Promise<LlmUsageSummaryRow[]> {
  const storeUrl = pathToFileURL(join(process.cwd(), "utils/sqlite-store.ts")).href;
  const script = `
    import { createSqliteStore } from ${JSON.stringify(storeUrl)};
    const [path] = process.argv.slice(1);
    const store = createSqliteStore(path);
    await store.migrate();
    // Empty batch is a no-op.
    await store.insertLlmUsage([]);
    await store.insertLlmUsage([
      { createdAt: "2026-07-15T10:00:00.000Z", storyId: 1, label: "post", gateway: "openrouter", modelRequested: "primary", modelUsed: "primary", promptTokens: 100, completionTokens: 50, totalTokens: 150, status: "ok" },
      { createdAt: "2026-07-15T10:05:00.000Z", storyId: 1, label: "post", gateway: "openrouter", modelRequested: "primary", modelUsed: "primary", promptTokens: 200, completionTokens: 20, totalTokens: 220, status: "ok" },
      { createdAt: "2026-07-15T11:00:00.000Z", storyId: 2, label: "comments", gateway: "groq", modelRequested: "llama", modelUsed: "llama", attempt: 1, promptTokens: 300, completionTokens: 100, totalTokens: 400, status: "error" },
      { createdAt: "2026-07-15T11:01:00.000Z", storyId: 2, label: "comments", gateway: "groq", modelRequested: "llama", status: "error" },
      { createdAt: "2026-07-14T09:00:00.000Z", storyId: 3, label: "tags", gateway: "groq", modelRequested: "llama", modelUsed: "llama", totalTokens: 40, status: "ok" },
    ]);
    const summary = await store.getLlmUsageSummary();
    store.close();
    process.stdout.write(JSON.stringify(summary));
  `;
  const { stdout } = await execFileAsync(
    "node",
    ["--import", "tsx", "--input-type=module", "--eval", script, path],
    { cwd: process.cwd() }
  );
  return JSON.parse(stdout) as LlmUsageSummaryRow[];
}

describe("llm_usage SQLite round-trip", () => {
  test("aggregates per day/gateway/label/model with errors, NULL model, and snake→camel mapping", async () => {
    const path = await tempDbPath();
    const summary = await runSummary(path);

    // Rows ordered by day DESC, then total_tokens DESC.
    expect(summary.map((r) => [r.day, r.gateway, r.label, r.modelUsed])).toEqual([
      ["2026-07-15", "groq", "comments", "llama"],
      ["2026-07-15", "openrouter", "post", "primary"],
      ["2026-07-15", "groq", "comments", null],
      ["2026-07-14", "groq", "tags", "llama"],
    ]);

    // post: two ok calls collapse; tokens summed via camelCase fields.
    const post = summary.find((r) => r.label === "post");
    expect(post).toEqual({
      day: "2026-07-15",
      gateway: "openrouter",
      label: "post",
      modelRequested: "primary",
      modelUsed: "primary",
      calls: 2,
      errors: 0,
      promptTokens: 300,
      completionTokens: 70,
      totalTokens: 370,
    });

    // comments with a model_used value: one error call, tokens preserved.
    const commentsWithModel = summary.find((r) => r.label === "comments" && r.modelUsed === "llama");
    expect(commentsWithModel).toEqual({
      day: "2026-07-15",
      gateway: "groq",
      label: "comments",
      modelRequested: "llama",
      modelUsed: "llama",
      calls: 1,
      errors: 1,
      promptTokens: 300,
      completionTokens: 100,
      totalTokens: 400,
    });

    // comments with NULL model_used (transport error before response): tokens COALESCE to 0.
    const commentsNullModel = summary.find((r) => r.label === "comments" && r.modelUsed === null);
    expect(commentsNullModel).toEqual({
      day: "2026-07-15",
      gateway: "groq",
      label: "comments",
      modelRequested: "llama",
      modelUsed: null,
      calls: 1,
      errors: 1,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });
});
