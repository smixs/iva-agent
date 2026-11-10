---------------------------- MODULE ChatRecord ----------------------------
\* The chat record: one file data/run-status.d/<chat>.json, written by two processes.
\* The agent process (Channel, draft, hooks), the Bridge and a Reminder turn all write it
\* under one lock with compare-and-set; a restart forgets every process memory and
\* keeps the file. 0 denotes an absent field.
\*
\* Record fields -> agent/lib/run-status.ts (fieldChecks, rowRules). Marks kept here:
\* stale (updatedAt older than RUN_STALE_MS, or 0 after recovery), reset (resetAt),
\* retry (restartRetryData), retire (retireAfterTurn), pending (pendingInput*).
\*
\* Accept/Abandon   -> telegram-turn-start.ts publishTelegramEarlyStatus,
\*                     abandonTelegramEarlyStatus.
\* TurnStart        -> publishTelegramTurnStarted. Beat -> markTelegramTurnAlive.
\* TurnEnd, Release -> the terminal handler of one turn: it starts when the turn
\*                     ends and writes later (telegram-draft.ts finishTelegramStatus
\*                     waits for the draft first). ReleaseIntoCompaction is its
\*                     keepBusy branch.
\* CompactClaim/End -> channels/telegram.ts claimChatForCompaction,
\*                     releaseCompactionClaim and the session.waiting release.
\* SessionFails     -> session.failed: finishTelegramStatus without a turn.
\* MarkRetire, AskOwner, OwnerAnswers -> run-status.ts
\*                     markTelegramSessionForRetirement,
\*                     updateTelegramPendingInputRequests (hooks/trace.ts).
\* RemClaim/Release -> scripts/reminders/fire.ts claimChat, releaseChat and
\*                     reminder-tick.ts releaseReminderStatus (same CAS).
\* Reap, Retire, Reset, DeliveryFailed -> scripts/poller/queue.ts reapStaleRuns,
\*                     retireSettledSessions, completeScopedResetState,
\*                     clearFailedDirectIngress.
\* Restart          -> the agent process dies; scripts/lib/wf-store.ts
\*                     rewriteRunStatusesForUpdate may mark the record or fail.
\*
\* Outside the model: the queued sign (queued*), the Stop mark (wasCancelled), the
\* turn question, latency stamps, the Bridge queue and its in-flight phases, the
\* two awaits inside one session retirement, wall-clock values and the file lock
\* (specs/FileLock.tla). eve handles events of one session in order: a session-level
\* release never overlaps a turn of the same session.
EXTENDS Naturals, FiniteSets
CONSTANTS Mutant, MaxTurns, MaxAccepts, MaxRestarts, MaxBridgeCrashes
VARIABLES rec, acc, core, closing, rem, bridgeUp,
          started, accepts, restarts, crashes, foreign
vars == <<rec, acc, core, closing, rem, bridgeUp,
          started, accepts, restarts, crashes, foreign>>

Sessions == 1..2      \* dialogue sessions of the chat
ReminderSession == 3  \* the session of one Reminder turn
Empty == [status |-> "idle", ingress |-> 0, session |-> 0, turn |-> 0,
  compacting |-> FALSE, stale |-> FALSE, reset |-> FALSE, retry |-> FALSE,
  retire |-> FALSE, pending |-> FALSE]
CoreIdle == [phase |-> "idle", session |-> 0, turn |-> 0, due |-> FALSE]

Live(r) == r.status = "running" /\ ~r.stale
\* chatTakeOverPatch: a claim names its owner and drops what the previous one left.
Claimed(r, ingress, session, compacting) == [r EXCEPT !.status = "running",
  !.ingress = ingress, !.session = session, !.turn = 0, !.compacting = compacting,
  !.stale = FALSE, !.reset = FALSE, !.retry = FALSE]
\* The terminal patch: every turn field goes with the status.
Freed(r) == [r EXCEPT !.status = "idle", !.ingress = 0, !.session = 0, !.turn = 0,
  !.compacting = FALSE, !.stale = FALSE]
Tombstone(r) == [Freed(r) EXCEPT !.reset = TRUE, !.retry = FALSE]

Init ==
  /\ rec = Empty /\ acc = 0 /\ core = CoreIdle /\ closing = {} /\ rem = FALSE
  /\ bridgeUp = TRUE /\ started = 0 /\ accepts = 0 /\ restarts = 0 /\ crashes = 0
  /\ foreign = FALSE

\* ---- agent process -------------------------------------------------------
Accept ==
  /\ acc = 0 /\ accepts < MaxAccepts /\ ~Live(rec)
  /\ accepts' = accepts + 1 /\ acc' = accepts'
  /\ rec' = Claimed(rec, accepts', 0, FALSE)
  /\ UNCHANGED <<core, closing, rem, bridgeUp, started, restarts, crashes, foreign>>
Abandon ==
  /\ acc # 0 /\ acc' = 0
  /\ rec' = IF rec.status = "running" /\ rec.ingress = acc /\ rec.session = 0
            THEN Freed(rec) ELSE rec
  /\ UNCHANGED <<core, closing, rem, bridgeUp, started, accepts, restarts, crashes,
                 foreign>>
\* A reset tombstone refuses the publication: that turn runs without a record.
TurnStart(s) ==
  /\ core.phase = "idle" /\ started < MaxTurns
  /\ started' = started + 1
  /\ core' = [phase |-> "turn", session |-> s, turn |-> started', due |-> FALSE]
  /\ rec' = IF rec.reset THEN rec
            ELSE [rec EXCEPT !.status = "running", !.session = s,
                             !.turn = started', !.compacting = FALSE, !.stale = FALSE]
  /\ acc' = IF ~rec.reset /\ rec.status = "running" /\ rec.session = 0 /\ rec.ingress = acc
            THEN 0 ELSE acc
  /\ UNCHANGED <<closing, rem, bridgeUp, accepts, restarts, crashes, foreign>>
Beat ==
  /\ core.phase = "turn" /\ rec.status = "running" /\ rec.session = core.session
  /\ rec.stale /\ rec' = [rec EXCEPT !.stale = FALSE]
  /\ UNCHANGED <<acc, core, closing, rem, bridgeUp, started, accepts, restarts,
                 crashes, foreign>>
TurnEnd(due) ==
  /\ core.phase = "turn"
  /\ closing' = closing \cup {[session |-> core.session, turn |-> core.turn]}
  /\ core' = [core EXCEPT !.phase = "idle", !.turn = 0, !.due = due]
  /\ UNCHANGED <<rec, acc, rem, bridgeUp, started, accepts, restarts, crashes, foreign>>
Owns(c) == rec.status = "running" /\ rec.session = c.session /\ rec.turn = c.turn
Hit(c) == IF Mutant = "release-by-session"
          THEN rec.status = "running" /\ rec.session = c.session ELSE Owns(c)
Release(c) ==
  /\ c \in closing /\ closing' = closing \ {c}
  /\ rec' = IF Hit(c) THEN Freed(rec) ELSE rec
  /\ foreign' = (foreign \/ (Hit(c) /\ ~Owns(c)))
  /\ UNCHANGED <<acc, core, rem, bridgeUp, started, accepts, restarts, crashes>>
ReleaseIntoCompaction(c) ==
  /\ c \in closing /\ Owns(c) /\ closing' = closing \ {c}
  /\ core.phase = "idle" /\ core.session = c.session /\ core.due
  /\ rec' = [Freed(rec) EXCEPT !.status = "running", !.session = c.session,
                               !.compacting = TRUE]
  /\ core' = [core EXCEPT !.phase = "compacting", !.due = FALSE]
  /\ UNCHANGED <<acc, rem, bridgeUp, started, accepts, restarts, crashes, foreign>>
CompactClaim ==
  /\ core.phase = "idle" /\ core.session # 0 /\ core.due
  /\ \A c \in closing : c.session # core.session
  /\ ~Live(rec) /\ ~rec.reset
  /\ rec' = Claimed(rec, 0, core.session, TRUE)
  /\ core' = [core EXCEPT !.phase = "compacting", !.due = FALSE]
  /\ UNCHANGED <<acc, closing, rem, bridgeUp, started, accepts, restarts, crashes,
                 foreign>>
CompactEnd ==
  /\ core.phase = "compacting" /\ core' = [core EXCEPT !.phase = "idle"]
  /\ rec' = IF rec.status = "running" /\ rec.session = core.session /\ rec.compacting
            THEN IF Mutant = "leave-compacting"
                 THEN [Freed(rec) EXCEPT !.compacting = TRUE] ELSE Freed(rec)
            ELSE rec
  /\ UNCHANGED <<acc, closing, rem, bridgeUp, started, accepts, restarts, crashes,
                 foreign>>
SessionFails ==
  /\ core.session # 0 /\ core' = CoreIdle
  /\ \A c \in closing : c.session # core.session
  /\ rec' = IF rec.status = "running" /\ rec.session = core.session
            THEN Freed(rec) ELSE rec
  /\ UNCHANGED <<acc, closing, rem, bridgeUp, started, accepts, restarts, crashes,
                 foreign>>
MarkRetire ==
  /\ core.phase = "turn" /\ rec.status = "running" /\ ~rec.retire
  /\ rec.session = core.session /\ rec.turn = core.turn
  /\ rec' = [rec EXCEPT !.retire = TRUE, !.stale = FALSE]
  /\ UNCHANGED <<acc, core, closing, rem, bridgeUp, started, accepts, restarts,
                 crashes, foreign>>
AskOwner ==
  /\ core.phase = "turn" /\ rec.session = core.session /\ ~rec.pending
  /\ rec' = [rec EXCEPT !.pending = TRUE, !.stale = FALSE]
  /\ UNCHANGED <<acc, core, closing, rem, bridgeUp, started, accepts, restarts,
                 crashes, foreign>>
OwnerAnswers ==
  /\ rec.pending /\ rec' = [rec EXCEPT !.pending = FALSE, !.stale = FALSE]
  /\ UNCHANGED <<acc, core, closing, rem, bridgeUp, started, accepts, restarts,
                 crashes, foreign>>
\* The process dies: memory is gone, the file stays. Recovery before the start marks
\* an interrupted record for the Bridge and frees an interrupted compaction; it may fail.
Recovered(r) ==
  IF r.status # "running" THEN r
  ELSE IF r.compacting THEN [Empty EXCEPT !.reset = TRUE]
  ELSE [r EXCEPT !.stale = TRUE]
Restart ==
  /\ restarts < MaxRestarts /\ restarts' = restarts + 1
  /\ acc' = 0 /\ core' = CoreIdle /\ closing' = {}
  /\ rec' \in {rec, Recovered(rec)}
  /\ UNCHANGED <<rem, bridgeUp, started, accepts, crashes, foreign>>

\* ---- Reminder turn: its own process, its own session ------------------------
RemClaim ==
  /\ ~rem /\ ~Live(rec) /\ rem' = TRUE
  /\ rec' = Claimed(rec, 0, ReminderSession, FALSE)
  /\ UNCHANGED <<acc, core, closing, bridgeUp, started, accepts, restarts, crashes,
                 foreign>>
RemRelease ==
  /\ rem /\ rem' = FALSE
  /\ rec' = IF rec.session = ReminderSession THEN Freed(rec) ELSE rec
  /\ UNCHANGED <<acc, core, closing, bridgeUp, started, accepts, restarts, crashes,
                 foreign>>

\* ---- Bridge ----------------------------------------------------------------
\* 30 minutes without a write of a living owner.
Expire ==
  /\ Live(rec) /\ rec' = [rec EXCEPT !.stale = TRUE]
  /\ UNCHANGED <<acc, core, closing, rem, bridgeUp, started, accepts, restarts,
                 crashes, foreign>>
\* The reaper also releases the session of the record.
Reap ==
  /\ bridgeUp /\ Mutant # "no-reaper" /\ rec.status = "running"
  /\ rec.stale \/ Mutant = "reap-live"
  /\ rec' = [Tombstone(rec) EXCEPT !.retry = TRUE]
  /\ core' = IF rec.session # 0 /\ core.session = rec.session THEN CoreIdle ELSE core
  /\ foreign' = (foreign \/ ~rec.stale)
  /\ UNCHANGED <<acc, closing, rem, bridgeUp, started, accepts, restarts, crashes>>
Retire ==
  /\ bridgeUp /\ rec.status = "idle" /\ rec.retire
  /\ rec' = [Tombstone(rec) EXCEPT !.retire = FALSE]
  /\ core' = IF core.phase = "idle" THEN CoreIdle ELSE core
  /\ UNCHANGED <<acc, closing, rem, bridgeUp, started, accepts, restarts, crashes,
                 foreign>>
\* /new: the person's word ends the session and frees the chat.
Reset ==
  /\ bridgeUp /\ rec' = Tombstone(rec) /\ core' = CoreIdle
  /\ UNCHANGED <<acc, closing, rem, bridgeUp, started, accepts, restarts, crashes,
                 foreign>>
\* A direct delivery that the agent did not accept clears its own early record.
DeliveryFailed ==
  /\ bridgeUp /\ rec.status = "running" /\ rec.ingress # 0 /\ rec.session = 0
  /\ rec' = Tombstone(rec)
  /\ UNCHANGED <<acc, core, closing, rem, bridgeUp, started, accepts, restarts,
                 crashes, foreign>>
BridgeCrash ==
  /\ bridgeUp /\ crashes < MaxBridgeCrashes
  /\ bridgeUp' = FALSE /\ crashes' = crashes + 1
  /\ UNCHANGED <<rec, acc, core, closing, rem, started, accepts, restarts, foreign>>
BridgeBoot ==
  /\ ~bridgeUp /\ bridgeUp' = TRUE
  /\ UNCHANGED <<rec, acc, core, closing, rem, started, accepts, restarts, crashes,
                 foreign>>

TurnStarts == \E s \in Sessions : TurnStart(s)
TurnEnds == \E due \in BOOLEAN : TurnEnd(due)
Releases == \E c \in closing : Release(c)
ReleasesIntoCompaction == \E c \in closing : ReleaseIntoCompaction(c)
Next == Accept \/ Abandon \/ TurnStarts \/ Beat \/ TurnEnds
  \/ Releases \/ ReleasesIntoCompaction \/ CompactClaim \/ CompactEnd \/ SessionFails \/ MarkRetire \/ AskOwner
  \/ OwnerAnswers \/ Restart \/ RemClaim \/ RemRelease \/ Expire \/ Reap \/ Retire
  \/ Reset \/ DeliveryFailed \/ BridgeCrash \/ BridgeBoot
\* Every started step ends; time passes; the Bridge comes back.
Fairness ==
  /\ WF_vars(Abandon) /\ WF_vars(TurnEnds) /\ WF_vars(Releases) /\ WF_vars(CompactEnd)
  /\ WF_vars(RemRelease) /\ WF_vars(Expire) /\ WF_vars(Reap) /\ WF_vars(BridgeBoot)
Spec == Init /\ [][Next]_vars /\ Fairness

\* ---- the states of a chat ----------------------------------------------------
NoTurnFields == rec.ingress = 0 /\ rec.session = 0 /\ rec.turn = 0 /\ ~rec.compacting
Idle == rec.status = "idle" /\ NoTurnFields
Is == [
  free |-> Idle /\ ~rec.retire /\ ~rec.retry /\ ~rec.pending,
  awaitingOwner |-> Idle /\ ~rec.retire /\ ~rec.retry /\ rec.pending,
  retryOffered |-> Idle /\ ~rec.retire /\ rec.retry,
  retiring |-> Idle /\ rec.retire,
  accepted |-> Live(rec) /\ rec.session = 0 /\ rec.ingress # 0 /\ rec.turn = 0
               /\ ~rec.compacting,
  turn |-> Live(rec) /\ rec.session # 0 /\ ~rec.compacting,
  compacting |-> Live(rec) /\ rec.session # 0 /\ rec.compacting /\ rec.turn = 0,
  stale |-> rec.status = "running" /\ rec.stale]

TypeOK ==
  /\ rec.status \in {"idle", "running"} /\ rec.ingress \in 0..MaxAccepts
  /\ rec.session \in 0..ReminderSession /\ rec.turn \in 0..MaxTurns
  /\ \A f \in {"compacting", "stale", "reset", "retry", "retire", "pending"} :
       rec[f] \in BOOLEAN
  /\ acc \in 0..MaxAccepts /\ core.phase \in {"idle", "turn", "compacting"}
  /\ rem \in BOOLEAN /\ bridgeUp \in BOOLEAN /\ foreign \in BOOLEAN
\* 1. A chat is in exactly one named state at every moment.
OneState == Cardinality({name \in DOMAIN Is : Is[name]}) = 1
\* 2. Turn fields are filled only while a turn or a compaction holds the chat.
TurnFieldsOnlyWhenBusy ==
  /\ rec.status = "idle" => NoTurnFields /\ ~rec.stale
  /\ rec.compacting => rec.session # 0 /\ rec.turn = 0
  /\ rec.turn # 0 => rec.session # 0
\* 3. Only the owner frees a record, or the reaper after the deadline.
ReleasedByOwnerOrReaper == ~foreign
\* 4. After any restart the chat becomes free in finite time.
FreeAfterRestart == (restarts > 0) ~> (rec.status = "idle")
=============================================================================
