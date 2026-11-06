--------------------------- MODULE HelperOutcome ---------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANT Mutant
Helpers == {"a", "b"}
Keep == 1
VARIABLES s, readPure
vars == <<s, readPure>>
Durable(x) == <<x.status, x.outcome, x.finishes, x.finished, x.deliveredAt, x.retained>>
\* Session/turn belongs to consumer memory; durable row holds only deliveredAt.
Ready(h) == s.status[h] = "finished" /\ s.deliveredAt[h] = 0
InitialState == [status |-> [h \in Helpers |-> "pending"],
  outcome |-> [h \in Helpers |-> FALSE], finishes |-> [h \in Helpers |-> 0],
  finished |-> [h \in Helpers |-> 0],
  deliveredAt |-> [h \in Helpers |-> 0], retained |-> Helpers,
  goal |-> [h \in Helpers |-> FALSE], admitted |-> FALSE, admittedGoal |-> FALSE, slotsReady |-> FALSE, evictedAt |-> 0,
  session |-> 1, reads |-> {}, previousReads |-> {}, readCounts |-> [h \in Helpers |-> 0],
  replied |-> FALSE, nonempty |-> FALSE, now |-> 0,
  proof |-> [h \in Helpers |-> TRUE],
  lostUnread |-> FALSE, sweptEarly |-> FALSE, readAuthorized |-> TRUE,
  bridge |-> "online", events |-> {}, offlineFinished |-> {}, bridgeReturned |-> FALSE]
InitCore == s = InitialState
Init == InitCore /\ readPure = TRUE
Finish(h) ==
  /\ s.status[h] = "pending" \/ (Mutant = "finish-twice" /\ s.finishes[h] = 1)
  /\ s' = [s EXCEPT !.status[h] = "finished", !.outcome[h] = TRUE,
       !.finishes[h] = @ + 1, !.finished[h] = s.now,
       !.events = IF s.bridge = "online" THEN @ \cup {h} ELSE @,
       !.offlineFinished = IF s.bridge = "offline" THEN @ \cup {h} ELSE @]
Read(h,actor) ==
  /\ actor = "owner" \/ Mutant = "foreign-read"
  /\ h \in s.retained /\ s.outcome[h] /\ ~s.replied /\ h \notin s.reads
  /\ s.readCounts[h] < 2
  /\ Mutant # "hide-unread"
  /\ s' = [s EXCEPT !.reads = @ \cup {h}, !.previousReads = @ \cup {h},
       !.readCounts[h] = @ + 1,
       !.deliveredAt[h] = IF Mutant = "read-write" THEN s.now + 1 ELSE @,
       !.readAuthorized = @ /\ actor = "owner"]
BridgeDown == /\ s.bridge = "online" /\ s' = [s EXCEPT !.bridge = "offline"]
BridgeUp ==
  /\ s.bridge = "offline"
  /\ s' = [s EXCEPT !.bridge = IF Mutant = "bridge-stays-down" THEN "offline" ELSE "online",
       !.events = {}, !.bridgeReturned = TRUE]
Reply(nonempty) ==
  /\ ~s.replied
  /\ s' = [s EXCEPT !.replied = TRUE, !.nonempty = nonempty]
Mark(h) ==
  /\ Ready(h)
  /\ (h \in s.reads) \/ Mutant = "without-read" \/
       (Mutant = "turn-only" /\ h \in s.previousReads /\ s.session = 2)
  /\ (s.replied /\ s.nonempty) \/ Mutant = "before-reply" \/
       (Mutant = "empty-reply" /\ s.replied)
  /\ s' = [s EXCEPT !.deliveredAt[h] = s.now + 1,
       !.proof[h] = s.replied /\ s.nonempty /\ h \in s.reads]
Restart ==
  /\ s.session = 1
  /\ s' = [s EXCEPT !.session = 2, !.reads = {}, !.replied = FALSE, !.nonempty = FALSE]
Close(h) ==
  /\ h \in s.retained /\ s.status[h] \in {"pending", "finished"}
  /\ s.deliveredAt[h] = 0 \/ ~s.goal[h] \/ Mutant = "close-goal"
  /\ s' = IF s.deliveredAt[h] # 0 THEN [s EXCEPT !.retained = @ \ {h}]
       ELSE [s EXCEPT !.status[h] = "closed", !.outcome[h] = TRUE,
         !.finished[h] = IF s.outcome[h] THEN @ ELSE s.now]
Clock == /\ s.now < 2 /\ s' = [s EXCEPT !.now = @ + 1]
Sweep(h) ==
  /\ h \in s.retained
  /\ (s.status[h] = "closed" /\ s.now >= s.finished[h] + Keep)
      \/ (s.deliveredAt[h] # 0 /\ s.now + 1 >= s.deliveredAt[h] + Keep)
      \/ (Mutant = "lose-unread" /\ Ready(h))
      \/ (Mutant = "early-close" /\ s.status[h] = "closed")
  /\ s' = [s EXCEPT !.retained = @ \ {h},
       !.lostUnread = @ \/ Ready(h),
       !.sweptEarly = @ \/ (s.status[h] = "closed" /\ s.now < s.finished[h] + Keep)]
NextCore == (\E h \in Helpers : Finish(h) \/ (\E actor \in {"owner","unknown","helper"} : Read(h,actor))
          \/ Mark(h) \/ Close(h) \/ Sweep(h))
        \/ (\E b \in BOOLEAN : Reply(b)) \/ Restart \/ Clock \/ BridgeDown \/ BridgeUp
ObserveRead == readPure' = (readPure /\
  ((\E h \in Helpers, actor \in {"owner","unknown","helper"} : Read(h,actor)) => Durable(s') = Durable(s)))
Next == NextCore /\ ObserveRead
Spec == Init /\ [][Next]_vars
\* A finished offline remains available to Read; only B, finished after recovery, emits an event.
BridgeRecoveryNext ==
  \/ (s.status["a"] = "pending" /\ ~s.bridgeReturned /\ BridgeDown)
  \/ (s.bridge = "offline" /\ s.status["a"] = "pending" /\ Finish("a"))
  \/ (s.status["a"] = "finished" /\ ~s.bridgeReturned /\ BridgeUp)
  \/ (s.bridgeReturned /\ s.status["b"] = "pending" /\ Finish("b"))
BridgeRecoverySpec == Init /\ [][BridgeRecoveryNext /\ ObserveRead]_vars
BridgeRecovered == s.bridgeReturned => s.bridge = "online"
RecoveredDelivery == s.status["b"] = "finished" => "b" \in s.events
OfflineNotReplayed == "a" \in s.offlineFinished => "a" \notin s.events
NoRecoveryComplete == ~("a" \in s.offlineFinished /\ "b" \in s.events)
TypeOK == /\ s.session \in {1,2} /\ s.now \in 0..2
          /\ s.retained \subseteq Helpers /\ s.reads \subseteq Helpers
          /\ \A h \in Helpers : s.status[h] \in {"pending","finished","closed"}
OutcomeOnce == \A h \in Helpers : s.finishes[h] <= 1
DeliveredAfterReply == \A h \in Helpers : s.deliveredAt[h] # 0 => s.proof[h]
UndeliveredKept == ~s.lostUnread
Visible == \A h \in Helpers : Ready(h) /\ h \in s.retained /\ ~s.replied /\
  h \notin s.reads /\ s.readCounts[h] < 2 => ENABLED Read(h,"owner")
ClosedKept == ~s.sweptEarly
ReadPure == readPure
ClosedFinal == \A h \in Helpers : s.status[h] = "closed" => s.outcome[h]
\* Reachability witnesses: multiple outcomes and repeated reading after restart are accepted.
NoTwoReads == Cardinality(s.reads) < 2
NoRepeatedRead == \A h \in Helpers : s.readCounts[h] < 2
AuthorizedReads == s.readAuthorized
OfflineEvent == s.offlineFinished \subseteq s.events

\* Admission and delivered close belong here; HelperRun ends before delivery.
\* Two old rows model a full table; admitted represents the new pending row.
SlotInit == /\ readPure = TRUE
  /\ \E status \in [Helpers -> {"pending", "finished", "closed"}],
        delivered \in [Helpers -> 0..2], goal \in [Helpers -> BOOLEAN] :
    /\ \A h \in Helpers : delivered[h] # 0 => status[h] = "finished"
    /\ s = [InitialState EXCEPT !.status = status, !.deliveredAt = delivered,
         !.outcome = [h \in Helpers |-> status[h] # "pending"],
         !.finished = [h \in Helpers |-> 1], !.goal = goal]
Evictable(h) == ~s.goal[h] /\ (s.deliveredAt[h] # 0 \/
  (s.status[h] = "closed" /\ Mutant # "evict-closed-blocked"))
EvictionTime(h) == IF s.deliveredAt[h] # 0 THEN s.deliveredAt[h] ELSE s.finished[h]
EvictForStart(h) ==
  /\ ~s.admitted /\ s.retained = Helpers
  /\ Evictable(h)
      \/ (Mutant = "evict-unread" /\ ~s.goal[h])
      \/ (Mutant = "evict-goal" /\ s.deliveredAt[h] # 0)
  /\ Mutant = "evict-newest" \/ \A other \in s.retained : Evictable(other)
       => EvictionTime(h) <= EvictionTime(other)
  /\ s' = [s EXCEPT !.retained = @ \ {h}, !.admitted = TRUE,
       !.evictedAt = EvictionTime(h)]
EvictForGoal ==
  /\ ~s.admitted /\ s.retained = Helpers /\ Mutant # "goal-no-eviction"
  /\ \A h \in Helpers : Evictable(h) \/ Mutant = "goal-evict-unread"
  /\ s' = [s EXCEPT !.retained = {}, !.admitted = TRUE, !.admittedGoal = TRUE]
SlotNext == /\ ~s.admitted
  /\ (IF ~s.slotsReady THEN s' = [s EXCEPT !.slotsReady = TRUE]
       ELSE ((\E h \in Helpers : EvictForStart(h) \/ Close(h)) \/ EvictForGoal))
  /\ UNCHANGED readPure
SlotSpec == SlotInit /\ [][SlotNext]_vars
ProtectedKept == \A h \in Helpers : ((s.deliveredAt[h] = 0 /\ s.status[h] # "closed") \/ s.goal[h]) => h \in s.retained
OldestEvicted == s.admitted => \A h \in s.retained : Evictable(h)
  => s.evictedAt <= EvictionTime(h)
AdmissionAvailable == (s.slotsReady /\ ~s.admitted /\ s.retained = Helpers /\
  (\E h \in Helpers : Evictable(h))) => ENABLED (\E h \in Helpers : EvictForStart(h))
GoalAdmissionAvailable == (s.slotsReady /\ ~s.admitted /\ s.retained = Helpers /\
  (\A h \in Helpers : ~s.goal[h] /\ (s.deliveredAt[h] # 0 \/ s.status[h] = "closed"))) => ENABLED EvictForGoal
ClosedAdmissionAvailable == (s.slotsReady /\ ~s.admitted /\ s.retained = Helpers /\
  (\E h \in Helpers : ~s.goal[h] /\ s.status[h] = "closed")) => ENABLED (\E h \in Helpers : EvictForStart(h))
SlotCapacity == Cardinality(s.retained) + (IF s.admitted THEN 1 ELSE 0) + (IF s.admittedGoal THEN 1 ELSE 0) <= 2
NoAdmission == ~s.admitted
NoDeliveredClose == \A h \in Helpers : s.deliveredAt[h] # 0 => h \in s.retained
=============================================================================
