#!/usr/bin/env bun
/**
 * Phase 1 direct-Groq smoke for the cheap-Groq comments-route eval.
 *
 * Runs the explicit candidate route (qwen/qwen3.6-27b) — and optionally the gpt-oss-120b
 * experiment — over a small, fixed set of real fixtures with sequential admission and a
 * local per-minute token reservation (input estimate + output cap vs the model's TPM),
 * backing off on any 429 retry-after. Each generation is a single physical call
 * (transportRetries: 0, maxRetries: 1) through the production prompt/schema/validator
 * (see comments-candidate-route.ts).
 *
 * The baseline route (llama-3.3-70b-versatile) is NOT run here: its free-tier TPD is
 * consumed by the hourly pipeline (see docs/handoff-comments-candidate-eval-phase0.md).
 * Phase 1's gate is candidate-focused; the saved 70b baseline is a Phase 2 input.
 *
 * Results (git-ignored) land in data/bench/candidate-smoke/. Exit code is nonzero if the
 * candidate smoke gate fails.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { env } from "@config/env";

import {
  makeCommentsRouteHttp,
  runCommentsRoute,
  type CommentsRoute,
  type CommentsRouteFixture,
  type CommentsRouteResult,
} from "./comments-candidate-route";

import type { NormalizedComment } from "@config/schemas";

const CHARS_PER_TOKEN = 4;
const MAX_RESERVE_WAIT_MS = 70_000;
const INTER_CALL_DELAY_MS = 500;
// The client does not surface retry-after headers, so on a 429 we wait roughly one TPM
// window for the per-minute budget to clear before the next call.
const BACKOFF_429_MS = 20_000;

export type FixtureMeta = { id: number; sizeBucket: string; tags: string[]; promptChars: number };

type SmokeOptions = {
  manifestPath: string;
  fixturesDir: string;
  outDir: string;
  fixtureCount: number;
  candidateRepeats: number;
  experimentRepeats: number;
  tpm: number;
  runExperiment: boolean;
  fixtureIds: number[] | undefined;
};

const DEFAULTS: SmokeOptions = {
  manifestPath: "bench/candidate-manifest.json",
  fixturesDir: "bench/comments",
  outDir: "data/bench/candidate-smoke",
  fixtureCount: 6,
  candidateRepeats: 2,
  experimentRepeats: 1,
  tpm: 8000,
  runExperiment: true,
  fixtureIds: undefined,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadManifest(path: string): Promise<FixtureMeta[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed["fixtures"])) {
    throw new TypeError("manifest must contain fixtures[]");
  }
  return (parsed["fixtures"] as unknown[]).map((f) => {
    if (!isRecord(f) || typeof f["id"] !== "number") {
      throw new TypeError("manifest fixture missing id");
    }
    return {
      id: f["id"],
      sizeBucket: typeof f["sizeBucket"] === "string" ? f["sizeBucket"] : "medium",
      tags: Array.isArray(f["tags"]) ? (f["tags"] as string[]) : [],
      promptChars: typeof f["promptChars"] === "number" ? f["promptChars"] : 0,
    };
  });
}

async function loadFixture(fixturesDir: string, id: number): Promise<CommentsRouteFixture> {
  const value = JSON.parse(await readFile(resolve(fixturesDir, `${id}.json`), "utf8")) as unknown;
  if (!isRecord(value) || !isRecord(value["story"]) || value["story"]["id"] !== id || !Array.isArray(value["comments"])) {
    throw new TypeError(`fixture ${id} malformed`);
  }
  const story = value["story"] as { id: number; title: string };
  return { story: { id: story.id, title: story.title }, comments: value["comments"] as NormalizedComment[] };
}

/**
 * Deterministic, diverse 6: the two largest longs (stress the near-limit input), then the
 * most-technical and most-contested mediums, then the two smallest shorts (brevity path).
 * Falls back to filling from remaining fixtures if a bucket is short.
 */
export function selectFixtures(metas: FixtureMeta[], count: number, override?: number[]): FixtureMeta[] {
  if (override !== undefined) {
    const byId = new Map(metas.map((m) => [m.id, m]));
    return override.map((id) => {
      const meta = byId.get(id);
      if (meta === undefined) {
        throw new Error(`--fixture-ids ${id} not in manifest`);
      }
      return meta;
    });
  }
  const has = (m: FixtureMeta, tag: string): boolean => m.tags.includes(tag);
  const longs = metas.filter((m) => m.sizeBucket === "long").sort((a, b) => b.promptChars - a.promptChars);
  const mediums = metas.filter((m) => m.sizeBucket === "medium");
  const shorts = metas.filter((m) => m.sizeBucket === "short").sort((a, b) => a.promptChars - b.promptChars);
  const picked: FixtureMeta[] = [];
  const take = (m: FixtureMeta | undefined): void => {
    if (m !== undefined && !picked.some((p) => p.id === m.id)) {
      picked.push(m);
    }
  };
  take(longs[0]);
  take(longs[1]);
  take([...mediums].sort((a, b) => Number(has(b, "technical")) - Number(has(a, "technical")) || b.promptChars - a.promptChars)[0]);
  take([...mediums].sort((a, b) => Number(has(b, "contested")) - Number(has(a, "contested")) || b.promptChars - a.promptChars)[0]);
  take(shorts[0]);
  take(shorts[1]);
  // Backfill deterministically (by id) if any bucket was short.
  for (const meta of [...metas].sort((a, b) => a.id - b.id)) {
    if (picked.length >= count) {
      break;
    }
    take(meta);
  }
  return picked.slice(0, count);
}

/** Local sliding-window token reservation to keep sequential calls under the model TPM. */
class TpmReserver {
  private events: Array<{ at: number; tokens: number }> = [];
  private readonly windowMs: number;

  constructor(
    private readonly limit: number,
    windowMs?: number
  ) {
    this.windowMs = windowMs ?? 60_000;
  }

  async reserve(tokens: number): Promise<number> {
    let waited = 0;
    for (;;) {
      const now = Date.now();
      this.events = this.events.filter((event) => now - event.at < this.windowMs);
      const used = this.events.reduce((sum, event) => sum + event.tokens, 0);
      // Admit if it fits, or if the window is empty (a single call larger than the limit
      // must still go through once rather than deadlock).
      if (used + tokens <= this.limit || this.events.length === 0) {
        this.events.push({ at: now, tokens });
        return waited;
      }
      const oldest = this.events[0];
      const waitMs = Math.min(MAX_RESERVE_WAIT_MS, Math.max(250, this.windowMs - (now - (oldest?.at ?? now))));
      await sleep(waitMs);
      waited += waitMs;
    }
  }
}

export type Generation = CommentsRouteResult & { routeLabel: string; repeat: number; reserveWaitMs: number };

async function runRoute(
  route: CommentsRoute,
  fixtures: Array<{ meta: FixtureMeta; fixture: CommentsRouteFixture }>,
  repeats: number,
  tpm: number
): Promise<Generation[]> {
  const http = makeCommentsRouteHttp();
  const reserver = new TpmReserver(tpm);
  const generations: Generation[] = [];
  for (const { meta, fixture } of fixtures) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const estimate = Math.ceil(meta.promptChars / CHARS_PER_TOKEN) + route.maxTokens;
      const reserveWaitMs = await reserver.reserve(estimate);
      const result = await runCommentsRoute(http, route, fixture);
      generations.push({ ...result, routeLabel: route.label, repeat, reserveWaitMs });
      const a = result.attempt;
      const outcomeLabel = result.validationPassed ? "OK" : `FAIL(${result.rejectedReason ?? "?"})`;
      process.stderr.write(
        `  [${route.label}] ${fixture.story.id} r${repeat}: ${outcomeLabel} ` +
          `http=${a.httpStatus ?? a.status} tok=${a.totalTokens ?? "?"} ${a.latencyMs}ms wait=${reserveWaitMs}ms\n`
      );
      // Reactive backoff: no retry-after header is available, so wait ~one TPM window.
      if (a.httpStatus === 429) {
        process.stderr.write(`    429 → backing off ${BACKOFF_429_MS}ms\n`);
        await sleep(BACKOFF_429_MS);
      } else {
        await sleep(INTER_CALL_DELAY_MS);
      }
    }
  }
  return generations;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))] ?? 0;
}

export type Gate = {
  route: string;
  generations: number;
  validated: number;
  maxFailures: number;
  provenanceFailures: number;
  http413: number;
  http429: number;
  p95LatencyMs: number;
  deadlineMs: number;
  checks: Array<{ name: string; actual: number | string; expected: string; passed: boolean }>;
  passed: boolean;
};

export function evaluateGate(routeLabel: string, gens: Generation[], deadlineMs: number): Gate {
  const generations = gens.length;
  const validated = gens.filter((g) => g.validationPassed).length;
  const provenanceFailures = gens.filter((g) => g.quoteEmitted && !g.quoteProvenanceOk).length;
  const http413 = gens.filter((g) => g.attempt.httpStatus === 413).length;
  const http429 = gens.filter((g) => g.attempt.httpStatus === 429).length;
  const okLatencies = gens.filter((g) => g.attempt.status === "ok").map((g) => g.attempt.latencyMs);
  const p95LatencyMs = percentile(okLatencies, 0.95);
  const maxFailures = Math.max(1, Math.round(generations / 12));
  const checks = [
    { name: "validated", actual: `${validated}/${generations}`, expected: `>= ${generations - maxFailures}`, passed: generations - validated <= maxFailures },
    { name: "provenance_failures", actual: provenanceFailures, expected: "== 0", passed: provenanceFailures === 0 },
    { name: "http_413", actual: http413, expected: "== 0", passed: http413 === 0 },
    { name: "http_429_burst", actual: http429, expected: "< 2", passed: http429 < 2 },
    { name: "p95_latency_ms", actual: p95LatencyMs, expected: `<= ${deadlineMs}`, passed: p95LatencyMs <= deadlineMs },
  ];
  return {
    route: routeLabel,
    generations,
    validated,
    maxFailures,
    provenanceFailures,
    http413,
    http429,
    p95LatencyMs,
    deadlineMs,
    checks,
    passed: checks.every((c) => c.passed),
  };
}

function renderMarkdown(gate: Gate, gens: Generation[], selected: FixtureMeta[]): string {
  const lines = [
    `# Comments candidate smoke — ${gate.route}`,
    "",
    `Gate: **${gate.passed ? "PASS" : "FAIL"}**`,
    `Fixtures: ${selected.map((m) => m.id).join(", ")}`,
    "",
    "| Check | Actual | Requirement | Pass |",
    "| --- | ---: | --- | :---: |",
    ...gate.checks.map((c) => `| ${c.name} | ${c.actual} | ${c.expected} | ${c.passed ? "yes" : "no"} |`),
    "",
    "| Story | repeat | valid | http | totalTok | latency ms | rejected |",
    "| ---: | ---: | :---: | ---: | ---: | ---: | --- |",
    ...gens.map(
      (g) =>
        `| ${g.storyId} | ${g.repeat} | ${g.validationPassed ? "yes" : "no"} | ${g.attempt.httpStatus ?? g.attempt.status} | ${g.attempt.totalTokens ?? "?"} | ${g.attempt.latencyMs} | ${g.rejectedReason ?? ""} |`
    ),
    "",
    "Manual review still required per the plan: read every candidate summary with a rejection, provenance drop, or latency outlier before trusting the aggregate.",
  ];
  return `${lines.join("\n")}\n`;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv: string[]): SmokeOptions {
  const options: SmokeOptions = { ...DEFAULTS };
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
      case "--fixtures": { options.fixtureCount = Number(requireValue(arg, value)); index += 1; break; }
      case "--repeats": { options.candidateRepeats = Number(requireValue(arg, value)); index += 1; break; }
      case "--experiment-repeats": { options.experimentRepeats = Number(requireValue(arg, value)); index += 1; break; }
      case "--tpm": { options.tpm = Number(requireValue(arg, value)); index += 1; break; }
      case "--no-experiment": { options.runExperiment = false; break; }
      case "--fixture-ids": { options.fixtureIds = requireValue(arg, value).split(",").map(Number); index += 1; break; }
      default: { throw new Error(`Unknown argument: ${arg}`); }
    }
  }
  return options;
}

export async function runCandidateSmoke(options: SmokeOptions): Promise<{ candidateGate: Gate }> {
  const metas = await loadManifest(options.manifestPath);
  const selected = selectFixtures(metas, options.fixtureCount, options.fixtureIds);
  const fixtures = await Promise.all(
    selected.map(async (meta) => ({ meta, fixture: await loadFixture(options.fixturesDir, meta.id) }))
  );
  await mkdir(options.outDir, { recursive: true });

  const requestTimeoutMs = env.COMMENTS_LLM_REQUEST_TIMEOUT_MS;
  // Qwen3.6 is a reasoning model: without reasoning_effort=none the whole max_tokens
  // budget is spent inside <think> and balanced-object extraction fails. Use the prod
  // comments output cap so a non-thinking JSON body still has headroom.
  const candidateRoute: CommentsRoute = {
    label: "candidate-qwen3.6-27b",
    gateway: "groq",
    model: "qwen/qwen3.6-27b",
    maxTokens: env.COMMENTS_SUMMARY_MAX_TOKENS,
    temperature: 0,
    requestTimeoutMs,
    reasoningEffort: "none",
  };

  process.stderr.write(`Candidate smoke: ${selected.length} fixtures × ${options.candidateRepeats} repeats (tpm=${options.tpm})\n`);
  const candidateGens = await runRoute(candidateRoute, fixtures, options.candidateRepeats, options.tpm);
  const candidateGate = evaluateGate(candidateRoute.label, candidateGens, requestTimeoutMs);
  await writeFile(resolve(options.outDir, "candidate.json"), jsonText({ gate: candidateGate, generations: candidateGens }), "utf8");
  await writeFile(resolve(options.outDir, "candidate.md"), renderMarkdown(candidateGate, candidateGens, selected), "utf8");

  if (options.runExperiment) {
    // gpt-oss rejects reasoning_effort=none (400); "low" keeps reasoning cheap enough
    // that JSON still lands inside the comments output cap.
    const experimentRoute: CommentsRoute = {
      label: "experiment-gpt-oss-120b",
      gateway: "groq",
      model: "openai/gpt-oss-120b",
      maxTokens: env.COMMENTS_SUMMARY_MAX_TOKENS,
      temperature: 0,
      requestTimeoutMs,
      reasoningEffort: "low",
    };
    process.stderr.write(`\nExperiment (independent): gpt-oss-120b × ${options.experimentRepeats}\n`);
    const experimentGens = await runRoute(experimentRoute, fixtures, options.experimentRepeats, options.tpm);
    const experimentGate = evaluateGate(experimentRoute.label, experimentGens, requestTimeoutMs);
    await writeFile(resolve(options.outDir, "experiment.json"), jsonText({ gate: experimentGate, generations: experimentGens }), "utf8");
    await writeFile(resolve(options.outDir, "experiment.md"), renderMarkdown(experimentGate, experimentGens, selected), "utf8");
  }

  return { candidateGate };
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    const { candidateGate } = await runCandidateSmoke(parseArgs(process.argv.slice(2)));
    process.stdout.write(`\nCandidate smoke gate: ${candidateGate.passed ? "PASS" : "FAIL"}\n`);
    for (const check of candidateGate.checks) {
      process.stdout.write(`  ${check.passed ? "✓" : "✗"} ${check.name}: ${check.actual} (want ${check.expected})\n`);
    }
    if (!candidateGate.passed) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
