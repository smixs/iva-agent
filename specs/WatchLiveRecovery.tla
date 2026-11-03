---- MODULE WatchLiveRecovery ----
EXTENDS Integers
CONSTANTS BypassRetry, StuckReject, Reapply, Truncate
VARIABLES now, owner, phase, sentOwner, sentAt, closeOwner, edits, applied, crashed
vars == <<now, owner, phase, sentOwner, sentAt, closeOwner, edits, applied, crashed>>
Init == /\ now = 0 /\ owner = -1 /\ phase = "ready" /\ sentOwner = -1
        /\ sentAt = -1 /\ closeOwner = -1 /\ edits = 0 /\ applied = FALSE /\ crashed = FALSE
Time == /\ now < 4 /\ now' = now+1
        /\ UNCHANGED <<owner, phase, sentOwner, sentAt, closeOwner, edits, applied, crashed>>
Owner == /\ owner < now /\ owner' = now
         /\ UNCHANGED <<now, phase, sentOwner, sentAt, closeOwner, edits, applied, crashed>>
RejectedSend == /\ phase = "ready" /\ phase' = "backoff"
                /\ UNCHANGED <<now, owner, sentOwner, sentAt, closeOwner, edits, applied, crashed>>
Deliver == /\ phase \in {"ready", "backoff"}
           /\ ((BypassRetry /\ phase = "backoff") \/ owner < 0 \/ now-owner >= 2)
           /\ phase' = "delivered" /\ sentOwner' = owner /\ sentAt' = now
           /\ UNCHANGED <<now, owner, closeOwner, edits, applied, crashed>>
ClaimClose == /\ phase = "delivered" /\ owner > sentAt /\ ~Truncate
              /\ phase' = "closing" /\ closeOwner' = owner
              /\ UNCHANGED <<now, owner, sentOwner, sentAt, edits, applied, crashed>>
RejectedClose == /\ phase = "closing" /\ phase' = IF StuckReject THEN "stuck" ELSE "closing"
                 /\ UNCHANGED <<now, owner, sentOwner, sentAt, closeOwner, edits, applied, crashed>>
ApplyClose == /\ phase = "closing"
              /\ edits' = IF applied /\ ~Reapply THEN edits ELSE edits+1
              /\ applied' = TRUE
              /\ UNCHANGED <<now, owner, phase, sentOwner, sentAt, closeOwner, crashed>>
ConfirmClose == /\ phase = "closing" /\ applied /\ phase' = "closed"
                /\ UNCHANGED <<now, owner, sentOwner, sentAt, closeOwner, edits, applied, crashed>>
Crash == /\ phase = "closing" /\ ~crashed /\ crashed' = TRUE
         /\ UNCHANGED <<now, owner, phase, sentOwner, sentAt, closeOwner, edits, applied>>
Next == Time \/ Owner \/ RejectedSend \/ Deliver \/ ClaimClose \/ RejectedClose \/ ApplyClose \/ ConfirmClose \/ Crash
Spec == Init /\ [][Next]_vars
LiveSilence == sentAt >= 0 => sentOwner < 0 \/ sentAt-sentOwner >= 2
RecoverableClose == phase # "stuck"
NoFalseClose == edits > 0 => closeOwner > sentAt
NoDoubleEdit == edits <= 1
HistoryCoversSignal == phase = "delivered" /\ owner > sentAt => ENABLED ClaimClose
====
