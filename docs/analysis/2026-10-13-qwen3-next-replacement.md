# Replacing qwen3-next-80b and the free post primary — 2026-10-13

Context: 12–13.10 the OpenRouter key hit its $2 total cap (`403 Key limit exceeded`) and
hourly-build failed four times in a row. `qwen/qwen3-next-80b-a3b-instruct` ($0.10/$1.10 per M)
was the paid model in two roles: the comments-v2 last-resort hop (strict json_schema, Groq TPM
spills, up to ~5 calls/run) and `SUMMARY_CONTENT_REJECT_MODEL` (strict post retries after a
heuristics/guard reject).

## Method

Both benches run the production code path with a single-model chain:

- Comments: `scripts/bench-comments-baseline.mts` with the Groq slots emptied and
  `COMMENTS_OPENROUTER_FALLBACK_MODEL=<candidate>`; 20 real threads from
  `bench/candidate-manifest.json`, 1 repeat.
- Posts: `summarizePost(..., { strictSystem: true, models: [candidate] })` +
  `checkSummaryHeuristics`; first 12 articles of `bench/manifest.json`, 3 repeats.
- Cost: OpenRouter key `usage` delta per model (may include a concurrent hourly run).
- Quality: blind Opus judge, model labels shuffled per item; 1–5 for faithfulness, coverage,
  Russian, concision, overall, plus a hallucination flag. Two flagged cases were checked against
  the source by hand (qwen: Getty "won" its suit — the article only says it sued; comments
  "more than 70 years" vs "almost 70"). Posts were judged twice (round 2 dropped qwen and added
  deepseek); the same judge drifted 0.4–0.6 between rounds but kept the order.

Raw data: `data/bench/qwen-replace-2026-10-13/` (git-ignored).

## Comments-v2 paid hop (20 threads)

| model | valid | overall | hallucinated | p50 / p95 s | $/call |
|---|---|---|---|---|---|
| qwen/qwen3-next-80b-a3b-instruct | 20/20 | 2.45 | 15/20 | 8.9 / 22.5 | 0.0015 |
| anthropic/claude-haiku-5.5 | 20/20 | 3.95 | 4/20 | 9.4 / 26.7 | 0.0017 |
| **google/gemma-4-31b-it** | 20/20 | 3.70 | **1/20** | 15.9 / 27.2 | **0.0004** |
| deepseek/deepseek-v4.1-flash | 8/20 | — | — | 28.6 / 51.4 | 0.0033 |

deepseek fails here because this hop sends no `reasoning_effort`: 57 calls returned empty
content after spending the cap on reasoning. gemma has the best faithfulness (4.4) but weaker
coverage (3.5 vs 4.55 for haiku).

## Post strict escalation (12 articles × 3)

| model | gate pass | overall r1 / r2 | hallucinated r1 / r2 | p50 / p95 s | $/call |
|---|---|---|---|---|---|
| qwen/qwen3-next-80b-a3b-instruct | 30/36 | 2.28 / — | 24/36 / — | 2.7 / 9.1 | 0.00063 |
| anthropic/claude-haiku-5.5 | 34/36 | 4.14 / 3.78 | 3 / 2 | 3.7 / 4.8 | 0.00053 |
| google/gemma-4-31b-it | 36/36 | 3.89 / 3.28 | 2 / 3 | 7.5 / 16.1 | 0.00027 |
| **deepseek/deepseek-v4.1-flash** | 34/36 | — / **4.06** | — / **0** | 2.9 / 6.2 | 0.00045 |

deepseek pricing is not a promo (no discount on the cheapest of ~30 providers); quality per
provider was not checked. Its weak spot is leftover English words (both gate rejects).

qwen3-next scored 4.53 faithfulness in the July escalation bench
(`docs/escalation-model-bench.md`); the drop is unexplained (provider routing change is a guess).

## Free post primary (12 articles × 2, same strict prompt, 6-way blind judge)

| model | gate pass /36 | overall | Russian | hallucinated /24 | p50 / p95 s |
|---|---|---|---|---|---|
| deepseek/deepseek-v4.1-flash (paid anchor) | 34 | 4.50 | 4.75 | 0 | 2.9 / 6.2 |
| **apodex/apodex-1.1-mini:free** | **36** | **3.75** | 3.96 | 0 | 2.4 / 3.2 |
| nvidia/nemotron-3-ultra-550b-a55b:free | 30 (6 call errors) | 3.33 | 3.71 | 2 | 15 / 32 |
| nvidia/nemotron-3-super-120b-a12b:free (previous primary) | 26 | 2.42 | 2.54 | 2 | 5.1 / 8.0 |
| dots-studio/dots-3-note-preview:free | 32 | 2.21 | 2.38 | 3 | 27 / 43 |
| nvidia/nemotron-3.5-lightning:free | 28 | 1.75 | 2.25 | 6 | 3.7 / 8.6 |

Unavailable on 13.10: gemma-4-31b/26b `:free` (429 upstream), inkling / inkling-small `:free`
(403, agentic harnesses only). nemotron-3-super leaks English and CJK into Russian text; each
gate reject sends the post to the paid escalation. apodex is free-only on one provider (Novita),
released 01.10 — availability is the risk, covered by the paid fallback. The bench used the strict
prompt; the normal prompt differs by four lines and already demands Russian-only text, so only
the gate pass rate may shift — watch it in prod.

## Decision

- `OPENROUTER_MODEL=apodex/apodex-1.1-mini:free`
- `OPENROUTER_FALLBACK_MODEL=deepseek/deepseek-v4.1-flash` (was the paid nemotron twin, not measured
  separately but the same weights as the free primary)
- `COMMENTS_OPENROUTER_FALLBACK_MODEL=google/gemma-4-31b-it`
- `SUMMARY_CONTENT_REJECT_MODEL=deepseek/deepseek-v4.1-flash`
- nemotron-3-super `:free` stays only as `COMMENTS_COMPRESS_MODEL` (separate bench).

## Side finding

The summary heuristics gate passed mixed-script words ("Катсуhiro", "провers") and CJK, and
every hallucinated card; its `latin_prose` / `contains_url` rejects mostly hit factually sound
cards.
