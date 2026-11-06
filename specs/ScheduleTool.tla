--------------------------- MODULE ScheduleTool ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Mutant, OverlapMutant
VARIABLES generation, pending, due, fired, active, facts, clock, until, duration, id, text
vars == <<generation, pending, due, fired, active, facts, clock, until, duration, id, text>>
Init == /\ generation = 0 /\ pending = TRUE /\ due = TRUE
        /\ fired = [g \in 0..2 |-> 0]
        /\ active = [g \in 0..2 |-> 0] /\ facts = [g \in 0..2 |-> 0]
        /\ duration = 2 /\ clock = 0 /\ until = [g \in 0..2 |-> 0] /\ id = "r-1" /\ text = "instruction"
\* move/run_now take the same table lock as Tick. Each explicit request arms
\* one firing, preserving identity and payload. A missed minute stays due.
Edit(now) == /\ generation < 2 /\ generation' = generation + 1
             /\ pending' = TRUE /\ due' = now
             /\ duration' \in {1, 2}
             /\ UNCHANGED <<fired, active, facts, clock, until, id, text>>
Minute == /\ ~due /\ due' = TRUE
          /\ UNCHANGED <<generation, pending, fired, active, facts, clock, until, duration, id, text>>
Tick == /\ (active[0] + active[1] + active[2] = 0 \/ OverlapMutant) /\ due /\ (pending \/ Mutant) /\ fired[generation] < 2
        /\ fired' = [fired EXCEPT ![generation] = @ + 1]
        /\ active' = [active EXCEPT ![generation] = @ + 1]
        /\ until' = [until EXCEPT ![generation] = clock + duration]
        /\ pending' = FALSE
        /\ UNCHANGED <<generation, due, facts, clock, duration, id, text>>
\* A child completes or reaches its deadline independently of edit/tick. Duration abstracts short/long commands;
\* editing the next duration preserves the active firing deadline.
Finish(g) == /\ active[g] > 0 /\ active' = [active EXCEPT ![g] = @ - 1]
             /\ facts' = [facts EXCEPT ![g] = @ + 1]
             /\ UNCHANGED <<generation, pending, due, fired, clock, until, duration, id, text>>
\* Absolute child deadlines complete execution even if a detached descendant
\* retains a pipe. Timer advance and expiry are one transition.
Advance == /\ clock < 4 /\ clock' = clock + 1
           /\ active' = [g \in 0..2 |-> IF until[g] <= clock + 1 THEN 0 ELSE active[g]]
           /\ facts' = [g \in 0..2 |-> IF until[g] <= clock + 1 THEN facts[g] + active[g] ELSE facts[g]]
           /\ UNCHANGED <<generation, pending, due, fired, until, duration, id, text>>
Next == Advance \/ Edit(TRUE) \/ Edit(FALSE) \/ Minute \/ Tick \/ (\E g \in 0..2 : Finish(g))
Spec == Init /\ [][Next]_vars
OncePerRequest == \A g \in 0..2 : fired[g] <= 1
OneRunning == active[0] + active[1] + active[2] <= 1
FiringFactKept == \A g \in 0..2 : active[g] + facts[g] = fired[g]
WithinDeadline == \A g \in 0..2 : active[g] > 0 => clock < until[g]
IdentityKept == id = "r-1" /\ text = "instruction"
=============================================================================
