# Handoff: comments candidate eval — Phase 3 scaffold

**Branch:** `feat/comments-candidate-eval`  
**Status:** scaffold committed, **flag DEFAULT OFF**. Not a production rollout.

## Waiver / prerequisites

- Phase 2 paired eval vs 70b **not run** (70b TPD exhausted by pipeline; user skipped to Phase 3).
- Phase 1 live smoke: qwen 12/12 validated, p95 ~3.5s, **2 provenance soft-fails** on story `48993414` (quote rewrite / NBSP spacing; summary kept). Gate formal FAIL, practically usable.
- User accepted practical OK and asked to proceed to Phase 3 feature-flag routing.

## What landed

| Piece | Detail |
|---|---|
| Flag | `COMMENTS_QWEN27B_ROUTE_ENABLE=false` (opt-in) |
| Model | `COMMENTS_QWEN27B_MODEL=qwen/qwen3.6-27b` |
| Caps | `COMMENTS_SHORT_ROUTE_MAX_RESERVED_TOKENS=5500`, `COMMENTS_QWEN27B_MAX_RESERVED_TOKENS=8000` |
| Estimate | `ceil((system+user chars)/4) + COMMENTS_ROUTE_TOKEN_ESTIMATE_MARGIN(600)` + maxOut |
| Chain (flag off) | 70b → 8b → paid OpenRouter (unchanged) |
| Chain (flag on) | 70b → size-pick(8b \| qwen \| skip) → paid OpenRouter |
| Qwen call | `reasoningEffort: "none"`, **temperature 0** (smoke parity), balanced-object JSON |
| TPD breaker | gateway-prefixed keys `groq::modelId` on shared `Set`; Worker injects one Set per inline run / queue batch |
| SLA | **Not invented.** Paid hop timing unchanged. |

### Review fixes (post-scaffold)

1. **P1 Worker scope:** `handleSummarizeTask` no longer relies on per-story `makeServices()` isolation for TPD — inline cron + queue batch pass a shared `commentsTpdExhaustedModels` Set into `makeServices({ commentsTpdExhaustedModels })`. Cross-batch persistence still out of scope (new batch starts clean).
2. **P2 Gateway key:** breaker keys are `groq::${model}`; OpenRouter steps never read/write them — colliding paid model ids stay reachable.
3. **P2 Temperature:** medium-qwen hop uses `temperature: 0` (Phase 1 smoke); llama hops keep `0.2`.
4. **P2 Estimate margin:** system prompt counted + `COMMENTS_ROUTE_TOKEN_ESTIMATE_MARGIN=600`; borderline 5k-user fixture now large-skips under 8k cap.

## Files

- `config/env.ts`, `.env.example`
- `pipeline/summarize.ts` — `selectCommentsSecondaryRoute`, `isGroqTpdExhaustionError`, chain builder
- `tests/summarize.comments-v2.test.ts` — Phase 3 describe (flag off/on, size, TPD, EN reject)

## Verify

```bash
bun test tests/summarize.comments-v2.test.ts   # 36 pass
```

## Do NOT

- Set `COMMENTS_QWEN27B_ROUTE_ENABLE=true` in prod/CI without Phase 4 plan.
- Treat this as Phase 2 PASS.
- Change paid freshness SLA here without an explicit product decision.

## Phase 4 controls (landed, still default-safe)

- `COMMENTS_QWEN27B_ROUTE_SHARE` default **0** — ENABLE alone does nothing.
- Deterministic sample: `storyId % 100 < share` (`isCommentsQwen27bShareHit`).
- Runbook: `docs/runbook-comments-qwen27b-rollout.md` (8-run table, rollback triggers).
- To start limited rollout in prod: deploy + set `ENABLE=true` and `SHARE=10` (or agreed %).

## Next (actual prod flip)

1. Baseline 8h metrics (usage + failures).
2. Set ENABLE=true SHARE=10 on Worker; deploy.
3. Fill runbook table for 8 crons; rollback on triggers.
4. Only then raise share / consider default.
