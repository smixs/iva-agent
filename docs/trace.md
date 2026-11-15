# Trace — the turn journal

The core writes one JSONL line per event: from the update the Bridge accepts to the answer
Outbox delivers. Two readers consume it — the `trace` plugin viewer and `iva trace` — so
this file, not the code, is the contract (ADR-0010). Terms follow `CONTEXT.md`.

File: `data/trace/YYYY-MM-DD.jsonl` under the data directory (`ASSISTANT_DATA_DIR`,
`./data` by default). Two processes append to it: the agent and the Bridge. Append-only,
one line per write.

## Event schema

Exactly seven fields, always in this order:

| Field     | Meaning                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- |
| `ts`      | ISO-8601 **UTC**, the moment of writing                                                       |
| `turn`    | turn key — three cases, see below                                                             |
| `session` | Eve session id (empty until the turn starts)                                                  |
| `source`  | `telegram`, `bridge`, `web`, `http`, `rollup`, `watch`, `brief`, `insight`, `cron`, `unknown` |
| `kind`    | group: `bridge`, `inbound`, `gate`, `context`, `turn`, `eve`, `outbox`, `status`, `stop`      |
| `name`    | the specific event inside the group                                                           |
| `data`    | object: names, timings, sizes, content                                                        |

`source` is `unknown` when an Eve event arrives without a channel kind. Journals of 0.4.11
and earlier may also carry `digest`. Note that `ts` is
UTC while the **day file** is named after the installation timezone
(`ASSISTANT_TIMEZONE`): near midnight the first lines of a file can carry a UTC timestamp
that belongs to the previous UTC day. That is deliberate — the journal splits days the way
the vault does.

A line is never longer than 16 KB **in UTF-8 bytes**. An event that does not fit is rebuilt
with every content field at 2000 characters; only if that still does not fit does it lose its
content (`data.traceTrimmed: true`). Names, timings and sizes always survive.

## The three key spaces of `turn`

1. **Before the turn exists** — the update key `tg:<chatId>:<messageId>`. Both the Bridge
   and the core can compute it; `update_id` is invisible to the core.
2. **After the turn starts** — the Eve `turnId` (`turn_0`, `turn_1`, …). Subagent steps
   carry a suffix: `turn_3#custom-node`, the same key `data/usage.jsonl` uses.
3. **Night turns have no turn key at all.** Rollup and other cron deliveries go through
   the Eve client, which exposes only a session id, so their `gate.outbound` and
   `outbox.*` lines carry `turn: ""` with a non-empty `session` and `source` in
   {`rollup`, `cron`}. Watch, Brief and Insight parts are sent by the proactive tick itself: their
   lines carry `turn: ""`, no `session` and `source` `watch`, `brief` or `insight`. The Eve events of
   that same night turn still carry `turn_N` from the hook, because the hook runs inside
   the agent.

**How a reader stitches one turn**

- _Chat turn:_ take `turn.bound`, collect everything whose `turn` equals its
  `data.updateKey` (Bridge, inbound, inbound gate) plus everything whose `session` **and**
  `turn` equal its own (Eve events, Outbox, Stop), then sort by `ts`; a line with `turn_N`
  and no session joins the most recent turn with that `turn_N`.
- _Night turn:_ group by `session` **and** `turn_N` together. One Eve session holds many
  turns — the nightly Rollup, for one, keeps its
  session alive across nights — so a session on its own would glue a fortnight of nights
  into one turn.
- _A line with no turn key_ (`gate.outbound` and `outbox.*` of a night send) belongs to the
  **most recent turn of its session** by `ts`.
- _Source is part of no key._ Inside one night turn the Eve lines carry
  `source: "unknown"` while `gate.outbound` and `outbox.*` carry `rollup`, so grouping by
  source would cut one turn in two.

**Naming one turn.** `<session>/<turn>`, e.g. `wrun_01M…/turn_0`, is what `iva trace show`
prints and accepts, what the Insight failure list gives and what `iva diagnose --turn` takes.
A bare `turn_N` names the newest turn with that number.

Callback updates (`/menu` buttons) get the key `tg:<chatId>:cb:<callbackId>`,
and **only the Bridge produces it**: callbacks never reach `runTelegramInbound`, so those
`bridge.*` lines stay orphans with no `turn.bound` and no `inbound.*`.
Native draft stops (`stopped_message_generation`) use `tg:<chatId>:stop:<update_id>` at intake; `stop.*` records the verified session and turn pair.

## Event catalogue

| `kind`.`name`                                                     | `data`                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridge.admitted` / `bridge.dropped`                              | `updateId`, `chatId`, `messageId`, `kind` (`message`/`callback`), `decision` (`owned`/`terminal-drop`/`unownable`/`write-failed`)                                                                                                                               |
| `bridge.queued`                                                   | `updateId`, `chatId`, `messageId`, `kind`, `count` (now waiting in the chat queue), `parts`; the event time is the queueing time                                                                                                                                |
| `bridge.delivered` / `bridge.rejected`                            | the same fields plus `accepted` (`true`/`false`/`"handled"`), `ms`, `parts` (messages in the delivery: a queue batch carries several)                                                                                                                           |
| `inbound.received`                                                | `chatId`, `chatType`, `messageId`, `userId`, `allowlisted`; content: `text`                                                                                                                                                                                     |
| `inbound.accepted` / `inbound.dropped`                            | `chatId`, `chatKey`, `parts`, `partChars[]`; content: `context[]`                                                                                                                                                                                               |
| `gate.inbound` / `gate.web`                                       | `surface`, `blocked`, `reason`, `flags[]`, `truncatedChars`, `chars`                                                                                                                                                                                            |
| `turn.bound`                                                      | `chatKey`, `updateKey`                                                                                                                                                                                                                                          |
| `turn.retired`                                                    | `replayMs`                                                                                                                                                                                                                                                      |
| `context.parts`                                                   | `core`, `persona`, `moc`, `daily` — memory file sizes in bytes, `unit`, `approximate`                                                                                                                                                                           |
| `eve.turn.started` / `turn.completed` / `turn.cancelled`          | `sequence`                                                                                                                                                                                                                                                      |
| `eve.turn.failed` / `eve.step.failed`                             | `sequence`, `stepIndex`, `code`; content: `message`, `details`                                                                                                                                                                                                  |
| `eve.step.started`                                                | `sequence`, `stepIndex`                                                                                                                                                                                                                                         |
| `eve.step.completed`                                              | `sequence`, `stepIndex`, `finishReason`, `usage {in,out,cacheRead,cacheWrite,costUsd?}`                                                                                                                                                                         |
| `eve.actions.requested`                                           | `sequence`, `stepIndex`, `actions[{kind,callId,toolName\|name}]`; content: `args[]`, index-aligned with `actions`                                                                                                                                               |
| `eve.action.result`                                               | `sequence`, `stepIndex`, `status`, `callId`, `toolName`, `name?` (the skill of `load_skill`), `subagentName?`, `isError`, `errorCode?`, `exitCode?`, `failure?`, `outChars?`; content: `result` (one JSON string), `error` (only when it differs from `result`) |
| `eve.message.completed`                                           | `sequence`, `stepIndex`, `finishReason`; content: `message`                                                                                                                                                                                                     |
| `eve.message.received`                                            | `sequence`, `parts`; content: `message`                                                                                                                                                                                                                         |
| `eve.reasoning.completed`                                         | `sequence`, `stepIndex`; content: `reasoning`                                                                                                                                                                                                                   |
| `eve.subagent.started` / `subagent.completed` / `subagent.called` | `callId`, `subagentName`, `name`, `childSessionId`; content: `output`                                                                                                                                                                                           |
| Eve events inside a subagent                                      | the same fields plus `subagent`, `parentCallId`                                                                                                                                                                                                                 |
| `gate.outbound`                                                   | `clean`, `findings[]` (`type:name`, no secret preview), `chars`; content: `text` — already **after** redaction                                                                                                                                                  |
| `outbox.delivered` / `outbox.failed`                              | `ok`, `delivered`, `fellBack`, `error`, `chars`, `ms`                                                                                                                                                                                                           |
| `status.post` / `status.edit`                                     | the progress message of a long turn, only when a request went to Telegram: `ok`, `answer` (`ok`, `gone`, `wait`, `error`), `error`, `chars`, `ms`. Never the turn's delivery or failure: `iva trace` and `iva diagnose` skip it                                 |
| `stop.requested` / `stop.idle` / `stop.failed`                    | `chatKey`, `outcome`                                                                                                                                                                                                                                            |

Any Eve event may also carry `sessionId` in `data` (whenever its payload has one) and
`input` in content (with `inputChars`); the hook copies both by name.

**`failure`** marks a failed tool call with its class, never with text: `isError` (eve or the
tool flagged the answer as an error), `status:failed` (the answer named its own `code` and
`message`; `errorCode` holds the code), `ok:false`, `error`, `timeout`, `exit <code>` (bash,
only with a non-empty stderr). `rejected` and a cancelled call are not failures. A failure
hidden by a pipe or `2>&1` has no `failure`. A string answer that holds a JSON object is
read as that object, as eve and the repeat guard read it. Lines written before this change
carry `result` as an object and no `failure`.

**`gate.outbound` can appear without a matching `outbox.*`.** Every service reply the
channel sends (a draft frame, an error explanation, a media notice) passes the
same outbound gate but not the Outbox seam, so it produces a gate line alone. Do not wait
for a delivery event after each gate verdict.

**`outbox.delivered` can carry `fellBack: true` and an `error`.** The reply reached the
chat, but not in the form the text asked for: a chunk went out as plain text, or Telegram
refused the rich message and the reply went by the HTML path without its buttons. In the
second case `error` reads `buttons dropped: sendRichMessage 400: <Telegram's reason>`.

Writer markers in `data`: `traceTrimmed` — the event went without content;
`traceUnreadable` — the payload could not be serialized. Markers inside values:
`…[truncated]` — a string or list was cut, `…[deep]` — nesting deeper than four levels,
`…[keys]` — how many fields the truncated object had, `…[unreadable]` — a field could not
be read. A bash result that fits the field is written whole; one that does not keeps the
**end** of `stdout` and the last 1000 characters of `stderr`: `…[truncated]` at the start of
the field means the head was cut. Other answers put `ok`, `error`, `message`, `isError`,
`code` and `exitCode` first, so a cut end keeps them. `outChars` is the size of the answer the
model got. An event rebuilt at 2000 characters (below) cuts every field from the end, a bash
result too.

### What is not in the journal

- **Delta events** (`message.appended`, `reasoning.appended`, `action.partial`). They
  repeat the accumulated text hundreds of times per turn; the final text arrives in
  `*.completed`.
- **Eve's own context composition.** CORE, PERSONA and the current time are injected by
  Eve's dynamic instructions, which cannot report from inside. `context.parts` gives the
  **size of those same files on disk** when the turn starts — an approximation, which the
  event itself states with `approximate: true`.
- **Gate verdicts outside a turn.** The sanitizer is called by scripts and unit tests too;
  without a turn key a verdict has nothing to attach to, so those calls write nothing.
  The in-process turn mark also expires after 60 seconds: if media handling of one inbound
  message takes longer than a minute, the gate verdict that follows it is not journaled.

## Content: the toggle and the caps

`data/settings.json`, field `captureContent` (on by default):

```json
{ "captureContent": false }
```

Turned off it keeps names, timings and sizes — the turn stays fully visible, only without
text. Every content field is capped at 4096 characters with the `…[truncated]` marker.

Sizes are written for **string** content fields only, as `<key>Chars` (`text` →
`textChars`). Array content — `args[]`, `context[]` — gets no size; their counts already
live in `data` as `actions[]` and `parts`.

## Retention

30 days: today's file and the 29 before it. Pruning goes by the **date in the file name**,
never by mtime (ADR-0002: file time lies after a copy or a restore), and runs on the first
journal write of a process and again whenever the day file changes. Files whose names do
not match `YYYY-MM-DD.jsonl` are left alone.

## Guarantees for a reader

- Every line is standalone valid JSON; one broken line does not spoil its neighbours.
- A write failure never breaks or slows a turn: it goes to the service log (at most once a
  minute) and nothing else.
- Two processes append to one file, so line order is write order, not turn order. Sort by
  `ts`.

Historical Trace entries such as `turn_3#planner` retain their original meaning.
