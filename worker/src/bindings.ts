export type QueueMessage<T> = { body: T };
export type QueueBatch<T> = { messages: QueueMessage<T>[] };

export interface QueueLike<T> {
  send(message: T): Promise<void>;
}

export type R2ObjectBodyLike = { text(): Promise<string> };
export type R2ListResultLike = { objects: Array<{ key: string }> };

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | Uint8Array | unknown,
    opts?: { httpMetadata?: { contentType?: string } }
  ): Promise<void>;
  list(options?: { prefix?: string }): Promise<R2ListResultLike>;
}

export type D1QueryResult<T> = { results: T[] };

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1QueryResult<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ success: boolean }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<void>;
}

export interface WorkerEnv {
  DATA_BUCKET: R2BucketLike;
  DB: D1DatabaseLike;
  TASKS?: QueueLike<unknown>;
  [key: string]: unknown;
}
