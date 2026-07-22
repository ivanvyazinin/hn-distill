# Handoff: cheap-Groq comments-route eval — Phase 0

**Plan:** `docs/plan-cheap-groq-comments-route.md`
**Branch / worktree:** `feat/comments-candidate-eval` @ `/Users/ivan/IdeaProjects/ml/hn-distill-candidate-eval`
**Date:** 2026-07-22

## Phase 0 gate status

| Gate item (plan) | Status |
|---|---|
| 20 distinct **real** HN thread IDs | ✅ done |
| Each fixture parses; `story.id` matches | ✅ done |
| Size + content distribution (≥5 long / ≥5 medium / ≥4 short / ≥3 technical / ≥3 contested) | ✅ done — 7 / 9 / 4, 6 technical, 6 contested |
| Corpus frozen (no mutation on re-run) | ✅ done — overwrite-guarded |
| **2 baseline `llama-3.3-70b` outputs per fixture** in `data/bench/` | ⛔ **deferred** — Groq free 70b TPD exhausted (see finding) |

**Phase 0 is NOT fully passed** until the baseline lands. Everything except the baseline is done and reviewable now.

## What shipped

### Corpus (committed)
- `bench/candidate-manifest.json` — 20 real HN thread IDs + per-fixture metadata: `fetchedISO`, `includedComments`, `promptChars` (actual production V2 prompt length via `buildCommentsPromptV2`), `sizeBucket`, `tags`, and raw `technicalScore` / `contestedScore` (auditable). Also records normalization params and the source pool stats.
- `bench/comments/<id>.json` — 20 fixtures (IDs `489…`), each `{ story:{id,title,url}, comments: NormalizedComment[] }`, produced through the **exact** production normalization (`fetchItem → normalizeStory → collectComments`, `MAX_DEPTH=2`, `MAX_COMMENTS_PER_STORY=40`, `MAX_BODY_CHARS=2000`).

### Tooling (committed)
- `scripts/bench-comments-fetch-real.mts` — fetches HN best+top, spreads candidates across comment-count, freezes 20 by a size/technical/contested greedy selection. Refuses to overwrite (corpus freeze) without `--overwrite`.
- `scripts/bench-comments-baseline.mts` — resumable + non-greedy baseline capture (see below).
- `scripts/bench-comments-baseline.sh` — wrapper pinning the ambient route to a single Groq 70b hop.

## Key finding (validates the plan's premise)

The smoke run hit a hard `429` on the very first call:

```
llama-3.3-70b-versatile … tokens per day (TPD): Limit 100000, Used 99672, Requested 3794
```

- The shared Groq **free-tier 70b budget is 100k tokens/day**, and the hourly pipeline had already consumed **99.7k of it by 08:38 UTC** — i.e. the pipeline alone effectively maxes the daily 70b cap and is already spilling to fallbacks during the day.
- One full baseline (20 fixtures × 2 repeats ≈ **140–160k tokens**) is **larger than the entire daily cap**, so it cannot complete in a single UTC day even with zero pipeline competition.
- **There is essentially no spare 70b free headroom.** Any baseline token taken is a token the live pipeline wanted. This is exactly the constraint the plan sets out to relieve (reduce 70b TPD pressure / paid-Qwen spill).

## Baseline: deferred capture design

Per your call ("defer to Groq reset"), the baseline script is built to complete **incrementally across UTC-day windows without starving the pipeline**:

- **Resumable** — skips any `<id>.r<repeat>.json` already captured with `validationPassed`, so re-running continues where the last window stopped. Writes a rolling `index.json` with `status: complete|partial` + `remaining`.
- **Non-greedy** — stops after `--max-calls-per-run` successful calls, or after `--fail-streak-stop` (default 3) consecutive non-validated generations. The production chain swallows the underlying 429, so a failure streak is the observable TPD-exhaustion proxy; stopping early hands the remaining daily budget back to the pipeline.

Run it (from this worktree):

```bash
scripts/bench-comments-baseline.sh --max-calls-per-run 12
```

⚠️ **Scheduling is intentionally NOT wired.** Because the pipeline already consumes the full 70b free budget, an unattended baseline job would contend with (degrade) the live site. Pick a contention strategy before scheduling:
1. **Paid one-off** — cleanest; `meta-llama/llama-3.3-70b-instruct` on OpenRouter, ~a few cents, same weights (quality baseline is weight-determined). Would need `--openrouter`-style route wiring (~10 lines).
2. **Accept ~2 days of partial pipeline degradation**, running the throttled wrapper right after 00:00 UTC.
3. **Spread over many days** with a small `--max-calls-per-run` so it only sips leftover headroom.

## Deliberate deviations from the plan (flagged for review)

1. **Temperature 0.2, not 0.** The production chain hardcodes `temperature: 0.2` (not env-tunable). Rather than edit `pipeline/summarize.ts` in Phase 0 (plan: "summarize.ts only after Phase 2 PASS"), the baseline uses the real production path at 0.2 — more production-faithful, and applied equally to baseline + candidate, so the comparison stays fair. The literal `temperature: 0` belongs in the Phase 1 explicit-route adapter.
2. **`postTldr` omitted** from the corpus. Isolates comment-summary quality from article-summary quality and keeps Phase 0 free of article-fetch LLM calls; absent `postSummary` is a valid production case (`buildCommentsPromptV2` handles it).
3. **Char cap not reached.** The largest real front-page thread today is ~17.5k prompt chars (73% of the 24k `COMMENTS_PROMPT_MAX_CHARS`); 13/20 sit at the 40-comment production cap. So "near the production limit" is met on the *comment-count* axis (the real ceiling) but not the *char* axis. Consequence: the plan's 413/char-boundary concern (Phase 1) can't be exercised from today's real traffic — Phase 1 smoke should add a synthetic max-length thread if it wants to test 413.

## Verification (this session)

- `bunx tsc --noEmit` — 36 errors, all pre-existing (aggregate.ts, cloudflare.infra.test.ts, summarize.ts, …); **0 in the new scripts**.
- `bunx eslint scripts/bench-comments-*.mts` — clean. (Repo-wide `eslint .` has ~320 pre-existing errors unrelated to this change.)
- `git diff --check` — clean.
- Corpus self-check — 20 unique IDs, all fixtures parse, `story.id` matches, generated by the committed code.
- `make build` — not run: no build-path files changed (additive scripts + bench data only).

## Next (Phase 1, after baseline + your gate review)

Per the plan: add `eval/run-comments-candidates.mts` (explicit baseline-vs-candidate route factory in `eval/comments-services.ts`), run the 6-fixture direct-Groq smoke for `qwen/qwen3.6-27b`, check the smoke gate. Do **not** start until the baseline is captured and Phase 0 is signed off.
