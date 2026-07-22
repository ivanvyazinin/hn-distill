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

| Run | UTC | written | actual model(s) | route plan | qwen proof? | notes |
|---|---|---|---|---|---|---|
| 1 | 11:03 | 1 | 70b only | share-miss plan | **no** | vars+bucket only |
| 2 | 11:55 | 5 | 70b×1, 8b×1, paid×3 | share-miss×5 | **no** | TPD breaker+8b secondary OK; 0 share hits |
| … |  |  |  |  |  | need `kind=medium-qwen` + written qwen3.6 |
| 8 |  |  |  |  |  |  |

### Run 2 — 2026-07-22T11:55Z (workflow_dispatch)

- URL: https://github.com/ivanvyazinin/hn-distill/actions/runs/29917558728  
- Result: **success**  
- Env: ENABLE=true, SHARE=10 ✓  
- Comments written: **5/5** (no generation-failed)

| story | bucket | plan kind/reason | reserved | chain (actual) | written model |
|---:|---:|---|---:|---|---|
| 48999291 | 91 | legacy / share-miss | 6222 | 70b OK | `llama-3.3-70b-versatile` |
| 48997548 | 48 | legacy / share-miss | 7369 | 70b **TPD 429** → 8b **413** → paid | `qwen/qwen3-next-80b-a3b-instruct` |
| 48996652 | 52 | legacy / share-miss | 5941 | 70b **TPD skip** → **8b OK** | `llama-3.1-8b-instant` |
| 48996571 | 71 | legacy / share-miss | 6425 | 70b skip → 8b **TPM 429** → paid | `qwen/qwen3-next-80b-a3b-instruct` |
| 48996318 | 18 | legacy / share-miss | 5824 | 70b skip → 8b **TPM 429** → paid | `qwen/qwen3-next-80b-a3b-instruct` |

**Proved this run**

- Share sampling: 5/5 miss (buckets 91,48,52,71,18 — all ≥10). At SHARE=10, E[hits]≈0.5 on n=5 → 0 hits plausible.
- All five plans were **medium band** (reserved 5.8k–7.4k): on a share **hit** they would have planned `medium-qwen`, not 8b.
- **TPD breaker works:** after 70b TPD on 48997548, later stories log `skipping TPD-exhausted model` `groq::llama-3.3-70b-versatile`.
- **Secondary hop actually ran:** 48996652 written model = `llama-3.1-8b-instant` (not plan-only).
- 8b still blows up on medium-large: 413 once, TPM 429 twice → paid OpenRouter — the pain Qwen medium hop is meant to absorb **when share hits**.

**Still not proved**

- `kind=medium-qwen` never logged  
- zero `qwen/qwen3.6-27b` calls / writes  
- Qwen three-part proof: **fail**

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
