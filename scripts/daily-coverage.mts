import { readFileSync } from "node:fs";

import { env } from "@config/env";
import { PATHS } from "@config/paths";
import { DailyGroupFileSchema } from "@config/schemas";
import { HttpClient } from "@utils/http-client";
import { loadAggregated } from "@utils/load-aggregated";
import { log } from "@utils/log";
import { Telegram } from "@utils/telegram";

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
};

export type CoverageRow = {
  id: number;
  title: string;
  score: number;
  hit: boolean;
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
    return {
      id: story.id,
      title: title !== undefined && title.length > 0 ? title : "(title unavailable)",
      score: typeof story.score === "number" ? story.score : 0,
      hit: published.has(story.id),
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
  lines.push("| Pts | Story | On digest? |");
  lines.push("|---:|---|---|");
  for (const row of report.rows) {
    const mark = row.hit ? "yes" : "**MISS**";
    lines.push(`| ${row.score} | [${row.title}](https://news.ycombinator.com/item?id=${row.id}) | ${mark} |`);
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

async function main(): Promise<void> {
  const now = new Date();
  const dayOffset = env.DAILY_COVERAGE_DAY_OFFSET;
  const day = utcDayKey(now, dayOffset);

  const services = makeServices(env);
  const topIds = await readTopIds(services, COVERAGE_TOP_N, {
    mode: "daily-top-by-score",
    now,
    dayOffset,
  });

  if (topIds.length === 0) {
    log.warn("daily-coverage", "Algolia returned no stories for the day window; skipping report", { day });
    return;
  }

  const top = await fetchStoryDetails(services, topIds);
  const aggregated = loadAggregated(PATHS.aggregated);
  const report = computeCoverage({
    day,
    top,
    publishedIds: aggregated.items.map((item) => item.id),
    publishedYesterday: countPublishedForDay(day),
    minCards: env.DAILY_COVERAGE_MIN_CARDS,
    minCoverage: env.DAILY_COVERAGE_MIN_RATIO,
  });

  log.info("daily-coverage", `coverage ${report.hits}/${report.total}, cards ${report.publishedYesterday}`, {
    day,
    alerts: report.alerts,
  });

  const markdown = renderSummaryMarkdown(report);
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(summaryPath, `${markdown}\n`);
  } else {
    process.stdout.write(`${markdown}\n`);
  }

  if (report.alerts.length > 0 && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const http = new HttpClient({
      retries: env.HTTP_RETRIES,
      baseBackoffMs: env.HTTP_BACKOFF_MS,
      timeoutMs: env.HTTP_TIMEOUT_MS,
      retryOnStatuses: [429],
    });
    const telegram = new Telegram(http, env.TELEGRAM_BOT_TOKEN);
    const text = [
      `<b>hn-distill coverage alert</b> (${report.day})`,
      ...report.alerts.map((alert) => `• ${alert}`),
    ].join("\n");
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
