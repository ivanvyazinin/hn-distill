import { COMMENTS_POLICY_VERSION, env, EXTRACT_POLICY_VERSION, type Env } from "@config/env";
import { PATHS, pathFor } from "@config/paths";
import {
  CommentsInsightsJsonSchema,
  CommentsInsightsSchema,
  CommentsSummarySchema,
  IndexSchema,
  NormalizedCommentSchema,
  NormalizedStorySchema,
  PostSummarySchema,
  TagsSummarySchema,
  type CommentsInsights,
  type CommentsSummary,
  type NormalizedComment,
  type NormalizedStory,
  type PostSummary,
} from "@config/schemas";
import {
  fetchViaJinaReader,
  isCloudflareChallengeError,
  looksLikeCloudflareChallenge,
} from "@utils/article-fetch";
import { passesEngagementGate } from "@utils/engagement-gate";
import {
  buildCommentsCompressUserPrompt,
  compressedStateFor,
  expectedCompressSourceHash,
  isCommentsCompressEnabled,
  isPermanentCompressHttpError,
  renderCommentsInsightsPlainText,
  resolveCompressedState,
  sanitizeCompressedOutput,
  validateCompressedText,
} from "@utils/comments-compress";
import {
  renderCommentsLead,
  renderCommentsSummaryMarkdown,
  renderCompressedParagraphMarkdown,
  renderTooFewCommentsFallback,
  validateCommentsQuote,
} from "@utils/comments-render";
import {
  buildCommentsThread,
  buildCommentsPromptV2,
  buildCommentsSystemInstructionV2,
  COMMENTS_INSIGHTS_HARD_CEILING,
  commentsInputHash,
  isSubstantiveComment,
} from "@utils/comments-thread";
import { decodeText, looksLikeHtml, looksLikePdf } from "@utils/content-detect";
import { assessExtractQuality } from "@utils/extract-quality";
import { sha256Hex } from "@utils/hash";
import { extractArticleMd } from "@utils/html-to-md";
import { HttpClient, HttpError } from "@utils/http-client";
import { log } from "@utils/log";
import { readJsonSafeOrStore } from "@utils/object-store";
import { createUsageCollector, type UsageCollector } from "@utils/llm-usage";
import { OpenRouter, UnsupportedResponseFormatError, type ChatMessage, type JsonSchema } from "@utils/openrouter";
import { runSummaryGuard, type SummaryGuardResult } from "@utils/summary-guard";
import {
  checkCommentsInsightsHeuristics,
  checkSummaryHeuristics,
  languageGateFromEnv,
} from "@utils/summary-heuristics";
import { buildTagsCacheMaterial, buildTagsPrompt, combineAndCanon, summarizeTagsStructured } from "@utils/tags-extract";
import {
  Telegram,
  buildTelegramMessage,
  parseTelegramError,
  readTelegramLedger,
  writeTelegramLedger,
  type TelegramDigestItem,
  type TelegramLedger,
} from "@utils/telegram";
import { fetchYouTubeTranscript, getVideoId, isYouTubeUrl } from "@utils/youtube";

import type { MetaStore } from "@utils/meta-store";
import type { ObjectStore } from "@utils/object-store";
import type { PdfToTextOptions } from "@utils/pdf";
import type { z } from "zod";

export { buildCommentsPromptV2, buildCommentsSystemInstructionV2, buildCommentsThread, commentsInputHash };

/**
 * How a story's article content was fetched/parsed.
 * "html" and "reader" (Jina markdown fallback) are subject to the garbage detector;
 * pdf / youtube / text / empty bypass it (lists and short lines are legitimate there).
 */
export type ArticleSourceKind = "empty" | "html" | "pdf" | "reader" | "text" | "youtube";

export type FetchedArticle = { md: string; sourceKind: ArticleSourceKind };

export type Services = {
  http: HttpClient;
  openrouter: OpenRouter;
  /** Client for structured-JSON calls (tags, post-guard, comments-v2). Groq when GROQ_API_KEY is set, else same as openrouter. */
  guardTagsClient: OpenRouter;
  fetchArticleMarkdown: (url: string) => Promise<FetchedArticle>;
  /** Force the Jina reader path (JS-rendered pages). Used to recover a no-article html extract. */
  fetchArticleViaReader?: (url: string) => Promise<FetchedArticle>;
  pdfToText?: (bytes: Uint8Array, opts?: PdfToTextOptions) => Promise<string>;
  /** Per-attempt LLM usage collector, scoped per story by processSingleStory. */
  usage: UsageCollector;
  /**
   * Run-scoped Groq model ids proven exhausted via TPD 429. Shared across stories in one
   * makeServices() lifetime so a later story skips the dead model without a module global.
   * Fresh Services (new run) starts empty. TPM/timeout/transport must NOT populate this.
   */
  commentsTpdExhaustedModels?: Set<string>;
};

export function makeServices(
  e: Env,
  options?: {
    pdfToText?: (bytes: Uint8Array, opts?: PdfToTextOptions) => Promise<string>;
    /** Test-only: inject a stub HttpClient (bytes/text) instead of the real one. */
    http?: HttpClient;
  }
): Services {
  const http =
    options?.http ??
    new HttpClient(
      {
        retries: e.HTTP_RETRIES,
        baseBackoffMs: e.HTTP_BACKOFF_MS,
        timeoutMs: e.HTTP_TIMEOUT_MS,
        retryOnStatuses: [408, 425, 429, 500, 502, 503, 504, 522],
      },
      {
        ua: "hn-distill/1.1 (+https://hckr.top/)",
        headers: {},
      }
    );
  const usage = createUsageCollector();
  // The usage sink is wired only behind the flag (R4): keeps write-path and wiring off until
  // the D1 migration is applied --remote, decoupling this from Pages/Worker deploy order.
  const onUsage = e.LLM_USAGE_ENABLED ? usage.record : undefined;
  const openrouter = new OpenRouter(
    http,
    e.OPENROUTER_API_KEY ?? "",
    e.OPENROUTER_MODEL,
    e.OPENROUTER_BASE_URL,
    { gateway: "openrouter", ...(onUsage === undefined ? {} : { onUsage }) }
  );
  // Route tags + post-guard (structured JSON) to Groq when a key is set; otherwise reuse OpenRouter.
  const groqEnabled = e.GROQ_API_KEY !== undefined && e.GROQ_API_KEY.length > 0;
  const guardTagsClient = groqEnabled
    ? new OpenRouter(http, e.GROQ_API_KEY ?? "", e.TAGS_MODEL, e.GROQ_BASE_URL, {
        gateway: "groq",
        ...(onUsage === undefined ? {} : { onUsage }),
      })
    : openrouter;

  async function fetchArticleMarkdown(url: string): Promise<FetchedArticle> {
    const youtubeText = await tryFetchYouTubeContent(url);
    if (youtubeText) {
      return { md: youtubeText, sourceKind: "youtube" };
    }

    try {
      const { data, contentType } = await http.bytes(url);
      // Rare: origin returns 200 with a Cloudflare challenge HTML body. Treat as
      // fallback-eligible instead of feeding the interstitial to Readability.
      // Decode once; reuse for both challenge check and HTML extract.
      if (looksLikeHtml(contentType ?? undefined)) {
        const html = decodeText(data, contentType ?? undefined);
        if (looksLikeCloudflareChallenge(html)) {
          // Synthetic 403 so reader failure on this path classifies as bot-protection
          // (WARN), same as a real origin 403 — not a generic ERROR.
          throw new HttpError(url, 403, `HTTP 403 Cloudflare challenge body for ${url}`);
        }
        return await parseFetchedContent(url, data, contentType ?? undefined, html);
      }
      return await parseFetchedContent(url, data, contentType ?? undefined);
    } catch (error) {
      if (!e.ARTICLE_FETCH_READER_FALLBACK || !isCloudflareChallengeError(error)) {
        throw error;
      }
      try {
        return await fetchArticleViaReader(url);
      } catch (readerError) {
        log.warn(LOG_NAMESPACE_ARTICLE, "Jina reader fallback failed", {
          url,
          error: String(readerError),
        });
        // Preserve the original origin failure (status/url) so outer logging still
        // classifies it as bot-protection; attach reader failure as cause.
        if (error instanceof HttpError) {
          throw new HttpError(error.url, error.status, error.message, { cause: readerError });
        }
        throw error;
      }
    }
  }

  async function fetchArticleViaReader(url: string): Promise<FetchedArticle> {
    // Structured counter-ish log: grep "via Jina reader" / sourceKind=reader for frequency.
    log.info(LOG_NAMESPACE_ARTICLE, "Retrying article via Jina reader", {
      url,
      fallback: "jina",
      readerBase: e.ARTICLE_READER_BASE_URL,
      hasJinaKey: Boolean(e.JINA_API_KEY && e.JINA_API_KEY.length > 0),
    });
    const md = await fetchViaJinaReader(http, url, {
      apiKey: e.JINA_API_KEY,
      baseUrl: e.ARTICLE_READER_BASE_URL,
      timeoutMs: e.HTTP_TIMEOUT_MS,
    });
    return { md, sourceKind: "reader" };
  }

  async function tryFetchYouTubeContent(url: string): Promise<string | undefined> {
    try {
      const parsed = new URL(url);
      if (!isYouTubeUrl(parsed)) {
        return undefined;
      }
      const vid = getVideoId(parsed);
      if (!vid) {
        return undefined;
      }
      log.info(LOG_NAMESPACE_ARTICLE, "Fetching YouTube transcript", { url, vid });
      const prefer =
        (e.YT_TRANSCRIPT_LANGS?.length ?? 0) > 0
          ? e.YT_TRANSCRIPT_LANGS ?? [e.SUMMARY_LANG, "en"]
          : [e.SUMMARY_LANG, "en"];
      const transcript = await fetchYouTubeTranscript(http, vid, prefer);
      const trimmed = transcript?.text.trim();
      if (trimmed) {
        return trimmed;
      }
      log.warn(LOG_NAMESPACE_ARTICLE, "No captions available; falling back to HTML", { url, vid });
    } catch {
      // Not a valid URL or transcript fetch failed; fall back to fetching bytes.
    }
    return undefined;
  }

  async function parseFetchedContent(
    url: string,
    data: Uint8Array,
    contentType?: string,
    /** Pre-decoded HTML when the caller already decoded for challenge detection. */
    decodedHtml?: string
  ): Promise<FetchedArticle> {
    const head = data.subarray(0, 8);
    if (looksLikePdf({ url, contentType, bytesHead: head })) {
      log.info(LOG_NAMESPACE_ARTICLE, "Fetching and parsing PDF", { url, contentType, bytes: data.length });
      if (!options?.pdfToText) {
        log.warn(LOG_NAMESPACE_ARTICLE, "PDF parsing disabled; skipping", { url, contentType });
        return { md: "", sourceKind: "pdf" };
      }
      try {
        const text = await options.pdfToText(data, {
          maxPages: e.PDF_MAX_PAGES,
          softMaxBytes: e.PDF_MAX_BYTES,
        });
        log.debug(LOG_NAMESPACE_ARTICLE, "PDF parsed successfully", { url, textLength: text.length });
        return { md: text, sourceKind: "pdf" };
      } catch (error) {
        log.error(LOG_NAMESPACE_ARTICLE, "PDF parse failed", { url, error: String(error) });
        return { md: "", sourceKind: "pdf" };
      }
    }
    if (looksLikeHtml(contentType)) {
      log.debug(LOG_NAMESPACE_ARTICLE, "Processing HTML content", { url, contentType });
      const html = decodedHtml ?? decodeText(data, contentType);
      // Readability-extract the article before turndown; the extract-quality
      // detector (HTML-only, in getOrFetchArticleMarkdown) judges the result.
      return { md: extractArticleMd(html, url), sourceKind: "html" };
    }
    log.debug(LOG_NAMESPACE_ARTICLE, "Processing as plain text", { url, contentType });
    try {
      const text = decodeText(data, contentType);
      return { md: text.trim(), sourceKind: "text" };
    } catch (error) {
      log.warn(LOG_NAMESPACE_ARTICLE, "Text decode failed", { url, contentType, error: String(error) });
      return { md: "", sourceKind: "text" };
    }
  }

  log.debug("summarize/services", "initialized", {
    hasOpenRouterKey: !!e.OPENROUTER_API_KEY,
    model: e.OPENROUTER_MODEL,
  });

  return {
    http,
    openrouter,
    guardTagsClient,
    fetchArticleMarkdown,
    fetchArticleViaReader,
    usage,
    commentsTpdExhaustedModels: new Set<string>(),
  };
}

const TAGS_DEBUG_MESSAGE = "summarize/tags";

// Log namespaces
const LOG_NAMESPACE_LLM = "summarize/llm" as const;
const LOG_NAMESPACE_POST = "summarize/post" as const;
const LOG_NAMESPACE_COMMENTS = "summarize/comments" as const;
const LOG_NAMESPACE_ARTICLE = "summarize/article" as const;
const LOG_NAMESPACE_GUARD = "summarize/guard" as const;

type LlmLogContext = Record<string, unknown>;

type SummarizePostOptions = {
  strictSystem?: boolean;
  context?: LlmLogContext;
  /** Ordered model chain override; undefined → default primary/fallback chain. */
  models?: string[];
};

type PostSummaryValidated = {
  summary: string;
  modelUsed: string;
  guard?: SummaryGuardResult;
};

let telegramStreamConfigWarned = false;
let telegramLedgerCache: TelegramLedger | undefined;
let telegramStreamDisabledReason: string | undefined;

const POST_SUMMARY_ATTEMPTS: Array<{ label: string; strict: boolean }> = [
  { label: "initial", strict: false },
  { label: "strict-1", strict: true },
  { label: "strict-2", strict: true },
];

function ensureError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string") {
    return new Error(error);
  }
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

function parseHttpErrorJson(error: HttpError): unknown {
  const { message } = error;
  const firstSpace = message.indexOf(" ");
  if (firstSpace === -1) {
    return undefined;
  }
  const secondSpace = message.indexOf(" ", firstSpace + 1);
  if (secondSpace === -1) {
    return undefined;
  }
  const jsonPart = message.slice(secondSpace + 1).trim();
  if (!jsonPart) {
    return undefined;
  }
  try {
    return JSON.parse(jsonPart);
  } catch {
    return undefined;
  }
}

function parseRateLimitScope(message?: string): string | undefined {
  if (!message) {
    return undefined;
  }
  const trimmed = message.trim();
  const prefix = "Rate limit exceeded:";
  if (!trimmed.startsWith(prefix)) {
    return undefined;
  }
  return (
    trimmed
      .slice(prefix.length)
      .replace(/\.\s*$/u, "")
      .trim() || undefined
  );
}

function parseNumberish(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseResetHeader(value: unknown): number | undefined {
  const parsed = parseNumberish(value);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed > 1_000_000_000_000) {
    return Math.floor(parsed);
  }
  if (parsed > 0) {
    return Math.floor(parsed * 1000);
  }
  return undefined;
}

type RateLimitDetails = {
  scope?: string | undefined;
  limit?: number | undefined;
  remaining?: number | undefined;
  resetEpochMs?: number | undefined;
};

function extractRateLimitDetails(error: HttpError): RateLimitDetails | undefined {
  const json = parseHttpErrorJson(error);
  if (!json || typeof json !== "object") {
    return undefined;
  }
  const errorPayload = (json as { error?: unknown }).error;
  if (!errorPayload || typeof errorPayload !== "object") {
    return undefined;
  }
  const errorObj = errorPayload as { message?: unknown; metadata?: unknown };
  const { message, metadata } = errorObj;
  const headers = metadata && typeof metadata === "object" ? (metadata as { headers?: unknown }).headers : undefined;

  const headerRecord = headers && typeof headers === "object" ? (headers as Record<string, unknown>) : undefined;

  const limit = headerRecord ? parseNumberish(headerRecord["X-RateLimit-Limit"]) : undefined;
  const remaining = headerRecord ? parseNumberish(headerRecord["X-RateLimit-Remaining"]) : undefined;
  const resetEpochMs = headerRecord ? parseResetHeader(headerRecord["X-RateLimit-Reset"]) : undefined;

  const result: RateLimitDetails = {};
  if (typeof message === "string") {
    result.scope = parseRateLimitScope(message);
  }
  if (limit !== undefined) {
    result.limit = limit;
  }
  if (remaining !== undefined) {
    result.remaining = remaining;
  }
  if (resetEpochMs !== undefined) {
    result.resetEpochMs = resetEpochMs;
  }
  return result;
}

type RateLimitErrorInit = RateLimitDetails & {
  model: string;
};

export class RateLimitError extends Error {
  readonly model: string;
  readonly limitScope?: string | undefined;
  readonly limit?: number | undefined;
  readonly remaining?: number | undefined;
  readonly resetEpochMs?: number | undefined;

  constructor(init: RateLimitErrorInit, options?: { cause?: Error }) {
    const parts = ["OpenRouter rate limit hit"];
    if (init.model) {
      parts.push(`model ${init.model}`);
    }
    if (init.scope) {
      parts.push(`(${init.scope})`);
    }
    super(parts.join(" "), options);
    this.name = "RateLimitError";
    this.model = init.model;
    this.limitScope = init.scope ?? undefined;
    this.limit = init.limit ?? undefined;
    this.remaining = init.remaining ?? undefined;
    this.resetEpochMs = init.resetEpochMs ?? undefined;
  }

  get retryDate(): Date | undefined {
    return typeof this.resetEpochMs === "number" ? new Date(this.resetEpochMs) : undefined;
  }

  toLogMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: this.model,
      limitScope: this.limitScope,
      limit: this.limit,
      remaining: this.remaining,
      retryISO: this.retryDate?.toISOString(),
      resetEpochMs: this.resetEpochMs,
      ...extra,
    };
  }
}

class LlmCallError extends Error {
  readonly attempt: "fallback" | "primary";
  readonly model: string;
  readonly context: LlmLogContext;

  constructor(attempt: "fallback" | "primary", model: string, context: LlmLogContext, options: { cause: Error }) {
    super(`OpenRouter ${attempt} call failed for model ${model}`, options);
    this.name = "LlmCallError";
    this.attempt = attempt;
    this.model = model;
    this.context = context;
  }

  describe(): string {
    const causeMessage = this.cause instanceof Error ? this.cause.message : undefined;
    return causeMessage ? `${this.message}: ${causeMessage}` : this.message;
  }

  toError(): Error {
    return this.cause instanceof Error ? this.cause : this;
  }

  toLogMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: this.model,
      attempt: this.attempt,
      ...this.context,
      error: this.cause instanceof Error ? this.cause.message : this.message,
      ...extra,
    };
  }
}

async function hashString(s: string): Promise<string> {
  return await sha256Hex(s);
}

type ExtractDetectorPolicy = Pick<
  Env,
  "EXTRACT_MAX_DUP_RATIO" | "EXTRACT_MAX_LINK_DENSITY" | "EXTRACT_MIN_PROSE_CHARS"
>;

/**
 * Input hash for a post summary. Includes both the code policy version and the
 * runtime detector thresholds: changing a verdict must also replace the current
 * summary/stub. Keep the inputs identical in processing and pre-selection.
 */
async function postInputHash(
  lang: string,
  articleSlice: string,
  detectorPolicy: ExtractDetectorPolicy
): Promise<string> {
  const detectorFingerprint = [
    detectorPolicy.EXTRACT_MIN_PROSE_CHARS,
    detectorPolicy.EXTRACT_MAX_LINK_DENSITY,
    detectorPolicy.EXTRACT_MAX_DUP_RATIO,
  ].join("|");
  return await hashString(`${lang}|${EXTRACT_POLICY_VERSION}|${detectorFingerprint}|${articleSlice}`);
}

function buildPostSystemInstruction(strict?: boolean): string {
  const isStrict = strict === true;
  if (env.SUMMARY_LANG === "en") {
    const base = [
      "You craft tight and concise Hacker News article distillations in Markdown. In English.",
      "Aim for roughly 170 words across two short paragraphs; add a third only if it truly helps.",
      "Spotlight the core idea plus one or two vivid facts, quotes, or numbers readers should remember.",
      "Skip titles, bylines, publication dates, and source attributions.",
      "Begin directly—no headings like 'Summary:' and no closing sign-offs.",
      "Important: mention all the key information from the article, don't lose it. Be precise and concise.",
    ];
    if (isStrict) {
      base.push(
        "Never apologise, mention policies, or refuse the task.",
        "If the source lacks detail, state the concrete facts that do exist; do not speculate or say the article is unavailable.",
        "Do not reference yourself or the request."
      );
    }
    return base.join("\n");
  }

  const base = [
    "Ты пишешь точные и ёмкие пересказы статей Hacker News в Markdown на русском языке.",
    "Пиши только по-русски: латиница допустима лишь для имён собственных, названий продуктов, терминов в кавычках и кода — не вставляй английские слова и фразы в связный русский текст.",
    "Стремись к ~170 словам в двух коротких абзацах; третий добавляй только если он действительно помогает.",
    "Выделяй главную идею и пару ярких фактов, цитат или цифр, которые стоит запомнить.",
    "Не называй заголовок, автора, дату публикации и источники.",
    "Начинай сразу с сути, без заголовков вроде 'Саммари:' и без финальных клише.",
    "Важно: упоминай всю ключевую информацию из статьи, не теряй её. Будь точен и лаконичен.",
  ];
  if (isStrict) {
    base.push(
      "Никаких отказов, извинений или упоминаний политик.",
      "Никогда не переходи на английский: весь связный текст — на русском.",
      "Если в материале мало деталей, перескажи то, что есть, и укажи ключевые факты.",
      "Не упоминай себя и само задание."
    );
  }
  return base.join("\n");
}

function buildCommentsSystemInstruction(): string {
  if (env.SUMMARY_LANG === "en") {
    return "You summarize Hacker News discussions in Markdown, in English. Always write in English.";
  }
  return [
    "Ты кратко пересказываешь обсуждения Hacker News в Markdown на русском языке.",
    "Пиши только по-русски, даже если все комментарии на английском. Никогда не переходи на английский.",
  ].join("\n");
}

function buildCommentsLanguageHeader(): string {
  if (env.SUMMARY_LANG === "en") {
    return (
      "Language: en\n" +
      // Style guardrails to avoid chatty prefaces
      "Summarize the discussion as 5–7 concise bullet points.\n" +
      "Output must be a markdown bullet list only, starting immediately with '- '.\n" +
      "Do not add any introductions, headings, prefaces, phrases like 'Summary:', 'Key takeaways:', or closing sentences.\n" +
      "No extra text before or after the list."
    );
  }
  return (
    "Language: ru\n" +
    "Суммаризируй обсуждение в 3-5 лаконичных буллетах.\n" +
    "Выводи только маркированный список в Markdown, сразу начинай с '- '.\n" +
    "Без вступлений, заголовков и фраз вида 'Саммари:', 'Основные тезисы обсуждения:', 'Вот саммари обсуждения:', и без заключений.\n" +
    "Никакого дополнительного текста до или после списка."
  );
}

export async function buildPostPrompt(story: NormalizedStory, articleMd?: string): Promise<string> {
  const content = (articleMd ?? "").trim();
  if (!content) {
    log.warn(LOG_NAMESPACE_POST, "No article content – skipping post prompt", { id: story.id });
    return "";
  }
  const { ARTICLE_SLICE_CHARS, ARTICLE_HEAD_CHARS } = env;
  if (content.length <= ARTICLE_SLICE_CHARS) {
    log.debug(LOG_NAMESPACE_POST, "Built post prompt", { id: story.id, promptChars: content.length });
    return content;
  }
  // Long article: keep the head plus a tail so conclusions survive the slice.
  // Clamp head to the total budget so ARTICLE_SLICE_CHARS stays the hard ceiling
  // even when ARTICLE_HEAD_CHARS is misconfigured larger than it.
  const headChars = Math.min(ARTICLE_HEAD_CHARS, ARTICLE_SLICE_CHARS);
  const tailChars = ARTICLE_SLICE_CHARS - headChars;
  const head = content.slice(0, headChars);
  const articleSlice = tailChars === 0 ? head : `${head}\n\n[…]\n\n${content.slice(content.length - tailChars)}`;
  log.debug(LOG_NAMESPACE_POST, "Built post prompt (head+tail)", {
    id: story.id,
    promptChars: articleSlice.length,
    headChars: head.length,
    tailChars,
  });
  return articleSlice;
}

export async function buildCommentsPrompt(
  comments: NormalizedComment[]
): Promise<{ prompt: string; sampleIds: number[] }> {
  const header = buildCommentsLanguageHeader();
  const { OPENROUTER_MAX_TOKENS } = env;
  let budget = 6 * OPENROUTER_MAX_TOKENS;
  const lines: string[] = [];
  for (const c of comments) {
    const { textPlain, by, depth } = c;
    const text = textPlain ? textPlain.replaceAll(/\s+/gu, " ").trim() : "";
    if (!text) {
      continue;
    }
    const line = `@${by} [d${depth}] ${text.slice(0, 400)}`;
    const cost = line.length + 1;
    if (budget - cost < 0) {
      break;
    }
    lines.push(line);
    budget -= cost;
  }
  const sampleIds = comments
    .filter((c) => {
      const { textPlain } = c;
      return Boolean(textPlain.trim());
    })
    .slice(0, 5)
    .map((c) => c.id);
  const prompt = [header, ...lines].join("\n");
  log.debug(LOG_NAMESPACE_COMMENTS, "Built comments prompt", { count: comments.length, promptChars: prompt.length });
  return { prompt, sampleIds };
}

export function preserveMarkdownWhitespace(content: string): string {
  const normalized = content ? content.replaceAll(/\r\n?/gu, "\n") : "";
  const lines = normalized.split("\n");
  const outLines: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      outLines.push(line);
      continue;
    }

    if (inCodeBlock) {
      outLines.push(line);
    } else {
      const body = line.trimEnd();
      const trailing = line.slice(body.length);

      if (trailing.length > 2) {
        outLines.push(`${body}  `); // Trim to 2
      } else {
        outLines.push(line); // Keep as is if <= 2
      }
    }
  }
  return outLines.join("\n");
}

const LLM_ARTIFACT_BEGIN_OF_SENTENCE = "<｜begin▁of▁sentence｜>";

export function sanitizeLlmContent(content: string): string {
  const preserved = preserveMarkdownWhitespace(content);
  const withoutArtifacts = preserved.replaceAll(LLM_ARTIFACT_BEGIN_OF_SENTENCE, "");
  return withoutArtifacts.trim();
}

type LlmResult = { content: string; modelUsed: string };

function classifyOpenRouterError(
  error: unknown,
  attempt: "fallback" | "primary",
  model: string,
  context: LlmLogContext
): LlmCallError | RateLimitError {
  if (error instanceof RateLimitError) {
    return error;
  }

  const httpError = error instanceof HttpError ? error : undefined;
  if (httpError && httpError.status === 429) {
    const details = extractRateLimitDetails(httpError) ?? {};
    return new RateLimitError({ model, ...details }, { cause: ensureError(error) });
  }

  if (error instanceof Error && /HTTP\s+429/u.test(error.message)) {
    return new RateLimitError({ model }, { cause: ensureError(error) });
  }

  return new LlmCallError(attempt, model, context, { cause: ensureError(error) });
}

async function callOpenRouterAttempt(
  services: Services,
  messages: ChatMessage[],
  model: string,
  attempt: "fallback" | "primary",
  context: LlmLogContext,
  label: string
): Promise<LlmResult> {
  const logContext = { model, ...context };
  const logMessage = attempt === "primary" ? "Calling LLM" : "Calling fallback LLM";
  log.info(LOG_NAMESPACE_LLM, logMessage, logContext);
  try {
    const content = await services.openrouter.chat(messages, {
      temperature: 0.3,
      maxTokens: env.OPENROUTER_MAX_TOKENS,
      model,
      label,
    });
    const cleaned = sanitizeLlmContent(content);
    if (attempt === "primary") {
      log.debug(LOG_NAMESPACE_LLM, "LLM response received", {
        summaryChars: cleaned.length,
        ...logContext,
      });
    } else {
      log.info(LOG_NAMESPACE_LLM, "Fallback LLM response received", {
        summaryChars: cleaned.length,
        ...logContext,
      });
    }
    return { content: cleaned, modelUsed: model };
  } catch (rawError) {
    throw classifyOpenRouterError(rawError, attempt, model, context);
  }
}

/** Default production chain: primary, then the two configured fallbacks. */
function defaultModelChain(): string[] {
  return [env.OPENROUTER_MODEL, env.OPENROUTER_FALLBACK_MODEL, env.OPENROUTER_FALLBACK_MODEL_2];
}

async function callOpenRouterWithRetry(
  services: Services,
  messages: ChatMessage[],
  context: LlmLogContext,
  label: string,
  models?: string[]
): Promise<LlmResult> {
  const chain = models === undefined || models.length === 0 ? defaultModelChain() : models;
  const failures: Array<LlmCallError | RateLimitError> = [];

  for (const [index, model] of chain.entries()) {
    const attempt = index === 0 ? "primary" : "fallback";
    try {
      return await callOpenRouterAttempt(services, messages, model, attempt, context, label);
    } catch (error) {
      if (!(error instanceof RateLimitError) && !(error instanceof LlmCallError)) {
        throw error;
      }
      failures.push(error);
      const nextModel = chain[index + 1];
      if (nextModel !== undefined) {
        if (error instanceof RateLimitError) {
          log.warn(LOG_NAMESPACE_LLM, "Rate limit on model; trying next in chain", {
            model,
            next: nextModel,
            chain,
            ...error.toLogMeta(context),
          });
        } else {
          log.warn(LOG_NAMESPACE_LLM, "Model failed; trying next in chain", {
            model,
            next: nextModel,
            chain,
            ...context,
            error: error.cause instanceof Error ? error.cause.message : error.message,
          });
        }
        continue;
      }

      if (error instanceof RateLimitError) {
        log.error(LOG_NAMESPACE_LLM, "Rate limit on all models", {
          chain,
          ...error.toLogMeta(context),
        });
        throw error;
      }
      log.error(LOG_NAMESPACE_LLM, "All models failed", {
        chain,
        ...context,
        errors: failures.map((failure) =>
          failure instanceof LlmCallError ? failure.describe() : failure.message
        ),
      });
      throw new AggregateError(
        failures.map((failure) => (failure instanceof LlmCallError ? failure.toError() : failure)),
        `LLM call failed for models: ${chain.join(", ")}`
      );
    }
  }

  throw new Error("Model chain is empty");
}

async function callLLMWithMessages(
  services: Services,
  messages: ChatMessage[],
  context: LlmLogContext = {},
  label: string,
  models?: string[]
): Promise<LlmResult> {
  const ctx: LlmLogContext = { messages: messages.length, ...context };
  return await callOpenRouterWithRetry(services, messages, ctx, label, models);
}

export function buildPostChatMessages(articleSlice: string, options: { strict?: boolean } = {}): ChatMessage[] {
  const system = buildPostSystemInstruction(options.strict ?? false);
  return [
    { role: "system", content: system },
    { role: "user", content: articleSlice },
  ];
}

export async function summarizePost(
  services: Services,
  story: NormalizedStory,
  articleSlice: string,
  options: SummarizePostOptions = {}
): Promise<Pick<PostSummary, "id" | "lang" | "model" | "summary">> {
  const messages = buildPostChatMessages(articleSlice, { strict: options.strictSystem ?? false });
  const context: LlmLogContext = { ...(options.context ?? {}) };
  if (options.strictSystem !== undefined) {
    context["strict"] = options.strictSystem;
  }
  const { content, modelUsed } = await callLLMWithMessages(services, messages, context, "post", options.models);
  return { id: story.id, lang: env.SUMMARY_LANG, summary: content, model: modelUsed };
}

export async function generateValidatedPostSummary(
  services: Services,
  story: NormalizedStory,
  articleSlice: string
): Promise<PostSummaryValidated | undefined> {
  const lang = env.SUMMARY_LANG;
  const attemptContextBase = { storyId: story.id };

  // Content-reject escalation: when explicitly configured, strict retries start from a
  // separately validated model instead of the primary that produced the rejected draft.
  // Empty config safely preserves the default chain. Applies to heuristic and guard rejects.
  const escalationModel = env.SUMMARY_CONTENT_REJECT_MODEL.trim();
  const escalationChain =
    escalationModel.length > 0 ? [escalationModel, env.OPENROUTER_FALLBACK_MODEL] : undefined;

  for (const attempt of POST_SUMMARY_ATTEMPTS) {
    try {
      const summaryContent = await summarizePost(services, story, articleSlice, {
        strictSystem: attempt.strict,
        context: { ...attemptContextBase, attempt: attempt.label },
        ...(attempt.strict && escalationChain !== undefined ? { models: escalationChain } : {}),
      });

      const heuristics = checkSummaryHeuristics(summaryContent.summary, {
        minChars: env.POST_SUMMARY_MIN_CHARS,
        language: lang,
        kind: "post",
        languageGate: languageGateFromEnv(env),
      });

      if (!heuristics.ok) {
        log.warn(LOG_NAMESPACE_GUARD, "Heuristic check failed", {
          id: story.id,
          attempt: attempt.label,
          triggers: heuristics.triggers,
        });
        continue;
      }

      let guardResult: SummaryGuardResult | undefined;
      if (env.POST_GUARD_ENABLE) {
        const guardModels = [env.POST_GUARD_MODEL, env.POST_GUARD_FALLBACK_MODEL].filter(
          (model, idx, arr) => model && arr.indexOf(model) === idx
        );

        for (const guardModel of guardModels) {
          try {
            guardResult = await runSummaryGuard(services.guardTagsClient, {
              summary: summaryContent.summary,
              articleSlice,
              envLike: {
                SUMMARY_LANG: lang,
                POST_GUARD_MODEL: guardModel,
                POST_GUARD_MAX_TOKENS: env.POST_GUARD_MAX_TOKENS,
                POST_GUARD_MIN_CONFIDENCE: env.POST_GUARD_MIN_CONFIDENCE,
                POST_GUARD_ARTICLE_MAX_CHARS: env.POST_GUARD_ARTICLE_MAX_CHARS,
              },
            });
            break;
          } catch (error) {
            log.error(LOG_NAMESPACE_GUARD, "Guard call failed", {
              id: story.id,
              attempt: attempt.label,
              guardModel,
              error: String(error),
            });
          }
        }

        if (guardResult === undefined) {
          log.warn(LOG_NAMESPACE_GUARD, "Guard unavailable; accepting heuristics-only summary", {
            id: story.id,
            attempt: attempt.label,
            guardModels,
          });
        }

        if (guardResult !== undefined && !guardResult.ok) {
          log.warn(LOG_NAMESPACE_GUARD, "Guard rejected summary", {
            id: story.id,
            attempt: attempt.label,
            verdict: guardResult.verdict,
            reasons: guardResult.reasons,
            confidence: guardResult.confidence,
          });
          continue;
        }
      }

      return {
        summary: summaryContent.summary,
        modelUsed: summaryContent.model ?? env.OPENROUTER_MODEL,
        ...(guardResult !== undefined && { guard: guardResult }),
      };
    } catch (error) {
      log.error(LOG_NAMESPACE_POST, "Post summary attempt failed", {
        id: story.id,
        attempt: attempt.label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.error(LOG_NAMESPACE_GUARD, "Exhausted summary attempts; skipping", { id: story.id });
  return undefined;
}

export async function summarizeComments(
  services: Services,
  storyId: number,
  prompt: string,
  sampleIds: number[] = [],
  options: { models?: string[]; context?: LlmLogContext } = {}
): Promise<Pick<CommentsSummary, "id" | "lang" | "model" | "sampleComments" | "summary">> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildCommentsSystemInstruction() },
    { role: "user", content: prompt },
  ];
  const { content, modelUsed } = await callLLMWithMessages(
    services,
    messages,
    options.context ?? {},
    "comments",
    options.models
  );
  return {
    id: storyId,
    lang: env.SUMMARY_LANG,
    summary: content,
    sampleComments: sampleIds,
    model: modelUsed,
  };
}

const HEURISTIC_REJECTION_WEIGHTS: Readonly<Record<string, number>> = {
  empty: 1000,
  refusal: 800,
  policy: 800,
  content_free: 700,
  artifact: 600,
  prompt_instructions: 600,
  low_cyrillic_ratio: 500,
  url_encoded_noise: 400,
  bare_bullets: 300,
  repetition_run: 300,
  low_unique_ratio: 250,
  contains_url: 200,
  latin_prose: 150,
  numeric_headings: 150,
  generic: 100,
  meta_instructions: 100,
  too_short: 75,
  too_few_words: 50,
  bullets_only: 50,
};

/** Lower is better; zero is a valid summary. Used only when both comment attempts fail. */
function heuristicRejectionScore(verdict: ReturnType<typeof checkSummaryHeuristics>): number {
  return verdict.triggers.reduce(
    (score, trigger) => score + (HEURISTIC_REJECTION_WEIGHTS[trigger.reason] ?? 100),
    0
  );
}

/**
 * Comments summary with content validation and a single escalated retry.
 * The first call keeps the default model chain untouched; on a heuristics reject
 * (language gate, refusal, artifacts, ...) one retry runs, starting from
 * SUMMARY_CONTENT_REJECT_MODEL when configured. A summary is never dropped:
 * if the retry is also rejected (or errors), the best available text is kept.
 */
export async function generateValidatedCommentsSummary(
  services: Services,
  storyId: number,
  prompt: string,
  sampleIds: number[] = []
): Promise<Pick<CommentsSummary, "id" | "lang" | "model" | "sampleComments" | "summary">> {
  const checkOptions = {
    minChars: env.POST_SUMMARY_MIN_CHARS,
    language: env.SUMMARY_LANG,
    kind: "comments" as const,
    languageGate: languageGateFromEnv(env),
  };

  const first = await summarizeComments(services, storyId, prompt, sampleIds);
  const firstCheck = checkSummaryHeuristics(first.summary, checkOptions);
  if (firstCheck.ok) {
    return first;
  }

  log.warn(LOG_NAMESPACE_COMMENTS, "Comments heuristic check failed; retrying with escalation", {
    id: storyId,
    triggers: firstCheck.triggers,
  });

  const escalationModel = env.SUMMARY_CONTENT_REJECT_MODEL.trim();
  const models = escalationModel.length > 0 ? [escalationModel, env.OPENROUTER_FALLBACK_MODEL] : undefined;
  let retry: Awaited<ReturnType<typeof summarizeComments>>;
  try {
    retry = await summarizeComments(services, storyId, prompt, sampleIds, {
      ...(models === undefined ? {} : { models }),
      context: { attempt: "comments-retry" },
    });
  } catch (error) {
    log.error(LOG_NAMESPACE_COMMENTS, "Comments retry failed; keeping first summary", {
      id: storyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return first;
  }

  const retryCheck = checkSummaryHeuristics(retry.summary, checkOptions);
  if (retryCheck.ok) {
    return retry;
  }

  const firstScore = heuristicRejectionScore(firstCheck);
  const retryScore = heuristicRejectionScore(retryCheck);
  const keepRetry = retryScore < firstScore;
  log.warn(LOG_NAMESPACE_COMMENTS, "Comments retry still flagged; keeping less severe result", {
    id: storyId,
    firstScore,
    retryScore,
    selected: keepRetry ? "retry" : "first",
    firstTriggers: firstCheck.triggers,
    retryTriggers: retryCheck.triggers,
  });
  return keepRetry ? retry : first;
}

const COMMENTS_DEADLINE_BUFFER_MS = 250;

export type CommentsGenerationBudgetOptions = {
  deadlineAt?: number;
  maxCalls?: number;
  now?: () => number;
  requestTimeoutMs?: number;
};

/** A single budget shared by every physical comments-v2 request. */
export class CommentsGenerationBudget {
  readonly maxCalls: number;
  private readonly deadlineAt: number | undefined;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private used: number;

  constructor(options: CommentsGenerationBudgetOptions = {}) {
    this.used = 0;
    this.maxCalls = options.maxCalls ?? env.COMMENTS_MAX_LLM_CALLS;
    this.deadlineAt = options.deadlineAt;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? env.COMMENTS_LLM_REQUEST_TIMEOUT_MS;
  }

  get callsUsed(): number {
    return this.used;
  }

  claimRequestTimeoutMs(): number | undefined {
    if (this.used >= this.maxCalls) {
      return undefined;
    }
    let timeoutMs = this.requestTimeoutMs;
    if (this.deadlineAt !== undefined) {
      const availableMs = this.deadlineAt - this.now() - COMMENTS_DEADLINE_BUFFER_MS;
      if (availableMs < 1000) {
        return undefined;
      }
      timeoutMs = Math.min(timeoutMs, availableMs);
    }
    this.used += 1;
    return Math.max(1, Math.floor(timeoutMs));
  }
}

export type PreparedCommentsPromptV2 = ReturnType<typeof buildCommentsPromptV2>;

export type ValidatedCommentsSummaryV2 = {
  insights: CommentsInsights;
  modelUsed: string;
  prompt: string;
  sampleIds: number[];
  summary: string;
};

export type GenerateCommentsSummaryV2Input = {
  budget?: CommentsGenerationBudget;
  comments: NormalizedComment[];
  deadlineAt?: number;
  postSummary?: Pick<PostSummary, "degraded" | "summary">;
  prepared?: PreparedCommentsPromptV2;
  story: Pick<NormalizedStory, "id" | "title">;
};

function commentsV2Messages(prompt: string, strict: boolean, maxInsights: number): ChatMessage[] {
  const strictInstruction =
    env.SUMMARY_LANG === "ru"
      ? "Строго соблюдай JSON-схему, не отказывайся от анализа и не добавляй вымышленных фактов."
      : "Follow the JSON schema exactly, do not refuse the analysis, and do not invent facts.";
  const system = [
    buildCommentsSystemInstructionV2(env.SUMMARY_LANG, maxInsights),
    ...(strict ? [strictInstruction] : []),
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];
}

function validateCommentsInsightsCandidate(
  insights: CommentsInsights,
  comments: NormalizedComment[],
  sampleIds: number[],
  maxInsights: number
): { insights: CommentsInsights; summary: string } | undefined {
  // Quote decision first: best_quote is optional, so a provenance miss drops the
  // quote and keeps the summary. Heuristics re-run on the quote-less text because
  // they include best_quote.translation when present.
  let effective: CommentsInsights = insights;
  if (insights.best_quote !== null) {
    const quote = validateCommentsQuote(insights, comments);
    if (quote === undefined || !sampleIds.includes(quote.commentId)) {
      log.warn(LOG_NAMESPACE_COMMENTS, "Comments-v2 quote failed provenance; dropped quote, keeping summary", {
        commentId: insights.best_quote.comment_id,
      });
      effective = { ...insights, best_quote: null };
    }
  }

  // maxInsights already comes from commentsInsightsCeiling (≤ hard ceiling).
  const sliceTo = maxInsights;
  if (effective.insights.length > sliceTo) {
    log.warn(LOG_NAMESPACE_COMMENTS, "Comments-v2 insights over ceiling; slicing", {
      produced: effective.insights.length,
      sliceTo,
      hardCeiling: COMMENTS_INSIGHTS_HARD_CEILING,
    });
    effective = { ...effective, insights: effective.insights.slice(0, sliceTo) };
  }

  const heuristics = checkCommentsInsightsHeuristics(effective, {
    language: env.SUMMARY_LANG,
    minCyrillicRatio: env.COMMENTS_MIN_CYRILLIC_RATIO,
  });
  if (!heuristics.ok) {
    log.warn(LOG_NAMESPACE_COMMENTS, "Comments-v2 insights failed heuristics", {
      triggers: heuristics.triggers,
    });
    return undefined;
  }

  const summary = renderCommentsSummaryMarkdown(effective, {
    language: env.SUMMARY_LANG,
    comments,
  });
  if (summary.trim().length < env.COMMENTS_SUMMARY_MIN_CHARS) {
    log.warn(LOG_NAMESPACE_COMMENTS, "Comments-v2 rendered summary is too short", {
      chars: summary.trim().length,
      minimum: env.COMMENTS_SUMMARY_MIN_CHARS,
    });
    return undefined;
  }
  return { insights: effective, summary };
}

function hasHttpErrorCause(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    if (current instanceof HttpError) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function findHttpErrorCause(error: unknown): HttpError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    if (current instanceof HttpError) {
      return current;
    }
    current = current.cause;
  }
  return undefined;
}

/** Deterministic prompt-size estimate used for free-route selection (no tokenizer). */
export function estimateCommentsPromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}

/**
 * True only for a proven Groq tokens-per-day exhaustion signal.
 * TPM 429 / bare 429 / timeout / transport must NOT match — those stay retryable.
 */
export function isGroqTpdExhaustionError(error: unknown): boolean {
  const httpError = findHttpErrorCause(error);
  if (httpError?.status !== 429) {
    return false;
  }
  const parts = [httpError.message, error instanceof Error ? error.message : String(error)];
  const blob = parts.join(" ").toLowerCase();
  return blob.includes("tokens per day") || blob.includes("(tpd)") || /\btpd\b/u.test(blob);
}

export type CommentsSecondaryRouteKind = "large-skip" | "legacy" | "medium-qwen" | "short-8b";

export type CommentsSecondaryRouteDecision = {
  estimateTokens: number;
  kind: CommentsSecondaryRouteKind;
  model: string;
  reason: string;
  reservedTokens: number;
};

/**
 * Pure secondary free-route picker (after primary 70b). Flag off → legacy 8b hop.
 * Flag on → short→8b, medium→Qwen 27b, large→skip both (paid hop still available later).
 */
export function selectCommentsSecondaryRoute(input: {
  enableQwen27b: boolean;
  estimateTokens: number;
  fallbackModel: string;
  maxOutputTokens: number;
  qwen27bMaxReservedTokens: number;
  qwen27bModel: string;
  shortMaxReservedTokens: number;
  tpdExhaustedModels?: ReadonlySet<string>;
}): CommentsSecondaryRouteDecision {
  const reservedTokens = input.estimateTokens + input.maxOutputTokens;
  const exhausted = input.tpdExhaustedModels ?? new Set<string>();

  if (!input.enableQwen27b) {
    const model = input.fallbackModel.trim();
    return {
      estimateTokens: input.estimateTokens,
      kind: "legacy",
      model,
      reason: model.length === 0 ? "legacy-fallback-empty" : "flag-off-legacy-8b",
      reservedTokens,
    };
  }

  if (reservedTokens < input.shortMaxReservedTokens) {
    const model = input.fallbackModel.trim();
    if (model.length === 0 || exhausted.has(model)) {
      return {
        estimateTokens: input.estimateTokens,
        kind: "large-skip",
        model: "",
        reason: model.length === 0 ? "short-8b-empty" : "short-8b-tpd-exhausted",
        reservedTokens,
      };
    }
    return {
      estimateTokens: input.estimateTokens,
      kind: "short-8b",
      model,
      reason: "short-reserved-under-cap",
      reservedTokens,
    };
  }

  if (reservedTokens <= input.qwen27bMaxReservedTokens) {
    const model = input.qwen27bModel.trim();
    if (model.length === 0 || exhausted.has(model)) {
      return {
        estimateTokens: input.estimateTokens,
        kind: "large-skip",
        model: "",
        reason: model.length === 0 ? "medium-qwen-empty" : "medium-qwen-tpd-exhausted",
        reservedTokens,
      };
    }
    return {
      estimateTokens: input.estimateTokens,
      kind: "medium-qwen",
      model,
      reason: "medium-reserved-fits-qwen",
      reservedTokens,
    };
  }

  return {
    estimateTokens: input.estimateTokens,
    kind: "large-skip",
    model: "",
    reason: "reserved-over-qwen-cap",
    reservedTokens,
  };
}

type CommentsChainStep = {
  client: OpenRouter;
  model: string;
  prefersResponseFormat: boolean;
  /** Groq Qwen3.6 needs reasoning_effort=none or the budget burns inside <think>. */
  reasoningEffort?: "high" | "low" | "medium" | "none";
  /** When true, a proven TPD 429 on this step is recorded on services.commentsTpdExhaustedModels. */
  trackTpdExhaustion: boolean;
};

function buildCommentsModelChain(
  services: Services,
  prompt: string
): { decision: CommentsSecondaryRouteDecision | undefined; steps: CommentsChainStep[] } {
  // Route comments through the Groq client when one exists: it returns reliable
  // non-reasoning JSON, unlike the OpenRouter reasoning models that share the post
  // chain and emit prose instead of JSON. makeServices only builds a distinct
  // guardTagsClient when GROQ_API_KEY is set; otherwise it is the OpenRouter client
  // and we keep the legacy chain, so local/dev and no-Groq deployments still work.
  // Deriving this from the injected client (not ambient env) keeps callers testable.
  const groqEnabled = services.guardTagsClient !== services.openrouter;
  const groqBaseUrl = env.GROQ_BASE_URL;
  const openRouterBaseUrl = env.OPENROUTER_BASE_URL ?? "";

  const steps: CommentsChainStep[] = [];
  const seenSteps = new Set<string>();
  const pushStep = (
    stepClient: OpenRouter,
    model: string,
    stepBaseUrl: string,
    prefersResponseFormat: boolean,
    options?: { reasoningEffort?: CommentsChainStep["reasoningEffort"]; trackTpdExhaustion?: boolean }
  ): void => {
    const trimmed = model.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (services.commentsTpdExhaustedModels?.has(trimmed) === true) {
      log.info(LOG_NAMESPACE_COMMENTS, "Comments-v2 skipping TPD-exhausted model", { model: trimmed });
      return;
    }
    const key = `${stepBaseUrl}::${trimmed}`;
    if (seenSteps.has(key)) {
      return;
    }
    seenSteps.add(key);
    steps.push({
      client: stepClient,
      model: trimmed,
      prefersResponseFormat,
      trackTpdExhaustion: options?.trackTpdExhaustion === true,
      ...(options?.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    });
  };

  let decision: CommentsSecondaryRouteDecision | undefined;

  if (groqEnabled) {
    // Primary high-value hop always stays 70b (flag does not touch it).
    pushStep(services.guardTagsClient, env.COMMENTS_MODEL, groqBaseUrl, false, { trackTpdExhaustion: true });

    const estimateTokens = estimateCommentsPromptTokens(prompt);
    decision = selectCommentsSecondaryRoute({
      enableQwen27b: env.COMMENTS_QWEN27B_ROUTE_ENABLE,
      estimateTokens,
      fallbackModel: env.COMMENTS_FALLBACK_MODEL,
      maxOutputTokens: env.COMMENTS_SUMMARY_MAX_TOKENS,
      qwen27bMaxReservedTokens: env.COMMENTS_QWEN27B_MAX_RESERVED_TOKENS,
      qwen27bModel: env.COMMENTS_QWEN27B_MODEL,
      shortMaxReservedTokens: env.COMMENTS_SHORT_ROUTE_MAX_RESERVED_TOKENS,
      ...(services.commentsTpdExhaustedModels === undefined
        ? {}
        : { tpdExhaustedModels: services.commentsTpdExhaustedModels }),
    });

    if (decision.kind === "legacy") {
      // Flag off: preserve the historical ordered list (fallback + optional fallback_2).
      for (const model of [env.COMMENTS_FALLBACK_MODEL, env.COMMENTS_FALLBACK_MODEL_2]) {
        pushStep(services.guardTagsClient, model, groqBaseUrl, false, { trackTpdExhaustion: true });
      }
    } else if (decision.model.length > 0) {
      pushStep(services.guardTagsClient, decision.model, groqBaseUrl, false, {
        trackTpdExhaustion: true,
        ...(decision.kind === "medium-qwen" ? { reasoningEffort: "none" as const } : {}),
      });
    }

    log.info(LOG_NAMESPACE_COMMENTS, "Comments-v2 secondary route selected", {
      kind: decision.kind,
      reason: decision.reason,
      model: decision.model.length > 0 ? decision.model : undefined,
      estimateTokens: decision.estimateTokens,
      reservedTokens: decision.reservedTokens,
      qwenRouteEnabled: env.COMMENTS_QWEN27B_ROUTE_ENABLE,
    });

    // Paid OpenRouter last resort — timing/SLA intentionally unchanged in this scaffold.
    pushStep(services.openrouter, env.COMMENTS_OPENROUTER_FALLBACK_MODEL, openRouterBaseUrl, true);
  } else {
    for (const model of [env.OPENROUTER_MODEL, env.OPENROUTER_FALLBACK_MODEL, env.OPENROUTER_FALLBACK_MODEL_2]) {
      pushStep(services.openrouter, model, openRouterBaseUrl, true);
    }
  }

  return { decision, steps };
}

export async function callStructuredWithModelChain(
  services: Services,
  input: {
    budget: CommentsGenerationBudget;
    comments: NormalizedComment[];
    maxInsights: number;
    prompt: string;
    sampleIds: number[];
  }
): Promise<{ insights: CommentsInsights; modelUsed: string; summary: string } | undefined> {
  const { steps } = buildCommentsModelChain(services, input.prompt);

  let stepIndex = 0;
  let strict = false;
  // Provider-derived per step: Groq llama rejects json_schema (400) and a same-model
  // no-format retry would burn a second physical call against COMMENTS_MAX_LLM_CALLS.
  // Start Groq on balanced-object; OpenRouter (Qwen) keeps strict json_schema.
  // UnsupportedResponseFormat may still flip the flag off for a same-model retry on
  // non-Groq providers that advertise schema support incorrectly.
  let useResponseFormat = steps[0]?.prefersResponseFormat ?? false;

  const moveToFallback = (): boolean => {
    stepIndex += 1;
    strict = true;
    const next = steps[stepIndex];
    useResponseFormat = next?.prefersResponseFormat ?? false;
    return next !== undefined;
  };

  while (stepIndex < steps.length) {
    const step = steps[stepIndex];
    if (step === undefined) {
      return undefined;
    }
    const { client, model, reasoningEffort, trackTpdExhaustion } = step;

    const requestTimeoutMs = input.budget.claimRequestTimeoutMs();
    if (requestTimeoutMs === undefined) {
      log.warn(LOG_NAMESPACE_COMMENTS, "Comments-v2 request budget or deadline exhausted", {
        callsUsed: input.budget.callsUsed,
        maxCalls: input.budget.maxCalls,
      });
      return undefined;
    }

    try {
      const insights = await client.chatStructured(
        commentsV2Messages(input.prompt, strict, input.maxInsights),
        {
          temperature: 0.2,
          maxTokens: env.COMMENTS_SUMMARY_MAX_TOKENS,
          model,
          label: "comments",
          jsonExtraction: useResponseFormat ? "strict" : "balanced-object",
          transportRetries: 0,
          requestTimeoutMs,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(useResponseFormat
            ? {
                signalUnsupportedResponseFormat: true,
                responseFormat: {
                  type: "json_schema" as const,
                  json_schema: {
                    name: "comments_insights_v2",
                    strict: true,
                    schema: CommentsInsightsJsonSchema as unknown as JsonSchema,
                  },
                },
              }
            : {}),
        },
        CommentsInsightsSchema,
        1
      );
      const validated = validateCommentsInsightsCandidate(
        insights,
        input.comments,
        input.sampleIds,
        input.maxInsights
      );
      if (validated !== undefined) {
        return { insights: validated.insights, modelUsed: model, summary: validated.summary };
      }
      if (!strict) {
        strict = true;
      } else if (!moveToFallback()) {
        return undefined;
      }
    } catch (error) {
      if (useResponseFormat && error instanceof UnsupportedResponseFormatError) {
        useResponseFormat = false;
        strict = true;
        log.warn(LOG_NAMESPACE_COMMENTS, "Comments-v2 response_format unsupported; retrying without it", {
          model,
        });
        continue;
      }
      if (trackTpdExhaustion && isGroqTpdExhaustionError(error)) {
        const exhausted = services.commentsTpdExhaustedModels ?? new Set<string>();
        exhausted.add(model);
        services.commentsTpdExhaustedModels = exhausted;
        log.warn(LOG_NAMESPACE_COMMENTS, "Comments-v2 marking model TPD-exhausted for this run", { model });
      }
      log.warn(LOG_NAMESPACE_COMMENTS, "Comments-v2 structured attempt failed", {
        model,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!useResponseFormat || hasHttpErrorCause(error) || strict) {
        if (!moveToFallback()) {
          return undefined;
        }
      } else {
        strict = true;
      }
    }
  }

  return undefined;
}

export async function generateValidatedCommentsSummaryV2(
  services: Services,
  input: GenerateCommentsSummaryV2Input
): Promise<ValidatedCommentsSummaryV2 | undefined> {
  const prepared =
    input.prepared ??
    buildCommentsPromptV2({
      story: input.story,
      comments: input.comments,
      ...(input.postSummary === undefined ? {} : { postSummary: input.postSummary }),
      language: env.SUMMARY_LANG,
      maxChars: env.COMMENTS_PROMPT_MAX_CHARS,
    });
  const budget =
    input.budget ??
    new CommentsGenerationBudget({
      ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
    });
  const result = await callStructuredWithModelChain(services, {
    budget,
    comments: input.comments,
    maxInsights: prepared.maxInsights,
    prompt: prepared.prompt,
    sampleIds: prepared.sampleIds,
  });
  if (result === undefined) {
    return undefined;
  }
  return {
    ...result,
    prompt: prepared.prompt,
    sampleIds: prepared.sampleIds,
  };
}

/**
 * Extract status persisted on the article_extract record:
 * - "ok": usable content (or a non-HTML source that bypasses the detector)
 * - "no-article": HTML extract judged to be nav/boilerplate/link-farm
 * `undefined` means unknown (no meta store, or a cache hit with no record).
 */
export type ArticleFetchResult = { md?: string; extractStatus?: string };

// Garbage verdict with the CURRENT env thresholds. Lists/short lines are legitimate
// in PDFs, transcripts, READMEs and plaintext, so only "html" and "reader" run it.
// "reader" is already markdown from Jina but can still be nav/boilerplate.
function detectHtmlExtractStatus(md: string): "no-article" | "ok" {
  const quality = assessExtractQuality(md, {
    minProseChars: env.EXTRACT_MIN_PROSE_CHARS,
    maxLinkDensity: env.EXTRACT_MAX_LINK_DENSITY,
    maxDupRatio: env.EXTRACT_MAX_DUP_RATIO,
  });
  return quality.verdict === "no-article" ? "no-article" : "ok";
}

function sourceKindUsesExtractDetector(sourceKind: string | undefined): boolean {
  return sourceKind === "html" || sourceKind === "reader";
}

export async function getOrFetchArticleMarkdown(
  services: Services,
  story: NormalizedStory,
  store: ObjectStore,
  meta?: MetaStore
): Promise<ArticleFetchResult> {
  if (!story.url) {
    log.warn(LOG_NAMESPACE_ARTICLE, "Story has no URL; cannot fetch article", { id: story.id });
    return {};
  }
  const path = pathFor.articleMd(story.id);
  const cached = await store.getText(path);
  if (cached?.trim()) {
    const extract = meta ? await meta.getArticleExtract(story.id) : undefined;
    // Legacy cache: written before Readability extraction landed (no sourceKind
    // recorded). Re-fetch once so the article is re-extracted through Readability +
    // detector. Works for both FS (local) and R2 (worker); the re-fetch overwrites
    // the cached blob in place, so no separate cache-invalidation step is needed.
    const isLegacyCache = meta !== undefined && extract?.sourceKind === undefined;
    if (!isLegacyCache) {
      log.debug(LOG_NAMESPACE_ARTICLE, "Using cached content", { id: story.id, path });
      let extractStatus = extract?.status ?? undefined;
      if (extract !== undefined && sourceKindUsesExtractDetector(extract.sourceKind)) {
        // Re-run the detector with the CURRENT thresholds so tuning takes effect on
        // cached extracts without a re-fetch (a cached verdict alone would be stale).
        extractStatus = detectHtmlExtractStatus(cached);
        if (meta && extractStatus !== extract.status) {
          // This is only a local verdict re-evaluation; the underlying bytes were
          // not fetched again, so preserve their original fetchedAt provenance.
          await meta.upsertArticleExtract({ ...extract, status: extractStatus });
        }
      }
      return { md: cached, ...(extractStatus === undefined ? {} : { extractStatus }) };
    }
    log.info(LOG_NAMESPACE_ARTICLE, "Re-fetching legacy cached article for Readability re-extraction", {
      id: story.id,
      path,
    });
  }
  try {
    log.info(LOG_NAMESPACE_ARTICLE, "Fetching article and processing content", { id: story.id, url: story.url });
    const { md, sourceKind } = await services.fetchArticleMarkdown(story.url);
    let text = md.trim();
    if (!text) {
      log.warn(LOG_NAMESPACE_ARTICLE, "Fetched content is empty", { id: story.id, url: story.url });
      return {};
    }
    let finalSourceKind = sourceKind;
    let extractStatus = sourceKindUsesExtractDetector(sourceKind)
      ? detectHtmlExtractStatus(text)
      : "ok";
    if (extractStatus === "no-article") {
      log.warn(LOG_NAMESPACE_ARTICLE, "Extract flagged as no-article", { id: story.id, url: story.url });
      // JS-rendered sites (SPA shells) return a 200 whose direct extract is nav /
      // tagline boilerplate, not the article — no Cloudflare challenge, so the raw
      // fetch stayed on the html path. Retry once through the JS-rendering reader
      // before degrading; if it yields a real article, use it instead.
      if (sourceKind === "html" && env.ARTICLE_FETCH_READER_FALLBACK && services.fetchArticleViaReader) {
        try {
          const reader = await services.fetchArticleViaReader(story.url);
          const readerText = reader.md.trim();
          const readerStatus = sourceKindUsesExtractDetector(reader.sourceKind)
            ? detectHtmlExtractStatus(readerText)
            : "ok";
          if (readerText && readerStatus === "ok") {
            log.info(LOG_NAMESPACE_ARTICLE, "Recovered no-article html extract via reader", {
              id: story.id,
              url: story.url,
            });
            text = readerText;
            finalSourceKind = reader.sourceKind;
            extractStatus = "ok";
          } else {
            log.warn(LOG_NAMESPACE_ARTICLE, "Reader retry did not recover a usable article", {
              id: story.id,
              url: story.url,
              readerStatus,
            });
          }
        } catch (readerError) {
          log.warn(LOG_NAMESPACE_ARTICLE, "Reader retry for no-article extract failed", {
            id: story.id,
            url: story.url,
            error: String(readerError),
          });
        }
      }
    }
    await store.putText(path, text, { contentType: "text/markdown" });
    if (meta) {
      const fetchedAt = new Date().toISOString();
      await meta.upsertRawBlob({
        storyId: story.id,
        kind: "article",
        ref: path,
        sizeBytes: text.length,
        fetchedAt,
      });
      await meta.upsertArticleExtract({
        storyId: story.id,
        status: extractStatus,
        sourceKind: finalSourceKind,
        charCount: text.length,
        rawArticleRef: path,
        fetchedAt,
      });
    }
    log.debug(LOG_NAMESPACE_ARTICLE, "Wrote content cache", {
      id: story.id,
      path,
      extractStatus,
      sourceKind: finalSourceKind,
    });
    return { md: text, extractStatus };
  } catch (error) {
    if (isCloudflareChallengeError(error)) {
      // Expected bot-protection miss (fallback off, or reader also failed). Keep
      // ERROR reserved for unexpected fetch/network problems.
      log.warn(LOG_NAMESPACE_ARTICLE, "Blocked by site bot protection; skipping article", {
        id: story.id,
        url: story.url,
        error: String(error),
      });
    } else {
      log.error(LOG_NAMESPACE_ARTICLE, "Failed to fetch content", {
        id: story.id,
        url: story.url,
        error: String(error),
      });
    }
    return {};
  }
}

// Local-only variant: do not hit network; used during pre-selection phase
async function getCachedArticleMarkdownOnly(story: NormalizedStory, store: ObjectStore): Promise<string | undefined> {
  if (!story.url) {
    return undefined;
  }
  const path = pathFor.articleMd(story.id);
  const cached = await store.getText(path);
  return cached?.trim() ? cached : undefined;
}

async function processPostSummary(
  services: Services,
  story: NormalizedStory,
  postPath: string,
  store: ObjectStore,
  meta?: MetaStore
): Promise<void> {
  const existingPostSummary = await readJsonSafeOrStore(store, postPath, PostSummarySchema);

  if (env.POST_SUMMARY_ONLY_IF_MISSING && existingPostSummary) {
    log.debug(LOG_NAMESPACE_POST, "Post summary exists; skipping due to ONLY_IF_MISSING", { id: story.id });
    return;
  }

  const { md: articleMd, extractStatus } = await getOrFetchArticleMarkdown(services, story, store, meta);
  const postArticleSlice = await buildPostPrompt(story, articleMd);
  const inputHash = await postInputHash(env.SUMMARY_LANG, postArticleSlice, env);

  if (existingPostSummary?.inputHash === inputHash) {
    log.debug(LOG_NAMESPACE_POST, "Post summary up-to-date; skipping", { id: story.id });
    return;
  }

  if (extractStatus === "no-article") {
    // Garbage extract (nav/boilerplate/link farm). Do not burn LLM quota on the
    // multi-attempt + fallback-model chain; retire any stale published summary
    // (both aggregators drop empty post summaries) and keep only the comments summary.
    const now = new Date().toISOString();
    const stub: PostSummary = {
      id: story.id,
      lang: env.SUMMARY_LANG,
      summary: "",
      degraded: "no-article",
      inputHash,
      createdISO: now,
    };
    await store.putJson(postPath, stub, { pretty: true, contentType: "application/json" });
    if (meta) {
      await meta.upsertSummary({
        storyId: story.id,
        kind: "post",
        lang: stub.lang,
        summary: "",
        createdAt: now,
      });
    }
    log.warn(LOG_NAMESPACE_POST, "Post degraded (no-article); skipped LLM", { id: story.id });
    return;
  }

  if (postArticleSlice.length > 0) {
    const validated = await generateValidatedPostSummary(services, story, postArticleSlice);
    if (!validated) {
      log.error(LOG_NAMESPACE_POST, "Post summary rejected after all attempts", {
        id: story.id,
      });
      return;
    }

    const guardPersisted = validated.guard
      ? {
          ok: validated.guard.ok,
          verdict: validated.guard.verdict,
          reasons: validated.guard.reasons,
          confidence: validated.guard.confidence,
        }
      : undefined;

    const postSummary: PostSummary = {
      id: story.id,
      lang: env.SUMMARY_LANG,
      summary: validated.summary,
      inputHash,
      model: validated.modelUsed,
      createdISO: new Date().toISOString(),
      ...(guardPersisted ? { guard: guardPersisted } : {}),
    };
    await store.putJson(postPath, postSummary, { pretty: true, contentType: "application/json" });
    if (meta) {
      await meta.upsertSummary({
        storyId: story.id,
        kind: "post",
        lang: postSummary.lang,
        ...(postSummary.model ? { model: postSummary.model } : {}),
        summary: postSummary.summary,
        createdAt: postSummary.createdISO ?? new Date().toISOString(),
      });
    }
    log.info(LOG_NAMESPACE_POST, "Post summary written", {
      id: story.id,
      chars: postSummary.summary.length,
      model: validated.modelUsed,
      guardVerdict: guardPersisted?.verdict,
    });
  } else {
    log.warn(LOG_NAMESPACE_POST, "Empty post prompt; skipping LLM", { id: story.id });
  }
}

export type CommentsProcessingResult =
  | {
      status: "applied";
      policyVersion: string;
      inputHash: string;
      summary: CommentsSummary;
    }
  | {
      status: "pending";
      desiredPolicyVersion: string;
      inputHash: string;
      reason: string;
    };

function metaSummaryText(summary: CommentsSummary): string {
  if (compressedStateFor(summary) === "usable" && summary.compressed !== undefined) {
    return renderCompressedParagraphMarkdown(summary.compressed.text);
  }
  return summary.summary;
}

async function upsertCommentsSummaryMeta(meta: MetaStore | undefined, summary: CommentsSummary): Promise<void> {
  if (meta === undefined) {
    return;
  }
  await meta.upsertSummary({
    storyId: summary.id,
    kind: "comments",
    lang: summary.lang,
    ...(summary.model === undefined ? {} : { model: summary.model }),
    summary: metaSummaryText(summary),
    createdAt: summary.createdISO ?? new Date().toISOString(),
  });
}

function makeCompressRejectMarker(
  summary: CommentsSummary,
  sourceHash: string
): CommentsSummary {
  return {
    ...summary,
    compressed: {
      text: "",
      model: env.COMMENTS_COMPRESS_MODEL,
      createdISO: new Date().toISOString(),
      sourceHash,
    },
  };
}

export type CompressCommentsResult =
  | { status: "usable" | "rejected" | "skipped"; summary: CommentsSummary }
  | { status: "pending"; summary: CommentsSummary; reason: "compress-pending" };

/**
 * Second-pass compression of a structured comments summary.
 * Shared budget with stage-1 on the fresh path; lazy path creates a one-call budget.
 * Transport failures leave `compressed` absent (retryable); semantic rejects write text:"".
 */
export async function compressCommentsSummaryIfNeeded(
  services: Services,
  summary: CommentsSummary,
  budget: CommentsGenerationBudget
): Promise<CompressCommentsResult> {
  if (
    !isCommentsCompressEnabled() ||
    summary.formatVersion !== 2 ||
    summary.structured === undefined ||
    summary.degraded !== undefined
  ) {
    return { status: "skipped", summary };
  }

  const plainText = renderCommentsInsightsPlainText(summary.structured);
  const sourceHash = expectedCompressSourceHash(summary);
  if (sourceHash === undefined) {
    return { status: "skipped", summary };
  }
  const state = resolveCompressedState(summary, sourceHash);
  if (state === "usable" || state === "rejected") {
    return { status: state, summary };
  }

  const requestTimeoutMs = budget.claimRequestTimeoutMs();
  if (requestTimeoutMs === undefined) {
    log.warn(LOG_NAMESPACE_COMMENTS, "Comments compress skipped: budget/deadline exhausted", {
      id: summary.id,
      callsUsed: budget.callsUsed,
      maxCalls: budget.maxCalls,
    });
    return { status: "pending", summary, reason: "compress-pending" };
  }

  try {
    const raw = await services.openrouter.chat(
      [{ role: "user", content: buildCommentsCompressUserPrompt(plainText) }],
      {
        temperature: 0.2,
        maxTokens: env.COMMENTS_COMPRESS_MAX_TOKENS,
        model: env.COMMENTS_COMPRESS_MODEL,
        label: "comments-compress",
        transportRetries: 0,
        requestTimeoutMs,
      }
    );
    const sanitized = sanitizeCompressedOutput(raw);
    const validated = validateCompressedText(sanitized, plainText, {
      language: "ru",
      minChars: env.COMMENTS_SUMMARY_MIN_CHARS,
      minCyrillicRatio: env.COMMENTS_MIN_CYRILLIC_RATIO,
    });
    if (!validated.ok) {
      log.warn(LOG_NAMESPACE_COMMENTS, "Comments compress semantic reject", {
        id: summary.id,
        reason: validated.reason,
      });
      return { status: "rejected", summary: makeCompressRejectMarker(summary, sourceHash) };
    }
    return {
      status: "usable",
      summary: {
        ...summary,
        compressed: {
          text: validated.text,
          model: env.COMMENTS_COMPRESS_MODEL,
          createdISO: new Date().toISOString(),
          sourceHash,
        },
      },
    };
  } catch (error) {
    // Permanent 4xx (bad model id, 401, …) must not burn a paid call every cron.
    if (isPermanentCompressHttpError(error)) {
      log.warn(LOG_NAMESPACE_COMMENTS, "Comments compress permanent HTTP error; writing reject marker", {
        id: summary.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: "rejected", summary: makeCompressRejectMarker(summary, sourceHash) };
    }
    log.warn(LOG_NAMESPACE_COMMENTS, "Comments compress transport error; leaving field absent", {
      id: summary.id,
      error: error instanceof Error ? error.message : String(error),
    });
    // Do NOT drop an existing usable compressed blob on a transient failure of a
    // force-retry: keep the previous field when present so backfill --force cannot
    // destroy good data. Fresh stage-1 blobs have no compressed field yet.
    return {
      status: "pending",
      summary,
      reason: "compress-pending",
    };
  }
}

export async function processCommentsSummary(
  services: Services,
  story: NormalizedStory,
  comments: NormalizedComment[],
  postSummary: PostSummary | undefined,
  commentsPath: string,
  store: ObjectStore,
  meta?: MetaStore,
  options: { deadlineAt?: number } = {}
): Promise<CommentsProcessingResult> {
  const prepared = buildCommentsPromptV2({
    story,
    comments,
    ...(postSummary === undefined ? {} : { postSummary }),
    language: env.SUMMARY_LANG,
    maxChars: env.COMMENTS_PROMPT_MAX_CHARS,
  });
  const inputHash = await commentsInputHash(env.SUMMARY_LANG, COMMENTS_POLICY_VERSION, prepared.prompt);
  let existingCommentsSummary: CommentsSummary | undefined;
  try {
    existingCommentsSummary = await readJsonSafeOrStore(store, commentsPath, CommentsSummarySchema);
  } catch (error) {
    log.error(LOG_NAMESPACE_COMMENTS, "Comments-v2 storage read failed", { id: story.id, error: String(error) });
    return {
      status: "pending",
      desiredPolicyVersion: COMMENTS_POLICY_VERSION,
      inputHash,
      reason: "storage-read-failed",
    };
  }

  const retryableFallback = existingCommentsSummary?.degraded === "generation-failed";
  const stage1UpToDate =
    existingCommentsSummary?.inputHash === inputHash &&
    existingCommentsSummary.formatVersion === 2 &&
    !retryableFallback;

  // Compress-only path when stage-1 is current OR when stage-1 is stale but we
  // only entered because compress is retryable (must not escalate into a full
  // stage-1 regen and burn the shared budget the cooldown protects).
  const compressRetryable =
    isCommentsCompressEnabled() &&
    existingCommentsSummary !== undefined &&
    existingCommentsSummary.formatVersion === 2 &&
    existingCommentsSummary.structured !== undefined &&
    existingCommentsSummary.degraded === undefined &&
    compressedStateFor(existingCommentsSummary) === "retryable";

  if (stage1UpToDate || (compressRetryable && existingCommentsSummary !== undefined)) {
    let summaryForMeta = existingCommentsSummary;
    if (compressRetryable) {
      const lazyBudget = new CommentsGenerationBudget({
        maxCalls: 1,
        ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
      });
      const compressed = await compressCommentsSummaryIfNeeded(
        services,
        existingCommentsSummary,
        lazyBudget
      );
      summaryForMeta = compressed.summary;
      // Persist only when the blob actually changed (usable/rejected marker).
      // Transient pending must NOT overwrite an existing compressed field.
      if (compressed.status === "usable" || compressed.status === "rejected") {
        try {
          await store.putJson(commentsPath, summaryForMeta, {
            pretty: true,
            contentType: "application/json",
          });
        } catch (error) {
          log.error(LOG_NAMESPACE_COMMENTS, "Comments compress lazy persistence failed", {
            id: story.id,
            error: String(error),
          });
          return {
            status: "pending",
            desiredPolicyVersion: COMMENTS_POLICY_VERSION,
            inputHash,
            reason: "persistence-failed",
          };
        }
      }
    }
    try {
      await upsertCommentsSummaryMeta(meta, summaryForMeta);
      log.debug(LOG_NAMESPACE_COMMENTS, "Comments-v2 summary up-to-date; repaired meta if needed", {
        id: story.id,
        stage1UpToDate,
        compressRetryable,
      });
      // Always "applied" when stage-1 is intact: compress-pending must not flip
      // processing_state.commentsStatus to "missing" for a healthy structured blob.
      return {
        status: "applied",
        policyVersion: COMMENTS_POLICY_VERSION,
        inputHash: summaryForMeta.inputHash ?? inputHash,
        summary: summaryForMeta,
      };
    } catch (error) {
      log.error(LOG_NAMESPACE_COMMENTS, "Comments-v2 meta repair failed", { id: story.id, error: String(error) });
      return {
        status: "pending",
        desiredPolicyVersion: COMMENTS_POLICY_VERSION,
        inputHash,
        reason: "meta-repair-failed",
      };
    }
  }

  // Fresh path: one shared budget for stage-1 + compress.
  const sharedBudget = new CommentsGenerationBudget({
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  });
  const substantiveComments = comments.filter((comment) => isSubstantiveComment(comment));
  let commentsSummary: CommentsSummary;
  let compressPending = false;
  if (substantiveComments.length < 3) {
    const now = new Date().toISOString();
    commentsSummary = {
      id: story.id,
      lang: env.SUMMARY_LANG,
      summary: renderTooFewCommentsFallback(substantiveComments, env.SUMMARY_LANG),
      degraded: "too-few-comments",
      formatVersion: 2,
      inputHash,
      sampleComments: substantiveComments.map((comment) => comment.id),
      createdISO: now,
    };
  } else {
    const validated = await generateValidatedCommentsSummaryV2(services, {
      story,
      comments,
      ...(postSummary === undefined ? {} : { postSummary }),
      prepared,
      budget: sharedBudget,
      ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
    });
    if (validated === undefined) {
      // Keep the card useful even when every structured model attempt fails. This
      // marker is deliberately retryable: the next run must try generation again
      // instead of treating the deterministic fallback as a successful v2 result.
      const now = new Date().toISOString();
      commentsSummary = {
        id: story.id,
        lang: env.SUMMARY_LANG,
        summary: renderTooFewCommentsFallback(substantiveComments, env.SUMMARY_LANG),
        degraded: "generation-failed",
        formatVersion: 2,
        inputHash,
        sampleComments: substantiveComments.map((comment) => comment.id),
        createdISO: now,
      };
      try {
        await store.putJson(commentsPath, commentsSummary, { pretty: true, contentType: "application/json" });
        await upsertCommentsSummaryMeta(meta, commentsSummary);
        log.warn(LOG_NAMESPACE_COMMENTS, "Comments-v2 generation failed; persisted deterministic fallback", {
          id: story.id,
          chars: commentsSummary.summary.length,
        });
      } catch (error) {
        log.error(LOG_NAMESPACE_COMMENTS, "Comments-v2 fallback persistence failed", {
          id: story.id,
          error: String(error),
        });
      }
      return {
        status: "pending",
        desiredPolicyVersion: COMMENTS_POLICY_VERSION,
        inputHash,
        reason: "generation-failed",
      };
    }
    commentsSummary = {
      id: story.id,
      lang: env.SUMMARY_LANG,
      summary: validated.summary,
      structured: validated.insights,
      formatVersion: 2,
      inputHash,
      model: validated.modelUsed,
      sampleComments: validated.sampleIds,
      createdISO: new Date().toISOString(),
    };
    const compressed = await compressCommentsSummaryIfNeeded(services, commentsSummary, sharedBudget);
    commentsSummary = compressed.summary;
    compressPending = compressed.status === "pending";
  }

  try {
    await store.putJson(commentsPath, commentsSummary, { pretty: true, contentType: "application/json" });
    await upsertCommentsSummaryMeta(meta, commentsSummary);
    log.info(LOG_NAMESPACE_COMMENTS, "Comments-v2 summary written", {
      id: story.id,
      chars: commentsSummary.summary.length,
      model: commentsSummary.model,
      degraded: commentsSummary.degraded,
      compressed:
        commentsSummary.compressed === undefined
          ? "absent"
          : commentsSummary.compressed.text === ""
            ? "rejected"
            : "usable",
      compressPending,
    });
    // Structured stage-1 is applied even when compress is still pending: the blob
    // is useful, and processing_state must not report "missing". Lazy path will
    // finish compress on the next cron via computeCommentsChanged.
    return {
      status: "applied",
      policyVersion: COMMENTS_POLICY_VERSION,
      inputHash,
      summary: commentsSummary,
    };
  } catch (error) {
    log.error(LOG_NAMESPACE_COMMENTS, "Comments-v2 persistence failed", { id: story.id, error: String(error) });
    return {
      status: "pending",
      desiredPolicyVersion: COMMENTS_POLICY_VERSION,
      inputHash,
      reason: "persistence-failed",
    };
  }
}

function getTelegramStreamConfig(): { chatId: string; botToken: string } | undefined {
  if (!env.TELEGRAM_ENABLE || !env.TELEGRAM_STREAM) {
    return undefined;
  }
  if (telegramStreamDisabledReason) {
    return undefined;
  }
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!chatId || !botToken) {
    if (!telegramStreamConfigWarned) {
      telegramStreamConfigWarned = true;
      log.warn("telegram", "Telegram stream enabled but missing config", {
        hasBotToken: !!botToken,
        hasChatId: !!chatId,
      });
    }
    return undefined;
  }
  return { chatId, botToken };
}

async function getTelegramLedgerCached(meta?: MetaStore): Promise<TelegramLedger> {
  if (!telegramLedgerCache) {
    telegramLedgerCache = await (meta ? meta.getTelegramLedger() : readTelegramLedger(PATHS.telegramSent));
  }
  return telegramLedgerCache;
}

async function persistTelegramLedgerCached(next: TelegramLedger, meta?: MetaStore): Promise<void> {
  telegramLedgerCache = next;
  if (!meta) {
    await writeTelegramLedger(PATHS.telegramSent, next);
  }
}

function buildTelegramItemFromStory(
  story: NormalizedStory,
  summary: string,
  commentsSummary: string | undefined,
  commentsInsights?: { lead: string }
): TelegramDigestItem {
  return {
    id: story.id,
    title: story.title,
    url: story.url,
    hnUrl: `https://news.ycombinator.com/item?id=${story.id}`,
    postSummary: summary,
    ...(commentsSummary === undefined ? {} : { commentsSummary }),
    ...(commentsInsights === undefined ? {} : { commentsInsights }),
    timeISO: story.timeISO,
  };
}

function extractTelegramErrorCode(message: string): number | undefined {
  const match = /"error_code"\s*:\s*(\d+)/u.exec(message);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function shouldDisableTelegramStream(errorMessage: string): boolean {
  const lowered = errorMessage.toLowerCase();
  if (lowered.includes("chat not found")) {
    return true;
  }
  if (lowered.includes("not enough rights") || lowered.includes("bot was blocked")) {
    return true;
  }
  if (lowered.includes("forbidden")) {
    return true;
  }
  const code = extractTelegramErrorCode(errorMessage);
  return code === 400 || code === 403;
}

async function sendTelegramWithRetries(
  telegram: Telegram,
  message: string,
  storyId: number,
  chatId: string
): Promise<number | undefined> {
  const maxRetries = env.TELEGRAM_MAX_RATE_LIMIT_RETRIES;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      return await telegram.sendMessage({
        chatId,
        text: message,
        parseMode: "HTML",
        disableWebPagePreview: true,
        disableNotification: env.TELEGRAM_DISABLE_NOTIFICATIONS,
        ...(env.TELEGRAM_MESSAGE_THREAD_ID && { messageThreadId: env.TELEGRAM_MESSAGE_THREAD_ID }),
      });
    } catch (error) {
      if (error instanceof Error && (error.message.includes("429") || error.message.includes("Too Many Requests"))) {
        const { retryAfter, description } = parseTelegramError(error.message);
        const waitSeconds = retryAfter ?? 30;
        const backoffMultiplier = Math.pow(1.5, retryCount);
        const totalWait = Math.ceil(waitSeconds * backoffMultiplier);

        log.warn("telegram", "Rate limit hit, waiting before retry", {
          storyId,
          retryAfter: waitSeconds,
          retryCount: retryCount + 1,
          maxRetries,
          description,
        });

        await new Promise((resolve) => setTimeout(resolve, (totalWait + 1) * 1000));
        retryCount++;
        continue;
      }

      if (error instanceof Error && shouldDisableTelegramStream(error.message)) {
        telegramStreamDisabledReason = "chat not found or bot has no rights";
        log.error("telegram", "Disabling telegram stream for this run", {
          storyId,
          reason: telegramStreamDisabledReason,
          error: error.message,
        });
        return undefined;
      }

      log.error("telegram", "Failed to send Telegram message", {
        storyId,
        error: String(error),
      });
      return undefined;
    }
  }

  log.error("telegram", "Failed to send Telegram message after retries", {
    storyId,
    maxRetries,
  });
  return undefined;
}

async function publishTelegramAfterSummary(
  services: Services,
  story: NormalizedStory,
  postSummary: string | undefined,
  commentsSummary: string | undefined,
  meta?: MetaStore,
  commentsInsights?: { lead: string }
): Promise<void> {
  const cfg = getTelegramStreamConfig();
  if (!cfg) {
    return;
  }

  const summary = postSummary?.trim();
  if (!summary) {
    return;
  }

  const ledger = await getTelegramLedgerCached(meta);
  if (ledger.sentIds.includes(story.id)) {
    log.debug("telegram", "Story already sent, skipping", { id: story.id });
    return;
  }

  const item = buildTelegramItemFromStory(story, summary, commentsSummary, commentsInsights);
  const message = buildTelegramMessage(item, env.SITE, { language: env.SUMMARY_LANG });

  const telegram = new Telegram(services.http, cfg.botToken);
  const messageId = await sendTelegramWithRetries(telegram, message, story.id, cfg.chatId);
  if (!messageId) {
    return;
  }

  const sentAt = new Date().toISOString();
  const nextIds = [...new Set([...(ledger.sentIds ?? []), story.id])];
  if (meta) {
    await meta.markTelegramSent(story.id, messageId, sentAt);
  }
  await persistTelegramLedgerCached({
    sentIds: nextIds,
    lastUpdatedISO: sentAt,
  }, meta);

  log.info("telegram", "Streamed story to Telegram", {
    id: story.id,
    messageId,
  });

  if (env.TELEGRAM_MESSAGE_DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, env.TELEGRAM_MESSAGE_DELAY_MS));
  }
}

async function processTags(
  services: Services,
  story: NormalizedStory,
  postSummary: string | undefined,
  store: ObjectStore,
  meta?: MetaStore
): Promise<void> {
  // Allow disabling tags to conserve LLM quota (e.g., during catch-up runs)
  if (env.TAGS_MAX_PER_STORY <= 0) {
    log.debug(TAGS_DEBUG_MESSAGE, "tags disabled via TAGS_MAX_PER_STORY=0", { id: story.id });
    return;
  }
  const p = pathFor.tagsSummary(story.id);
  const prompt = buildTagsPrompt(story, postSummary);
  const inputHash = await hashString(buildTagsCacheMaterial(prompt, env.TAGS_MODEL));
  const existing = await readJsonSafeOrStore(store, p, TagsSummarySchema);
  if (existing?.inputHash === inputHash) {
    log.debug(TAGS_DEBUG_MESSAGE, "up-to-date", { id: story.id });
    return;
  }

  try {
    const llm = await summarizeTagsStructured(services.guardTagsClient, prompt, env);
    const domain = story.url ? new URL(story.url).hostname : undefined;
    const tags = combineAndCanon({
      llm,
      title: story.title,
      domain,
      max: env.TAGS_MAX_PER_STORY,
    });

    const payload = {
      id: story.id,
      lang: env.TAGS_LANG,
      tags: tags.map((slug) => ({ name: slug })), // store normalized names in summary for transparency
      inputHash,
      model: env.TAGS_MODEL,
      createdISO: new Date().toISOString(),
    };
    await store.putJson(p, payload, { pretty: true, contentType: "application/json" });
    if (meta) {
      await meta.replaceTags(story.id, tags);
    }
    log.info(TAGS_DEBUG_MESSAGE, "tags written", { id: story.id, count: tags.length, model: env.TAGS_MODEL });
  } catch (error) {
    log.error(TAGS_DEBUG_MESSAGE, "Failed to generate structured tags, falling back to heuristics", {
      id: story.id,
      error,
      model: env.TAGS_MODEL,
    });

    // Fallback to just heuristic tags if structured output fails
    const domain = story.url ? new URL(story.url).hostname : undefined;
    const tags = combineAndCanon({
      llm: [],
      title: story.title,
      domain,
      max: env.TAGS_MAX_PER_STORY,
    });

    const payload = {
      id: story.id,
      lang: env.TAGS_LANG,
      tags: tags.map((name) => ({ name })),
      inputHash,
      model: env.TAGS_MODEL,
      createdISO: new Date().toISOString(),
    };
    await store.putJson(p, payload, { pretty: true, contentType: "application/json" });
    if (meta) {
      await meta.replaceTags(story.id, tags);
    }
    log.info(TAGS_DEBUG_MESSAGE, "fallback tags written", { id: story.id, count: tags.length, model: env.TAGS_MODEL });
  }
}

export async function processSingleStory(
  services: Services,
  id: number,
  store: ObjectStore,
  meta?: MetaStore,
  options: { deadlineAt?: number } = {}
): Promise<void> {
  const story = await readJsonSafeOrStore<NormalizedStory>(
    store,
    pathFor.rawItem(id),
    NormalizedStorySchema as unknown as z.ZodType<NormalizedStory>
  );
  if (!story) {
    log.warn("summarize", "Missing normalized story file; skipping", { id });
    return;
  }

  // Engagement gate (defense-in-depth: also enforced in evaluateCandidate for the
  // local workflow, but this function is called directly by the Cloudflare worker
  // path). Skip ALL LLM + state writes below threshold, before any usage scope.
  if (
    !passesEngagementGate(
      { score: story.score, comments: story.descendants },
      {
        minScore: env.SUMMARIZE_MIN_SCORE,
        minComments: env.SUMMARIZE_MIN_COMMENTS,
      }
    )
  ) {
    log.info("summarize", "Skipping LLM: below engagement threshold", {
      id,
      score: story.score,
      descendants: story.descendants,
      minScore: env.SUMMARIZE_MIN_SCORE,
      minComments: env.SUMMARIZE_MIN_COMMENTS,
    });
    return;
  }

  // Scope the usage collector to this story; drain + persist in finally so events flush
  // even when the body throws, and the scope is always cleared (record() drops out-of-scope
  // events — R3). The Worker calls this same function, so there is no separate wiring.
  services.usage.setStory(id);
  try {
    const postPath = pathFor.postSummary(id);
    const commentsPath = pathFor.commentsSummary(id);

    await processPostSummary(services, story, postPath, store, meta);
    const post = await readJsonSafeOrStore(store, pathFor.postSummary(story.id), PostSummarySchema);
    let comments: NormalizedComment[] | undefined;
    try {
      comments =
        (await readJsonSafeOrStore<NormalizedComment[]>(
          store,
          pathFor.rawComments(id),
          NormalizedCommentSchema.array() as unknown as z.ZodType<NormalizedComment[]>,
          []
        )) ?? [];
      log.debug(LOG_NAMESPACE_COMMENTS, "Comments loaded", { id: story.id, count: comments.length });
    } catch (error) {
      log.error(LOG_NAMESPACE_COMMENTS, "Comments input load failed; continuing with legacy Telegram summary", {
        id: story.id,
        error: String(error),
      });
    }

    let commentsSummary: CommentsSummary | undefined;
    try {
      commentsSummary = await readJsonSafeOrStore(store, commentsPath, CommentsSummarySchema);
    } catch (error) {
      log.error(LOG_NAMESPACE_COMMENTS, "Comments summary snapshot failed; continuing without Telegram teaser", {
        id: story.id,
        error: String(error),
      });
    }

    let commentsResult: CommentsProcessingResult | undefined;
    if (comments !== undefined) {
      try {
        commentsResult = await processCommentsSummary(services, story, comments, post, commentsPath, store, meta, {
          ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
        });
      } catch (error) {
        log.error(LOG_NAMESPACE_COMMENTS, "Comments processing failed; continuing with Telegram publication", {
          id: story.id,
          error: String(error),
        });
      }
    }

    if (commentsResult?.status === "applied") {
      commentsSummary = commentsResult.summary;
    } else {
      try {
        commentsSummary =
          (await readJsonSafeOrStore(store, pathFor.commentsSummary(story.id), CommentsSummarySchema)) ??
          commentsSummary;
      } catch (error) {
        log.error(LOG_NAMESPACE_COMMENTS, "Comments summary refresh failed; using pre-processing snapshot", {
          id: story.id,
          error: String(error),
        });
      }
    }

    const telegramLead =
      commentsSummary?.structured?.bottom_line === undefined
        ? undefined
        : { lead: renderCommentsLead(commentsSummary.structured.bottom_line) };
    await publishTelegramAfterSummary(services, story, post?.summary, commentsSummary?.summary, meta, telegramLead);
    await processTags(services, story, post?.summary, store, meta);

    if (meta) {
      const now = new Date().toISOString();
      await meta.upsertProcessingState(story.id, {
        postStatus: post ? "ok" : "missing",
        commentsStatus: commentsResult?.status === "applied" ? "ok" : "missing",
        ...(commentsResult?.status === "applied"
          ? {
              commentsPolicyVersion: commentsResult.policyVersion,
              commentsInputHash: commentsResult.inputHash,
            }
          : {}),
        tagsStatus: (await readJsonSafeOrStore(store, pathFor.tagsSummary(story.id), TagsSummarySchema))
          ? "ok"
          : "missing",
        updatedAt: now,
        error: null,
      });
    }
  } finally {
    const rows = services.usage.drain();
    services.usage.setStory(undefined);
    if (meta && rows.length > 0) {
      // Best-effort, off the critical path: a persistence failure must not fail the story.
      try {
        await meta.insertLlmUsage(rows);
      } catch (error) {
        log.error("summarize", "persist llm usage failed", { id, error: String(error) });
      }
    }
  }
}

type Candidate = {
  id: number;
  priority: number;
  timeISO?: string;
};

type CandidateSelectionConfig = {
  cooldownMs: number;
  summaryLang: string;
  postSummaryOnlyIfMissing: boolean;
  detectorPolicy: ExtractDetectorPolicy;
  gate: { minScore: number; minComments: number };
};

function isInsideCooldown(iso: string | undefined, now: number, cooldownMs: number): boolean {
  if (!iso || cooldownMs <= 0) {
    return false;
  }
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && now - ts < cooldownMs;
}

// Re-export shared gate (also used by aggregate/site publish filters).
export { passesEngagementGate } from "@utils/engagement-gate";

async function computePostChanged(
  story: NormalizedStory,
  existingPost: PostSummary | null | undefined,
  config: CandidateSelectionConfig,
  now: number,
  store: ObjectStore
): Promise<boolean> {
  if (!existingPost) {
    return true;
  }
  if (config.postSummaryOnlyIfMissing) {
    return false;
  }
  if (isInsideCooldown(existingPost.createdISO, now, config.cooldownMs)) {
    return false;
  }
  const cachedMd = await getCachedArticleMarkdownOnly(story, store);
  if (!cachedMd) {
    return false;
  }
  const slice = await buildPostPrompt(story, cachedMd);
  const hash = await postInputHash(config.summaryLang, slice, config.detectorPolicy);
  return existingPost.inputHash !== hash;
}

export async function computeCommentsChanged(
  story: NormalizedStory,
  existingComments: CommentsSummary | null | undefined,
  language: Env["SUMMARY_LANG"],
  cooldownMs: number,
  now: number,
  store: ObjectStore
): Promise<boolean> {
  if (!existingComments) {
    return true;
  }
  // A deterministic fallback is intentionally not protected by the normal
  // cooldown: it exists only to keep the card visible until generation works.
  if (existingComments.degraded === "generation-failed") {
    return true;
  }
  // Compress retry must run even inside cooldown — but only when compress is
  // actually enabled. With COMMENTS_COMPRESS_MODEL="" or SUMMARY_LANG=en every
  // structured blob would otherwise look eternally retryable and starve real work.
  if (
    isCommentsCompressEnabled() &&
    existingComments.formatVersion === 2 &&
    existingComments.structured !== undefined &&
    existingComments.degraded === undefined &&
    compressedStateFor(existingComments) === "retryable"
  ) {
    return true;
  }
  if (isInsideCooldown(existingComments.createdISO, now, cooldownMs)) {
    return false;
  }
  const comments = await readJsonSafeOrStore<NormalizedComment[]>(
    store,
    pathFor.rawComments(story.id),
    NormalizedCommentSchema.array() as unknown as z.ZodType<NormalizedComment[]>,
    []
  );
  const postSummary = await readJsonSafeOrStore(store, pathFor.postSummary(story.id), PostSummarySchema);
  const prepared = buildCommentsPromptV2({
    story,
    comments: comments ?? [],
    ...(postSummary === undefined ? {} : { postSummary }),
    language,
    maxChars: env.COMMENTS_PROMPT_MAX_CHARS,
  });
  const hash = await commentsInputHash(language, COMMENTS_POLICY_VERSION, prepared.prompt);
  return (
    existingComments.degraded === "generation-failed" ||
    existingComments.formatVersion !== 2 ||
    existingComments.inputHash !== hash
  );
}

async function evaluateCandidate(
  id: number,
  config: CandidateSelectionConfig,
  store: ObjectStore
): Promise<Candidate | "gate-skipped" | undefined> {
  const story = await readJsonSafeOrStore<NormalizedStory>(
    store,
    pathFor.rawItem(id),
    NormalizedStorySchema as unknown as z.ZodType<NormalizedStory>
  );
  if (!story) {
    return undefined;
  }

  // Engagement gate: skip ALL LLM work below threshold, before the expensive
  // hashing/reads in computePostChanged/computeCommentsChanged.
  if (!passesEngagementGate({ score: story.score, comments: story.descendants }, config.gate)) {
    log.info("summarize", "Skipping LLM: below engagement threshold", {
      id,
      score: story.score,
      descendants: story.descendants,
      minScore: config.gate.minScore,
      minComments: config.gate.minComments,
    });
    return "gate-skipped";
  }

  const [existingPost, existingComments] = await Promise.all([
    readJsonSafeOrStore(store, pathFor.postSummary(id), PostSummarySchema.nullable()),
    readJsonSafeOrStore(store, pathFor.commentsSummary(id), CommentsSummarySchema.nullable()),
  ]);

  const now = Date.now();
  const postChanged = await computePostChanged(story, existingPost, config, now, store);
  const commentsChanged = await computeCommentsChanged(
    story,
    existingComments,
    config.summaryLang as Env["SUMMARY_LANG"],
    config.cooldownMs,
    now,
    store
  );
  const priority = (postChanged ? 1 : 0) + (commentsChanged ? 2 : 0);

  if (priority <= 0) {
    return undefined;
  }

  return { id, priority, timeISO: story.timeISO };
}

async function collectCandidates(
  ids: number[],
  config: CandidateSelectionConfig,
  store: ObjectStore
): Promise<{ candidates: Candidate[]; gateSkipped: number }> {
  const candidates: Candidate[] = [];
  let gateSkipped = 0;
  for (const id of ids) {
    try {
      const candidate = await evaluateCandidate(id, config, store);
      if (candidate === "gate-skipped") {
        gateSkipped += 1;
      } else if (candidate) {
        candidates.push(candidate);
      }
    } catch (error) {
      log.warn("summarize", "Preselect failed; will attempt full processing", { id, error: String(error) });
      candidates.push({ id, priority: 1 });
    }
  }
  return { candidates, gateSkipped };
}

export async function summarizeWorkflow(services: Services, e: Env, store: ObjectStore, meta?: MetaStore): Promise<void> {
  const index = await readJsonSafeOrStore<{ updatedISO: string; storyIds: number[] }>(store, PATHS.index, IndexSchema, {
    updatedISO: new Date(0).toISOString(),
    storyIds: [],
  });

  const {
    OPENROUTER_API_KEY,
    SUMMARIZE_COOLDOWN_MINUTES,
    SUMMARIZE_MAX_STORIES_PER_RUN,
    POST_SUMMARY_ONLY_IF_MISSING,
    SUMMARY_LANG,
    SUMMARIZE_MIN_SCORE,
    SUMMARIZE_MIN_COMMENTS,
  } = e;
  if (!OPENROUTER_API_KEY) {
    log.warn("summarize", "OPENROUTER_API_KEY missing; skipping summarize step");
    return;
  }

  // Pre-select candidates to limit token burn per run
  const cooldownMins = Math.max(0, SUMMARIZE_COOLDOWN_MINUTES);
  const maxPerRun = Math.max(1, SUMMARIZE_MAX_STORIES_PER_RUN);
  const { candidates, gateSkipped } = await collectCandidates(index.storyIds, {
    cooldownMs: cooldownMins * 60_000,
    summaryLang: SUMMARY_LANG,
    postSummaryOnlyIfMissing: POST_SUMMARY_ONLY_IF_MISSING,
    detectorPolicy: e,
    gate: { minScore: SUMMARIZE_MIN_SCORE, minComments: SUMMARIZE_MIN_COMMENTS },
  }, store);

  // Sort: higher priority first; then newest by timeISO desc; then id desc
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    const ta = a.timeISO ? Date.parse(a.timeISO) : Number.NaN;
    const tb = b.timeISO ? Date.parse(b.timeISO) : Number.NaN;
    const aHas = Number.isFinite(ta);
    const bHas = Number.isFinite(tb);
    if (aHas && bHas) {
      return tb - ta;
    }
    if (aHas && !bHas) {
      return -1;
    }
    if (!aHas && bHas) {
      return 1;
    }
    return b.id - a.id;
  });

  const selected = candidates.slice(0, maxPerRun);
  const skipped = Math.max(0, candidates.length - selected.length);
  log.info("summarize", "Candidate selection complete", {
    candidates: candidates.length,
    gateSkipped,
    selected: selected.length,
    maxPerRun,
  });
  if (skipped > 0) {
    log.info("summarize", "Cap reached; skipping some stories this run", {
      candidates: candidates.length,
      selected: selected.length,
      skipped,
      maxPerRun,
      cooldownMins,
    });
  }

  let rateLimitAbort: RateLimitError | undefined;

  for (const { id } of selected) {
    if (rateLimitAbort) {
      log.warn("summarize", "Skipping story due to prior rate limit", {
        id,
        retryISO: rateLimitAbort.retryDate?.toISOString(),
        model: rateLimitAbort.model,
      });
      break;
    }
    log.info("summarize", "Processing story", { id });
    try {
      await processSingleStory(services, id, store, meta);
    } catch (error) {
      if (error instanceof RateLimitError) {
        rateLimitAbort = error;
        log.error("summarize", "Aborting summarize run due to OpenRouter rate limit", {
          id,
          ...error.toLogMeta(),
        });
        break;
      }
      log.error("summarize", "Unhandled error during story processing", { id, error: String(error) });
      continue;
    }
  }

  if (rateLimitAbort) {
    log.warn("summarize", "Summarize run aborted early because of rate limit", rateLimitAbort.toLogMeta());
  }
}
