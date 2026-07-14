# Ф4: валидация escalation-модели для content-reject

Дата фиксации критериев: 2026-07-14 (до запуска бенча).

## Критерии production route

`SUMMARY_CONTENT_REJECT_MODEL` можно включить только для **точного route/model id**,
который одновременно проходит:

1. language-fail-rate ≤ 10% и не выше baseline;
2. mean language purity ≥ 4.5;
3. faithfulness и overall не ниже baseline более чем на 0.2;
4. error rate ≤ 10%;
5. p95 latency ≤ 60 секунд.

Если точный route не прошёл все условия, переменная остаётся пустой и content-reject retry
использует прежнюю default model chain.

## Что реально измерено

На одинаковых 12 статьях × 3 повтора были получены quality-замеры:

| Фактически измеренный route | lang-fail | purity | overall | faith | heur pass | error | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| nemotron-3-nano-30b `:free` (baseline, 8k) | 36% | 3.64 | 3.33 | 3.67 | 58% | 0% | 80 с |
| llama-3.3-70b через Groq/9Router | 0% | 4.53 | 4.06 | 4.53 | 100% | 0% | 43 с |
| qwen3-next-80b, платный OpenRouter route | 0% | 4.86 | 4.47 | 4.53 | 86% | 0% | 9 с |

Эти результаты подтверждают качество весов на использованных routes, но не являются
availability/latency-доказательством для других routes.

Дополнительный production-smoke точного paid route
`qwen/qwen3-next-80b-a3b-instruct` с strict escalation prompt прошёл 2026-07-14:
1/1 успешных ответов, 10.36 с, 1021 символ, heuristic/language gate без триггеров.

## Почему не `:free` route

Точные OpenRouter routes
`qwen/qwen3-next-80b-a3b-instruct:free` и
`meta-llama/llama-3.3-70b-instruct:free` в той сессии дали 100% upstream rate-limit.
Следовательно, они не прошли критерии error-rate и p95; объявлять
`meta-llama/llama-3.3-70b-instruct:free` победителем было некорректно.

Решение: production winner — paid OpenRouter route
`qwen/qwen3-next-80b-a3b-instruct`. Он прошёл зафиксированные quality,
error-rate и p95 критерии, а также strict-prompt smoke. `config/env.ts`, `.env.example`
и hourly workflow используют его по умолчанию; GitHub repository variable может
явно переопределить model id.

## Ф7: EN→RU two-step

Эксперимент для nemotron (8k токенов) дал: direct — 36% lang-fail, purity 3.64,
overall 3.33, p95 80 с; two-step — 22%, 3.50, 3.08, 210 с. Two-step в production не
переносится: качество ниже, а latency почти втрое выше.

## Матрица фаз

| Фаза | Done | Verified | Deferred |
|---|---|---|---|
| Ф1 detector/calibration | Детектор и committed labeled fixture | 12/12 manual-label agreement; detector unit tests | — |
| Ф2 RU gate/prompt | Gate, env и call-sites | Targeted unit tests | — |
| Ф3 judge | `language_purity` и leaderboard | `score-models` tests | — |
| Ф4 model selection | Выбран paid Qwen3 Next OpenRouter route | 12×3 quality run + strict smoke | Free-route не используется |
| Ф5 escalation | Ordered chain и paid default в hourly workflow | Post escalation tests | — |
| Ф6 comments | Validation, retry и severity comparator | Comments validation tests | — |
| Ф7 EN→RU | Эксперимент завершён, rollout отклонён | Direct/two-step результаты зафиксированы | — |
