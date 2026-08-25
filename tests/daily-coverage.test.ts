import { describe, expect, test } from "bun:test";

import { computeCoverage, renderSummaryMarkdown, type CoverageInput } from "../scripts/daily-coverage.mts";

function makeInput(overrides: Partial<CoverageInput> = {}): CoverageInput {
  return {
    day: "2026-08-24",
    top: [
      { id: 101, title: "Top story", score: 900 },
      { id: 102, title: "Second", score: 500 },
      { id: 103, title: "Third", score: 350 },
    ],
    publishedIds: [101],
    publishedYesterday: 7,
    minCards: 6,
    minCoverage: 0.5,
    ...overrides,
  };
}

describe("computeCoverage", () => {
  test("marks hits and misses against the published set", () => {
    const report = computeCoverage(makeInput());
    expect(report.hits).toBe(1);
    expect(report.total).toBe(3);
    expect(report.rows.map((row) => row.hit)).toEqual([true, false, false]);
    expect(report.alerts).toContain("coverage 1/3 (33%) is below 50%");
  });

  test("full coverage and enough cards produce no alerts", () => {
    const report = computeCoverage(
      makeInput({ publishedIds: [101, 102, 103], publishedYesterday: 9 })
    );
    expect(report.hits).toBe(3);
    expect(report.alerts).toEqual([]);
  });

  test("low card volume raises the volume alert even with full coverage", () => {
    const report = computeCoverage(
      makeInput({ publishedIds: [101, 102, 103], publishedYesterday: 2 })
    );
    expect(report.alerts).toEqual(["only 2 cards published for 2026-08-24 (minimum 6)"]);
  });

  test("coverage exactly at threshold does not alert", () => {
    const report = computeCoverage(
      makeInput({
        top: [
          { id: 201, title: "A", score: 900 },
          { id: 202, title: "B", score: 800 },
          { id: 203, title: "C", score: 700 },
          { id: 204, title: "D", score: 600 },
        ],
        publishedIds: [201, 202],
        minCoverage: 0.5,
      })
    );
    expect(Math.abs(report.coverageRatio - 0.5) < 1e-9).toBe(true);
    expect(report.alerts.filter((alert) => alert.includes("coverage"))).toEqual([]);
  });
  test("empty day window counts as covered and stays silent about ratio", () => {
    const report = computeCoverage(
      makeInput({ top: [], publishedIds: [], publishedYesterday: 10 })
    );
    expect(report.total).toBe(0);
    expect(report.coverageRatio).toBe(1);
    expect(report.alerts).toEqual([]);
  });

  test("stories without title or score degrade gracefully", () => {
    const report = computeCoverage(makeInput({ top: [{ id: 999 }] }));
    expect(report.rows[0]?.title).toBe("(title unavailable)");
    expect(report.rows[0]?.score).toBe(0);
  });

  test("summary markdown renders table and alert block", () => {
    const markdown = renderSummaryMarkdown(computeCoverage(makeInput()));
    expect(markdown).toContain("### Daily digest coverage — 2026-08-24");
    expect(markdown).toContain("| 900 | [Top story](https://news.ycombinator.com/item?id=101) | yes |");
    expect(markdown).toContain("**MISS**");
    expect(markdown).toContain("⚠️");
    expect(markdown).toContain("Hits: **1/3** (33%)");
  });
});
