# Self-hosted hourly job

The recommended production topology uses GitHub Actions and GitHub Pages. The
local runner remains available when you want to run the pipeline on your own
machine: `scripts/hourly-job.sh`.

## GitHub Pages and Actions with VPS state backup

Use this setup when GitHub Pages should publish the static site and a VPS
should preserve pipeline state between ephemeral Actions runners. The VPS is a
state store, not a web host. It stores `data/hn.sqlite`, raw state, and
`data/cache/seen.json` under one backup directory.

The workflow restores state, runs `make run`, backs up successful state, builds
`dist`, and deploys the Pages artifact. Restore errors stop the job before the
pipeline runs. The backup runs before the site build, so a later build error
does not discard fresh pipeline state.

### Prepare the VPS

Use the VPS provider console or another trusted administrative channel. Create
an account named `hnbackup` and a production directory owned by that account:

```bash
sudo useradd -m -s /bin/bash hnbackup
sudo install -d -o hnbackup -g hnbackup -m 700 /home/hnbackup/.ssh
sudo install -d -o hnbackup -g hnbackup -m 700 /home/hnbackup/backup/hn-distill
sudo touch /home/hnbackup/.ssh/authorized_keys
sudo chown hnbackup:hnbackup /home/hnbackup/.ssh/authorized_keys
sudo chmod 600 /home/hnbackup/.ssh/authorized_keys
```

If `hnbackup` or any directory already exists, inspect it instead of rerunning
commands that change ownership or permissions. The backup directory may be
empty for the first workflow run.

Generate a deployment-only Ed25519 key pair on a trusted administrator machine.
Choose a path that does not overwrite an existing key:

```bash
umask 077
ssh-keygen -t ed25519 -f ./hn_deploy -N '' -C 'github-actions-hn-distill'
```

Add the contents of `hn_deploy.pub` as one line in `authorized_keys`. Append
the key only when the same line is not already present. Never replace
`authorized_keys`, because it may contain keys for other services:

```bash
public_key=$(cat ./hn_deploy.pub)
if ! sudo grep -Fqx -- "$public_key" /home/hnbackup/.ssh/authorized_keys; then
  printf '%s\n' "$public_key" \
    | sudo tee -a /home/hnbackup/.ssh/authorized_keys >/dev/null
fi
sudo chmod 600 /home/hnbackup/.ssh/authorized_keys
```

Do not reuse this key for another repository or administrative access. Store
its private half only in the GitHub Actions secret described below.

### Verify the VPS host key

Collect the Ed25519 host key outside Actions:

```bash
ssh-keyscan -t ed25519 <vps-host> > ./vps-known-hosts.candidate
ssh-keygen -lf ./vps-known-hosts.candidate -E sha256
```

Compare the fingerprint with the value shown by the VPS provider console or
another trusted channel. Do not trust a fingerprint obtained only from the
same network path. After verification, save the complete candidate line as
`VPS_KNOWN_HOSTS`. The workflow writes that value to `known_hosts`; it does not
run `ssh-keyscan`.

### Configure GitHub Actions

In the repository, open **Settings → Secrets and variables → Actions**. Add
these secrets with the exact names used by
`.github/workflows/hourly-build.yml`:

| Secret | Value |
| --- | --- |
| `VPS_SSH_KEY` | Contents of the private `hn_deploy` key |
| `VPS_KNOWN_HOSTS` | The verified Ed25519 `known_hosts` line |
| `VPS_HOST` | VPS DNS name or address |
| `VPS_USER` | `hnbackup` |
| `VPS_PATH` | `/home/hnbackup/backup/hn-distill` |
| `OPENROUTER_API_KEY` | OpenRouter API key used by `make run` |

Do not print secret values in workflow logs or commit them to the repository.

Add these Actions variables:

| Variable | Required value or purpose |
| --- | --- |
| `SITE` | `https://<user>.github.io` |
| `BASE` | `/<repo>/`, including both leading and trailing slashes |
| `TOP_N` | Optional pipeline limit |
| `SUMMARY_LANG` | Optional summary language |
| `OPENROUTER_MODEL` | Optional primary summary model |
| `OPENROUTER_FALLBACK_MODEL` | Optional first fallback model |
| `OPENROUTER_FALLBACK_MODEL_2` | Optional second fallback model |
| `TAGS_MODEL` | Optional tags model |
| `POST_GUARD_MODEL` | Optional post-guard model |
| `POST_GUARD_FALLBACK_MODEL` | Optional post-guard fallback model |

The workflow supplies defaults for optional variables. Set `BASE` to the
project-site path, not `/`, when the repository is published at
`https://<user>.github.io/<repo>/`.

Open **Settings → Pages** and set **Build and deployment → Source** to
**GitHub Actions**. Do not configure a custom domain for this topology.

### Run and verify the workflow

The workflow runs at `0 * * * *` and also supports `workflow_dispatch`. A
scheduled run can start late because GitHub Actions queues scheduled work,
especially around the top of the hour. For the first run, use
**Actions → hourly-build → Run workflow** after the VPS and GitHub settings are
ready.

The first run can restore an empty `/home/hnbackup/backup/hn-distill/`. After
`make run`, it must create a non-empty `data/hn.sqlite`. The workflow then
runs the guarded backup, builds `dist`, uploads the Pages artifact, and deploys
it. A later run restores that state before calling `make run`.

Check the first run for these events:

1. Node.js 22 is selected.
2. Restore completes before `make run`.
3. `data/hn.sqlite` is non-empty after the pipeline.
4. Backup completes before the site build.
5. The Pages artifact contains `dist`.
6. The deployment reports the project-site URL.

The backup excludes `bench/`, `.DS_Store`, and temporary SQLite WAL and SHM
files. The backup command uses `--delete` only for the production backup.

Before the first production run, test access with a uniquely named sibling
directory. Never use the production backup directory or `--delete` for this
test:

```bash
TEST_PATH=/home/hnbackup/backup/hn-distill-rsync-test-$(date +%s)-$$
TEST_FILE=$(mktemp)
TEST_NAME=$(basename "$TEST_FILE")
TEST_RECEIVE=$(mktemp -d)
printf 'hn-distill rsync check\n' > "$TEST_FILE"
ssh -i ./hn_deploy hnbackup@<vps-host> 'echo ok'
ssh -i ./hn_deploy <vps-user>@<vps-host> "mkdir -- '$TEST_PATH'"
rsync -az -e "ssh -i ./hn_deploy" -- "$TEST_FILE" <vps-user>@<vps-host>:"$TEST_PATH/$TEST_NAME"
rsync -az -e "ssh -i ./hn_deploy" <vps-user>@<vps-host>:"$TEST_PATH/$TEST_NAME" "$TEST_RECEIVE/"
diff -u "$TEST_FILE" "$TEST_RECEIVE/$TEST_NAME"
ssh -i ./hn_deploy <vps-user>@<vps-host> "rm -f -- '$TEST_PATH/$TEST_NAME' && rmdir -- '$TEST_PATH'"
rm -f "$TEST_FILE"
rm -rf "$TEST_RECEIVE"
```

Replace the placeholders with the configured values. Use `hnbackup` as
`<vps-user>`. Confirm that the temporary path is a sibling of the production
path before running the test.

### Recover from SSH or rsync errors

If restore fails, the job stops before `make run` and does not start a backup.
Check `VPS_HOST`, `VPS_USER`, `VPS_PATH`, the private key, and the verified
`VPS_KNOWN_HOSTS` value. Then test SSH access again. Do not add
`StrictHostKeyChecking=no`, run `ssh-keyscan` inside Actions, or add `|| true`
to restore.

If backup fails, inspect the VPS account permissions, free space, network, and
`rsync` error. Do not delete or replace the existing production backup while
recovering. Fix access and rerun the workflow; a successful restore and guarded
backup preserve the state model.

For a public repository, GitHub can disable scheduled workflows after 60 days
without repository activity. Use a manual `workflow_dispatch` run before that
limit and check the Actions schedule after long periods of inactivity.

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
- `R2_PREFIXES=data/aggregated.json,data/search.json,data/by-date/` (published artifacts only; summaries/raw live in D1/R2 blobs)
- `GIT_ENABLE=true|false` (default `false`)
- `GIT_REMOTE=origin`, `GIT_BRANCH=main`
- `GIT_USER_NAME`, `GIT_USER_EMAIL`
- `DEPLOY_DIR=/var/www/hn-distill`
- `DEPLOY_COMMAND=...`
- `LOG_DIR=/path/to/logs`
- `GIT_PULL_BEFORE=true` (if you want to rebase before running)
- `TELEGRAM_STREAM=true` to post each story right after its summary is ready
