import type { HttpClient } from "@utils/http-client";

export type TelegramSendParams = {
  chatId: string; // @channel or numeric ID
  text: string;
  parseMode?: "HTML" | "MarkdownV2"; // default "HTML"
  disableWebPagePreview?: boolean; // default true
  disableNotification?: boolean; // from env
  messageThreadId?: number; // optional topic
};

export class Telegram {
  constructor(private readonly http: HttpClient, private readonly token: string) {}

  async sendMessage(p: TelegramSendParams): Promise<number> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;

    const body = {
      chat_id: p.chatId,
      text: p.text,
      parse_mode: p.parseMode ?? "HTML",
      disable_web_page_preview: p.disableWebPagePreview ?? true,
      ...(p.disableNotification !== undefined && { disable_notification: p.disableNotification }),
      ...(p.messageThreadId !== undefined && p.messageThreadId !== 0 && { message_thread_id: p.messageThreadId }),
    };

    const response = await this.http.json<{ ok: boolean; result?: { message_id: number } }>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Telegram API error: ${JSON.stringify(response)}`);
    }

    return response.result?.message_id ?? 0;
  }
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// eslint-disable-next-line @typescript-eslint/typedef
export function chunkTelegramText(s: string, limit = 4096): string[] {
  if (s.length <= limit) {
    return [s];
  }

  const chunks: string[] = [];
  let remaining = s;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Find the last paragraph break within the limit
    let cutPoint = limit;
    const paragraphBreak = remaining.lastIndexOf("\n\n", limit - 1);

    if (paragraphBreak > limit * 0.7) {
      // Use paragraph break if it's reasonably close to the limit
      cutPoint = paragraphBreak + 2; // Include the \n\n
    } else {
      // Otherwise, find the last line break
      const lineBreak = remaining.lastIndexOf("\n", limit - 1);
      if (lineBreak > limit * 0.8) {
        cutPoint = lineBreak + 1; // Include the \n
      } else {
        // Fall back to word boundary or character limit
        const wordBreak = remaining.lastIndexOf(" ", limit - 1);
        if (wordBreak > limit * 0.9) {
          cutPoint = wordBreak + 1; // Include the space
        }
      }
    }

    chunks.push(remaining.slice(0, cutPoint));
    remaining = remaining.slice(cutPoint);
  }

  return chunks;
}

export type TelegramDigestItem = {
  id: number;
  title: string;
  domain?: string;
  url?: string | null;
  hnUrl?: string;
  postSummary?: string;
  commentsSummary?: string;
  commentsInsights?: { lead: string };
  timeISO: string;
};

export type TelegramMessageLanguage = "en" | "ru";

export type TelegramMessageOptions = {
  language?: TelegramMessageLanguage;
  maxLength?: number;
};

const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_COMMENTS_TEASER_LIMIT = 200;
const MAX_OPTIONAL_LINK_LENGTH = 1024;
const MAX_REQUIRED_LINK_LENGTH = 512;

const TELEGRAM_LABELS: Record<
  TelegramMessageLanguage,
  { comments: string; hn: string; readOn: string; site: string; source: string }
> = {
  ru: {
    comments: "Комментарии",
    hn: "комментарии на HN",
    readOn: "читать на",
    site: "сайте",
    source: "источник",
  },
  en: {
    comments: "Comments",
    hn: "comments on HN",
    readOn: "read on",
    site: "site",
    source: "source",
  },
};

function normalizePlainText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function stripMarkdownInline(value: string): string {
  return normalizePlainText(
    value
      .replaceAll(/!\[(?<label>[^\n\]]{0,500})\]\([^\n)]{0,2000}\)/gu, "$<label>")
      .replaceAll(/\[(?<label>[^\n\]]{1,500})\]\([^\n)]{0,2000}\)/gu, "$<label>")
      .replaceAll(/(?<!\\)(?:\*\*|__|~~|`+)/gu, "")
      .replaceAll(/(?<!\\)[*_]/gu, "")
      .replaceAll(/\\(?<escaped>[^\s\p{L}\p{N}])/gu, "$<escaped>")
  );
}

function bulletText(line: string): string | undefined {
  const trimmed = line.trim();
  let text: string | undefined;
  if (trimmed.startsWith("- ") || trimmed.startsWith("+ ") || trimmed.startsWith("* ")) {
    text = trimmed.slice(2);
  } else {
    const numericPrefix = /^\d{1,6}[).] /u.exec(trimmed)?.[0];
    if (numericPrefix !== undefined) {
      text = trimmed.slice(numericPrefix.length);
    }
  }
  if (text === undefined || text.length === 0) {
    return undefined;
  }
  const plain = stripMarkdownInline(text);
  return plain.length > 0 ? plain : undefined;
}

function headingText(line: string): string | undefined {
  const trimmed = line.trim();
  let markerLength = 0;
  while (markerLength < 6 && trimmed[markerLength] === "#") {
    markerLength += 1;
  }
  if (markerLength === 0 || trimmed[markerLength] !== " ") {
    return undefined;
  }
  let text = trimmed.slice(markerLength + 1).trimEnd();
  while (text.endsWith("#")) {
    text = text.slice(0, -1).trimEnd();
  }
  return text.length === 0 ? undefined : stripMarkdownInline(text).toLocaleLowerCase();
}

function truncatePlain(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength === 1) {
    return "…";
  }
  const target = maxLength - 1;
  let length = 0;
  let truncated = "";
  for (const character of value) {
    if (length + character.length > target) {
      break;
    }
    truncated += character;
    length += character.length;
  }
  return `${truncated.trimEnd()}…`;
}

export function commentsTeaser(
  summaryMd: string | null | undefined,
  maxChars: number = TELEGRAM_COMMENTS_TEASER_LIMIT
): string {
  const normalized = summaryMd?.replaceAll(/\r\n?/gu, "\n").trim();
  const safeMaxChars = Number.isFinite(maxChars)
    ? Math.max(0, Math.floor(maxChars))
    : TELEGRAM_COMMENTS_TEASER_LIMIT;
  if (normalized === undefined || normalized.length === 0 || safeMaxChars === 0) {
    return "";
  }

  // Prefer the first bullet; headings (legacy fallback cards) are skipped.
  const lines = normalized.split("\n");
  for (const line of lines) {
    if (headingText(line) !== undefined) {
      continue;
    }
    const bullet = bulletText(line);
    if (bullet !== undefined) {
      return truncatePlain(bullet, safeMaxChars);
    }
  }
  return "";
}

function safeHttpUrl(value: string | null | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return undefined;
    }
    const serialized = url.toString();
    return escapeHtml(serialized).length <= maxLength ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSiteBase(siteBase?: string): { base: string; label: string } {
  const fallback = "https://hckr.top";
  const safeBase = safeHttpUrl(siteBase, MAX_REQUIRED_LINK_LENGTH) ?? fallback;
  const normalized = safeBase.endsWith("/") ? safeBase.slice(0, -1) : safeBase;
  return { base: normalized, label: new URL(normalized).host };
}

function renderLink(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function fitPlainToEscapedBudget(value: string, maxEscapedLength: number): string {
  if (maxEscapedLength <= 0) {
    return "";
  }
  const normalized = normalizePlainText(value);
  if (escapeHtml(normalized).length <= maxEscapedLength) {
    return normalized;
  }

  const boundaries = [0];
  let position = 0;
  for (const character of normalized) {
    position += character.length;
    boundaries.push(position);
  }
  let low = 0;
  let high = boundaries.length - 1;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const boundary = boundaries[middle] ?? 0;
    const candidate = truncatePlain(normalized, Math.max(1, boundary + 1));
    if (escapeHtml(candidate).length <= maxEscapedLength) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function composeTelegramMessage(input: {
  commentsLabel: string;
  links: string[];
  summary: string;
  teaser: string;
  title: string;
}): string {
  const titleLine = `<b>${escapeHtml(input.title)}</b>`;
  const summaryLine = input.summary.length > 0 ? `\n\n${escapeHtml(input.summary)}` : "";
  const teaserLine =
    input.teaser.length > 0
      ? `\n\n💬 <b>${escapeHtml(input.commentsLabel)}:</b> ${escapeHtml(input.teaser)}`
      : "";
  const linksLine = input.links.length > 0 ? `\n\n${input.links.join(" | ")}` : "";
  return `${titleLine}${summaryLine}${teaserLine}${linksLine}`;
}

export function buildTelegramMessage(
  item: TelegramDigestItem,
  siteBase?: string,
  options: TelegramMessageOptions = {}
): string {
  const language = options.language ?? "ru";
  const labels = TELEGRAM_LABELS[language];
  const configuredMaxLength = options.maxLength ?? TELEGRAM_MESSAGE_LIMIT;
  const maxLength = Number.isFinite(configuredMaxLength)
    ? Math.max(1, Math.floor(configuredMaxLength))
    : TELEGRAM_MESSAGE_LIMIT;
  let title = normalizePlainText(item.title);
  let summary = normalizePlainText(item.postSummary ?? "");
  const lead = item.commentsInsights?.lead;
  let teaser =
    lead !== undefined && lead.trim().length > 0
      ? truncatePlain(stripMarkdownInline(lead), TELEGRAM_COMMENTS_TEASER_LIMIT)
      : commentsTeaser(item.commentsSummary);

  const links: string[] = [];
  const sourceUrl = safeHttpUrl(item.url, MAX_OPTIONAL_LINK_LENGTH);
  if (sourceUrl !== undefined) {
    links.push(renderLink(sourceUrl, labels.source));
  }

  const { base, label } = normalizeSiteBase(siteBase);
  const siteLink = `${base}/item/${item.id}`;
  links.push(renderLink(siteLink, `${labels.readOn} ${label.length > 0 ? label : labels.site}`));

  const fallbackHnUrl = `https://news.ycombinator.com/item?id=${item.id}`;
  const hnUrl = safeHttpUrl(item.hnUrl, MAX_REQUIRED_LINK_LENGTH) ?? fallbackHnUrl;
  links.push(renderLink(hnUrl, labels.hn));

  const compose = (): string =>
    composeTelegramMessage({ commentsLabel: labels.comments, links, summary, teaser, title });
  let message = compose();
  if (message.length <= maxLength) {
    return message;
  }

  const withoutSummary = composeTelegramMessage({ commentsLabel: labels.comments, links, summary: "", teaser, title });
  const summaryMarkupLength = summary.length > 0 ? 2 : 0;
  summary = fitPlainToEscapedBudget(summary, maxLength - withoutSummary.length - summaryMarkupLength);
  message = compose();
  if (message.length <= maxLength) {
    return message;
  }

  summary = "";
  const withoutTitle = composeTelegramMessage({ commentsLabel: labels.comments, links, summary, teaser, title: "" });
  title = fitPlainToEscapedBudget(title, maxLength - withoutTitle.length);
  message = compose();
  if (message.length <= maxLength) {
    return message;
  }

  teaser = "";
  const linksOnlyWithEmptyTitle = composeTelegramMessage({
    commentsLabel: labels.comments,
    links,
    summary: "",
    teaser: "",
    title: "",
  });
  title = fitPlainToEscapedBudget(title, maxLength - linksOnlyWithEmptyTitle.length);
  message = compose();
  if (message.length <= maxLength) {
    return message;
  }

  // This only matters for artificial limits below the fixed two-link footer.
  // Keep the HTML valid rather than slicing through a tag.
  return escapeHtml(fitPlainToEscapedBudget(item.title, maxLength));
}

export function buildTelegramMessages(
  items: TelegramDigestItem[],
  siteBase?: string,
  options: TelegramMessageOptions = {}
): string[] {
  return items.map((item) => buildTelegramMessage(item, siteBase, options));
}

export type SeenCache = {
  telegram?: {
    lastHash?: string;
    lastUpdatedISO?: string;
    sentAtISO?: string;
    lastIds?: number[];
  };
};

export async function digestHash(items: TelegramDigestItem[]): Promise<string> {
  const { sha256Hex } = await import("@utils/hash");
  const payload = {
    ids: items.map((i: TelegramDigestItem) => i.id),
    titles: items.map((i: TelegramDigestItem) => i.title),
    summaries: items.map((i: TelegramDigestItem) => i.postSummary?.trim() ?? ""),
  };
  return await sha256Hex(JSON.stringify(payload));
}

export async function readSeenCache(cachePath: string): Promise<SeenCache> {
  const { readJsonSafeOr } = await import("@utils/json");
  const { z } = await import("zod");
  return await readJsonSafeOr<SeenCache>(cachePath, z.any(), {});
}

export async function writeSeenCache(cachePath: string, next: SeenCache): Promise<void> {
  const { writeJsonFile } = await import("@utils/json");
  await writeJsonFile(cachePath, next);
}

export type TelegramProgress = {
  hash: string;
  startedAt: string;
  sentItems: Array<{ id: number; messageId: number; sentAt: string }>;
};

export async function readProgress(progressPath: string): Promise<TelegramProgress | undefined> {
  const { readJsonSafeOr } = await import("@utils/json");
  const { z } = await import("zod");
  const schema = z.object({
    hash: z.string(),
    startedAt: z.string(),
    sentItems: z.array(z.object({ id: z.number(), messageId: z.number(), sentAt: z.string() })),
  });
  type ResultType = TelegramProgress | undefined;
  const fallback: ResultType = undefined;
  return await readJsonSafeOr<ResultType>(progressPath, schema, fallback);
}

export async function writeProgress(progressPath: string, progress: TelegramProgress): Promise<void> {
  const { writeJsonFile } = await import("@utils/json");
  await writeJsonFile(progressPath, progress);
}

export async function deleteProgress(progressPath: string): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(progressPath);
  } catch {
    // Ignore if file doesn't exist
  }
}

export function parseTelegramError(errorMessage: string): { retryAfter?: number; description?: string } {
  try {
    const openBrace = errorMessage.indexOf("{");
    const closeBrace = errorMessage.indexOf("}", openBrace);
    if (openBrace !== -1 && closeBrace !== -1) {
      const matchedJson = errorMessage.slice(openBrace, closeBrace + 1);
      const parsed = JSON.parse(matchedJson) as { retry_after?: number; description?: string };
      const result: { retryAfter?: number; description?: string } = {};
      if (parsed.retry_after !== undefined) {
        result.retryAfter = parsed.retry_after;
      }
      if (parsed.description !== undefined) {
        result.description = parsed.description;
      }
      return result;
    }
  } catch {
    // Fall back to regex
  }

  const retryAfterRegex = /"retry_after":?\s*(?<seconds>\d+)/u;
  const match = retryAfterRegex.exec(errorMessage);
  const result: { retryAfter?: number; description?: string } = {};
  if (match?.groups) {
    const { groups } = match;
    if ("seconds" in groups) {
      const { seconds } = groups;
      if (seconds) {
        result.retryAfter = Number.parseInt(seconds, 10);
      }
    }
  }
  return result;
}

export type TelegramLedger = { sentIds: number[]; lastUpdatedISO?: string };

export async function readTelegramLedger(path: string): Promise<TelegramLedger> {
  const { readJsonSafeOr } = await import("@utils/json");
  const { z } = await import("zod");
  const schema = z.object({
    sentIds: z.array(z.number()).default([]),
    lastUpdatedISO: z.string().optional(),
  });
  return (await readJsonSafeOr(path, schema, { sentIds: [] })) as TelegramLedger;
}

export async function writeTelegramLedger(path: string, ledger: TelegramLedger): Promise<void> {
  const { writeJsonFile } = await import("@utils/json");
  await writeJsonFile(path, ledger);
}
