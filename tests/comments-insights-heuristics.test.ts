import { describe, expect, test } from "bun:test";

import type { CommentsInsights } from "../config/schemas.ts";
import { checkCommentsInsightsHeuristics, cyrillicRatio } from "../utils/summary-heuristics.ts";

function insights(overrides: Partial<CommentsInsights> = {}): CommentsInsights {
  return {
    consensus: ["Участники согласны, что измерения нужно повторить на реальной нагрузке."],
    disputes: [],
    practical_advice: [],
    best_quote: null,
    ...overrides,
  };
}

describe("comments insight heuristics", () => {
  test("cyrillicRatio ignores inline and fenced code", () => {
    const text = "Русский текст `const englishName = value` и ещё слова.\n```ts\nreturn englishValue\n```";
    expect(cyrillicRatio(text)).toBe(1);
  });

  test("accepts Russian semantic fields with technical code spans", () => {
    const verdict = checkCommentsInsightsHeuristics(
      insights({
        practical_advice: ["Для проверки советуют выполнить `docker compose up` и сравнить результаты замеров."],
      }),
      { language: "ru", minCyrillicRatio: 0.65 }
    );
    expect(verdict.ok).toBeTrue();
    expect(verdict.triggers).toEqual([]);
  });

  test("rejects English generated prose for a Russian summary", () => {
    const verdict = checkCommentsInsightsHeuristics(
      insights({
        consensus: ["Participants agree that the benchmark must be repeated under realistic production load."],
      }),
      { language: "ru", minCyrillicRatio: 0.65 }
    );
    expect(verdict.ok).toBeFalse();
    expect(verdict.triggers.some((trigger) => trigger.reason === "low_cyrillic_ratio")).toBeTrue();
  });

  test("does not count a verbatim English source quote as generated language", () => {
    const verdict = checkCommentsInsightsHeuristics(
      insights({
        best_quote: {
          comment_id: 42,
          source_text: "This English source quote remains exact and must not affect the Russian language score.",
          translation: "Точный перевод цитаты подтверждает основной вывод участников обсуждения.",
        },
      }),
      { language: "ru", minCyrillicRatio: 0.65 }
    );
    expect(verdict.ok).toBeTrue();
  });

  test("checks the generated translation but not quote provenance", () => {
    const verdict = checkCommentsInsightsHeuristics(
      insights({
        best_quote: {
          comment_id: 42,
          source_text: "Точная исходная цитата на русском языке не должна маскировать плохой перевод.",
          translation: "The generated translation is English prose and must be included in the language score.",
        },
      }),
      { language: "ru", minCyrillicRatio: 0.65 }
    );
    expect(verdict.ok).toBeFalse();
    expect(verdict.triggers.some((trigger) => trigger.reason === "low_cyrillic_ratio")).toBeTrue();
  });

  test("reuses refusal, policy, and prompt-instruction checks", () => {
    const verdict = checkCommentsInsightsHeuristics(
      insights({
        consensus: ["As an AI, I cannot comply because the usage policy prohibits this request."],
        practical_advice: ["Your task is to summarize, and you must translate the response before returning it."],
      }),
      { language: "en" }
    );
    expect(verdict.ok).toBeFalse();
    expect(verdict.triggers.map((trigger) => trigger.reason)).toEqual([
      "refusal",
      "policy",
      "prompt_instructions",
    ]);
  });

  test("does not apply the Cyrillic gate to English output", () => {
    const verdict = checkCommentsInsightsHeuristics(
      insights({
        consensus: ["Participants agree that the benchmark should be repeated under production load."],
      }),
      { language: "en", minCyrillicRatio: 1 }
    );
    expect(verdict.ok).toBeTrue();
  });
});
