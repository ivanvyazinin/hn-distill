# Replacing the dead free primaries — 2026-11-09

Context: both free primaries chosen earlier left the OpenRouter catalog (HTTP 404):

- post primary `apodex/apodex-1.1-mini:free` answered only 6 calls in prod, all on 13.10 within two
  minutes; 494 errors since;
- compress primary `nvidia/nemotron-3-super-120b-a12b:free` last answered on 20.10.

All post traffic was already served by the paid fallback `deepseek/deepseek-v4.1-flash`, all
compression by `google/gemma-4-31b-it`; the dead hop added ~100 wasted calls per 3 days.

## Live free models on 09.11

| model | result |
|---|---|
| google/gemma-4-31b-it:free, gemma-4-26b-a4b-it:free, xingchen-agi/xing4.0-29b-a4b:free | 429 upstream on almost every call (43/44 in the bench) |
| nvidia/nemotron-3.5-super-vl:free | answers, CJK inside Russian text on 2/2 probes |
| recursive/flint-v1.0:free | reasoning cannot be disabled; spent 1500 tokens reasoning, empty content |
| stealth/crouton-alpha (zero price) | 403 "not available in your region"; reasoning mandatory |
| nvidia/nemotron-3-ultra-550b-a55b:free | live — benched below |
| Groq qwen/qwen3.8-27b (free tier) | answers in 0.3 s, but invented a fact in 1 of 2 probes; post/compress paths call OpenRouter only, so it needs a code change |

## Bench

Same method as `2026-10-13-qwen3-next-replacement.md`: production `summarizePost` with a
single-model chain, strict prompt, first 12 articles of `bench/manifest.json`, 2 repeats; blind
Opus judge with labels shuffled per item. Anchors are the 13.10 outputs of deepseek and apodex
on the same articles. OpenRouter key spend for the run: $0.

| model | gate pass | overall | faithfulness | Russian | hallucinated | p50 / max s |
|---|---|---|---|---|---|---|
| deepseek/deepseek-v4.1-flash (13.10 output) | 34/36 | 4.17 | 4.67 | 4.33 | 1/24 | 2.9 / — |
| apodex/apodex-1.1-mini:free (13.10 output) | 36/36 | 3.38 | 3.96 | 3.54 | 5/24 | 2.4 / — |
| nvidia/nemotron-3-ultra-550b-a55b:free | 24/24 | 2.83 | 3.38 | 3.25 | 15/24 | 11.7 / 73 |

nemotron-3-ultra adds details from outside the article (applause instead of "the audience
gasped", "champagne with cognac" — both checked against the source), invents causality and
breaks Russian words. The production gate passed all 24 of its cards, including every
fabricated one.

Compression (`scripts/bench-compress-models.mts`, 20 real inputs, validator only, no judge):

| model | valid | RU purity | ratio | p50 ms |
|---|---|---|---|---|
| nvidia/nemotron-3-ultra-550b-a55b:free | 19/20 | 19/20 | 0.55 | 499 |
| google/gemma-4-31b-it (13.09 run) | 20/20 | 20/20 | 0.53 | 827 |
| google/gemma-4-31b-it:free | 1/20 | — | — | 429 ×19 |

The validator checks size and language, not faithfulness, and a semantic reject is terminal, so
a free primary with a paid fallback does not protect against bad free output.

Raw data: `data/bench/free-replace-2026-11-09/`, `data/bench/compress-compare/2026-11-09T09-23-30.215Z/`
(git-ignored).

## Decision

- `OPENROUTER_MODEL=deepseek/deepseek-v4.1-flash`, `OPENROUTER_FALLBACK_MODEL=google/gemma-4-31b-it`
  (36/36 gate, 2–3/36 hallucinated on 13.10), `OPENROUTER_FALLBACK_MODEL_2` empty — paid
  llama-3.3-70b was never benched on this path.
- `COMMENTS_COMPRESS_MODEL=google/gemma-4-31b-it`, no second hop; the repair pass retries failed
  compressions on later runs.
- Expected prod effect: same models as before in practice, minus the 404 hop. Spend is unchanged
  (~$0.018/day in November); the key's $3 cap still has to be raised.

## Open

- nemotron-3-ultra:free for compression would save ~$0.12/month; needs a faithfulness judge on
  compression before use.
- Groq qwen3.8-27b for compression needs Groq routing on that path, then a bench.
