# Reminders

Ask Iva to remind you, and she will — at the due time, including seconds, in your timezone, in your chat. A reminder is not a note she might recall later: it is a row in `data/`, picked up by a dispatcher that wakes every second. Restart the server, update Iva, roll the version back — the row is still there, and anything that came due while the machine was down fires on the first tick after it comes back.

## How to ask

Plain words in the chat, the way you would tell a person:

- «remind me in 30 minutes to call the clinic»
- «remind me at 14:30 to send the invoice»
- «on 14 September at 09:00 — the contract deadline»
- «every weekday at 09:00 remind me about standup»
- «what reminders do I have?» — she lists them
- «cancel the standup one» — she finds it and removes it

Two kinds: a one-time reminder fires once and is done, a repeating one takes its next time from the calendar and waits for it. You never write the date arithmetic yourself and neither does she: you say when, Iva turns it into an exact moment and tells you back the time she stored.

| You say                                              | What it means                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `in 30m`, `in 1h 30m`, `in 2d`                       | a delay from now                                                   |
| `14:30`                                              | today at that wall-clock time; if it has already passed — tomorrow |
| `2026-09-14 09:00`                                   | that date and time on your wall clock                              |
| an ISO instant with an offset or `Z`                 | exactly that moment, wherever you are                              |
| a five-field schedule expression, e.g. `0 9 * * 1-5` | repeating: 09:00 on weekdays, in your timezone                     |

Everything is read in your timezone — the one Iva is configured with, not the server's. A date that does not exist on your clock (the hour skipped by a daylight-saving change, 31 February) is refused with that reason instead of being rounded to something nearby. So is a time in the past, and anything more than a year out.

## What happens at the time

A simple reminder (`content: "text"`) is ready text. Code sends it directly to the chat and topic where you asked, without a model turn. The next tick is within one second of the stored due time; the isolated smoke test allows 15 seconds including child startup and local transport. Network failures and a busy dispatcher can add delay. The existing dispatcher runs every second; it also picks up reminders created between minute boundaries.

A scheduled task (`content: "task"`) is a self-contained instruction for Iva. At the due time she starts one fresh session, uses her tools and returns a final answer; code sends that answer to your chat. This can take as long as the task and model need. Existing reminders without `content` retain this task behavior. Repeating reminders use the same two choices and keep their existing schedule calculation.

If the task fails or returns no usable text, code sends the original instruction. If `/new` resets the conversation while the task is running, code sends that text with a short note in your language explaining that the reset interrupted execution. An explicit `/stop` addressed to that turn closes it without sending the text.

A row fires once. The transport may retry the same text if Telegram's acceptance answer is lost; a doubled reminder is preferable to a lost one. `delivered` records the transport answer, while `error` preserves any task failure and transport refusal. The list names the last firing with `phase`: `waiting`, `running`, `delivered`, `failed` or `abandoned`. An interrupted child without a known outcome still uses the existing Alert described below.

## Where to see the list

`/menu` → **⏰** shows the nearest reminders, what failed to go out, and one line about the dispatcher: when it last ticked (its pulse is the file `data/reminders.tick`, touched every second). A fresh pulse means the machinery is alive; a stale one, or none at all, is your signal that reminders are stored but nothing will fire until Iva is running again.

You can also just ask in the chat: she lists the same rows with their ids, the next time, and the last firing with the delivery fact. Rows stay in the list for a day after they fire — that is where you see whether the text went out. Ask her to cancel one and she removes it by id.

## When something breaks

- **Nothing arrived.** The row shows `delivered: false` and the reason in `error`. Fix the chat settings or the token, then ask again — a one-time reminder has already fired, so put a new one.
- **The agent turn could not run.** Your text still arrives, verbatim; the reason is in `error` and in the journal (`journalctl --user -u iva.service | grep reminders`).
- **Iva restarted while the reminder was firing.** The firing is left with no delivery fact, and the table cannot tell whether the text had already gone out. Iva does not send it a second time. Once the firing has been silent for half an hour, she marks the row `abandoned` with the reason in `error` and sends one notice to the same chat: which reminder may not have reached you and what to check. A turn that is still running in Iva is not marked, however long it takes. If Iva goes down again before the notice goes out, she sends it after the restart; until then the row stays, and a recurring reminder takes its next due only after that notice. `iva doctor` lists such a row too, also while Iva is down. A scheduled command left without an outcome is treated the same way: it is not run again, and you get one notice.
- **The dispatcher is not ticking.** The list warns that the reminder is stored but will not fire, and `iva doctor` says the same by the pulse file. It also lists every reminder that fired in the last day and did not go out.
- **`no activity for 180000ms` during an external-job check.** The limit counts silence in the Eve event stream, including a blocking tool that produces no events; it is not a three-minute limit on the whole turn. A check should read a bounded progress/status snapshot and return it, even if the job is still running. It should not wait for process exit, run `tail -f` or keep checking in a loop. The `background-check` skill describes this procedure. Code sends the final status; the model must not send a report separately and then keep waiting. A later check belongs in a new request from the owner, not a new reminder created inside the firing turn.

## Scheduling and delivery

Use `remind` or `schedule` for reminders; `add` with text requires `content: "text"` or `content: "task"`. Delivery goes through the turn response; use `iva post` for an external chat.

## Limits

- **Back to where you asked.** A reminder returns to the chat and forum topic it was created in; another person as the recipient is not supported. Reminders created before 0.4.4 go to the owner chat from the settings.
- **No more often than every ten minutes.** A repeating schedule tighter than that is refused: that is a monitoring job, not a reminder.
- **Your timezone, one of them.** Everything is computed in the timezone Iva is configured with.
- **A scheduled task is one turn.** It fires, Iva does what the text says in that single turn and answers once (or, if repeating, moves to the next occurrence). The turn has no time limit: it runs as long as the work needs, and only two things end it — `/stop` sent from the same chat, or three minutes of silence from the model. `/new` also interrupts execution and delivers the original text with an explanation. The reminder uses `/stop` in its originating chat. Private chat drafts use the native ■ control when the Telegram channel owns the turn. She sets no new reminders in it: that turn may list and remove them, not add.

## Stored format and rollback

The current reader accepts reminder schemas 1 and 2. Scheduled commands keep schema 2.

The reminder table keeps schema 2 and its existing row keys. `data/reminder-content.json` stores only `id → "text"`; an absent entry means task. A missing or unreadable content file preserves the original bytes and falls back to task execution, with a warning in the log for unreadable data. On rollback, older versions execute text reminders as tasks: the text arrives after a model turn.
