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
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      ...(p.disableNotification !== undefined && { disable_notification: p.disableNotification }),
      ...(p.messageThreadId && { message_thread_id: p.messageThreadId }),
    };

    const response = await this.http.json<{ ok: boolean; result?: { message_id: number } }>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      retryOnStatuses: [429],
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

export function digestHash(items: TelegramDigestItem[], updatedISO: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef, @typescript-eslint/no-unsafe-assignment
  const { createHash } = require("node:crypto");
  const payload = {
    updatedISO,
    ids: items.map((i: TelegramDigestItem) => i.id),
    titles: items.map((i: TelegramDigestItem) => i.title),
    summaries: items.map((i: TelegramDigestItem) => i.postSummary ?? i.commentsSummary ?? ""),
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
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
