export type HeuristicTrigger = {
  reason: string;
  detail?: string;
};

export type HeuristicVerdict = {
  ok: boolean;
  triggers: HeuristicTrigger[];
};

type HeuristicCheckOptions = {
  minChars?: number;
  language?: "en" | "ru";
};

const REPETITION_RUN_MIN_WORDS = 20;
const REPETITION_RUN_THRESHOLD = 8;
const UNIQUE_RATIO_MIN_WORDS = 80;
const UNIQUE_RATIO_THRESHOLD = 0.2;
const URL_ENCODED_MIN_MATCHES = 8;
const URL_ENCODED_RATIO_THRESHOLD = 0.05;

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
  if (lines.length > 0 && lines.every((line) => line.trimStart().startsWith("- "))) {
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

  const percentMatches = summary.match(/%[0-9a-f]{2}/giu);
  if (percentMatches) {
    const percentChars = percentMatches.length;
    const percentRatio = percentChars / summary.length;
    if (percentChars >= URL_ENCODED_MIN_MATCHES && percentRatio >= URL_ENCODED_RATIO_THRESHOLD) {
      triggers.push({ reason: "url_encoded_noise", detail: `ratio=${percentRatio.toFixed(3)}` });
    }
  }

  const ok = triggers.length === 0;
  return { ok, triggers };
}
