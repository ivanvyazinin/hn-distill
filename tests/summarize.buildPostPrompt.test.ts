import { describe, expect, test } from "bun:test";

import { buildPostPrompt } from "../scripts/summarize.mts";
import { story as makeStory, withEnvPatch } from "./helpers";

const SEP = "[…]";

describe("buildPostPrompt head+tail slicing", () => {
  test("returns short content unchanged", async () => {
    await withEnvPatch({ ARTICLE_SLICE_CHARS: 6000, ARTICLE_HEAD_CHARS: 4000 }, async () => {
      const content = "A short article that fits comfortably within the slice budget.";
      const out = await buildPostPrompt(makeStory(), content);
      expect(out).toBe(content);
      expect(out).not.toContain(SEP);
    });
  });

  test("long content keeps both intro and conclusion via head+tail", async () => {
    await withEnvPatch({ ARTICLE_SLICE_CHARS: 6000, ARTICLE_HEAD_CHARS: 4000 }, async () => {
      const content = `INTRO_MARKER ${"a".repeat(6000)} CONCLUSION_MARKER`;
      const out = await buildPostPrompt(makeStory(), content);
      expect(out).toContain("INTRO_MARKER");
      expect(out).toContain("CONCLUSION_MARKER");
      expect(out).toContain(SEP);
      // head (4000) + separator + tail (2000)
      expect(out.length).toBe(4000 + `\n\n${SEP}\n\n`.length + 2000);
    });
  });

  test("HEAD == SLICE degenerates to head-only (no tail, no separator)", async () => {
    await withEnvPatch({ ARTICLE_SLICE_CHARS: 6000, ARTICLE_HEAD_CHARS: 6000 }, async () => {
      const content = "z".repeat(6100);
      const out = await buildPostPrompt(makeStory(), content);
      expect(out).not.toContain(SEP);
      expect(out.length).toBe(6000);
    });
  });

  test("HEAD > SLICE stays within the total budget (head clamped to SLICE)", async () => {
    await withEnvPatch({ ARTICLE_SLICE_CHARS: 1000, ARTICLE_HEAD_CHARS: 2000 }, async () => {
      const content = "z".repeat(5000);
      const out = await buildPostPrompt(makeStory(), content);
      expect(out).not.toContain(SEP);
      expect(out.length).toBe(1000); // NOT 2000
    });
  });

  test("empty content yields empty prompt", async () => {
    const out = await buildPostPrompt(makeStory(), "");
    expect(out).toBe("");
    const out2 = await buildPostPrompt(makeStory());
    expect(out2).toBe("");
  });
});
