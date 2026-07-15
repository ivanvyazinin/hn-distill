import { z } from "zod";

const IsoString = z.string().regex(/^\d{4}-\d{2}-\d{2}T.*Z$/u, "must be ISO string");

const INVALID_URL_MESSAGE = "Invalid URL";

export const HnItemRawSchema = z.object({
  id: z.number(),
  type: z.enum(["story", "comment"]),
  title: z.string().optional(),
  // accept any string here; validate/normalize later
  url: z.string().optional(),
  text: z.string().optional(),
  by: z.string().optional(),
  time: z.number().int().nonnegative(),
  kids: z.array(z.number()).optional(),
  parent: z.number().optional(),
  score: z.number().optional(),
  descendants: z.number().optional(),
});

export const NormalizedStorySchema = z.object({
  id: z.number(),
  title: z.string().max(500),
  url: z.union([
    z.string().refine((value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }, INVALID_URL_MESSAGE),
    z.null(),
  ]),
  by: z.string().max(80),
  timeISO: IsoString,
  commentIds: z.array(z.number()),
  score: z.number().optional(),
  descendants: z.number().optional(),
});

export const NormalizedCommentSchema = z.object({
  id: z.number(),
  by: z.string().max(80),
  timeISO: IsoString,
  textPlain: z.string().max(2000),
  parent: z.number(),
  depth: z.number().int().min(0).max(10),
});

export const IndexSchema = z.object({
  updatedISO: z.string(),
  storyIds: z.array(z.number()),
});

export const LangSchema = z.enum(["en", "ru"]);

export const PostSummarySchema = z.object({
  id: z.number(),
  lang: LangSchema,
  summary: z.string(),
  // Set when content extraction produced no usable article (nav/boilerplate/link
  // farm). The post LLM is skipped and `summary` is "" — only comments are summarized.
  degraded: z.literal("no-article").optional(),
  inputHash: z.string().optional(),
  model: z.string().optional(),
  createdISO: z.string().optional(),
  guard: z
    .object({
      ok: z.boolean(),
      verdict: z.string().optional(),
      reasons: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

const CommentsInsightTextSchema = z.string().min(20).max(300);
const CommentsInsightKindSchema = z.enum(["consensus", "dispute", "advice"]);

export const CommentsInsightsSchema = z
  .object({
    bottom_line: CommentsInsightTextSchema,
    insights: z
      .array(
        z
          .object({
            kind: CommentsInsightKindSchema,
            text: CommentsInsightTextSchema,
          })
          .strict()
      )
      .max(5),
    best_quote: z
      .object({
        comment_id: z.number().int().positive(),
        source_text: z.string().min(20).max(300),
        translation: z.string().min(20).max(300).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((value) => value.insights.length >= 1, "at least one insight is required");

/**
 * Provider-facing equivalent of CommentsInsightsSchema. Keep this explicit so
 * structured-output requests do not depend on a runtime schema converter.
 */
export const CommentsInsightsJsonSchema = {
  type: "object",
  properties: {
    bottom_line: { type: "string", minLength: 20, maxLength: 300 },
    insights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          // Nested enum is allowed (Groq/OpenAI reject enum only at schema root).
          kind: { type: "string", enum: ["consensus", "dispute", "advice"] },
          text: { type: "string", minLength: 20, maxLength: 300 },
        },
        required: ["kind", "text"],
        additionalProperties: false,
      },
      maxItems: 5,
      // No minItems: the "at least one insight" rule lives in the Zod refine only
      // so we do not expand the provider surface with keywords they reject at root.
    },
    best_quote: {
      anyOf: [
        {
          type: "object",
          properties: {
            comment_id: { type: "integer", minimum: 1 },
            source_text: { type: "string", minLength: 20, maxLength: 300 },
            translation: {
              anyOf: [
                { type: "string", minLength: 20, maxLength: 300 },
                { type: "null" },
              ],
            },
          },
          required: ["comment_id", "source_text", "translation"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
  },
  required: ["bottom_line", "insights", "best_quote"],
  additionalProperties: false,
  // No top-level anyOf: strict providers (Groq, OpenAI structured outputs) reject
  // oneOf/anyOf/enum/not at the schema root. The "at least one insight" rule is
  // enforced by CommentsInsightsSchema's Zod refine on every parse.
} as const;

export const CommentsSummarySchema = z.object({
  id: z.number(),
  lang: LangSchema,
  summary: z.string(),
  structured: CommentsInsightsSchema.optional(),
  formatVersion: z.literal(2).optional(),
  degraded: z.literal("too-few-comments").optional(),
  sampleComments: z.array(z.number()).optional(),
  inputHash: z.string().optional(),
  model: z.string().optional(),
  createdISO: z.string().optional(),
});

export const TagSchema = z.object({
  name: z.string().min(1).max(40),
  cat: z
    .enum([
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
    ])
    .optional(),
});
export const TagsSummarySchema = z.object({
  id: z.number(),
  lang: LangSchema, // keep 'en' regardless of SUMMARY_LANG for canonicalization; see env below
  tags: z.array(TagSchema), // normalized, deduped, max ~12
  inputHash: z.string().optional(),
  model: z.string().optional(),
  createdISO: z.string().optional(),
});

export const AggregatedItemSchema = z.object({
  id: z.number(),
  title: z.string().max(500),
  url: z.union([
    z.string().refine((value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }, INVALID_URL_MESSAGE),
    z.null(),
  ]),
  by: z.string().max(80),
  timeISO: IsoString,
  postSummary: z.string().optional(),
  commentsSummary: z.string().optional(),
  // Rendered parts for the site fold UI. Populated only on the FS aggregation
  // path (D1/sqlite loaders intentionally omit this — no migration).
  commentsInsights: z
    .object({
      lead: z.string(),
      visible: z.string(),
      folded: z.string(),
      foldedInsightsCount: z.number().int().min(0),
    })
    .optional(),
  score: z.number().optional(),
  commentsCount: z.number().optional(),
  hnUrl: z
    .string()
    .refine((value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }, "Invalid URL")
    .optional(),
  domain: z.string().optional(),
  tags: z.array(z.string()).optional(), // canonical slugs, e.g. ["llm","python","openai"]
});

export const AggregatedFileSchema = z.object({
  updatedISO: z.string(),
  items: z.array(AggregatedItemSchema),
});

export const DailyGroupFileSchema = z.object({
  updatedISO: z.string(),
  byDate: z.record(z.array(z.number())),
});

export const WeeklyGroupFileSchema = z.object({
  updatedISO: z.string(),
  byWeek: z.record(z.array(z.number())),
});

// Inferred types from schemas (single source of truth)
export type HnItemRaw = z.infer<typeof HnItemRawSchema>;
export type NormalizedStory = z.infer<typeof NormalizedStorySchema>;
export type NormalizedComment = z.infer<typeof NormalizedCommentSchema>;
export type PostSummary = z.infer<typeof PostSummarySchema>;
export type CommentsInsights = z.infer<typeof CommentsInsightsSchema>;
export type CommentsSummary = z.infer<typeof CommentsSummarySchema>;
export type TagsSummary = z.infer<typeof TagsSummarySchema>;
export type AggregatedItem = z.infer<typeof AggregatedItemSchema>;
export type AggregatedFile = z.infer<typeof AggregatedFileSchema>;
