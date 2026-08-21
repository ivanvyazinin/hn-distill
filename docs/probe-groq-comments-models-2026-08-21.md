# Probe: замена comments-моделей Groq (2026-08-21)

Контекст: Groq shut down `llama-3.3-70b-versatile` 2026-08-16 (официальная страница
deprecations); `llama-3.1-8b-instant` легла той же волной. С 17.08 в проде
0 ok / 92 err на этих двух хопах (`llm_usage`, см. `docs/ops/2026-08-21/report.md`).

Метод: прямые вызовы Groq API прод-ключом, промпт «саммари комментариев HN →
строгий JSON на русском». Прогон 1 — 2 комментария, max_tokens 400;
прогон 2 — 15 комментариев (~566 prompt tok), max_tokens 2500.

## Результаты

| модель | режим | итог |
|---|---|---|
| llama-3.3-70b-versatile | — | **404** model_not_found (подтверждение shutdown) |
| llama-3.1-8b-instant | — | **404** model_not_found |
| openai/gpt-oss-120b | как есть | 200, чистый JSON в `content`, reasoning в отдельном поле `message.reasoning`; 2.3s, compl 914 |
| qwen/qwen3.6-27b | без флагов | 200, но `<think>` идёт **внутри content** → json-BAD при малом бюджете |
| qwen/qwen3.6-27b | `response_format: json_object` | **400** `json_validate_failed` |
| qwen/qwen3.6-27b | `reasoning_effort: "none"` | 200, чистый JSON; 1.6s, compl 558 |
| openai/gpt-oss-20b | как есть | 200, чистый JSON; 1.2s, compl 833 |

## Вывод

- **Primary**: `openai/gpt-oss-120b` — официальная замена Groq, контент чистый
  при любом флаге (reasoning наружу из content не вытекает).
- **Fallback**: `openai/gpt-oss-20b` — слот в `buildCommentsModelChain` не
  передаёт `reasoning_effort`, поэтому туда годится только модель с чистым
  контентом без флагов.
- **qwen3.6-27b** остаётся на secondary-route хопе — тот единственный передаёт
  `reasoning_effort:"none"` (pipeline/summarize.ts) и работает в проде с июля.
