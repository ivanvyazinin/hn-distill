import { describe, expect, test } from "bun:test";

import { Miniflare } from "miniflare";

import {
  getCommentsPolicyState,
  getCommentsPolicyStates,
  listPendingStoryIds,
  upsertProcessingState,
  upsertStory,
} from "../worker/src/d1.ts";

import type { NormalizedStory } from "../config/schemas.ts";

const MINIFLARE_SCRIPT = "export default { fetch() { return new Response('ok'); } };";
const CURRENT_FETCH_ISO = "2026-07-15T13:00:00.000Z";
const ARCHIVE_FETCH_ISO = "2026-07-14T13:00:00.000Z";
const OLD_STATE_ISO = "2026-07-15T10:00:00.000Z";
const CUTOFF_ISO = "2026-07-15T11:00:00.000Z";
const FRESH_STATE_ISO = "2026-07-15T12:00:00.000Z";

async function initPolicyDb(db: Awaited<ReturnType<Miniflare["getD1Database"]>>): Promise<void> {
  await db
    .prepare(
      "CREATE TABLE stories (id INTEGER PRIMARY KEY, title TEXT, url TEXT, by TEXT, timeISO TEXT, score INTEGER, descendants INTEGER, rank INTEGER, updated_at TEXT)"
    )
    .run();
  await db
    .prepare(
      "CREATE TABLE processing_state (story_id INTEGER PRIMARY KEY, post_status TEXT, comments_status TEXT, tags_status TEXT, updated_at TEXT, error TEXT, comments_policy_version TEXT, comments_input_hash TEXT)"
    )
    .run();
}

function story(id: number): NormalizedStory {
  return {
    id,
    title: `Story ${id}`,
    url: `https://example.test/${id}`,
    by: "tester",
    timeISO: CURRENT_FETCH_ISO,
    commentIds: [],
    score: 100,
    descendants: 10,
  };
}

async function insertState(
  db: Awaited<ReturnType<Miniflare["getD1Database"]>>,
  storyId: number,
  options: {
    commentsStatus?: "error" | "missing" | "ok";
    policyVersion?: string;
    updatedAt?: string;
  } = {}
): Promise<void> {
  await upsertProcessingState(db, storyId, {
    postStatus: "ok",
    commentsStatus: options.commentsStatus ?? "ok",
    tagsStatus: "ok",
    updatedAt: options.updatedAt ?? OLD_STATE_ISO,
    ...(options.policyVersion === undefined ? {} : { commentsPolicyVersion: options.policyVersion }),
    ...(options.policyVersion === undefined ? {} : { commentsInputHash: `hash-${storyId}` }),
  });
}

describe("D1 comments policy helpers", () => {
  test("pending selector applies policy mismatch and status checks only to current-fetch rows after cooldown", async () => {
    const mf = new Miniflare({ modules: true, script: MINIFLARE_SCRIPT, d1Databases: ["DB"] });
    try {
      const db = await mf.getD1Database("DB");
      await initPolicyDb(db);
      for (let id = 1; id <= 8; id++) {
        await upsertStory(db, story(id), id - 1, id === 6 ? ARCHIVE_FETCH_ISO : CURRENT_FETCH_ISO);
      }

      await insertState(db, 1, { policyVersion: "2" });
      await insertState(db, 2, { policyVersion: "1" });
      await insertState(db, 3);
      await insertState(db, 4, { commentsStatus: "error", policyVersion: "2" });
      await insertState(db, 5, { policyVersion: "1", updatedAt: FRESH_STATE_ISO });
      await insertState(db, 6, { policyVersion: "1" });
      // Story 7 has no processing row and is immediately eligible.
      await insertState(db, 8, { commentsStatus: "missing", policyVersion: "2", updatedAt: FRESH_STATE_ISO });

      expect(await listPendingStoryIds(db, 20, CUTOFF_ISO, CURRENT_FETCH_ISO, "2")).toEqual([2, 3, 4, 7]);
      expect(await listPendingStoryIds(db, 2, CUTOFF_ISO, CURRENT_FETCH_ISO, "2")).toEqual([2, 3]);
    } finally {
      await mf.dispose();
    }
  });

  test("policy state reads version/hash/timestamp and legacy upserts preserve both policy fields", async () => {
    const mf = new Miniflare({ modules: true, script: MINIFLARE_SCRIPT, d1Databases: ["DB"] });
    try {
      const db = await mf.getD1Database("DB");
      await initPolicyDb(db);
      await upsertStory(db, story(10), 0, CURRENT_FETCH_ISO);
      await upsertStory(db, story(11), 1, CURRENT_FETCH_ISO);

      await upsertProcessingState(db, 10, {
        postStatus: "ok",
        commentsStatus: "ok",
        tagsStatus: "ok",
        updatedAt: OLD_STATE_ISO,
        commentsPolicyVersion: "2",
        commentsInputHash: "hash-v2",
      });
      expect(await getCommentsPolicyState(db, 10)).toEqual({
        commentsPolicyVersion: "2",
        commentsInputHash: "hash-v2",
        updatedAt: OLD_STATE_ISO,
      });
      expect(await getCommentsPolicyState(db, 999)).toBeUndefined();
      expect((await getCommentsPolicyStates(db, [])).size).toBe(0);

      const firstBatch = await getCommentsPolicyStates(db, [10, 10, 11, 999]);
      expect(firstBatch.size).toBe(1);
      expect(firstBatch.get(10)?.commentsInputHash).toBe("hash-v2");

      await upsertProcessingState(db, 10, {
        postStatus: "ok",
        commentsStatus: "error",
        tagsStatus: "ok",
        updatedAt: FRESH_STATE_ISO,
        error: "temporary generation failure",
      });
      expect(await getCommentsPolicyState(db, 10)).toEqual({
        commentsPolicyVersion: "2",
        commentsInputHash: "hash-v2",
        updatedAt: FRESH_STATE_ISO,
      });

      await upsertProcessingState(db, 10, {
        postStatus: "ok",
        commentsStatus: "ok",
        tagsStatus: "ok",
        updatedAt: CURRENT_FETCH_ISO,
        commentsPolicyVersion: "3",
        commentsInputHash: "hash-v3",
      });
      const finalState = await getCommentsPolicyStates(db, [10]);
      expect(finalState.get(10)).toEqual({
        commentsPolicyVersion: "3",
        commentsInputHash: "hash-v3",
        updatedAt: CURRENT_FETCH_ISO,
      });
    } finally {
      await mf.dispose();
    }
  });
});
