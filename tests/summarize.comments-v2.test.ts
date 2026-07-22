import { describe, expect, test } from "bun:test";

import { COMMENTS_POLICY_VERSION, env } from "../config/env";
import { pathFor } from "../config/paths";
import type { CommentsInsights, CommentsSummary, NormalizedComment } from "../config/schemas";
import {
  CommentsGenerationBudget,
  buildCommentsPromptV2,
  commentsTpdExhaustionKey,
  computeCommentsChanged,
  estimateCommentsPromptTokens,
  generateValidatedCommentsSummaryV2,
  isCommentsQwen27bShareHit,
  isGroqTpdExhaustionError,
  makeServices,
  processCommentsSummary,
  selectCommentsSecondaryRoute,
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
      commentsTpdExhaustedModels: new Set<string>(),
    },
  };
}

function groqPairServices(handlers: {
  groq?: (call: StructuredCall) => Promise<CommentsInsights>;
  openrouter?: (call: StructuredCall) => Promise<CommentsInsights>;
}): {
  groqCalls: StructuredCall[];
  openRouterCalls: StructuredCall[];
  services: Services;
} {
  const groqCalls: StructuredCall[] = [];
  const openRouterCalls: StructuredCall[] = [];
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
      const call = { messages, options, maxRetries };
      groqCalls.push(call);
      if (handlers.groq === undefined) {
        throw new Error("unexpected Groq call");
      }
      return (await handlers.groq(call)) as T;
    },
  } as unknown) as Services["openrouter"];
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
      openRouterCalls.push(call);
      if (handlers.openrouter === undefined) {
        throw new Error("unexpected OpenRouter call");
      }
      return (await handlers.openrouter(call)) as T;
    },
  } as unknown) as Services["openrouter"];
  return {
    groqCalls,
    openRouterCalls,
    services: {
      http: {} as Services["http"],
      openrouter,
      guardTagsClient: groqClient,
      fetchArticleMarkdown: async () => ({ md: "", sourceKind: "empty" }),
      usage: createUsageCollector(),
      commentsTpdExhaustedModels: new Set<string>(),
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

  test("70b HTTP 429 then 8b HTTP 413 reaches OpenRouter Qwen within 3 calls", async () => {
    const story = makeStory({ id: 43, title: "Budget reaches Qwen" });
    const groqCalls: StructuredCall[] = [];
    const openRouterCalls: StructuredCall[] = [];
    const groqClient = ({
      chat: async () => {
        throw new Error("legacy chat must not be called by comments-v2");
      },
      chatStructured: async (messages: ChatMessage[], options: StructuredOutputOptions, _schema: unknown, maxRetries: number) => {
        groqCalls.push({ messages, options, maxRetries });
        if (options.model === env.COMMENTS_MODEL) {
          throw new Error("rate limited", {
            cause: new HttpError("https://api.groq.com/openai/v1", 429, "tokens per day (TPD)"),
          });
        }
        if (options.model === env.COMMENTS_FALLBACK_MODEL) {
          if (options.responseFormat !== undefined) {
            throw new UnsupportedResponseFormatError(
              new HttpError("https://api.groq.com/openai/v1", 400, "response_format is not supported")
            );
          }
          throw new Error("request too large", {
            cause: new HttpError("https://api.groq.com/openai/v1", 413, "Request too large for model"),
          });
        }
        throw new Error(`unexpected Groq model ${options.model ?? "<none>"}`);
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
    const budget = new CommentsGenerationBudget({ maxCalls: 3 });

    await withEnvPatch(
      { SUMMARY_LANG: "ru", COMMENTS_SUMMARY_MIN_CHARS: 200, COMMENTS_MAX_LLM_CALLS: 3, COMMENTS_COMPRESS_MODEL: "" },
      async () => {
        const result = await generateValidatedCommentsSummaryV2(services, {
          story,
          comments: threeComments(story.id),
          budget,
        });

        expect(result?.insights).toEqual(VALID_INSIGHTS);
        expect(result?.modelUsed).toBe(env.COMMENTS_OPENROUTER_FALLBACK_MODEL);
        expect(groqCalls.map((call) => call.options.model)).toEqual([
          env.COMMENTS_MODEL,
          env.COMMENTS_FALLBACK_MODEL,
        ]);
        expect(groqCalls.length).toBe(2);
        for (const call of groqCalls) {
          expect(call.options.responseFormat).toBeUndefined();
          expect(call.options.jsonExtraction).toBe("balanced-object");
        }
        expect(openRouterCalls.length).toBe(1);
        expect(openRouterCalls[0]?.options.model).toBe(env.COMMENTS_OPENROUTER_FALLBACK_MODEL);
        expect(openRouterCalls[0]?.options.responseFormat?.type).toBe("json_schema");
        expect(openRouterCalls[0]?.options.responseFormat?.json_schema.name).toBe("comments_insights_v2");
        expect(openRouterCalls[0]?.options.responseFormat?.json_schema.strict).toBe(true);
        expect(typeof openRouterCalls[0]?.options.responseFormat?.json_schema.schema).toBe("object");
        expect(openRouterCalls[0]?.options.jsonExtraction).toBe("strict");
        expect(budget.callsUsed).toBe(3);
      }
    );
  });

  test("Groq model_not_found advances chain without repeating the missing id", async () => {
    const story = makeStory({ id: 42, title: "Missing model" });
    const groqCalls: StructuredCall[] = [];
    const openRouterCalls: StructuredCall[] = [];
    const missingPrimary = env.COMMENTS_MODEL;
    const groqClient = ({
      chat: async () => {
        throw new Error("legacy chat must not be called by comments-v2");
      },
      chatStructured: async (messages: ChatMessage[], options: StructuredOutputOptions, _schema: unknown, maxRetries: number) => {
        groqCalls.push({ messages, options, maxRetries });
        if (options.model === missingPrimary) {
          throw new Error("model missing", {
            cause: new HttpError(
              "https://api.groq.com/openai/v1",
              404,
              'HTTP 404 {"error":{"code":"model_not_found","message":"does not exist"}}'
            ),
          });
        }
        return VALID_INSIGHTS;
      },
    } as unknown) as Services["openrouter"];
    const openrouter = ({
      chat: async () => {
        throw new Error("legacy chat must not be called by comments-v2");
      },
      chatStructured: async (messages: ChatMessage[], options: StructuredOutputOptions, _schema: unknown, maxRetries: number) => {
        openRouterCalls.push({ messages, options, maxRetries });
        throw new Error("OpenRouter must not be reached when Groq fallback succeeds");
      },
    } as unknown) as Services["openrouter"];
    const services: Services = {
      http: {} as Services["http"],
      openrouter,
      guardTagsClient: groqClient,
      fetchArticleMarkdown: async () => ({ md: "", sourceKind: "empty" }),
      usage: createUsageCollector(),
    };

    await withEnvPatch(
      { SUMMARY_LANG: "ru", COMMENTS_SUMMARY_MIN_CHARS: 200, COMMENTS_MAX_LLM_CALLS: 3, COMMENTS_COMPRESS_MODEL: "" },
      async () => {
        const result = await generateValidatedCommentsSummaryV2(services, {
          story,
          comments: threeComments(story.id),
        });
        expect(result?.insights).toEqual(VALID_INSIGHTS);
        expect(result?.modelUsed).toBe(env.COMMENTS_FALLBACK_MODEL);
        expect(groqCalls.map((call) => call.options.model)).toEqual([
          env.COMMENTS_MODEL,
          env.COMMENTS_FALLBACK_MODEL,
        ]);
        expect(openRouterCalls.length).toBe(0);
      }
    );
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

  test("transport error leaves compressed absent, returns applied, lazy path retries", async () => {
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
        // Stage-1 is applied even when compress is still pending — processing_state
        // must not flip commentsStatus to "missing" for a healthy structured blob.
        const first = await processCommentsSummary(services, story, comments, undefined, path, store);
        expect(first.status).toBe("applied");
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

  test("shared budget exhausted by stage-1 skips compress (no fourth call) but still applies", async () => {
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
        expect(result.status).toBe("applied");
        expect(calls.length).toBe(3);
        expect(chatCalls.length).toBe(0);
        const persisted = await store.getJson<CommentsSummary>(path);
        expect(persisted?.structured).toEqual(VALID_INSIGHTS);
        expect(persisted?.compressed).toBeUndefined();
      }
    );
  });

  test("permanent 4xx compress error writes reject marker and is not retried", async () => {
    const story = makeStory({ id: 35, title: "Compress 404" });
    const comments = threeComments(story.id);
    const store = new MemoryStore();
    const path = "data/summaries/35.comments.json";
    const { chatCalls, services } = structuredServices(
      [async () => VALID_INSIGHTS],
      [
        async () => {
          throw new HttpError("https://openrouter.ai/api/v1/chat/completions", 404, "model not found");
        },
      ]
    );

    await withEnvPatch(
      {
        SUMMARY_LANG: "ru",
        COMMENTS_SUMMARY_MIN_CHARS: 80,
        COMMENTS_COMPRESS_MODEL: "typo/model-id",
      },
      async () => {
        const first = await processCommentsSummary(services, story, comments, undefined, path, store);
        expect(first.status).toBe("applied");
        const persisted = await store.getJson<CommentsSummary>(path);
        expect(persisted?.compressed?.text).toBe("");
        expect(chatCalls.length).toBe(1);

        const second = await processCommentsSummary(services, story, comments, undefined, path, store);
        expect(second.status).toBe("applied");
        expect(chatCalls.length).toBe(1);
      }
    );
  });

  test("compress retry with drifted inputHash does not escalate into stage-1", async () => {
    const story = makeStory({ id: 36, title: "No stage-1 on compress retry" });
    const comments = threeComments(story.id);
    const store = new MemoryStore();
    const path = "data/summaries/36.comments.json";
    // Seed a structured blob whose inputHash is intentionally stale relative to
    // the current prompt — compress is still retryable, so the path must do a
    // one-call compress only, not a full stage-1 regen.
    await store.putJson(path, {
      id: story.id,
      lang: "ru",
      summary: "structured markdown",
      formatVersion: 2,
      structured: VALID_INSIGHTS,
      inputHash: "stale-hash-not-matching-current-prompt",
      createdISO: new Date().toISOString(),
    } satisfies CommentsSummary);

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
        const result = await processCommentsSummary(services, story, comments, undefined, path, store);
        expect(result.status).toBe("applied");
        expect(calls.length).toBe(0);
        expect(chatCalls.length).toBe(1);
        const after = await store.getJson<CommentsSummary>(path);
        expect(after?.compressed?.text).toBe(VALID_COMPRESSED_RU);
        // Stage-1 fields stay as seeded (inputHash not rewritten).
        expect(after?.inputHash).toBe("stale-hash-not-matching-current-prompt");
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

    // Compress disabled: absent compressed must NOT bypass cooldown.
    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: "" }, async () => {
      expect(await computeCommentsChanged(story, base, "ru", 60_000, Date.now(), store)).toBeFalse();
    });

    // EN deploy: compress gated off even if model is set.
    await withEnvPatch(
      { SUMMARY_LANG: "en", COMMENTS_COMPRESS_MODEL: "qwen/qwen3-next-80b-a3b-instruct" },
      async () => {
        expect(await computeCommentsChanged(story, base, "en", 60_000, Date.now(), store)).toBeFalse();
      }
    );
  });
});

describe("comments-v2 qwen27b feature-flag routing (Phase 3 scaffold)", () => {
  const QWEN = "qwen/qwen3.6-27b";
  const FLAG_ON = {
    SUMMARY_LANG: "ru" as const,
    COMMENTS_SUMMARY_MIN_CHARS: 200,
    COMMENTS_COMPRESS_MODEL: "",
    COMMENTS_MAX_LLM_CALLS: 3,
    COMMENTS_QWEN27B_ROUTE_ENABLE: true,
    COMMENTS_QWEN27B_ROUTE_SHARE: 100,
    COMMENTS_QWEN27B_MODEL: QWEN,
    COMMENTS_SUMMARY_MAX_TOKENS: 2500,
    COMMENTS_SHORT_ROUTE_MAX_RESERVED_TOKENS: 5500,
    COMMENTS_QWEN27B_MAX_RESERVED_TOKENS: 8000,
  };

  test("selectCommentsSecondaryRoute: flag off stays legacy; size splits short/medium/large", () => {
    const base = {
      fallbackModel: "llama-3.1-8b-instant",
      maxOutputTokens: 2500,
      qwen27bMaxReservedTokens: 8000,
      qwen27bModel: QWEN,
      qwen27bSharePercent: 100,
      shortMaxReservedTokens: 5500,
      storyId: 42,
    };
    expect(selectCommentsSecondaryRoute({ ...base, enableQwen27b: false, estimateTokens: 1000 }).kind).toBe("legacy");
    // reserved = 2000+2500 = 4500 < 5500 → short
    expect(selectCommentsSecondaryRoute({ ...base, enableQwen27b: true, estimateTokens: 2000 }).kind).toBe("short-8b");
    // reserved = 4000+2500 = 6500 → medium qwen
    expect(selectCommentsSecondaryRoute({ ...base, enableQwen27b: true, estimateTokens: 4000 })).toEqual({
      estimateTokens: 4000,
      kind: "medium-qwen",
      model: QWEN,
      reason: "medium-reserved-fits-qwen",
      reservedTokens: 6500,
      shareBucket: 42,
    });
    // reserved = 6000+2500 = 8500 > 8000 → large skip
    expect(selectCommentsSecondaryRoute({ ...base, enableQwen27b: true, estimateTokens: 6000 }).kind).toBe("large-skip");
    // TPD-exhausted qwen uses gateway-prefixed key → skip secondary
    expect(
      selectCommentsSecondaryRoute({
        ...base,
        enableQwen27b: true,
        estimateTokens: 4000,
        tpdExhaustedModels: new Set([commentsTpdExhaustionKey("groq", QWEN)]),
      }).reason
    ).toBe("medium-qwen-tpd-exhausted");
    // Bare model id (no gateway prefix) must NOT match — prevents accidental cross-provider trips.
    expect(
      selectCommentsSecondaryRoute({
        ...base,
        enableQwen27b: true,
        estimateTokens: 4000,
        tpdExhaustedModels: new Set([QWEN]),
      }).kind
    ).toBe("medium-qwen");
  });

  test("medium share: enable+share0 is legacy; share hit is deterministic by story id", () => {
    expect(isCommentsQwen27bShareHit(10, 0)).toBe(false);
    expect(isCommentsQwen27bShareHit(10, 100)).toBe(true);
    expect(isCommentsQwen27bShareHit(10, 10)).toBe(false); // 10 % 100 = 10, not < 10
    expect(isCommentsQwen27bShareHit(9, 10)).toBe(true);
    expect(isCommentsQwen27bShareHit(109, 10)).toBe(true); // 109 % 100 = 9

    const base = {
      enableQwen27b: true,
      estimateTokens: 4000,
      fallbackModel: "llama-3.1-8b-instant",
      maxOutputTokens: 2500,
      qwen27bMaxReservedTokens: 8000,
      qwen27bModel: QWEN,
      shortMaxReservedTokens: 5500,
    };
    // ENABLE alone with SHARE=0 must not flip medium to Qwen (safe deploy).
    const shareZero = selectCommentsSecondaryRoute({ ...base, qwen27bSharePercent: 0, storyId: 9 });
    expect(shareZero.kind).toBe("legacy");
    expect(shareZero.reason).toBe("share-zero-legacy-8b");

    const miss = selectCommentsSecondaryRoute({ ...base, qwen27bSharePercent: 10, storyId: 10 });
    expect(miss.kind).toBe("legacy");
    expect(miss.reason).toBe("share-miss-legacy-8b");

    const hit = selectCommentsSecondaryRoute({ ...base, qwen27bSharePercent: 10, storyId: 9 });
    expect(hit.kind).toBe("medium-qwen");
    expect(hit.shareBucket).toBe(9);
  });

  test("isGroqTpdExhaustionError matches only explicit TPD 429 bodies", () => {
    expect(
      isGroqTpdExhaustionError(
        new Error("rate limited", {
          cause: new HttpError("https://api.groq.com", 429, "tokens per day (TPD) limit"),
        })
      )
    ).toBe(true);
    expect(
      isGroqTpdExhaustionError(
        new Error("rate limited", {
          cause: new HttpError("https://api.groq.com", 429, "tokens per minute (TPM) Limit 8000"),
        })
      )
    ).toBe(false);
    expect(
      isGroqTpdExhaustionError(new Error("timeout", { cause: new HttpError("https://api.groq.com", 503, "down") }))
    ).toBe(false);
  });

  test("flag off keeps the legacy 70b → 8b → paid chain", async () => {
    const story = makeStory({ id: 301, title: "Flag off" });
    const { groqCalls, openRouterCalls, services } = groqPairServices({
      groq: async () => {
        throw new Error("rate limited", {
          cause: new HttpError("https://api.groq.com", 429, "tokens per day (TPD)"),
        });
      },
      openrouter: async () => VALID_INSIGHTS,
    });

    await withEnvPatch(
      { SUMMARY_LANG: "ru", COMMENTS_SUMMARY_MIN_CHARS: 200, COMMENTS_MAX_LLM_CALLS: 3, COMMENTS_COMPRESS_MODEL: "", COMMENTS_QWEN27B_ROUTE_ENABLE: false },
      async () => {
        const result = await generateValidatedCommentsSummaryV2(services, {
          story,
          comments: threeComments(story.id),
        });
        expect(result?.modelUsed).toBe(env.COMMENTS_OPENROUTER_FALLBACK_MODEL);
        expect(groqCalls.map((c) => c.options.model)).toEqual([env.COMMENTS_MODEL, env.COMMENTS_FALLBACK_MODEL]);
        expect(openRouterCalls.map((c) => c.options.model)).toEqual([env.COMMENTS_OPENROUTER_FALLBACK_MODEL]);
        // No reasoning_effort on llama hops.
        for (const call of groqCalls) {
          expect(call.options.reasoningEffort).toBeUndefined();
        }
      }
    );
  });

  test("medium input under flag picks Qwen 27b with reasoning_effort=none and balanced-object", async () => {
    const story = makeStory({ id: 302, title: "Medium qwen" });
    // Force medium: estimateTokens + maxOut in (shortCap, qwenCap].
    // threeComments prompt is small → stub by patching short cap below reserved of tiny prompts.
    const { groqCalls, openRouterCalls, services } = groqPairServices({
      groq: async (call) => {
        if (call.options.model === env.COMMENTS_MODEL) {
          throw new Error("rate limited", {
            cause: new HttpError("https://api.groq.com", 429, "tokens per day (TPD)"),
          });
        }
        if (call.options.model === QWEN) {
          return VALID_INSIGHTS;
        }
        throw new Error(`unexpected groq model ${call.options.model ?? "?"}`);
      },
    });

    await withEnvPatch(
      {
        ...FLAG_ON,
        // threeComments reserved is well under 5500 with default caps; drop short cap so
        // the same fixture lands in the medium bucket without fabricating a huge prompt.
        COMMENTS_SHORT_ROUTE_MAX_RESERVED_TOKENS: 1,
      },
      async () => {
        const result = await generateValidatedCommentsSummaryV2(services, {
          story,
          comments: threeComments(story.id),
        });
        expect(result?.insights).toEqual(VALID_INSIGHTS);
        expect(result?.modelUsed).toBe(QWEN);
        expect(result?.summary.trim().length).toBeGreaterThan(0);
        expect(groqCalls.map((c) => c.options.model)).toEqual([env.COMMENTS_MODEL, QWEN]);
        expect(openRouterCalls.length).toBe(0);
        const qwenCall = groqCalls[1];
        expect(qwenCall?.options.reasoningEffort).toBe("none");
        // Temperature 0 matches the Phase 1 smoke policy (not the legacy llama 0.2).
        expect(qwenCall?.options.temperature).toBe(0);
        expect(qwenCall?.options.jsonExtraction).toBe("balanced-object");
        expect(qwenCall?.options.responseFormat).toBeUndefined();
        // System+user messages still carry the production V2 prompt shape.
        expect(qwenCall?.messages.length).toBe(2);
        expect(qwenCall?.messages[0]?.role).toBe("system");
        expect(qwenCall?.messages[1]?.role).toBe("user");
        expect(qwenCall?.messages[1]?.content.length).toBeGreaterThan(0);
        // Primary llama hop keeps historical temperature.
        expect(groqCalls[0]?.options.temperature).toBe(0.2);
      }
    );
  });

  test("short input under flag still uses 8b, not Qwen", async () => {
    const story = makeStory({ id: 303, title: "Short 8b" });
    const { groqCalls, services } = groqPairServices({
      groq: async (call) => {
        if (call.options.model === env.COMMENTS_MODEL) {
          throw new Error("rate limited", {
            cause: new HttpError("https://api.groq.com", 429, "tokens per day (TPD)"),
          });
        }
        if (call.options.model === env.COMMENTS_FALLBACK_MODEL) {
          return VALID_INSIGHTS;
        }
        throw new Error(`unexpected groq model ${call.options.model ?? "?"}`);
      },
    });

    await withEnvPatch(
      {
        ...FLAG_ON,
        // Make short bucket absorb the tiny fixture.
        COMMENTS_SHORT_ROUTE_MAX_RESERVED_TOKENS: 100_000,
      },
      async () => {
        const result = await generateValidatedCommentsSummaryV2(services, {
          story,
          comments: threeComments(story.id),
        });
        expect(result?.modelUsed).toBe(env.COMMENTS_FALLBACK_MODEL);
        expect(groqCalls.map((c) => c.options.model)).toEqual([env.COMMENTS_MODEL, env.COMMENTS_FALLBACK_MODEL]);
        expect(groqCalls[1]?.options.reasoningEffort).toBeUndefined();
      }
    );
  });

  test("large reserved input skips both free secondary hops and reaches paid within 3 calls", async () => {
    const story = makeStory({ id: 304, title: "Large skip" });
    const budget = new CommentsGenerationBudget({ maxCalls: 3 });
    const { groqCalls, openRouterCalls, services } = groqPairServices({
      groq: async (call) => {
        if (call.options.model === env.COMMENTS_MODEL) {
          throw new Error("rate limited", {
            cause: new HttpError("https://api.groq.com", 429, "tokens per day (TPD)"),
          });
        }
        throw new Error(`secondary free hop must be skipped, got ${call.options.model ?? "?"}`);
      },
      openrouter: async () => VALID_INSIGHTS,
    });

    await withEnvPatch(
      {
        ...FLAG_ON,
        COMMENTS_SHORT_ROUTE_MAX_RESERVED_TOKENS: 1,
        COMMENTS_QWEN27B_MAX_RESERVED_TOKENS: 1,
      },
      async () => {
        const result = await generateValidatedCommentsSummaryV2(services, {
          story,
          comments: threeComments(story.id),
          budget,
        });
        expect(result?.modelUsed).toBe(env.COMMENTS_OPENROUTER_FALLBACK_MODEL);
        expect(groqCalls.map((c) => c.options.model)).toEqual([env.COMMENTS_MODEL]);
        expect(openRouterCalls.map((c) => c.options.model)).toEqual([env.COMMENTS_OPENROUTER_FALLBACK_MODEL]);
        expect(budget.callsUsed).toBe(2);
      }
    );
  });

  test("invalid EN candidate from Qwen is not published; chain advances", async () => {
    const story = makeStory({ id: 305, title: "Bad qwen" });
    const { groqCalls, openRouterCalls, services } = groqPairServices({
      groq: async (call) => {
        if (call.options.model === env.COMMENTS_MODEL) {
          throw new Error("rate limited", {
            cause: new HttpError("https://api.groq.com", 429, "tokens per day (TPD)"),
          });
        }
        if (call.options.model === QWEN) {
          return INVALID_LANGUAGE_INSIGHTS;
        }
        throw new Error(`unexpected groq model ${call.options.model ?? "?"}`);
      },
      openrouter: async () => VALID_INSIGHTS,
    });

    await withEnvPatch(
      { ...FLAG_ON, COMMENTS_SHORT_ROUTE_MAX_RESERVED_TOKENS: 1 },
      async () => {
        const result = await generateValidatedCommentsSummaryV2(services, {
          story,
          comments: threeComments(story.id),
        });
        expect(result?.modelUsed).toBe(env.COMMENTS_OPENROUTER_FALLBACK_MODEL);
        expect(result?.insights).toEqual(VALID_INSIGHTS);
        expect(groqCalls.map((c) => c.options.model)).toEqual([env.COMMENTS_MODEL, QWEN]);
        expect(openRouterCalls.length).toBe(1);
      }
    );
  });

  test("Qwen TPD disables only Qwen for the next story; TPM does not; fresh Services resets", async () => {
    const storyA = makeStory({ id: 306, title: "TPD A" });
    const storyB = makeStory({ id: 307, title: "TPD B" });
    const storyC = makeStory({ id: 308, title: "TPM C" });

    let qwenHits = 0;
    const { groqCalls, openRouterCalls, services } = groqPairServices({
      groq: async (call) => {
        if (call.options.model === env.COMMENTS_MODEL) {
          throw new Error("rate limited", {
            cause: new HttpError("https://api.groq.com", 429, "tokens per day (TPD)"),
          });
        }
        if (call.options.model === QWEN) {
          qwenHits += 1;
          throw new Error("rate limited", {
            cause: new HttpError("https://api.groq.com", 429, "tokens per day (TPD) Limit 200000"),
          });
        }
        throw new Error(`unexpected groq model ${call.options.model ?? "?"}`);
      },
      openrouter: async () => VALID_INSIGHTS,
    });

    await withEnvPatch(
      { ...FLAG_ON, COMMENTS_SHORT_ROUTE_MAX_RESERVED_TOKENS: 1 },
      async () => {
        // Story A: 70b TPD → Qwen TPD → paid. Qwen marked exhausted.
        const a = await generateValidatedCommentsSummaryV2(services, {
          story: storyA,
          comments: threeComments(storyA.id),
        });
        expect(a?.modelUsed).toBe(env.COMMENTS_OPENROUTER_FALLBACK_MODEL);
        expect(qwenHits).toBe(1);
        expect(services.commentsTpdExhaustedModels?.has(commentsTpdExhaustionKey("groq", QWEN))).toBe(true);
        expect(services.commentsTpdExhaustedModels?.has(commentsTpdExhaustionKey("groq", env.COMMENTS_MODEL))).toBe(true);
        // Paid OpenRouter key must never be written from a Groq TPD trip.
        expect(services.commentsTpdExhaustedModels?.has(commentsTpdExhaustionKey("openrouter", env.COMMENTS_OPENROUTER_FALLBACK_MODEL))).toBe(false);
        expect(services.commentsTpdExhaustedModels?.has(QWEN)).toBe(false);

        const callsAfterA = groqCalls.length;

        // Story B: primary already TPD-exhausted → skipped; Qwen skipped; paid only.
        const b = await generateValidatedCommentsSummaryV2(services, {
          story: storyB,
          comments: threeComments(storyB.id),
        });
        expect(b?.modelUsed).toBe(env.COMMENTS_OPENROUTER_FALLBACK_MODEL);
        expect(qwenHits).toBe(1); // no second Qwen attempt
        expect(groqCalls.length).toBe(callsAfterA); // no new Groq calls
        expect(openRouterCalls.length).toBe(2);

        // TPM 429 must NOT expand the exhausted set with a new id.
        const tpmServices: Services = {
          ...services,
          commentsTpdExhaustedModels: new Set<string>(),
          guardTagsClient: ({
            chat: async () => {
              throw new Error("no chat");
            },
            chatStructured: async () => {
              throw new Error("tpm", {
                cause: new HttpError("https://api.groq.com", 429, "tokens per minute (TPM) Limit 8000"),
              });
            },
          } as unknown) as Services["openrouter"],
          openrouter: ({
            chat: async () => {
              throw new Error("no chat");
            },
            chatStructured: async <T>(): Promise<T> => VALID_INSIGHTS as T,
          } as unknown) as Services["openrouter"],
        };
        await generateValidatedCommentsSummaryV2(tpmServices, {
          story: storyC,
          comments: threeComments(storyC.id),
        });
        expect(tpmServices.commentsTpdExhaustedModels?.size ?? 0).toBe(0);

        // Fresh Services starts clean — Qwen is eligible again.
        const fresh = groqPairServices({
          groq: async (call) => {
            if (call.options.model === QWEN) {
              return VALID_INSIGHTS;
            }
            throw new Error("rate limited", {
              cause: new HttpError("https://api.groq.com", 429, "tokens per day (TPD)"),
            });
          },
        });
        const c = await generateValidatedCommentsSummaryV2(fresh.services, {
          story: storyC,
          comments: threeComments(storyC.id),
        });
        expect(c?.modelUsed).toBe(QWEN);
        expect(fresh.groqCalls.some((call) => call.options.model === QWEN)).toBe(true);
      }
    );
  });

  test("estimateCommentsPromptTokens includes system prompt + margin and is deterministic", () => {
    const user = "abcd";
    const withMargin = estimateCommentsPromptTokens(user, { marginTokens: 600, maxInsights: 5 });
    const bare = estimateCommentsPromptTokens(user, { marginTokens: 0, maxInsights: 5 });
    expect(withMargin - bare).toBe(600);
    expect(bare).toBeGreaterThan(Math.ceil(user.length / 4)); // system instruction counted
    expect(estimateCommentsPromptTokens(user, { marginTokens: 600, maxInsights: 5 })).toBe(withMargin);
  });

  test("near Qwen 8k cap, margin pushes borderline reserved into large-skip", () => {
    // Without margin a user-only chars/4 estimate of 5000 + 2500 out = 7500 would look safe.
    // With system+margin the same user prompt must reserve over 8000 → large-skip.
    const userChars = 5000 * 4; // 5000 tokens if user-only chars/4
    const user = "x".repeat(userChars);
    const estimate = estimateCommentsPromptTokens(user, { marginTokens: 600, maxInsights: 5 });
    expect(estimate).toBeGreaterThan(5000); // system + margin
    const decision = selectCommentsSecondaryRoute({
      enableQwen27b: true,
      estimateTokens: estimate,
      fallbackModel: "llama-3.1-8b-instant",
      maxOutputTokens: 2500,
      qwen27bMaxReservedTokens: 8000,
      qwen27bModel: QWEN,
      qwen27bSharePercent: 100,
      shortMaxReservedTokens: 5500,
      storyId: 1,
    });
    expect(decision.kind).toBe("large-skip");
    expect(decision.reservedTokens).toBeGreaterThan(8000);
  });

  test("Groq TPD on a model id cannot disable paid OpenRouter hop with the same id", async () => {
    const collidingId = "same-model-id";
    const story = makeStory({ id: 309, title: "Gateway isolation" });
    const { groqCalls, openRouterCalls, services } = groqPairServices({
      groq: async () => {
        throw new Error("rate limited", {
          cause: new HttpError("https://api.groq.com", 429, "tokens per day (TPD)"),
        });
      },
      openrouter: async () => VALID_INSIGHTS,
    });

    await withEnvPatch(
      {
        ...FLAG_ON,
        COMMENTS_MODEL: collidingId,
        COMMENTS_FALLBACK_MODEL: "",
        COMMENTS_QWEN27B_MODEL: "",
        COMMENTS_OPENROUTER_FALLBACK_MODEL: collidingId,
        COMMENTS_SHORT_ROUTE_MAX_RESERVED_TOKENS: 1,
        COMMENTS_QWEN27B_MAX_RESERVED_TOKENS: 1,
      },
      async () => {
        const first = await generateValidatedCommentsSummaryV2(services, {
          story,
          comments: threeComments(story.id),
        });
        expect(first?.modelUsed).toBe(collidingId);
        expect(groqCalls.length).toBe(1);
        expect(openRouterCalls.length).toBe(1);
        expect(services.commentsTpdExhaustedModels?.has(commentsTpdExhaustionKey("groq", collidingId))).toBe(true);

        // Second story: Groq primary skipped; paid OpenRouter with same bare id still runs.
        const second = await generateValidatedCommentsSummaryV2(services, {
          story: makeStory({ id: 310, title: "Still paid" }),
          comments: threeComments(310),
        });
        expect(second?.modelUsed).toBe(collidingId);
        expect(groqCalls.length).toBe(1); // no new Groq call
        expect(openRouterCalls.length).toBe(2);
      }
    );
  });

  test("makeServices reuses an injected TPD set across instances (worker batch contract)", () => {
    const shared = new Set<string>([commentsTpdExhaustionKey("groq", "llama-3.3-70b-versatile")]);
    const a = makeServices(env, { commentsTpdExhaustedModels: shared });
    const b = makeServices(env, { commentsTpdExhaustedModels: shared });
    expect(a.commentsTpdExhaustedModels).toBe(shared);
    expect(b.commentsTpdExhaustedModels).toBe(shared);
    a.commentsTpdExhaustedModels?.add(commentsTpdExhaustionKey("groq", QWEN));
    expect(b.commentsTpdExhaustedModels?.has(commentsTpdExhaustionKey("groq", QWEN))).toBe(true);
  });
});
