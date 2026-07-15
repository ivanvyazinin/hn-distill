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

export const CommentsInsightsSchema = z
  .object({
    consensus: z.array(CommentsInsightTextSchema).max(3),
    disputes: z
      .array(
        z
          .object({
            topic: z.string().min(8).max(160),
            position_a: z.string().min(20).max(400),
            position_b: z.string().min(20).max(400),
          })
          .strict()
      )
      .max(3),
    practical_advice: z.array(CommentsInsightTextSchema).max(3),
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
  .refine(
    (value) => value.consensus.length + value.disputes.length + value.practical_advice.length >= 1,
    "at least one consensus, dispute, or practical advice item is required"
  );

/**
 * Provider-facing equivalent of CommentsInsightsSchema. Keep this explicit so
 * structured-output requests do not depend on a runtime schema converter.
 */
export const CommentsInsightsJsonSchema = {
  type: "object",
  properties: {
    consensus: {
      type: "array",
      items: { type: "string", minLength: 20, maxLength: 300 },
      maxItems: 3,
    },
    disputes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: { type: "string", minLength: 8, maxLength: 160 },
          position_a: { type: "string", minLength: 20, maxLength: 400 },
          position_b: { type: "string", minLength: 20, maxLength: 400 },
        },
        required: ["topic", "position_a", "position_b"],
        additionalProperties: false,
      },
      maxItems: 3,
    },
    practical_advice: {
      type: "array",
      items: { type: "string", minLength: 20, maxLength: 300 },
      maxItems: 3,
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
  required: ["consensus", "disputes", "practical_advice", "best_quote"],
  additionalProperties: false,
  anyOf: [
    { properties: { consensus: { minItems: 1 } } },
    { properties: { disputes: { minItems: 1 } } },
    { properties: { practical_advice: { minItems: 1 } } },
  ],
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
