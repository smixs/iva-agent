---- MODULE ReminderLifecycle ----
EXTENDS Naturals

\* One row of data/reminders.json through its firings: a Reminder (Kind = "at") or a
\* Routine (Kind = "cron"). The processes that share the row: the minute tick inside the
\* agent, the fire child, the Alert children, and the tick's in-memory continuations.
\*
\* Tick -> agent/lib/reminder-tick.ts:runReminderTick, table transactions in order:
\*   TickDue   -> reminder-store.ts:fireDue (holds a row that owes its Alert)
\*   TickSweep -> reminder-store.ts:sweepFired (the same hold)
\*   TickClose -> reminder-store.ts:closeAbandoned (skips a firing whose child this agent runs)
\*   TickAlert -> reminder-tick.ts:owedAlerts (closed rows whose Alert fact is missing)
\* Spawn, HandlerFill -> reminder-tick.ts:fireRow (the continuation dies with the agent)
\* ChildSend, ChildAnswer, ChildAnswerLost, ChildRefused, ChildRecord -> scripts/reminders/fire.ts:fireRow
\*   ChildSend: Telegram accepted the message; ChildAnswer: the sender got the answer;
\*   ChildAnswerLost: the answer was lost and the transport (scripts/lib/telegram-send.ts)
\*   sends the same text again. The turn itself never runs again.
\* AlertCheck, AlertAccept, AlertAnswer, AlertRecord -> fire.ts:alertAbandoned through
\*   alertOnce (packages/alert-state): the row and the Alert fact are read, the Alert is sent,
\*   the fact is recorded. AlertWait, AlertResume -> telegram-send.ts:postWithTransientRetry:
\*   a transient refusal or a lost answer, the backoff, and the check (beforeAttempt) that
\*   reads the row and the Alert fact again before the next attempt.
\* Open, Expire -> reminder-store.ts:reminderPhase ("running" until the liveness window passes)
\* firing stands for firedAt: the identity every recordDelivery compares before it writes.
\*
\* Excludes: move and run_now (ScheduleTool), the turn itself (TurnLifecycle, ReminderSilence),
\* the per-tick claim limit, a damaged table, a Telegram answer that lies about delivery, and
\* the milliseconds between a check of the Alert child and the attempt it lets through.
CONSTANTS Kind, Fault, MaxCrashes, MaxFaults
ASSUME Kind \in {"at", "cron"}
ASSUME Fault \in {"none", "nopickup", "resend", "stale", "recapture", "sweepopen",
                  "closelive", "alertblind", "forget", "nofact", "sweepfirst",
                  "takefirst", "retryblind"}

Firings == 1..2
Dues == 1..2
Slots == 1..2

VARIABLES agent, tick, matured, dueAt, status, firing, delivered, error, expired,
          child, handler, sender, tracked, alertFact, crashes, faults,
          texts, lostText, alerts, misses, reasons, captures, overdue, falseAlert, dropped
row == <<status, dueAt, firing, delivered, error, expired>>
ghost == <<texts, lostText, alerts, misses, reasons, captures, overdue, falseAlert, dropped>>
vars == <<agent, tick, matured, row, child, handler, sender, tracked, alertFact, crashes,
          faults, ghost>>

Init == /\ agent = "up" /\ tick = "idle" /\ matured = 0 /\ crashes = 0 /\ faults = 0
        /\ status = "pending" /\ dueAt = 1 /\ firing = 0
        /\ delivered = "null" /\ error = "none" /\ expired = FALSE
        /\ child = [f \in Firings |-> "none"] /\ handler = [f \in Firings |-> FALSE]
        /\ sender = [f \in Firings |-> [k \in Slots |-> "none"]]
        /\ tracked = [f \in Firings |-> 0] /\ alertFact = [f \in Firings |-> FALSE]
        /\ texts = [f \in Firings |-> 0] /\ lostText = [f \in Firings |-> 0]
        /\ alerts = [f \in Firings |-> 0] /\ misses = [f \in Firings |-> 0]
        /\ reasons = [f \in Firings |-> FALSE] /\ captures = [d \in Dues |-> 0]
        /\ overdue = FALSE /\ falseAlert = FALSE /\ dropped = FALSE

\* A firing with neither a fact nor a reason: nobody has said how it ended.
Open == status # "swept" /\ firing > 0 /\ delivered = "null" /\ error = "none"
\* The row still shows firing f closed by the tick, no late fact, and no Alert fact yet.
Owes(f) == /\ firing = f /\ status # "swept" /\ delivered = "null" /\ error = "abandoned"
           /\ ~alertFact[f]
Alive(s) == s \in {"check", "send", "accepted", "sent", "wait"}
Fault1 == faults < MaxFaults /\ faults' = faults + 1

\* ---- clock ----
Mature == /\ matured < (IF Kind = "cron" THEN 2 ELSE 1) /\ matured' = matured + 1
          /\ UNCHANGED <<agent, tick, row, child, handler, sender, tracked, alertFact,
                         crashes, faults, ghost>>
\* The liveness window passes. The clock does not know whether the child is alive.
Expire == /\ Open /\ ~expired /\ expired' = TRUE
          /\ UNCHANGED <<agent, tick, matured, status, dueAt, firing, delivered, error,
                         child, handler, sender, tracked, alertFact, crashes, faults, ghost>>

\* ---- the minute tick ----
TickStart == /\ agent = "up" /\ tick = "idle" /\ tick' = "due"
             /\ UNCHANGED <<agent, matured, row, child, handler, sender, tracked, alertFact,
                            crashes, faults, ghost>>
\* The row is held while the firing it shows owes its Alert: taking it again would replace that
\* firing, sweeping it would remove it, and the debt would go with it. dropped: the row left a
\* firing that still owed its Alert.
Held == firing > 0 /\ Owes(firing)
Drop == dropped' = (dropped \/ Held)
\* One atomic transition takes the row; an open firing is never taken over, a held one neither.
\* Fault "takefirst": the take does not look at the debt (the code before).
TickDue ==
  /\ agent = "up" /\ tick = "due" /\ tick' = "sweep"
  /\ IF /\ status = "pending" /\ dueAt <= matured /\ ~Open /\ firing < 2
        /\ (~Held \/ Fault = "takefirst")
     THEN /\ Drop /\ firing' = firing + 1
          /\ delivered' = "null" /\ error' = "none" /\ expired' = FALSE
          /\ handler' = [handler EXCEPT ![firing + 1] = TRUE]
          /\ captures' = [captures EXCEPT ![dueAt] = @ + 1]
          /\ status' = IF Kind = "at" /\ Fault # "recapture" THEN "fired" ELSE "pending"
          /\ dueAt' = IF Kind = "cron" /\ Fault # "recapture" THEN dueAt + 1 ELSE dueAt
     ELSE UNCHANGED <<row, handler, captures, dropped>>
  /\ UNCHANGED <<agent, matured, child, sender, tracked, alertFact, crashes, faults,
                 texts, lostText, alerts, misses, reasons, overdue, falseAlert>>
\* A day later the fired row leaves the table, but only once its firing has an outcome and owes
\* no Alert. Fault "sweepfirst": the sweep does not look at the debt (the code before).
TickSweep ==
  /\ agent = "up" /\ tick = "sweep" /\ tick' = "close"
  /\ \/ /\ status = "fired" /\ (~Open \/ Fault = "sweepopen")
        /\ (~Held \/ Fault = "sweepfirst") /\ status' = "swept" /\ Drop
     \/ status' = status /\ UNCHANGED dropped
  /\ UNCHANGED <<agent, matured, dueAt, firing, delivered, error, expired,
                 child, handler, sender, tracked, alertFact, crashes, faults, texts, lostText,
                 alerts, misses, reasons, captures, overdue, falseAlert>>
\* The open firing whose window has passed and whose child this agent does not run gets its
\* reason in one transition. A child this agent still runs keeps its firing open.
Closable == Open /\ expired /\ (~handler[firing] \/ Fault = "closelive")
TickClose ==
  /\ agent = "up" /\ tick = "close"
  /\ IF Closable
     THEN IF Fault = "nopickup"
          THEN /\ overdue' = TRUE /\ tick' = "alert" /\ UNCHANGED <<error, reasons>>
          ELSE /\ error' = "abandoned" /\ tick' = "alertnew"
               /\ reasons' = [reasons EXCEPT ![firing] = TRUE]
               /\ UNCHANGED overdue
     ELSE /\ tick' = "alert" /\ UNCHANGED <<error, reasons, overdue>>
  /\ UNCHANGED <<agent, matured, status, dueAt, firing, delivered, expired, child, handler,
                 sender, tracked, alertFact, crashes, faults, texts, lostText, alerts,
                 misses, captures, falseAlert, dropped>>
\* Every pass hands an owed Alert to a child, unless an Alert child this agent runs already
\* has it. The debt lives in the row and the Alert fact, so a crash does not erase it.
\* Fault "forget": the Alert goes out only in the pass that closed the row (the code before).
FreeSlot(f) == {k \in Slots : ~Alive(sender[f][k])}
TickAlert ==
  /\ agent = "up" /\ tick \in {"alert", "alertnew"} /\ tick' = "idle"
  /\ IF /\ firing > 0 /\ Owes(firing) /\ tracked[firing] = 0 /\ FreeSlot(firing) # {}
        /\ (Fault # "forget" \/ tick = "alertnew")
     THEN LET k == CHOOSE s \in FreeSlot(firing) : TRUE
          IN /\ sender' = [sender EXCEPT ![firing][k] = "check"]
             /\ tracked' = [tracked EXCEPT ![firing] = k]
     ELSE UNCHANGED <<sender, tracked>>
  /\ UNCHANGED <<agent, matured, row, child, handler, alertFact, crashes, faults, ghost>>
Tick == TickStart \/ TickDue \/ TickSweep \/ TickClose \/ TickAlert

\* ---- the fire child ----
Spawn(f) == /\ agent = "up" /\ handler[f] /\ child[f] = "none"
            /\ child' = [child EXCEPT ![f] = "turn"]
            /\ UNCHANGED <<agent, tick, matured, row, handler, sender, tracked, alertFact,
                           crashes, faults, ghost>>
\* Telegram accepts the reply of the turn or the row text as is.
ChildSend(f) == /\ child[f] \in {"turn", "resend"} /\ child' = [child EXCEPT ![f] = "accepted"]
                /\ texts' = [texts EXCEPT ![f] = @ + 1]
                /\ UNCHANGED <<agent, tick, matured, row, handler, sender, tracked, alertFact,
                               crashes, faults, lostText, alerts, misses, reasons, captures,
                               overdue, falseAlert, dropped>>
ChildAnswer(f) == /\ child[f] = "accepted" /\ child' = [child EXCEPT ![f] = "sent"]
                  /\ UNCHANGED <<agent, tick, matured, row, handler, sender, tracked,
                                 alertFact, crashes, faults, ghost>>
\* The answer is lost after Telegram accepted: the transport sends the same text again.
ChildAnswerLost(f) ==
  /\ child[f] = "accepted" /\ Fault1 /\ child' = [child EXCEPT ![f] = "resend"]
  /\ lostText' = [lostText EXCEPT ![f] = @ + 1]
  /\ UNCHANGED <<agent, tick, matured, row, handler, sender, tracked, alertFact, crashes,
                 texts, alerts, misses, reasons, captures, overdue, falseAlert, dropped>>
\* No route, the owner's stop or a Telegram refusal: nothing more reaches the chat.
ChildRefused(f) == /\ child[f] \in {"turn", "resend"} /\ child' = [child EXCEPT ![f] = "refused"]
                   /\ UNCHANGED <<agent, tick, matured, row, handler, sender, tracked,
                                  alertFact, crashes, faults, ghost>>
\* The fact goes to the row only for the firing it belongs to.
Mine(f) == status # "swept" /\ (firing = f \/ Fault = "stale")
ChildRecord(f) ==
  /\ child[f] \in {"sent", "refused"} /\ child' = [child EXCEPT ![f] = "done"]
  /\ IF Mine(f)
     THEN /\ delivered' = IF child[f] = "sent" THEN "true" ELSE "false"
          /\ error' = IF child[f] = "refused" THEN "other" ELSE error
          /\ reasons' = IF child[f] = "refused"
                        THEN [reasons EXCEPT ![firing] = TRUE] ELSE reasons
     ELSE UNCHANGED <<delivered, error, reasons>>
  /\ UNCHANGED <<agent, tick, matured, status, dueAt, firing, expired, handler, sender,
                 tracked, alertFact, crashes, faults, texts, lostText, alerts, misses,
                 captures, overdue, falseAlert, dropped>>
\* The fact write failed (the table lock was busy): the child leaves without it.
ChildSilent(f) == /\ child[f] \in {"sent", "refused"} /\ child' = [child EXCEPT ![f] = "done"]
                  /\ UNCHANGED <<agent, tick, matured, row, handler, sender, tracked,
                                 alertFact, crashes, faults, ghost>>
\* SIGKILL, or the service manager stops the child together with the agent.
ChildDie(f) == /\ child[f] \in {"turn", "accepted", "resend", "sent", "refused"}
               /\ child' = [child EXCEPT ![f] = "dead"]
               /\ UNCHANGED <<agent, tick, matured, row, handler, sender, tracked,
                              alertFact, crashes, faults, ghost>>
\* The tick's continuation: a child that ended without a fact gets its reason.
HandlerFill(f) ==
  /\ agent = "up" /\ handler[f] /\ child[f] \in {"done", "dead"}
  /\ handler' = [handler EXCEPT ![f] = FALSE]
  /\ IF Mine(f) /\ delivered = "null"
     THEN /\ error' = "other" /\ reasons' = [reasons EXCEPT ![firing] = TRUE]
          /\ delivered' = IF child[f] = "dead" THEN "false" ELSE "null"
     ELSE UNCHANGED <<delivered, error, reasons>>
  /\ UNCHANGED <<agent, tick, matured, status, dueAt, firing, expired, child, sender,
                 tracked, alertFact, crashes, faults, texts, lostText, alerts, misses,
                 captures, overdue, falseAlert, dropped>>

\* ---- the Alert children ----
\* A sender that ends is forgotten by the continuation that watched it, if any.
End(f, k, s) == /\ sender' = [sender EXCEPT ![f][k] = s]
                /\ tracked' = IF tracked[f] = k THEN [tracked EXCEPT ![f] = 0] ELSE tracked
\* The child reads the row and the Alert fact. Fault "alertblind" skips the row.
\* falseAlert: the check let through an Alert about a firing whose fact the row holds or whose
\* fire child this agent still runs.
Passes(f) == IF Fault = "alertblind" THEN ~alertFact[f] ELSE Owes(f)
LetThrough(f) == falseAlert' = (falseAlert \/ handler[f] \/ (firing = f /\ delivered = "true"))
AlertCheck(f, k) ==
  /\ sender[f][k] = "check"
  /\ IF Passes(f)
     THEN /\ sender' = [sender EXCEPT ![f][k] = "send"] /\ UNCHANGED tracked /\ LetThrough(f)
     ELSE End(f, k, "done") /\ UNCHANGED falseAlert
  /\ UNCHANGED <<agent, tick, matured, row, child, handler, alertFact, crashes, faults,
                 texts, lostText, alerts, misses, reasons, captures, overdue, dropped>>
\* Telegram accepts the Alert. It names the reminder and the reason; it is not the row
\* text sent again: the table cannot tell whether the fire child had already sent it.
AlertAccept(f, k) ==
  /\ sender[f][k] = "send" /\ sender' = [sender EXCEPT ![f][k] = "accepted"]
  /\ IF Fault = "resend"
     THEN texts' = [texts EXCEPT ![f] = @ + 1] /\ UNCHANGED alerts
     ELSE alerts' = [alerts EXCEPT ![f] = @ + 1] /\ UNCHANGED texts
  /\ UNCHANGED <<agent, tick, matured, row, child, handler, tracked, alertFact, crashes,
                 faults, lostText, misses, reasons, captures, overdue, falseAlert, dropped>>
AlertAnswer(f, k) == /\ sender[f][k] = "accepted" /\ sender' = [sender EXCEPT ![f][k] = "sent"]
                     /\ UNCHANGED <<agent, tick, matured, row, child, handler, tracked,
                                    alertFact, crashes, faults, ghost>>
\* The answer is lost after Telegram accepted: the transport waits and tries again.
AlertAnswerLost(f, k) ==
  /\ sender[f][k] = "accepted" /\ Fault1 /\ sender' = [sender EXCEPT ![f][k] = "wait"]
  /\ misses' = [misses EXCEPT ![f] = @ + 1]
  /\ UNCHANGED <<agent, tick, matured, row, child, handler, tracked, alertFact, crashes,
                 texts, lostText, alerts, reasons, captures, overdue, falseAlert, dropped>>
\* A transient refusal (5xx, 429, the network): the transport waits and tries again.
AlertWait(f, k) == /\ sender[f][k] = "send" /\ Fault1 /\ sender' = [sender EXCEPT ![f][k] = "wait"]
                   /\ UNCHANGED <<agent, tick, matured, row, child, handler, tracked, alertFact,
                                  crashes, ghost>>
\* After the backoff the next attempt goes through the check again: a fact that landed while
\* the transport waited stops the Alert. Fault "retryblind": the attempt goes without it.
AlertResume(f, k) ==
  /\ sender[f][k] = "wait"
  /\ IF Fault = "retryblind"
     THEN sender' = [sender EXCEPT ![f][k] = "send"] /\ LetThrough(f)
     ELSE sender' = [sender EXCEPT ![f][k] = "check"] /\ UNCHANGED falseAlert
  /\ UNCHANGED <<agent, tick, matured, row, child, handler, tracked, alertFact, crashes,
                 faults, texts, lostText, alerts, misses, reasons, captures, overdue, dropped>>
\* Telegram refused: no fact, the next pass hands the Alert to a new child.
AlertRefused(f, k) == /\ sender[f][k] = "send" /\ Fault1 /\ End(f, k, "done")
                      /\ UNCHANGED <<agent, tick, matured, row, child, handler, alertFact,
                                     crashes, ghost>>
\* The fact "Alert sent" is recorded after the send. Fault "nofact": it is never recorded.
AlertRecord(f, k) ==
  /\ sender[f][k] = "sent" /\ End(f, k, "done")
  /\ alertFact' = IF Fault = "nofact" THEN alertFact ELSE [alertFact EXCEPT ![f] = TRUE]
  /\ UNCHANGED <<agent, tick, matured, row, child, handler, crashes, faults, ghost>>
\* A sender that dies after Telegram accepted leaves an Alert without its fact.
AlertDie(f, k) ==
  /\ Alive(sender[f][k]) /\ Fault1 /\ End(f, k, "dead")
  /\ misses' = IF sender[f][k] \in {"accepted", "sent"}
               THEN [misses EXCEPT ![f] = @ + 1] ELSE misses
  /\ UNCHANGED <<agent, tick, matured, row, child, handler, alertFact, crashes,
                 texts, lostText, alerts, reasons, captures, overdue, falseAlert, dropped>>

\* ---- the agent ----
\* Everything the tick kept in memory goes: continuations and the senders it watched. The
\* children are processes of their own and may outlive the agent. A sender the agent forgets
\* before it recorded its fact may meet a second sender after the restart.
Crash == /\ agent = "up" /\ crashes < MaxCrashes
         /\ agent' = "down" /\ tick' = "idle" /\ crashes' = crashes + 1
         /\ handler' = [f \in Firings |-> FALSE] /\ tracked' = [f \in Firings |-> 0]
         /\ misses' = [f \in Firings |->
                         IF \E k \in Slots : Alive(sender[f][k]) THEN misses[f] + 1
                         ELSE misses[f]]
         /\ UNCHANGED <<matured, row, child, sender, alertFact, faults, texts, lostText,
                        alerts, reasons, captures, overdue, falseAlert, dropped>>
Restart == /\ agent = "down" /\ agent' = "up"
           /\ UNCHANGED <<tick, matured, row, child, handler, sender, tracked, alertFact,
                          crashes, faults, ghost>>

ChildStep(f) == Spawn(f) \/ ChildSend(f) \/ ChildAnswer(f) \/ ChildRecord(f) \/ HandlerFill(f)
SenderStep(f, k) == AlertCheck(f, k) \/ AlertAccept(f, k) \/ AlertAnswer(f, k) \/ AlertRecord(f, k)
                    \/ AlertResume(f, k)
Next == \/ Mature \/ Expire \/ Tick \/ Crash \/ Restart
        \/ \E f \in Firings :
             \/ ChildStep(f) \/ ChildAnswerLost(f) \/ ChildRefused(f) \/ ChildSilent(f)
             \/ ChildDie(f)
             \/ \E k \in Slots : SenderStep(f, k) \/ AlertAnswerLost(f, k) \/ AlertWait(f, k)
                                 \/ AlertRefused(f, k) \/ AlertDie(f, k)
Spec == Init /\ [][Next]_vars
\* After the last crash the agent comes back, the tick keeps ticking, the clock moves, and
\* the children finish: the turn has its silence watchdog, Telegram answers in the end.
FairSpec == /\ Spec /\ WF_vars(Restart) /\ WF_vars(Tick) /\ WF_vars(Expire)
            /\ \A f \in Firings : /\ WF_vars(ChildStep(f))
                                  /\ \A k \in Slots : WF_vars(SenderStep(f, k))

\* 5. One capture, one delivery attempt: the text of a firing reaches the chat once, and again
\*    only when Telegram accepted it and the answer was lost (at least once at the transport).
OneAttemptPerCapture == \A f \in Firings : texts[f] <= 1 + lostText[f]
\* 3. The fact in the row is the fact of the firing the row shows.
FactOfThisFiring == status # "swept" /\ firing > 0 /\ delivered = "true" => texts[firing] >= 1
\* 4. One due, one firing.
OncePerDue == \A d \in Dues : captures[d] <= 1
\* 2. No tick walks past an open firing whose window has passed and whose child is gone.
BoundedOutcome == ~overdue
\* One abandoned firing, one Alert; a repeat only when a sender lost track of an Alert it had
\* sent: the answer was lost, the sender died after Telegram accepted, or the agent forgot it.
AlertOnce == \A f \in Firings : alerts[f] <= 1 + misses[f]
\* No Alert about a firing whose fact the row holds or whose child this agent still runs, at the
\* first attempt and at every repeat of the transport.
NoFalseAlert == ~falseAlert
\* An abandoned firing does not leave the row before its Alert: neither the next firing of a
\* Routine nor the sweep a day later takes away a firing that still owes it.
AlertBeforeDrop == ~dropped
\* 1. A firing that is over went out or carries its reason.
Settled(f) == f <= firing /\ ~(f = firing /\ Open)
DeliveredOrReason == \A f \in Firings : Settled(f) => texts[f] >= 1 \/ reasons[f]
\* 2. Every taken row gets its outcome, across crashes and restarts too.
EveryFiringConcludes == Open ~> ~Open
\* The Alert about an abandoned firing goes out after any crash, unless a late fact of that
\* firing lands first. The row does not leave in between (AlertBeforeDrop).
LateFact(f) == firing = f /\ status # "swept" /\ delivered # "null"
AbandonedAlerted == \A f \in Firings : Owes(f) ~> (alertFact[f] \/ LateFact(f))
====
