import { describe, expect, test } from "bun:test";

import {
  renderCommentsSummaryMarkdown,
  renderTooFewCommentsFallback,
  validateCommentsQuote,
} from "../utils/comments-render.ts";

import type { CommentsInsights, NormalizedComment } from "../config/schemas.ts";

const TEST_ISO = "2026-07-15T00:00:00.000Z";

function comment(overrides: Partial<NormalizedComment> = {}): NormalizedComment {
  return {
    id: 101,
    by: "alice",
    parent: 1,
    depth: 1,
    timeISO: TEST_ISO,
    textPlain: "The exact source quotation is preserved from this original Hacker News comment.",
    ...overrides,
  };
}

function insights(overrides: Partial<CommentsInsights> = {}): CommentsInsights {
  return {
    disputes: [],
    consensus: [],
    practical_advice: ["Проверяйте предложенный подход на небольшом воспроизводимом примере."],
    best_quote: null,
    ...overrides,
  };
}

describe("comments summary renderer", () => {
  test("renders localized RU sections in disputes, consensus, advice order with at most seven semantic bullets", () => {
    const repeated = [1, 2, 3].map((index) => `Достаточно подробный пункт номер ${index} для проверки ограничения списка.`);
    const value = insights({
      disputes: repeated.map((item, index) => ({
        topic: `Спорная тема ${index + 1}`,
        position_a: `${item} Первая позиция участников обсуждения.`,
        position_b: `${item} Альтернативная позиция участников обсуждения.`,
      })),
      consensus: repeated,
      practical_advice: repeated,
    });

    const markdown = renderCommentsSummaryMarkdown(value, { language: "ru", comments: [] });
    expect(markdown.indexOf("### О чём спорят")).toBeLessThan(markdown.indexOf("### Консенсус"));
    expect(markdown.indexOf("### Консенсус")).toBeLessThan(markdown.indexOf("### Советы из треда"));
    expect(markdown.split("\n").filter((line) => line.startsWith("- ")).length).toBe(7);
    expect(markdown).toContain("Достаточно подробный пункт номер 1");
    expect(markdown).not.toContain("Достаточно подробный пункт номер 2\n- Достаточно подробный пункт номер 3");
  });

  test("renders localized EN headings and accepts advice-only insights", () => {
    const markdown = renderCommentsSummaryMarkdown(
      insights({
        practical_advice: ["Test the migration on a disposable database copy before production rollout."],
      }),
      { language: "en", comments: [] }
    );

    expect(markdown).toBe(
      "### Advice from the thread\n\n- Test the migration on a disposable database copy before production rollout.\n"
    );
    expect(markdown).not.toContain("What people debate");
    expect(markdown).not.toContain("Consensus");
  });

  test("derives quote author by comment id and renders source and translation separately", () => {
    const comments = [comment({ by: "real_author" })];
    const value = insights({
      best_quote: {
        comment_id: 101,
        source_text: "exact source quotation is preserved",
        translation: "Точная исходная цитата сохранена отдельно от перевода.",
      },
    });

    const validated = validateCommentsQuote(value, comments);
    expect(validated).toEqual({
      commentId: 101,
      author: "real_author",
      sourceText: "exact source quotation is preserved",
      translation: "Точная исходная цитата сохранена отдельно от перевода.",
    });

    const markdown = renderCommentsSummaryMarkdown(value, { language: "ru", comments });
    expect(markdown).toContain("### Цитата из обсуждения");
    expect(markdown).toContain("> exact source quotation is preserved");
    expect(markdown).toContain(`> — @real${String.fromCodePoint(92)}_author`);
    expect(markdown).toContain("_Перевод:_ Точная исходная цитата сохранена отдельно от перевода.");
    expect(markdown).not.toContain("> Точная исходная цитата сохранена");
  });

  test("omits a quote with an unknown id or text absent from the original comment", () => {
    const comments = [comment()];
    const unknownId = insights({
      best_quote: {
        comment_id: 999,
        source_text: "exact source quotation is preserved",
        translation: null,
      },
    });
    const inventedText = insights({
      best_quote: {
        comment_id: 101,
        source_text: "This sentence was invented and never appeared in the source.",
        translation: null,
      },
    });

    expect(validateCommentsQuote(unknownId, comments)).toBeUndefined();
    expect(validateCommentsQuote(inventedText, comments)).toBeUndefined();
    expect(renderCommentsSummaryMarkdown(unknownId, { language: "en", comments })).not.toContain("Quote from");
    expect(renderCommentsSummaryMarkdown(inventedText, { language: "en", comments })).not.toContain("Quote from");
  });

  test("normalizes provenance whitespace and prevents quote Markdown from opening headings or fences", () => {
    const sourceText = "# heading\n```ts\nconst answer = 42\n```";
    const comments = [comment({ textPlain: `Prefix ${sourceText} suffix` })];
    const value = insights({
      best_quote: { comment_id: 101, source_text: sourceText, translation: null },
    });
    const markdown = renderCommentsSummaryMarkdown(value, { language: "en", comments });

    expect(validateCommentsQuote(value.best_quote, comments)?.author).toBe("alice");
    expect(markdown).toContain("> \\# heading");
    expect(markdown).toContain("> \\`\\`\\`ts");
    expect(markdown).not.toContain("\n# heading");
    expect(markdown).not.toContain("\n```ts");
  });

  test("degraded fallback returns empty for zero content comments and nonempty localized output for one or two", () => {
    const short = comment({ id: 1, textPlain: "too short" });
    const first = comment({ id: 2, by: "first", textPlain: "A".repeat(80) });
    const second = comment({ id: 3, by: "second", textPlain: "B".repeat(100) });
    const third = comment({ id: 4, by: "third", textPlain: "C".repeat(100) });

    expect(renderTooFewCommentsFallback([], "ru")).toBe("");
    expect(renderTooFewCommentsFallback([short], "en")).toBe("");

    const one = renderTooFewCommentsFallback([short, first], "ru");
    expect(one).toContain("### Из обсуждения");
    expect(one).toContain("**@first:**");
    expect(one.split("\n").filter((line) => line.startsWith("- ")).length).toBe(1);

    const two = renderTooFewCommentsFallback([first, second, third], "en");
    expect(two).toContain("### From the discussion");
    expect(two).toContain("**@first:**");
    expect(two).toContain("**@second:**");
    expect(two).not.toContain("@third");
    expect(two.split("\n").filter((line) => line.startsWith("- ")).length).toBe(2);
  });
});
