import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { CommentsSummarySchema } from "../config/schemas";

const legacyFixturePath = new URL("fixtures/comments-v2/legacy.comments.json", import.meta.url);

describe("CommentsSummary v2 backward compatibility", () => {
  test("parses a legacy comments file without adding v2 fields", () => {
    const legacy = JSON.parse(readFileSync(legacyFixturePath, "utf8")) as Record<string, unknown>;
    const result = CommentsSummarySchema.safeParse(legacy);

    expect(result.success).toBeTrue();
    if (!result.success) {
      return;
    }

    expect(JSON.stringify(result.data)).toBe(JSON.stringify(legacy));
    expect("structured" in result.data).toBeFalse();
    expect("formatVersion" in result.data).toBeFalse();
    expect("degraded" in result.data).toBeFalse();
  });

  test("still accepts the minimal legacy object", () => {
    const legacy = {
      id: 42,
      lang: "en",
      summary: "- The thread recommends measuring before making a migration decision.",
    } as const;

    expect(CommentsSummarySchema.parse(legacy)).toEqual(legacy);
  });

  test("round-trips a v2 blob that includes compressed", () => {
    const blob = {
      id: 99,
      lang: "ru" as const,
      summary: "Структурная сводка.",
      formatVersion: 2 as const,
      structured: {
        bottom_line: "Тред добавляет практический опыт эксплуатации и оговорки.",
        insights: [
          {
            kind: "advice" as const,
            text: "Сначала прогоните на маленьком наборе, потом масштабируйте.",
          },
        ],
        best_quote: null,
      },
      compressed: {
        text: "Тред добавляет опыт эксплуатации: сначала маленький набор, потом масштаб.",
        model: "qwen/qwen3-next-80b-a3b-instruct",
        createdISO: "2026-07-16T12:00:00.000Z",
        sourceHash: "abc123",
      },
    };

    expect(CommentsSummarySchema.parse(blob)).toEqual(blob);
  });
});
