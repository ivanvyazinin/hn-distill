# План: обход Cloudflare 403 при фетче статей

Заметка для продолжения в другой сессии. Статус: **реализовано** (Jina reader fallback в `utils/article-fetch.ts` + `makeServices().fetchArticleMarkdown`; env `ARTICLE_FETCH_READER_FALLBACK` / `JINA_API_KEY` / `ARTICLE_READER_BASE_URL`).

## Контекст / что триггернуло

В логах hourly-build (напр. run 29366132126) регулярно висит:

```
ERROR summarize/article: Failed to fetch content
  error: 'HttpError: HTTP 403 <!DOCTYPE html>...<title>Just a moment...</title>...challenges.cloudflare.com...'
WARN summarize/post: No article content – skipping post prompt { id: 48872401 }
WARN summarize/post: Empty post prompt; skipping LLM { id: 48872401 }
```

Это **не баг нашего кода** — внешний сайт за Cloudflare отдаёт анти-бот заглушку.
Обработка graceful: `catch` в `pipeline/summarize.ts:1063` ловит, логирует ERROR, возвращает `{}`,
стори пропускается по article-промпту (саммари комментов может сделаться отдельно). Ран остаётся зелёным.

Конкретная стори из лога — `48872401`:
- Title: **"The largest available Minecraft world, totalling 15 TB"** (сервер 2b2t)
- URL: `https://2b2t.place/1million` — домен за Cloudflare
- 180 очков, 61 коммент

## Диагноз

Заглушка "Just a moment..." с CSP на `challenges.cloudflare.com` = **JS-challenge**, НЕ простой bot-fight.
- Обычным HTTP-клиентом НЕ проходится — нужен исполняемый JS в браузере.
- Подкрутка заголовков (`Accept`, `Accept-Language`, `Sec-Ch-Ua`…) тут почти наверняка НЕ поможет.
- Усугубляет: датацентровый IP GitHub Actions у Cloudflare в дефолтном чёрном списке.

## Текущее состояние фетча (`utils/http-client.ts`)

- node `fetch` (через tsx/node).
- Отправляет только `user-agent` (Chrome UA, строка в конструкторе `HttpClient`, ~line 74), для json ещё `accept`.
- НЕТ полного набора браузерных заголовков.
- Retry только на статусах 408/425/429/5xx/522 — 403 не ретраится (правильно).

## Варианты (по возрастанию усилий)

1. **Jina Reader (РЕКОМЕНДОВАНО)** — префикс `https://r.jina.ai/` перед URL,
   сервис сам рендерит страницу (проходит Cloudflare на своей стороне) и **возвращает готовый markdown**.
   Пример: `https://r.jina.ai/https://2b2t.place/1million`
   - Почти бесплатно (free-tier + опц. `JINA_API_KEY` для лимитов), без headless-браузера у нас.
   - Идеально как fallback: прямой фетч → при 403/challenge → reader → markdown в тот же extract-пайп.
2. **Архивная копия** — фолбэк на `web.archive.org` / `archive.ph`, минуя origin. Покрытие неполное.
3. **Платный scraping-API** — Firecrawl / ScrapingBee / Browserless (headless + резидентные прокси). Оправдано если таких статей много.
4. **Playwright + stealth + резидентный прокси** — НЕ советую: тяжело, дорого по CI, JS-challenge всё равно может резать DC-IP.

## Предложенная реализация (пункт 1)

Тиерный fallback в `getCachedArticleMarkdown` (`pipeline/summarize.ts`, ~line 1063 catch):
- На `HttpError` со статусом 403 ИЛИ детект "Just a moment"/challenges.cloudflare.com в теле →
  повторить через `r.jina.ai`.
- Если reader тоже не отдал → оставить текущий graceful-skip (return `{}`).
- Env-флаг для включения (напр. `ARTICLE_FETCH_READER_FALLBACK=true`) + опц. `JINA_API_KEY` (заголовок `Authorization: Bearer ...`).
- Сохранять результат в тот же кэш (`store.putText` / `upsertArticleExtract`), пометить `sourceKind` = reader-fallback для отслеживания.

### Точки в коде
- `utils/http-client.ts` — где формируются заголовки (constructor ~74, `doFetch` ~126).
- `pipeline/summarize.ts:1063` — catch блок фетча статьи (место вставки fallback).
- `pipeline/summarize.ts:494` — "No article content – skipping post prompt".

### Открытые вопросы
- Reader-fallback только для GH Actions или и локально?
- Понижать ли ERROR→WARN для явных Cloudflare/403 случаев (сейчас `ERROR summarize/article`), чтобы ERROR остался сигналом реальных проблем. (Отдельный мелкий пункт, можно сделать заодно.)
- Нужен ли учёт стоимости/частоты reader-вызовов (счётчик/лог).

## Как продолжить

> Реализуй reader-fallback (Jina) для фетча статей по плану в
> `docs/plan-cloudflare-article-fetch-fallback.md`. Начни с диффа для review.
