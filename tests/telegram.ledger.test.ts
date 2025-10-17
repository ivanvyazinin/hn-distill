import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";

import { readTelegramLedger, writeTelegramLedger } from "@utils/telegram";

const TEST_TIME_ISO = "2024-01-01T00:00:00.000Z";

describe("telegram ledger operations", () => {
  test("should read empty ledger when file doesn't exist", async () => {
    const nonExistentPath = "/tmp/non-existent-telegram-ledger.json";
    const ledger = await readTelegramLedger(nonExistentPath);
    expect(ledger).toEqual({ sentIds: [] });
  });

  test("should write and read ledger successfully", async () => {
    const tempPath = "/tmp/telegram-test-ledger.json";
    const testLedger = {
      sentIds: [123, 456, 789],
      lastUpdatedISO: TEST_TIME_ISO,
    };

    await writeTelegramLedger(tempPath, testLedger);

    const readLedger = await readTelegramLedger(tempPath);
    expect(readLedger).toEqual(testLedger);

    try {
      unlinkSync(tempPath);
    } catch {
      // File might not exist
    }
  });

  test("should handle malformed ledger file", async () => {
    const tempPath = "/tmp/telegram-test-malformed-ledger.json";

    writeFileSync(tempPath, "invalid json content");

    const ledger = await readTelegramLedger(tempPath);
    expect(ledger).toEqual({ sentIds: [] });

    try {
      unlinkSync(tempPath);
    } catch {
      // File might not exist
    }
  });

  test("should handle ledger with missing lastUpdatedISO", async () => {
    const tempPath = "/tmp/telegram-test-partial-ledger.json";
    const testLedger = {
      sentIds: [100, 200],
    };

    await writeTelegramLedger(tempPath, testLedger);

    const readLedger = await readTelegramLedger(tempPath);
    expect(readLedger.sentIds).toEqual([100, 200]);
    expect(readLedger.lastUpdatedISO).toBeUndefined();

    try {
      unlinkSync(tempPath);
    } catch {
      // File might not exist
    }
  });

  test("should handle empty sentIds array", async () => {
    const tempPath = "/tmp/telegram-test-empty-ledger.json";
    const testLedger = {
      sentIds: [],
      lastUpdatedISO: TEST_TIME_ISO,
    };

    await writeTelegramLedger(tempPath, testLedger);

    const readLedger = await readTelegramLedger(tempPath);
    expect(readLedger.sentIds).toEqual([]);
    expect(readLedger.lastUpdatedISO).toBe(TEST_TIME_ISO);

    try {
      unlinkSync(tempPath);
    } catch {
      // File might not exist
    }
  });

  test("should preserve large arrays of IDs", async () => {
    const tempPath = "/tmp/telegram-test-large-ledger.json";
    const largeIdArray = Array.from({ length: 1000 }, (_, i) => i + 1);
    const testLedger = {
      sentIds: largeIdArray,
      lastUpdatedISO: TEST_TIME_ISO,
    };

    await writeTelegramLedger(tempPath, testLedger);

    const readLedger = await readTelegramLedger(tempPath);
    expect(readLedger.sentIds).toEqual(largeIdArray);
    expect(readLedger.sentIds.length).toBe(1000);

    try {
      unlinkSync(tempPath);
    } catch {
      // File might not exist
    }
  });
});
