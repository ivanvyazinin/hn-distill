#!/usr/bin/env bun
/**
 * OPTIONAL targeted tool for the Readability extraction change
 * (docs/product-review-summarization.md §1).
 *
 * NOTE: the bulk migration is automatic on local workflow runs and opt-in for the
 * worker; you usually do NOT need this script.
 * Legacy cached article Markdown (pre-Readability, whole-page turndown) is written
 * without a `sourceKind`, so getOrFetchArticleMarkdown re-fetches + re-extracts it on
 * the next run — for both FS (local) and R2 (worker). Post reselection is likewise
 * automatic via EXTRACT_POLICY_VERSION in the post inputHash. For the worker, use
 * WORKER_EXTRACTION_BACKFILL_ENABLE as documented in docs/architecture.md; resetting
 * post_status alone does not select history outside the current TOP_N fetch.
 *
 * Use this script only to force a re-fetch of SPECIFIC stories WITHOUT bumping the
 * policy (e.g. one article changed upstream). It invalidates the cached FS article md
 * so the next `data:summarize` re-fetches. FS topology only (Node can't reach worker R2).
 *
 * Usage:
 *   set -a; source .env; set +a
 *   bun run tsx scripts/backfill-extraction.mts --ids 48845049,48849066
 *   bun run tsx scripts/backfill-extraction.mts --dry-run   # all stories in the index
 */

import { PATHS, pathFor } from "@config/paths";
import { IndexSchema } from "@config/schemas";
import { createFsStore } from "@utils/fs-store";
import { readJsonSafeOr } from "@utils/json";
import { log } from "@utils/log";

import type { z } from "zod";

const LOG_NAMESPACE = "backfill-extraction" as const;
type IndexData = z.infer<typeof IndexSchema>;

type CliOptions = { ids?: number[]; dryRun: boolean };

function parseIds(value: string | undefined): number[] {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("--ids requires a comma-separated list of positive integer story IDs");
  }
  const tokens = value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const ids: number[] = [];
  for (const token of tokens) {
    // Strict: reject "not-an-id", "123abc", negatives, 0. Fail closed — a typo must
    // never silently fall back to invalidating the entire index.
    if (!/^\d+$/u.test(token)) {
      throw new Error(`--ids: invalid story ID ${JSON.stringify(token)} (expected a positive integer)`);
    }
    const num = Number.parseInt(token, 10);
    if (!Number.isSafeInteger(num) || num <= 0) {
      throw new Error(`--ids: story ID out of range: ${token}`);
    }
    ids.push(num);
  }
  if (ids.length === 0) {
    throw new Error("--ids was provided but contained no valid story IDs");
  }
  return ids;
}

function parseArgs(args: string[]): CliOptions {
  let ids: number[] | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--ids") {
      ids = parseIds(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${String(arg)}`);
  }
  return ids ? { ids, dryRun } : { dryRun };
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage: bun run tsx scripts/backfill-extraction.mts [--ids id1,id2] [--dry-run]

Invalidates cached raw article Markdown so the next summarize run re-fetches and
re-extracts through Readability + the extract-quality detector. One-time, opt-in.`);
}

async function discoverStoryIds(): Promise<number[]> {
  const index = await readJsonSafeOr<IndexData>(PATHS.index, IndexSchema);
  return index && Array.isArray(index.storyIds) ? index.storyIds : [];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const store = createFsStore();
  const storyIds = options.ids ?? (await discoverStoryIds());

  if (storyIds.length === 0) {
    log.info(LOG_NAMESPACE, "No stories to process");
    return;
  }

  let invalidated = 0;
  let absent = 0;
  for (const id of storyIds) {
    const path = pathFor.articleMd(id);
    const cached = await store.getText(path);
    if (!cached?.trim()) {
      absent += 1;
      continue;
    }
    if (options.dryRun) {
      log.info(LOG_NAMESPACE, "Would invalidate cached article md", { id, path, chars: cached.length });
      invalidated += 1;
      continue;
    }
    // The store has no delete; an empty body reads as "no cache" (getOrFetch trims),
    // forcing a re-fetch + Readability re-extract on the next run.
    await store.putText(path, "", { contentType: "text/markdown" });
    invalidated += 1;
  }

  log.info(LOG_NAMESPACE, "Backfill complete", {
    total: storyIds.length,
    invalidated,
    absent,
    dryRun: options.dryRun,
  });
  // eslint-disable-next-line no-console
  console.log(
    `Invalidated ${invalidated}/${storyIds.length} cached article md file(s)${
      options.dryRun ? " (dry-run)" : ""
    }. ` +
      `Next 'bun run data:summarize' will re-fetch + re-extract. ` +
      `For the D1 worker, use the opt-in migration drain documented in docs/architecture.md.`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
