import { HttpError, type HttpClient } from "@utils/http-client";

/** Default public Jina Reader prefix. Overridable via ARTICLE_READER_BASE_URL. */
export const DEFAULT_ARTICLE_READER_BASE_URL = "https://r.jina.ai";

/** Minimum non-empty reader body we accept as usable article markdown. */
export const MIN_READER_MD_CHARS = 40;

const CHALLENGE_MARKERS = [
  "just a moment",
  "challenges.cloudflare.com",
  "cf-browser-verification",
  "enable javascript and cookies to continue",
  "attention required! | cloudflare",
  "checking your browser before accessing",
] as const;

/**
 * True when a string looks like a Cloudflare JS-challenge / bot-fight page body.
 * Case-insensitive substring match against known markers.
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
 * eligible for the Jina Reader fallback. Primary signal is HTTP 403 with challenge
 * markers in the message; bare 403 also qualifies (many CF edges omit the body
 * fragment we store). 503 with challenge markers is accepted as a secondary case.
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
    "x-respond-with": "markdown",
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
