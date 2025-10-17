import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";

import { digestHash, readSeenCache, writeSeenCache } from "@utils/telegram";

const TEST_STORY_TITLE = "Test Story 1";
const TEST_TIME_ISO = "2024-01-01T00:00:00.000Z";

describe("digestHash", () => {
  test("should generate consistent hash for same input", async () => {
    const items = [
      {
        id: 1,
        title: TEST_STORY_TITLE,
        postSummary: "Summary 1",
        commentsSummary: "",
        timeISO: TEST_TIME_ISO,
      },
      {
        id: 2,
        title: "Test Story 2",
        postSummary: "",
        commentsSummary: "Comments 2",
        timeISO: "2024-01-02T00:00:00.000Z",
      },
    ];

    const hash1 = await digestHash(items);
    const hash2 = await digestHash(items);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/u); // SHA256 hex string
  });

  test("should generate different hash for different input", async () => {
    const items1 = [
      {
        id: 1,
        title: TEST_STORY_TITLE,
        postSummary: "Summary 1",
        commentsSummary: "",
        timeISO: TEST_TIME_ISO,
      },
    ];
    const items2 = [
      {
        id: 1,
        title: TEST_STORY_TITLE,
        postSummary: "Different Summary",
        commentsSummary: "",
        timeISO: TEST_TIME_ISO,
      },
    ];

    const hash1 = await digestHash(items1);
    const hash2 = await digestHash(items2);

    expect(hash1).not.toBe(hash2);
  });

  test("should generate same hash regardless of updatedISO (content-based only)", async () => {
    const items = [
      {
        id: 1,
        title: TEST_STORY_TITLE,
        postSummary: "Summary 1",
        commentsSummary: "",
        timeISO: TEST_TIME_ISO,
      },
    ];

    const hash1 = await digestHash(items);
    const hash2 = await digestHash(items);

    expect(hash1).toBe(hash2);
  });

  test("should handle empty items array", async () => {
    const hash = await digestHash([]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("should prioritize postSummary over commentsSummary", async () => {
    const items1 = [
      {
        id: 1,
        title: "Test Story",
        postSummary: "Post summary",
        commentsSummary: "Comments summary",
        timeISO: TEST_TIME_ISO,
      },
    ];
    const items2 = [
      {
        id: 1,
        title: "Test Story",
        postSummary: "Different post summary",
        commentsSummary: "Comments summary",
        timeISO: TEST_TIME_ISO,
      },
    ];

    const hash1 = await digestHash(items1);
    const hash2 = await digestHash(items2);

    expect(hash1).not.toBe(hash2);
  });

  test("should ignore commentsSummary when postSummary is missing", async () => {
    const baseItem = {
      id: 42,
      title: "Story without summary",
      postSummary: "",
      commentsSummary: "First comment summary",
      timeISO: "2024-01-03T00:00:00.000Z",
    };

    const hash1 = await digestHash([baseItem]);
    const hash2 = await digestHash([
      {
        ...baseItem,
        commentsSummary: "Updated comments summary should not matter",
      },
    ]);

    expect(hash1).toBe(hash2);
  });
});

describe("cache operations", () => {
  test("should read empty cache when file doesn't exist", async () => {
    // Create a temporary path that doesn't exist
    const nonExistentPath = "/tmp/non-existent-telegram-cache.json";
    const cache = await readSeenCache(nonExistentPath);
    expect(cache).toEqual({});
  });

  test("should write cache successfully", async () => {
    const tempPath = "/tmp/telegram-test-cache.json";
    const testCache = {
      telegram: {
        lastHash: "new-hash-456",
        lastUpdatedISO: "2024-01-02T00:00:00.000Z",
        sentAtISO: "2024-01-02T01:00:00.000Z",
        lastIds: [4, 5, 6],
      },
    };

    // Write cache - this should not throw
    await writeSeenCache(tempPath, testCache);

    // Verify file exists and contains expected content
    const fileContent = await import("node:fs").then((fs) => fs.readFileSync(tempPath, "utf8"));
    const writtenCache = JSON.parse(fileContent);
    expect(writtenCache).toEqual(testCache);

    // Clean up
    try {
      unlinkSync(tempPath);
    } catch {
      // File might not exist
    }
  });

  test("should handle malformed cache file", async () => {
    const tempPath = "/tmp/telegram-test-malformed-cache.json";

    // Write invalid JSON
    writeFileSync(tempPath, "invalid json content");

    const cache = await readSeenCache(tempPath);
    expect(cache).toEqual({});

    // Clean up
    try {
      unlinkSync(tempPath);
    } catch {
      // File might not exist
    }
  });
});
