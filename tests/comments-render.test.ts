import { describe, expect, test } from "bun:test";

import {
  clampToClause,
  commentsFoldLabel,
  renderCommentsLead,
  renderCommentsSummaryMarkdown,
  renderCommentsSummaryParts,
  renderTooFewCommentsFallback,
  validateCommentsQuote,
} from "../utils/comments-render.ts";
import {
  COMMENTS_INSIGHTS_FIXTURE_TEXT,
  makeEnCommentsInsights,
  makeRuCommentsInsights,
  makeRuDisputeInsight,
} from "./helpers/comments-insights.ts";

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

function longInsight(kind: CommentsInsights["insights"][number]["kind"], index: number): CommentsInsights["insights"][number] {
  // Distinct content per index so containment dedup does not collapse fold-boundary fixtures.
  const topics = [
    "измерение задержек очереди при пиковой нагрузке на прод",
    "канареечный rollout feature flags перед cutover",
    "стоимость self-hosted Wireguard против managed VPN",
    "корреляция сна и здоровья без доказанной причинности",
    "откат миграции базы через dual-write и сравнение ответов",
  ] as const;
  const topic = topics[index - 1] ?? `уникальная тема номер ${index}`;
  return {
    kind,
    text: `Достаточно подробный тезис номер ${index}: ${topic}.`,
  };
}

describe("comments summary renderer", () => {
  test("lead is plain bottom_line without a heading", () => {
    const value = makeRuCommentsInsights();
    const parts = renderCommentsSummaryParts(value, { language: "ru", comments: [] });
    expect(parts.lead).toBe(`${COMMENTS_INSIGHTS_FIXTURE_TEXT.ru.bottom}\n`);
    expect(parts.lead).not.toContain("###");
    expect(renderCommentsLead(value.bottom_line)).toBe(parts.lead);
  });

  test("labels dispute/advice and leaves consensus unlabeled (RU and EN)", () => {
    const ru = makeRuCommentsInsights({
      insights: [
        makeRuDisputeInsight(),
        { kind: "consensus", text: COMMENTS_INSIGHTS_FIXTURE_TEXT.ru.consensus },
        { kind: "advice", text: COMMENTS_INSIGHTS_FIXTURE_TEXT.ru.advice },
      ],
    });
    const ruMd = renderCommentsSummaryMarkdown(ru, { language: "ru", comments: [] });
    expect(ruMd).toContain("**Спор:**");
    expect(ruMd).toContain("**Совет:**");
    expect(ruMd).toContain(`- ${COMMENTS_INSIGHTS_FIXTURE_TEXT.ru.consensus}`);
    expect(ruMd).not.toContain("###");

    const en = makeEnCommentsInsights({
      insights: [
        { kind: "dispute", text: COMMENTS_INSIGHTS_FIXTURE_TEXT.en.dispute },
        { kind: "consensus", text: COMMENTS_INSIGHTS_FIXTURE_TEXT.en.consensus },
        { kind: "advice", text: COMMENTS_INSIGHTS_FIXTURE_TEXT.en.advice },
      ],
    });
    const enMd = renderCommentsSummaryMarkdown(en, { language: "en", comments: [] });
    expect(enMd).toContain("**Debate:**");
    expect(enMd).toContain("**Advice:**");
    expect(enMd).toContain(`- ${COMMENTS_INSIGHTS_FIXTURE_TEXT.en.consensus}`);
  });

  test("fold boundary: 1 and 3 insights stay visible; 4–5 go to folded", () => {
    const one = makeRuCommentsInsights({ insights: [longInsight("advice", 1)] });
    const oneParts = renderCommentsSummaryParts(one, { language: "ru", comments: [] });
    expect(oneParts.visible).toContain("тезис номер 1");
    expect(oneParts.folded).toBe("");
    expect(oneParts.foldedInsightsCount).toBe(0);

    const three = makeRuCommentsInsights({
      insights: [longInsight("advice", 1), longInsight("consensus", 2), longInsight("dispute", 3)],
    });
    const threeParts = renderCommentsSummaryParts(three, { language: "ru", comments: [] });
    expect(threeParts.visible.split("\n").filter((line) => line.startsWith("- ")).length).toBe(3);
    expect(threeParts.folded).toBe("");
    expect(threeParts.foldedInsightsCount).toBe(0);

    const five = makeRuCommentsInsights({
      insights: [
        longInsight("advice", 1),
        longInsight("consensus", 2),
        longInsight("dispute", 3),
        longInsight("advice", 4),
        longInsight("consensus", 5),
      ],
    });
    const fiveParts = renderCommentsSummaryParts(five, { language: "ru", comments: [] });
    expect(fiveParts.visible).toContain("тезис номер 3");
    expect(fiveParts.visible).not.toContain("тезис номер 4");
    expect(fiveParts.folded).toContain("тезис номер 4");
    expect(fiveParts.folded).toContain("тезис номер 5");
    expect(fiveParts.foldedInsightsCount).toBe(2);
    expect(fiveParts.foldedHasQuote).toBeFalse();
  });

  test("quote is always folded and has no heading", () => {
    const comments = [comment({ by: "real_author" })];
    const value = makeRuCommentsInsights({
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

    const parts = renderCommentsSummaryParts(value, { language: "ru", comments });
    expect(parts.folded).toContain("> exact source quotation is preserved");
    expect(parts.folded).toContain(`> — @real${String.fromCodePoint(92)}_author`);
    expect(parts.folded).toContain("_Перевод:_ Точная исходная цитата сохранена отдельно от перевода.");
    expect(parts.folded).not.toContain("###");
    expect(parts.visible).not.toContain("exact source quotation");
    expect(parts.foldedHasQuote).toBeTrue();
  });

  test("a verbatim quote longer than the display cap is trimmed with an ellipsis", () => {
    const longSource = "Длинная дословная цитата из комментария, которую нужно обрезать при показе. ".repeat(6).trim();
    expect(longSource.length).toBeGreaterThan(300);
    const comments = [comment({ by: "quoter", textPlain: longSource })];
    const value = makeRuCommentsInsights({
      best_quote: { comment_id: 101, source_text: longSource, translation: null },
    });

    const parts = renderCommentsSummaryParts(value, { language: "ru", comments });
    const quoteLine = parts.folded.split("\n").find((line) => line.startsWith("> Длинная"));
    expect(quoteLine).toBeDefined();
    expect(quoteLine?.endsWith("…")).toBeTrue();
    // "> " prefix + <=300 chars + ellipsis, far shorter than the ~450-char source.
    expect((quoteLine?.length ?? 0)).toBeLessThan(longSource.length);
    expect(parts.foldedHasQuote).toBeTrue();
  });

  test("quote-only fold when all insights fit in visible", () => {
    const comments = [comment()];
    const value = makeRuCommentsInsights({
      insights: [longInsight("advice", 1)],
      best_quote: {
        comment_id: 101,
        source_text: "exact source quotation is preserved",
        translation: null,
      },
    });
    const parts = renderCommentsSummaryParts(value, { language: "ru", comments });
    expect(parts.foldedInsightsCount).toBe(0);
    expect(parts.folded).toContain("> exact source quotation is preserved");
    expect(parts.folded).not.toContain("тезис номер");
    expect(parts.foldedHasQuote).toBeTrue();
    expect(commentsFoldLabel(parts, "ru")).toBe("цитата из треда");
    expect(commentsFoldLabel(parts, "en")).toBe("quote from the thread");
  });

  test("escaped comparison operators in folded bullets do not fake a quote label", () => {
    // Regression: sniffing folded.includes("> ") matched escaped `\>` from text like `p99 > p95`.
    const value = makeRuCommentsInsights({
      insights: [
        longInsight("advice", 1),
        longInsight("consensus", 2),
        longInsight("dispute", 3),
        {
          kind: "advice",
          text: "Смотрите latency p99 > p95 перед cutover, иначе редирект /api -> /v2 спрячет регрессию.",
        },
      ],
      best_quote: null,
    });
    const parts = renderCommentsSummaryParts(value, { language: "ru", comments: [] });
    expect(parts.foldedInsightsCount).toBe(1);
    expect(parts.foldedHasQuote).toBeFalse();
    // Escaped greater-than still appears in folded markdown body…
    expect(parts.folded.includes("> ") || parts.folded.includes("\\>")).toBeTrue();
    // …but the fold label must not claim a quote.
    expect(commentsFoldLabel(parts, "ru")).toBe("ещё 1 тезис");
    expect(commentsFoldLabel(parts, "en")).toBe("1 more takeaways");
  });

  test("fold labels use (+ цитата) without the awkward '+ и'", () => {
    const comments = [comment()];
    const value = makeRuCommentsInsights({
      insights: [
        longInsight("advice", 1),
        longInsight("consensus", 2),
        longInsight("dispute", 3),
        longInsight("advice", 4),
      ],
      best_quote: {
        comment_id: 101,
        source_text: "exact source quotation is preserved",
        translation: null,
      },
    });
    const parts = renderCommentsSummaryParts(value, { language: "ru", comments });
    expect(parts.foldedHasQuote).toBeTrue();
    expect(parts.foldedInsightsCount).toBe(1);
    expect(commentsFoldLabel(parts, "ru")).toBe("ещё 1 тезис (+ цитата)");
    expect(commentsFoldLabel(parts, "en")).toBe("1 more takeaways (+ quote)");
  });

  test("markdown equals concatenation of non-empty parts", () => {
    const comments = [comment()];
    const value = makeRuCommentsInsights({
      insights: [
        longInsight("advice", 1),
        longInsight("consensus", 2),
        longInsight("dispute", 3),
        longInsight("advice", 4),
      ],
      best_quote: {
        comment_id: 101,
        source_text: "exact source quotation is preserved",
        translation: null,
      },
    });
    const parts = renderCommentsSummaryParts(value, { language: "ru", comments });
    const markdown = renderCommentsSummaryMarkdown(value, { language: "ru", comments });
    const concat = [parts.lead.trimEnd(), parts.visible.trimEnd(), parts.folded.trimEnd()]
      .filter((chunk) => chunk.length > 0)
      .join("\n\n");
    expect(markdown).toBe(`${concat}\n`);
  });

  test("dedups near-duplicate insights against bottom_line and earlier items", () => {
    const value = makeRuCommentsInsights({
      bottom_line:
        "Тред добавляет практический опыт: VPN через SSH проще корпоративного клиента для доступа к внутренним сервисам.",
      insights: [
        {
          kind: "advice",
          text: "VPN через SSH удобнее корпоративного VPN-клиента для доступа к внутренним сервисам.",
        },
        {
          kind: "consensus",
          text: "Self-hosted Wireguard через Headscale проще для небольшой команды, чем полный Tailscale.",
        },
        {
          kind: "advice",
          text: "Для небольшой команды self-hosted Wireguard с Headscale проще полного Tailscale.",
        },
      ],
    });
    const markdown = renderCommentsSummaryMarkdown(value, { language: "ru", comments: [] });
    expect(markdown).toContain("Wireguard");
    expect(markdown).not.toContain("VPN через SSH удобнее");
    // second Wireguard near-dup dropped; only one remains
    expect(markdown.match(/Wireguard|Headscale/gu)?.length).toBeLessThanOrEqual(2);
  });

  test("escapes markdown literals in generated text", () => {
    const value = makeRuCommentsInsights({
      bottom_line: "Тред про `code` и *звёзды* с [ссылкой](x) в одном выводе.",
      insights: [{ kind: "advice", text: "Проверьте `rm -rf` и **жирный** текст перед запуском миграции." }],
    });
    const markdown = renderCommentsSummaryMarkdown(value, { language: "ru", comments: [] });
    expect(markdown).toContain("\\`code\\`");
    expect(markdown).toContain("\\*звёзды\\*");
    expect(markdown).toContain("\\[ссылкой\\]");
  });

  test("omits a quote with an unknown id or text absent from the original comment", () => {
    const comments = [comment()];
    const unknownId = makeRuCommentsInsights({
      best_quote: {
        comment_id: 999,
        source_text: "exact source quotation is preserved",
        translation: null,
      },
    });
    const missingText = makeRuCommentsInsights({
      best_quote: {
        comment_id: 101,
        source_text: "this quote is not present in the comment body at all",
        translation: null,
      },
    });
    expect(validateCommentsQuote(unknownId, comments)).toBeUndefined();
    expect(validateCommentsQuote(missingText, comments)).toBeUndefined();
    expect(renderCommentsSummaryMarkdown(unknownId, { language: "ru", comments })).not.toContain(">");
  });

  test("renders too-few-comments fallback with the legacy heading", () => {
    const comments = [
      comment({
        id: 1,
        by: "alice",
        textPlain: "A sufficiently long comment body that exceeds the minimum character threshold for fallback.",
      }),
      comment({
        id: 2,
        by: "bob",
        textPlain: "Another sufficiently long comment body that exceeds the minimum character threshold for fallback.",
      }),
    ];
    const markdown = renderTooFewCommentsFallback(comments, "ru");
    expect(markdown).toContain("### Из обсуждения");
    expect(markdown).toContain("@alice");
    expect(markdown).toContain("@bob");
  });
});

describe("clampToClause (mid-word truncation repair)", () => {
  test("leaves a cleanly terminated value untouched", () => {
    const clean = "Тред добавляет практический опыт эксплуатации в проде.";
    expect(clampToClause(clean)).toBe(clean);
    expect(clampToClause('Он сказал: «готово».')).toBe('Он сказал: «готово».');
  });

  test("trims to the last full sentence when the tail sentence is cut", () => {
    const cut = "Первый вывод понятен. Второй тезис обрывается на середине сло";
    expect(clampToClause(cut)).toBe("Первый вывод понятен.");
  });

  test("drops the partial trailing word and marks elision for a run-on cut", () => {
    const cut = "Пользователи считают клавиатуру слишком дорогой и предлагаю";
    const result = clampToClause(cut);
    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toContain("предлагаю");
    expect(result).toBe("Пользователи считают клавиатуру слишком дорогой и…");
  });

  test("repairs the lead so the rendered card never ends mid-word", () => {
    const bottomLine =
      "Многие считают, что клавиатура не стоит своих 230 долларов, и советуют дешёвые макропады или самодельные альтернативы вместо неё, потому что реальной пользы для агентной работы почти н";
    const lead = renderCommentsLead(bottomLine);
    // safeInline runs NFKC, so the "…" the repair adds renders as three dots.
    expect(/(?:…|\.\.\.)$/u.test(lead.trimEnd())).toBe(true);
    expect(lead).not.toContain("работы почти н");
  });
});
