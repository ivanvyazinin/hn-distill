Окей, спроектируем добавление парсинга PDF в текст без ломки текущего пайплайна.

# Цель и текущее поведение

Сейчас `scripts/summarize.mts` внутри `makeServices().fetchArticleMarkdown()` скачивает HTML (`http.text(url)`) и конвертит в Markdown через `utils/html-to-md.ts`. Для PDF это даёт «байты как текст» и бесполезный Markdown. Нужно: детектить PDF, извлекать из него осмысленный текст, вернуть его как «markdown/text» строку, дальше всё остаётся совместимым (кэш `data/raw/articles/{id}.md`, слайс для LLM и т. п.).

# Высокоуровневый подход

1. На этапе скачивания контента получать *байтовый ответ + content-type*.
2. Определять тип: PDF vs HTML vs plain.
3. Для PDF извлекать текст библиотекой уровня `pdf-parse` (или альтернативно `pdfjs-dist`) с лимитами по страницам/размеру.
4. Нормализовать текст (мягкая очистка/склейка переносов), вернуть строку; для HTML — как сейчас через Turndown.

# Новые зависимости

* Библиотека извлечения текста из PDF: **вариант по умолчанию** `pdf-parse` (тонкая обёртка над pdf.js, простая API).

  * `npm i pdf-parse -E` в `dependencies`.
* Альтернатива на случай проблем с Bun: `pdfjs-dist` c disableWorker=true; план ниже оставляет этот вариант как взаимозаменяемый.

# Изменения API инфраструктуры HTTP

## Файл: `utils/http-client.ts`

Добавляем метод для скачивания байтов с заголовками; сохраняем ретраи/таймауты.

* Новый тип:

  ```ts
  export type BytesResponse = { data: Uint8Array; contentType?: string; contentLength?: number };
  ```
* Новый метод:

  ```ts
  async bytes(url: string, init?: SafeRequestInit): Promise<BytesResponse>
  ```

  Логика: копия `text()` но `processor: async (res) => { const ab = await res.arrayBuffer(); return { data: new Uint8Array(ab), contentType: res.headers.get('content-type') ?? undefined, contentLength: Number(res.headers.get('content-length') ?? NaN) || undefined }; }`.
* Побочные эффекты: нет; существующие импорты/контракты не меняются.

# Детект и извлечение контента

## Новый утилити-модуль: `utils/content-detect.ts`

* Назначение: статический детект по URL/Content-Type/магической сигнатуре.
* Экспорты:

  ```ts
  export function looksLikePdf(opts: { url?: string; contentType?: string; bytesHead?: Uint8Array }): boolean
  export function looksLikeHtml(contentType?: string): boolean
  export function decodeText(bytes: Uint8Array, contentType?: string): string // учитываем charset из content-type, падение на utf-8
  ```
* Логика:

  * `looksLikePdf`: true если `contentType?.includes('application/pdf')` или `url?.toLowerCase().endsWith('.pdf')` или первые 4 байта равны `%PDF`.
  * `looksLikeHtml`: true если `contentType?.includes('text/html')` или `contentType?.includes('+html')`.
  * `decodeText`: достаём `charset` из `contentType` (regexp `charset=...`), `new TextDecoder(charset || 'utf-8', { fatal:false })`.

## Новый утилити-модуль: `utils/pdf.ts`

* Для `pdf-parse`:

  ```ts
  import pdfParse from 'pdf-parse';

  export type PdfToTextOptions = { maxPages?: number; softMaxBytes?: number; joinLines?: boolean };
  export async function pdfToText(bytes: Uint8Array, opts?: PdfToTextOptions): Promise<string>
  ```
* Логика:

  * Если `opts?.softMaxBytes` задан и `bytes.length` превышает — логируем предупреждение и всё равно парсим первые N страниц (ограничение стримом невозможно без потокового декодера).
  * Вызываем `pdfParse(Buffer.from(bytes), { max: opts?.maxPages ?? DEFAULTS.PDF_MAX_PAGES })`.
  * Берём `res.text`, прогоняем через нормализацию:

    * Заменить `\u0000` → `''`.
    * Схлопнуть последовательности более 3 переносов до 2.
    * Если `joinLines` установлено, склеить «жёсткие переносы» в пределах абзаца (эвристика: переносы без завершающей точки/двоеточия превращать в пробел).
  * Вернуть строку.
* Константы по умолчанию: `DEFAULTS.PDF_MAX_PAGES = 12`, `DEFAULTS.PDF_JOIN_LINES = true`.

# Встраивание в текущий пайплайн

## Файл: `scripts/summarize.mts` — функция `makeServices(e).fetchArticleMarkdown`

* Заменяем реализацию на байтовую загрузку + ветвление по типу.
* Импорты:

  ```ts
  import { pdfToText } from '@utils/pdf';
  import { decodeText, looksLikeHtml, looksLikePdf } from '@utils/content-detect';
  ```
* Подпись остаётся прежней:

  ```ts
  async function fetchArticleMarkdown(url: string): Promise<string>
  ```
* Новая логика:

  1. `const { data, contentType } = await http.bytes(url);`
  2. `const head = data.subarray(0, 8);`
  3. Если `looksLikePdf({ url, contentType, bytesHead: head })`:

     * Проверить `env.PDF_MAX_BYTES` и `env.PDF_MAX_PAGES` для логирования/ограничений.
     * `const text = await pdfToText(data, { maxPages: env.PDF_MAX_PAGES, softMaxBytes: env.PDF_MAX_BYTES });`
     * `return text;`  (допускается возвращать plain-text: дальше это всё равно идёт как сырьё в LLM; формат `.md` файла остаётся).
  4. Иначе если `looksLikeHtml(contentType)`:

     * `const html = decodeText(data, contentType);`
     * `return htmlToMd(html);`
  5. Иначе:

     * Пробуем декодировать как текст и вернуть как есть.
     * Если декод не удался или пусто — логируем warn и возвращаем `''` чтобы сохранить поведение «пропуск пустых статей».
* Побочные эффекты: сохраняется кэш через уже существующий `getOrFetchArticleMarkdown` → `.md` может содержать plain-text, это совместимо (консумеры берут только слайс текста).

# Конфиг

## Файл: `config/env.ts`

* Добавляем параметры:

  ```ts
  PDF_MAX_PAGES: z.coerce.number().int().min(1).max(200).default(12),
  PDF_MAX_BYTES: z.coerce.number().int().min(100_000).max(50_000_000).default(10_000_000),
  ```
* Экспорт `Env` уже покрывает новые поля через `parse`.
* Риски: при отсутствии переменных используются дефолты; при слишком маленьких значениях парсинг может возвращать малополезный текст — это ожидаемо.

## Файл: `.env.example`

* Добавляем:

  ```
  # PDF parsing
  PDF_MAX_PAGES=12
  PDF_MAX_BYTES=10000000
  ```

# Обновления package.json

* `"dependencies": { "pdf-parse": "^1.1.1" }` (актуальную версию уточнить при установке).
* Альтернативный путь: если предпочтёте `pdfjs-dist`, фиксируем:

  * `"pdfjs-dist": "^4.x"` и модуль `utils/pdf.ts` переписывается на:

    ```ts
    import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.js';
    export async function pdfToText(bytes: Uint8Array, opts?: PdfToTextOptions): Promise<string> {
      const doc = await pdfjs.getDocument({ data: bytes, disableWorker: true }).promise;
      const max = Math.min(doc.numPages, opts?.maxPages ?? 12);
      const chunks: string[] = [];
      for (let i = 1; i <= max; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        chunks.push(content.items.map(it => ('str' in it ? it.str : '')).join('\n'));
      }
      return normalize(chunks.join('\n\n'), opts);
    }
    ```
  * Обоснование выбора: `pdf-parse` проще, `pdfjs-dist` даёт больше контроля, но чуть больше кода.

# Места, где нужно править импорты

* `scripts/summarize.mts`: плюс два новых импорта утилит.
* `utils/http-client.ts`: новые экспортируемые типы/методы.
* Новые файлы `utils/content-detect.ts` и `utils/pdf.ts` подключаются только из `summarize.mts`.

# Архитектурные решения и последствия

* Детект по **Content-Type** и сигнатуре `%PDF` нивелирует кривые серверы c неверными расширениями/мим-тайпами.
* Возврат plain-text для PDF сохраняет совместимость с уже существующей логикой: `buildPostPrompt()` принимает строку и режет по `env.ARTICLE_SLICE_CHARS`, формат итогового саммари управляется системной инструкцией LLM.
* Кэш статей по пути `data/raw/articles/{id}.md` остаётся неизменным; внутри может лежать не-Markdown, это не ломает использование.
* Лимиты `PDF_MAX_PAGES` и `PDF_MAX_BYTES` предотвращают взрыв памяти/токенов на длинных PDF; дополнительные эвристики (скип картинок, таблиц) делаются внутри PDF-библиотеки.
* HTTP-клиент получает универсальный метод `bytes()`, который пригодится и для будущих форматов (EPUB, DOCX).

# Интерфейсы и сигнатуры (сводка)

* `utils/http-client.ts`

  ```ts
  export type BytesResponse = { data: Uint8Array; contentType?: string; contentLength?: number };
  export class HttpClient { /* … */ bytes(url: string, init?: SafeRequestInit): Promise<BytesResponse> }
  ```
* `utils/content-detect.ts`

  ```ts
  export function looksLikePdf(args: { url?: string; contentType?: string; bytesHead?: Uint8Array }): boolean;
  export function looksLikeHtml(contentType?: string): boolean;
  export function decodeText(bytes: Uint8Array, contentType?: string): string;
  ```
* `utils/pdf.ts`

  ```ts
  export type PdfToTextOptions = { maxPages?: number; softMaxBytes?: number; joinLines?: boolean };
  export async function pdfToText(bytes: Uint8Array, opts?: PdfToTextOptions): Promise<string>;
  ```

# Точки изменений по строкам/местам

* `scripts/summarize.mts`:

  * Внутри `makeServices(e)`: заменить тело `fetchArticleMarkdown(url)` на байтовую ветку; логировать с `LOG_NAMESPACE_ARTICLE` тип контента и путь (добавить мета `{ contentType, pdf: boolean, bytes: data.length }`).
* `config/env.ts`:

  * В объект `EnvironmentSchema` добавить два поля PDF.
* `.env.example`: добавить переменные PDF.
* `package.json`: добавить зависимость на PDF-библиотеку.

# Обработка ошибок и fallback’и

* Если `pdfToText()` кидает — логируем `log.error("summarize/article", "PDF parse failed", { url, error })` и возвращаем `''` чтобы пропустить пост, как и при пустом HTML.
* Если сервер отдаёт HTML с ошибкой (captcha, 403) — сейчас Turndown всё равно конвертит; добавьте эвристику «если `<title>` содержит “403/Access denied/CAPTCHA” — вернуть пусто» при желании, но это необязательно в рамках задачи.
* Если `content-type` отсутствует — проверяем сигнатуру и расширение; если тоже нет — пробуем `decodeText`, при невалидном UTF-8 `TextDecoder` с `fatal:false` вернёт строки с U+FFFD, это допустимо.

# Производительность и память

* Ограничение `PDF_MAX_PAGES` держит парсинг в O(n) по первым страницам, что достаточный предохранитель.
* `bytes()` грузит весь ответ в память; если захотите стопать слишком большие PDF до загрузки — расширьте `HttpClient` для потокового чтения и раннего break по `Content-Length > PDF_MAX_BYTES`, но это отдельная оптимизация.
* В кэш всё равно пишется уже текст, что уменьшает I/O на последующих прогоне.

# Документация

* В `README.md` дописать, что PDF поддерживаются и что действуют лимиты `PDF_MAX_*`.
* В комментарии над `fetchArticleMarkdown()` описать порядок детекта и причины выбора.

# Альтернативы и переключаемость

* Если `pdf-parse` под Bun окажется шумным, переключение на `pdfjs-dist` займёт замену реализации `pdfToText()` без изменения остальных слоёв; интерфейс сохранён стабильным.

# Миграция

* Установка зависимости, правки кода, перегенерация данных любым из скриптов (`make run`) автоматически начнёт складывать «markdown» статьи из PDF как plain-text в `.md`.

