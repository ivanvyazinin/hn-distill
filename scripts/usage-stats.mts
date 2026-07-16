import { openLocalMetaStore } from "@utils/meta-runtime";

import type { LlmUsageSummaryRow } from "@utils/meta-store";

/** Render the per-day/gateway/label/model usage summary as an aligned text table. */
export function renderUsageTable(rows: LlmUsageSummaryRow[]): string {
  if (rows.length === 0) {
    return "No LLM usage recorded yet (is LLM_USAGE_ENABLED=true?).";
  }

  const header = ["day", "gateway", "label", "model", "calls", "errors", "prompt", "completion", "total"];
  const body = rows.map((row) => [
    row.day,
    row.gateway,
    row.label,
    // model_requested→model_used only when they differ (fallback served a different model).
    row.modelUsed !== null && row.modelUsed !== row.modelRequested
      ? `${row.modelRequested}→${row.modelUsed}`
      : row.modelRequested,
    String(row.calls),
    String(row.errors),
    String(row.promptTokens),
    String(row.completionTokens),
    String(row.totalTokens),
  ]);

  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((columns) => (columns[index] ?? "").length))
  );
  // Left-align text columns (0-3), right-align numeric columns (4-8).
  const format = (columns: string[]): string =>
    columns.map((cell, index) => (index <= 3 ? cell.padEnd(widths[index] ?? 0) : cell.padStart(widths[index] ?? 0))).join("  ");

  const totals = rows.reduce(
    (accumulator, row) => ({
      calls: accumulator.calls + row.calls,
      errors: accumulator.errors + row.errors,
      total: accumulator.total + row.totalTokens,
    }),
    { calls: 0, errors: 0, total: 0 }
  );

  return [
    format(header),
    format(header.map((_cell, index) => "-".repeat(widths[index] ?? 0))),
    ...body.map(format),
    "",
    `Totals: ${totals.calls} calls, ${totals.errors} errors, ${totals.total} tokens across ${rows.length} groups.`,
  ].join("\n");
}

export async function main(): Promise<void> {
  const meta = await openLocalMetaStore();
  if (meta === undefined) {
    // eslint-disable-next-line no-console
    console.error("Local meta store unavailable (node:sqlite required); cannot read LLM usage.");
    process.exit(1);
  }
  try {
    const rows = await meta.getLlmUsageSummary();
    // eslint-disable-next-line no-console
    console.log(renderUsageTable(rows));
  } finally {
    await meta.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
