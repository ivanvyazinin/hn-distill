# Ф4: Выбор escalation-модели для content-reject (direct-RU бенч)

Дата фиксации критериев: 2026-07-14 (ДО запуска бенча).

## Setup

- Кандидаты: `nvidia/nemotron-3-nano-30b-a3b:free` (текущий primary, baseline),
  `qwen/qwen3-next-80b-a3b-instruct:free`, `meta-llama/llama-3.3-70b-instruct:free`.
- Judge: `xai/grok-4` (→ grok-4.3) через локальный 9Router, structured output проверен.
- `SUMMARY_LANG=ru`, промпт продовый (`buildPostChatMessages`, strict:false, с новой
  языковой строкой), статьи — фиксированный префикс `bench/manifest.json` (12 id), repeats = 3.
- Команда: `bun run data:score --models <3 модели> --articles <12 id> --repeats 3`.

## Числовые критерии выбора (зафиксированы до запуска)

Победитель — модель с максимальным `composite_rank`, удовлетворяющая ВСЕМ условиям:

1. **language-fail-rate** (доля прогонов с `latin_prose` или `low_cyrillic_ratio` в
   heuristic-триггерах) **≤ 10%** и **не выше**, чем у baseline (nemotron) в этом же прогоне;
2. **mean_language_purity ≥ 4.5**;
3. **mean_faithfulness ≥ baseline − 0.2** и **mean_overall ≥ baseline − 0.2**;
4. **error_rate ≤ 10%**;
5. **p95_latency_ms ≤ 60 000** (эскалация — не latency-критичный путь, лимит защищает от
   патологических очередей free-tier).

Если ни один кандидат не проходит — эскалация остаётся на дефолтной цепочке fallback-моделей
(решение по SUMMARY_CONTENT_REJECT_MODEL откладывается, Ф5 реализуется с дефолтом = primary
chain), вопрос эскалируется пользователю.

Победитель записывается в `SUMMARY_CONTENT_REJECT_MODEL` (новая env-переменная).

## Отклонения от плана прогона (зафиксированы по ходу)

- `:free`-слаги qwen3-next-80b и llama-3.3-70b на OpenRouter были **полностью
  rate-limited upstream** (провайдер Venice, вечерний пик; 100% ошибок с ретраями).
  Качество измерено на тех же весах через другие маршруты: **`qwen/qwen3-next-80b-a3b-instruct`
  (платный слаг OpenRouter)** и **`groq:llama-3.3-70b-versatile` (через локальный 9Router)**.
  Замер качества валиден (те же веса); `error_rate`/`p95` для продовых `:free`-слагов
  этой сессией не измерены — прод-путь остаётся `:free`, доступность транзиентна.
- Baseline nemotron дополнительно перегнан с `BENCH_SUMMARY_MAX_TOKENS=8000`
  (прод-значение `OPENROUTER_MAX_TOKENS`): у reasoning-модели бюджет 2048 обрезал
  рассуждения и «need to produce…» протекал в выдачу, занижая baseline.

## Результаты (2026-07-14, 12 статей × 3 повтора, judge grok-4.3)

| Модель | lang-fail | purity | overall | faith | heur pass | error | p95 | composite |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| nemotron-3-nano-30b (baseline, 8k tok) | 36% | 3.64 | 3.33 | 3.67 | 58% | 0% | 80 c | 1.94 |
| **llama-3.3-70b** (groq-маршрут) | **0%** | 4.53 | 4.06 | 4.53 | **100%** | 0% | 43 c | **4.06** |
| qwen3-next-80b (платный слаг) | **0%** | **4.86** | **4.47** | 4.53 | 86% | 0% | **9 c** | 3.85 |

Оба кандидата проходят все критерии. **Победитель по зафиксированному правилу
(max composite среди прошедших): `meta-llama/llama-3.3-70b-instruct:free`** →
`SUMMARY_CONTENT_REJECT_MODEL`.

Примечания:
- qwen — сильный runner-up: выше purity (4.86 vs 4.53), overall (4.47 vs 4.06) и на
  порядок быстрее (p95 9 c vs 43 c); composite ему срезали 5 не-языковых heur-реджектов
  (2× артефакт `<|`, 3× URL в тексте на одной статье). В проде такой брак эскалационной
  попытки сжигает strict-attempt — именно это composite и штрафует.
- Baseline подтверждает первопричину из ревью: даже при прод-бюджете токенов primary
  даёт 36% языкового брака (утечки английских рассуждений «need to produce…»), purity 3.64.
- У кандидатов lang-fail-rate 0% на 72 прогонах.

## Ф7: EN→RU two-step (nemotron@en-ru)

При бюджете 2048: purity 1.58 vs 2.06 у direct — двухшаговка **хуже** (второй вызов
удваивает поверхность утечки рассуждений). Прогон при 8000 — см. дополнение ниже.
