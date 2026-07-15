import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NormalizedCommentSchema, NormalizedStorySchema, PostSummarySchema } from "@config/schemas";

import type { NormalizedComment, NormalizedStory } from "@config/schemas";

export type CommentsBenchFixture = {
  story: Pick<NormalizedStory, "id" | "title" | "url">;
  postTldr?: string;
  comments: NormalizedComment[];
};

export type QualityTargets = {
  large: number;
  medium: number;
  small: number;
};

export type SnapshotCommentsBenchOptions = {
  commentsDir: string;
  itemsDir: string;
  summariesDir: string;
  outputDir: string;
  manifestPath: string;
  overwrite?: boolean;
  forceSynthetic?: boolean;
  qualityTargets?: QualityTargets;
};

export type SnapshotCommentsBenchResult = {
  qualityIds: number[];
  edgeIds: number[];
  provenance: "local-snapshot" | "mixed-local-and-synthetic" | "synthetic-public-hn-like";
};

type Candidate = {
  fixture: CommentsBenchFixture;
  provenance: "local" | "synthetic";
};

type BenchManifest = Record<string, unknown> & {
  commentThreadIds?: number[];
  commentEdgeThreadIds?: number[];
  commentsProvenance?: Record<string, unknown>;
};

const DEFAULT_QUALITY_TARGETS: QualityTargets = { large: 5, medium: 10, small: 5 };
const SYNTHETIC_QUALITY_ID_BASE = 990_000_000;
const SYNTHETIC_EDGE_ID_BASE = 990_100_000;
const SYNTHETIC_TIME_EPOCH = Date.UTC(2026, 0, 1);
const SYNTHETIC_DISCUSSION_TEXTS = [
  "The benchmark looks promising, but the post should publish hardware details and raw samples before comparing it with established systems.",
  "We deployed a similar design last year; recovery was simple at first, while operational complexity appeared once the dataset crossed several terabytes.",
  "The strongest part is the narrow API. It leaves room to replace the storage layer later without forcing every caller to migrate at once.",
  "I disagree that throughput is the main constraint here. Tail latency during compaction is what usually surprises users in production.",
  "A useful follow-up would compare failure recovery, upgrade time, and observability rather than reporting only steady-state requests per second.",
  "For a small team, the older approach may still be preferable because it has mature tooling and fewer components to operate overnight.",
  "The proposed cache policy needs an explicit invalidation story; otherwise a successful demo can hide stale reads under concurrent updates.",
  "One practical rollout is to mirror traffic, compare results offline, and enable writes for a small canary only after the mismatch rate reaches zero.",
  "The documentation explains the happy path well, but examples for partial failures and interrupted migrations would make the trade-offs clearer.",
  "This resembles patterns used in database proxies, although the post makes a different consistency choice that reduces coordination between regions.",
  "Memory use deserves a separate graph. Higher throughput is less attractive if every worker needs enough RAM to retain the entire hot set.",
  "Maintainers should publish a reproducible test harness so readers can verify the numbers on different kernels, filesystems, and cloud instances.",
] as const;

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readManifest(path: string): Promise<BenchManifest> {
  if (!(await pathExists(path))) {
    return {};
  }
  const value = await readJson(path);
  return value instanceof Object && !Array.isArray(value) ? (value as BenchManifest) : {};
}

async function numericJsonIds(dir: string): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return names
    .map((name) => /^(?<id>\d+)\.json$/u.exec(name)?.groups?.["id"])
    .filter((id): id is string => id !== undefined)
    .map(Number)
    .filter(Number.isSafeInteger)
    .sort((left, right) => left - right);
}

async function loadLocalCandidate(id: number, options: SnapshotCommentsBenchOptions): Promise<Candidate | undefined> {
  const itemPath = resolve(options.itemsDir, `${id}.json`);
  const commentsPath = resolve(options.commentsDir, `${id}.json`);
  if (!(await pathExists(itemPath))) {
    return undefined;
  }

  const [storyResult, commentsResult] = await Promise.all([
    readJson(itemPath).then((value) => NormalizedStorySchema.safeParse(value)),
    readJson(commentsPath).then((value) => NormalizedCommentSchema.array().safeParse(value)),
  ]);
  if (!storyResult.success || !commentsResult.success) {
    return undefined;
  }

  const postPath = resolve(options.summariesDir, `${id}.post.json`);
  let postTldr: string | undefined;
  if (await pathExists(postPath)) {
    const parsed = PostSummarySchema.safeParse(await readJson(postPath));
    const summary = parsed.success ? parsed.data.summary.trim() : "";
    if (summary.length > 0) {
      postTldr = summary;
    }
  }

  return {
    provenance: "local",
    fixture: {
      story: {
        id: storyResult.data.id,
        title: storyResult.data.title,
        url: storyResult.data.url,
      },
      ...(postTldr === undefined ? {} : { postTldr }),
      comments: commentsResult.data,
    },
  };
}

function syntheticComment(storyId: number, index: number, text?: string): NormalizedComment {
  const id = storyId * 1000 + index + 1;
  const rootIndex = index - (index % 5);
  const rootId = storyId * 1000 + rootIndex + 1;
  const isRoot = index % 5 === 0;
  const discussionText =
    SYNTHETIC_DISCUSSION_TEXTS[index % SYNTHETIC_DISCUSSION_TEXTS.length] ??
    "Participants compare the implementation trade-offs and request more reproducible operational evidence.";
  return {
    id,
    by: `synthetic_user_${index % 11}`,
    timeISO: new Date(SYNTHETIC_TIME_EPOCH + index * 60_000).toISOString(),
    textPlain: text ?? discussionText,
    parent: isRoot ? storyId : rootId,
    depth: isRoot ? 0 : 1,
  };
}

function syntheticFixture(storyId: number, count: number, label: string): CommentsBenchFixture {
  return {
    story: {
      id: storyId,
      title: `Synthetic HN-like discussion: ${label}`,
      url: `https://example.invalid/hn-synthetic/${storyId}`,
    },
    postTldr: `Synthetic context for the ${label} discussion; this fixture is not production data.`,
    comments: Array.from({ length: count }, (_, index) => syntheticComment(storyId, index)),
  };
}

function syntheticQualityCandidates(): Candidate[] {
  const counts = [38, 40, 42, 44, 46, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 3, 7, 11, 17, 23];
  return counts.map((count, index) => ({
    provenance: "synthetic",
    fixture: syntheticFixture(SYNTHETIC_QUALITY_ID_BASE + index + 1, count, `quality-${index + 1}`),
  }));
}

function syntheticEdgeCandidates(): Candidate[] {
  const zero = syntheticFixture(SYNTHETIC_EDGE_ID_BASE + 1, 0, "zero-comments");
  const one = syntheticFixture(SYNTHETIC_EDGE_ID_BASE + 2, 1, "one-comment");
  const two = syntheticFixture(SYNTHETIC_EDGE_ID_BASE + 3, 2, "two-comments");

  const advice = syntheticFixture(SYNTHETIC_EDGE_ID_BASE + 4, 6, "advice-only");
  advice.comments = advice.comments.map((comment, index) => ({
    ...comment,
    textPlain:
      index % 2 === 0
        ? "What concrete checks should an operator run before enabling this feature in production?"
        : "Start with a canary, record latency and error-rate baselines, then expand only after comparing the measurements.",
  }));

  const missingParent = syntheticFixture(SYNTHETIC_EDGE_ID_BASE + 5, 5, "missing-parent");
  const orphanedReply = missingParent.comments[1];
  if (orphanedReply === undefined) {
    throw new Error("Synthetic missing-parent fixture is incomplete");
  }
  missingParent.comments[1] = {
    ...orphanedReply,
    parent: missingParent.story.id * 1000 + 999,
    depth: 2,
  };

  const technicalRu = syntheticFixture(SYNTHETIC_EDGE_ID_BASE + 6, 5, "technical-russian");
  const technicalTexts = [
    "Участники сравнивают PostgreSQL и SQLite, обсуждают WAL, fsync и задержки p99 на тестовом стенде.",
    "Для диагностики советуют запустить `EXPLAIN ANALYZE`, проверить индексы и сохранить план запроса.",
    "Автор уточняет, что API остаётся совместимым, а миграция TypeScript-клиента выполняется постепенно.",
    "В ответах разбирают Docker, Linux cgroups v2 и влияние лимитов CPU на фоновые задачи.",
    "Общий вывод: сначала нужен небольшой canary rollout с метриками, затем расширение на остальные узлы.",
  ];
  technicalRu.comments = technicalRu.comments.map((comment, index) => ({
    ...comment,
    textPlain: technicalTexts[index] ?? "Технический комментарий для детерминированного тестового набора.",
  }));

  return [zero, one, two, advice, missingParent, technicalRu].map((fixture) => ({
    provenance: "synthetic" as const,
    fixture,
  }));
}

function bucketForCount(count: number): keyof QualityTargets | undefined {
  if (count >= 38) {
    return "large";
  }
  if (count >= 25) {
    return "medium";
  }
  if (count >= 3) {
    return "small";
  }
  return undefined;
}

function selectQualityCandidates(
  local: Candidate[],
  targets: QualityTargets,
  forceSynthetic: boolean
): Candidate[] {
  const selected: Candidate[] = [];
  const counts: QualityTargets = { large: 0, medium: 0, small: 0 };
  const sources = forceSynthetic ? [] : [...local, ...syntheticQualityCandidates()];
  const candidates = forceSynthetic ? syntheticQualityCandidates() : sources;

  for (const candidate of candidates) {
    const bucket = bucketForCount(candidate.fixture.comments.length);
    if (bucket === undefined || counts[bucket] >= targets[bucket]) {
      continue;
    }
    selected.push(candidate);
    counts[bucket] += 1;
  }

  for (const bucket of ["large", "medium", "small"] as const) {
    if (counts[bucket] < targets[bucket]) {
      throw new Error(`Unable to build ${bucket} comments cohort: ${counts[bucket]}/${targets[bucket]}`);
    }
  }
  return selected;
}

async function writeFixtures(candidates: Candidate[], outputDir: string, overwrite: boolean): Promise<void> {
  const paths = candidates.map((candidate) => resolve(outputDir, `${candidate.fixture.story.id}.json`));
  if (!overwrite) {
    const collisions = await Promise.all(paths.map(async (path) => ((await pathExists(path)) ? path : undefined)));
    const existing = collisions.filter((path): path is string => path !== undefined);
    if (existing.length > 0) {
      throw new Error(`Refusing to overwrite existing comments fixtures: ${existing.join(", ")}`);
    }
  }

  await mkdir(outputDir, { recursive: true });
  await Promise.all(
    candidates.map(async (candidate) => {
      const path = resolve(outputDir, `${candidate.fixture.story.id}.json`);
      await writeFile(path, jsonText(candidate.fixture), "utf8");
    })
  );

  if (overwrite) {
    const keepIds = new Set(candidates.map((candidate) => candidate.fixture.story.id));
    const existingIds = await numericJsonIds(outputDir);
    await Promise.all(
      existingIds
        .filter((id) => !keepIds.has(id))
        .map(async (id) => {
          await rm(resolve(outputDir, `${id}.json`));
        })
    );
  }
}

export async function snapshotCommentsBench(
  options: SnapshotCommentsBenchOptions
): Promise<SnapshotCommentsBenchResult> {
  const targets = options.qualityTargets ?? DEFAULT_QUALITY_TARGETS;
  const ids = options.forceSynthetic ? [] : await numericJsonIds(options.commentsDir);
  const localCandidates = (
    await Promise.all(ids.map(async (id) => await loadLocalCandidate(id, options)))
  ).filter((candidate): candidate is Candidate => candidate !== undefined);
  const quality = selectQualityCandidates(localCandidates, targets, options.forceSynthetic ?? false);
  const edges = syntheticEdgeCandidates();
  const allCandidates = [...quality, ...edges];

  await writeFixtures(allCandidates, options.outputDir, options.overwrite ?? false);

  const localCount = quality.filter((candidate) => candidate.provenance === "local").length;
  let provenance: SnapshotCommentsBenchResult["provenance"] = "synthetic-public-hn-like";
  if (quality.length > 0 && localCount === quality.length) {
    provenance = "local-snapshot";
  } else if (localCount > 0) {
    provenance = "mixed-local-and-synthetic";
  }
  const qualityIds = quality.map((candidate) => candidate.fixture.story.id);
  const edgeIds = edges.map((candidate) => candidate.fixture.story.id);
  const qualityBuckets = Object.fromEntries(
    (["large", "medium", "small"] as const).map((bucket) => {
      const inBucket = quality.filter((candidate) => bucketForCount(candidate.fixture.comments.length) === bucket);
      return [
        bucket,
        {
          target: targets[bucket],
          local: inBucket.filter((candidate) => candidate.provenance === "local").length,
          synthetic: inBucket.filter((candidate) => candidate.provenance === "synthetic").length,
        },
      ];
    })
  );
  const manifest = await readManifest(options.manifestPath);
  const nextManifest: BenchManifest = {
    ...manifest,
    commentThreadIds: qualityIds,
    commentEdgeThreadIds: edgeIds,
    commentsProvenance: {
      kind: provenance,
      localFixtureCount: localCount,
      syntheticFixtureCount: allCandidates.length - localCount,
      qualityBuckets,
      edgeCohort: "synthetic",
      note:
        provenance === "local-snapshot"
          ? "Snapshot from local generated repository data; no live network calls were made."
          : "Synthetic fixtures are deterministic and public-HN-like; they are not production conversations.",
    },
  };
  await mkdir(dirname(options.manifestPath), { recursive: true });
  await writeFile(options.manifestPath, jsonText(nextManifest), "utf8");

  return { qualityIds, edgeIds, provenance };
}

type CliOptions = SnapshotCommentsBenchOptions;

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a path`);
  }
  return value;
}

export function parseSnapshotCommentsArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    commentsDir: "data/raw/comments",
    itemsDir: "data/raw/items",
    summariesDir: "data/summaries",
    outputDir: "bench/comments",
    manifestPath: "bench/manifest.json",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      throw new Error(`Missing argument at index ${index}`);
    }
    switch (arg) {
      case "--overwrite": {
        options.overwrite = true;
        break;
      }
      case "--synthetic": {
        options.forceSynthetic = true;
        break;
      }
      case "--comments-dir": {
        options.commentsDir = valueAfter(args, index, arg);
        index += 1;
        break;
      }
      case "--items-dir": {
        options.itemsDir = valueAfter(args, index, arg);
        index += 1;
        break;
      }
      case "--summaries-dir": {
        options.summariesDir = valueAfter(args, index, arg);
        index += 1;
        break;
      }
      case "--output-dir": {
        options.outputDir = valueAfter(args, index, arg);
        index += 1;
        break;
      }
      case "--manifest": {
        options.manifestPath = valueAfter(args, index, arg);
        index += 1;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }
  return options;
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  snapshotCommentsBench(parseSnapshotCommentsArgs(process.argv.slice(2)))
    .then((result) =>
      process.stdout.write(
        `Wrote ${result.qualityIds.length} quality and ${result.edgeIds.length} edge comment fixtures (${result.provenance}).\n`
      )
    )
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
