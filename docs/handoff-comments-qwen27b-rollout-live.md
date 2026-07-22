# Live rollout: Qwen 27b comments secondary hop

**Started:** 2026-07-22T11:02Z  
**PR:** https://github.com/ivanvyazinin/hn-distill/pull/25 (merged `92d1f7d06d`)  
**Path:** GitHub Actions `hourly-build` (primary prod pipeline)

## Live knobs

| Var | Value |
|---|---|
| `COMMENTS_QWEN27B_ROUTE_ENABLE` | **true** |
| `COMMENTS_QWEN27B_ROUTE_SHARE` | **10** |
| `LLM_USAGE_ENABLED` | true (pre-existing) |

```bash
gh variable set COMMENTS_QWEN27B_ROUTE_ENABLE -R ivanvyazinin/hn-distill --body true
gh variable set COMMENTS_QWEN27B_ROUTE_SHARE -R ivanvyazinin/hn-distill --body 10
```

## Rollback

```bash
gh variable set COMMENTS_QWEN27B_ROUTE_ENABLE -R ivanvyazinin/hn-distill --body false
gh variable set COMMENTS_QWEN27B_ROUTE_SHARE -R ivanvyazinin/hn-distill --body 0
```

## How to read logs (do not mis-count)

`Comments-v2 secondary route selected` logs the **planned secondary free hop only** (after primary 70b is already queued). It does **not** mean that model was called.

Chain order (`pipeline/summarize.ts`):

1. **Primary always:** `COMMENTS_MODEL` (`llama-3.3-70b-versatile`)
2. **Secondary (size/share):** 8b / Qwen / skip — what the log’s `kind` + `model` describe
3. **Paid OpenRouter** last resort

`Comments-v2 summary written` → `model` is the **actual winner**. If primary succeeds, secondary never runs.

### Qwen proof requires all three

1. route log: `kind=medium-qwen` (share hit + medium reserved)
2. `llm_usage`: gateway `groq` + model `qwen/qwen3.6-27b` (label `comments`)
3. summary written: `model=qwen/qwen3.6-27b`

Until (2)+(3), do **not** treat a run as Qwen quality/cost/latency evidence.

## Run log

### Run 1 — 2026-07-22T11:03Z (workflow_dispatch)

- URL: https://github.com/ivanvyazinin/hn-distill/actions/runs/29914235102  
- Result: **success**  
- Env in job: ENABLE=true, SHARE=10 ✓  

**What this run proves**

- Repo vars wired into hourly-build ✓  
- Share bucketing live: story `48999291` → `shareBucket=91` → `reason=share-miss-legacy-8b` (91 ≥ 10) ✓  
- Secondary **plan** for that story: `kind=legacy`, planned fallback model `llama-3.1-8b-instant`, `reservedTokens=6197` (medium band — would plan Qwen **only if** share hit)

**What this run does *not* prove**

- Qwen was **not** called  
- 8b was **not** called  
- Actual summary: **`model=llama-3.3-70b-versatile`** (primary succeeded; secondary unused)  
- Not a quality / cost / latency / secondary-hop sample

| Run | UTC | written | actual model(s) | route kind | qwen proof? | notes |
|---|---|---|---|---|---|---|
| 1 | 11:03 | 1 | 70b only | legacy / share-miss (plan only) | **no** | vars+bucket only |
| 2 |  |  |  |  |  |  |
| … |  |  |  |  |  | need real secondary / qwen hits |
| 8 |  |  |  |  |  |  |

## Next

1. Scheduled hourlies (`0 */3 * * *`) or dispatch when 70b TPD/fail forces secondary, **or** when share hit + primary fails — otherwise Qwen stays dark.
2. Per run grep:
   - `secondary route selected` → plan (`kind`, `shareBucket`)
   - `summary written` → **actual** `model`
   - `llm_usage` / usage-stats for `qwen/qwen3.6-27b`
3. Count Qwen only when the three-part proof above holds.
4. Rollback: runbook `docs/runbook-comments-qwen27b-rollout.md`.

## CF Worker note

`wrangler.toml` still ENABLE=false SHARE=0. Actions hourly is the live path for `make run`. If Worker summarize is also enabled in prod, set the same vars in CF dashboard separately.
