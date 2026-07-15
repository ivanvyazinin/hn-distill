import { describe, expect, test } from "bun:test";

import { CommentsInsightsJsonSchema, CommentsInsightsSchema } from "../config/schemas";

type JsonSchemaNode = {
  additionalProperties?: boolean;
  anyOf?: readonly JsonSchemaNode[];
  const?: unknown;
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

const VALID_ADVICE = "Проверьте решение на небольшом наборе данных перед полным запуском.";
const VALID_CONSENSUS = "Участники согласны, что измерения нужны до выбора архитектуры.";

const validAdviceOnly = {
  consensus: [],
  disputes: [],
  practical_advice: [VALID_ADVICE],
  best_quote: null,
};

const validComplete = {
  consensus: [VALID_CONSENSUS],
  disputes: [
    {
      topic: "Стратегия миграции",
      position_a: "Одна сторона предлагает переключить всех пользователей сразу после тестов.",
      position_b: "Другая сторона настаивает на постепенном включении с быстрым откатом.",
    },
  ],
  practical_advice: [VALID_ADVICE],
  best_quote: {
    comment_id: 41_850_701,
    source_text: "Measure twice, migrate once, and keep a rollback path ready.",
    translation: "Сначала всё измерьте, затем мигрируйте и оставьте путь для отката.",
  },
};

function hasType(schema: JsonSchemaNode, type: string): boolean {
  return Array.isArray(schema.type) ? schema.type.includes(type) : schema.type === type;
}

function matchesJsonSchema(value: unknown, schema: JsonSchemaNode): boolean {
  if (schema.const !== undefined && value !== schema.const) {
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
    const dispute = schema.properties?.["disputes"]?.items;
    const quote = schema.properties?.["best_quote"]?.anyOf?.find((candidate) => candidate.type === "object");

    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBeFalse();
    expect(schema.required).toEqual(["consensus", "disputes", "practical_advice", "best_quote"]);
    expect(dispute?.additionalProperties).toBeFalse();
    expect(dispute?.required).toEqual(["topic", "position_a", "position_b"]);
    expect(quote?.additionalProperties).toBeFalse();
    expect(quote?.required).toEqual(["comment_id", "source_text", "translation"]);
  });

  test("Zod and JSON Schema agree on a shared valid/invalid matrix", () => {
    const matrix: ReadonlyArray<{ expected: boolean; name: string; value: unknown }> = [
      { expected: true, name: "complete payload", value: validComplete },
      { expected: true, name: "advice-only payload", value: validAdviceOnly },
      {
        expected: false,
        name: "empty semantic payload",
        value: { consensus: [], disputes: [], practical_advice: [], best_quote: null },
      },
      { expected: false, name: "additional root property", value: { ...validAdviceOnly, invented: true } },
      {
        expected: false,
        name: "additional dispute property",
        value: {
          ...validComplete,
          disputes: [{ ...validComplete.disputes[0], confidence: 0.9 }],
        },
      },
      {
        expected: false,
        name: "non-positive quote id",
        value: { ...validComplete, best_quote: { ...validComplete.best_quote, comment_id: 0 } },
      },
      {
        expected: false,
        name: "model-authored quote attribution",
        value: { ...validComplete, best_quote: { ...validComplete.best_quote, author: "alice" } },
      },
      {
        expected: false,
        name: "missing quote source text",
        value: {
          ...validComplete,
          best_quote: {
            comment_id: validComplete.best_quote.comment_id,
            translation: validComplete.best_quote.translation,
          },
        },
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
        result: fixture.expected,
      });
      expect(jsonSchemaResult).toBe(zodResult);
    }
  });
});
