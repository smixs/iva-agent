---- MODULE NightProgress ----
\* ADR-0016: A accumulates answers in the day cache, before any Card/summary write.
\* A received answer can be lost before atomic save. Saved answers survive every
\* interruption; only a complete sequence is published through NightWriter.
\* C keeps its candidates until CORE is committed, then consumes the queue itself.
\* There is no independent coreDone receipt. coreCommitted is a proof witness.
EXTENDS Naturals, Sequences
CONSTANTS Parts, MaxAttempts, ResumeProgress, BoundAttempts, CountTransient
VARIABLES phase, cursor, saved, received, failures, result, crashed, savedThrough, askedSaved, realFailures, interruptions, corePending, coreCommitted
vars == <<phase, cursor, saved, received, failures, result, crashed, savedThrough, askedSaved, realFailures, interruptions, corePending, coreCommitted>>

Init == /\ phase = "ask" /\ cursor = 0 /\ saved = <<>>
        /\ received = 0 /\ failures = 0 /\ result = <<>> /\ crashed = FALSE
        /\ savedThrough = 0 /\ askedSaved = FALSE /\ realFailures = 0 /\ interruptions = 0
        /\ corePending = TRUE /\ coreCommitted = FALSE

Receive ==
  /\ phase = "ask" /\ cursor < Parts
  /\ received' = cursor + 1 /\ phase' = "received"
  /\ askedSaved' = (askedSaved \/ cursor + 1 <= savedThrough)
  /\ UNCHANGED <<cursor, saved, failures, result, crashed, savedThrough, realFailures, interruptions, corePending, coreCommitted>>
Save ==
  /\ phase = "received"
  /\ saved' = Append(saved, received) /\ cursor' = cursor + 1
  /\ savedThrough' = IF cursor' > savedThrough THEN cursor' ELSE savedThrough
  /\ phase' = IF cursor' = Parts THEN "publish" ELSE "ask"
  /\ UNCHANGED <<received, failures, result, crashed, askedSaved, realFailures, interruptions, corePending, coreCommitted>>
\* Only actual day failures consume an Attempt.
\* Process death/deadline before an observed failure consumes no Attempt.
Interrupt ==
  /\ phase \in {"ask", "received", "publish"}
  /\ failures < MaxAttempts + 1
  /\ failures' = failures + 1 /\ realFailures' = realFailures + 1
  /\ phase' = IF BoundAttempts /\ failures' >= MaxAttempts
                 THEN "paused" ELSE "interrupted"
  /\ UNCHANGED <<cursor, saved, received, result, crashed, savedThrough, askedSaved, interruptions, corePending, coreCommitted>>
Crash ==
  /\ ~crashed /\ phase \in {"ask", "received", "publish", "core", "core-written", "core-committed"}
  /\ phase' = "interrupted" /\ crashed' = TRUE
  /\ UNCHANGED <<cursor, saved, received, failures, result, savedThrough, askedSaved, realFailures, interruptions, corePending, coreCommitted>>
\* Ceiling cuts, like temporary outages/deadlines, preserve attempts and saved A.
\* CountTransient is the mutant that counts these interruptions as day failures.
Transient ==
  /\ phase \in {"ask", "received", "publish"} /\ interruptions < MaxAttempts + 1
  /\ phase' = "interrupted" /\ interruptions' = interruptions + 1
  /\ failures' = IF CountTransient THEN failures + 1 ELSE failures
  /\ UNCHANGED <<cursor, saved, received, result, crashed, savedThrough, askedSaved, realFailures, corePending, coreCommitted>>
Resume ==
  /\ phase = "interrupted"
  /\ cursor' = IF Len(result) > 0 THEN Parts ELSE IF ResumeProgress THEN Len(saved) ELSE 0
  /\ phase' = IF Len(result) > 0 THEN "core" ELSE IF cursor' = Parts THEN "publish" ELSE "ask"
  /\ received' = 0
  /\ saved' = IF ResumeProgress THEN saved ELSE <<>>
  /\ UNCHANGED <<failures, result, crashed, savedThrough, askedSaved, realFailures, interruptions, corePending, coreCommitted>>
Publish ==
  /\ phase = "publish" /\ result' = saved /\ saved' = <<>> /\ phase' = "core"
  /\ UNCHANGED <<cursor, received, failures, crashed, savedThrough, askedSaved, realFailures, interruptions, corePending, coreCommitted>>
WriteCore ==
  /\ phase = "core" /\ phase' = "core-written"
  /\ UNCHANGED <<cursor, saved, received, failures, result, crashed, savedThrough, askedSaved, realFailures, interruptions, corePending, coreCommitted>>
CommitCore ==
  /\ phase = "core-written" /\ phase' = "core-committed" /\ coreCommitted' = TRUE
  /\ UNCHANGED <<cursor, saved, received, failures, result, crashed, savedThrough, askedSaved, realFailures, interruptions, corePending>>
ConsumeCore ==
  /\ phase = "core-committed" /\ phase' = "done" /\ corePending' = FALSE
  /\ UNCHANGED <<cursor, saved, received, failures, result, crashed, savedThrough, askedSaved, realFailures, interruptions, coreCommitted>>
Settled == phase \in {"paused", "done"} /\ UNCHANGED vars
Next == Receive \/ Save \/ Interrupt \/ Transient \/ Crash \/ Resume \/ Publish \/ WriteCore \/ CommitCore \/ ConsumeCore \/ Settled
Spec == Init /\ [][Next]_vars /\ WF_vars(Receive) /\ WF_vars(Save)
        /\ WF_vars(Resume) /\ WF_vars(Publish)
        /\ WF_vars(WriteCore) /\ WF_vars(CommitCore) /\ WF_vars(ConsumeCore)

TypeOK == /\ phase \in {"ask", "received", "publish", "core", "core-written", "core-committed", "interrupted", "paused", "done"}
          /\ cursor \in 0..Parts /\ received \in 0..Parts
          /\ saved \in Seq(1..Parts) /\ result \in Seq(1..Parts)
          /\ failures \in 0..(MaxAttempts + 1) /\ crashed \in BOOLEAN
          /\ savedThrough \in 0..Parts /\ askedSaved \in BOOLEAN
          /\ realFailures \in 0..(MaxAttempts + 1) /\ interruptions \in 0..(MaxAttempts + 1)
          /\ corePending \in BOOLEAN /\ coreCommitted \in BOOLEAN
\* Each saved answer contributes once, in the same order as an uninterrupted day.
PortionsAppliedOnce == saved = [i \in 1..Len(saved) |-> i]
SameResult == phase = "done" => result = [i \in 1..Parts |-> i]
AttemptsBounded == failures <= MaxAttempts
SavedNeverAsked == ~askedSaved
TransientPreservesAttempts == failures = realFailures
CoreConsumedAfterCommit == ~corePending => coreCommitted
PublishedProgressConsumed == Len(result) > 0 => saved = <<>>
EventuallySettled == <>(phase \in {"done", "paused"})
====
