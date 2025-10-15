import { env } from "@config/env";
import { PATHS } from "@config/paths";
import { HttpClient } from "@utils/http-client";
import { loadAggregated } from "@utils/load-aggregated";
import { log } from "@utils/log";
import { Telegram, chunkTelegramText, digestHash, escapeHtml, readSeenCache, writeSeenCache } from "@utils/telegram";

import type { AggregatedItem } from "@config/schemas";

async function main(): Promise<void> {
  // Check if Telegram publishing is enabled and configured
  if (!env.TELEGRAM_ENABLE || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    log.info("telegram", "Telegram publishing disabled or not configured");
    process.exit(0);
  }

  log.info("telegram", "Starting Telegram digest publishing", {
    maxItems: env.TELEGRAM_MAX_ITEMS,
    chatId: env.TELEGRAM_CHAT_ID,
  });

  // Load aggregated data
  const aggregated = loadAggregated(PATHS.aggregated);
  if (aggregated.items.length === 0) {
    log.info("telegram", "No aggregated data available");
    process.exit(0);
  }

  // Select and prepare items for digest
  const items = pickTop(aggregated.items, env.TELEGRAM_MAX_ITEMS);

  // Build message content
  const message = buildMessage(items, aggregated.updatedISO);

  // Check idempotency
  const hash = digestHash(items, aggregated.updatedISO);
  const seen = await readSeenCache(PATHS.seenCache);

  if (seen.telegram?.lastHash && hash === seen.telegram.lastHash) {
    log.info("telegram", "Digest unchanged, skipping", { hash });
    process.exit(0);
  }

  log.info("telegram", "Publishing new digest", {
    hash,
    itemCount: items.length,
    messageLength: message.length,
  });

  // Initialize HTTP client and Telegram API
  const http = new HttpClient({
    retries: env.HTTP_RETRIES,
    baseBackoffMs: env.HTTP_BACKOFF_MS,
    timeoutMs: env.HTTP_TIMEOUT_MS,
    retryOnStatuses: [429],
  });

  const telegram = new Telegram(http, env.TELEGRAM_BOT_TOKEN);

  // Chunk message if needed and send
  const chunks = chunkTelegramText(message);
  const messageIds: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) {
      throw new Error(`Chunk ${i} is undefined`);
    }

    log.debug("telegram", `Sending chunk ${i + 1}/${chunks.length}`, {
      chunkLength: chunk.length,
    });

    try {
      const messageId = await telegram.sendMessage({
        chatId: env.TELEGRAM_CHAT_ID,
        text: chunk,
        parseMode: "HTML",
        disableWebPagePreview: true,
        disableNotification: env.TELEGRAM_DISABLE_NOTIFICATIONS,
        ...(env.TELEGRAM_MESSAGE_THREAD_ID && { messageThreadId: env.TELEGRAM_MESSAGE_THREAD_ID }),
      });

      messageIds.push(messageId);

      // Add delay between chunks to be conservative
      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (error) {
      log.error("telegram", "Failed to send message chunk", { error, chunkIndex: i });
      throw error;
    }
  }

  // Update cache after successful send
  await writeSeenCache(PATHS.seenCache, {
    ...seen,
    telegram: {
      lastHash: hash,
      lastUpdatedISO: aggregated.updatedISO,
      lastIds: items.map((item: { id: number }) => item.id),
      sentAtISO: new Date().toISOString(),
    },
  });

  log.info("telegram", "Digest published successfully", {
    messageIds,
    chunksSent: chunks.length,
  });
}

function pickTop(
  items: AggregatedItem[],
  n: number
): Array<{
  id: number;
  title: string;
  domain?: string;
  url?: string | null;
  hnUrl?: string;
  postSummary?: string;
  commentsSummary?: string;
  timeISO: string;
}> {
  // Sort by timeISO desc (newest first) and take top N
  return items
    .sort((a, b) => new Date(b.timeISO).getTime() - new Date(a.timeISO).getTime())
    .slice(0, n)
    .map((item: AggregatedItem) => ({
      id: item.id,
      title: item.title,
      domain: item.domain,
      url: item.url,
      hnUrl: item.hnUrl,
      postSummary: item.postSummary,
      commentsSummary: item.commentsSummary,
      timeISO: item.timeISO,
    })) as Array<{
    id: number;
    title: string;
    domain?: string;
    url?: string | null;
    hnUrl?: string;
    postSummary?: string;
    commentsSummary?: string;
    timeISO: string;
  }>;
}

function buildMessage(
  items: Array<{
    id: number;
    title: string;
    domain?: string;
    url?: string | null;
    hnUrl?: string;
    postSummary?: string;
    commentsSummary?: string;
    timeISO: string;
  }>,
  updatedISO: string
): string {
  const dateFormatter = new Intl.DateTimeFormat(env.SUMMARY_LANG, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const header = `🧾 HN digest — ${dateFormatter.format(new Date(updatedISO))}`;

  const itemLines = items.map((item) => {
    // Prefer postSummary, fallback to commentsSummary, or empty string
    const summary = item.postSummary ?? item.commentsSummary ?? "";
    // Truncate summary to ~240 chars to control message size
    const truncatedSummary = summary.length > 240 ? `${summary.slice(0, 240)}...` : summary;

    // Build canonical URL: prefer site page if SITE is set, else external URL or HN URL
    const itemLink = env.SITE ? `${env.SITE.replace(/\/$/u, "")}/item/${item.id}` : item.url ?? item.hnUrl ?? "";

    const domainText = item.domain ? ` (${item.domain})` : "";
    const hnLink = item.hnUrl ? ` · <a href="${item.hnUrl}">HN</a>` : "";

    const line = `• <b>${escapeHtml(item.title)}</b>${domainText}\n  <a href="${itemLink}">Read</a>${hnLink}`;
    return truncatedSummary ? `${line}\n${escapeHtml(truncatedSummary)}` : line;
  });

  return [header, ...itemLines].join("\n\n");
}

// Run main function and handle errors
main().catch((error) => {
  log.error("telegram", "Fatal error in Telegram publishing", { error });
  process.exit(1);
});
