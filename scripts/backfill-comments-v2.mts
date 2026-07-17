#!/usr/bin/env bun
/**
 * Opt-in comments v2 backfill for explicit story ids (or all structured blobs).
 *
 * Modes:
 *   default           — regenerate stage-1 via processCommentsSummary
 *   --compress-only   — second-pass compress only; never unlinks or re-runs stage 1
 *
 * Discovery:
 *   --ids a,b,c       — explicit ids
 *   --all-structured  — scan data/summaries/*.comments.json
 *
 * Usage:
 *   bun run scripts/backfill-comments-v2.mts --ids 48915004,48919363
 *   bun run scripts/backfill-comments-v2.mts --ids 48915004 --dry-run
 *   bun run scripts/backfill-comments-v2.mts --all-structured --compress-only --dry-run
 *   bun run scripts/backfill-comments-v2.mts --ids 48915004 --compress-only --force
 */

import { readdir, unlink } from "node:fs/promises";

import { env } from "@config/env";
import { PATHS, pathFor } from "@config/paths";
import {
  CommentsSummarySchema,
  NormalizedCommentSchema,
  NormalizedStorySchema,
  PostSummarySchema,
  type CommentsSummary,
  type NormalizedComment,
  type NormalizedStory,
} from "@config/schemas";
import {
  compressSourceHash,
  renderCommentsInsightsPlainText,
  resolveCompressedState,
} from "@utils/comments-compress";
import { renderCompressedParagraphMarkdown } from "@utils/comments-render";
import { createFsStore } from "@utils/fs-store";
import { log } from "@utils/log";
import { openLocalMetaStore } from "@utils/meta-runtime";
import { readJsonSafeOrStore } from "@utils/object-store";

import {
  CommentsGenerationBudget,
  compressCommentsSummaryIfNeeded,
  makeServices,
  processCommentsSummary,
} from "../pipeline/summarize";

const LOG_NAMESPACE = "backfill-comments-v2" as const;

type Options = {
  ids: number[];
  allStructured: boolean;
  compressOnly: boolean;
  dryRun: boolean;
  throttleMs: number;
  force: boolean;
};

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage:
  bun run scripts/backfill-comments-v2.mts --ids id1,id2 [--dry-run] [--force] [--throttle-ms N]
  bun run scripts/backfill-comments-v2.mts --all-structured --compress-only [--dry-run] [--force]

Examples:
  bun run scripts/backfill-comments-v2.mts --ids 48915004,48919363
  bun run scripts/backfill-comments-v2.mts --ids 48915004 --compress-only
  bun run scripts/backfill-comments-v2.mts --all-structured --compress-only --dry-run
`);
}

function parseArgs(args: string[]): Options {
  let ids: number[] = [];
  let allStructured = false;
  let compressOnly = false;
  let dryRun = false;
  let force = false;
  let throttleMs = 0;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--ids") {
      const value = args[i + 1];
      if (typeof value !== "string") {
        throw new Error("--ids requires a comma-separated list");
      }
      ids = value
        .split(",")
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((num) => Number.isInteger(num) && num > 0);
      i += 1;
      continue;
    }
    if (arg === "--all-structured") {
      allStructured = true;
      continue;
    }
    if (arg === "--compress-only") {
      compressOnly = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--throttle-ms") {
      const value = args[i + 1];
      const n = Number.parseInt(value ?? "", 10);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error("--throttle-ms requires a non-negative integer");
      }
      throttleMs = n;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (allStructured && ids.length > 0) {
    throw new Error("--all-structured and --ids are mutually exclusive");
  }
  if (allStructured && !compressOnly) {
    // Stage-1 mass regen must never be implied by a discovery flag alone.
    throw new Error("--all-structured is only supported with --compress-only");
  }
  if (compressOnly && ids.length === 0 && !allStructured) {
    throw new Error("--compress-only requires --ids or --all-structured");
  }
  if (!compressOnly && ids.length === 0) {
    throw new Error("Provide at least one story id via --ids");
  }

  return { ids, allStructured, compressOnly, dryRun, throttleMs, force };
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function discoverStructuredIds(): Promise<number[]> {
  const dir = PATHS.summaries;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    throw new Error(
      `Cannot read summaries dir ${dir}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const ids: number[] = [];
  for (const entry of entries) {
    const match = /^(?<id>\d+)\.comments\.json$/u.exec(entry);
    if (match?.groups?.["id"] === undefined) {
      continue;
    }
    const id = Number.parseInt(match.groups["id"], 10);
    if (Number.isInteger(id) && id > 0) {
      ids.push(id);
    }
  }
  ids.sort((a, b) => a - b);
  return ids;
}

async function resolveIds(options: Options): Promise<number[]> {
  if (options.allStructured) {
    if (options.ids.length > 0) {
      // Belt-and-suspenders: parseArgs already rejects the combo.
      throw new Error("--all-structured and --ids are mutually exclusive");
    }
    return await discoverStructuredIds();
  }
  return options.ids;
}

function compressDecision(
  existing: CommentsSummary | undefined,
  force: boolean
): { action: "skip" | "compress"; reason: string; sourceHash?: string } {
  if (existing === undefined) {
    return { action: "skip", reason: "no-blob" };
  }
  if (existing.formatVersion !== 2 || existing.structured === undefined) {
    return { action: "skip", reason: "not-structured" };
  }
  if (existing.degraded !== undefined) {
    return { action: "skip", reason: `degraded:${existing.degraded}` };
  }
  const plainText = renderCommentsInsightsPlainText(existing.structured);
  const sourceHash = compressSourceHash(existing.lang, plainText);
  if (force) {
    return { action: "compress", reason: "force", sourceHash };
  }
  const state = resolveCompressedState(existing, sourceHash);
  if (state === "retryable") {
    return { action: "compress", reason: "retryable", sourceHash };
  }
  return { action: "skip", reason: `state:${state}`, sourceHash };
}

async function runCompressOnly(
  options: Options,
  ids: number[]
): Promise<{ succeeded: number; skipped: number; failed: number }> {
  const store = createFsStore();
  const services = makeServices(env);
  const meta = await openLocalMetaStore();
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  log.info(LOG_NAMESPACE, "Starting comments compress-only backfill", {
    ids,
    dryRun: options.dryRun,
    force: options.force,
    model: env.COMMENTS_COMPRESS_MODEL,
    lang: env.SUMMARY_LANG,
  });

  try {
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      if (id === undefined) {
        continue;
      }
      const commentsPath = pathFor.commentsSummary(id);
      const existing = await readJsonSafeOrStore(store, commentsPath, CommentsSummarySchema.nullable());
      const decision = compressDecision(existing ?? undefined, options.force);

      if (decision.action === "skip") {
        log.info(LOG_NAMESPACE, "Compress-only skip", { id, reason: decision.reason });
        skipped += 1;
        continue;
      }

      if (options.dryRun) {
        log.info(LOG_NAMESPACE, "Dry-run would compress", {
          id,
          reason: decision.reason,
          sourceHash: decision.sourceHash,
          hasCompressed: existing?.compressed !== undefined,
        });
        skipped += 1;
        continue;
      }

      // Never unlink in compress-only mode. On --force, strip compressed only in
      // the in-memory request so compressCommentsSummaryIfNeeded re-runs; the
      // on-disk blob is rewritten ONLY on usable/rejected so a transport miss or
      // env gate cannot destroy a previously good compressed field.
      const onDisk = existing as CommentsSummary;
      let requestSummary = onDisk;
      if (options.force && requestSummary.compressed !== undefined) {
        const { compressed: _drop, ...rest } = requestSummary;
        requestSummary = rest;
      }

      try {
        const budget = new CommentsGenerationBudget({ maxCalls: 1 });
        const result = await compressCommentsSummaryIfNeeded(services, requestSummary, budget);

        if (result.status === "usable" || result.status === "rejected") {
          await store.putJson(commentsPath, result.summary, {
            pretty: true,
            contentType: "application/json",
          });
          if (meta !== undefined) {
            const metaText =
              result.status === "usable" && result.summary.compressed !== undefined
                ? renderCompressedParagraphMarkdown(result.summary.compressed.text)
                : result.summary.summary;
            await meta.upsertSummary({
              storyId: result.summary.id,
              kind: "comments",
              lang: result.summary.lang,
              ...(result.summary.model === undefined ? {} : { model: result.summary.model }),
              summary: metaText,
              createdAt: result.summary.createdISO ?? new Date().toISOString(),
            });
          }
        }

        if (result.status === "pending") {
          log.warn(LOG_NAMESPACE, "Compress pending (transport/budget); left on-disk blob untouched", {
            id,
          });
          failed += 1;
        } else if (result.status === "rejected") {
          log.warn(LOG_NAMESPACE, "Compress rejected (semantic marker written)", { id });
          succeeded += 1;
        } else if (result.status === "usable") {
          log.info(LOG_NAMESPACE, "Compress written", {
            id,
            chars: result.summary.compressed?.text.length,
            model: result.summary.compressed?.model,
          });
          succeeded += 1;
        } else {
          log.info(LOG_NAMESPACE, "Compress skipped by gates; left on-disk blob untouched", { id });
          skipped += 1;
        }
      } catch (error) {
        failed += 1;
        log.error(LOG_NAMESPACE, "Compress-only failed", {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (index < ids.length - 1) {
        await sleep(options.throttleMs);
      }
    }
  } finally {
    await meta?.close();
  }

  return { succeeded, skipped, failed };
}

async function runStage1(options: Options, ids: number[]): Promise<{ succeeded: number; skipped: number; failed: number }> {
  const store = createFsStore();
  const services = makeServices(env);
  const meta = await openLocalMetaStore();
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  log.info(LOG_NAMESPACE, "Starting comments v2 backfill", {
    ids,
    dryRun: options.dryRun,
    force: options.force,
    throttleMs: options.throttleMs,
    model: env.OPENROUTER_MODEL,
    baseUrl: env.OPENROUTER_BASE_URL ?? "default-openrouter",
    lang: env.SUMMARY_LANG,
    telegram: env.TELEGRAM_ENABLE,
  });

  try {
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      if (id === undefined) {
        continue;
      }

      const commentsPath = pathFor.commentsSummary(id);
      const existing = await readJsonSafeOrStore(store, commentsPath, CommentsSummarySchema.nullable());
      const alreadyV2 = existing?.formatVersion === 2 && existing.structured !== undefined;

      if (alreadyV2 && !options.force) {
        log.info(LOG_NAMESPACE, "Already comments v2; skipping", { id, model: existing?.model });
        skipped += 1;
        continue;
      }

      const story = await readJsonSafeOrStore<NormalizedStory>(
        store,
        pathFor.rawItem(id),
        NormalizedStorySchema as never
      );
      if (!story) {
        log.error(LOG_NAMESPACE, "Missing raw item; cannot backfill", { id });
        failed += 1;
        continue;
      }

      const comments =
        (await readJsonSafeOrStore<NormalizedComment[]>(
          store,
          pathFor.rawComments(id),
          NormalizedCommentSchema.array() as never,
          []
        )) ?? [];
      const post = await readJsonSafeOrStore(store, pathFor.postSummary(id), PostSummarySchema);

      if (options.dryRun) {
        log.info(LOG_NAMESPACE, "Dry-run would regenerate", {
          id,
          comments: comments.length,
          hasPost: post !== undefined,
          existingFormatVersion: existing?.formatVersion ?? null,
          existingModel: existing?.model,
        });
        skipped += 1;
        continue;
      }

      try {
        if (existing) {
          try {
            await unlink(commentsPath);
            log.info(LOG_NAMESPACE, "Removed legacy comments summary", { id, path: commentsPath });
          } catch (error) {
            log.warn(LOG_NAMESPACE, "Could not unlink legacy comments summary", {
              id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        log.info(LOG_NAMESPACE, "Processing comments", {
          id,
          progress: `${index + 1}/${ids.length}`,
          comments: comments.length,
        });

        const result = await processCommentsSummary(
          services,
          story,
          comments,
          post,
          commentsPath,
          store,
          meta ?? undefined
        );

        if (result.status === "applied" && result.summary.formatVersion === 2) {
          log.info(LOG_NAMESPACE, "Comments v2 written", {
            id,
            model: result.summary.model,
            degraded: result.summary.degraded,
            chars: result.summary.summary.length,
            insights: result.summary.structured?.insights.length,
            compressed: result.summary.compressed === undefined ? "absent" : "present",
          });
          succeeded += 1;
        } else {
          log.error(LOG_NAMESPACE, "Comments v2 not applied", {
            id,
            status: result.status,
            reason: "reason" in result ? result.reason : undefined,
          });
          failed += 1;
        }
      } catch (error) {
        failed += 1;
        log.error(LOG_NAMESPACE, "Failed to process story", {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (index < ids.length - 1) {
        await sleep(options.throttleMs);
      }
    }
  } finally {
    await meta?.close();
  }

  return { succeeded, skipped, failed };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const ids = await resolveIds(options);
  if (ids.length === 0) {
    log.warn(LOG_NAMESPACE, "No story ids to process");
    return;
  }

  const stats = options.compressOnly
    ? await runCompressOnly(options, ids)
    : await runStage1(options, ids);

  log.info(LOG_NAMESPACE, "Backfill complete", {
    total: ids.length,
    ...stats,
  });

  if (stats.failed > 0) {
    process.exitCode = 1;
  }
}

// Exported for unit tests.
export { compressDecision, parseArgs, discoverStructuredIds };

if (import.meta.main) {
  main().catch((error) => {
    log.error(LOG_NAMESPACE, "Fatal error", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
