import { describe, expect, test } from "bun:test";

import {
  compressDecision,
  parseArgs,
} from "../scripts/backfill-comments-v2.mts";
import type { CommentsSummary } from "../config/schemas";
import { makeRuCommentsInsights } from "./helpers/comments-insights.ts";
import { compressSourceHash, renderCommentsInsightsPlainText } from "../utils/comments-compress.ts";

describe("backfill-comments-v2 args and compress-only gates", () => {
  test("parseArgs requires ids or all-structured for compress-only", () => {
    expect(() => parseArgs(["--compress-only"])).toThrow("--compress-only requires");
    expect(() => parseArgs([])).toThrow("Provide at least one story id");
    const ok = parseArgs(["--ids", "1,2", "--compress-only", "--dry-run"]);
    expect(ok.ids).toEqual([1, 2]);
    expect(ok.compressOnly).toBeTrue();
    expect(ok.dryRun).toBeTrue();
    const all = parseArgs(["--all-structured", "--compress-only"]);
    expect(all.allStructured).toBeTrue();
    expect(all.compressOnly).toBeTrue();
  });

  test("compressDecision skips non-structured and degraded blobs", () => {
    expect(compressDecision(undefined, false)).toEqual({ action: "skip", reason: "no-blob" });
    expect(
      compressDecision(
        { id: 1, lang: "ru", summary: "x", formatVersion: 2 } as CommentsSummary,
        false
      ).reason
    ).toBe("not-structured");
    expect(
      compressDecision(
        {
          id: 1,
          lang: "ru",
          summary: "x",
          formatVersion: 2,
          structured: makeRuCommentsInsights(),
          degraded: "too-few-comments",
        } as CommentsSummary,
        false
      ).reason
    ).toBe("degraded:too-few-comments");
  });

  test("compressDecision compresses retryable and skips usable/rejected unless force", () => {
    const structured = makeRuCommentsInsights();
    const sourceHash = compressSourceHash("ru", renderCommentsInsightsPlainText(structured));
    const base = {
      id: 1,
      lang: "ru" as const,
      summary: "x",
      formatVersion: 2 as const,
      structured,
    };

    expect(compressDecision(base, false).action).toBe("compress");
    expect(compressDecision(base, false).reason).toBe("retryable");

    const usable = {
      ...base,
      compressed: { text: "ok", model: "m", createdISO: "t", sourceHash },
    };
    expect(compressDecision(usable, false).action).toBe("skip");
    expect(compressDecision(usable, false).reason).toBe("state:usable");
    expect(compressDecision(usable, true).action).toBe("compress");
    expect(compressDecision(usable, true).reason).toBe("force");

    const rejected = {
      ...base,
      compressed: { text: "", model: "m", createdISO: "t", sourceHash },
    };
    expect(compressDecision(rejected, false).action).toBe("skip");
    expect(compressDecision(rejected, false).reason).toBe("state:rejected");
  });
});
