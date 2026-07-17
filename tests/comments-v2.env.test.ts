import { describe, expect, test } from "bun:test";

import { COMMENTS_POLICY_VERSION, parseEnv } from "../config/env.ts";

describe("comments-v2 environment", () => {
  test("uses bounded defaults compatible with the worker task budget", () => {
    const parsed = parseEnv({});
    expect(COMMENTS_POLICY_VERSION).toBe("4");
    expect(parsed.COMMENTS_SUMMARY_MIN_CHARS).toBe(200);
    expect(parsed.COMMENTS_MIN_CYRILLIC_RATIO).toBe(0.65);
    expect(parsed.COMMENTS_PROMPT_MAX_CHARS).toBe(24_000);
    expect(parsed.COMMENTS_SUMMARY_MAX_TOKENS).toBe(2500);
    expect(parsed.COMMENTS_COMPRESS_MODEL).toBe("qwen/qwen3-next-80b-a3b-instruct");
    expect(parsed.COMMENTS_COMPRESS_MAX_TOKENS).toBe(1000);
    expect(parsed.COMMENTS_MAX_LLM_CALLS).toBe(3);
    expect(parsed.COMMENTS_LLM_REQUEST_TIMEOUT_MS).toBe(7000);
    expect(parsed.COMMENTS_MAX_LLM_CALLS * parsed.COMMENTS_LLM_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(
      parsed.WORKER_QUEUE_TASK_TIMEOUT_MS - 2000
    );
    expect(parsed.COMMENTS_JUDGE_THREAD_MAX_CHARS).toBeGreaterThanOrEqual(parsed.COMMENTS_PROMPT_MAX_CHARS);
  });

  test("coerces explicit comments-v2 settings", () => {
    const parsed = parseEnv({
      COMMENTS_SUMMARY_MIN_CHARS: "240",
      COMMENTS_MIN_CYRILLIC_RATIO: "0.7",
      COMMENTS_PROMPT_MAX_CHARS: "30000",
      COMMENTS_SUMMARY_MAX_TOKENS: "1400",
      COMMENTS_COMPRESS_MODEL: "",
      COMMENTS_COMPRESS_MAX_TOKENS: "800",
      COMMENTS_MAX_LLM_CALLS: "2",
      COMMENTS_LLM_REQUEST_TIMEOUT_MS: "9000",
      COMMENTS_JUDGE_THREAD_MAX_CHARS: "32000",
    });
    expect(parsed.COMMENTS_SUMMARY_MIN_CHARS).toBe(240);
    expect(parsed.COMMENTS_MIN_CYRILLIC_RATIO).toBe(0.7);
    expect(parsed.COMMENTS_PROMPT_MAX_CHARS).toBe(30_000);
    expect(parsed.COMMENTS_SUMMARY_MAX_TOKENS).toBe(1400);
    expect(parsed.COMMENTS_COMPRESS_MODEL).toBe("");
    expect(parsed.COMMENTS_COMPRESS_MAX_TOKENS).toBe(800);
    expect(parsed.COMMENTS_MAX_LLM_CALLS).toBe(2);
    expect(parsed.COMMENTS_LLM_REQUEST_TIMEOUT_MS).toBe(9000);
    expect(parsed.COMMENTS_JUDGE_THREAD_MAX_CHARS).toBe(32_000);
  });

  test("rejects a judge context smaller than the candidate context", () => {
    expect(() =>
      parseEnv({
        COMMENTS_PROMPT_MAX_CHARS: "30000",
        COMMENTS_JUDGE_THREAD_MAX_CHARS: "29999",
      })
    ).toThrow("must be greater than or equal to COMMENTS_PROMPT_MAX_CHARS");
  });
});
