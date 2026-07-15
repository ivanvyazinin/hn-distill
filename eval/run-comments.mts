#!/usr/bin/env bun

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { env, type Env } from "@config/env";

import { makeCommentsEvaluationServices } from "./comments-services";
import {
  evaluateCommentsGate,
  renderCommentsEvaluationMarkdown,
  runCommentsEvaluation,
  type CommentsBenchFixture,
  type CommentsCandidateOutput,
  type CommentsEvaluationResult,
  type CommentsEvaluationServices,
  type CommentsGateResult,
} from "./score-comments";

type CommentsManifest = {
  commentEdgeThreadIds: number[];
  commentThreadIds: number[];
};

export type CommentsCliEnvironment = Env;

export type CommentsCliOptions = {
  fixturesDir: string;
  manifestPath: string;
  markdownOut?: string;
  out?: string;
  repeats: number;
  seed: number;
  stubJudge: boolean;
};

export type CommentsCliDependencies = {
  environment?: CommentsCliEnvironment;
  now?: () => Date;
  services?: CommentsEvaluationServices;
  servicesFactory?: (environment: CommentsCliEnvironment) => CommentsEvaluationServices;
};

export type CommentsCliRun = {
  gate: CommentsGateResult;
  markdownPath: string;
  result: CommentsEvaluationResult;
  resultsPath: string;
};

type PersistedCommentsEvaluation = {
  generatedAt: string;
  gate: CommentsGateResult;
  options: {
    repeats: number;
    seed: number;
    stubJudge: boolean;
  };
  result: CommentsEvaluationResult;
  source: {
    edgeThreadIds: number[];
    fixturesDir: string;
    manifestPath: string;
    qualityThreadIds: number[];
  };
  version: 1;
};

const DEFAULT_REPEATS = 2;
const DEFAULT_SEED = 42;

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
}

function parseInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${option} must be a safe integer`);
  }
  return parsed;
}

export function parseCommentsArgs(argv: string[]): CommentsCliOptions {
  const options: CommentsCliOptions = {
    fixturesDir: join("bench", "comments"),
    manifestPath: join("bench", "manifest.json"),
    repeats: DEFAULT_REPEATS,
    seed: DEFAULT_SEED,
    stubJudge: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stub-judge") {
      options.stubJudge = true;
      continue;
    }
    if (arg === "--manifest") {
      options.manifestPath = optionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--fixtures-dir") {
      options.fixturesDir = optionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--repeats") {
      options.repeats = parseInteger(optionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--seed") {
      options.seed = parseInteger(optionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      options.out = optionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--markdown-out") {
      options.markdownOut = optionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new TypeError(
        "Usage: bun run data:score:comments [--stub-judge] [--repeats N] [--seed N] [--manifest path] [--fixtures-dir path] [--out path] [--markdown-out path]"
      );
    }
    throw new TypeError(`unknown argument: ${arg ?? "<missing>"}`);
  }

  if (options.repeats < 2) {
    throw new TypeError("--repeats must be at least 2 for paired evaluation");
  }
  return options;
}

function parseIdList(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  const ids = value.filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0);
  if (ids.length !== value.length || new Set(ids).size !== ids.length) {
    throw new TypeError(`${field} must contain unique positive integer ids`);
  }
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadCommentsManifest(path: string): Promise<CommentsManifest> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new TypeError("comments benchmark manifest must be an object");
  }
  const commentThreadIds = parseIdList(parsed["commentThreadIds"], "commentThreadIds");
  const commentEdgeThreadIds = parseIdList(parsed["commentEdgeThreadIds"], "commentEdgeThreadIds");
  const quality = new Set(commentThreadIds);
  if (commentEdgeThreadIds.some((id) => quality.has(id))) {
    throw new TypeError("quality and edge comment thread ids must not overlap");
  }
  return { commentThreadIds, commentEdgeThreadIds };
}

function parseFixture(value: unknown, expectedId: number): CommentsBenchFixture {
  if (!isRecord(value) || !isRecord(value["story"]) || value["story"]["id"] !== expectedId) {
    throw new TypeError(`comments fixture ${expectedId} must contain matching story.id`);
  }
  if (!Array.isArray(value["comments"])) {
    throw new TypeError(`comments fixture ${expectedId} must contain comments[]`);
  }
  return value as CommentsBenchFixture;
}

export async function loadCommentsFixtures(
  fixturesDir: string,
  manifest: CommentsManifest
): Promise<CommentsBenchFixture[]> {
  const ids = [...manifest.commentThreadIds, ...manifest.commentEdgeThreadIds];
  return await Promise.all(
    ids.map(async (id) => {
      const value = JSON.parse(await readFile(join(fixturesDir, `${id}.json`), "utf8")) as unknown;
      return parseFixture(value, id);
    })
  );
}

function makeStubCandidate(summary: string, version: "v1" | "v2"): CommentsCandidateOutput {
  return {
    summary,
    validationPassed: true,
    latencyMs: 0,
    metadata: {
      requestedModel: `stub-${version}`,
      resolvedModel: `stub-${version}`,
      provider: "local-stub",
      policyVersion: version === "v2" ? "3" : "1",
      promptVersion: version,
    },
  };
}

function makeStubServices(): CommentsEvaluationServices {
  return {
    generateV1: async () =>
      makeStubCandidate("- Stub v1 candidate preserves deterministic CLI coverage.", "v1"),
    generateV2: async () =>
      makeStubCandidate("- Stub v2 candidate preserves deterministic CLI coverage.", "v2"),
  };
}

function requireRealConfiguration(environment: CommentsCliEnvironment): void {
  if ((environment.OPENROUTER_API_KEY ?? "").trim().length === 0) {
    throw new Error("OPENROUTER_API_KEY is required for real comments evaluation");
  }
  if (environment.OPENROUTER_MODEL.trim().length === 0) {
    throw new Error("OPENROUTER_MODEL is required for real comments evaluation");
  }
  if (environment.JUDGE_MODEL.trim().length === 0) {
    throw new Error("JUDGE_MODEL is required for real comments evaluation; use --stub-judge for a local dry run");
  }
  const judgeKey = environment.JUDGE_API_KEY ?? environment.OPENROUTER_API_KEY ?? "";
  if (judgeKey.trim().length === 0) {
    throw new Error("JUDGE_API_KEY or OPENROUTER_API_KEY is required for real comments evaluation");
  }
}

function defaultResultsPath(now: Date): string {
  const stamp = now.toISOString().replaceAll(":", "-");
  return join("data", "bench", `comments-results-${stamp}.json`);
}

function defaultMarkdownPath(resultsPath: string): string {
  return resultsPath.endsWith(".json") ? `${resultsPath.slice(0, -5)}.md` : `${resultsPath}.md`;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}

export async function runCommentsCli(
  argv: string[],
  dependencies: CommentsCliDependencies = {}
): Promise<CommentsCliRun> {
  const options = parseCommentsArgs(argv);
  const environment = dependencies.environment ?? env;
  let { services } = dependencies;
  const { servicesFactory } = dependencies;
  if (services === undefined) {
    if (options.stubJudge) {
      services = makeStubServices();
    } else {
      requireRealConfiguration(environment);
      services = (servicesFactory ?? makeCommentsEvaluationServices)(environment);
    }
  }

  const manifest = await loadCommentsManifest(options.manifestPath);
  const fixtures = await loadCommentsFixtures(options.fixturesDir, manifest);
  const result = await runCommentsEvaluation(fixtures, services, {
    repeats: options.repeats,
    seed: options.seed,
    threadMaxChars: environment.COMMENTS_JUDGE_THREAD_MAX_CHARS,
    stubJudge: options.stubJudge,
    qualityIds: manifest.commentThreadIds,
    edgeIds: manifest.commentEdgeThreadIds,
  });
  const gate = evaluateCommentsGate(result.records, {
    qualityIds: manifest.commentThreadIds,
    edgeIds: manifest.commentEdgeThreadIds,
    seed: options.seed,
  });
  const now = dependencies.now ?? ((): Date => new Date());
  const generatedAt = now().toISOString();
  const resultsPath = options.out ?? defaultResultsPath(new Date(generatedAt));
  const markdownPath = options.markdownOut ?? defaultMarkdownPath(resultsPath);
  const payload: PersistedCommentsEvaluation = {
    version: 1,
    generatedAt,
    source: {
      manifestPath: options.manifestPath,
      fixturesDir: options.fixturesDir,
      qualityThreadIds: manifest.commentThreadIds,
      edgeThreadIds: manifest.commentEdgeThreadIds,
    },
    options: {
      repeats: options.repeats,
      seed: options.seed,
      stubJudge: options.stubJudge,
    },
    result,
    gate,
  };

  await Promise.all([
    writeAtomic(resultsPath, `${JSON.stringify(payload, undefined, 2)}\n`),
    writeAtomic(markdownPath, renderCommentsEvaluationMarkdown(result, gate)),
  ]);
  return { result, gate, resultsPath, markdownPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const run = await runCommentsCli(process.argv.slice(2));
    process.stdout.write(`Comments evaluation JSON: ${run.resultsPath}\nComments evaluation Markdown: ${run.markdownPath}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
