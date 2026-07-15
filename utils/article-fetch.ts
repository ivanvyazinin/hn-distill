import { HttpError, type HttpClient } from "@utils/http-client";

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
 * or throws HttpError / Error on empty / still-challenge body.
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
  if (trimmed.length < MIN_READER_MD_CHARS) {
    throw new Error(`Jina reader returned empty/short body (${trimmed.length} chars) for ${targetUrl}`);
  }
  if (looksLikeCloudflareChallenge(trimmed)) {
    throw new Error(`Jina reader still returned a Cloudflare challenge page for ${targetUrl}`);
  }
  return trimmed;
}
