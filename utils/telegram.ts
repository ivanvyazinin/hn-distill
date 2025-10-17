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
  timeISO: string;
};

export type SeenCache = {
  telegram?: {
    lastHash?: string;
    lastUpdatedISO?: string;
    sentAtISO?: string;
    lastIds?: number[];
  };
};

export async function digestHash(items: TelegramDigestItem[]): Promise<string> {
  const { createHash } = await import("node:crypto");
  const payload = {
    ids: items.map((i: TelegramDigestItem) => i.id),
    titles: items.map((i: TelegramDigestItem) => i.title),
    summaries: items.map((i: TelegramDigestItem) => i.postSummary?.trim() ?? ""),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
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
