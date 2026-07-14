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

## Результаты

_(заполняется после прогона)_
