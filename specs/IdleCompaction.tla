---- MODULE IdleCompaction ----
\* Idle compaction between turns (spec .scratch/work/idle-compaction/spec.md v4, sections 3, 4,
\* 5, 7; ADR-0021). Written AFTER the code: it checks the code, not a design. While the history
\* is retold the chat is BUSY with a status record running + compacting, as during a turn. One
\* eve session in one Telegram chat; the bridge (routing under queue or steer, the disk queue,
\* the drain, the reaper), the chat status record data/run-status.d/<chat>.json, the process
\* memory of agent/lib/idle-compaction.ts, eve's session (input buffer, control queue, current
\* action), the compact POST that the session.waiting handler awaits, a process restart with
\* the ExecStartPre recovery.
\*
\* Model action -> file:function (working tree of round 2 with R3 and R4)
\*   Send         a person writes; a reply to a bot message is its own kind (Bypass)
\*   Route        scripts/poller/routing.ts:212 routeMessageUpdate: a reply to the bot skips
\*                the busy check unless the chat is compacting (:292, isCompacting
\*                agent/lib/run-status.ts:283); mustQueue (:295) when the policy is queue and
\*                isRunning (run-status.ts:274, one RUN_STALE_MS for turn and compaction) or the
\*                disk queue / a drain is busy -> enqueue + notice (scripts/poller/queue.ts:1092
\*                queuedNoticeText); else a direct delivery
\*   Drain        routing.ts:335 drainReadyQueueHeads: the queue head while not running
\*   Arrive       onAccepted (agent/channels/telegram.ts:491) -> publishTelegramEarlyStatus ->
\*                takeOverTelegramChat (agent/lib/telegram-turn-start.ts:192): a fresh running
\*                record is left alone, any other is taken with chatTakeOverPatch (:100,
\*                compacting: null, resetAt: null); then eve's inbound: queue -> input buffer
\*                (Ф4); steer during a compaction -> abort (Ф5), during a turn -> joins it
\*   EveStartComp eve parked takes control commands before buffered messages (Ф11); a
\*                compaction first emits compaction.requested: state compReq until the hook ran
\*   BeginHook    compaction.requested hook (agent/hooks/usage.ts:101) -> beginIdleCompaction
\*                (agent/lib/idle-compaction.ts:86): outside a turn and with an open ask
\*                (reclaim), clear reclaim and claim the chat again with the same takeover (a
\*                live record or resetAt is left alone); BeginAnyIdle (R5, not code): claim for
\*                any compaction outside a turn, memory or not
\*   EveStartTurn turn.started (telegram.ts:296): openIdleCompactionTurn (idle-compaction.ts:49)
\*                + publishTelegramTurnStarted (turn-start.ts:337): adopt an ingress record
\*                (:414), skip on resetAt (:369), else a generation CAS writing compacting: null
\*                (:379)
\*   Step         step.completed hook (usage.ts:87) -> recordStepInput (idle-compaction.ts:72),
\*                first KNOWN input (first ??= tokens)
\*   InTurnComp   eve's own safety compaction inside a turn: compaction.requested and
\*                compaction.completed with the turn open -> both hooks do nothing (:86, :105)
\*   TurnEnd      turn.completed (telegram.ts:318): finishTelegramStatus (CAS by sessionId,
\*                agent/lib/telegram-status-message.ts:146,160) finally closeIdleCompactionTurn
\*                (idle-compaction.ts:124)
\*   TurnFail     turn.failed (telegram.ts:446): dropIdleCompactionTurn (:146, clears open, due,
\*                asked, compacted), finish
\*   PostTurnSkip after a turn with something queued eve may start the next action without
\*                session.waiting (Ф9, both outcomes)
\*   WaitRelease  session.waiting (telegram.ts:348): endIdleCompaction (:113) if the record is
\*                this session's compacting one (telegram.ts:356), then finishTelegramStatus
\*   WaitClaim    finally await startIdleCompaction (telegram.ts:364, idle-compaction.ts:168):
\*                due cleared; no ask while an earlier one is open (reclaim younger than
\*                ASK_FORGOTTEN_MS, :187); claimChatForCompaction (telegram.ts:215: no bearer or
\*                resetAt -> no; then takeOverTelegramChat, which takes a stale record too);
\*                asked = true and reclaim set BEFORE the request; POST; the handler waits for
\*                the answer (AwaitPost)
\*   PostAnswer   agent/lib/eve-compact.ts:27 requestSessionCompact: 202 accepted (control
\*                queued, Ф3); 200 / 4xx refusal -> asked = false, reclaim cleared,
\*                releaseCompactionClaim (telegram.ts:239, CAS {sessionId, compacting: true});
\*                timeout, cut or 5xx -> unknown: the control may or may not be queued, the chat
\*                stays busy, asked and reclaim stay; LatePost: the request outlives the
\*                client's 5 s and is accepted later (LateLand)
\*   CompDone / CompFail / StopComp / steer Arrive
\*                compaction.completed -> completeIdleCompaction (:105, also clears reclaim);
\*                or the summary failed; or /stop or a steer message aborted it. Ф6, Ф13: a
\*                parking after success and failure; after an abort: parking, turn.cancelled,
\*                parking
\*   CancelH      turn.cancelled (telegram.ts:327): finish completed if the record is compacting,
\*                else cancelled (wasCancelled), finally dropIdleCompactionTurn
\*   Forget       ASK_FORGOTTEN_MS: an open ask eve never announced is dropped after 30 min
\*   Expire       a running record goes stale after RUN_STALE_MS when nobody owns it any more;
\*                with LongCompaction also a compacting record (no heartbeat) while eve still
\*                compacts
\*   Reap         queue.ts:973 reapStaleRuns: idle + resetAt, reset of the session, notice
\*                «Предыдущий ход оборвался» unless compacting (:952 notifyInterruptedTurn)
\*   Restart      process killed: module memory and the POST are gone; ExecStartPre
\*                recoverInterruptedSessionState (scripts/lib/wf-store.ts:190): a running record
\*                not yet marked (:89) -> quarantine of the workflow store (session, input,
\*                controls gone); rewriteRunStatusesForUpdate (:153): a compacting record becomes
\*                idle + resetAt (:167), any other running record updatedAt = 0 for the reaper;
\*                no running record -> the store (with its queued controls) stays and a session
\*                killed in a compaction or a turn hangs (Ф8, specs/RestartRecovery.tla)
\*
\* Environment assumptions (eve 0.51.1, spec section 5): eve awaits channel handlers (Ф10);
\* control commands go before buffered messages (Ф11); a compact request queues behind an active
\* turn (Ф3); a parking follows any compaction end (Ф6), after an abort the order is parking,
\* turn.cancelled, parking (Ф13); after a turn eve parks, or with something queued may take the
\* next action directly (Ф9, both); a steer message aborts the compaction (Ф5); a reset of a hung
\* session fails (Ф8); a reset by the reaper keeps the input buffer (not proven); eve's queued
\* controls survive a restart without quarantine; a process killed after eve began a
\* compaction, before or inside the compaction.requested hook, hangs like one killed mid-summary;
\* a late compact request lands or dies within ASK_FORGOTTEN_MS; a direct delivery cut by a
\* restart is told to the person by the bridge, a drain delivery stays in the disk queue; a live
\* turn keeps its record fresh; one session per chat; context abstracted to low/high against
\* idleCompactionLimit; one input buffer goes into one turn. LongCompaction = FALSE assumes that
\* a compaction ends within RUN_STALE_MS.
\*
\* Outside the model, covered elsewhere: limit arithmetic and null input (PBT
\* agent/lib/idle-compaction.test.ts), route status mapping (scripts/lib/eve-compact.test.ts), the
\* eve hunk (scripts/eve-manual-compaction.test.ts), restart on a real eve process
\* (scripts/restart-mid-compaction.test.ts), recovery faults and quarantine rotation
\* (RestartRecovery.tla), /stop during a turn, /new, several chats, Bot API and file failures,
\* a missing ASSISTANT_BEARER (no claim, no ask: the same as due = FALSE).
\*
\* Code switches (TRUE = the code; each witness sets one to FALSE):
\*   AwaitPost         session.waiting awaits the compact POST (R1)
\*   ReleaseOnlyCompacting  a refusal frees only {sessionId, compacting: true} (R2)
\*   ClaimChat         the chat is claimed before the request
\*   OpenGuard         completeIdleCompaction counts only while the turn is closed
\*   SilentReap        the reaper sends no interrupt notice for a compacting record
\*   TurnClears        publishTelegramTurnStarted writes compacting: null
\*   DueOnce           due cleared at the first parking
\*   DueChecksOff      closeIdleCompactionTurn: due = !off && ...
\*   ParkRelease       session.waiting frees the compacting record
\*   Reaper            the reaper closes a stale record
\*   QueueReplies      a reply to the bot is queued while the chat is compacting
\*   DropOnFail        turn.failed / turn.cancelled clear due
\*   DropEndsAsk       turn.failed / turn.cancelled also clear asked and compacted (R3)
\*   Reclaim           an open ask (reclaim) blocks a second one; cleared by refusal,
\*                     completion, parking on the compacting record and after 30 min (R4)
\*   BeginClaim        compaction.requested claims the chat again for an open ask (R4)
\* Proposed repair (FALSE = the code):
\*   BeginAnyIdle      R5: compaction.requested claims the chat for any compaction outside a
\*                     turn, also when the process memory was lost by a restart
\* Environment switches: Policy, Bypass (replies to bot messages happen), LatePost (a compact
\* request outlives the client's timeout and is accepted later), LongCompaction (a compaction
\* may outlast RUN_STALE_MS, 30 min).
EXTENDS Naturals

CONSTANTS
  Policy, MaxMsgs, MaxSteps, MaxRestarts, MaxStops,
  Bypass, LatePost, LongCompaction,
  AwaitPost, ReleaseOnlyCompacting, ClaimChat, OpenGuard, SilentReap, TurnClears, DueOnce,
  DueChecksOff, ParkRelease, Reaper, QueueReplies, DropOnFail, DropEndsAsk, Reclaim, BeginClaim, BeginAnyIdle

ASSUME Policy \in {"queue", "steer"}

Level == {"none", "low", "high"}

VARIABLES
  \* person and bridge: normal and reply-to-bot messages waiting for routing
  sent, pend, pendR, bq, wire, dw,
  \* eve session; after: where eve goes when the parking handler returns
  buf, started, ev, after, steps, ctx, ctrl, hung, stops,
  \* the awaited compact POST and a request that outlived its client
  post, late,
  \* chat status record: rs running/idle, rk none/ingress/turn, rsid none/cur/old (sessionId:
  \* none, the current eve session, one retired by quarantine), cflag (compacting), fresh (not
  \* stale), resetAt, marked (updatedAt = 0 by recovery)
  rs, rk, rsid, cflag, fresh, resetAt, marked,
  \* process memory of idle-compaction.ts for the session
  has, open, first, last, due, asked, compacted, off, reclaim,
  \* restarts and losses
  restarts, lostTold, lostSilent,
  \* ghosts
  asksSince, badStack, badStackRec, badAskOff, idleDone, turnClean, badOff,
  falseNotice, leak, inboxLeak, hangSeen, hangTurn, badCancelMark, expired, leakWin, hangWin

bridgeV == <<sent, pend, pendR, bq, wire, dw>>
eveV == <<buf, started, ev, after, steps, ctx, ctrl, hung, stops>>
postV == <<post, late>>
recV == <<rs, rk, rsid, cflag, fresh, resetAt, marked>>
memV == <<has, open, first, last, due, asked, compacted, off, reclaim>>
lossV == <<restarts, lostTold, lostSilent>>
ghostV == <<asksSince, badStack, badStackRec, badAskOff, idleDone, turnClean, badOff,
            falseNotice, leak, inboxLeak, hangSeen, hangTurn, badCancelMark, expired, leakWin,
            hangWin>>
vars == <<bridgeV, eveV, postV, recV, memV, lossV, ghostV>>

Init ==
  /\ sent = 0 /\ pend = 0 /\ pendR = 0 /\ bq = 0 /\ wire = 0 /\ dw = 0
  /\ buf = 0 /\ started = 0 /\ ev = "parked" /\ after = "parked" /\ steps = 0 /\ ctx = "low"
  /\ ctrl = 0 /\ hung = FALSE /\ stops = 0
  /\ post = 0 /\ late = 0
  /\ rs = "idle" /\ rk = "none" /\ rsid = "none" /\ cflag = FALSE /\ fresh = TRUE
  /\ resetAt = FALSE /\ marked = FALSE
  /\ has = FALSE /\ open = FALSE /\ first = "none" /\ last = "none" /\ due = FALSE
  /\ asked = FALSE /\ compacted = FALSE /\ off = FALSE /\ reclaim = FALSE
  /\ restarts = 0 /\ lostTold = 0 /\ lostSilent = 0
  /\ asksSince = 0 /\ badStack = FALSE /\ badStackRec = FALSE /\ badAskOff = FALSE
  /\ idleDone = FALSE /\ turnClean = FALSE /\ badOff = FALSE /\ falseNotice = FALSE
  /\ leak = FALSE /\ inboxLeak = FALSE /\ hangSeen = FALSE /\ hangTurn = FALSE
  /\ badCancelMark = FALSE /\ expired = FALSE /\ leakWin = FALSE /\ hangWin = FALSE

\* isRunning: a running record that is not stale.
Running == rs = "running" /\ fresh
\* The compacting record holds the chat.
CompRecord == rs = "running" /\ cflag
\* eve compacts: compaction.requested is being handled (compReq) or the summary runs.
Compacting == ev \in {"compReq", "compact"}
\* A compaction requested and not ended: on its way, queued in eve or running.
CompPending == post > 0 \/ late > 0 \/ ctrl > 0 \/ Compacting

RecIdle(reset) ==
  /\ rs' = "idle" /\ rk' = "none" /\ rsid' = "none" /\ cflag' = FALSE /\ fresh' = TRUE
  /\ resetAt' = reset /\ marked' = FALSE

\* finishTelegramStatus(current session): CAS by sessionId. ParkRelease = FALSE (mutant): the
\* parking leaves a compacting record alone.
Finish(park) ==
  IF rsid = "cur" /\ rs = "running" /\ ~(park /\ ~ParkRelease /\ cflag)
    THEN RecIdle(resetAt)
    ELSE UNCHANGED recV

MemGone ==
  /\ has' = FALSE /\ open' = FALSE /\ first' = "none" /\ last' = "none" /\ due' = FALSE
  /\ asked' = FALSE /\ compacted' = FALSE /\ off' = FALSE /\ reclaim' = FALSE

\* dropIdleCompactionTurn
Drop ==
  /\ open' = FALSE
  /\ due' = IF DropOnFail THEN FALSE ELSE due
  \* a failed or cancelled turn also ends the ask's measurement (repair R3)
  /\ asked' = IF DropEndsAsk THEN FALSE ELSE asked
  /\ compacted' = IF DropEndsAsk THEN FALSE ELSE compacted

Send ==
  /\ sent < MaxMsgs
  /\ sent' = sent + 1
  /\ \/ pend' = pend + 1 /\ UNCHANGED pendR
     \/ Bypass /\ pendR' = pendR + 1 /\ UNCHANGED pend
  /\ UNCHANGED <<bq, wire, dw>> /\ UNCHANGED <<eveV, postV, recV, memV, lossV, ghostV>>

RouteMsg(reply) ==
  LET busyCheck == ~reply \/ (QueueReplies /\ CompRecord /\ fresh)
      mustQueue == busyCheck /\ Policy = "queue" /\ (Running \/ bq > 0 \/ dw > 0)
  IN /\ IF mustQueue
          THEN bq' = bq + 1 /\ UNCHANGED wire
          ELSE wire' = wire + 1 /\ UNCHANGED bq
     \* (1) under queue a message routed while eve compacts goes to the bridge queue, unless
     \* the claim of this compaction went stale (a compaction longer than RUN_STALE_MS)
     /\ leak' = (leak \/ (Policy = "queue" /\ ev = "compact" /\ ~mustQueue /\ ~expired))
     \* the same in the window between the start of the compaction and its hook
     /\ leakWin' = (leakWin \/ (Policy = "queue" /\ ev = "compReq" /\ ~mustQueue))

Route ==
  /\ \/ pend > 0 /\ pend' = pend - 1 /\ UNCHANGED pendR /\ RouteMsg(FALSE)
     \/ pendR > 0 /\ pendR' = pendR - 1 /\ UNCHANGED pend /\ RouteMsg(TRUE)
  /\ UNCHANGED <<sent, dw>> /\ UNCHANGED <<eveV, postV, recV, memV, lossV>>
  /\ UNCHANGED <<asksSince, badStack, badStackRec, badAskOff, idleDone, turnClean, badOff,
                 falseNotice, inboxLeak, hangSeen, hangTurn, badCancelMark, expired, hangWin>>

Drain ==
  /\ bq > 0 /\ dw = 0 /\ ~Running
  /\ bq' = bq - 1 /\ dw' = 1
  /\ UNCHANGED <<sent, pend, pendR, wire>>
  /\ UNCHANGED <<eveV, postV, recV, memV, lossV, ghostV>>

Arrive ==
  /\ \/ dw > 0 /\ dw' = 0 /\ UNCHANGED wire
     \/ wire > 0 /\ wire' = wire - 1 /\ UNCHANGED dw
  /\ IF Running
       THEN UNCHANGED recV
       ELSE /\ rs' = "running" /\ rk' = "ingress" /\ rsid' = "none" /\ cflag' = FALSE
            /\ fresh' = TRUE /\ resetAt' = FALSE /\ marked' = FALSE
  /\ IF hung
       THEN buf' = buf + 1 /\ UNCHANGED <<started, ev>>
       ELSE IF Policy = "steer" /\ Compacting
       THEN buf' = buf + 1 /\ ev' = "postAbort" /\ UNCHANGED started
       ELSE IF Policy = "steer" /\ ev = "turn"
       THEN started' = started + 1 /\ UNCHANGED <<buf, ev>>
       ELSE buf' = buf + 1 /\ UNCHANGED <<started, ev>>
  \* (1, strong form) under queue no message enters eve's input while the compacting record
  \* holds the chat
  /\ inboxLeak' = (inboxLeak \/ (Policy = "queue" /\ CompRecord /\ fresh /\ ~hung))
  /\ UNCHANGED <<sent, pend, pendR, bq>>
  /\ UNCHANGED <<after, steps, ctx, ctrl, hung, stops>> /\ UNCHANGED <<postV, memV, lossV>>
  /\ UNCHANGED <<asksSince, badStack, badStackRec, badAskOff, idleDone, turnClean, badOff,
                 falseNotice, leak, hangSeen, hangTurn, badCancelMark, expired, leakWin, hangWin>>

EveStartComp ==
  /\ ev = "parked" /\ ~hung /\ ctrl > 0
  /\ ev' = "compReq" /\ ctrl' = ctrl - 1
  /\ inboxLeak' = (inboxLeak \/ (Policy = "queue" /\ buf > 0 /\ CompRecord /\ fresh))
  /\ UNCHANGED <<buf, started, after, steps, ctx, hung, stops>>
  /\ UNCHANGED <<bridgeV, postV, recV, memV, lossV>>
  /\ UNCHANGED <<asksSince, badStack, badStackRec, badAskOff, idleDone, turnClean, badOff,
                 falseNotice, leak, hangSeen, hangTurn, badCancelMark, expired, leakWin, hangWin>>

\* compaction.requested -> beginIdleCompaction (idle-compaction.ts:86): between turns, with an
\* ask still open (reclaim), claim the chat again with the same takeover; a live record or
\* resetAt is left alone. Then the summary runs.
BeginHook ==
  /\ ev = "compReq" /\ ~hung
  /\ ev' = "compact"
  /\ IF BeginClaim /\ ((Reclaim /\ has /\ ~open /\ reclaim) \/ (BeginAnyIdle /\ ~(has /\ open)))
       THEN /\ reclaim' = FALSE
            /\ IF ~resetAt /\ ~Running
                 THEN /\ rs' = "running" /\ rk' = "none" /\ rsid' = "cur" /\ cflag' = TRUE
                      /\ fresh' = TRUE /\ resetAt' = FALSE /\ marked' = FALSE
                      /\ expired' = FALSE
                 ELSE UNCHANGED <<recV, expired>>
       ELSE UNCHANGED <<reclaim, recV, expired>>
  /\ UNCHANGED <<buf, started, after, steps, ctx, ctrl, hung, stops>>
  /\ UNCHANGED <<has, open, first, last, due, asked, compacted, off>>
  /\ UNCHANGED <<bridgeV, postV, lossV>>
  /\ UNCHANGED <<asksSince, badStack, badStackRec, badAskOff, idleDone, turnClean, badOff,
                 falseNotice, leak, inboxLeak, hangSeen, hangTurn, badCancelMark, leakWin, hangWin>>

EveStartTurn ==
  /\ ev = "parked" /\ ~hung /\ ctrl = 0 /\ buf > 0
  /\ ev' = "turn" /\ steps' = 0 /\ started' = started + buf /\ buf' = 0
  /\ has' = TRUE /\ open' = TRUE /\ first' = "none" /\ last' = "none" /\ due' = FALSE
  /\ IF has THEN UNCHANGED <<asked, compacted, off>>
     ELSE asked' = FALSE /\ compacted' = FALSE /\ off' = FALSE
  /\ UNCHANGED reclaim
  /\ IF rs = "running" /\ rk = "ingress" /\ rsid = "none"
       THEN /\ rk' = "turn" /\ rsid' = "cur" /\ fresh' = TRUE
            /\ UNCHANGED <<rs, cflag, resetAt, marked>>
       ELSE IF resetAt
       THEN UNCHANGED recV
       ELSE /\ rs' = "running" /\ rk' = "turn" /\ rsid' = "cur" /\ fresh' = TRUE
            /\ cflag' = (IF TurnClears THEN FALSE ELSE cflag)
            /\ UNCHANGED <<resetAt, marked>>
  /\ turnClean' = idleDone
  /\ UNCHANGED <<after, ctx, ctrl, hung, stops>> /\ UNCHANGED <<bridgeV, postV, lossV>>
  /\ UNCHANGED <<asksSince, badStack, badStackRec, badAskOff, idleDone, badOff, falseNotice,
                 leak, inboxLeak, hangSeen, hangTurn, badCancelMark, expired, leakWin, hangWin>>

Step ==
  /\ ev = "turn" /\ ~hung /\ steps < MaxSteps
  /\ \E c \in {ctx, "high"}, known \in BOOLEAN :
       LET r == IF known THEN c ELSE "none" IN
       /\ ctx' = c
       /\ IF has
            THEN /\ first' = IF first = "none" THEN r ELSE first
                 /\ last' = r
            ELSE UNCHANGED <<first, last>>
  /\ steps' = steps + 1
  /\ UNCHANGED <<buf, started, ev, after, ctrl, hung, stops>>
  /\ UNCHANGED <<has, open, due, asked, compacted, off, reclaim>>
  /\ UNCHANGED <<bridgeV, postV, recV, lossV, ghostV>>

\* completeIdleCompaction
OnCompleted == compacted' = (compacted \/ (has /\ asked /\ (~open \/ ~OpenGuard)))

InTurnComp ==
  /\ ev = "turn" /\ ~hung /\ steps >= 1 /\ ctx = "high"
  /\ ctx' \in {"low", "high"}
  /\ OnCompleted
  /\ UNCHANGED <<buf, started, ev, after, steps, ctrl, hung, stops>>
  /\ UNCHANGED <<has, open, first, last, due, asked, off, reclaim>>
  /\ UNCHANGED <<bridgeV, postV, recV, lossV, ghostV>>

TurnEnd ==
  /\ ev = "turn" /\ ~hung /\ steps >= 1
  /\ ev' = "postTurn" /\ steps' = 0
  /\ Finish(FALSE)
  /\ IF has
       THEN LET newOff == off \/ (asked /\ compacted /\ first = "high") IN
            /\ open' = FALSE
            /\ off' = newOff
            /\ asked' = FALSE /\ compacted' = FALSE
            /\ due' = ((~newOff \/ ~DueChecksOff) /\ last = "high")
            /\ badOff' = (badOff \/ (newOff /\ ~off /\ ~turnClean))
       ELSE UNCHANGED <<open, off, asked, compacted, due, badOff>>
  /\ asksSince' = 0 /\ idleDone' = FALSE
  /\ UNCHANGED <<buf, started, after, ctx, ctrl, hung, stops>>
  /\ UNCHANGED <<has, first, last, reclaim>> /\ UNCHANGED <<bridgeV, postV, lossV>>
  /\ UNCHANGED <<badStack, badStackRec, badAskOff, turnClean, falseNotice, leak, inboxLeak,
                 hangSeen, hangTurn, badCancelMark, expired, leakWin, hangWin>>

TurnFail ==
  /\ ev = "turn" /\ ~hung
  /\ ev' = "postTurn" /\ steps' = 0
  /\ Finish(FALSE)
  /\ IF has THEN Drop ELSE UNCHANGED <<open, due, asked, compacted>>
  /\ asksSince' = 0 /\ idleDone' = FALSE
  /\ UNCHANGED <<buf, started, after, ctx, ctrl, hung, stops>>
  /\ UNCHANGED <<has, first, last, off, reclaim>> /\ UNCHANGED <<bridgeV, postV, lossV>>
  /\ UNCHANGED <<badStack, badStackRec, badAskOff, turnClean, badOff, falseNotice, leak,
                 inboxLeak, hangSeen, hangTurn, badCancelMark, expired, leakWin, hangWin>>

PostTurnSkip ==
  /\ ev = "postTurn" /\ ~hung /\ (buf > 0 \/ ctrl > 0)
  /\ ev' = "parked"
  /\ UNCHANGED <<buf, started, after, steps, ctx, ctrl, hung, stops>>
  /\ UNCHANGED <<bridgeV, postV, recV, memV, lossV, ghostV>>

WaitRelease ==
  /\ ev \in {"postTurn", "postComp", "postAbort"} /\ ~hung
  /\ ev' = "waitClaim"
  /\ after' = IF ev = "postAbort" THEN "cancelH" ELSE "parked"
  \* endIdleCompaction (telegram.ts:356): the parking found this session's compacting record
  /\ reclaim' = IF Reclaim /\ cflag /\ rsid = "cur" THEN FALSE ELSE reclaim
  /\ Finish(TRUE)
  /\ UNCHANGED <<buf, started, steps, ctx, ctrl, hung, stops>>
  /\ UNCHANGED <<has, open, first, last, due, asked, compacted, off>>
  /\ UNCHANGED <<bridgeV, postV, lossV, ghostV>>

WaitClaim ==
  /\ ev = "waitClaim" /\ ~hung
  /\ LET canClaim == ~resetAt /\ ~Running
         \* an earlier ask eve has not announced yet: no second one
         ask == has /\ due /\ ~(Reclaim /\ reclaim) /\ (~ClaimChat \/ canClaim)
     IN /\ ev' = IF ask /\ AwaitPost THEN "waitPost" ELSE after
        /\ IF has /\ due THEN due' = ~DueOnce ELSE UNCHANGED due
        /\ IF ask
             THEN /\ IF ClaimChat
                       THEN /\ rs' = "running" /\ rk' = "none" /\ rsid' = "cur"
                            /\ cflag' = TRUE /\ fresh' = TRUE /\ resetAt' = FALSE
                            /\ marked' = FALSE
                       ELSE UNCHANGED recV
                  /\ asked' = TRUE /\ reclaim' = TRUE
                  /\ post' = 1
                  /\ asksSince' = asksSince + 1
                  /\ badStack' = (badStack \/ CompPending)
                  /\ badStackRec' = (badStackRec \/ CompRecord)
                  /\ badAskOff' = (badAskOff \/ off)
                  /\ expired' = FALSE
             ELSE UNCHANGED <<recV, asked, reclaim, post, asksSince, badStack, badStackRec,
                              badAskOff, expired>>
  /\ UNCHANGED <<buf, started, after, steps, ctx, ctrl, hung, stops>>
  /\ UNCHANGED <<has, open, first, last, compacted, off>>
  /\ UNCHANGED <<bridgeV, late, lossV>>
  /\ UNCHANGED <<idleDone, turnClean, badOff, falseNotice, leak, inboxLeak, hangSeen, hangTurn,
                 badCancelMark, leakWin, hangWin>>

\* The answer to the compact POST. Without AwaitPost eve does not wait for it.
PostAnswer ==
  /\ post > 0 /\ ~hung
  /\ post' = 0
  /\ \/ /\ ctrl' = ctrl + 1 /\ UNCHANGED <<recV, asked, reclaim, late>>     \* 202
     \/ /\ asked' = FALSE /\ reclaim' = FALSE                              \* 200, 4xx
        /\ IF ReleaseOnlyCompacting
             THEN IF CompRecord /\ rsid = "cur" THEN RecIdle(resetAt) ELSE UNCHANGED recV
             ELSE Finish(FALSE)
        /\ UNCHANGED <<ctrl, late>>
     \/ /\ ctrl' = ctrl + 1 /\ UNCHANGED <<recV, asked, reclaim, late>>     \* 5xx, queued
     \/ UNCHANGED <<ctrl, recV, asked, reclaim, late>>                      \* timeout, lost
     \/ /\ LatePost /\ late' = 1 /\ UNCHANGED <<ctrl, recV, asked, reclaim>> \* lands later
  /\ ev' = IF ev = "waitPost" THEN after ELSE ev
  /\ UNCHANGED <<buf, started, after, steps, ctx, hung, stops>>
  /\ UNCHANGED <<has, open, first, last, due, compacted, off>>
  /\ UNCHANGED <<bridgeV, lossV, ghostV>>

LateLand ==
  /\ late > 0 /\ ~hung
  /\ late' = 0 /\ ctrl' = ctrl + 1
  /\ UNCHANGED <<buf, started, ev, after, steps, ctx, hung, stops>>
  /\ UNCHANGED <<post>> /\ UNCHANGED <<bridgeV, recV, memV, lossV, ghostV>>

CompDone ==
  /\ ev = "compact" /\ ~hung
  /\ ev' = "postComp" /\ ctx' \in {"low", "high"}
  /\ OnCompleted
  /\ reclaim' = IF open THEN reclaim ELSE FALSE
  /\ idleDone' = (idleDone \/ ~open)
  /\ UNCHANGED <<buf, started, after, steps, ctrl, hung, stops>>
  /\ UNCHANGED <<has, open, first, last, due, asked, off>>
  /\ UNCHANGED <<bridgeV, postV, recV, lossV>>
  /\ UNCHANGED <<asksSince, badStack, badStackRec, badAskOff, turnClean, badOff, falseNotice,
                 leak, inboxLeak, hangSeen, hangTurn, badCancelMark, expired, leakWin, hangWin>>

CompFail ==
  /\ ev = "compact" /\ ~hung
  /\ ev' = "postComp"
  /\ UNCHANGED <<buf, started, after, steps, ctx, ctrl, hung, stops>>
  /\ UNCHANGED <<bridgeV, postV, recV, memV, lossV, ghostV>>

StopComp ==
  /\ Compacting /\ ~hung /\ stops < MaxStops
  /\ ev' = "postAbort" /\ stops' = stops + 1
  /\ UNCHANGED <<buf, started, after, steps, ctx, ctrl, hung>>
  /\ UNCHANGED <<bridgeV, postV, recV, memV, lossV, ghostV>>

CancelH ==
  /\ ev = "cancelH" /\ ~hung
  /\ ev' = "postComp"
  /\ LET compacting == rs = "running" /\ cflag IN
       /\ Finish(FALSE)
       /\ badCancelMark' = (badCancelMark \/ (~compacting /\ rsid = "cur" /\ rs = "running"))
  /\ IF has THEN Drop ELSE UNCHANGED <<open, due, asked, compacted>>
  /\ UNCHANGED <<buf, started, after, steps, ctx, ctrl, hung, stops>>
  /\ UNCHANGED <<has, first, last, off, reclaim>>
  /\ UNCHANGED <<bridgeV, postV, lossV>>
  /\ UNCHANGED <<asksSince, badStack, badStackRec, badAskOff, idleDone, turnClean, badOff,
                 falseNotice, leak, inboxLeak, hangSeen, hangTurn, expired, leakWin, hangWin>>

\* ASK_FORGOTTEN_MS: an ask eve never announced is forgotten after 30 minutes. Assumption: by
\* then eve has started or dropped it (nothing of it is pending).
Forget ==
  /\ Reclaim /\ reclaim /\ ~hung
  /\ post = 0 /\ late = 0 /\ ctrl = 0 /\ ~Compacting
  /\ reclaim' = FALSE
  /\ UNCHANGED <<has, open, first, last, due, asked, compacted, off>>
  /\ UNCHANGED <<bridgeV, eveV, postV, recV, lossV, ghostV>>

\* Nobody will touch the record any more: no live turn or compaction, nothing pending.
Abandoned ==
  \/ hung
  \/ (ev = "parked" /\ ctrl = 0 /\ post = 0 /\ late = 0 /\ buf = 0 /\ wire = 0 /\ dw = 0)

Expire ==
  /\ Reaper /\ rs = "running" /\ fresh
  /\ Abandoned \/ (LongCompaction /\ cflag /\ ev = "compact")
  /\ fresh' = FALSE
  /\ expired' = (expired \/ cflag)
  /\ UNCHANGED <<rs, rk, rsid, cflag, resetAt, marked>>
  /\ UNCHANGED <<bridgeV, eveV, postV, memV, lossV>>
  /\ UNCHANGED <<asksSince, badStack, badStackRec, badAskOff, idleDone, turnClean, badOff,
                 falseNotice, leak, inboxLeak, hangSeen, hangTurn, badCancelMark, leakWin, hangWin>>

Reap ==
  /\ Reaper /\ rs = "running" /\ ~fresh /\ dw = 0
  /\ RecIdle(TRUE)
  /\ LET notice == ~cflag \/ ~SilentReap
         reset == rsid = "cur" /\ ~hung
     IN /\ falseNotice' = (falseNotice \/ (notice /\ cflag))
        /\ IF reset
             THEN /\ ev' = "parked" /\ after' = "parked" /\ ctrl' = 0 /\ steps' = 0
                  /\ post' = 0 /\ late' = 0 /\ MemGone
             ELSE UNCHANGED <<ev, after, ctrl, steps, post, late, memV>>
  /\ UNCHANGED <<buf, started, ctx, hung, stops>> /\ UNCHANGED <<bridgeV, lossV>>
  /\ UNCHANGED <<asksSince, badStack, badStackRec, badAskOff, idleDone, turnClean, badOff,
                 leak, inboxLeak, hangSeen, hangTurn, badCancelMark, expired, leakWin, hangWin>>

Restart ==
  /\ restarts < MaxRestarts
  /\ restarts' = restarts + 1
  /\ MemGone /\ post' = 0 /\ late' = 0
  /\ wire' = 0 /\ bq' = bq + dw /\ dw' = 0
  /\ after' = "parked"
  /\ IF rs = "running" /\ ~marked
       THEN \* quarantine: the session with its input and controls is gone
            /\ ev' = "parked" /\ ctrl' = 0 /\ buf' = 0 /\ steps' = 0 /\ hung' = FALSE
            /\ IF cflag
                 THEN \* the compacting record is free again, nobody tells anything
                      /\ RecIdle(TRUE)
                      /\ lostSilent' = lostSilent + buf /\ lostTold' = lostTold + wire
                 ELSE \* marked for the reaper, which tells the person
                      /\ fresh' = FALSE /\ marked' = TRUE
                      /\ rsid' = IF rsid = "cur" THEN "old" ELSE rsid
                      /\ UNCHANGED <<rs, rk, cflag, resetAt>>
                      /\ lostTold' = lostTold + buf + wire /\ UNCHANGED lostSilent
            /\ UNCHANGED <<hangSeen, hangTurn, hangWin>>
       ELSE \* the store stays: a session killed in an action hangs (Ф8)
            /\ hung' = (hung \/ ev = "turn" \/ Compacting)
            /\ hangSeen' = (hangSeen \/ ev = "compact")
            /\ hangWin' = (hangWin \/ ev = "compReq")
            /\ hangTurn' = (hangTurn \/ ev = "turn")
            /\ ev' = IF ev = "turn" \/ Compacting THEN ev ELSE "parked"
            /\ UNCHANGED <<steps, ctrl, buf>> /\ UNCHANGED recV
            /\ lostTold' = lostTold + wire /\ UNCHANGED lostSilent
  /\ UNCHANGED <<started, ctx, stops>> /\ UNCHANGED <<sent, pend, pendR>>
  /\ UNCHANGED <<asksSince, badStack, badStackRec, badAskOff, idleDone, turnClean, badOff,
                 falseNotice, leak, inboxLeak, badCancelMark, expired, leakWin>>

Next ==
  \/ Send \/ Route \/ Drain \/ Arrive
  \/ EveStartComp \/ BeginHook \/ EveStartTurn \/ Step \/ InTurnComp \/ TurnEnd \/ TurnFail \/ PostTurnSkip
  \/ WaitRelease \/ WaitClaim \/ PostAnswer \/ LateLand
  \/ CompDone \/ CompFail \/ StopComp \/ CancelH
  \/ Forget \/ Expire \/ Reap \/ Restart

\* Fair eve, bridge and code; people, failures, /stop and restarts are not forced.
Spec == Init /\ [][Next]_vars
        /\ WF_vars(Route) /\ WF_vars(Drain) /\ WF_vars(Arrive)
        /\ WF_vars(EveStartComp) /\ WF_vars(BeginHook) /\ WF_vars(EveStartTurn) /\ WF_vars(Step \/ TurnEnd)
        /\ WF_vars(WaitRelease) /\ WF_vars(WaitClaim) /\ WF_vars(PostAnswer) /\ WF_vars(LateLand)
        /\ WF_vars(CompDone \/ CompFail) /\ WF_vars(CancelH) /\ WF_vars(Expire) /\ WF_vars(Reap)

TypeOK ==
  /\ sent \in 0..MaxMsgs /\ pend \in 0..MaxMsgs /\ pendR \in 0..MaxMsgs /\ bq \in 0..MaxMsgs
  /\ wire \in 0..MaxMsgs /\ dw \in 0..1 /\ buf \in 0..MaxMsgs /\ started \in 0..MaxMsgs
  /\ ev \in {"parked", "turn", "compReq", "compact", "postTurn", "postComp", "postAbort", "waitClaim",
             "waitPost", "cancelH"}
  /\ after \in {"parked", "cancelH"}
  /\ steps \in 0..MaxSteps /\ ctx \in {"low", "high"} /\ ctrl \in Nat
  /\ post \in 0..1 /\ late \in 0..1
  /\ rs \in {"idle", "running"} /\ rk \in {"none", "ingress", "turn"}
  /\ rsid \in {"none", "cur", "old"} /\ first \in Level /\ last \in Level

\* (1) every sent message is waiting, queued, on its way, in eve, answered or lost.
MessageAccounted ==
  sent = pend + pendR + bq + wire + dw + buf + started + lostTold + lostSilent
\* (1) under queue a message routed while eve compacts stays in the bridge queue (until the
\* compacting record goes stale).
QueuedWhileCompacting == ~leak
\* (1, strong form) under queue eve's input is empty while the compacting record holds the chat.
InboxEmptyWhileCompacting == ~inboxLeak
\* (1) liveness: every sent message begins a turn or is lost with or without a notice.
NoLostMessage ==
  \A k \in 1..MaxMsgs : (sent >= k) ~> (started + lostTold + lostSilent >= k)
\* (1) a message lost by a restart is told to the person.
NoSilentLoss == lostSilent = 0

\* (2) liveness: the compacting record does not stay forever.
ChatFreed == CompRecord ~> ~CompRecord
\* (2) while eve compacts (after compaction.requested was handled), a running record holds the
\* chat.
CompactionGuarded == ev = "compact" => rs = "running"
\* (2) a refusal never frees the record of a running turn (nor does anything else).
TurnRecordKept == (ev = "turn" /\ ~resetAt) => rs = "running"
\* (2) restart: no session killed mid-compaction without quarantine (Ф8).
NoHangAfterRestart == ~hangSeen
\* The same in the window between the start of a compaction and its compaction.requested hook.
NoHangInRequestWindow == ~hangWin
\* (1) a message routed under queue in that window goes to the bridge queue.
QueuedInRequestWindow == ~leakWin
\* The same for a turn (outside the feature, see the report).
NoTurnHangAfterRestart == ~hangTurn

\* (3) «Предыдущий ход оборвался» never goes out for a compacting record.
NoFalseInterruptNotice == ~falseNotice
\* (3) /stop or steer during a compaction leaves no wasCancelled mark.
NoCancelMarkForCompaction == ~badCancelMark

\* (4) the record of a running turn never carries compacting.
CompactingNeverInTurn == rk = "turn" => ~cflag

\* (5) off only after an idle compaction that completed before the measured turn began.
OffOnlyAfterUselessCompaction == ~badOff

\* (6) at most one ask per completed turn; no ask while an earlier one is pending anywhere;
\* no ask while the compacting record holds the chat.
AtMostOneAskPerTurn == asksSince <= 1
NoStackedCompaction == ~badStack
NoAskOverCompactingRecord == ~badStackRec

\* (7) no ask while off (process memory).
NoAskWhileOff == ~badAskOff
====
