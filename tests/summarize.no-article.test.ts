import { describe, expect, test } from "bun:test";

import { env } from "../config/env";
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

const VALID_POST_SUMMARY =
  "The project replaces a fragile polling loop with a durable queue that can recover work after restarts. " +
  "The migration adds bounded retries, per-job tracing, and idempotent handlers so duplicate delivery remains safe. " +
  "Early production results show lower peak latency and no dropped jobs during the busiest traffic windows.";

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
        // Valid comments summary for the default RU heuristics profile (no retry triggered).
        return [
          "- Читатели считают игру увлекательной и делятся первыми впечатлениями от новых уровней и механик",
          "- Несколько участников сообщают об ошибках в подсчёте очков и просят авторов исправить баланс",
          "- Автор обещает выпустить обновление с исправлениями и опубликовать план развития проекта",
        ].join("\n");
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

      // Neither post nor comments calls the LLM: both comments are below the
      // substantive threshold, so comments-v2 persists an intentional degraded row.
      expect(rec.chatCalls.length).toBe(0);

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

      // Comments degraded result is still recorded identically in FS and meta.
      const commentsUpsert = rec.summaries.find((r) => r.kind === "comments");
      const commentsFile = await store.getJson<{ summary: string; degraded?: string; formatVersion?: number }>(
        pathFor.commentsSummary(id)
      );
      expect(commentsFile?.summary).toBe("");
      expect(commentsFile?.degraded).toBe("too-few-comments");
      expect(commentsFile?.formatVersion).toBe(2);
      expect(commentsUpsert?.summary).toBe(commentsFile?.summary);
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
          // Valid EN comments summary for the heuristics profile (no validation retry).
          return [
            "- Readers discuss the new release and share detailed first impressions of the updated levels",
            "- Several participants report scoring bugs and ask the developers to rebalance the difficulty",
            "- The author promises a follow-up patch with fixes and a public roadmap for the project",
          ].join("\n");
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

      // Both runs skip comments LLM generation; the second run reuses the v2 hash.
      expect(rec.chatCalls.length).toBe(0);
      const commentsFile = await store.getJson<{ degraded?: string; formatVersion?: number; summary?: string }>(
        pathFor.commentsSummary(id)
      );
      expect(commentsFile?.summary).toBe("");
      expect(commentsFile?.degraded).toBe("too-few-comments");
      expect(commentsFile?.formatVersion).toBe(2);
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
          // Valid EN comments summary for the heuristics profile (no validation retry).
          return [
            "- Readers discuss the new release and share detailed first impressions of the updated levels",
            "- Several participants report scoring bugs and ask the developers to rebalance the difficulty",
            "- The author promises a follow-up patch with fixes and a public roadmap for the project",
          ].join("\n");
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
      expect(rec.chatCalls.length).toBe(0);
      const post = await store.getJson<{ summary: string; degraded?: string }>(pathFor.postSummary(id));
      expect(post?.summary).toBe("");
      expect(post?.degraded).toBe("no-article");
    });
  });

  test("threshold change no-article -> ok replaces the stub and preserves extract fetchedAt", async () => {
    await withTempDir(async (base) => {
      const { PATHS, pathFor } = mockPaths(base);
      const { processSingleStory, summarizeWorkflow } = await import("../pipeline/summarize");
      const { createFsStore } = await import("../utils/fs-store");

      const store = createFsStore();
      const id = 223;
      const fetchedAt = "2026-01-02T03:04:05.000Z";
      await store.putJson(pathFor.rawItem(id), makeStory({ id, url: "https://example.com/policy-up", commentIds: [] }));
      await store.putJson(pathFor.rawComments(id), []);
      await store.putText(pathFor.articleMd(id), GARBAGE_HTML_MD);
      await store.putJson(PATHS.index, { updatedISO: new Date().toISOString(), storyIds: [id] });

      const rec = makeRecorder();
      rec.extractById.set(id, {
        storyId: id,
        status: "no-article",
        sourceKind: "html",
        fetchedAt,
      });
      const services = {
        http: {} as never,
        openrouter: {
          chat: async (messages: ChatMessage[]) => {
            rec.chatCalls.push(messages);
            return VALID_POST_SUMMARY;
          },
          chatStructured: async () => "{}",
        } as never,
        guardTagsClient: {} as never,
        fetchArticleMarkdown: async () => {
          throw new Error("cached extract must not be fetched again");
        },
      } as never;
      const meta = makeMeta(rec);

      await withEnvPatch(
        { TAGS_MAX_PER_STORY: 0, SUMMARY_LANG: "en", POST_GUARD_ENABLE: false },
        async () => {
          await processSingleStory(services, id, store, meta);
        }
      );
      const stub = await store.getJson<{ inputHash?: string; degraded?: string }>(pathFor.postSummary(id));
      expect(stub?.degraded).toBe("no-article");

      await withEnvPatch(
        {
          TAGS_MAX_PER_STORY: 0,
          SUMMARY_LANG: "en",
          POST_GUARD_ENABLE: false,
          OPENROUTER_API_KEY: "test-key",
          EXTRACT_MIN_PROSE_CHARS: 0,
          EXTRACT_MAX_LINK_DENSITY: 1,
          EXTRACT_MAX_DUP_RATIO: 1,
        },
        async () => {
          // Exercise workflow pre-selection too: computePostChanged must use the
          // same detector-policy fingerprint as processPostSummary.
          await summarizeWorkflow(services, env, store, meta);
        }
      );

      expect(rec.chatCalls.length).toBe(1);
      const post = await store.getJson<{ inputHash?: string; summary?: string; degraded?: string }>(
        pathFor.postSummary(id)
      );
      expect(post?.summary).toBe(VALID_POST_SUMMARY);
      expect(post?.degraded).toBeUndefined();
      expect(post?.inputHash).not.toBe(stub?.inputHash);
      expect([...rec.summaries].reverse().find((row) => row.kind === "post")?.summary).toBe(VALID_POST_SUMMARY);
      expect(rec.extractById.get(id)?.status).toBe("ok");
      expect(rec.extractById.get(id)?.fetchedAt).toBe(fetchedAt);
    });
  });

  test("threshold change ok -> no-article replaces the summary with an empty degraded upsert", async () => {
    await withTempDir(async (base) => {
      const { PATHS, pathFor } = mockPaths(base);
      const { processSingleStory, summarizeWorkflow } = await import("../pipeline/summarize");
      const { createFsStore } = await import("../utils/fs-store");

      const store = createFsStore();
      const id = 224;
      const fetchedAt = "2026-02-03T04:05:06.000Z";
      await store.putJson(pathFor.rawItem(id), makeStory({ id, url: "https://example.com/policy-down", commentIds: [] }));
      await store.putJson(pathFor.rawComments(id), []);
      await store.putText(pathFor.articleMd(id), GARBAGE_HTML_MD);
      await store.putJson(PATHS.index, { updatedISO: new Date().toISOString(), storyIds: [id] });

      const rec = makeRecorder();
      rec.extractById.set(id, { storyId: id, status: "ok", sourceKind: "html", fetchedAt });
      const services = {
        http: {} as never,
        openrouter: {
          chat: async (messages: ChatMessage[]) => {
            rec.chatCalls.push(messages);
            return VALID_POST_SUMMARY;
          },
          chatStructured: async () => "{}",
        } as never,
        guardTagsClient: {} as never,
        fetchArticleMarkdown: async () => {
          throw new Error("cached extract must not be fetched again");
        },
      } as never;
      const meta = makeMeta(rec);

      await withEnvPatch(
        {
          TAGS_MAX_PER_STORY: 0,
          SUMMARY_LANG: "en",
          POST_GUARD_ENABLE: false,
          EXTRACT_MIN_PROSE_CHARS: 0,
          EXTRACT_MAX_LINK_DENSITY: 1,
          EXTRACT_MAX_DUP_RATIO: 1,
        },
        async () => {
          await processSingleStory(services, id, store, meta);
        }
      );
      const original = await store.getJson<{ inputHash?: string; summary?: string }>(pathFor.postSummary(id));
      expect(original?.summary).toBe(VALID_POST_SUMMARY);

      await withEnvPatch(
        {
          TAGS_MAX_PER_STORY: 0,
          SUMMARY_LANG: "en",
          POST_GUARD_ENABLE: false,
          OPENROUTER_API_KEY: "test-key",
        },
        async () => {
          await summarizeWorkflow(services, env, store, meta);
        }
      );

      expect(rec.chatCalls.length).toBe(1);
      const post = await store.getJson<{ inputHash?: string; summary?: string; degraded?: string }>(
        pathFor.postSummary(id)
      );
      expect(post?.summary).toBe("");
      expect(post?.degraded).toBe("no-article");
      expect(post?.inputHash).not.toBe(original?.inputHash);
      expect([...rec.summaries].reverse().find((row) => row.kind === "post")?.summary).toBe("");
      expect(rec.extractById.get(id)?.status).toBe("no-article");
      expect(rec.extractById.get(id)?.fetchedAt).toBe(fetchedAt);
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
