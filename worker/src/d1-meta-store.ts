import { createMetaStoreOverDriver } from "@utils/meta-store-over-sql";
import { createD1Driver } from "@utils/sql-driver";

import type { D1DatabaseLike } from "./bindings";
import type { MetaStore } from "@utils/meta-store";

/**
 * Thin factory kept for the worker's import sites: the store implementation
 * itself lives once in utils/meta-store-over-sql.ts, driven over D1.
 */
export function createD1MetaStore(db: D1DatabaseLike): MetaStore {
  return createMetaStoreOverDriver(createD1Driver(db));
}
