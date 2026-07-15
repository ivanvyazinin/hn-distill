import type { CommentsInsights, NormalizedComment } from "@config/schemas";

type SummaryLanguage = "en" | "ru";
type CommentsQuote = NonNullable<CommentsInsights["best_quote"]>;

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

const HEADINGS: Record<SummaryLanguage, {
  disputes: string;
  consensus: string;
  advice: string;
  quote: string;
  fallback: string;
  translation: string;
}> = {
  ru: {
    disputes: "О чём спорят",
    consensus: "Консенсус",
    advice: "Советы из треда",
    quote: "Цитата из обсуждения",
    fallback: "Из обсуждения",
    translation: "Перевод",
  },
  en: {
    disputes: "What people debate",
    consensus: "Consensus",
    advice: "Advice from the thread",
    quote: "Quote from the discussion",
    fallback: "From the discussion",
    translation: "Translation",
  },
};

const MAX_DISPUTES = 3;
const MAX_CONSENSUS = 3;
const MAX_ADVICE = 3;
const MAX_SEMANTIC_BULLETS = 7;
const MAX_FALLBACK_COMMENTS = 2;
const MIN_FALLBACK_COMMENT_CHARS = 80;
const MARKDOWN_LITERAL_CHARACTERS = ["\\", "`", "*", "_", "[", "]", "{", "}", "<", ">", "#", "+", "-", "|", "!"] as const;

function normalizeInline(value: string): string {
  return value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
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

function pushSection(lines: string[], heading: string, bullets: string[]): void {
  if (bullets.length === 0) {
    return;
  }
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(`### ${heading}`, "", ...bullets.map((bullet) => `- ${bullet}`));
}

function renderQuote(lines: string[], heading: string, translationLabel: string, quote: ValidatedCommentsQuote): void {
  if (lines.length > 0) {
    lines.push("");
  }
  const quoteLines = escapeMarkdownLiteral(quote.sourceText).split("\n");
  lines.push(`### ${heading}`, "", ...quoteLines.map((line) => (line.length === 0 ? ">" : `> ${line}`)));
  lines.push(`> — @${safeAuthor(quote.author)}`);
  if (quote.translation !== null && normalizeInline(quote.translation).length > 0) {
    lines.push("", `_${translationLabel}:_ ${safeInline(quote.translation)}`);
  }
}

export function renderCommentsSummaryMarkdown(
  insights: CommentsInsights,
  options: RenderCommentsSummaryOptions
): string {
  const headings = HEADINGS[options.language];
  const lines: string[] = [];
  let remainingBullets = MAX_SEMANTIC_BULLETS;

  const disputes = insights.disputes.slice(0, Math.min(MAX_DISPUTES, remainingBullets)).map((dispute) =>
    `**${safeInline(dispute.topic)}:** ${safeInline(dispute.position_a)} — ${safeInline(dispute.position_b)}`
  );
  remainingBullets -= disputes.length;
  pushSection(lines, headings.disputes, disputes);

  const consensus = insights.consensus
    .slice(0, Math.min(MAX_CONSENSUS, remainingBullets))
    .map((item) => safeInline(item));
  remainingBullets -= consensus.length;
  pushSection(lines, headings.consensus, consensus);

  const advice = insights.practical_advice
    .slice(0, Math.min(MAX_ADVICE, remainingBullets))
    .map((item) => safeInline(item));
  pushSection(lines, headings.advice, advice);

  const quote = validateCommentsQuote(insights, options.comments);
  if (quote !== undefined) {
    renderQuote(lines, headings.quote, headings.translation, quote);
  }

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
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
  return `### ${HEADINGS[language].fallback}\n\n${bullets.join("\n")}\n`;
}
