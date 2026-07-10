import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PATHS } from "@config/paths";

import type { BenchArticle, ScoredRunRecord } from "./score-models";

/** Safe directory name for an OpenRouter model slug (one folder per model per run). */
export function benchModelDirName(model: string): string {
  return model.replaceAll("/", "__").replaceAll(":", "__");
}

/** Run id aligned with `results-<runId>.json` filename stem. */
export function benchRunIdFromResultsPath(resultsPath: string): string {
  const base = resultsPath.split("/").pop() ?? resultsPath;
  const match = /^results-(?<id>.+)\.json$/u.exec(base);
  return match?.groups?.["id"] ?? base.replace(/\.json$/u, "");
}

export function benchSummaryRelPath(params: {
  runId: string;
  model: string;
  articleId: number;
  repeat: number;
}): string {
  const file = params.repeat === 0 ? `${params.articleId}.md` : `${params.articleId}-r${params.repeat}.md`;
  return join(PATHS.bench.dataDir, "summaries", params.runId, benchModelDirName(params.model), file);
}

function yamlEscape(value: string): string {
  if (/^[\w\-./:@]+$/u.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function buildSummaryMarkdown(params: {
  article: BenchArticle;
  record: ScoredRunRecord;
  summaryText: string;
}): string {
  const { article, record, summaryText } = params;
  const lines = [
    "---",
    `model: ${yamlEscape(record.model)}`,
    `articleId: ${record.articleId}`,
    `repeat: ${record.repeat}`,
    `title: ${yamlEscape(article.title)}`,
    `url: ${yamlEscape(article.url)}`,
    `latencyMs: ${record.latencyMs}`,
    `outputChars: ${record.outputChars}`,
    `heuristicOk: ${record.heuristic.ok}`,
    ...(record.error === undefined ? [] : [`error: ${yamlEscape(record.error)}`]),
    ...(record.judge === undefined
      ? []
      : [`judgeOverall: ${record.judge.overall}`, `judgeRefusal: ${record.judge.is_refusal}`]),
    "---",
    "",
    summaryText.trim().length > 0 ? summaryText.trim() : "_(empty output)_",
    "",
  ];
  return `${lines.join("\n")}`;
}

export async function writeBenchSummaryMarkdown(params: {
  runId: string;
  article: BenchArticle;
  record: ScoredRunRecord;
  summaryText: string;
}): Promise<string> {
  const rel = benchSummaryRelPath({
    runId: params.runId,
    model: params.record.model,
    articleId: params.record.articleId,
    repeat: params.record.repeat,
  });
  const abs = join(process.cwd(), rel);
  await mkdir(join(abs, ".."), { recursive: true });
  const body = buildSummaryMarkdown({
    article: params.article,
    record: params.record,
    summaryText: params.summaryText,
  });
  await writeFile(abs, body, "utf8");
  return rel;
}

export async function writeBenchRunReadme(params: {
  runId: string;
  resultsPath: string;
  entries: Array<{ relPath: string; record: ScoredRunRecord; title: string }>;
}): Promise<string> {
  const rel = join(PATHS.bench.dataDir, "summaries", params.runId, "README.md");
  const abs = join(process.cwd(), rel);
  await mkdir(join(abs, ".."), { recursive: true });

  const byModel = new Map<string, typeof params.entries>();
  for (const entry of params.entries) {
    const list = byModel.get(entry.record.model) ?? [];
    list.push(entry);
    byModel.set(entry.record.model, list);
  }

  const sections: string[] = [
    `# Bench run ${params.runId}`,
    "",
    `Results JSON: \`${params.resultsPath}\``,
    "",
    "Summaries are grouped by model under this directory.",
    "",
  ];

  for (const [model, items] of [...byModel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    sections.push(`## \`${model}\``, "");
    const modelDir = benchModelDirName(model);
    for (const item of items.sort((a, b) => a.record.articleId - b.record.articleId)) {
      let status: "error" | "heuristic_fail" | "ok";
      if (item.record.error === undefined) {
        status = item.record.heuristic.ok ? "ok" : "heuristic_fail";
      } else {
        status = "error";
      }
      const fileName = item.relPath.split("/").pop() ?? `${item.record.articleId}.md`;
      sections.push(
        `- [${item.record.articleId}](${modelDir}/${fileName}) — ${item.title.slice(0, 72)} (${status}, ${item.record.outputChars} chars)`
      );
    }
    sections.push("");
  }

  await writeFile(abs, `${sections.join("\n")}\n`, "utf8");
  return rel;
}