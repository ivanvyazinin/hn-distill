import type { AggregatedItem } from "@config/schemas";

// Memoise by the items array reference. loadAggregated hands the same array to every
// page in a build, so tag counts are computed once per build. Auto-invalidates: a fresh
// load (new mtime) produces a new array, which is a WeakMap miss. The returned Map is
// treated as READ-ONLY by callers.
const countTagsCache = new WeakMap<AggregatedItem[], Map<string, number>>();

function computeTagCounts(items: AggregatedItem[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    if (!Array.isArray(it.tags)) {
      continue;
    }
    for (const tag of it.tags) {
      m.set(tag, (m.get(tag) ?? 0) + 1);
    }
  }
  return m;
}

export function countTags(items: AggregatedItem[]): Map<string, number> {
  const memo = countTagsCache.get(items);
  if (memo) {
    return memo;
  }
  const counts = computeTagCounts(items);
  countTagsCache.set(items, counts);
  return counts;
}

export function isPopularTag(tag: string, counts: Map<string, number>, min: number): boolean {
  return (counts.get(tag) ?? 0) >= min;
}
