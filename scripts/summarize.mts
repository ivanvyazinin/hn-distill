import { env, type Env } from "@config/env";
import type { NormalizedStory } from "@config/schemas";
import { createFsStore } from "@utils/fs-store";
import { openLocalMetaStore } from "@utils/meta-runtime";
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

export async function getOrFetchArticleMarkdown(services: Services, story: NormalizedStory) {
  const store = createFsStore();
  return await getOrFetchArticleMarkdownCore(services, story, store);
}

export async function processSingleStory(services: Services, id: number): Promise<void> {
  const store = createFsStore();
  await processSingleStoryCore(services, id, store);
}

export async function summarizeWorkflow(services: Services, e: Env = env): Promise<void> {
  const store = createFsStore();
  const meta = await openLocalMetaStore();
  await summarizeWorkflowCore(services, e, store, meta ?? undefined);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const services = makeServices(env);
  summarizeWorkflow(services, env).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
