import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { PATHS } from "@config/paths";

import type { MetaStore } from "@utils/meta-store";

export const META_DB_PATH = `${PATHS.dataDir}/hn.sqlite`;
export type LocalMetaStore = MetaStore & { close: () => Promise<void> | void };

/** Opens local SQLite meta store (Node/tsx). Returns undefined when `node:sqlite` is unavailable (e.g. Bun test). */
export async function openLocalMetaStore(): Promise<LocalMetaStore | undefined> {
  try {
    await mkdir(dirname(META_DB_PATH), { recursive: true });
    const { createSqliteStore } = await import("@utils/sqlite-store");
    const meta = createSqliteStore(META_DB_PATH);
    await meta.migrate();
    return meta;
  } catch {
    return undefined;
  }
}
