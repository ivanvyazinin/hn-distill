import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { env } from "../config/env.ts";
import type { Services } from "../scripts/summarize.mts";
import { generateValidatedCommentsSummary } from "../scripts/summarize.mts";

import type { ChatMessage } from "../utils/openrouter";

type ChatHandler = (req: { model: string; messages: ChatMessage[] }) => Promise<string>;
type CallRecord = { model: string };

const ESCALATION_MODEL = "escalation/bench-winner:free";
const PROMPT_TEXT = "Language: ru\n@user [d0] comment text";

const GOOD_RU_BULLETS = [
  "- Участники обсуждают производительность нового движка и делятся замерами на реальных данных из боевых кластеров",
  "- Часть пользователей сомневается в честности методики сравнения и просит раскрыть конфигурацию стендов",
  "- Автор отвечает на критику и обещает опубликовать полный набор бенчмарков вместе с исходным кодом",
].join("\n");

const BAD_RU_BULLETS = [
  "- Участники обсуждают закон и его последствия для приватности пользователей в разных странах мира",
  "- Несмотря на протесты абсолютного большинства для от rejection он прошёл без существенных поправок",
  "- Автор поста обещает следить за развитием событий и публиковать обновления по мере их поступления",
].join("\n");

const WORSE_ENGLISH_RETRY = [
  "- The participants discuss the law and its consequences for privacy in several countries around the world",
  "- Most commenters reject the decision and say that the process did not include meaningful public debate",
  "- The author promises to follow future developments and publish updates when more information becomes available",
].join("\n");

function makeServices(chatHandlers: ChatHandler[]) {
  let index = 0;
  const calls: CallRecord[] = [];

  const chat = async (messages: ChatMessage[], options?: { model?: string }): Promise<string> => {
    const handler = chatHandlers[index++];
    if (!handler) {
      throw new Error(`Unexpected chat invocation #${index}`);
    }
    const model = options?.model ?? env.OPENROUTER_MODEL;
    calls.push({ model });
    return await handler({ model, messages });
  };

  const orMock = {
    chat,
    chatStructured: async () => {
      throw new Error("not implemented");
    },
  } as unknown as Services["openrouter"];
  const services: Services = {
    http: {} as Services["http"],
    openrouter: orMock,
    guardTagsClient: orMock,
    fetchArticleMarkdown: async () => ({ md: "", sourceKind: "empty" as const }),
  };

  return { services, calls };
}

describe("generateValidatedCommentsSummary", () => {
  let savedRejectModel: string;
  let savedLang: typeof env.SUMMARY_LANG;

  beforeEach(() => {
    savedRejectModel = env.SUMMARY_CONTENT_REJECT_MODEL;
    savedLang = env.SUMMARY_LANG;
    env.SUMMARY_CONTENT_REJECT_MODEL = ESCALATION_MODEL;
    env.SUMMARY_LANG = "ru";
  });

  afterEach(() => {
    env.SUMMARY_CONTENT_REJECT_MODEL = savedRejectModel;
    env.SUMMARY_LANG = savedLang;
  });

  test("valid RU bullet list passes on the first call with the default chain", async () => {
    const { services, calls } = makeServices([async () => GOOD_RU_BULLETS]);

    const result = await generateValidatedCommentsSummary(services, 200, PROMPT_TEXT, [1, 2]);

    expect(result.summary).toBe(GOOD_RU_BULLETS);
    expect(result.sampleComments).toEqual([1, 2]);
    expect(calls.length).toBe(1);
    expect(calls[0]?.model).toBe(env.OPENROUTER_MODEL);
  });

  test("latin_prose in bullets triggers one retry on the escalation model", async () => {
    const { services, calls } = makeServices([
      async () => BAD_RU_BULLETS,
      async () => GOOD_RU_BULLETS,
    ]);

    const result = await generateValidatedCommentsSummary(services, 201, PROMPT_TEXT);

    expect(result.summary).toBe(GOOD_RU_BULLETS);
    expect(result.model).toBe(ESCALATION_MODEL);
    expect(calls.length).toBe(2);
    expect(calls[0]?.model).toBe(env.OPENROUTER_MODEL);
    expect(calls[1]?.model).toBe(ESCALATION_MODEL);
  });

  test("equally flagged retry keeps the first result", async () => {
    const { services, calls } = makeServices([
      async () => BAD_RU_BULLETS,
      async () => BAD_RU_BULLETS,
    ]);

    const result = await generateValidatedCommentsSummary(services, 202, PROMPT_TEXT);

    expect(result.summary).toBe(BAD_RU_BULLETS);
    expect(result.model).toBe(env.OPENROUTER_MODEL);
    expect(calls.length).toBe(2);
  });

  test("worse retry does not replace a less severe first result", async () => {
    const { services, calls } = makeServices([
      async () => BAD_RU_BULLETS,
      async () => WORSE_ENGLISH_RETRY,
    ]);

    const result = await generateValidatedCommentsSummary(services, 205, PROMPT_TEXT);

    expect(result.summary).toBe(BAD_RU_BULLETS);
    expect(result.model).toBe(env.OPENROUTER_MODEL);
    expect(calls.length).toBe(2);
    expect(calls[1]?.model).toBe(ESCALATION_MODEL);
  });

  test("retry error: first summary is kept", async () => {
    const { services, calls } = makeServices([
      async () => BAD_RU_BULLETS,
      async () => {
        throw new Error("escalation down");
      },
      async () => {
        throw new Error("fallback down");
      },
    ]);

    const result = await generateValidatedCommentsSummary(services, 203, PROMPT_TEXT);

    expect(result.summary).toBe(BAD_RU_BULLETS);
    expect(calls[1]?.model).toBe(ESCALATION_MODEL);
    expect(calls[2]?.model).toBe(env.OPENROUTER_FALLBACK_MODEL);
  });

  test("without escalation model the retry uses the default chain", async () => {
    env.SUMMARY_CONTENT_REJECT_MODEL = "";
    const { services, calls } = makeServices([
      async () => BAD_RU_BULLETS,
      async () => GOOD_RU_BULLETS,
    ]);

    const result = await generateValidatedCommentsSummary(services, 204, PROMPT_TEXT);

    expect(result.summary).toBe(GOOD_RU_BULLETS);
    expect(calls[1]?.model).toBe(env.OPENROUTER_MODEL);
  });
});
