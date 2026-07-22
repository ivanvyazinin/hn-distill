# Runbook: Qwen 27b comments secondary-hop rollout (Phase 4)

**Audience:** on-call / pipeline owner  
**Scope:** limited production enable of `qwen/qwen3.6-27b` as the **medium** Groq second hop after `llama-3.3-70b-versatile`.  
**Status:** procedure only — defaults stay OFF until you set Worker/env vars.

## Preconditions

- [ ] Phase 3 scaffold on the deployed commit (`COMMENTS_QWEN27B_*` env keys exist).
- [ ] Phase 2 paired eval PASS **or** explicit product waiver (this branch waived Phase 2 after practical Phase 1 smoke).
- [ ] `LLM_USAGE_ENABLED=true` so `llm_usage` rows capture gateway/model/tokens.
- [ ] You can edit Worker secrets/vars and redeploy within minutes (rollback path).
- [ ] Know how to pull last-N-hours usage (`bun run data:usage-stats` / D1 `llm_usage` / Loki `summarize/comments`).

## What the flags do

| Var | Default | Effect |
|---|---|---|
| `COMMENTS_QWEN27B_ROUTE_ENABLE` | `false` | Master switch. Off → always legacy `70b → 8b → paid`. |
| `COMMENTS_QWEN27B_ROUTE_SHARE` | `0` | % of stories (by `storyId % 100 < share`) that may take the **size-aware** path. **Enable + share 0 = still legacy** (safe). |
| Size path (only if enable ∧ share hit) | — | short → 8b; medium → Qwen 27b (`reasoning_effort=none`, `temperature=0`); large → skip free secondary → paid. |
| 70b primary | unchanged | High-value first hop always `COMMENTS_MODEL`. |

Deterministic sample: story `109` with share `10` → bucket `9` → **hit**; story `110` → bucket `10` → **miss**.

## Rollout steps

### 1. Baseline window (before flip)

Record for the previous **8 hourly runs** (or last 8h if hourly cron):

- comments summaries written / `generation-failed` / too-few
- `llm_usage` calls+tokens by model for label `comments` (70b, 8b, paid OpenRouter Qwen)
- 413 / TPM 429 / TPD 429 counts (Loki + provider dashboard)
- p95 comments latency if available
- paid OpenRouter comments tokens

Keep the snapshot in the rollout notes (date, commit SHA, numbers).

### 2. Enable limited share

Suggested first knobs:

```text
COMMENTS_QWEN27B_ROUTE_ENABLE=true
COMMENTS_QWEN27B_ROUTE_SHARE=10
```

Deploy Worker/pipeline with those vars. Do **not** change `COMMENTS_MODEL` / paid fallback.

### 3. After each of 8 scheduled runs

Fill one row per run:

| Run | UTC | SHA | written | failed/fallback | qwen27b calls | 70b | 8b | paid | 413 | TPM429 | TPD429 | p95 | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| … |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 8 |  |  |  |  |  |  |  |  |  |  |  |  |  |

**How to collect**

- **Planned secondary only:** `Comments-v2 secondary route selected` → `kind`, `reason`, `shareBucket`, `storyId`.  
  This is the hop *after* primary 70b. It does **not** mean that model ran.  
  `kind=medium-qwen` ≈ share% of medium-sized *plans*, not of all stories and not of actual calls.
- **Actual winner:** `Comments-v2 summary written` → `model`. If this is still 70b, secondary never executed.
- **Qwen proof (all three required):**  
  1) route `kind=medium-qwen`  
  2) `llm_usage` gateway=groq model=`qwen/qwen3.6-27b` label=comments  
  3) summary written `model=qwen/qwen3.6-27b`
- Usage: `llm_usage` where `label=comments`  
  - Groq `llama-3.3-70b-versatile` = primary (most successes stop here)  
  - Groq `qwen/qwen3.6-27b` = candidate secondary  
  - Groq `llama-3.1-8b-instant` = short/legacy second  
  - OpenRouter paid model = last resort
- TPD breaker: `Comments-v2 marking model TPD-exhausted` / `skipping TPD-exhausted model`
- Validation: no spike in `generation-failed`, empty cards, or EN (`low_cyrillic_ratio`) on comments.

### 4. Immediate rollback triggers

Set enable false **and** share 0, redeploy, if **any**:

1. Provenance / quote scandals spike (manual: wrong attributed quotes on site), or systematic quote-drop + bad synthesis.
2. Comments validated / applied rate **&lt; 95%** of pre-rollout baseline for the same window shape.
3. RU language gate fails worse than baseline (EN prose on RU site).
4. Comments p95 **&gt; request deadline** on **two consecutive** runs.
5. Unexpected 413 burst on Qwen (estimate margin failed) or TPD thrash without breaker skip.
6. Paid OpenRouter comments tokens **up** vs baseline without a matching free-quota outage explanation.

Rollback env:

```text
COMMENTS_QWEN27B_ROUTE_ENABLE=false
COMMENTS_QWEN27B_ROUTE_SHARE=0
```

### 5. After 8 clean runs

Compare to baseline:

- paid comments tokens ↓ or flat with better free coverage  
- freshness / pending age not worse  
- error rate not worse  

Only then consider raising share (e.g. 10 → 25 → 50) or making size-aware path default (`SHARE=100` with enable on). **Do not** remove 70b primary in this phase.

## Out of scope / known limits

- Cross-queue-batch TPD memory: each CF queue batch starts a fresh breaker Set.
- Phase 1 smoke had 2/12 provenance soft-fails on one contested story; watch quote quality on Gemini/pricing threads.
- No separate freshness-SLA change for paid hop in this rollout.
- `gpt-oss-120b` is **not** in this route.

## Related

- Plan: `docs/plan-cheap-groq-comments-route.md` (Phase 4)
- Scaffold handoff: `docs/handoff-comments-candidate-eval-phase3.md`
- Code: `selectCommentsSecondaryRoute`, `isCommentsQwen27bShareHit` in `pipeline/summarize.ts`
