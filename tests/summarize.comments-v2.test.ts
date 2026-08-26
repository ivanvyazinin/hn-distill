import { describe, expect, test } from "bun:test";

import { COMMENTS_POLICY_VERSION, env } from "../config/env";
import { pathFor } from "../config/paths";
import type { CommentsInsights, CommentsSummary, NormalizedComment } from "../config/schemas";
import {
  CommentsGenerationBudget,
  buildCommentsPromptV2,
  commentsTpdExhaustionKey,
  computeCommentsChanged,
  generateValidatedCommentsSummaryV2,
  isGroqTpdExhaustionError,
  makeServices,
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

  test("default chain pins hop 1 to the MiniMax gateway (MiniMax-M3, reasoning none, balanced-object)", async () => {
    const story = makeStory({ id: 44, title: "MiniMax primary" });
    const minimaxCalls: StructuredCall[] = [];
    const groqCalls: StructuredCall[] = [];
    const minimaxClient = ({
      chat: async () => {
        throw new Error("legacy chat must not be called by comments-v2");
      },
      chatStructured: async <T>(
        messages: ChatMessage[],
        options: StructuredOutputOptions,
        _schema: unknown,
        maxRetries: number
      ): Promise<T> => {
        minimaxCalls.push({ messages, options, maxRetries });
        // HTTP-caused failure → the ladder advances instead of retrying the same hop.
        throw new Error("minimax down", {
          cause: new HttpError("https://api.minimax.io/v1/chat/completions", 503),
        });
      },
    } as unknown) as Services["openrouter"];
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
    const openrouter = ({
      chatStructured: async () => {
        throw new Error("paid last resort must not run when the Groq ladder answers");
      },
    } as unknown) as Services["openrouter"];
    const services: Services = {
      http: {} as Services["http"],
      openrouter,
      guardTagsClient: groqClient,
      commentsMinimaxClient: minimaxClient,
      fetchArticleMarkdown: async () => ({ md: "", sourceKind: "empty" }),
      usage: createUsageCollector(),
    };

    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_SUMMARY_MIN_CHARS: 200, COMMENTS_COMPRESS_MODEL: "" }, async () => {
      const result = await generateValidatedCommentsSummaryV2(services, {
        story,
        comments: threeComments(story.id),
      });

      expect(result?.insights).toEqual(VALID_INSIGHTS);
      expect(result?.modelUsed).toBe(env.COMMENTS_MODEL);
      expect(minimaxCalls.length).toBe(1);
      expect(minimaxCalls[0]?.options.model).toBe(env.COMMENTS_MINIMAX_MODEL);
      expect(minimaxCalls[0]?.options.reasoningEffort).toBe("none");
      expect(minimaxCalls[0]?.options.temperature).toBe(0.2);
      expect(minimaxCalls[0]?.options.jsonExtraction).toBe("balanced-object");
      expect(minimaxCalls[0]?.options.responseFormat).toBeUndefined();
      // Slow reasoning hop gets its own ceiling; Groq hops keep the shared base.
      expect(minimaxCalls[0]?.options.requestTimeoutMs).toBe(env.COMMENTS_MINIMAX_REQUEST_TIMEOUT_MS);
      expect(minimaxCalls[0]?.options.requestTimeoutMs).toBeGreaterThan(env.COMMENTS_LLM_REQUEST_TIMEOUT_MS);
      // The paid gpt-oss ladder follows unchanged: Groq 120b is hop 2.
      expect(groqCalls.map((call) => call.options.model)).toEqual([env.COMMENTS_MODEL]);
      expect(groqCalls[0]?.options.responseFormat).toBeUndefined();
      expect(groqCalls[0]?.options.jsonExtraction).toBe("balanced-object");
      expect(groqCalls[0]?.options.requestTimeoutMs).toBe(env.COMMENTS_LLM_REQUEST_TIMEOUT_MS);
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

  test("selection computes the same policy hash as persistence; title/post drift is hash-only when count gate off", async () => {
    // Without descendants snapshots (or with gate threshold 0) title/post changes
    // still flip the inputHash. With the default +N gate and processedDescendants
    // present, title/post drift alone is intentionally ignored — covered below.
    const story = makeStory({ id: 23, title: "Original title" });
    const comments = [longComment(231, story.id, "Один подробный ответ объясняет порядок проверки и запуска новой системы.")];
    const postSummary = { id: story.id, lang: "ru" as const, summary: "Краткая суть исходной статьи для контекста." };
    const store = new MemoryStore();
    const path = "data/summaries/23.comments.json";
    const { services } = structuredServices([]);
    await store.putJson(pathFor.rawComments(story.id), comments);
    await store.putJson(pathFor.postSummary(story.id), postSummary);

    await withEnvPatch(
      { SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: "", COMMENTS_REGEN_MIN_NEW_COMMENTS: 0 },
      async () => {
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
      }
    );
  });
});

describe("comments-v2 descendants regen gate", () => {
  test("delta within threshold skips computeCommentsChanged hash path and processCommentsSummary LLM", async () => {
    const story = makeStory({ id: 50, title: "Gate hold", descendants: 150 });
    const comments = threeComments(story.id);
    const store = new MemoryStore();
    const path = "data/summaries/50.comments.json";
    const { calls, services } = structuredServices([async () => VALID_INSIGHTS]);

    await withEnvPatch(
      {
        SUMMARY_LANG: "ru",
        COMMENTS_SUMMARY_MIN_CHARS: 80,
        COMMENTS_COMPRESS_MODEL: "",
        COMMENTS_REGEN_MIN_NEW_COMMENTS: 100,
      },
      async () => {
        const first = await processCommentsSummary(services, story, comments, undefined, path, store);
        expect(first.status).toBe("applied");
        if (first.status !== "applied") {
          return;
        }
        expect(first.summary.processedDescendants).toBe(150);
        expect(first.summary.policyVersion).toBe(COMMENTS_POLICY_VERSION);
        expect(calls.length).toBe(1);

        // Mutate prompt inputs so the hash would differ, but keep delta ≤ 100.
        const grown = { ...story, title: "Changed title", descendants: 250 };
        await store.putJson(pathFor.rawComments(story.id), [
          ...comments,
          longComment(199, story.id, "Новый комментарий не должен форсировать реген при малой дельте."),
        ]);
        // No rawComments/postSummary needed for the short-circuit — even empty store is fine.
        expect(await computeCommentsChanged(grown, first.summary, "ru", 0, Date.now(), store)).toBeFalse();

        const second = await processCommentsSummary(services, grown, comments, undefined, path, store);
        expect(second.status).toBe("applied");
        expect(calls.length).toBe(1);
        const persisted = await store.getJson<CommentsSummary>(path);
        expect(persisted?.processedDescendants).toBe(150);
        expect(persisted?.inputHash).toBe(first.summary.inputHash);
      }
    );
  });

  test("delta above threshold regenerates and rewrites processedDescendants", async () => {
    const story = makeStory({ id: 51, title: "Gate fire", descendants: 100 });
    const comments = threeComments(story.id);
    const store = new MemoryStore();
    const path = "data/summaries/51.comments.json";
    const { calls, services } = structuredServices([
      async () => VALID_INSIGHTS,
      async () => VALID_INSIGHTS,
    ]);

    await withEnvPatch(
      {
        SUMMARY_LANG: "ru",
        COMMENTS_SUMMARY_MIN_CHARS: 80,
        COMMENTS_COMPRESS_MODEL: "",
        COMMENTS_REGEN_MIN_NEW_COMMENTS: 100,
      },
      async () => {
        const first = await processCommentsSummary(services, story, comments, undefined, path, store);
        expect(first.status).toBe("applied");
        if (first.status !== "applied") {
          return;
        }
        expect(first.summary.processedDescendants).toBe(100);

        const grown = { ...story, descendants: 201 };
        expect(await computeCommentsChanged(grown, first.summary, "ru", 0, Date.now(), store)).toBeTrue();

        const second = await processCommentsSummary(services, grown, comments, undefined, path, store);
        expect(second.status).toBe("applied");
        expect(calls.length).toBe(2);
        const persisted = await store.getJson<CommentsSummary>(path);
        expect(persisted?.processedDescendants).toBe(201);
        expect(persisted?.policyVersion).toBe(COMMENTS_POLICY_VERSION);
      }
    );
  });

  test("legacy blob without processedDescendants falls back to inputHash", async () => {
    const story = makeStory({ id: 52, title: "Legacy fallback", descendants: 200 });
    const comments = threeComments(story.id);
    const store = new MemoryStore();
    await store.putJson(pathFor.rawComments(story.id), comments);

    const legacy: CommentsSummary = {
      id: story.id,
      lang: "ru",
      summary: "legacy structured markdown",
      formatVersion: 2,
      structured: VALID_INSIGHTS,
      inputHash: "stale-hash-without-descendants-field",
      createdISO: new Date(0).toISOString(),
      // no processedDescendants / policyVersion
    };

    await withEnvPatch(
      { SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: "", COMMENTS_REGEN_MIN_NEW_COMMENTS: 100 },
      async () => {
        expect(await computeCommentsChanged(story, legacy, "ru", 0, Date.now(), store)).toBeTrue();
      }
    );
  });

  test("policyVersion mismatch forces regen at any delta", async () => {
    const story = makeStory({ id: 53, title: "Policy bump", descendants: 120 });
    const comments = threeComments(story.id);
    const store = new MemoryStore();
    const path = "data/summaries/53.comments.json";
    const { calls, services } = structuredServices([async () => VALID_INSIGHTS]);

    const stale: CommentsSummary = {
      id: story.id,
      lang: "ru",
      summary: "old policy blob",
      formatVersion: 2,
      structured: VALID_INSIGHTS,
      inputHash: "whatever",
      createdISO: new Date(0).toISOString(),
      processedDescendants: 120,
      policyVersion: "1",
    };
    await store.putJson(path, stale);

    await withEnvPatch(
      {
        SUMMARY_LANG: "ru",
        COMMENTS_SUMMARY_MIN_CHARS: 80,
        COMMENTS_COMPRESS_MODEL: "",
        COMMENTS_REGEN_MIN_NEW_COMMENTS: 100,
      },
      async () => {
        expect(await computeCommentsChanged(story, stale, "ru", 0, Date.now(), store)).toBeTrue();
        const result = await processCommentsSummary(services, story, comments, undefined, path, store);
        expect(result.status).toBe("applied");
        expect(calls.length).toBe(1);
        const persisted = await store.getJson<CommentsSummary>(path);
        expect(persisted?.policyVersion).toBe(COMMENTS_POLICY_VERSION);
        expect(persisted?.processedDescendants).toBe(120);
      }
    );
  });

  test("undefined story.descendants falls back to inputHash", async () => {
    const story = makeStory({ id: 54, title: "No descendants" }); // descendants omitted
    const comments = threeComments(story.id);
    const store = new MemoryStore();
    await store.putJson(pathFor.rawComments(story.id), comments);

    const existing: CommentsSummary = {
      id: story.id,
      lang: "ru",
      summary: "blob with snapshot",
      formatVersion: 2,
      structured: VALID_INSIGHTS,
      inputHash: "stale-hash",
      createdISO: new Date(0).toISOString(),
      processedDescendants: 50,
      policyVersion: COMMENTS_POLICY_VERSION,
    };

    await withEnvPatch(
      { SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: "", COMMENTS_REGEN_MIN_NEW_COMMENTS: 100 },
      async () => {
        expect(await computeCommentsChanged(story, existing, "ru", 0, Date.now(), store)).toBeTrue();
      }
    );
  });

  test("threshold 0 restores hash-only behavior even with snapshots", async () => {
    const story = makeStory({ id: 55, title: "Gate off", descendants: 100 });
    const comments = threeComments(story.id);
    const store = new MemoryStore();
    await store.putJson(pathFor.rawComments(story.id), comments);

    const existing: CommentsSummary = {
      id: story.id,
      lang: "ru",
      summary: "snapshot present",
      formatVersion: 2,
      structured: VALID_INSIGHTS,
      inputHash: "stale-hash",
      createdISO: new Date(0).toISOString(),
      processedDescendants: 100,
      policyVersion: COMMENTS_POLICY_VERSION,
    };

    await withEnvPatch(
      { SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: "", COMMENTS_REGEN_MIN_NEW_COMMENTS: 0 },
      async () => {
        expect(await computeCommentsChanged(story, existing, "ru", 0, Date.now(), store)).toBeTrue();
      }
    );
  });

  test("generation-failed still forces regen under the count gate", async () => {
    const story = makeStory({ id: 56, title: "Failed still retries", descendants: 80 });
    const store = new MemoryStore();
    await store.putJson(pathFor.rawComments(story.id), threeComments(story.id));

    const failed: CommentsSummary = {
      id: story.id,
      lang: "ru",
      summary: "fallback",
      formatVersion: 2,
      degraded: "generation-failed",
      inputHash: "x",
      createdISO: new Date().toISOString(),
      processedDescendants: 80,
      policyVersion: COMMENTS_POLICY_VERSION,
    };

    await withEnvPatch(
      { SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: "", COMMENTS_REGEN_MIN_NEW_COMMENTS: 100 },
      async () => {
        expect(await computeCommentsChanged(story, failed, "ru", 60_000, Date.now(), store)).toBeTrue();
      }
    );
  });

  test("too-few-comments is not pinned by the count gate and upgrades on hash change", async () => {
    // Early thin thread writes degraded too-few with processedDescendants. Growth
    // within threshold must NOT freeze the fallback — hash path must still fire so
    // a later substantive sample can produce a real structured summary.
    const story = makeStory({ id: 58, title: "Too few upgrade", descendants: 5 });
    const thin = [longComment(581, story.id, "Один короткий ответ без достаточной дискуссии.")];
    const rich = threeComments(story.id);
    const store = new MemoryStore();
    const path = "data/summaries/58.comments.json";
    const { calls, services } = structuredServices([async () => VALID_INSIGHTS]);

    await withEnvPatch(
      {
        SUMMARY_LANG: "ru",
        COMMENTS_SUMMARY_MIN_CHARS: 80,
        COMMENTS_COMPRESS_MODEL: "",
        COMMENTS_REGEN_MIN_NEW_COMMENTS: 100,
      },
      async () => {
        const first = await processCommentsSummary(services, story, thin, undefined, path, store);
        expect(first.status).toBe("applied");
        if (first.status !== "applied") {
          return;
        }
        expect(first.summary.degraded).toBe("too-few-comments");
        expect(first.summary.processedDescendants).toBe(5);
        expect(calls.length).toBe(0);

        const grown = { ...story, descendants: 90 }; // +85 ≤ 100
        await store.putJson(pathFor.rawComments(story.id), rich);
        // Count gate must not short-circuit degraded blobs.
        expect(await computeCommentsChanged(grown, first.summary, "ru", 0, Date.now(), store)).toBeTrue();

        const second = await processCommentsSummary(services, grown, rich, undefined, path, store);
        expect(second.status).toBe("applied");
        expect(calls.length).toBe(1);
        const persisted = await store.getJson<CommentsSummary>(path);
        expect(persisted?.degraded).toBeUndefined();
        expect(persisted?.structured).toEqual(VALID_INSIGHTS);
        expect(persisted?.processedDescendants).toBe(90);
      }
    );
  });

  test("gate-fire above threshold is still blocked by cooldown", async () => {
    const story = makeStory({ id: 59, title: "Cooldown wins", descendants: 300 });
    const store = new MemoryStore();
    await store.putJson(pathFor.rawComments(story.id), threeComments(story.id));

    const fresh: CommentsSummary = {
      id: story.id,
      lang: "ru",
      summary: "structured markdown",
      formatVersion: 2,
      structured: VALID_INSIGHTS,
      inputHash: "hash",
      createdISO: new Date().toISOString(),
      processedDescendants: 100,
      policyVersion: COMMENTS_POLICY_VERSION,
    };

    await withEnvPatch(
      { SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: "", COMMENTS_REGEN_MIN_NEW_COMMENTS: 100 },
      async () => {
        // +200 > 100 would fire the gate, but cooldown short-circuits first.
        expect(await computeCommentsChanged(story, fresh, "ru", 60_000, Date.now(), store)).toBeFalse();
        // Outside cooldown the same delta forces regen.
        expect(
          await computeCommentsChanged(story, fresh, "ru", 0, Date.now(), store)
        ).toBeTrue();
      }
    );
  });

  test("compress-retry still fires under the count gate inside cooldown", async () => {
    const story = makeStory({ id: 57, title: "Compress under gate", descendants: 90 });
    const store = new MemoryStore();
    await store.putJson(pathFor.rawComments(story.id), threeComments(story.id));

    const pending: CommentsSummary = {
      id: story.id,
      lang: "ru",
      summary: "structured markdown",
      formatVersion: 2,
      structured: VALID_INSIGHTS,
      inputHash: "hash",
      createdISO: new Date().toISOString(),
      processedDescendants: 90,
      policyVersion: COMMENTS_POLICY_VERSION,
      // compressed absent → retryable
    };

    await withEnvPatch(
      {
        SUMMARY_LANG: "ru",
        COMMENTS_COMPRESS_MODEL: "qwen/qwen3-next-80b-a3b-instruct",
        COMMENTS_REGEN_MIN_NEW_COMMENTS: 100,
      },
      async () => {
        expect(await computeCommentsChanged(story, pending, "ru", 60_000, Date.now(), store)).toBeTrue();
      }
    );
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

describe("comments-v2 Groq TPD breaker", () => {
  const FLAG_BASE = {
    SUMMARY_LANG: "ru" as const,
    COMMENTS_SUMMARY_MIN_CHARS: 200,
    COMMENTS_MAX_LLM_CALLS: 3,
    COMMENTS_COMPRESS_MODEL: "",
  };

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
        ...FLAG_BASE,
        COMMENTS_MODEL: collidingId,
        COMMENTS_FALLBACK_MODEL: "",
        COMMENTS_OPENROUTER_FALLBACK_MODEL: collidingId,
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
    a.commentsTpdExhaustedModels?.add(commentsTpdExhaustionKey("groq", "llama-3.1-8b-instant"));
    expect(b.commentsTpdExhaustedModels?.has(commentsTpdExhaustionKey("groq", "llama-3.1-8b-instant"))).toBe(true);
  });
});

describe("CommentsGenerationBudget.claimRequestTimeoutMs", () => {
  test("preferred per-step timeout overrides the base and still claims a call", () => {
    const budget = new CommentsGenerationBudget({ maxCalls: 2 });
    expect(budget.claimRequestTimeoutMs(env.COMMENTS_MINIMAX_REQUEST_TIMEOUT_MS)).toBe(
      env.COMMENTS_MINIMAX_REQUEST_TIMEOUT_MS
    );
    // Second claim without preference falls back to the shared base timeout.
    expect(budget.claimRequestTimeoutMs()).toBe(env.COMMENTS_LLM_REQUEST_TIMEOUT_MS);
    // Budget exhausted.
    expect(budget.claimRequestTimeoutMs(20_000)).toBeUndefined();
  });

  test("preferred timeout is capped by the remaining worker deadline", () => {
    const now = { current: 1_000_000 };
    const budget = new CommentsGenerationBudget({
      maxCalls: 3,
      deadlineAt: now.current + 8000, // only ~6 s remain after the buffer
      now: () => now.current,
    });
    const claimed = budget.claimRequestTimeoutMs(env.COMMENTS_MINIMAX_REQUEST_TIMEOUT_MS);
    expect(claimed).toBeLessThan(env.COMMENTS_MINIMAX_REQUEST_TIMEOUT_MS);
    expect(claimed).toBeGreaterThan(0);
  });
});
