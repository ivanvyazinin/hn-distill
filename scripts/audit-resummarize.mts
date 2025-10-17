#!/usr/bin/env bun

import { createHash } from "node:crypto";

import { env } from "@config/env";
import { PATHS, pathFor } from "@config/paths";
import {
  IndexSchema,
  NormalizedStorySchema,
  PostSummarySchema,
  type NormalizedStory,
  type PostSummary,
} from "@config/schemas";
import { readJsonSafeOr, writeJsonFile } from "@utils/json";
import { log } from "@utils/log";
import { runSummaryGuard } from "@utils/summary-guard";
import { checkSummaryHeuristics } from "@utils/summary-heuristics";

import {
  buildPostPrompt,
  generateValidatedPostSummary,
  getOrFetchArticleMarkdown,
  makeServices,
} from "./summarize.mts";

import type { z } from "zod";

type Mode = "audit" | "fix";

type CliOptions = {
  mode: Mode;
  ids?: number[];
};

type AuditVerdict = {
  id: number;
  status: "guard_fail" | "heuristics_fail" | "missing" | "no_prompt" | "ok";
  reasons?: string[];
};

const argv = process.argv.slice(2);
const LOG_NAMESPACE = "audit-resummarize" as const;
type IndexData = z.infer<typeof IndexSchema>;

async function main(): Promise<void> {
  const options = parseArgs(argv);
  const services = makeServices(env);
  const storyIds = options.ids ?? (await discoverStoryIds());

  if (storyIds.length === 0) {
    log.info(LOG_NAMESPACE, "No stories to process");
    return;
  }

  const results: AuditVerdict[] = [];
  const failures: AuditVerdict[] = [];

  for (const id of storyIds) {
    const verdict = await evaluateStory(id, services, options.mode);
    results.push(verdict);
    if (verdict.status !== "ok") {
      failures.push(verdict);
    }
  }

  printReport(results, options.mode);

  if (options.mode === "fix" && failures.length > 0) {
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): CliOptions {
  let mode: Mode | undefined;
  let ids: number[] | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--mode") {
      const value = args[i + 1];
      if (typeof value === "string" && (value === "audit" || value === "fix")) {
        mode = value;
      } else {
        throw new Error(`Unknown mode: ${value}`);
      }
      i += 1;
      continue;
    }
    if (arg === "--ids") {
      const value = args[i + 1];
      if (typeof value === "string") {
        ids = value
          .split(",")
          .map((part) => Number.parseInt(part.trim(), 10))
          .filter((num) => Number.isInteger(num));
        i += 1;
        continue;
      }
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  const result: CliOptions = { mode: mode ?? "audit" };
  if (ids && ids.length > 0) {
    result.ids = ids;
  }
  return result;
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage: bun run scripts/audit-resummarize.mts --mode <audit|fix> [--ids id1,id2]

Examples:
  bun run scripts/audit-resummarize.mts --mode audit
  bun run scripts/audit-resummarize.mts --mode fix --ids 45617088,45606698
`);
}

async function discoverStoryIds(): Promise<number[]> {
  const index = await readJsonSafeOr<IndexData>(PATHS.index, IndexSchema);
  if (index && Array.isArray(index.storyIds)) {
    return index.storyIds;
  }
  return [];
}

async function evaluateStory(id: number, services: ReturnType<typeof makeServices>, mode: Mode): Promise<AuditVerdict> {
  const story = await readJsonSafeOr(pathFor.rawItem(id), NormalizedStorySchema.nullable());

  if (!story) {
    log.warn(LOG_NAMESPACE, "Missing normalized story", { id });
    return { id, status: "missing" };
  }

  const postPath = pathFor.postSummary(id);
  const existing = await readJsonSafeOr(postPath, PostSummarySchema);

  const articleMd = await getOrFetchArticleMarkdown(services, story);
  const prompt = await buildPostPrompt(story, articleMd);

  if (!prompt) {
    log.warn(LOG_NAMESPACE, "No prompt available for story", { id });
    return { id, status: "no_prompt" };
  }

  if (mode === "audit") {
    return await auditOnly(id, existing, services, prompt);
  }

  return await fixStory(id, existing, services, prompt, story, postPath);
}

async function auditOnly(
  id: number,
  existing: PostSummary | undefined,
  services: ReturnType<typeof makeServices>,
  prompt: string
): Promise<AuditVerdict> {
  if (!existing?.summary) {
    return { id, status: "missing" };
  }

  const heuristics = checkSummaryHeuristics(existing.summary, {
    minChars: env.POST_SUMMARY_MIN_CHARS,
    language: env.SUMMARY_LANG,
  });

  if (!heuristics.ok) {
    return { id, status: "heuristics_fail", reasons: heuristics.triggers.map((t) => t.reason) };
  }

  if (!env.POST_GUARD_ENABLE) {
    return { id, status: "ok" };
  }

  const guardVerdict = await evaluateGuard(existing.summary, prompt, services);
  if (!guardVerdict.ok) {
    return { id, status: "guard_fail", reasons: guardVerdict.reasons };
  }

  return { id, status: "ok", reasons: guardVerdict.reasons };
}

async function fixStory(
  id: number,
  existing: PostSummary | undefined,
  services: ReturnType<typeof makeServices>,
  prompt: string,
  story: NormalizedStory,
  postPath: string
): Promise<AuditVerdict> {
  let needsFix = !existing?.summary;
  let reasons: string[] = [];

  if (existing?.summary) {
    const heuristics = checkSummaryHeuristics(existing.summary, {
      minChars: env.POST_SUMMARY_MIN_CHARS,
      language: env.SUMMARY_LANG,
    });
    if (!heuristics.ok) {
      needsFix = true;
      reasons = heuristics.triggers.map((t) => t.reason);
    } else if (env.POST_GUARD_ENABLE) {
      const guardVerdict = await evaluateGuard(existing.summary, prompt, services);
      if (!guardVerdict.ok) {
        needsFix = true;
        reasons = guardVerdict.reasons;
      }
    }
  }

  if (!needsFix) {
    return { id, status: "ok" };
  }

  const validated = await generateValidatedPostSummary(services, story, prompt);
  if (!validated) {
    return { id, status: "guard_fail", reasons: reasons.length > 0 ? reasons : ["generation_failed"] };
  }

  const payload: PostSummary = {
    id,
    lang: env.SUMMARY_LANG,
    summary: validated.summary,
    inputHash: hashString(`${env.SUMMARY_LANG}|${prompt}`),
    model: validated.modelUsed,
    createdISO: new Date().toISOString(),
    ...(validated.guard
      ? {
          guard: {
            ok: validated.guard.ok,
            verdict: validated.guard.verdict,
            reasons: validated.guard.reasons,
            confidence: validated.guard.confidence,
          },
        }
      : {}),
  };

  await writeJsonFile(postPath, payload, { atomic: true, pretty: true });

  return { id, status: "ok" };
}

async function evaluateGuard(
  summary: string,
  prompt: string,
  services: ReturnType<typeof makeServices>
): Promise<{ ok: boolean; reasons: string[] }> {
  if (!env.POST_GUARD_ENABLE) {
    return { ok: true, reasons: [] };
  }
  const verdict = await runSummaryGuard(services.openrouter, {
    summary,
    articleSlice: prompt,
    envLike: {
      SUMMARY_LANG: env.SUMMARY_LANG,
      POST_GUARD_MODEL: env.POST_GUARD_MODEL,
      POST_GUARD_MAX_TOKENS: env.POST_GUARD_MAX_TOKENS,
      POST_GUARD_MIN_CONFIDENCE: env.POST_GUARD_MIN_CONFIDENCE,
      POST_GUARD_ARTICLE_MAX_CHARS: env.POST_GUARD_ARTICLE_MAX_CHARS,
    },
  });
  return { ok: verdict.ok, reasons: verdict.reasons };
}

function printReport(results: AuditVerdict[], mode: Mode): void {
  const rows = results.map((res) => {
    const reasons = res.reasons?.length ? `\t${res.reasons.join(",")}` : "";
    return `${res.id}\t${res.status}${reasons}`;
  });
  const hasReasons = rows.some((row) => row.includes("\t", row.indexOf("\t") + 1));
  const header = hasReasons ? "id\tstatus\treasons" : "id\tstatus";
  // eslint-disable-next-line no-console
  console.log(`Mode: ${mode}\n${header}\n${rows.join("\n")}`);
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

main().catch((error) => {
  log.error(LOG_NAMESPACE, "Fatal error", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
