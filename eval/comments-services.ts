import { z } from "zod";

import { COMMENTS_POLICY_VERSION, type Env } from "@config/env";
import { OpenRouter, type ChatMessage, type JsonSchema, type StructuredOutputOptions } from "@utils/openrouter";

import {
  buildCommentsPrompt,
  generateValidatedCommentsSummary,
  generateValidatedCommentsSummaryV2,
  makeServices,
  type Services,
} from "../pipeline/summarize";

import {
  CommentsJudgeVerdictSchema,
  type CommentsCandidateMetadata,
  type CommentsCandidateOutput,
  type CommentsEvaluationServices,
  type CommentsGenerationInput,
  type CommentsPairedJudgeInput,
  type CommentsPairedJudgeOutput,
} from "./score-comments";

type CommentsPipelineAdapter = {
  makeServices: typeof makeServices;
  buildCommentsPrompt: typeof buildCommentsPrompt;
  generateValidatedCommentsSummary: typeof generateValidatedCommentsSummary;
  generateValidatedCommentsSummaryV2: typeof generateValidatedCommentsSummaryV2;
};

export type CommentsJudgeInvocation = {
  messages: ChatMessage[];
  options: StructuredOutputOptions;
  schema: z.ZodSchema<CommentsPairedJudgeOutput>;
  maxRetries: number;
};

export type CommentsJudgeInvoker = (invocation: CommentsJudgeInvocation) => Promise<unknown>;

export type CommentsEvaluationServiceDependencies = {
  candidateServices?: Services;
  judgeInvoker?: CommentsJudgeInvoker;
  now?: () => number;
  pipeline?: CommentsPipelineAdapter;
};

const DEFAULT_PIPELINE: CommentsPipelineAdapter = {
  makeServices,
  buildCommentsPrompt,
  generateValidatedCommentsSummary,
  generateValidatedCommentsSummaryV2,
};

const PAIRED_OUTPUT_SCHEMA = z
  .object({
    A: CommentsJudgeVerdictSchema,
    B: CommentsJudgeVerdictSchema,
  })
  .strict();

const PAIRED_JUDGE_JSON_SCHEMA = {
  type: "object",
  properties: {
    A: {
      type: "object",
      properties: {
        viewpoint_coverage: { type: "number", minimum: 1, maximum: 5 },
        faithfulness: { type: "number", minimum: 1, maximum: 5 },
        language_purity: { type: "number", minimum: 1, maximum: 5 },
        format_adherence: { type: "number", minimum: 1, maximum: 5 },
        overall: { type: "number", minimum: 1, maximum: 5 },
        is_refusal: { type: "boolean" },
        reasons: { type: "array", items: { type: "string" }, maxItems: 8 },
      },
      required: [
        "viewpoint_coverage",
        "faithfulness",
        "language_purity",
        "format_adherence",
        "overall",
        "is_refusal",
        "reasons",
      ],
      additionalProperties: false,
    },
    B: {
      type: "object",
      properties: {
        viewpoint_coverage: { type: "number", minimum: 1, maximum: 5 },
        faithfulness: { type: "number", minimum: 1, maximum: 5 },
        language_purity: { type: "number", minimum: 1, maximum: 5 },
        format_adherence: { type: "number", minimum: 1, maximum: 5 },
        overall: { type: "number", minimum: 1, maximum: 5 },
        is_refusal: { type: "boolean" },
        reasons: { type: "array", items: { type: "string" }, maxItems: 8 },
      },
      required: [
        "viewpoint_coverage",
        "faithfulness",
        "language_purity",
        "format_adherence",
        "overall",
        "is_refusal",
        "reasons",
      ],
      additionalProperties: false,
    },
  },
  required: ["A", "B"],
  additionalProperties: false,
} as unknown as JsonSchema;

function candidateMetadata(
  environment: Env,
  variant: "v1" | "v2",
  resolvedModel?: string
): CommentsCandidateMetadata {
  return {
    requestedModel: environment.OPENROUTER_MODEL,
    resolvedModel: resolvedModel ?? environment.OPENROUTER_MODEL,
    provider: "openrouter",
    policyVersion: variant === "v2" ? COMMENTS_POLICY_VERSION : "1",
    promptVersion: variant === "v2" ? "comments-structured-v2" : "comments-legacy-v1",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedCandidate(
  environment: Env,
  variant: "v1" | "v2",
  latencyMs: number,
  error: unknown
): CommentsCandidateOutput {
  return {
    summary: "",
    validationPassed: false,
    latencyMs,
    metadata: candidateMetadata(environment, variant),
    error: errorMessage(error),
  };
}

async function generateLegacyCandidate(
  environment: Env,
  pipeline: CommentsPipelineAdapter,
  services: Services,
  input: CommentsGenerationInput,
  now: () => number
): Promise<CommentsCandidateOutput> {
  const started = now();
  try {
    const prepared = await pipeline.buildCommentsPrompt(input.canonicalThread.comments);
    const result = await pipeline.generateValidatedCommentsSummary(
      services,
      input.fixture.story.id,
      prepared.prompt,
      prepared.sampleIds
    );
    return {
      summary: result.summary,
      validationPassed: result.summary.trim().length > 0,
      latencyMs: Math.max(0, now() - started),
      metadata: candidateMetadata(environment, "v1", result.model),
    };
  } catch (error) {
    return failedCandidate(environment, "v1", Math.max(0, now() - started), error);
  }
}

async function generateStructuredCandidate(
  environment: Env,
  pipeline: CommentsPipelineAdapter,
  services: Services,
  input: CommentsGenerationInput,
  now: () => number
): Promise<CommentsCandidateOutput> {
  const started = now();
  try {
    const result = await pipeline.generateValidatedCommentsSummaryV2(services, {
      story: { id: input.fixture.story.id, title: input.fixture.story.title },
      comments: input.canonicalThread.comments,
      ...(input.fixture.postTldr === undefined
        ? {}
        : { postSummary: { summary: input.fixture.postTldr } }),
    });
    if (result === undefined) {
      return failedCandidate(
        environment,
        "v2",
        Math.max(0, now() - started),
        new Error("comments-v2 generation returned no validated result")
      );
    }
    return {
      summary: result.summary,
      structured: result.insights,
      validationPassed: true,
      latencyMs: Math.max(0, now() - started),
      metadata: candidateMetadata(environment, "v2", result.modelUsed),
    };
  } catch (error) {
    return failedCandidate(environment, "v2", Math.max(0, now() - started), error);
  }
}

function buildJudgeMessages(input: CommentsPairedJudgeInput, language: Env["SUMMARY_LANG"]): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a strict evaluator of two anonymous Hacker News discussion summaries.",
        "Score each candidate independently from 1 to 5 for viewpoint coverage, faithfulness, requested-language purity, format adherence, and overall quality.",
        "Do not infer which system produced candidate A or B. Respond only with the requested JSON object.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Requested language: ${language}`,
        "Canonical discussion thread:",
        "---",
        input.canonicalThread,
        "---",
        "Anonymous candidate A:",
        "---",
        input.candidates[0].summary,
        "---",
        "Anonymous candidate B:",
        "---",
        input.candidates[1].summary,
        "---",
        "Return {A, B}; each value must match the scoring rubric schema.",
      ].join("\n"),
    },
  ];
}

function defaultJudgeInvoker(environment: Env, services: Services): CommentsJudgeInvoker {
  const apiKey = environment.JUDGE_API_KEY ?? environment.OPENROUTER_API_KEY ?? "";
  const client = new OpenRouter(services.http, apiKey, environment.JUDGE_MODEL, environment.JUDGE_BASE_URL);
  return async (invocation) =>
    await client.chatStructured(
      invocation.messages,
      invocation.options,
      invocation.schema,
      invocation.maxRetries
    );
}

export function makeCommentsEvaluationServices(
  environment: Env,
  dependencies: CommentsEvaluationServiceDependencies = {}
): CommentsEvaluationServices {
  const pipeline = dependencies.pipeline ?? DEFAULT_PIPELINE;
  const services = dependencies.candidateServices ?? pipeline.makeServices(environment);
  const now = dependencies.now ?? Date.now;
  const invokeJudge = dependencies.judgeInvoker ?? defaultJudgeInvoker(environment, services);

  return {
    generateV1: async (input) => await generateLegacyCandidate(environment, pipeline, services, input, now),
    generateV2: async (input) => await generateStructuredCandidate(environment, pipeline, services, input, now),
    judge: async (input): Promise<CommentsPairedJudgeOutput> => {
      const invocation: CommentsJudgeInvocation = {
        messages: buildJudgeMessages(input, environment.SUMMARY_LANG),
        options: {
          temperature: 0,
          maxTokens: environment.JUDGE_MAX_TOKENS,
          model: environment.JUDGE_MODEL,
          transportRetries: 0,
          requestTimeoutMs: environment.COMMENTS_LLM_REQUEST_TIMEOUT_MS,
          responseFormat: {
            type: "json_schema",
            json_schema: {
              name: "comments_judge",
              strict: true,
              schema: PAIRED_JUDGE_JSON_SCHEMA,
            },
          },
        },
        schema: PAIRED_OUTPUT_SCHEMA,
        maxRetries: 1,
      };
      return PAIRED_OUTPUT_SCHEMA.parse(await invokeJudge(invocation));
    },
  };
}
