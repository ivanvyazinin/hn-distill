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

// Proxy for markdown-link count: each `[text](url)` contains exactly one "](".
// Avoids a backtracking-prone regex over untrusted page content.
function countMarkdownLinks(md: string): number {
  return md.split("](").length - 1;
}

function countWords(trimmed: string): number {
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(/\s+/u).filter(Boolean).length;
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
    const words = countWords(trimmed);
    wordCount += words;
    if (words >= PROSE_MIN_WORDS && !isStructuralNonProse(trimmed)) {
      proseChars += trimmed.length;
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
    metrics.dupRatio > thresholds.maxDupRatio;
  return { verdict: isGarbage ? "no-article" : "article", metrics };
}
