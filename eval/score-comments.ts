import { z } from "zod";

import type { CommentsInsights, NormalizedComment } from "@config/schemas";

export const CommentsJudgeVerdictSchema = z.object({
  viewpoint_coverage: z.number().min(1).max(5),
  faithfulness: z.number().min(1).max(5),
  language_purity: z.number().min(1).max(5),
  format_adherence: z.number().min(1).max(5),
  overall: z.number().min(1).max(5),
  is_refusal: z.boolean(),
  reasons: z.array(z.string()).max(8),
});

export type CommentsJudgeVerdict = z.infer<typeof CommentsJudgeVerdictSchema>;

export type CommentsBenchFixture = {
  story: {
    id: number;
    title: string;
    url?: string | null;
  };
  postTldr?: string;
  comments: NormalizedComment[];
  cohort?: "edge" | "quality";
};

export type CanonicalCommentsThread = {
  text: string;
  comments: NormalizedComment[];
  includedCommentIds: number[];
  truncated: boolean;
  maxChars: number;
};

export type CommentsCandidateMetadata = {
  requestedModel: string;
  resolvedModel: string;
  provider: string;
  policyVersion: string;
  promptVersion: string;
};

export type CommentsCandidateOutput = {
  summary: string;
  validationPassed: boolean;
  latencyMs: number;
  metadata: CommentsCandidateMetadata;
  structured?: CommentsInsights;
  error?: string;
};

export type CommentsGenerationInput = {
  fixture: CommentsBenchFixture;
  canonicalThread: CanonicalCommentsThread;
  repeat: number;
  seed: number;
};

export type BlindCandidateSlot = "A" | "B";
export type CommentsVariant = "v1" | "v2";

export type CommentsPairedJudgeInput = {
  storyId: number;
  repeat: number;
  canonicalThread: string;
  candidates: [
    { slot: BlindCandidateSlot; summary: string },
    { slot: BlindCandidateSlot; summary: string },
  ];
};

export type CommentsPairedJudgeOutput = Record<BlindCandidateSlot, CommentsJudgeVerdict>;

export type CommentsEvaluationServices = {
  generateV1: (input: CommentsGenerationInput) => Promise<CommentsCandidateOutput>;
  generateV2: (input: CommentsGenerationInput) => Promise<CommentsCandidateOutput>;
  judge?: (input: CommentsPairedJudgeInput) => Promise<CommentsPairedJudgeOutput>;
};

export type CommentsEvaluationOptions = {
  repeats: number;
  seed: number;
  threadMaxChars: number;
  stubJudge?: boolean;
  qualityIds?: readonly number[];
  edgeIds?: readonly number[];
};

export type QuoteMetric = {
  emitted: boolean;
  accurate?: boolean;
  commentId?: number;
};

export type CommentsEvaluationRecord = {
  storyId: number;
  cohort: "edge" | "quality";
  repeat: number;
  variant: CommentsVariant;
  blindSlot: BlindCandidateSlot;
  canonicalThreadChars: number;
  canonicalThreadTruncated: boolean;
  summary: string;
  validationPassed: boolean;
  latencyMs: number;
  quote: QuoteMetric;
  candidateMetadata?: CommentsCandidateMetadata;
  candidateError?: string;
  judge?: CommentsJudgeVerdict;
  judgeError?: string;
  missingResult: boolean;
};

export type CommentsEvaluationMetadata = {
  repeats: number;
  seed: number;
  threadMaxChars: number;
  fixtureCount: number;
  qualityIds: number[];
  edgeIds: number[];
};

export type CommentsEvaluationResult = {
  records: CommentsEvaluationRecord[];
  metadata: CommentsEvaluationMetadata;
};

export type CommentsGateThresholds = {
  minQualityThreads: number;
  minOverallDelta: number;
  minBootstrapLower: number;
  minValidationPassRate: number;
  maxMissingResults: number;
  minLanguagePurity: number;
  minFaithfulness: number;
  minFaithfulnessDelta: number;
  minQuoteAccuracy: number;
  maxRefusals: number;
};

export type CommentsGateOptions = {
  qualityIds?: readonly number[];
  edgeIds?: readonly number[];
  seed?: number;
  bootstrapIterations?: number;
  thresholds?: Partial<CommentsGateThresholds>;
};

export type CommentsGateMetrics = {
  qualityThreadCount: number;
  pairedRunCount: number;
  meanOverallV1: number | undefined;
  meanOverallV2: number | undefined;
  meanOverallDelta: number | undefined;
  bootstrap95Lower: number | undefined;
  validationPassRateV2: number;
  missingResultCount: number;
  meanLanguagePurityV2: number | undefined;
  meanFaithfulnessV1: number | undefined;
  meanFaithfulnessV2: number | undefined;
  quoteEmissionRateV2: number;
  quoteAccuracyOnEmittedV2: number | undefined;
  refusalCountV2: number;
};

export type CommentsGateCheck = {
  name: string;
  passed: boolean;
  actual: number | undefined;
  expected: string;
};

export type CommentsGateResult = {
  passed: boolean;
  metrics: CommentsGateMetrics;
  checks: CommentsGateCheck[];
  failures: string[];
};

const DEFAULT_GATE_THRESHOLDS: CommentsGateThresholds = {
  minQualityThreads: 20,
  minOverallDelta: 0.3,
  minBootstrapLower: 0,
  minValidationPassRate: 0.9,
  maxMissingResults: 0,
  minLanguagePurity: 4.5,
  minFaithfulness: 4,
  minFaithfulnessDelta: 0,
  minQuoteAccuracy: 1,
  maxRefusals: 0,
};

const STUB_JUDGE_VERDICT: CommentsJudgeVerdict = {
  viewpoint_coverage: 3,
  faithfulness: 3,
  language_purity: 3,
  format_adherence: 3,
  overall: 3,
  is_refusal: false,
  reasons: ["stub_judge"],
};

function singleLine(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function commentBlock(comment: NormalizedComment): string {
  return [
    `[comment id=${comment.id} parent=${comment.parent} depth=${comment.depth} by=${singleLine(comment.by)}]`,
    singleLine(comment.textPlain),
  ].join("\n");
}

export function serializeCanonicalCommentsThread(
  fixture: CommentsBenchFixture,
  maxChars: number
): CanonicalCommentsThread {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError("maxChars must be a positive integer");
  }

  const header = [
    `[story id=${fixture.story.id}]`,
    `title: ${singleLine(fixture.story.title)}`,
    ...(fixture.story.url === undefined || fixture.story.url === null
      ? []
      : [`url: ${singleLine(fixture.story.url)}`]),
    ...(fixture.postTldr === undefined ? [] : [`post_tldr: ${singleLine(fixture.postTldr)}`]),
    "comments:",
  ].join("\n");

  if (header.length >= maxChars) {
    return {
      text: header.slice(0, maxChars),
      comments: [],
      includedCommentIds: [],
      truncated: fixture.comments.length > 0 || header.length > maxChars,
      maxChars,
    };
  }

  let text = header;
  const comments: NormalizedComment[] = [];
  for (const comment of fixture.comments) {
    const addition = `\n\n${commentBlock(comment)}`;
    if (text.length + addition.length > maxChars) {
      break;
    }
    text += addition;
    comments.push(comment);
  }

  return {
    text,
    comments,
    includedCommentIds: comments.map((comment) => comment.id),
    truncated: comments.length !== fixture.comments.length,
    maxChars,
  };
}

function normalizedQuoteText(value: string): string {
  return value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
}

export function computeQuoteMetric(
  candidate: Pick<CommentsCandidateOutput, "structured"> | undefined,
  canonicalThread: CanonicalCommentsThread
): QuoteMetric {
  const quote = candidate?.structured?.best_quote;
  if (quote === undefined || quote === null) {
    return { emitted: false };
  }

  const source = canonicalThread.comments.find((comment) => comment.id === quote.comment_id);
  const normalizedSource = source === undefined ? "" : normalizedQuoteText(source.textPlain);
  const normalizedQuote = normalizedQuoteText(quote.source_text);
  return {
    emitted: true,
    accurate: normalizedQuote.length > 0 && normalizedSource.includes(normalizedQuote),
    commentId: quote.comment_id,
  };
}

function hashSeed(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function blindVariants(storyId: number, repeat: number, seed: number): [CommentsVariant, CommentsVariant] {
  const firstIsV1 = (hashSeed(`${seed}:${storyId}`) + repeat) % 2 === 0;
  return firstIsV1 ? ["v1", "v2"] : ["v2", "v1"];
}

function fixtureCohort(
  fixture: CommentsBenchFixture,
  qualityIds: ReadonlySet<number>,
  edgeIds: ReadonlySet<number>
): "edge" | "quality" {
  if (edgeIds.has(fixture.story.id)) {
    return "edge";
  }
  if (qualityIds.has(fixture.story.id)) {
    return "quality";
  }
  return fixture.cohort ?? "quality";
}

async function generateCandidate(
  generator: CommentsEvaluationServices["generateV1"],
  input: CommentsGenerationInput
): Promise<{ output?: CommentsCandidateOutput; error?: string }> {
  try {
    return { output: await generator(input) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function emptyRecord(params: {
  fixture: CommentsBenchFixture;
  cohort: "edge" | "quality";
  repeat: number;
  variant: CommentsVariant;
  blindSlot: BlindCandidateSlot;
  canonical: CanonicalCommentsThread;
  generated: { output?: CommentsCandidateOutput; error?: string };
}): CommentsEvaluationRecord {
  const { fixture, cohort, repeat, variant, blindSlot, canonical, generated } = params;
  const { error: generationError, output } = generated;
  const summary = output?.summary ?? "";
  const candidateError = generationError ?? output?.error;
  return {
    storyId: fixture.story.id,
    cohort,
    repeat,
    variant,
    blindSlot,
    canonicalThreadChars: canonical.text.length,
    canonicalThreadTruncated: canonical.truncated,
    summary,
    validationPassed: output?.validationPassed ?? false,
    latencyMs: output?.latencyMs ?? 0,
    quote: computeQuoteMetric(output, canonical),
    ...(output === undefined ? {} : { candidateMetadata: output.metadata }),
    ...(candidateError === undefined ? {} : { candidateError }),
    missingResult: candidateError !== undefined || summary.trim().length === 0,
  };
}

export async function runCommentsEvaluation(
  fixtures: CommentsBenchFixture[],
  services: CommentsEvaluationServices,
  options: CommentsEvaluationOptions
): Promise<CommentsEvaluationResult> {
  if (!Number.isInteger(options.repeats) || options.repeats < 1) {
    throw new RangeError("repeats must be a positive integer");
  }
  if (options.stubJudge !== true && services.judge === undefined) {
    throw new Error("A judge service is required unless stubJudge is enabled");
  }

  const qualityIds = new Set(options.qualityIds ?? []);
  const edgeIds = new Set(options.edgeIds ?? []);
  const records: CommentsEvaluationRecord[] = [];

  for (const fixture of fixtures) {
    const canonical = serializeCanonicalCommentsThread(fixture, options.threadMaxChars);
    const cohort = fixtureCohort(fixture, qualityIds, edgeIds);
    for (let repeat = 0; repeat < options.repeats; repeat++) {
      const input: CommentsGenerationInput = {
        fixture,
        canonicalThread: canonical,
        repeat,
        seed: options.seed,
      };
      const [v1, v2] = await Promise.all([
        generateCandidate(services.generateV1, input),
        generateCandidate(services.generateV2, input),
      ]);
      const generated: Record<CommentsVariant, { output?: CommentsCandidateOutput; error?: string }> = { v1, v2 };
      const variants = blindVariants(fixture.story.id, repeat, options.seed);
      const slots: Record<CommentsVariant, BlindCandidateSlot> =
        variants[0] === "v1" ? { v1: "A", v2: "B" } : { v1: "B", v2: "A" };
      const v1Record = emptyRecord({
        fixture,
        cohort,
        repeat,
        variant: "v1",
        blindSlot: slots.v1,
        canonical,
        generated: generated.v1,
      });
      const v2Record = emptyRecord({
        fixture,
        cohort,
        repeat,
        variant: "v2",
        blindSlot: slots.v2,
        canonical,
        generated: generated.v2,
      });
      const pair = [v1Record, v2Record];
      const byVariant = { v1: v1Record, v2: v2Record };
      if (!pair.some((record) => record.missingResult)) {
        try {
          const judgeOutput =
            options.stubJudge === true
              ? { A: STUB_JUDGE_VERDICT, B: STUB_JUDGE_VERDICT }
              : await services.judge?.({
                  storyId: fixture.story.id,
                  repeat,
                  canonicalThread: canonical.text,
                  candidates: variants.map((variant, index) => ({
                    slot: index === 0 ? "A" : "B",
                    summary: byVariant[variant].summary,
                  })) as CommentsPairedJudgeInput["candidates"],
                });
          if (judgeOutput === undefined) {
            throw new Error("Judge returned no result");
          }
          for (const record of pair) {
            record.judge = CommentsJudgeVerdictSchema.parse(judgeOutput[record.blindSlot]);
          }
        } catch (error) {
          const judgeError = error instanceof Error ? error.message : String(error);
          for (const record of pair) {
            record.judgeError = judgeError;
            record.missingResult = true;
          }
        }
      }

      for (const record of pair) {
        if (record.judge === undefined) {
          record.missingResult = true;
        }
        records.push(record);
      }
    }
  }

  return {
    records,
    metadata: {
      repeats: options.repeats,
      seed: options.seed,
      threadMaxChars: options.threadMaxChars,
      fixtureCount: fixtures.length,
      qualityIds: [...qualityIds],
      edgeIds: [...edgeIds],
    },
  };
}

function mean(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 1_831_565_813;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function bootstrapLowerBound(values: number[], iterations: number, seed: number): number | undefined {
  if (values.length === 0 || iterations < 1) {
    return undefined;
  }
  const random = createSeededRandom(seed);
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sum = values.reduce(
      (total) => total + (values[Math.floor(random() * values.length)] ?? 0),
      0
    );
    samples.push(sum / values.length);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(0.025 * (samples.length - 1))];
}

function qualityRecords(
  records: CommentsEvaluationRecord[],
  qualityIds: ReadonlySet<number>,
  edgeIds: ReadonlySet<number>
): CommentsEvaluationRecord[] {
  return records.filter((record) => {
    if (edgeIds.has(record.storyId)) {
      return false;
    }
    if (qualityIds.size > 0) {
      return qualityIds.has(record.storyId);
    }
    return record.cohort === "quality";
  });
}

function pairedQualityRuns(records: CommentsEvaluationRecord[]): Array<{ v1: CommentsEvaluationRecord; v2: CommentsEvaluationRecord }> {
  const groups = new Map<string, Partial<Record<CommentsVariant, CommentsEvaluationRecord>>>();
  for (const record of records) {
    const key = `${record.storyId}:${record.repeat}`;
    const group = groups.get(key) ?? {};
    group[record.variant] = record;
    groups.set(key, group);
  }
  const pairs: Array<{ v1: CommentsEvaluationRecord; v2: CommentsEvaluationRecord }> = [];
  for (const group of groups.values()) {
    if (group.v1?.judge !== undefined && group.v2?.judge !== undefined) {
      pairs.push({ v1: group.v1, v2: group.v2 });
    }
  }
  return pairs;
}

function storyMeanDeltas(pairs: Array<{ v1: CommentsEvaluationRecord; v2: CommentsEvaluationRecord }>): number[] {
  const byStory = new Map<number, number[]>();
  for (const pair of pairs) {
    const delta = (pair.v2.judge?.overall ?? 0) - (pair.v1.judge?.overall ?? 0);
    const values = byStory.get(pair.v1.storyId) ?? [];
    values.push(delta);
    byStory.set(pair.v1.storyId, values);
  }
  return [...byStory.values()].map((values) => mean(values) ?? 0);
}

function gateCheck(name: string, actual: number | undefined, expected: string, passed: boolean): CommentsGateCheck {
  return { name, actual, expected, passed };
}

export function evaluateCommentsGate(
  records: CommentsEvaluationRecord[],
  options: CommentsGateOptions = {}
): CommentsGateResult {
  const qualityIds = new Set(options.qualityIds ?? []);
  const edgeIds = new Set(options.edgeIds ?? []);
  const thresholds = { ...DEFAULT_GATE_THRESHOLDS, ...(options.thresholds ?? {}) };
  const relevant = qualityRecords(records, qualityIds, edgeIds);
  const v1 = relevant.filter((record) => record.variant === "v1");
  const v2 = relevant.filter((record) => record.variant === "v2");
  const judgedV1 = v1.filter((record): record is CommentsEvaluationRecord & { judge: CommentsJudgeVerdict } => record.judge !== undefined);
  const judgedV2 = v2.filter((record): record is CommentsEvaluationRecord & { judge: CommentsJudgeVerdict } => record.judge !== undefined);
  const pairs = pairedQualityRuns(relevant);
  const deltas = storyMeanDeltas(pairs);
  const overallV1 = mean(judgedV1.map((record) => record.judge.overall));
  const overallV2 = mean(judgedV2.map((record) => record.judge.overall));
  const overallDelta = mean(deltas);
  const bootstrap95Lower = bootstrapLowerBound(
    deltas,
    options.bootstrapIterations ?? 10_000,
    options.seed ?? 1
  );
  const emitted = v2.filter((record) => record.quote.emitted);
  const accurate = emitted.filter((record) => record.quote.accurate === true);
  const qualityThreadCount = new Set(relevant.map((record) => record.storyId)).size;
  const missingResultCount = relevant.filter((record) => record.missingResult).length;
  const faithfulnessV1 = mean(judgedV1.map((record) => record.judge.faithfulness));
  const faithfulnessV2 = mean(judgedV2.map((record) => record.judge.faithfulness));
  const metrics: CommentsGateMetrics = {
    qualityThreadCount,
    pairedRunCount: pairs.length,
    meanOverallV1: overallV1,
    meanOverallV2: overallV2,
    meanOverallDelta: overallDelta,
    bootstrap95Lower,
    validationPassRateV2: v2.length === 0 ? 0 : v2.filter((record) => record.validationPassed).length / v2.length,
    missingResultCount,
    meanLanguagePurityV2: mean(judgedV2.map((record) => record.judge.language_purity)),
    meanFaithfulnessV1: faithfulnessV1,
    meanFaithfulnessV2: faithfulnessV2,
    quoteEmissionRateV2: v2.length === 0 ? 0 : emitted.length / v2.length,
    quoteAccuracyOnEmittedV2: emitted.length === 0 ? undefined : accurate.length / emitted.length,
    refusalCountV2: judgedV2.filter((record) => record.judge.is_refusal).length,
  };

  const checks = [
    gateCheck(
      "quality_thread_count",
      qualityThreadCount,
      `>= ${thresholds.minQualityThreads}`,
      qualityThreadCount >= thresholds.minQualityThreads
    ),
    gateCheck(
      "overall_delta",
      overallDelta,
      `>= ${thresholds.minOverallDelta}`,
      overallDelta !== undefined && overallDelta >= thresholds.minOverallDelta
    ),
    gateCheck(
      "bootstrap_95_lower",
      bootstrap95Lower,
      `> ${thresholds.minBootstrapLower}`,
      bootstrap95Lower !== undefined && bootstrap95Lower > thresholds.minBootstrapLower
    ),
    gateCheck(
      "validation_pass_rate_v2",
      metrics.validationPassRateV2,
      `>= ${thresholds.minValidationPassRate}`,
      metrics.validationPassRateV2 >= thresholds.minValidationPassRate
    ),
    gateCheck(
      "missing_results",
      missingResultCount,
      `<= ${thresholds.maxMissingResults}`,
      missingResultCount <= thresholds.maxMissingResults
    ),
    gateCheck(
      "language_purity_v2",
      metrics.meanLanguagePurityV2,
      `>= ${thresholds.minLanguagePurity}`,
      metrics.meanLanguagePurityV2 !== undefined && metrics.meanLanguagePurityV2 >= thresholds.minLanguagePurity
    ),
    gateCheck(
      "faithfulness_v2",
      faithfulnessV2,
      `>= ${thresholds.minFaithfulness}`,
      faithfulnessV2 !== undefined && faithfulnessV2 >= thresholds.minFaithfulness
    ),
    gateCheck(
      "faithfulness_delta",
      faithfulnessV1 === undefined || faithfulnessV2 === undefined ? undefined : faithfulnessV2 - faithfulnessV1,
      `>= ${thresholds.minFaithfulnessDelta}`,
      faithfulnessV1 !== undefined &&
        faithfulnessV2 !== undefined &&
        faithfulnessV2 - faithfulnessV1 >= thresholds.minFaithfulnessDelta
    ),
    gateCheck(
      "quote_accuracy_on_emitted_v2",
      metrics.quoteAccuracyOnEmittedV2,
      `>= ${thresholds.minQuoteAccuracy} (N/A passes when no quote is emitted)`,
      metrics.quoteAccuracyOnEmittedV2 === undefined ||
        metrics.quoteAccuracyOnEmittedV2 >= thresholds.minQuoteAccuracy
    ),
    gateCheck(
      "refusals_v2",
      metrics.refusalCountV2,
      `<= ${thresholds.maxRefusals}`,
      metrics.refusalCountV2 <= thresholds.maxRefusals
    ),
  ];
  const failures = checks.filter((check) => !check.passed).map((check) => check.name);
  return { passed: failures.length === 0, metrics, checks, failures };
}

function displayMetric(value: number | undefined, digits?: number): string {
  return value === undefined ? "N/A" : value.toFixed(digits ?? 3);
}

export function renderCommentsEvaluationMarkdown(
  result: CommentsEvaluationResult,
  gate: CommentsGateResult = evaluateCommentsGate(result.records, {
    qualityIds: result.metadata.qualityIds,
    edgeIds: result.metadata.edgeIds,
    seed: result.metadata.seed,
  })
): string {
  const lines = [
    "# Comments summary evaluation",
    "",
    `Gate: **${gate.passed ? "PASS" : "FAIL"}**`,
    `Fixtures: ${result.metadata.fixtureCount}; repeats: ${result.metadata.repeats}; seed: ${result.metadata.seed}`,
    "",
    "| Metric | Actual | Requirement | Pass |",
    "| --- | ---: | --- | :---: |",
    ...gate.checks.map(
      (check) => `| ${check.name} | ${displayMetric(check.actual)} | ${check.expected} | ${check.passed ? "yes" : "no"} |`
    ),
    "",
    `Paired runs: ${gate.metrics.pairedRunCount}`,
    `Quote emission rate (v2): ${displayMetric(gate.metrics.quoteEmissionRateV2)}`,
  ];
  return `${lines.join("\n")}\n`;
}
