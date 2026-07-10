/**
 * Packs raw blobs older than RETENTION_DAYS into data/archive/YYYY/MM/DD.tar.gz.
 * Run from self-hosted scheduler against local FS or after R2 pull — not from the Worker.
 */
import { Buffer } from "node:buffer";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { PATHS } from "@config/paths";
import { toDateKeyUTC } from "@utils/date-keys";
import { log } from "@utils/log";
import { openLocalMetaStore } from "@utils/meta-runtime";

const RETENTION_DAYS = 14;
const RAW_KIND_BY_DIRECTORY = {
  articles: "article",
  comments: "comments",
  items: "item",
} as const;

/** POSIX ustar checksum: sum header bytes treating checksum field as ASCII spaces (0x20). */
function tarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(512, 0);
  buf.write(name.slice(0, 100), 0, "utf8");
  buf.write("0000644\0", 100, "utf8");
  buf.write("0000000\0", 108, "utf8");
  buf.write("0000000\0", 116, "utf8");
  buf.write(`${size.toString(8).padStart(11, "0")  }\0`, 124, "utf8");
  buf.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")  }\0`, 136, "utf8");
  buf.write("        ", 148, "ascii");
  buf.write("ustar\0", 257, "utf8");
  buf.write("00\0", 263, "utf8");
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : (buf[i] ?? 0);
  }
  buf.write(`${sum.toString(8).padStart(6, "0")  }\0 `, 148, "utf8");
  return buf;
}

async function appendFileToTar(chunks: Buffer[], name: string, filePath: string): Promise<void> {
  const data = readFileSync(filePath);
  chunks.push(tarHeader(name, data.length));
  chunks.push(data);
  const pad = 512 - (data.length % 512);
  if (pad < 512) {
    chunks.push(Buffer.alloc(pad));
  }
}

function storyIdFromRawFilename(name: string, sub: "articles" | "comments" | "items"): number | undefined {
  if (sub === "items") {
    const id = /^(?<id>\d+)\.json$/u.exec(name)?.groups?.["id"];
    return id === undefined ? undefined : Number.parseInt(id, 10);
  }
  if (sub === "comments") {
    const id = /^(?<id>\d+)\.comments\.json$/u.exec(name)?.groups?.["id"];
    return id === undefined ? undefined : Number.parseInt(id, 10);
  }
  const id = /^(?<id>\d+)\.md$/u.exec(name)?.groups?.["id"];
  return id === undefined ? undefined : Number.parseInt(id, 10);
}

async function main(): Promise<void> {
  const meta = await openLocalMetaStore();
  if (!meta) {
    log.warn("archive-raw", "SQLite unavailable; skipping");
    return;
  }

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  const cutoffKey = cutoff.toISOString().slice(0, 10);

  const storyDay = new Map<number, string>();
  const storyIds = await meta.listStoryIdsForAggregate(0);
  const items = await meta.getAggregatedItems(storyIds);
  for (const item of items) {
    storyDay.set(item.id, toDateKeyUTC(item.timeISO));
  }

  for (const sub of ["items", "comments", "articles"] as const) {
    const dir = PATHS.raw[sub];
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    const byDay = new Map<string, Array<{ path: string; storyId: number }>>();
    for (const name of entries) {
      const storyId = storyIdFromRawFilename(name, sub);
      if (storyId === undefined) {
        continue;
      }
      const day = storyDay.get(storyId);
      if (!day || day >= cutoffKey) {
        continue;
      }
      const full = join(dir, name);
      const list = byDay.get(day) ?? [];
      list.push({ path: full, storyId });
      byDay.set(day, list);
    }

    for (const [day, files] of byDay) {
      if (files.length === 0) {
        continue;
      }
      const [y, mo, d] = day.split("-");
      const archiveDir = join(PATHS.dataDir, "archive", y ?? "0000", mo ?? "00");
      await mkdir(archiveDir, { recursive: true });
      const archivePath = join(archiveDir, `${d ?? "00"}-${sub}.tar.gz`);
      const chunks: Buffer[] = [];
      for (const file of files) {
        await appendFileToTar(chunks, basename(file.path), file.path);
      }
      chunks.push(Buffer.alloc(1024));
      const tar = Buffer.concat(chunks);
      await pipeline(Readable.from(tar), createGzip(), createWriteStream(archivePath));
      for (const file of files) {
        await rm(file.path, { force: true });
        const kind = RAW_KIND_BY_DIRECTORY[sub];
        await meta.upsertRawBlob({
          storyId: file.storyId,
          kind,
          ref: `${archivePath}#${basename(file.path)}`,
        });
      }
      log.info("archive-raw", "Archived day", { day, sub, count: files.length, archivePath });
    }
  }

  log.info("archive-raw", "Done", { retentionDays: RETENTION_DAYS });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}