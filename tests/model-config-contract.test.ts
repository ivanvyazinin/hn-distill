import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseEnv } from "@config/env";

const ROOT = join(import.meta.dir, "..");

describe("model config contract", () => {
  test("schema defaults match the 2026-08-21 selected availability routes", () => {
    // Empty source → pure schema defaults (ignore developer .env / process.env overrides).
    const defaults = parseEnv({});
    expect(defaults.TAGS_MODEL).toBe("openai/gpt-oss-20b");
    expect(defaults.POST_GUARD_MODEL).toBe("openai/gpt-oss-20b");
    expect(defaults.POST_GUARD_FALLBACK_MODEL).toBe("");
    // Repointed 2026-08-21: Groq shut down both llama ids on 2026-08-16 (404
    // model_not_found); probe in docs/probe-groq-comments-models-2026-08-21.md.
    expect(defaults.COMMENTS_MODEL).toBe("openai/gpt-oss-120b");
    expect(defaults.COMMENTS_FALLBACK_MODEL).toBe("openai/gpt-oss-20b");
    expect(defaults.COMMENTS_FALLBACK_MODEL_2).toBe("");
    expect(defaults.COMMENTS_OPENROUTER_FALLBACK_MODEL).toBe("qwen/qwen3-next-80b-a3b-instruct");
    expect(defaults.OPENROUTER_MODEL).toBe("nvidia/nemotron-3-nano-30b-a3b:free");
    // Repointed 2026-08-02: both ":free" slugs now answer 404 "unavailable for free",
    // which left the post chain with no working fallback at all.
    expect(defaults.OPENROUTER_FALLBACK_MODEL).toBe("qwen/qwen3-next-80b-a3b-instruct");
    expect(defaults.OPENROUTER_FALLBACK_MODEL_2).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(defaults.SUMMARY_CONTENT_REJECT_MODEL).toBe("qwen/qwen3-next-80b-a3b-instruct");
  });

  test("hourly-build workflow does not set model env overrides", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/hourly-build.yml"), "utf8");
    const forbidden = [
      "OPENROUTER_MODEL:",
      "OPENROUTER_FALLBACK_MODEL:",
      "OPENROUTER_FALLBACK_MODEL_2:",
      "COMMENTS_MODEL:",
      "COMMENTS_FALLBACK_MODEL:",
      "COMMENTS_FALLBACK_MODEL_2:",
      "COMMENTS_OPENROUTER_FALLBACK_MODEL:",
      "TAGS_MODEL:",
      "POST_GUARD_MODEL:",
      "POST_GUARD_FALLBACK_MODEL:",
      "SUMMARY_CONTENT_REJECT_MODEL:",
    ];
    for (const key of forbidden) {
      expect(workflow.includes(key)).toBeFalse();
    }
    // Secrets stay — only model IDs are banned from the workflow surface.
    expect(workflow).toContain("OPENROUTER_API_KEY:");
    expect(workflow).toContain("GROQ_API_KEY:");
  });
});
