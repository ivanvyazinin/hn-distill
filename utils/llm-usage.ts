/**
 * Per-attempt LLM usage accounting. Every upstream LLM call (post/comments/tags/guard)
 * emits one compact event with tokens + the model/gateway that actually served it. The
 * collector is scoped to a single story via setStory(); processSingleStory drains it in a
 * finally block and persists the rows through MetaStore.insertLlmUsage.
 *
 * Cost and latency are intentionally out of scope (the same hook can add them later).
 */

export type LlmUsageEvent = {
  createdAt: string; // ISO, stamped in record()
  storyId?: number; // from scope, stamped in record()
  label: string; // "post" | "comments" | "tags" | "guard"
  gateway: string; // "openrouter" | "groq"
  modelRequested: string;
  modelUsed?: string; // response.model (fallback-aware)
  attempt?: number; // structured retry index
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  status: "error" | "ok";
};

/** What a call site emits; createdAt + storyId are stamped by the collector. */
export type UsageInput = Omit<LlmUsageEvent, "createdAt" | "storyId">;

export type UsageSink = (event: UsageInput) => void;

export type UsageCollector = {
  /** Stamp createdAt + storyId and buffer. Drops the event when no story scope is active. */
  record: UsageSink;
  setStory: (id?: number) => void;
  drain: () => LlmUsageEvent[];
  size: () => number;
};

export function createUsageCollector(): UsageCollector {
  let storyId: number | undefined;
  let events: LlmUsageEvent[] = [];

  return {
    record(event: UsageInput): void {
      // No active story scope → drop. This narrows the promise to "LLM calls in the
      // per-story pipeline": processSingleStory always setStory() first, while
      // maintenance scripts / eval that call the LLM directly are intentionally not
      // accounted for (no leak, no orphan rows).
      if (storyId === undefined) {
        return;
      }
      events.push({
        ...event,
        createdAt: new Date().toISOString(),
        storyId,
      });
    },
    setStory(id?: number): void {
      storyId = id;
    },
    drain(): LlmUsageEvent[] {
      const drained = events;
      events = [];
      return drained;
    },
    size(): number {
      return events.length;
    },
  };
}
