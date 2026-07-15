import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

type SqliteScenario = "legacy-migrate" | "migrate" | "pending" | "persist" | "preserve";

type SqliteScenarioResult = {
  columns: string[];
  row?: {
    comments_input_hash: string | null;
    comments_policy_version: string | null;
    comments_status: string;
    updated_at: string;
  };
  pendingIds?: number[];
  versions: number[];
};

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (path) => await rm(path, { force: true, recursive: true })));
});

async function tempDbPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hn-comments-policy-"));
  tempRoots.push(root);
  return join(root, "meta.sqlite");
}

const execFileAsync = promisify(execFile);

async function runNode(path: string, scenario: SqliteScenario): Promise<SqliteScenarioResult> {
  const storeUrl = pathToFileURL(join(process.cwd(), "utils/sqlite-store.ts")).href;
  const script = `
    import { DatabaseSync } from "node:sqlite";
    import { createSqliteStore } from ${JSON.stringify(storeUrl)};
    const [path, scenario] = process.argv.slice(1);
    if (scenario === "legacy-migrate") {
      const legacy = new DatabaseSync(path);
      legacy.exec(
        "CREATE TABLE processing_state (story_id INTEGER PRIMARY KEY, post_status TEXT, comments_status TEXT, tags_status TEXT, updated_at TEXT, error TEXT);" +
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);" +
        "INSERT INTO schema_migrations (version, applied_at) VALUES (1, datetime('now')), (2, datetime('now'));"
      );
      legacy.close();
    }
    const store = createSqliteStore(path);
    await store.migrate();
    await store.migrate();
    if (scenario === "persist" || scenario === "preserve") {
      await store.upsertProcessingState(42, {
        postStatus: "ok",
        commentsStatus: "ok",
        commentsPolicyVersion: "2",
        commentsInputHash: "hash-v2",
        tagsStatus: "ok",
        updatedAt: "2026-07-15T00:00:00.000Z",
      });
    }
    if (scenario === "preserve") {
      await store.upsertProcessingState(42, {
        postStatus: "error",
        commentsStatus: "missing",
        tagsStatus: "error",
        updatedAt: "2026-07-15T01:00:00.000Z",
        error: "legacy caller failure",
      });
    }
    let pendingIds;
    if (scenario === "pending") {
      const story = (id, fetchedISO) => ({
        id,
        title: "Story " + id,
        url: "https://example.com/" + id,
        by: "author",
        timeISO: "2026-07-15T00:00:00.000Z",
        commentIds: [],
      });
      const currentFetch = "2026-07-15T02:00:00.000Z";
      await store.upsertStory(story(1), 0, currentFetch);
      await store.upsertStory(story(2), 1, currentFetch);
      await store.upsertStory(story(3), 2, currentFetch);
      await store.upsertStory(story(4), 3, currentFetch);
      await store.upsertStory(story(5), 4, "2026-07-14T02:00:00.000Z");
      const state = (commentsPolicyVersion, updatedAt) => ({
        postStatus: "ok",
        commentsStatus: "ok",
        commentsPolicyVersion,
        commentsInputHash: "hash-" + commentsPolicyVersion,
        tagsStatus: "ok",
        updatedAt,
      });
      await store.upsertProcessingState(2, state("1", "2026-07-15T00:00:00.000Z"));
      await store.upsertProcessingState(3, state("2", "2026-07-15T00:00:00.000Z"));
      await store.upsertProcessingState(4, state("1", "2026-07-15T01:30:00.000Z"));
      await store.upsertProcessingState(5, state("1", "2026-07-15T00:00:00.000Z"));
      pendingIds = await store.listPendingStoryIds(20, "2026-07-15T01:00:00.000Z", currentFetch, "2");
    }
    store.close();
    const db = new DatabaseSync(path);
    const columns = db.prepare("PRAGMA table_info(processing_state)").all().map((row) => row.name);
    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version);
    const row = scenario === "migrate" ? undefined : db.prepare(
      "SELECT comments_status, comments_policy_version, comments_input_hash, updated_at FROM processing_state WHERE story_id = 42"
    ).get();
    db.close();
    process.stdout.write(JSON.stringify({ columns, versions, ...(row === undefined ? {} : { row }), ...(pendingIds === undefined ? {} : { pendingIds }) }));
  `;
  const { stdout } = await execFileAsync(
    "node",
    ["--import", "tsx", "--input-type=module", "--eval", script, path, scenario],
    { cwd: process.cwd() }
  );
  return JSON.parse(stdout) as SqliteScenarioResult;
}

describe("comments policy SQLite state", () => {
  test("split migrations contain exactly one additive processing_state column each", async () => {
    const policyMigration = await readFile("worker/d1/migrations/003_comments_policy_version.sql", "utf8");
    const hashMigration = await readFile("worker/d1/migrations/004_comments_input_hash.sql", "utf8");
    expect(policyMigration.match(/ALTER TABLE/gu)?.length).toBe(1);
    expect(hashMigration.match(/ALTER TABLE/gu)?.length).toBe(1);
    expect(policyMigration).toContain("ADD COLUMN comments_policy_version TEXT");
    expect(policyMigration).not.toContain("comments_input_hash");
    expect(hashMigration).toContain("ADD COLUMN comments_input_hash TEXT");
    expect(hashMigration).not.toContain("comments_policy_version");
  });

  test("fresh schema migrates twice idempotently with both policy columns", async () => {
    const path = await tempDbPath();
    const result = await runNode(path, "migrate");
    expect(result.columns).toContain("comments_policy_version");
    expect(result.columns).toContain("comments_input_hash");
    expect(result.versions).toEqual([1, 2, 3, 4]);
  });

  test("applies both split migrations to a legacy processing_state table", async () => {
    const path = await tempDbPath();
    const result = await runNode(path, "legacy-migrate");
    expect(result.columns).toContain("comments_policy_version");
    expect(result.columns).toContain("comments_input_hash");
    expect(result.versions).toEqual([1, 2, 3, 4]);
  });

  test("persists successful comments policy and input hash", async () => {
    const path = await tempDbPath();
    const result = await runNode(path, "persist");
    expect(result.row).toEqual({
      comments_status: "ok",
      comments_policy_version: "2",
      comments_input_hash: "hash-v2",
      updated_at: "2026-07-15T00:00:00.000Z",
    });
  });

  test("selects current-fetch policy mismatches only after cooldown", async () => {
    const path = await tempDbPath();
    const result = await runNode(path, "pending");
    expect(result.pendingIds).toEqual([1, 2]);
  });

  test("legacy updates preserve an already applied comments policy and hash", async () => {
    const path = await tempDbPath();
    const result = await runNode(path, "preserve");
    expect(result.row).toEqual({
      comments_status: "missing",
      comments_policy_version: "2",
      comments_input_hash: "hash-v2",
      updated_at: "2026-07-15T01:00:00.000Z",
    });
  });
});
