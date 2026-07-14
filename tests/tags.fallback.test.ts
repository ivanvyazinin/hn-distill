import { describe, expect, mock, test } from "bun:test";

import { withEnvPatch } from "./helpers/env";

const DEFAULT_MODEL = "default-model";

mock.module("@config/openrouter", () => ({
  TAGS_FALLBACK_MODELS: [DEFAULT_MODEL, "fallback-model"] as const,
}));
// NB: do NOT mock "../scripts/summarize.mts" here. The workflow runner is
// injected via __setTagsWorkflowRunnerForTests and ignores the services, so the
// real `makeServices` (which only constructs HTTP/LLM clients, no I/O) is safe
// to call. Mocking summarize.mts with an async factory that re-imports itself
// via `?actual` deadlocks bun 1.2.19 when summarize.mts is already loaded by an
// earlier test file — an order-dependent hang that wedged CI (exit 124).

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
