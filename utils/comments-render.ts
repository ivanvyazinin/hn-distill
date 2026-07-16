import type { CommentsInsights, NormalizedComment } from "@config/schemas";
import { dedupByContainment } from "@utils/comments-dedup";

type SummaryLanguage = "en" | "ru";
type CommentsQuote = NonNullable<CommentsInsights["best_quote"]>;
type InsightKind = CommentsInsights["insights"][number]["kind"];

export type ValidatedCommentsQuote = {
  commentId: number;
  author: string;
  sourceText: string;
  translation: string | null;
};

export type RenderCommentsSummaryOptions = {
  language: SummaryLanguage;
  comments: NormalizedComment[];
};

export type CommentsSummaryParts = {
  lead: string;
  visible: string;
  folded: string;
  foldedInsightsCount: number;
  /** True when a provenance-validated quote is present in `folded` (not inferred from text). */
  foldedHasQuote: boolean;
};

const LABELS: Record<
  SummaryLanguage,
  {
    dispute: string;
    advice: string;
    fallback: string;
    translation: string;
  }
> = {
  ru: {
    dispute: "Спор",
    advice: "Совет",
    fallback: "Из обсуждения",
    translation: "Перевод",
  },
  en: {
    dispute: "Debate",
    advice: "Advice",
    fallback: "From the discussion",
    translation: "Translation",
  },
};

const MAX_VISIBLE_INSIGHTS = 3;
const MAX_FALLBACK_COMMENTS = 2;
const MIN_FALLBACK_COMMENT_CHARS = 80;
const MARKDOWN_LITERAL_CHARACTERS = ["\\", "`", "*", "_", "[", "]", "{", "}", "<", ">", "#", "+", "-", "|", "!"] as const;

function normalizeInline(value: string): string {
  return value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
}

const SENTENCE_TERMINATORS = new Set([".", "!", "?", "…"]);
const CLOSING_MARKS = /["'»”)\]]/u;
const MIN_CLAUSE_CHARS = 20;

/**
 * Repair a value that a length-capped structured decoder chopped mid-word.
 * Prefers the last full sentence; if the text is a single run-on sentence with
 * no internal terminator (the common Groq/OpenRouter cut), drops the trailing
 * partial word and marks the elision. Values that already end cleanly are
 * returned untouched, so complete summaries are never altered.
 */
export function clampToClause(raw: string): string {
  const text = raw.trimEnd();
  if (text.length === 0 || endsCleanly(text)) {
    return text;
  }
  const sentence = trimToLastSentence(text);
  // Prefer the last complete sentence. Ignore a trivially short leading fragment
  // (e.g. "Да.") and fall through to the word-boundary path so we keep substance.
  if (sentence.length >= MIN_CLAUSE_CHARS) {
    return sentence;
  }
  const withoutPartialWord = text.replace(/\s+\S*$/u, "").trimEnd();
  const base = withoutPartialWord.length >= MIN_CLAUSE_CHARS ? withoutPartialWord : text;
  return `${base}…`;
}

function endsCleanly(text: string): boolean {
  const stripped = text.replace(new RegExp(`${CLOSING_MARKS.source}+$`, "u"), "");
  const last = stripped.at(-1);
  return last !== undefined && SENTENCE_TERMINATORS.has(last);
}

function trimToLastSentence(text: string): string {
  let cut = -1;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (SENTENCE_TERMINATORS.has(text[index] as string)) {
      cut = index;
      break;
    }
  }
  if (cut < 0) {
    return "";
  }
  let end = cut + 1;
  while (end < text.length && CLOSING_MARKS.test(text[end] as string)) {
    end += 1;
  }
  return text.slice(0, end);
}

function normalizeForProvenance(value: string): string {
  return normalizeInline(value);
}

function escapeMarkdownLiteral(value: string): string {
  let escaped = value;
  for (const character of MARKDOWN_LITERAL_CHARACTERS) {
    escaped = escaped.replaceAll(character, `\\${character}`);
  }
  return escaped;
}

function safeInline(value: string): string {
  return escapeMarkdownLiteral(normalizeInline(value));
}

function safeAuthor(value: string): string {
  return safeInline(value.replace(/^@+/u, ""));
}

function quoteFromInput(input: CommentsInsights | CommentsQuote | null): CommentsQuote | undefined {
  if (input === null) {
    return undefined;
  }
  return "best_quote" in input ? (input.best_quote ?? undefined) : input;
}

export function validateCommentsQuote(
  insightsOrQuote: CommentsInsights | CommentsQuote | null,
  comments: NormalizedComment[]
): ValidatedCommentsQuote | undefined {
  const quote = quoteFromInput(insightsOrQuote);
  if (quote === undefined) {
    return undefined;
  }
  const comment = comments.find((candidate) => candidate.id === quote.comment_id);
  if (comment === undefined) {
    return undefined;
  }
  const normalizedQuote = normalizeForProvenance(quote.source_text);
  const normalizedComment = normalizeForProvenance(comment.textPlain);
  if (normalizedQuote.length === 0 || !normalizedComment.includes(normalizedQuote)) {
    return undefined;
  }
  return {
    commentId: comment.id,
    author: comment.by,
    sourceText: quote.source_text.replaceAll(/\r\n?/gu, "\n").trim(),
    translation: quote.translation,
  };
}

function renderInsightBullet(kind: InsightKind, text: string, language: SummaryLanguage): string {
  const body = safeInline(clampToClause(text));
  if (kind === "dispute") {
    return `- **${LABELS[language].dispute}:** ${body}`;
  }
  if (kind === "advice") {
    return `- **${LABELS[language].advice}:** ${body}`;
  }
  return `- ${body}`;
}

function renderQuote(translationLabel: string, quote: ValidatedCommentsQuote): string {
  const quoteLines = escapeMarkdownLiteral(quote.sourceText).split("\n");
  const lines = [
    ...quoteLines.map((line) => (line.length === 0 ? ">" : `> ${line}`)),
    `> — @${safeAuthor(quote.author)}`,
  ];
  if (quote.translation !== null && normalizeInline(quote.translation).length > 0) {
    lines.push("", `_${translationLabel}:_ ${safeInline(quote.translation)}`);
  }
  return lines.join("\n");
}

function joinChunks(chunks: readonly string[]): string {
  const nonempty = chunks.filter((chunk) => chunk.length > 0);
  return nonempty.length === 0 ? "" : `${nonempty.join("\n\n")}\n`;
}

export function renderCommentsLead(bottomLine: string): string {
  const lead = safeInline(clampToClause(bottomLine));
  return lead.length === 0 ? "" : `${lead}\n`;
}

/**
 * Deterministic site-facing parts. Dedup runs here intentionally: a card that is
 * pure near-duplicates can fail the min-chars gate after rendering — desired.
 */
export function renderCommentsSummaryParts(
  insights: CommentsInsights,
  options: RenderCommentsSummaryOptions
): CommentsSummaryParts {
  const labels = LABELS[options.language];
  const lead = safeInline(clampToClause(insights.bottom_line));
  const surviving = dedupByContainment(
    insights.bottom_line,
    insights.insights.map((insight) => insight.text)
  );
  const bullets = surviving.map((index) => {
    const insight = insights.insights[index];
    if (insight === undefined) {
      throw new Error(`dedup returned unknown index ${index}`);
    }
    return renderInsightBullet(insight.kind, insight.text, options.language);
  });

  const visibleBullets = bullets.slice(0, MAX_VISIBLE_INSIGHTS);
  const foldedBullets = bullets.slice(MAX_VISIBLE_INSIGHTS);
  const quote = validateCommentsQuote(insights, options.comments);
  const quoteMarkdown = quote === undefined ? "" : renderQuote(labels.translation, quote);

  return {
    lead: lead.length === 0 ? "" : `${lead}\n`,
    visible: visibleBullets.length === 0 ? "" : `${visibleBullets.join("\n")}\n`,
    folded: joinChunks([foldedBullets.length === 0 ? "" : foldedBullets.join("\n"), quoteMarkdown]),
    foldedInsightsCount: foldedBullets.length,
    foldedHasQuote: quoteMarkdown.length > 0,
  };
}

/** Localized fold `<summary>` label for the site UI (shared by list + item pages). */
export function commentsFoldLabel(
  parts: Pick<CommentsSummaryParts, "foldedInsightsCount" | "foldedHasQuote">,
  language: SummaryLanguage
): string {
  const n = parts.foldedInsightsCount;
  if (language === "ru") {
    if (parts.foldedHasQuote) {
      if (n === 0) return "цитата из треда";
      if (n === 1) return "ещё 1 тезис (+ цитата)";
      return `ещё ${n} тезиса (+ цитата)`;
    }
    if (n === 1) return "ещё 1 тезис";
    return `ещё ${n} тезиса`;
  }
  if (parts.foldedHasQuote) {
    if (n === 0) return "quote from the thread";
    return `${n} more takeaways (+ quote)`;
  }
  return `${n} more takeaways`;
}

export function renderCommentsSummaryMarkdown(
  insights: CommentsInsights,
  options: RenderCommentsSummaryOptions
): string {
  const parts = renderCommentsSummaryParts(insights, options);
  return joinChunks([parts.lead.trimEnd(), parts.visible.trimEnd(), parts.folded.trimEnd()]);
}

export function renderTooFewCommentsFallback(comments: NormalizedComment[], language: SummaryLanguage): string {
  const contentComments = comments
    .filter((comment) => normalizeInline(comment.textPlain).length >= MIN_FALLBACK_COMMENT_CHARS)
    .slice(0, MAX_FALLBACK_COMMENTS);
  if (contentComments.length === 0) {
    return "";
  }

  const bullets = contentComments.map(
    (comment) => `- **@${safeAuthor(comment.by)}:** ${safeInline(comment.textPlain)}`
  );
  return `### ${LABELS[language].fallback}\n\n${bullets.join("\n")}\n`;
}
