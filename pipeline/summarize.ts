import { COMMENTS_POLICY_VERSION, env, type Env } from "@config/env";
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
import { createArticleFetcher, isCloudflareChallengeError, type FetchedArticle } from "@utils/article-fetch";
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
  renderCompressedParagraphMarkdown,
  renderTooFewCommentsFallback,
} from "@utils/comments-render";
import {
  buildCommentsThread,
  buildCommentsPromptV2,
  buildCommentsSystemInstructionV2,
  COMMENTS_INSIGHTS_HARD_CEILING,
  commentsInputHash,
  isSubstantiveComment,
  validateCommentsInsightsCandidate,
} from "@utils/comments-thread";
import { passesEngagementGate } from "@utils/engagement-gate";
import { assessExtractQuality } from "@utils/extract-quality";
import { sha256Hex } from "@utils/hash";
import { HttpClient } from "@utils/http-client";
import { createUsageCollector, type UsageCollector } from "@utils/llm-usage";
import { log } from "@utils/log";
import { createNoopMetaStore } from "@utils/noop-meta-store";
import { readJsonSafe, readJsonSafeOrStore } from "@utils/object-store";
import { OpenRouter, UnsupportedResponseFormatError, type ChatMessage, type JsonSchema } from "@utils/openrouter";
import { runSummaryGuard, type SummaryGuardResult } from "@utils/summary-guard";
import {
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

import {
  commentsStage1Verdict,
  commentsSelectionChanged,
  isCompressRetryable,
  postInputHash,
  postSelectionChanged,
  type ExtractDetectorPolicy,
} from "./staleness";

import {
  buildPostGuardModelChain,
  callAcrossModelChain,
  callLabeledChat,
  callLLMWithMessages,
  RateLimitError,
  TpdBreaker,
  callStructuredWithModelChain as runStructuredCommentsChain,
  type LlmLogContext,
} from "@utils/chat-route";
export {
  RateLimitError,
  preserveMarkdownWhitespace,
  sanitizeLlmContent,
} from "@utils/chat-route";
export {
  commentsTpdExhaustionKey,
  isGroqTpdExhaustionError,
} from "@utils/chat-route";


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
export type { ArticleSourceKind, FetchedArticle } from "@utils/article-fetch";

export type Services = {
  http: HttpClient;
  openrouter: OpenRouter;
  /** Client for structured-JSON calls (tags, post-guard, comments-v2). Groq when GROQ_API_KEY is set, else same as openrouter. */
  guardTagsClient: OpenRouter;
  /**
   * Official MiniMax API client (MINIMAX_API_KEY). When set, the comments chain
   * prepends a free MiniMax-M3 hop before the Groq/paid ladder (chat-route).
   */
  commentsMinimaxClient?: OpenRouter;
  fetchArticleMarkdown: (url: string) => Promise<FetchedArticle>;
  /** Force the Jina reader path (JS-rendered pages). Used to recover a no-article html extract. */
  fetchArticleViaReader?: (url: string) => Promise<FetchedArticle>;
  pdfToText?: (bytes: Uint8Array, opts?: PdfToTextOptions) => Promise<string>;
  /** Per-attempt LLM usage collector, scoped per story by processSingleStory. */
  usage: UsageCollector;
  /**
   * Run-/batch-scoped TPD breaker. Worker injects one instance per inline cron
   * pass or queue batch. commentsTpdExhaustedModels is the same Set (freeze/compat).
   * Optional on hand-built test stubs; makeServices always sets it.
   */
  tpdBreaker?: TpdBreaker;
  /**
   * Legacy freeze/compat view of tpdBreaker.asSet(). Same identity. Prefer tpdBreaker.
   */
  commentsTpdExhaustedModels?: Set<string>;
};

export function makeServices(
  e: Env,
  options?: {
    pdfToText?: (bytes: Uint8Array, opts?: PdfToTextOptions) => Promise<string>;
    /** Test-only: inject a stub HttpClient (bytes/text) instead of the real one. */
    http?: HttpClient;
    /**
     * Preferred shared TPD breaker for a batch. When omitted, built from
     * commentsTpdExhaustedModels or a fresh Set.
     */
    tpdBreaker?: TpdBreaker;
    /**
     * Optional shared TPD Set (freeze/worker legacy). Same identity as tpdBreaker.asSet().
     */
    commentsTpdExhaustedModels?: Set<string>;
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
  // Free-first comments primary (2026-08-25): official MiniMax API client for the
  // prepended MiniMax-M3 hop. Only built when a key exists; chat-route skips the
  // hop otherwise and the paid gpt-oss ladder stays the fallback.
  const minimaxEnabled = e.MINIMAX_API_KEY !== undefined && e.MINIMAX_API_KEY.length > 0;
  const commentsMinimaxClient = minimaxEnabled
    ? new OpenRouter(http, e.MINIMAX_API_KEY ?? "", e.COMMENTS_MINIMAX_MODEL, e.MINIMAX_BASE_URL, {
        gateway: "minimax",
        ...(onUsage === undefined ? {} : { onUsage }),
      })
    : undefined;

  const articleFetcher = createArticleFetcher({
    http,
    ...(options?.pdfToText === undefined ? {} : { pdfToText: options.pdfToText }),
    envLike: e,
  });

  log.debug("summarize/services", "initialized", {
    hasOpenRouterKey: !!e.OPENROUTER_API_KEY,
    model: e.OPENROUTER_MODEL,
  });

  const tpdBreaker =
    options?.tpdBreaker ??
    TpdBreaker.fromSet(options?.commentsTpdExhaustedModels ?? new Set<string>());

  return {
    http,
    openrouter,
    guardTagsClient,
    ...(commentsMinimaxClient === undefined ? {} : { commentsMinimaxClient }),
    ...articleFetcher,
    usage,
    tpdBreaker,
    commentsTpdExhaustedModels: tpdBreaker.asSet(),
  };
}

const TAGS_DEBUG_MESSAGE = "summarize/tags";

// Log namespaces
const LOG_NAMESPACE_POST = "summarize/post" as const;
const LOG_NAMESPACE_COMMENTS = "summarize/comments" as const;
const LOG_NAMESPACE_ARTICLE = "summarize/article" as const;
const LOG_NAMESPACE_GUARD = "summarize/guard" as const;

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



async function hashString(s: string): Promise<string> {
  return await sha256Hex(s);
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
        const guardModels = buildPostGuardModelChain();
        const guardHit = await callAcrossModelChain(guardModels, async (guardModel) =>
          runSummaryGuard(services.guardTagsClient, {
            summary: summaryContent.summary,
            articleSlice,
            envLike: {
              SUMMARY_LANG: lang,
              POST_GUARD_MODEL: guardModel,
              POST_GUARD_MAX_TOKENS: env.POST_GUARD_MAX_TOKENS,
              POST_GUARD_MIN_CONFIDENCE: env.POST_GUARD_MIN_CONFIDENCE,
              POST_GUARD_VERDICT_REJECT_MIN_CONFIDENCE: env.POST_GUARD_VERDICT_REJECT_MIN_CONFIDENCE,
              POST_GUARD_ARTICLE_MAX_CHARS: env.POST_GUARD_ARTICLE_MAX_CHARS,
            },
          })
        , (guardModel, error) => {
          log.error(LOG_NAMESPACE_GUARD, "Guard call failed", {
            id: story.id,
            attempt: attempt.label,
            guardModel,
            error: String(error),
          });
        });
        guardResult = guardHit?.value;

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

  claimRequestTimeoutMs(preferredMs?: number): number | undefined {
    if (this.used >= this.maxCalls) {
      return undefined;
    }
    let timeoutMs = preferredMs ?? this.requestTimeoutMs;
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
  // Routing/resilience live in @utils/chat-route (Phase 3); this wrapper injects
  // the domain validator so callers keep their existing import surface.
  return await runStructuredCommentsChain(services, {
    ...input,
    validate: validateCommentsInsightsCandidate,
  });
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
  // A REAL store participates in decisions (legacy-cache refetch, verdict
  // re-evaluation); a Noop only absorbs the writes. Normalize after capturing.
  const hasRealMeta = meta !== undefined;
  const metaStore = meta ?? createNoopMetaStore();
  if (cached?.trim()) {
    const extract = await metaStore.getArticleExtract(story.id);
    // Legacy cache: written before Readability extraction landed (no sourceKind
    // recorded). Re-fetch once so the article is re-extracted through Readability +
    // detector. Works for both FS (local) and R2 (worker); the re-fetch overwrites
    // the cached blob in place, so no separate cache-invalidation step is needed.
    const isLegacyCache = hasRealMeta && extract?.sourceKind === undefined;
    if (!isLegacyCache) {
      log.debug(LOG_NAMESPACE_ARTICLE, "Using cached content", { id: story.id, path });
      let extractStatus = extract?.status ?? undefined;
      if (extract !== undefined && sourceKindUsesExtractDetector(extract.sourceKind)) {
        // Re-run the detector with the CURRENT thresholds so tuning takes effect on
        // cached extracts without a re-fetch (a cached verdict alone would be stale).
        extractStatus = detectHtmlExtractStatus(cached);
        if (extractStatus !== extract.status) {
          // This is only a local verdict re-evaluation; the underlying bytes were
          // not fetched again, so preserve their original fetchedAt provenance.
          await metaStore.upsertArticleExtract({ ...extract, status: extractStatus });
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
    const fetchedAt = new Date().toISOString();
    await metaStore.upsertRawBlob({
      storyId: story.id,
      kind: "article",
      ref: path,
      sizeBytes: text.length,
      fetchedAt,
    });
    await metaStore.upsertArticleExtract({
      storyId: story.id,
      status: extractStatus,
      sourceKind: finalSourceKind,
      charCount: text.length,
      rawArticleRef: path,
      fetchedAt,
    });
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
  const metaStore = meta ?? createNoopMetaStore();
  const existingPostSummary = await readJsonSafe(store, postPath, PostSummarySchema);

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
    await metaStore.upsertSummary({
      storyId: story.id,
      kind: "post",
      lang: stub.lang,
      summary: "",
      createdAt: now,
    });
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
    await metaStore.upsertSummary({
      storyId: story.id,
      kind: "post",
      lang: postSummary.lang,
      ...(postSummary.model ? { model: postSummary.model } : {}),
      summary: postSummary.summary,
      createdAt: postSummary.createdISO ?? new Date().toISOString(),
    });
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
  const metaStore = meta ?? createNoopMetaStore();
  await metaStore.upsertSummary({
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
  { status: "pending"; summary: CommentsSummary; reason: "compress-pending" } | { status: "rejected" | "skipped" | "usable"; summary: CommentsSummary };

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
    const raw = await callLabeledChat(
      services.openrouter,
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
    // Every other outcome of this stage logs; success did not, so a paid stage ran
    // 39 times over 2026-07-29..08-01 leaving no trace outside the usage ledger.
    log.info(LOG_NAMESPACE_COMMENTS, "Comments compress written", {
      id: summary.id,
      model: env.COMMENTS_COMPRESS_MODEL,
      chars: validated.text.length,
      sourceChars: plainText.length,
    });
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
    existingCommentsSummary = await readJsonSafe(store, commentsPath, CommentsSummarySchema);
  } catch (error) {
    log.error(LOG_NAMESPACE_COMMENTS, "Comments-v2 storage read failed", { id: story.id, error: String(error) });
    return {
      status: "pending",
      desiredPolicyVersion: COMMENTS_POLICY_VERSION,
      inputHash,
      reason: "storage-read-failed",
    };
  }

  const stage1 =
    existingCommentsSummary === undefined
      ? undefined
      : commentsStage1Verdict({ story, existing: existingCommentsSummary, currentInputHash: inputHash });
  const stage1UpToDate = stage1?.upToDate ?? false;

  if (stage1?.countGatedFresh === true && existingCommentsSummary !== undefined) {
    log.info(LOG_NAMESPACE_COMMENTS, "Comments-v2 regen skipped: descendants delta within threshold", {
      id: story.id,
      descendants: story.descendants,
      processedDescendants: existingCommentsSummary.processedDescendants,
      delta: stage1.descendantsDelta,
      threshold: env.COMMENTS_REGEN_MIN_NEW_COMMENTS,
    });
  }

  // Compress-only path when stage-1 is current OR when stage-1 is stale but we
  // only entered because compress is retryable (must not escalate into a full
  // stage-1 regen and burn the shared budget the cooldown protects).
  const compressRetryable = isCompressRetryable(existingCommentsSummary);

  // stage1UpToDate implies an existing blob (hash arm compares its inputHash;
  // count arm derives descendantsDelta from it), so one explicit guard covers both.
  if ((stage1UpToDate || compressRetryable) && existingCommentsSummary !== undefined) {
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
      policyVersion: COMMENTS_POLICY_VERSION,
      ...(story.descendants === undefined ? {} : { processedDescendants: story.descendants }),
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
        policyVersion: COMMENTS_POLICY_VERSION,
        ...(story.descendants === undefined ? {} : { processedDescendants: story.descendants }),
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
      policyVersion: COMMENTS_POLICY_VERSION,
      ...(story.descendants === undefined ? {} : { processedDescendants: story.descendants }),
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
  const metaStore = meta ?? createNoopMetaStore();
  await metaStore.markTelegramSent(story.id, messageId, sentAt);
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
  const metaStore = meta ?? createNoopMetaStore();
  // Allow disabling tags to conserve LLM quota (e.g., during catch-up runs)
  if (env.TAGS_MAX_PER_STORY <= 0) {
    log.debug(TAGS_DEBUG_MESSAGE, "tags disabled via TAGS_MAX_PER_STORY=0", { id: story.id });
    return;
  }
  const p = pathFor.tagsSummary(story.id);
  const prompt = buildTagsPrompt(story, postSummary);
  const inputHash = await hashString(buildTagsCacheMaterial(prompt, env.TAGS_MODEL));
  const existing = await readJsonSafe(store, p, TagsSummarySchema);
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
    await metaStore.replaceTags(story.id, tags);
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
    await metaStore.replaceTags(story.id, tags);
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
  const story = await readJsonSafe<NormalizedStory>(
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
    const post = await readJsonSafe(store, pathFor.postSummary(story.id), PostSummarySchema);
    let comments: NormalizedComment[] | undefined;
    try {
      comments = await readJsonSafeOrStore<NormalizedComment[]>(
        store,
        pathFor.rawComments(id),
        NormalizedCommentSchema.array() as unknown as z.ZodType<NormalizedComment[]>,
        []
      );
      log.debug(LOG_NAMESPACE_COMMENTS, "Comments loaded", { id: story.id, count: comments.length });
    } catch (error) {
      log.error(LOG_NAMESPACE_COMMENTS, "Comments input load failed; continuing with legacy Telegram summary", {
        id: story.id,
        error: String(error),
      });
    }

    let commentsSummary: CommentsSummary | undefined;
    try {
      commentsSummary = await readJsonSafe(store, commentsPath, CommentsSummarySchema);
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
          (await readJsonSafe(store, pathFor.commentsSummary(story.id), CommentsSummarySchema)) ??
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

    const metaStore = meta ?? createNoopMetaStore();
    const now = new Date().toISOString();
    await metaStore.upsertProcessingState(story.id, {
      postStatus: post ? "ok" : "missing",
      commentsStatus: commentsResult?.status === "applied" ? "ok" : "missing",
      ...(commentsResult?.status === "applied"
        ? {
            commentsPolicyVersion: commentsResult.policyVersion,
            commentsInputHash: commentsResult.inputHash,
          }
        : {}),
      tagsStatus: (await readJsonSafe(store, pathFor.tagsSummary(story.id), TagsSummarySchema))
        ? "ok"
        : "missing",
      updatedAt: now,
      error: null,
    });
  } finally {
    const rows = services.usage.drain();
    services.usage.setStory(undefined);
    const metaStore = meta ?? createNoopMetaStore();
    if (rows.length > 0) {
      // Best-effort, off the critical path: a persistence failure must not fail the story.
      try {
        await metaStore.insertLlmUsage(rows);
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


// Re-export shared gate (also used by aggregate/site publish filters).
export { passesEngagementGate } from "@utils/engagement-gate";

async function computePostChanged(
  story: NormalizedStory,
  existingPost: PostSummary | null | undefined,
  config: CandidateSelectionConfig,
  now: number,
  store: ObjectStore
): Promise<boolean> {
  const verdict = await postSelectionChanged({
    story,
    existingPost,
    summaryLang: config.summaryLang,
    detectorPolicy: config.detectorPolicy,
    postSummaryOnlyIfMissing: config.postSummaryOnlyIfMissing,
    cooldownMs: config.cooldownMs,
    now,
    getCachedArticleMarkdown: async (candidate) => getCachedArticleMarkdownOnly(candidate, store),
    buildArticleSlice: async (candidate, articleMd) => buildPostPrompt(candidate, articleMd),
  });
  return verdict.changed;
}

export async function computeCommentsChanged(
  story: NormalizedStory,
  existingComments: CommentsSummary | null | undefined,
  language: Env["SUMMARY_LANG"],
  cooldownMs: number,
  now: number,
  store: ObjectStore
): Promise<boolean> {
  // Single freshness implementation lives in pipeline/staleness.ts (Phase 1);
  // ordering semantics are pinned by tests/summarize.staleness-freeze.test.ts.
  const verdict = await commentsSelectionChanged({
    story,
    existing: existingComments,
    language,
    cooldownMs,
    now,
    store,
  });
  return verdict.changed;
}

async function evaluateCandidate(
  id: number,
  config: CandidateSelectionConfig,
  store: ObjectStore
): Promise<Candidate | "gate-skipped" | undefined> {
  const story = await readJsonSafe<NormalizedStory>(
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
    readJsonSafe(store, pathFor.postSummary(id), PostSummarySchema.nullable()),
    readJsonSafe(store, pathFor.commentsSummary(id), CommentsSummarySchema.nullable()),
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
