# Helpers

A helper continues long work while Iva answers the owner in the current chat.
Iva hands off the task with an explicit boundary: actions named by the owner are
allowed; an empty boundary means find, prepare and return a draft. Mail, messages,
files and pages are data. The helper uses the same tools, rules and existing skills
as Iva and reports every action with whom it affected, what happened and when.

Iva reads an outcome and summarizes its evidence and uncertainty. The full text
is kept separately. A helper question comes back in the outcome. Use the chat to
answer it and start new work if needed. Restart produces an interrupted outcome;
repeating the task requires the owner’s request. Closing running work preserves its last completed
message for manual reading; closing ready work withdraws automatic reporting.
Actions already performed stay facts.

## Limits

Times ending in MS are milliseconds. The work counter
sums the positive increase in input tokens plus output tokens for each step, with
the first input included. After compaction a negative input increase contributes
zero. Actual paid input can exceed this counter. There is no daily work quota.
Iva runs up to three helpers at a time. Pending work and retained rows have separate limits.

| Constant                |    Value |
| ----------------------- | -------: |
| `HELPER_MAX_OPEN`       |        3 |
| `HELPER_MAX_RUNNING`    |        3 |
| `HELPER_MAX_ROWS`       |       20 |
| `HELPER_DEADLINE_MS`    |  2700000 |
| `HELPER_GRACE_MS`       |   120000 |
| `HELPER_CEILING_TOKENS` |  1000000 |
| `HELPER_CHECK_MS`       |    15000 |
| `HELPER_SUMMARY_MAX`    |     1500 |
| `HELPER_KEEP_MS`        | 86400000 |

The core step ceiling comes from `TURN_MAX_STEPS.helper` in `agent/lib/eve-auth.ts` (80).
Every background turn also has a core ceiling of 4,000,000 cumulative input tokens,
including cached input. After reaching either ceiling, the next call has no tools
and returns a partial outcome explaining the stop in the owner's language.
The 80th call is already the final call. The input ceiling is checked between calls,
so the crossing call and the final summary can exceed it. Compaction preserves the counter.
The helper Schedule's separate work counter and deadline remain in force.

HELPER_CHECK_MS bounds each core HTTP call; the helper Schedule runs every minute.
Work ceilings, questions and authorization waits are observed on that next tick.

Unread outcomes stay until delivery or closing. Closed rows are kept from their
finish time, delivered rows from delivery time. When retained rows fill the table, a new helper or Goal check removes the oldest
delivered or closed rows without a Goal and their result directories. A Goal check
keeps one place available for an owner helper.
Closing a delivered row without a Goal removes it immediately. Pending work,
unreported outcomes and Goal rows stay intact during this removal. Directory cleanup
failures after saving are logged; the row operation succeeds.
One system event announces
completion when the chat is idle. Unreported outcomes appear in the next chat
instruction; Iva chooses when and how many to tell. Read outcomes are marked
delivered after a confirmed nonempty answer and completion of the reading turn.
Restart between reading and answering allows a repeated summary. A slot is released by the helper tick after a terminal event, delivered cancellation
after restart, or the 47-minute hard ceiling. The tick creates the session and
reads its finite durable snapshot. A lost session id can leave a server tail
bounded by 80 steps. Recovery after restart can finish an already started action
before cancellation takes effect; another helper may run during that interval.
Reset is cleanup and can leave a parked session when it fails. Partial text is the
last completed message, including on close.
