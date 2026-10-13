import { type Env } from "@config/env";
import { decodeText, looksLikeHtml, looksLikePdf } from "@utils/content-detect";
import { extractArticleMd } from "@utils/html-to-md";
import { HttpError, type HttpClient } from "@utils/http-client";
import { log } from "@utils/log";
import { fetchYouTubeTranscript, getVideoId, isYouTubeUrl } from "@utils/youtube";

import type { PdfToTextOptions } from "@utils/pdf";

/** Default public Jina Reader prefix. Overridable via ARTICLE_READER_BASE_URL. */
export const DEFAULT_ARTICLE_READER_BASE_URL = "https://r.jina.ai";

/** Minimum non-empty reader body we accept as usable article markdown. */
export const MIN_READER_MD_CHARS = 40;

/**
 * High-signal Cloudflare / bot-fight markers. Prefer specific CF hostnames,
 * meta/title anchors, and compound interstitial phrases over loose English
 * fragments like bare "just a moment" (those appear in ordinary article prose
 * and would false-positive the 200-HTML path + reader body validation).
 */
const CHALLENGE_MARKERS = [
  "challenges.cloudflare.com",
  "cdn-cgi/challenge-platform",
  "cf-browser-verification",
  "cf-challenge",
  "attention required! | cloudflare",
  // Anchored title forms — not the bare English phrase.
  "<title>just a moment",
  "<title>just a moment...",
  "enable javascript and cookies to continue",
  "checking your browser before accessing",
] as const;

/**
 * True when a string looks like a Cloudflare JS-challenge / bot-fight page body.
 * Case-insensitive substring match against high-signal markers only.
 */
export function looksLikeCloudflareChallenge(text?: string | null): boolean {
  if (text === undefined || text === null || text === "") {
    return false;
  }
  const lower = text.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Classify a thrown fetch error as a Cloudflare / bot-protection block that is
 * eligible for the Jina Reader fallback. Primary signal is HTTP 403; bare 403
 * always qualifies (many CF edges omit the body fragment we store). 503 / status-
 * less errors need challenge markers in the message.
 */
export function isCloudflareChallengeError(error: unknown): boolean {
  if (!(error instanceof HttpError)) {
    return false;
  }
  const { status, message } = error;
  const bodyLooksLikeChallenge = looksLikeCloudflareChallenge(message);
  if (status === 403) {
    return true;
  }
  if (status === 503 && bodyLooksLikeChallenge) {
    return true;
  }
  // Status missing (network wrapper) but body snippet still screams CF challenge.
  return status === undefined && bodyLooksLikeChallenge;
}

/**
 * Build `https://r.jina.ai/<absolute-url>`. Refuses to double-prefix if the
 * target is already a reader URL for the same base.
 */
export function buildJinaReaderUrl(targetUrl: string, baseUrl: string = DEFAULT_ARTICLE_READER_BASE_URL): string {
  let base = baseUrl;
  while (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  const trimmed = targetUrl.trim();
  if (trimmed.startsWith(`${base}/`) || trimmed === base) {
    return trimmed;
  }
  // Jina expects the full absolute URL after the prefix, including scheme.
  return `${base}/${trimmed}`;
}

export type FetchViaJinaReaderOptions = {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  /** Max retries for the reader hop (default 1 = one retry). */
  retries?: number | undefined;
};

/**
 * Fetch article markdown via Jina Reader (`r.jina.ai`). Returns trimmed markdown
 * without link-dominated lines, or throws HttpError / Error on empty /
 * still-challenge body.
 *
 * Headers follow the upstream Reader docs (`X-Respond-With`; Accept text/plain).
 * @see https://github.com/jina-ai/reader
 */
export async function fetchViaJinaReader(
  http: HttpClient,
  targetUrl: string,
  options: FetchViaJinaReaderOptions = {}
): Promise<string> {
  const baseUrl = options.baseUrl ?? DEFAULT_ARTICLE_READER_BASE_URL;
  const readerUrl = buildJinaReaderUrl(targetUrl, baseUrl);
  const headers: Record<string, string> = {
    Accept: "text/plain",
    // Canonical Jina Reader header (also accepted case-insensitively as x-respond-with).
    "X-Respond-With": "markdown",
  };
  const apiKey = options.apiKey?.trim();
  if (apiKey !== undefined && apiKey.length > 0) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const text = await http.text(readerUrl, {
    headers,
    retries: options.retries ?? 1,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const trimmed = text.trim();
  if (looksLikeCloudflareChallenge(trimmed)) {
    throw new Error(`Jina reader still returned a Cloudflare challenge page for ${targetUrl}`);
  }
  const cleaned = dropLinkDominatedLines(trimmed);
  if (cleaned.length < MIN_READER_MD_CHARS) {
    throw new Error(`Jina reader returned empty/short body (${cleaned.length} chars) for ${targetUrl}`);
  }
  return cleaned;
}

// Anchor/url classes exclude their own delimiters so matching stays linear on
// untrusted page content (no rescans across unclosed brackets).
const MD_IMAGE = /!\[[^[\]]*\]\([^()]*\)/gu;
// No `u` flag: in JSC it made this pattern ~5000x slower on a 60 KB inline-CSS
// line (530 ms vs 0.1 ms); the pattern is ASCII-only, so matching is unchanged.
// eslint-disable-next-line regexp/require-unicode-regexp, unicorn/better-regex
const MD_LINK = /\[(?<anchor>[^[\]]*)\]\([^()]*\)/g;
const MD_DECORATION = /[\s#*\->_`|]/gu;
const LINK_LINE_MIN_UNLINKED_SHARE = 0.5;

/**
 * Drop lines whose visible text is mostly link anchors or images: menus, share
 * bars, related-story cards. Reader markdown is the whole page; on sites with
 * long menus the article sat past the post prompt's head slice and the model
 * summarized a bare title (2026-10-13: 60 of 257 reader posts). Code blocks
 * and table rows are content, so they are always kept.
 */
export function dropLinkDominatedLines(md: string): string {
  let inFence = false;
  const kept = md.split("\n").filter((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      return true;
    }
    if (inFence || trimmed.startsWith("|") || !line.includes("](")) {
      return true;
    }
    const noImages = line.replaceAll(MD_IMAGE, "");
    const visible = noImages.replaceAll(MD_LINK, "$<anchor>").replaceAll(MD_DECORATION, "");
    const unlinked = noImages.replaceAll(MD_LINK, "").replaceAll(MD_DECORATION, "");
    return visible.length > 0 && unlinked.length >= visible.length * LINK_LINE_MIN_UNLINKED_SHARE;
  });
  return kept.join("\n").replaceAll(/\n{3,}/gu, "\n\n").trim();
}

export type ArticleSourceKind = "empty" | "html" | "pdf" | "reader" | "text" | "youtube";

export type FetchedArticle = { md: string; sourceKind: ArticleSourceKind };

/**
 * Env surface the fetch policy reads. Narrow on purpose: the policy must stay
 * grep-able for its config (N8 self-liquidation path).
 */
export type ArticleFetchEnv = Pick<
  Env,
  | "ARTICLE_FETCH_READER_FALLBACK"
  | "ARTICLE_READER_BASE_URL"
  | "HTTP_TIMEOUT_MS"
  | "JINA_API_KEY"
  | "PDF_MAX_BYTES"
  | "PDF_MAX_PAGES"
  | "SUMMARY_LANG"
  | "YT_TRANSCRIPT_LANGS"
>;

const ARTICLE_LOG_NS = "summarize/article" as const;

export type ArticleFetcher = {
  fetchArticleMarkdown: (url: string) => Promise<FetchedArticle>;
  fetchArticleViaReader: (url: string) => Promise<FetchedArticle>;
};

/**
 * Single owner of the article-fetch policy (N6): youtube transcript → http bytes →
 * Cloudflare-challenge detection → pdf/html/text extraction → Jina reader fallback.
 * makeServices and future composition roots assemble this; the policy is testable
 * without the whole pipeline Services.
 */
export function createArticleFetcher(deps: {
  http: HttpClient;
  envLike: ArticleFetchEnv;
  pdfToText?: (bytes: Uint8Array, opts?: PdfToTextOptions) => Promise<string>;
}): ArticleFetcher {
  const { http, envLike: e, pdfToText } = deps;

  async function fetchArticleViaReader(url: string): Promise<FetchedArticle> {
    // Structured counter-ish log: grep "via Jina reader" / sourceKind=reader for frequency.
    log.info(ARTICLE_LOG_NS, "Retrying article via Jina reader", {
      url,
      fallback: "jina",
      readerBase: e.ARTICLE_READER_BASE_URL,
      hasJinaKey: e.JINA_API_KEY !== undefined && e.JINA_API_KEY.length > 0,
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
      if (vid === undefined || vid.length === 0) {
        return undefined;
      }
      log.info(ARTICLE_LOG_NS, "Fetching YouTube transcript", { url, vid });
      const prefer =
        (e.YT_TRANSCRIPT_LANGS?.length ?? 0) > 0
          ? e.YT_TRANSCRIPT_LANGS ?? [e.SUMMARY_LANG, "en"]
          : [e.SUMMARY_LANG, "en"];
      const transcript = await fetchYouTubeTranscript(http, vid, prefer);
      const trimmed = transcript?.text.trim();
      if (trimmed !== undefined && trimmed.length > 0) {
        return trimmed;
      }
      log.warn(ARTICLE_LOG_NS, "No captions available; falling back to HTML", { url, vid });
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
      log.info(ARTICLE_LOG_NS, "Fetching and parsing PDF", { url, contentType, bytes: data.length });
      if (pdfToText === undefined) {
        log.warn(ARTICLE_LOG_NS, "PDF parsing disabled; skipping", { url, contentType });
        return { md: "", sourceKind: "pdf" };
      }
      try {
        const text = await pdfToText(data, {
          maxPages: e.PDF_MAX_PAGES,
          softMaxBytes: e.PDF_MAX_BYTES,
        });
        log.debug(ARTICLE_LOG_NS, "PDF parsed successfully", { url, textLength: text.length });
        return { md: text, sourceKind: "pdf" };
      } catch (error) {
        log.error(ARTICLE_LOG_NS, "PDF parse failed", { url, error: String(error) });
        return { md: "", sourceKind: "pdf" };
      }
    }
    if (looksLikeHtml(contentType)) {
      log.debug(ARTICLE_LOG_NS, "Processing HTML content", { url, contentType });
      const html = decodedHtml ?? decodeText(data, contentType);
      // Readability-extract the article before turndown; the extract-quality
      // detector (HTML-only) judges the result downstream.
      return { md: extractArticleMd(html, url), sourceKind: "html" };
    }
    log.debug(ARTICLE_LOG_NS, "Processing as plain text", { url, contentType });
    try {
      const text = decodeText(data, contentType);
      return { md: text.trim(), sourceKind: "text" };
    } catch (error) {
      log.warn(ARTICLE_LOG_NS, "Text decode failed", { url, contentType, error: String(error) });
      return { md: "", sourceKind: "text" };
    }
  }

  async function fetchArticleMarkdown(url: string): Promise<FetchedArticle> {
    const youtubeText = await tryFetchYouTubeContent(url);
    if (youtubeText !== undefined && youtubeText.length > 0) {
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
        log.warn(ARTICLE_LOG_NS, "Jina reader fallback failed", {
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

  return { fetchArticleMarkdown, fetchArticleViaReader };
}
