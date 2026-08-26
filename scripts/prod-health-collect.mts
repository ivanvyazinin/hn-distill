#!/usr/bin/env bun
/**
 * Deterministic fact collector for the daily prod health check
 * (docs/runbook-prod-health-check.md). No LLM calls: the morning agent
 * (docs/ops/morning-agent-prompt.md) interprets this JSON.
 *
 * Sections degrade independently; collection problems land in `errors[]`
 * instead of failing the run so one broken source never blinds the report.
 *
 * Usage:
 *   bun run scripts/prod-health-collect.mts                    # JSON → stdout
 *   WARN_RUNS=4 SAMPLE=12 HN_DB_PATH=/tmp/hn.sqlite bun run …  # tuned
 */
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { log } from "@utils/log";
import {
  classifyCommentsCard,
  extractItemIds,
  repeatOffenders,
  summarizeRenderSample,
  tallyWarnings,
  type RenderSample,
  type SampledCard,
  type WarningTally,
} from "@utils/prod-health";

const SITE_URL = process.env["SITE_URL"] ?? "https://ivanvyazinin.github.io/hn-distill/";
const WARN_RUNS = Number(process.env["WARN_RUNS"] ?? 6);
const SAMPLE = Number(process.env["SAMPLE"] ?? 10);
const { HN_DB_PATH } = process.env;

type RunRow = { databaseId: number; createdAt: string; conclusion: string | null };

function ghJson(args: string[]): { error: string } | { rows: RunRow[] } {
  const proc = spawnSync("gh", args, { encoding: "utf8" });
  if (proc.status !== 0) {
    return { error: `gh ${args.join(" ")} failed: ${proc.stderr.trim().slice(0, 200)}` };
  }
  try {
    return { rows: JSON.parse(proc.stdout) as RunRow[] };
  } catch (error) {
    return { error: `gh output unparsable: ${String(error)}` };
  }
}

function runList(workflow: string, limit: number): { error: string } | { runs: RunRow[] } {
  const result = ghJson([
    "run",
    "list",
    `--workflow=${workflow}`,
    `--limit=${limit}`,
    "--json",
    "databaseId,createdAt,conclusion",
  ]);
  return "rows" in result ? { runs: result.rows } : result;
}

function scanRunWarnings(runId: number): WarningTally {
  const proc = spawnSync("gh", ["run", "view", String(runId), "--log"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    throw new Error(proc.stderr.trim().slice(0, 200));
  }
  return tallyWarnings(proc.stdout.split("\n"));
}

async function sampleCards(): Promise<RenderSample> {
  const homepage = await fetch(SITE_URL).then(async (response) => {
    if (!response.ok) {
      throw new Error(`homepage HTTP ${response.status}`);
    }
    return response.text();
  });
  const ids = extractItemIds(homepage, SAMPLE);
  const cards: SampledCard[] = await Promise.all(
    ids.map(async (id): Promise<SampledCard> => {
      try {
        const html = await fetch(`${SITE_URL}item/${id}/`).then(async (response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return response.text();
        });
        return { id, ...classifyCommentsCard(html) };
      } catch {
        return { id, mode: "missing", disputeLabels: 0 };
      }
    })
  );
  return summarizeRenderSample(cards);
}

type UsageDigest = {
  windowHours: number;
  byLabel: Array<{ label: string; ok: number; error: number; totalTokens: number }>;
  minimaxHop: { ok: number; error: number };
};

function digestUsage(dbPath: string, windowHours: number): UsageDigest {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
    const byLabel = 
      db
        .prepare(
          `select label,
                  sum(status = 'ok') as ok,
                  sum(status = 'error') as error,
                  coalesce(sum(total_tokens), 0) as total_tokens
           from llm_usage where created_at >= ?
           group by label order by label`
        )
        .all(since)
        .map((row) => {
          const record = row as Record<string, unknown>;
          return {
            label: String(record["label"]),
            ok: Number(record["ok"]),
            error: Number(record["error"]),
            totalTokens: Number(record["total_tokens"]),
          };
        })
    ;
    const hop = db
      .prepare(
        `select coalesce(sum(status = 'ok'), 0) as ok,
                coalesce(sum(status = 'error'), 0) as error
         from llm_usage where gateway = 'minimax' and created_at >= ?`
      )
      .get(since) as Record<string, unknown>;
    return {
      windowHours,
      byLabel,
      minimaxHop: { ok: Number(hop["ok"]), error: Number(hop["error"]) },
    };
  } finally {
    db.close();
  }
}

const errors: string[] = [];
const hourly = runList("hourly-build.yml", Math.max(WARN_RUNS + 2, 8));
const dailyCatchup = runList("daily-catchup.yml", 1);

let warnings:
  | {
      runsScanned: number;
      totals: WarningTally["counts"];
      rejectsByRun: Array<WarningTally["rejectIdsByReason"]>;
      repeatOffenders: ReturnType<typeof repeatOffenders>;
    }
  | { error: string };

if ("runs" in hourly && hourly.runs.length > 0) {
  const scanTargets = hourly.runs.slice(0, WARN_RUNS);
  const tallies: WarningTally[] = [];
  for (const run of scanTargets) {
    try {
      tallies.push(scanRunWarnings(run.databaseId));
    } catch (error) {
      errors.push(`run ${run.databaseId}: ${String(error)}`);
    }
  }
  const totals: WarningTally["counts"] = {};
  for (const tally of tallies) {
    for (const [category, count] of Object.entries(tally.counts)) {
      totals[category] = (totals[category] ?? 0) + count;
    }
  }
  warnings = {
    runsScanned: tallies.length,
    totals,
    rejectsByRun: tallies.map((tally) => tally.rejectIdsByReason),
    repeatOffenders: repeatOffenders(tallies.map((tally) => tally.rejectIdsByReason)),
  };
} else {
  warnings = { error: "no hourly runs to scan" };
}

let render: RenderSample | { error: string };
try {
  render = await sampleCards();
} catch (error) {
  render = { error: String(error) };
}

let llmUsage: UsageDigest | { error: string };
if (HN_DB_PATH === undefined || HN_DB_PATH.length === 0) {
  llmUsage = { error: "HN_DB_PATH not set; copy the VPS backup first (sudo cp hn.sqlite)" };
} else {
  try {
    llmUsage = digestUsage(HN_DB_PATH, 24);
  } catch (error) {
    llmUsage = { error: String(error) };
  }
}

if ("error" in dailyCatchup) {
  errors.push(dailyCatchup.error);
}
if (!("runs" in hourly)) {
  errors.push(hourly.error);
}

const report = {
  generatedAt: new Date().toISOString(),
  site: SITE_URL,
  pipeline: {
    hourlyRuns: "runs" in hourly ? hourly.runs : [],
    dailyCatchup: "runs" in dailyCatchup ? dailyCatchup.runs : [],
  },
  warnings,
  render,
  llmUsage,
  errors,
};
log.debug("prod-health", "collection finished");
process.stdout.write(`${JSON.stringify(report)}
`);
