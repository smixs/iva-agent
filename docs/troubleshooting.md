# Troubleshooting

Every entry below is a real failure someone hit, and the fix that shipped. Find your symptom, run the command. Env-var details live in [configuration.md](configuration.md); the full command reference in [cli.md](cli.md).

## Send the maintainer a log package

One line on the server, nothing else to type:

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/diagnose.sh | bash
```

It runs `iva diagnose` (on Iva older than 0.4.1 it collects the service journal instead), cuts the secrets, and sends the package as a file into your chat with the bot. Forward that file to whoever is helping you.

Tokens run out too fast, or turns fail with a provider limit or `Bad Request`: send the usage package instead.

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/diagnose-usage.sh | bash
```

It packs the last three days (`IVA_DIAG_DAYS=7` for a week): tokens of every model step, the skeleton of every turn (model, why each step ended, tool names, which calls failed, steps with neither a tool call nor text) with a `summary.txt` on top, Iva's trace and the failure lines of the service journal. No chat text, no tool inputs or outputs and no `.env` values beyond the model settings leave the server. It goes to your chat with the bot as a `.tgz`; forward it.

## Common issues

### Build killed / exit 137

Cause: `eve build` needs more RAM than a small VPS has — the kernel OOM-kills it. The installer normally adds a swapfile to prevent this ([install.md](install.md)), but skips it when free disk is too low. Add one by hand:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
cd ~/iva && npm run build
```

### Disk full during update

Symptoms: `iva update` fails with `ENOSPC`, services restart in a loop, `iva doctor` says `update to … never finished`. `~/iva/versions/` keeps the running version and one rollback, about 400 MB each; a build removes the rollback first, so an update needs room for one more version.

Start with `iva doctor` — it removes leftover and surplus versions. If the disk is still full, free it by hand, then finish the update:

```bash
sudo journalctl --vacuum-size=100M
npm cache clean --force
rm -rf ~/iva/versions/<a version that is neither current nor the rollback>
iva update
```

If the running version itself is broken, run `iva rollback` before `iva update`: the build takes the rollback slot.

### Bot silent after iva config

Cause: before 0.1.4 the wizard saw Iva's own port as "busy", moved `IVA_PORT` 8723 → 8724 and left `ASSISTANT_HOST` on the old one — the bridge talked to a port nobody listened on.

```bash
iva update                                       # 0.1.4+ keeps the port and syncs the host
grep -E '^(IVA_PORT|ASSISTANT_HOST)' ~/iva/.env  # the two ports must match
iva restart
```

### Turn stuck / no reply

Cause: a wedged turn lives in `.workflow-data`, and eve re-enqueues it on every start — plain `iva restart` brings it right back.

If Iva reports `Model produced no output for 90s`, the provider stream stayed silent; retry, or switch the model.

```bash
iva reset   # stop services, quarantine workflow + Telegram busy/queue state, restart
```

From Telegram, `/new` resets only the current chat or forum topic. `/restart` resets that same session and then restarts the agent process. Both are handled out-of-band and work while the agent is busy. Use server-side `iva reset` only when the entire workflow store is damaged.

After upgrading a legacy group with no recorded Eve token, send `/new` as a reply to Iva's latest message once. Future resets use the exact token stored by the new channel events.

When the ⏹ Stop button does not stop the turn within a minute, the owner's private chat gets the honest text (`The turn hasn't stopped within 60s.`; Russian installations show `Ход не остановился за 60 с.`) and a `Restart Iva` button. That button is the only thing that restarts the agent: it kills work in every chat, so press it only when the turn is really wedged. It stays valid for that same turn until the stale-run reaper drops the record (about 30 minutes) — a press after that answers `This turn is over already.` and changes nothing. Groups get the honest text without the button.

The notice `The conversation grew large, so I started a fresh one. Memory is intact.` means replay exceeded 30 seconds; with a retained first-turn baseline, replay also grew to more than twice that turn. Russian installations show `Диалог разросся, начала новый. Память на месте.` Iva finishes the current turn before resetting only that chat. Vault memory remains intact. Send the next message normally. For a smoke test, set `TELEGRAM_REPLAY_RETIRE_THRESHOLD_MS` to a positive number of milliseconds.

Replying to an Iva message starts a normal turn when no human-input request is pending; when one is pending, the reply answers it.

Known limit: while a question or approval is pending, reply to that prompt itself or send a plain message. Replying elsewhere can be lost.

### Codex rejects auth after the subscription lapses

Iva forces one OAuth refresh and retries once; if `Codex auth rejected (401 token_expired)` remains, run `iva login` and retry the message.

### Bot silent or stuck after an update

An update now resets every open session before services restart. Each chat starts with fresh context; Vault and long-term History stay intact. Telegram messages queued while services were stopped are also preserved.

### Long or formatted message gets no reply

Symptoms: short messages are answered, a long one (over 4096 characters) or one written in the Telegram editor is ignored, and `/restart` changes nothing.

Cause: since Bot API 10.1 a client sends such a message in `rich_message` instead of `text`, and the Bridge before 0.3.33 admitted only the content keys it already knew — everything else was dropped before the agent ever saw it:

```bash
iva logs poll   # drop update 1234 — terminal ingress policy; message keys: [... "rich_message"]
```

Before 0.3.33 that line names the update id only; the keys are what identifies the field you sent.

```bash
iva update      # 0.3.33+ admits any message carrying content, and answers the ones it cannot read
```

On an older version, send the text as a `.txt` or `.md` file, or split it under 4096 characters.

### Model changed in .env but nothing happened

Cause: the model is read once, at process start.

```bash
iva restart
```

### Agent dead after editing MODEL_PROVIDER

Cause: exactly seven names are accepted — `ollama`, `opencode`, `codex`, `claude`, `openrouter`, `custom`, `requesty`. Anything else, a typo or a different case included, is refused at startup instead of quietly running Ollama under the wrong name, so the service stops and says which names it takes:

```bash
journalctl --user -u iva.service -n 20 --no-pager
# Error: Invalid MODEL_PROVIDER "ollmaa"; expected one of: ollama, opencode, codex, claude, openrouter, custom, requesty — run: iva config
```

`iva doctor` prints the same line, and the bridge is a separate service, so `/menu` → 📊 Status still answers and shows the provider as `invalid (ollmaa)`. Fix it with `iva config`, with the `/model` wizard in Telegram, or by hand — then `iva restart`. Removing the variable altogether is not a typo: that still means `ollama`.

**Values that used to work.** Before this check, `MODEL_PROVIDER=` (empty) and `MODEL_PROVIDER=OLLAMA` both resolved to Ollama and ran. They are refused now — deliberately: the old behaviour ran one provider under another provider's name, so usage, reasoning and `/menu` disagreed with what was actually being called. If your installation was one of those, it stops on the next restart until you spell one of the accepted names.

**Updating from such an installation.** The first half of every `iva update` is executed by the code already on your disk, so a check that ships inside the new version cannot run until that version is installed. Coming from a release older than this one, the first attempt fetches and builds, fails the health probe and rolls back; the message names the reason, in the terminal and in the chat. From the version carrying this check onward `iva update` refuses before the build, and the release after it refuses before the fetch. Either way the fix is the same and takes precedence over retrying: correct `MODEL_PROVIDER` with `iva config` or in `.env`, then update.

### Voice note over 20MB ignored

Cause: Telegram's Bot API download cap ([providers.md](providers.md)) — the bridge never receives the audio. Split before sending:

```bash
ffmpeg -i note.m4a -f segment -segment_time 600 -c copy part%02d.m4a
```

### iva update fails after force-push

Cause: old versions used a destructive recovery path when upstream history changed. Run the repair command; it puts the checkout back onto its release — edits to Iva's own code are removed, `.env`, `data/` and the vault are not touched — and hands the rest to the one updater:

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/repair.sh | bash
```

The installer command does the same thing over an existing installation: it hands it to that updater instead of updating anything itself. If the update cannot finish, the version that was running stays in place and the full reason is recorded under `data/logs/`.

### Update says my version is too old

Symptoms: `iva update` — in the terminal or in the chat — answers `Your Iva (0.3.x) is too old to update itself` and stops. Cause: every release names the oldest updater able to install it (`update-compat.json`, field `minUpdater`), and the installed CLI is older than that. It stops before touching anything: the installation keeps running the version it ran before, and no unit, version or data was written.

Reinstall from the current tree — one command, and it is the only way out:

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/repair.sh | bash
```

Your data and `.env` stay in place: nothing outside Iva's own code is touched. What the command does touch is that code - it puts the checkout back on the release it tracks, so local edits to Iva's files are removed - and then runs the ordinary update.

### gh not available warnings

Cause: the nightly Brain pass backs your vault up to a private `iva-vault` GitHub repo through `gh`; unauthenticated `gh` means no off-box backup.

```bash
gh auth login                                      # the installer already put gh on the box
systemctl --user start iva-brain.service           # backup now: creates the private repo and pushes
```

`iva doctor` only reports a missing vault origin — the repo creation and push happen in the nightly Brain pass; the second command runs it immediately instead of waiting for 05:00.
On an install that has not been updated since the rename the unit is still called `iva-memory-doctor.service` — `iva doctor` moves it to `iva-brain.service`.

### agent-browser fails on Ubuntu 24.04

Cause: Ubuntu 23.10+ blocks unprivileged user namespaces (AppArmor), so Chromium dies with "No usable sandbox". The installer writes the workaround; if it's missing:

```bash
echo '{ "args": "--no-sandbox" }' > ~/.agent-browser/config.json
agent-browser open about:blank && agent-browser close --all   # launch check
```

## Lifecycle

### Migrate to a new server

The step-by-step procedure — what to copy off the old box and how to restore it on the new one — is in [deploy.md](deploy.md) ("Moving servers").

### Restore memory from the iva-vault repo

The Brain pass commits and pushes the vault nightly at 05:00, so the remote is at most a day behind.

```bash
rm -rf ~/iva/vault
gh repo clone <user>/iva-vault ~/iva/vault
iva restart
```

### Uninstall

`iva uninstall`, with `--purge` to also delete code and vault — push the vault first; there is no undo. Details: [cli.md](cli.md).
