import { env } from "@config/env";
import { PATHS } from "@config/paths";
import { HttpClient } from "@utils/http-client";
import { loadAggregated } from "@utils/load-aggregated";
import { log } from "@utils/log";
import { Telegram, digestHash, escapeHtml, readSeenCache, writeSeenCache } from "@utils/telegram";

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

  // Check idempotency
  const hash = await digestHash(items, aggregated.updatedISO);
  const seen = await readSeenCache(PATHS.seenCache);

  if (seen.telegram?.lastHash && hash === seen.telegram.lastHash) {
    log.info("telegram", "Digest unchanged, skipping", { hash });
    process.exit(0);
  }

  log.info("telegram", "Publishing new digest", {
    hash,
    itemCount: items.length,
  });

  // Initialize HTTP client and Telegram API
  const http = new HttpClient({
    retries: env.HTTP_RETRIES,
    baseBackoffMs: env.HTTP_BACKOFF_MS,
    timeoutMs: env.HTTP_TIMEOUT_MS,
    retryOnStatuses: [429],
  });

  const telegram = new Telegram(http, env.TELEGRAM_BOT_TOKEN);

  // Build individual messages for each news item
  const messages = buildMessages(items, aggregated.updatedISO);
  const messageIds: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    let message = messages[i];
    if (!message) {
      throw new Error(`Message ${i} is undefined`);
    }

    // Check Telegram message length limit (4096 characters)
    const TELEGRAM_LIMIT = 4096;
    if (message.length > TELEGRAM_LIMIT) {
      log.warn("telegram", `Message ${i + 1} exceeds Telegram limit, truncating`, {
        originalLength: message.length,
        limit: TELEGRAM_LIMIT,
      });
      // Truncate to fit within limit, trying to end at a sentence or word boundary
      message = message.slice(0, TELEGRAM_LIMIT - 3) + "...";
    }

    log.debug("telegram", `Sending news item ${i + 1}/${messages.length}`, {
      messageLength: message.length,
      title: items[i]?.title?.slice(0, 50) + (items[i]?.title?.length > 50 ? "..." : ""),
    });

    try {
      const messageId = await telegram.sendMessage({
        chatId: env.TELEGRAM_CHAT_ID,
        text: message,
        parseMode: "HTML",
        disableWebPagePreview: true,
        disableNotification: env.TELEGRAM_DISABLE_NOTIFICATIONS,
        ...(env.TELEGRAM_MESSAGE_THREAD_ID && { messageThreadId: env.TELEGRAM_MESSAGE_THREAD_ID }),
      });

      messageIds.push(messageId);

      // Add delay between messages to be conservative
      if (i < messages.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (error) {
      log.error("telegram", "Failed to send news item", { error, itemIndex: i, title: items[i]?.title });
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
    messagesSent: messages.length,
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

function buildMessages(
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
): string[] {
  const dateFormatter = new Intl.DateTimeFormat(env.SUMMARY_LANG, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const header = `🧾 HN — ${dateFormatter.format(new Date(updatedISO))}\n\n`;

  return items.map((item) => {
    // Prefer postSummary, fallback to commentsSummary, or empty string
    const summary = item.postSummary ?? item.commentsSummary ?? "";

    // Build canonical URL: prefer site page if SITE is set, else external URL or HN URL
    const itemLink = env.SITE ? `${env.SITE.replace(/\/$/u, "")}/item/${item.id}` : item.url ?? item.hnUrl ?? "";

    const domainText = item.domain ? ` (${item.domain})` : "";
    const hnLink = item.hnUrl ? ` · <a href="${item.hnUrl}">HN</a>` : "";

    const titleLine = `<b>${escapeHtml(item.title)}</b>${domainText}`;
    const linkLine = `  <a href="${itemLink}">Read</a>${hnLink}`;
    const summaryLine = summary ? `\n\n${escapeHtml(summary)}` : "";

    return `${header}${titleLine}\n${linkLine}${summaryLine}`;
  });
}

// Run main function and handle errors
main().catch((error) => {
  log.error("telegram", "Fatal error in Telegram publishing", { error });
  process.exit(1);
});
