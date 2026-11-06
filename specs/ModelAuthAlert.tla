--------------------------- MODULE ModelAuthAlert ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANT SkipThrottle
VARIABLES pending, sentDays, day, quiet, duplicate, recovery, delivered
vars == <<pending, sentDays, day, quiet, duplicate, recovery, delivered>>
Init == /\ pending = FALSE /\ sentDays = {} /\ day = 0 /\ quiet = TRUE
        /\ duplicate = FALSE /\ recovery = 0 /\ delivered = FALSE
Fail == /\ ~pending /\ ~delivered /\ pending' = TRUE
        /\ UNCHANGED <<sentDays, day, quiet, duplicate, recovery, delivered>>
Wake == /\ quiet /\ quiet' = FALSE
        /\ UNCHANGED <<pending, sentDays, day, duplicate, recovery, delivered>>
Tomorrow == /\ day = 0 /\ day' = 1 /\ quiet' = TRUE
        /\ UNCHANGED <<pending, sentDays, duplicate, recovery, delivered>>
Send == /\ pending /\ ~quiet /\ (SkipThrottle \/ day \notin sentDays)
        /\ duplicate' = (day \in sentDays) /\ sentDays' = sentDays \cup {day}
        /\ delivered' = TRUE /\ UNCHANGED <<pending, day, quiet, recovery>>
(* Replies to an owner message bypass quiet hours and the proactive throttle. *)
OwnerReply == /\ pending /\ delivered' = TRUE /\ sentDays' = sentDays \cup {day}
              /\ UNCHANGED <<pending, day, quiet, duplicate, recovery>>
Succeed == /\ pending /\ pending' = FALSE
        /\ UNCHANGED <<sentDays, day, quiet, duplicate, recovery, delivered>>
Recover == /\ ~pending /\ delivered /\ ~quiet /\ recovery = 0
        /\ recovery' = 1 /\ delivered' = FALSE
        /\ UNCHANGED <<pending, sentDays, day, quiet, duplicate>>
(* Restart and failed Telegram send preserve durable evidence and delivery marks. *)
RestartOrSendFailure == UNCHANGED vars
Next == Fail \/ Wake \/ Tomorrow \/ Send \/ OwnerReply \/ Succeed \/ Recover \/ RestartOrSendFailure
Spec == Init /\ [][Next]_vars
DailyThrottle == ~duplicate
RecoveryOnce == recovery <= 1
=============================================================================
