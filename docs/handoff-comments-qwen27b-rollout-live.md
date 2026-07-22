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

## Run log

### Run 1 — 2026-07-22T11:03Z (workflow_dispatch)

- URL: https://github.com/ivanvyazinin/hn-distill/actions/runs/29914235102  
- Result: **success**  
- Env in job: ENABLE=true, SHARE=10 ✓  
- Candidates: 5 selected (all also engagement-gate-skipped for some path; 5 processed)  
- **Comments-v2 generations observed: 1**
  - story `48999291`
  - route: `kind=legacy`, `reason=share-miss-legacy-8b`
  - `shareBucket=91` (91 ≥ 10 → miss) ✓ deterministic sample works
  - `reservedTokens=6197` (medium band: would have been Qwen **if** share hit)
  - `model=llama-3.1-8b-instant` second hop
  - summary **written** (no failure)
- **Qwen 27b calls this run: 0** (expected at 10% with n=1 medium attempt)
- No 413 / TPD / EN spike in this thin sample

| Run | UTC | written | qwen27b | share-miss | short-8b | large-skip | fails | notes |
|---|---|---|---|---|---|---|---|---|
| 1 | 11:03 | 1 | 0 | 1 | 0 | 0 | 0 | first live; sample miss |
| 2 |  |  |  |  |  |  |  |  |
| … |  |  |  |  |  |  |  | need 8 runs **with** comments work |
| 8 |  |  |  |  |  |  |  |  |

## Next

1. Wait for scheduled hourlies (cron `0 */3 * * *`) or dispatch when queue has real comments work.
2. Grep each run: `Comments-v2 secondary route selected` + `summary written`.
3. Expect ~10% of **share-eligible medium** attempts → `medium-qwen` (not 10% of all stories).
4. Fill table; rollback per `docs/runbook-comments-qwen27b-rollout.md` if triggers fire.

## CF Worker note

`wrangler.toml` still ENABLE=false SHARE=0. Actions hourly is the live path for `make run`. If Worker summarize is also enabled in prod, set the same vars in CF dashboard separately.
