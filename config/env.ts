import { z } from "zod";

const EnvironmentSchema = z.object({
  OPENROUTER_API_KEY: z.string().optional(),
  // Optional OpenAI-compatible chat-completions URL for the primary summarization client
  // (e.g. a local gateway or a direct Groq route). Empty/unset keeps the OpenRouter default.
  OPENROUTER_BASE_URL: z.string().optional(),
  // Optional secondary provider for tags + post-guard (structured JSON). When set, those
  // two calls go to Groq (reliable JSON, non-reasoning llama) instead of OPENROUTER_API_KEY.
  // TAGS_MODEL / POST_GUARD_MODEL must then be Groq model ids (e.g. llama-3.3-70b-versatile).
  GROQ_API_KEY: z.string().optional(),
  GROQ_BASE_URL: z.string().default("https://api.groq.com/openai/v1/chat/completions"),
  SUMMARY_LANG: z.enum(["ru", "en"]).default("ru"),
  TOP_N: z.coerce.number().int().min(1).max(500).default(10),
  TOP_N_MODE: z.enum(["topstories", "daily-top-by-score"]).default("topstories"),
  TOP_N_DAY_OFFSET: z.coerce.number().int().min(-30).max(0).default(0),
  MAX_COMMENTS_PER_STORY: z.coerce.number().int().min(1).max(5000).default(40),
  MAX_DEPTH: z.coerce.number().int().min(1).max(10).default(2),
  CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
  ARTICLE_SLICE_CHARS: z.coerce.number().int().min(1000).max(20_000).default(6000),
  // Head+tail slicing: keep the first ARTICLE_HEAD_CHARS of the article, then the
  // last (ARTICLE_SLICE_CHARS - ARTICLE_HEAD_CHARS) so conclusions survive. When
  // ARTICLE_HEAD_CHARS >= ARTICLE_SLICE_CHARS the tail is empty (head-only).
  ARTICLE_HEAD_CHARS: z.coerce.number().int().min(500).max(20_000).default(4000),
  MAX_BODY_CHARS: z.coerce.number().int().min(1000).max(50_000).default(2000),

  // HTML-extract garbage detector thresholds (see utils/extract-quality.ts). An
  // extract is flagged `no-article` (post LLM skipped, only comments summarized)
  // when prose is too thin OR links/duplicate-lines dominate.
  EXTRACT_MIN_PROSE_CHARS: z.coerce.number().int().min(0).max(20_000).default(500),
  EXTRACT_MAX_LINK_DENSITY: z.coerce.number().min(0).max(1).default(0.5),
  EXTRACT_MAX_DUP_RATIO: z.coerce.number().min(0).max(1).default(0.5),

  // When a direct article fetch hits Cloudflare JS-challenge / 403, retry via
  // Jina Reader (https://r.jina.ai/<url>) which returns ready markdown. Off to
  // skip the second hop (local debugging). On by default so GH Actions recovers
  // bot-blocked origin pages without Playwright.
  ARTICLE_FETCH_READER_FALLBACK: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(true),
  // Optional Jina API key (Authorization: Bearer …). Free tier works without it
  // at lower RPM; set for higher limits. Never required for correctness.
  JINA_API_KEY: z.string().optional(),
  // Override reader base (tests / self-host). No trailing slash required.
  ARTICLE_READER_BASE_URL: z.string().default("https://r.jina.ai"),

  HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
  HTTP_RETRIES: z.coerce.number().int().min(0).max(5).default(3),
  HTTP_BACKOFF_MS: z.coerce.number().int().min(100).max(5000).default(600),

  OPENROUTER_MODEL: z.string().default("nvidia/nemotron-3-nano-30b-a3b:free"),
  // When primary model fails for summaries, try this model next (priority order)
  OPENROUTER_FALLBACK_MODEL: z.string().default("qwen/qwen3-next-80b-a3b-instruct:free"),
  OPENROUTER_FALLBACK_MODEL_2: z.string().default("meta-llama/llama-3.3-70b-instruct:free"),
  OPENROUTER_MAX_TOKENS: z.coerce.number().int().min(128).max(32_768).default(8000),

  // Comments-v2 has an independent input/output and request budget. Three
  // seven-second calls fit under the worker's 25s task timeout with its 2s buffer.
  COMMENTS_SUMMARY_MIN_CHARS: z.coerce.number().int().min(40).max(1000).default(200),
  COMMENTS_MIN_CYRILLIC_RATIO: z.coerce.number().min(0).max(1).default(0.65),
  COMMENTS_PROMPT_MAX_CHARS: z.coerce.number().int().min(1000).max(100_000).default(24_000),
  // Room for up to 15 RU insights (dynamic ceiling); ~3k tokens worst case.
  COMMENTS_SUMMARY_MAX_TOKENS: z.coerce.number().int().min(128).max(4096).default(2500),
  // Second-pass compression of structured comments. Empty string disables.
  // Changing the model does NOT invalidate existing compressed results — bump
  // COMMENTS_COMPRESS_POLICY_VERSION to force recompression after a model swap.
  COMMENTS_COMPRESS_MODEL: z.string().default("qwen/qwen3-next-80b-a3b-instruct"),
  COMMENTS_COMPRESS_MAX_TOKENS: z.coerce.number().int().min(128).max(4096).default(1000),
  // Default 3 covers the Groq dead-end path (scout → llama-3.3 → OpenRouter
  // hop): a 429 fails fast and jumps straight to the next step, so the paid
  // OpenRouter fallback (COMMENTS_OPENROUTER_FALLBACK_MODEL) is reached within
  // budget without breaching the worker task timeout (3 × 7s ≤ 25s − 2s buffer).
  COMMENTS_MAX_LLM_CALLS: z.coerce.number().int().min(1).max(5).default(3),
  COMMENTS_LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(7000),
  COMMENTS_JUDGE_THREAD_MAX_CHARS: z.coerce.number().int().min(1000).max(100_000).default(24_000),

  // Comments-v2 model chain. When GROQ_API_KEY is set these route through the Groq
  // client (reliable non-reasoning JSON, no json_schema needed) and MUST be Groq model
  // ids (e.g. llama-3.3-70b-versatile). Without a Groq key they are ignored and comments
  // fall back to the OPENROUTER_MODEL chain. Reasoning models (nvidia/nemotron:free) emit
  // prose instead of JSON here and break structured parsing — keep them out of this chain.
  // 2026-07-20 local probe (docs/probe-llm-models-2026-07-20.md): scout is absent from the
  // current Groq catalog (model_not_found). Primary is llama-3.3-70b; on TPD spill the next
  // Groq hop is llama-3.1-8b-instant (separate free-tier bucket), then paid OpenRouter.
  COMMENTS_MODEL: z.string().default("llama-3.3-70b-versatile"),
  // Second Groq hop after 70b TPD/TPM. Keep non-reasoning; plain-JSON extraction on Groq.
  // When COMMENTS_QWEN27B_ROUTE_ENABLE is on, this model is only used for short inputs
  // (see COMMENTS_SHORT_ROUTE_MAX_RESERVED_TOKENS); medium inputs take Qwen 27b instead.
  COMMENTS_FALLBACK_MODEL: z.string().default("llama-3.1-8b-instant"),
  COMMENTS_FALLBACK_MODEL_2: z.string().default(""),
  // Opt-in size-aware second Groq hop (Phase 3 scaffold). Default OFF — deployment without
  // the flag keeps the legacy 70b → 8b → paid chain. Do not enable in production until
  // Phase 2 paired eval PASSes (or an explicit waiver) and Phase 4 rollout is planned.
  COMMENTS_QWEN27B_ROUTE_ENABLE: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(false),
  COMMENTS_QWEN27B_MODEL: z.string().default("qwen/qwen3.6-27b"),
  // Secondary free-route size gates: prompt-token estimate + COMMENTS_SUMMARY_MAX_TOKENS.
  // Short: reserved < this → 8b-instant. Medium: reserved ≤ QWEN max → Qwen 27b. Else skip both.
  COMMENTS_SHORT_ROUTE_MAX_RESERVED_TOKENS: z.coerce.number().int().min(1000).max(20_000).default(5500),
  COMMENTS_QWEN27B_MAX_RESERVED_TOKENS: z.coerce.number().int().min(1000).max(32_000).default(8000),
  // Added on top of ceil((system+user)/4). Smoke saw real prompt tokens 86–499 above chars/4
  // on user-only estimates; margin covers system prompt drift + tokenizer variance near 8k TPM.
  COMMENTS_ROUTE_TOKEN_ESTIMATE_MARGIN: z.coerce.number().int().min(0).max(4000).default(600),
  // Cross-provider last resort tried on the OpenRouter client (not Groq) after the
  // Groq chain is exhausted — chiefly Groq's per-model daily token cap (HTTP 429 TPD),
  // which otherwise dead-ends comment generation into a persisted fallback. A PAID
  // OpenRouter model is required: :free models emit prose, not clean structured JSON
  // (the original reason comments moved to Groq). Empty string disables the hop.
  // Freshness-SLA gating of this hop is intentionally unchanged in Phase 3 scaffold.
  COMMENTS_OPENROUTER_FALLBACK_MODEL: z.string().default("qwen/qwen3-next-80b-a3b-instruct"),

  // Groq strict json_schema (when GROQ_API_KEY set). Probe winner: openai/gpt-oss-20b.
  // No second tags model — LLM fail falls back to deterministic heuristics in processTags.
  TAGS_MODEL: z.string().default("openai/gpt-oss-20b"),
  TAGS_MAX_TOKENS: z.coerce.number().int().min(128).max(2048).default(512),
  TAGS_LANG: z.enum(["en"]).default("en"), // canonical tag language
  TAGS_MAX_PER_STORY: z.coerce.number().int().min(0).max(20).default(10),

  POST_GUARD_ENABLE: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(true),
  // Same Groq strict-JSON route as tags. Empty fallback → one guard attempt then
  // heuristics-only acceptance (see generateValidatedPostSummary). Do not put an
  // OpenRouter id here while guardTagsClient is the Groq gateway.
  POST_GUARD_MODEL: z.string().default("openai/gpt-oss-20b"),
  POST_GUARD_FALLBACK_MODEL: z.string().default(""),
  POST_GUARD_MAX_TOKENS: z.coerce.number().int().min(128).max(1024).default(256),
  POST_GUARD_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  POST_GUARD_ARTICLE_MAX_CHARS: z.coerce
    .number()
    .int()
    .min(500)
    .max(12 * 1000)
    .default(4 * 1000),
  POST_SUMMARY_MIN_CHARS: z.coerce.number().int().min(40).max(500).default(120),

  // RU language-purity gate (retry-only: reasons are NOT in aggregator DROP lists).
  // Master switch for both signals (low_cyrillic_ratio + latin_prose).
  SUMMARY_LANGUAGE_GATE_ENABLE: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(true),
  // low_cyrillic_ratio threshold over prose-eligible letters (calibrated 2026-07: see docs/language-gate-calibration.md).
  SUMMARY_MIN_CYRILLIC_RATIO: z.coerce.number().min(0).max(1).default(0.8),
  // latin_prose: weak 2-3-word noun-phrase runs («unified memory») — ~40% precision, opt-in.
  SUMMARY_LATIN_SOFT_RUNS: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(false),
  // latin_prose: dictionary singletons («создают precedents») — 100% precision on calibration.
  SUMMARY_LATIN_SINGLETONS: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(true),
  // Escalation model for content-rejected summaries (heuristics/guard). Strict retry
  // attempts start from this model instead of the small primary. Empty → default chain.
  // Paid OpenRouter route validated in docs/escalation-model-bench.md.
  SUMMARY_CONTENT_REJECT_MODEL: z.string().default("qwen/qwen3-next-80b-a3b-instruct"),

  LOG_LEVEL: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),

  SITE: z.string().optional(),
  BASE: z.string().optional(),

  // GoatCounter subdomain code (e.g. "hn-distill" → hn-distill.goatcounter.com). When set,
  // a lightweight cookieless pageview script is injected into every page at build time.
  // Unset (e.g. in dev) → no analytics, local visits are not counted.
  GOATCOUNTER_CODE: z.string().optional(),

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
  // Engagement gate for LLM spend AND site publish. A story is only processed by
  // the LLM stages (post summary, comments, tags, guard) when it clears this gate;
  // otherwise ALL LLM work is skipped. Aggregate/site also drop stories without a
  // publishable postSummary, so below-threshold items never become empty cards.
  // Semantics: 0 = criterion disabled. A story passes if NO criterion is enabled,
  // OR any enabled criterion is met (OR):
  //   passes = !(minScore > 0 || minComments > 0)
  //     || (minScore > 0 && (story.score ?? 0) >= minScore)
  //     || (minComments > 0 && (story.descendants ?? 0) >= minComments)
  // Boundary values pass (score === minScore → pass). Missing score/descendants
  // count as 0. Defaults 0/0 keep current behavior (gate off).
  SUMMARIZE_MIN_SCORE: z.coerce.number().int().min(0).default(0),
  SUMMARIZE_MIN_COMMENTS: z.coerce.number().int().min(0).default(0),

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
  // Opt-in migration drain. When enabled, worker cron also processes legacy
  // article_extracts with no source_kind, independent of current TOP_N/fetchedISO.
  WORKER_EXTRACTION_BACKFILL_ENABLE: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(false),

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

  // Gate per-attempt LLM usage accounting (tokens + model/gateway/task/status → llm_usage).
  // Default false decouples this from deploy order (Pages and the Worker ship independently):
  // ship the code off, apply the D1 migration --remote, then flip on. Off → no wiring, no writes.
  LLM_USAGE_ENABLED: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(false),

  // Offline model scoring (eval/score-models.mts) — writes only under data/bench/
  // Empty by default so a real (paid) run without an explicit judge id fails fast
  // instead of silently calling a wrong/nonexistent model. Set to your flagship id.
  JUDGE_MODEL: z.string().default(""),
  JUDGE_MAX_TOKENS: z.coerce.number().int().min(128).max(4096).default(700),
  JUDGE_API_KEY: z.string().optional(),
  JUDGE_BASE_URL: z.string().optional(),
  // The judge must see the same article slice the candidate summarized, otherwise
  // completeness/faithfulness scores are biased. Keep >= ARTICLE_SLICE_CHARS.
  JUDGE_ARTICLE_MAX_CHARS: z.coerce.number().int().min(1000).max(20_000).default(6000),
  BENCH_REPEATS: z.coerce.number().int().min(1).max(10).default(1),
  BENCH_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  BENCH_MAX_ARTICLES: z.coerce.number().int().min(1).max(200).default(30),
  /** OpenRouter summarization on free models can exceed HTTP_TIMEOUT_MS; bench uses max(HTTP_TIMEOUT_MS, this). */
  BENCH_HTTP_TIMEOUT_MS: z.coerce.number().int().min(15_000).max(600_000).default(180_000),
  /**
   * max_tokens for candidate summaries. A ~170-word summary needs ~500 tokens; the production
   * 8000 is wasteful and, on Groq free tier, requested max_tokens counts toward the per-request
   * TPM cap (qwen3-32b=6000, gpt-oss=8000) → 413. Keep low enough that input+this < tightest TPM.
   */
  BENCH_SUMMARY_MAX_TOKENS: z.coerce.number().int().min(256).max(8000).default(2048),
  /**
   * Minimum gap between consecutive candidate calls to the SAME provider (openrouter / groq / xai),
   * to stay under free-tier rate limits (OpenRouter free = 16 req/min ≈ 3.75s; Groq free per-model).
   * 0 disables. Quality/completeness over speed → default spaces to ~15 req/min.
   */
  BENCH_PROVIDER_THROTTLE_MS: z.coerce.number().int().min(0).max(60_000).default(4000),
}).superRefine((value, context) => {
  if (value.COMMENTS_JUDGE_THREAD_MAX_CHARS < value.COMMENTS_PROMPT_MAX_CHARS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["COMMENTS_JUDGE_THREAD_MAX_CHARS"],
      message: "must be greater than or equal to COMMENTS_PROMPT_MAX_CHARS",
    });
  }
});

/**
 * Bump when the content-extraction / slicing policy changes in a way that should
 * invalidate all cached post summaries. Folded into the post inputHash so local
 * reselection (computePostChanged) and processPostSummary both reprocess stories.
 * Not an env var — a code constant so a deploy is the only way to change it.
 */
export const EXTRACT_POLICY_VERSION = "1";

/** Bump to invalidate persisted comments summaries after a policy change. */
export const COMMENTS_POLICY_VERSION = "4";

/** Bump to invalidate compressed paragraphs after a compress-policy/model change. */
export const COMMENTS_COMPRESS_POLICY_VERSION = "1";

export type Env = z.infer<typeof EnvironmentSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  return EnvironmentSchema.parse(source);
}

export const env: Env = parseEnv(process.env);

export function applyEnv(next: Env): void {
  Object.assign(env, next);
}
