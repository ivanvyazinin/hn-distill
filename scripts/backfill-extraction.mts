#!/usr/bin/env bun
/**
 * One-time, opt-in migration for the Readability extraction + garbage-detector
 * change (docs/product-review-summarization.md §1).
 *
 * Article Markdown is cached (fs / R2) and it is POST-turndown of the whole page,
 * so Readability can only help on a re-fetch. This script invalidates the cached
 * raw article Markdown for a target story set so the next summarize run re-fetches
 * and re-extracts through Readability + the detector.
 *
 * Reselection itself is automatic: EXTRACT_POLICY_VERSION is folded into the post
 * inputHash, so every existing post summary's hash differs and computePostChanged
 * reselects it on the next local run (unless POST_SUMMARY_ONLY_IF_MISSING=true).
 *
 * Cloudflare/D1 worker topology only: listPendingStoryIds excludes post_status='ok',
 * so also reset post_status for the target stories with wrangler, e.g.:
 *   bunx wrangler d1 execute hn_distill --remote \
 *     --command "UPDATE processing_state SET post_status='missing'"
 *
 * Usage:
 *   set -a; source .env; set +a
 *   bun run tsx scripts/backfill-extraction.mts            # all stories in the index
 *   bun run tsx scripts/backfill-extraction.mts --ids 48845049,48849066
 *   bun run tsx scripts/backfill-extraction.mts --dry-run
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

function parseArgs(args: string[]): CliOptions {
  let ids: number[] | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--ids") {
      const value = args[i + 1];
      if (typeof value === "string") {
        ids = value
          .split(",")
          .map((part) => Number.parseInt(part.trim(), 10))
          .filter((num) => Number.isInteger(num));
        i += 1;
      }
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
  }
  return ids && ids.length > 0 ? { ids, dryRun } : { dryRun };
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
      `For the D1 worker, also reset post_status via wrangler (see file header).`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
