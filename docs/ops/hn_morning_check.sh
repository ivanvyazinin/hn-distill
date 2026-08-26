#!/usr/bin/env bash
# hn-distill morning prod check.
# Pipeline: git pull -> copy VPS backup -> fact collector -> headless omp agent ->
# plain-language rewrite pass -> RU report on stdout (delivered by Hermes cron).
set -uo pipefail
export PATH="$HOME/.local/bin:/usr/bin:/bin:/usr/local/bin"
ENV_FILE="$HOME/.hermes/scripts/hn_check.env"
CHECKOUT="$HOME/work/projects/hn-distill"
MSG_FILE="/tmp/hn-check-msg.md"
[ -f "$ENV_FILE" ] || { echo "нет $ENV_FILE"; exit 0; }
set -a
source "$ENV_FILE"
set +a
cd "$CHECKOUT" || { echo "нет чекаута $CHECKOUT"; exit 0; }
git pull -q origin main 2>/dev/null

DB_ARG=""
if sudo -n cp /home/hnbackup/backup/hn-distill/hn.sqlite "$HN_DB_PATH" 2>/dev/null; then
  sudo -n chmod 644 "$HN_DB_PATH" 2>/dev/null
  DB_ARG="$HN_DB_PATH"
fi

WARN_RUNS=6 SAMPLE=10 HN_DB_PATH="$DB_ARG" GH_TOKEN="$GH_TOKEN" \
  /usr/bin/tsx scripts/prod-health-collect.mts > /tmp/facts.json 2>/dev/null \
  || echo '{"errors":["collector failed"]}' > /tmp/facts.json

{
  cat "$CHECKOUT/docs/ops/morning-agent-prompt.md"
  printf '\n\n---\n\nФАКТЫ (facts.json, сгенерирован только что):\n\n'
  cat /tmp/facts.json
} > "$MSG_FILE"

# Up to 3 attempts: upstream 429/credit blips happen intermittently; keep evidence.
VERDICT_JSON=""
for ATTEMPT in 1 2 3; do
  VERDICT_JSON=$(omp -p --no-session --model "openrouter/stealth/ox-alpha:low" "@$MSG_FILE" 2>/tmp/omp_err.txt)
  printf '%s attempt=%s raw_len=%s err=%s\n' "$(date -Is)" "$ATTEMPT" "${#VERDICT_JSON}" \
    "$(tr '\n' ' ' </tmp/omp_err.txt | tail -c 200)" >> /tmp/hn-check-debug.log
  case "$VERDICT_JSON" in *'{'*) break;; esac
  [ "$ATTEMPT" = "3" ] || sleep 20
done

export VERDICT_JSON
if ! REPORT=$(python3 - <<'PY'
import json, os, re
raw = os.environ.get("VERDICT_JSON", "").strip()
raw = re.sub(r"^```[a-zA-Z]*\s*", "", raw)
raw = re.sub(r"\s*```$", "", raw)
m = re.search(r"\{.*\}", raw, re.S)
candidates = [m.group(0), raw] if m else [raw]
data = None
for candidate in candidates:
    try:
        data = json.loads(candidate, strict=False)
        break
    except Exception:
        continue
if data is None:
    raise SystemExit(1)
icon = {"GREEN": "🟢", "YELLOW": "🟡", "RED": "🔴"}.get(str(data.get("verdict", "")).upper(), "⚪️")
lines = [f"{icon} hn-distill прод: {data.get('verdict','?')} — {data.get('headline','')}", ""]
for f in data.get("findings", []):
    sev = {"critical": "❗️", "warning": "⚠️"}.get(f.get("severity", ""), "ℹ️")
    lines.append(f"{sev} {f.get('title','')}")
    if f.get("evidence"):
        lines.append(f"   {f['evidence']}")
    if f.get("nextAction"):
        lines.append(f"   → {f['nextAction']}")
print("\n".join(lines))
PY
); then
  echo "агент не вернул JSON (3 попытки). Последняя ошибка:"
  tail -1 /tmp/hn-check-debug.log 2>/dev/null
  exit 0
fi

# Final pass: same facts, human language. Falls back to the raw report on failure.
export REPORT
python3 - <<'PY' > /tmp/hn-check-rewrite.md
import os
instruction = (
    "Ты редактор. Ниже отчёт дежурного инженера о состоянии проекта hn-distill.\n"
    "Перепиши его для человека: коротко, ясно и просто, без жаргона и канцелярита.\n"
    "Обязательно сохрани все факты, цифры, id карточек и вердикт (значок 🟢/🟡/🔴).\n"
    "Ничего не добавляй от себя. Верни только готовый текст.\n"
)
report = os.environ.get("REPORT", "")
with open("/tmp/hn-check-rewrite.md", "w", encoding="utf-8") as handle:
    handle.write(instruction + "\n---\n\nОтчёт:\n\n" + report)
PY

SIMPLE=$(omp -p --no-session --model "openrouter/stealth/ox-alpha:low" "@/tmp/hn-check-rewrite.md" 2>>/tmp/omp_err.txt)
printf '%s rewrite_len=%s\n' "$(date -Is)" "${#SIMPLE}" >> /tmp/hn-check-debug.log
if [ -n "$SIMPLE" ]; then
  printf '%s\n' "$SIMPLE"
else
  printf '%s\n' "$REPORT"
fi
