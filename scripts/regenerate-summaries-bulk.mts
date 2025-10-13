import { access, readdir } from "node:fs/promises";

import { env } from "@config/env";
import { pathFor } from "@config/paths";
import { NormalizedStorySchema } from "@config/schemas";
import { readJsonSafeOr } from "@utils/json";
import { log } from "@utils/log";

import { makeServices, processSingleStory } from "./summarize.mts";

import type { NormalizedStory } from "@config/schemas";

const LOG_NAMESPACE = "regenerate-summaries-bulk";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function getItemIds(): Promise<number[]> {
  log.info(LOG_NAMESPACE, "Reading all items from data/raw/items/...");

  const itemFiles = await readdir("data/raw/items");
  const itemIds = itemFiles
    .filter((f) => f.endsWith(".json"))
    .map((f) => Number.parseInt(f.replace(".json", ""), 10))
    .filter((id) => !Number.isNaN(id))
    .sort((a, b) => b - a); // Sort by ID descending (newer first)

  log.info(LOG_NAMESPACE, `Found ${itemIds.length} items`);
  return itemIds;
}

async function findStoriesNeedingSummaries(itemIds: number[]): Promise<number[]> {
  log.info(LOG_NAMESPACE, "Finding stories that need summaries...");

  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  const oneMonthAgoMs = oneMonthAgo.getTime();

  const storiesNeedingSummaries: number[] = [];

  for (const id of itemIds) {
    try {
      const story = await readJsonSafeOr<NormalizedStory>(pathFor.rawItem(id), NormalizedStorySchema);

      if (!story) {
        continue;
      }

      const storyTime = story.timeISO ? Date.parse(story.timeISO) : 0;
      if (storyTime < oneMonthAgoMs) {
        continue;
      }

      const hasPost = await fileExists(pathFor.postSummary(id));
      const hasComments = await fileExists(pathFor.commentsSummary(id));

      if (!hasPost || !hasComments) {
        storiesNeedingSummaries.push(id);
      }
    } catch {
      // Skip invalid JSON files or other errors
    }
  }

  log.info(LOG_NAMESPACE, "Found stories needing summaries", {
    count: storiesNeedingSummaries.length,
  });

  return storiesNeedingSummaries;
}

async function main(): Promise<void> {
  const itemIds = await getItemIds();
  const storiesNeedingSummaries = await findStoriesNeedingSummaries(itemIds);

  if (storiesNeedingSummaries.length === 0) {
    log.info(LOG_NAMESPACE, "No stories need regeneration");
    return;
  }

  const services = makeServices(env);
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const id of storiesNeedingSummaries) {
    processed++;
    log.info(LOG_NAMESPACE, `Processing story ${processed}/${storiesNeedingSummaries.length}`, { id });

    try {
      await processSingleStory(services, id);
      succeeded++;

      // Add a small delay between requests to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      failed++;
      log.error(LOG_NAMESPACE, "Failed to process story", {
        id,
        error: error instanceof Error ? error.message : String(error),
      });

      // If we hit a rate limit error, stop processing
      if (error instanceof Error && error.message.includes("rate limit")) {
        log.warn(LOG_NAMESPACE, "Rate limit hit, stopping", {
          processed,
          succeeded,
          failed,
          remaining: storiesNeedingSummaries.length - processed,
        });
        break;
      }
    }
  }

  log.info(LOG_NAMESPACE, "Regeneration complete", {
    total: storiesNeedingSummaries.length,
    processed,
    succeeded,
    failed,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    log.error(LOG_NAMESPACE, "Fatal error", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
