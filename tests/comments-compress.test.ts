import { describe, expect, test } from "bun:test";

import {
  COMMENTS_COMPRESS_PROMPT,
  buildCommentsCompressUserPrompt,
  compressSourceHash,
  renderCommentsInsightsPlainText,
  resolveCompressedState,
  sanitizeCompressedOutput,
  validateCompressedText,
} from "../utils/comments-compress.ts";
import { makeRuCommentsInsights } from "./helpers/comments-insights.ts";

const insights = makeRuCommentsInsights({
  bottom_line: "Тред добавляет практический опыт эксплуатации и оговорки перед миграцией.",
  insights: [
    {
      kind: "consensus",
      text: "Участники согласны, что перед миграцией нужно измерить задержки.",
    },
    {
      kind: "dispute",
      text: "одна сторона за полный cutover, другая — за постепенное включение.",
    },
    {
      kind: "advice",
      text: "Сначала зеркалируйте запросы и сравнивайте ответы.",
    },
  ],
  best_quote: {
    comment_id: 1,
    source_text: "Measure twice before the cutover and keep a rollback ready.",
    translation: "Сначала всё измерьте, затем мигрируйте и оставьте путь для отката.",
  },
});

describe("comments-compress pure helpers", () => {
  test("renderCommentsInsightsPlainText includes bottom_line + kind prefixes, excludes best_quote", () => {
    const plain = renderCommentsInsightsPlainText(insights);
    expect(plain).toContain(insights.bottom_line);
    expect(plain).toContain("Участники согласны");
    expect(plain).toContain("Спор: одна сторона");
    expect(plain).toContain("Совет: Сначала зеркалируйте");
    expect(plain).not.toContain("Measure twice");
    expect(plain).not.toContain("best_quote");
  });

  test("buildCommentsCompressUserPrompt freezes the exact prompt wording", () => {
    const plain = "строка один\nстрока два";
    expect(buildCommentsCompressUserPrompt(plain)).toBe(`${COMMENTS_COMPRESS_PROMPT}\n\n${plain}`);
    expect(COMMENTS_COMPRESS_PROMPT).toBe(
      "Сожми текст: убери повторы, канцелярит и лишние пояснения, объедини близкие мысли. Сохрани факты, смысл и важные оговорки. Ничего не добавляй от себя. Верни только итоговый текст."
    );
  });

  test("compressSourceHash is deterministic and changes with language/text", () => {
    const plain = renderCommentsInsightsPlainText(insights);
    const a = compressSourceHash("ru", plain);
    const b = compressSourceHash("ru", plain);
    const c = compressSourceHash("en", plain);
    const d = compressSourceHash("ru", `${plain}\nextra`);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("sanitizeCompressedOutput strips fences, labels, quotes and collapses whitespace", () => {
    // clampToClause may append … when the stripped text has no sentence terminator.
    expect(sanitizeCompressedOutput('```\n«Итоговый текст:  "Раз  два."  »\n```')).toBe("Раз два.");
    expect(sanitizeCompressedOutput("Итог — Короткий абзац.")).toBe("Короткий абзац.");
    expect(sanitizeCompressedOutput("  строка один. \n\n строка  два.  ")).toBe("строка один. строка два.");
    // Multi-span quotes must not be peeled as a single outer pair.
    expect(sanitizeCompressedOutput("«Первый.» … «Второй.»")).toBe("«Первый.» … «Второй.»");
  });

  test("isCommentsCompressEnabled gates on lang + model", async () => {
    const { isCommentsCompressEnabled } = await import("../utils/comments-compress.ts");
    const { withEnvPatch } = await import("./helpers");
    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: "m" }, async () => {
      expect(isCommentsCompressEnabled()).toBeTrue();
    });
    await withEnvPatch({ SUMMARY_LANG: "ru", COMMENTS_COMPRESS_MODEL: "" }, async () => {
      expect(isCommentsCompressEnabled()).toBeFalse();
    });
    await withEnvPatch({ SUMMARY_LANG: "en", COMMENTS_COMPRESS_MODEL: "m" }, async () => {
      expect(isCommentsCompressEnabled()).toBeFalse();
    });
  });

  test("isPermanentCompressHttpError treats 4xx (except 408/425/429) as terminal", async () => {
    const { isPermanentCompressHttpError } = await import("../utils/comments-compress.ts");
    const { HttpError } = await import("../utils/http-client.ts");
    expect(isPermanentCompressHttpError(new HttpError("u", 404, "missing"))).toBeTrue();
    expect(isPermanentCompressHttpError(new HttpError("u", 401, "auth"))).toBeTrue();
    expect(isPermanentCompressHttpError(new HttpError("u", 429, "rate"))).toBeFalse();
    expect(isPermanentCompressHttpError(new HttpError("u", 503, "down"))).toBeFalse();
    expect(isPermanentCompressHttpError(new Error("plain"))).toBeFalse();
    expect(isPermanentCompressHttpError(new Error("wrap", { cause: new HttpError("u", 400, "bad") }))).toBeTrue();
  });

  test("validateCompressedText rejects empty, short, expanded, and non-cyrillic text", () => {
    const source = "А".repeat(300);
    expect(validateCompressedText("", source, { language: "ru", minChars: 50 }).ok).toBeFalse();
    expect(validateCompressedText("коротко", source, { language: "ru", minChars: 50 }).ok).toBeFalse();
    expect(
      validateCompressedText(`${source}extra`, source, { language: "ru", minChars: 50 }).ok
    ).toBeFalse();
    expect(
      validateCompressedText("This is entirely English prose about migrations and rollbacks with enough length.", source, {
        language: "ru",
        minChars: 40,
        minCyrillicRatio: 0.65,
      }).ok
    ).toBeFalse();

    const good =
      "Тред добавляет практический опыт эксплуатации: перед миграцией измерьте задержки и проверьте восстановление после сбоев, зеркалируйте запросы, сравнивайте ответы между системами и включайте запись только после устранения всех найденных расхождений.";
    const ok = validateCompressedText(good, `${good} ${"ещё исходный текст".repeat(5)}`, {
      language: "ru",
      minChars: 80,
    });
    expect(ok).toEqual({ ok: true, text: good });
  });

  test("resolveCompressedState covers the four contract states", () => {
    const hash = "abc";
    expect(resolveCompressedState({}, hash)).toBe("retryable");
    expect(
      resolveCompressedState(
        { compressed: { text: "ok", model: "m", createdISO: "t", sourceHash: "other" } },
        hash
      )
    ).toBe("retryable");
    expect(
      resolveCompressedState(
        { compressed: { text: "", model: "m", createdISO: "t", sourceHash: hash } },
        hash
      )
    ).toBe("rejected");
    expect(
      resolveCompressedState(
        { compressed: { text: "usable", model: "m", createdISO: "t", sourceHash: hash } },
        hash
      )
    ).toBe("usable");
  });
});
