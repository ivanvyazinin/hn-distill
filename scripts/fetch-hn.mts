import { createFsStore } from "@utils/fs-store";
import { openLocalMetaStore } from "@utils/meta-runtime";

import {
  collectComments,
  fetchItem,
  main as coreMain,
  makeServices,
  normalizeStory,
  readSeenCache,
  readTopIds,
  type Services,
} from "../pipeline/fetch-hn";

export type { Services } from "../pipeline/fetch-hn";
export { collectComments, fetchItem, makeServices, normalizeStory, readSeenCache, readTopIds };

export async function main(servicesOverride?: Services): Promise<{ updatedISO: string; storyIds: number[] }> {
  const store = createFsStore();
  const meta = await openLocalMetaStore();
  return await coreMain(servicesOverride, store, meta ?? undefined);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
