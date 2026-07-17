import { describe, expect, test } from "bun:test";

import { COMMENTS_POLICY_VERSION, env } from "../config/env";
import { pathFor } from "../config/paths";
import type { CommentsInsights, CommentsSummary, NormalizedComment } from "../config/schemas";
import {
  CommentsGenerationBudget,
  buildCommentsPromptV2,
  computeCommentsChanged,
  generateValidatedCommentsSummaryV2,
  processCommentsSummary,
  type Services,
} from "../pipeline/summarize";
import { HttpError } from "../utils/http-client";
import { createUsageCollector } from "../utils/llm-usage";
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

type ChatCall = {
  messages: ChatMessage[];
  options: {
    label?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    requestTimeoutMs?: number;
    transportRetries?: number;
  };
};

function structuredServices(
  handlers: Array<(call: StructuredCall) => Promise<CommentsInsights>>,
  chatHandlers: Array<(call: ChatCall) => Promise<string>> = []
): { calls: StructuredCall[]; chatCalls: ChatCall[]; services: Services } {
  const calls: StructuredCall[] = [];
  const chatCalls: ChatCall[] = [];
  let index = 0;
  let chatIndex = 0;
  const openrouter = ({
    chat: async (messages: ChatMessage[], options: ChatCall["options"] = {}) => {
      const call = { messages, options };
      chatCalls.push(call);
      const handler = chatHandlers[chatIndex];
      chatIndex += 1;
      if (handler === undefined) {
        throw new Error(`unexpected chat call ${chatIndex}`);
      }
      return await handler(call);
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
    chatCalls,
    services: {
      http: {} as Services["http"],
      openrouter,
      guardTagsClient: openrouter,
      fetchArticleMarkdown: async () => ({ md: "", sourceKind: "empty" }),
      usage: createUsageCollector(),
    },
  };
}

const COMPRESS_OFF = { COMMENTS_COMPRESS_MODEL: "" } as const;

// ≥25 words so checkSummaryHeuristics (MIN_WORDS) accepts the compress output.
const VALID_COMPRESSED_RU =
  "Тред добавляет практический опыт эксплуатации: перед миграцией измерьте задержки и проверьте восстановление после сбоев, зеркалируйте запросы, сравнивайте ответы между системами и включайте запись только после устранения всех найденных расхождений и согласования критериев отката.";

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

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_SUMMARY_MIN_CHARS: 200, COMMENTS_COMPRESS_MODEL: ""}, async () => {
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
      usage: createUsageCollector(),
    };

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_SUMMARY_MIN_CHARS: 200, COMMENTS_COMPRESS_MODEL: ""}, async () => {
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

  test("Groq TPD 429 falls back cross-provider to the paid OpenRouter model", async () => {
    const story = makeStory({ id: 41, title: "TPD exhausted" });
    const groqCalls: StructuredCall[] = [];
    const openRouterCalls: StructuredCall[] = [];
    const groqClient = ({
      chat: async () => {
        throw new Error("legacy chat must not be called by comments-v2");
      },
      chatStructured: async (messages: ChatMessage[], options: StructuredOutputOptions, _schema: unknown, maxRetries: number) => {
        groqCalls.push({ messages, options, maxRetries });
        throw new Error("rate limited", {
          cause: new HttpError("https://api.groq.com/openai/v1", 429, "tokens per day (TPD)"),
        });
      },
    } as unknown) as Services["openrouter"];
    const openrouter = ({
      chat: async () => {
        throw new Error("legacy chat must not be called by comments-v2");
      },
      chatStructured: async <T>(messages: ChatMessage[], options: StructuredOutputOptions, _schema: unknown, maxRetries: number): Promise<T> => {
        openRouterCalls.push({ messages, options, maxRetries });
        return VALID_INSIGHTS as T;
      },
    } as unknown) as Services["openrouter"];
    const services: Services = {
      http: {} as Services["http"],
      openrouter,
      guardTagsClient: groqClient,
      fetchArticleMarkdown: async () => ({ md: "", sourceKind: "empty" }),
      usage: createUsageCollector(),
    };

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_SUMMARY_MIN_CHARS: 200, COMMENTS_MAX_LLM_CALLS: 3, COMMENTS_COMPRESS_MODEL: ""}, async () => {
      const result = await generateValidatedCommentsSummaryV2(services, {
        story,
        comments: threeComments(story.id),
      });

      expect(result?.insights).toEqual(VALID_INSIGHTS);
      expect(result?.modelUsed).toBe(env.COMMENTS_OPENROUTER_FALLBACK_MODEL);
      // Both Groq models were tried and 429'd before the cross-provider hop.
      expect(groqCalls.map((call) => call.options.model)).toEqual([env.COMMENTS_MODEL, env.COMMENTS_FALLBACK_MODEL]);
      expect(openRouterCalls.length).toBe(1);
      expect(openRouterCalls[0]?.options.model).toBe(env.COMMENTS_OPENROUTER_FALLBACK_MODEL);
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

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: ""}, async () => {
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

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: ""}, async () => {
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

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_MAX_LLM_CALLS: 3, COMMENTS_COMPRESS_MODEL: ""}, async () => {
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

  test("quote outside sampleIds is dropped while the summary is retained without escalation", async () => {
    const story = makeStory({ id: 15, title: "Quote provenance soft-fail" });
    const comments = threeComments(story.id);
    const outOfSampleId = 103;
    const outOfSample = comments.find((comment) => comment.id === outOfSampleId);
    if (outOfSample === undefined) {
      throw new Error("expected threeComments to include id 103");
    }
    const quoteSource = outOfSample.textPlain.slice(0, 80).trim();
    const insightsWithOutOfSampleQuote: CommentsInsights = {
      ...VALID_INSIGHTS,
      best_quote: {
        comment_id: outOfSampleId,
        source_text: quoteSource,
        translation: "Перевод цитаты о допустимом уровне расхождений между системами.",
      },
    };
    const basePrepared = buildCommentsPromptV2({
      story,
      comments,
      language: "ru",
      maxChars: env.COMMENTS_PROMPT_MAX_CHARS,
    });
    const prepared = {
      ...basePrepared,
      sampleIds: basePrepared.sampleIds.filter((id) => id !== outOfSampleId),
      droppedIds: [...new Set([...basePrepared.droppedIds, outOfSampleId])],
    };
    const { calls, services } = structuredServices([async () => insightsWithOutOfSampleQuote]);

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_SUMMARY_MIN_CHARS: 200, COMMENTS_COMPRESS_MODEL: ""}, async () => {
      const result = await generateValidatedCommentsSummaryV2(services, {
        story,
        comments,
        prepared,
      });

      expect(result?.insights.best_quote).toBeNull();
      expect(result?.summary).not.toContain(quoteSource);
      expect(result?.summary.length).toBeGreaterThan(0);
      expect(calls.length).toBe(1);
      expect(result?.modelUsed).toBe(env.OPENROUTER_MODEL);
    });
  });

  test("bad quote does not rescue a synthesis that still fails heuristics", async () => {
    const story = makeStory({ id: 16, title: "Bad synthesis stays rejected" });
    const comments = threeComments(story.id);
    const outOfSampleId = 103;
    const outOfSample = comments.find((comment) => comment.id === outOfSampleId);
    if (outOfSample === undefined) {
      throw new Error("expected threeComments to include id 103");
    }
    const insightsWithBadQuote: CommentsInsights = {
      ...INVALID_LANGUAGE_INSIGHTS,
      best_quote: {
        comment_id: outOfSampleId,
        source_text: outOfSample.textPlain.slice(0, 80).trim(),
        translation: "A translation that cannot rescue English synthesis.",
      },
    };
    const basePrepared = buildCommentsPromptV2({
      story,
      comments,
      language: "ru",
      maxChars: env.COMMENTS_PROMPT_MAX_CHARS,
    });
    const prepared = {
      ...basePrepared,
      sampleIds: basePrepared.sampleIds.filter((id) => id !== outOfSampleId),
      droppedIds: [...new Set([...basePrepared.droppedIds, outOfSampleId])],
    };
    const { calls, services } = structuredServices([
      async () => insightsWithBadQuote,
      async () => insightsWithBadQuote,
      async () => insightsWithBadQuote,
    ]);

    await withEnvPatch(
      { SUMMARY_LANG: "ru", COMMENTS_SUMMARY_MIN_CHARS: 200, COMMENTS_MAX_LLM_CALLS: 3, COMMENTS_COMPRESS_MODEL: "" },
      async () => {
        const result = await generateValidatedCommentsSummaryV2(services, {
          story,
          comments,
          prepared,
        });
        expect(result).toBeUndefined();
        expect(calls.length).toBe(3);
      }
    );
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

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: ""}, async () => {
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
    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: "" }, async () => {
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

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: "" }, async () => {
      const result = await processCommentsSummary(services, story, comments, undefined, path, store);
      expect(result.status).toBe("pending");
      const fallback = await store.getJson<CommentsSummary>(path);
      expect(fallback?.degraded).toBe("generation-failed");
      expect(fallback?.formatVersion).toBe(2);
      expect(fallback?.summary.length).toBeGreaterThan(0);
      expect(fallback?.summary).not.toBe(legacy.summary);
      expect(await computeCommentsChanged(story, fallback, "ru", 60_000, Date.now(), store)).toBeTrue();
    });
  });

  test("storage read failure returns pending without starting generation", async () => {
    const story = makeStory({ id: 24 });
    const store = new MemoryStore();
    store.getJson = async () => {
      throw new Error("storage unavailable");
    };
    const { calls, services } = structuredServices([async () => VALID_INSIGHTS]);

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: "" }, async () => {
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
  });

  test("good synthesis with unverifiable quote applies non-degraded v2 and nulls best_quote", async () => {
    const story = makeStory({ id: 25, title: "Prod-style quote provenance soft-fail" });
    const comments = threeComments(story.id);
    const store = new MemoryStore();
    const path = "data/summaries/25.comments.json";
    // Mirrors prod: model invents a quote comment_id that is not in the sampled set
    // (and here not even among the story comments), while the synthesis is fine.
    const insightsWithUnverifiableQuote: CommentsInsights = {
      ...VALID_INSIGHTS,
      best_quote: {
        comment_id: 999_001,
        source_text: "Первый участник предлагает измерить задержки до переключения пользователей.",
        translation: "Перевод неверифицируемой цитаты о задержках.",
      },
    };
    const { services } = structuredServices([async () => insightsWithUnverifiableQuote]);

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_SUMMARY_MIN_CHARS: 200, COMMENTS_COMPRESS_MODEL: ""}, async () => {
      const result = await processCommentsSummary(services, story, comments, undefined, path, store);
      expect(result.status).toBe("applied");
      const persisted = await store.getJson<CommentsSummary>(path);
      expect(persisted?.degraded).toBeUndefined();
      expect(persisted?.structured?.best_quote).toBeNull();
      expect(persisted?.summary.length).toBeGreaterThan(0);
      expect(persisted?.summary).not.toContain("неверифицируемой цитаты");
    });
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

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: ""}, async () => {
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

describe("comments compress integration", () => {
  test("success writes compressed and meta uses the compressed paragraph", async () => {
    const story = makeStory({ id: 30, title: "Compress success" });
    const comments = threeComments(story.id);
    const store = new MemoryStore();
    const path = "data/summaries/30.comments.json";
    const summaries: SummaryRow[] = [];
    const meta = {
      upsertSummary: async (row: SummaryRow) => {
        summaries.push(row);
      },
    } as MetaStore;
    const { calls, chatCalls, services } = structuredServices(
      [async () => VALID_INSIGHTS],
      [async () => VALID_COMPRESSED_RU]
    );

    await withEnvPatch(
      {
        SUMMARY_LANG: "ru",
        COMMENTS_SUMMARY_MIN_CHARS: 80,
        COMMENTS_COMPRESS_MODEL: "qwen/qwen3-next-80b-a3b-instruct",
      },
      async () => {
        const result = await processCommentsSummary(services, story, comments, undefined, path, store, meta);
        expect(result.status).toBe("applied");
        const persisted = await store.getJson<CommentsSummary>(path);
        expect(persisted?.compressed?.text).toBe(VALID_COMPRESSED_RU);
        expect(persisted?.compressed?.model).toBe("qwen/qwen3-next-80b-a3b-instruct");
        expect(persisted?.compressed?.sourceHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(summaries[0]?.summary).toContain("Тред добавляет");
        expect(summaries[0]?.summary).not.toContain("- **Спор:**");
        expect(calls.length).toBe(1);
        expect(chatCalls.length).toBe(1);
        expect(chatCalls[0]?.options.label).toBe("comments-compress");
      }
    );
  });

  test("semantic reject writes text:\"\" marker and a second pass does not call LLM again", async () => {
    const story = makeStory({ id: 31, title: "Compress reject" });
    const comments = threeComments(story.id);
    const store = new MemoryStore();
    const path = "data/summaries/31.comments.json";
    const { chatCalls, services } = structuredServices(
      [async () => VALID_INSIGHTS],
      [async () => "This is entirely English and must be rejected by the cyrillic gate after compression."]
    );

    await withEnvPatch(
      {
        SUMMARY_LANG: "ru",
        COMMENTS_SUMMARY_MIN_CHARS: 80,
        COMMENTS_COMPRESS_MODEL: "qwen/qwen3-next-80b-a3b-instruct",
      },
      async () => {
        const first = await processCommentsSummary(services, story, comments, undefined, path, store);
        expect(first.status).toBe("applied");
        const persisted = await store.getJson<CommentsSummary>(path);
        expect(persisted?.compressed?.text).toBe("");
        expect(persisted?.compressed?.sourceHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(chatCalls.length).toBe(1);

        const second = await processCommentsSummary(services, story, comments, undefined, path, store);
        expect(second.status).toBe("applied");
        expect(chatCalls.length).toBe(1);
      }
    );
  });

  test("transport error leaves compressed absent, returns compress-pending, lazy path retries", async () => {
    const story = makeStory({ id: 32, title: "Compress transport" });
    const comments = threeComments(story.id);
    const store = new MemoryStore();
    const path = "data/summaries/32.comments.json";
    let chatAttempts = 0;
    const { chatCalls, services } = structuredServices(
      [async () => VALID_INSIGHTS],
      [
        async () => {
          chatAttempts += 1;
          throw new Error("upstream timeout");
        },
        async () => VALID_COMPRESSED_RU,
      ]
    );

    await withEnvPatch(
      {
        SUMMARY_LANG: "ru",
        COMMENTS_SUMMARY_MIN_CHARS: 80,
        COMMENTS_COMPRESS_MODEL: "qwen/qwen3-next-80b-a3b-instruct",
      },
      async () => {
        const first = await processCommentsSummary(services, story, comments, undefined, path, store);
        expect(first.status).toBe("pending");
        if (first.status === "pending") {
          expect(first.reason).toBe("compress-pending");
        }
        const persisted = await store.getJson<CommentsSummary>(path);
        expect(persisted?.compressed).toBeUndefined();
        expect(persisted?.structured).toEqual(VALID_INSIGHTS);
        expect(chatAttempts).toBe(1);

        const second = await processCommentsSummary(services, story, comments, undefined, path, store);
        expect(second.status).toBe("applied");
        const after = await store.getJson<CommentsSummary>(path);
        expect(after?.compressed?.text).toBe(VALID_COMPRESSED_RU);
        expect(chatCalls.length).toBe(2);
      }
    );
  });

  test("shared budget exhausted by stage-1 skips compress (no fourth call)", async () => {
    const story = makeStory({ id: 33, title: "Budget exhaust" });
    const comments = threeComments(story.id);
    const store = new MemoryStore();
    const path = "data/summaries/33.comments.json";
    const { calls, chatCalls, services } = structuredServices(
      [
        async () => INVALID_LANGUAGE_INSIGHTS,
        async () => INVALID_LANGUAGE_INSIGHTS,
        async () => VALID_INSIGHTS,
      ],
      [async () => VALID_COMPRESSED_RU]
    );

    await withEnvPatch(
      {
        SUMMARY_LANG: "ru",
        COMMENTS_SUMMARY_MIN_CHARS: 80,
        COMMENTS_MAX_LLM_CALLS: 3,
        COMMENTS_COMPRESS_MODEL: "qwen/qwen3-next-80b-a3b-instruct",
      },
      async () => {
        const result = await processCommentsSummary(services, story, comments, undefined, path, store);
        expect(result.status).toBe("pending");
        if (result.status === "pending") {
          expect(result.reason).toBe("compress-pending");
        }
        expect(calls.length).toBe(3);
        expect(chatCalls.length).toBe(0);
        const persisted = await store.getJson<CommentsSummary>(path);
        expect(persisted?.structured).toEqual(VALID_INSIGHTS);
        expect(persisted?.compressed).toBeUndefined();
      }
    );
  });

  test("computeCommentsChanged is true for retryable compress inside cooldown and false for reject marker", async () => {
    const story = makeStory({ id: 34, title: "Cooldown compress" });
    const store = new MemoryStore();
    await store.putJson(pathFor.rawComments(story.id), threeComments(story.id));

    const base: CommentsSummary = {
      id: story.id,
      lang: "ru",
      summary: "structured markdown",
      formatVersion: 2,
      structured: VALID_INSIGHTS,
      inputHash: "hash",
      createdISO: new Date().toISOString(),
    };

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: "qwen/qwen3-next-80b-a3b-instruct" }, async () => {
      // absent compressed → retryable even inside cooldown
      expect(await computeCommentsChanged(story, base, "ru", 60_000, Date.now(), store)).toBeTrue();

      const { compressSourceHash, renderCommentsInsightsPlainText } = await import("../utils/comments-compress");
      const sourceHash = compressSourceHash("ru", renderCommentsInsightsPlainText(VALID_INSIGHTS));
      const rejected: CommentsSummary = {
        ...base,
        compressed: { text: "", model: "m", createdISO: base.createdISO!, sourceHash },
      };
      expect(await computeCommentsChanged(story, rejected, "ru", 60_000, Date.now(), store)).toBeFalse();

      const usable: CommentsSummary = {
        ...base,
        compressed: { text: VALID_COMPRESSED_RU, model: "m", createdISO: base.createdISO!, sourceHash },
      };
      expect(await computeCommentsChanged(story, usable, "ru", 60_000, Date.now(), store)).toBeFalse();
    });
  });
});
