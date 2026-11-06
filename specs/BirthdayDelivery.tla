----------------------- MODULE BirthdayDelivery -----------------------
EXTENDS Naturals, FiniteSets

\* PR382 v2: abstract operation order; tick tests cover reader/marker/keep details.
\* Claim -> tick.ts:claim / brief (existing intent before runTurn).
\* Generate -> tick.ts:turnText; message.completed/daily has no ack action.
\* Send -> TickDeps.send, one iva:next part with allowlisted iva:item keys.
\* Persist -> tick.ts:birthdayDelivery -> save, seen[key].reported after send.ok.
\* Observe -> tick.ts:watch keep2 -> observedState/updateSeen (abstract retention).
\* NextDay -> birthday key's daysUntil changes, same as the current key format.
\* Crash -> loss of in-flight locals; persisted seen survives a fresh tick.
\* Locking, ordinary sources, caps and quiet hours: existing Proactive model/tests.
\* A send is a whole logical part: false may include an internally delivered prefix.
\* Such a prefix is deliberately retried; there is no per-chunk transport receipt.
\* Environment: one locked tick, accurate send.ok, atomic state write, finite runs.

CONSTANTS Keys, MaxRuns, MaxCrashes, ClaimIsAck, AllPartsAck, KeepAck
VARIABLES pc, kind, day, runs, crashes, reported, pending, remaining,
          generated, sent, failed, delivered, recorded, current

vars == <<pc, kind, day, runs, crashes, reported, pending, remaining,
          generated, sent, failed, delivered, recorded, current>>
Modes == {"brief", "watch"}
Current(S) == {k \in Keys : <<k, day>> \in S}
BriefEligible == Keys \ reported
WatchEligible == {k \in Keys : k \notin reported}

Init ==
  /\ pc = "idle" /\ kind = "brief" /\ day = 0
  /\ runs = 0 /\ crashes = 0
  /\ reported = {} /\ pending = {} /\ remaining = {}
  /\ generated = {} /\ sent = {} /\ failed = {}
  /\ delivered = {} /\ recorded = {} /\ current = {}

Start(m) ==
  /\ pc = "idle" /\ runs < MaxRuns /\ m \in Modes
  /\ pc' = "observe" /\ kind' = m /\ runs' = runs + 1
  /\ pending' = {} /\ remaining' = {} /\ generated' = {}
  /\ sent' = {} /\ failed' = {} /\ current' = {}
  /\ UNCHANGED <<day, crashes, reported, delivered, recorded>>

Observe ==
  /\ pc = "observe"
  /\ reported' = IF kind = "watch" /\ ~KeepAck THEN {} ELSE reported
  /\ pc' = "claim"
  /\ UNCHANGED <<kind, day, runs, crashes, pending, remaining,
                  generated, sent, failed, delivered, recorded, current>>

Claim ==
  /\ pc = "claim"
  /\ pending' = IF kind = "brief" THEN BriefEligible ELSE WatchEligible
  /\ reported' = IF ClaimIsAck THEN reported \cup pending' ELSE reported
  /\ pc' = "generate"
  /\ UNCHANGED <<kind, day, runs, crashes, remaining, generated,
                  sent, failed, delivered, recorded, current>>

Generate(S) ==
  /\ pc = "generate" /\ S \subseteq pending
  /\ generated' = S /\ remaining' = S /\ pc' = "send"
  /\ UNCHANGED <<kind, day, runs, crashes, reported, pending,
                  sent, failed, delivered, recorded, current>>

Send(S, ok) ==
  /\ pc = "send" /\ S \subseteq remaining /\ S # {} /\ ok \in BOOLEAN
  /\ remaining' = remaining \ S
  /\ sent' = IF ok THEN sent \cup S ELSE sent
  /\ failed' = IF ok THEN failed ELSE failed \cup S
  /\ delivered' = IF ok THEN delivered \cup {<<k, day>> : k \in S} ELSE delivered
  /\ current' = IF ok THEN S ELSE {}
  /\ pc' = IF ok THEN "persist" ELSE "send"
  /\ UNCHANGED <<kind, day, runs, crashes, reported, pending,
                  generated, recorded>>

Persist ==
  /\ pc = "persist"
  /\ LET ack == IF AllPartsAck THEN generated ELSE current IN
       /\ reported' = reported \cup ack
       /\ recorded' = recorded \cup {<<k, day>> : k \in ack}
  /\ pc' = "send" /\ current' = {}
  /\ UNCHANGED <<kind, day, runs, crashes, pending, remaining,
                  generated, sent, failed, delivered>>

SaveFailure ==
  /\ pc = "persist" /\ pc' = "idle"
  /\ UNCHANGED <<kind, day, runs, crashes, reported, pending, remaining,
                  generated, sent, failed, delivered, recorded, current>>

Finish ==
  /\ pc = "send" /\ remaining = {} /\ pc' = "idle"
  /\ UNCHANGED <<kind, day, runs, crashes, reported, pending, remaining,
                  generated, sent, failed, delivered, recorded, current>>

Crash ==
  /\ pc # "idle" /\ crashes < MaxCrashes
  /\ pc' = "idle" /\ crashes' = crashes + 1
  /\ UNCHANGED <<kind, day, runs, reported, pending, remaining,
                  generated, sent, failed, delivered, recorded, current>>

NextDay ==
  /\ pc = "idle" /\ day = 0 /\ day' = 1 /\ reported' = {}
  /\ pending' = {} /\ remaining' = {} /\ generated' = {}
  /\ sent' = {} /\ failed' = {} /\ current' = {}
  /\ UNCHANGED <<pc, kind, runs, crashes, delivered, recorded>>

Next ==
  \/ \E m \in Modes : Start(m)
  \/ Observe \/ Claim
  \/ \E S \in SUBSET Keys : Generate(S)
  \/ \E S \in SUBSET Keys, ok \in BOOLEAN : Send(S, ok)
  \/ Persist \/ SaveFailure \/ Finish \/ Crash \/ NextDay

TypeOK ==
  /\ pc \in {"idle", "observe", "claim", "generate", "send", "persist"}
  /\ kind \in Modes /\ day \in 0..1
  /\ runs \in 0..MaxRuns /\ crashes \in 0..MaxCrashes
  /\ \A S \in {reported, pending, remaining, generated, sent, failed, current} : S \subseteq Keys
  /\ delivered \subseteq (Keys \X (0..1))
  /\ recorded \subseteq (Keys \X (0..1))

FailedSendCannotSuppress == reported \subseteq Current(delivered)
PartialOnlyDelivered == Current(recorded) \subseteq Current(delivered)
IntentIsNotAck == reported \subseteq Current(recorded)
AckSurvivesRestart == Current(recorded) \subseteq reported
BothReadersAgree ==
  /\ BriefEligible = WatchEligible
  /\ BriefEligible \cap Current(recorded) = {}
Spec == Init /\ [][Next]_vars
=======================================================================
