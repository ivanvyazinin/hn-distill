/**
 * Cheap, LLM-free detector for "is this extracted Markdown a real article, or
 * navigation / cookie-banner / footer / link-farm boilerplate?".
 *
 * Runs ONLY on the HTML branch of content extraction (PDFs, YouTube transcripts,
 * READMEs/release-notes/plaintext are list-heavy but legitimate, so they bypass
 * this entirely — see pipeline/summarize.ts). Pure string ops; no DOM, no network.
 */

export type ExtractVerdict = "article" | "no-article";

export type ExtractMetrics = {
  /** total characters across "prose" lines (>=12 words; excludes headings/quotes/tables) */
  proseChars: number;
  /** markdown-link count / word count across non-empty lines */
  linkDensity: number;
  /** 1 - unique(non-empty trimmed lines) / count(non-empty trimmed lines) */
  dupRatio: number;
  /**
   * 1 - unique / count over sentence-like phrases (>= PHRASE_MIN_WORDS words).
   * Catches JS-rendered SPA shells whose extract is one long line repeating a
   * tagline, which line-based dupRatio misses (it is a single line, so unique=1).
   */
  phraseDupRatio: number;
  wordCount: number;
  nonEmptyLines: number;
};

export type ExtractThresholds = {
  minProseChars: number;
  maxLinkDensity: number;
  maxDupRatio: number;
};

export const DEFAULT_EXTRACT_THRESHOLDS: ExtractThresholds = {
  minProseChars: 500,
  maxLinkDensity: 0.5,
  maxDupRatio: 0.5,
};

const PROSE_MIN_WORDS = 12;
// Sentences shorter than this are ignored for phrase-dup so incidental short
// repeats ("Read more.", "We're always listening.") do not skew the ratio.
const PHRASE_MIN_WORDS = 5;

// Split into sentence-like phrases across the whole extract (ignoring heading
// lines) so intra-line repetition is visible; line-based dupRatio cannot see it.
function computePhraseDupRatio(md: string): number {
  const phrases = (md.replace(/^#.*$/gmu, " ").match(/[^.!?…\n]+[.!?…]+/gu) ?? [])
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.split(/\s+/u).filter(Boolean).length >= PHRASE_MIN_WORDS);
  if (phrases.length === 0) {
    return 0;
  }
  return 1 - new Set(phrases).size / phrases.length;
}

const NO_SPACE_CHARS_PER_WORD = 2;
// A no-space-script char carries far more information per character than a Latin
// one, so weight it up when measuring prose volume; otherwise the char-based floor
// (EXTRACT_MIN_PROSE_CHARS) is Latin-biased and rejects real CJK/Thai articles.
const NO_SPACE_PROSE_WEIGHT = 3;

// Proxy for markdown-link count: each `[text](url)` contains exactly one "](".
// Avoids a backtracking-prone regex over untrusted page content.
function countMarkdownLinks(md: string): number {
  return md.split("](").length - 1;
}

// Scripts written without spaces between words (Thai, CJK kana/ideographs, Hangul).
// One whitespace-split "word" would wrongly mark a full article as thin prose.
function isNoSpaceScript(cp: number): boolean {
  return (
    (cp >= 0x0E_00 && cp <= 0x0E_7F) || // Thai
    (cp >= 0x30_40 && cp <= 0x30_FF) || // Hiragana + Katakana
    (cp >= 0x34_00 && cp <= 0x4D_BF) || // CJK Ext. A
    (cp >= 0x4E_00 && cp <= 0x9F_FF) || // CJK Unified Ideographs
    (cp >= 0xAC_00 && cp <= 0xD7_AF) || // Hangul syllables
    (cp >= 0xF9_00 && cp <= 0xFA_FF) // CJK Compatibility Ideographs
  );
}

function countNoSpaceChars(trimmed: string): number {
  let count = 0;
  for (const ch of trimmed) {
    if (isNoSpaceScript(ch.codePointAt(0) ?? 0)) {
      count += 1;
    }
  }
  return count;
}

function countWords(trimmed: string, noSpaceChars: number): number {
  const spaceWords = trimmed.split(/\s+/u).filter(Boolean).length;
  if (noSpaceChars === 0) {
    return spaceWords;
  }
  return spaceWords + Math.ceil(noSpaceChars / NO_SPACE_CHARS_PER_WORD);
}

function isStructuralNonProse(trimmed: string): boolean {
  // Headings, blockquotes and table rows are never prose. List items are NOT
  // excluded here: a long (>=12-word) bullet is substantive content (release
  // notes, READMEs). Short nav/menu bullets fall out via the word-count gate,
  // and link farms are caught separately by linkDensity.
  return /^[#>|]/u.test(trimmed);
}

export function computeExtractMetrics(md: string): ExtractMetrics {
  const lines = md.split("\n");
  const nonEmpty: string[] = [];
  let wordCount = 0;
  let proseChars = 0;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    nonEmpty.push(trimmed);
    const noSpaceChars = countNoSpaceChars(trimmed);
    const words = countWords(trimmed, noSpaceChars);
    wordCount += words;
    if (words >= PROSE_MIN_WORDS && !isStructuralNonProse(trimmed)) {
      proseChars += trimmed.length + noSpaceChars * (NO_SPACE_PROSE_WEIGHT - 1);
    }
  }

  const linkCount = countMarkdownLinks(md);
  let linkDensity = 0;
  if (wordCount > 0) {
    linkDensity = linkCount / wordCount;
  } else if (linkCount > 0) {
    linkDensity = 1;
  }
  const uniqueLines = new Set(nonEmpty).size;
  const dupRatio = nonEmpty.length > 0 ? 1 - uniqueLines / nonEmpty.length : 0;

  return {
    proseChars,
    linkDensity,
    dupRatio,
    phraseDupRatio: computePhraseDupRatio(md),
    wordCount,
    nonEmptyLines: nonEmpty.length,
  };
}

export function assessExtractQuality(
  md: string,
  thresholds: ExtractThresholds = DEFAULT_EXTRACT_THRESHOLDS
): { verdict: ExtractVerdict; metrics: ExtractMetrics } {
  const metrics = computeExtractMetrics(md);
  const isGarbage =
    metrics.proseChars < thresholds.minProseChars ||
    metrics.linkDensity > thresholds.maxLinkDensity ||
    metrics.dupRatio > thresholds.maxDupRatio ||
    metrics.phraseDupRatio > thresholds.maxDupRatio;
  return { verdict: isGarbage ? "no-article" : "article", metrics };
}
