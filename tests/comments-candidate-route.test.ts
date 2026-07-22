import { describe, expect, test } from "bun:test";

import { env } from "../config/env.ts";
import { __testing } from "../eval/comments-candidate-route.ts";
import { evaluateGate, selectFixtures, type FixtureMeta, type Generation } from "../eval/run-comments-candidates.mts";
import { HttpError } from "../utils/http-client.ts";
import { makeEnCommentsInsights, makeRuCommentsInsights } from "./helpers/comments-insights.ts";

import type { NormalizedComment } from "../config/schemas.ts";

const { validateCandidateInsights, findHttpError } = __testing;

const SOURCE_TEXT = "Полный исходный текст комментария сохранён здесь для проверки провенанса цитаты.";

function comment(overrides: Partial<NormalizedComment> = {}): NormalizedComment {
  return {
    id: 101,
    by: "alice",
    parent: 1,
    depth: 1,
    timeISO: "2026-07-15T00:00:00.000Z",
    textPlain: SOURCE_TEXT,
    ...overrides,
  };
}

function gen(overrides: Partial<Generation> = {}): Generation {
  return {
    storyId: 1,
    validationPassed: true,
    summary: "summary",
    summaryChars: 7,
    quoteEmitted: false,
    quoteProvenanceOk: true,
    promptChars: 1000,
    includedComments: 10,
    routeLabel: "candidate",
    repeat: 0,
    reserveWaitMs: 0,
    attempt: { requestedModel: "qwen/qwen3.6-27b", status: "ok", latencyMs: 1200 },
    ...overrides,
  };
}

describe("validateCandidateInsights (composed production validator)", () => {
  const comments = [comment()];

  test("valid Russian insights with no quote pass and render a summary", () => {
    const out = validateCandidateInsights(makeRuCommentsInsights(), comments, [101], 15);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.summary.trim().length).toBeGreaterThan(0);
      expect(out.quoteEmitted).toBe(false);
      expect(out.quoteProvenanceOk).toBe(true);
    }
  });

  test("an emitted quote that IS in a sampled comment keeps provenance", () => {
    const source = "исходный текст комментария сохранён здесь для проверки провенанса";
    const insights = makeRuCommentsInsights({
      best_quote: { comment_id: 101, source_text: source, translation: null },
    });
    const out = validateCandidateInsights(insights, comments, [101], 15);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.quoteEmitted).toBe(true);
      expect(out.quoteProvenanceOk).toBe(true);
      expect(out.insights.best_quote).not.toBeNull();
    }
  });

  test("an emitted quote NOT present in the source is a provenance failure and is dropped", () => {
    const insights = makeRuCommentsInsights({
      best_quote: { comment_id: 101, source_text: "Этой фразы нет ни в одном комментарии треда вообще нигде.", translation: null },
    });
    const out = validateCandidateInsights(insights, comments, [101], 15);
    expect(out.ok).toBe(true); // summary still renders from insights
    if (out.ok) {
      expect(out.quoteEmitted).toBe(true);
      expect(out.quoteProvenanceOk).toBe(false);
      expect(out.insights.best_quote).toBeNull();
    }
  });

  test("a quote whose comment is outside the sampled set fails provenance", () => {
    const other = comment({ id: 202, textPlain: "Второй комментарий содержит эту цитату для проверки выборки идентификаторов." });
    const insights = makeRuCommentsInsights({
      best_quote: { comment_id: 202, source_text: "Второй комментарий содержит эту цитату для проверки выборки", translation: null },
    });
    const out = validateCandidateInsights(insights, [comment(), other], [101], 15);
    if (out.ok) {
      expect(out.quoteProvenanceOk).toBe(false);
      expect(out.insights.best_quote).toBeNull();
    }
  });

  // Only meaningful when the requested output language is Russian (the deployed default).
  if (env.SUMMARY_LANG === "ru") {
    test("English insights fail the language heuristic", () => {
      const out = validateCandidateInsights(makeEnCommentsInsights(), comments, [101], 15);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toContain("heuristics");
      }
    });
  }
});

describe("findHttpError", () => {
  test("returns a directly-thrown HttpError with its status", () => {
    const found = findHttpError(new HttpError("https://api", 429, "rate limited"));
    expect(found?.status).toBe(429);
  });

  test("unwraps an HttpError from the cause chain", () => {
    const wrapped = new Error("wrapper", { cause: new HttpError("https://api", 413, "too large") });
    expect(findHttpError(wrapped)?.status).toBe(413);
  });

  test("returns undefined for a plain error", () => {
    expect(findHttpError(new Error("boom"))).toBeUndefined();
  });
});

describe("selectFixtures", () => {
  const metas: FixtureMeta[] = [
    { id: 1, sizeBucket: "long", tags: ["long", "near-limit"], promptChars: 17_000 },
    { id: 2, sizeBucket: "long", tags: ["long", "contested"], promptChars: 16_000 },
    { id: 3, sizeBucket: "long", tags: ["long"], promptChars: 15_000 },
    { id: 4, sizeBucket: "medium", tags: ["medium", "technical"], promptChars: 12_000 },
    { id: 5, sizeBucket: "medium", tags: ["medium", "contested"], promptChars: 11_000 },
    { id: 6, sizeBucket: "medium", tags: ["medium"], promptChars: 9000 },
    { id: 7, sizeBucket: "short", tags: ["short"], promptChars: 4000 },
    { id: 8, sizeBucket: "short", tags: ["short", "technical"], promptChars: 2000 },
  ];

  test("picks a diverse, deterministic 6 spanning sizes", () => {
    const picked = selectFixtures(metas, 6);
    expect(picked.length).toBe(6);
    const ids = picked.map((m) => m.id);
    expect(new Set(ids).size).toBe(6); // no duplicates
    expect(ids).toContain(1); // largest long
    expect(ids).toContain(2); // second long
    expect(picked.some((m) => m.tags.includes("technical"))).toBe(true);
    expect(picked.some((m) => m.tags.includes("contested"))).toBe(true);
    expect(picked.filter((m) => m.sizeBucket === "short").length).toBe(2);
    // Deterministic across calls.
    expect(selectFixtures(metas, 6).map((m) => m.id)).toEqual(ids);
  });

  test("honours an explicit id override in order", () => {
    expect(selectFixtures(metas, 3, [8, 4, 1]).map((m) => m.id)).toEqual([8, 4, 1]);
  });
});

describe("evaluateGate", () => {
  test("passes when all 12 validate within budget", () => {
    const gate = evaluateGate("candidate", Array.from({ length: 12 }, () => gen()), 7000);
    expect(gate.passed).toBe(true);
    expect(gate.validated).toBe(12);
  });

  test("tolerates a single failure (11/12) but not two", () => {
    const oneFail = [gen({ validationPassed: false, rejectedReason: "too_short" }), ...Array.from({ length: 11 }, () => gen())];
    expect(evaluateGate("candidate", oneFail, 7000).checks.find((c) => c.name === "validated")?.passed).toBe(true);
    const twoFail = [gen({ validationPassed: false }), gen({ validationPassed: false }), ...Array.from({ length: 10 }, () => gen())];
    expect(evaluateGate("candidate", twoFail, 7000).checks.find((c) => c.name === "validated")?.passed).toBe(false);
  });

  test("fails on a provenance failure, a 413, or a p95 over deadline", () => {
    const provenance = evaluateGate("candidate", [gen({ quoteEmitted: true, quoteProvenanceOk: false }), ...Array.from({ length: 11 }, () => gen())], 7000);
    expect(provenance.passed).toBe(false);

    const big = evaluateGate("candidate", [gen({ attempt: { requestedModel: "m", status: "error", httpStatus: 413, latencyMs: 100 } }), ...Array.from({ length: 11 }, () => gen())], 7000);
    expect(big.checks.find((c) => c.name === "http_413")?.passed).toBe(false);

    const slow = evaluateGate("candidate", Array.from({ length: 12 }, () => gen({ attempt: { requestedModel: "m", status: "ok", latencyMs: 9000 } })), 7000);
    expect(slow.checks.find((c) => c.name === "p95_latency_ms")?.passed).toBe(false);
  });
});
