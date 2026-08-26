/**
 * Pure fact-shaping for the daily prod health check (docs/runbook-prod-health-check.md).
 * The collector script (scripts/prod-health-collect.mts) does all I/O and feeds raw
 * lines / HTML here; judgment stays with the morning agent, this module only counts.
 */

export type CardMode = "compressed" | "fallback" | "missing";

export type SampledCard = {
  id: number;
  mode: CardMode;
  /** «Спор:»-style labels inside the rendered card; label spam is a stage-1 smell. */
  disputeLabels: number;
};

/** Item ids referenced by list pages (/hn-distill/item/<id>/ links). */
export function extractItemIds(pageHtml: string, limit: number): number[] {
  const ids = new Set<number>();
  const re = /\/item\/(?<id>\d+)\//gu;
  for (const match of pageHtml.matchAll(re)) {
    ids.add(Number(match.groups?.["id"]));
    if (ids.size >= limit) {
      break;
    }
  }
  return [...ids];
}

/**
 * Classify the comments card of an item page: a single <p> is the compressed
 * paragraph (healthy); several paragraphs mean the structured bullet fallback
 * rendered because compress is absent/rejected.
 */
export function classifyCommentsCard(itemHtml: string): Omit<SampledCard, "id"> {
  const title = /Комментарии \((?<count>\d+)\)/u.exec(itemHtml);
  if (title === null) {
    return { mode: "missing", disputeLabels: 0 };
  }
  const tail = itemHtml.slice(title.index);
  const asideEnd = tail.indexOf("</aside>");
  const segment = asideEnd === -1 ? tail : tail.slice(0, asideEnd);
  const body = /<div class="md">(?<body>.*?)<\/div>/su.exec(segment)?.groups?.["body"];
  if (body === undefined) {
    return { mode: "missing", disputeLabels: 0 };
  }
  const paragraphs = (body.match(/<p>/gu)?.length ?? 0) + (body.match(/<p /gu)?.length ?? 0);
  // Linear tag strip: `replace(/<[^>]+>/)` trips regexp/no-super-linear-move.
  let plain = "";
  for (const part of body.split("<")) {
    const close = part.indexOf(">");
    plain += close === -1 ? part : part.slice(close + 1);
  }
  const disputeLabels = plain.match(/Спор[аы]?:/gu)?.length ?? 0;
  return { mode: paragraphs <= 1 ? "compressed" : "fallback", disputeLabels };
}

export type WarningTally = {
  counts: Record<string, number>;
  /** story ids per semantic-reject reason; repeats across runs are the smell. */
  rejectIdsByReason: Record<string, number[]>;
};

const WARNING_PATTERNS: Array<[category: string, re: RegExp]> = [
  ["compress.semanticReject", /Comments compress semantic reject/u],
  ["compress.transportError", /Comments compress transport error/u],
  ["compress.permanentHttpError", /Comments compress permanent HTTP error/u],
  ["stage1.attemptFailed", /Comments-v2 structured attempt failed/u],
  ["stage1.heuristicsFailed", /Comments-v2 insights failed heuristics/u],
  ["quote.provenanceDropped", /quote failed provenance/u],
  ["regen.skippedCountGate", /regen skipped: descendants delta within threshold/u],
];

export function tallyWarnings(lines: readonly string[]): WarningTally {
  const counts: Record<string, number> = {};
  const rejectIdsByReason: Record<string, number[]> = {};
  let minimaxTimeouts = 0;
  for (const line of lines) {
    if (line.includes("TimeoutError") && line.includes("api.minimax.io")) {
      minimaxTimeouts += 1;
    }
    for (const [category, re] of WARNING_PATTERNS) {
      if (!re.test(line)) {
        continue;
      }
      counts[category] = (counts[category] ?? 0) + 1;
      if (category !== "compress.semanticReject") {
        continue;
      }
      const id = /id: (?<id>\d+)/u.exec(line)?.groups?.["id"];
      const reason = /reason: '?(?<reason>[0-9:<>_a-z]+)'?[\s,}]/u.exec(line)?.groups?.["reason"];
      if (id !== undefined && reason !== undefined) {
        (rejectIdsByReason[reason] ??= []).push(Number(id));
      }
    }
  }
  if (minimaxTimeouts > 0) {
    counts["minimax.hopTimeout"] = minimaxTimeouts;
  }
  return { counts, rejectIdsByReason };
}

/** Story ids whose same reject reason shows up in ≥2 distinct collection units (runs). */
export function repeatOffenders(
  rejectsByRun: ReadonlyArray<WarningTally["rejectIdsByReason"]>
): Array<{ reason: string; id: number; runs: number }> {
  const seen = new Map<string, Map<number, number>>();
  for (const byReason of rejectsByRun) {
    for (const [reason, ids] of Object.entries(byReason)) {
      for (const id of new Set(ids)) {
        const perReason = seen.get(reason) ?? new Map<number, number>();
        perReason.set(id, (perReason.get(id) ?? 0) + 1);
        seen.set(reason, perReason);
      }
    }
  }
  const offenders: Array<{ reason: string; id: number; runs: number }> = [];
  for (const [reason, perId] of seen) {
    for (const [id, runs] of perId) {
      if (runs >= 2) {
        offenders.push({ reason, id, runs });
      }
    }
  }
  return offenders.sort((a, b) => b.runs - a.runs);
}

export type RenderSample = {
  sampled: number;
  compressed: number;
  fallback: number;
  missing: number;
  cards: SampledCard[];
  fallbackRatioPercent: number;
};

export function summarizeRenderSample(cards: readonly SampledCard[]): RenderSample {
  const compressed = cards.filter((card) => card.mode === "compressed").length;
  const fallback = cards.filter((card) => card.mode === "fallback").length;
  const missing = cards.filter((card) => card.mode === "missing").length;
  const classified = compressed + fallback;
  return {
    sampled: cards.length,
    compressed,
    fallback,
    missing,
    cards: [...cards],
    fallbackRatioPercent: classified === 0 ? 100 : Math.round((fallback / classified) * 100),
  };
}
