import type { AggregatedItem, NormalizedStory } from "@config/schemas";
import type { LlmUsageEvent } from "@utils/llm-usage";

import type { D1DatabaseLike } from "../worker/src/bindings";

export type ProcessingStatus = "ok" | "missing" | "error";

export type SummaryKind = "post" | "comments";

export type SummaryRow = {
  storyId: number;
  kind: SummaryKind;
  lang: string;
  model?: string;
  summary: string;
  createdAt: string;
};

export type RawBlobKind = "item" | "comments" | "article";

export type RawBlobRow = {
  storyId: number;
  kind: RawBlobKind;
  ref: string;
  sha256?: string;
  sizeBytes?: number;
  fetchedAt?: string;
};

export type ArticleExtractRow = {
  storyId: number;
  status: string;
  /** how the source was fetched/parsed: "html" | "pdf" | "youtube" | "text" | "empty" */
  sourceKind?: string;
  charCount?: number;
  rawArticleRef?: string;
  fetchedAt?: string;
};

export type DailyRankingRow = {
  day: string;
  storyId: number;
  rank: number;
  score?: number;
  mode?: string;
};

export type TelegramLedgerSnapshot = {
  sentIds: number[];
  lastUpdatedISO?: string;
};

/** One persisted per-attempt LLM usage row (mirrors the in-memory event 1:1). */
export type LlmUsageRow = LlmUsageEvent;

/** Aggregated per-day/gateway/label/model usage for the CLI report. */
export type LlmUsageSummaryRow = {
  day: string;
  gateway: string;
  label: string;
  modelRequested: string;
  modelUsed: string | null;
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ProcessingStateUpdate = {
  postStatus: ProcessingStatus;
  commentsStatus: ProcessingStatus;
  commentsPolicyVersion?: string;
  commentsInputHash?: string;
  tagsStatus: ProcessingStatus;
  updatedAt: string;
  error?: string | null;
};

export interface MetaStore {
  migrate(): Promise<void>;

  upsertStory(story: NormalizedStory, rank: number, fetchedISO: string): Promise<void>;
  listStoryIdsForAggregate(minScore: number): Promise<number[]>;
  getAggregatedItems(storyIds: number[]): Promise<AggregatedItem[]>;

  upsertSummary(row: SummaryRow): Promise<void>;
  replaceTags(storyId: number, tags: string[]): Promise<void>;
  upsertArticleExtract(row: ArticleExtractRow): Promise<void>;
  /** Read the persisted extract verdict for a story (used at summarize time on cache hits). */
  getArticleExtract(storyId: number): Promise<ArticleExtractRow | undefined>;
  upsertRawBlob(row: RawBlobRow): Promise<void>;
  upsertDailyRanking(row: DailyRankingRow): Promise<void>;

  upsertProcessingState(storyId: number, state: ProcessingStateUpdate): Promise<void>;

  getTelegramSentIds(ids: number[]): Promise<Set<number>>;
  markTelegramSent(storyId: number, messageId: number, sentAtISO: string): Promise<void>;
  getTelegramLedger(): Promise<TelegramLedgerSnapshot>;
  acquireRunLock(key: string, nowISO: string, ttlMs: number, owner: string): Promise<boolean>;
  listPendingStoryIds(
    limit: number,
    updatedBeforeISO: string,
    fetchedISO: string,
    desiredPolicyVersion: string
  ): Promise<number[]>;
  getProcessingUpdatedMax(): Promise<string | undefined>;
  getAggregateState(
    key: string
  ): Promise<{ indexUpdatedISO?: string | null; processingUpdatedISO?: string | null } | undefined>;
  setAggregateState(
    key: string,
    indexUpdatedISO: string,
    processingUpdatedISO: string | null,
    updatedAtISO: string
  ): Promise<void>;
  getPagesDeployState(
    key: string
  ): Promise<{ monthKey?: string | null; usedCount?: number | null; lastSlot?: string | null } | undefined>;
  setPagesDeployState(
    key: string,
    monthKey: string,
    usedCount: number,
    lastSlot: string,
    updatedAtISO: string
  ): Promise<void>;

  deleteStoriesBelowScore(minScore: number): Promise<number[]>;

  /** Append per-attempt LLM usage rows (best-effort; off the critical path). */
  insertLlmUsage(rows: LlmUsageRow[]): Promise<void>;
  /** Aggregated usage per day/gateway/label/model for the CLI report. */
  getLlmUsageSummary(): Promise<LlmUsageSummaryRow[]>;
}

export type { D1DatabaseLike };
