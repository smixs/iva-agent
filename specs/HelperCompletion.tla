-------------------------- MODULE HelperCompletion --------------------------
EXTENDS Naturals, Sequences, TLC
CONSTANT Mutant
VARIABLE s
vars == <<s>>
Workers == {1, 2}
Init == s = [event |-> "none", stop |-> "none", expired |-> FALSE,
  restarted |-> FALSE, run |-> TRUE, saved |-> FALSE, outcome |-> "none",
  commits |-> 0, delivered |-> FALSE, deliveries |-> 0, lock |-> 0,
  phase |-> [w \in Workers |-> "read"],
  observed |-> [w \in Workers |-> "none"],
  prefix |-> FALSE, committedPrefix |-> FALSE,
  observedPrefix |-> [w \in Workers |-> FALSE],
  keptPrefix |-> [w \in Workers |-> FALSE],
  seen |-> [w \in Workers |-> "none"],
  chosen |-> [w \in Workers |-> "none"]]
End == /\ s.event = "none"
       /\ s' = [s EXCEPT !.event = "completed"]
Expire == /\ ~s.expired /\ s' = [s EXCEPT !.expired = TRUE]
Cancel == /\ s.stop = "none" /\ s' = [s EXCEPT !.stop = "closed"]
Restart == /\ ~s.restarted /\ s' = [s EXCEPT !.restarted = TRUE]
Prefix == /\ ~s.prefix /\ s' = [s EXCEPT !.prefix = TRUE]
Read(w, aborted) ==
  /\ s.phase[w] = "read"
  /\ s' = [s EXCEPT !.observed[w] = s.event,
       !.observedPrefix[w] = s.prefix,
       !.keptPrefix[w] = s.prefix /\ ~(aborted /\ Mutant = "drop-prefix"),
       !.seen[w] = IF Mutant = "wait-tail" THEN "none" ELSE s.event,
       !.chosen[w] = IF s.stop # "none" THEN "stopped"
         ELSE IF s.event = "completed" /\ Mutant # "wait-tail" THEN "done"
         ELSE IF s.restarted THEN "interrupted"
         ELSE IF s.expired THEN "deadline" ELSE "none",
       !.phase[w] = "claim"]
Acquire(w) ==
  /\ s.phase[w] = "claim" /\ s.chosen[w] # "none" /\ s.lock = 0
  /\ s' = [s EXCEPT !.lock = w, !.phase[w] = "check"]
Check(w) ==
  /\ s.lock = w /\ s.phase[w] = "check"
  /\ s' = [s EXCEPT !.phase[w] = IF s.run \/ Mutant = "duplicate-commit"
       THEN IF Mutant = "finalize-before-result" THEN "commit" ELSE "write"
       ELSE "release"]
Write(w) ==
  /\ s.lock = w /\ s.phase[w] = "write"
  /\ s' = [s EXCEPT !.saved = @ \/ s.seen[w] = "completed" \/ s.keptPrefix[w], !.phase[w] = "commit"]
WriteFailure(w) ==
  /\ s.lock = w /\ s.phase[w] = "write"
  /\ s' = [s EXCEPT !.phase[w] = "release"]
Commit(w) ==
  /\ s.lock = w /\ s.phase[w] = "commit" /\ s.commits < 2
  /\ s' = [s EXCEPT !.run = FALSE, !.commits = @ + 1,
       !.committedPrefix = s.observedPrefix[w],
       !.outcome = IF s.stop # "none" THEN "stopped" ELSE s.chosen[w],
       !.phase[w] = "release"]
Release(w) ==
  /\ s.lock = w /\ s.phase[w] = "release"
  /\ s' = [s EXCEPT !.lock = 0, !.phase[w] = "done"]
Crash(w) ==
  /\ s.lock = w /\ s.phase[w] \in {"write", "commit"}
  /\ ~s.restarted
  /\ s' = [s EXCEPT !.lock = 0, !.phase[w] = "read", !.restarted = TRUE]
Retry(w) ==
  /\ s.phase[w] = "done" /\ s.run /\ ~s.restarted
  /\ s' = [s EXCEPT !.phase[w] = "read", !.restarted = TRUE]
Deliver ==
  /\ ~s.run /\ ~s.delivered
  /\ s' = [s EXCEPT !.delivered = TRUE, !.deliveries = @ + 1]
Next == End \/ Prefix \/ Expire \/ Cancel \/ Restart \/ Deliver \/
  (\E w \in Workers : (\E aborted \in BOOLEAN : Read(w, aborted)) \/ Acquire(w) \/ Check(w) \/ Write(w)
    \/ WriteFailure(w) \/ Commit(w) \/ Release(w) \/ Crash(w) \/ Retry(w))
Spec == Init /\ [][Next]_vars
TypeOK == /\ s.event \in {"none", "completed"} /\ s.lock \in {0, 1, 2}
  /\ s.outcome \in {"none", "done", "stopped", "deadline", "interrupted"}
  /\ s.commits \in 0..2 /\ s.deliveries \in 0..1
OutcomeOnce == s.commits <= 1
ResultBeforeFinalize == s.outcome = "done" => s.saved
DeliveryOnce == s.deliveries <= 1
CompletedObserved == \A w \in Workers : s.phase[w] # "read"
  /\ s.observed[w] = "completed" /\ s.stop = "none" => s.chosen[w] = "done"
PartialBeforeFinalize == s.commits > 0 /\ s.committedPrefix => s.saved
=============================================================================
