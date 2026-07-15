import { describe, expect, test } from "bun:test";

import { CommentsInsightsJsonSchema, CommentsInsightsSchema } from "../config/schemas";
import { makeRuCommentsInsights } from "./helpers/comments-insights.ts";

type JsonSchemaNode = {
  additionalProperties?: boolean;
  anyOf?: readonly JsonSchemaNode[];
  const?: unknown;
  enum?: readonly unknown[];
  items?: JsonSchemaNode;
  maximum?: number;
  maxItems?: number;
  maxLength?: number;
  minimum?: number;
  minItems?: number;
  minLength?: number;
  properties?: Record<string, JsonSchemaNode>;
  required?: readonly string[];
  type?: string | readonly string[];
};

const validAdviceOnly = makeRuCommentsInsights({
  insights: [
    {
      kind: "advice",
      text: "Проверьте решение на небольшом наборе данных перед полным запуском.",
    },
  ],
  best_quote: null,
});

const validComplete = makeRuCommentsInsights({
  insights: [
    {
      kind: "consensus",
      text: "Участники согласны, что измерения нужны до выбора архитектуры.",
    },
    {
      kind: "dispute",
      text: "Спор: одна сторона предлагает переключить всех сразу, другая — постепенное включение с откатом.",
    },
    {
      kind: "advice",
      text: "Проверьте решение на небольшом наборе данных перед полным запуском.",
    },
  ],
  best_quote: {
    comment_id: 41_850_701,
    source_text: "Measure twice, migrate once, and keep a rollback path ready.",
    translation: "Сначала всё измерьте, затем мигрируйте и оставьте путь для отката.",
  },
});

function hasType(schema: JsonSchemaNode, type: string): boolean {
  return Array.isArray(schema.type) ? schema.type.includes(type) : schema.type === type;
}

function matchesJsonSchema(value: unknown, schema: JsonSchemaNode): boolean {
  if (schema.const !== undefined && value !== schema.const) {
    return false;
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return false;
  }

  if (schema.type !== undefined) {
    const matchesType =
      (hasType(schema, "null") && value === null) ||
      (hasType(schema, "array") && Array.isArray(value)) ||
      (hasType(schema, "object") && typeof value === "object" && value !== null && !Array.isArray(value)) ||
      (hasType(schema, "string") && typeof value === "string") ||
      (hasType(schema, "integer") && typeof value === "number" && Number.isInteger(value)) ||
      (hasType(schema, "number") && typeof value === "number" && Number.isFinite(value));
    if (!matchesType) {
      return false;
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return false;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return false;
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return false;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return false;
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return false;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return false;
    }
    const itemSchema = schema.items;
    if (itemSchema !== undefined && !value.every((item) => matchesJsonSchema(item, itemSchema))) {
      return false;
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        return false;
      }
    }
    if (schema.additionalProperties === false && schema.properties !== undefined) {
      const allowed = new Set(Object.keys(schema.properties));
      if (Object.keys(record).some((key) => !allowed.has(key))) {
        return false;
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (key in record && !matchesJsonSchema(record[key], propertySchema)) {
        return false;
      }
    }
  }

  return schema.anyOf === undefined || schema.anyOf.some((candidate) => matchesJsonSchema(value, candidate));
}

describe("CommentsInsights schema contract", () => {
  test("keeps the response-format schema closed at every object boundary", () => {
    const schema = CommentsInsightsJsonSchema as JsonSchemaNode;
    const insight = schema.properties?.["insights"]?.items;
    const quote = schema.properties?.["best_quote"]?.anyOf?.find((candidate) => candidate.type === "object");

    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBeFalse();
    expect(schema.required).toEqual(["bottom_line", "insights", "best_quote"]);
    expect(schema.properties?.["insights"]?.minItems).toBeUndefined();
    expect(insight?.additionalProperties).toBeFalse();
    expect(insight?.required).toEqual(["kind", "text"]);
    expect(insight?.properties?.["kind"]?.enum).toEqual(["consensus", "dispute", "advice"]);
    expect(quote?.additionalProperties).toBeFalse();
    expect(quote?.required).toEqual(["comment_id", "source_text", "translation"]);
  });

  test("Zod and JSON Schema agree on a shared valid/invalid matrix", () => {
    const matrix: ReadonlyArray<{
      expected: boolean;
      /** JSON Schema verdict when it deliberately diverges from Zod (structural vs semantic). */
      jsonSchemaExpected?: boolean;
      name: string;
      value: unknown;
    }> = [
      { expected: true, name: "complete payload", value: validComplete },
      { expected: true, name: "advice-only payload", value: validAdviceOnly },
      {
        expected: false,
        // Deliberate divergence: the JSON Schema is structural-only (no minItems),
        // so the at-least-one-insight rule lives in the Zod refine alone.
        jsonSchemaExpected: true,
        name: "empty insights payload",
        value: {
          bottom_line: validAdviceOnly.bottom_line,
          insights: [],
          best_quote: null,
        },
      },
      { expected: false, name: "additional root property", value: { ...validAdviceOnly, invented: true } },
      {
        expected: false,
        name: "additional insight property",
        value: {
          ...validComplete,
          insights: [{ ...validComplete.insights[0]!, confidence: 0.9 }],
        },
      },
      {
        expected: false,
        name: "invalid insight kind",
        value: {
          ...validAdviceOnly,
          insights: [{ kind: "tip", text: validAdviceOnly.insights[0]!.text }],
        },
      },
      {
        expected: false,
        name: "non-positive quote id",
        value: { ...validComplete, best_quote: { ...validComplete.best_quote!, comment_id: 0 } },
      },
      {
        expected: false,
        name: "model-authored quote attribution",
        value: { ...validComplete, best_quote: { ...validComplete.best_quote!, author: "alice" } },
      },
      {
        expected: false,
        name: "missing quote source text",
        value: {
          ...validComplete,
          best_quote: {
            comment_id: validComplete.best_quote!.comment_id,
            translation: validComplete.best_quote!.translation,
          },
        },
      },
      {
        expected: false,
        name: "missing bottom_line",
        value: { insights: validAdviceOnly.insights, best_quote: null },
      },
    ];
    const jsonSchema = CommentsInsightsJsonSchema as JsonSchemaNode;

    for (const fixture of matrix) {
      const zodResult = CommentsInsightsSchema.safeParse(fixture.value).success;
      const jsonSchemaResult = matchesJsonSchema(fixture.value, jsonSchema);

      expect({ fixture: fixture.name, result: zodResult }).toEqual({
        fixture: fixture.name,
        result: fixture.expected,
      });
      expect({ fixture: fixture.name, result: jsonSchemaResult }).toEqual({
        fixture: fixture.name,
        result: fixture.jsonSchemaExpected ?? fixture.expected,
      });
    }
  });
});
