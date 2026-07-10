import { z } from "zod";

const EnvironmentSchema = z.object({
  OPENROUTER_API_KEY: z.string().optional(),
  SUMMARY_LANG: z.enum(["ru", "en"]).default("ru"),
  TOP_N: z.coerce.number().int().min(1).max(500).default(40),
  TOP_N_MODE: z.enum(["topstories", "daily-top-by-score"]).default("topstories"),
  TOP_N_DAY_OFFSET: z.coerce.number().int().min(-30).max(0).default(0),
  MAX_COMMENTS_PER_STORY: z.coerce.number().int().min(1).max(5000).default(40),
  MAX_DEPTH: z.coerce.number().int().min(1).max(10).default(2),
  CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
  ARTICLE_SLICE_CHARS: z.coerce.number().int().min(1000).max(20_000).default(6000),
  MAX_BODY_CHARS: z.coerce.number().int().min(1000).max(50_000).default(2000),

  HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
  HTTP_RETRIES: z.coerce.number().int().min(0).max(5).default(3),
  HTTP_BACKOFF_MS: z.coerce.number().int().min(100).max(5000).default(600),

  OPENROUTER_MODEL: z.string().default("xiaomi/mimo-v2-flash:free"),
  // When primary model fails for summaries, try this model next (priority order)
  OPENROUTER_FALLBACK_MODEL: z.string().default("mistralai/devstral-2512:free"),
  OPENROUTER_FALLBACK_MODEL_2: z.string().default("tngtech/deepseek-r1t2-chimera:free"),
  OPENROUTER_MAX_TOKENS: z.coerce.number().int().min(128).max(32_768).default(8000),

  TAGS_MODEL: z.string().default("xiaomi/mimo-v2-flash:free"), // try structured outputs, fallback to JSON
  TAGS_MAX_TOKENS: z.coerce.number().int().min(128).max(2048).default(512),
  TAGS_LANG: z.enum(["en"]).default("en"), // canonical tag language
  TAGS_MAX_PER_STORY: z.coerce.number().int().min(0).max(20).default(10),

  POST_GUARD_ENABLE: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(true),
  POST_GUARD_MODEL: z.string().default("xiaomi/mimo-v2-flash:free"),
  POST_GUARD_FALLBACK_MODEL: z.string().default("mistralai/devstral-2512:free"),
  POST_GUARD_MAX_TOKENS: z.coerce.number().int().min(128).max(1024).default(256),
  POST_GUARD_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  POST_GUARD_ARTICLE_MAX_CHARS: z.coerce
    .number()
    .int()
    .min(500)
    .max(12 * 1000)
    .default(4 * 1000),
  POST_SUMMARY_MIN_CHARS: z.coerce.number().int().min(40).max(500).default(120),

  LOG_LEVEL: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),

  SITE: z.string().optional(),
  BASE: z.string().optional(),

  // Summarization workload controls
  // Hard cap: how many stories to actually summarize per run (prioritized newest and missing/outdated first)
  SUMMARIZE_MAX_STORIES_PER_RUN: z.coerce.number().int().min(1).max(500).default(500),
  // Cooldown in minutes: if a story had its summaries generated within this window, skip re-summarizing even if inputs changed
  SUMMARIZE_COOLDOWN_MINUTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(0),

  // Posts: skip regeneration entirely if a post summary already exists
  POST_SUMMARY_ONLY_IF_MISSING: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(false),

  // PDF parsing limits
  PDF_MAX_PAGES: z.coerce.number().int().min(1).max(200).default(12),
  PDF_MAX_BYTES: z.coerce.number().int().min(100_000).max(50_000_000).default(10_000_000),

  // YouTube transcript preferences
  YT_TRANSCRIPT_LANGS: z
    .string()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : []
    )
    .optional(),

  // Telegram publishing (optional)
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(), // channel @handle or numeric ID
  TELEGRAM_MESSAGE_THREAD_ID: z.coerce.number().optional(), // topic ID for forum supergroups
  TELEGRAM_DISABLE_NOTIFICATIONS: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(true),
  TELEGRAM_MAX_ITEMS: z.coerce.number().int().min(1).max(100).default(10),
  TELEGRAM_MESSAGE_DELAY_MS: z.coerce.number().int().min(500).max(10_000).default(2000),
  TELEGRAM_MAX_RATE_LIMIT_RETRIES: z.coerce.number().int().min(1).max(10).default(5),
  TELEGRAM_STREAM: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(false),
  TELEGRAM_ENABLE: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(true),

  // Worker safety guards (serverless limits)
  WORKER_QUEUE_TASK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(25_000),
  WORKER_CRON_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(55_000),
  WORKER_SUMMARIZE_MAX_PER_CRON: z.coerce.number().int().min(1).max(50).default(3),
  WORKER_RETRY_COOLDOWN_SECONDS: z.coerce.number().int().min(60).max(24 * 60 * 60).default(600),

  // Cloudflare Pages deploy scheduling (optional)
  PAGES_DEPLOY_HOOK_URL: z.string().optional(),
  PAGES_DEPLOY_TARGET_PER_MONTH: z.coerce.number().int().min(1).max(2000).default(500),
  PAGES_DEPLOY_ENABLE: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(true),

  /** When true and SQLite/D1 meta is available, aggregate reads the DB ledger instead of merging JSON blobs. */
  AGGREGATE_FROM_DB: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(false),
});

export type Env = z.infer<typeof EnvironmentSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  return EnvironmentSchema.parse(source);
}

export const env: Env = parseEnv(process.env);

export function applyEnv(next: Env): void {
  Object.assign(env, next);
}
