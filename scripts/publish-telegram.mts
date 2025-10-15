import { join } from "node:path";

import { env } from "@config/env";
import { PATHS } from "@config/paths";
import { HttpClient } from "@utils/http-client";
import { loadAggregated } from "@utils/load-aggregated";
import { log } from "@utils/log";
import {
  Telegram,
  deleteProgress,
  digestHash,
  escapeHtml,
  parseTelegramError,
  readProgress,
  readSeenCache,
  writeProgress,
  writeSeenCache,
} from "@utils/telegram";

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

  // Check idempotency (content-based hash only)
  const hash = await digestHash(items);
  const seen = await readSeenCache(PATHS.seenCache);

  if (seen.telegram?.lastHash && hash === seen.telegram.lastHash) {
    log.info("telegram", "Digest unchanged (same content), skipping", { hash });
    process.exit(0);
  }

  // Check for existing progress from previous run
  const progressPath = join(PATHS.cache, "telegram-progress.json");
  let progress = await readProgress(progressPath);

  // If progress exists but hash changed, start fresh
  if (progress !== undefined && progress.hash !== hash) {
    log.info("telegram", "Content changed since last run, starting fresh", {
      oldHash: progress.hash,
      freshHash: hash,
    });
    await deleteProgress(progressPath);
    progress = undefined;
  }

  // Resume from progress or start fresh
  const alreadySentIds = new Set(progress?.sentItems.map((item) => item.id) ?? []);
  const itemsToSend = items.filter((item) => !alreadySentIds.has(item.id));

  if (itemsToSend.length === 0 && progress !== undefined) {
    log.info("telegram", "All items already sent in previous run, finalizing", {
      hash,
      totalItems: items.length,
    });
    // Mark as complete and clean up
    await writeSeenCache(PATHS.seenCache, {
      ...seen,
      telegram: {
        lastHash: hash,
        lastUpdatedISO: aggregated.updatedISO,
        lastIds: items.map((item: { id: number }) => item.id),
        sentAtISO: new Date().toISOString(),
      },
    });
    await deleteProgress(progressPath);
    process.exit(0);
  }

  log.info("telegram", "Publishing digest", {
    hash,
    totalItems: items.length,
    alreadySent: alreadySentIds.size,
    toSend: itemsToSend.length,
    resuming: progress !== undefined,
  });

  // Initialize HTTP client and Telegram API
  const http = new HttpClient({
    retries: env.HTTP_RETRIES,
    baseBackoffMs: env.HTTP_BACKOFF_MS,
    timeoutMs: env.HTTP_TIMEOUT_MS,
    retryOnStatuses: [429],
  });

  const telegram = new Telegram(http, env.TELEGRAM_BOT_TOKEN);

  // Initialize or restore progress
  if (progress === undefined) {
    progress = {
      hash,
      startedAt: new Date().toISOString(),
      sentItems: [],
    };
    await writeProgress(progressPath, progress);
  }

  // Build individual messages for items to send
  const messages = buildMessages(itemsToSend);
  const allMessageIds: number[] = progress.sentItems.map((item) => item.messageId);

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
      message = `${message.slice(0, TELEGRAM_LIMIT - 3)}...`;
    }

    const item = itemsToSend[i];
    if (!item) {
      throw new Error(`Item ${i} is undefined`);
    }

    log.debug("telegram", `Sending news item ${i + 1}/${messages.length}`, {
      itemId: item.id,
      messageLength: message.length,
      title: `${item.title.slice(0, 50)}${item.title.length > 50 ? "..." : ""}`,
    });

    let sent = false;
    let retryCount = 0;
    const MAX_RATE_LIMIT_RETRIES = env.TELEGRAM_MAX_RATE_LIMIT_RETRIES;

    while (!sent && retryCount < MAX_RATE_LIMIT_RETRIES) {
      try {
        const messageId = await telegram.sendMessage({
          chatId: env.TELEGRAM_CHAT_ID,
          text: message,
          parseMode: "HTML",
          disableWebPagePreview: true,
          disableNotification: env.TELEGRAM_DISABLE_NOTIFICATIONS,
          ...(env.TELEGRAM_MESSAGE_THREAD_ID && { messageThreadId: env.TELEGRAM_MESSAGE_THREAD_ID }),
        });

        allMessageIds.push(messageId);
        sent = true;

        // Update progress immediately after successful send
        progress.sentItems.push({
          id: item.id,
          messageId,
          sentAt: new Date().toISOString(),
        });
        await writeProgress(progressPath, progress);

        log.info("telegram", `Sent item ${i + 1}/${messages.length}`, {
          itemId: item.id,
          messageId,
        });

        // Delay between messages to avoid rate limits
        if (i < messages.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, env.TELEGRAM_MESSAGE_DELAY_MS));
        }
      } catch (error) {
        if (error instanceof Error && (error.message.includes("429") || error.message.includes("Too Many Requests"))) {
          const { retryAfter, description } = parseTelegramError(error.message);
          const waitSeconds = retryAfter ?? 30;

          log.warn("telegram", "Rate limit hit, waiting before retry", {
            itemIndex: i,
            itemId: item.id,
            retryAfter: waitSeconds,
            retryCount: retryCount + 1,
            maxRetries: MAX_RATE_LIMIT_RETRIES,
            description,
          });

          // Exponential backoff for consecutive rate limits
          const backoffMultiplier = Math.pow(1.5, retryCount);
          const totalWait = Math.ceil(waitSeconds * backoffMultiplier);

          await new Promise((resolve) => setTimeout(resolve, (totalWait + 1) * 1000));
          retryCount++;
        } else {
          log.error("telegram", "Failed to send news item", {
            error,
            itemIndex: i,
            itemId: item.id,
            title: item.title,
          });
          throw error;
        }
      }
    }

    if (!sent) {
      throw new Error(
        `Failed to send message for item ${item.id} after ${MAX_RATE_LIMIT_RETRIES} retries due to rate limiting`
      );
    }
  }

  // All messages sent successfully, update cache and clean up progress
  await writeSeenCache(PATHS.seenCache, {
    ...seen,
    telegram: {
      lastHash: hash,
      lastUpdatedISO: aggregated.updatedISO,
      lastIds: items.map((item: { id: number }) => item.id),
      sentAtISO: new Date().toISOString(),
    },
  });

  await deleteProgress(progressPath);

  log.info("telegram", "Digest published successfully", {
    messageIds: allMessageIds,
    messagesSent: items.length,
    newlySent: messages.length,
    hash,
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
  }>
): string[] {
  return items.map((item) => {
    // Prefer postSummary, fallback to commentsSummary, or empty string
    const summary = item.postSummary ?? item.commentsSummary ?? "";

    // Build links section
    const links: string[] = [];

    // Original source link
    if (item.url) {
      links.push(`<a href="${item.url}">источник</a>`);
    }

    // Link to our site
    const siteLink = `https://hckr.top/item/${item.id}`;
    links.push(`<a href="${siteLink}">читать на hckr.top</a>`);

    // HN comments
    if (item.hnUrl) {
      links.push(`<a href="${item.hnUrl}">комментарии на HN</a>`);
    }

    const linksLine = links.length > 0 ? `\n\n${links.join(" | ")}` : "";

    const titleLine = `<b>${escapeHtml(item.title)}</b>`;
    const summaryLine = summary ? `\n\n${escapeHtml(summary)}` : "";

    return `${titleLine}${summaryLine}${linksLine}`;
  });
}

// Run main function and handle errors
main().catch((error) => {
  log.error("telegram", "Fatal error in Telegram publishing", { error });
  process.exit(1);
});
