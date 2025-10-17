import { describe, expect, mock, test } from "bun:test";

const DEFAULT_MODEL = "default-model";

const envStub = {
  TAGS_MODEL: DEFAULT_MODEL,
  TAGS_MAX_PER_STORY: 5,
  TAGS_LANG: "en",
  OPENROUTER_API_KEY: "test-key",
} as const;

mock.module("@config/env", () => ({ env: envStub }));
mock.module("@config/openrouter", () => ({
  TAGS_FALLBACK_MODELS: [DEFAULT_MODEL, "fallback-model"] as const,
}));
mock.module("../scripts/summarize.mts", () => ({
  makeServices: () => ({
    http: {},
    openrouter: {},
    fetchArticleMarkdown: async () => "",
  }),
}));

describe("tags bulk fallback handling", () => {
  test("switches to a different model after rate limit", async () => {
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
  });
});
