---
name: self-map
description: "Your evidence and how you work: one Trace turn to its cause and whose it is (owner side, the Version, outside); spend, schedules, failures, the journal, docs; what Stop, Interrupt or a break leave; where to look before asking. Load in an Insight turn with failures, when the owner asks what you did, why it failed, what was slow or costly, how you work."
---

# Self-map

Paths are relative to the `bash` folder — the running Version
(`~/iva/versions/<v>`; `~/iva/current` points at it). Your own code is here, not
in `~/iva`. Data is `$ASSISTANT_DATA_DIR` (default `./data`). Everything below
is for inspection unless the owner requests a repair.

## Keep the output small

`bash` gives you only the last 30 000 characters of each stream; `read_file`
stops at 24 000. Never `cat` a day file of the Trace or `data/usage.jsonl`:
they run to megabytes. A long turn — print only what is around its failures:

    iva trace show <session>/<turn> | grep -B4 -A2 -e 'failure=' -e 'turn.failed' -e 'step.failed'

## Commands in a turn

Only one lifecycle command is accepted at a time; read its result before requesting another.

- `iva doctor` in a turn prints the complete read-only diagnosis; repairs belong to the owner in a terminal.
- Перезапуск, обновление, откат — только `iva <глагол>`: он сам отложит действие до конца хода; systemctl/launchctl/pkill по Иве из хода убивают ответ.
- `iva diagnose` — read-only; in a turn only through `report-problem`.
- `iva logs`, `iva trace tail` — they follow forever and end only on the bash
  timeout. Use `journalctl … --no-pager -n N` and `iva trace show`.
- `iva proactive on|off|set`, `iva jobs ack` — they change state; only on the
  owner's word.

## One turn = session + turn

`turn_N` starts again at `turn_0` in every session, so a turn is named by both:
`<session>/<turn>`, for example `wrun_01M43YEKCW0FRANBS1E510CWX5/turn_0`. Nobody
tells you your own session; find the turn from what you have:

- A line of the failure list in your prompt — it ends with the command; run it.
- A recent turn — `iva trace show` lists the last 20 with their
  `<session>/<turn>`; `iva trace show last` is the last turn of the model.
- A chat message — `iva trace show tg:<chat>:<message>`.
- A time or words — `ts` is UTC, the day file is the local day:
  `grep -l '<words>' data/trace/*.jsonl`, then
  `grep -h '<words>' data/trace/<day>.jsonl | cut -c1-200` shows `turn` and
  `session`.

A turn without a chat (Watch, Brief, Insight, a Reminder) starts with an
`eve.message.received` whose prompt begins `Watch:`, `Brief:`, `Insight:` or
`Reminder`. The lines that sent its answer (`gate.outbound`, `outbox.*`) carry
no session: they are the sends right after its `turn.completed`.

## What the events say

The header: start → end, the duration up to the end of the turn, steps, tools,
failed calls, the outcome (`failed`, `stopped`, `blocked`, `dropped`,
`delivered`, `answered`, `open`).

- `bridge.*`, `inbound.*`, `gate.inbound` — the message came in; the inbound
  Gate passed or blocked it.
- `eve.message.received` — the prompt of the turn.
- `eve.step.started` → `eve.step.completed` — one model call; `usage` = tokens.
- `eve.actions.requested` — you called tools: `actions[]`, their arguments in
  `args[]` in the same order.
- `eve.action.result` — what a tool returned, same `callId`. `failure=` marks a
  failed call: `exit N` (bash, with stderr), `timeout`, `ok:false`, `error`,
  `isError` (the answer was flagged as an error: a subagent, `load_skill`, an
  MCP tool), `status:failed` (the answer named its own error; `errorCode` is
  that code). `result` is the answer as one JSON string, `ok`, `error`,
  `message`, `code` first; `outChars` is how much of it you saw then. For bash
  the Trace keeps the END of `stdout` and `stderr`: `…[truncated]` at the start
  means the head was cut. A failure hidden by a pipe or `2>&1` has no
  `failure=`: read `exitCode` and the end of `stdout`.
- `eve.step.failed`, `eve.turn.failed` — the turn broke: `code`, `message`,
  `details`.
- `eve.compaction.*`, `eve.session.waiting` — after the turn, not its work.
- `gate.outbound` → `outbox.delivered` / `outbox.failed` — the answer after
  secret redaction, and whether Telegram took it.
- `tool.rejected`, `guard.repeat_stop` — the repeat guard saw a failed call /
  stopped a repeat. They carry no turn and no session: match them by `ts` and
  tool.
- `stop.*` — the owner pressed ■.

`--full` prints the content whole (as the Trace kept it), `--json` the raw
lines. Lines written before `failure=` existed keep `result`
as an object and have no `failure`.

## Find the cause

1. How it ended: the outcome in the header.
2. The FIRST failure in time, not the last: later ones are often its
   consequence.
3. Its `callId` → the `eve.actions.requested` above it: what you asked for.
4. The reason: `stderr`, `error`, the end of `stdout`, the `message` of a
   failed step.
5. What came next: the same call again with the same error, then
   `guard.repeat_stop` — the loop is part of the cause.

Not every non-zero exit is a failure: `grep` 1 = nothing found, `diff` 1 = the
files differ, `test` 1 = false; those have no `failure=`. «The Trace does not show why» is a
correct answer; a guessed reason is not.

## Whose it is

Decide by the tool, the skill and the path in the events, never by a stack: a
stack points into `.output/server/index.mjs` for every kind of code.

- **Outside** — the provider down or busy (`MODEL_CALL_FAILED` with 429, 5xx
  or «no output»), the network, a site, someone else's server timing out.
  Nothing to fix; the same cause over several days is worth one line.
  `MODEL_CALL_FAILED` with 401 or 403 is the owner's key (owner side); with
  another 4xx (400, 404, 422) the provider refused the request Iva built — a
  tool schema, a parameter — that is the Version.
- **Your own call** — a wrong path or argument, an unknown tool name: the error
  text names the right form. Nothing to fix, unless a skill told you the wrong
  form.
- **Owner side** — the Custom layer and the owner's data; it survives
  `iva update`. A tool named `connection__mcp-<plugin>--…` (a plugin);
  `connection__<x>__…` when `data/custom/agent/connections/<x>.ts` exists; a
  skill that `ls data/custom/agent/skills data/custom/plugins/*/skills` lists;
  a script under `data/custom/`, `data/plugin-data/` or
  `data/custom/plugin-drafts/`; the Vault; a key or setting missing from `.env`
  or `data/settings.json`. A fix there holds: a plugin draft, an edit, or one
  line on what to set.
- **The Version** — what `iva update` replaces: `agent/`, `scripts/`,
  `packages/`, eve. A built-in tool (`bash`, `glob`, `grep`, `memory_search`,
  `read_file`, `remind`, `send_file`, `tasks`, `web_fetch`, `web_search`,
  `write_card`, `write_file`, `helper`, `connection__telegram-userbot__…`) failed with
  `isError` or `status:failed` on arguments that were right; an
  `iva <command>` failed with a stack; a turn or step failed with an `IVA_…`
  code or a provider 4xx above; a built-in skill told you something wrong. A
  patch on the owner's side is wiped by the next update, and a copy of a
  built-in skill freezes it and hides every later fix: this is an issue for
  the developer (`report-problem`), nothing else.

## Answering the owner about yourself

Everything above is for you. The owner is not technical: the answer says in
plain words what happened and what it means for them, and offers the step
that gives them what they missed. Not sure — say «не уверена», not «не дошло».
No ids, session names, event names, delivery statuses or commands, unless the
owner asks for details.

Bad (a real answer, 06.10.2026): «⚠️ Проблема: вчерашняя проверка сервера
(r-4ba18f, 05.10 09:05) сработала, но сообщение не дошло до чата (статус
доставки пустой, ошибки нет)».

Good:

    Не уверена, что до тебя дошла вчерашняя утренняя проверка сервера в 09:05:
    я её отправила, но подтверждения, что она пришла, нет.
    Остальные 10 сообщений за сутки дошли.

    Проверить сервер ещё раз сейчас?

    <tg-button-row><tg-button type="callback_data" data="Проверь сервер сейчас">Да</tg-button><tg-button type="callback_data" data="Не нужно">Нет</tg-button></tg-button-row>

## Stop, Interrupt, a break, a miss

What becomes of your work — for the owner's questions about you.

- **Queue and Interrupt** (`/menu` → New messages; Queue by default). Queue:
  a new message waits until the current reply ends. Interrupt: a new message
  stops the current turn, and a new turn starts from it. Finished steps, files
  you wrote and what you sent stay; a command still running is killed, the
  unfinished answer is dropped. A correction does not reach the running turn;
  it starts the next one.
- Helpers, Watch, Brief and Insight use the helper and background model selected in `/menu`; an empty `HELPER_MODEL` selects the chat model.
- **Helper** works in a separate background turn. Read `helper outcome` and tell
  the owner; `helper close` stops it and keeps the last completed message.
  A new conversation keeps it running; restart gives interrupted. Repeat with the owner's permission.
- **■ Stop** (or `/stop`) stops the main turn; a helper continues. The turn ends the same way: what is done stays. The
  next turn opens with a note that the previous one was stopped; do not redo
  that work unless asked.
- `[The previous turn was interrupted` / `[Предыдущий ход был прерван`: an explicit Stop was pressed; repeat the work only on request.
- `[This message arrived while` / `[Это сообщение пришло, пока`: check the conversation for completion of the previous request before repeating any work.
- **A broken model call** (the network, the provider failing for a moment):
  up to three requests inside the same turn; a tool from a cut-off answer does
  not run, finished steps are not redone. When the third breaks off too, the
  owner's message depends on where it broke. In the middle of the answer: a
  «Повторить» button that sends the question again, only for a message
  without an attachment; with one, a request to send it again. Before the
  answer began: what happened and to write again, no button.
- **Iva restarts while a turn is running** (a crash, a restart): the
  conversation of every chat starts anew, memory (CORE, cards, days) stays.
  The owner sees «Предыдущий ход оборвался», a short quote of the last accepted
  question in a private chat, and a «Повторить» button. The button sends the full
  question as an ordinary turn, once and only on the owner's tap. An attachment
  asks the owner to send it again; a group shows no quote. A new conversation or
  another accepted turn closes the old button. The turn stays stopped until a tap.
- **After a miss** (the server was off or restarting): a Reminder that came
  due fires on the first minute after; a Brief or an Insight runs if it is
  less than 3 hours late, otherwise that time is skipped; a night less than 20
  hours late runs at start, otherwise the next night takes the queued days.

## Not in the Trace — say so, do not guess

- The system prompt, CORE, the rules: only file sizes (`context.parts`).
- Money: no prices anywhere; tokens only (`data/usage.jsonl`).
- What the model was thinking: no reasoning events arrive.
- What the night did inside: `data/jobs.json` and `data/rollup-status.json`
  only.
- Which model ran a step: `data/usage.jsonl` has the configured one.
- Anything older than 30 days.
- With `captureContent` off: no prompts, answers or results — only names,
  sizes and `failure=`; the failure list then also counts your own Insight turns.

## Spend, schedule, services

`CLAUDE_CONTEXT_WINDOW=200000` — дешевле на подписке Claude, раньше сворачивает историю.

### Why the cache warmed again

Read only the relevant steps from `data/usage.jsonl`, matching `sessionId` and `turnId`.
The optional `request` holds eight-character SHA-256 fingerprints: `system`, `cache`,
`tools`, and `toolCount`. They identify changes, not the original text.
Compare steps using the same provider and model: changed `system` means instructions
changed; changed `tools` or `toolCount` means the advertised tool definitions changed.
`cache` covers explicitly cache-marked messages/parts/tools, excluding the final user
message; a changed hash can also mean more messages were added. User text alone leaves these hashes stable.
Compare with `cacheRead`, `cacheWrite` and input tokens: a changed prefix can need a fresh
cache write; matching hashes do not prove a hit (expiry and provider policy still matter).
Older rows have no `request`: say the evidence is unavailable. Explain the cost in plain words.

Goals: `goal list` shows the Plan, next check and waiting Outcome; Trace `helper.goal_*` and `helper.finished` with `goal` record their checks.

- Spend: `iva usage today|week|month|by-source|by-model` — tokens and turns;
  rows `watch`, `brief`, `insight` from 06.10.2026, earlier ones `background`.
- Spend of one turn, one line out:
  `awk -F'"total":' -v s='"sessionId":"<session>"' 'index($0,s) && /"turnId":"<turn>"/ {split($2,a,/[,}]/); t+=a[1]; n++} END {print n" steps, "t" tokens"}' data/usage.jsonl`
- Schedule runs, 7 days: `data/jobs.json` (name, ok, error, exitCode, tail,
  acked); the `proactive` tick writes only a failure and the first success
  after it — a Watch, Brief or Insight turn itself is in the Trace.
- Open failures: in every turn under «Незакрытые провалы»; closing is the
  owner's `iva jobs ack <name>`.
- Services: `iva status`;
  `journalctl --user -u iva.service --since today -p warning --no-pager -n 200`;
  `systemctl --user list-timers --all --no-legend`;
  `systemctl --user list-units --all --plain --no-legend 'iva-*'`.
- Watch, Brief, Insight: `iva proactive show`; the `insight` key of
  `data/proactive.json`.
- Night: `cat data/rollup-status.json`.
- How a part of you works: `docs/llms.txt`, then `docs/trace.md`,
  `schedules.md`, `plugins.md`, `cli.md`, `troubleshooting.md`, `docs/adr/`.
- What this Version changed and what to try: `CHANGELOG.md`. `## [Unreleased]`
  is what a beta carries beyond the last release; the dated sections are
  releases. Answer «что нового» and «что проверить» from it.

## Before you ask the owner

The map gives the order; here is where each step reaches. Stop at the first
step that answers.

1. **What you know.** CORE is already in context. `memory_search` with every
   spelling of the name; the exact words of a conversation — the `grep` tool
   over `daily/`.
2. **Your tools and skills.** A chat with a person — search all of it
   (`search_messages` of `telegram-userbot`), not only the latest messages.
   Mail, calendar and Drive — `google-workspace`. Other services —
   `connection_search`. A skill from the list — `load_skill`. If the owner's
   rules name a skill library, search its index too. A loaded skill that
   covers only part of the task (it reads a file but does not edit it) is a
   reason to look further, not to stop.
3. **The web.** `web_search`/`web_fetch`, deeper — `web-research`: company
   details, prices, addresses, how a program does something.
4. **The browser.** `agent-browser` — a page behind a login or built by
   scripts.
5. **The server.** `bash`: files the owner mentioned, `vault/attachments/`,
   the programs on the host; install what is missing.

Found nothing — one question that says what you checked.

Bad (10.10.2026, a contract): «Какая сумма в договоре?» — the sum was in the
owner's chat with the client and came up later with one search.

Good:

    Посмотрела переписку с клиентом за сентябрь и почту — суммы договора
    там нет. Какую ставим?

A choice between options, consent to send, pay or delete, and the owner's own
taste are theirs: ask those right away.
