# Handoff: восстановить LLM fallback-и hourly pipeline

**Статус:** фазы 1–2 + ship + первый prod rollout 2026-07-20. Главная цель (`model_not_found=0`) закрыта. Открыт follow-up: comments budget не всегда доходит до OpenRouter после Groq TPD/413.

**Аудитория:** разработчик, который продолжит hardening comments/tags/guard после rollout.
**Цель (исходная):** убрать скрытую деградацию pipeline из‑за мёртвого scout и drift конфигов.
**Цель (текущая):** при Groq rate-limit comments гарантированно доходить до paid OpenRouter; снизить tags/guard `json_validate_failed`/TPM noise на `gpt-oss-20b`.

## Краткий вывод

До фикса hourly был зелёным, но tags/guard/comments деградировали: `meta-llama/llama-4-scout-17b-16e-instruct` отсутствует в Groq catalog (`model_not_found`), плюс drift `config/env.ts` ↔ workflow ↔ GitHub variables.

Сделано:
- model defaults только в [`config/env.ts`](../config/env.ts);
- scout убран; routes из local probe;
- `model_not_found` без retry того же id;
- commit `868e1695ad` на `main`, ручной hourly [run 29733829540](https://github.com/ivanvyazinin/hn-distill/actions/runs/29733829540) = **success**, `model_not_found=0`.

Осталось: comments chain часто сжигает `COMMENTS_MAX_LLM_CALLS=3` на Groq (`70b` TPD + `8b` unsupported-format retry + `8b` 413/TPM) и **не доходит** до `COMMENTS_OPENROUTER_FALLBACK_MODEL`.

## Доказательства из логов

Артефакты расследования:

- сводка: `/tmp/hn-hourly-logs/20260720T084059Z/SUMMARY.md`
- худший запуск: `/tmp/hn-hourly-logs/20260720T084059Z/29688760986/pipeline.log`
- последний запуск: `/tmp/hn-hourly-logs/20260720T084059Z/29714673888/pipeline.log`

| Метрика за 10 запусков | Значение | Значение для продукта |
|---|---:|---|
| Jobs с `success` | 10 / 10 | CI status не отражает качество LLM-результата |
| `model_not_found` для scout | 445 | Недоступная модель вызывается во всех прогонах |
| `json_validate_failed` | 137 | Часть structured-output маршрутов не проходит JSON schema |
| `HTTP_429_TPD` | 96 | Groq `llama-3.3-70b-versatile` исчерпывает дневной token budget |
| `guard_heuristics_only` | 34 | Post guard не подтверждает часть summaries через LLM |
| `tags_heuristics_fallback` | 41 | Все 41 записанных набора тегов получили эвристический fallback |
| Pipeline duration, среднее | 306 с | Ошибки не останавливают агрегацию, но тратят попытки и снижают качество |

`aggregate_heuristic_drops=519` не является 519 новыми потерями в каждом запуске. Число и набор trigger'ов полностью повторяются, поэтому это aggregate-проверка исторического корпуса.

## Текущая конфигурация и drift

### Runtime-конфиг из Actions logs

Логи показывают:

```text
COMMENTS_MODEL=llama-3.3-70b-versatile
COMMENTS_FALLBACK_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
COMMENTS_FALLBACK_MODEL_2=
TAGS_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
POST_GUARD_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
POST_GUARD_FALLBACK_MODEL=openai/gpt-oss-20b
```

`TAGS_MODEL`, `POST_GUARD_MODEL` и `POST_GUARD_FALLBACK_MODEL` не совпадают с defaults в workflow. Они приходят из GitHub repository variables. Scout возвращает 404: `model_not_found`.

### Два источника defaults

[`config/env.ts`](../config/env.ts) задаёт comments chain как:

```text
Groq: COMMENTS_MODEL=scout
Groq: COMMENTS_FALLBACK_MODEL=llama-3.3-70b-versatile
OpenRouter: COMMENTS_OPENROUTER_FALLBACK_MODEL=qwen/qwen3-next-80b-a3b-instruct
```

[`.github/workflows/hourly-build.yml`](../.github/workflows/hourly-build.yml) передаёт другой порядок:

```text
Groq: COMMENTS_MODEL=llama-3.3-70b-versatile
Groq: COMMENTS_FALLBACK_MODEL=scout
Groq: COMMENTS_FALLBACK_MODEL_2=""
```

Поэтому код и production job не используют одну конфигурацию. Не считать defaults из `config/env.ts` доказательством работоспособности: scout в production logs недоступен и должен пройти новый probe перед повторным выбором.

## Поведение comments fallback

`callStructuredWithModelChain` в [`pipeline/summarize.ts`](../pipeline/summarize.ts) строит цепочку по provider:

1. `COMMENTS_MODEL` через Groq;
2. `COMMENTS_FALLBACK_MODEL` через Groq;
3. `COMMENTS_FALLBACK_MODEL_2` через Groq, если значение не пустое;
4. `COMMENTS_OPENROUTER_FALLBACK_MODEL` через OpenRouter.

Любая HTTP-ошибка переводит вызов к следующему шагу. Тест в [`tests/summarize.comments-v2.test.ts`](../tests/summarize.comments-v2.test.ts) уже подтверждает путь `Groq 429 TPD → OpenRouter paid fallback`.

`COMMENTS_MAX_LLM_CALLS` по умолчанию равен 3. Поэтому не заполняйте `COMMENTS_FALLBACK_MODEL_2` без отдельного решения о budget: три Groq вызова могут исчерпать лимит до OpenRouter fallback. Рекомендуемая минимальная цепочка — два проверенных Groq models и один проверенный OpenRouter model. Если потребуется третий Groq model, поднимите budget до 4 и проверьте worker deadline.

## Решения, которые нужно принять до изменения production

1. Выбрать доступные Groq models для tags, guard и первых двух comments попыток.
2. Выбрать доступный OpenRouter model для comments last resort и post guard fallback.
3. Подтвердить, что каждый выбранный route возвращает JSON нужного формата, а не только отвечает 200.
4. Решить, нужен ли третий Groq comments fallback. По умолчанию он не нужен из-за лимита трёх LLM calls.

[`docs/escalation-model-bench.md`](./escalation-model-bench.md) подтверждён повторным probe: paid OpenRouter `qwen/qwen3-next-80b-a3b-instruct` проходит comments last-resort route.

## Результат фазы 1 (2026-07-20)

**Local availability probe** с production credentials из `.env` (без записи pipeline data). GitHub Actions workflow `LLM model probe` **не** запускался — только локальный `bun run tsx scripts/probe-llm-models.mts`. Артефакт: [`docs/probe-llm-models-2026-07-20.md`](./probe-llm-models-2026-07-20.md).

`bunx tsc --noEmit` в этой сессии был красным на pre-existing ошибках вне probe (`tests/fetch.collectComments.test.ts`, `utils/object-store.ts`, `worker/src/index.ts`). Не считать typecheck зелёным; разбор отдельно от фазы 1.

### Catalog vs runtime

`GET https://api.groq.com/openai/v1/models` на текущем ключе **не** содержит `meta-llama/llama-4-scout-17b-16e-instruct`. Scout control-probe: `fail` на tags/guard/comments-groq. Это объясняет 445 `model_not_found` в hourly logs.

Доступные chat-модели Groq на ключе: `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.6-27b` (+ compound/whisper/guard, не для этих ролей).

### Role matrix (schema-aware)

| role | model | attempts | result | notes |
|---|---|---:|---|---|
| tags (Groq strict JSON) | `openai/gpt-oss-20b` | 3/3 | **pass** | ~0.3–0.9s |
| tags | `openai/gpt-oss-120b` | 1/1 | pass | медленнее 20b |
| tags | `llama-3.3-70b-versatile` | — | fail | `json_schema` not supported |
| tags | `llama-3.1-8b-instant` | — | fail | `json_schema` not supported |
| tags | `qwen/qwen3.6-27b` | — | fail | `json_schema` not supported |
| tags | scout | — | fail | `model_not_found` |
| guard (Groq strict JSON) | `openai/gpt-oss-20b` | 3/3 primary; later 2/3 once | **best candidate** | ~0.3–0.8s; не называть безусловно стабильным после одного flaky stab run |
| guard | `openai/gpt-oss-120b` | fail | **reject** | единственный dedicated guard probe → `json_validate_failed` |
| guard | llama/qwen non-oss | — | fail | no `json_schema` |
| comments-groq (balanced-object) | `llama-3.3-70b-versatile` | 3/3 | **pass** | ~0.7–0.9s |
| comments-groq | `llama-3.1-8b-instant` | 3/3 | **pass** | ~0.2s; кандидат fallback |
| comments-groq | `qwen/qwen3.6-27b` | 3/3 | **pass** | ~1.2s; reasoning-ish, медленнее |
| comments-groq | `openai/gpt-oss-120b` | 3/3 | pass | ~1.1s |
| comments-groq | `openai/gpt-oss-20b` | — | **fail** | empty content / weak plain-JSON |
| comments-openrouter (strict JSON) | `qwen/qwen3-next-80b-a3b-instruct` | 3/3 | **pass** | ~2.0–3.2s |

Probe comments prompt исправлен: обязан перечислять enum `kind ∈ {consensus,dispute,advice}` и давать example shape. Старый prompt давал ложные fail на валидных моделях (модели ставили `kind="concise"`).

### Выбранные model ID (фаза 2 ещё не стартовала)

Минимальная comments-цепочка (2 Groq + 1 OpenRouter, `COMMENTS_MAX_LLM_CALLS=3`):

| env | value | rationale |
|---|---|---|
| `TAGS_MODEL` | `openai/gpt-oss-20b` | единственный надёжный Groq strict-JSON для tags в probe |
| `POST_GUARD_MODEL` | `openai/gpt-oss-20b` | лучший guard candidate; один stab run был 2/3 — не «безусловно стабильный» |
| `POST_GUARD_FALLBACK_MODEL` | `""` | пустой fallback: один guard call → heuristics-only. `gpt-oss-120b` отклонён |
| `COMMENTS_MODEL` | `llama-3.3-70b-versatile` | production primary; schema pass; TPD spill ожидаем |
| `COMMENTS_FALLBACK_MODEL` | `llama-3.1-8b-instant` | отдельный Groq bucket от 70b; fast plain-JSON pass; замена мёртвому scout |
| `COMMENTS_FALLBACK_MODEL_2` | `""` | не нужен при budget=3 |
| `COMMENTS_OPENROUTER_FALLBACK_MODEL` | `qwen/qwen3-next-80b-a3b-instruct` | paid OR last resort, confirmed |

Альтернатива comments fallback (если 8b окажется слабым на реальных тредах): `qwen/qwen3.6-27b`. Не ставить `openai/gpt-oss-20b` в comments-groq — probe empty-content.

**Третий Groq comments fallback не берём** (лимит 3 LLM calls).

**Открыто до фазы 2:** guard fallback model; tags fallback path (сейчас tags при LLM fail уходят в heuristics — отдельного model fallback нет).

## План реализации

### 1. Проверить модели до переключения

**Done / Verified as local availability probe (2026-07-20).** Не GH Actions run.

- [`.github/workflows/llm-model-probe.yml`](../.github/workflows/llm-model-probe.yml) — ручной non-mutating workflow (ещё не dispatch'ился);
- [`scripts/probe-llm-models.mts`](../scripts/probe-llm-models.mts) — минимальные запросы; comments prompt pins kind enum;
- [`tests/probe-llm-models.test.ts`](../tests/probe-llm-models.test.ts) — schemas, kind-enum prompt, quiet fail under `LOG_LEVEL=silent`;
- fix: `LOG_LEVEL=silent` в [`utils/log.ts`](../utils/log.ts) реально глушит emit (раньше `silent=99` инвертировал порог и **всё** печатал, включая provider error bodies).

Локальный probe с production keys, `PROBE_ATTEMPTS=3` на comments/tags primary routes — pass. Production data / hourly **не** запускались.

### 2. Убрать drift конфигурации

**Done + shipped (2026-07-20, `868e1695ad`).**

- defaults: [`config/env.ts`](../config/env.ts), [`.env.example`](../.env.example);
- [`.github/workflows/hourly-build.yml`](../.github/workflows/hourly-build.yml) — **без** model env (`OPENROUTER_*` / `COMMENTS_*` / `TAGS_*` / `POST_GUARD_*` / `SUMMARY_CONTENT_REJECT_MODEL`); только secrets + runtime flags;
- repository model variables удалены; остались `SITE`, `BASE`, `TOP_N`, `SUMMARY_LANG`, `LLM_USAGE_ENABLED`, `GOATCOUNTER_CODE`;
- contract test: [`tests/model-config-contract.test.ts`](../tests/model-config-contract.test.ts).

Focused re-probe перед phase 2: runner exit **1** (concurrent `Promise.all`). tags+guard `openai/gpt-oss-20b` **3/3 pass**; comments-groq `llama-3.3-70b` `fail_1_of_3` в том же batch — не «full pass».

### 3. Обрабатывать permanent model errors

**Done.** `isModelNotFoundError` + early exit в `chatStructured` (без retry того же id). Tags: `model_not_found` не уходит во второй plain-JSON call на тот же id → heuristics в `processTags`.

### 4. Защитить контракт тестами

**Done (targeted):**
- `model_not_found` no same-id retry — `tests/openrouter.comments-structured.test.ts`
- comments `404 → next Groq` — `tests/summarize.comments-v2.test.ts`
- existing `429 TPD → OpenRouter` сохранён
- empty guard fallback → 1 call + heuristics-only — `tests/summarize.escalation.test.ts`
- tags `model_not_found` skips plain JSON — `tests/tags.test.ts`

## Ship и первый prod rollout (2026-07-20)

| Item | Value |
|---|---|
| Commit | [`868e1695ad`](https://github.com/ivanvyazinin/hn-distill/commit/868e1695ad) on `main` |
| Manual hourly | [run 29733829540](https://github.com/ivanvyazinin/hn-distill/actions/runs/29733829540) |
| Conclusion | **success** (~4 min build + deploy) |
| `TOP_N` | 10 (repo var) |
| Log snapshot | `/tmp/hourly-29733829540.log` (local) |

### Счётчики первого ручного прогона vs baseline (10 runs)

| Метрика | Baseline (10 runs) | Run 29733829540 | Статус |
|---|---:|---:|---|
| Job success | 10/10 | success | ok |
| `model_not_found` / scout | 445 | **0** | **closed** |
| tags written on live model | n/a (scout 404) | 10 × `openai/gpt-oss-20b` | ok |
| `fallback tags written` | 41 heuristics-driven | 3 | partial |
| `guard_heuristics_only` | 34 | 1 | partial |
| `json_validate_failed` | 137 / 10 runs | 15 / 1 run | still noisy on oss-20b |
| HTTP 429 | 96 TPD-ish | 43 (70b TPD + 8b/oss TPM) | expected pressure |
| HTTP 413 (8b TPM/size) | n/a | 6 | new |
| comments summary written | n/a | 1 (`llama-3.1-8b-instant`) | weak |
| comments `generation-failed` fallback | n/a | 5 | open |
| OpenRouter qwen reached | desired on TPD | **0** | **open** |

### Что подтвердил rollout

- Новые defaults реально в Actions (нет scout, tags/guard = `gpt-oss-20b`, comments = `70b`→`8b`).
- 404-driven degradation убрана.
- Empty `POST_GUARD_FALLBACK_MODEL` ведёт себя как задумано: один guard model, при fail → heuristics-only.

### Что вскрылось (follow-up)

1. **Comments budget burn before OpenRouter**  
   Типичный path при TPD:
   - call1: `llama-3.3-70b` → 429 TPD;
   - call2: `llama-3.1-8b` + `response_format` → unsupported → same-model retry without format (ещё один physical call);
   - call3: `8b` plain → 413 (TPM 6000 / large thread) или 429 TPM;
   - `COMMENTS_MAX_LLM_CALLS=3` исчерпан → deterministic comments fallback;  
   - `qwen/qwen3-next-80b-a3b-instruct` **не вызывается**.

2. **`llama-3.1-8b-instant` weak on large threads**  
   Free-tier TPM 6000; big prompts → HTTP 413. Availability probe на synthetic JSON этого не ловил.

3. **`openai/gpt-oss-20b` tags/guard noise**  
   TPM 8000 + `json_validate_failed` → часть tags уходит в heuristics, редкий guard heuristics-only. Это уже не 404, а quality/rate-limit.

## Критерии успеха (обновлённые)

### Closed
- `model_not_found=0` / no scout;
- model IDs single-sourced from `config/env.ts`;
- hourly job + backup/deploy success on new config.

### Still open (phase 3)
- при Groq TPD/413 comments **доходят** до OpenRouter qwen в пределах budget;
- `comments generation-failed` не доминирует на TOP_N=10;
- `json_validate_failed` и tags/guard heuristics на oss-20b ниже первого rollout snapshot на суточном окне;
- 8 scheduled hourly runs без регресса `model_not_found`.

## Phase 3 — план

1. **Comments chain accounting**  
   Не считать unsupported-`response_format` retry отдельным burn budget *или* стартовать Groq comments сразу с `balanced-object` (без json_schema) для 8b/70b. Цель: `70b 429 → 8b fail → OpenRouter` ≤ 3 calls.
2. **Large-thread path**  
   На 413/TPM от 8b сразу `moveToFallback` на OpenRouter; рассмотреть `qwen/qwen3.6-27b` как Groq fallback вместо/рядом с 8b (уже pass в probe, медленнее).
3. **Tags/guard hardening** (отдельно)  
   Retry/spacing на oss-20b TPM; не возвращать 120b guard fallback без нового probe.
4. **Наблюдение**  
   8 scheduled runs; сравнивать те же счётчики, что в таблице rollout.

## Команды проверки

```bash
make lint
# make typecheck  # known pre-existing failures outside this work (~36 tsc errors)
make test
git diff --check
```

Targeted suite used at ship time: probe/log/openrouter/comments-v2/tags/escalation/model-config-contract (59 pass).

## Следующий запрос для агента

> Phase 3: fix comments budget so Groq TPD/413 reaches `COMMENTS_OPENROUTER_FALLBACK_MODEL` within `COMMENTS_MAX_LLM_CALLS`. Prefer starting Groq comments on balanced-object (no json_schema) and/or not billing unsupported-format retries against the call budget. Add a regression test: 70b 429 → 8b 413 → OpenRouter success in ≤3 calls. Do not reintroduce workflow model env vars. After tests, one manual hourly and compare counters to run 29733829540.
