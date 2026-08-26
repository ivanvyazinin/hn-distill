import { describe, expect, test } from "bun:test";

import {
  classifyCommentsCard,
  extractItemIds,
  repeatOffenders,
  summarizeRenderSample,
  tallyWarnings,
  computeRenderDelta,
} from "../utils/prod-health.ts";

const COMPRESSED_CARD = `
<aside class="card"><h3 class="title"><a href="https://news.ycombinator.com/item?id=100">Комментарии (42)</a></h3>
<div class="md"><p>Обсуждение показывает, что подход рабочий: пользователи делятся замерами и опытом эксплуатации в продакшене.</p>
</div></aside>`;

const FALLBACK_CARD = `
<aside class="card"><h3 class="title"><a href="https://news.ycombinator.com/item?id=200">Комментарии (300)</a></h3>
<div class="md"><p>Обсуждение ставит под сомнение искренность перехода к открытым моделям.</p>
<p><b>Спор:</b> одни считают шаг тактическим, другие — принципиальным.</p>
<p><b>Спор:</b> открытие моделей меняет правила игры, но не ценности.</p>
<p>Участники признают пользу для экосистемы.</p>
<blockquote>цитата</blockquote></div></aside>`;

describe("extractItemIds", () => {
  test("collects unique ids in order up to the limit", () => {
    const html = `<a href="/hn-distill/item/7/">a</a><a href="/hn-distill/item/3/">b</a><a href="/hn-distill/item/7/">c</a>`;
    expect(extractItemIds(html, 10)).toEqual([7, 3]);
  });

  test("stops at the limit", () => {
    const html = Array.from({ length: 30 }, (_, index) => `/item/${index}/`).join(" ");
    expect(extractItemIds(html, 10).length).toBe(10);
  });
});

describe("classifyCommentsCard", () => {
  test("single paragraph renders as compressed", () => {
    const result = classifyCommentsCard(COMPRESSED_CARD);
    expect(result.mode).toBe("compressed");
    expect(result.disputeLabels).toBe(0);
  });

  test("multi-paragraph render is fallback and counts Спор labels", () => {
    const result = classifyCommentsCard(FALLBACK_CARD);
    expect(result.mode).toBe("fallback");
    expect(result.disputeLabels).toBeGreaterThanOrEqual(2);
  });

  test("no comments card is missing", () => {
    expect(classifyCommentsCard("<html><body>nothing</body></html>").mode).toBe("missing");
  });
});

describe("tallyWarnings", () => {
  test("counts categories, pairs reject ids with reasons, spots minimax timeouts", () => {
    const lines = [
      "WARN summarize/comments: Comments compress semantic reject { id: 49434378, reason: 'expanded:4547>3237' }",
      "WARN summarize/comments: Comments compress transport error; leaving field absent { error: 'empty content' }",
      "DOMException [TimeoutError]: Request timed out … url: 'https://api.minimax.io/v1/chat/completions'",
      "INFO summarize/comments: Comments-v2 summary written { id: 1 }",
    ];
    const tally = tallyWarnings(lines);
    expect(tally.counts["compress.semanticReject"]).toBe(1);
    expect(tally.counts["compress.transportError"]).toBe(1);
    expect(tally.counts["minimax.hopTimeout"]).toBe(1);
    expect(tally.rejectIdsByReason["expanded:4547>3237"]).toEqual([49_434_378]);
  });
});

describe("repeatOffenders", () => {
  test("flags ids rejected for the same reason in two or more runs", () => {
    const runA = { expanded: [100, 200] };
    const runB = { expanded: [100] };
    const runC = { too_short: [100] };
    const offenders = repeatOffenders([runA, runB, runC]);
    expect(offenders).toEqual([{ reason: "expanded", id: 100, runs: 2 }]);
  });

  test("single-run rejects are not offenders", () => {
    expect(repeatOffenders([{ expanded: [5] }, { expanded: [6] }])).toEqual([]);
  });
});

describe("summarizeRenderSample", () => {
  test("ratio ignores missing pages instead of counting them degraded", () => {
    const sample = summarizeRenderSample([
      { id: 1, mode: "compressed", disputeLabels: 0 },
      { id: 2, mode: "fallback", disputeLabels: 4 },
      { id: 3, mode: "missing", disputeLabels: 0 },
    ]);
    expect(sample.fallbackRatioPercent).toBe(50);
    expect(sample.missing).toBe(1);
  });
});

describe("computeRenderDelta", () => {
  test("splits fallback churn into entered and resolved", () => {
    const delta = computeRenderDelta([1, 2, 3], [2, 3, 4]);
    expect(delta).toEqual({ entered: [4], resolved: [1] });
  });

  test("first run without previous state yields empty deltas", () => {
    expect(computeRenderDelta(undefined, [7, 8])).toEqual({ entered: [], resolved: [] });
  });
});
