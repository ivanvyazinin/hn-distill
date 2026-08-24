import { describe, expect, test } from "bun:test";

import { PATHS } from "@config/paths";
import { log } from "@utils/log";
import { sanitizePostSummaryForPublish } from "@utils/meta-aggregated-batch";
import { recordDrop, reportDrops, resetDrops } from "@utils/summary-drops";
import { withEnvPatch } from "./helpers";

import type { ObjectStore } from "@utils/object-store";

/** Minimal in-memory store: reportDrops only needs getJson/putJson. */
function makeStore(): ObjectStore {
  const data = new Map<string, unknown>();
  return {
    getText: async () => null,
    putText: async () => undefined,
    getJson: async <T>(key: string) => (data.has(key) ? (data.get(key) as T) : null),
    putJson: async (key: string, value: unknown) => {
      data.set(key, value);
    },
    list: async () => [],
  };
}

async function captureWarns(run: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const warned: Array<Record<string, unknown>> = [];
  const original = log.warn;
  log.warn = ((_ns: string, message: string, meta?: Record<string, unknown>) => {
    if (message === "New summary drop" && meta) {
      warned.push(meta);
    }
  }) as typeof log.warn;
  try {
    await run();
  } finally {
    log.warn = original;
  }
  return warned;
}

describe("summary drop reporting", () => {
  // Production aggregates from the meta DB (AGGREGATE_FROM_DB=true), so this path
  // -- not readAggregates -- is the one that used to emit 518 WARNs per run.
  test("the DB sanitizer records drops instead of warning per item", async () => {
    resetDrops();
    const store = makeStore();

    // Pin the heuristics inputs: other suites patch env, and a stray
    // POST_SUMMARY_MIN_CHARS would decide whether this text drops at all.
    const warns = await captureWarns(async () => {
      await withEnvPatch({ POST_SUMMARY_MIN_CHARS: 200, SUMMARY_LANG: "ru" }, async () => {
        expect(sanitizePostSummaryForPublish("Коротко.", { id: 501 })).toBeUndefined();
      });
      await reportDrops(store);
    });

    // First pass is the baseline: silent, and it remembers id 501.
    expect(warns).toEqual([]);
    // Key comes from PATHS: sibling suites mock the paths module to a temp dir.
    const stateKey = `${PATHS.dataDir}/aggregate-drops.json`;
    expect(await store.getJson<{ ids: number[] }>(stateKey)).toEqual({ ids: [501] });
  });

  test("a repeat drop stays quiet, a fresh one warns once", async () => {
    const store = makeStore();
    await store.putJson(`${PATHS.dataDir}/aggregate-drops.json`, { ids: [501] });

    resetDrops();
    let warns = await captureWarns(async () => {
      recordDrop({ id: 501, stage: "heuristics", reasons: ["too_short"] });
      await reportDrops(store);
    });
    expect(warns).toEqual([]);

    resetDrops();
    warns = await captureWarns(async () => {
      recordDrop({ id: 501, stage: "heuristics", reasons: ["too_short"] });
      recordDrop({ id: 777, stage: "guard", reasons: ["not_article"] });
      await reportDrops(store);
    });
    expect(warns.length).toBe(1);
    expect(warns[0]?.["id"]).toBe(777);
  });
});
