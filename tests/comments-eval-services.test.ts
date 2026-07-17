import { describe, expect, test } from "bun:test";

import { parseEnv } from "../config/env.ts";
import {
  makeCommentsEvaluationServices,
  type CommentsJudgeInvocation,
} from "../eval/comments-services.ts";

import type { CommentsInsights, NormalizedComment } from "../config/schemas.ts";
import { createUsageCollector } from "../utils/llm-usage.ts";
import type { CommentsGenerationInput, CommentsJudgeVerdict } from "../eval/score-comments.ts";
import type { Services } from "../pipeline/summarize.ts";

const TEST_ISO = "2026-07-15T00:00:00.000Z";

function comment(id: number, text: string): NormalizedComment {
  return { id, by: `user-${id}`, parent: 1, depth: 1, timeISO: TEST_ISO, textPlain: text };
}

function evaluationInput(comments: NormalizedComment[]): CommentsGenerationInput {
  const serializedComments = comments.map((item) => `[comment id=${item.id}] ${item.textPlain}`).join("\n");
  return {
    fixture: {
      story: { id: 1, title: "Adapter story" },
      postTldr: "Article context for the structured candidate.",
      comments: [...comments, comment(999, "This fixture comment is intentionally outside the canonical subset.")],
    },
    canonicalThread: {
      text: `[story id=1]\ncomments:\n${serializedComments}\nCANONICAL_TAIL`,
      comments,
      includedCommentIds: comments.map((item) => item.id),
      truncated: true,
      maxChars: 1000,
    },
    repeat: 0,
    seed: 42,
  };
}

function verdict(overrides: Partial<CommentsJudgeVerdict> = {}): CommentsJudgeVerdict {
  return {
    viewpoint_coverage: 5,
    faithfulness: 5,
    language_purity: 5,
    format_adherence: 5,
    overall: 5,
    is_refusal: false,
    reasons: [],
    ...overrides,
  };
}

const STRUCTURED_INSIGHTS: CommentsInsights = {
  bottom_line: "The thread adds a sufficiently detailed and testable implementation approach with caveats.",
  insights: [
    {
      kind: "consensus",
      text: "Commenters agree on a sufficiently detailed and testable implementation approach.",
    },
  ],
  best_quote: null,
};

function testEnvironment() {
  return parseEnv({
    SUMMARY_LANG: "en",
    OPENROUTER_API_KEY: "candidate-key",
    OPENROUTER_MODEL: "requested-model",
    JUDGE_API_KEY: "judge-key",
    JUDGE_MODEL: "judge-model",
    JUDGE_MAX_TOKENS: "900",
    COMMENTS_LLM_REQUEST_TIMEOUT_MS: "7000",
  });
}

function inertServices(): Services {
  return { marker: "offline", usage: createUsageCollector() } as unknown as Services;
}

describe("comments evaluation production adapter", () => {
  test("feeds the same canonical comment subset to v1 and v2 and records resolved metadata", async () => {
    const legacyIds: number[][] = [];
    const structuredIds: number[][] = [];
    let structuredStory: { id: number; title: string } | undefined;
    let structuredPostSummary: string | undefined;
    let clock = 0;
    const services = makeCommentsEvaluationServices(testEnvironment(), {
      candidateServices: inertServices(),
      now: () => {
        clock += 5;
        return clock;
      },
      judgeInvoker: async () => ({ A: verdict(), B: verdict() }),
      pipeline: {
        makeServices: () => inertServices(),
        buildCommentsPrompt: async (comments) => {
          legacyIds.push(comments.map((item) => item.id));
          return { prompt: "legacy prompt", sampleIds: comments.map((item) => item.id) };
        },
        generateValidatedCommentsSummary: async (_services, storyId, _prompt, sampleIds) => ({
          id: storyId,
          lang: "en",
          summary: "Legacy candidate summary with complete discussion context.",
          sampleComments: sampleIds,
          model: "resolved-legacy-model",
        }),
        generateValidatedCommentsSummaryV2: async (_services, input) => {
          structuredIds.push(input.comments.map((item) => item.id));
          structuredStory = input.story;
          structuredPostSummary = input.postSummary?.summary;
          return {
            insights: STRUCTURED_INSIGHTS,
            modelUsed: "resolved-structured-model",
            prompt: "structured prompt",
            sampleIds: input.comments.map((item) => item.id),
            summary: "Structured candidate summary with complete discussion context.",
          };
        },
      },
    });
    const canonicalComments = [comment(101, "First canonical comment."), comment(102, "Second canonical comment.")];
    const input = evaluationInput(canonicalComments);

    const v1 = await services.generateV1(input);
    const v2 = await services.generateV2(input);

    expect(legacyIds).toEqual([[101, 102]]);
    expect(structuredIds).toEqual([[101, 102]]);
    expect(structuredStory).toEqual({ id: 1, title: "Adapter story" });
    expect(structuredPostSummary).toBe("Article context for the structured candidate.");
    expect(v1.metadata).toEqual({
      requestedModel: "requested-model",
      resolvedModel: "resolved-legacy-model",
      provider: "openrouter",
      policyVersion: "1",
      promptVersion: "comments-legacy-v1",
    });
    expect(v2.metadata).toEqual({
      requestedModel: "requested-model",
      resolvedModel: "resolved-structured-model",
      provider: "openrouter",
      policyVersion: "4",
      promptVersion: "comments-structured-v2",
    });
    expect(v1.validationPassed).toBeTrue();
    expect(v2.validationPassed).toBeTrue();
    expect(v2.structured).toEqual(STRUCTURED_INSIGHTS);
    expect(v1.latencyMs).toBe(5);
    expect(v2.latencyMs).toBe(5);
  });

  test("judge receives the full canonical tail and anonymous A/B payload in one bounded structured call", async () => {
    let captured: CommentsJudgeInvocation | undefined;
    const services = makeCommentsEvaluationServices(testEnvironment(), {
      candidateServices: inertServices(),
      judgeInvoker: async (invocation) => {
        captured = invocation;
        return { A: verdict({ overall: 4 }), B: verdict({ overall: 5 }) };
      },
    });
    const result = await services.judge?.({
      storyId: 1,
      repeat: 0,
      canonicalThread: "CANONICAL_HEAD\nfull content\nCANONICAL_TAIL",
      candidates: [
        { slot: "A", summary: "First anonymous summary." },
        { slot: "B", summary: "Second anonymous summary." },
      ],
    });

    expect(result).toEqual({ A: verdict({ overall: 4 }), B: verdict({ overall: 5 }) });
    if (captured === undefined) {
      throw new Error("Judge invocation was not captured");
    }
    const prompt = captured.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("CANONICAL_TAIL");
    expect(prompt).toContain("Anonymous candidate A");
    expect(prompt).toContain("Anonymous candidate B");
    expect(prompt).not.toContain("candidate v1");
    expect(prompt).not.toContain("candidate v2");
    expect(captured.maxRetries).toBe(1);
    expect(captured.options.transportRetries).toBe(0);
    expect(captured.options.requestTimeoutMs).toBe(7000);
    expect(captured.options.model).toBe("judge-model");
  });

  test("candidate failures stay offline and return metadata-bearing failed outputs", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCalls++;
      throw new Error("network must not be called");
    }) as typeof globalThis.fetch;

    try {
      const services = makeCommentsEvaluationServices(testEnvironment(), {
        candidateServices: inertServices(),
        judgeInvoker: async () => ({ A: verdict(), B: verdict() }),
        pipeline: {
          makeServices: () => inertServices(),
          buildCommentsPrompt: async () => {
            throw new Error("legacy generation failed");
          },
          generateValidatedCommentsSummary: async () => {
            throw new Error("unexpected legacy call");
          },
          generateValidatedCommentsSummaryV2: async () =>
            await new Promise<undefined>((resolve) => {
              resolve(new Map<string, never>().get("missing"));
            }),
        },
      });
      const input = evaluationInput([comment(101, "Canonical comment.")]);
      const [v1, v2] = await Promise.all([services.generateV1(input), services.generateV2(input)]);

      expect(v1.validationPassed).toBeFalse();
      expect(v1.error).toBe("legacy generation failed");
      expect(v1.metadata.promptVersion).toBe("comments-legacy-v1");
      expect(v2.validationPassed).toBeFalse();
      expect(v2.error).toBe("comments-v2 generation returned no validated result");
      expect(v2.metadata.promptVersion).toBe("comments-structured-v2");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
