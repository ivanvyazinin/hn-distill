import { describe, expect, test } from "bun:test";

import { COMMENTS_POLICY_VERSION, env } from "../config/env";
import { pathFor } from "../config/paths";
import type { CommentsInsights, CommentsSummary, NormalizedComment } from "../config/schemas";
import {
  CommentsGenerationBudget,
  computeCommentsChanged,
  generateValidatedCommentsSummaryV2,
  processCommentsSummary,
  type Services,
} from "../pipeline/summarize";
import { HttpError } from "../utils/http-client";
import type { MetaStore, SummaryRow } from "../utils/meta-store";
import type { ObjectStore } from "../utils/object-store";
import {
  UnsupportedResponseFormatError,
  type ChatMessage,
  type StructuredOutputOptions,
} from "../utils/openrouter";
import { comment as makeComment, story as makeStory, withEnvPatch } from "./helpers";

type StructuredCall = {
  maxRetries: number;
  messages: ChatMessage[];
  options: StructuredOutputOptions;
};

class MemoryStore implements ObjectStore {
  readonly values: Map<string, string> = new Map<string, string>();

  async getText(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async putText(key: string, body: string): Promise<void> {
    this.values.set(key, body);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const value = this.values.get(key);
    return value === undefined ? null : (JSON.parse(value) as T);
  }

  async putJson(key: string, value: unknown): Promise<void> {
    this.values.set(key, JSON.stringify(value));
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
}

const VALID_INSIGHTS: CommentsInsights = {
  bottom_line:
    "Тред добавляет практический опыт: перед миграцией нужно измерить задержки и проверить восстановление после сбоев.",
  insights: [
    {
      kind: "consensus",
      text: "Участники согласны, что перед миграцией необходимо измерить задержки и проверить восстановление после сбоев.",
    },
    {
      kind: "dispute",
      text: "Спор: одна сторона за полный cutover после нагрузочного испытания, другая — за постепенное включение с откатом.",
    },
    {
      kind: "advice",
      text: "Сначала зеркалируйте запросы, сравнивайте ответы и включайте запись только после устранения расхождений.",
    },
  ],
  best_quote: null,
};

const INVALID_LANGUAGE_INSIGHTS: CommentsInsights = {
  bottom_line: "Participants agree that benchmarks should be published before the migration begins.",
  insights: [
    {
      kind: "consensus",
      text: "Participants agree that benchmarks should be published before the migration begins.",
    },
  ],
  best_quote: null,
};

function longComment(id: number, parent: number, text: string): NormalizedComment {
  return makeComment({
    id,
    parent,
    textPlain: `${text} ${"Дополнительный содержательный контекст для проверки производственного пути.".repeat(2)}`,
  });
}

function structuredServices(
  handlers: Array<(call: StructuredCall) => Promise<CommentsInsights>>
): { calls: StructuredCall[]; services: Services } {
  const calls: StructuredCall[] = [];
  let index = 0;
  const openrouter = ({
    chat: async () => {
      throw new Error("legacy chat must not be called by comments-v2");
    },
    chatStructured: async <T>(
      messages: ChatMessage[],
      options: StructuredOutputOptions,
      _schema: unknown,
      maxRetries: number
    ): Promise<T> => {
      const call = { messages, options, maxRetries };
      calls.push(call);
      const handler = handlers[index];
      index += 1;
      if (handler === undefined) {
        throw new Error(`unexpected structured call ${index}`);
      }
      return (await handler(call)) as T;
    },
  } as unknown) as Services["openrouter"];
  return {
    calls,
    services: {
      http: {} as Services["http"],
      openrouter,
      guardTagsClient: openrouter,
      fetchArticleMarkdown: async () => ({ md: "", sourceKind: "empty" }),
    },
  };
}

function threeComments(storyId: number): NormalizedComment[] {
  return [
    longComment(101, storyId, "Первый участник предлагает измерить задержки до переключения пользователей."),
    longComment(102, storyId, "Второй участник рекомендует канареечный запуск и проверенный сценарий отката."),
    longComment(103, storyId, "Третий участник спорит о допустимом уровне расхождений между системами."),
  ];
}

describe("comments-v2 request budget and validation", () => {
  test("semantic failure retries strictly on the same model and keeps one physical call per attempt", async () => {
    const story = makeStory({ id: 10, title: "Safe migration" });
    const { calls, services } = structuredServices([
      async () => INVALID_LANGUAGE_INSIGHTS,
      async () => VALID_INSIGHTS,
    ]);

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_SUMMARY_MIN_CHARS: 200 }, async () => {
      const result = await generateValidatedCommentsSummaryV2(services, {
        story,
        comments: threeComments(story.id),
      });

      expect(result?.insights).toEqual(VALID_INSIGHTS);
      expect(calls.length).toBe(2);
      expect(calls[0]?.options.model).toBe(env.OPENROUTER_MODEL);
      expect(calls[1]?.options.model).toBe(env.OPENROUTER_MODEL);
      expect(calls.every((call) => call.maxRetries === 1)).toBeTrue();
      expect(calls.every((call) => call.options.transportRetries === 0)).toBeTrue();
      expect(calls[1]?.messages[0]?.content).toContain("Строго соблюдай JSON-схему");
    });
  });

  test("routes comments through the distinct Groq client and its own model chain", async () => {
    const story = makeStory({ id: 40, title: "Groq route" });
    const groqCalls: StructuredCall[] = [];
    const groqClient = ({
      chat: async () => {
        throw new Error("legacy chat must not be called by comments-v2");
      },
      chatStructured: async <T>(
        messages: ChatMessage[],
        options: StructuredOutputOptions,
        _schema: unknown,
        maxRetries: number
      ): Promise<T> => {
        groqCalls.push({ messages, options, maxRetries });
        return VALID_INSIGHTS as T;
      },
    } as unknown) as Services["openrouter"];
    // A distinct openrouter client that must never be touched for comments once a Groq client exists.
    const openrouter = ({
      chat: async () => {
        throw new Error("post client must not be used for comments-v2");
      },
      chatStructured: async () => {
        throw new Error("openrouter must not be used when a Groq client is present");
      },
    } as unknown) as Services["openrouter"];
    const services: Services = {
      http: {} as Services["http"],
      openrouter,
      guardTagsClient: groqClient,
      fetchArticleMarkdown: async () => ({ md: "", sourceKind: "empty" }),
    };

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_SUMMARY_MIN_CHARS: 200 }, async () => {
      const result = await generateValidatedCommentsSummaryV2(services, {
        story,
        comments: threeComments(story.id),
      });

      expect(result?.insights).toEqual(VALID_INSIGHTS);
      expect(result?.modelUsed).toBe(env.COMMENTS_MODEL);
      expect(groqCalls.length).toBe(1);
      expect(groqCalls[0]?.options.model).toBe(env.COMMENTS_MODEL);
      // Groq base URL → skip json_schema (guaranteed 400/TPD burn) and extract balanced object.
      expect(groqCalls[0]?.options.responseFormat).toBeUndefined();
      expect(groqCalls[0]?.options.jsonExtraction).toBe("balanced-object");
    });
  });

  test("transport failure advances to the fallback model", async () => {
    const story = makeStory({ id: 11 });
    const { calls, services } = structuredServices([
      async () => {
        throw new Error("provider failed", { cause: new HttpError("https://provider.invalid", 503) });
      },
      async () => VALID_INSIGHTS,
    ]);

    await withEnvPatch({ SUMMARY_LANG: "ru" }, async () => {
      const result = await generateValidatedCommentsSummaryV2(services, {
        story,
        comments: threeComments(story.id),
      });
      expect(result?.modelUsed).toBe(env.OPENROUTER_FALLBACK_MODEL);
      expect(calls.length).toBe(2);
      expect(calls[1]?.options.model).toBe(env.OPENROUTER_FALLBACK_MODEL);
    });
  });

  test("unsupported response_format alone enables balanced no-format extraction on the same model", async () => {
    const story = makeStory({ id: 12 });
    const { calls, services } = structuredServices([
      async () => {
        throw new UnsupportedResponseFormatError(
          new HttpError("https://provider.invalid", 400, "response_format is not supported")
        );
      },
      async () => VALID_INSIGHTS,
    ]);

    await withEnvPatch({ SUMMARY_LANG: "ru" }, async () => {
      const result = await generateValidatedCommentsSummaryV2(services, {
        story,
        comments: threeComments(story.id),
      });
      expect(result?.modelUsed).toBe(env.OPENROUTER_MODEL);
      expect(calls.length).toBe(2);
      expect(calls[0]?.options.responseFormat !== undefined).toBeTrue();
      expect(calls[1]?.options.responseFormat).toBeUndefined();
      expect(calls[1]?.options.jsonExtraction).toBe("balanced-object");
    });
  });

  test("all failures stop at three physical calls", async () => {
    const story = makeStory({ id: 13 });
    const { calls, services } = structuredServices([
      async () => INVALID_LANGUAGE_INSIGHTS,
      async () => INVALID_LANGUAGE_INSIGHTS,
      async () => INVALID_LANGUAGE_INSIGHTS,
    ]);

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_MAX_LLM_CALLS: 3 }, async () => {
      const result = await generateValidatedCommentsSummaryV2(services, {
        story,
        comments: threeComments(story.id),
      });
      expect(result).toBeUndefined();
      expect(calls.length).toBe(3);
      expect(calls[2]?.options.model).toBe(env.OPENROUTER_FALLBACK_MODEL);
    });
  });

  test("a near deadline does not start another physical request", async () => {
    const story = makeStory({ id: 14 });
    const { calls, services } = structuredServices([async () => VALID_INSIGHTS]);
    const budget = new CommentsGenerationBudget({
      maxCalls: 3,
      deadlineAt: 10_999,
      now: () => 10_000,
      requestTimeoutMs: 7000,
    });

    const result = await generateValidatedCommentsSummaryV2(services, {
      story,
      comments: threeComments(story.id),
      budget,
    });
    expect(result).toBeUndefined();
    expect(calls.length).toBe(0);
    expect(budget.callsUsed).toBe(0);
  });
});

describe("comments-v2 persistence", () => {
  test("degraded output is identical in ObjectStore and MetaStore and repairs meta on a matching rerun", async () => {
    const story = makeStory({ id: 20, title: "One useful answer" });
    const comments = [longComment(201, story.id, "Единственный ответ содержит практическую рекомендацию по безопасному запуску.")];
    const store = new MemoryStore();
    const summaries: SummaryRow[] = [];
    const meta = {
      upsertSummary: async (row: SummaryRow) => {
        summaries.push(row);
      },
    } as MetaStore;
    const { services } = structuredServices([]);
    const path = "data/summaries/20.comments.json";

    await withEnvPatch({ SUMMARY_LANG: "ru" }, async () => {
      const first = await processCommentsSummary(services, story, comments, undefined, path, store, meta);
      expect(first.status).toBe("applied");
      const persisted = await store.getJson<CommentsSummary>(path);
      expect(persisted?.formatVersion).toBe(2);
      expect(persisted?.degraded).toBe("too-few-comments");
      expect(persisted?.summary).toBe(summaries[0]?.summary);
      expect(persisted?.summary.length).toBeGreaterThan(0);

      const second = await processCommentsSummary(services, story, comments, undefined, path, store, meta);
      expect(second.status).toBe("applied");
      expect(summaries.length).toBe(2);
      expect(summaries[1]?.summary).toBe(persisted?.summary);
    });
  });

  test("zero substantive comments persists an intentional empty v2 degraded result", async () => {
    const story = makeStory({ id: 21, title: "No discussion" });
    const store = new MemoryStore();
    const { services } = structuredServices([]);
    const result = await processCommentsSummary(
      services,
      story,
      [makeComment({ id: 211, parent: story.id, textPlain: "short" })],
      undefined,
      "data/summaries/21.comments.json",
      store
    );

    expect(result.status).toBe("applied");
    if (result.status === "applied") {
      expect(result.summary.summary).toBe("");
      expect(result.summary.formatVersion).toBe(2);
      expect(result.summary.degraded).toBe("too-few-comments");
    }
  });

  test("all-fail generation persists a retryable fallback and remains pending", async () => {
    const story = makeStory({ id: 22 });
    const store = new MemoryStore();
    const path = "data/summaries/22.comments.json";
    const legacy = { id: story.id, lang: "ru", summary: "- Старое проверенное саммари", inputHash: "legacy" };
    await store.putJson(path, legacy);
    const comments = threeComments(story.id);
    await store.putJson(pathFor.rawComments(story.id), comments);
    const { services } = structuredServices([
      async () => {
        throw new SyntaxError("bad json one");
      },
      async () => {
        throw new SyntaxError("bad json two");
      },
      async () => {
        throw new SyntaxError("bad json three");
      },
    ]);

    const result = await processCommentsSummary(services, story, comments, undefined, path, store);
    expect(result.status).toBe("pending");
    const fallback = await store.getJson<CommentsSummary>(path);
    expect(fallback?.degraded).toBe("generation-failed");
    expect(fallback?.formatVersion).toBe(2);
    expect(fallback?.summary.length).toBeGreaterThan(0);
    expect(fallback?.summary).not.toBe(legacy.summary);
    expect(await computeCommentsChanged(story, fallback, "ru", 60_000, Date.now(), store)).toBeTrue();
  });

  test("storage read failure returns pending without starting generation", async () => {
    const story = makeStory({ id: 24 });
    const store = new MemoryStore();
    store.getJson = async () => {
      throw new Error("storage unavailable");
    };
    const { calls, services } = structuredServices([async () => VALID_INSIGHTS]);

    const result = await processCommentsSummary(
      services,
      story,
      threeComments(story.id),
      undefined,
      "data/summaries/24.comments.json",
      store
    );

    expect(result.status).toBe("pending");
    if (result.status === "pending") {
      expect(result.reason).toBe("storage-read-failed");
    }
    expect(calls.length).toBe(0);
  });

  test("selection computes the same policy hash as persistence and notices title/post changes", async () => {
    const story = makeStory({ id: 23, title: "Original title" });
    const comments = [longComment(231, story.id, "Один подробный ответ объясняет порядок проверки и запуска новой системы.")];
    const postSummary = { id: story.id, lang: "ru" as const, summary: "Краткая суть исходной статьи для контекста." };
    const store = new MemoryStore();
    const path = "data/summaries/23.comments.json";
    const { services } = structuredServices([]);
    await store.putJson(pathFor.rawComments(story.id), comments);
    await store.putJson(pathFor.postSummary(story.id), postSummary);

    await withEnvPatch({ SUMMARY_LANG: "ru" }, async () => {
      const applied = await processCommentsSummary(services, story, comments, postSummary, path, store);
      expect(applied.status).toBe("applied");
      if (applied.status !== "applied") {
        return;
      }
      expect(applied.policyVersion).toBe(COMMENTS_POLICY_VERSION);
      expect(
        await computeCommentsChanged(story, applied.summary, "ru", 0, Date.now(), store)
      ).toBeFalse();
      expect(
        await computeCommentsChanged({ ...story, title: "Changed title" }, applied.summary, "ru", 0, Date.now(), store)
      ).toBeTrue();
      await store.putJson(pathFor.postSummary(story.id), {
        ...postSummary,
        summary: "Изменённая суть статьи должна поменять общий comments input hash.",
      });
      expect(
        await computeCommentsChanged(story, applied.summary, "ru", 0, Date.now(), store)
      ).toBeTrue();
    });
  });
});
