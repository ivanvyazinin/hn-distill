import { describe, expect, mock, test } from "bun:test";

import { withEnvPatch } from "./helpers/env";

const DEFAULT_MODEL = "default-model";

mock.module("@config/openrouter", () => ({
  TAGS_FALLBACK_MODELS: [DEFAULT_MODEL, "fallback-model"] as const,
}));
mock.module("../scripts/summarize.mts", async () => {
  const actual = await import("../scripts/summarize.mts?actual");
  return {
    ...actual,
    makeServices: () => ({
      http: {},
      openrouter: {},
      guardTagsClient: {},
      fetchArticleMarkdown: async () => ({ md: "", sourceKind: "empty" }),
    }),
  };
});

describe("tags bulk fallback handling", () => {
  test("switches to a different model after rate limit", async () => {
    await withEnvPatch(
      {
        TAGS_MODEL: DEFAULT_MODEL,
        TAGS_MAX_PER_STORY: 5,
        TAGS_LANG: "en",
        OPENROUTER_API_KEY: "test-key",
      },
      async () => {
        const { runTagsWorkflowWithFallback, __setTagsWorkflowRunnerForTests, __resetTagsModelRotationForTests } =
          await import("../scripts/add-tags-bulk.mts");

        __resetTagsModelRotationForTests();
        const usedModels: string[] = [];
        const workflowMock = mock(async (_services: unknown, _storyIds: number[], customEnv: { TAGS_MODEL: string }) => {
          usedModels.push(customEnv.TAGS_MODEL);
          if (usedModels.length === 1) {
            throw new Error("HTTP 429 rate limit");
          }
        });

        __setTagsWorkflowRunnerForTests(workflowMock);
        try {
          await runTagsWorkflowWithFallback([101]);
          expect(workflowMock).toHaveBeenCalledTimes(2);
          expect(usedModels).toEqual([DEFAULT_MODEL, "fallback-model"]);
        } finally {
          __resetTagsModelRotationForTests();
        }
      }
    );
  });
});
