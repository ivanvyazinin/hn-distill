import { z } from "zod";

import { log } from "@utils/log";
import { canonicalize, dedupeKeepOrder, heuristicTags } from "@utils/tags";

import type { Env } from "@config/env";
import type { JsonSchema, OpenRouter } from "@utils/openrouter";


// Single source of truth for the allowed `cat` values. Referenced by the zod
// response schema, the strict JSON schema sent to the model, and the prompt text,
// so the three can never drift apart.
export const CAT_ENUM = [
  "topic",
  "lang",
  "lib",
  "framework",
  "company",
  "org",
  "product",
  "standard",
  "person",
  "event",
  "infra",
  "other",
] as const;

const CAT_SET: ReadonlySet<string> = new Set(CAT_ENUM);

// Known human-readable phrasings a weak model tends to emit, mapped onto the enum.
// Only used to salvage the fallback JSON path — `cat` is discarded downstream
// (see tags-cat-dead-downstream), so this is best-effort, not load-bearing.
const CAT_ALIASES: Record<string, string> = {
  "programming language": "lang",
  programming_language: "lang",
  language: "lang",
  library: "lib",
  libraries: "lib",
  frameworks: "framework",
  companies: "company",
  organization: "org",
  organisation: "org",
  protocol: "standard",
  spec: "standard",
  specification: "standard",
  service: "product",
  tool: "product",
  tooling: "product",
  concept: "topic",
};

const TagInResponseSchema = z.object({
  name: z.string().min(1).max(40),
  cat: z.enum(CAT_ENUM).optional(),
});

export const TagsResponseSchema = (max: number): z.ZodObject<{ tags: z.ZodArray<typeof TagInResponseSchema> }> =>
  z.object({
    tags: z.array(TagInResponseSchema).max(max),
  });

type TagsResponse = z.infer<ReturnType<typeof TagsResponseSchema>>;

export function buildTagsPrompt(
  story: { title: string; url: string | null },
  postSummary?: string,
  commentsSummary?: string
): string {
  const { title, url } = story;
  const hasUrl = typeof url === "string" && url.length > 0;
  const domain = hasUrl ? new URL(url).hostname : "";
  const lines: string[] = [
    `Title: ${title}`,
    `URL: ${hasUrl ? url : "N/A"}`,
    `Domain: ${domain}`,
  ];

  const hasPost = typeof postSummary === "string" && postSummary.length > 0;
  if (hasPost) {
    lines.push(`\nArticle summary:\n${postSummary}`);
  }

  const hasComments = typeof commentsSummary === "string" && commentsSummary.length > 0;
  if (hasComments) {
    lines.push(`\nComments summary:\n${commentsSummary}`);
  }

  return lines.join("\n");
}

const TAGS_DEBUG_MESSAGE = "tags-extract";

// Shared rules text for both the structured and the fallback prompt. Includes the
// allowed `cat` enum + mapping hints so the model stops inventing categories like
// "programming_language" (the main cause of Groq strict json_validate_failed 400s).
function buildTagsRules(maxPerStory: number): string {
  return `You are a technical content categorization expert. Extract only the most relevant and certain tags from the given content.

Rules:
- Only include tags you are highly confident about based on explicit mentions or clear context
- Focus on: programming languages, frameworks, databases, cloud platforms, companies, protocols, and core technical concepts
- Use lowercase, normalized names (e.g., "javascript" not "JavaScript", "postgresql" not "PostgreSQL")
- Avoid generic terms like "software", "technology", "development" unless they're the main focus
- Prefer specific over general (e.g., "reactjs" over "frontend")
- Return at most ${maxPerStory} tags
- Only return tags that add meaningful categorization value

Allowed "cat" values (pick exactly one per tag, lowercase, from this list only):
${CAT_ENUM.join(", ")}
Mapping hints: programming language → lang; library → lib; framework → framework; company → company; organization/foundation/standards body → org; product or service → product; spec/protocol/standard → standard; person → person; anything unclear → other.`;
}

// Strip a leading ```json / ``` fence (and its closing ```) that weak models wrap
// JSON in, so the fallback JSON.parse doesn't choke on the backticks.
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  // Drop the opening fence line (``` or ```json) and the trailing ``` line.
  const withoutOpen = trimmed.replace(/^```[^\n]*\n?/u, "");
  const withoutClose = withoutOpen.replace(/\n?```$/u, "");
  return withoutClose.trim();
}

// Coerce a model-supplied `cat` onto the enum: exact match wins, then known aliases,
// otherwise drop to undefined (with a warn so bad-category frequency stays visible).
// `cat` is discarded before persistence, so dropping it never degrades output.
function normalizeCat(raw: unknown, model: string): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const lower = raw.trim().toLowerCase();
  if (lower === "") {
    return undefined;
  }
  if (CAT_SET.has(lower)) {
    return lower;
  }
  const aliased = CAT_ALIASES[lower];
  if (aliased !== undefined) {
    return aliased;
  }
  log.warn(TAGS_DEBUG_MESSAGE, "coerced unknown cat", { raw, model });
  return undefined;
}

// Normalize every tag's `cat` in a parsed fallback payload before zod validation.
// Non-conforming shapes pass through untouched so zod surfaces the real error.
function normalizeParsedTagCats(parsed: unknown, model: string): unknown {
  if (typeof parsed !== "object" || parsed === null) {
    return parsed;
  }
  const record = parsed as Record<string, unknown>;
  const { tags } = record;
  if (!Array.isArray(tags)) {
    return parsed;
  }
  const tagArray: unknown[] = tags;
  const normalizedTags = tagArray.map((tag) => {
    if (typeof tag !== "object" || tag === null) {
      return tag;
    }
    const tagRecord = tag as Record<string, unknown>;
    return { ...tagRecord, cat: normalizeCat(tagRecord["cat"], model) };
  });
  return { ...record, tags: normalizedTags };
}

export async function summarizeTagsStructured(
  or: OpenRouter,
  prompt: string,
  envLike: Pick<Env, "TAGS_MAX_PER_STORY" | "TAGS_MAX_TOKENS" | "TAGS_MODEL">
): Promise<Array<{ name: string; cat?: string | undefined }>> {
  log.debug(TAGS_DEBUG_MESSAGE, "structured request", {
    model: envLike.TAGS_MODEL,
    promptChars: prompt.length,
  });

  const schema: JsonSchema = {
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Tag name, normalized and lowercase",
            },
            cat: {
              type: "string",
              enum: [...CAT_ENUM],
              description: "Optional category for the tag",
            },
          },
          // Groq structured outputs (strict) require every declared property in `required`.
          // cat stays semantically optional via the zod schema, which tolerates it either way.
          required: ["name", "cat"],
          additionalProperties: false,
        },
      },
    },
    required: ["tags"],
    additionalProperties: false,
  };

  const zodSchema = TagsResponseSchema(envLike.TAGS_MAX_PER_STORY);
  const rules = buildTagsRules(envLike.TAGS_MAX_PER_STORY);

  try {
    const result = await or.chatStructured<TagsResponse>(
      [
        {
          role: "system",
          content: `Answer in JSON. ${rules}`,
        },
        { role: "user", content: prompt },
      ],
      {
        temperature: 0.5,
        maxTokens: envLike.TAGS_MAX_TOKENS,
        model: envLike.TAGS_MODEL,
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "tags_extraction",
            strict: true,
            schema,
          },
        },
      },
      zodSchema,
      2 // reduced retries
    );

    return result.tags.map((tag) => ({
      name: tag.name,
      cat: tag.cat,
    }));
  } catch (error) {
    log.warn(TAGS_DEBUG_MESSAGE, "structured outputs failed, falling back to regular JSON", {
      model: envLike.TAGS_MODEL,
      error: error instanceof Error ? error.message : String(error),
    });

    const jsonResponse = await or.chat(
      [
        {
          role: "system",
          content: `Answer in JSON format: { "tags": [{ "name": "...", "cat": "..." }] }. Return raw JSON only, without Markdown fences or commentary. ${rules}`,
        },
        { role: "user", content: prompt },
      ],
      {
        temperature: 0.5,
        maxTokens: envLike.TAGS_MAX_TOKENS,
        model: envLike.TAGS_MODEL,
      }
    );

    try {
      const parsed = JSON.parse(stripJsonFence(jsonResponse)) as unknown;
      const normalized = normalizeParsedTagCats(parsed, envLike.TAGS_MODEL);
      const validated = zodSchema.parse(normalized);
      return validated.tags.map((tag) => ({
        name: tag.name,
        cat: tag.cat,
      }));
    } catch (jsonError) {
      log.error(TAGS_DEBUG_MESSAGE, "fallback JSON parsing failed", {
        model: envLike.TAGS_MODEL,
        error: jsonError instanceof Error ? jsonError.message : String(jsonError),
        response: jsonResponse.slice(0, 200),
      });
      throw new Error(`Failed to parse fallback JSON from LLM: ${String(jsonError)}`);
    }
  }
}

export function combineAndCanon(input: {
  llm: Array<{ name: string; cat?: string | undefined }>;
  title: string;
  domain?: string | undefined;
  max: number;
}): string[] {
  const canonLlm = input.llm.map((t) => canonicalize({ name: t.name, cat: t.cat }));
  const heur = heuristicTags(input.title, input.domain).map((slug) => ({ slug }));
  return dedupeKeepOrder([...canonLlm, ...heur]).slice(0, input.max);
}