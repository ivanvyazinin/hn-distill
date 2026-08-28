import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  COMMENTS_COMPRESS_PROMPT,
  buildCommentsCompressUserPrompt,
  commentsCompressModelChain,
  compressSourceHash,
  isRetriableCompressReject,
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
  test("renderCommentsInsightsPlainText drops near-duplicate insights like the display render", () => {
    const first =
      "Проверяйте гипотезу на малом воспроизводимом примере перед полным запуском в прод.";
    const nearCopy =
      "Проверяйте гипотезу на малом воспроизводимом примере перед полным запуском в продакшен.";
    const bottomEcho =
      "Тред добавляет практический опыт: VPN через SSH проще корпоративного клиента для внутреннего доступа.";
    const planted = makeRuCommentsInsights({
      insights: [
        { kind: "advice", text: first },
        { kind: "advice", text: nearCopy },
        { kind: "advice", text: bottomEcho },
        {
          kind: "consensus",
          text: "Участники согласны, что измерения нужно повторить на реальной нагрузке перед выбором архитектуры.",
        },
      ],
    });

    const plain = renderCommentsInsightsPlainText(planted);
    expect(plain).toContain(first);
    expect(plain).not.toContain(nearCopy);
    expect(plain).not.toContain(bottomEcho);
    expect(plain).toContain("измерения нужно повторить");
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

  test("commentsCompressModelChain: primary, optional fallback, dedup, kill switch", async () => {
    const { withEnvPatch } = await import("./helpers");
    await withEnvPatch({ COMMENTS_COMPRESS_MODEL: "a", COMMENTS_COMPRESS_FALLBACK_MODEL: "b" }, async () => {
      expect(commentsCompressModelChain()).toEqual(["a", "b"]);
    });
    await withEnvPatch({ COMMENTS_COMPRESS_MODEL: "a", COMMENTS_COMPRESS_FALLBACK_MODEL: " a " }, async () => {
      expect(commentsCompressModelChain()).toEqual(["a"]);
    });
    await withEnvPatch({ COMMENTS_COMPRESS_MODEL: "a", COMMENTS_COMPRESS_FALLBACK_MODEL: "" }, async () => {
      expect(commentsCompressModelChain()).toEqual(["a"]);
    });
    // Empty primary is the kill switch for the whole route — the fallback must not revive it.
    await withEnvPatch({ COMMENTS_COMPRESS_MODEL: "", COMMENTS_COMPRESS_FALLBACK_MODEL: "b" }, async () => {
      expect(commentsCompressModelChain()).toEqual([]);
    });
  });

  test("isRetriableCompressReject: language/format retries, size verdicts are terminal", () => {
    // Model-specific: the paid hop plausibly answers in Russian on the same input.
    expect(isRetriableCompressReject("low_cyrillic_ratio:0.621")).toBeTrue();
    expect(isRetriableCompressReject("low_cyrillic_ratio,latin_prose")).toBeTrue();
    expect(isRetriableCompressReject("contains_url")).toBeTrue();
    expect(isRetriableCompressReject("artifact")).toBeTrue();
    // Source verdicts: another hop would only repeat them.
    expect(isRetriableCompressReject("expanded:4547>3237")).toBeFalse();
    expect(isRetriableCompressReject("too_short:189<200")).toBeFalse();
    expect(isRetriableCompressReject("expanded:10>5,too_short:1<2")).toBeFalse();
    // Mixed: one retriable token is enough to earn the next hop.
    expect(isRetriableCompressReject("too_short:189<200,latin_prose")).toBeTrue();
    expect(isRetriableCompressReject("")).toBeFalse();
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

// Fixture: verbatim prod data/summaries/49468642.comments.json from 2026-08-28.
// Stage-1 (MiniMax-M3) returned 11 clean insights; the compressor hop
// (qwen/qwen3-next-80b-a3b-instruct) repeated one thesis byte-identically and
// the pre-fix validation passed it, publishing the duplicate to the site.
const prodDupFixturePath = new URL("fixtures/comments-v2/49468642-compressed-dup.json", import.meta.url);

describe("prod 49468642 regression: compressor duplicate must not publish", () => {
  const fixture = JSON.parse(readFileSync(prodDupFixturePath, "utf8")) as {
    lang: "ru";
    structured: Parameters<typeof renderCommentsInsightsPlainText>[0];
    compressed: { text: string; sourceHash: string };
  };

  test("deduped plaintext keeps the prod sourceHash stable when stage-1 has no duplicates", () => {
    // If this breaks, every good prod compressed blob goes stale on deploy and
    // the fleet re-compresses for no reason — dedup must only change inputs
    // that actually contain duplicates.
    const plain = renderCommentsInsightsPlainText(fixture.structured);
    expect(compressSourceHash(fixture.lang, plain)).toBe(fixture.compressed.sourceHash);
  });

  test("rejects the published paragraph as duplicate_sentence, retriable for the next hop", () => {
    const plain = renderCommentsInsightsPlainText(fixture.structured);
    const verdict = validateCompressedText(fixture.compressed.text, plain, { language: "ru" });
    expect(verdict.ok).toBeFalse();
    if (verdict.ok) {
      return;
    }
    expect(verdict.reason).toContain("duplicate_sentence");
    expect(isRetriableCompressReject(verdict.reason)).toBeTrue();
  });

  test("accepts the same paragraph with the duplicate removed (no false positive on real text)", () => {
    const repeated =
      "@ks2048, @saghm, @MaxBarraclough и @wvbdmp сходятся: фаззеры важны, потому что находят именно эксплуатируемые пути, а не просто ошибки.";
    expect(fixture.compressed.text.split(repeated).length - 1).toBe(2);
    const clean = fixture.compressed.text.replace(`${repeated} ${repeated}`, repeated);

    const plain = renderCommentsInsightsPlainText(fixture.structured);
    const verdict = validateCompressedText(clean, plain, { language: "ru" });
    expect(verdict).toEqual({ ok: true, text: clean });
  });

  test("ignores repeated short stock phrases below the word gate", () => {
    const body =
      "Тред сходится, что перед миграцией нужно измерить задержки на реальной нагрузке, зеркалировать запросы между старой и новой системами, сравнивать ответы и оставить путь отката. Итог понятен. Итог понятен.";
    const verdict = validateCompressedText(body, `${body} ${"дополнительный исходный текст".repeat(6)}`, {
      language: "ru",
      minChars: 40,
    });
    expect(verdict).toEqual({ ok: true, text: body });
  });
});
