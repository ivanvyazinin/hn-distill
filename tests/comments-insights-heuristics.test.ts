import { describe, expect, test } from "bun:test";

import { checkCommentsInsightsHeuristics, cyrillicRatio } from "../utils/summary-heuristics.ts";
import { makeEnCommentsInsights, makeRuCommentsInsights } from "./helpers/comments-insights.ts";

describe("comments insight heuristics", () => {
  test("cyrillicRatio ignores inline and fenced code", () => {
    const text = "Русский текст `const englishName = value` и ещё слова.\n```ts\nreturn englishValue\n```";
    expect(cyrillicRatio(text)).toBe(1);
  });

  test("accepts Russian semantic fields with technical code spans", () => {
    const verdict = checkCommentsInsightsHeuristics(
      makeRuCommentsInsights({
        insights: [
          {
            kind: "advice",
            text: "Для проверки советуют выполнить `docker compose up` и сравнить результаты замеров.",
          },
        ],
      }),
      { language: "ru", minCyrillicRatio: 0.65 }
    );
    expect(verdict.ok).toBeTrue();
    expect(verdict.triggers).toEqual([]);
  });

  test("rejects English generated prose for a Russian summary", () => {
    const verdict = checkCommentsInsightsHeuristics(
      makeRuCommentsInsights({
        bottom_line: "Participants agree that the benchmark must be repeated under realistic production load.",
        insights: [
          {
            kind: "consensus",
            text: "Participants agree that the benchmark must be repeated under realistic production load.",
          },
        ],
      }),
      { language: "ru", minCyrillicRatio: 0.65 }
    );
    expect(verdict.ok).toBeFalse();
    expect(verdict.triggers.some((trigger) => trigger.reason === "low_cyrillic_ratio")).toBeTrue();
  });

  test("EN bottom_line with RU insights still trips low_cyrillic_ratio (proves bottom_line is gated)", () => {
    const verdict = checkCommentsInsightsHeuristics(
      makeRuCommentsInsights({
        // Long English lead so the combined cyrillic ratio falls under 0.65 even with RU insights.
        bottom_line:
          "The thread merely restates the article in fluent English without adding operational experience, production numbers, failure modes, or any concrete mechanism that practitioners could reuse in their own systems under realistic load.",
        insights: [
          {
            kind: "advice",
            text: "Проверьте подход на стенде.",
          },
        ],
      }),
      { language: "ru", minCyrillicRatio: 0.65 }
    );
    expect(verdict.ok).toBeFalse();
    expect(verdict.triggers.some((trigger) => trigger.reason === "low_cyrillic_ratio")).toBeTrue();
  });

  test("does not count a verbatim English source quote as generated language", () => {
    const verdict = checkCommentsInsightsHeuristics(
      makeRuCommentsInsights({
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
      makeRuCommentsInsights({
        // Keep RU fields short so a long English translation dominates the cyrillic ratio.
        bottom_line: "Тред добавляет опыт эксплуатации.",
        insights: [{ kind: "advice", text: "Проверьте на стенде перед продом." }],
        best_quote: {
          comment_id: 42,
          source_text: "Точная исходная цитата на русском языке не должна маскировать плохой перевод.",
          translation:
            "The generated translation is long English prose that must be included in the language score and pull the ratio below the Russian gate for this fixture.",
        },
      }),
      { language: "ru", minCyrillicRatio: 0.65 }
    );
    expect(verdict.ok).toBeFalse();
    expect(verdict.triggers.some((trigger) => trigger.reason === "low_cyrillic_ratio")).toBeTrue();
  });

  test("reuses refusal, policy, and prompt-instruction checks", () => {
    const verdict = checkCommentsInsightsHeuristics(
      makeEnCommentsInsights({
        bottom_line: "As an AI, I cannot comply because the usage policy prohibits this request for the user.",
        insights: [
          {
            kind: "advice",
            text: "Your task is to summarize, and you must translate the response before returning it fully.",
          },
        ],
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
    const verdict = checkCommentsInsightsHeuristics(makeEnCommentsInsights(), {
      language: "en",
      minCyrillicRatio: 1,
    });
    expect(verdict.ok).toBeTrue();
  });
});
