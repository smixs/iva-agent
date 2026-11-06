---
name: background-check
description: "Use when checking a long-running external job from a Reminder or a chat, or diagnosing a background job that stopped, including an interrupted memory night."
---

# Check a background job

A check observes a job; it does not keep a model turn open until the job finishes.

1. Read a bounded status snapshot: the job's checkpoint/progress file, a short tail
   of its log, or `systemctl --user show <unit> -p ActiveState -p SubState -p Result -p ExecMainStatus`.
   For the cause, read `journalctl --user -u <unit> -n 50 --no-pager`.
   A PID alone does not prove progress or completion. Use a short
   tool timeout; no `sleep`, `tail -f`, status checks in a loop or wait for process exit.
2. Return the observed state and its evidence: completed, still running, failed
   or unknown. Still running means say what remains; never report it as complete.
   Stop checking after that snapshot. A Reminder returns the status as its final
   text: code delivers it. Do not send the report yourself, invent a keepalive or
   create another Reminder inside that turn. Arrange a later check only in the
   owner's chat, if asked.
3. A failed custom script: preserve its output and resume checkpoint, find the
   failing input and show the cause before suggesting a restart. Colliding PDF
   basenames need a job-owned temporary directory and unique paths per input,
   not overwriting `/tmp/<basename>`. A restart can repeat external side effects;
   establish resume safety and the owner's authorization first.
4. An interrupted `memory-night`: read `iva diagnose` and its Schedules section, the failed job's log, the raw
   day in `vault/daily/` and its cache in `data/memory/night/`. A day not processed
   that night is not proof that a Card was deleted. The next night resumes an
   unfinished day from its cache. Never delete that cache, raw days or Cards to
   repair a provider timeout; never switch the night model behind the owner's
   back. Restore the configured provider, then check the next run. `iva jobs ack`
   acknowledges a failure; it does not perform the missing work. If bytes are
   actually missing, preserve the files and Git evidence and load `report-problem`.
   The night raises its own model limits and Git wait within `iva night show`; leave caches and limits intact, and at a ceiling ask the owner to raise it with `iva night set`.

Existing Watch and Brief read failures of user timer services and installed
plugin/MCP services. They do not supervise arbitrary detached processes, detect
a hung but live process, or restart a custom script. Keep a persistent capability
in a plugin, and use a Routine for recurring work; do not build another scheduler
or watchdog in the chat. Before fixing a Watch failure, follow `watch`: read-only
until the owner's Fix tap.
