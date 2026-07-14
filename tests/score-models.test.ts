import { describe, expect, test } from "bun:test";

import { env } from "@config/env";
import type { HttpClient } from "@utils/http-client";
import { OpenRouter } from "@utils/openrouter";

import { selectCandidates } from "../eval/models-under-test";
import {
  aggregate,
  JudgeVerdictSchema,
  renderLeaderboardMarkdown,
  runQualityJudge,
  scoreOneRun,
  summarizeTwoStepEnRu,
  summarizeWithModel,
  type ScoredRunRecord,
} from "../eval/score-models";

describe("aggregate", () => {
  test("computes pass rate, composite rank, and percentiles", () => {
    const runs: ScoredRunRecord[] = [
      {
        model: "m/a",
        articleId: 1,
        repeat: 0,
        latencyMs: 100,
        outputChars: 200,
        heuristic: { ok: true, triggers: [] },
        judge: {
          accuracy: 4,
          completeness: 4,
          faithfulness: 5,
          format_adherence: 4,
          language_purity: 5,
          overall: 4,
          is_refusal: false,
          reasons: [],
        },
      },
      {
        model: "m/a",
        articleId: 2,
        repeat: 0,
        latencyMs: 300,
        outputChars: 180,
        heuristic: { ok: false, triggers: [{ reason: "too_short" }] },
        judgeSkipped: true,
      },
      {
        model: "m/b",
        articleId: 1,
        repeat: 0,
        latencyMs: 50,
        outputChars: 0,
        error: "OpenRouter: empty content",
        heuristic: { ok: false, triggers: [{ reason: "empty" }] },
        judgeSkipped: true,
      },
    ];

    const scores = aggregate(runs);
    expect(scores[0]?.model).toBe("m/a");
    expect(Math.abs((scores[0]?.heuristic_pass_rate ?? 0) - 0.5)).toBeLessThan(0.001);
    expect(Math.abs((scores[0]?.mean_overall ?? 0) - 4)).toBeLessThan(0.001);
    expect(Math.abs((scores[0]?.composite_rank ?? 0) - 2)).toBeLessThan(0.001);
    expect(scores[0]?.p50_latency_ms).toBe(100);
    expect(Math.abs((scores[0]?.mean_language_purity ?? 0) - 5)).toBeLessThan(0.001);
    expect(scores[1]?.error_rate).toBe(1);
    expect(scores[1]?.failure_histogram["candidate_error"]).toBe(1);
  });
});

describe("runQualityJudge", () => {
  test("parses rubric from structured response", async () => {
    const payload = {
      accuracy: 5,
      completeness: 4,
      faithfulness: 5,
      format_adherence: 4,
      language_purity: 5,
      overall: 4.5,
      is_refusal: false,
      reasons: ["solid"],
    };
    const http = {
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
    } as unknown as HttpClient;
    const client = new OpenRouter(http, "key", "judge-model");
    const verdict = await runQualityJudge(client, {
      articleSlice: "Article body here.",
      summary: "A good summary.",
      language: "en",
      envLike: {
        JUDGE_MAX_TOKENS: 700,
        JUDGE_MODEL: "judge-model",
        JUDGE_ARTICLE_MAX_CHARS: 6000,
      },
    });
    const parsed = JudgeVerdictSchema.parse(verdict);
    expect(parsed.overall).toBe(4.5);
    expect(parsed.language_purity).toBe(5);
  });
});

describe("scoreOneRun", () => {
  test("skips judge on empty candidate output", async () => {
    const failingHttp = {
      json: async () => {
        throw new Error("rate limited");
      },
    } as unknown as HttpClient;
    const candidateClient = new OpenRouter(failingHttp, "key", "bad-model");
    const judgeClient = new OpenRouter(failingHttp, "k", env.JUDGE_MODEL);

    const { record } = await scoreOneRun({
      candidateClient,
      judgeClient,
      model: "bad-model",
      article: { id: 1, title: "t", url: "u", articleSlice: "slice" },
      repeat: 0,
      envLike: env,
    });

    expect(record.error).toBe("rate limited");
    expect(record.judgeSkipped).toBe(true);
    expect(record.judge).toBeUndefined();
  });
});

describe("summarizeWithModel", () => {
  test("records error instead of throwing", async () => {
    const http = {
      json: async () => {
        throw new Error("boom");
      },
    } as unknown as HttpClient;
    const client = new OpenRouter(http, "key", "m/test");
    const out = await summarizeWithModel(client, "article", "m/test", env);
    expect(out.content).toBe("");
    expect(out.error).toBe("boom");
  });
});

describe("renderLeaderboardMarkdown", () => {
  test("renders ranked table", () => {
    const md = renderLeaderboardMarkdown(
      [
        {
          model: "a",
          n: 1,
          heuristic_pass_rate: 1,
          refusal_rate: 0,
          failure_histogram: {},
          mean_overall: 4,
          mean_accuracy: 4,
          mean_completeness: 4,
          mean_faithfulness: 4,
          mean_format_adherence: 4,
          mean_language_purity: 5,
          error_rate: 0,
          p50_latency_ms: 10,
          p95_latency_ms: 10,
          mean_output_chars: 100,
          composite_rank: 4,
        },
      ],
      { generatedAt: "2026-01-01", runCount: 1 }
    );
    expect(md).toContain("composite");
    expect(md).toContain("`a`");
    expect(md).toContain("Lang purity");
  });
});

describe("en-then-ru pipeline", () => {
  test("summarizeTwoStepEnRu chains EN summary into RU translation and throttles each call", async () => {
    const prompts: string[] = [];
    let beforeCalls = 0;
    const http = {
      json: async (_url: string, init: { body?: string }) => {
        const body = JSON.parse(init.body ?? "{}") as { messages: Array<{ role: string; content: string }> };
        prompts.push(body.messages.map((m) => m.content).join("\n---\n"));
        const content = prompts.length === 1 ? "English summary." : "Русский перевод.";
        return { choices: [{ message: { content } }] };
      },
    } as unknown as HttpClient;
    const client = new OpenRouter(http, "key", "m/test");

    const out = await summarizeTwoStepEnRu(client, "article body", "m/test", env, async () => {
      beforeCalls += 1;
    });

    expect(out.error).toBeUndefined();
    expect(out.content).toBe("Русский перевод.");
    expect(beforeCalls).toBe(2);
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain("English summary.");
    expect(prompts[1]).toContain("переводчик");
  });

  test("scoreOneRun dispatches to the two-step pipeline", async () => {
    let calls = 0;
    const http = {
      json: async () => {
        calls += 1;
        return { choices: [{ message: { content: calls === 1 ? "English summary." : "Русский перевод." } }] };
      },
    } as unknown as HttpClient;
    const client = new OpenRouter(http, "key", "m/test");

    const { record } = await scoreOneRun({
      candidateClient: client,
      judgeClient: client,
      model: "m/test",
      label: "m/test@en-ru",
      pipeline: "en-then-ru",
      article: { id: 1, title: "t", url: "u", articleSlice: "slice" },
      repeat: 0,
      envLike: env,
      stubJudge: true,
    });

    expect(calls).toBe(2);
    expect(record.model).toBe("m/test@en-ru");
    expect(record.outputChars).toBeGreaterThan(0);
  });

  test("selectCandidates parses the @en-ru suffix", () => {
    const [direct, twoStep] = selectCandidates([
      "qwen/qwen3-next-80b-a3b-instruct:free",
      "qwen/qwen3-next-80b-a3b-instruct:free@en-ru",
    ]);
    expect(direct?.pipeline).toBeUndefined();
    expect(direct?.label).toBe("qwen/qwen3-next-80b-a3b-instruct:free");
    expect(twoStep?.pipeline).toBe("en-then-ru");
    expect(twoStep?.label).toBe("qwen/qwen3-next-80b-a3b-instruct:free@en-ru");
    expect(twoStep?.model).toBe("qwen/qwen3-next-80b-a3b-instruct:free");
  });
});
