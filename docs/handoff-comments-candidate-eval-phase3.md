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
| Estimate | `ceil(promptChars / 4) + COMMENTS_SUMMARY_MAX_TOKENS` |
| Chain (flag off) | 70b → 8b → paid OpenRouter (unchanged) |
| Chain (flag on) | 70b → size-pick(8b \| qwen \| skip) → paid OpenRouter |
| Qwen call | `reasoningEffort: "none"`, balanced-object JSON (no json_schema) |
| TPD breaker | `services.commentsTpdExhaustedModels` — only explicit TPD 429 body; per `makeServices()` run |
| SLA | **Not invented.** Paid hop timing unchanged. |

## Files

- `config/env.ts`, `.env.example`
- `pipeline/summarize.ts` — `selectCommentsSecondaryRoute`, `isGroqTpdExhaustionError`, chain builder
- `tests/summarize.comments-v2.test.ts` — Phase 3 describe (flag off/on, size, TPD, EN reject)

## Verify

```bash
bun test tests/summarize.comments-v2.test.ts   # 33 pass
```

## Do NOT

- Set `COMMENTS_QWEN27B_ROUTE_ENABLE=true` in prod/CI without Phase 4 plan.
- Treat this as Phase 2 PASS.
- Change paid freshness SLA here without an explicit product decision.

## Next (Phase 4 when ready)

1. Optional: finish Phase 2 when 70b TPD available, or document permanent waiver.
2. Enable flag on a small medium-story share only.
3. Watch 8 scheduled runs: validated rate, provenance, RU, p95, paid tokens.
4. Rollback triggers per `docs/plan-cheap-groq-comments-route.md` Phase 4.
