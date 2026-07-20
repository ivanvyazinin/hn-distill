# Follow-up: tags re-extract almost every run (input-hash churn)

Status: **implemented and verified** in `45b2b439b8` (`fix: stabilize tags cache against
comments-summary drift`). The original observation came from the `llm_usage` ledger after
`LLM_USAGE_ENABLED=true` on 2026-07-16.

## What was observed

In the 11:40 UTC hourly run (`llm_usage`, prod SQLite pulled from the VPS):

| label | calls | stories | note |
|---|---|---|---|
| tags | 10 | 10 | one per story, all `attempt=1`, all `ok` |
| comments | 16 | 9 | incl. 6× HTTP 429 (Groq 70b TPD) → scout fallback |
| post | 3 | 2 | article summary only for the 2 genuinely-new stories |
| guard | 2 | 2 | only where a post summary was generated |

`post` is cached across runs (the article summary lives in the `summaries` table and is
generated once), so only 2 of 10 stories triggered it. **tags fired for all 10** — including
stories whose article summary dated back to 2026-07-15. So tags recompute essentially every
run for every story in the working set.

## Root cause

Historically, `processTags` had a cache gate, but both the tag prompt and its `inputHash`
contained `commentsSummary`:

```ts
const prompt = buildTagsPrompt(story, postSummary, commentsSummary);
const inputHash = await hashString(`tags|${prompt}|${env.TAGS_MODEL}`);
```

The comments summary changes when new HN comments arrive and can also drift between equivalent
LLM responses. That changed the prompt text and hash even when the story's tag-worthy subject
had not changed, so the cache missed and tags were extracted again.

`TAGS_MODEL` also belongs in the hash. A model switch intentionally causes a one-time cache
miss because it changes the tag generator.

## Why it costs

At the time of the observation, tags used Groq `llama-4-scout-17b` through
`guardTagsClient`, sharing that model's scarce capacity with fallback work. The production
routing has since changed: tags and guard now use `openai/gpt-oss-20b`, while comments use
separate 70b/8b model quotas. Tag churn therefore no longer consumes the comments models'
per-model limits, but it still wastes the shared tags/guard TPM/TPD and increases pipeline
latency.

## Chosen fix

Use one stable and internally consistent cache contract in both the production and bulk paths:

```ts
const prompt = buildTagsPrompt(story, postSummary);
const inputHash = await hashString(buildTagsCacheMaterial(prompt, env.TAGS_MODEL));
```

The implementation follows these rules:

1. Exclude `commentsSummary` from both the prompt and the hash. Keeping it only in the prompt
   would be incorrect because the same hash could then represent different LLM inputs.
2. Build the prompt from `title`, URL/domain, and optional cached article summary.
3. Keep `TAGS_MODEL` in the cache material so a deliberate model switch invalidates tags once.
4. Share `buildTagsCacheMaterial()` between `pipeline/summarize.ts` and
   `scripts/add-tags-bulk.mts` so their cache contracts cannot drift.
5. Cache heuristic fallback output with the same hash. A provider failure therefore does not
   retry the same unchanged story every hour.

Consequently, tags recompute only when a stable input changes: title, URL/domain, article
summary, or `TAGS_MODEL`. A comments-only change does not trigger tag extraction.

### Trade-off

Tags no longer pick up a topic that appears only in a later discussion. This is intentional:
the stable story/article signal is preferred over hourly LLM churn. If discussion-derived tags
become a product requirement, add a separate explicitly scheduled enrichment pass rather than
putting volatile comments back into the hourly cache key.

## Verification

Automated coverage:

- `tests/tags.test.ts` checks the prompt and shared cache material contract.
- `tests/summarize.tags-cache.test.ts` proves that comments drift does not cause another tag
  call, while title, URL/domain, and model changes do invalidate the cache.

Production rollout evidence:

- Run `29733829540` wrote tags for all 10 stories during the one-time model/cache transition.
- The next run, `29735222938`, wrote **0 tags** for the overlapping working set: existing hashes
  matched and the cache gate skipped the LLM calls.

## Related

- `utils/tags-extract.ts` — stable prompt and shared cache material.
- `pipeline/summarize.ts` — production cache gate.
- `scripts/add-tags-bulk.mts` — bulk path using the same cache contract.
- `tests/summarize.tags-cache.test.ts` — cache invalidation integration coverage.
- `config/env.ts` — current tags and comments model defaults.
- `docs/handoff-hourly-llm-fallbacks.md` — current LLM routing and rollout context.
