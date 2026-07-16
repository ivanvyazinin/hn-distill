import { describe, expect, test } from "bun:test";

import { Miniflare } from "miniflare";

import { getLlmUsageSummary, insertLlmUsage } from "../worker/src/d1.ts";

import type { LlmUsageRow } from "../utils/meta-store.ts";

const MINIFLARE_SCRIPT = "export default { fetch() { return new Response('ok'); } };";

async function initUsageDb(db: Awaited<ReturnType<Miniflare["getD1Database"]>>): Promise<void> {
  await db
    .prepare(
      "CREATE TABLE llm_usage (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, story_id INTEGER, " +
        "label TEXT NOT NULL, gateway TEXT NOT NULL, model_requested TEXT NOT NULL, model_used TEXT, " +
        "attempt INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER, status TEXT NOT NULL)"
    )
    .run();
}

const ROWS: LlmUsageRow[] = [
  { createdAt: "2026-07-15T10:00:00.000Z", storyId: 1, label: "post", gateway: "openrouter", modelRequested: "primary", modelUsed: "primary", promptTokens: 100, completionTokens: 50, totalTokens: 150, status: "ok" },
  { createdAt: "2026-07-15T10:05:00.000Z", storyId: 1, label: "post", gateway: "openrouter", modelRequested: "primary", modelUsed: "primary", promptTokens: 200, completionTokens: 20, totalTokens: 220, status: "ok" },
  { createdAt: "2026-07-15T11:00:00.000Z", storyId: 2, label: "comments", gateway: "groq", modelRequested: "llama", modelUsed: "llama", attempt: 1, promptTokens: 300, completionTokens: 100, totalTokens: 400, status: "error" },
  { createdAt: "2026-07-15T11:01:00.000Z", storyId: 2, label: "comments", gateway: "groq", modelRequested: "llama", status: "error" },
];

describe("D1 llm_usage helpers", () => {
  test("insert (batched) round-trips and getLlmUsageSummary aggregates with NULL model + errors", async () => {
    const mf = new Miniflare({ modules: true, script: MINIFLARE_SCRIPT, d1Databases: ["DB"] });
    try {
      const db = await mf.getD1Database("DB");
      await initUsageDb(db);

      // Empty batch is a no-op.
      await insertLlmUsage(db, []);
      await insertLlmUsage(db, ROWS);

      const summary = await getLlmUsageSummary(db);

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
    } finally {
      await mf.dispose();
    }
  });
});
