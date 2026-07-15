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
});
