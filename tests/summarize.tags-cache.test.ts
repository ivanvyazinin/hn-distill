import { describe, expect, test } from "bun:test";

import type { CommentsInsights, NormalizedComment, NormalizedStory } from "../config/schemas";
import type { Services } from "../pipeline/summarize";
import { createUsageCollector } from "../utils/llm-usage";
import type { ObjectStore } from "../utils/object-store";
import type { ChatMessage, StructuredOutputOptions } from "../utils/openrouter";
import { comment as makeComment, mockPaths, story as makeStory, withEnvPatch, withTempDir } from "./helpers";

// Cache-gate integration test for the tags input hash. It drives the real
// processSingleStory against an on-disk store (createFsStore + mockPaths + withTempDir)
// so the actual cache gate in processTags runs. The point is the CONTRACT and the
// tag-call count, not the LLM tag content, so all LLM responses are deterministic mocks.
//
// Two separate mocks are used: guardTagsClient (tags) and a distinct openrouter
// (comments/post), so guardTagsClient !== openrouter and the pipeline behaves as if a
// Groq client is present. Because that production routing sends comments-v2 through the
// same guardTagsClient, the tag-call counter keys strictly on label === "tags" — that
// makes it unambiguous no matter how many comments calls run in the same story.
//
// The article is deliberately empty (no article summary, no post LLM), so the tag prompt
// reduces to the stable title/URL/domain signal — exactly the inputs whose stability the
// change guarantees.

type TmpPathFor = ReturnType<typeof mockPaths>["pathFor"];

const BASE_TITLE = "Устойчивая очередь задач";
const BASE_URL = "https://example.com/queue";

const RU_INSIGHTS_A: CommentsInsights = {
  bottom_line:
    "Обсуждение сходится к тому, что перед переключением нужно измерить задержки и заранее проверить сценарий отката.",
  insights: [
    {
      kind: "consensus",
      text: "Участники согласны, что необходимо измерить задержки и убедиться в надёжном восстановлении после сбоев.",
    },
    {
      kind: "dispute",
      text: "Спорят о том, делать ли полный переход сразу или включать новую систему постепенно с быстрым откатом.",
    },
    {
      kind: "advice",
      text: "Советуют сначала зеркалировать трафик, сравнивать ответы и включать запись только после устранения расхождений.",
    },
  ],
  best_quote: null,
};

const RU_INSIGHTS_B: CommentsInsights = {
  bottom_line:
    "Ветка обсуждения смещается к вопросам мониторинга и стоимости эксплуатации новой очереди в реальном продакшене.",
  insights: [
    {
      kind: "consensus",
      text: "Комментаторы отмечают важность подробных метрик и трассировки для диагностики задержек в очереди.",
    },
    {
      kind: "dispute",
      text: "Разногласие о выборе брокера сообщений и допустимой сложности инфраструктуры для небольшой команды.",
    },
    {
      kind: "advice",
      text: "Рекомендуют начать с управляемого сервиса и переходить на своё решение только при явной экономии затрат.",
    },
  ],
  best_quote: null,
};

function ruComments(storyId: number): NormalizedComment[] {
  const pad = "Дополнительный содержательный контекст для проверки производственного пути обработки комментариев.";
  return [
    makeComment({
      id: 101,
      parent: storyId,
      textPlain: `Первый участник предлагает измерить задержки перед переключением пользователей. ${pad}`,
    }),
    makeComment({
      id: 102,
      parent: storyId,
      textPlain: `Второй участник советует канареечный запуск и заранее проверенный сценарий отката. ${pad}`,
    }),
    makeComment({
      id: 103,
      parent: storyId,
      textPlain: `Третий участник спорит о допустимом уровне расхождений между старой и новой системами. ${pad}`,
    }),
  ];
}

function ruCommentsAlt(storyId: number): NormalizedComment[] {
  const pad = "Развёрнутое пояснение с деталями эксплуатации и мониторинга для проверки пути генерации саммари.";
  return [
    makeComment({
      id: 201,
      parent: storyId,
      textPlain: `Новый комментатор описывает неожиданный рост стоимости после включения очереди в продакшене. ${pad}`,
    }),
    makeComment({
      id: 202,
      parent: storyId,
      textPlain: `Другой участник делится опытом отладки задержек и настройки трассировки запросов. ${pad}`,
    }),
    makeComment({
      id: 203,
      parent: storyId,
      textPlain: `Третий обсуждает выбор брокера сообщений и сложность поддержки собственного решения. ${pad}`,
    }),
  ];
}

type TagCounters = { tagCalls: number; tagModels: string[] };

type TagCacheHarness = {
  services: Services;
  counters: TagCounters;
  setCommentsInsights: (insights: CommentsInsights) => void;
};

function makeTagCacheServices(): TagCacheHarness {
  const counters: TagCounters = { tagCalls: 0, tagModels: [] };
  let commentsInsights: CommentsInsights = RU_INSIGHTS_A;

  const guardTagsClient = {
    chat: async (): Promise<string> => "",
    chatStructured: async <T>(_messages: ChatMessage[], options: StructuredOutputOptions): Promise<T> => {
      if (options.label === "tags") {
        counters.tagCalls += 1;
        counters.tagModels.push(options.model ?? "");
        return { tags: [{ name: "python", cat: "lang" }] } as unknown as T;
      }
      if (options.label === "comments") {
        return commentsInsights as unknown as T;
      }
      throw new Error(`unexpected structured label on guardTagsClient: ${String(options.label)}`);
    },
  } as unknown as Services["guardTagsClient"];

  // Distinct object so guardTagsClient !== openrouter (Groq route active). Only serves as
  // a safety net for the cross-provider comments fallback; tags never touch it.
  const openrouter = {
    chat: async (): Promise<string> => "",
    chatStructured: async <T>(_messages: ChatMessage[], options: StructuredOutputOptions): Promise<T> => {
      if (options.label === "comments") {
        return commentsInsights as unknown as T;
      }
      throw new Error(`openrouter must not receive structured label ${String(options.label)}`);
    },
  } as unknown as Services["openrouter"];

  const services = {
    http: {} as Services["http"],
    openrouter,
    guardTagsClient,
    fetchArticleMarkdown: async (): Promise<{ md: string; sourceKind: "empty" }> => ({ md: "", sourceKind: "empty" }),
    usage: createUsageCollector(),
  } as unknown as Services;

  return {
    services,
    counters,
    setCommentsInsights: (insights: CommentsInsights): void => {
      commentsInsights = insights;
    },
  };
}

async function seedStory(
  store: ObjectStore,
  pathFor: TmpPathFor,
  id: number,
  over: Partial<NormalizedStory> = {},
  comments: NormalizedComment[] = ruComments(id)
): Promise<void> {
  await store.putJson(
    pathFor.rawItem(id),
    makeStory({ id, title: BASE_TITLE, url: BASE_URL, commentIds: [101, 102, 103], ...over })
  );
  await store.putJson(pathFor.rawComments(id), comments);
}

const ENV_PATCH = { SUMMARY_LANG: "ru" as const, TAGS_MAX_PER_STORY: 5, TAGS_MODEL: "tags-model-a" };

type TagsRecord = { inputHash: string };
type CommentsRecord = { summary: string };

describe("tags cache gate is stable against comments drift", () => {
  test("first run writes tags.json and makes exactly one structured tag call", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { createFsStore } = await import("../utils/fs-store");
      const { processSingleStory } = await import("../pipeline/summarize");

      const store = createFsStore();
      const { services, counters } = makeTagCacheServices();
      const id = 700_001;
      await seedStory(store, pathFor, id);

      await withEnvPatch(ENV_PATCH, async () => {
        await processSingleStory(services, id, store);
      });

      const tags = await store.getJson<TagsRecord>(pathFor.tagsSummary(id));
      expect(tags).not.toBeNull();
      expect(typeof tags?.inputHash).toBe("string");
      expect(counters.tagCalls).toBe(1);
    });
  });

  test("a changed comments summary does not trigger a tag recompute", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { createFsStore } = await import("../utils/fs-store");
      const { processSingleStory } = await import("../pipeline/summarize");

      const store = createFsStore();
      const { services, counters, setCommentsInsights } = makeTagCacheServices();
      const id = 700_002;
      await seedStory(store, pathFor, id);

      await withEnvPatch(ENV_PATCH, async () => {
        setCommentsInsights(RU_INSIGHTS_A);
        await processSingleStory(services, id, store);
        const tagsFirst = await store.getJson<TagsRecord>(pathFor.tagsSummary(id));
        const commentsFirst = await store.getJson<CommentsRecord>(pathFor.commentsSummary(id));
        expect(counters.tagCalls).toBe(1);

        // Force the comments pipeline to regenerate a DIFFERENT summary: new raw comments
        // (new comments inputHash) plus a different deterministic LLM response.
        await store.putJson(pathFor.rawComments(id), ruCommentsAlt(id));
        setCommentsInsights(RU_INSIGHTS_B);
        await processSingleStory(services, id, store);

        const tagsSecond = await store.getJson<TagsRecord>(pathFor.tagsSummary(id));
        const commentsSecond = await store.getJson<CommentsRecord>(pathFor.commentsSummary(id));

        // Premise holds: the comments summary text genuinely changed between runs.
        expect(commentsSecond?.summary).not.toBe(commentsFirst?.summary);
        // Contract: tags did NOT recompute and the tag inputHash is unchanged.
        expect(counters.tagCalls).toBe(1);
        expect(tagsSecond?.inputHash).toBe(tagsFirst?.inputHash);
      });
    });
  });

  test("changing the title triggers a tag recompute and a new inputHash", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { createFsStore } = await import("../utils/fs-store");
      const { processSingleStory } = await import("../pipeline/summarize");

      const store = createFsStore();
      const { services, counters } = makeTagCacheServices();
      const id = 700_003;
      await seedStory(store, pathFor, id);

      await withEnvPatch(ENV_PATCH, async () => {
        await processSingleStory(services, id, store);
        const tagsFirst = await store.getJson<TagsRecord>(pathFor.tagsSummary(id));
        expect(counters.tagCalls).toBe(1);

        await seedStory(store, pathFor, id, { title: "Совершенно другой заголовок обсуждения" });
        await processSingleStory(services, id, store);

        const tagsSecond = await store.getJson<TagsRecord>(pathFor.tagsSummary(id));
        expect(counters.tagCalls).toBe(2);
        expect(tagsSecond?.inputHash).not.toBe(tagsFirst?.inputHash);
      });
    });
  });

  test("changing the URL/domain triggers a tag recompute and a new inputHash", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { createFsStore } = await import("../utils/fs-store");
      const { processSingleStory } = await import("../pipeline/summarize");

      const store = createFsStore();
      const { services, counters } = makeTagCacheServices();
      const id = 700_004;
      await seedStory(store, pathFor, id);

      await withEnvPatch(ENV_PATCH, async () => {
        await processSingleStory(services, id, store);
        const tagsFirst = await store.getJson<TagsRecord>(pathFor.tagsSummary(id));
        expect(counters.tagCalls).toBe(1);

        await seedStory(store, pathFor, id, { url: "https://different.example.org/other-path" });
        await processSingleStory(services, id, store);

        const tagsSecond = await store.getJson<TagsRecord>(pathFor.tagsSummary(id));
        expect(counters.tagCalls).toBe(2);
        expect(tagsSecond?.inputHash).not.toBe(tagsFirst?.inputHash);
      });
    });
  });

  test("re-running with a different TAGS_MODEL triggers a tag recompute and a new inputHash", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { createFsStore } = await import("../utils/fs-store");
      const { processSingleStory } = await import("../pipeline/summarize");

      const store = createFsStore();
      const { services, counters } = makeTagCacheServices();
      const id = 700_005;
      await seedStory(store, pathFor, id);

      await withEnvPatch({ ...ENV_PATCH, TAGS_MODEL: "tags-model-a" }, async () => {
        await processSingleStory(services, id, store);
      });
      const tagsFirst = await store.getJson<TagsRecord>(pathFor.tagsSummary(id));
      expect(counters.tagCalls).toBe(1);
      expect(counters.tagModels).toEqual(["tags-model-a"]);

      await withEnvPatch({ ...ENV_PATCH, TAGS_MODEL: "tags-model-b" }, async () => {
        await processSingleStory(services, id, store);
      });
      const tagsSecond = await store.getJson<TagsRecord>(pathFor.tagsSummary(id));

      expect(counters.tagCalls).toBe(2);
      expect(tagsSecond?.inputHash).not.toBe(tagsFirst?.inputHash);
      expect(counters.tagModels).toEqual(["tags-model-a", "tags-model-b"]);
    });
  });
});
