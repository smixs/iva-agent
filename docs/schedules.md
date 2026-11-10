# Schedules — what runs on its own, and what happens when it fails

Iva runs its background work as in-process Eve schedules: one `memory-night`
pipeline at 04:00, the half-hourly
`proactive` tick (Watch, the Brief and Insight), the daily `jobs-watchdog`, and the reminder dispatcher that ticks every
minute. Each scheduled job is a thin spawner — the work itself lives in
`scripts/` (see `docs/deploy.md`).

## Every run leaves a trace, a fact by its policy

One row per run in `data/jobs.json`, written by the schedule's fact policy: a failure is
always a row, a success is a row under `factOnSuccess: "always"` (the default) and only
closes a failure under `"after-failure"` (the half-hourly `proactive` tick: it writes a
failure and the first success after it, so 48 rows a day do not crowd out the rest; a
success without a failure on top leaves no row and is recorded in
`data/rollup-status.json` only). A row holds: name, started/finished time, ok, the reason
of a failure, the exit code, and the tail of the run's error output (last 20 lines
of `stderr`, cut by the same rule the evidence package uses — the report a script
prints to `stdout` stays out of the row and out of the agent's turn). Rows older than seven days are
dropped on the next write. `data/rollup-status.json` keeps only "in progress" and
"last success" for the double-run guards — the history is `jobs.json`.

## The agent wakes up with the fact

Right after a run, `schedule-runner` starts `scripts/jobs/wake.ts <name>
<startedAt>` in the background. That child reads the row, opens an ordinary agent
turn and:

- on success the turn says "nothing is broken — answer with an empty message",
  and an empty answer sends nothing;
- on failure the agent finds the cause, tells the owner briefly what broke and
  why, and ends with a «Починить» (Fix) button. It fixes nothing until the owner
  taps it.

Only a non-empty answer is sent, to the owner's private chat (the first id of
`TELEGRAM_ALLOWED_USER_IDS`: the button is accepted only there). In the quiet hours
(23:00–08:00 by default) with Watch and Brief on, the answer is not sent at night:
the failure stays open and comes first in the morning Brief. With Watch and Brief
off, or with no Brief times, it is sent at once. The outcome of the turn
(answered / empty / failed, plus a `deferred` mark for a failure that waits for
the Brief) is written back into the same row.

## Where to look

- `iva doctor` → the schedules section: the last run of every name (ok or
  failure, when; for `proactive` the last success comes from
  `data/rollup-status.json`) and the open failures. The same command reports the
  minute dispatcher's pulse in its reminders section.
- Every agent turn carries a short "open failures" block, so the agent sees a
  broken schedule even before you ask. A failed schedule stays there, and in the
  morning Brief, until a later success or `iva jobs ack`.
- `iva jobs ack <name>` closes an open failure you decided not to fix. A later
  successful run closes one by itself.
- If the agent cannot wake at all (the turn fails every time), one message per day
  reaches the owner: "scheduled jobs failed in the last 24h: N; the agent is not
  responding; run: iva doctor". A table nobody can read is the same case and gets
  its own reason, because the agent cannot wake with a fact it cannot read.
  `data/jobs-watchdog.json` remembers the last message.

## If something broke anyway

The raw run log is the service journal:

```bash
journalctl --user -u iva.service -n 200 --no-pager | grep schedule-runner
```
