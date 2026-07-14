#!/usr/bin/env bun

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import pLimit from "p-limit";

import { env } from "@config/env";
import { PATHS } from "@config/paths";
import { log } from "@utils/log";
import { OpenRouter } from "@utils/openrouter";

import { makeServices } from "../pipeline/summarize";

import {
  benchRunIdFromResultsPath,
  writeBenchRunReadme,
  writeBenchSummaryMarkdown,
} from "./bench-summaries";
import { type CandidateSpec, resolveCandidates, selectCandidates } from "./models-under-test";
import {
  aggregate,
  loadBenchArticles,
  makeJudgeClient,
  renderLeaderboardMarkdown,
  scoreOneRun,
  type ScoredRunRecord,
} from "./score-models";

const LOG_NAMESPACE = "score-models-cli" as const;

type CliOptions = {
  /** Names from --models (labels or model ids). Undefined → all configured candidates. */
  modelNames?: string[];
  articleIds?: number[];
  limit?: number;
  repeats: number;
  out?: string;
  stubJudge: boolean;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const openRouterKey = env.OPENROUTER_API_KEY?.trim() ?? "";
  if (openRouterKey.length === 0) {
    log.error(
      LOG_NAMESPACE,
      "OPENROUTER_API_KEY is missing. Set it in hn-distill/.env (see .env.example) and run from the hn-distill directory, or export OPENROUTER_API_KEY in the shell."
    );
    process.exit(1);
  }
  if (options.stubJudge) {
    log.warn(LOG_NAMESPACE, "Using stub judge (no paid LLM calls)");
  } else if (env.JUDGE_MODEL.trim().length === 0) {
    log.error(
      LOG_NAMESPACE,
      "JUDGE_MODEL is empty. Set it in .env (your flagship judge model id) or pass --stub-judge for a dry run."
    );
    process.exit(1);
  }
  const benchHttpTimeoutMs = Math.max(env.HTTP_TIMEOUT_MS, env.BENCH_HTTP_TIMEOUT_MS);
  if (benchHttpTimeoutMs > env.HTTP_TIMEOUT_MS) {
    log.info(LOG_NAMESPACE, "Using extended HTTP timeout for bench", {
      httpTimeoutMs: benchHttpTimeoutMs,
      defaultHttpTimeoutMs: env.HTTP_TIMEOUT_MS,
    });
  }
  const services = makeServices({ ...env, HTTP_TIMEOUT_MS: benchHttpTimeoutMs });
  const judgeClient = makeJudgeClient(env);

  const candidates = options.modelNames === undefined ? resolveCandidates() : selectCandidates(options.modelNames);

  // Warn (don't fail) when a provider key is missing — those candidates will just record errors.
  // Resolve a candidate's API key: named env var → its value; else OpenRouter key for
  // OpenRouter candidates, or empty for keyless custom gateways (e.g. local 9Router).
  const apiKeyFor = (candidate: CandidateSpec): string => {
    if (candidate.apiKeyEnv !== undefined) {
      return process.env[candidate.apiKeyEnv]?.trim() ?? "";
    }
    return candidate.baseUrl === undefined ? openRouterKey : "";
  };

  // Warn (don't fail) when a provider key is missing — those candidates will just record errors.
  const missingKeys = new Set(
    candidates
      .filter((c) => c.apiKeyEnv !== undefined && apiKeyFor(c).length === 0)
      .map((c) => c.apiKeyEnv ?? "")
  );
  for (const keyName of missingKeys) {
    log.warn(LOG_NAMESPACE, "Provider API key missing; those candidates will error out", { env: keyName });
  }

  // One OpenAI-compatible client per (baseUrl, apiKeyEnv). Reuses the shared HttpClient.
  const clientCache = new Map<string, OpenRouter>();
  const clientFor = (candidate: CandidateSpec): OpenRouter => {
    const cacheKey = `${candidate.baseUrl ?? ""}|${candidate.apiKeyEnv ?? ""}`;
    const cached = clientCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const client = new OpenRouter(services.http, apiKeyFor(candidate), candidate.model, candidate.baseUrl);
    clientCache.set(cacheKey, client);
    return client;
  };

  // Per-provider throttle: keep >= BENCH_PROVIDER_THROTTLE_MS between candidate calls to the same
  // upstream provider so free-tier rate limits (OpenRouter 16/min, Groq per-model) don't 429.
  // Key groups by provider: OpenRouter slugs → "openrouter"; 9Router models by prefix (groq/xai).
  const providerKey = (candidate: CandidateSpec): string =>
    candidate.baseUrl === undefined ? "openrouter" : candidate.model.split("/")[0] ?? "custom";
  const throttleGate = new Map<string, Promise<unknown>>();
  const lastCallAt = new Map<string, number>();
  const throttle = async (key: string): Promise<void> => {
    if (env.BENCH_PROVIDER_THROTTLE_MS <= 0) {
      return;
    }
    const prev = throttleGate.get(key) ?? Promise.resolve();
    const mine = (async (): Promise<void> => {
      await prev;
      const wait = env.BENCH_PROVIDER_THROTTLE_MS - (Date.now() - (lastCallAt.get(key) ?? 0));
      if (wait > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
      }
      lastCallAt.set(key, Date.now());
    })();
    throttleGate.set(key, mine);
    await mine;
  };

  // Only apply the default article cap when scoring the full manifest. When the caller
  // names explicit --articles, run exactly those (an explicit --limit still caps them).
  const loadOpts: { limit?: number; articleIds?: number[] } = {};
  if (options.articleIds !== undefined) {
    loadOpts.articleIds = options.articleIds;
  }
  const effectiveLimit =
    options.limit ?? (options.articleIds === undefined ? env.BENCH_MAX_ARTICLES : undefined);
  if (effectiveLimit !== undefined) {
    loadOpts.limit = effectiveLimit;
  }
  const articles = await loadBenchArticles(env, loadOpts);

  if (articles.length === 0) {
    log.info(LOG_NAMESPACE, "No benchmark articles loaded");
    return;
  }

  await mkdir(PATHS.bench.dataDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const resultsPath = options.out ?? join(PATHS.bench.dataDir, `results-${stamp}.json`);
  const runId = benchRunIdFromResultsPath(resultsPath);
  const articleTitleById = new Map(articles.map((a) => [a.id, a.title]));

  type TaskSpec = {
    candidate: CandidateSpec;
    article: (typeof articles)[number];
    repeat: number;
    index: number;
  };
  const specs: TaskSpec[] = [];
  let taskIndex = 0;
  for (const candidate of candidates) {
    for (const article of articles) {
      for (let repeat = 0; repeat < options.repeats; repeat += 1) {
        specs.push({ candidate, article, repeat, index: taskIndex });
        taskIndex += 1;
      }
    }
  }

  const limit = pLimit(env.BENCH_CONCURRENCY);
  const runs: Array<ScoredRunRecord | undefined> = Array.from({ length: specs.length });

  log.info(LOG_NAMESPACE, "Starting scoring run", {
    models: candidates.length,
    articles: articles.length,
    repeats: options.repeats,
    tasks: specs.length,
    resultsPath,
  });

  // Serialize snapshot writes: tasks run concurrently, but writing the same file from
  // several of them at once can interleave and corrupt the JSON. Chain the writes and
  // write-then-rename so the snapshot on disk is always complete and valid.
  let writeChain: Promise<unknown> = Promise.resolve();
  const persistSnapshot = async (): Promise<void> => {
    const snapshot = runs.filter((r): r is ScoredRunRecord => r !== undefined);
    const payload = `${JSON.stringify({ runs: snapshot, updatedAt: new Date().toISOString() }, undefined, 2)}\n`;
    const prev = writeChain;
    writeChain = (async (): Promise<void> => {
      await prev;
      const tmpPath = `${resultsPath}.tmp`;
      await writeFile(tmpPath, payload, "utf8");
      await rename(tmpPath, resultsPath);
    })();
    await writeChain;
  };

  let completed = 0;
  await Promise.all(
    specs.map(async (spec) =>
      limit(async () => {
        log.info(LOG_NAMESPACE, "Task start", {
          index: spec.index + 1,
          total: specs.length,
          model: spec.candidate.label,
          articleId: spec.article.id,
          title: spec.article.title.slice(0, 60),
        });
        const { record: scored, summaryText } = await scoreOneRun({
          candidateClient: clientFor(spec.candidate),
          judgeClient,
          model: spec.candidate.model,
          label: spec.candidate.label,
          ...(spec.candidate.pipeline === undefined ? {} : { pipeline: spec.candidate.pipeline }),
          // Throttle before EVERY candidate call: the two-step pipeline makes two
          // requests per run, and both must respect the per-provider interval.
          beforeCandidateCall: async () => {
            await throttle(providerKey(spec.candidate));
          },
          article: spec.article,
          repeat: spec.repeat,
          envLike: env,
          stubJudge: options.stubJudge,
        });
        const summaryPath = await writeBenchSummaryMarkdown({
          runId,
          article: spec.article,
          record: scored,
          summaryText,
        });
        const record: ScoredRunRecord = { ...scored, summaryPath };
        runs[spec.index] = record;
        completed += 1;
        log.info(LOG_NAMESPACE, "Task done", {
          completed,
          total: specs.length,
          articleId: record.articleId,
          latencyMs: record.latencyMs,
          outputChars: record.outputChars,
          heuristicOk: record.heuristic.ok,
          error: record.error?.slice(0, 120),
        });
        await persistSnapshot();
      })
    )
  );
  await writeChain;

  const finalRuns = runs.filter((r): r is ScoredRunRecord => r !== undefined);

  const scores = aggregate(finalRuns);
  const leaderboard = renderLeaderboardMarkdown(scores, {
    generatedAt: new Date().toISOString(),
    runCount: finalRuns.length,
  });
  const leaderboardPath = join(PATHS.bench.dataDir, "leaderboard.md");
  await writeFile(leaderboardPath, leaderboard, "utf8");
  const readmeEntries = finalRuns
    .filter((r): r is ScoredRunRecord & { summaryPath: string } => r.summaryPath !== undefined)
    .map((r) => ({
      relPath: r.summaryPath,
      record: r,
      title: articleTitleById.get(r.articleId) ?? `article ${r.articleId}`,
    }));
  const readmePath = await writeBenchRunReadme({
    runId,
    resultsPath,
    entries: readmeEntries,
  });
  log.info(LOG_NAMESPACE, "Done", {
    resultsPath,
    leaderboardPath,
    summariesDir: join(PATHS.bench.dataDir, "summaries", runId),
    summariesReadme: readmePath,
  });
}

function parseArgs(argv: string[]): CliOptions {
  let modelNames: string[] | undefined;
  let articleIds: number[] | undefined;
  let limit: number | undefined;
  let repeats = env.BENCH_REPEATS;
  let out: string | undefined;
  let stubJudge = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--models") {
      const value = argv[i + 1];
      if (typeof value === "string") {
        modelNames = value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        i += 1;
      }
      continue;
    }
    if (arg === "--articles") {
      const value = argv[i + 1];
      if (typeof value === "string") {
        articleIds = value
          .split(",")
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isInteger(n));
        i += 1;
      }
      continue;
    }
    if (arg === "--limit") {
      const value = argv[i + 1];
      if (typeof value === "string") {
        limit = Number.parseInt(value, 10);
        i += 1;
      }
      continue;
    }
    if (arg === "--repeats") {
      const value = argv[i + 1];
      if (typeof value === "string") {
        repeats = Number.parseInt(value, 10);
        i += 1;
      }
      continue;
    }
    if (arg === "--stub-judge") {
      stubJudge = true;
      continue;
    }
    if (arg === "--out") {
      const value = argv[i + 1];
      if (typeof value === "string") {
        out = value;
        i += 1;
      }
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      log.info(LOG_NAMESPACE, "Usage: bun run data:score [--models a,b] [--articles id,...] [--limit N] [--repeats N] [--out path]");
      process.exit(0);
    }
  }

  const result: CliOptions = { repeats, stubJudge };
  if (modelNames !== undefined) {
    result.modelNames = modelNames;
  }
  if (articleIds !== undefined) {
    result.articleIds = articleIds;
  }
  if (limit !== undefined) {
    result.limit = limit;
  }
  if (out !== undefined) {
    result.out = out;
  }
  return result;
}

await main();