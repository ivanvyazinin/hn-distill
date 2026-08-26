# Probe: модель comments-compress на продовых входах — 26.08.2026

Повод: юзер-репорт «карточки без суммаризации — только "Спор:" и цитаты» + WARN-шторм
`Comments compress semantic reject {reason:'expanded:N>M'}` / `transport error: empty content`
в hourly после рефактора 25.08.

## Метод

Точные продовые входы: тексты `renderCommentsInsightsPlainText`, реконструированные из
6 застрявших карточек живого сайта (совпадают с логами байт-в-байт: источник
49434378 = 3237 символов, как в `expanded:4547>3237`). Промпт, temperature 0.2,
max_tokens 1000 — как прод. Валидация — питон-порт `sanitizeCompressedOutput` +
`validateCompressedText` (≥200 знаков, ≤ источника, cyrillic ≥0.65, чистый конец).
n=6×1, один снимок часа.

## Результаты

| роут | OK | поведение |
|---|---:|---|
| nvidia/nemotron-3-super-120b-a12b:free (прод-дефолт) | **1/6** | у всех вызовов `finish=length`: жжёт все 1000 токенов в reasoning-трейсе; раздувает источник ×1.4 (`expanded`) или режет (`too_short:189<200`) |
| **minimax/minimax-m3:free (OpenRouter)** | **6/6** | чистое сжатие до ~50–65% источника, `finish=stop`, 450–710 completion-токенов, 6–9 c |
| qwen/qwen3-next-80b-a3b-instruct (платный) | 5/6 | один ответ целиком англицкий (поймал cyrillic-gate) |
| MiniMax-M3 через официальный API | 1/6 | раздувает как нематрон (`expanded:4221>2782` и т.п.) |

Сырые результаты: `/tmp/probe_results.json` (сессия 26.08), скрипт — python-порт
санитайзера; повторять лучше сразу через eval-харнесс.

## Выводы

1. **Дефолт `COMMENTS_COMPRESS_MODEL` сменён на `minimax/minimax-m3:free`.**
   Нематрон на этой задаче не сжимает, а переписывает длиннее — семантический гейт
   это правильно отбрасывает, но карточка навсегда остаётся в сыром bullet-рендере.
2. **Официальный MiniMax API для compress НЕ годится**, хотя это та же модель:
   без обвязки OpenRouter она раздувает текст. Не путать хопы.
3. Волатильность `:free` принята: транспортный фейл = поле отсутствует =
   retryable-pending, следующий hourly повторит. Объём (~40 вызовов/день) помещается
   в квоту 1000/день.
4. Второй симптом юзер-репорта — «Спор:, Спор:,…» ×12 в fallback-рендере — это
   stage-1 MiniMax-M3 вешает `kind="dispute"` почти на все инсайты. Лечится
   демоцией хвоста до consensus в `evaluateCommentsInsightsCandidate` (cap 3).

## Бэклог

Застрявшие карточки (compressed absent/rejected) сами не оживут: hourly трогает
только текущее окно TOP_N. Нужен sweep по процедуре handoff-manual-compress-72h:
pull VPS → `backfill-comments-v2.mts --all-structured --compress-only`
(+ точечно `--force --ids …` для терминальных reject-маркеров) → push → rebuild.
