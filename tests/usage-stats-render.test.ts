import { describe, expect, test } from "bun:test";

import { renderUsageTable } from "../scripts/usage-stats.mts";

import type { LlmUsageSummaryRow } from "../utils/meta-store";

function row(overrides: Partial<LlmUsageSummaryRow>): LlmUsageSummaryRow {
  return {
    day: "2026-07-15",
    gateway: "openrouter",
    label: "post",
    modelRequested: "primary",
    modelUsed: "primary",
    calls: 1,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

describe("renderUsageTable", () => {
  test("empty input hints at the flag instead of an empty table", () => {
    expect(renderUsageTable([])).toContain("No LLM usage recorded");
  });

  test("renders header, rows, and a totals line; shows fallback as requested→used", () => {
    const rows: LlmUsageSummaryRow[] = [
      row({ label: "post", modelRequested: "primary", modelUsed: "primary", calls: 2, totalTokens: 370 }),
      row({
        gateway: "groq",
        label: "comments",
        modelRequested: "llama",
        modelUsed: "llama-fallback",
        calls: 3,
        errors: 1,
        promptTokens: 300,
        completionTokens: 100,
        totalTokens: 400,
      }),
      row({ gateway: "groq", label: "tags", modelRequested: "llama", modelUsed: null, calls: 1, totalTokens: 0 }),
    ];

    const table = renderUsageTable(rows);

    // Header present.
    expect(table).toContain("day");
    expect(table).toContain("total");
    // Same requested/used model shows once; a differing fallback shows the arrow.
    expect(table).toContain("primary");
    expect(table).toContain("llama→llama-fallback");
    // NULL model_used falls back to the requested model name, no arrow.
    expect(table).toMatch(/tags\s+llama\s/u);
    // Totals aggregate calls/errors/tokens across all groups.
    expect(table).toContain("Totals: 6 calls, 1 errors, 770 tokens across 3 groups.");
  });
});
