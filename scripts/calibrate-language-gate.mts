#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Offline calibration for the RU language-purity gate (read-only on inputs).
 *
 * By default this reads the committed, manually labeled fixture, so the documented
 * result is reproducible in a clean checkout. `--data-dir` switches to exploratory
 * analysis of local generated summaries; those files are intentionally not required.
 *
 * Usage:
 *   bun run tsx scripts/calibrate-language-gate.mts [--out-dir <dir>]
 *   bun run tsx scripts/calibrate-language-gate.mts --data-dir data/summaries \
 *     [--since 2026-07-09] [--out-dir <dir>]
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  analyzeRussianLanguagePurity,
  DEFAULT_MIN_CYRILLIC_RATIO,
  stripNonProse,
} from "@utils/language-gate";

type HardSignal = "latin_prose" | "low_cyrillic_ratio";

type CliOptions = {
  fixture?: string;
  dataDir?: string;
  since: string;
  outDir: string;
};

type SampleDoc = {
  id: string;
  kind: "comments" | "post";
  summary: string;
  createdISO?: string;
  model?: string;
  expectedSignals?: HardSignal[];
  note?: string;
};

const DEFAULT_FIXTURE = "docs/language-gate-calibration-fixture.json";
const CANDIDATE_RATIOS = [0.7, 0.75, 0.8, 0.85, 0.9] as const;

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    fixture: DEFAULT_FIXTURE,
    since: "2026-07-09",
    outDir: "calibration-language-gate",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    switch (arg) {
      case "--fixture": {
        options.fixture = requiredValue(argv, ++index, arg);
        delete options.dataDir;
        break;
      }
      case "--data-dir": {
        options.dataDir = requiredValue(argv, ++index, arg);
        delete options.fixture;
        break;
      }
      case "--since": {
        options.since = requiredValue(argv, ++index, arg);
        break;
      }
      case "--out-dir": {
        options.outDir = requiredValue(argv, ++index, arg);
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }
  return options;
}

function loadFixture(path: string): SampleDoc[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new TypeError(`Calibration fixture must be an array: ${path}`);
  }
  return parsed as SampleDoc[];
}

function loadGeneratedSamples(dataDir: string, since: string): SampleDoc[] {
  const samples: SampleDoc[] = [];
  for (const file of readdirSync(dataDir)) {
    let kind: SampleDoc["kind"] | undefined;
    if (file.endsWith(".post.json")) {
      kind = "post";
    } else if (file.endsWith(".comments.json")) {
      kind = "comments";
    }
    if (kind === undefined) {
      continue;
    }
    const parsed = JSON.parse(readFileSync(join(dataDir, file), "utf8")) as {
      id: number | string;
      lang?: string;
      createdISO?: string;
      model?: string;
      summary?: string;
    };
    if (parsed.lang !== "ru" || !parsed.createdISO || parsed.createdISO < since || !parsed.summary) {
      continue;
    }
    samples.push({
      id: String(parsed.id),
      kind,
      createdISO: parsed.createdISO,
      summary: parsed.summary,
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
    });
  }
  return samples;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position);
  const baseValue = sorted[base];
  if (baseValue === undefined) {
    return Number.NaN;
  }
  const next = sorted[base + 1] ?? baseValue;
  return baseValue + (position - base) * (next - baseValue);
}

function signalsFor(report: ReturnType<typeof analyzeRussianLanguagePurity>): HardSignal[] {
  const signals: HardSignal[] = [];
  if (report.lowCyrillicRatio) {
    signals.push("low_cyrillic_ratio");
  }
  if (report.latinRuns.length > 0 || report.latinSingletons.length > 0) {
    signals.push("latin_prose");
  }
  return signals;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const samples =
    options.fixture === undefined
      ? loadGeneratedSamples(options.dataDir ?? "data/summaries", options.since)
      : loadFixture(options.fixture);
  samples.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));

  const posts = samples.filter((sample) => sample.kind === "post");
  const comments = samples.filter((sample) => sample.kind === "comments");
  const source = options.fixture ?? `${options.dataDir} since ${options.since}`;
  console.log(`Loaded ${samples.length} RU samples from ${source}: ${posts.length} post, ${comments.length} comments`);

  const rows = samples.map((sample) => {
    const report = analyzeRussianLanguagePurity(sample.summary, {
      minCyrillicRatio: DEFAULT_MIN_CYRILLIC_RATIO,
      flagSoftRuns: true,
      flagSingletons: true,
    });
    return { sample, report, actualSignals: signalsFor(report) };
  });
  const ratios = rows.map((row) => row.report.cyrillicRatio).sort((a, b) => a - b);

  console.log("\ncyrillicRatio distribution (after stripping non-prose):");
  for (const q of [0, 0.05, 0.1, 0.5, 0.9, 1]) {
    console.log(`  p${(q * 100).toFixed(0).padStart(3)}: ${quantile(ratios, q).toFixed(4)}`);
  }
  console.log("\nlow_cyrillic_ratio hits at candidate thresholds:");
  for (const threshold of CANDIDATE_RATIOS) {
    const hits = rows.filter((row) => row.report.cyrillicRatio < threshold);
    console.log(`  <${threshold}: ${hits.length}`);
  }

  const hardFlagged = rows.filter((row) => row.actualSignals.length > 0);
  const runFlagged = rows.filter((row) => row.report.latinRuns.length > 0);
  const singletonFlagged = rows.filter((row) => row.report.latinSingletons.length > 0);
  console.log(`\nproduction threshold: ratio < ${DEFAULT_MIN_CYRILLIC_RATIO}`);
  console.log(`latin_prose strong runs: ${runFlagged.length} samples`);
  console.log(`latin_prose singletons: ${singletonFlagged.length} samples`);
  console.log(`any hard signal: ${hardFlagged.length} / ${rows.length}`);

  const labeledRows = rows.filter((row) => row.sample.expectedSignals !== undefined);
  const mismatches = labeledRows.filter((row) => {
    const expected = [...(row.sample.expectedSignals ?? [])].sort();
    const actual = [...row.actualSignals].sort();
    return JSON.stringify(expected) !== JSON.stringify(actual);
  });
  if (labeledRows.length > 0) {
    console.log(`manual-label agreement: ${labeledRows.length - mismatches.length}/${labeledRows.length}`);
  }

  mkdirSync(options.outDir, { recursive: true });
  const reportRows = rows.map((row) => ({
    id: row.sample.id,
    kind: row.sample.kind,
    ...(row.sample.note === undefined ? {} : { note: row.sample.note }),
    ...(row.sample.expectedSignals === undefined ? {} : { expectedSignals: row.sample.expectedSignals }),
    actualSignals: row.actualSignals,
    cyrillicRatio: Number(row.report.cyrillicRatio.toFixed(4)),
    latinRuns: row.report.latinRuns,
    softLatinRuns: row.report.softLatinRuns,
    latinSingletons: row.report.latinSingletons,
    prose: stripNonProse(row.sample.summary).slice(0, 400),
  }));
  writeFileSync(join(options.outDir, "report.json"), JSON.stringify(reportRows, undefined, 2));

  if (mismatches.length > 0) {
    const ids = mismatches.map((row) => row.sample.id).join(", ");
    throw new Error(`Detector disagrees with manual labels for: ${ids}`);
  }
  console.log(`Wrote ${reportRows.length} samples to ${join(options.outDir, "report.json")}`);
}

main();
