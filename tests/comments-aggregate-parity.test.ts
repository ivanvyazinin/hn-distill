import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { pathFor } from "../config/paths";
import { buildAggregatedItem, fallbackFromRaw, readAggregates } from "../pipeline/aggregate";
import { renderTooFewCommentsFallback } from "../utils/comments-render";
import { createFsStore } from "../utils/fs-store";
import { getAggregatedItemsD1 } from "../utils/meta-aggregated-load-d1";
import { makeEnCommentsInsights } from "./helpers/comments-insights.ts";

import { comment, story, withTempDir } from "./helpers";

import type { NormalizedComment, NormalizedStory } from "../config/schemas";
import type {
  D1DatabaseLike,
  D1PreparedStatement,
  D1QueryResult,
} from "../worker/src/bindings";
import type { StoryRow } from "../utils/meta-aggregated-batch";

type SummaryRow = { story_id: number; kind: string; summary: string };

const execFileAsync = promisify(execFile);

function commentsById(
  items: Array<{ id: number; commentsSummary?: string | undefined }>
): Map<number, string | undefined> {
  return new Map(items.map((item) => [item.id, item.commentsSummary]));
}

function fakeD1(stories: StoryRow[], summaries: SummaryRow[]): D1DatabaseLike {
  return {
    prepare(query: string): D1PreparedStatement {
      let rows: unknown[] = [];
      if (query.includes("FROM stories")) {
        rows = stories;
      } else if (query.includes("FROM summaries")) {
        rows = summaries;
      } else if (query.includes("FROM tags")) {
        rows = [];
      }

      const statement: D1PreparedStatement = {
        bind: () => statement,
        all: async <T>(): Promise<D1QueryResult<T>> => ({ results: rows as T[] }),
        first: async <T>(): Promise<T | null> => (rows[0] as T | undefined) ?? null,
        run: async () => ({ success: true }),
      };
      return statement;
    },
    exec: async () => {},
  };
}

async function loadSqliteComments(
  stories: StoryRow[],
  summaries: SummaryRow[]
): Promise<Map<number, string | undefined>> {
  const loaderUrl = pathToFileURL(join(process.cwd(), "utils/meta-aggregated-load-sqlite.ts")).href;
  const envUrl = pathToFileURL(join(process.cwd(), "config/env.ts")).href;
  const script = `
    import { DatabaseSync } from "node:sqlite";
    import { getAggregatedItemsSqlite } from ${JSON.stringify(loaderUrl)};
    import { env } from ${JSON.stringify(envUrl)};
    const stories = JSON.parse(process.argv[1]);
    const summaries = JSON.parse(process.argv[2]);
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE stories (id INTEGER PRIMARY KEY, title TEXT, url TEXT, by TEXT, timeISO TEXT, score INTEGER, descendants INTEGER);" +
      "CREATE TABLE summaries (story_id INTEGER, kind TEXT, lang TEXT, summary TEXT);" +
      "CREATE TABLE tags (story_id INTEGER, tag TEXT);"
    );
    const insertStory = db.prepare(
      "INSERT INTO stories (id, title, url, by, timeISO, score, descendants) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (const row of stories) {
      insertStory.run(row.id, row.title, row.url, row.by, row.timeISO, row.score, row.descendants);
    }
    const insertSummary = db.prepare(
      "INSERT INTO summaries (story_id, kind, lang, summary) VALUES (?, ?, ?, ?)"
    );
    for (const row of summaries) {
      insertSummary.run(row.story_id, row.kind, env.SUMMARY_LANG, row.summary);
    }
    const items = getAggregatedItemsSqlite(db, stories.map((row) => row.id));
    db.close();
    process.stdout.write(JSON.stringify(items.map((item) => [item.id, item.commentsSummary])));
  `;
  const { stdout } = await execFileAsync(
    "node",
    ["--import", "tsx", "--input-type=module", "--eval", script, JSON.stringify(stories), JSON.stringify(summaries)],
    { cwd: process.cwd() }
  );
  return new Map(JSON.parse(stdout) as Array<[number, string | undefined]>);
}

describe("comments summary aggregation parity", () => {
  test("only a persisted empty v2 summary suppresses raw fallback", () => {
    const normalizedStory = story({ id: 701, commentIds: [710], descendants: 1 });
    const rawComments = [comment({ id: 710, parent: 701, textPlain: "Raw fallback must not leak." })];
    const emptyV2 = {
      id: 701,
      lang: "en",
      summary: "",
      formatVersion: 2,
      degraded: "too-few-comments",
      sampleComments: [],
    };

    expect(buildAggregatedItem(normalizedStory, rawComments, void 0, emptyV2, void 0).commentsSummary).toBe("");
    expect(
      buildAggregatedItem(
        normalizedStory,
        rawComments,
        void 0,
        { id: 701, lang: "en", summary: "" },
        void 0
      ).commentsSummary
    ).toBe(fallbackFromRaw(normalizedStory, rawComments).commentsSummary);
    expect(buildAggregatedItem(normalizedStory, rawComments, void 0, void 0, void 0).commentsSummary).toBe(
      fallbackFromRaw(normalizedStory, rawComments).commentsSummary
    );
  });

  test("filesystem, D1, and SQLite preserve empty and nonempty degraded summaries", async () => {
    const fixtures: Array<{ story: NormalizedStory; comments: NormalizedComment[] }> = [
      { story: story({ id: 701, commentIds: [], descendants: 0, score: 100 }), comments: [] },
      {
        story: story({ id: 702, commentIds: [720], descendants: 1, score: 100 }),
        comments: [
          comment({
            id: 720,
            by: "alice",
            parent: 702,
            textPlain:
              "This single substantive comment is intentionally longer than eighty characters and describes a concrete operational lesson.",
          }),
        ],
      },
      {
        story: story({ id: 703, commentIds: [730, 731], descendants: 2, score: 100 }),
        comments: [
          comment({
            id: 730,
            by: "bob",
            parent: 703,
            textPlain:
              "The first substantive response explains why bounded retries matter and gives enough detail to cross the content threshold.",
          }),
          comment({
            id: 731,
            by: "carol",
            parent: 703,
            textPlain:
              "The second substantive response recommends measuring queue latency before changing concurrency limits in production.",
          }),
        ],
      },
    ];
    const persistedSummaries = fixtures.map(({ comments }) => renderTooFewCommentsFallback(comments, "en"));
    const fsItems = await withTempDir(async (base) => {
      const store = createFsStore(base);
      for (const [index, fixture] of fixtures.entries()) {
        await store.putJson(pathFor.rawItem(fixture.story.id), fixture.story);
        await store.putJson(pathFor.rawComments(fixture.story.id), fixture.comments);
        await store.putJson(pathFor.commentsSummary(fixture.story.id), {
          id: fixture.story.id,
          lang: "en",
          summary: persistedSummaries[index],
          formatVersion: 2,
          degraded: "too-few-comments",
          sampleComments: fixture.comments.map((item) => item.id),
        });
      }
      return await readAggregates(fixtures.map((fixture) => fixture.story.id), store);
    });
    const storyRows: StoryRow[] = fixtures.map(({ story: itemStory }) => ({
      id: itemStory.id,
      title: itemStory.title,
      url: itemStory.url,
      by: itemStory.by,
      timeISO: itemStory.timeISO,
      score: itemStory.score ?? null,
      descendants: itemStory.descendants ?? null,
    }));
    const summaryRows: SummaryRow[] = fixtures.map(({ story: itemStory }, index) => ({
      story_id: itemStory.id,
      kind: "comments",
      summary: persistedSummaries[index] ?? "",
    }));

    const expected = commentsById(fsItems);
    const d1Items = await getAggregatedItemsD1(fakeD1(storyRows, summaryRows), storyRows.map((row) => row.id));
    const sqliteComments = await loadSqliteComments(storyRows, summaryRows);

    expect(expected).toEqual(
      new Map([
        [701, ""],
        [702, renderTooFewCommentsFallback(fixtures[1]?.comments ?? [], "en")],
        [703, renderTooFewCommentsFallback(fixtures[2]?.comments ?? [], "en")],
      ])
    );
    expect(commentsById(d1Items)).toEqual(expected);
    expect(sqliteComments).toEqual(expected);
  });

  test("FS path attaches commentsInsights parts; D1/sqlite loaders omit them (D2 asymmetry)", async () => {
    const normalizedStory = story({ id: 801, commentIds: [810], descendants: 1, score: 120 });
    const rawComments = [
      comment({
        id: 810,
        parent: 801,
        textPlain:
          "A sufficiently detailed operational comment about measuring latency before flipping production traffic.",
      }),
    ];
    const structured = makeEnCommentsInsights();
    const commentsSummary = {
      id: 801,
      lang: "en" as const,
      summary: "unused string path",
      structured,
      formatVersion: 2 as const,
      sampleComments: [810],
    };

    const fsItem = buildAggregatedItem(normalizedStory, rawComments, void 0, commentsSummary, void 0);
    expect(fsItem.commentsInsights !== undefined).toBeTrue();
    expect(fsItem.commentsInsights?.lead.trim().length).toBeGreaterThan(0);
    expect(fsItem.commentsInsights?.visible).toContain("-");

    const storyRows: StoryRow[] = [
      {
        id: normalizedStory.id,
        title: normalizedStory.title,
        url: normalizedStory.url,
        by: normalizedStory.by,
        timeISO: normalizedStory.timeISO,
        score: normalizedStory.score ?? null,
        descendants: normalizedStory.descendants ?? null,
      },
    ];
    const summaryRows: SummaryRow[] = [
      {
        story_id: 801,
        kind: "comments",
        summary: commentsSummary.summary,
      },
    ];
    const d1Items = await getAggregatedItemsD1(fakeD1(storyRows, summaryRows), [801]);
    expect(d1Items[0]?.commentsInsights).toBeUndefined();

    const sqliteComments = await loadSqliteComments(storyRows, summaryRows);
    // sqlite loader only returns commentsSummary strings; no commentsInsights key.
    expect(sqliteComments.get(801)).toBe(commentsSummary.summary);
  });
});
