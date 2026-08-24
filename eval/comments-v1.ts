/**
 * Comments-v1 legacy candidate (N7 cleanup): the pre-v2 single-shot path with
 * heuristic validation and one escalation retry. Production runs comments-v2
 * (pipeline.summarize → generateValidatedCommentsSummaryV2); this module exists
 * only so baseline/eval and the v1 behavior tests keep exercising the exact
 * historical logic after it left pipeline/summarize.
 */
import { env } from "@config/env";
import { type CommentsSummary, type NormalizedComment } from "@config/schemas";
import {
  callLLMWithMessages,
  type LlmLogContext,
  type RouteServices,
} from "@utils/chat-route";
import { log } from "@utils/log";
import { checkSummaryHeuristics, languageGateFromEnv } from "@utils/summary-heuristics";

import type { ChatMessage } from "@utils/openrouter";

const LOG_NAMESPACE_COMMENTS = "summarize/comments" as const;

function buildCommentsSystemInstruction(): string {
  if (env.SUMMARY_LANG === "en") {
    return "You summarize Hacker News discussions in Markdown, in English. Always write in English.";
  }
  return [
    "Ты кратко пересказываешь обсуждения Hacker News в Markdown на русском языке.",
    "Пиши только по-русски, даже если все комментарии на английском. Никогда не переходи на английский.",
  ].join("\n");
}

function buildCommentsLanguageHeader(): string {
  if (env.SUMMARY_LANG === "en") {
    return (
      "Language: en\n" +
      // Style guardrails to avoid chatty prefaces
      "Summarize the discussion as 5–7 concise bullet points.\n" +
      "Output must be a markdown bullet list only, starting immediately with '- '.\n" +
      "Do not add any introductions, headings, prefaces, phrases like 'Summary:', 'Key takeaways:', or closing sentences.\n" +
      "No extra text before or after the list."
    );
  }
  return (
    "Language: ru\n" +
    "Суммаризируй обсуждение в 3-5 лаконичных буллетах.\n" +
    "Выводи только маркированный список в Markdown, сразу начинай с '- '.\n" +
    "Без вступлений, заголовков и фраз вида 'Саммари:', 'Основные тезисы обсуждения:', 'Вот саммари обсуждения:', и без заключений.\n" +
    "Никакого дополнительного текста до или после списка."
  );
}

export async function buildCommentsPrompt(
  comments: NormalizedComment[]
): Promise<{ prompt: string; sampleIds: number[] }> {
  const header = buildCommentsLanguageHeader();
  const { OPENROUTER_MAX_TOKENS } = env;
  let budget = 6 * OPENROUTER_MAX_TOKENS;
  const lines: string[] = [];
  for (const c of comments) {
    const { textPlain, by, depth } = c;
    const text = textPlain ? textPlain.replaceAll(/\s+/gu, " ").trim() : "";
    if (!text) {
      continue;
    }
    const line = `@${by} [d${depth}] ${text.slice(0, 400)}`;
    const cost = line.length + 1;
    if (budget - cost < 0) {
      break;
    }
    lines.push(line);
    budget -= cost;
  }
  const sampleIds = comments
    .filter((c) => {
      const { textPlain } = c;
      return Boolean(textPlain.trim());
    })
    .slice(0, 5)
    .map((c) => c.id);
  const prompt = [header, ...lines].join("\n");
  log.debug(LOG_NAMESPACE_COMMENTS, "Built comments prompt", { count: comments.length, promptChars: prompt.length });
  return { prompt, sampleIds };
}

export async function summarizeComments(
  services: RouteServices,
  storyId: number,
  prompt: string,
  sampleIds: number[] = [],
  options: { models?: string[]; context?: LlmLogContext } = {}
): Promise<Pick<CommentsSummary, "id" | "lang" | "model" | "sampleComments" | "summary">> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildCommentsSystemInstruction() },
    { role: "user", content: prompt },
  ];
  const { content, modelUsed } = await callLLMWithMessages(
    services,
    messages,
    options.context ?? {},
    "comments",
    options.models
  );
  return {
    id: storyId,
    lang: env.SUMMARY_LANG,
    summary: content,
    sampleComments: sampleIds,
    model: modelUsed,
  };
}

const HEURISTIC_REJECTION_WEIGHTS: Readonly<Record<string, number>> = {
  empty: 1000,
  refusal: 800,
  policy: 800,
  content_free: 700,
  artifact: 600,
  prompt_instructions: 600,
  low_cyrillic_ratio: 500,
  url_encoded_noise: 400,
  bare_bullets: 300,
  repetition_run: 300,
  low_unique_ratio: 250,
  contains_url: 200,
  latin_prose: 150,
  numeric_headings: 150,
  generic: 100,
  meta_instructions: 100,
  too_short: 75,
  too_few_words: 50,
  bullets_only: 50,
};

/** Lower is better; zero is a valid summary. Used only when both comment attempts fail. */
function heuristicRejectionScore(verdict: ReturnType<typeof checkSummaryHeuristics>): number {
  return verdict.triggers.reduce(
    (score, trigger) => score + (HEURISTIC_REJECTION_WEIGHTS[trigger.reason] ?? 100),
    0
  );
}

/**
 * Comments summary with content validation and a single escalated retry.
 * The first call keeps the default model chain untouched; on a heuristics reject
 * (language gate, refusal, artifacts, ...) one retry runs, starting from
 * SUMMARY_CONTENT_REJECT_MODEL when configured. A summary is never dropped:
 * if the retry is also rejected (or errors), the best available text is kept.
 */
export async function generateValidatedCommentsSummary(
  services: RouteServices,
  storyId: number,
  prompt: string,
  sampleIds: number[] = []
): Promise<Pick<CommentsSummary, "id" | "lang" | "model" | "sampleComments" | "summary">> {
  const checkOptions = {
    minChars: env.POST_SUMMARY_MIN_CHARS,
    language: env.SUMMARY_LANG,
    kind: "comments" as const,
    languageGate: languageGateFromEnv(env),
  };

  const first = await summarizeComments(services, storyId, prompt, sampleIds);
  const firstCheck = checkSummaryHeuristics(first.summary, checkOptions);
  if (firstCheck.ok) {
    return first;
  }

  log.warn(LOG_NAMESPACE_COMMENTS, "Comments heuristic check failed; retrying with escalation", {
    id: storyId,
    triggers: firstCheck.triggers,
  });

  const escalationModel = env.SUMMARY_CONTENT_REJECT_MODEL.trim();
  const models = escalationModel.length > 0 ? [escalationModel, env.OPENROUTER_FALLBACK_MODEL] : undefined;
  let retry: Awaited<ReturnType<typeof summarizeComments>>;
  try {
    retry = await summarizeComments(services, storyId, prompt, sampleIds, {
      ...(models === undefined ? {} : { models }),
      context: { attempt: "comments-retry" },
    });
  } catch (error) {
    log.error(LOG_NAMESPACE_COMMENTS, "Comments retry failed; keeping first summary", {
      id: storyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return first;
  }

  const retryCheck = checkSummaryHeuristics(retry.summary, checkOptions);
  if (retryCheck.ok) {
    return retry;
  }

  const firstScore = heuristicRejectionScore(firstCheck);
  const retryScore = heuristicRejectionScore(retryCheck);
  const keepRetry = retryScore < firstScore;
  log.warn(LOG_NAMESPACE_COMMENTS, "Comments retry still flagged; keeping less severe result", {
    id: storyId,
    firstScore,
    retryScore,
    selected: keepRetry ? "retry" : "first",
    firstTriggers: firstCheck.triggers,
    retryTriggers: retryCheck.triggers,
  });
  return keepRetry ? retry : first;
}
