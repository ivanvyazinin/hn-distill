# Self-hosted hourly job

This repo used to run the hourly pipeline in GitHub Actions. Use the local
runner script instead: `scripts/hourly-job.sh`.

## One-time setup

1) Install Bun and dependencies:

```bash
make install
```

2) Create `.env` and fill in required values:

```bash
cp .env.example .env
```

At minimum set:
- `OPENROUTER_API_KEY` (if you want summaries)
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (for Telegram publishing)

3) Optional deployment targets:
- `DEPLOY_DIR=/var/www/hn-distill` to copy `dist/` into a local web root
- `DEPLOY_COMMAND='rsync -az --delete dist/ user@host:/var/www/hn-distill/'`

## Run once (manual)

```bash
./scripts/hourly-job.sh
```

## Scheduling options

### Linux cron (simple)

Edit crontab:

```bash
crontab -e
```

Add a line (adjust paths):

```cron
0 * * * * /path/to/hn-distill/scripts/hourly-job.sh >> /path/to/hn-distill/logs/hourly.log 2>&1
```

If Bun is installed in a non-standard PATH, set it in crontab:

```cron
PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin
```

### Linux systemd timer (recommended on VPS)

Create `/etc/systemd/system/hn-distill.service`:

```ini
[Unit]
Description=HN Distill hourly job
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/path/to/hn-distill
Environment=LOG_DIR=/var/log/hn-distill
Environment=DEPLOY_DIR=/var/www/hn-distill
ExecStart=/path/to/hn-distill/scripts/hourly-job.sh
```

Create `/etc/systemd/system/hn-distill.timer`:

```ini
[Unit]
Description=Run HN Distill hourly

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hn-distill.timer
```

### macOS launchd

Create `~/Library/LaunchAgents/com.hn-distill.hourly.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.hn-distill.hourly</string>
    <key>ProgramArguments</key>
    <array>
      <string>/path/to/hn-distill/scripts/hourly-job.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/hn-distill</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
      <key>LOG_DIR</key>
      <string>/path/to/hn-distill/logs</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Minute</key>
      <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/path/to/hn-distill/logs/hourly.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/hn-distill/logs/hourly.log</string>
  </dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.hn-distill.hourly.plist
```

## Script behavior and knobs

`scripts/hourly-job.sh`:
- pulls data from R2 via `make pull-r2` when `USE_R2=true` (or when R2 creds are set); otherwise runs `make run`
- skips local Telegram publish when `USE_R2=true`
- builds the site (`make build`)
- deploys `dist/` if `DEPLOY_DIR` or `DEPLOY_COMMAND` is set

Optional env vars:
- `USE_R2=true|false` (default `false`; auto-enabled if R2 creds set)
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- `R2_PREFIXES=data/,summaries/`
- `GIT_ENABLE=true|false` (default `false`)
- `GIT_REMOTE=origin`, `GIT_BRANCH=main`
- `GIT_USER_NAME`, `GIT_USER_EMAIL`
- `DEPLOY_DIR=/var/www/hn-distill`
- `DEPLOY_COMMAND=...`
- `LOG_DIR=/path/to/logs`
- `GIT_PULL_BEFORE=true` (if you want to rebase before running)
- `TELEGRAM_STREAM=true` to post each story right after its summary is ready
