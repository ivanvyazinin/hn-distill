import type { AggregatedItem } from "@config/schemas";

export function countTags(items: AggregatedItem[]): Map<string, number> {
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

export function isPopularTag(tag: string, counts: Map<string, number>, min: number): boolean {
  return (counts.get(tag) ?? 0) >= min;
}
