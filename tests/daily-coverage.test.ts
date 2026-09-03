import { describe, expect, test } from "bun:test";

import {
  classifyMiss,
  computeCoverage,
  formatMissLines,
  renderSummaryMarkdown,
  type CoverageInput,
  type MissSnapshot,
} from "../scripts/daily-coverage.mts";

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

  test("miss reasons attach to MISS rows and render in markdown", () => {
    const report = computeCoverage(
      makeInput({ publishedIds: [], reasons: { 102: "article download failed" } })
    );
    expect(report.rows[1]?.reason).toBe("article download failed");
    expect(report.rows[0]?.reason).toBeUndefined();
    const markdown = renderSummaryMarkdown(report);
    expect(markdown).toContain("| Why missed |");
    expect(markdown).toContain("article download failed");
  });

  test("summary markdown renders table and alert block", () => {
    const markdown = renderSummaryMarkdown(computeCoverage(makeInput()));
    expect(markdown).toContain("### Daily digest coverage — 2026-08-24");
    expect(markdown).toContain("| 900 | [Top story](https://news.ycombinator.com/item?id=101) | yes |  |");
    expect(markdown).toContain("**MISS**");
    expect(markdown).toContain("⚠️");
    expect(markdown).toContain("Hits: **1/3** (33%)");
  });
});

describe("classifyMiss", () => {
  const ok: MissSnapshot = {
    selected: true,
    hasRaw: true,
    hasUrl: true,
    article: "ok",
    post: "ok",
    passesGate: true,
  };

  test("cheapest explanation wins, in pipeline order", () => {
    expect(classifyMiss({ ...ok, selected: false, hasRaw: false })).toContain("not selected");
    expect(classifyMiss({ ...ok, hasRaw: false })).toContain("fetch failed");
    expect(classifyMiss({ ...ok, passesGate: false })).toContain("below engagement gate");
    expect(classifyMiss({ ...ok, hasUrl: false, article: "na", post: "missing" })).toContain("no URL");
    expect(classifyMiss({ ...ok, post: "no-article", article: "no-article" })).toContain("no-article");
    expect(classifyMiss({ ...ok, article: "missing", post: "missing" })).toContain("article download failed");
    expect(classifyMiss({ ...ok, post: "failed" })).toContain("post summary missing");
    expect(classifyMiss(ok)).toContain("dropped at aggregate");
  });
});

describe("formatMissLines", () => {
  test("miss rows render escaped title, link and reason", () => {
    const report = computeCoverage({
      day: "2026-08-24",
      top: [
        { id: 101, title: "Top story", score: 900 },
        { id: 102, title: "Second <b> & co", score: 500 },
      ],
      publishedIds: [101],
      publishedYesterday: 7,
      minCards: 6,
      minCoverage: 0.5,
      reasons: { 102: "article download failed" },
    });
    const lines = formatMissLines([report]);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("Second &lt;b&gt; &amp; co");
    expect(lines[0]).toContain("item?id=102");
    expect(lines[0]).toContain("article download failed");
  });

  test("no misses produce no lines", () => {
    const report = computeCoverage({
      day: "2026-08-24",
      top: [{ id: 101, title: "Top", score: 900 }],
      publishedIds: [101],
      publishedYesterday: 7,
      minCards: 6,
      minCoverage: 0.5,
    });
    expect(formatMissLines([report])).toEqual([]);
  });
});
