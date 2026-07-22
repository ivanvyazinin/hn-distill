import { applyEnv, COMMENTS_POLICY_VERSION, parseEnv, type Env } from "@config/env";
import { pathFor } from "@config/paths";
import { type AggregatedFile, type CommentsSummary, type NormalizedStory } from "@config/schemas";
import { HttpClient } from "@utils/http-client";
import { log } from "@utils/log";
import { Telegram, buildTelegramMessage, parseTelegramError, type TelegramDigestItem } from "@utils/telegram";

import { main as aggregateMain } from "../../pipeline/aggregate";
import { main as fetchMain, makeServices as makeFetchServices } from "../../pipeline/fetch-hn";
import {
  computeCommentsChanged,
  makeServices as makeSummarizeServices,
  processSingleStory,
} from "../../pipeline/summarize";

import type { QueueBatch, WorkerEnv } from "./bindings";
import {
  acquireRunLock,
  getAggregateState,
  getCommentsPolicyStates,
  getProcessingUpdatedMax,
  getPagesDeployState,
  getTelegramSentIds,
  listLegacyExtractionStoryIds,
  listPendingStoryIds,
  markTelegramSent,
  setPagesDeployState,
  setAggregateState,
  upsertProcessingState,
  upsertStory,
} from "./d1";
import { createD1MetaStore } from "./d1-meta-store";
import { buildScheduleForDate, shouldTriggerSlot } from "./pages-schedule";
import { createWorkerStore } from "./store";
import type { TaskMessage } from "./types";

const LOCK_KEY = "cron";
const AGG_KEY = "aggregate";
const PAGES_KEY = "pages";
const LOCK_TTL_MS = 55 * 60 * 1000;
type ScheduledEvent = { scheduledTime?: number };
const TIMEOUT_BUFFER_MS = 2_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function extractEnvBindings(env: WorkerEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function initEnv(env: WorkerEnv): Env {
  const parsed = parseEnv(extractEnvBindings(env));
  applyEnv(parsed);
  return parsed;
}

async function upsertStoriesFromStore(
  db: WorkerEnv["DB"],
  store: ReturnType<typeof createWorkerStore>,
  storyIds: number[],
  fetchedISO: string
): Promise<void> {
  for (const [index, id] of storyIds.entries()) {
    const story = await store.getJson<NormalizedStory>(pathFor.rawItem(id));
    if (!story) {
      continue;
    }
    await upsertStory(db, story, index, fetchedISO);
  }
}

async function enqueueSummaries(queue: NonNullable<WorkerEnv["TASKS"]>, ids: number[]): Promise<void> {
  // Queue delivery is at-least-once. Selection and summary persistence are
  // deliberately idempotent through the comments policy/input hash pair.
  for (const id of ids) {
    await queue.send({ kind: "summarize", id } satisfies TaskMessage);
  }
}

function isProcessingStateInsideCooldown(updatedAt: string | undefined, cutoffISO: string): boolean {
  if (updatedAt === undefined) {
    return false;
  }
  const updated = Date.parse(updatedAt);
  const cutoff = Date.parse(cutoffISO);
  return Number.isFinite(updated) && Number.isFinite(cutoff) && updated >= cutoff;
}

async function selectSummarizeIds(
  env: WorkerEnv,
  parsedEnv: Env,
  store: ReturnType<typeof createWorkerStore>,
  currentStoryIds: number[],
  fetchedISO: string
): Promise<number[]> {
  const maxPerCron = Math.max(1, parsedEnv.WORKER_SUMMARIZE_MAX_PER_CRON);
  const cooldownMs = Math.max(60_000, parsedEnv.WORKER_RETRY_COOLDOWN_SECONDS * 1000);
  const cutoffISO = new Date(Date.now() - cooldownMs).toISOString();
  const currentIds = [...new Set(currentStoryIds)];
  const sqlPending = new Set(
    await listPendingStoryIds(env.DB, maxPerCron, cutoffISO, fetchedISO, COMMENTS_POLICY_VERSION)
  );
  const policyStates = await getCommentsPolicyStates(env.DB, currentIds);
  const selectedCurrent: number[] = [];

  for (const id of currentIds) {
    if (selectedCurrent.length >= maxPerCron) {
      break;
    }
    const state = policyStates.get(id);
    if (!sqlPending.has(id) && isProcessingStateInsideCooldown(state?.updatedAt, cutoffISO)) {
      continue;
    }

    const story = await store.getJson<NormalizedStory>(pathFor.rawItem(id));
    if (story === null) {
      if (sqlPending.has(id)) {
        selectedCurrent.push(id);
      }
      continue;
    }
    const existingComments = await store.getJson<CommentsSummary>(pathFor.commentsSummary(id));
    const inputChanged = await computeCommentsChanged(
      story,
      existingComments,
      parsedEnv.SUMMARY_LANG,
      0,
      Date.now(),
      store
    );
    const stateMismatch =
      state?.commentsPolicyVersion !== COMMENTS_POLICY_VERSION ||
      state.commentsInputHash !== existingComments?.inputHash;
    if (sqlPending.has(id) || inputChanged || stateMismatch) {
      selectedCurrent.push(id);
    }
  }

  if (!parsedEnv.WORKER_EXTRACTION_BACKFILL_ENABLE || selectedCurrent.length >= maxPerCron) {
    return selectedCurrent;
  }
  const selectedSet = new Set(selectedCurrent);
  const legacyIds = await listLegacyExtractionStoryIds(env.DB, maxPerCron, cutoffISO);
  const selectedLegacy = legacyIds.filter((id) => !selectedSet.has(id)).slice(0, maxPerCron - selectedCurrent.length);
  return [...selectedCurrent, ...selectedLegacy];
}

async function collectTelegramItems(
  env: WorkerEnv,
  aggregated: AggregatedFile | undefined,
  parsedEnv: Env
): Promise<TelegramDigestItem[]> {
  if (!parsedEnv.TELEGRAM_ENABLE || !parsedEnv.TELEGRAM_BOT_TOKEN || !parsedEnv.TELEGRAM_CHAT_ID) {
    log.info("worker/telegram", "Telegram disabled or missing config");
    return [];
  }
  if (!aggregated || aggregated.items.length === 0) {
    log.info("worker/telegram", "No aggregated items for Telegram");
    return [];
  }

  const candidates = aggregated.items.filter((item) => (item.postSummary ?? "").trim().length > 0);
  const limited = candidates.slice(0, Math.max(1, parsedEnv.TELEGRAM_MAX_ITEMS));
  const sent = await getTelegramSentIds(env.DB, limited.map((item) => item.id));

  const items: TelegramDigestItem[] = [];
  for (const item of limited) {
    if (sent.has(item.id)) {
      continue;
    }
    const payload: TelegramDigestItem = {
      id: item.id,
      title: item.title,
      url: item.url,
      ...(item.domain === undefined ? {} : { domain: item.domain }),
      ...(item.hnUrl === undefined ? {} : { hnUrl: item.hnUrl }),
      ...(item.postSummary === undefined ? {} : { postSummary: item.postSummary }),
      ...(item.commentsSummary === undefined ? {} : { commentsSummary: item.commentsSummary }),
      ...(item.commentsInsights === undefined
        ? {}
        : { commentsInsights: { lead: item.commentsInsights.lead } }),
      timeISO: item.timeISO,
    };
    items.push(payload);
  }
  return items;
}

async function enqueueTelegramTasks(
  env: WorkerEnv,
  aggregated: AggregatedFile | undefined,
  parsedEnv: Env
): Promise<void> {
  if (!env.TASKS) {
    return;
  }
  const items = await collectTelegramItems(env, aggregated, parsedEnv);
  for (const item of items) {
    await env.TASKS.send({ kind: "telegram", item } satisfies TaskMessage);
  }
}

async function processInlineSummaries(
  env: WorkerEnv,
  parsedEnv: Env,
  store: ReturnType<typeof createWorkerStore>,
  meta: ReturnType<typeof createD1MetaStore>,
  startedAt: number,
  cronTimeout: number,
  currentStoryIds: number[],
  fetchedISO: string
): Promise<void> {
  const ids = await selectSummarizeIds(env, parsedEnv, store, currentStoryIds, fetchedISO);
  if (ids.length === 0) {
    log.info("worker/cron", "No pending summaries");
    return;
  }

  const taskTimeoutBase = Math.max(1_000, parsedEnv.WORKER_QUEUE_TASK_TIMEOUT_MS);
  // One TPD breaker set for the whole inline pass — a per-story makeServices() would
  // re-hit models already proven exhausted earlier in this cron run.
  const commentsTpdExhaustedModels = new Set<string>();
  for (const id of ids) {
    const elapsed = Date.now() - startedAt;
    const remaining = cronTimeout - elapsed - TIMEOUT_BUFFER_MS;
    if (remaining <= 1000) {
      log.warn("worker/cron", "Stopping inline summarize due to cron budget", { elapsed, cronTimeout });
      break;
    }
    const taskTimeout = Math.min(taskTimeoutBase, remaining);
    try {
      await withTimeout(
        handleSummarizeTask(env, parsedEnv, store, id, meta, taskTimeout, commentsTpdExhaustedModels),
        taskTimeout,
        `summarize:${id}`
      );
    } catch (error) {
      log.error("worker/cron", "Inline summarize failed", { id, error: String(error) });
    }
  }
}

async function processInlineTelegram(
  env: WorkerEnv,
  parsedEnv: Env,
  aggregated: AggregatedFile | undefined,
  startedAt: number,
  cronTimeout: number
): Promise<void> {
  const items = await collectTelegramItems(env, aggregated, parsedEnv);
  if (items.length === 0) {
    return;
  }

  const taskTimeoutBase = Math.max(1_000, parsedEnv.WORKER_QUEUE_TASK_TIMEOUT_MS);
  for (const item of items) {
    const elapsed = Date.now() - startedAt;
    const remaining = cronTimeout - elapsed - TIMEOUT_BUFFER_MS;
    if (remaining <= 1000) {
      log.warn("worker/cron", "Stopping inline Telegram due to cron budget", { elapsed, cronTimeout });
      break;
    }
    const taskTimeout = Math.min(taskTimeoutBase, remaining);
    try {
      await withTimeout(handleTelegramTask(env, parsedEnv, item), taskTimeout, `telegram:${item.id}`);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      log.error("worker/cron", "Inline Telegram failed", { id: item.id, error: err });
      if (err.includes("429") || err.includes("Too Many Requests")) {
        break;
      }
    }

    if (parsedEnv.TELEGRAM_MESSAGE_DELAY_MS > 0) {
      const delay = parsedEnv.TELEGRAM_MESSAGE_DELAY_MS;
      const remainingAfter = cronTimeout - (Date.now() - startedAt) - TIMEOUT_BUFFER_MS;
      if (remainingAfter <= delay) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function handleSummarizeTask(
  env: WorkerEnv,
  parsedEnv: Env,
  store: ReturnType<typeof createWorkerStore>,
  storyId: number,
  meta: ReturnType<typeof createD1MetaStore>,
  taskTimeoutMs: number,
  commentsTpdExhaustedModels?: Set<string>
): Promise<void> {
  const deadlineAt = Date.now() + taskTimeoutMs - TIMEOUT_BUFFER_MS;
  if (!parsedEnv.OPENROUTER_API_KEY) {
    log.warn("worker/summarize", "OPENROUTER_API_KEY missing; skipping", { id: storyId });
    return;
  }
  const services = makeSummarizeServices(parsedEnv, {
    ...(commentsTpdExhaustedModels === undefined ? {} : { commentsTpdExhaustedModels }),
  });
  try {
    await processSingleStory(services, storyId, store, meta, { deadlineAt });
  } catch (error) {
    await upsertProcessingState(env.DB, storyId, {
      postStatus: "error",
      commentsStatus: "error",
      tagsStatus: "error",
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    log.error("worker/summarize", "Summarize task failed", { id: storyId, error: String(error) });
  }
}

async function handleTelegramTask(env: WorkerEnv, parsedEnv: Env, item: TelegramDigestItem): Promise<void> {
  if (!parsedEnv.TELEGRAM_ENABLE || !parsedEnv.TELEGRAM_BOT_TOKEN || !parsedEnv.TELEGRAM_CHAT_ID) {
    return;
  }
  const sent = await getTelegramSentIds(env.DB, [item.id]);
  if (sent.has(item.id)) {
    return;
  }

  const http = new HttpClient({
    retries: parsedEnv.HTTP_RETRIES,
    baseBackoffMs: parsedEnv.HTTP_BACKOFF_MS,
    timeoutMs: parsedEnv.HTTP_TIMEOUT_MS,
    retryOnStatuses: [408, 425, 429, 500, 502, 503, 504, 522],
  });
  const telegram = new Telegram(http, parsedEnv.TELEGRAM_BOT_TOKEN);

  const message = buildTelegramMessage(item, parsedEnv.SITE, { language: parsedEnv.SUMMARY_LANG });

  try {
    const messageId = await telegram.sendMessage({
      chatId: parsedEnv.TELEGRAM_CHAT_ID,
      text: message,
      parseMode: "HTML",
      disableWebPagePreview: true,
      disableNotification: parsedEnv.TELEGRAM_DISABLE_NOTIFICATIONS,
      ...(parsedEnv.TELEGRAM_MESSAGE_THREAD_ID && { messageThreadId: parsedEnv.TELEGRAM_MESSAGE_THREAD_ID }),
    });
    await markTelegramSent(env.DB, item.id, messageId, new Date().toISOString());
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    if (err.includes("429") || err.includes("Too Many Requests")) {
      const parsed = parseTelegramError(err);
      log.warn("worker/telegram", "Telegram rate limit", { id: item.id, retryAfter: parsed.retryAfter });
      throw error;
    }
    log.error("worker/telegram", "Failed to send Telegram message", { id: item.id, error: err });
  }
}

function slotKeyUTC(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hour = String(d.getUTCHours()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${day}-${hour}`;
}

async function maybeTriggerPagesDeploy(env: WorkerEnv, parsedEnv: Env): Promise<void> {
  if (!parsedEnv.PAGES_DEPLOY_ENABLE) {
    return;
  }
  const hook = parsedEnv.PAGES_DEPLOY_HOOK_URL?.trim();
  if (!hook) {
    return;
  }

  const now = new Date();
  const target = Math.max(1, parsedEnv.PAGES_DEPLOY_TARGET_PER_MONTH);
  if (!shouldTriggerSlot(now, target)) {
    return;
  }

  const schedule = buildScheduleForDate(now, target);
  const slot = slotKeyUTC(now);
  const state = await getPagesDeployState(env.DB, PAGES_KEY);
  const sameMonth = state?.monthKey === schedule.monthKey;
  const used = sameMonth ? Math.max(0, state?.usedCount ?? 0) : 0;
  const lastSlot = sameMonth ? state?.lastSlot ?? undefined : undefined;

  if (lastSlot === slot) {
    return;
  }
  if (used >= target) {
    log.warn("worker/pages", "Monthly deploy cap reached", { used, target, month: schedule.monthKey });
    return;
  }

  const response = await fetch(hook, { method: "POST" });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    log.warn("worker/pages", "Deploy hook failed", { status: response.status, body: body.slice(0, 200) });
    return;
  }

  await setPagesDeployState(env.DB, PAGES_KEY, schedule.monthKey, used + 1, slot, new Date().toISOString());
  log.info("worker/pages", "Triggered Pages deploy", {
    month: schedule.monthKey,
    used: used + 1,
    target,
    dayQuota: schedule.dayQuota,
    dayIndex: schedule.dayIndex + 1,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    initEnv(env);
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    return new Response("hn-distill worker", { status: 200 });
  },

  async scheduled(event: ScheduledEvent, env: WorkerEnv): Promise<void> {
    const parsedEnv = initEnv(env);
    const nowISO = new Date().toISOString();
    const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    const owner = typeof cryptoObj?.randomUUID === "function" ? cryptoObj.randomUUID() : `run-${Date.now()}`;
    const hasLock = await acquireRunLock(env.DB, LOCK_KEY, nowISO, LOCK_TTL_MS, owner);
    if (!hasLock) {
      log.warn("worker/cron", "Run skipped: lock held", { owner });
      return;
    }

    const store = createWorkerStore(env.DATA_BUCKET);
    const meta = createD1MetaStore(env.DB);
    const fetchServices = makeFetchServices(parsedEnv);
    const cronTimeout = Math.max(1_000, parsedEnv.WORKER_CRON_TIMEOUT_MS);
    const queue = env.TASKS;

    const startedAt = Date.now();
    const index = await withTimeout(fetchMain(fetchServices, store, meta), cronTimeout - TIMEOUT_BUFFER_MS, "fetch-main");
    await upsertStoriesFromStore(env.DB, store, index.storyIds, nowISO);
    if (queue) {
      await enqueueSummaries(queue, await selectSummarizeIds(env, parsedEnv, store, index.storyIds, nowISO));
    } else {
      await processInlineSummaries(env, parsedEnv, store, meta, startedAt, cronTimeout, index.storyIds, nowISO);
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed + TIMEOUT_BUFFER_MS >= cronTimeout) {
      log.warn("worker/cron", "Skipping aggregate due to cron budget", { elapsed, cronTimeout });
      return;
    }

    const processingUpdatedISO = await getProcessingUpdatedMax(env.DB);
    const aggregateState = await getAggregateState(env.DB, AGG_KEY);
    const prevIndexISO = aggregateState?.indexUpdatedISO ?? null;
    const prevProcessingISO = aggregateState?.processingUpdatedISO ?? null;
    const nextProcessingISO = processingUpdatedISO ?? null;

    const shouldAggregate = prevIndexISO !== index.updatedISO || prevProcessingISO !== nextProcessingISO;
    let aggregated: AggregatedFile | undefined;

    if (shouldAggregate) {
      const fromDb = parsedEnv.AGGREGATE_FROM_DB === true;
      aggregated = await withTimeout(
        aggregateMain(store, meta, fromDb ? { fromDb: true } : undefined),
        cronTimeout - elapsed,
        "aggregate"
      );
      await setAggregateState(env.DB, AGG_KEY, index.updatedISO, nextProcessingISO, new Date().toISOString());
    } else {
      aggregated = await store.getJson<AggregatedFile>(pathFor.aggregated);
      log.info("worker/cron", "Aggregate unchanged; skipping recompute", {
        indexUpdatedISO: index.updatedISO,
        processingUpdatedISO: nextProcessingISO,
      });
    }

    if (queue) {
      await enqueueTelegramTasks(env, aggregated, parsedEnv);
    } else {
      await processInlineTelegram(env, parsedEnv, aggregated, startedAt, cronTimeout);
    }

    const remaining = cronTimeout - (Date.now() - startedAt) - TIMEOUT_BUFFER_MS;
    if (remaining > 1000) {
      await maybeTriggerPagesDeploy(env, parsedEnv);
    } else {
      log.warn("worker/cron", "Skipping Pages deploy due to cron budget", { remaining });
    }
  },

  async queue(batch: QueueBatch<TaskMessage>, env: WorkerEnv): Promise<void> {
    const parsedEnv = initEnv(env);
    const store = createWorkerStore(env.DATA_BUCKET);
    const meta = createD1MetaStore(env.DB);
    const taskTimeout = Math.max(1_000, parsedEnv.WORKER_QUEUE_TASK_TIMEOUT_MS);
    // Share TPD breaker across every summarize message in this queue batch. Cross-batch
    // persistence would need Durable Object / D1 state (out of Phase 3 scope); a new
    // batch still starts clean, matching "new run starts clean".
    const commentsTpdExhaustedModels = new Set<string>();

    for (const message of batch.messages) {
      const body = message.body;
      if (!body || typeof body !== "object") {
        continue;
      }
      if (body.kind === "summarize") {
        await withTimeout(
          handleSummarizeTask(env, parsedEnv, store, body.id, meta, taskTimeout, commentsTpdExhaustedModels),
          taskTimeout,
          `summarize:${body.id}`
        );
      } else if (body.kind === "telegram") {
        await withTimeout(handleTelegramTask(env, parsedEnv, body.item), taskTimeout, `telegram:${body.item.id}`);
      }
    }
  },
};
