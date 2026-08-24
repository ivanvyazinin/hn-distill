import type { D1DatabaseLike } from "@utils/meta-store";
import type { DatabaseSync, StatementSync } from "node:sqlite";


/** One parameterized SQL statement, backend-agnostic. */
export type SqlStatement = { sql: string; params?: readonly unknown[] };

/** A statement bound to backend SQL text; parameters are applied per execution. */
export type SqlPreparedStatement = {
  run: (...params: readonly unknown[]) => Promise<unknown>;
  get: (...params: readonly unknown[]) => Promise<unknown>;
  all: (...params: readonly unknown[]) => Promise<unknown[]>;
};

/**
 * Minimal seam between the single MetaStore implementation and its two SQL
 * backends: local `node:sqlite` (scripts/tests) and Cloudflare D1 (worker).
 * `get` resolves to `undefined` when no row matches (both backends normalized).
 */
export type SqlDriver = {
  exec: (sql: string) => Promise<void>;
  prepare: (sql: string) => SqlPreparedStatement;
  /** Atomic multi-statement execution. */
  batch: (statements: readonly SqlStatement[]) => Promise<unknown[]>;
};

/** Wraps an already-opened `node:sqlite` database. */
type SqliteParams = Parameters<StatementSync["run"]>;
export function createNodeSqliteDriver(db: DatabaseSync): SqlDriver {
  return {
    async exec(sql: string): Promise<void> {
      db.exec(sql);
    },
    prepare(sql: string): SqlPreparedStatement {
      const statement = db.prepare(sql);
      return {
        async run(...params: readonly unknown[]): Promise<unknown> {
          return statement.run(...(params as SqliteParams));
        },
        async get(...params: readonly unknown[]): Promise<unknown> {
          // StatementSync.get() returns undefined for no match already.
          return statement.get(...(params as SqliteParams));
        },
        async all(...params: readonly unknown[]): Promise<unknown[]> {
          return statement.all(...(params as SqliteParams)) as unknown[];
        },
      };
    },
    async batch(statements: readonly SqlStatement[]): Promise<unknown[]> {
      if (statements.length === 0) {
        return [];
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const results: unknown[] = [];
        for (const { sql, params } of statements) {
          results.push(db.prepare(sql).run(...((params ?? []) as SqliteParams)));
        }
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** Adapts the worker's D1 binding (see worker/src/bindings.ts) to the seam. */
export function createD1Driver(db: D1DatabaseLike): SqlDriver {
  return {
    async exec(sql: string): Promise<void> {
      await db.exec(sql);
    },
    prepare(sql: string): SqlPreparedStatement {
      // D1 statements are bound per call; binding mutates the prepared
      // statement, so re-preparing keeps repeated executions safe.
      return {
        async run(...params: readonly unknown[]): Promise<unknown> {
          await db
            .prepare(sql)
            .bind(...params)
            .run();
          return undefined;
        },
        async get(...params: readonly unknown[]): Promise<unknown> {
          // D1 first() yields null for no match; normalize to undefined.
          const row = await db
            .prepare(sql)
            .bind(...params)
            .first();
          return row ?? undefined;
        },
        async all(...params: readonly unknown[]): Promise<unknown[]> {
          const result = await db
            .prepare(sql)
            .bind(...params)
            .all();
          return result.results;
        },
      };
    },
    async batch(statements: readonly SqlStatement[]): Promise<unknown[]> {
      if (statements.length === 0) {
        return [];
      }
      const prepared = statements.map((statement) =>
        db.prepare(statement.sql).bind(...(statement.params ?? []))
      );
      if (db.batch) {
        return await db.batch(prepared);
      }
      const results: unknown[] = [];
      for (const statement of prepared) {
        await statement.run();
        results.push(undefined);
      }
      return results;
    },
  };
}
