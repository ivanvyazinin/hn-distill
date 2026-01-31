import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { ObjectStore, PutOptions } from "@utils/object-store";

function normalizeKey(key: string): string {
  return key.replace(/^[./]+/u, "");
}

function stableStringify(data: unknown, pretty?: boolean): string {
  return JSON.stringify(data, undefined, pretty ?? true ? 2 : 0);
}

async function writeTextAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${Date.now()}.${process.pid}.tmp`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}

export function createFsStore(rootDir = "."): ObjectStore {
  const root = resolve(rootDir);

  function resolvePath(key: string): string {
    if (isAbsolute(key)) {
      return key;
    }
    return resolve(root, normalizeKey(key));
  }

  async function listDir(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const results: string[] = [];
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await listDir(full);
        results.push(...sub);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
    return results;
  }

  return {
    async getText(key: string): Promise<string | null> {
      const path = resolvePath(key);
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    async putText(key: string, body: string, opts?: PutOptions): Promise<void> {
      const path = resolvePath(key);
      const skip = opts?.skipIfUnchanged ?? true;
      if (skip && existsSync(path)) {
        try {
          const current = await readFile(path, "utf8");
          if (current === body) {
            return;
          }
        } catch {
          // ignore diff read errors
        }
      }
      await writeTextAtomic(path, body);
    },
    async getJson<T>(key: string): Promise<T | null> {
      const raw = await this.getText(key);
      if (!raw) {
        return null;
      }
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async putJson(key: string, value: unknown, opts?: PutOptions): Promise<void> {
      const payload = stableStringify(value, opts?.pretty);
      await this.putText(key, payload, opts);
    },
    async list(prefix: string): Promise<string[]> {
      const dir = resolvePath(prefix);
      const files = await listDir(dir);
      return files.map((file) => relative(root, file).split(sep).join("/"));
    },
  };
}
