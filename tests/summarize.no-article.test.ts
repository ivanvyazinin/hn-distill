import { describe, expect, test } from "bun:test";

import type { ArticleExtractRow, MetaStore, SummaryRow } from "../utils/meta-store";
import type { ChatMessage } from "../utils/openrouter";
import { comment as makeComment, mockPaths, story as makeStory, withEnvPatch, withTempDir } from "./helpers";

// A link farm: high link density + thin prose -> detector verdict "no-article".
const GARBAGE_HTML_MD = `[Home](/) [About](/about) [Products](/products) [Pricing](/pricing) [Blog](/blog)

Something went wrong. Please try again.

Practice again

- [Facebook](https://facebook.com)
- [Twitter](https://twitter.com)
- [LinkedIn](https://linkedin.com)

[Privacy](/privacy) [Terms](/terms)`;

type Recorder = {
  chatCalls: ChatMessage[][];
  summaries: SummaryRow[];
  extracts: ArticleExtractRow[];
  extractById: Map<number, ArticleExtractRow>;
};

function makeRecorder(): Recorder {
  return { chatCalls: [], summaries: [], extracts: [], extractById: new Map() };
}

const metaNoop = async (): Promise<void> => {};

// Only the methods exercised by the degraded post + comments path are backed;
// the rest are no-ops behind the `unknown` cast (telegram stream + tags are off).
function makeMeta(rec: Recorder): MetaStore {
  return {
    migrate: metaNoop,
    upsertSummary: async (row: SummaryRow) => {
      rec.summaries.push(row);
    },
    replaceTags: metaNoop,
    upsertArticleExtract: async (row: ArticleExtractRow) => {
      rec.extracts.push(row);
      rec.extractById.set(row.storyId, row);
    },
    getArticleExtract: async (storyId: number) => rec.extractById.get(storyId),
    upsertRawBlob: metaNoop,
    upsertProcessingState: metaNoop,
  } as unknown as MetaStore;
}

describe("degraded no-article lifecycle", () => {
  test("skips the post LLM, writes a degraded stub, retires the summary, still summarizes comments", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { processSingleStory } = await import("../pipeline/summarize");
      const { createFsStore } = await import("../utils/fs-store");

      const store = createFsStore();
      const id = 48_845_049;
      const s = makeStory({ id, url: "https://example.com/game", commentIds: [1, 2] });
      await store.putJson(pathFor.rawItem(id), s);
      await store.putJson(pathFor.rawComments(id), [
        makeComment({ id: 1, parent: id, textPlain: "This game is fun but has bugs", depth: 1 }),
        makeComment({ id: 2, parent: id, textPlain: "Agreed, the scoring is broken", depth: 1 }),
      ]);

      const rec = makeRecorder();
      const chat = async (messages: ChatMessage[]): Promise<string> => {
        rec.chatCalls.push(messages);
        return "- Readers found the game fun\n- Several report scoring bugs";
      };
      const orMock = { chat, chatStructured: async () => "{}" } as never;
      const services = {
        http: {} as never,
        openrouter: orMock,
        guardTagsClient: orMock,
        fetchArticleMarkdown: async () => ({ md: GARBAGE_HTML_MD, sourceKind: "html" as const }),
      } as never;

      await withEnvPatch({ TAGS_MAX_PER_STORY: 0, SUMMARY_LANG: "en" }, async () => {
        await processSingleStory(services, id, store, makeMeta(rec));
      });

      // No post LLM call — only the single comments call went through.
      expect(rec.chatCalls.length).toBe(1);

      // Degraded stub written to the post summary file.
      const post = await store.getJson<{ summary: string; degraded?: string; inputHash?: string }>(
        pathFor.postSummary(id)
      );
      expect(post?.summary).toBe("");
      expect(post?.degraded).toBe("no-article");
      expect(post?.inputHash).toBeTruthy();

      // Extract verdict persisted with provenance.
      const extract = rec.extracts.at(-1);
      expect(extract?.status).toBe("no-article");
      expect(extract?.sourceKind).toBe("html");

      // Stale published post summary retired via an empty upsert (both aggregators drop it).
      const postUpsert = rec.summaries.find((r) => r.kind === "post");
      expect(postUpsert?.summary).toBe("");

      // Comments summary still produced and written.
      const commentsUpsert = rec.summaries.find((r) => r.kind === "comments");
      expect(commentsUpsert?.summary).toContain("-");
      const commentsFile = await store.getJson<{ summary: string }>(pathFor.commentsSummary(id));
      expect(commentsFile?.summary).toContain("-");
    });
  });

  test("steady-state: a second identical run skips the post LLM (policy-versioned inputHash)", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { processSingleStory } = await import("../pipeline/summarize");
      const { createFsStore } = await import("../utils/fs-store");

      const store = createFsStore();
      const id = 111;
      await store.putJson(pathFor.rawItem(id), makeStory({ id, url: "https://example.com/x", commentIds: [1] }));
      await store.putJson(pathFor.rawComments(id), [makeComment({ id: 1, parent: id, textPlain: "a comment here" })]);

      const rec = makeRecorder();
      const orMock = {
        chat: async (messages: ChatMessage[]) => {
          rec.chatCalls.push(messages);
          return "- one\n- two";
        },
        chatStructured: async () => "{}",
      } as never;
      const services = {
        http: {} as never,
        openrouter: orMock,
        guardTagsClient: orMock,
        fetchArticleMarkdown: async () => ({ md: GARBAGE_HTML_MD, sourceKind: "html" as const }),
      } as never;
      const meta = makeMeta(rec);

      await withEnvPatch({ TAGS_MAX_PER_STORY: 0, SUMMARY_LANG: "en" }, async () => {
        await processSingleStory(services, id, store, meta);
        await processSingleStory(services, id, store, meta);
      });

      // Run 1: one comments call. Run 2: post skipped via inputHash, comments skipped via
      // its own inputHash -> no additional calls.
      expect(rec.chatCalls.length).toBe(1);
    });
  });

  test("a stale (pre-policy-bump) inputHash forces the post to be re-evaluated", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { processSingleStory } = await import("../pipeline/summarize");
      const { createFsStore } = await import("../utils/fs-store");

      const store = createFsStore();
      const id = 222;
      await store.putJson(pathFor.rawItem(id), makeStory({ id, url: "https://example.com/y", commentIds: [1] }));
      await store.putJson(pathFor.rawComments(id), [makeComment({ id: 1, parent: id, textPlain: "a comment here" })]);
      // A previously-good summary stored under a hash that predates the policy version.
      await store.putJson(pathFor.postSummary(id), {
        id,
        lang: "en",
        summary: "An old, once-good article summary that must be re-evaluated.",
        inputHash: "legacy-hash-without-policy-version",
        model: "old-model",
      });

      const rec = makeRecorder();
      const orMock = {
        chat: async (messages: ChatMessage[]) => {
          rec.chatCalls.push(messages);
          return "- one\n- two";
        },
        chatStructured: async () => "{}",
      } as never;
      const services = {
        http: {} as never,
        openrouter: orMock,
        guardTagsClient: orMock,
        fetchArticleMarkdown: async () => ({ md: GARBAGE_HTML_MD, sourceKind: "html" as const }),
      } as never;

      await withEnvPatch({ TAGS_MAX_PER_STORY: 0, SUMMARY_LANG: "en" }, async () => {
        await processSingleStory(services, id, store, makeMeta(rec));
      });

      // Not skipped (hash mismatch) and, since the fresh extract is garbage, the old
      // summary is replaced by the degraded stub — no post LLM call.
      expect(rec.chatCalls.length).toBe(1);
      const post = await store.getJson<{ summary: string; degraded?: string }>(pathFor.postSummary(id));
      expect(post?.summary).toBe("");
      expect(post?.degraded).toBe("no-article");
    });
  });

  test("legacy cache (no sourceKind) is re-fetched so Readability re-extracts", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { getOrFetchArticleMarkdown } = await import("../pipeline/summarize");
      const { createFsStore } = await import("../utils/fs-store");

      const store = createFsStore();
      const id = 333;
      // Old whole-page markdown already in the store (pre-Readability).
      await store.putText(pathFor.articleMd(id), "# Old\n\n[Home](/) [About](/about) old whole-page dump");

      const rec = makeRecorder();
      // Legacy extract record: status ok, but NO sourceKind (column added later).
      rec.extractById.set(id, { storyId: id, status: "ok" });

      let fetchCalls = 0;
      const fresh = `# Fresh article\n\n${"This is the real Readability-extracted article body with plenty of substantial prose. ".repeat(10)}`;
      const services = {
        http: {} as never,
        openrouter: {} as never,
        guardTagsClient: {} as never,
        fetchArticleMarkdown: async () => {
          fetchCalls += 1;
          return { md: fresh, sourceKind: "html" as const };
        },
      } as never;

      const result = await getOrFetchArticleMarkdown(services, makeStory({ id, url: "https://example.com/z" }), store, makeMeta(rec));

      expect(fetchCalls).toBe(1); // HTTP fetch actually happened despite the cache hit
      expect(result.md).toContain("Fresh article");
      expect(result.extractStatus).toBe("ok");
      // Extract record upgraded with sourceKind.
      expect(rec.extractById.get(id)?.sourceKind).toBe("html");
    });
  });
});
