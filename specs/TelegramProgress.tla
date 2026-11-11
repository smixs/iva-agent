-------------------------- MODULE TelegramProgress --------------------------
\* One live TelegramDraftStream. The channel sends after completeStep claims.
\* Invariants: at most one progress attempt; only a live owner claims; empty
\* and stale steps do not consume the claim; drafts may be disabled independently.
\* HTTP success, redaction and actual latency are checked by the wire smoke.
EXTENDS Naturals
CONSTANT Mutant
VARIABLES closed, owner, claimed, step, attempts, invalid
vars == <<closed, owner, claimed, step, attempts, invalid>>
Init == /\ closed = FALSE /\ owner = TRUE /\ claimed = FALSE
        /\ step = 0 /\ attempts = 0 /\ invalid = FALSE
Complete(n, text) ==
  /\ n \in 0..2 /\ text \in BOOLEAN
  /\ LET valid == ~closed /\ owner /\ n >= step /\ text
         take == IF Mutant = "no-owner" THEN ~closed /\ n >= step /\ text
                 ELSE valid
         send == take /\ (~claimed \/ Mutant = "repeat")
     IN /\ step' = IF ~closed /\ n >= step THEN n ELSE step
        /\ claimed' = (claimed \/ send)
        /\ attempts' = IF send THEN attempts + 1 ELSE attempts
        /\ invalid' = (invalid \/ (send /\ ~valid))
  /\ UNCHANGED <<closed, owner>>
Close == /\ ~closed /\ closed' = TRUE
         /\ UNCHANGED <<owner, claimed, step, attempts, invalid>>
LoseOwner == /\ owner /\ owner' = FALSE
             /\ UNCHANGED <<closed, claimed, step, attempts, invalid>>
Next == (\E n \in 0..2, text \in BOOLEAN : Complete(n, text)) \/ Close \/ LoseOwner
Spec == Init /\ [][Next]_vars
Once == attempts <= 1
LiveOwner == ~invalid
=============================================================================
