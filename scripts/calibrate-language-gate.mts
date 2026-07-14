#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Offline calibration for the RU language-purity gate (read-only on data).
 *
 * Reads data/summaries/*.post.json and *.comments.json, filters lang === "ru"
 * with createdISO >= --since, runs the two-signal detector from
 * utils/language-gate.ts at several candidate thresholds, and writes a report
 * with every hit (plus context) for manual labeling.
 *
 * Usage:
 *   bun run tsx scripts/calibrate-language-gate.mts \
 *     [--data-dir data/summaries] [--since 2026-07-09] [--out-dir <dir>]
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { analyzeRussianLanguagePurity, stripNonProse } from "@utils/language-gate";

type CliOptions = {
  dataDir: string;
  since: string;
  outDir: string;
};

type SampleDoc = {
  id: string;
  kind: "comments" | "post";
  createdISO: string;
  model?: string;
  summary: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dataDir: "data/summaries",
    since: "2026-07-09",
    outDir: "calibration-language-gate",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    switch (arg) {
    case "--data-dir": {
      options.dataDir = argv[++index];

    break;
    }
    case "--since": {
      options.since = argv[++index];

    break;
    }
    case "--out-dir": {
      options.outDir = argv[++index];

    break;
    }
    default: {
      throw new Error(`Unknown argument: ${arg}`);
    }
    }
  }
  return options;
}

function loadSamples(dataDir: string, since: string): SampleDoc[] {
  const samples: SampleDoc[] = [];
  for (const file of readdirSync(dataDir)) {
    let kind: SampleDoc["kind"] | undefined;
    if (file.endsWith(".post.json")) {
      kind = "post";
    } else if (file.endsWith(".comments.json")) {
      kind = "comments";
    }
    if (!kind) {
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
      model: parsed.model,
      summary: parsed.summary,
    });
  }
  samples.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));
  return samples;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1] ?? sorted[base];
  return sorted[base] + rest * (next - sorted[base]);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const samples = loadSamples(options.dataDir, options.since);
  const posts = samples.filter((sample) => sample.kind === "post");
  const comments = samples.filter((sample) => sample.kind === "comments");
  console.log(`Loaded ${samples.length} RU samples since ${options.since}: ${posts.length} post, ${comments.length} comments`);

  const CANDIDATE_RATIOS = [0.7, 0.75, 0.8, 0.85, 0.9];

  const rows = samples.map((sample) => {
    const report = analyzeRussianLanguagePurity(sample.summary, { flagSoftRuns: true, flagSingletons: true });
    return { sample, report };
  });

  const ratios = rows
    .map((row) => row.report.cyrillicRatio)
    .filter((ratio) => Number.isFinite(ratio))
    .sort((a, b) => a - b);
  console.log("\ncyrillicRatio distribution (after stripping code/URLs):");
  for (const q of [0, 0.01, 0.05, 0.1, 0.25, 0.5, 0.9, 1]) {
    console.log(`  p${(q * 100).toFixed(0).padStart(3)}: ${quantile(ratios, q).toFixed(4)}`);
  }
  console.log("\nlow_cyrillic_ratio hits at candidate thresholds:");
  for (const threshold of CANDIDATE_RATIOS) {
    const hits = rows.filter((row) => row.report.cyrillicRatio < threshold);
    console.log(
      `  <${threshold}: ${hits.length} (${hits.filter((h) => h.sample.kind === "post").length} post / ${hits.filter((h) => h.sample.kind === "comments").length} comments)`
    );
  }

  const runFlagged = rows.filter((row) => row.report.latinRuns.length > 0);
  const softRunFlagged = rows.filter((row) => row.report.softLatinRuns.length > 0);
  const singletonFlagged = rows.filter((row) => row.report.latinSingletons.length > 0);
  console.log(`\nlatin_prose strong runs: ${runFlagged.length} samples`);
  console.log(`latin_prose soft (noun-phrase) runs: ${softRunFlagged.length} samples`);
  console.log(`latin_prose singletons (dictionary): ${singletonFlagged.length} samples`);
  const anyFlag = rows.filter(
    (row) => row.report.cyrillicRatio < 0.85 || row.report.latinRuns.length > 0 || row.report.latinSingletons.length > 0
  );
  console.log(`any hard signal (ratio<0.85 OR strong runs OR singletons): ${anyFlag.length} / ${rows.length}`);

  mkdirSync(options.outDir, { recursive: true });

  const manifest = samples.map((sample) => ({ id: sample.id, kind: sample.kind, createdISO: sample.createdISO }));
  writeFileSync(join(options.outDir, "manifest.json"), JSON.stringify(manifest, undefined, 2));

  const hitsReport = rows
    .filter(
      (row) =>
        row.report.latinRuns.length > 0 ||
        row.report.softLatinRuns.length > 0 ||
        row.report.latinSingletons.length > 0 ||
        row.report.cyrillicRatio < 0.9
    )
    .map((row) => ({
      id: row.sample.id,
      kind: row.sample.kind,
      model: row.sample.model,
      cyrillicRatio: Number(row.report.cyrillicRatio.toFixed(4)),
      latinRuns: row.report.latinRuns,
      softLatinRuns: row.report.softLatinRuns,
      latinSingletons: row.report.latinSingletons,
      prose: stripNonProse(row.sample.summary).slice(0, 400),
    }));
  writeFileSync(join(options.outDir, "hits.json"), JSON.stringify(hitsReport, undefined, 2));

  const singletonFreq = new Map<string, number>();
  for (const row of rows) {
    for (const hit of row.report.latinSingletons) {
      singletonFreq.set(hit.word, (singletonFreq.get(hit.word) ?? 0) + 1);
    }
  }
  const freqSorted = [...singletonFreq.entries()].sort((a, b) => b[1] - a[1]);
  writeFileSync(join(options.outDir, "singleton-frequency.json"), JSON.stringify(freqSorted, undefined, 2));

  console.log(`\nWrote ${hitsReport.length} flagged samples to ${join(options.outDir, "hits.json")}`);
  const topWords = freqSorted.slice(0, 20).map(([word, count]) => `${word}(${count})`).join(", ");
  console.log(`Top singleton words: ${topWords}`);
}

main();
