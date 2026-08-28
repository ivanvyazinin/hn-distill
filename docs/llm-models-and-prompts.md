# LLM models and prompts

**Статус:** живая reference для production и offline-проверок

Обновляйте этот документ при изменении модели, gateway, порядка fallback, prompt,
JSON-схемы или validation-gate. Источник runtime-значений — `config/env.ts` и
секреты/variables workflow. Значения ниже — defaults из кода; production может
переопределить их через environment.

## Production map

| Stage | Models | Provider | Оплата | Назначение и поведение |
|---|---|---|---|---|
| Post summary | `nvidia/nemotron-3-super-120b-a12b:free` → `nvidia/nemotron-3-super-120b-a12b` → `meta-llama/llama-3.3-70b-instruct` | OpenRouter | Первый hop — free pool; остальные — paid route | Пересказ статьи на русском. При heuristic/guard reject выполняются strict retries; для них используется `SUMMARY_CONTENT_REJECT_MODEL` (`qwen/qwen3-next-80b-a3b-instruct`) и затем fallback. |
| Comments-v2, stage 1 | `MiniMax-M3` → `openai/gpt-oss-120b` → `openai/gpt-oss-20b` → optional `COMMENTS_FALLBACK_MODEL_2` → `qwen/qwen3-next-80b-a3b-instruct` | MiniMax API → Groq → OpenRouter | MiniMax — free quota; Groq — ваш бесплатный tier; последний qwen — paid | Структурированный анализ HN-треда: `bottom_line`, `insights[]`, optional `best_quote`. MiniMax hop добавляется только при `MINIMAX_API_KEY`; Groq hops — только при `GROQ_API_KEY`. Последний qwen hop — cross-provider fallback. |
| Comments compression | `minimax/minimax-m3:free` → `qwen/qwen3-next-80b-a3b-instruct` | OpenRouter | Первый hop — free pool; второй — paid route | Второй проход: structured insights превращаются в один русский абзац. Transport и model-specific language/format rejects передаются следующему hop; `expanded` и `too_short` остаются terminal. |
| Tags | `openai/gpt-oss-20b` | Groq при `GROQ_API_KEY`, иначе основной client | Ваш бесплатный Groq tier; при отсутствии ключа billing зависит от основного client | Извлечение до `TAGS_MAX_PER_STORY` нормализованных тегов. При полном отказе используются deterministic heuristics; второго LLM hop нет. |
| Post guard | `openai/gpt-oss-20b` | Groq при `GROQ_API_KEY`, иначе основной client | Ваш бесплатный Groq tier; при отсутствии ключа billing зависит от основного client | Проверка post summary: статья ли это, отказ, verdict, confidence. `POST_GUARD_FALLBACK_MODEL` по умолчанию пустой; при недоступности guard summary принимается только через heuristics. |
| Content-reject escalation | `qwen/qwen3-next-80b-a3b-instruct` → `OPENROUTER_FALLBACK_MODEL` | OpenRouter | Зависит от конкретного model id; defaults — paid route | Strict retry для post summary после language/heuristics/guard reject. Это не отдельный stage публикации. |

### Providers and billing

| Provider | Credential | Free / paid rule | Что проверить при изменении |
|---|---|---|---|
| MiniMax official API | `MINIMAX_API_KEY` | `MiniMax-M3` используется как free-first hop; текущая конфигурация считает его route с ценой `$0`. Квоты и latency остаются ограничениями. | Token Plan, лимиты и фактический статус account |
| OpenRouter | `OPENROUTER_API_KEY` | Slug с суффиксом `:free` — free pool. Slug без `:free` — paid route и требует credits. | Model page, credits, upstream rate limits |
| Groq | `GROQ_API_KEY` | В текущем setup используется только бесплатный tier. `openai/gpt-oss-*` — free-tier API calls, ограниченные лимитами аккаунта. | Free-tier limits, rate limits и актуальность model id |

`MiniMax-M3` и `minimax/minimax-m3:free` — разные записи в ledger:

- `MiniMax-M3` — stage-1 comments через официальный MiniMax API;
- `minimax/minimax-m3:free` — comments-compress через OpenRouter.

Фраза «иначе основной client» в таблице описывает только выбор gateway при
отсутствии `GROQ_API_KEY`. Она не означает, что текущий Groq setup платный.

Поэтому плохая недельная строка `MiniMax-M3: 62 calls, 19 OK, 43 errors`
описывает stage 1, а не compression. Из 43 errors у 41 не было ответа и токенов;
логи показывают `Request timed out` на MiniMax hop. Два ответа были получены, но
завершились ошибкой обработки/валидации. Счётчик считает попытки, а не карточки.

### Model-specific constraints

- `MiniMax-M3` получает `reasoning_effort=none` и отдельный timeout
  `COMMENTS_MINIMAX_REQUEST_TIMEOUT_MS`. Без этого reasoning может занять весь
  budget. Текущий default — 22 секунды; значение остаётся ограничено общим
  40-секундным worker task budget, shared comments budget и fallback hops.
- `qwen/qwen3.6-27b` нельзя ставить в обычные Groq comments slots без
  `reasoning_effort=none`: модель может вернуть `<think>` внутри JSON.
- OpenRouter free-модели не использовать для strict comments JSON без проверки:
  они могут вернуть prose вместо schema-compatible object.
- При смене `COMMENTS_COMPRESS_MODEL` увеличьте
  `COMMENTS_COMPRESS_POLICY_VERSION`, если нужно принудительно пересжать уже
  сохранённые абзацы. Простая смена модели существующие результаты не инвалидирует.

## Prompt contracts

### Post summary

Builder: `buildPostSystemInstruction` и `buildPostPrompt` в
`pipeline/summarize.ts`. User message содержит article slice: до
`ARTICLE_SLICE_CHARS` символов, для длинной статьи — head плюс tail.

Production RU system prompt:

```text
Ты пишешь точные и ёмкие пересказы статей Hacker News в Markdown на русском языке.
Пиши только по-русски: латиница допустима лишь для имён собственных, названий продуктов, терминов в кавычках и кода — не вставляй английские слова и фразы в связный русский текст.
Стремись к ~170 словам в двух коротких абзацах; третий добавляй только если он действительно помогает.
Выделяй главную идею и пару ярких фактов, цитат или цифр, которые стоит запомнить.
Не называй заголовок, автора, дату публикации и источники.
Начинай сразу с сути, без заголовков вроде 'Саммари:' и без финальных клише.
Важно: упоминай всю ключевую информацию из статьи, не теряй её. Будь точен и лаконичен.
```

Strict retry добавляет:

```text
Никаких отказов, извинений или упоминаний политик.
Никогда не переходи на английский: весь связный текст — на русском.
Если в материале мало деталей, перескажи то, что есть, и укажи ключевые факты.
Не упоминай себя и само задание.
```

User message — только article slice. Не добавляйте в него title, byline или
инструкции: системный prompt запрещает их пересказывать.

### Comments-v2 stage 1

Builders: `buildCommentsSystemInstructionV2` и `buildCommentsPromptV2` в
`utils/comments-thread.ts`. Сначала строится thread из маркеров
`[comment_id=<id> @<user>]`; затем добавляется JSON contract с динамическим
`maxInsights`.

RU system prompt:

```text
Точно и кратко анализируй обсуждения Hacker News на русском языке.
Возвращай только JSON по запрошенной схеме, без Markdown-ограждений и пояснений.
Сохраняй ники и технические термины; не выдумывай тезисы, консенсус, споры, советы и цитаты.
kind="dispute" только при настоящем споре с содержательными аргументами обеих сторон — обе стороны внутри text.
Атрибутируй опыт, когда он есть (например: «по опыту @ник в проде…»); предпочитай голоса с прямым опытом.
Ранжируй: самое ценное первым. <maxInsights> — потолок, не план. Один факт = один insight; 2 плотных лучше 5 общих.
```

При strict retry добавляется:

```text
Строго соблюдай JSON-схему, не отказывайся от анализа и не добавляй вымышленных фактов.
```

RU user prompt имеет форму:

```text
Тема поста: <title>
Суть статьи: <до 400 символов post summary, если summary не degraded>
Обсуждение:
<выбранные comment branches с [comment_id=...]>

Верни только один JSON-объект по этой точной JSON Schema:
<dynamic CommentsInsights schema with insights.maxItems=<maxInsights>>
best_quote — null либо объект с comment_id из обсуждения, дословным source_text и отдельным translation; для EN translation=null.
Не повторяй суть статьи; извлекай только то, что тред ДОБАВЛЯЕТ (опыт эксплуатации, возражения, цифры из практики, механизмы). bottom_line — что тред добавляет к статье: подтверждает/опровергает/дополняет — и чем.
Не добавляй сведения, которых нет во включённых комментариях.
```

Если post summary отсутствует или помечен `no-article`, вместо правила про
добавление используется `bottom_line — главный вывод треда.`

Acceptance после ответа модели:

- JSON соответствует `CommentsInsightsSchema`.
- `best_quote` проходит provenance check по `comment_id` и дословному тексту.
- `kind="dispute"` ограничен тремя карточными labels; хвост переводится в
  `consensus`.
- Русский текст проходит cyrillic/heuristics gates.
- Rendered summary имеет минимум `COMMENTS_SUMMARY_MIN_CHARS` символов.

### Comments compression

Builder: `buildCommentsCompressUserPrompt` в `utils/comments-compress.ts`.
Модель получает один user message, без system message:

```text
Сожми текст: убери повторы, канцелярит и лишние пояснения, объедини близкие мысли. Сохрани факты, смысл и важные оговорки. Ничего не добавляй от себя. Верни только итоговый текст.

<plain text: bottom_line plus insights; dispute gets prefix «Спор: », advice gets «Совет: »>
```

Acceptance после ответа модели:

- результат очищен до одного абзаца;
- длина не меньше `COMMENTS_SUMMARY_MIN_CHARS`;
- результат не длиннее исходного plain text;
- русский текст проходит `COMMENTS_MIN_CYRILLIC_RATIO` и comment heuristics.

### Tags

Builders: `buildTagsPrompt` и `buildTagsRules` в `utils/tags-extract.ts`.
User message:

```text
Title: <story title>
URL: <story URL или N/A>
Domain: <hostname или пусто>

Article summary:
<post summary, если есть>
```

Structured system prompt начинается так:

```text
Answer in JSON. You are a technical content categorization expert. Extract only the most relevant and certain tags from the given content.
```

Далее rules требуют явных упоминаний, lowercase normalized names, конкретные
технические категории и не более `TAGS_MAX_PER_STORY` тегов. Допустимые `cat`:
`topic`, `lang`, `lib`, `framework`, `company`, `org`, `product`, `standard`,
`person`, `event`, `infra`, `other`.

Plain fallback требует raw JSON без Markdown fences:

```text
Answer in JSON format: { "tags": [{ "name": "...", "cat": "..." }] }. Return raw JSON only, without Markdown fences or commentary.
```

### Post guard

Builder: `buildGuardPrompt` в `utils/summary-guard.ts`.
System prompt:

```text
You are a strict quality gate for article summaries.
Return exactly one JSON object and always include every key:
{"ok":true,"is_article":true,"refusal":false,"verdict":"ok","reasons":[],"confidence":0.95}

Rules:
- "ok", "is_article", and "refusal" are booleans.
- "verdict" must be one of: nonsense, not_article, ok, other, refusal, too_generic, too_short.
- "confidence" is a number from 0 to 1; never omit it.
- "reasons" is always an array of at most two short strings; use [] when no reason is needed.
- Output JSON only, without Markdown or commentary.
```

User message:

```text
Language: <SUMMARY_LANG>
Evaluate whether the candidate summary is acceptable.
Article excerpt:
---
<article slice, truncated to POST_GUARD_ARTICLE_MAX_CHARS>
---
Candidate summary:
---
<generated post summary>
---
Respond with JSON following the provided schema.
```

## Change procedure

1. Change the model or prompt in code/config.
2. Update the corresponding table row and prompt block in this document.
3. Update the provider-specific probe or contract test when the contract changes.
4. Run the affected tests and a real-input probe before changing production defaults.
5. In the next prod check, verify both `model` in logs and user-visible rendering.

Do not store API keys, full production comment threads, or provider response bodies
in this document. For historical probe results, link the dated probe document.
