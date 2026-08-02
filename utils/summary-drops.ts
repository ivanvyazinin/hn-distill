import { PATHS } from "@config/paths";
import { log } from "@utils/log";

import type { ObjectStore } from "@utils/object-store";

/**
 * Per-run collector for post summaries the aggregate stage refuses to publish.
 *
 * The set is near-static: the same 518 ids were dropped on all 24 runs of
 * 2026-07-29..08-01 (zero difference between the first and the last), which
 * buried every real WARN under 12k lines over three days. Detail goes to debug;
 * a run warns only about ids that were not dropped last time, plus one summary
 * line, so "three new drops" is visible instead of hiding inside five hundred.
 *
 * Both aggregation paths feed this: the object-store one (readAggregates) and
 * the DB one (sanitizePostSummaryDb), which is what production actually runs
 * with AGGREGATE_FROM_DB=true.
 */
export type DropRecord = { id: number; stage: "guard" | "heuristics"; reasons: string[] };

/** Derived from PATHS so the tests' temp-dir mock redirects it too. */
const dropStatePath = (): string => `${PATHS.dataDir}/aggregate-drops.json`;

let dropsThisRun: DropRecord[] = [];

export function resetDrops(): void {
  dropsThisRun = [];
}

export function recordDrop(record: DropRecord): void {
  dropsThisRun.push(record);
}

export async function reportDrops(store: ObjectStore): Promise<void> {
  const drops = [...dropsThisRun].sort((a, b) => a.id - b.id);
  const statePath = dropStatePath();
  const previous = await store.getJson<{ ids?: number[] }>(statePath);
  const known = new Set(previous?.ids ?? []);
  const byReason: Record<string, number> = {};
  for (const drop of drops) {
    for (const reason of drop.reasons) {
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    }
  }

  if (previous === null) {
    // First run after this landed: everything looks new, so skip the per-id noise.
    log.info("aggregate", "Summary drop baseline recorded", { total: drops.length, byReason });
  } else {
    const fresh = drops.filter((drop) => !known.has(drop.id));
    for (const drop of fresh) {
      log.warn("aggregate", "New summary drop", { id: drop.id, stage: drop.stage, reasons: drop.reasons });
    }
    const resolved = [...known].filter((id) => !drops.some((drop) => drop.id === id));
    log.info("aggregate", "Summary drops", {
      total: drops.length,
      new: fresh.length,
      resolved: resolved.length,
      byReason,
    });
  }

  await store.putJson(statePath, { ids: drops.map((drop) => drop.id) });
}
