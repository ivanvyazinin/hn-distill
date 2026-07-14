import type { AggregatedItem, NormalizedStory } from "@config/schemas";

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

  upsertProcessingState(
    storyId: number,
    state: {
      postStatus: ProcessingStatus;
      commentsStatus: ProcessingStatus;
      tagsStatus: ProcessingStatus;
      updatedAt: string;
      error?: string | null;
    }
  ): Promise<void>;

  getTelegramSentIds(ids: number[]): Promise<Set<number>>;
  markTelegramSent(storyId: number, messageId: number, sentAtISO: string): Promise<void>;
  getTelegramLedger(): Promise<TelegramLedgerSnapshot>;
  acquireRunLock(key: string, nowISO: string, ttlMs: number, owner: string): Promise<boolean>;
  listPendingStoryIds(limit: number, updatedBeforeISO: string, fetchedISO: string): Promise<number[]>;
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
}

export type { D1DatabaseLike };