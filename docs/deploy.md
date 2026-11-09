# Deploy

On macOS, `install.sh` uses launchd with unit labels `app.iva.*` and plists in `~/Library/LaunchAgents`. The same `iva status/restart/start/stop/logs/update/doctor/uninstall` commands operate those units. Logs are in `~/Library/Logs/Iva/`. Units run in the logged-in GUI session, so the Mac must be on and awake. A calendar job missed during sleep runs on wake; a night while the Mac is off is skipped.

Iva runs on one VPS as two systemd user services, two systemd watchdog timers, and four in-process eve schedules. `install.sh` sets all of it up ([install](./install.md)); this page is what's actually running and how to operate it.

## Transport: long polling

Telegram never connects to your server. The permanent `scripts/telegram-poll.mjs` entry shim starts the TypeScript bridge in `scripts/poller/main.ts`, which long-polls `getUpdates` and POSTs each update to the local eve webhook (`http://127.0.0.1:8723/eve/v1/telegram`) with the shared `X-Telegram-Bot-Api-Secret-Token` header. Telegram sees an ordinary bot; the channel code is unchanged. No public HTTPS, no domain, no reverse proxy.

The bridge also gives you:

- 📬 **Ordered delivery** — advances the offset (`data/telegram-offset.json`) only after eve replies 2xx, retrying with backoff up to 15s while the server boots.
- ⏱ **Per-chat pacing** — a 1.5s pause between updates to the same chat, so a burst can't start two runs on one session.
- 🛟 **Out-of-band recovery** — a handful of slash commands (`/restart` and friends) are handled by the bridge itself, so they work even when the agent is stuck. Which ones, and what they do: [cli.md](./cli.md).

### Webhook mode (alternative)

Polling and webhook are mutually exclusive — the bridge calls `deleteWebhook` on start. If you do have a public HTTPS endpoint, disable the bridge and register the webhook:

```bash
systemctl --user disable --now iva-telegram-poll
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<your-domain>/eve/v1/telegram",
       "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'",
       "allowed_updates":["message","callback_query","stopped_message_generation"]}'
```

Note: `getUpdates` — which the setup wizard uses to discover your user ID — stops working while a webhook is registered.

What you give up without the bridge: the out-of-band commands are gone (`/menu`, `/stop`, `/new`, `/restart`, `/start`, `/model`, `/think`, `/update`, `/usage`, `/help` reach the model as ordinary text instead of being handled), and so are the busy-time queue with its 👀 acknowledgement, per-chat pacing, and durable offset. Only `/task`, `/tasks` and `/digest` are model-routed by design. The native ■ control in a private chat draft works in both modes. The channel verifies the webhook secret and cancels the draft's exact turn through its own cancel route. Groups and topics show typing; use `/stop` with the bridge.

## systemd units

`scripts/cli/systemd.ts` is the single source of truth for every unit; the permanent `bin/iva.mjs` entry shim delegates to the TypeScript CLI. Any restart through the `iva` CLI regenerates the units first, so `Environment=PORT` always matches `IVA_PORT` in `.env`. Don't hand-edit `~/.config/systemd/user/iva-*` — edits get overwritten. If you write your own unit instead, bake the port literally (`Environment=PORT=8723`): systemd will not expand `$IVA_PORT` from an `EnvironmentFile`.

The unit starts eve with `--host 127.0.0.1`, and a hand-written one must do the same. Setting `HOST` in the environment is insufficient because `eve start` overwrites `HOST`/`NITRO_HOST` for the process it spawns. Iva also requires the generated `ASSISTANT_BEARER` on Eve session routes. `localDev()` is included only under `eve dev`, which sets `EVE_DEV=1`; production does not use the client-controlled `Host` header as authentication.

The two controls cover different failure modes: loopback binding removes direct network reachability, while the bearer protects against another local process, SSRF, or a reverse proxy reaching the port. `iva doctor` repairs a missing bearer, `.env` permissions, and an old process still listening beyond loopback.

For a direct smoke test, load the secret without printing it and pass the header to curl through stdin rather than the process arguments:

```bash
ASSISTANT_BEARER="$(node --env-file=.env -p 'process.env.ASSISTANT_BEARER')"
IVA_PORT="$(node --env-file=.env -p 'process.env.IVA_PORT || 8723')"
printf 'header = "Authorization: Bearer %s"\n' "$ASSISTANT_BEARER" |
  curl --fail-with-body --config - \
  -X POST "http://127.0.0.1:${IVA_PORT}/eve/v1/session" \
  -H "content-type: application/json" \
  -d '{"message":"Reply with exactly: auth ok"}'
unset ASSISTANT_BEARER IVA_PORT
```

| Unit                           | When                         | Job                                                           |
| ------------------------------ | ---------------------------- | ------------------------------------------------------------- |
| `iva.service`                  | always                       | the agent (`eve start`), `Restart=always`                     |
| `iva-telegram-poll.service`    | always                       | the long-polling bridge                                       |
| `iva-telegram-userbot.service` | opt-in (`iva userbot setup`) | Telethon userbot MCP proxy — see [userbot.md](userbot.md)     |
| `iva-brain.timer`              | 05:00 nightly                | owner-edit commit, link graph, CORE size, vault `git push`    |
| `iva-update-check.timer`       | 10:00 daily                  | check for a newer stable Iva version; notify once per version |

The Brain and update-check timers stay on systemd on purpose: they're watchdogs that must keep running even if the agent process itself is wedged. `iva-brain.timer` embeds `ASSISTANT_TIMEZONE` directly, so its 05:00 schedule remains correct even when the server clock uses UTC — as do the eve schedules below (`Environment=TZ` in `iva.service`). Setting the server's own system timezone to match is therefore optional, not required for anything in this doc to work correctly:

```bash
# Optional — the generated units and the eve schedules already carry ASSISTANT_TIMEZONE
# themselves, so this only affects OTHER things that read the system clock (log
# timestamps, cron jobs you add yourself, etc.). `node --env-file` parses .env as plain
# KEY=VALUE pairs — unlike `source`, it never shell-interprets its contents, so a stray
# `$(...)` or backtick sitting in .env can't execute anything.
ASSISTANT_TIMEZONE="$(node --env-file=.env -p 'process.env.ASSISTANT_TIMEZONE || ""')"
[ -n "$ASSISTANT_TIMEZONE" ] && sudo timedatectl set-timezone "$ASSISTANT_TIMEZONE"
```

### Memory rollups, Watch and Brief: in-process eve schedules

The four memory-rollup cadences moved off systemd and, with the Watch and Brief tick, the jobs watchdog and the reminder dispatcher, run as `agent/schedules/*.ts` — eve's native `defineSchedule` API — inside the `iva.service` process itself:

| Schedule        | Cron (local time)            | Job                                                                                                                                                                                                                                                                                                             |
| --------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory-night`  | `0 4 * * *` (04:00 nightly)  | queued days → cards, links, CORE and every ready daily/weekly/monthly/yearly summary                                                                                                                                                                                                                            |
| `proactive`     | `0,30 * * * *` (half-hourly) | `scripts/proactive/tick.ts`: Watch once an hour and the Brief at `proactive.briefTimes` — **on by default**, `iva proactive off` ([ADR-0020](adr/0020-watch-and-brief-are-on-by-default.md)); Insight at `proactive.insightTimes`, off by default ([ADR-0022](adr/0022-insight-brings-one-capability-a-day.md)) |
| `jobs-watchdog` | `17 7 * * *` (07:17 daily)   | `scripts/jobs/watchdog.ts`: one message to the owner when schedules failed and the agent cannot wake ([schedules.md](schedules.md))                                                                                                                                                                             |
| `reminders`     | `* * * * *` (every minute)   | reminder dispatcher: hands due rows of `data/reminders.json` to `scripts/reminders/fire.ts` ([reminders.md](reminders.md))                                                                                                                                                                                      |

The memory schedule is a thin spawner (`agent/lib/schedule-runner.ts`): it runs `scripts/memory/night.ts` under `.memory.lock` and a hard timeout, then records the outcome in `data/rollup-status.json`. `iva.service` sets `Environment=TZ` from `ASSISTANT_TIMEZONE` (`ivaServiceBody()` in `scripts/cli/systemd.ts`), so cron expressions above tick in the configured local time, not the host's system TZ — Nitro's schedule runner carries no timezone of its own otherwise.

Nitro's scheduled-task runner has no `Persistent=true` equivalent, so a period missed while the server was down does **not** auto-fire on its own. `agent/lib/schedule-migration.ts` replaces that: on every server start it compares each period's last recorded success against its most recent scheduled point and, if it's stale and still within its grace window, runs it once (grace 20h for the single `memory-night` schedule). A brand-new install seeds a baseline and runs nothing on its first boot, so installing never triggers an immediate storm of catch-up jobs. The same start-up hook also retires the old `iva-memory-{daily,weekly,monthly,yearly}.{service,timer}` units on any existing install, by exact name only — any unrelated timer you've set up yourself is left alone.

Manual runs and status:

```bash
npm run memory               # the night now; or: npm run memory -- YYYY-MM-DD for one day
npm run brain
systemctl --user list-timers                             # Brain, update-check (the only two systemd timers left)
systemctl --user status iva.service iva-telegram-poll.service  # the two always-on services
cat data/rollup-status.json                               # last run per eve schedule (or: /menu → ⏰ in Telegram)
iva logs                  # agent; `iva logs poll` for the bridge
```

The update check fetches the configured Git upstream without calling the model. It stays silent when the installed stable version is current, when the same version was already offered, or when Telegram is not configured. A newer `MAJOR.MINOR.PATCH` release produces one message in `TELEGRAM_DIGEST_CHAT_ID` (falling back to the first trusted user) with **Update** and **Later** buttons. Errors are journal-only and retry on the next timer run.

Full CLI reference: [cli](./cli.md). What the rollups actually write: [memory](./memory.md).

## nginx and TLS

You need neither for Telegram - polling is outbound-only. If you expose the Telegram webhook, proxy only `/eve/v1/telegram`; that route verifies `X-Telegram-Bot-Api-Secret-Token` and the Telegram user allowlist.

Exposing the Eve HTTP channel is a separate security decision. Require HTTPS and preserve the `Authorization: Bearer ...` header so Iva can verify `ASSISTANT_BEARER`. Never remove the bearer check merely because the proxy connects to `127.0.0.1`: loopback describes the proxy-to-Iva hop, not the original caller.

## Moving servers

Your state is three things: the vault (its own git repo, pushed nightly by the Brain pass), `.env` (all keys), and `data/` (`tasks.json`, `usage.jsonl`).

1. Old box: `npm run brain` to push the vault, then copy `.env` and `data/` off.
2. New box: run the installer ([install](./install.md)) with `--skip-setup`, drop in `.env`.
3. Clone the vault back — `gh repo clone <user>/iva-vault <vault-dir>` — restore `data/`, then `iva restart`.

If all you have left is the vault repo, you lose open tasks and token history. Memory survives intact.

## Vercel (advanced)

Iva is built on eve, which deploys to Vercel natively — but self-host is the intended path. If you go there anyway:

- **Schedules** — `defineSchedule` in `agent/schedules/*.ts` becomes a real Vercel Cron Job (cron times are UTC there).
- **Storage** — `./data` is ephemeral on Vercel; tasks and usage logs need a real DB or KV store.
- **Auth** - Eve routes accept Vercel OIDC or `ASSISTANT_BEARER`. `localDev()` is enabled only by `eve dev`; configure the bearer as a Vercel secret for any non-OIDC caller.
