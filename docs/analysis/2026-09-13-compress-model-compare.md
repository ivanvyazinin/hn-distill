# Compress-stage model compare — 2026-09-13

Context: 08.09 OpenRouter removed `minimax/minimax-m3:free` (HTTP 404 "unavailable for free");
compress fell to the paid fallback `qwen/qwen3-next-80b-a3b-instruct` on every card → daily
spend ×3 and the key hit its monthly cap on 12.09. Question: is there a cheaper/better paid
fallback, incl. Meta "contributor" tier (Meta trains on prompts; acceptable for public HN data).

Bench: `scripts/bench-compress-models.mts` — 20 real structured insights (from
`data/bench/model-compare/2026-09-03T08-05-36-312Z`), production prompt / sanitizer /
`validateCompressedText`, temp 0.2, max_tokens 1000, `reasoning_effort: none`.
Raw results: `data/bench/compress-compare/2026-09-13T08-43-25.684Z/` (+ Muse rerun `…08-47-28.582Z`).

| model | valid | RU purity | avgRatio | p50 / p95 ms | $/call | notes |
|---|---|---|---|---|---|---|
| nvidia/nemotron-3-super-120b-a12b:free (primary) | 17/20 | 18/20 | 0.84 | 502 / 573 | 0 | latin_prose×2, empty×1; barely compresses |
| qwen/qwen3-next-80b-a3b-instruct (current fallback) | 18/20 | 19/20 | 0.65 | 725 / 1044 | 0.00059 | $0.09/$1.10 per M |
| google/gemma-4-31b-it | **20/20** | **20/20** | 0.53 | 827 / 1404 | **0.00020** | most aggressive, faithful in spot-check |
| deepseek/deepseek-v4-flash | 18/20 | 19/20 | 0.70 | 1431 / 5773 | **0.00012** | promo −92%; p95 slow but < 14s timeout |
| qwen/qwen3-235b-a22b-2507 | 15/20 | 19/20 | 0.70 | 850 / 2210 | 0.00047 | empty×4 |
| meta/muse-spark-1.3-contributor, max_tokens 1000 | 1/20 | — | — | — | 0.00026 | reasoning cannot be disabled (HTTP 400 on `none`); burns whole cap in thinking → empty |
| meta/muse-spark-1.3-contributor, max_tokens 4000, effort low | 19/20 | 19/20 | 0.54 | 1023 / 1510 | 0.00040 | ~1360 reasoning tok/call; needs prod code change (per-model effort + cap) |

## Conclusions

- **Muse contributor: not worth it for compress.** Only 1.5× cheaper than qwen3-next because
  reasoning tokens are billed as output; requires per-model `reasoning_effort` and a 4× cap.
  Quality fine (adds @author attribution, longer).
- **Best fallback: `google/gemma-4-31b-it`** — 20/20 valid, 3× cheaper than qwen3-next, stable
  latency. `deepseek-v4-flash` is 5× cheaper but promo-priced and p95 5.8s.
- Current free primary passes 17/20 but compresses weakly (ratio 0.84) — the paid hop's
  quality matters more than assumed.

## Proposed change

`COMMENTS_COMPRESS_FALLBACK_MODEL=google/gemma-4-31b-it` (env default in `config/env.ts`).
Post-stage strict fallback (`qwen3-next`) is a separate knob — not benchmarked here.
