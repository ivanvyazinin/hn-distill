import { env, type Env } from "@config/env";
import { createFsStore } from "@utils/fs-store";
import { openLocalMetaStore, type LocalMetaStore } from "@utils/meta-runtime";
import { pdfToText } from "@utils/pdf";

import {
  RateLimitError,
  buildCommentsPrompt,
  buildPostChatMessages,
  buildPostPrompt,
  generateValidatedPostSummary,
  getOrFetchArticleMarkdown as getOrFetchArticleMarkdownCore,
  preserveMarkdownWhitespace,
  processSingleStory as processSingleStoryCore,
  summarizeComments,
  summarizePost,
  summarizeWorkflow as summarizeWorkflowCore,
  makeServices as makeServicesCore,
  type Services,
} from "../pipeline/summarize";

import type { NormalizedStory } from "@config/schemas";

export type { Services } from "../pipeline/summarize";
export {
  RateLimitError,
  buildCommentsPrompt,
  buildPostChatMessages,
  buildPostPrompt,
  generateValidatedPostSummary,
  preserveMarkdownWhitespace,
  summarizeComments,
  summarizePost,
};

export function makeServices(e: Env): Services {
  return makeServicesCore(e, { pdfToText });
}

type LocalMetaOptions = {
  /** Test seam; normal script callers always use openLocalMetaStore. */
  openMetaStore?: () => Promise<LocalMetaStore | undefined>;
};

async function withLocalMeta<T>(
  options: LocalMetaOptions | undefined,
  fn: (meta?: LocalMetaStore) => Promise<T>
): Promise<T> {
  const meta = await (options?.openMetaStore ?? openLocalMetaStore)();
  try {
    return await fn(meta);
  } finally {
    await meta?.close();
  }
}

export async function getOrFetchArticleMarkdown(
  services: Services,
  story: NormalizedStory,
  options?: LocalMetaOptions
): Promise<string | undefined> {
  const store = createFsStore();
  return await withLocalMeta(options, async (meta) => {
    const { md } = await getOrFetchArticleMarkdownCore(services, story, store, meta);
    return md;
  });
}

export async function processSingleStory(services: Services, id: number, options?: LocalMetaOptions): Promise<void> {
  const store = createFsStore();
  await withLocalMeta(options, async (meta) => {
    await processSingleStoryCore(services, id, store, meta);
  });
}

export async function summarizeWorkflow(services: Services, e: Env = env): Promise<void> {
  const store = createFsStore();
  await withLocalMeta(undefined, async (meta) => {
    await summarizeWorkflowCore(services, e, store, meta);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const services = makeServices(env);
  summarizeWorkflow(services, env).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
