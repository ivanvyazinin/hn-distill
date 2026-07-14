import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { PATHS } from "@config/paths";
import { log } from "@utils/log";
import { OpenRouter, type JsonSchema } from "@utils/openrouter";
import { checkSummaryHeuristics, languageGateFromEnv } from "@utils/summary-heuristics";

import { buildPostChatMessages, makeServices, sanitizeLlmContent } from "../pipeline/summarize";

import type { Env } from "@config/env";

const LOG_NAMESPACE = "score-models" as const;

export type BenchArticle = {
  id: number;
  title: string;
  url: string;
  articleSlice: string;
};

export type RunOutput = {
  content: string;
  latencyMs: number;
  error?: string;
};

export const JudgeVerdictSchema = z.object({
  accuracy: z.number().min(1).max(5),
  completeness: z.number().min(1).max(5),
  faithfulness: z.number().min(1).max(5),
  format_adherence: z.number().min(1).max(5),
  language_purity: z.number().min(1).max(5),
  overall: z.number().min(1).max(5),
  is_refusal: z.boolean(),
  reasons: z.array(z.string()).max(8),
});

export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export type ScoredRunRecord = {
  model: string;
  articleId: number;
  repeat: number;
  latencyMs: number;
  outputChars: number;
  error?: string;
  heuristic: ReturnType<typeof checkSummaryHeuristics>;
  judge?: JudgeVerdict;
  judgeSkipped?: boolean;
  /** Relative path to saved summary markdown under data/bench/summaries/ (when persisted). */
  summaryPath?: string;
};

export type ModelScore = {
  model: string;
  n: number;
  heuristic_pass_rate: number;
  refusal_rate: number;
  failure_histogram: Record<string, number>;
  mean_overall: number | undefined;
  mean_accuracy: number | undefined;
  mean_completeness: number | undefined;
  mean_faithfulness: number | undefined;
  mean_format_adherence: number | undefined;
  mean_language_purity: number | undefined;
  error_rate: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  mean_output_chars: number;
  /** Composite rank = mean_overall * heuristic_pass_rate (judge quality gated by non-garbage rate). */
  composite_rank: number;
};

type BenchManifest = {
  articleIds: number[];
};

export async function loadBenchManifest(): Promise<number[]> {
  const raw = await readFile(PATHS.bench.manifest, "utf8");
  const parsed = JSON.parse(raw) as BenchManifest;
  return parsed.articleIds;
}

export async function loadBenchArticles(
  envLike: Pick<Env, "ARTICLE_SLICE_CHARS">,
  options: { limit?: number; articleIds?: number[] } = {}
): Promise<BenchArticle[]> {
  const ids = options.articleIds ?? (await loadBenchManifest());
  const limited = options.limit === undefined ? ids : ids.slice(0, options.limit);
  const articles: BenchArticle[] = [];

  for (const id of limited) {
    const mdPath = join(PATHS.bench.articles, `${id}.md`);
    const itemPath = join(PATHS.bench.items, `${id}.json`);
    const [md, itemRaw] = await Promise.all([readFile(mdPath, "utf8"), readFile(itemPath, "utf8")]);
    const item = JSON.parse(itemRaw) as { title?: string; url?: string };
    const articleSlice = md.slice(0, envLike.ARTICLE_SLICE_CHARS);
    articles.push({
      id,
      title: item.title ?? String(id),
      url: item.url ?? "",
      articleSlice,
    });
  }

  return articles;
}

export function makeJudgeClient(envLike: Pick<Env, "JUDGE_API_KEY" | "JUDGE_BASE_URL" | "JUDGE_MODEL" | "OPENROUTER_API_KEY">): OpenRouter {
  const services = makeServices(envLike as Env);
  const apiKey = envLike.JUDGE_API_KEY ?? envLike.OPENROUTER_API_KEY ?? "";
  return new OpenRouter(services.http, apiKey, envLike.JUDGE_MODEL, envLike.JUDGE_BASE_URL);
}

const CANDIDATE_MAX_ATTEMPTS = 4;
const CANDIDATE_RETRY_FALLBACK_MS = 15_000;
const CANDIDATE_RETRY_MAX_MS = 60_000;

function rateLimitDelayMs(message: string): number | undefined {
  if (!message.includes('429')) {
    return undefined;
  }
  const retryAfter = /"retry_after_seconds"\s*:\s*(?<seconds>\d+)/u.exec(message)?.groups?.["seconds"];
  const delay = retryAfter === undefined ? CANDIDATE_RETRY_FALLBACK_MS : Number.parseInt(retryAfter, 10) * 1000 + 1000;
  return Math.min(delay, CANDIDATE_RETRY_MAX_MS);
}

/** Chat call with retry on provider 429 (free pools saturate for seconds at a time). */
async function chatWithRateLimitRetry(
  client: OpenRouter,
  messages: ReturnType<typeof buildPostChatMessages>,
  model: string,
  maxTokens: number,
  beforeCall?: () => Promise<void>
): Promise<{ content: string } | { error: string }> {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= CANDIDATE_MAX_ATTEMPTS; attempt += 1) {
    await beforeCall?.();
    try {
      const content = await client.chat(messages, { model, temperature: 0.3, maxTokens });
      return { content: sanitizeLlmContent(content) };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const delayMs = rateLimitDelayMs(lastError);
      if (delayMs === undefined || attempt === CANDIDATE_MAX_ATTEMPTS) {
        log.warn(LOG_NAMESPACE, "Candidate model failed", { model, attempt, error: lastError });
        break;
      }
      log.info(LOG_NAMESPACE, "Candidate rate-limited; retrying", { model, attempt, delayMs });
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return { error: lastError };
}

export async function summarizeWithModel(
  client: OpenRouter,
  articleSlice: string,
  model: string,
  envLike: Pick<Env, "BENCH_SUMMARY_MAX_TOKENS">,
  beforeCall?: () => Promise<void>
): Promise<RunOutput> {
  const started = Date.now();
  const result = await chatWithRateLimitRetry(
    client,
    buildPostChatMessages(articleSlice, { strict: false }),
    model,
    envLike.BENCH_SUMMARY_MAX_TOKENS,
    beforeCall
  );
  if ("error" in result) {
    return { content: "", latencyMs: Date.now() - started, error: result.error };
  }
  return { content: result.content, latencyMs: Date.now() - started };
}

/**
 * Two-step EN→RU pipeline: summarize in English first (a local prompt, independent of the
 * global SUMMARY_LANG), then have the same model translate its own summary into Russian.
 */
const EN_STEP_SYSTEM = [
  "You craft tight and concise Hacker News article distillations in Markdown. In English.",
  "Aim for roughly 170 words across two short paragraphs; add a third only if it truly helps.",
  "Spotlight the core idea plus one or two vivid facts, quotes, or numbers readers should remember.",
  "Skip titles, bylines, publication dates, and source attributions.",
  "Begin directly—no headings like 'Summary:' and no closing sign-offs.",
  "Important: mention all the key information from the article, don't lose it. Be precise and concise.",
].join("\n");

const RU_TRANSLATION_SYSTEM = [
  "Ты профессиональный переводчик технических текстов на русский язык.",
  "Переведи пересказ статьи на естественный русский, сохраняя Markdown-разметку и структуру абзацев.",
  "Пиши только по-русски: латиница допустима лишь для имён собственных, названий продуктов и кода.",
  "Не добавляй заголовков, комментариев или пояснений — выведи только перевод.",
].join("\n");

export async function summarizeTwoStepEnRu(
  client: OpenRouter,
  articleSlice: string,
  model: string,
  envLike: Pick<Env, "BENCH_SUMMARY_MAX_TOKENS">,
  beforeCall?: () => Promise<void>
): Promise<RunOutput> {
  const started = Date.now();

  const enStep = await chatWithRateLimitRetry(
    client,
    [
      { role: "system", content: EN_STEP_SYSTEM },
      { role: "user", content: articleSlice },
    ],
    model,
    envLike.BENCH_SUMMARY_MAX_TOKENS,
    beforeCall
  );
  if ("error" in enStep) {
    return { content: "", latencyMs: Date.now() - started, error: enStep.error };
  }
  if (enStep.content.trim().length === 0) {
    return { content: "", latencyMs: Date.now() - started, error: "empty EN step output" };
  }

  const ruStep = await chatWithRateLimitRetry(
    client,
    [
      { role: "system", content: RU_TRANSLATION_SYSTEM },
      { role: "user", content: enStep.content },
    ],
    model,
    envLike.BENCH_SUMMARY_MAX_TOKENS,
    beforeCall
  );
  if ("error" in ruStep) {
    return { content: "", latencyMs: Date.now() - started, error: ruStep.error };
  }
  return { content: ruStep.content, latencyMs: Date.now() - started };
}

function truncateSnippet(input: string, limit: number): string {
  if (input.length <= limit) {
    return input;
  }
  return `${input.slice(0, limit)}…`;
}

function buildJudgePrompt(payload: { language: string; summary: string; articleSnippet: string }): string {
  return [
    `Language: ${payload.language}`,
    "Score the candidate article summary against the excerpt using the JSON rubric.",
    "format_adherence: ~170 words, two short paragraphs, no headings like 'Summary:', no closing sign-offs, matches production style.",
    "faithfulness: penalize hallucinations and content not supported by the excerpt.",
    "language_purity: the summary must be written entirely in the requested language (see Language:). Penalize words, phrases, or sentences from another language embedded in connected prose (e.g. English inside Russian text). Latin script is acceptable only for proper nouns, product names, quoted terms, and code.",
    "overall: holistic quality; a summary with poor language_purity cannot receive a high overall score.",
    "Article excerpt:",
    "---",
    payload.articleSnippet,
    "---",
    "Candidate summary:",
    "---",
    payload.summary,
    "---",
    "Respond ONLY with JSON matching the schema.",
  ].join("\n");
}

export async function runQualityJudge(
  judgeClient: OpenRouter,
  input: {
    articleSlice: string;
    summary: string;
    language: Env["SUMMARY_LANG"];
    envLike: Pick<Env, "JUDGE_ARTICLE_MAX_CHARS" | "JUDGE_MAX_TOKENS" | "JUDGE_MODEL">;
  }
): Promise<JudgeVerdict> {
  const snippet = truncateSnippet(input.articleSlice, input.envLike.JUDGE_ARTICLE_MAX_CHARS);
  const schema: JsonSchema = {
    type: "object",
    properties: {
      accuracy: { type: "number", minimum: 1, maximum: 5 },
      completeness: { type: "number", minimum: 1, maximum: 5 },
      faithfulness: { type: "number", minimum: 1, maximum: 5 },
      format_adherence: { type: "number", minimum: 1, maximum: 5 },
      language_purity: { type: "number", minimum: 1, maximum: 5 },
      overall: { type: "number", minimum: 1, maximum: 5 },
      is_refusal: { type: "boolean" },
      reasons: { type: "array", items: { type: "string" }, maxItems: 8 },
    },
    required: [
      "accuracy",
      "completeness",
      "faithfulness",
      "format_adherence",
      "language_purity",
      "overall",
      "is_refusal",
      "reasons",
    ],
    additionalProperties: false,
  };

  const messages = [
    {
      role: "system" as const,
      content:
        "You are an expert evaluator for Hacker News article summaries. Be strict and consistent. Respond ONLY in JSON.",
    },
    {
      role: "user" as const,
      content: buildJudgePrompt({
        language: input.language,
        summary: input.summary,
        articleSnippet: snippet,
      }),
    },
  ];

  return await judgeClient.chatStructured(messages, {
    temperature: 0,
    maxTokens: input.envLike.JUDGE_MAX_TOKENS,
    model: input.envLike.JUDGE_MODEL,
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "summary_quality_judge", strict: true, schema },
    },
  }, JudgeVerdictSchema, 2);
}

const STUB_JUDGE_VERDICT: JudgeVerdict = {
  accuracy: 3,
  completeness: 3,
  faithfulness: 3,
  format_adherence: 3,
  language_purity: 3,
  overall: 3,
  is_refusal: false,
  reasons: ["stub_judge"],
};

export async function scoreOneRun(params: {
  /** Client for the candidate provider (OpenRouter / 9Router / Groq / …). */
  candidateClient: OpenRouter;
  judgeClient: OpenRouter;
  /** Model id sent to the candidate provider. */
  model: string;
  /** Unique leaderboard key for this candidate (defaults to `model`). */
  label?: string;
  /** Summary generation strategy (default "direct"). */
  pipeline?: "direct" | "en-then-ru";
  /** Called before EVERY candidate API call (provider throttling). */
  beforeCandidateCall?: () => Promise<void>;
  article: BenchArticle;
  repeat: number;
  envLike: Env;
  stubJudge?: boolean;
}): Promise<{ record: ScoredRunRecord; summaryText: string }> {
  const { candidateClient, judgeClient, model, label, pipeline, beforeCandidateCall, article, repeat, envLike, stubJudge } =
    params;
  const run =
    pipeline === "en-then-ru"
      ? await summarizeTwoStepEnRu(candidateClient, article.articleSlice, model, envLike, beforeCandidateCall)
      : await summarizeWithModel(candidateClient, article.articleSlice, model, envLike, beforeCandidateCall);
  const heuristic = checkSummaryHeuristics(run.content || undefined, {
    minChars: envLike.POST_SUMMARY_MIN_CHARS,
    language: envLike.SUMMARY_LANG,
    kind: "post",
    languageGate: languageGateFromEnv(envLike),
  });

  const skipJudge = run.error !== undefined || run.content.trim().length === 0;
  let judge: JudgeVerdict | undefined;
  if (!skipJudge) {
    judge = stubJudge === true
      ? STUB_JUDGE_VERDICT
      : await runQualityJudge(judgeClient, {
          articleSlice: article.articleSlice,
          summary: run.content,
          language: envLike.SUMMARY_LANG,
          envLike,
        });
  }

  const record: ScoredRunRecord = {
    model: label ?? model,
    articleId: article.id,
    repeat,
    latencyMs: run.latencyMs,
    outputChars: run.content.length,
    ...(run.error === undefined ? {} : { error: run.error }),
    heuristic,
    ...(judge === undefined ? { judgeSkipped: true } : { judge }),
  };
  return { record, summaryText: run.content };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function mean(nums: number[]): number | undefined {
  if (nums.length === 0) {
    return undefined;
  }
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function aggregate(runs: ScoredRunRecord[]): ModelScore[] {
  const byModel = new Map<string, ScoredRunRecord[]>();
  for (const run of runs) {
    const list = byModel.get(run.model) ?? [];
    list.push(run);
    byModel.set(run.model, list);
  }

  const scores: ModelScore[] = [];
  for (const [model, modelRuns] of byModel) {
    const n = modelRuns.length;
    const heuristicOk = modelRuns.filter((r) => r.heuristic.ok).length;
    const heuristic_pass_rate = n === 0 ? 0 : heuristicOk / n;
    const refusal_rate =
      n === 0
        ? 0
        : modelRuns.filter((r) => r.judge?.is_refusal === true || r.heuristic.triggers.some((t) => t.reason === "refusal")).length / n;
    const error_rate = n === 0 ? 0 : modelRuns.filter((r) => r.error !== undefined).length / n;

    const histogram: Record<string, number> = {};
    for (const run of modelRuns) {
      for (const t of run.heuristic.triggers) {
        histogram[t.reason] = (histogram[t.reason] ?? 0) + 1;
      }
      if (run.error !== undefined) {
        histogram["candidate_error"] = (histogram["candidate_error"] ?? 0) + 1;
      }
    }

    const judged = modelRuns.filter((r): r is ScoredRunRecord & { judge: JudgeVerdict } => r.judge !== undefined);
    const latencies = modelRuns.map((r) => r.latencyMs).sort((a, b) => a - b);
    const mean_overall = mean(judged.map((r) => r.judge.overall));
    const composite_rank = (mean_overall ?? 0) * heuristic_pass_rate;

    scores.push({
      model,
      n,
      heuristic_pass_rate,
      refusal_rate,
      failure_histogram: histogram,
      mean_overall,
      mean_accuracy: mean(judged.map((r) => r.judge.accuracy)),
      mean_completeness: mean(judged.map((r) => r.judge.completeness)),
      mean_faithfulness: mean(judged.map((r) => r.judge.faithfulness)),
      mean_format_adherence: mean(judged.map((r) => r.judge.format_adherence)),
      mean_language_purity: mean(judged.map((r) => r.judge.language_purity)),
      error_rate,
      p50_latency_ms: percentile(latencies, 50),
      p95_latency_ms: percentile(latencies, 95),
      mean_output_chars: n === 0 ? 0 : modelRuns.reduce((s, r) => s + r.outputChars, 0) / n,
      composite_rank,
    });
  }

  scores.sort((a, b) => {
    if (b.composite_rank !== a.composite_rank) {
      return b.composite_rank - a.composite_rank;
    }
    return a.p95_latency_ms - b.p95_latency_ms;
  });

  return scores;
}

export function renderLeaderboardMarkdown(scores: ModelScore[], meta?: { generatedAt?: string; runCount?: number }): string {
  const lines: string[] = [
    "# Model scoring leaderboard (article summaries)",
    "",
    meta?.generatedAt === undefined ? "" : `Generated: ${meta.generatedAt}`,
    meta?.runCount === undefined ? "" : `Runs: ${meta.runCount}`,
    "",
    "Rank uses **composite** = `mean_overall × heuristic_pass_rate` (tie-break: lower p95 latency).",
    "The judge is instructed to fold language_purity into `overall`, so purity affects the rank; the column shows it separately.",
    "",
    "| Rank | Model | Composite | Judge overall | Lang purity | Heuristic pass | Error rate | Refusal rate | p95 ms |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ].filter((line) => line !== "");

  for (const [i, s] of scores.entries()) {
    const overall = s.mean_overall === undefined ? "—" : s.mean_overall.toFixed(2);
    const purity = s.mean_language_purity === undefined ? "—" : s.mean_language_purity.toFixed(2);
    lines.push(
      `| ${i + 1} | \`${s.model}\` | ${s.composite_rank.toFixed(3)} | ${overall} | ${purity} | ${(s.heuristic_pass_rate * 100).toFixed(0)}% | ${(s.error_rate * 100).toFixed(0)}% | ${(s.refusal_rate * 100).toFixed(0)}% | ${Math.round(s.p95_latency_ms)} |`
    );
  }

  lines.push("", "## Failure histograms", "");
  for (const s of scores) {
    const entries = Object.entries(s.failure_histogram).sort((a, b) => b[1] - a[1]);
    const hist = entries.length === 0 ? "(none)" : entries.map(([k, v]) => `${k}:${v}`).join(", ");
    lines.push(`- **${s.model}**: ${hist}`);
  }

  return `${lines.join("\n")}\n`;
}
