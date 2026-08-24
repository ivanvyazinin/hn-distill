import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createMetaStoreOverDriver } from "@utils/meta-store-over-sql";
import { createNodeSqliteDriver } from "@utils/sql-driver";

import type { MetaStore } from "@utils/meta-store";

async function migrateSqlite(db: DatabaseSync): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolve(here, "../worker/d1/schema.sql");
  db.exec(await readFile(schemaPath, "utf8"));

  const migrationDir = resolve(here, "../worker/d1/migrations");
  const migrationFiles = (await readdir(migrationDir))
    .map((name) => ({ name, version: /^(?<version>\d+)_.*\.sql$/u.exec(name)?.groups?.["version"] }))
    .filter((entry): entry is { name: string; version: string } => entry.version !== undefined)
    .sort((a, b) => Number(a.version) - Number(b.version));
  for (const migration of migrationFiles) {
    const version = Number(migration.version);
    const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version);
    if (applied) {
      continue;
    }
    try {
      db.exec(await readFile(resolve(migrationDir, migration.name), "utf8"));
    } catch (error) {
      // A fresh DB gets the latest columns straight from schema.sql, so an
      // additive `ALTER TABLE ... ADD COLUMN` migration is a no-op here and
      // SQLite reports a duplicate column. That is the intended end state —
      // record the migration as applied and continue. Re-throw anything else.
      if (!/duplicate column name/iu.test(String(error))) {
        throw error;
      }
    }
    db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))").run(
      version
    );
  }
}

/** Local MetaStore over node:sqlite. All store methods come from the single shared implementation. */
export function createSqliteStore(dbPath: string): MetaStore & { close: () => void } {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  const driver = createNodeSqliteDriver(db);
  return {
    ...createMetaStoreOverDriver(driver),
    migrate: async (): Promise<void> => migrateSqlite(db),
    close: (): void => {
      db.close();
    },
  };
}
