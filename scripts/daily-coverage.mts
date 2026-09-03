import { existsSync, readFileSync } from "node:fs";

import { env } from "@config/env";
import { PATHS, pathFor } from "@config/paths";
import { DailyGroupFileSchema, IndexSchema } from "@config/schemas";
import { passesEngagementGate } from "@utils/engagement-gate";
import { HttpClient } from "@utils/http-client";
import { loadAggregated } from "@utils/load-aggregated";
import { log } from "@utils/log";
import { escapeHtml, Telegram } from "@utils/telegram";

import { fetchItem, makeServices, readTopIds, type Services } from "./fetch-hn.mts";

const COVERAGE_TOP_N = 10;
export type CoverageInput = {
  day: string;
  /** Top stories for the day by final score, best first. */
  top: Array<{ id: number; title?: string; score?: number }>;
  publishedIds: Iterable<number>;
  publishedYesterday: number;
  minCards: number;
  minCoverage: number;
  /** Optional miss reasons by story id, attached to MISS rows. */
  reasons?: Record<number, string>;
};

/**
 * Local pipeline state for one missed story. Built from index.json (what was
 * selected), the raw item, and post/article artifacts with their metadata —
 * not from bare file existence, which lies: fetch-hn indexes ids whose fetch
 * failed, and no-article extracts are still saved as .md files.
 */
export type MissSnapshot = {
  /** Present in index.json: the story was selected this run. */
  selected: boolean;
  hasRaw: boolean;
  hasUrl: boolean;
  /** Article extract state: 'na' when there is no URL to fetch. */
  article: "missing" | "na" | "no-article" | "ok";
  /** Post summary state from the persisted file record. */
  post: "failed" | "missing" | "no-article" | "ok";
  passesGate: boolean;
};

/**
 * Probable cause of a miss, cheapest explanation first. Pure: feed it a
 * snapshot built from local files, get a one-line reason for the report.
 */
export function classifyMiss(snapshot: MissSnapshot): string {
  if (!snapshot.selected && !snapshot.hasRaw) {
    return "not selected: missing from index.json and local raw (outside top-N selection)";
  }
  if (snapshot.selected && !snapshot.hasRaw) {
    return "selected but story fetch failed (in index.json, no raw item)";
  }
  if (!snapshot.passesGate) {
    return "below engagement gate (score/comments too low at selection time)";
  }
  if (!snapshot.hasUrl) {
    return "no URL (Tell HN / text post): no article to summarize, card dropped by publish bar";
  }
  if (snapshot.post === "no-article" || snapshot.article === "no-article") {
    return "article extract unusable (no-article boilerplate): post LLM skipped by design";
  }
  if (snapshot.article === "missing") {
    return "article download failed (paywall / JS / bot protection)";
  }
  if (snapshot.post === "failed" || snapshot.post === "missing") {
    return "post summary missing (LLM / guard dropped it)";
  }
  return "post ready but card dropped at aggregate (sanitizer / publish heuristics)";
}

export type CoverageRow = {
  id: number;
  title: string;
  score: number;
  hit: boolean;
  /** Human-readable miss reason; set only for misses when known. */
  reason?: string;
};

export type CoverageReport = {
  day: string;
  rows: CoverageRow[];
  hits: number;
  total: number;
  coverageRatio: number;
  publishedYesterday: number;
  alerts: string[];
};

/** Pure decision core: match day top-10 against the published digest and derive alerts. */
export function computeCoverage(input: CoverageInput): CoverageReport {
  const published = new Set(input.publishedIds);
  const rows: CoverageRow[] = input.top.map((story) => {
    const title = story.title?.trim();
    const hit = published.has(story.id);
    return {
      id: story.id,
      title: title !== undefined && title.length > 0 ? title : "(title unavailable)",
      score: typeof story.score === "number" ? story.score : 0,
      hit,
      ...(!hit && input.reasons?.[story.id] !== undefined ? { reason: input.reasons[story.id] } : {}),
    };
  });
  const hits = rows.filter((row) => row.hit).length;
  const total = rows.length;
  const coverageRatio = total === 0 ? 1 : hits / total;

  const alerts: string[] = [];
  if (total > 0 && coverageRatio < input.minCoverage) {
    const pct = Math.round(coverageRatio * 100);
    const minPct = Math.round(input.minCoverage * 100);
    alerts.push(`coverage ${hits}/${total} (${pct}%) is below ${minPct}%`);
  }
  if (input.publishedYesterday < input.minCards) {
    alerts.push(`only ${input.publishedYesterday} cards published for ${input.day} (minimum ${input.minCards})`);
  }

  return {
    day: input.day,
    rows,
    hits,
    total,
    coverageRatio,
    publishedYesterday: input.publishedYesterday,
    alerts,
  };
}

export function renderSummaryMarkdown(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push(`### Daily digest coverage — ${report.day}`);
  lines.push("");
  lines.push("| Pts | Story | On digest? | Why missed |");
  lines.push("|---:|---|---|---|");
  for (const row of report.rows) {
    const mark = row.hit ? "yes" : "**MISS**";
    const why = row.hit ? "" : (row.reason ?? "");
    lines.push(`| ${row.score} | [${row.title}](https://news.ycombinator.com/item?id=${row.id}) | ${mark} | ${why} |`);
  }
  lines.push("");
  lines.push(
    `Hits: **${report.hits}/${report.total}** (${Math.round(report.coverageRatio * 100)}%), cards published for ${report.day}: **${report.publishedYesterday}**`
  );
  if (report.alerts.length > 0) {
    lines.push("");
    lines.push(report.alerts.map((alert) => `⚠️ ${alert}`).join("\n"));
  }
  return lines.join("\n");
}

function utcDayKey(now: Date, dayOffset: number): string {
  const d = new Date(now.getTime() + dayOffset * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function countPublishedForDay(day: string): number {
  try {
    const raw = JSON.parse(readFileSync(PATHS.grouped.daily, "utf8")) as unknown;
    const parsed = DailyGroupFileSchema.safeParse(raw);
    if (!parsed.success) {
      return 0;
    }
    return parsed.data.byDate[day]?.length ?? 0;
  } catch {
    return 0;
  }
}

async function fetchStoryDetails(
  services: Services,
  ids: number[]
): Promise<Array<{ id: number; title?: string; score?: number }>> {
  return Promise.all(
    ids.map(async (id) => {
      try {
        const item = await fetchItem(services, id);
        if (!item || item.type !== "story") {
          return { id };
        }
        return {
          id,
          ...(typeof item.title === "string" ? { title: item.title } : {}),
          ...(typeof item.score === "number" ? { score: item.score } : {}),
        };
      } catch {
        return { id };
      }
    })
  );
}
function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function readSelectedIds(): Set<number> {
  const parsed = readJsonFile(PATHS.index);
  const result = IndexSchema.safeParse(parsed);
  if (!result.success) {
    return new Set();
  }
  return new Set(result.data.storyIds);
}

type PostFileState = MissSnapshot["post"];

function readPostState(id: number): PostFileState {
  const post = readJsonFile(pathFor.postSummary(id)) as { summary?: unknown; degraded?: unknown } | undefined;
  if (post === undefined || typeof post !== "object") {
    return "missing";
  }
  if (post.degraded === "no-article") {
    return "no-article";
  }
  return typeof post.summary === "string" && post.summary.trim().length > 0 ? "ok" : "failed";
}

/**
 * Build a miss snapshot from local pipeline state: index.json tells whether
 * the story was selected, the raw item carries score/url, and the post file
 * record (not bare existence) tells no-article apart from LLM failure.
 */
function buildMissSnapshot(id: number, selectedIds: Set<number>): MissSnapshot {
  const parsed = readJsonFile(pathFor.rawItem(id));
  const raw =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { url?: unknown; score?: unknown; descendants?: unknown })
      : undefined;
  const hasRaw = raw !== undefined;
  const hasUrl = hasRaw && typeof raw.url === "string" && raw.url.length > 0;
  const score = hasRaw && typeof raw.score === "number" ? raw.score : 0;
  const descendants = hasRaw && typeof raw.descendants === "number" ? raw.descendants : 0;
  const post = readPostState(id);
  let article: MissSnapshot["article"];
  if (!hasUrl) {
    article = "na";
  } else if (post === "no-article") {
    article = "no-article";
  } else {
    article = existsSync(pathFor.articleMd(id)) ? "ok" : "missing";
  }
  return {
    selected: selectedIds.has(id),
    hasRaw,
    hasUrl,
    article,
    post,
    passesGate: passesEngagementGate(
      { score, comments: descendants },
      { minScore: env.SUMMARIZE_MIN_SCORE, minComments: env.SUMMARIZE_MIN_COMMENTS }
    ),
  };
}
async function reportForOffset(
  services: Services,
  publishedIds: number[],
  now: Date,
  dayOffset: number
): Promise<{ report: CoverageReport; empty: boolean }> {
  const day = utcDayKey(now, dayOffset);
  const topIds = await readTopIds(services, COVERAGE_TOP_N, {
    mode: "daily-top-by-score",
    now,
    dayOffset,
  });
  const top = await fetchStoryDetails(services, topIds);
  const published = new Set(publishedIds);
  const selectedIds = readSelectedIds();
  const reasons: Record<number, string> = {};
  for (const story of top) {
    if (!published.has(story.id)) {
      reasons[story.id] = classifyMiss(buildMissSnapshot(story.id, selectedIds));
    }
  }
  const report = computeCoverage({
    day,
    top,
    publishedIds,
    publishedYesterday: countPublishedForDay(day),
    minCards: env.DAILY_COVERAGE_MIN_CARDS,
    minCoverage: env.DAILY_COVERAGE_MIN_RATIO,
    reasons,
  });
  log.info("daily-coverage", `coverage ${report.hits}/${report.total}, cards ${report.publishedYesterday}`, {
    day,
    alerts: report.alerts,
  });
  return { report, empty: false };
}

const TELEGRAM_MISS_MAX_LINES = 10;
const TELEGRAM_MISS_TITLE_CHARS = 80;

/**
 * One line per missed story for the Telegram alert, HTML-escaped and
 * size-capped. Pure: takes reports, returns message lines (without header).
 */
export function formatMissLines(reports: CoverageReport[]): string[] {
  const misses = reports.flatMap((report) =>
    report.rows
      .filter((row) => !row.hit)
      .map((row) => ({ day: report.day, ...row }))
  );
  const lines = misses
    .slice(0, TELEGRAM_MISS_MAX_LINES)
    .map((miss) => {
      const title = escapeHtml(
        miss.title.length > TELEGRAM_MISS_TITLE_CHARS
          ? `${miss.title.slice(0, TELEGRAM_MISS_TITLE_CHARS - 1)}…`
          : miss.title
      );
      const why = miss.reason === undefined ? "" : ` — ${escapeHtml(miss.reason)}`;
      return `• MISS (${miss.day}) ${miss.score} <a href="https://news.ycombinator.com/item?id=${miss.id}">${title}</a>${why}`;
    });
  if (misses.length > TELEGRAM_MISS_MAX_LINES) {
    lines.push(`• …and ${misses.length - TELEGRAM_MISS_MAX_LINES} more (see job summary)`);
  }
  return lines;
}

async function main(): Promise<void> {
  const now = new Date();
  const services = makeServices(env);
  const aggregated = loadAggregated(PATHS.aggregated);
  const publishedIds = aggregated.items.map((item) => item.id);

  // Two windows: the fresh day (hourly freshness grade) and the settled day
  // (catch-up grade — scores are final, late-evening votes counted).
  const offsets = [env.DAILY_COVERAGE_DAY_OFFSET, env.DAILY_COVERAGE_DAY_OFFSET - 1];
  const reports: CoverageReport[] = [];
  for (const dayOffset of offsets) {
    const { report, empty } = await reportForOffset(services, publishedIds, now, dayOffset);
    if (!empty) {
      reports.push(report);
    }
  }
  if (reports.length === 0) {
    return;
  }

  const markdown = reports.map((report) => renderSummaryMarkdown(report)).join("\n---\n\n");
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(summaryPath, `${markdown}\n`);
  } else {
    process.stdout.write(`${markdown}\n`);
  }

  const alertLines = reports.flatMap((report) =>
    report.alerts.map((alert) => `• (${report.day}) ${alert}`)
  );
  const missLines = formatMissLines(reports);
  if (alertLines.length > 0 && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const http = new HttpClient({
      retries: env.HTTP_RETRIES,
      baseBackoffMs: env.HTTP_BACKOFF_MS,
      timeoutMs: env.HTTP_TIMEOUT_MS,
      retryOnStatuses: [429],
    });
    const telegram = new Telegram(http, env.TELEGRAM_BOT_TOKEN);
    const text = [`<b>hn-distill coverage alert</b>`, ...alertLines, ...missLines].join("\n");
    try {
      await telegram.sendMessage({
        chatId: env.TELEGRAM_CHAT_ID,
        text,
        disableNotification: true,
      });
    } catch (error) {
      log.warn("daily-coverage", "failed to send Telegram alert", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const invokedDirectly = process.argv[1]?.includes("daily-coverage");
if (invokedDirectly) {
  await main();
}
