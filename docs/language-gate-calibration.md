# Калибровка языкового гейта RU-саммари (Ф1)

Дата: 2026-07-14. Детектор: `utils/language-gate.ts`. Скрипт:
`scripts/calibrate-language-gate.mts` (read-only на входных данных).

## Воспроизводимая выборка

В репозитории лежит компактный fixture
`docs/language-gate-calibration-fixture.json`: 12 текстов с ручными метками
`expectedSignals`. Он содержит 7 известных дефектов и 5 precision-антипримеров:
lowercase-инструменты, короткую UI-строку, proper-name phrase, скобочный технический
глосс и командную идиому.

Команда из чистого checkout:

```sh
bun run tsx scripts/calibrate-language-gate.mts --out-dir /tmp/language-gate-calibration
```

Фактический результат текущей реализации:

- loaded: 12 (10 post, 2 comments);
- production threshold: `SUMMARY_MIN_CYRILLIC_RATIO = 0.8`;
- hard signal: 7/12;
- strong runs: 3; singletons: 3;
- agreement с ручными метками: 12/12.

Скрипт завершится ошибкой при любом расхождении меток и запишет полный
`report.json` с текстом после препроцессинга, ratio, runs и singletons.

## Конструкция детектора

1. `low_cyrillic_ratio`: кириллица / (кириллица + lowercase-латинская проза), порог
   0.8. Отдельный case-insensitive fallback ловит полностью латинский текст из четырёх
   и более слов, включая ALL-CAPS, не штрафуя одиночные названия и акронимы.
2. `latin_prose` strong: run из двух и более lowercase-латинских слов с английским
   function word либо run длиной от четырёх слов.
3. `latin_prose` singleton: precision-first словарь английских function words,
   глаголов и характерной морфологии. Proper-name glue допускается только между двумя
   Capitalized-токенами (`Institute for Highway Safety`), поэтому `OpenAI admits`
   остаётся видимым.
4. Soft noun-runs по умолчанию выключены из-за низкой precision.

Fenced/inline code и URL удаляются. Короткие цитаты до трёх слов считаются UI/title
термами; длинная цитата остаётся прозой и анализируется. Короткие латинские глоссы в
скобках исключаются.

## Локальная exploratory-выборка

При наличии generated summaries можно отдельно запустить:

```sh
bun run tsx scripts/calibrate-language-gate.mts \
  --data-dir data/summaries --since 2026-07-09 --out-dir /tmp/language-gate-local
```

Этот режим не является источником committed цифр: `data/summaries` зависит от локального
snapshot. Прежний manifest только с ID/датами удалён, потому что без текстов и ручных меток
он не позволял воспроизвести ни выборку, ни precision.
