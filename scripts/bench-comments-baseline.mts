/**
 * Phase 0 baseline capture for the cheap-Groq comments-route eval.
 *
 * Generates and caches the `llama-3.3-70b-versatile` baseline outputs the later
 * candidate is compared against. Runs the EXACT production path
 * (generateValidatedCommentsSummaryV2 → buildCommentsPromptV2 / CommentsInsightsSchema
 * / validateCommentsInsightsCandidate / renderer), so the baseline honours every
 * CommentsInsights invariant. The route (model, output cap, timeout, single-model
 * chain) is controlled by ambient env — see scripts/bench-comments-baseline.sh.
 *
 * Groq's free tier caps llama-3.3-70b at 100k tokens/day (TPD), which the hourly
 * pipeline already consumes and which is smaller than one full baseline (~140-160k
 * tokens). So this capture is:
 *   - resumable: fixtures/repeats already captured (validationPassed) are skipped, so
 *     re-running continues where a previous window stopped; and
 *   - non-greedy: it stops after `--max-calls-per-run` successful calls, or after
 *     `--fail-streak-stop` consecutive non-validated generations (the signal that the
 *     shared TPD is exhausted — the production chain swallows the underlying 429, so a
 *     failure streak is the observable proxy). Stopping early yields the remaining daily
 *     budget back to the live pipeline instead of starving it.
 *
 * Temperature is fixed at 0.2 inside the production chain (not env-tunable); the plan's
 * literal temperature:0 is deferred to the Phase 1 explicit-route adapter. 0.2 is what
 * production uses and it applies equally to baseline and candidate, so the comparison
 * stays fair.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { env } from "@config/env";

import {
  CommentsGenerationBudget,
  generateValidatedCommentsSummaryV2,
  makeServices,
} from "../pipeline/summarize";

import type { CommentsBenchFixture } from "../eval/score-comments";

type Options = {
  manifestPath: string;
  fixturesDir: string;
  outDir: string;
  repeats: number;
  maxCalls: number;
  delayMs: number;
  maxCallsPerRun: number;
  failStreakStop: number;
};

const DEFAULTS: Options = {
  manifestPath: "bench/candidate-manifest.json",
  fixturesDir: "bench/comments",
  outDir: "data/bench/candidate-baseline",
  repeats: 2,
  maxCalls: 2,
  delayMs: 400,
  maxCallsPerRun: 0, // 0 = unlimited within this run (still bounded by TPD via the streak breaker)
  failStreakStop: 3,
};

type RepeatRecord = {
  storyId: number;
  title: string;
  repeat: number;
  route: unknown;
  validationPassed: boolean;
  model?: string;
  summary: string;
  summaryChars: number;
  promptChars?: number;
  includedComments?: number;
  callsUsed: number;
  latencyMs: number;
  error?: string;
};

async function delay(ms: number): Promise<void> {
  if (ms > 0) {
    await sleep(ms);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadManifestIds(path: string): Promise<number[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed["commentThreadIds"])) {
    throw new TypeError("manifest must contain commentThreadIds[]");
  }
  const ids = parsed["commentThreadIds"].filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0);
  if (ids.length === 0) {
    throw new TypeError("manifest commentThreadIds[] is empty");
  }
  return ids;
}

async function loadFixture(fixturesDir: string, id: number): Promise<CommentsBenchFixture> {
  const value = JSON.parse(await readFile(resolve(fixturesDir, `${id}.json`), "utf8")) as unknown;
  if (!isRecord(value) || !isRecord(value["story"]) || value["story"]["id"] !== id || !Array.isArray(value["comments"])) {
    throw new TypeError(`fixture ${id} malformed (story.id mismatch or missing comments[])`);
  }
  return value as CommentsBenchFixture;
}

function recordPath(outDir: string, id: number, repeat: number): string {
  return resolve(outDir, `${id}.r${repeat}.json`);
}

async function readExisting(outDir: string, id: number, repeat: number): Promise<RepeatRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(recordPath(outDir, id, repeat), "utf8")) as unknown;
    if (isRecord(parsed) && parsed["validationPassed"] === true) {
      return parsed as RepeatRecord;
    }
  } catch {
    // Missing or unreadable → regenerate.
  }
  return undefined;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))] ?? 0;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

export type BaselineOutcome = {
  validated: number;
  total: number;
  callsThisRun: number;
  stopped: "call-cap" | "complete" | "tpd-streak";
  remaining: number;
};

export async function captureBaseline(options: Options): Promise<BaselineOutcome> {
  const services = makeServices(env);
  const ids = await loadManifestIds(options.manifestPath);
  await mkdir(options.outDir, { recursive: true });

  const route = {
    model: env.COMMENTS_MODEL,
    fallbackModel: env.COMMENTS_FALLBACK_MODEL,
    fallbackModel2: env.COMMENTS_FALLBACK_MODEL_2,
    openrouterFallbackModel: env.COMMENTS_OPENROUTER_FALLBACK_MODEL,
    maxTokens: env.COMMENTS_SUMMARY_MAX_TOKENS,
    requestTimeoutMs: env.COMMENTS_LLM_REQUEST_TIMEOUT_MS,
    maxCalls: options.maxCalls,
    temperature: 0.2,
    gateway: "groq",
    promptMaxChars: env.COMMENTS_PROMPT_MAX_CHARS,
    summaryLang: env.SUMMARY_LANG,
  };
  process.stderr.write(`Baseline route: ${JSON.stringify(route)}\n`);
  process.stderr.write(`Fixtures: ${ids.length}, repeats: ${options.repeats}, resumable\n`);

  const latencies: number[] = [];
  const records = new Map<string, RepeatRecord>();
  let validated = 0;
  let callsThisRun = 0;
  let failStreak = 0;
  let stopped: BaselineOutcome["stopped"] = "complete";

  outer: for (const id of ids) {
    const fixture = await loadFixture(options.fixturesDir, id);
    for (let repeat = 0; repeat < options.repeats; repeat += 1) {
      const key = `${id}:${repeat}`;
      const existing = await readExisting(options.outDir, id, repeat);
      if (existing !== undefined) {
        records.set(key, existing);
        validated += 1;
        continue;
      }
      if (options.maxCallsPerRun > 0 && callsThisRun >= options.maxCallsPerRun) {
        stopped = "call-cap";
        break outer;
      }

      const budget = new CommentsGenerationBudget({
        maxCalls: options.maxCalls,
        requestTimeoutMs: env.COMMENTS_LLM_REQUEST_TIMEOUT_MS,
      });
      const started = Date.now();
      let record: RepeatRecord;
      try {
        const result = await generateValidatedCommentsSummaryV2(services, {
          story: { id: fixture.story.id, title: fixture.story.title },
          comments: fixture.comments,
          budget,
        });
        const latencyMs = Date.now() - started;
        latencies.push(latencyMs);
        record = {
          storyId: id,
          title: fixture.story.title,
          repeat,
          route,
          validationPassed: result !== undefined,
          ...(result === undefined ? {} : { model: result.modelUsed }),
          summary: result?.summary ?? "",
          summaryChars: result?.summary.length ?? 0,
          ...(result === undefined ? {} : { promptChars: result.prompt.length, includedComments: result.sampleIds.length }),
          callsUsed: budget.callsUsed,
          latencyMs,
          ...(result === undefined ? { error: "no validated result" } : {}),
        };
      } catch (error) {
        const latencyMs = Date.now() - started;
        latencies.push(latencyMs);
        record = {
          storyId: id,
          title: fixture.story.title,
          repeat,
          route,
          validationPassed: false,
          summary: "",
          summaryChars: 0,
          callsUsed: budget.callsUsed,
          latencyMs,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      callsThisRun += record.callsUsed;
      records.set(key, record);
      await writeFile(recordPath(options.outDir, id, repeat), jsonText(record), "utf8");
      const errNote = record.error === undefined ? "" : ` err=${record.error}`;
      process.stderr.write(
        `  ${id} r${repeat}: ${record.validationPassed ? "OK" : "FAIL"} model=${record.model ?? "-"} calls=${record.callsUsed} ${record.latencyMs}ms${errNote}\n`
      );

      if (record.validationPassed) {
        validated += 1;
        failStreak = 0;
      } else {
        failStreak += 1;
        // A run of consecutive failures ⇒ the shared 70b TPD is (almost certainly)
        // exhausted; stop and let the pipeline keep the remaining budget.
        if (failStreak >= options.failStreakStop) {
          stopped = "tpd-streak";
          break outer;
        }
      }
      await delay(options.delayMs);
    }
  }

  const total = ids.length * options.repeats;
  const remaining = total - validated;
  const index = {
    version: 1,
    generatedAtISO: new Date().toISOString(),
    status: remaining === 0 ? "complete" : "partial",
    stoppedBecause: stopped,
    route,
    totals: {
      fixtures: ids.length,
      repeats: options.repeats,
      generations: total,
      validated,
      remaining,
      validationRate: total === 0 ? 0 : validated / total,
      callsThisRun,
      latencyP50Ms: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95),
    },
    perFixture: ids.map((id) => ({
      id,
      repeats: Array.from({ length: options.repeats }, (_, repeat) => {
        const r = records.get(`${id}:${repeat}`);
        return {
          repeat,
          captured: r !== undefined,
          validationPassed: r?.validationPassed ?? false,
          model: r?.model,
          callsUsed: r?.callsUsed ?? 0,
          latencyMs: r?.latencyMs ?? 0,
          summaryChars: r?.summaryChars ?? 0,
          error: r?.error,
        };
      }),
    })),
  };
  await writeFile(resolve(options.outDir, "index.json"), jsonText(index), "utf8");
  return { validated, total, callsThisRun, stopped, remaining };
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === undefined) {
      continue;
    }
    switch (arg) {
      case "--manifest": { options.manifestPath = requireValue(arg, value); index += 1; break; }
      case "--fixtures-dir": { options.fixturesDir = requireValue(arg, value); index += 1; break; }
      case "--out-dir": { options.outDir = requireValue(arg, value); index += 1; break; }
      case "--repeats": { options.repeats = Number(requireValue(arg, value)); index += 1; break; }
      case "--max-calls": { options.maxCalls = Number(requireValue(arg, value)); index += 1; break; }
      case "--delay-ms": { options.delayMs = Number(requireValue(arg, value)); index += 1; break; }
      case "--max-calls-per-run": { options.maxCallsPerRun = Number(requireValue(arg, value)); index += 1; break; }
      case "--fail-streak-stop": { options.failStreakStop = Number(requireValue(arg, value)); index += 1; break; }
      default: { throw new Error(`Unknown argument: ${arg}`); }
    }
  }
  if (options.repeats < 1) {
    throw new Error("--repeats must be >= 1");
  }
  if (options.failStreakStop < 1) {
    throw new Error("--fail-streak-stop must be >= 1");
  }
  return options;
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    const outcome = await captureBaseline(parseArgs(process.argv.slice(2)));
    process.stdout.write(
      `\nBaseline: ${outcome.validated}/${outcome.total} validated (${outcome.remaining} remaining), ` +
        `${outcome.callsThisRun} calls this run, stopped=${outcome.stopped}.\n`
    );
    if (outcome.remaining > 0) {
      process.stdout.write("Partial — re-run after the Groq TPD window frees up to capture the rest.\n");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
