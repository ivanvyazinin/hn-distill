import { describe, expect, test } from "bun:test";

import {
  CommentsJudgeVerdictSchema,
  computeQuoteMetric,
  evaluateCommentsGate,
  renderCommentsEvaluationMarkdown,
  runCommentsEvaluation,
  serializeCanonicalCommentsThread,
  type CommentsBenchFixture,
  type CommentsCandidateOutput,
  type CommentsEvaluationRecord,
  type CommentsEvaluationServices,
  type CommentsJudgeVerdict,
  type CommentsVariant,
} from "../eval/score-comments.ts";

const TEST_ISO = "2026-07-14T12:00:00.000Z";
const DEFAULT_STORY_ID = 1;

function fixture(storyId: number = DEFAULT_STORY_ID): CommentsBenchFixture {
  return {
    story: { id: storyId, title: `Story ${storyId}`, url: `https://example.test/${storyId}` },
    postTldr: "A canonical article summary.",
    comments: [
      {
        id: storyId * 100 + 1,
        by: "alice",
        parent: storyId,
        depth: 1,
        timeISO: TEST_ISO,
        textPlain: "The first comment contains an exact source quotation for deterministic scoring.",
      },
      {
        id: storyId * 100 + 2,
        by: "bob",
        parent: storyId * 100 + 1,
        depth: 2,
        timeISO: TEST_ISO,
        textPlain: "The second comment disagrees and adds enough detail to test canonical truncation.",
      },
    ],
    cohort: "quality",
  };
}

function metadata(variant: CommentsVariant) {
  return {
    requestedModel: "provider/requested",
    resolvedModel: `provider/resolved-${variant}`,
    provider: "test-provider",
    policyVersion: variant,
    promptVersion: `comments-${variant}`,
  };
}

function candidate(variant: CommentsVariant, inputFixture: CommentsBenchFixture): CommentsCandidateOutput {
  const firstComment = inputFixture.comments[0];
  return {
    summary: `${variant} candidate summary with enough deterministic content.`,
    validationPassed: true,
    latencyMs: variant === "v1" ? 10 : 20,
    metadata: metadata(variant),
    ...(variant === "v2" && firstComment !== undefined
      ? {
          structured: {
            consensus: ["A sufficiently detailed consensus item for the structured candidate."],
            disputes: [],
            practical_advice: [],
            best_quote: {
              comment_id: firstComment.id,
              source_text: "exact source quotation",
              translation: "точная исходная цитата для проверки",
            },
          },
        }
      : {}),
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

function scoreCandidateSummary(summary: string): CommentsJudgeVerdict {
  return summary.startsWith("v2") ? verdict({ overall: 5 }) : verdict({ overall: 4 });
}

function record(
  storyId: number,
  variant: CommentsVariant,
  judge: CommentsJudgeVerdict,
  overrides: Partial<CommentsEvaluationRecord> = {}
): CommentsEvaluationRecord {
  return {
    storyId,
    cohort: "quality",
    repeat: 0,
    variant,
    blindSlot: variant === "v1" ? "A" : "B",
    canonicalThreadChars: 100,
    canonicalThreadTruncated: false,
    summary: `${variant} summary`,
    validationPassed: true,
    latencyMs: 10,
    quote: variant === "v2" ? { emitted: true, accurate: true, commentId: storyId * 100 + 1 } : { emitted: false },
    candidateMetadata: metadata(variant),
    judge,
    missingResult: false,
    ...overrides,
  };
}

describe("comments scoring core", () => {
  test("judge schema enforces every rubric score in the 1..5 range", () => {
    expect(CommentsJudgeVerdictSchema.safeParse(verdict()).success).toBeTrue();
    expect(CommentsJudgeVerdictSchema.safeParse(verdict({ viewpoint_coverage: 0 })).success).toBeFalse();
    expect(CommentsJudgeVerdictSchema.safeParse(verdict({ language_purity: 6 })).success).toBeFalse();
  });

  test("canonical serialization is deterministic, bounded, and keeps whole comments", () => {
    const input = fixture();
    const full = serializeCanonicalCommentsThread(input, 10_000);
    const secondMarker = full.text.indexOf(`[comment id=${input.comments[1]?.id ?? 0}`);
    const limit = secondMarker - 2;
    const first = serializeCanonicalCommentsThread(input, limit);
    const second = serializeCanonicalCommentsThread(input, limit);

    expect(first).toEqual(second);
    expect(first.text.length).toBeLessThanOrEqual(limit);
    expect(first.comments.length).toBe(1);
    expect(first.includedCommentIds).toEqual([101]);
    expect(first.truncated).toBeTrue();
    expect(first.text.includes("second comment")).toBeFalse();
  });

  test("quote metrics require both the canonical comment id and a source substring", () => {
    const input = fixture();
    const canonical = serializeCanonicalCommentsThread(input, 10_000);
    const accurate = candidate("v2", input);
    const { structured } = accurate;
    if (structured?.best_quote === undefined || structured.best_quote === null) {
      throw new Error("Expected structured quote in test candidate");
    }
    const bestQuote = structured.best_quote;
    const wrongText: CommentsCandidateOutput = {
      ...accurate,
      structured: {
        ...structured,
        best_quote: {
          ...bestQuote,
          source_text: "a phrase absent from the source comment",
        },
      },
    };
    const wrongId: CommentsCandidateOutput = {
      ...accurate,
      structured: {
        ...structured,
        best_quote: { ...bestQuote, comment_id: 999_999 },
      },
    };

    expect(computeQuoteMetric(accurate, canonical)).toEqual({ emitted: true, accurate: true, commentId: 101 });
    expect(computeQuoteMetric(wrongText, canonical).accurate).toBeFalse();
    expect(computeQuoteMetric(wrongId, canonical).accurate).toBeFalse();
    expect(computeQuoteMetric(candidate("v1", input), canonical)).toEqual({ emitted: false });
  });

  test("evaluation injects generators and presents alternating anonymous pairs to the judge", async () => {
    const judgeInputs: Array<{ canonicalThread: string; slots: string[]; summaries: string[] }> = [];
    const services: CommentsEvaluationServices = {
      generateV1: async (input) => candidate("v1", input.fixture),
      generateV2: async (input) => candidate("v2", input.fixture),
      judge: async (input) => {
        judgeInputs.push({
          canonicalThread: input.canonicalThread,
          slots: input.candidates.map((entry) => entry.slot),
          summaries: input.candidates.map((entry) => entry.summary),
        });
        return {
          A: scoreCandidateSummary(input.candidates[0].summary),
          B: scoreCandidateSummary(input.candidates[1].summary),
        };
      },
    };

    const result = await runCommentsEvaluation([fixture()], services, {
      repeats: 2,
      seed: 17,
      threadMaxChars: 10_000,
      qualityIds: [1],
    });

    expect(result.records.length).toBe(4);
    expect(judgeInputs.length).toBe(2);
    expect(judgeInputs[0]?.slots).toEqual(["A", "B"]);
    expect(judgeInputs[0]?.summaries).not.toEqual(judgeInputs[1]?.summaries);
    expect(judgeInputs.every((input) => input.canonicalThread === judgeInputs[0]?.canonicalThread)).toBeTrue();
    expect(result.records.filter((entry) => entry.variant === "v2").every((entry) => entry.judge?.overall === 5)).toBeTrue();
    expect(result.records[0]?.candidateMetadata).toEqual(metadata("v1"));
    expect(result.records.filter((entry) => entry.variant === "v2").every((entry) => entry.quote.accurate === true)).toBeTrue();
  });

  test("stub judge performs no judge callback and generation failures become missing records", async () => {
    let judgeCalls = 0;
    const services: CommentsEvaluationServices = {
      generateV1: async (input) => candidate("v1", input.fixture),
      generateV2: async () => {
        throw new Error("candidate budget exhausted");
      },
      judge: async () => {
        judgeCalls++;
        return { A: verdict(), B: verdict() };
      },
    };
    const result = await runCommentsEvaluation([fixture()], services, {
      repeats: 1,
      seed: 1,
      threadMaxChars: 10_000,
      stubJudge: true,
    });

    expect(judgeCalls).toBe(0);
    expect(result.records.every((entry) => entry.missingResult)).toBeTrue();
    expect(result.records.find((entry) => entry.variant === "v2")?.candidateError).toBe("candidate budget exhausted");
  });

  test("gate applies paired delta, deterministic bootstrap, and every rollout threshold", () => {
    const records: CommentsEvaluationRecord[] = [];
    for (let storyId = 1; storyId <= 20; storyId++) {
      records.push(record(storyId, "v1", verdict({ overall: 4, faithfulness: 4.5 })));
      records.push(record(storyId, "v2", verdict({ overall: 4.5, faithfulness: 4.5 })));
    }

    const first = evaluateCommentsGate(records, { seed: 42, bootstrapIterations: 1000 });
    const second = evaluateCommentsGate(records, { seed: 42, bootstrapIterations: 1000 });
    expect(first.passed).toBeTrue();
    expect(first.metrics.meanOverallDelta).toBe(0.5);
    expect(first.metrics.bootstrap95Lower).toBe(0.5);
    expect(first.metrics.quoteAccuracyOnEmittedV2).toBe(1);
    expect(first.metrics).toEqual(second.metrics);

    const broken = records.map((entry) => ({ ...entry, quote: { ...entry.quote } }));
    const brokenV2 = broken.find((entry) => entry.storyId === 1 && entry.variant === "v2");
    if (brokenV2 === undefined) {
      throw new Error("Missing test record");
    }
    brokenV2.validationPassed = false;
    brokenV2.missingResult = true;
    brokenV2.quote.accurate = false;
    brokenV2.judge = verdict({ faithfulness: 3, language_purity: 4, is_refusal: true, overall: 4.5 });
    const failed = evaluateCommentsGate(broken, {
      seed: 42,
      bootstrapIterations: 100,
      thresholds: { minValidationPassRate: 1 },
    });
    expect(failed.passed).toBeFalse();
    expect(failed.failures).toContain("validation_pass_rate_v2");
    expect(failed.failures).toContain("missing_results");
    expect(failed.failures).toContain("quote_accuracy_on_emitted_v2");
    expect(failed.failures).toContain("refusals_v2");
  });

  test("edge cohort is excluded from quality delta and markdown exposes the gate", () => {
    const quality = [record(1, "v1", verdict({ overall: 4 })), record(1, "v2", verdict({ overall: 4.5 }))];
    const edge = [
      record(99, "v1", verdict({ overall: 5 }), { cohort: "edge" }),
      record(99, "v2", verdict({ overall: 1 }), { cohort: "edge" }),
    ];
    const gate = evaluateCommentsGate([...quality, ...edge], {
      edgeIds: [99],
      bootstrapIterations: 10,
      thresholds: { minQualityThreads: 1 },
    });
    expect(gate.metrics.meanOverallDelta).toBe(0.5);

    const markdown = renderCommentsEvaluationMarkdown(
      {
        records: [...quality, ...edge],
        metadata: { repeats: 1, seed: 1, threadMaxChars: 1000, fixtureCount: 2, qualityIds: [1], edgeIds: [99] },
      },
      gate
    );
    expect(markdown).toContain("# Comments summary evaluation");
    expect(markdown).toContain("Gate: **PASS**");
  });
});
