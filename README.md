# Hacker News Digest (Astro)

- What: Static site that fetches top Hacker News stories, distills article text and comments, and publishes daily/weekly digests.
- Requires: `bun`.
- Setup: `cp .env.example .env` and set `OPENROUTER_API_KEY` (optional for summaries). For articles, it scrapes HTML/PDF content. For YouTube links, it fetches transcripts. Optional: set `TOP_N_MODE=daily-top-by-score` to pick stories created in a UTC day window and rank them by HN score instead of using `topstories`; use `TOP_N_DAY_OFFSET=-1` for yesterday.
- Generate data: `bun install` then `bun run data:all` (or `make run`).
- Develop: `bunx astro dev` (or `make dev`).
- Build/preview: `bunx astro build && bunx astro preview` (or `make build`/`make preview`).
- Self-hosted hourly job (VPS/macOS): see `docs/self-hosted.md`.

Generated data is **not** committed to git. Local runs write raw blobs and published JSON under `data/`; processed summaries/tags live in `data/hn.sqlite`. Deploy hydrates published artifacts from R2 via `make pull-r2`. The site reads `data/aggregated.json`.

One-time backfill after pulling legacy `data/`:
`bun run tsx scripts/migrate-to-sqlite.mts` then set `AGGREGATE_FROM_DB=true` in `.env`.

## Comment summaries

- Each fetch writes a fresh bounded snapshot, including already-seen replies. Edits and removed replies are reflected in the next snapshot rather than merged with stale cached text.
- Disputes retain their original meaning and are never relabeled as agreement to reduce display labels.
- The correctness patch leaves traversal order, prefix clipping and editorial/compression prompts unchanged. Sampling and excerpt changes stay evaluation-only until they pass the independent input-ablation gates.

The model routes, token caps, call limits and cache policy versions are unchanged. Existing summaries refresh under the normal freshness gates, avoiding a forced regeneration of the archive. These changes apply when a summary is next needed; they do not run a backfill or publish data.
