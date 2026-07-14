export type LatinRunHit = {
  words: string[];
  context: string;
};

export type LatinSingletonHit = {
  word: string;
  context: string;
};

export type LanguageGateOptions = {
  /** Minimum share of Cyrillic among prose letters (after stripping code/URLs/short quoted terms). */
  minCyrillicRatio?: number;
  /** Minimum length of a run of consecutive lowercase-Latin words to count as a run. */
  latinRunMinWords?: number;
  /** Also report weak (noun-phrase) runs of 2-3 Latin words without English function words. */
  flagSoftRuns?: boolean;
  /** Flag single lowercase-Latin defect words (dictionary-based, precision-first). */
  flagSingletons?: boolean;
  /** Extra lowercase names allowed in addition to the built-in allowlist. */
  extraAllowlist?: readonly string[];
};

export type LanguageGateReport = {
  cyrillicRatio: number;
  letterCount: number;
  lowCyrillicRatio: boolean;
  /** High-confidence English prose runs (contain function words or are >=4 words long). */
  latinRuns: LatinRunHit[];
  /** Weak noun-phrase runs (2-3 Latin words, no function words) — low precision, off by default. */
  softLatinRuns: LatinRunHit[];
  /** Single English defect words embedded in Russian prose (dictionary-matched). */
  latinSingletons: LatinSingletonHit[];
};

export const DEFAULT_MIN_CYRILLIC_RATIO = 0.8;
export const DEFAULT_LATIN_RUN_MIN_WORDS = 2;

/**
 * Lowercase product/tool/format names that legitimately appear in Russian tech prose.
 * Only matters for words written literally in lowercase (Capitalized/ALL-CAPS never flagged).
 */
const LOWERCASE_TECH_ALLOWLIST = new Set([
  "systemd",
  "npm",
  "pnpm",
  "yarn",
  "curl",
  "wget",
  "ffmpeg",
  "nginx",
  "webpack",
  "podman",
  "git",
  "github",
  "sudo",
  "bash",
  "zsh",
  "ssh",
  "node",
  "deno",
  "bun",
  "pip",
  "apt",
  "brew",
  "docker",
  "kubectl",
  "kubernetes",
  "grep",
  "vim",
  "neovim",
  "emacs",
  "tmux",
  "rsync",
  "jq",
  "sqlite",
  "postgres",
  "postgresql",
  "mysql",
  "redis",
  "linux",
  "unix",
  "macos",
  "ios",
  "android",
  "javascript",
  "typescript",
  "python",
  "rust",
  "golang",
  "kotlin",
  "swift",
  "wasm",
  "json",
  "yaml",
  "toml",
  "html",
  "css",
  "os",
  // Latin-language set phrases (de facto, in vitro, ...) — never English leakage.
  "de",
  "facto",
  "jure",
  "novo",
  "vitro",
  "vivo",
  "situ",
  "hoc",
  "ad",
  "priori",
  "posteriori",
  "versus",
  "vs",
]);

/**
 * English function words. A run containing at least one of these is connected English
 * prose (high confidence). As singletons (>=3 letters) they signal broken grammar
 * («для от rejection», «донаты и thus»).
 */
const EN_FUNCTION_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "nor",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "into",
  "onto",
  "over",
  "under",
  "about",
  "after",
  "before",
  "between",
  "through",
  "during",
  "without",
  "within",
  "against",
  "among",
  "around",
  "per",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "has",
  "have",
  "had",
  "does",
  "do",
  "did",
  "will",
  "would",
  "can",
  "could",
  "should",
  "must",
  "may",
  "might",
  "shall",
  "not",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "they",
  "them",
  "their",
  "his",
  "her",
  "our",
  "your",
  "you",
  "who",
  "whom",
  "whose",
  "which",
  "what",
  "when",
  "where",
  "why",
  "how",
  "than",
  "then",
  "thus",
  "hence",
  "however",
  "moreover",
  "therefore",
  "although",
  "though",
  "while",
  "whereas",
  "because",
  "since",
  "until",
  "unless",
  "if",
  "else",
  "whether",
  "both",
  "either",
  "neither",
  "each",
  "every",
  "all",
  "some",
  "any",
  "few",
  "many",
  "much",
  "more",
  "most",
  "other",
  "another",
  "such",
  "same",
  "only",
  "also",
  "too",
  "very",
  "just",
  "even",
  "still",
  "already",
  "yet",
  "again",
  "alike",
]);

/** Common English verbs (3rd person / base) that read as leakage inside Russian prose. */
const EN_COMMON_VERBS = new Set([
  "admits",
  "imposes",
  "allows",
  "enables",
  "provides",
  "requires",
  "offers",
  "gives",
  "takes",
  "makes",
  "gets",
  "uses",
  "needs",
  "wants",
  "helps",
  "seems",
  "looks",
  "feels",
  "creates",
  "claims",
  "argues",
  "notes",
  "says",
  "shows",
  "means",
  "lets",
  "supports",
  "includes",
  "contains",
  "describes",
  "explains",
  "suggests",
  "proposes",
  "reveals",
  "remains",
  "becomes",
  "keeps",
  "holds",
  "brings",
  "leads",
  "causes",
  "prevents",
  "reduces",
  "increases",
  "improves",
]);

/** Curated common-prose words seen leaking into Russian summaries (not tech jargon). */
const EN_EXTRA_DEFECT_WORDS = new Set(["precedents", "dissent", "impasse", "sovereign", "fight", "sharp"]);

/** RU-tech loanwords / lowercase nouns that match defect morphology but are idiomatic. */
const MORPHOLOGY_BLOCKLIST = new Set([
  "production",
  "performance",
  "inference",
  "assembly",
  "family",
  "supply",
  "apply",
  "reply",
  "early",
  "daily",
  "weekly",
  "monthly",
  "hourly",
  "anomaly",
  "monopoly",
]);

const ABSTRACT_NOUN_RE = /^[a-z]+(?:ance|ence|ment|ness|sion|tion)s?$/u;
const LY_ADVERB_RE = /^[a-z]{3,}ly$/u;

const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/gu;
const INLINE_CODE_RE = /`[^\n`]*`/gu;
const MARKDOWN_LINK_RE = /\[(?<label>[^[\]]*)\]\([^()]*\)/gu;
const MARKDOWN_HEADING_RE = /^#{1,6}\s+(?<inner>[^\n]{1,80})$/gmu;
const URL_RE = /(?:https?:\/\/|www\.)\S+/giu;
// Short quoted terms are usually UI strings or titles. Longer quotes are still prose and
// must remain visible to the gate: otherwise a model can hide a whole English sentence in
// quotation marks.
const GUILLEMET_QUOTE_RE = /«(?<inner>[^«»]{1,300})»/gu;
const CURLY_QUOTE_RE = /“(?<inner>[^“”]{1,300})”/gu;
const ASCII_QUOTE_RE = /"(?<inner>[^\n"]{1,300})"/gu;
// Parenthesized fragments without Cyrillic: glosses like «осевого (axial flux) двигателя».
const PAREN_RE = /\((?<inner>[^()]{1,60})\)/gu;

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const LETTER_RE = /\p{L}/u;
const UPPER_LATIN_RE = /[A-Z]/u;
const DIGIT_RE = /\d/u;
const LATIN_WORD_CHARS_RE = /^['\-A-Za-z’]+$/u;
const LATIN_EDGE_RE = /^[A-Za-z].*[A-Za-z]$|^[A-Za-z]$/u;
const DOUBLE_SEPARATOR_RE = /['\-’]{2}/u;

/** Word made only of Latin letters (optionally hyphenated/apostrophized). */
function isPureLatinWord(word: string): boolean {
  return LATIN_WORD_CHARS_RE.test(word) && LATIN_EDGE_RE.test(word) && !DOUBLE_SEPARATOR_RE.test(word);
}

function stripShortQuotedTerm(_match: string, ...args: unknown[]): string {
  const groups = args.at(-1) as { inner?: string } | undefined;
  const inner = groups?.inner ?? "";
  const wordCount = inner.trim().split(/\s+/u).filter(Boolean).length;
  return wordCount <= 3 ? " " : ` ${inner} `;
}

export function stripNonProse(text: string): string {
  return text
    .replaceAll(FENCED_CODE_RE, " ")
    .replaceAll(INLINE_CODE_RE, " ")
    .replaceAll(MARKDOWN_LINK_RE, "$<label>")
    .replaceAll(MARKDOWN_HEADING_RE, (match, ...args: unknown[]) => {
      const groups = args.at(-1) as { inner?: string } | undefined;
      return CYRILLIC_RE.test(groups?.inner ?? "") ? match : " ";
    })
    .replaceAll(URL_RE, " ")
    .replaceAll(GUILLEMET_QUOTE_RE, stripShortQuotedTerm)
    .replaceAll(CURLY_QUOTE_RE, stripShortQuotedTerm)
    .replaceAll(ASCII_QUOTE_RE, stripShortQuotedTerm)
    .replaceAll(PAREN_RE, (match, inner: string) => (CYRILLIC_RE.test(inner) ? match : " "));
}

function countChars(word: string, re: RegExp): number {
  let count = 0;
  for (const char of word) {
    if (re.test(char)) {
      count += 1;
    }
  }
  return count;
}

type Token = {
  /** Raw whitespace-separated chunk (with punctuation). */
  raw: string;
  /** Chunk with leading/trailing punctuation stripped. */
  word: string;
  /** Trailing punctuation breaks a prose run (comma, colon, dash, quotes, ...). */
  breaksRunAfter: boolean;
};

const RUN_BREAK_PUNCT_RE = /["&(),/:;[\]{|}«»–—“”…]|[!.?]\s*$/u;

const ALNUM_RE = /[\p{L}\p{N}]/u;

function trimNonAlnum(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && !ALNUM_RE.test(raw.charAt(start))) {
    start += 1;
  }
  while (end > start && !ALNUM_RE.test(raw.charAt(end - 1))) {
    end -= 1;
  }
  return raw.slice(start, end);
}

function tokenize(text: string): Token[] {
  return text
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .map((raw) => {
      const word = trimNonAlnum(raw);
      const trailing = word.length > 0 ? raw.slice(raw.indexOf(word) + word.length) : raw;
      return {
        raw,
        word,
        breaksRunAfter: RUN_BREAK_PUNCT_RE.test(trailing) || word.length === 0,
      };
    });
}

function letterLength(word: string): number {
  return countChars(word, LETTER_RE);
}

function isLowercaseLatinWord(word: string): boolean {
  return word.length > 0 && isPureLatinWord(word) && !UPPER_LATIN_RE.test(word);
}

function isSingletonDefectWord(word: string): boolean {
  if (EN_FUNCTION_WORDS.has(word) || EN_COMMON_VERBS.has(word) || EN_EXTRA_DEFECT_WORDS.has(word)) {
    return true;
  }
  if (MORPHOLOGY_BLOCKLIST.has(word)) {
    return false;
  }
  return ABSTRACT_NOUN_RE.test(word) || LY_ADVERB_RE.test(word);
}

function contextAround(tokens: Token[], start: number, end: number): string {
  const from = Math.max(0, start - 4);
  const to = Math.min(tokens.length, end + 4);
  return tokens
    .slice(from, to)
    .map((token) => token.raw)
    .join(" ");
}

/**
 * Language-purity detector for Russian summaries. Signals:
 * - lowCyrillicRatio: large English fragments (whole sentences/paragraphs);
 * - latinRuns: connected English prose embedded in Russian text (high confidence);
 * - softLatinRuns: short Latin noun phrases (low precision, opt-in);
 * - latinSingletons: single English words in Russian grammar («создают precedents»).
 * Code, URLs, short quoted terms, and Latin-only parenthesized glosses are stripped first.
 * Long quoted prose remains visible. Capitalized/CamelCase tokens are excluded from the
 * normal ratio, while an all-Latin fallback still catches fully English ALL-CAPS output.
 */
export function analyzeRussianLanguagePurity(text: string, options: LanguageGateOptions = {}): LanguageGateReport {
  const minCyrillicRatio = options.minCyrillicRatio ?? DEFAULT_MIN_CYRILLIC_RATIO;
  const latinRunMinWords = options.latinRunMinWords ?? DEFAULT_LATIN_RUN_MIN_WORDS;
  const flagSoftRuns = options.flagSoftRuns ?? false;
  const flagSingletons = options.flagSingletons ?? true;
  const allowlist =
    options.extraAllowlist && options.extraAllowlist.length > 0
      ? new Set([...LOWERCASE_TECH_ALLOWLIST, ...options.extraAllowlist.map((w) => w.toLowerCase())])
      : LOWERCASE_TECH_ALLOWLIST;

  const prose = stripNonProse(text);
  const tokens = tokenize(prose);

  // Prose-eligible ratio: Cyrillic letters vs lowercase-Latin word letters. Capitalized /
  // ALL-CAPS / digit-bearing tokens (product names, versions, acronyms) and allowlisted
  // tools are names, not prose, and must not drag a legit Russian text below the threshold.
  let cyrillicLetters = 0;
  let lowercaseLatinLetters = 0;
  let allLatinLetters = 0;
  let pureLatinWordCount = 0;
  for (const token of tokens) {
    cyrillicLetters += countChars(token.word, CYRILLIC_RE);
    if (isPureLatinWord(token.word) && !allowlist.has(token.word.toLowerCase())) {
      allLatinLetters += letterLength(token.word);
      pureLatinWordCount += 1;
    }
    if (isLowercaseLatinWord(token.word) && !allowlist.has(token.word)) {
      lowercaseLatinLetters += letterLength(token.word);
    }
  }
  const letters = cyrillicLetters + lowercaseLatinLetters;
  const cyrillicRatio = letters > 0 ? cyrillicLetters / letters : 1;
  const latinRuns: LatinRunHit[] = [];
  const softLatinRuns: LatinRunHit[] = [];
  const latinSingletons: LatinSingletonHit[] = [];

  const neighborBlocksSingleton = (index: number): boolean => {
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if ([previous, next].some((neighbor) => neighbor !== undefined && DIGIT_RE.test(neighbor.word))) {
      return true;
    }
    // Proper-name glue is safe only when the lowercase token is inside the name:
    // «Institute for Highway Safety». A single Capitalized neighbor must not hide
    // broken prose such as «Компания OpenAI admits ошибку».
    return (
      previous !== undefined &&
      next !== undefined &&
      UPPER_LATIN_RE.test(previous.word) &&
      UPPER_LATIN_RE.test(next.word)
    );
  };

  let runStart = -1;
  let runWords: string[] = [];
  const flushRun = (endIndex: number): void => {
    if (runStart < 0) {
      return;
    }
    const words = runWords;
    const start = runStart;
    runStart = -1;
    runWords = [];

    if (words.length >= latinRunMinWords) {
      if (words.every((word) => allowlist.has(word))) {
        return;
      }
      // Command idiom: «команды brew bundle», «в podman machine».
      const firstWord = words[0];
      if (words.length === 2 && firstWord !== undefined && allowlist.has(firstWord)) {
        return;
      }
      // Function words inside an English proper-noun phrase: «Car of the Year»,
      // «Future of the Web» — glue words next to Capitalized neighbors, not prose.
      const allFunctionWords = words.every((word) => EN_FUNCTION_WORDS.has(word));
      const neighborIsCapitalized = [tokens[start - 1], tokens[endIndex]].some(
        (neighbor) => neighbor !== undefined && UPPER_LATIN_RE.test(neighbor.word)
      );
      if (allFunctionWords && neighborIsCapitalized) {
        return;
      }
      const hasFunctionWord = words.some((word) => EN_FUNCTION_WORDS.has(word));
      const hit: LatinRunHit = { words, context: contextAround(tokens, start, endIndex) };
      if (hasFunctionWord || words.length >= 4) {
        latinRuns.push(hit);
      } else if (flagSoftRuns) {
        softLatinRuns.push(hit);
      }
      return;
    }

    if (flagSingletons && words.length === 1) {
      const word = words[0];
      if (
        word !== undefined &&
        letterLength(word) >= 3 &&
        !allowlist.has(word) &&
        isSingletonDefectWord(word) &&
        !neighborBlocksSingleton(start)
      ) {
        latinSingletons.push({ word, context: contextAround(tokens, start, endIndex) });
      }
    }
  };

  for (const [index, token] of tokens.entries()) {
    if (isLowercaseLatinWord(token.word) && letterLength(token.word) >= 2) {
      if (runStart < 0) {
        runStart = index;
      }
      runWords.push(token.word.toLowerCase());
      if (token.breaksRunAfter) {
        flushRun(index + 1);
      }
    } else {
      flushRun(index);
    }
  }
  flushRun(tokens.length);

  return {
    cyrillicRatio,
    letterCount: letters,
    lowCyrillicRatio:
      (letters > 0 && cyrillicRatio < minCyrillicRatio) ||
      // The normal ratio intentionally ignores names/acronyms. If there is no Cyrillic
      // at all, four or more Latin words are prose regardless of case (including ALL-CAPS).
      (cyrillicLetters === 0 && pureLatinWordCount >= 4 && allLatinLetters >= 16),
    latinRuns,
    softLatinRuns,
    latinSingletons,
  };
}
