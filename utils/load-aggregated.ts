import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { AggregatedItem } from "@config/schemas";

export type AggregatedData = {
  items: AggregatedItem[];
  updatedISO: string;
};

/**
 * Cache contract (build/dev safe):
 * - Cache lives for the lifetime of the process. `astro build` is a single Node
 *   process, so this memoises across all ~7300 pages (item + tag + page) within one build.
 * - Invalidation is by file mtime, NOT by content hash: if the aggregated.json is
 *   rewritten (e.g. during `astro dev` watch), the mtime changes and we reload a fresh
 *   object. The rare "content changed but mtime didn't" case (`cp -p`, sub-second
 *   rewrite on a coarse FS) is not detected — a deliberate trade-off, practically
 *   impossible for the hourly pipeline's write-then-read flow.
 * - The returned object (and its `items` array) is treated as READ-ONLY by all
 *   callers. `countTags`/`indexById` memoise by the array reference this cache
 *   hands out, so mutating/sorting it in place would corrupt every downstream cache.
 *   Consumers only use find/filter/slice/map today — never sort/mutate.
 * - Fallback branches (missing file / bad JSON / stat error) are NOT cached AND evict
 *   any prior entry for the key, so a transient failure never "sticks" and a later
 *   restore (even with an unchanged mtime) is not served from stale cache.
 */
const aggregatedCache = new Map<string, { mtimeMs: number; data: AggregatedData }>();

/**
 * Load aggregated data file with safe fallbacks.
 * - Missing file → empty items, updatedISO "—"
 * - Malformed JSON → empty items, updatedISO "—"
 * - Wrong field types → coerce to safe defaults
 */
export function loadAggregated(pathname: string): AggregatedData {
  if (!pathname) {
    return { items: [], updatedISO: "—" };
  }
  // Canonicalise the key so callers passing an absolute URL pathname (index.astro)
  // and callers passing a relative PATHS.aggregated resolve to one cache entry —
  // otherwise they'd hold two distinct items arrays and desync the WeakMap memos.
  const key = resolve(process.cwd(), pathname);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(key).mtimeMs;
  } catch {
    aggregatedCache.delete(key);
    return { items: [], updatedISO: "—" };
  }
  const cached = aggregatedCache.get(key);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.data;
  }
  try {
    const raw = readFileSync(key, "utf8");
    const parsed: unknown = JSON.parse(raw);
    function getItems(u: unknown): AggregatedItem[] {
      if (typeof u === "object" && u !== null && "items" in u) {
        const object = u as Record<string, unknown>;
        const maybeItems = object["items"];
        if (Array.isArray(maybeItems)) {
          return maybeItems as AggregatedItem[];
        }
      }
      return [];
    }

    function getUpdatedISO(u: unknown): string {
      if (typeof u === "object" && u !== null && "updatedISO" in u) {
        const object = u as Record<string, unknown>;
        return typeof object["updatedISO"] === "string" ? object["updatedISO"] : "—";
      }
      return "—";
    }

    const items = getItems(parsed);
    const updatedISO = getUpdatedISO(parsed);
    const data: AggregatedData = { items, updatedISO };
    aggregatedCache.set(key, { mtimeMs, data });
    return data;
  } catch {
    aggregatedCache.delete(key);
    return { items: [], updatedISO: "—" };
  }
}

// Memoise by the items array reference. loadAggregated hands the same array to every
// page in a build, so indexById is computed once per build. Auto-invalidates: a fresh
// load (new mtime) produces a new array, which is a WeakMap miss.
const indexByIdCache = new WeakMap<AggregatedItem[], Map<number, AggregatedItem>>();

export function indexById(items: AggregatedItem[]): Map<number, AggregatedItem> {
  const memo = indexByIdCache.get(items);
  if (memo) {
    return memo;
  }
  const map = new Map<number, AggregatedItem>();
  for (const item of items) {
    // first-wins to preserve `.find` semantics on a hypothetical duplicate id
    // (aggregate.ts already dedupes by id, so this is a safety net).
    if (!map.has(item.id)) {
      map.set(item.id, item);
    }
  }
  indexByIdCache.set(items, map);
  return map;
}

export function pickByIds(map: Map<number, AggregatedItem>, ids: number[]): AggregatedItem[] {
  const result: AggregatedItem[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    const item = map.get(id);
    if (item) {
      result.push(item);
      seen.add(id);
    }
  }
  return result;
}
