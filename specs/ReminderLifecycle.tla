---- MODULE ReminderLifecycle ----
EXTENDS Naturals

\* One row of data/reminders.json through its firings: a Reminder (Kind = "at") or a
\* Routine (Kind = "cron"). Four processes share the row: the minute tick inside the
\* agent, the fire child, the Alert child and the tick's in-memory continuation.
\*
\* Tick -> agent/lib/reminder-tick.ts:runReminderTick, three table transactions in order:
\*   TickDue   -> reminder-store.ts:fireDue
\*   TickSweep -> reminder-store.ts:sweepFired
\*   TickClose -> reminder-store.ts:closeAbandoned
\* Spawn, HandlerFill -> reminder-tick.ts:fireRow (the continuation dies with the agent)
\* ChildSend, ChildRefused, ChildRecord -> scripts/reminders/fire.ts:fireRow
\* SpawnAlert, AlertSend -> reminder-tick.ts:alertAbandoned, fire.ts:alertAbandoned
\* Open, Expire -> reminder-store.ts:reminderPhase ("running" until the liveness window passes)
\* firing stands for firedAt: the identity every recordDelivery compares before it writes.
\*
\* Excludes: move and run_now (ScheduleTool), the turn itself (TurnLifecycle, ReminderSilence),
\* the per-tick claim limit, a damaged table, and a Telegram answer that lies about delivery.
CONSTANTS Kind, Fault, MaxCrashes
ASSUME Kind \in {"at", "cron"}
ASSUME Fault \in {"none", "nopickup", "resend", "stale", "recapture", "sweepopen"}

Firings == 1..2
Dues == 1..2

VARIABLES agent, tick, matured, dueAt, status, firing, delivered, error, expired,
          child, handler, alert, crashes,
          texts, alerts, reasons, captures, overdue
row == <<status, dueAt, firing, delivered, error, expired>>
ghost == <<texts, alerts, reasons, captures, overdue>>
vars == <<agent, tick, matured, row, child, handler, alert, crashes, ghost>>

Init == /\ agent = "up" /\ tick = "idle" /\ matured = 0 /\ crashes = 0
        /\ status = "pending" /\ dueAt = 1 /\ firing = 0
        /\ delivered = "null" /\ error = FALSE /\ expired = FALSE
        /\ child = [f \in Firings |-> "none"] /\ handler = [f \in Firings |-> FALSE]
        /\ alert = [f \in Firings |-> "none"]
        /\ texts = [f \in Firings |-> 0] /\ alerts = [f \in Firings |-> 0]
        /\ reasons = [f \in Firings |-> FALSE] /\ captures = [d \in Dues |-> 0]
        /\ overdue = FALSE

\* A firing with neither a fact nor a reason: nobody has said how it ended.
Open == status # "swept" /\ firing > 0 /\ delivered = "null" /\ ~error

\* ---- clock ----
Mature == /\ matured < (IF Kind = "cron" THEN 2 ELSE 1) /\ matured' = matured + 1
          /\ UNCHANGED <<agent, tick, row, child, handler, alert, crashes, ghost>>
\* The liveness window passes. The clock does not know whether the child is alive.
Expire == /\ Open /\ ~expired /\ expired' = TRUE
          /\ UNCHANGED <<agent, tick, matured, status, dueAt, firing, delivered, error,
                         child, handler, alert, crashes, ghost>>

\* ---- the minute tick ----
TickStart == /\ agent = "up" /\ tick = "idle" /\ tick' = "due"
             /\ UNCHANGED <<agent, matured, row, child, handler, alert, crashes, ghost>>
\* One atomic transition takes the row; an open firing is never taken over.
TickDue ==
  /\ agent = "up" /\ tick = "due" /\ tick' = "sweep"
  /\ IF status = "pending" /\ dueAt <= matured /\ ~Open /\ firing < 2
     THEN /\ firing' = firing + 1
          /\ delivered' = "null" /\ error' = FALSE /\ expired' = FALSE
          /\ handler' = [handler EXCEPT ![firing + 1] = TRUE]
          /\ captures' = [captures EXCEPT ![dueAt] = @ + 1]
          /\ status' = IF Kind = "at" /\ Fault # "recapture" THEN "fired" ELSE "pending"
          /\ dueAt' = IF Kind = "cron" /\ Fault # "recapture" THEN dueAt + 1 ELSE dueAt
     ELSE UNCHANGED <<row, handler, captures>>
  /\ UNCHANGED <<agent, matured, child, alert, crashes, texts, alerts, reasons, overdue>>
\* A day later the fired row leaves the table, but only once its firing has an outcome.
TickSweep ==
  /\ agent = "up" /\ tick = "sweep" /\ tick' = "close"
  /\ \/ /\ status = "fired" /\ (~Open \/ Fault = "sweepopen") /\ status' = "swept"
     \/ status' = status
  /\ UNCHANGED <<agent, matured, dueAt, firing, delivered, error, expired,
                 child, handler, alert, crashes, ghost>>
\* The open firing whose window has passed gets its reason in one transition; the Alert
\* is owed from that moment and is never owed twice.
TickClose ==
  /\ agent = "up" /\ tick = "close" /\ tick' = "idle"
  /\ IF Open /\ expired
     THEN IF Fault = "nopickup"
          THEN /\ overdue' = TRUE /\ UNCHANGED <<error, reasons, alert>>
          ELSE /\ error' = TRUE
               /\ reasons' = [reasons EXCEPT ![firing] = TRUE]
               /\ alert' = [alert EXCEPT ![firing] = "due"]
               /\ UNCHANGED overdue
     ELSE UNCHANGED <<error, reasons, alert, overdue>>
  /\ UNCHANGED <<agent, matured, status, dueAt, firing, delivered, expired,
                 child, handler, crashes, texts, alerts, captures>>
Tick == TickStart \/ TickDue \/ TickSweep \/ TickClose

\* ---- the fire child ----
Spawn(f) == /\ agent = "up" /\ handler[f] /\ child[f] = "none"
            /\ child' = [child EXCEPT ![f] = "turn"]
            /\ UNCHANGED <<agent, tick, matured, row, handler, alert, crashes, ghost>>
\* The reply of the turn or the row text as is: one message reaches the chat.
ChildSend(f) == /\ child[f] = "turn" /\ child' = [child EXCEPT ![f] = "sent"]
                /\ texts' = [texts EXCEPT ![f] = @ + 1]
                /\ UNCHANGED <<agent, tick, matured, row, handler, alert, crashes,
                               alerts, reasons, captures, overdue>>
\* No route, the owner's stop or a Telegram refusal: nothing reaches the chat.
ChildRefused(f) == /\ child[f] = "turn" /\ child' = [child EXCEPT ![f] = "refused"]
                   /\ UNCHANGED <<agent, tick, matured, row, handler, alert, crashes, ghost>>
\* The fact goes to the row only for the firing it belongs to.
Mine(f) == status # "swept" /\ (firing = f \/ Fault = "stale")
ChildRecord(f) ==
  /\ child[f] \in {"sent", "refused"} /\ child' = [child EXCEPT ![f] = "done"]
  /\ IF Mine(f)
     THEN /\ delivered' = IF child[f] = "sent" THEN "true" ELSE "false"
          /\ error' = (error \/ child[f] = "refused")
          /\ reasons' = IF child[f] = "refused"
                        THEN [reasons EXCEPT ![firing] = TRUE] ELSE reasons
     ELSE UNCHANGED <<delivered, error, reasons>>
  /\ UNCHANGED <<agent, tick, matured, status, dueAt, firing, expired, handler, alert,
                 crashes, texts, alerts, captures, overdue>>
\* The fact write failed (the table lock was busy): the child leaves without it.
ChildSilent(f) == /\ child[f] \in {"sent", "refused"} /\ child' = [child EXCEPT ![f] = "done"]
                  /\ UNCHANGED <<agent, tick, matured, row, handler, alert, crashes, ghost>>
\* SIGKILL, or the service manager stops the child together with the agent.
ChildDie(f) == /\ child[f] \in {"turn", "sent", "refused"}
               /\ child' = [child EXCEPT ![f] = "dead"]
               /\ UNCHANGED <<agent, tick, matured, row, handler, alert, crashes, ghost>>
\* The tick's continuation: a child that ended without a fact gets its reason.
HandlerFill(f) ==
  /\ agent = "up" /\ handler[f] /\ child[f] \in {"done", "dead"}
  /\ handler' = [handler EXCEPT ![f] = FALSE]
  /\ IF Mine(f) /\ delivered = "null"
     THEN /\ error' = TRUE /\ reasons' = [reasons EXCEPT ![firing] = TRUE]
          /\ delivered' = IF child[f] = "dead" THEN "false" ELSE "null"
     ELSE UNCHANGED <<delivered, error, reasons>>
  /\ UNCHANGED <<agent, tick, matured, status, dueAt, firing, expired, child, alert,
                 crashes, texts, alerts, captures, overdue>>

\* ---- the Alert child ----
SpawnAlert(f) == /\ agent = "up" /\ alert[f] = "due" /\ alert' = [alert EXCEPT ![f] = "child"]
                 /\ UNCHANGED <<agent, tick, matured, row, child, handler, crashes, ghost>>
\* The Alert names the reminder and the reason. It is not the row text sent again:
\* the table cannot tell whether the dead child had already sent it.
AlertSend(f) ==
  /\ alert[f] = "child" /\ alert' = [alert EXCEPT ![f] = "done"]
  /\ IF Fault = "resend"
     THEN texts' = [texts EXCEPT ![f] = @ + 1] /\ UNCHANGED alerts
     ELSE alerts' = [alerts EXCEPT ![f] = @ + 1] /\ UNCHANGED texts
  /\ UNCHANGED <<agent, tick, matured, row, child, handler, crashes, reasons, captures, overdue>>
AlertLost(f) == /\ alert[f] = "child" /\ alert' = [alert EXCEPT ![f] = "done"]
                /\ UNCHANGED <<agent, tick, matured, row, child, handler, crashes, ghost>>

\* ---- the agent ----
\* Everything the tick kept in memory goes: continuations and Alerts not yet handed over.
Crash == /\ agent = "up" /\ crashes < MaxCrashes
         /\ agent' = "down" /\ tick' = "idle" /\ crashes' = crashes + 1
         /\ handler' = [f \in Firings |-> FALSE]
         /\ alert' = [f \in Firings |-> IF alert[f] = "due" THEN "none" ELSE alert[f]]
         /\ UNCHANGED <<matured, row, child, ghost>>
Restart == /\ agent = "down" /\ agent' = "up"
           /\ UNCHANGED <<tick, matured, row, child, handler, alert, crashes, ghost>>

Next == \/ Mature \/ Expire \/ Tick \/ Crash \/ Restart
        \/ \E f \in Firings :
             \/ Spawn(f) \/ ChildSend(f) \/ ChildRefused(f) \/ ChildRecord(f)
             \/ ChildSilent(f) \/ ChildDie(f) \/ HandlerFill(f)
             \/ SpawnAlert(f) \/ AlertSend(f) \/ AlertLost(f)
Spec == Init /\ [][Next]_vars
\* After the last crash the agent comes back, the tick keeps ticking and the clock moves.
FairSpec == Spec /\ WF_vars(Restart) /\ WF_vars(Tick) /\ WF_vars(Expire)

\* 5. No duplicate in the chat: the text of one firing goes out at most once.
NoDuplicate == \A f \in Firings : texts[f] <= 1
\* 3. The fact in the row is the fact of the firing the row shows.
FactOfThisFiring == status # "swept" /\ firing > 0 /\ delivered = "true" => texts[firing] = 1
\* 4. One due, one firing.
OncePerDue == \A d \in Dues : captures[d] <= 1
\* 2. No tick walks past an open firing whose window has passed.
BoundedOutcome == ~overdue
AlertOnce == \A f \in Firings : alerts[f] <= 1
\* 1. A firing that is over went out exactly once or carries its reason.
Settled(f) == f <= firing /\ ~(f = firing /\ Open)
ExactlyOnceOrReason == \A f \in Firings : Settled(f) => texts[f] = 1 \/ reasons[f]
\* 2. Every taken row gets its outcome, across crashes and restarts too.
EveryFiringConcludes == Open ~> ~Open
====
