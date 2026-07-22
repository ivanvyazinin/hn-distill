#!/usr/bin/env bash
# Throttled, resumable Groq-free baseline capture for the comments-route eval (Phase 0).
#
# Pins the ambient comments-v2 route to a single Groq hop (llama-3.3-70b-versatile, no
# fallbacks, output cap 1000) so generateValidatedCommentsSummaryV2 runs the production
# path against exactly the baseline model. Safe to run repeatedly / from a scheduler:
# the underlying script skips already-captured fixtures and stops early on TPD
# exhaustion, so a partial run just resumes next time.
#
# Bound each run so it does not drain the shared 70b daily budget the hourly pipeline
# needs, e.g.:  scripts/bench-comments-baseline.sh --max-calls-per-run 12
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source .env
set +a

COMMENTS_MODEL=llama-3.3-70b-versatile \
COMMENTS_FALLBACK_MODEL= \
COMMENTS_FALLBACK_MODEL_2= \
COMMENTS_OPENROUTER_FALLBACK_MODEL= \
COMMENTS_SUMMARY_MAX_TOKENS=1000 \
  bun run tsx scripts/bench-comments-baseline.mts "$@"
