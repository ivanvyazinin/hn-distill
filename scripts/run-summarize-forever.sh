#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"

LOG_FILE="$LOG_DIR/summarize-$(date +%Y%m%d).log"
PID_FILE="$ROOT_DIR/.summarize.pid"

echo "=== Starting summarize at $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG_FILE"
echo "Log file: $LOG_FILE"

# Load .env
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  . "$ROOT_DIR/.env"
  set +a
fi

while true; do
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting summarize workflow..." >> "$LOG_FILE"

  # Run summarize with env loaded
  set -a
  . "$ROOT_DIR/.env"
  set +a
  bun run tsx scripts/summarize.mts >> "$LOG_FILE" 2>&1

  EXIT_CODE=$?
  TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  if [ $EXIT_CODE -eq 0 ]; then
    echo "[$TIMESTAMP] Summarize completed successfully. Waiting 60 seconds before next run..." >> "$LOG_FILE"
    sleep 60
  else
    echo "[$TIMESTAMP] Summarize exited with code $EXIT_CODE. Waiting 30 seconds before restart..." >> "$LOG_FILE"
    sleep 30
  fi
done
