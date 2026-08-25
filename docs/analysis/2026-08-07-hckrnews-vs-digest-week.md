# hckrnews top-10 vs hn-distill — week review

Date: 2026-08-07  
Sources:

- hckrnews daily files `https://hckrnews.com/data/YYYYMMDD.js` (final-ish scores for 2026-07-31 … 2026-08-05)
- hckrnews homepage HTML for 2026-08-06 / 2026-08-07 (day files not published yet)
- live digest index `https://ivanvyazinin.github.io/hn-distill/data/search.json`

Method: for each calendar day take hckrnews stories sorted by points, top 10; check id presence on digest.  
Prod selection: `TOP_N=40`, `TOP_N_MODE=topstories` (hourly snapshot of HN front page), not end-of-day score ranking.

## Coverage

| Day (UTC bucket on hckrnews) | Hit | Notes |
|---|---:|---|
| 2026-07-31 | 8/10 | strong |
| 2026-08-01 | 5/10 | missed day’s #1 RSS post |
| 2026-08-02 | 2/10 | worst day — only 2 digest cards total |
| 2026-08-03 | 6/10 | |
| 2026-08-04 | 5/10 | missed 1620p memorial + 790p AI-images essay |
| 2026-08-05 | 8/10 | best complete day |
| 2026-08-06 | 4/10 | HTML live scores; day still settling |
| 2026-08-07 | 0/10 | today — expected lag until hourly catch-up |

**Complete week Jul 31–Aug 6: 38/70 = 54% of hckrnews daily top-10 appear on digest.**

Digest published ~50 cards that week; 38 of them are inside some day’s hckr top-10, rest are top-11…20 / snapshot picks.

## Biggest misses (interesting, not on digest)

Ranked by final hckr points among complete-week misses:

| Pts | Cmt | Day | ID | Title | Why it matters |
|---:|---:|---|---:|---|---|
| 1620 | 95 | 08-04 | [49173165](https://news.ycombinator.com/item?id=49173165) | In Memory of My Wife, Elise Cawley… | #1 of day, huge emotional HN moment |
| 790 | 465 | 08-04 | [49167113](https://news.ycombinator.com/item?id=49167113) | AI-Generated Images Discourage Me from Reading Your Blog | core culture/AI writing debate |
| 630 | 486 | 08-03 | [49151734](https://news.ycombinator.com/item?id=49151734) | More German than many Germans | big discussion thread |
| 628 | 241 | 08-01 | [49136821](https://news.ycombinator.com/item?id=49136821) | How Google helped destroy adoption of RSS feeds (2023) | day’s #1; classic tech-history |
| 534 | 441 | 08-03 | [49153374](https://news.ycombinator.com/item?id=49153374) | Prevent cognitive debt by manually retyping LLM-generated code | on-theme for digest audience |
| 493 | 310 | 08-06 | [49200652](https://news.ycombinator.com/item?id=49200652) | Qwen3.8 Max ranked best by agentic index | major model news |
| 473 | 241 | 08-06 | [49168622](https://news.ycombinator.com/item?id=49168622) | How to Make a Nintendo 64 Game in 2026 | high-craft retro/dev piece |
| 459 | 97 | 08-04 | [49166202](https://news.ycombinator.com/item?id=49166202) | FFmpeg 9.0 | release that HN always wants |
| 446 | 496 | 08-05 | [49188022](https://news.ycombinator.com/item?id=49188022) | I'm switching my phone from Android to Linux | huge comment thread |
| 426 | 115 | 08-05 | [49186762](https://news.ycombinator.com/item?id=49186762) | Beating GPT-5.6 Sol on retrieval with 100x cheaper open models | directly on AI beat |
| 410 | 53 | 08-03 | [49156750](https://news.ycombinator.com/item?id=49156750) | Twenty Years of Pandoc | evergreen OSS |
| 391 | 310 | 08-06 | [49198302](https://news.ycombinator.com/item?id=49198302) | GitHub Actions/Pages degraded | infra incident (maybe intentionally skippable) |
| 391 | 248 | 08-04 | [49171656](https://news.ycombinator.com/item?id=49171656) | Winona PD Flock cameras stolen | privacy/surveillance |
| 385 | 153 | 08-03 | [49152842](https://news.ycombinator.com/item?id=49152842) | Bonsai: Janestreet's UI Library | serious eng |
| 363 | 383 | 08-06 | [49196684](https://news.ycombinator.com/item?id=49196684) | Software development with AI feels like cooking steak | AI-dev culture |
| 352 | 345 | 08-02 | [49143414](https://news.ycombinator.com/item?id=49143414) | Wikimedia refuses union recognition… | labor/tech |
| 336 | 154 | 08-01 | [49135257](https://news.ycombinator.com/item?id=49135257) | Cursor removed cost information… | tooling trust |
| 335 | 165 | 07-31 | [49123386](https://news.ycombinator.com/item?id=49123386) | Run Kimi K3 using 29 GB RAM… | local LLM |

Also weak day **2026-08-02**: digest only kept 2 cards (Pelican, Go tour) while hckr top-10 had 8 more ≥244p stories (union, Show HN gearbox, eBay harassment, SwiftUI, Kakehashi, PKM, ELL vocab, tools/trust).

## What digest caught well

- Mega-threads: Elevators, Don’t be a meat proxy, LLMs reward expertise, Qwen3.8-Max, Discovery Loop, DeepMind leadership, Mario/Pareto, AMD/Taalas.
- Most days’ #1–#3 when they stayed hot on `topstories` for hours.
- AI/model beat is decent but not complete (missed Qwen agentic-index, Kimi RAM, retrieval-vs-Sol, cognitive-debt retype).

## Root cause (selection, not summarization)

1. **Mode mismatch**  
   hckr top-10 ≈ end-of-day score ranking among homepage-eligible stories.  
   Digest prod ≈ hourly `topstories` ∩ `TOP_N=40`, then whatever gets summarized/published.  
   Late bloomers and posts that spike off-peak never enter the candidate set.

2. **No daily catch-up pass**  
   `TOP_N_MODE=daily-top-by-score` exists (and is used in local `make local-test`) but prod hourly workflow stays on `topstories`.  
   A once-per-day `dayOffset=-1` pass would have recovered many misses (memorial 1620p, RSS 628p, FFmpeg, Android→Linux, etc.).

3. **Capacity / churn on thin days**  
   Aug 2 only 2 published cards → either few stories stayed in topstories long enough, or pipeline/LLM budget dropped candidates before publish. Worth checking hourly-build logs for that UTC day.

4. **Today lag is normal**  
   Aug 7 0/10 is not a regression yet; scores are low and hourly hasn’t promoted them.

## Not really “missed interesting news”

Some top-10 absences are debatable for a distill product:

- GitHub status incidents (ephemeral)
- pure sports (Premier League sponsors)
- duplicate Soft Rains PDF when date-anniversary card already published
- very personal memorial (editorial choice: include vs skip)

## Recommendations

1. **Add daily reconciliation job**: `TOP_N_MODE=daily-top-by-score TOP_N_DAY_OFFSET=-1 TOP_N=15..25` after day closes; merge ids not already summarized.  
2. **Keep hourly topstories** for freshness, but treat daily-top as source of truth for “did we miss the day”.  
3. **Alert**: if published cards for yesterday < 6 or coverage vs hckr top-10 < 50%, flag in support review.  
4. Optional: always force-include day final top-3 by score even if never seen in hourly topstories.

## Raw coverage detail

See session comparison script output (ids + YES/MISS per day) from 2026-08-07 review.  
Live miss spot-checks: top miss item pages returned 404 on gh-pages (`/item/<id>/`), confirming absence not just search.json lag.

## Status update — 2026-08-25

Recommendations 1–3 implemented: `.github/workflows/daily-catchup.yml` runs the
closed UTC day through the pipeline (`daily-top-by-score`, offset −1, `TOP_N=20`
via `CATCHUP_TOP_N`) at 01:33 UTC between hourly slots; `scripts/daily-
coverage.mts` (`make coverage-daily`) compares yesterday's Algolia top-10 with
published cards, writes a job-summary table and alerts Telegram below 6 cards /
50% coverage (thresholds: `DAILY_COVERAGE_MIN_CARDS`, `DAILY_COVERAGE_MIN_RATIO`).
Recommendation 4 (per-run re-admission in hourly) deliberately deferred until
morning-latency of the catch-up run proves annoying.
