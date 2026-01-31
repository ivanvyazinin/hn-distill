import { createFsStore } from "@utils/fs-store";

import {
  buildAggregatedItem,
  extractDomain,
  fallbackFromRaw,
  main as coreMain,
  makeServices,
  readAggregates as readAggregatesCore,
  sortItemsDesc,
} from "../pipeline/aggregate";

export { buildAggregatedItem, extractDomain, fallbackFromRaw, makeServices, sortItemsDesc };

export async function readAggregates(storyIds: number[]) {
  const store = createFsStore();
  return await readAggregatesCore(storyIds, store);
}

export async function main(): Promise<void> {
  const store = createFsStore();
  await coreMain(store);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
