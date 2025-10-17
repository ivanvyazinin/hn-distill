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
});
