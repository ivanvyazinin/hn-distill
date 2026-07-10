/** D1 allows ~100 bound parameters per statement; stay under that for IN (...) lists. */
export const SQL_IN_CHUNK_SIZE = 90;

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function inPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}