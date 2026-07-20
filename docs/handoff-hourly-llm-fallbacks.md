# Handoff: восстановить LLM fallback-и hourly pipeline

**Статус:** фазы 1–2 сделаны локально 2026-07-20. Hourly/production data **не** гонялись — нужен согласованный rollout.

**Аудитория:** разработчик, который продолжит исправление `hourly-build`.
**Цель:** убрать скрытую деградацию pipeline: GitHub Actions завершается успешно, но tags и post guard регулярно переходят на эвристики, а comments теряют устойчивый путь после Groq TPD.

## Краткий вывод

За 10 последних `hourly-build` запусков от 2026-07-18 до 2026-07-20 не было упавших jobs. Однако pipeline работал в degraded-режиме. Главная причина — недоступный model ID `meta-llama/llama-4-scout-17b-16e-instruct` в фактическом runtime-конфиге и расхождение между workflow и `config/env.ts`.

Не исправляйте только GitHub variables. Сначала выберите и проверьте доступные модели по каждому provider/role, затем сделайте `config/env.ts` единственным источником defaults и удалите устаревшие workflow overrides.

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

**Done (2026-07-20).** `config/env.ts` + `.env.example` defaults обновлены. Hourly workflow больше **не** задаёт model env (`OPENROUTER_*`, `COMMENTS_*`, `TAGS_*`, `POST_GUARD_*`, `SUMMARY_CONTENT_REJECT_MODEL`) — только secrets + runtime flags. Repository model variables удалены (оставлены `SITE`/`BASE`/`TOP_N`/`SUMMARY_LANG`/`LLM_USAGE_ENABLED`/`GOATCOUNTER_CODE`).

Focused re-probe runner exit was **1**: tags+guard `openai/gpt-oss-20b` **3/3 pass**; comments-groq `llama-3.3-70b` was `fail_1_of_3` in the same concurrent (`Promise.all`) batch — not a serial tags/guard-only gate. Do not call the whole probe “full pass.”

Inventory GitHub repository variables от 2026-07-20:

- присутствуют stale overrides: `TAGS_MODEL=meta-llama/llama-4-scout-17b-16e-instruct`, `POST_GUARD_MODEL=meta-llama/llama-4-scout-17b-16e-instruct`, `POST_GUARD_FALLBACK_MODEL=openai/gpt-oss-20b`;
- `COMMENTS_*` repository variables отсутствуют;
- другие runtime-флаги и summary-model overrides пока не менялись.

После выбора моделей:

1. Обновите defaults в [`config/env.ts`](../config/env.ts).
2. Удалите model defaults из [`.github/workflows/hourly-build.yml`](../.github/workflows/hourly-build.yml), чтобы workflow не дублировал и не переставлял model chain.
3. Удалите stale GitHub repository variables:
   - `TAGS_MODEL`
   - `POST_GUARD_MODEL`
   - `POST_GUARD_FALLBACK_MODEL`
   - старые `COMMENTS_*` overrides
4. Оставьте secrets и безопасные runtime-флаги в workflow.

Изменение model defaults должно проходить через review в репозитории. Не возвращайте mutable Actions variables как второй источник model configuration.

### 3. Обрабатывать permanent model errors

**Done.** `isModelNotFoundError` + early exit в `chatStructured` (без retry того же id). Tags: `model_not_found` не уходит во второй plain-JSON call на тот же id → heuristics в `processTags`.

### 4. Защитить контракт тестами

**Done (targeted):**
- `model_not_found` no same-id retry — `tests/openrouter.comments-structured.test.ts`
- comments `404 → next Groq` — `tests/summarize.comments-v2.test.ts`
- existing `429 TPD → OpenRouter` сохранён
- empty guard fallback → 1 call + heuristics-only — `tests/summarize.escalation.test.ts`
- tags `model_not_found` skips plain JSON — `tests/tags.test.ts`

## Rollout и критерии успеха

1. Запустите probe без изменения данных.
2. После успешного probe выполните `workflow_dispatch` с `TOP_N=10`.
3. Не перезаписывайте production state без подтверждения владельца данных.
4. Наблюдайте один ручной запуск и восемь scheduled запусков за сутки.

Сравните с baseline выше. Минимальные критерии:

- `model_not_found=0`;
- нет `tags_heuristics_fallback` и `guard_heuristics_only`, вызванных 404;
- при Groq TPD comments доходят до проверенного OpenRouter fallback;
- `json_validate_failed` ниже baseline 137 на 10 запусков;
- aggregate и backup state продолжают завершаться успешно.

## Команды проверки после реализации

```bash
make lint
make typecheck
make test
git diff --check
```

После локальной проверки используйте `workflow_dispatch` только после согласования запуска, поскольку обычный job восстанавливает и сохраняет `data/` через VPS.

## Следующий запрос для агента

> Phase 2 code/config done. Review diff, commit if ok, then optional coordinated `workflow_dispatch` hourly with `TOP_N=10` after owner confirms data backup path. Watch `model_not_found=0`, no 404-driven tags/guard heuristics, comments TPD→OpenRouter. Do not rewrite production state without confirmation.
