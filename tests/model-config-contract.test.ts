import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseEnv } from "@config/env";

const ROOT = join(import.meta.dir, "..");

describe("model config contract", () => {
  test("schema defaults match the selected comments routes", () => {
    // Empty source → pure schema defaults (ignore developer .env / process.env overrides).
    const defaults = parseEnv({});
    expect(defaults.TAGS_MODEL).toBe("openai/gpt-oss-20b");
    expect(defaults.POST_GUARD_MODEL).toBe("openai/gpt-oss-20b");
    expect(defaults.POST_GUARD_FALLBACK_MODEL).toBe("");
    expect(defaults.COMMENTS_MODEL).toBe("openai/gpt-oss-120b");
    expect(defaults.COMMENTS_FALLBACK_MODEL).toBe("openai/gpt-oss-20b");
    expect(defaults.COMMENTS_FALLBACK_MODEL_2).toBe("");
    expect(defaults.COMMENTS_OPENROUTER_FALLBACK_MODEL).toBe("qwen/qwen3-next-80b-a3b-instruct");
    expect(defaults.OPENROUTER_MODEL).toBe("nvidia/nemotron-3-super-120b-a12b:free");
    expect(defaults.OPENROUTER_FALLBACK_MODEL).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(defaults.OPENROUTER_FALLBACK_MODEL_2).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(defaults.COMMENTS_COMPRESS_MODEL).toBe("minimax/minimax-m3:free");
    expect(defaults.COMMENTS_COMPRESS_FALLBACK_MODEL).toBe("qwen/qwen3-next-80b-a3b-instruct");
    expect(defaults.COMMENTS_COMPRESS_REPAIR_SCAN).toBe(10);
    expect(defaults.COMMENTS_COMPRESS_REPAIR_MAX_STORIES).toBe(3);
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
      "COMMENTS_COMPRESS_MODEL:",
      "COMMENTS_COMPRESS_FALLBACK_MODEL:",
    ];
    for (const key of forbidden) {
      expect(workflow.includes(key)).toBeFalse();
    }
    // Provider credentials remain; model IDs stay in config defaults.
    expect(workflow).toContain("OPENROUTER_API_KEY:");
    expect(workflow).toContain("GROQ_API_KEY:");
  });
});
