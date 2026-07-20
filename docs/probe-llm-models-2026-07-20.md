# LLM model probe results — 2026-07-20

**Kind:** local availability probe only (not a GitHub Actions `LLM model probe` run).

Non-mutating local probe with production credentials from `.env`.
No hourly workflow, no pipeline data read/write.

Tooling:

- `scripts/probe-llm-models.mts` (comments prompt pins `kind ∈ {consensus,dispute,advice}`)
- `tests/probe-llm-models.test.ts` — unit contract + quiet-fail under `LOG_LEVEL=silent`
- `utils/log.ts` — `LOG_LEVEL=silent` fix (was inverted; leaked provider diagnostics)
- Groq catalog: `GET /openai/v1/models` on the current key

`bunx tsc --noEmit` had pre-existing failures outside probe scope; not claimed green.

## Catalog

Present on key: `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.6-27b`.

Absent: `meta-llama/llama-4-scout-17b-16e-instruct` → control probe `model_not_found` on tags/guard/comments-groq.

## Primary combo (`PROBE_ATTEMPTS=3`)

| role | provider | model | avg latency_ms | result |
|---|---|---|---:|---|
| tags | groq | `openai/gpt-oss-20b` | 914 | pass |
| guard | groq | `openai/gpt-oss-20b` | 379 | pass (see caveat) |
| comments-groq | groq | `llama-3.3-70b-versatile` | 731 | pass |
| comments-openrouter | openrouter | `qwen/qwen3-next-80b-a3b-instruct` | 2688 | pass |

Guard caveat: a later stability batch once reported guard `openai/gpt-oss-20b` as `fail_2_of_3` while probing another comments model. Treat 20b as **best available**, not unconditionally stable.

## Comments Groq fallback candidates (`PROBE_ATTEMPTS=3`)

| model | result | avg latency_ms |
|---|---|---:|
| `llama-3.1-8b-instant` | pass | 218 |
| `qwen/qwen3.6-27b` | pass | 1242 |
| `openai/gpt-oss-120b` | pass | 1109 |
| `openai/gpt-oss-20b` | **fail** | — empty content / weak plain-JSON |

## Rejected for tags/guard strict JSON

| model | reason |
|---|---|
| `llama-3.3-70b-versatile` | HTTP 400: no `response_format=json_schema` |
| `llama-3.1-8b-instant` | same |
| `qwen/qwen3.6-27b` | same |
| `openai/gpt-oss-120b` (guard) | **rejected** — dedicated guard probe `json_validate_failed` |
| scout | `model_not_found` |

## Focused re-probe before phase 2

Concurrent runner (`Promise.all` over all four roles), `PROBE_ATTEMPTS=3`, process exit **1**:

| role | model | result |
|---|---|---|
| tags | `openai/gpt-oss-20b` | **3/3 pass** |
| guard | `openai/gpt-oss-20b` | **3/3 pass** |
| comments-groq | `llama-3.3-70b-versatile` | `fail_1_of_3` (transient in this batch) |
| comments-openrouter | `qwen/qwen3-next-80b-a3b-instruct` | pass |

Not a serial tags/guard-only probe. Prior separate 3/3 pass on comments 70b still stands; do not label this batch a full focused pass.

## Selected and applied in phase 2

```text
TAGS_MODEL=openai/gpt-oss-20b
POST_GUARD_MODEL=openai/gpt-oss-20b
POST_GUARD_FALLBACK_MODEL=
COMMENTS_MODEL=llama-3.3-70b-versatile
COMMENTS_FALLBACK_MODEL=llama-3.1-8b-instant
COMMENTS_FALLBACK_MODEL_2=
COMMENTS_OPENROUTER_FALLBACK_MODEL=qwen/qwen3-next-80b-a3b-instruct
```

Decisions locked:

- guard fallback empty (120b rejected; heuristics-only on guard fail)
- tags: no second model → deterministic heuristics

Notes:

- `POST_GUARD_*` models must be Groq ids while `guardTagsClient` uses the Groq gateway.
- Keep `COMMENTS_MAX_LLM_CALLS=3` → no third Groq comments model.
- `openai/gpt-oss-20b` is good for tags/guard primary and bad for comments-groq plain JSON.

## Probe prompt fix

`COMMENTS_MESSAGES` states required keys + enum and includes an example JSON object.
Without that, models invented `kind="concise"` / `observation` and failed Zod on healthy routes.
