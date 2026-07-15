import { analyzeRussianLanguagePurity, DEFAULT_MIN_CYRILLIC_RATIO } from "@utils/language-gate";

import type { CommentsInsights } from "@config/schemas";

export type HeuristicTrigger = {
  reason: string;
  detail?: string;
};

export type HeuristicVerdict = {
  ok: boolean;
  triggers: HeuristicTrigger[];
};

export type CommentsInsightsHeuristicOptions = {
  language: "en" | "ru";
  minCyrillicRatio?: number;
};

export type LanguageGateSettings = {
  enable?: boolean;
  minCyrillicRatio?: number;
  flagSoftRuns?: boolean;
  flagSingletons?: boolean;
};

type LanguageGateEnvLike = {
  SUMMARY_LANGUAGE_GATE_ENABLE: boolean;
  SUMMARY_MIN_CYRILLIC_RATIO: number;
  SUMMARY_LATIN_SOFT_RUNS: boolean;
  SUMMARY_LATIN_SINGLETONS: boolean;
};

export function languageGateFromEnv(envLike: LanguageGateEnvLike): LanguageGateSettings {
  return {
    enable: envLike.SUMMARY_LANGUAGE_GATE_ENABLE,
    minCyrillicRatio: envLike.SUMMARY_MIN_CYRILLIC_RATIO,
    flagSoftRuns: envLike.SUMMARY_LATIN_SOFT_RUNS,
    flagSingletons: envLike.SUMMARY_LATIN_SINGLETONS,
  };
}

export type HeuristicCheckOptions = {
  minChars?: number;
  language?: "en" | "ru";
  /**
   * Content profile. The "comments" profile expects a bullet-list-only summary
   * (the RU comments prompt demands it), so `bullets_only` is not a defect there.
   */
  kind?: "comments" | "post";
  /** RU language-purity gate thresholds; only applied when language === "ru". */
  languageGate?: LanguageGateSettings;
};

const REPETITION_RUN_MIN_WORDS = 20;
const REPETITION_RUN_THRESHOLD = 8;
const UNIQUE_RATIO_MIN_WORDS = 80;
const UNIQUE_RATIO_THRESHOLD = 0.2;
const URL_ENCODED_MIN_MATCHES = 8;
const URL_ENCODED_RATIO_THRESHOLD = 0.05;
const BARE_BULLET_MIN_LINES = 10;
const BARE_BULLET_RATIO_THRESHOLD = 0.9;
const PROMPT_INSTRUCTION_SCORE_THRESHOLD = 2;
const NUMERIC_HEADINGS_MIN_LINES = 3;
const NUMERIC_HEADINGS_RATIO_THRESHOLD = 0.8;
const COMMENTS_INSIGHTS_REUSED_REASONS = new Set(["policy", "prompt_instructions", "refusal"]);

const REFUSAL_PHRASES = [
  "as an ai",
  "i cannot",
  "i can't comply",
  "i must decline",
  "the request is not allowed",
  "как искусственный интеллект",
  "я не могу",
  "доступ к этой статье закрыт",
];

const POLICY_PHRASES = ["usage policy", "safety policy", "guidelines", "openai policy", "anthropic policy"];
const GENERIC_PHRASES = ["this article discusses", "the content provides", "the text covers"];
const META_PHRASES = ["for more information", "see the original article", "read the original article"];
const CONTENT_FREE_PHRASES = ["no additional information", "information not provided"];

const APOLOGY_TOKENS = ["i'm sorry", "im sorry", "sorry", "apologize", "к сожалению", "извините"];
const REFUSAL_TOKENS = [
  "i cannot",
  "i can't",
  "cannot",
  "can't",
  "unable to",
  "я не могу",
  "мы не можем",
  "не буду",
  "не сможем",
];

const DEFAULT_MIN_CHARS = 120;
const MIN_WORDS = 25;

const PROMPT_INSTRUCTION_STRONG_PHRASES = [
  "я твой переводчик",
  "я ваш переводчик",
  "я буду твоим переводчиком",
  "я буду вашим переводчиком",
  "я являюсь твоим переводчиком",
  "я являюсь вашим переводчиком",
  "i will be your translator",
  "i can be your translator",
  "i will be the translator",
  "as your translator",
  "as the translator",
  "as your assistant",
  "as the assistant",
  "ignore previous instructions",
];

const PROMPT_INSTRUCTION_WEAK_PHRASES = [
  "твоя задача",
  "ваша задача",
  "your task is",
  "ты пишешь",
  "вы пишете",
  "ты должен",
  "ты должна",
  "вы должны",
  "тебе нужно пересказать",
  "вам нужно пересказать",
  "тебе нужно перевести",
  "вам нужно перевести",
  "переведи на русский",
  "перескажи на русском",
  "you must summarize",
  "you should summarize",
  "you need to summarize",
  "you must translate",
  "you should translate",
  "you need to translate",
  "i will help you translate",
  "i can help you translate",
  "i will help you summarize",
  "i can help you summarize",
  "я помогу тебе перевести",
  "я помогу вам перевести",
  "я помогу тебе пересказать",
  "я помогу вам пересказать",
  "я могу тебе перевести",
  "я могу вам перевести",
];

function pushIfMatch(summaryLower: string, phrases: string[], reason: string, triggers: HeuristicTrigger[]): void {
  for (const phrase of phrases) {
    if (summaryLower.includes(phrase)) {
      triggers.push({ reason, detail: phrase });
      return;
    }
  }
}

function pushIfApologyRefusal(summaryLower: string, reason: string, triggers: HeuristicTrigger[]): void {
  const sentences = summaryLower.split(/[\n!.;?]+/u);
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      continue;
    }
    const hasApology = APOLOGY_TOKENS.some((token) => trimmed.includes(token));
    if (!hasApology) {
      continue;
    }
    const hasRefusal = REFUSAL_TOKENS.some((token) => trimmed.includes(token));
    if (hasRefusal) {
      triggers.push({ reason, detail: "apology_refusal" });
      return;
    }
  }
}

function withoutMarkdownCodeSpans(text: string): string {
  return text.replaceAll(/```[\s\S]*?```/gu, " ").replaceAll(/`[^\n\r`]*`/gu, " ");
}

/** Ratio of Cyrillic letters to Cyrillic + Latin letters outside Markdown code spans. */
export function cyrillicRatio(text: string): number {
  const prose = withoutMarkdownCodeSpans(text);
  let cyrillicLetters = 0;
  let latinLetters = 0;
  for (const char of prose) {
    if (/\p{Script=Cyrillic}/u.test(char)) {
      cyrillicLetters += 1;
    } else if (/\p{Script=Latin}/u.test(char)) {
      latinLetters += 1;
    }
  }
  const eligibleLetters = cyrillicLetters + latinLetters;
  return eligibleLetters > 0 ? cyrillicLetters / eligibleLetters : 1;
}

function commentsInsightsLanguageText(insights: CommentsInsights): string {
  const fields = [
    ...insights.consensus,
    ...insights.disputes.flatMap((dispute) => [dispute.topic, dispute.position_a, dispute.position_b]),
    ...insights.practical_advice,
  ];
  // source_text is deliberately excluded: it is a verbatim source quote, not
  // generated prose. The optional translation is generated and must pass the gate.
  const translation = insights.best_quote?.translation;
  if (translation !== undefined && translation !== null && translation.length > 0) {
    fields.push(translation);
  }
  return withoutMarkdownCodeSpans(fields.join("\n"));
}

/** Content checks for model-generated insight fields, excluding quote provenance. */
export function checkCommentsInsightsHeuristics(
  insights: CommentsInsights,
  options: CommentsInsightsHeuristicOptions
): HeuristicVerdict {
  const semanticText = commentsInsightsLanguageText(insights);
  const reused = checkSummaryHeuristics(semanticText, {
    kind: "comments",
    language: "en",
    minChars: 0,
  }).triggers.filter((trigger) => COMMENTS_INSIGHTS_REUSED_REASONS.has(trigger.reason));
  const triggers = [...reused];

  if (options.language === "ru") {
    const minimum = options.minCyrillicRatio ?? 0.65;
    const ratio = cyrillicRatio(semanticText);
    if (ratio < minimum) {
      triggers.push({ reason: "low_cyrillic_ratio", detail: `ratio=${ratio.toFixed(3)}` });
    }
  }

  return { ok: triggers.length === 0, triggers };
}

export function checkSummaryHeuristics(
  rawSummary: string | undefined,
  options: HeuristicCheckOptions = {}
): HeuristicVerdict {
  if (rawSummary === undefined) {
    return { ok: false, triggers: [{ reason: "empty" }] };
  }

  const summary = rawSummary.trim();
  if (summary.length === 0) {
    return { ok: false, triggers: [{ reason: "empty" }] };
  }

  const triggers: HeuristicTrigger[] = [];
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;
  if (summary.length < minChars) {
    triggers.push({ reason: "too_short", detail: `chars<${minChars}` });
  }

  const words = summary.split(/\s+/u).filter((w) => w.length > 0);
  if (words.length < MIN_WORDS) {
    triggers.push({ reason: "too_few_words", detail: `words=${words.length}` });
  }

  const lines = summary.split(/\r?\n/u);
  if (options.kind !== "comments" && lines.length > 0 && lines.every((line) => line.trimStart().startsWith("- "))) {
    triggers.push({ reason: "bullets_only" });
  }

  const summaryLower = summary.toLowerCase();

  pushIfMatch(summaryLower, REFUSAL_PHRASES, "refusal", triggers);
  pushIfApologyRefusal(summaryLower, "refusal", triggers);
  pushIfMatch(summaryLower, POLICY_PHRASES, "policy", triggers);
  pushIfMatch(summaryLower, GENERIC_PHRASES, "generic", triggers);
  pushIfMatch(summaryLower, META_PHRASES, "meta_instructions", triggers);
  pushIfMatch(summaryLower, CONTENT_FREE_PHRASES, "content_free", triggers);

  if (summary.includes("<|")) {
    triggers.push({ reason: "artifact", detail: "angle-token" });
  }
  if (summary.includes("```")) {
    triggers.push({ reason: "artifact", detail: "code-fence" });
  }
  if (summary.trimStart().startsWith("{") || summary.trimStart().startsWith("[")) {
    triggers.push({ reason: "artifact", detail: "json" });
  }

  if (summaryLower.includes("http://") || summaryLower.includes("https://")) {
    triggers.push({ reason: "contains_url" });
  }

  if (words.length > 0) {
    const lowerWords = words.map((word) => word.toLowerCase());

    if (lowerWords.length >= REPETITION_RUN_MIN_WORDS) {
      let longestRun = 1;
      let currentRun = 1;
      for (let index = 1; index < lowerWords.length; index += 1) {
        if (lowerWords[index] === lowerWords[index - 1]) {
          currentRun += 1;
        } else {
          currentRun = 1;
        }
        if (currentRun > longestRun) {
          longestRun = currentRun;
        }
      }
      if (longestRun >= REPETITION_RUN_THRESHOLD) {
        triggers.push({ reason: "repetition_run", detail: `run=${longestRun}` });
      }
    }

    if (lowerWords.length >= UNIQUE_RATIO_MIN_WORDS) {
      const uniqueCount = new Set(lowerWords).size;
      const uniqueRatio = uniqueCount / lowerWords.length;
      if (uniqueRatio < UNIQUE_RATIO_THRESHOLD) {
        triggers.push({ reason: "low_unique_ratio", detail: `ratio=${uniqueRatio.toFixed(3)}` });
      }
    }
  }

  const percentMatches = summary.match(/%[\da-f]{2}/giu);
  if (percentMatches) {
    const percentChars = percentMatches.length;
    const percentRatio = percentChars / summary.length;
    if (percentChars >= URL_ENCODED_MIN_MATCHES && percentRatio >= URL_ENCODED_RATIO_THRESHOLD) {
      triggers.push({ reason: "url_encoded_noise", detail: `ratio=${percentRatio.toFixed(3)}` });
    }
  }

  const bareBullets = lines.filter((line) => isBareBulletLine(line)).length;
  if (bareBullets >= BARE_BULLET_MIN_LINES && bareBullets / lines.length >= BARE_BULLET_RATIO_THRESHOLD) {
    triggers.push({ reason: "bare_bullets", detail: `ratio=${(bareBullets / lines.length).toFixed(2)}` });
  }

  const promptScore = computePromptInstructionScore(summaryLower);
  if (promptScore >= PROMPT_INSTRUCTION_SCORE_THRESHOLD) {
    triggers.push({ reason: "prompt_instructions", detail: `score=${promptScore}` });
  }

  const numericHeadingLines = lines.filter((line) => isNumericHeadingLine(line)).length;
  const contentLines = lines.filter((line) => line.trim().length > 0).length;
  if (
    numericHeadingLines >= NUMERIC_HEADINGS_MIN_LINES &&
    contentLines > 0 &&
    numericHeadingLines / contentLines >= NUMERIC_HEADINGS_RATIO_THRESHOLD
  ) {
    triggers.push({
      reason: "numeric_headings",
      detail: `ratio=${(numericHeadingLines / contentLines).toFixed(2)}`,
    });
  }

  if (options.language === "ru" && (options.languageGate?.enable ?? true)) {
    const gate = options.languageGate ?? {};
    const purity = analyzeRussianLanguagePurity(summary, {
      minCyrillicRatio: gate.minCyrillicRatio ?? DEFAULT_MIN_CYRILLIC_RATIO,
      flagSoftRuns: gate.flagSoftRuns ?? false,
      flagSingletons: gate.flagSingletons ?? true,
    });
    if (purity.lowCyrillicRatio) {
      triggers.push({ reason: "low_cyrillic_ratio", detail: `ratio=${purity.cyrillicRatio.toFixed(3)}` });
    }
    const latinHits = [
      ...purity.latinRuns.map((run) => run.words.join(" ")),
      ...purity.softLatinRuns.map((run) => run.words.join(" ")),
      ...purity.latinSingletons.map((hit) => hit.word),
    ];
    if (latinHits.length > 0) {
      triggers.push({ reason: "latin_prose", detail: latinHits.slice(0, 5).join("; ") });
    }
  }

  const ok = triggers.length === 0;
  return { ok, triggers };
}

function isBareBulletLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const unescaped = trimmed.startsWith("\\") ? trimmed.slice(1) : trimmed;
  return /^[-–—•]{1,4}$/u.test(unescaped);
}

function computePromptInstructionScore(summaryLower: string): number {
  const normalized = summaryLower.replaceAll(/[^\s\p{L}\p{N}]/gu, " ");
  const collapsed = normalized.replaceAll(/\s+/gu, " ").trim();
  const padded = ` ${collapsed} `;
  let score = 0;
  if (PROMPT_INSTRUCTION_STRONG_PHRASES.some((phrase) => padded.includes(` ${phrase} `))) {
    score += PROMPT_INSTRUCTION_SCORE_THRESHOLD;
  }
  for (const phrase of PROMPT_INSTRUCTION_WEAK_PHRASES) {
    if (padded.includes(` ${phrase} `)) {
      score += 1;
      if (score >= PROMPT_INSTRUCTION_SCORE_THRESHOLD) {
        break;
      }
    }
  }
  return score;
}

function isNumericHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("#")) {
    return false;
  }
  const headingText = trimmed.replace(/^#+\s*/u, "");
  if (headingText.length === 0 || !/\d/u.test(headingText)) {
    return false;
  }
  if (/\p{L}/u.test(headingText)) {
    return false;
  }
  for (const char of headingText) {
    if (char >= "0" && char <= "9") {
      continue;
    }
    if (char === "." || char === "/" || char === "-" || char === " " || char === "\t") {
      continue;
    }
    return false;
  }
  return true;
}
