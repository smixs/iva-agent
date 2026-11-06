----------------------------- MODULE HelperRun -----------------------------
EXTENDS Integers, FiniteSets, Sequences, TLC
CONSTANTS Case, Mutant, Helpers
VARIABLE s
vars == <<s>>
Deadline == 2
Grace == 1
Ceiling == Deadline + Grace
RunningLimit == 3 \* HELPER_MAX_RUNNING in helper-store.ts
Terms == {"none", "completed", "failed", "question", "authorization", "cancelled", "step-limit"}
Stops == {"none", "closed", "deadline", "ceiling"}
Texts == 0..3 \* 0: empty, 1/2: distinct messages, 3: quiet reply
Empty == [status |-> "pending", run |-> FALSE, claimed |-> FALSE,
  fired |-> 0, owner |-> 1, creating |-> FALSE, created |-> FALSE, known |-> FALSE,
  kernel |-> FALSE, quarantined |-> FALSE, event |-> "none", text |-> 0,
  messages |-> 0, usage |-> <<>>, foldText |-> 0, foldUsage |-> <<>>,
  stop |-> "none", stops |-> <<>>, stopOnEnd |-> FALSE, missedCancel |-> FALSE,
  outcome |-> "none", saved |-> 0, steps |-> 0, work |-> 0,
  attempts |-> 0, delivered |-> FALSE, resetQueued |-> FALSE, commits |-> <<>>]
\* Capacity configs use four candidates to test the running guard separately from HELPER_MAX_OPEN admission (three pending rows in code).
Init == s = [rows |-> [h \in Helpers |-> Empty], owner |-> 1, now |-> 0,
  lastTick |-> -1, phase |-> "idle", todo |-> {}, reminderBusy |-> TRUE]
Running == {h \in Helpers : s.rows[h].run}
Usable(text) == IF text = 3 THEN 0 ELSE text
StopOutcome(stop) == IF stop = "closed" THEN "stopped" ELSE stop
EventOutcome(event, text) ==
  IF event = "step-limit" THEN "ceiling"
  ELSE IF event = "cancelled" THEN "interrupted"
  ELSE IF event \in {"failed", "question", "authorization"} THEN "failed"
  ELSE IF Usable(text) > 0 THEN "done" ELSE "empty"
RECURSIVE MeasuredWork(_, _)
MeasuredWork(usage, previous) ==
  IF Len(usage) = 0 THEN 0
  ELSE (IF Head(usage).input > previous THEN Head(usage).input - previous ELSE 0)
       + Head(usage).output + MeasuredWork(Tail(usage), Head(usage).input)
FirstStop(stops) == IF Len(stops) = 0 THEN "none" ELSE Head(stops)
SetStop(row, why) ==
  IF row.stop = "none" THEN [row EXCEPT !.stop = why, !.stops = Append(@, why)]
  ELSE IF Mutant = "stop-overwrite" THEN [row EXCEPT !.stop = why]
  ELSE row

\* Audit entries retain actual inputs at the CAS, independently of the selected mutation.
Commit(row, event, text, usage, startFault, delivered, outcome) ==
  [outcome |-> outcome, event |-> event, text |-> text, usage |-> usage,
   stop |-> row.stop, stops |-> row.stops, claimed |-> row.claimed,
   startFault |-> startFault, oldOwner |-> row.owner # s.owner,
   known |-> row.known, delivered |-> delivered, at |-> s.now, fired |-> row.fired,
   saved |-> IF Mutant = "drop-text" THEN 0 ELSE Usable(IF event # "none" THEN row.foldText ELSE text),
   steps |-> Len(IF event # "none" THEN row.foldUsage ELSE usage),
   work |-> IF Mutant = "work-output" THEN 0
     ELSE MeasuredWork(IF event # "none" THEN row.foldUsage ELSE usage, 0)]
Finished(row, event, text, usage, startFault, delivered, outcome) ==
  LET audit == Commit(row, event, text, usage, startFault, delivered, outcome)
  IN [row EXCEPT !.run = FALSE, !.creating = FALSE,
      !.status = IF row.stop = "closed" THEN "closed" ELSE "finished",
      !.outcome = outcome, !.saved = audit.saved, !.steps = audit.steps, !.work = audit.work,
      !.resetQueued = row.known \/ (startFault /\ row.created), !.commits = Append(@, audit)]

Claim(h) ==
  /\ s.now = 0 /\ s.rows[h].status = "pending" /\ ~s.rows[h].claimed
  /\ (Cardinality(Running) < RunningLimit \/ Mutant = "no-running-cap")
  /\ s' = [s EXCEPT !.rows[h].run = TRUE, !.rows[h].claimed = TRUE,
       !.rows[h].creating = TRUE, !.rows[h].owner = s.owner, !.rows[h].fired = s.now]
Create(h) ==
  /\ s.rows[h].run /\ s.rows[h].creating /\ ~s.rows[h].created
  /\ s' = [s EXCEPT !.rows[h].kernel = TRUE, !.rows[h].created = TRUE]
Record(h) ==
  /\ Case \notin {"lost-id", "record-failure"}
  /\ s.rows[h].run /\ s.rows[h].creating /\ s.rows[h].created
  /\ s' = [s EXCEPT !.rows[h].known = TRUE, !.rows[h].creating = FALSE]
LoseId(h) ==
  /\ Case \in {"all", "lost-id"}
  /\ s.rows[h].run /\ s.rows[h].creating /\ s.rows[h].created
  /\ s' = [s EXCEPT !.rows[h].creating = FALSE]
StartFailed(h) ==
  /\ Case = "all" /\ s.rows[h].run /\ s.rows[h].creating /\ ~s.rows[h].created
  /\ s' = [s EXCEPT !.rows[h] = Finished(@, "none", 0, <<>>, TRUE, FALSE,
       IF @.stop = "none" THEN "failed" ELSE StopOutcome(@.stop))]
RecordFailed(h) ==
  /\ Case \in {"all", "record-failure"}
  /\ s.rows[h].run /\ s.rows[h].creating /\ s.rows[h].created
  /\ LET row == [s.rows[h] EXCEPT !.attempts = @ + 1]
     IN s' = [s EXCEPT !.rows[h] = Finished(row, "none", 0, <<>>, TRUE, FALSE,
       IF row.stop = "none" THEN "failed" ELSE StopOutcome(row.stop))]

\* While a row is open, the kernel journal is adversarial. After finalize its contents are
\* irrelevant to the tick; the retained kernel flag witnesses a durable tail.
Message(h, text) ==
  /\ Case = "all" /\ s.rows[h].run /\ s.rows[h].kernel /\ ~s.rows[h].quarantined
  /\ s.rows[h].messages < 2
  /\ s' = [s EXCEPT !.rows[h].text = text, !.rows[h].messages = @ + 1,
       !.rows[h].foldText = IF Mutant = "end-cutoff" /\ s.rows[h].event # "none" THEN @ ELSE text]
Usage(h, input, output) ==
  /\ Case = "all" /\ s.rows[h].run /\ s.rows[h].kernel /\ ~s.rows[h].quarantined
  /\ Len(s.rows[h].usage) < 2
  /\ LET usage == Append(s.rows[h].usage, [input |-> input, output |-> output])
     IN s' = [s EXCEPT !.rows[h].usage = usage,
       !.rows[h].foldUsage = IF Mutant = "end-cutoff" /\ s.rows[h].event # "none" THEN @ ELSE usage]
KernelEvent(h, event) ==
  /\ Case = "all" /\ s.rows[h].run /\ s.rows[h].kernel /\ ~s.rows[h].quarantined
  /\ s.rows[h].event = "none"
  /\ s' = [s EXCEPT !.rows[h].event = event]
KernelEnd(h) ==
  /\ Case = "all" /\ s.rows[h].run /\ s.rows[h].kernel
  /\ s' = [s EXCEPT !.rows[h].kernel = FALSE]
Restart ==
  /\ Case \in {"all", "restart", "quarantine", "cancel-failure", "lost-id"}
  /\ s.owner = 1 /\ Running # {}
  /\ s' = [s EXCEPT !.owner = 2,
       !.rows = [h \in Helpers |-> [s.rows[h] EXCEPT
         !.quarantined = Case = "quarantine"]]]
Close(h) ==
  /\ s.rows[h].status = "pending" /\ s.rows[h].stop # "closed"
  /\ LET row == SetStop(s.rows[h], "closed")
     IN s' = [s EXCEPT !.rows[h] = IF row.run THEN row ELSE
       Finished(row, "none", 0, <<>>, FALSE, FALSE, "stopped")]

\* A minute advances only after its finite tick pass. Each HTTP operation returns or times out
\* within HELPER_CHECK_MS; the atomic row step represents these bounded calls, not a successful RPC.
\* v7.3: the minute dispatcher returns after admission; it remains runnable while
\* a reminder turn never returns. The shared-schedule mutant waits for that turn.
TickStart ==
  /\ (Mutant # "shared-schedule" \/ ~s.reminderBusy)
  /\ s.phase = "idle" /\ s.lastTick < s.now
  /\ s' = [s EXCEPT !.phase = "scan", !.todo = Running]
CancelDelivered(reply) == reply \in {"accepted", "no_active_turn"}
ReadReplies(row) ==
  IF row.quarantined THEN {"404"}
  ELSE IF Case = "snapshot-failure" THEN {"error", "timeout", "junk"}
  ELSE IF Case = "all" THEN {"ok", "error", "timeout", "junk", "404"}
  ELSE {"ok"}
CancelReplies(row) ==
  IF row.quarantined THEN {"no_active_turn"}
  ELSE IF Case = "cancel-failure" THEN {"error", "timeout", "other"}
  ELSE IF Case = "all" THEN {"accepted", "no_active_turn", "error", "timeout", "other"}
  ELSE {"accepted"}
TickRow(h, read, reply) ==
  /\ s.phase = "scan" /\ h \in s.todo
  /\ read \in ReadReplies(s.rows[h]) /\ reply \in CancelReplies(s.rows[h])
  /\ LET before == s.rows[h]
         readable == before.known /\ read = "ok"
         event == IF readable THEN before.event ELSE "none"
         text == IF readable THEN before.text ELSE 0
         usage == IF readable THEN before.usage ELSE <<>>
         oldOwner == before.owner # s.owner
         atCeiling == s.now >= before.fired + Ceiling
         row == IF event # "none" \/ oldOwner \/ ~readable
           \/ (atCeiling /\ Mutant # "stop-before-end") THEN before
           ELSE IF MeasuredWork(usage, 0) > 3 THEN SetStop(before, "ceiling")
           ELSE IF s.now >= before.fired + Deadline THEN SetStop(before, "deadline")
           ELSE before
         cancelNeeded == before.known /\ (oldOwner \/ row.stop # "none" \/ atCeiling \/ event # "none")
           /\ (Mutant # "stop-needs-snapshot" \/ readable \/ oldOwner \/ atCeiling \/ event # "none")
         delivered == cancelNeeded /\ CancelDelivered(reply)
         cancelRow == IF cancelNeeded THEN [row EXCEPT !.attempts = @ + 1,
           !.delivered = @ \/ delivered] ELSE row
         restartFinish == oldOwner /\ (~before.known \/ delivered \/ Mutant = "restart-undelivered")
         end == event # "none" \/ restartFinish
           \/ (atCeiling /\ Mutant # "no-ceiling")
           \/ (Mutant = "cancel-finish" /\ delivered)
         outcome == IF row.stop # "none" THEN StopOutcome(row.stop)
           ELSE IF event # "none" THEN EventOutcome(event, text)
           ELSE IF restartFinish THEN "interrupted" ELSE "deadline"
         \* Independent observers record whether the actual transition violates branch/cancel order.
         observed == [cancelRow EXCEPT
           !.stopOnEnd = @ \/ (before.stop = "none" /\ row.stop # "none" /\ end),
           !.missedCancel = @ \/ (before.known /\ row.stop # "none" /\ ~cancelNeeded)]
         result == IF before.run /\ end THEN Finished(observed, event, text, usage, FALSE, delivered,
           IF Mutant = "wrong-event" /\ event # "none" THEN "done" ELSE outcome)
           ELSE observed
     IN s' = [s EXCEPT !.rows[h] = result, !.todo = @ \ {h}]
TickDone ==
  /\ s.phase = "scan" /\ s.todo = {}
  /\ s' = [s EXCEPT !.phase = "idle", !.lastTick = s.now]
Clock ==
  /\ s.phase = "idle" /\ s.lastTick = s.now /\ s.now < Ceiling + 1
  /\ s' = [s EXCEPT !.now = @ + 1]
DoubleFinalize(h) ==
  /\ Mutant = "finalize-twice" /\ Len(s.rows[h].commits) = 1
  /\ s' = [s EXCEPT !.rows[h].commits = Append(@, Head(@))]

Next == TickStart \/ TickDone \/ Clock \/ Restart \/
  (\E h \in Helpers : Claim(h) \/ Create(h) \/ Record(h) \/ LoseId(h)
    \/ StartFailed(h) \/ RecordFailed(h) \/ Close(h) \/ KernelEnd(h) \/ DoubleFinalize(h)
    \/ (\E text \in Texts : Message(h, text))
    \/ (\E input \in 0..2, output \in 0..1 : Usage(h, input, output))
    \/ (\E event \in Terms \ {"none"} : KernelEvent(h, event))
    \/ (\E read \in {"ok", "error", "timeout", "junk", "404"},
           reply \in {"accepted", "no_active_turn", "error", "timeout", "other"} : TickRow(h, read, reply)))
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Clock) /\ WF_vars(TickStart) /\ WF_vars(TickDone)
  /\ \A h \in Helpers : WF_vars(\E read \in {"ok", "error", "timeout", "junk", "404"},
    reply \in {"accepted", "no_active_turn", "error", "timeout", "other"} : TickRow(h, read, reply))

TypeOK == /\ s.reminderBusy \in BOOLEAN
  /\ s.now \in 0..(Ceiling + 1) /\ s.owner \in {1, 2}
  /\ s.lastTick \in -1..s.now /\ s.phase \in {"idle", "scan"} /\ s.todo \subseteq Helpers
  /\ \A h \in Helpers : /\ s.rows[h].status \in {"pending", "finished", "closed"}
      /\ s.rows[h].event \in Terms /\ s.rows[h].stop \in Stops /\ s.rows[h].text \in Texts
      /\ s.rows[h].run \in BOOLEAN /\ Len(s.rows[h].usage) <= 2
RunningBounded == Cardinality(Running) <= RunningLimit
\* Claim-only projection isolates admission from per-row outcome state space.
CapacitySpec == Init /\ [][\E h \in Helpers : Claim(h)]_vars
CapacityAvailable == Cardinality(Running) < RunningLimit =>
  \A h \in Helpers : ~s.rows[h].claimed => ENABLED Claim(h)
CapacityNotFull == Cardinality(Running) < RunningLimit
OutcomeOnce == \A h \in Helpers : Len(s.rows[h].commits) <= 1
StopOnce == \A h \in Helpers : s.rows[h].stop = FirstStop(s.rows[h].stops)
StopOnlyWhileRunning == \A h \in Helpers : ~s.rows[h].stopOnEnd
StopCancelSent == \A h \in Helpers : ~s.rows[h].missedCancel
SnapshotFolded == \A h \in Helpers :
  /\ s.rows[h].foldText = s.rows[h].text
  /\ s.rows[h].foldUsage = s.rows[h].usage
EndAllowed(commit) == ~commit.claimed \/ commit.startFault \/ commit.event # "none"
  \/ (commit.oldOwner /\ (~commit.known \/ commit.delivered))
  \/ commit.at >= commit.fired + Ceiling
ExpectedOutcome(commit) ==
  IF FirstStop(commit.stops) # "none" THEN StopOutcome(FirstStop(commit.stops))
  ELSE IF commit.startFault THEN "failed"
  ELSE IF commit.event # "none" THEN EventOutcome(commit.event, commit.text)
  ELSE IF commit.oldOwner /\ (~commit.known \/ commit.delivered) THEN "interrupted"
  ELSE "deadline"
OutcomeJustified == \A h \in Helpers : \A i \in 1..Len(s.rows[h].commits) : EndAllowed(s.rows[h].commits[i])
OutcomeMatches == \A h \in Helpers :
  /\ \A i \in 1..Len(s.rows[h].commits) :
    s.rows[h].commits[i].outcome = ExpectedOutcome(s.rows[h].commits[i])
  /\ Len(s.rows[h].commits) > 0 => s.rows[h].outcome = ExpectedOutcome(Head(s.rows[h].commits))
RestartDelivered == \A h \in Helpers : \A i \in 1..Len(s.rows[h].commits) :
  LET c == s.rows[h].commits[i]
  IN c.oldOwner /\ c.known /\ ~c.startFault /\ c.event = "none" /\ c.at < c.fired + Ceiling => c.delivered
PartialKept == \A h \in Helpers :
  /\ \A i \in 1..Len(s.rows[h].commits) :
    s.rows[h].commits[i].saved = Usable(s.rows[h].commits[i].text)
  /\ Len(s.rows[h].commits) > 0 => s.rows[h].saved = Usable(Head(s.rows[h].commits).text)
WorkMeasured == \A h \in Helpers :
  /\ \A i \in 1..Len(s.rows[h].commits) :
    /\ s.rows[h].commits[i].steps = Len(s.rows[h].commits[i].usage)
    /\ s.rows[h].commits[i].work = MeasuredWork(s.rows[h].commits[i].usage, 0)
  /\ Len(s.rows[h].commits) > 0 =>
    /\ s.rows[h].steps = Len(Head(s.rows[h].commits).usage)
    /\ s.rows[h].work = MeasuredWork(Head(s.rows[h].commits).usage, 0)
RowConsistent == \A h \in Helpers :
  /\ (s.rows[h].outcome = "none") = (Len(s.rows[h].commits) = 0)
  /\ s.rows[h].outcome # "none" => ~s.rows[h].run
  /\ s.rows[h].status = "closed" => s.rows[h].outcome # "none" \/ s.rows[h].run
BoundedEnd == \A h \in Helpers : s.rows[h].claimed /\ s.lastTick >= s.rows[h].fired + Ceiling
  => s.rows[h].outcome # "none"
NoSilentEnd == \A h \in Helpers : s.rows[h].run ~> (s.rows[h].outcome # "none")
\* Accepted consequence: durable work may outlive the table claim after restart/ceiling/lost-id.
NoDetachedWork == \A h \in Helpers : ~s.rows[h].run => ~s.rows[h].kernel
=============================================================================
