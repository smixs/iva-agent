----------------------------- MODULE DraftStop -----------------------------
\* Draft/stop contract, frozen v2, 2026-10-14. One private chat without a topic.
\* 0 denotes null. Turn numbers are unique; consecutive turns may share a session.
\* Draft numbers denote fresh random ids, including a new id after lazy recovery.
\* Random-id collisions, HTTP bodies, text redaction and wall-clock timing are
\* checked at the implementation boundary. This model checks event ordering.
\*
\* Start: publishTelegramTurnStarted + one CAS of sessionId/turnId/draft_id.
\* MessageCompleted: final message.completed, separate from TurnEnded.
\* Close: stop timers; RequestDone may still settle an earlier HTTP request.
\* SendFinal: closeTelegramDraftChat also drains closed streams of the same chat.
\* StopRead/StopCancel: native update, checked snapshot, pair-scoped cancel.
\* OtherProcess: reset/takeover writes the chat record without a local signal.
\* Tick: one 4.5 s typing tick reads that record and closes stale streams.
\* Restart/LazyRecover: process memory is gone; the core may resume without
\* turn.started. The first event installs a new draft id by pair-scoped CAS.
\* Input-requested closes and forgets the stream. Continuing after the answer
\* uses the same lazy recovery, after the closed stream has drained.
\* A restart also forgets the old process's 429 pause, as telegram-draft.ts does.
\* Terminal record writes retain a different owner.
\* Reject counters and sticky violation flags monitor the three implementation seams.
\*
\* Initial orphan case is adversarial persisted input: a record of the removed
\* between-turns compaction had turnId=null and a leftover positive draft id.
\* Correct writers clear both; the stop handler must still reject this snapshot.
\* This case makes the null guard independently testable rather than relying on
\* well-formed storage.
EXTENDS Naturals, FiniteSets
CONSTANTS Mutant, MaxTurns, MaxRestarts
VARIABLE s
vars == <<s>>
Turns == 1..MaxTurns
Drafts == 1..(MaxTurns + MaxRestarts + 1)
EmptyRecord == [status |-> "idle", session |-> 0, turn |-> 0, draft |-> 0]
EmptyStream == [session |-> 0, turn |-> 0, closed |-> TRUE, inFlight |-> FALSE,
  pause |-> FALSE, disabled |-> FALSE, success |-> FALSE, failures |-> 0,
  rejectsSinceSuccess |-> 0, pending |-> FALSE]
EmptyStop == [ready |-> FALSE, eventDraft |-> 0, session |-> 0, turn |-> 0, draft |-> 0]
Init == \E orphan \in BOOLEAN :
  s = [record |-> IF orphan THEN
         [status |-> "running", session |-> 1, turn |-> 0, draft |-> 1]
         ELSE EmptyRecord,
    core |-> "idle", session |-> 1, turn |-> 0,
    started |-> 0, issued |-> IF orphan THEN 1 ELSE 0, restarts |-> 0,
    recovering |-> FALSE,
    streams |-> [d \in Drafts |-> EmptyStream], stop |-> EmptyStop,
    finals |-> [t \in Turns |-> "none"], cancels |-> [t \in Turns |-> 0],
    wrongDraft |-> FALSE, emptyTurn |-> FALSE, afterClose |-> FALSE,
    afterFinal |-> FALSE, staleAfterTick |-> FALSE,
    foreignRecordLost |-> FALSE, restartPauseKept |-> FALSE]

Pair(stream, session, turn) == stream.session = session /\ stream.turn = turn
\* Compare the draft id as well: two incarnations can have the same session/turn.
Matches(d) == s.record.status = "running" /\ s.record.session = s.streams[d].session
  /\ s.record.turn = s.streams[d].turn /\ s.record.draft = d
Close(stream) == [stream EXCEPT !.closed = TRUE, !.pending = FALSE,
  !.success = FALSE, !.failures = 0, !.rejectsSinceSuccess = 0, !.disabled = FALSE]
ClosePair(streams, session, turn) == [d \in Drafts |->
  IF Pair(streams[d], session, turn) THEN Close(streams[d]) ELSE streams[d]]
NewStream(session, turn) == [EmptyStream EXCEPT
  !.session = session, !.turn = turn, !.closed = FALSE, !.pending = TRUE]

Start(session, publish) ==
  /\ s.core = "idle" /\ s.started < MaxTurns
  /\ s.issued < Cardinality(Drafts)
  /\ LET t == s.started + 1
         d == IF publish THEN s.issued + 1 ELSE 0
     IN s' = [s EXCEPT !.core = "running", !.session = session, !.turn = t,
       !.started = t, !.issued = IF publish THEN d ELSE @, !.recovering = FALSE,
       !.record = IF publish THEN
         [status |-> "running", session |-> session, turn |-> t, draft |-> d]
         ELSE @,
       !.streams = IF publish THEN [@ EXCEPT ![d] = NewStream(session, t)] ELSE @]

\* Timer refresh and new text both request the latest frame, never a backlog.
Refresh(d) ==
  /\ ~s.streams[d].closed
  /\ s' = [s EXCEPT !.streams[d].pending = TRUE]
SendFrame(d) ==
  /\ s.streams[d].turn # 0
  /\ ~s.streams[d].disabled /\ ~s.streams[d].inFlight /\ ~s.streams[d].pause
  /\ ((~s.streams[d].closed /\ s.streams[d].pending)
     \/ (Mutant = "frame-after-final" /\ s.finals[s.streams[d].turn] = "sent")
     \/ (Mutant = "older-frame-after-final" /\
         \E t \in Turns : s.streams[d].turn < t /\ s.finals[t] = "sent"))
  /\ s' = [s EXCEPT !.streams[d].inFlight = TRUE, !.streams[d].pending = FALSE,
       !.afterClose = @ \/ s.streams[d].closed,
       !.afterFinal = @ \/ (s.finals[s.streams[d].turn] = "sent")]
RequestDone(d, reply) ==
  /\ s.streams[d].inFlight
  /\ LET stream == s.streams[d]
         errors == IF reply = "ok" THEN 0
                   ELSE IF reply = "reject" THEN stream.failures + 1
                   ELSE IF Mutant = "reset-on-non-success" THEN 0 ELSE stream.failures
         done == [stream EXCEPT !.inFlight = FALSE,
           !.success = @ \/ reply = "ok", !.pause = @ \/ reply = "429",
           !.failures = errors,
           \* History monitor: only an ok reply starts a new rejection series.
           !.rejectsSinceSuccess = IF reply = "ok" THEN 0
             ELSE IF reply = "reject" THEN @ + 1 ELSE @,
           !.disabled = @ \/ (reply = "reject" /\ (~stream.success \/ errors >= 3)),
           !.pending = IF stream.closed THEN FALSE ELSE @ \/ reply = "429"]
     IN s' = [s EXCEPT !.streams[d] = IF stream.closed THEN Close(done) ELSE done,
       !.afterFinal = @ \/ (reply = "ok" /\ s.finals[stream.turn] = "sent")]
PauseEnded(d) ==
  /\ s.streams[d].pause
  /\ s' = [s EXCEPT !.streams[d].pause = FALSE]

MessageCompleted ==
  /\ s.core = "running" /\ s.finals[s.turn] = "none"
  /\ s' = [s EXCEPT !.finals[s.turn] = "pending",
       !.streams = ClosePair(@, s.session, s.turn)]
Drained(t) == \A d \in Drafts : s.streams[d].turn = t =>
  s.streams[d].closed /\ ~s.streams[d].inFlight /\ ~s.streams[d].pause
\* closeTelegramDraftChat keeps unrelated open turns intact and waits for closed ones.
ClosedStreamsDrained == \A d \in Drafts : s.streams[d].closed =>
  ~s.streams[d].inFlight /\ ~s.streams[d].pause
SendFinal(t) ==
  /\ s.finals[t] = "pending" /\ Drained(t) /\ ClosedStreamsDrained
  /\ s' = [s EXCEPT !.finals[t] = "sent"]
\* All terminal/parking/input-requested safety closures use the same Close.
TurnEnded ==
  /\ s.core \in {"running", "cancelled"}
  /\ LET owns == s.record.session = s.session /\ s.record.turn = s.turn
         record == IF owns \/ Mutant = "turn-clear-foreign" THEN EmptyRecord ELSE s.record
     IN s' = [s EXCEPT !.core = "idle", !.record = record,
       !.streams = ClosePair(@, s.session, s.turn), !.recovering = FALSE,
       !.foreignRecordLost = @ \/ (~owns /\ record # s.record)]
SafetyClose ==
  /\ s.core = "running"
  /\ s' = [s EXCEPT !.streams = ClosePair(@, s.session, s.turn)]
\* Forget only on the question closure; the next continued event creates a stream.
InputRequested ==
  /\ s.core = "running" /\ s.finals[s.turn] = "none"
  /\ s' = [s EXCEPT !.streams = ClosePair(@, s.session, s.turn),
       !.recovering = TRUE]

OtherProcess(kind) ==
  /\ s.record.status = "running"
  /\ s' = [s EXCEPT !.record = IF kind = "reset" THEN EmptyRecord ELSE
       [status |-> "running", session |-> 2, turn |-> 0, draft |-> 0]]
Tick(d) ==
  /\ ~s.streams[d].closed
  /\ LET stale == ~Matches(d)
         stream == IF stale /\ Mutant # "no-self-check" THEN Close(s.streams[d])
                   ELSE s.streams[d]
     IN s' = [s EXCEPT !.streams[d] = stream,
       !.staleAfterTick = @ \/ (stale /\ ~stream.closed)]

StopRead(d, authorized) ==
  /\ ~s.stop.ready
  /\ s' = [s EXCEPT !.stop = IF authorized THEN
       [ready |-> TRUE, eventDraft |-> d, session |-> s.record.session,
        turn |-> s.record.turn, draft |-> s.record.draft] ELSE EmptyStop]
StopCancel(reply) ==
  /\ s.stop.ready
  /\ LET snap == s.stop
         request == (snap.eventDraft = snap.draft \/ Mutant = "stop-without-draft")
           /\ (snap.turn # 0 \/ Mutant = "stop-with-null-turn")
         hit == request /\ reply = "ok" /\ s.core = "running"
           /\ snap.session = s.session /\ snap.turn = s.turn
     IN s' = [s EXCEPT !.stop = EmptyStop,
       !.core = IF hit THEN "cancelled" ELSE @,
       !.cancels = IF hit THEN [@ EXCEPT ![s.turn] = @ + 1] ELSE @,
       !.wrongDraft = @ \/ (request /\ snap.eventDraft # snap.draft),
       !.emptyTurn = @ \/ (request /\ snap.turn = 0)]

Restart ==
  /\ s.restarts < MaxRestarts
  /\ LET streams == [d \in Drafts |-> [Close(s.streams[d]) EXCEPT
           !.inFlight = FALSE,
           !.pause = IF Mutant = "restart-keep-pause" THEN @ ELSE FALSE]]
     IN s' = [s EXCEPT !.restarts = @ + 1, !.recovering = s.core = "running",
       !.stop = EmptyStop,
       !.streams = streams,
       !.restartPauseKept = @ \/ (\E d \in Drafts : streams[d].pause)]
LazyRecover ==
  /\ s.recovering /\ s.core = "running" /\ s.finals[s.turn] = "none"
  /\ Drained(s.turn)
  /\ s.record.status = "running" /\ s.record.session = s.session /\ s.record.turn = s.turn
  /\ s.issued < Cardinality(Drafts)
  /\ LET d == s.issued + 1 IN s' = [s EXCEPT !.recovering = FALSE,
       !.issued = d, !.record.draft = d, !.streams[d] = NewStream(s.session, s.turn)]

Next == MessageCompleted \/ TurnEnded \/ SafetyClose
  \/ Restart \/ LazyRecover \/ InputRequested
  \/ (\E session \in 1..2, publish \in BOOLEAN : Start(session, publish))
  \/ (\E kind \in {"reset", "takeover"} : OtherProcess(kind))
  \/ (\E reply \in {"ok", "network"} : StopCancel(reply))
  \/ (\E d \in Drafts : Refresh(d) \/ SendFrame(d) \/ PauseEnded(d) \/ Tick(d)
      \/ (\E reply \in {"ok", "429", "reject", "timeout"} : RequestDone(d, reply))
      \/ (\E authorized \in BOOLEAN : StopRead(d, authorized)))
  \/ (\E t \in Turns : SendFinal(t))
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ s.core \in {"idle", "running", "cancelled"}
  /\ s.turn \in 0..MaxTurns /\ s.started \in 0..MaxTurns
  /\ s.issued \in 0..Cardinality(Drafts) /\ s.restarts \in 0..MaxRestarts
  /\ s.record.status \in {"idle", "running"} /\ s.record.session \in 0..2
  /\ s.record.turn \in 0..MaxTurns /\ s.record.draft \in 0..Cardinality(Drafts)
  /\ s.foreignRecordLost \in BOOLEAN /\ s.restartPauseKept \in BOOLEAN
  /\ \A d \in Drafts : /\ s.streams[d].turn \in 0..MaxTurns
      /\ s.streams[d].session \in 0..2 /\ s.streams[d].failures \in 0..3
      /\ s.streams[d].rejectsSinceSuccess \in 0..3
  /\ \A t \in Turns : s.finals[t] \in {"none", "pending", "sent"}
StopOwnDraft == ~s.wrongDraft
StopHasTurn == ~s.emptyTurn
StopOnce == \A t \in Turns : s.cancels[t] <= 1
FramesOnlyWhileOpen == ~s.afterClose
NoFrameAfterFinal == ~s.afterFinal
FinalAfterClose == \A t \in Turns : s.finals[t] = "sent" => Drained(t)
\* All streams belong to this chat, including earlier turns in another session.
NoOlderInFlightAfterFinal == \A t \in Turns : s.finals[t] = "sent" =>
  \A d \in Drafts : s.streams[d].turn < t => ~s.streams[d].inFlight
SelfCheckCloses == ~s.staleAfterTick
\* These monitors state the policy independently of each mutated state update.
FailurePolicy == \A d \in Drafts :
  /\ s.streams[d].failures = s.streams[d].rejectsSinceSuccess
  /\ (s.streams[d].rejectsSinceSuccess = 3 => s.streams[d].disabled)
ForeignRecordPreserved == ~s.foreignRecordLost
RestartForgetsPause == ~s.restartPauseKept
=============================================================================
