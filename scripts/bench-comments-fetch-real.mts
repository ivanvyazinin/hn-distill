/**
 * Phase 0 corpus builder for the cheap-Groq comments-route eval.
 *
 * Fetches real, public Hacker News comment threads through the SAME normalization
 * the production pipeline uses (fetchItem → normalizeStory → collectComments with
 * env.MAX_DEPTH / env.MAX_COMMENTS_PER_STORY), then freezes 20 of them into
 * bench/comments/<id>.json plus a dedicated manifest (bench/candidate-manifest.json).
 *
 * Selection targets a spread of sizes plus technical- and contested-content cohorts
 * (see the plan). Size is measured by the ACTUAL production V2 prompt length
 * (buildCommentsPromptV2), so "long, near the production limit" means a prompt that
 * fills / truncates against COMMENTS_PROMPT_MAX_CHARS. Technical / contested tags are
 * deterministic heuristics; their scores are recorded so the classification is
 * auditable during the manual review the plan requires.
 *
 * The corpus is frozen: re-running refuses to overwrite existing fixtures unless
 * --overwrite is passed, so a later run cannot silently mutate the comparison set.
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { env } from "@config/env";
import { buildCommentsPromptV2 } from "@utils/comments-thread";

import { collectComments, fetchItem, makeServices, normalizeStory } from "../pipeline/fetch-hn";

import type { CommentsBenchFixture } from "../eval/score-comments";
import type { NormalizedComment } from "@config/schemas";

type SizeBucket = "long" | "medium" | "short";

type Candidate = {
  fixture: CommentsBenchFixture;
  fetchedISO: string;
  includedComments: number;
  totalComments: number;
  droppedComments: number;
  promptChars: number;
  truncated: boolean;
  sizeBucket: SizeBucket;
  technicalScore: number;
  contestedScore: number;
};

type SelectedFixtureMeta = {
  id: number;
  title: string;
  fetchedISO: string;
  includedComments: number;
  totalComments: number;
  droppedComments: number;
  promptChars: number;
  truncated: boolean;
  sizeBucket: SizeBucket;
  tags: string[];
  technicalScore: number;
  contestedScore: number;
};

type Options = {
  outputDir: string;
  manifestPath: string;
  count: number;
  poolLimit: number;
  candidateTrees: number;
  overwrite: boolean;
};

const DEFAULTS: Options = {
  outputDir: "bench/comments",
  manifestPath: "bench/candidate-manifest.json",
  count: 20,
  poolLimit: 300,
  candidateTrees: 80,
  overwrite: false,
};

// Size targets (by prompt length). The three targets must sum to at most `count`.
const SIZE_TARGETS: Record<SizeBucket, number> = { long: 5, medium: 5, short: 4 };
const MIN_TECHNICAL = 3;
const MIN_CONTESTED = 3;

// Technical: dense with terms, numbers, and links. Contested: mutually exclusive
// positions and caveats. Both are heuristics over the normalized comment text and are
// matched as whole words/phrases (dynamic per-term regex, so no giant literal to sort).
const TECHNICAL_TERMS = [
  "api", "cpu", "gpu", "ram", "latency", "latencies", "throughput", "kernel", "compiler",
  "protocol", "database", "sql", "query", "cache", "thread", "async", "benchmark", "byte",
  "kb", "mb", "gb", "tb", "ms", "ns", "regex", "token", "schema", "binary", "encryption",
  "tls", "http", "tcp", "udp", "docker", "kubernetes", "rust", "python", "typescript",
  "golang", "linux", "syscall", "allocator", "heap", "stack", "pointer", "p99", "p95",
  "fsync", "wal", "index", "hash", "algorithm", "complexity",
];
const CONTESTED_MARKERS = [
  "disagree", "however", "but", "actually", "wrong", "incorrect", "false", "nonsense",
  "on the other hand", "counterpoint", "i doubt", "not necessarily", "depends", "caveat",
  "in my experience", "citation needed", "overstated", "misleading", "strawman",
  "oversimplified",
];
const URL_RE = /https?:\/\/\S+/giu;
const NUMBER_RE = /\d+/gu;

function escapeForRegExp(value: string): string {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

function countWholeWords(text: string, terms: readonly string[]): number {
  let total = 0;
  for (const term of terms) {
    // Terms come from the hard-coded constant lists above and are regex-escaped; not user input.
    // eslint-disable-next-line security/detect-non-literal-regexp
    const re = new RegExp(String.raw`\b${escapeForRegExp(term)}\b`, "giu");
    total += [...text.matchAll(re)].length;
  }
  return total;
}

function countPattern(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}

function threadText(comments: NormalizedComment[]): string {
  return comments.map((comment) => comment.textPlain).join("\n");
}

function technicalScore(comments: NormalizedComment[]): number {
  if (comments.length === 0) {
    return 0;
  }
  const text = threadText(comments);
  const terms = countWholeWords(text, TECHNICAL_TERMS);
  const urls = countPattern(text, URL_RE);
  const numbers = countPattern(text, NUMBER_RE);
  // Per-comment density so long threads do not automatically dominate.
  return (terms + 2 * urls + numbers) / comments.length;
}

function contestedScore(comments: NormalizedComment[]): number {
  if (comments.length === 0) {
    return 0;
  }
  const text = threadText(comments);
  const markers = countWholeWords(text, CONTESTED_MARKERS);
  // Reward replies (depth > 1): back-and-forth is where disagreement lives.
  const replies = comments.filter((comment) => comment.depth > 1).length;
  return (markers + replies * 0.5) / comments.length;
}

function sizeBucket(promptChars: number, truncated: boolean, cap: number): SizeBucket {
  if (truncated || promptChars >= 0.6 * cap) {
    return "long";
  }
  if (promptChars >= 0.25 * cap) {
    return "medium";
  }
  return "short";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

type FetchServices = ReturnType<typeof makeServices>;

async function readPoolIds(services: FetchServices, limit: number): Promise<number[]> {
  const base = "https://hacker-news.firebaseio.com/v0";
  const [best, top] = await Promise.all([
    services.http.json<number[]>(`${base}/beststories.json`).catch(() => [] as number[]),
    services.http.json<number[]>(`${base}/topstories.json`).catch(() => [] as number[]),
  ]);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of [...best, ...top]) {
    if (Number.isSafeInteger(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out.slice(0, limit);
}

type StoryMeta = { id: number; descendants: number };

async function readStoryMetas(services: FetchServices, ids: number[]): Promise<StoryMeta[]> {
  const metas: StoryMeta[] = [];
  for (const batch of chunk(ids, Math.max(1, env.CONCURRENCY))) {
    const items = await Promise.all(batch.map(async (id) => await fetchItem(services, id)));
    for (const item of items) {
      if (item === undefined || item.type !== "story") {
        continue;
      }
      const descendants = typeof item.descendants === "number" ? item.descendants : 0;
      if (descendants >= 3 && Array.isArray(item.kids) && item.kids.length > 0) {
        metas.push({ id: item.id, descendants });
      }
    }
  }
  return metas;
}

/**
 * Pick which threads to fetch trees for: take the densest discussions outright (their
 * 40-comment threads produce the largest prompts, i.e. the near-production-limit inputs
 * the plan wants to stress), then spread the remainder evenly across the comment-count
 * spectrum so medium and short sizes are also represented.
 */
function pickCandidateIds(metas: StoryMeta[], want: number): number[] {
  const sorted = [...metas].sort((a, b) => b.descendants - a.descendants);
  if (sorted.length <= want) {
    return sorted.map((meta) => meta.id);
  }
  const denseTake = Math.min(sorted.length, Math.ceil(want * 0.6));
  const picked = new Set<number>(sorted.slice(0, denseTake).map((meta) => meta.id));
  const rest = sorted.slice(denseTake);
  const spreadWant = want - picked.size;
  for (let index = 0; index < spreadWant && rest.length > 0; index += 1) {
    const position = Math.min(rest.length - 1, Math.round((index * (rest.length - 1)) / Math.max(1, spreadWant - 1)));
    const meta = rest[position];
    if (meta !== undefined) {
      picked.add(meta.id);
    }
  }
  // Backfill any collisions from the sparse end so we still fetch `want` trees.
  for (let index = rest.length - 1; index >= 0 && picked.size < want; index -= 1) {
    const meta = rest[index];
    if (meta !== undefined) {
      picked.add(meta.id);
    }
  }
  return [...picked];
}

async function buildCandidate(services: FetchServices, id: number): Promise<Candidate | undefined> {
  const item = await fetchItem(services, id);
  if (item === undefined || item.type !== "story") {
    return undefined;
  }
  const story = normalizeStory(item);
  const rootIds = Array.isArray(story.commentIds) ? story.commentIds : [];
  if (rootIds.length === 0) {
    return undefined;
  }
  const { comments } = await collectComments(services, rootIds, {
    maxDepth: env.MAX_DEPTH,
    maxCount: env.MAX_COMMENTS_PER_STORY,
    concurrency: Math.max(1, env.CONCURRENCY),
    seenByDepth: {},
  });
  if (comments.length < 3) {
    return undefined;
  }
  const fixture: CommentsBenchFixture = {
    story: { id: story.id, title: story.title, url: story.url },
    comments,
  };
  const prepared = buildCommentsPromptV2({
    story: { id: story.id, title: story.title },
    comments,
    language: env.SUMMARY_LANG,
    maxChars: env.COMMENTS_PROMPT_MAX_CHARS,
  });
  const truncated = prepared.droppedIds.length > 0;
  return {
    fixture,
    fetchedISO: new Date().toISOString(),
    includedComments: prepared.sampleIds.length,
    totalComments: comments.length,
    droppedComments: prepared.droppedIds.length,
    promptChars: prepared.prompt.length,
    truncated,
    sizeBucket: sizeBucket(prepared.prompt.length, truncated, env.COMMENTS_PROMPT_MAX_CHARS),
    technicalScore: technicalScore(comments),
    contestedScore: contestedScore(comments),
  };
}

function percentileThreshold(values: number[], fraction: number): number {
  if (values.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((1 - fraction) * sorted.length));
  return sorted[index] ?? Number.POSITIVE_INFINITY;
}

type Tagged = Candidate & { isTechnical: boolean; isContested: boolean };

function tagCandidates(candidates: Candidate[]): Tagged[] {
  // Top ~35% of each score become the tag pool; final counts are enforced by selection.
  const techThreshold = percentileThreshold(candidates.map((c) => c.technicalScore), 0.35);
  const contestedThreshold = percentileThreshold(candidates.map((c) => c.contestedScore), 0.35);
  return candidates.map((candidate) => ({
    ...candidate,
    isTechnical: candidate.technicalScore >= techThreshold && candidate.technicalScore > 0,
    isContested: candidate.contestedScore >= contestedThreshold && candidate.contestedScore > 0,
  }));
}

type Deficits = { long: number; medium: number; short: number; technical: number; contested: number };

function fillCount(candidate: Tagged, deficits: Deficits): number {
  let filled = 0;
  if (deficits[candidate.sizeBucket] > 0) {
    filled += 1;
  }
  if (candidate.isTechnical && deficits.technical > 0) {
    filled += 1;
  }
  if (candidate.isContested && deficits.contested > 0) {
    filled += 1;
  }
  return filled;
}

/**
 * Greedy multi-objective selection: repeatedly take the candidate that fills the most
 * still-unmet quotas (size bucket + technical + contested), tie-broken by combined
 * technical/contested score, until `count` fixtures are chosen. Records what it could
 * not satisfy rather than silently truncating.
 */
function select(tagged: Tagged[], count: number): { chosen: Tagged[]; unmet: string[] } {
  const deficits: Deficits = {
    long: SIZE_TARGETS.long,
    medium: SIZE_TARGETS.medium,
    short: SIZE_TARGETS.short,
    technical: MIN_TECHNICAL,
    contested: MIN_CONTESTED,
  };
  const remaining = [...tagged];
  const chosen: Tagged[] = [];

  while (chosen.length < count && remaining.length > 0) {
    remaining.sort((a, b) => {
      const fill = fillCount(b, deficits) - fillCount(a, deficits);
      if (fill !== 0) {
        return fill;
      }
      return b.technicalScore + b.contestedScore - (a.technicalScore + a.contestedScore);
    });
    const next = remaining.shift();
    if (next === undefined) {
      break;
    }
    chosen.push(next);
    deficits[next.sizeBucket] = Math.max(0, deficits[next.sizeBucket] - 1);
    if (next.isTechnical) {
      deficits.technical = Math.max(0, deficits.technical - 1);
    }
    if (next.isContested) {
      deficits.contested = Math.max(0, deficits.contested - 1);
    }
  }

  const unmet: string[] = [];
  for (const [key, value] of Object.entries(deficits)) {
    if (value > 0) {
      unmet.push(`${key} short by ${value}`);
    }
  }
  return { chosen, unmet };
}

/**
 * Assign display tags across the SELECTED set. Because HN best/top is uniformly
 * technical and argumentative, a blanket threshold tags almost everything; instead we
 * mark the strongest representatives (top `TAG_REPRESENTATIVES` by each score, always
 * >= the plan's minimums) so the cohort tags are discriminating and auditable.
 * `near-limit` marks threads that used the full production comment budget (the real
 * input ceiling) or whose prompt approaches the char cap.
 */
const TAG_REPRESENTATIVES = 6;

function finalizeTags(chosen: Tagged[]): SelectedFixtureMeta[] {
  const byTech = new Set(
    [...chosen].sort((a, b) => b.technicalScore - a.technicalScore).slice(0, TAG_REPRESENTATIVES).map((c) => c.fixture.story.id)
  );
  const byContested = new Set(
    [...chosen].sort((a, b) => b.contestedScore - a.contestedScore).slice(0, TAG_REPRESENTATIVES).map((c) => c.fixture.story.id)
  );
  const charLimit = 0.8 * env.COMMENTS_PROMPT_MAX_CHARS;
  return chosen.map((candidate) => {
    const { story } = candidate.fixture;
    const { id, title } = story;
    const nearLimit =
      candidate.truncated ||
      candidate.includedComments >= env.MAX_COMMENTS_PER_STORY ||
      candidate.promptChars >= charLimit;
    const tags: string[] = [candidate.sizeBucket];
    if (byTech.has(id)) {
      tags.push("technical");
    }
    if (byContested.has(id)) {
      tags.push("contested");
    }
    if (nearLimit) {
      tags.push("near-limit");
    }
    return {
      id,
      title,
      fetchedISO: candidate.fetchedISO,
      includedComments: candidate.includedComments,
      totalComments: candidate.totalComments,
      droppedComments: candidate.droppedComments,
      promptChars: candidate.promptChars,
      truncated: candidate.truncated,
      sizeBucket: candidate.sizeBucket,
      tags,
      technicalScore: Number(candidate.technicalScore.toFixed(4)),
      contestedScore: Number(candidate.contestedScore.toFixed(4)),
    };
  });
}

function parseArgs(argv: string[]): Options {
  const options: Options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === undefined) {
      continue;
    }
    switch (arg) {
      case "--overwrite": {
        options.overwrite = true;
        break;
      }
      case "--output-dir": {
        if (value === undefined) {throw new Error("--output-dir requires a path");}
        options.outputDir = value;
        index += 1;
        break;
      }
      case "--manifest": {
        if (value === undefined) {throw new Error("--manifest requires a path");}
        options.manifestPath = value;
        index += 1;
        break;
      }
      case "--count": {
        if (value === undefined) {throw new Error("--count requires a number");}
        options.count = Number(value);
        index += 1;
        break;
      }
      case "--pool-limit": {
        if (value === undefined) {throw new Error("--pool-limit requires a number");}
        options.poolLimit = Number(value);
        index += 1;
        break;
      }
      case "--candidate-trees": {
        if (value === undefined) {throw new Error("--candidate-trees requires a number");}
        options.candidateTrees = Number(value);
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

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

export async function fetchRealCommentsCorpus(options: Options): Promise<{
  chosen: SelectedFixtureMeta[];
  unmet: string[];
}> {
  const services = makeServices(env);
  process.stderr.write(`Reading HN best+top pool (limit ${options.poolLimit})...\n`);
  const poolIds = await readPoolIds(services, options.poolLimit);
  process.stderr.write(`Pool: ${poolIds.length} ids. Reading story metadata...\n`);
  const metas = await readStoryMetas(services, poolIds);
  process.stderr.write(`Usable stories (>=3 comments): ${metas.length}. Fetching threads...\n`);

  const candidateIds = pickCandidateIds(metas, options.candidateTrees);
  const candidates: Candidate[] = [];
  for (const batch of chunk(candidateIds, Math.max(1, env.CONCURRENCY))) {
    const built = await Promise.all(batch.map(async (id) => await buildCandidate(services, id)));
    for (const candidate of built) {
      if (candidate !== undefined) {
        candidates.push(candidate);
      }
    }
    process.stderr.write(`  built ${candidates.length} candidate threads...\n`);
  }

  if (candidates.length < options.count) {
    throw new Error(
      `Only ${candidates.length} usable candidate threads; need ${options.count}. Raise --pool-limit / --candidate-trees.`
    );
  }

  const tagged = tagCandidates(candidates);
  const { chosen, unmet } = select(tagged, options.count);
  if (chosen.length < options.count) {
    throw new Error(`Selected only ${chosen.length}/${options.count} fixtures.`);
  }

  // Freeze fixtures. Refuse to clobber an existing corpus unless --overwrite.
  await mkdir(options.outputDir, { recursive: true });
  const targets = chosen.map((candidate) => ({
    candidate,
    path: resolve(options.outputDir, `${candidate.fixture.story.id}.json`),
  }));
  if (!options.overwrite) {
    const existing = (
      await Promise.all(targets.map(async (t) => ((await pathExists(t.path)) ? t.path : undefined)))
    ).filter((path): path is string => path !== undefined);
    if (existing.length > 0) {
      throw new Error(`Refusing to overwrite existing fixtures (pass --overwrite): ${existing.join(", ")}`);
    }
  }
  await Promise.all(targets.map(async (t) => { await writeFile(t.path, jsonText(t.candidate.fixture), "utf8"); }));

  const chosenMeta = finalizeTags(chosen);
  const distribution = {
    long: chosenMeta.filter((f) => f.sizeBucket === "long").length,
    medium: chosenMeta.filter((f) => f.sizeBucket === "medium").length,
    short: chosenMeta.filter((f) => f.sizeBucket === "short").length,
    technical: chosenMeta.filter((f) => f.tags.includes("technical")).length,
    contested: chosenMeta.filter((f) => f.tags.includes("contested")).length,
    nearLimit: chosenMeta.filter((f) => f.tags.includes("near-limit")).length,
    maxPromptChars: Math.max(...chosenMeta.map((f) => f.promptChars)),
  };
  const manifest = {
    version: 1,
    kind: "candidate-eval-real-hn",
    generatedAtISO: new Date().toISOString(),
    note: "Frozen real public HN comment threads for the baseline-vs-candidate comments eval. postTldr intentionally omitted (comment-summary quality is isolated from article-summary quality).",
    source: {
      api: "https://hacker-news.firebaseio.com/v0",
      pools: ["beststories", "topstories"],
      poolIdsConsidered: poolIds.length,
      usableStories: metas.length,
      candidateThreadsFetched: candidates.length,
    },
    normalization: {
      maxDepth: env.MAX_DEPTH,
      maxCommentsPerStory: env.MAX_COMMENTS_PER_STORY,
      maxBodyChars: env.MAX_BODY_CHARS,
      promptMaxChars: env.COMMENTS_PROMPT_MAX_CHARS,
      summaryLang: env.SUMMARY_LANG,
    },
    sizeTargets: SIZE_TARGETS,
    minTechnical: MIN_TECHNICAL,
    minContested: MIN_CONTESTED,
    distribution,
    unmetTargets: unmet,
    commentThreadIds: chosenMeta.map((f) => f.id),
    commentEdgeThreadIds: [] as number[],
    fixtures: chosenMeta,
  };
  await writeFile(options.manifestPath, jsonText(manifest), "utf8");
  return { chosen: chosenMeta, unmet };
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    const { chosen, unmet } = await fetchRealCommentsCorpus(parseArgs(process.argv.slice(2)));
    const dist = {
      long: chosen.filter((f) => f.sizeBucket === "long").length,
      medium: chosen.filter((f) => f.sizeBucket === "medium").length,
      short: chosen.filter((f) => f.sizeBucket === "short").length,
      technical: chosen.filter((f) => f.tags.includes("technical")).length,
      contested: chosen.filter((f) => f.tags.includes("contested")).length,
      nearLimit: chosen.filter((f) => f.tags.includes("near-limit")).length,
    };
    process.stdout.write(`\nWrote ${chosen.length} real HN comment fixtures.\n`);
    process.stdout.write(`Distribution: ${JSON.stringify(dist)}\n`);
    if (unmet.length > 0) {
      process.stdout.write(`Unmet targets: ${unmet.join("; ")}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
