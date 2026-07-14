# Калибровка языкового гейта RU-саммари (Ф1)

Дата: 2026-07-14. Скрипт: `scripts/calibrate-language-gate.mts` (read-only).
Выборка: `data/summaries/*.post.json` + `*.comments.json`, фильтр `lang === "ru" && createdISO >= "2026-07-09"` → **132 post + 150 comments = 282 саммари** (manifest: `docs/language-gate-manifest.json`).

Детектор: `utils/language-gate.ts` (`analyzeRussianLanguagePurity`).

## Итоговая конструкция детектора

Препроцессинг (`stripNonProse`): удаляются fenced/inline-код, URL, markdown-ссылки (остаётся label), **цитаты** «…», “…”, "…" (≤300 симв. — цитирование UI-строк/твитов/названий легитимно) и **скобочные глоссы без кириллицы** ≤60 симв. («осевого (axial flux) двигателя»).

Сигналы:

1. **`low_cyrillic_ratio`** — prose-eligible ratio: кириллические буквы / (кириллические + буквы **lowercase-латинских слов**). Capitalized/CamelCase/ALL-CAPS-токены, токены с цифрами и allowlist-инструменты — это имена, не проза, в знаменатель не входят (иначе легитимный обзор с GLM‑5.2/MiniMax/DeepSeek падал до 0.71). Порог по калибровке: **0.8**.
2. **`latin_prose` strong** — run из ≥2 подряд lowercase-латинских слов, содержащий английское function word ИЛИ длиной ≥4 слов. Runs рвутся на пунктуации (запятые ломают перечисления «npm, krew и winget»). Исключения: run целиком из allowlist; «командная идиома» из 2 слов с allowlist-первым («brew bundle», «podman machine»); runs только из function words рядом с Capitalized-соседом («Car **of the** Year»).
3. **`latin_prose` singletons** — одиночное lowercase-латинское слово ≥3 букв, входящее в словарь дефектных слов: function words (thus, alike, per…), частотные глаголы (admits, imposes, lets…), морфология `-tion/-sion/-ment/-ness/-ance/-ence`, `-ly` (с blocklist RU-техжаргона: production, performance, inference, assembly, early, daily…), кураторские (precedents, dissent, impasse, sovereign, fight, sharp). Не флагаются: allowlist, соседство с Capitalized-токеном («Institute **for** Highway Safety») или числом («600 **dpi**», «release 22.03»).
4. **soft noun-runs** (2–3 lowercase-слова без function words: «unified memory», «load average») — precision ~40% на выборке, **по умолчанию выключены** (`flagSoftRuns: false`); включаются опционально.

## Результаты на выборке (282 саммари)

Распределение prose-eligible ratio: p5 = 0.914, p10 = 0.978, p50 = 1.0. Полностью английские саммари — ratio = 0.

| Сигнал | Срабатываний | Ручная разметка |
|---|---|---|
| ratio < 0.8 | 12 доков | 12/12 true — целиком английские саммари (100% precision) |
| strong runs (ratio ≥ 0.85) | 4 дока | 3 true («lets you drag…», «equipped with…», «lets you compare results globally»), 1 gray («41 shades of blue» — незакавыченное название) |
| singletons (ratio ≥ 0.85) | 8 доков | 8/8 true: rejection, alike, dissent, sharp, fight, impasse, thus, precedents (100% precision) |
| soft noun-runs | 19 доков | ~40% precision (unified memory, load average, resident set size — FP) → выключены |

Все 4 канонических дефекта из `docs/product-review-summarization.md` §2 ловятся: «создают **precedents**», «**lets you compare results globally**», «для от **rejection**», «которым **alike**». Анти-примеры (GitHub, OpenWrt, API, systemd, npm, curl, nginx, htop-обзор) — 0 ложных срабатываний на уровне hard-сигналов.

Итог по выборке: hard-сигналы флагают 24/282 (~8.5%) — самые грубые дефекты; остальная часть из «54/132» ревью (стилистические кальки без латиницы) — зона judge-метрики `language_purity` (Ф3).

## Дефолты

- `SUMMARY_MIN_CYRILLIC_RATIO = 0.8`
- strong runs: включены; singletons: включены; soft noun-runs: выключены.

Воспроизведение: `bun run tsx scripts/calibrate-language-gate.mts --data-dir data/summaries --out-dir <dir>` (отчёт `hits.json` со всеми срабатываниями и контекстами).
