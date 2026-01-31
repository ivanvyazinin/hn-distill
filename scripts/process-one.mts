#!/usr/bin/env bun

import { env } from "@config/env";
import { makeServices, processSingleStory } from "./summarize.mts";

const STORY_ID = Number.parseInt(process.argv[2], 10);

if (!Number.isInteger(STORY_ID)) {
  // eslint-disable-next-line no-console
  console.error("Usage: bun run scripts/process-one.mts <story-id>");
  process.exit(1);
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`Processing story ${STORY_ID} with TELEGRAM_STREAM=${env.TELEGRAM_STREAM}`);

  const services = makeServices(env);
  await processSingleStory(services, STORY_ID);

  // eslint-disable-next-line no-console
  console.log(`Done! Story ${STORY_ID} processed`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Error:", error);
  process.exit(1);
});
