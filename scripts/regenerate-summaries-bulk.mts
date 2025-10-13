import { env } from "@config/env";
import { pathFor } from "@config/paths";
import { NormalizedStorySchema } from "@config/schemas";
import { readJsonSafeOr } from "@utils/json";
import { log } from "@utils/log";
import { access, readdir } from "node:fs/promises";
import { makeServices, processSingleStory } from "./summarize.mts";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log("Reading all items from data/raw/items/...");

  const itemFiles = await readdir("data/raw/items");
  const itemIds = itemFiles
    .filter((f) => f.endsWith(".json"))
    .map((f) => parseInt(f.replace(".json", "")))
    .filter((id) => !isNaN(id))
    .sort((a, b) => b - a); // Sort by ID descending (newer first)

  console.log(`Found ${itemIds.length} items`);

  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  const oneMonthAgoMs = oneMonthAgo.getTime();

  const storiesNeedingSummaries: number[] = [];

  console.log("Finding stories that need summaries...");

  for (const id of itemIds) {
    try {
      const story = await readJsonSafeOr(pathFor.rawItem(id), NormalizedStorySchema as any);

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
    } catch (error) {
      // Skip
    }
  }

  log.info("regenerate-bulk", "Found stories needing summaries", {
    count: storiesNeedingSummaries.length,
  });

  if (storiesNeedingSummaries.length === 0) {
    log.info("regenerate-bulk", "No stories need regeneration");
    return;
  }

  const services = makeServices(env);
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const id of storiesNeedingSummaries) {
    processed++;
    log.info("regenerate-bulk", `Processing story ${processed}/${storiesNeedingSummaries.length}`, { id });

    try {
      await processSingleStory(services, id);
      succeeded++;

      // Add a small delay between requests to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      failed++;
      log.error("regenerate-bulk", "Failed to process story", {
        id,
        error: error instanceof Error ? error.message : String(error),
      });

      // If we hit a rate limit error, stop processing
      if (error instanceof Error && error.message.includes("rate limit")) {
        log.warn("regenerate-bulk", "Rate limit hit, stopping", {
          processed,
          succeeded,
          failed,
          remaining: storiesNeedingSummaries.length - processed,
        });
        break;
      }
    }
  }

  log.info("regenerate-bulk", "Regeneration complete", {
    total: storiesNeedingSummaries.length,
    processed,
    succeeded,
    failed,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

