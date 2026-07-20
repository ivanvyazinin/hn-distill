import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

describe("log silent level", () => {
  test("LOG_LEVEL=silent suppresses error/warn/info/debug", () => {
    const script = `
      import { log } from "./utils/log.ts";
      log.error("t", "err", { body: "provider-secret" });
      log.warn("t", "warn");
      log.info("t", "info");
      log.debug("t", "debug");
    `;
    const result = spawnSync("bun", ["-e", script], {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, LOG_LEVEL: "silent" },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
