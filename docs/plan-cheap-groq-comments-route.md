# План: дешёвый Groq route для comments без регрессии качества

**Статус:** Superseded — закрыт 25.08.2026

> **Закрытие плана.** Groq llama shutdown 21.08.2026 убил экономику маршрута (обе
> llama-модели → 404), а free-first скан 25.08 (docs/probe-comments-models-2026-08-25.md)
> нашёл более выгодную замену: comments primary переехал на MiniMax-M3 через официальное
> API (COMMENTS_MINIMAX_MODEL + MINIMAX_API_KEY), qwen27b secondary-route скаффолд
> (size-split, share sampling, флаги COMMENTS_QWEN27B_*) снесён в рамках этого же решения.
> Платная лестница gpt-oss-120b → 20b → paid qwen сохранена как fallback.

**Жанр:** design doc / implementation plan


**Задача аудитории:** проверить и безопасно включить менее дефицитную бесплатную модель для части comments summary

**Выгодоприобретатель:** владелец сайта и читатель русских summaries

**Бизнес-цель:** уменьшить paid Qwen spill и расход 70b TPD, не публикуя неверные, англоязычные или непроверяемые summaries

## Решение

Не менять production routing до model-vs-model eval. Основной кандидат — `qwen/qwen3.6-27b`: у него отдельный бесплатный лимит 200k TPD и 8k TPM. Он должен заменить только второй Groq hop для medium comments после проверки.

`openai/gpt-oss-120b` проверить как отдельный quota bucket, но не добавлять в routing до собственного прохождения тех же gates. `llama-3.1-8b-instant` оставить только для коротких inputs и semantic compression. `llama-3.3-70b-versatile` остаётся primary для high-value comments.

Целевая цепочка после rollout:

```text
70b для high-value comments
→ Qwen 27b для medium comments
→ 8b только для короткого input / compression
→ pending retry
→ paid Qwen после freshness SLA и в пределах daily cap
```

## Цели и границы

### Цели

- Сравнить candidate с baseline на одном production V2 prompt.
- Измерить schema validity, validation, provenance, русский язык, faithfulness, latency и фактические tokens.
- Не посылать burst в общий Groq лимит: eval выполняет запросы последовательно и учитывает rate-limit headers.
- Включить candidate только за feature flag и наблюдать восемь scheduled runs.

### Не цели

- Не менять post, tags, guard или semantic compression в этой работе.
- Не менять default model IDs в workflow или GitHub repository variables.
- Не подменять semantic compression детерминированным сокращением.
- Не считать `compound`, Orpheus, Whisper, Prompt Guard и Safeguard кандидатами для comments generation.
- Не добавлять третий Groq hop в существующий бюджет из трёх вызовов.

## Инварианты качества

Каждый eval и production route обязан сохранять существующий контракт `CommentsInsights`:

- тот же `buildCommentsPromptV2`, `CommentsInsightsSchema` и `validateCommentsInsightsCandidate`;
- ответ проходит validation, language gate и quote provenance;
- `label: "comments"`, gateway и фактический `model_used` попадают в `llm_usage`;
- отказ или transient failure не перезаписывает хороший существующий summary;
- исчерпание free quota не разрешает paid fallback раньше freshness SLA;
- один физический provider call расходует один `CommentsGenerationBudget` slot.

Ни один результат LLM judge не достаточен сам по себе. Перед решением вручную просмотреть все candidate outputs с judge reason, validation failure или отличием faithfulness от baseline больше `0.2`.

## Фазы

| Фаза | Результат | Gate | Done / Verified / Deferred |
|---|---|---|---|
| 0 | Зафиксированный corpus и baseline | 20 real HN threads, распределённых по размеру и типу | Deferred / — / — |
| 1 | Изолированный direct-Groq smoke | 6 fixtures × 2, без rate-limit violation | Deferred / — / — |
| 2 | Полный blind paired eval winner vs 70b | Все quality gates пройдены | Deferred / — / — |
| 3 | Изменение routing под feature flag | Unit/integration tests и локальная verification | Deferred / — / — |
| 4 | Ограниченный production rollout | 8 scheduled runs без quality/cost regression | Deferred / — / — |

Выполнять только одну фазу за раз. Не начинать следующую до её verification gate.

## Фаза 0: зафиксировать corpus и baseline

1. Создать отдельный manifest для candidate eval. В нём должно быть 20 публичных real HN comment threads, а не только текущие пять real fixtures из `bench/manifest.json`.
2. Подобрать минимум:
   - 5 длинных тредов, включая input около production лимита;
   - 5 medium тредов;
   - 4 коротких треда;
   - 3 технических треда с терминами, числами и ссылками;
   - 3 спорных треда с взаимоисключающими позициями и оговорками.
3. Сохранить fixture вместе с source ID, временем fetch и размером canonical prompt. Не обновлять corpus при повторном запуске.
4. Собрать baseline `llama-3.3-70b-versatile` тем же V2 prompt и тем же planned output cap. Сохранить outputs локально в `data/bench/`; каталог игнорируется Git.
5. Передавать judge только canonical thread и два анонимных output. Не показывать model ID, gateway, latency или порядок вызова.

**Gate:** 20 разных real thread IDs; каждый fixture парсится; есть по два baseline output на fixture; corpus не меняется во время сравнения.

## Фаза 1: direct-Groq smoke

### Изменение eval harness

Добавить отдельный runner, например `eval/run-comments-candidates.mts`. Не перегружать `eval/run-comments.mts`: он сравнивает legacy V1 и structured V2, поэтому не отделяет эффект модели от эффекта prompt/pipeline.

Runner принимает два explicit route:

```text
baseline:  groq / llama-3.3-70b-versatile
candidate: groq / qwen/qwen3.6-27b
```

Для обоих routes он вызывает один и тот же production `generateValidatedCommentsSummaryV2` путь. Route задаёт provider, model ID, output cap и timeout; не заменяет prompt или Zod schema.

В первом smoke запуске проверить также `openai/gpt-oss-120b`, но как независимый experiment. Не включать его в fallback chain по результатам одного smoke.

### Параметры

- 6 заранее выбранных real fixtures × 2 repeats;
- `temperature: 0`;
- planned output cap: 1000 tokens;
- прямой Groq endpoint с `GROQ_API_KEY`, не 9Router;
- последовательный admission, без `Promise.all` по fixtures;
- резервировать input estimate + output cap против 8k TPM;
- между запросами уважать `retry-after`, `x-ratelimit-remaining-tokens` и reset headers;
- сохранять requested/resolved model, prompt/completion/total tokens, status, latency, headers и ошибку на каждую попытку.

**Gate:** candidate даёт не менее 11/12 validated results; нет provenance failure; нет 413; нет незапланированного 429 burst; p95 latency не превышает worker request deadline. При провале candidate прекращать его eval и не менять production code.

## Фаза 2: полный paired eval

1. Для smoke winner выполнить 20 fixtures × 2 repeats против сохранённого 70b baseline.
2. Оценивать candidate policy, то есть конкретный model ID, endpoint, `maxTokens` и timeout, а не абстрактную «модель Qwen».
3. Использовать blind paired judge с существующими критериями: viewpoint coverage, faithfulness, language purity, format adherence, overall и refusal.
4. Дополнительно собрать детерминированные метрики из application validation:
   - schema/validation pass rate;
   - accurate `best_quote` при emitted quote;
   - доля language-gate failures;
   - missing, timeout, 413, 429 и transport failures;
   - p50/p95 latency;
   - input, completion и total tokens;
   - фактический остаток quota из headers.
5. Экспортировать Markdown report и JSON results в `data/bench/`. В report включить список всех ручных findings, а не только средние оценки.

### Production gate

Candidate допустим к feature-flag rollout, только если одновременно:

| Проверка | Требование |
|---|---:|
| Validated structured outputs | ≥95% |
| Ошибки provider/transport | ≤10% |
| Provenance failures | 0 |
| Faithfulness | не хуже 70b более чем на 0.2 |
| Language purity | не хуже 70b более чем на 0.2 и среднее ≥4.5 |
| Refusals | 0 |
| p95 latency | < 7 секунд на запрос |
| 413 | 0 |

Если gate не пройден, оставить `llama-3.1-8b-instant` вторым hop и оформить причину в report. Не компенсировать слабую модель повышением числа attempts или ослаблением validation.

## Фаза 3: feature-flag routing

Начинать только после Phase 2 PASS.

1. Добавить явный opt-in flag для candidate route. Default остаётся текущим, чтобы deployment без flag не менял поведение.
2. Добавить Qwen 27b как второй Groq hop только для medium inputs. Определить medium по детерминированной оценке prompt tokens до provider call.
3. Оставить 8b доступным только при estimate input + reserved output `< 5.5k` и только когда он не создаёт 6k TPM burst.
4. Не расширять `COMMENTS_MAX_LLM_CALLS=3`. При отсутствии подходящего free route сохранить pending state и применять paid Qwen только после отдельной freshness-SLA policy.
5. Записывать selected route, skipped reason, estimate, usage и provider headers. Для TPD exhaustion включить per-run circuit breaker только для доказанного exhausted model.

### Обязательные тесты

- Qwen 27b получает production V2 prompt и проходит обычный validator.
- Невалидный, англоязычный или provenance-несовместимый candidate не публикуется.
- Medium input выбирает Qwen 27b; short input может выбрать 8b; large input пропускает 8b.
- Первый TPD 429 отключает только этот model для оставшихся stories текущего run; новый run начинает с чистого state.
- 429 TPM, timeout и transport error не выключают route навсегда.
- Free exhaustion сохраняет retryable pending result и не вызывает paid model до SLA.
- Каждый physical call учитывает budget, поэтому paid fallback остаётся достижимым в трёх attempts.
- `llm_usage` хранит actual `gateway` и `model_used`.

## Фаза 4: rollout и rollback

1. Включить flag для ограниченной доли medium stories. Не менять high-value 70b path.
2. После каждого из восьми scheduled runs записывать:
   - summaries written и deterministic fallbacks;
   - candidate validation/rejection failures;
   - 70b/Qwen27b/8b/paid Qwen calls и tokens;
   - 413, TPM 429, TPD 429, timeout;
   - queue age и paid fallback age;
   - duration workflow.
3. Откатить flag немедленно, если появляется provenance failure, падение validated rate ниже 95%, русский summary проходит слабее baseline, либо p95 превышает deadline два runs подряд.
4. После восьми runs сравнить paid Qwen tokens, summary freshness и error rate с предыдущим rolling window. Только тогда сделать candidate default fallback.

## Альтернативы

- **Сразу сменить 8b на Qwen 27b.** Отклонено: availability probe не проверяет русский, provenance и длительные треды.
- **Поставить OSS 120b вторым hop.** Отложено: отдельный quota bucket полезен, но JSON и русский ещё не доказаны.
- **Отправлять всё на 8b.** Отклонено: 6k TPM/request limit вызывает 413 на real large threads.
- **Убрать LLM compression.** Отклонено: semantic compression — product requirement.
- **Использовать Compound.** Отклонено: orchestration route не даёт стабильного model/output contract для reproducible eval.

## Файлы, которые вероятно изменятся

```text
eval/run-comments-candidates.mts          # новый paired model-vs-model runner
eval/comments-services.ts                 # explicit route factory или отдельный adapter
eval/score-comments.ts                    # neutral candidate labels/gates при необходимости
tests/comments-eval-services.test.ts      # direct-Groq route, metadata, blind judge
tests/summarize.comments-v2.test.ts       # selection, budget и failure contracts
pipeline/summarize.ts                     # только после Phase 2 PASS
config/env.ts
.env.example
```

Перед implementation создать isolated worktree: затрагиваются несколько subsystems. Не коммитить `data/bench/` results и не менять production/generated data во время eval.

## Verification после каждой фазы

```bash
bun test <затронутые test files>
make test
make lint
make typecheck
make build
git diff --check
git diff --stat -- . ':!data'
```

Зафиксировать pre-existing failures отдельно. Для test suites, которые могут загрязнять environment, запускать affected files в обоих порядках.

## Условия завершения

Работа завершена, когда Qwen 27b прошёл полный gate, отработал восемь scheduled runs под feature flag без rollback trigger и уменьшил paid Qwen usage без ухудшения quality/freshness. Если он не проходит, результат всё равно полезен: текущий route остаётся безопасным, а OSS 120b становится следующим отдельным кандидатом для Phase 1.
