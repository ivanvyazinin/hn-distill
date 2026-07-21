import { describe, expect, mock, test } from "bun:test";

import {
  runSummaryGuard,
  SummaryGuardSchema,
  SummaryGuardStrictJsonSchema,
} from "../utils/summary-guard.ts";

import type { OpenRouter } from "@utils/openrouter";

const ENV_LIKE = {
  POST_GUARD_ARTICLE_MAX_CHARS: 2000,
  POST_GUARD_MAX_TOKENS: 256,
  POST_GUARD_MIN_CONFIDENCE: 0.6,
  POST_GUARD_MODEL: "openai/gpt-oss-20b",
  SUMMARY_LANG: "en" as const,
};

const VALID_GUARD = {
  ok: true,
  is_article: true,
  refusal: false,
  verdict: "ok" as const,
  reasons: [] as string[],
  confidence: 0.95,
};

describe("SummaryGuardSchema", () => {
  test("rejects object without confidence", () => {
    const parsed = SummaryGuardSchema.safeParse({
      ok: true,
      is_article: true,
      refusal: false,
      verdict: "ok",
      reasons: [],
    });

    expect(parsed.success).toBeFalse();
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes("confidence"))).toBeTrue();
    }
  });

  test("accepts a complete valid object", () => {
    const parsed = SummaryGuardSchema.safeParse(VALID_GUARD);
    expect(parsed.success).toBeTrue();
  });
});

describe("runSummaryGuard", () => {
  test("sends strict schema with six required fields", async () => {
    let capturedSchema: unknown;
    const openrouter = {
      chatStructured: mock(async (_messages, options) => {
        capturedSchema = options.responseFormat?.json_schema?.schema;
        return VALID_GUARD;
      }),
    } as unknown as OpenRouter;

    await runSummaryGuard(openrouter, {
      summary: "A detailed summary of the article content with enough substance.",
      articleSlice: "Article body about distributed systems and recovery.",
      envLike: ENV_LIKE,
    });

    expect(capturedSchema).toEqual(SummaryGuardStrictJsonSchema);
    expect(SummaryGuardStrictJsonSchema.required).toEqual([
      "ok",
      "is_article",
      "refusal",
      "verdict",
      "reasons",
      "confidence",
    ]);
    expect(openrouter.chatStructured).toHaveBeenCalledTimes(1);
  });

  test("system prompt lists every key, allowed verdicts, and confidence rule", async () => {
    let systemPrompt = "";
    const openrouter = {
      chatStructured: mock(async (messages) => {
        systemPrompt = messages[0]?.content ?? "";
        return VALID_GUARD;
      }),
    } as unknown as OpenRouter;

    await runSummaryGuard(openrouter, {
      summary: "A detailed summary of the article content with enough substance.",
      articleSlice: "Article body about distributed systems and recovery.",
      envLike: ENV_LIKE,
    });

    expect(systemPrompt).toContain('"ok"');
    expect(systemPrompt).toContain('"is_article"');
    expect(systemPrompt).toContain('"refusal"');
    expect(systemPrompt).toContain('"verdict"');
    expect(systemPrompt).toContain('"reasons"');
    expect(systemPrompt).toContain('"confidence"');
    expect(systemPrompt).toContain("nonsense, not_article, ok, other, refusal, too_generic, too_short");
    expect(systemPrompt).toContain('"confidence" is a number from 0 to 1; never omit it.');
    expect(systemPrompt).toContain("always include every key");
  });

  test("valid response with empty reasons yields ok", async () => {
    const openrouter = {
      chatStructured: mock(async () => VALID_GUARD),
    } as unknown as OpenRouter;

    const result = await runSummaryGuard(openrouter, {
      summary: "A detailed summary of the article content with enough substance.",
      articleSlice: "Article body about distributed systems and recovery.",
      envLike: ENV_LIKE,
    });

    expect(result.ok).toBeTrue();
    expect(result.verdict).toBe("ok");
    expect(result.reasons).toEqual([]);
    expect(result.confidence).toBe(0.95);
  });

  test("caps model reasons to two before returning", async () => {
    const openrouter = {
      chatStructured: mock(async () => ({
        ok: false,
        is_article: true,
        refusal: false,
        verdict: "too_generic" as const,
        reasons: ["too vague", "no specifics", "extra reason"],
        confidence: 0.9,
      })),
    } as unknown as OpenRouter;

    const result = await runSummaryGuard(openrouter, {
      summary: "Short blurb.",
      articleSlice: "Article body.",
      envLike: ENV_LIKE,
    });

    expect(result.ok).toBeFalse();
    expect(result.reasons).toEqual(["too vague", "no specifics"]);
  });

  test("keeps the not_article reason within the two-reason cap", async () => {
    const openrouter = {
      chatStructured: mock(async () => ({
        ok: false,
        is_article: false,
        refusal: false,
        verdict: "other" as const,
        reasons: ["too vague", "no specifics"],
        confidence: 0.9,
      })),
    } as unknown as OpenRouter;

    const result = await runSummaryGuard(openrouter, {
      summary: "Short blurb.",
      articleSlice: "Article body.",
      envLike: ENV_LIKE,
    });

    expect(result.ok).toBeFalse();
    expect(result.verdict).toBe("not_article");
    expect(result.reasons).toEqual(["not_article", "too vague"]);
  });
});
