import { z } from "zod";

const EnvironmentSchema = z.object({
  OPENROUTER_API_KEY: z.string().optional(),
  SUMMARY_LANG: z.enum(["ru", "en"]).default("ru"),
  TOP_N: z.coerce.number().int().min(1).max(500).default(40),
  MAX_COMMENTS_PER_STORY: z.coerce.number().int().min(1).max(5000).default(40),
  MAX_DEPTH: z.coerce.number().int().min(1).max(10).default(2),
  CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
  ARTICLE_SLICE_CHARS: z.coerce.number().int().min(1000).max(20_000).default(6000),
  MAX_BODY_CHARS: z.coerce.number().int().min(1000).max(50_000).default(2000),

  HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
  HTTP_RETRIES: z.coerce.number().int().min(0).max(5).default(3),
  HTTP_BACKOFF_MS: z.coerce.number().int().min(100).max(5000).default(600),

  OPENROUTER_MODEL: z.string().default("moonshotai/kimi-k2:free"),
  // When primary model fails for summaries, try this model next
  OPENROUTER_FALLBACK_MODEL: z.string().default("deepseek/deepseek-chat-v3.1:free"),
  OPENROUTER_FALLBACK_MODEL_2: z.string().default("z-ai/glm-4.5-air:free"),
  OPENROUTER_MAX_TOKENS: z.coerce.number().int().min(128).max(32_768).default(8000),

  TAGS_MODEL: z.string().default("mistralai/mistral-small-3.2-24b-instruct:free"), // try structured outputs, fallback to JSON
  TAGS_MAX_TOKENS: z.coerce.number().int().min(128).max(2048).default(512),
  TAGS_LANG: z.enum(["en"]).default("en"), // canonical tag language
  TAGS_MAX_PER_STORY: z.coerce.number().int().min(3).max(20).default(10),

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
  TELEGRAM_ENABLE: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(true),
});

export const env = EnvironmentSchema.parse(process.env);
export type Env = typeof env;
