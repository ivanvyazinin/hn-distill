import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Buffer } from "node:buffer";

import { log } from "@utils/log";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

const accountId = requiredEnv("R2_ACCOUNT_ID");
const accessKeyId = requiredEnv("R2_ACCESS_KEY_ID");
const secretAccessKey = requiredEnv("R2_SECRET_ACCESS_KEY");
const bucket = requiredEnv("R2_BUCKET");
const prefixes = (process.env["R2_PREFIXES"] ?? "data/aggregated.json,data/search.json,data/by-date/")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

const client = new S3Client({
  region: "auto",
  endpoint,
  credentials: { accessKeyId, secretAccessKey },
});

function mapKeyToPath(key: string): string | undefined {
  if (key.startsWith("data/")) {
    return key;
  }
  if (key.startsWith("summaries/")) {
    return `data/summaries/${key.slice("summaries/".length)}`;
  }
  return undefined;
}

async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    for (const obj of result.Contents ?? []) {
      if (obj.Key) {
        keys.push(obj.Key);
      }
    }
    token = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function bodyToBytes(body: unknown): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array();
  }
  const candidate = body as { transformToByteArray?: () => Promise<Uint8Array>; arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof candidate.transformToByteArray === "function") {
    return await candidate.transformToByteArray();
  }
  if (typeof candidate.arrayBuffer === "function") {
    return new Uint8Array(await candidate.arrayBuffer());
  }
  if (Symbol.asyncIterator in Object(candidate)) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of candidate as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  return new Uint8Array();
}

async function downloadKey(key: string): Promise<void> {
  const localPath = mapKeyToPath(key);
  if (!localPath) {
    return;
  }
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await bodyToBytes(result.Body);
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, bytes);
}

async function main(): Promise<void> {
  const start = Date.now();
  let total = 0;

  for (const prefix of prefixes) {
    const keys = await listKeys(prefix);
    for (const key of keys) {
      await downloadKey(key);
      total += 1;
    }
  }

  log.info("r2/pull", "Download complete", { total, ms: Date.now() - start });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
