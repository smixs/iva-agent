-------------------------- MODULE TelegramProgress --------------------------
\* ChatRecord owns the claim for a session+turn, before the Outbox attempt.
\* Close/Restore model input.requested and the next stream; Crash/Restore model
\* a new process recovering the same ChatRecord. Draft IDs are not claim IDs.
\* age abstracts elapsed milliseconds: 0..10 are quiet, 11 permits progress.
EXTENDS Naturals
CONSTANT Mutant
VARIABLES closed, alive, owner, claimed, step, attempts, invalid, age, noisy
vars == <<closed, alive, owner, claimed, step, attempts, invalid, age, noisy>>
Init == /\ closed = FALSE /\ alive = TRUE /\ owner = TRUE /\ claimed = FALSE
        /\ step = 0 /\ attempts = 0 /\ invalid = FALSE /\ age = 0 /\ noisy = FALSE
Complete(n, text) ==
  /\ alive /\ attempts < 2 /\ n \in 0..2 /\ text \in BOOLEAN
  /\ LET valid == ~closed /\ owner /\ n >= step /\ text
         take == IF Mutant = "no-owner" THEN ~closed /\ n >= step /\ text
                 ELSE valid
         send == take /\ (~claimed \/ Mutant = "repeat")
                      /\ (age > 10 \/ Mutant = "no-threshold")
     IN /\ step' = IF ~closed /\ n >= step THEN n ELSE step
        /\ claimed' = (claimed \/ send)
        /\ attempts' = IF send THEN attempts + 1 ELSE attempts
        /\ invalid' = (invalid \/ (send /\ ~valid))
        /\ noisy' = (noisy \/ (send /\ age <= 10))
  /\ UNCHANGED <<closed, alive, owner, age>>
Close == /\ alive /\ ~closed /\ closed' = TRUE
         /\ UNCHANGED <<alive, owner, claimed, step, attempts, invalid, age, noisy>>
Crash == /\ alive /\ alive' = FALSE /\ closed' = TRUE
         /\ UNCHANGED <<owner, claimed, step, attempts, invalid, age, noisy>>
Restore == /\ closed /\ owner /\ closed' = FALSE /\ alive' = TRUE /\ step' = 0
           /\ claimed' = IF Mutant = "draft-claim" THEN FALSE ELSE claimed
           /\ UNCHANGED <<owner, attempts, invalid, age, noisy>>
Age == /\ age < 11 /\ age' = age + 1
       /\ UNCHANGED <<closed, alive, owner, claimed, step, attempts, invalid, noisy>>
LoseOwner == /\ owner /\ owner' = FALSE
             /\ UNCHANGED <<closed, alive, claimed, step, attempts, invalid, age, noisy>>
Next == (\E n \in 0..2, text \in BOOLEAN : Complete(n, text))
        \/ Close \/ Crash \/ Restore \/ Age \/ LoseOwner
Spec == Init /\ [][Next]_vars
Once == attempts <= 1
LiveOwner == ~invalid
Quiet == ~noisy
=============================================================================
