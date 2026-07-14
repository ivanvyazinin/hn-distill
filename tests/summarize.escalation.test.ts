import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { env, parseEnv } from "../config/env.ts";
import type { Services } from "../scripts/summarize.mts";
import { generateValidatedPostSummary } from "../scripts/summarize.mts";

import type { NormalizedStory } from "@config/schemas";
import type { ChatMessage } from "../utils/openrouter";

type ChatHandler = (req: { model: string; messages: ChatMessage[] }) => Promise<string>;
type GuardPayload = {
  ok: boolean;
  is_article: boolean;
  refusal: boolean;
  verdict: string;
  reasons: string[];
  confidence: number;
};

type CallRecord = { model: string };

const ESCALATION_MODEL = "escalation/bench-winner:free";

const GOOD_RU_SUMMARY =
  "Автор подробно разбирает архитектуру новой системы хранения, объясняет, как шардирование распределяет петабайты логов между регионами, приводит цифры из нагрузочных тестов, описывает модель восстановления после сбоев и делится практическими уроками, полученными командой при миграции боевого кластера на новую платформу без простоя.";

const GOOD_RU_SUMMARY_2 =
  "Статья описывает переход крупного сервиса на событийную архитектуру: команда выделила критичные потоки данных, построила конвейер обработки с гарантией доставки, сократила задержки на порядок и подробно объясняет, какие ошибки проектирования пришлось исправлять уже после запуска, чтобы система выдержала пиковые нагрузки праздничного сезона.";

const STORY: NormalizedStory = {
  id: 4242,
  title: "Test story",
  url: "https://example.com/post",
  by: "tester",
  timeISO: new Date("2026-07-01T00:00:00Z").toISOString(),
  commentIds: [],
} as unknown as NormalizedStory;

function makeServices(chatHandlers: ChatHandler[], guardPayloads: GuardPayload[] = []) {
  let chatIndex = 0;
  let guardIndex = 0;
  const calls: CallRecord[] = [];
  const guardCalls: number[] = [];

  const chat = async (messages: ChatMessage[], options?: { model?: string }): Promise<string> => {
    const handler = chatHandlers[chatIndex++];
    if (!handler) {
      throw new Error(`Unexpected chat invocation #${chatIndex}`);
    }
    const model = options?.model ?? env.OPENROUTER_MODEL;
    calls.push({ model });
    return await handler({ model, messages });
  };

  const chatStructured = async (): Promise<GuardPayload> => {
    const payload = guardPayloads[guardIndex++];
    if (!payload) {
      throw new Error(`Unexpected guard invocation #${guardIndex}`);
    }
    guardCalls.push(guardIndex);
    return payload;
  };

  const orMock = { chat, chatStructured } as unknown as Services["openrouter"];
  const services: Services = {
    http: {} as Services["http"],
    openrouter: orMock,
    guardTagsClient: orMock,
    fetchArticleMarkdown: async () => ({ md: "", sourceKind: "empty" as const }),
  };

  return { services, calls, guardCalls };
}

const GUARD_OK: GuardPayload = {
  ok: true,
  is_article: true,
  refusal: false,
  verdict: "ok",
  reasons: [],
  confidence: 0.95,
};

const GUARD_REJECT: GuardPayload = {
  ok: false,
  is_article: true,
  refusal: true,
  verdict: "refusal",
  reasons: ["refusal"],
  confidence: 0.95,
};

describe("generateValidatedPostSummary escalation", () => {
  let savedRejectModel: string;
  let savedGuardEnable: boolean;
  let savedLang: typeof env.SUMMARY_LANG;

  test("defaults content-reject escalation to the validated paid Qwen route", () => {
    expect(parseEnv({}).SUMMARY_CONTENT_REJECT_MODEL).toBe("qwen/qwen3-next-80b-a3b-instruct");
  });

  beforeEach(() => {
    savedRejectModel = env.SUMMARY_CONTENT_REJECT_MODEL;
    savedGuardEnable = env.POST_GUARD_ENABLE;
    savedLang = env.SUMMARY_LANG;
    env.SUMMARY_CONTENT_REJECT_MODEL = ESCALATION_MODEL;
    env.POST_GUARD_ENABLE = false;
    env.SUMMARY_LANG = "ru";
  });

  afterEach(() => {
    env.SUMMARY_CONTENT_REJECT_MODEL = savedRejectModel;
    env.POST_GUARD_ENABLE = savedGuardEnable;
    env.SUMMARY_LANG = savedLang;
  });

  test("heuristic reject on initial escalates strict-1 to the escalation model", async () => {
    const { services, calls } = makeServices([
      async () => "Слишком коротко.",
      async () => GOOD_RU_SUMMARY,
    ]);

    const result = await generateValidatedPostSummary(services, STORY, "article text");

    expect(result?.summary).toBe(GOOD_RU_SUMMARY);
    expect(result?.modelUsed).toBe(ESCALATION_MODEL);
    expect(calls[0]?.model).toBe(env.OPENROUTER_MODEL);
    expect(calls[1]?.model).toBe(ESCALATION_MODEL);
  });

  test("language-gate reject on initial escalates strict-1 to the escalation model", async () => {
    const { services, calls } = makeServices([
      async () =>
        `${GOOD_RU_SUMMARY} Эксперты считают, что такие меры создают precedents, позволяющие государствам шпионить за пользователями.`,
      async () => GOOD_RU_SUMMARY,
    ]);

    const result = await generateValidatedPostSummary(services, STORY, "article text");

    expect(result?.summary).toBe(GOOD_RU_SUMMARY);
    expect(calls[0]?.model).toBe(env.OPENROUTER_MODEL);
    expect(calls[1]?.model).toBe(ESCALATION_MODEL);
  });

  test("HTTP error of the escalation model falls back to the configured fallback", async () => {
    const { services, calls } = makeServices([
      async () => "Слишком коротко.",
      async () => {
        throw new Error("escalation model down");
      },
      async () => GOOD_RU_SUMMARY,
    ]);

    const result = await generateValidatedPostSummary(services, STORY, "article text");

    expect(result?.summary).toBe(GOOD_RU_SUMMARY);
    expect(result?.modelUsed).toBe(env.OPENROUTER_FALLBACK_MODEL);
    expect(calls[1]?.model).toBe(ESCALATION_MODEL);
    expect(calls[2]?.model).toBe(env.OPENROUTER_FALLBACK_MODEL);
  });

  test("guard reject also escalates to the escalation model", async () => {
    env.POST_GUARD_ENABLE = true;
    const { services, calls, guardCalls } = makeServices(
      [async () => GOOD_RU_SUMMARY, async () => GOOD_RU_SUMMARY_2],
      [GUARD_REJECT, GUARD_OK]
    );

    const result = await generateValidatedPostSummary(services, STORY, "article text");

    expect(result?.summary).toBe(GOOD_RU_SUMMARY_2);
    expect(calls[0]?.model).toBe(env.OPENROUTER_MODEL);
    expect(calls[1]?.model).toBe(ESCALATION_MODEL);
    expect(guardCalls.length).toBe(2);
  });

  test("without SUMMARY_CONTENT_REJECT_MODEL strict retries use the default chain", async () => {
    env.SUMMARY_CONTENT_REJECT_MODEL = "";
    const { services, calls } = makeServices([
      async () => "Слишком коротко.",
      async () => GOOD_RU_SUMMARY,
    ]);

    const result = await generateValidatedPostSummary(services, STORY, "article text");

    expect(result?.summary).toBe(GOOD_RU_SUMMARY);
    expect(calls[0]?.model).toBe(env.OPENROUTER_MODEL);
    expect(calls[1]?.model).toBe(env.OPENROUTER_MODEL);
  });
});
