---- MODULE ReminderSilence ----
EXTENDS Naturals
CONSTANT IgnoreTool
VARIABLES now, lastEvent, pending, until, stopped, cause
vars == <<now, lastEvent, pending, until, stopped, cause>>
\* readTurnStream: two parallel callIds; silence=2, tool timeout=4, grace=2.
\* Tool effects and session reset are in TurnLifecycle; this refines its Expire guard.
Init == /\ now = 0 /\ lastEvent = 0 /\ pending = {}
        /\ until = [id \in {1,2} |-> 0] /\ stopped = FALSE /\ cause = ""
Request(id) == /\ ~stopped /\ id \notin pending /\ now = 0
               /\ pending' = pending \cup {id} /\ until' = [until EXCEPT ![id] = now+6]
               /\ lastEvent' = now /\ UNCHANGED <<now, stopped, cause>>
Result(id) == /\ ~stopped /\ id \in pending
              /\ pending' = pending \ {id} /\ lastEvent' = now
              /\ UNCHANGED <<now, until, stopped, cause>>
Tick == /\ ~stopped /\ now < 8 /\ now' = now+1
        /\ UNCHANGED <<lastEvent, pending, until, stopped, cause>>
Expire == /\ ~stopped /\ now >= lastEvent+2
          /\ (IgnoreTool \/ \A id \in pending: now >= until[id])
          /\ stopped' = TRUE /\ cause' = "silence"
          /\ UNCHANGED <<now, lastEvent, pending, until>>
Deadline == /\ ~stopped /\ now >= 3 /\ stopped' = TRUE /\ cause' = "deadline"
            /\ UNCHANGED <<now, lastEvent, pending, until>>
Next == (\E id \in {1,2}: Request(id) \/ Result(id)) \/ Tick \/ Expire \/ Deadline
Spec == Init /\ [][Next]_vars
ToolWait == stopped /\ cause = "silence" => \A id \in pending: now >= until[id]
IdleBound == now >= lastEvent+2 /\ pending = {} /\ ~stopped => ENABLED Expire
ToolBound == now >= 6 /\ now >= lastEvent+2 /\ ~stopped => ENABLED Expire
DeadlineWins == now >= 3 /\ ~stopped => ENABLED Deadline
====
