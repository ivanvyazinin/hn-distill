import type { CommentsPolicyState, MetaStore, TelegramLedgerSnapshot } from "@utils/meta-store";

const noop = async (): Promise<void> => {
  // Intentional: absence of persistence must not produce side effects.
  await Promise.resolve();
};

/**
 * Absence-of-persistence store: every write is a silent no-op, every read
 * returns an empty result. Passing it instead of `undefined` lets pipeline code
 * call metaStore.* unconditionally instead of branching on optionality —
 * decisions must not change when persistence is absent, only side effects.
 *
 * Callers that need to distinguish a REAL store from its absence (e.g. the
 * aggregate DB branch, legacy-cache refetch decisions) must check the optional
 * parameter itself before normalizing.
 */
export function createNoopMetaStore(): MetaStore {
  return {
    migrate: noop,

    upsertStory: noop,
    listStoryIdsForAggregate: async (): Promise<number[]> => [],
    getAggregatedItems: async (): Promise<never[]> => [],

    upsertSummary: noop,
    replaceTags: noop,
    upsertArticleExtract: noop,
    getArticleExtract: async (): Promise<undefined> => undefined,
    upsertRawBlob: noop,
    upsertDailyRanking: noop,

    upsertProcessingState: noop,

    getTelegramSentIds: async (): Promise<Set<number>> => new Set<number>(),
    markTelegramSent: noop,
    getTelegramLedger: async (): Promise<TelegramLedgerSnapshot> => ({ sentIds: [] }),
    acquireRunLock: async (): Promise<boolean> => true,
    listPendingStoryIds: async (): Promise<number[]> => [],
    getProcessingUpdatedMax: async (): Promise<undefined> => undefined,
    getAggregateState: async (): Promise<undefined> => undefined,
    setAggregateState: noop,
    getPagesDeployState: async (): Promise<undefined> => undefined,
    setPagesDeployState: noop,

    deleteStoriesBelowScore: async (): Promise<number[]> => [],

    insertLlmUsage: noop,
    getLlmUsageSummary: async (): Promise<never[]> => [],

    getCommentsPolicyState: async (): Promise<CommentsPolicyState | undefined> => undefined,
    getCommentsPolicyStates: async (): Promise<Map<number, CommentsPolicyState>> =>
      new Map<number, CommentsPolicyState>(),
  };
}
