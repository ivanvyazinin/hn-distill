import { describe, expect, test } from "bun:test";

import {
  buildTelegramMessage,
  buildTelegramMessages,
  commentsTeaser,
  type TelegramDigestItem,
} from "@utils/telegram";

const BASE_ITEM: TelegramDigestItem = {
  id: 42,
  title: "A useful HN thread",
  url: "https://example.com/article",
  hnUrl: "https://news.ycombinator.com/item?id=42",
  postSummary: "A concise article summary.",
  timeISO: "2026-07-15T00:00:00.000Z",
};

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      return false;
    }
    if (codePoint >= 55_296 && codePoint <= 57_343) {
      return true;
    }
    if (codePoint > 65_535) {
      index += 1;
    }
  }
  return false;
}

function expectValidTelegramHtml(message: string): void {
  const tokens = message.match(/<\/?b>|<a href="[^"]*">|<\/a>/gu) ?? [];
  const stack: string[] = [];
  for (const token of tokens) {
    if (token === "<b>" || token.startsWith("<a ")) {
      stack.push(token === "<b>" ? "b" : "a");
      continue;
    }
    const expected = token === "</b>" ? "b" : "a";
    expect(stack.pop()).toBe(expected);
  }
  expect(stack).toEqual([]);
  const withoutAllowedTags = message.replaceAll(/<\/?b>|<a href="[^"]*">|<\/a>/gu, "");
  expect(withoutAllowedTags).not.toMatch(/[<>]/u);
}

describe("commentsTeaser", () => {
  test("prefers the first bullet after skipping headings", () => {
    const ru = [
      "### Из обсуждения",
      "",
      "- **Цена\\* API:** одна сторона за кэш — другая за простоту.",
    ].join("\n");
    const en = [
      "### From the discussion",
      "",
      "- **Operational cost:** one side prefers queues — the other prefers cron.",
    ].join("\n");

    expect(commentsTeaser(ru)).toBe("Цена* API: одна сторона за кэш — другая за простоту.");
    expect(commentsTeaser(en)).toBe("Operational cost: one side prefers queues — the other prefers cron.");
  });

  test("falls back to the first legacy or too-few-comments bullet", () => {
    expect(commentsTeaser("Вводный текст\n\n- **@alice:** Проверить миграцию на копии базы.")).toBe(
      "@alice: Проверить миграцию на копии базы."
    );
    expect(commentsTeaser("### Из обсуждения\n\n- **@bob:** Один содержательный комментарий.")).toBe(
      "@bob: Один содержательный комментарий."
    );
  });

  test("omits empty, zero-comment degraded, and bullet-free summaries", () => {
    expect(commentsTeaser(null)).toBe("");
    expect(commentsTeaser("")).toBe("");
    expect(commentsTeaser("### Из обсуждения\n")).toBe("");
    expect(commentsTeaser("A legacy paragraph without bullets.")).toBe("");
  });

  test("truncates plain text without splitting a Unicode surrogate pair", () => {
    const teaser = commentsTeaser("- ab😀cd", 5);
    expect(teaser).toBe("ab😀…");
    expect(teaser.length).toBe(5);
    expect(hasUnpairedSurrogate(teaser)).toBeFalse();
  });
});

describe("buildTelegramMessage comments block", () => {
  test("prefers commentsInsights.lead over markdown teaser", () => {
    const item = {
      ...BASE_ITEM,
      commentsSummary: "- First markdown bullet that should lose to lead.",
      commentsInsights: {
        lead: "Lead from structured bottom_line with **markdown** that is stripped.",
      },
    };
    const en = buildTelegramMessage(item, "https://hckr.top", { language: "en" });
    // stripMarkdownInline removes underscores from bottom_line markers like bottom_line → bottomline
    expect(en).toContain("💬 <b>Comments:</b> Lead from structured bottomline with markdown that is stripped.");
    expect(en).not.toContain("First markdown bullet");
  });

  test("localizes the comments label and places the teaser before links", () => {
    const item = {
      ...BASE_ITEM,
      commentsSummary: "- **Caching:** faster reads — harder invalidation.",
    };
    const ru = buildTelegramMessage(item, "https://hckr.top", { language: "ru" });
    const en = buildTelegramMessage(item, "https://hckr.top", { language: "en" });

    expect(ru).toContain("💬 <b>Комментарии:</b> Caching: faster reads — harder invalidation.");
    expect(en).toContain("💬 <b>Comments:</b> Caching: faster reads — harder invalidation.");
    expect(en.indexOf("💬")).toBeLessThan(en.indexOf("<a href="));
    expect(en).toContain(">source</a>");
    expect(en).toContain(">comments on HN</a>");
  });

  test("supports legacy comments and omits the block for no summary", () => {
    const legacy = buildTelegramMessage({ ...BASE_ITEM, commentsSummary: "- First legacy viewpoint\n- Second" });
    const missing = buildTelegramMessage({ ...BASE_ITEM, commentsSummary: "" });

    expect(legacy).toContain("💬 <b>Комментарии:</b> First legacy viewpoint");
    expect(missing).not.toContain("💬");
  });

  test("escapes text and rejects hostile or non-HTTP href values", () => {
    const scriptUrl = "javascript".concat(":alert(1)");
    const scriptSite = "javascript".concat(":alert(2)");
    const message = buildTelegramMessage(
      {
        ...BASE_ITEM,
        title: "<b>not markup</b> & friends",
        url: scriptUrl,
        hnUrl: "data:text/html,<script>alert(1)</script>",
        postSummary: "5 < 7 & 9 > 3",
        commentsSummary: "- <img src=x onerror=alert(1)> & disagreement",
      },
      scriptSite,
      { language: "en" }
    );

    expect(message).not.toContain("javascript".concat(":"));
    expect(message).not.toContain("data:text");
    expect(message).toContain("&lt;b&gt;not markup&lt;/b&gt; &amp; friends");
    expect(message).toContain("5 &lt; 7 &amp; 9 &gt; 3");
    expect(message).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; disagreement");
    expect(message).toContain('href="https://hckr.top/item/42"');
    expect(message).toContain('href="https://news.ycombinator.com/item?id=42"');
    expectValidTelegramHtml(message);
  });

  test("escapes entities inside accepted href attributes", () => {
    const message = buildTelegramMessage({
      ...BASE_ITEM,
      url: "https://example.com/article?first=1&second=%22quoted%22",
    });

    expect(message).toContain('href="https://example.com/article?first=1&amp;second=%22quoted%22"');
    expectValidTelegramHtml(message);
  });

  test("truncates plain components before escaping and preserves complete HTML at 4096", () => {
    const message = buildTelegramMessage(
      {
        ...BASE_ITEM,
        title: `Entity & emoji 😀 ${"title ".repeat(100)}`,
        postSummary: `Long <summary> & entities 😀 ${"payload &<> 😀 ".repeat(800)}`,
        commentsSummary: `- **Unicode:** ${"😀 & < > ".repeat(80)}`,
      },
      "https://hckr.top",
      { language: "en" }
    );

    expect(message.length).toBeLessThanOrEqual(4096);
    expect(message).toContain("…");
    expect(message).toContain('href="https://hckr.top/item/42"');
    expect(message).toContain('href="https://news.ycombinator.com/item?id=42"');
    expect(hasUnpairedSurrogate(message)).toBeFalse();
    expectValidTelegramHtml(message);
  });

  test("keeps the artificial tiny-limit fallback escaped and within its limit", () => {
    const message = buildTelegramMessage(
      {
        ...BASE_ITEM,
        title: "<script>alert('x')</script> 😀",
        commentsSummary: "- hostile fallback",
      },
      "https://hckr.top",
      { maxLength: 20 }
    );

    expect(message.length).toBeLessThanOrEqual(20);
    expect(message).not.toContain("<script>");
    expect(message).toContain("&lt;");
  });

  test("keeps old call sites working and forwards language through the batch builder", () => {
    const item = { ...BASE_ITEM, commentsSummary: "- A legacy opinion" };
    expect(buildTelegramMessage(item)).toContain("Комментарии");
    expect(buildTelegramMessages([item], undefined, { language: "en" })[0]).toContain("Comments");
  });
});
