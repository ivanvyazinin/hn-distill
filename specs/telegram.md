# Plan: Telegram news publication for hourly scheduler

## Scope decisions

Add a **standalone post-aggregation script** `scripts/publish-telegram.mts` that reads `data/aggregated.json`, formats individual news messages, and posts to Telegram. Each news item is sent as a separate message (not as a digest). Keep the aggregator unchanged to avoid side-effects on site output. Wire it into CI as a separate step after `make run`. Support idempotency via a small cache in `PATHS.seenCache`. Reuse `utils/http-client.ts` for Telegram API with existing retry/backoff.

## Config & env

Modify `config/env.ts` to add Telegram settings with safe defaults and types.

* Add:

  ```ts
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),                // channel @handle or numeric ID
  TELEGRAM_MESSAGE_THREAD_ID: z.coerce.number().optional(), // topic ID for forum supergroups
  TELEGRAM_DISABLE_NOTIFICATIONS: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(true),
  TELEGRAM_MAX_ITEMS: z.coerce.number().int().min(1).max(20).default(10),
  TELEGRAM_ENABLE: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(true),
  ```

* Behavior: publishing runs only when `TELEGRAM_ENABLE && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID` evaluate truthy.
* Update `.env.example` with commented guidance and placeholders:

  ```
  # Telegram publishing (optional)
  TELEGRAM_ENABLE=true
  TELEGRAM_BOT_TOKEN=
  TELEGRAM_CHAT_ID=@your_channel_or_numeric_id
  TELEGRAM_MESSAGE_THREAD_ID=
  TELEGRAM_DISABLE_NOTIFICATIONS=true
  TELEGRAM_MAX_ITEMS=10
  ```

* CI: in `.github/workflows/hourly-build.yml` add environment for the publish step:

  ```yml
  env:
    TELEGRAM_ENABLE: ${{ vars.TELEGRAM_ENABLE || 'true' }}
    TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
    TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID || vars.TELEGRAM_CHAT_ID }}
    TELEGRAM_MESSAGE_THREAD_ID: ${{ vars.TELEGRAM_MESSAGE_THREAD_ID }}
    TELEGRAM_DISABLE_NOTIFICATIONS: ${{ vars.TELEGRAM_DISABLE_NOTIFICATIONS || 'true' }}
    TELEGRAM_MAX_ITEMS: ${{ vars.TELEGRAM_MAX_ITEMS || 10 }}
  ```

## HTTP and logging reuse

Construct `HttpClient` with existing policy using `env.HTTP_*` in the new script. Allow `retryOnStatuses: [429]` when calling Telegram endpoints; `HttpClient` already retries on 429 plus other transient statuses.

## New utility: `utils/telegram.ts`

Create a focused wrapper around Telegram Bot API plus helpers.

* Exports:

  ```ts
  import type { HttpClient } from "@utils/http-client";

  export type TelegramSendParams = {
    chatId: string;                    // @channel or numeric ID
    text: string;
    parseMode?: "HTML" | "MarkdownV2"; // default "HTML"
    disableWebPagePreview?: boolean;   // default true
    disableNotification?: boolean;     // from env
    messageThreadId?: number;          // optional topic
  };

  export class Telegram {
    constructor(private http: HttpClient, private token: string) {}
    async sendMessage(p: TelegramSendParams): Promise<number> { /* returns message_id */ }
  }

  export function escapeHtml(s: string): string { /* &,<,>,", ' */ }

  export function chunkTelegramText(s: string, limit = 4096): string[] { /* split on paragraph boundaries, then lines */ }
  ```

* `sendMessage` logic:

  * Endpoint: `https://api.telegram.org/bot${token}/sendMessage`.
  * POST JSON body with fields `chat_id`, `text`, `parse_mode`, `disable_web_page_preview`, `disable_notification`, and `message_thread_id` when present.
  * Use `http.json<{ ok: boolean; result?: { message_id: number } }>(url, { method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({...}), retryOnStatuses: [429] })`.
  * Throw `HttpError` if `ok !== true`.
* Side-effects: none outside HTTP; all logging via `utils/log.ts`.

## New script: `scripts/publish-telegram.mts`

Entry-point that reads aggregated data, builds the digest, checks idempotency, and publishes.

* Imports:

  * `@config/env` for settings.
  * `@utils/http-client` and instantiate with `{ retries: env.HTTP_RETRIES, baseBackoffMs: env.HTTP_BACKOFF_MS, timeoutMs: env.HTTP_TIMEOUT_MS, retryOnStatuses: [429] }`.
  * `@utils/log` for observability.
  * `@utils/load-aggregated` to read `PATHS.aggregated` safely.
  * `@config/paths` for file locations, notably `PATHS.aggregated` and `PATHS.seenCache`.
  * `@utils/json` to read/write the cache (`readJsonSafeOr`, `writeJsonFile`).
  * `./../utils/telegram` for API and helpers.
  * `node:crypto` `createHash` for content hash.
* Local types:

  ```ts
  type SeenCache = { telegram?: { lastHash?: string; lastUpdatedISO?: string; sentAtISO?: string; lastIds?: number[] } };
  ```

* Digest selection:

  * Load `aggregated.json` using `loadAggregated(PATHS.aggregated)`.
  * Sort by `timeISO` desc as a guard, then take the first `env.TELEGRAM_MAX_ITEMS`.
  * Prefer `postSummary ?? commentsSummary ?? ""`, clamp to ~240 chars per item to control message size.
  * Build canonical URL: prefer site page if `env.SITE` is set, else external `url || hnUrl`.

    * Site page format: `${env.SITE?.replace(/\/$/, "")}/item/${id}` because you already have Astro dynamic routes.
* Message format (HTML parse mode):

  * Header: `🧾 HN digest — ${new Intl.DateTimeFormat(env.SUMMARY_LANG, { dateStyle: "medium", timeStyle: "short" }).format(new Date(updatedISO))}` without emoji if you prefer, replace with plain: `HN digest — <date>`.
  * Per item line:

    ```
    • <b>{escapeHtml(title)}</b> {domain ? `(${domain})` : ""}
      <a href="{itemLink}">Read</a>{hnUrl ? ` · <a href="${hnUrl}">HN</a>` : ""}{summary ? `\n${escapeHtml(summary)}` : ""}
    ```

  * Join items with double newline; disable web previews to avoid clutter.
* Hash for idempotency:

  ```ts
  function digestHash(items: AggregatedItem[], updatedISO: string): string {
    const payload = {
      updatedISO,
      ids: items.map(i => i.id),
      titles: items.map(i => i.title),
      summaries: items.map(i => (i.postSummary ?? i.commentsSummary ?? "")),
    };
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }
  ```

* Cache read/write:

  * Read `PATHS.seenCache` with `readJsonSafeOr<SeenCache>(PATHS.seenCache, z.any(), { })` or use a local lightweight safe reader since the cache is schemaless.
  * Compare `hash !== cache.telegram?.lastHash`; skip sending when equal; log a reason.
  * After successful send of all chunks, write:

    ```ts
    await writeJsonFile(PATHS.seenCache, {
      ...(cache || {}),
      telegram: { lastHash: hash, lastUpdatedISO: aggregated.updatedISO, lastIds: items.map(i => i.id), sentAtISO: new Date().toISOString() }
    });
    ```

* Chunking and send:

  * Build full text, call `chunkTelegramText(fullText)`.
  * Iterate chunks and call `telegram.sendMessage` with `parseMode: "HTML"`, `disableWebPagePreview: true`, `disableNotification: env.TELEGRAM_DISABLE_NOTIFICATIONS`, `messageThreadId: env.TELEGRAM_MESSAGE_THREAD_ID`.
  * Minimal pacing: if more than one chunk, `await new Promise(r => setTimeout(r, 500));` between messages to be conservative.
* Exit codes:

  * Exit 0 on success or skip; non-zero on fatal misconfig or HTTP error.

## File changes by path

* `config/env.ts`: add Telegram fields as described, keep strict parsing, mirror boolean coercions used elsewhere.
* `.env.example`: new variables with comments.
* `utils/telegram.ts`: new file with API wrapper, HTML escaping, chunker.
* `scripts/publish-telegram.mts`: new file with the orchestrator entry-point.
* `config/paths.ts`: no change, but we will reuse `PATHS.aggregated` and `PATHS.seenCache` for cache.
* `Makefile`: add a convenience target but do not chain into `run` to keep local builds unchanged unless configured.

  ```
  .PHONY: publish-telegram
  publish-telegram:
    bun run tsx scripts/publish-telegram.mts
  ```

* `.github/workflows/hourly-build.yml`: add a step after “Generate data”.

  ```yml
  - name: Publish Telegram digest
    if: ${{ env.TELEGRAM_ENABLE == 'true' && env.TELEGRAM_BOT_TOKEN != '' && env.TELEGRAM_CHAT_ID != '' }}
    env:
      TELEGRAM_ENABLE: ${{ env.TELEGRAM_ENABLE }}
      TELEGRAM_BOT_TOKEN: ${{ env.TELEGRAM_BOT_TOKEN }}
      TELEGRAM_CHAT_ID: ${{ env.TELEGRAM_CHAT_ID }}
      TELEGRAM_MESSAGE_THREAD_ID: ${{ env.TELEGRAM_MESSAGE_THREAD_ID }}
      TELEGRAM_DISABLE_NOTIFICATIONS: ${{ env.TELEGRAM_DISABLE_NOTIFICATIONS }}
      TELEGRAM_MAX_ITEMS: ${{ env.TELEGRAM_MAX_ITEMS }}
      HTTP_TIMEOUT_MS: ${{ env.HTTP_TIMEOUT_MS || 15000 }}
      HTTP_RETRIES: ${{ env.HTTP_RETRIES || 3 }}
      HTTP_BACKOFF_MS: ${{ env.HTTP_BACKOFF_MS || 600 }}
    run: make publish-telegram
  ```

## Message and formatting decisions

Use `parse_mode="HTML"` to avoid MarkdownV2 escaping complexity. Escape user/content-derived text with `escapeHtml`. Disable link previews to keep messages compact and avoid rate-limiting on page fetches. Include both site link and HN link when available to drive traffic and provide context.

**Publication format:** Each news item is sent as a separate Telegram message (not grouped in a digest). Long messages are automatically truncated to fit within Telegram's 4096 character limit.

## Idempotency and duplicate avoidance

Key off a stable hash over `updatedISO`, item IDs, titles, and summaries so a changed summary regenerates a new digest even if IDs are the same. Persist that hash in `PATHS.seenCache` under a new `telegram` object so we don’t interfere with other potential consumers of the cache. Only write the cache after **all** chunks are successfully published.

## Rate limiting and backoff

Rely on `HttpClient`’s built-in retry on network errors and HTTP 429 with exponential backoff (`HTTP_RETRIES` and `HTTP_BACKOFF_MS`). Space multi-chunk sends by ~500 ms as a low-friction throttle. Avoid excessive messages by defaulting to `TELEGRAM_MAX_ITEMS=10`.

## Types and signatures to add

* `utils/telegram.ts`:

  ```ts
  export class Telegram {
    constructor(http: HttpClient, token: string);
    sendMessage(p: TelegramSendParams): Promise<number>;
  }
  export function escapeHtml(s: string): string;
  export function chunkTelegramText(s: string, limit?: number): string[];
  ```

* `scripts/publish-telegram.mts` main flow:

  ```ts
  type AggregatedDigestItem = { id: number; title: string; domain?: string; url?: string | null; hnUrl?: string; postSummary?: string; commentsSummary?: string; timeISO: string; };
  async function main(): Promise<void>;
  function pickTop(items: AggregatedDigestItem[], n: number): AggregatedDigestItem[];
  function buildMessage(items: AggregatedDigestItem[], updatedISO: string): string;
  function digestHash(items: AggregatedDigestItem[], updatedISO: string): string;
  async function readSeen(): Promise<SeenCache>;
  async function writeSeen(next: SeenCache): Promise<void>;
  ```

* `Makefile` target signature:

  ```
  publish-telegram: ## posts digest to Telegram if configured
  ```

## Potential side effects and mitigations

Publishing script writes to `data/cache/seen.json`; structure is additive and namespaced under `telegram` to avoid clobbering. CI adds a step but does not alter the site artifact path or contents. The new utilities import only shared modules and avoid changing existing exports to preserve test stability.

## Tests to add (Bun)

Create focused tests using existing helpers and the mock HTTP client.

* `tests/telegram.format.test.ts`: verifies `escapeHtml` correctness and `chunkTelegramText` boundaries on synthetic long messages.
* `tests/telegram.idempotency.test.ts`: writes a temporary aggregated file and a temporary `seen.json`, runs a small harness invoking the hash and cache logic, asserts skip or send decisions.
* `tests/telegram.api.test.ts`: uses `makeMockHttp` to assert a POST to `/bot<token>/sendMessage` with expected JSON keys (`chat_id`, `text`, `parse_mode`, etc.), and that `retryOnStatuses` includes 429 (indirectly by simulating a 429 then success in the mock).
* `tests/publish-telegram.entry.test.ts` (lightweight): patches env via `withEnvPatch`, mocks paths via `mockPaths`, writes a tiny `aggregated.json`, runs `publish-telegram.mts`’s exported `main` and ensures a single HTTP call is made when cache empty, then none on second call.
