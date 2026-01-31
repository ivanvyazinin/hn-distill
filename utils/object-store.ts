export type PutOptions = {
  contentType?: string;
  pretty?: boolean;
  skipIfUnchanged?: boolean;
};

export interface ObjectStore {
  getText(key: string): Promise<string | null>;
  putText(key: string, body: string, opts?: PutOptions): Promise<void>;
  getJson<T>(key: string): Promise<T | null>;
  putJson(key: string, value: unknown, opts?: PutOptions): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export type KeyMapper = (key: string) => string;

function normalizeKey(key: string): string {
  return key.replace(/^[./]+/u, "");
}

function stableStringify(data: unknown, pretty?: boolean): string {
  return JSON.stringify(data, undefined, pretty ?? true ? 2 : 0);
}

export type R2ObjectBodyLike = { text(): Promise<string> };
export type R2ListResultLike = { objects: Array<{ key: string }> };

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    opts?: { httpMetadata?: { contentType?: string } }
  ): Promise<void>;
  list(options?: { prefix?: string }): Promise<R2ListResultLike>;
}

export function mapR2KeyDefault(key: string): string {
  const normalized = normalizeKey(key);
  if (normalized.startsWith("data/summaries/")) {
    return normalized.replace(/^data\/summaries\//u, "summaries/");
  }
  return normalized;
}

export function createR2Store(
  bucket: R2BucketLike,
  opts?: { prefix?: string; mapKey?: KeyMapper }
): ObjectStore {
  const prefix = opts?.prefix ? normalizeKey(opts.prefix) : "";
  const mapKey = opts?.mapKey ?? mapR2KeyDefault;

  function resolveKey(key: string): string {
    const mapped = mapKey(normalizeKey(key));
    const base = prefix ? `${prefix}/` : "";
    return `${base}${mapped}`.replace(/^\//u, "");
  }

  return {
    async getText(key: string): Promise<string | null> {
      const obj = await bucket.get(resolveKey(key));
      if (!obj) {
        return null;
      }
      return await obj.text();
    },
    async putText(key: string, body: string, opts?: PutOptions): Promise<void> {
      const skip = opts?.skipIfUnchanged ?? false;
      if (skip) {
        const current = await this.getText(key);
        if (current !== null && current === body) {
          return;
        }
      }
      await bucket.put(resolveKey(key), body, {
        httpMetadata: opts?.contentType ? { contentType: opts.contentType } : undefined,
      });
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
      await this.putText(key, payload, { ...opts, contentType: opts?.contentType ?? "application/json" });
    },
    async list(prefixKey: string): Promise<string[]> {
      const result = await bucket.list({ prefix: resolveKey(prefixKey) });
      return result.objects.map((obj) => obj.key);
    },
  };
}

export async function readJsonSafeOrStore<T>(
  store: ObjectStore,
  key: string,
  schema: import("zod").ZodType<T>,
  fallback?: T
): Promise<T | undefined> {
  const raw = await store.getJson<unknown>(key);
  if (raw === null || raw === undefined) {
    return fallback;
  }
  try {
    return schema.parse(raw);
  } catch {
    return fallback;
  }
}
