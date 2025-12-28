#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOCK_FILE="${LOCK_FILE:-/tmp/hn-distill-hourly.lock}"
if [ -f "$LOCK_FILE" ]; then
  OLD_PID="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "another run is already in progress (pid $OLD_PID)"
    exit 0
  fi
  echo "stale lock found, removing"
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# Export .env for tools that do not auto-load it.
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  . "$ROOT_DIR/.env"
  set +a
fi

if [ -n "${LOG_DIR:-}" ]; then
  mkdir -p "$LOG_DIR"
  LOG_FILE="${LOG_FILE:-$LOG_DIR/hourly.log}"
  exec >>"$LOG_FILE" 2>&1
fi

echo "=== $(date -u +"%Y-%m-%dT%H:%M:%SZ") hourly job start ==="

if [ "${GIT_PULL_BEFORE:-false}" = "true" ]; then
  git pull --rebase "${GIT_REMOTE:-origin}" "${GIT_BRANCH:-main}"
fi

make run

if [ "${TELEGRAM_ENABLE:-true}" = "true" ]; then
  make publish-telegram
else
  echo "telegram disabled, skipping"
fi

if [ "${GIT_ENABLE:-true}" = "true" ]; then
  git config user.email "${GIT_USER_EMAIL:-bot@example.com}"
  git config user.name "${GIT_USER_NAME:-bot}"
  if [ -n "$(git status --porcelain data)" ]; then
    git add data
    if ! git diff --cached --quiet -- data; then
      git commit -m "${GIT_COMMIT_MESSAGE:-hourly data}"
      git pull --rebase "${GIT_REMOTE:-origin}" "${GIT_BRANCH:-main}"
      git push "${GIT_REMOTE:-origin}" "${GIT_BRANCH:-main}"
    fi
  else
    echo "no data changes"
  fi
fi

make build

if [ -n "${DEPLOY_DIR:-}" ]; then
  mkdir -p "$DEPLOY_DIR"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete dist/ "$DEPLOY_DIR/"
  else
    cp -R dist/. "$DEPLOY_DIR/"
  fi
fi

if [ -n "${DEPLOY_COMMAND:-}" ]; then
  echo "running deploy command"
  eval "$DEPLOY_COMMAND"
fi

echo "=== $(date -u +"%Y-%m-%dT%H:%M:%SZ") hourly job done ==="
