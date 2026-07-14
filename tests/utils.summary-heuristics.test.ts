import { describe, expect, test } from "bun:test";

import { checkSummaryHeuristics } from "../utils/summary-heuristics.ts";

describe("utils/summary-heuristics", () => {
  test("flags refusal patterns", () => {
    const verdict = checkSummaryHeuristics("As an AI, I cannot comply with that request.", {
      minChars: 20,
      language: "en",
    });
    expect(verdict.ok).toBeFalse();
    expect(verdict.triggers.some((t) => t.reason === "refusal")).toBeTrue();
  });

  test("passes detailed summaries", () => {
    const verdict = checkSummaryHeuristics(
      "The article explains how a new distributed storage engine shards petabytes of logs across regions, " +
        "describes the recovery model in detail, and highlights the operational lessons learned during migration.",
      {
        minChars: 60,
        language: "en",
      }
    );
    expect(verdict.ok).toBeTrue();
    expect(verdict.triggers).toEqual([]);
  });

  test("flags extreme repetition", () => {
    const summary = Array.from({ length: 120 }, () => "Test").join(" ");
    const verdict = checkSummaryHeuristics(summary, {
      minChars: 10,
      language: "en",
    });
    expect(verdict.ok).toBeFalse();
    expect(verdict.triggers.some((trigger) => trigger.reason === "repetition_run")).toBeTrue();
    expect(verdict.triggers.some((trigger) => trigger.reason === "low_unique_ratio")).toBeTrue();
  });

  test("flags url-encoded gibberish", () => {
    const summary = `Intro ${"%20data".repeat(60)}`;
    const verdict = checkSummaryHeuristics(summary, {
      minChars: 10,
      language: "en",
    });
    expect(verdict.ok).toBeFalse();
    expect(verdict.triggers.some((trigger) => trigger.reason === "url_encoded_noise")).toBeTrue();
  });

  test("allows benign apologies without refusals", () => {
    const summary =
      "Автор пишет: «Извините за задержку публикации», после чего подробно объясняет причины, приводит новые данные, " +
      "сравнивает подходы конкурентов и завершает конкретными рекомендациями по внедрению изменений в проект.";
    const verdict = checkSummaryHeuristics(summary, {
      minChars: 60,
      language: "ru",
    });
    expect(verdict.triggers.some((trigger) => trigger.reason === "refusal")).toBeFalse();
  });

  test("flags bare bullet markers without content", () => {
    const summary = Array.from({ length: 25 }, () => "-").join("\n");
    const verdict = checkSummaryHeuristics(summary, {
      minChars: 10,
      language: "ru",
    });
    expect(verdict.ok).toBeFalse();
    expect(verdict.triggers.some((trigger) => trigger.reason === "bare_bullets")).toBeTrue();
  });

  test("flags prompt-style instructions", () => {
    const summary =
      "# Ты пишешь подробные пересказы.\n" +
      "Твоя задача — пересказать статью на русском языке.\n" +
      "Я буду твоим переводчиком и помогу тебе перевести текст.";
    const verdict = checkSummaryHeuristics(summary, {
      minChars: 10,
      language: "ru",
    });
    expect(verdict.ok).toBeFalse();
    expect(verdict.triggers.some((trigger) => trigger.reason === "prompt_instructions")).toBeTrue();
  });

  test("flags numeric headings only output", () => {
    const summary = ["#3.1", "#1.1", "#2.4", "#4.0"].join("\n");
    const verdict = checkSummaryHeuristics(summary, {
      minChars: 10,
      language: "ru",
    });
    expect(verdict.ok).toBeFalse();
    expect(verdict.triggers.some((trigger) => trigger.reason === "numeric_headings")).toBeTrue();
  });

  test("allows headings with descriptive text", () => {
    const summary =
      "# Release notes\n" +
      "Новая версия улучшает производительность, исправляет критичные ошибки, перечисляет новые сценарии внедрения, уточняет график релизов и объясняет, как команда планирует сопровождать обновление после выката.";
    const verdict = checkSummaryHeuristics(summary, {
      minChars: 10,
      language: "ru",
    });
    expect(verdict.ok).toBeTrue();
    expect(verdict.triggers.some((trigger) => trigger.reason === "numeric_headings")).toBeFalse();
  });

  test("allows instructional phrases in legitimate prose", () => {
    const summary =
      "Автор делится опытом по подготовке охот, объясняет, почему ваша задача как организатора — создавать решаемые, но честные головоломки, перечисляет типичные ошибки команд и завершает примером удачного события.";
    const verdict = checkSummaryHeuristics(summary, {
      minChars: 60,
      language: "ru",
    });
    expect(verdict.ok).toBeTrue();
    expect(verdict.triggers.some((trigger) => trigger.reason === "prompt_instructions")).toBeFalse();
  });

  describe("RU language gate", () => {
    const RU_FILLER =
      "Автор подробно разбирает архитектуру системы, приводит цифры из тестов, объясняет причины решений и сравнивает подход с альтернативами, чтобы читатель мог оценить применимость на практике.";

    test("flags single English word in Russian grammar (precedents)", () => {
      const verdict = checkSummaryHeuristics(`${RU_FILLER} Эксперты считают, что такие меры создают precedents, позволяющие государствам шпионить за пользователями.`, {
        minChars: 60,
        language: "ru",
      });
      expect(verdict.ok).toBeFalse();
      expect(verdict.triggers.some((t) => t.reason === "latin_prose")).toBeTrue();
    });

    test("flags English clause inside Russian prose", () => {
      const verdict = checkSummaryHeuristics(`${RU_FILLER} Вы выбираете стратегию, а система очков lets you compare results globally.`, {
        minChars: 60,
        language: "ru",
      });
      expect(verdict.ok).toBeFalse();
      expect(verdict.triggers.some((t) => t.reason === "latin_prose")).toBeTrue();
    });

    test("flags broken grammar with function word (для от rejection)", () => {
      const verdict = checkSummaryHeuristics(`${RU_FILLER} Несмотря на протесты абсолютного большинства для от rejection он прошёл без поправок.`, {
        minChars: 60,
        language: "ru",
      });
      expect(verdict.ok).toBeFalse();
      expect(verdict.triggers.some((t) => t.reason === "latin_prose")).toBeTrue();
    });

    test("flags fully English summary via low_cyrillic_ratio", () => {
      const verdict = checkSummaryHeuristics(
        "The article explains how a new distributed storage engine shards petabytes of logs across regions and highlights the operational lessons learned during the migration to the new architecture of the platform.",
        { minChars: 60, language: "ru" }
      );
      expect(verdict.ok).toBeFalse();
      expect(verdict.triggers.some((t) => t.reason === "low_cyrillic_ratio")).toBeTrue();
    });

    test("does not flag proper nouns, acronyms and lowercase tools", () => {
      const verdict = checkSummaryHeuristics(
        `Проект OpenWrt публикует релиз на GitHub: обновлены systemd, npm, curl и nginx, добавлена поддержка API и HTTP, а команда brew bundle получила параллельную установку. ${RU_FILLER}`,
        { minChars: 60, language: "ru" }
      );
      expect(verdict.ok).toBeTrue();
      expect(verdict.triggers).toEqual([]);
    });

    test("does not flag quoted English strings and glosses", () => {
      const verdict = checkSummaryHeuristics(
        `При ошибке появляется сообщение «Something went wrong», а производитель осевого (axial flux) двигателя цитирует твит «Duplication is far cheaper than the wrong abstraction». ${RU_FILLER}`,
        { minChars: 60, language: "ru" }
      );
      expect(verdict.ok).toBeTrue();
      expect(verdict.triggers).toEqual([]);
    });

    test("gate can be disabled via languageGate.enable", () => {
      const verdict = checkSummaryHeuristics(`${RU_FILLER} Такие меры создают precedents, позволяющие обходить закон.`, {
        minChars: 60,
        language: "ru",
        languageGate: { enable: false },
      });
      expect(verdict.triggers.some((t) => t.reason === "latin_prose")).toBeFalse();
    });

    test("gate is inactive for English summaries", () => {
      const verdict = checkSummaryHeuristics(
        "The article explains how a new distributed storage engine shards petabytes of logs across regions, describes the recovery model in detail, and highlights the operational lessons learned during migration.",
        { minChars: 60, language: "en" }
      );
      expect(verdict.ok).toBeTrue();
    });

    test("soft noun-phrase runs flag only when enabled", () => {
      const text = `${RU_FILLER} Надёжнее использовать resident set size вместо виртуальной памяти при мониторинге процессов.`;
      const defaultVerdict = checkSummaryHeuristics(text, { minChars: 60, language: "ru" });
      expect(defaultVerdict.triggers.some((t) => t.reason === "latin_prose")).toBeFalse();
      const softVerdict = checkSummaryHeuristics(text, {
        minChars: 60,
        language: "ru",
        languageGate: { flagSoftRuns: true },
      });
      expect(softVerdict.triggers.some((t) => t.reason === "latin_prose")).toBeTrue();
    });
  });

  describe("comments profile", () => {
    test("does not flag a valid RU bullet list as bullets_only", () => {
      const summary = [
        "- Участники обсуждают производительность нового движка и делятся замерами на реальных данных",
        "- Часть пользователей сомневается в честности методики сравнения и просит раскрыть конфигурацию",
        "- Автор отвечает на критику и обещает опубликовать полный набор бенчмарков вместе с кодом",
      ].join("\n");
      const verdict = checkSummaryHeuristics(summary, { minChars: 60, language: "ru", kind: "comments" });
      expect(verdict.ok).toBeTrue();
      expect(verdict.triggers).toEqual([]);
    });

    test("post profile still flags bullets_only", () => {
      const summary = [
        "- Участники обсуждают производительность нового движка и делятся замерами на реальных данных",
        "- Часть пользователей сомневается в честности методики сравнения и просит раскрыть конфигурацию",
        "- Автор отвечает на критику и обещает опубликовать полный набор бенчмарков вместе с кодом",
      ].join("\n");
      const verdict = checkSummaryHeuristics(summary, { minChars: 60, language: "ru", kind: "post" });
      expect(verdict.triggers.some((t) => t.reason === "bullets_only")).toBeTrue();
    });

    test("language gate still applies to comment bullet lists", () => {
      const summary = [
        "- Участники обсуждают закон и его последствия для приватности пользователей в разных странах",
        "- Несмотря на протесты абсолютного большинства для от rejection он прошёл без поправок",
        "- Автор поста обещает следить за развитием событий и публиковать обновления по мере поступления",
      ].join("\n");
      const verdict = checkSummaryHeuristics(summary, { minChars: 60, language: "ru", kind: "comments" });
      expect(verdict.ok).toBeFalse();
      expect(verdict.triggers.some((t) => t.reason === "latin_prose")).toBeTrue();
    });
  });
});
