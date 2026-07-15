const CONTAINMENT_THRESHOLD = 0.7;
const MIN_TOKEN_LENGTH = 3;
const STEM_LENGTH = 6;

const STOP_WORDS = new Set([
  // RU
  "это",
  "как",
  "для",
  "что",
  "или",
  "при",
  "они",
  "она",
  "он",
  "мы",
  "вы",
  "их",
  "его",
  "её",
  "ее",
  "так",
  "там",
  "тут",
  "уже",
  "ещё",
  "еще",
  "все",
  "всё",
  "без",
  "над",
  "под",
  "про",
  "чем",
  "кто",
  "где",
  "когда",
  "если",
  "тоже",
  "только",
  "можно",
  "нужно",
  "есть",
  "был",
  "была",
  "были",
  "быть",
  "этот",
  "эта",
  "эти",
  "такой",
  "такая",
  "такие",
  "таких",
  "того",
  "тому",
  "том",
  "тем",
  "те",
  "той",
  "то",
  // EN
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "they",
  "them",
  "their",
  "from",
  "into",
  "about",
  "have",
  "has",
  "had",
  "are",
  "was",
  "were",
  "been",
  "being",
  "will",
  "would",
  "could",
  "should",
  "can",
  "not",
  "but",
  "you",
  "your",
  "our",
  "out",
  "any",
  "all",
  "more",
  "most",
  "than",
  "then",
  "there",
  "here",
  "when",
  "where",
  "which",
  "who",
  "what",
  "how",
  "why",
]);

function tokenize(text: string): Set<string> {
  const normalized = text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) {
    return new Set();
  }

  const tokens = new Set<string>();
  for (const raw of normalized.split(" ")) {
    if (raw.length < MIN_TOKEN_LENGTH || STOP_WORDS.has(raw)) {
      continue;
    }
    tokens.add(raw.length > STEM_LENGTH ? raw.slice(0, STEM_LENGTH) : raw);
  }
  return tokens;
}

/**
 * Token-set containment: |A∩B| / min(|A|,|B|).
 * Empty sets yield 0 (never treated as duplicates).
 */
export function containment(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  for (const token of smaller) {
    if (larger.has(token)) {
      intersection += 1;
    }
  }
  return intersection / Math.min(left.size, right.size);
}

/**
 * Drop near-duplicates of `bottomLine` and pairwise near-duplicates among
 * `texts`, keeping the earlier (higher-ranked) item when a pair collides.
 * Returns surviving indices into `texts`.
 */
export function dedupByContainment(bottomLine: string, texts: readonly string[]): number[] {
  const survivors: number[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index];
    if (text === undefined) {
      continue;
    }
    if (containment(text, bottomLine) >= CONTAINMENT_THRESHOLD) {
      continue;
    }
    let isDuplicate = false;
    for (const kept of survivors) {
      const prior = texts[kept];
      if (prior !== undefined && containment(text, prior) >= CONTAINMENT_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) {
      survivors.push(index);
    }
  }
  return survivors;
}

export const COMMENTS_DEDUP_THRESHOLD = CONTAINMENT_THRESHOLD;
