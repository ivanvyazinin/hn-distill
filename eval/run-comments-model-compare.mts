#!/usr/bin/env bun
/**
 * Comments model compare: run the same real-thread fixtures through several
 * OpenRouter models using the production prompt/schema/validator seam
 * (eval/comments-candidate-route.ts) and report schema-valid rate, provenance,
 * Russian purity, latency and tokens per call.
 *
 * Read-only with respect to pipeline state; writes results under
 * data/bench/model-compare/<runId>/ (git-ignored). Report-only: exits 0 even
 * when a model fails gates — the point is the comparison table, not a gate.
 *
 * Env:
 *   COMPARE_MODELS      comma-separated OpenRouter slugs (default: the three
 *                       candidates for the comments free-first decision)
 *   COMPARE_FIXTURES    how many manifest fixtures to use, 1..20 (default 20)
 *   COMPARE_REPEATS     repeats per fixture per model (default 1)
 *   COMPARE_DELAY_MS    delay between calls (default 1000)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { env } from "@config/env";
import { analyzeRussianLanguagePurity } from "@utils/language-gate";
import { log } from "@utils/log";

import {
  makeCommentsRouteHttp,
  runCommentsRoute,
  type CommentsRoute,
  type CommentsRouteFixture,
  type CommentsRouteResult,
} from "./comments-candidate-route";

type FixtureMeta = { id: number; sizeBucket: string; promptChars: number };
type Manifest = { fixtures: FixtureMeta[] };

type ModelReport = {
  model: string;
  calls: number;
  transportOk: number;
  transportErrors: number;
  http429: number;
  validationPassed: number;
  validationFailed: number;
  provenanceFailures: number;
  ruPurityPass: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgTotalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
};

const DEFAULT_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "openai/gpt-oss-120b:free"];

function percentile(values: Array<number | undefined>, p: number): number {
  const clean = values.filter((v): v is number => typeof v === "number" && v > 0);
  if (clean.length === 0) {return 0;}
  const sorted = [...clean].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

function average(values: Array<number | undefined>): number {
  const clean = values.filter((v): v is number => typeof v === "number");
  return Math.round(clean.reduce((a, b) => a + b, 0) / Math.max(1, clean.length));
}
async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

function buildRoutes(models: string[]): CommentsRoute[] {
  return models.map((model) => ({
    label: model,
    gateway: "openrouter",
    model,
    maxTokens: env.COMMENTS_SUMMARY_MAX_TOKENS,
    temperature: 0,
    requestTimeoutMs: 90_000,
    // Production runs gpt-oss with low reasoning effort (utils/chat-route).
    ...(model.includes("gpt-oss") ? { reasoningEffort: "low" as const } : {}),
  }));
}

function summarize(model: string, results: CommentsRouteResult[]): ModelReport {
  return {
    model,
    calls: results.length,
    transportOk: results.filter((r) => r.attempt.status === "ok").length,
    transportErrors: results.filter((r) => r.attempt.status === "error").length,
    http429: results.filter((r) => r.attempt.httpStatus === 429).length,
    validationPassed: results.filter((r) => r.validationPassed).length,
    validationFailed: results.filter((r) => !r.validationPassed && r.rejectedReason !== "transport").length,
    provenanceFailures: results.filter((r) => r.quoteEmitted && !r.quoteProvenanceOk).length,
    ruPurityPass: results.filter(
      (r) => r.summaryChars > 0 && !analyzeRussianLanguagePurity(r.summary).lowCyrillicRatio
    ).length,
    avgLatencyMs: average(results.map((r) => r.attempt.latencyMs)),
    p95LatencyMs: percentile(results.map((r) => r.attempt.latencyMs), 95),
    avgTotalTokens: average(results.map((r) => r.attempt.totalTokens)),
    totalPromptTokens: results.reduce((a, r) => a + (r.attempt.promptTokens ?? 0), 0),
    totalCompletionTokens: results.reduce((a, r) => a + (r.attempt.completionTokens ?? 0), 0),
  };
}

function renderMarkdown(reports: ModelReport[], fixtureCount: number, repeats: number): string {
  const lines: string[] = [];
  lines.push(`### Comments model compare — ${fixtureCount} fixtures × ${repeats} repeat(s)`);
  lines.push("");
  lines.push("| model | ok | 429 | schema-valid | prov-fail | RU-pass | avg ms | p95 ms | avg tok | Σ in/out tok |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of reports) {
    lines.push(
      `| ${r.model} | ${r.transportOk}/${r.calls} | ${r.http429} | ${r.validationPassed}/${r.calls} | ${r.provenanceFailures} | ${r.ruPurityPass}/${r.calls} | ${r.avgLatencyMs} | ${r.p95LatencyMs} | ${r.avgTotalTokens} | ${r.totalPromptTokens}/${r.totalCompletionTokens} |`
    );
  }
  lines.push("");
  lines.push("schema-valid counts only non-transport failures as failures; RU-pass uses utils/language-gate.");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const models = (process.env["COMPARE_MODELS"] ?? DEFAULT_MODELS.join(","))
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const fixtureCount = Number(process.env["COMPARE_FIXTURES"] ?? "20");
  const repeats = Number(process.env["COMPARE_REPEATS"] ?? "1");
  const delayMs = Number(process.env["COMPARE_DELAY_MS"] ?? "1000");

  const manifestPath = resolve("bench/candidate-manifest.json");
  const manifest = await readJson<Manifest>(manifestPath);
  const fixtures = manifest.fixtures.slice(0, Math.max(1, Math.min(manifest.fixtures.length, fixtureCount)));
  log.info("model-compare", `running ${models.length} models × ${fixtures.length} fixtures × ${repeats} repeat(s)`);

  const http = makeCommentsRouteHttp();
  const routes = buildRoutes(models);
  const perModel = new Map<string, CommentsRouteResult[]>();

  for (const route of routes) {
    const results: CommentsRouteResult[] = [];
    for (const meta of fixtures) {
      const fixture = await readJson<CommentsRouteFixture>(
        resolve(import.meta.dir, `../bench/comments/${meta.id}.json`)
      );
      for (let i = 0; i < repeats; i += 1) {
        const result = await runCommentsRoute(http, route, fixture);
        results.push(result);
        log.info("model-compare", `${route.model} ← ${meta.id}: ${result.attempt.status}`, {
          valid: result.validationPassed,
          ms: result.attempt.latencyMs,
          reason: result.rejectedReason,
        });
        await new Promise((_resolve) => setTimeout(_resolve, delayMs));
      }
    }
    perModel.set(route.model, results);
  }

  const reports = [...perModel.entries()].map(([model, results]) => summarize(model, results));
  const runId = new Date().toISOString().replaceAll(/[.:]+/gu, "-");
  const outDir = resolve(`data/bench/model-compare/${runId}`);
  await mkdir(outDir, { recursive: true });
  const markdown = renderMarkdown(reports, fixtures.length, repeats);
  const payload = { reports, perModel: [...perModel.entries()] };
  await writeFile(
    resolve(outDir, "results.json"),
    JSON.stringify(payload, (_key: string, value: unknown): unknown => value, 2)
  );
  await writeFile(resolve(outDir, "summary.md"), `${markdown}\n`);

  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath !== undefined && summaryPath.length > 0) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(summaryPath, `${markdown}\n`);
  }
  process.stdout.write(`${markdown}\n`);
}

await main();
