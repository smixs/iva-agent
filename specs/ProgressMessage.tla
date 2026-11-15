-------------------------- MODULE ProgressMessage --------------------------
\* The status message of a long turn: posted once, edited in place, deleted at the end
\* (agent/lib/telegram-draft.ts, agent/lib/outbox.ts, agent/channels/telegram.ts).
\* TelegramProgress.tla models only the claim (`progressClaimed`); this model adds the
\* id of the message, a MARK of the chat record (ChatRecord.tla `progressMessageId`),
\* and the one deleter that fires on the derived state `stale`.
\*
\* rec = [pair, claimed, id]: pair is the running turn (0 = free chat), claimed is
\* `progressClaimed`, id is `progressMessageId` (0 = absent). progressMessageOf(rec):
\*   none    = ~claimed /\ id = 0     claimed = claimed /\ id = 0
\*   shown   = claimed /\ id # 0      stale   = ~claimed /\ id # 0
\* The turn fields (pair, claimed) are cleared by any process at any moment
\* (ForeignClear: Bridge reset and reaper, takeover); the id is not a turn field.
\*
\* An operation toward Telegram is a record in `ops`. Telegram accepts it (TgAccept) and
\* the caller learns the answer later (Deliver): a crash between the two is the residual
\* of the design. Process memory is lost at Crash; a request already sent may still land.
\*
\* TurnStart   -> turn.started: retire (top of the handler), then publish.
\* Step        -> TelegramDraftStream.status: post (claim, CAS id) or edit.
\* CloseStart, FinalSend, DrainTimeout -> close() of the stream and the final send.
\* Finish, RetireCall -> finishTelegramStatus: CAS, then retireProgressMessage.
\* Deliver     -> the frame that sent the request processes the answer.
EXTENDS Naturals, FiniteSets
CONSTANTS Mutant, MaxFaults, MaxCrashes, MaxForeign, MaxSteps, MaxMsgId
VARIABLES rec, msgs, nextId, ts, ops, posts, steps, bound, finalSent,
          faults, crashes, foreign, envDel, leaked, overId, late, liveDel, due
vars == <<rec, msgs, nextId, ts, ops, posts, steps, bound, finalSent,
          faults, crashes, foreign, envDel, leaked, overId, late, liveDel, due>>

Turns == 1..2
Stale(r) == r.id # 0 /\ ~r.claimed
Inflight(t) == \E o \in ops : o.k \in {"post", "edit"} /\ o.t = t /\ o.src = "live"
Drained(t) == ~Inflight(t) \/ bound[t]
NewOp(k, by, t, id) ==
  [k |-> k, by |-> by, t |-> t, id |-> id, src |-> "live", st |-> "pend", res |-> "", rid |-> 0]

\* The deleter fires only on `stale`; the mutant decides by the pair instead.
RetireGuard(r, caller) ==
  IF Mutant = "delete-by-pair" THEN r.id # 0 /\ r.pair # caller ELSE Stale(r)
RetireSet(r, caller, by) ==
  IF RetireGuard(r, caller) THEN {NewOp("del", by, 0, r.id)} ELSE {}
RetireLive(r, caller) == RetireGuard(r, caller) /\ ~Stale(r)

Init ==
  /\ rec = [pair |-> 0, claimed |-> FALSE, id |-> 0] /\ msgs = {} /\ nextId = 1
  /\ ts = [t \in Turns |-> "none"] /\ ops = {}
  /\ posts = [t \in Turns |-> 0] /\ steps = [t \in Turns |-> 0]
  /\ bound = [t \in Turns |-> FALSE] /\ finalSent = [t \in Turns |-> FALSE]
  /\ faults = 0 /\ crashes = 0 /\ foreign = 0 /\ envDel = 0
  /\ leaked = FALSE /\ overId = FALSE /\ late = FALSE /\ liveDel = FALSE /\ due = 0

TurnStart(t) ==
  /\ ts[t] = "none" /\ (IF t = 1 THEN TRUE ELSE ts[t - 1] # "none")
  /\ ops' = ops \cup RetireSet(rec, t, <<"s", t>>)
  /\ liveDel' = (liveDel \/ RetireLive(rec, t))
  /\ rec' = [pair |-> t, claimed |-> FALSE, id |-> rec.id]
  /\ ts' = [ts EXCEPT ![t] = "open"]
  /\ UNCHANGED <<msgs, nextId, posts, steps, bound, finalSent, faults, crashes,
                 foreign, envDel, leaked, overId, late, due>>

\* One status call. A skipped call (same text, throttle, pause) is no step at all.
Step(t) ==
  /\ ts[t] = "open" \/ (Mutant = "edit-after-close" /\ ts[t] = "closed")
  /\ steps[t] < MaxSteps /\ ~Inflight(t)
  /\ steps' = [steps EXCEPT ![t] = @ + 1]
  /\ late' = (late \/ ts[t] # "open")
  /\ \/ \* none: claim with `id = undefined` in the CAS, then post
        /\ rec.pair = t /\ ~rec.claimed /\ (rec.id = 0 \/ Mutant = "claim-over-id")
        /\ rec' = [rec EXCEPT !.claimed = TRUE]
        /\ ops' = ops \cup {NewOp("post", <<"p", t>>, t, 0)}
        /\ posts' = [posts EXCEPT ![t] = @ + 1]
        /\ overId' = (overId \/ rec.id # 0)
     \/ \* shown: edit the id read from the record
        /\ rec.pair = t /\ rec.claimed /\ rec.id # 0
        /\ ops' = ops \cup {NewOp("edit", <<"e", t>>, t, rec.id)}
        /\ UNCHANGED <<rec, posts, overId>>
  /\ UNCHANGED <<msgs, nextId, ts, bound, finalSent, faults, crashes, foreign, envDel,
                 leaked, liveDel, due>>

\* ---- Telegram ------------------------------------------------------------
Fault == faults < MaxFaults
Answer(o, res, rid, newMsgs, newNext, cost, lost) ==
  /\ ops' = (ops \ {o}) \cup {[o EXCEPT !.st = "done", !.res = res, !.rid = rid]}
  /\ msgs' = newMsgs /\ nextId' = newNext
  /\ faults' = faults + cost
  /\ leaked' = (leaked \/ lost)
  /\ UNCHANGED <<rec, ts, posts, steps, bound, finalSent, crashes, foreign, envDel,
                 overId, late, liveDel, due>>
TgAccept(o) ==
  /\ o \in ops /\ o.src = "live" /\ o.st = "pend"
  /\ \/ /\ o.k = "post" /\ nextId <= MaxMsgId
        /\ \/ Answer(o, "ok", nextId, msgs \cup {nextId}, nextId + 1, 0, FALSE)
           \* a reply without message_id, or a lost reply: the message exists, untracked
           \/ Fault /\ Answer(o, "ok", 0, msgs \cup {nextId}, nextId + 1, 1, TRUE)
           \/ Fault /\ Answer(o, "error", 0, msgs \cup {nextId}, nextId + 1, 1, TRUE)
           \/ Fault /\ \E r \in {"wait", "error", "gone"} :
                Answer(o, r, 0, msgs, nextId, 1, FALSE)
     \/ /\ o.k = "edit"
        /\ IF o.id \in msgs
           THEN \/ Answer(o, "ok", 0, msgs, nextId, 0, FALSE)
                \/ Fault /\ \E r \in {"wait", "error"} :
                     Answer(o, r, 0, msgs, nextId, 1, FALSE)
           ELSE Answer(o, "gone", 0, msgs, nextId, 0, FALSE)
     \/ /\ o.k = "del"
        /\ IF o.id \in msgs
           THEN \/ Answer(o, "ok", 0, msgs \ {o.id}, nextId, 0, FALSE)
                \/ Fault /\ \E r \in {"wait", "error"} :
                     Answer(o, r, 0, msgs, nextId, 1, FALSE)
                \* the message is gone, the reply is lost
                \/ Fault /\ Answer(o, "error", 0, msgs \ {o.id}, nextId, 1, FALSE)
           ELSE Answer(o, "gone", 0, msgs, nextId, 0, FALSE)
\* A request of a dead process may still land.
DeadSettle(o) ==
  /\ o \in ops /\ o.src = "dead"
  /\ ops' = ops \ {o}
  /\ \/ /\ o.k = "post" /\ nextId <= MaxMsgId /\ o.st = "pend"
        /\ msgs' = msgs \cup {nextId} /\ nextId' = nextId + 1 /\ leaked' = TRUE
     \/ /\ o.k = "del" /\ msgs' = msgs \ {o.id} /\ UNCHANGED <<nextId, leaked>>
     \/ /\ msgs' = msgs /\ UNCHANGED <<nextId, leaked>>
  /\ UNCHANGED <<rec, ts, posts, steps, bound, finalSent, faults, crashes, foreign,
                 envDel, overId, late, liveDel, due>>
UserDeletes ==
  /\ envDel < 1 /\ \E i \in msgs : msgs' = msgs \ {i}
  /\ envDel' = envDel + 1
  /\ UNCHANGED <<rec, nextId, ts, ops, posts, steps, bound, finalSent, faults, crashes,
                 foreign, leaked, overId, late, liveDel, due>>

\* ---- the caller learns the answer ---------------------------------------
Deliver(o) ==
  /\ o \in ops /\ o.src = "live" /\ o.st = "done"
  /\ ops' = (ops \ {o}) \cup
       (IF o.k = "post" /\ o.res = "ok" /\ o.rid # 0
           /\ ~(rec.pair = o.t /\ rec.claimed /\ rec.id = 0)
           /\ Mutant # "no-frame-delete"
        THEN {NewOp("del", <<"f", o.t>>, 0, o.rid)} ELSE {})
  /\ rec' =
       CASE o.k = "post" /\ o.res = "ok" /\ o.rid # 0
              /\ rec.pair = o.t /\ rec.claimed /\ rec.id = 0
            -> [rec EXCEPT !.id = o.rid]
         [] o.k = "edit" /\ o.res = "gone" /\ rec.id = o.id
            -> [rec EXCEPT !.id = 0,
                 !.claimed = IF Mutant = "resend-after-gone" THEN FALSE ELSE rec.claimed]
         [] o.k = "del" /\ o.res \in {"ok", "gone"}
            -> IF Mutant = "clear-null" THEN [rec EXCEPT !.id = 0]
               ELSE IF rec.id = o.id THEN [rec EXCEPT !.id = 0] ELSE rec
         [] OTHER -> rec
  \* A failed delete of a frame leaves one untracked message: nobody else knows its id.
  /\ leaked' = (leaked \/ (o.k = "del" /\ o.by[1] = "f" /\ o.res \notin {"ok", "gone"}))
  /\ UNCHANGED <<msgs, nextId, ts, posts, steps, bound, finalSent, faults, crashes,
                 foreign, envDel, overId, late, liveDel, due>>

\* ---- the end of a turn -----------------------------------------------------
CloseStart(t) ==
  /\ ts[t] = "open" /\ ts' = [ts EXCEPT ![t] = "closed"]
  /\ UNCHANGED <<rec, msgs, nextId, ops, posts, steps, bound, finalSent, faults,
                 crashes, foreign, envDel, leaked, overId, late, liveDel, due>>
DrainTimeout(t) ==
  /\ ts[t] = "closed" /\ Inflight(t) /\ ~bound[t] /\ bound' = [bound EXCEPT ![t] = TRUE]
  /\ UNCHANGED <<rec, msgs, nextId, ts, ops, posts, steps, finalSent, faults, crashes,
                 foreign, envDel, leaked, overId, late, liveDel, due>>
FinalSend(t) ==
  /\ ts[t] = "closed" /\ ~finalSent[t] /\ Drained(t)
  /\ finalSent' = [finalSent EXCEPT ![t] = TRUE]
  /\ UNCHANGED <<rec, msgs, nextId, ts, ops, posts, steps, bound, faults, crashes,
                 foreign, envDel, leaked, overId, late, liveDel, due>>
Finish(t) ==
  /\ ts[t] = "closed" /\ Drained(t) /\ due = 0
  /\ ts' = [ts EXCEPT ![t] = "finished"]
  /\ rec' = IF rec.pair = t THEN [pair |-> 0, claimed |-> FALSE, id |-> rec.id] ELSE rec
  /\ due' = t
  /\ UNCHANGED <<msgs, nextId, ops, posts, steps, bound, finalSent, faults, crashes,
                 foreign, envDel, leaked, overId, late, liveDel>>
\* retireProgressMessage after the CAS, whether or not the CAS succeeded.
RetireCall ==
  /\ due # 0 /\ due' = 0
  /\ ops' = ops \cup RetireSet(rec, due, <<"r", due>>)
  /\ liveDel' = (liveDel \/ RetireLive(rec, due))
  /\ UNCHANGED <<rec, msgs, nextId, ts, posts, steps, bound, finalSent, faults,
                 crashes, foreign, envDel, leaked, overId, late>>

\* ---- other processes and failures -------------------------------------------
ForeignClear ==
  /\ foreign < MaxForeign /\ foreign' = foreign + 1
  /\ rec' = [pair |-> 0, claimed |-> FALSE,
             id |-> IF Mutant = "id-turn-field" THEN 0 ELSE rec.id]
  /\ UNCHANGED <<msgs, nextId, ts, ops, posts, steps, bound, finalSent, faults, crashes,
                 envDel, leaked, overId, late, liveDel, due>>
Crash ==
  /\ crashes < MaxCrashes /\ crashes' = crashes + 1
  \* A crash while a frame holds a posted message (before the record write or before
  \* its delete lands) leaves it untracked.
  /\ leaked' = (leaked \/ \E o \in ops : o.src = "live" /\
                  ((o.k = "post" /\ o.st = "done" /\ o.rid # 0)
                   \/ (o.k = "del" /\ o.by[1] = "f")))
  /\ ops' = {[o EXCEPT !.src = "dead"] : o \in ops}
  /\ ts' = [t \in Turns |-> IF ts[t] = "open" THEN "lost" ELSE ts[t]]
  /\ due' = 0
  /\ UNCHANGED <<rec, msgs, nextId, posts, steps, bound, finalSent, faults, foreign,
                 envDel, overId, late, liveDel>>
\* The turn resumes: a lazily recreated stream reads the id from the record.
Resume(t) ==
  /\ ts[t] = "lost" /\ ts' = [ts EXCEPT ![t] = "open"]
  /\ UNCHANGED <<rec, msgs, nextId, ops, posts, steps, bound, finalSent, faults,
                 crashes, foreign, envDel, leaked, overId, late, liveDel, due>>
GiveUp(t) ==
  /\ ts[t] = "lost" /\ ts' = [ts EXCEPT ![t] = "dead"]
  /\ UNCHANGED <<rec, msgs, nextId, ops, posts, steps, bound, finalSent, faults,
                 crashes, foreign, envDel, leaked, overId, late, liveDel, due>>

Next == (\E t \in Turns : TurnStart(t) \/ Step(t) \/ CloseStart(t) \/ DrainTimeout(t)
                          \/ FinalSend(t) \/ Finish(t) \/ Resume(t) \/ GiveUp(t))
        \/ (\E o \in ops : TgAccept(o) \/ DeadSettle(o) \/ Deliver(o))
        \/ RetireCall \/ ForeignClear \/ Crash \/ UserDeletes
\* Telegram answers, every call is delivered, a started turn ends.
Fairness ==
  /\ WF_vars(\E o \in ops : TgAccept(o))
  /\ WF_vars(\E o \in ops : Deliver(o))
  /\ WF_vars(\E o \in ops : DeadSettle(o))
  /\ WF_vars(RetireCall)
  /\ \A t \in Turns : WF_vars(CloseStart(t)) /\ WF_vars(Finish(t))
Spec == Init /\ [][Next]_vars /\ Fairness

TypeOK ==
  /\ rec.pair \in 0..2 /\ rec.claimed \in BOOLEAN /\ rec.id \in 0..MaxMsgId
  /\ msgs \subseteq 1..MaxMsgId /\ due \in 0..2
  /\ \A t \in Turns : ts[t] \in {"none", "open", "closed", "finished", "lost", "dead"}

\* 1. At most one status post attempt per turn; a failed post, a lost id or a gone
\*    message is never followed by a resend.
Once == \A t \in Turns : posts[t] <= 1
\* 2. A post is attempted only when the record holds neither a claim nor an id.
NoPostOverId == ~overId
\* 4. deleteMessage is requested only for a stale id, or by the frame that posted it.
NoDeleteLive == ~liveDel
\* 6. Without a crash between accept and record write, every existing status message is
\*    the recorded id or is held by a request that deletes or records it.
NoOrphanWithoutCrash ==
  ~leaked => \A m \in msgs :
    \/ m = rec.id
    \/ \E o \in ops : o.src = "live" /\ ((o.k = "post" /\ o.st = "done" /\ o.rid = m)
                                          \/ (o.k = "del" /\ o.id = m))
\* 7. No status post or edit starts after the stream is closed; the final send begins
\*    only after the in-flight status call settled or its bound expired.
NoStatusAfterFinal ==
  /\ ~late
  /\ \A t \in Turns : finalSent[t] /\ Inflight(t) => bound[t]
\* 3. An id seen without a claim never becomes live again (concurrent deleters are safe).
StaleIsFinal ==
  [][Stale(rec) => ~(rec'.claimed /\ rec'.id = rec.id)]_vars
\* 8. After a terminal event of a turn the recorded id is deleted (Telegram answering).
EventuallyGone == (due # 0) ~> (due = 0 /\ ~Stale(rec))
=============================================================================
