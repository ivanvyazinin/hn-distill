#!/usr/bin/env bun
/**
 * Compress-stage model compare: feed real structured comments insights (from a
 * previous model-compare run) through the production compress prompt/validator to
 * several OpenRouter models and report validity, RU purity, tokens, latency and cost.
 *
 * Read-only; writes data/bench/compress-compare/<runId>/ (git-ignored).
 *
 * Env: COMPARE_MODELS (comma slugs), COMPARE_INPUTS (max inputs, default 20),
 *      COMPARE_SOURCE (results.json of a model-compare run), COMPARE_DELAY_MS,
 *      COMPARE_MAX_TOKENS (default COMMENTS_COMPRESS_MAX_TOKENS; reasoning models
 *      burn the cap inside their thinking trace and return empty content).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { env } from "@config/env";
import {
  buildCommentsCompressUserPrompt,
  renderCommentsInsightsPlainText,
  sanitizeCompressedOutput,
  validateCompressedText,
} from "@utils/comments-compress";
import { analyzeRussianLanguagePurity } from "@utils/language-gate";

const DEFAULT_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "qwen/qwen3-next-80b-a3b-instruct",
  "meta/muse-spark-1.3-contributor",
  "deepseek/deepseek-v4-flash",
  "qwen/qwen3-235b-a22b-2507",
  "google/gemma-4-31b-it",
];

const MAX_TOKENS = Number(process.env["COMPARE_MAX_TOKENS"] ?? env.COMMENTS_COMPRESS_MAX_TOKENS);
const REASONING_MANDATORY = new Set(["meta/muse-spark-1.3-contributor", "meta/muse-spark-1.2-contributor"]);

type Insights = Parameters<typeof renderCommentsInsightsPlainText>[0];
type Input = { storyId: number; plainText: string };

type CallRecord = {
  model: string;
  storyId: number;
  ok: boolean;
  reason?: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  costUsd: number;
  ratio: number;
  purityPass: boolean;
  purityIssues: number;
  text: string;
  error?: string;
};

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function rejectKey(r: CallRecord): string {
  return (r.reason ?? r.error ?? "?").split(":")[0] ?? "?";
}

function collectInputs(source: unknown, max: number): Input[] {
  const seen = new Set<number>();
  const out: Input[] = [];
  const walk = (o: unknown, storyId?: number): void => {
    if (Array.isArray(o)) {
      for (const v of o) {walk(v, storyId);}
      return;
    }
    if (o === null || typeof o !== "object") {return;}
    const rec = o as Record<string, unknown>;
    const sid = typeof rec["storyId"] === "number" ? rec["storyId"] : storyId;
    if (typeof rec["bottom_line"] === "string" && Array.isArray(rec["insights"]) && sid !== undefined && rec["validationPassed"] !== false) {
      if (!seen.has(sid)) {
        seen.add(sid);
        out.push({ storyId: sid, plainText: renderCommentsInsightsPlainText(rec as unknown as Insights) });
      }
      return;
    }
    for (const v of Object.values(rec)) {walk(v, sid);}
  };
  walk(source);
  return out.slice(0, max);
}

async function loadPricing(): Promise<Map<string, { prompt: number; completion: number }>> {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  const body = (await res.json()) as { data: Array<{ id: string; pricing: { prompt: string; completion: string } }> };
  return new Map(body.data.map((m) => [m.id, { prompt: Number(m.pricing.prompt), completion: Number(m.pricing.completion) }]));
}

async function callModel(model: string, input: Input, pricing: Map<string, { prompt: number; completion: number }>): Promise<CallRecord> {
  const started = Date.now();
  const base: Omit<CallRecord, "latencyMs" | "ok"> = {
    model, storyId: input.storyId, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0,
    ratio: 0, purityPass: false, purityIssues: 0, text: "",
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, 60_000);
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: buildCommentsCompressUserPrompt(input.plainText) }],
        temperature: 0.2,
        max_tokens: MAX_TOKENS,
        // Prod sends "none" (utils/chat-route compress hop); Muse contributor refuses to
        // disable reasoning (HTTP 400), so it gets the lowest allowed effort instead.
        reasoning_effort: REASONING_MANDATORY.has(model) ? "low" : "none",
        usage: { include: true },
      }),
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { ...base, ok: false, latencyMs, error: `HTTP ${res.status} ${(await res.text()).slice(0, 200)}` };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; completion_tokens_details?: { reasoning_tokens?: number } };
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    const sanitized = sanitizeCompressedOutput(raw);
    const validated = validateCompressedText(sanitized, input.plainText, {
      language: "ru", minChars: env.COMMENTS_SUMMARY_MIN_CHARS, minCyrillicRatio: env.COMMENTS_MIN_CYRILLIC_RATIO,
    });
    const purity = analyzeRussianLanguagePurity(sanitized, { minCyrillicRatio: env.COMMENTS_MIN_CYRILLIC_RATIO });
    const purityIssues = purity.latinRuns.length + purity.latinSingletons.length;
    const pt = json.usage?.prompt_tokens ?? 0;
    const ct = json.usage?.completion_tokens ?? 0;
    const price = pricing.get(model) ?? { prompt: 0, completion: 0 };
    const costUsd = json.usage?.cost ?? pt * price.prompt + ct * price.completion;
    return {
      ...base, ok: validated.ok, ...(validated.ok ? {} : { reason: validated.reason }), latencyMs,
      promptTokens: pt, completionTokens: ct, reasoningTokens: json.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      costUsd, ratio: sanitized.trim().length / input.plainText.length,
      purityPass: !purity.lowCyrillicRatio && purityIssues === 0, purityIssues, text: sanitized.trim(),
    };
  } catch (error) {
    return { ...base, ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const models = (process.env["COMPARE_MODELS"] ?? DEFAULT_MODELS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const maxInputs = Number(process.env["COMPARE_INPUTS"] ?? 20);
  const delayMs = Number(process.env["COMPARE_DELAY_MS"] ?? 500);
  const sourcePath = process.env["COMPARE_SOURCE"] ?? "data/bench/model-compare/2026-09-03T08-05-36-312Z/results.json";
  const source = JSON.parse(await readFile(resolve(sourcePath), "utf8")) as unknown;
  const inputs = collectInputs(source, maxInputs);
  const pricing = await loadPricing();
  process.stdout.write(`inputs=${inputs.length} models=${models.length}\n`);

  const records: CallRecord[] = [];
  for (const model of models) {
    for (const input of inputs) {
      const rec = await callModel(model, input, pricing);
      records.push(rec);
      const verdict = rec.ok ? "OK" : `FAIL:${rec.reason ?? rec.error}`;
      process.stdout.write(`${model} ${input.storyId} ${verdict} ${rec.latencyMs}ms ${rec.completionTokens}tok $${rec.costUsd.toFixed(5)}\n`);
      await sleep(delayMs);
    }
  }

  const rows = models.map((model) => {
    const rs = records.filter((r) => r.model === model);
    const okRs = rs.filter((r) => r.ok);
    const lat = rs.map((r) => r.latencyMs).sort((a, b) => a - b);
    return {
      model, calls: rs.length, valid: okRs.length, transportErr: rs.filter((r) => r.error !== undefined).length,
      purityPass: rs.filter((r) => r.purityPass).length,
      avgRatio: avg(okRs.map((r) => r.ratio)), p50Ms: lat[Math.floor(lat.length / 2)] ?? 0, p95Ms: lat[Math.floor(lat.length * 0.95)] ?? 0,
      avgCompTok: avg(rs.map((r) => r.completionTokens)), reasoningTok: rs.reduce((a, r) => a + r.reasoningTokens, 0),
      totalCost: rs.reduce((a, r) => a + r.costUsd, 0),
      rejectReasons: Object.entries(
        rs.filter((r) => !r.ok).reduce<Record<string, number>>((acc, r) => {
          const k = rejectKey(r);
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {})
      ).map(([k, v]) => `${k}×${v}`).join(" "),
    };
  });

  const md = [
    `# Compress model compare — ${new Date().toISOString()}`, "",
    `inputs=${inputs.length} (source: ${sourcePath}); max_tokens=${MAX_TOKENS}; temp=0.2; reasoning_effort=none`, "",
    "| model | valid | purity | transportErr | avgRatio | p50 ms | p95 ms | avg comp tok | reasoning tok | total $ | $/call | rejects |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.model} | ${r.valid}/${r.calls} | ${r.purityPass}/${r.calls} | ${r.transportErr} | ${r.avgRatio.toFixed(2)} | ${r.p50Ms} | ${r.p95Ms} | ${r.avgCompTok.toFixed(0)} | ${r.reasoningTok} | ${r.totalCost.toFixed(4)} | ${(r.totalCost / Math.max(1, r.calls)).toFixed(5)} | ${r.rejectReasons} |`),
  ].join("\n");

  const runId = new Date().toISOString().replaceAll(":", "-");
  const outDir = resolve("data/bench/compress-compare", runId);
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, "results.json"), JSON.stringify({ inputs, records, rows }, undefined, 2));
  await writeFile(resolve(outDir, "summary.md"), `${md}\n`);
  process.stdout.write(`\n${md}\n\nwritten: ${outDir}\n`);
}

await main();
