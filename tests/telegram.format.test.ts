import { describe, expect, test } from "bun:test";

import { chunkTelegramText, escapeHtml } from "@utils/telegram";

describe("escapeHtml", () => {
  test("should escape HTML entities", () => {
    expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  test("should handle normal text", () => {
    expect(escapeHtml("Hello world")).toBe("Hello world");
  });

  test("should handle empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  test("should handle text with no special characters", () => {
    expect(escapeHtml("Normal text without HTML")).toBe("Normal text without HTML");
  });

  test("should escape multiple occurrences", () => {
    expect(escapeHtml("a & b < c > d \" e ' f")).toBe("a &amp; b &lt; c &gt; d &quot; e &#39; f");
  });
});

describe("chunkTelegramText", () => {
  test("should return single chunk when text is within limit", () => {
    const text = "Short text";
    const chunks = chunkTelegramText(text, 100);
    expect(chunks).toEqual([text]);
  });

  test("should return single chunk when text equals limit", () => {
    const text = "a".repeat(4096);
    const chunks = chunkTelegramText(text, 4096);
    expect(chunks).toEqual([text]);
  });

  test("should split text that exceeds limit", () => {
    const text = "a".repeat(5000);
    const chunks = chunkTelegramText(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  test("should prefer paragraph breaks for splitting", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
    const chunks = chunkTelegramText(text, 20);
    // Should split at paragraph breaks
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some((chunk) => chunk.includes("Paragraph one."))).toBe(true);
  });

  test("should fall back to line breaks when no paragraph breaks available", () => {
    const text = "Line one\nLine two\nLine three";
    const chunks = chunkTelegramText(text, 15);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  test("should handle text with no natural breaks", () => {
    const text = "VeryLongWordThatExceedsTheLimitAndHasNoBreaks";
    const chunks = chunkTelegramText(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  test("should handle empty string", () => {
    const chunks = chunkTelegramText("", 100);
    expect(chunks).toEqual([""]);
  });

  test("should handle text with mixed break types", () => {
    const text = "Para1\n\nPara2\nPara3\n\nPara4";
    const chunks = chunkTelegramText(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    // Should prefer paragraph breaks over line breaks
    expect(chunks.some((chunk) => chunk.includes("Para1"))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes("Para2"))).toBe(true);
  });
});
