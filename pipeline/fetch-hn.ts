import pLimit from "p-limit";
import { z } from "zod";

import { env, type Env } from "@config/env";
import { PATHS, pathFor } from "@config/paths";
import {
  HnItemRawSchema,
  IndexSchema,
  type HnItemRaw,
  type NormalizedComment,
  type NormalizedStory,
} from "@config/schemas";
import { HN } from "@utils/hn";
import { HttpClient } from "@utils/http-client";
import { log } from "@utils/log";
import type { MetaStore } from "@utils/meta-store";
import { readJsonSafeOrStore, type ObjectStore } from "@utils/object-store";
import { toDateKeyUTC } from "@utils/date-keys";
import { clamp, htmlToPlain } from "@utils/text";

export type Services = {
  http: HttpClient;
};

function normalizeUrl(url?: string): string | undefined {
  if (url === undefined || url.length === 0) {
    return undefined;
  }
  try {
    const u = new URL(url);
    if (!u.protocol.startsWith("http")) {
      return undefined;
    }
    return u.toString();
  } catch {
    return undefined;
  }
}

export function makeServices(e: Env): Services {
  const http = new HttpClient(
    {
      retries: e.HTTP_RETRIES,
      baseBackoffMs: e.HTTP_BACKOFF_MS,
      timeoutMs: e.HTTP_TIMEOUT_MS,
      retryOnStatuses: [408, 425, 429, 500, 502, 503, 504, 522],
    },
    {
      ua: "hckr.top/1.0 (+https://hckr.top)",
      headers: {},
    }
  );
  return { http };
}

type ReadTopIdsOptions = {
  mode?: Env["TOP_N_MODE"];
  now?: Date;
  dayOffset?: number;
  /** Item fetch parallelism for daily-top-by-score (defaults to env.CONCURRENCY). */
  concurrency?: number;
};

type DayOffset = NonNullable<ReadTopIdsOptions["dayOffset"]>;

type AlgoliaStoryHit = {
  objectID?: unknown;
  created_at_i?: unknown;
};

type AlgoliaSearchResponse = {
  hits: AlgoliaStoryHit[];
  nbHits?: number;
  nbPages?: number;
};

type DailyStoryCandidate = {
  id: number;
  score: number;
  time: number;
};

const ALGOLIA_HITS_PER_PAGE = 1000;

function utcDayWindow(now: Date, dayOffset: DayOffset = 0): { startUnix: number; endUnix: number } {
  const startMs =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0) + dayOffset * 24 * 60 * 60 * 1000;
  return {
    startUnix: Math.floor(startMs / 1000),
    endUnix: Math.floor((startMs + 24 * 60 * 60 * 1000) / 1000),
  };
}

function parseFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseAlgoliaResponse(raw: unknown): AlgoliaSearchResponse | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }

  const candidate = raw as {
    hits?: unknown;
    nbHits?: unknown;
    nbPages?: unknown;
  };

  const parsed: AlgoliaSearchResponse = {
    hits: Array.isArray(candidate.hits) ? (candidate.hits as AlgoliaStoryHit[]) : [],
  };
  const nbHits = parseFiniteNumber(candidate.nbHits);
  const nbPages = parseFiniteNumber(candidate.nbPages);
  if (nbHits !== undefined) {
    parsed.nbHits = nbHits;
  }
  if (nbPages !== undefined) {
    parsed.nbPages = nbPages;
  }
  return parsed;
}

function buildAlgoliaDayUrl(startUnix: number, endUnix: number): string {
  const url = new URL(`${HN.algoliaApi}/search_by_date`);
  url.searchParams.set("query", "");
  url.searchParams.set("tags", "story");
  url.searchParams.set("hitsPerPage", String(ALGOLIA_HITS_PER_PAGE));
  url.searchParams.set("page", "0");
  url.searchParams.set("numericFilters", `created_at_i>=${startUnix},created_at_i<${endUnix}`);
  return url.toString();
}

function parseAlgoliaHitId(hit: AlgoliaStoryHit): number | undefined {
  const parsed = Number(hit.objectID);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseAlgoliaHitCreatedAt(hit: AlgoliaStoryHit): number | undefined {
  return parseFiniteNumber(hit.created_at_i);
}

async function readDailyCandidateIdsForWindow(
  services: Services,
  startUnix: number,
  endUnix: number
): Promise<number[]> {
  if (startUnix >= endUnix) {
    return [];
  }

  let raw: unknown;
  try {
    raw = await services.http.json<unknown>(buildAlgoliaDayUrl(startUnix, endUnix));
  } catch {
    raw = undefined;
  }
  const parsed = parseAlgoliaResponse(raw);
  if (!parsed) {
    return [];
  }

  const ids = uniqueNumbers(
    parsed.hits
      .map((hit) => {
        const id = parseAlgoliaHitId(hit);
        if (id === undefined) {
          return;
        }

        const createdAtUnix = parseAlgoliaHitCreatedAt(hit);
        if (createdAtUnix !== undefined && (createdAtUnix < startUnix || createdAtUnix >= endUnix)) {
          return;
        }

        return id;
      })
      .filter((id): id is number => id !== undefined)
  );

  if ((parsed.nbPages ?? 1) <= 1) {
    return ids;
  }

  const midpoint = startUnix + Math.floor((endUnix - startUnix) / 2);
  if (midpoint <= startUnix || midpoint >= endUnix) {
    log.warn("fetch-hn", "Algolia day window hit page cap at minimum granularity", {
      startUnix,
      endUnix,
      hits: ids.length,
      nbHits: parsed.nbHits,
      nbPages: parsed.nbPages,
    });
    return ids;
  }

  const [leftIds, rightIds] = await Promise.all([
    readDailyCandidateIdsForWindow(services, startUnix, midpoint),
    readDailyCandidateIdsForWindow(services, midpoint, endUnix),
  ]);
  return uniqueNumbers([...leftIds, ...rightIds]);
}

async function readDailyTopIds(
  services: Services,
  limit: number,
  now: Date,
  dayOffset: DayOffset = 0,
  concurrencyOverride?: number
): Promise<number[]> {
  const { startUnix, endUnix } = utcDayWindow(now, dayOffset);
  const candidateIds = await readDailyCandidateIdsForWindow(services, startUnix, endUnix);
  if (candidateIds.length === 0) {
    return [];
  }

  const configuredConcurrency = concurrencyOverride ?? env.CONCURRENCY;
  const concurrency = Number.isFinite(configuredConcurrency) ? Math.max(1, configuredConcurrency) : 8;
  const limitConcurrency = pLimit(concurrency);
  const candidates = (
    await Promise.all(
      candidateIds.map(async (id) =>
        await limitConcurrency(async (): Promise<DailyStoryCandidate | undefined> => {
          const item = await fetchItem(services, id);
          if (!item || item.type !== "story") {
            return;
          }

          const time = Number.isFinite(item.time) ? item.time : undefined;
          if (time === undefined || time < startUnix || time >= endUnix) {
            return;
          }

          return {
            id: item.id,
            score: typeof item.score === "number" ? item.score : 0,
            time,
          };
        })
      )
    )
  ).filter((candidate): candidate is DailyStoryCandidate => candidate !== undefined);

  candidates.sort((a, b) => b.score - a.score || b.time - a.time || b.id - a.id);
  return candidates.slice(0, Math.max(0, limit)).map((candidate) => candidate.id);
}

export async function readTopIds(
  services: Services,
  limit: number,
  options: ReadTopIdsOptions = {}
): Promise<number[]> {
  if (options.mode === "daily-top-by-score") {
    return await readDailyTopIds(
      services,
      limit,
      options.now ?? new Date(),
      options.dayOffset ?? 0,
      options.concurrency
    );
  }

  const ids = await services.http.json<number[]>(`${HN.api}/topstories.json`).catch(() => []);
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }
  return ids.slice(0, Math.max(0, limit));
}

export async function fetchItem(services: Services, id: number): Promise<HnItemRaw | undefined> {
  const url = `${HN.api}/item/${id}.json`;
  try {
    const data = await services.http.json<unknown>(url);
    const parsed = HnItemRawSchema.safeParse(data);
    if (!parsed.success) {
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

export function normalizeStory(raw: HnItemRaw): NormalizedStory {
  if (raw.type !== "story") {
    throw new Error(`Not a story: ${raw.id}`);
  }
  const title = clamp(raw.title ?? "(no title)", 500);
  const by = clamp(raw.by ?? "unknown", 80);
  const timeMs = Number.isFinite(raw.time) ? raw.time * 1000 : Date.now();
  return {
    id: raw.id,
    title,
    url: normalizeUrl(raw.url) ?? null, // eslint-disable-line unicorn/no-null
    by,
    timeISO: new Date(timeMs).toISOString(),
    commentIds: raw.kids ?? [],
    score: raw.score,
    descendants: raw.descendants,
  };
}

type SeenCacheShape = Record<
  number,
  {
    seenTopLevel: number[];
    seenByDepth: Record<string, number[]>;
    updatedISO: string;
  }
>;

async function migrateCache(raw: unknown): Promise<SeenCacheShape> {
  const migrated: SeenCacheShape = {};
  if (typeof raw !== "object" || raw === null) {
    return migrated;
  }
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    const storyId = Number(key);
    if (Number.isNaN(storyId)) {
      continue;
    }
    const entry = (raw as Record<string, unknown>)[key] as
      | {
          seenTopLevel?: number[];
          seenKids?: number[];
          seenByDepth?: Record<string, number[]>;
          updatedISO?: string;
        }
      | undefined;
    const seenTopLevel: number[] = entry?.seenTopLevel ?? entry?.seenKids ?? [];
    const seenByDepth: Record<string, number[]> = entry?.seenByDepth ?? {};
    const updatedISO: string = typeof entry?.updatedISO === "string" ? entry.updatedISO : new Date(0).toISOString();
    migrated[storyId] = { seenTopLevel, seenByDepth, updatedISO };
  }
  return migrated;
}

export async function readSeenCache(store: ObjectStore, p: string = PATHS.seenCache): Promise<SeenCacheShape> {
  const rawCache = await readJsonSafeOrStore<Record<string, unknown>>(store, p, z.record(z.unknown()), {});
  return migrateCache(rawCache ?? {});
}

function uniqueNumbers(values: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function arrayShallowEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (const [index, value] of a.entries()) {
    if (value !== b[index]) {
      return false;
    }
  }
  return true;
}

function normalizeMembers(values: readonly number[]): number[] {
  const seen = new Set<number>(values);
  return [...seen].sort((a, b) => a - b);
}

function numberMembersEqual(a: readonly number[], b: readonly number[]): boolean {
  return arrayShallowEqual(normalizeMembers(a), normalizeMembers(b));
}

function seenByDepthMembersEqual(a: Record<string, number[]>, b: Record<string, number[]>): boolean {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const aa = a[key] ?? [];
    const bb = b[key] ?? [];
    if (!numberMembersEqual(aa, bb)) {
      return false;
    }
  }
  return true;
}

type CommentFetchResult = {
  normalized?: NormalizedComment;
  kids: number[];
  depthCurrent: number;
  skip: boolean;
};

async function processCommentItem(
  services: Services,
  id: number,
  depth: number,
  visitedThisRun: Set<number>,
  allSeenByDepth: Record<number, number[]>
): Promise<CommentFetchResult | undefined> {
  if (visitedThisRun.has(id)) {
    return;
  }
  visitedThisRun.add(id);

  const item = await fetchItem(services, id).catch(() => {
    // Ignore fetch errors and continue
  });
  if (!item || item.type !== "comment") {
    return;
  }

  allSeenByDepth[depth] ??= [];
  allSeenByDepth[depth].push(id);

  const kids = Array.isArray(item.kids) ? item.kids : [];

  const textPlainRaw = htmlToPlain(item.text ?? "");
  if (!textPlainRaw) {
    return { kids, depthCurrent: depth, skip: true };
  }
  const textPlain = clamp(textPlainRaw, env.MAX_BODY_CHARS);
  const normalized: NormalizedComment = {
    id: item.id,
    by: clamp(item.by ?? "unknown", 80),
    timeISO: new Date((Number.isFinite(item.time) ? item.time : Date.now() / 1000) * 1000).toISOString(),
    textPlain,
    parent: item.parent ?? 0,
    depth,
  };
  return { normalized, kids, depthCurrent: depth, skip: false };
}

function addKidsToQueue(
  result: CommentFetchResult,
  queue: Array<{ id: number; depth: number }>,
  options: {
    maxDepth: number;
    maxCount: number;
    seenByDepth: Record<string, number[]>;
  },
  visitedThisRun: Set<number>,
  currentCount: number
): void {
  if (result.depthCurrent >= options.maxDepth) {
    return;
  }

  const nextDepth = result.depthCurrent + 1;
  const seenAtNextDepth = options.seenByDepth[String(nextDepth)] ?? [];
  for (const kid of result.kids) {
    if (currentCount + queue.length >= options.maxCount) {
      break;
    }
    if (seenAtNextDepth.includes(kid)) {
      continue;
    }
    if (!visitedThisRun.has(kid)) {
      queue.push({ id: kid, depth: nextDepth });
    }
  }
}

export async function collectComments(
  services: Services,
  rootIds: number[],
  options: {
    maxDepth: number;
    maxCount: number;
    concurrency: number;
    seenByDepth: Record<string, number[]>;
  }
): Promise<{ comments: NormalizedComment[]; allSeenByDepth: Record<number, number[]> }> {
  const limit = pLimit(options.concurrency);
  const queue: Array<{ id: number; depth: number }> = rootIds.map((id) => ({
    id,
    depth: 1,
  }));
  const out: NormalizedComment[] = [];
  const visitedThisRun = new Set<number>();
  const allSeenByDepth: Record<number, number[]> = {};

  while (queue.length > 0 && out.length < options.maxCount) {
    const batchSize = Math.max(1, Math.min(queue.length, options.concurrency));
    const batch = queue.splice(0, batchSize);
    const results = await Promise.all(
      batch.map(async ({ id, depth }) =>
        limit(async () => processCommentItem(services, id, depth, visitedThisRun, allSeenByDepth))
      )
    );

    for (const res of results) {
      if (!res) {
        continue;
      }
      if (!res.skip && res.normalized && out.length < options.maxCount) {
        out.push(res.normalized);
      }
      addKidsToQueue(res, queue, options, visitedThisRun, out.length);
    }
  }

  return { comments: out.slice(0, options.maxCount), allSeenByDepth };
}

export async function main(
  servicesOverride: Services | undefined,
  store: ObjectStore,
  meta?: MetaStore
): Promise<{ updatedISO: string; storyIds: number[] }> {
  const services = servicesOverride ?? makeServices(env);
  const runTimestamp = new Date().toISOString();

  const seenCache = await readSeenCache(store);
  const seenCacheExists = (await store.getText(PATHS.seenCache)) !== null;
  let seenCacheChanged = false;

  const previousIndex = await readJsonSafeOrStore(store, PATHS.index, IndexSchema);
  const indexExists = (await store.getText(PATHS.index)) !== null;

  const topIds = await readTopIds(services, env.TOP_N, {
    mode: env.TOP_N_MODE,
    now: new Date(runTimestamp),
    dayOffset: env.TOP_N_DAY_OFFSET,
    concurrency: env.CONCURRENCY,
  });
  const idsSet = new Set<number>(topIds);

  const concurrency = Math.max(1, env.CONCURRENCY);
  const limit = pLimit(concurrency);

  const stories: NormalizedStory[] = [];
  const commentsByStory: Record<number, NormalizedComment[]> = {};

  await Promise.all(
    topIds.map(async (id) =>
      limit(async () => {
        const item = await fetchItem(services, id);
        if (!item) {
          return;
        }
        if (item.type !== "story") {
          return;
        }
        const story = normalizeStory(item);
        stories.push(story);

        const entry = seenCache[story.id];
        const seenByDepth = entry?.seenByDepth ?? {};
        const rootIds = Array.isArray(story.commentIds) ? story.commentIds : [];

        if (rootIds.length > 0) {
          const { comments, allSeenByDepth } = await collectComments(services, rootIds, {
            maxDepth: env.MAX_DEPTH,
            maxCount: env.MAX_COMMENTS_PER_STORY,
            concurrency,
            seenByDepth,
          });
          commentsByStory[story.id] = comments;

          const c: Record<string, number[]> = {};
          for (const [depth, array] of Object.entries(allSeenByDepth)) {
            c[String(depth)] = uniqueNumbers(array);
          }

          const nextEntry = {
            seenTopLevel: uniqueNumbers(rootIds),
            seenByDepth: c,
          };
          const prevEntry = seenCache[story.id];
          const sameTop = prevEntry ? numberMembersEqual(prevEntry.seenTopLevel, nextEntry.seenTopLevel) : false;
          const sameByDepth = prevEntry ? seenByDepthMembersEqual(prevEntry.seenByDepth, nextEntry.seenByDepth) : false;

          if (prevEntry && sameTop && sameByDepth) {
            return;
          }

          seenCacheChanged = true;
          seenCache[story.id] = {
            ...nextEntry,
            updatedISO: runTimestamp,
          };
        }
      })
    )
  );

  for (const s of stories) {
    await store.putJson(pathFor.rawItem(s.id), s, { pretty: true, contentType: "application/json" });
    const comments = commentsByStory[s.id] ?? [];
    await store.putJson(pathFor.rawComments(s.id), comments, { pretty: true, contentType: "application/json" });
    if (meta) {
      const rank = topIds.indexOf(s.id);
      await meta.upsertStory(s, rank >= 0 ? rank : stories.indexOf(s), runTimestamp);
      await meta.upsertRawBlob({
        storyId: s.id,
        kind: "item",
        ref: pathFor.rawItem(s.id),
        fetchedAt: runTimestamp,
      });
      await meta.upsertRawBlob({
        storyId: s.id,
        kind: "comments",
        ref: pathFor.rawComments(s.id),
        fetchedAt: runTimestamp,
      });
      if (env.TOP_N_MODE === "daily-top-by-score") {
        await meta.upsertDailyRanking({
          day: toDateKeyUTC(s.timeISO),
          storyId: s.id,
          rank: rank >= 0 ? rank : 0,
          ...(typeof s.score === "number" ? { score: s.score } : {}),
          mode: env.TOP_N_MODE,
        });
      }
    }
  }

  const storyIds = [...idsSet];
  const previousStoryIds = previousIndex?.storyIds ?? [];
  const sameStoryIds = arrayShallowEqual(previousStoryIds, storyIds);
  const indexUpdatedISO =
    sameStoryIds && typeof previousIndex?.updatedISO === "string" ? previousIndex.updatedISO : runTimestamp;
  const indexPayload = {
    updatedISO: indexUpdatedISO,
    storyIds,
  };
  const shouldWriteIndex = !sameStoryIds || !previousIndex || !indexExists;
  if (shouldWriteIndex) {
    await store.putJson(PATHS.index, indexPayload, { pretty: true, contentType: "application/json" });
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (seenCacheChanged || !seenCacheExists) {
    await store.putJson(PATHS.seenCache, seenCache, { pretty: true, contentType: "application/json" });
  }

  return indexPayload;
}
