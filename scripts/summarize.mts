import { createHash } from "node:crypto";
import { dirname } from "node:path";


import { env, type Env } from "@config/env";
import { PATHS, pathFor } from "@config/paths";
import {
  CommentsSummarySchema,
  IndexSchema,
  NormalizedCommentSchema,
  NormalizedStorySchema,
  PostSummarySchema,
  TagsSummarySchema,
  type CommentsSummary,
  type NormalizedComment,
  type NormalizedStory,
  type PostSummary,
} from "@config/schemas";
import { decodeText, looksLikeHtml, looksLikePdf } from "@utils/content-detect";
import { ensureDir, readTextSafe, writeTextFile } from "@utils/fs";
import { htmlToMd } from "@utils/html-to-md";
import { HttpClient } from "@utils/http-client";
import { readJsonSafeOr, writeJsonFile } from "@utils/json";
import { log } from "@utils/log";
import { OpenRouter, type ChatMessage } from "@utils/openrouter";
import { pdfToText } from "@utils/pdf";
import { buildTagsPrompt, combineAndCanon, summarizeTagsStructured } from "@utils/tags-extract";

import type { z } from "zod";

export type Services = {
  http: HttpClient;
  openrouter: OpenRouter;
  fetchArticleMarkdown: (url: string) => Promise<string>;
};

export function makeServices(e: Env): Services {
  const http = new HttpClient(
    {
      retries: e.HTTP_RETRIES,
      baseBackoffMs: e.HTTP_BACKOFF_MS,
      timeoutMs: e.HTTP_TIMEOUT_MS,
      retryOnStatuses: [408, 425, 429, 500, 502, 503, 504, 522],
    },
    {
      ua: "hn-distill/1.1 (+https://hckr.top/)",
      headers: {},
    }
  );
  const openrouter = new OpenRouter(http, e.OPENROUTER_API_KEY ?? "", e.OPENROUTER_MODEL);

  async function fetchArticleMarkdown(url: string): Promise<string> {
    const { data, contentType } = await http.bytes(url);
    const head = data.subarray(0, 8);

    if (looksLikePdf({ url, contentType: contentType ?? undefined, bytesHead: head })) {
      log.info(LOG_NAMESPACE_ARTICLE, "Fetching and parsing PDF", { url, contentType, bytes: data.length });
      try {
        const text = await pdfToText(data, {
          maxPages: e.PDF_MAX_PAGES,
          softMaxBytes: e.PDF_MAX_BYTES
        });
        log.debug(LOG_NAMESPACE_ARTICLE, "PDF parsed successfully", { url, textLength: text.length });
        return text;
      } catch (error) {
        log.error(LOG_NAMESPACE_ARTICLE, "PDF parse failed", { url, error: String(error) });
        return '';
      }
    } else if (looksLikeHtml(contentType ?? undefined)) {
      log.debug(LOG_NAMESPACE_ARTICLE, "Processing HTML content", { url, contentType });
      const html = decodeText(data, contentType);
      return htmlToMd(html);
    } else {
      log.debug(LOG_NAMESPACE_ARTICLE, "Processing as plain text", { url, contentType });
      try {
        const text = decodeText(data, contentType);
        return text.trim();
      } catch (error) {
        log.warn(LOG_NAMESPACE_ARTICLE, "Text decode failed", { url, contentType, error: String(error) });
        return '';
      }
    }
  }

  log.debug("summarize/services", "initialized", {
    hasOpenRouterKey: !!e.OPENROUTER_API_KEY,
    model: e.OPENROUTER_MODEL,
  });

  return { http, openrouter, fetchArticleMarkdown };
}

const TAGS_DEBUG_MESSAGE = "summarize/tags";

// Log namespaces
const LOG_NAMESPACE_LLM = "summarize/llm" as const;
const LOG_NAMESPACE_POST = "summarize/post" as const;
const LOG_NAMESPACE_COMMENTS = "summarize/comments" as const;
const LOG_NAMESPACE_ARTICLE = "summarize/article" as const;

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function buildPostSystemInstruction(): string {
  return env.SUMMARY_LANG === "en"
    ? "make the content two times shorter, don't mention the title, publication date and other metadata; format the output as markdown"
    : "переведи на русский содержимое (не указывай заголовок, дату и другие метаданные), сократи в два раза; форматируй вывод как markdown";
}

function buildCommentsLanguageHeader(): string {
  if (env.SUMMARY_LANG === "en") {
    return (
      "Language: en\n" +
      // Style guardrails to avoid chatty prefaces
      "Summarize the discussion as 5–9 concise bullet points.\n" +
      "Output must be a markdown bullet list only, starting immediately with '- '.\n" +
      "Do not add any introductions, headings, prefaces, phrases like 'Summary:', 'Key takeaways:', or closing sentences.\n" +
      "No extra text before or after the list."
    );
  }
  return (
    "Language: ru\n" +
    "Суммаризируй обсуждение в 5–9 лаконичных буллетах.\n" +
    "Выводи только маркированный список в Markdown, сразу начинай с '- '.\n" +
    "Без вступлений, заголовков и фраз вида 'Саммари:', 'Основные тезисы обсуждения:', 'Вот саммари обсуждения:', и без заключений.\n" +
    "Никакого дополнительного текста до или после списка."
  );
}

export async function buildPostPrompt(story: NormalizedStory, articleMd?: string): Promise<string> {
  const content = (articleMd ?? "").trim();
  if (!content) {
    log.warn(LOG_NAMESPACE_POST, "No article content – skipping post prompt", { id: story.id });
    return "";
  }
  const articleSlice = content.slice(0, env.ARTICLE_SLICE_CHARS);
  log.debug(LOG_NAMESPACE_POST, "Built post prompt", { id: story.id, promptChars: articleSlice.length });
  return articleSlice;
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

export function preserveMarkdownWhitespace(content: string): string {
  const normalized = content ? content.replaceAll(/\r\n?/gu, "\n") : "";
  const lines = normalized.split("\n");
  const outLines: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      outLines.push(line);
      continue;
    }

    if (inCodeBlock) {
      outLines.push(line);
    } else {
      const body = line.trimEnd();
      const trailing = line.slice(body.length);

      if (trailing.length > 2) {
        outLines.push(`${body}  `); // Trim to 2
      } else {
        outLines.push(line); // Keep as is if <= 2
      }
    }
  }
  return outLines.join("\n");
}

type LlmResult = { content: string; modelUsed: string };

async function callLLM(services: Services, prompt: string): Promise<LlmResult> {
  const { OPENROUTER_MODEL, OPENROUTER_FALLBACK_MODEL, OPENROUTER_MAX_TOKENS } = env;
  try {
    log.info(LOG_NAMESPACE_LLM, "Calling LLM", { model: OPENROUTER_MODEL, promptChars: prompt.length });
    const content = await services.openrouter.chat([{ role: "user", content: prompt }], {
      temperature: 0.3,
      maxTokens: OPENROUTER_MAX_TOKENS,
    });
    const cleaned = preserveMarkdownWhitespace(content).trim();
    log.debug(LOG_NAMESPACE_LLM, "LLM response received", { summaryChars: cleaned.length });
    return { content: cleaned, modelUsed: OPENROUTER_MODEL };
  } catch (error) {
    log.warn(LOG_NAMESPACE_LLM, "Primary model failed; trying fallback", {
      primary: OPENROUTER_MODEL,
      fallback: OPENROUTER_FALLBACK_MODEL,
      error: String(error),
    });
    // Try fallback model once for any error
    const content = await services.openrouter.chat([{ role: "user", content: prompt }], {
      temperature: 0.3,
      maxTokens: OPENROUTER_MAX_TOKENS,
      model: OPENROUTER_FALLBACK_MODEL,
    });
    const cleaned = preserveMarkdownWhitespace(content).trim();
    log.info(LOG_NAMESPACE_LLM, "Fallback LLM response received", {
      model: OPENROUTER_FALLBACK_MODEL,
      summaryChars: cleaned.length,
    });
    return { content: cleaned, modelUsed: OPENROUTER_FALLBACK_MODEL };
  }
}

async function callLLMWithMessages(services: Services, messages: ChatMessage[]): Promise<LlmResult> {
  const { OPENROUTER_MODEL, OPENROUTER_FALLBACK_MODEL, OPENROUTER_MAX_TOKENS } = env;
  try {
    log.info(LOG_NAMESPACE_LLM, "Calling LLM", { model: OPENROUTER_MODEL, messages: messages.length });
    const content = await services.openrouter.chat(messages, {
      temperature: 0.3,
      maxTokens: OPENROUTER_MAX_TOKENS,
    });
    const cleaned = preserveMarkdownWhitespace(content).trim();
    log.debug(LOG_NAMESPACE_LLM, "LLM response received", { summaryChars: cleaned.length });
    return { content: cleaned, modelUsed: OPENROUTER_MODEL };
  } catch (error) {
    log.warn(LOG_NAMESPACE_LLM, "Primary model failed; trying fallback", {
      primary: OPENROUTER_MODEL,
      fallback: OPENROUTER_FALLBACK_MODEL,
      error: String(error),
    });
    const content = await services.openrouter.chat(messages, {
      temperature: 0.3,
      maxTokens: OPENROUTER_MAX_TOKENS,
      model: OPENROUTER_FALLBACK_MODEL,
    });
    const cleaned = preserveMarkdownWhitespace(content).trim();
    log.info(LOG_NAMESPACE_LLM, "Fallback LLM response received", {
      model: OPENROUTER_FALLBACK_MODEL,
      summaryChars: cleaned.length,
    });
    return { content: cleaned, modelUsed: OPENROUTER_FALLBACK_MODEL };
  }
}

export function buildPostChatMessages(articleSlice: string): ChatMessage[] {
  const system = buildPostSystemInstruction();
  return [
    { role: "system", content: system },
    { role: "user", content: articleSlice },
  ];
}

export async function summarizePost(
  services: Services,
  story: NormalizedStory,
  articleSlice: string
): Promise<Pick<PostSummary, "id" | "lang" | "model" | "summary">> {
  const messages = buildPostChatMessages(articleSlice);
  const { content, modelUsed } = await callLLMWithMessages(services, messages);
  return { id: story.id, lang: env.SUMMARY_LANG, summary: content, model: modelUsed };
}

export async function summarizeComments(
  services: Services,
  storyId: number,
  prompt: string,
  sampleIds: number[] = []
): Promise<Pick<CommentsSummary, "id" | "lang" | "model" | "sampleComments" | "summary">> {
  const { content, modelUsed } = await callLLM(services, prompt);
  return {
    id: storyId,
    lang: env.SUMMARY_LANG,
    summary: content,
    sampleComments: sampleIds,
    model: modelUsed,
  };
}

export async function getOrFetchArticleMarkdown(
  services: Services,
  story: NormalizedStory
): Promise<string | undefined> {
  if (!story.url) {
    log.warn(LOG_NAMESPACE_ARTICLE, "Story has no URL; cannot fetch article", { id: story.id });
    return undefined;
  }
  const path = pathFor.articleMd(story.id);
  const cached = await readTextSafe(path);
  if (cached?.trim()) {
    log.debug(LOG_NAMESPACE_ARTICLE, "Using cached content", { id: story.id, path });
    return cached;
  }
  try {
    await ensureDir(dirname(path));
    log.info(LOG_NAMESPACE_ARTICLE, "Fetching article and processing content", { id: story.id, url: story.url });
    const md = await services.fetchArticleMarkdown(story.url);
    const text = md.trim();
    if (!text) {
      log.warn(LOG_NAMESPACE_ARTICLE, "Fetched content is empty", { id: story.id, url: story.url });
      return undefined;
    }
    await writeTextFile(path, text);
    log.debug(LOG_NAMESPACE_ARTICLE, "Wrote content cache", { id: story.id, path });
    return text;
  } catch (error) {
    log.error(LOG_NAMESPACE_ARTICLE, "Failed to fetch content", {
      id: story.id,
      url: story.url,
      error: String(error),
    });
    return undefined;
  }
}

// Local-only variant: do not hit network; used during pre-selection phase
async function getCachedArticleMarkdownOnly(story: NormalizedStory): Promise<string | undefined> {
  if (!story.url) {
    return undefined;
  }
  const path = pathFor.articleMd(story.id);
  const cached = await readTextSafe(path);
  return cached?.trim() ? cached : undefined;
}

async function processPostSummary(services: Services, story: NormalizedStory, postPath: string): Promise<void> {
  const existingPostSummary = await readJsonSafeOr(postPath, PostSummarySchema);

  if (env.POST_SUMMARY_ONLY_IF_MISSING && existingPostSummary) {
    log.debug(LOG_NAMESPACE_POST, "Post summary exists; skipping due to ONLY_IF_MISSING", { id: story.id });
    return;
  }

  const articleMd = await getOrFetchArticleMarkdown(services, story);
  const postArticleSlice = await buildPostPrompt(story, articleMd);
  const postInputHash = hashString(`${env.SUMMARY_LANG}|${postArticleSlice}`);

  if (existingPostSummary?.inputHash === postInputHash) {
    log.debug(LOG_NAMESPACE_POST, "Post summary up-to-date; skipping", { id: story.id });
    return;
  }

  if (postArticleSlice.length > 0) {
    const summaryContent = await summarizePost(services, story, postArticleSlice);
    const modelUsed = summaryContent.model ?? env.OPENROUTER_MODEL;
    const postSummary: PostSummary = {
      ...summaryContent,
      inputHash: postInputHash,
      model: modelUsed,
      createdISO: new Date().toISOString(),
    };
    await writeJsonFile(postPath, postSummary, { atomic: true, pretty: true });
    log.info(LOG_NAMESPACE_POST, "Post summary written", {
      id: story.id,
      chars: postSummary.summary.length,
      model: modelUsed,
    });
  } else {
    log.warn(LOG_NAMESPACE_POST, "Empty post prompt; skipping LLM", { id: story.id });
  }
}

async function processCommentsSummary(
  services: Services,
  story: NormalizedStory,
  comments: NormalizedComment[],
  commentsPath: string
): Promise<void> {
  const { prompt: commentsPrompt, sampleIds } = await buildCommentsPrompt(comments);
  const commentsInputHash = hashString(commentsPrompt);
  const existingCommentsSummary = await readJsonSafeOr(commentsPath, CommentsSummarySchema);

  if (existingCommentsSummary?.inputHash === commentsInputHash) {
    log.debug(LOG_NAMESPACE_COMMENTS, "Comments summary up-to-date; skipping", { id: story.id });
    return;
  }

  if (comments.length > 0) {
    const summaryContent = await summarizeComments(services, story.id, commentsPrompt, sampleIds);
    const modelUsed = summaryContent.model ?? env.OPENROUTER_MODEL;
    const commentsSummary: CommentsSummary = {
      ...summaryContent,
      inputHash: commentsInputHash,
      model: modelUsed,
      createdISO: new Date().toISOString(),
    };
    await writeJsonFile(commentsPath, commentsSummary, { atomic: true, pretty: true });
    log.info(LOG_NAMESPACE_COMMENTS, "Comments summary written", {
      id: story.id,
      chars: commentsSummary.summary.length,
      model: modelUsed,
    });
  } else {
    log.warn(LOG_NAMESPACE_COMMENTS, "No comments available; skipping summary", { id: story.id });
  }
}

async function processTags(
  services: Services,
  story: NormalizedStory,
  postSummary?: string,
  commentsSummary?: string
): Promise<void> {
  const p = pathFor.tagsSummary(story.id);
  const prompt = buildTagsPrompt(story, postSummary, commentsSummary);
  const inputHash = hashString(`tags|${prompt}|${env.TAGS_MODEL}`);
  const existing = await readJsonSafeOr(p, TagsSummarySchema);
  if (existing?.inputHash === inputHash) {
    log.debug(TAGS_DEBUG_MESSAGE, "up-to-date", { id: story.id });
    return;
  }

  try {
    const llm = await summarizeTagsStructured(services.openrouter, prompt, env);
    const domain = story.url ? new URL(story.url).hostname : undefined;
    const tags = combineAndCanon({
      llm,
      title: story.title,
      domain,
      max: env.TAGS_MAX_PER_STORY,
    });

    const payload = {
      id: story.id,
      lang: env.TAGS_LANG,
      tags: tags.map((slug) => ({ name: slug })), // store normalized names in summary for transparency
      inputHash,
      model: env.TAGS_MODEL,
      createdISO: new Date().toISOString(),
    };
    await writeJsonFile(p, payload, { atomic: true, pretty: true });
    log.info(TAGS_DEBUG_MESSAGE, "tags written", { id: story.id, count: tags.length, model: env.TAGS_MODEL });
  } catch (error) {
    log.error(TAGS_DEBUG_MESSAGE, "Failed to generate structured tags, falling back to heuristics", {
      id: story.id,
      error,
      model: env.TAGS_MODEL,
    });

    // Fallback to just heuristic tags if structured output fails
    const domain = story.url ? new URL(story.url).hostname : undefined;
    const tags = combineAndCanon({
      llm: [],
      title: story.title,
      domain,
      max: env.TAGS_MAX_PER_STORY,
    });

    const payload = {
      id: story.id,
      lang: env.TAGS_LANG,
      tags: tags.map((name) => ({ name })),
      inputHash,
      model: env.TAGS_MODEL,
      createdISO: new Date().toISOString(),
    };
    await writeJsonFile(p, payload, { atomic: true, pretty: true });
    log.info(TAGS_DEBUG_MESSAGE, "fallback tags written", { id: story.id, count: tags.length, model: env.TAGS_MODEL });
  }
}

async function processSingleStory(services: Services, id: number): Promise<void> {
  const story = await readJsonSafeOr<NormalizedStory>(
    pathFor.rawItem(id),
    NormalizedStorySchema as unknown as z.ZodType<NormalizedStory>
  );
  if (!story) {
    log.warn("summarize", "Missing normalized story file; skipping", { id });
    return;
  }

  const comments = await readJsonSafeOr<NormalizedComment[]>(
    pathFor.rawComments(id),
    NormalizedCommentSchema.array() as unknown as z.ZodType<NormalizedComment[]>,
    []
  );
  log.debug(LOG_NAMESPACE_COMMENTS, "Comments loaded", { id: story.id, count: comments.length });

  const postPath = pathFor.postSummary(id);
  const commentsPath = pathFor.commentsSummary(id);

  await processPostSummary(services, story, postPath);
  await processCommentsSummary(services, story, comments, commentsPath);

  const post = await readJsonSafeOr(pathFor.postSummary(story.id), PostSummarySchema);
  const commentsSummary = await readJsonSafeOr(pathFor.commentsSummary(story.id), CommentsSummarySchema);
  await processTags(services, story, post?.summary, commentsSummary?.summary);
}

export async function summarizeWorkflow(services: Services, e: Env = env): Promise<void> {
  const index = await readJsonSafeOr<{ updatedISO: string; storyIds: number[] }>(PATHS.index, IndexSchema, {
    updatedISO: new Date(0).toISOString(),
    storyIds: [],
  });

  const {
    OPENROUTER_API_KEY,
    SUMMARIZE_COOLDOWN_MINUTES,
    SUMMARIZE_MAX_STORIES_PER_RUN,
    POST_SUMMARY_ONLY_IF_MISSING,
    SUMMARY_LANG,
  } = e;
  if (!OPENROUTER_API_KEY) {
    log.warn("summarize", "OPENROUTER_API_KEY missing; skipping summarize step");
    return;
  }

  // Pre-select candidates to limit token burn per run
  const cooldownMins = Math.max(0, SUMMARIZE_COOLDOWN_MINUTES);
  const maxPerRun = Math.max(1, SUMMARIZE_MAX_STORIES_PER_RUN);

  type Candidate = {
    id: number;
    priority: number; // higher first
    timeISO?: string;
  };

  const candidates: Candidate[] = [];

  for (const id of index.storyIds) {
    try {
      // Load minimal story + summaries
      const story = await readJsonSafeOr<NormalizedStory>(
        pathFor.rawItem(id),
        NormalizedStorySchema as unknown as z.ZodType<NormalizedStory>
      );
      if (!story) {
        continue;
      }

      const [existingPost, existingComments] = await Promise.all([
        readJsonSafeOr(pathFor.postSummary(id), PostSummarySchema.nullable()),
        readJsonSafeOr(pathFor.commentsSummary(id), CommentsSummarySchema.nullable()),
      ]);

      const now = Date.now();
      const recentEnough = (iso?: string): boolean => {
        if (!iso || cooldownMins <= 0) {
          return false;
        }
        const ts = Date.parse(iso);
        return Number.isFinite(ts) && now - ts < cooldownMins * 60_000;
      };

      // Post: compute input hash only if cached article exists locally
      let postChanged = false;
      if (!existingPost) {
        postChanged = true; // missing summary
      } else if (POST_SUMMARY_ONLY_IF_MISSING) {
        postChanged = false;
      } else if (!recentEnough(existingPost.createdISO)) {
        const cachedMd = await getCachedArticleMarkdownOnly(story);
        if (cachedMd) {
          const slice = await buildPostPrompt(story, cachedMd);
          const hash = hashString(`${SUMMARY_LANG}|${slice}`);
          postChanged = existingPost.inputHash !== hash;
        }
      }

      // Comments: compute prompt hash
      let commentsChanged = false;
      if (!existingComments) {
        commentsChanged = true; // missing summary
      } else if (!recentEnough(existingComments.createdISO)) {
        const comments = await readJsonSafeOr<NormalizedComment[]>(
          pathFor.rawComments(id),
          NormalizedCommentSchema.array() as unknown as z.ZodType<NormalizedComment[]>,
          []
        );
        const { prompt } = await buildCommentsPrompt(comments);
        const hash = hashString(prompt);
        commentsChanged = existingComments.inputHash !== hash;
      }

      const priority = (postChanged ? 1 : 0) + (commentsChanged ? 2 : 0);
      if (priority > 0) {
        candidates.push({ id, priority, timeISO: story.timeISO });
      }
    } catch (error) {
      log.warn("summarize", "Preselect failed; will attempt full processing", { id, error: String(error) });
      candidates.push({ id, priority: 1 });
    }
  }

  // Sort: higher priority first; then newest by timeISO desc; then id desc
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    const ta = a.timeISO ? Date.parse(a.timeISO) : Number.NaN;
    const tb = b.timeISO ? Date.parse(b.timeISO) : Number.NaN;
    const aHas = Number.isFinite(ta);
    const bHas = Number.isFinite(tb);
    if (aHas && bHas) {
      return tb - ta;
    }
    if (aHas && !bHas) {
      return -1;
    }
    if (!aHas && bHas) {
      return 1;
    }
    return b.id - a.id;
  });

  const selected = candidates.slice(0, maxPerRun);
  const skipped = Math.max(0, candidates.length - selected.length);
  if (skipped > 0) {
    log.info("summarize", "Cap reached; skipping some stories this run", {
      candidates: candidates.length,
      selected: selected.length,
      skipped,
      maxPerRun,
      cooldownMins,
    });
  }

  for (const { id } of selected) {
    log.info("summarize", "Processing story", { id });
    try {
      await processSingleStory(services, id);
    } catch (error) {
      log.error("summarize", "Unhandled error during story processing", { id, error: String(error) });
      continue;
    }
  }
}

async function main(): Promise<void> {
  const services = makeServices(env);
  await summarizeWorkflow(services, env);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
