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
});
