---- MODULE GoalCheck ----
\* Goal v3.5.1, sections 3 and 7. Every Commit is one helpers.json write.
\* HelperRun supplies bounded termination; HelperOutcome supplies Tell fairness.
\* Row ids are used once. Allocation/edit bounds restrict finite input prefixes.
\* bornEdit, claimed, actual and audit are independent observations, not CAS keys.
\* Environment assumption (ADR-0026): Watch/Brief/Insight/Reminder/Signal/Alert
\* follow the goal skill. A service request uses the owner's action authority
\* and is represented by WatchNudge/Owner* only when the skill permits it,
\* with every existing action guard preserved. Watch uses WatchNudge on an
\* active goal with check=0; Brief reads and other service turns preserve Goals
\* through stuttering steps. Owner* mutations require the owner's instruction
\* or tap. Caller role and skill compliance are assumptions of this boundary;
\* OnlyOwnerActs proves the resulting transitions under these assumptions.
\* Verdict's claimed guard assumes the ordinary tick creates its session after
\* Claim. Claim's ownerPending=0 guard remains a requirement on the code.
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS ActiveGoals, RowIds, MaxAlloc, MaxEdits, MaxOpen, MaxRows,
          Mode, Mutant, OpportunityFair, TrackSafety
Goals == {1, 2}
None == "none"
FailuresToPause == 2
DayMax == 2
RunningLimit == 3 \* HELPER_MAX_RUNNING; pending admission remains MaxOpen=3
Verdicts == {"quiet", "news", "done", "blocked"}
Outcomes == {"ok", "bad", "interrupted", "stopped"}
ASSUME ActiveGoals \subseteq Goals /\ ActiveGoals # {} /\ RowIds \subseteq 1..4 /\ RowIds # {}
ASSUME MaxAlloc \in 1..4 /\ MaxEdits \in 0..2 /\ MaxOpen = 3 /\ MaxRows = 5
ASSUME {OpportunityFair, TrackSafety} \subseteq BOOLEAN
ASSUME Mode \in {"check", "failure", "limits", "capacity", "day", "reserve"}
ASSUME Mutant \in {"none", "nodetach", "noclosed", "owner-time", "fail-default", "doublecheck",
  "pending-close", "require-done", "quiet-empty", "content-failure", "due-untold",
  "verdict-cas-goal", "no-reserve", "link-stop", "sweep-untold", "claim-detached", "nonormalize"}
EmptyGoal == [status |-> "absent", check |-> 0, verdict |-> None, verdictBy |-> 0,
  due |-> "none", arrived |-> FALSE, ownerNext |-> FALSE, failures |-> 0,
  expired |-> FALSE, checksDay |-> 0, checksToday |-> 0, edits |-> 0,
  allocated |-> 0, plan |-> None, pause |-> None]
EmptyRow == [goal |-> 0, phase |-> "unused", told |-> FALSE, stop |-> None,
  outcome |-> None, staleAtEnd |-> FALSE, bornEdit |-> 0, claimed |-> FALSE]
LoadedDayGoal == [EmptyGoal EXCEPT !.status="active", !.due="auto", !.arrived=TRUE,
  !.checksDay=1, !.checksToday=DayMax]
SafetyNames == {"ClaimOnlyActive", "DetachedChangesNothing", "OwnerNextKept",
  "ContentTold", "SilentBranches", "FailureCount", "UntoldKept", "OnlyOwnerActs", "OwnerPlace"}
VARIABLES s, audit
vars == <<s, audit>>
Rows(x) == {r \in RowIds : x.r[r].phase \notin {"unused", "removed"}}
Available(x) == {r \in RowIds : x.r[r].phase="unused"}
Pending(x) == {r \in Rows(x) : x.r[r].phase \in {"pending", "running"}}
Running(x) == {r \in Rows(x) : x.r[r].phase="running"}
Untold(x,g) == {r \in Rows(x) : x.r[r].goal=g /\ x.r[r].phase="outcome" /\ ~x.r[r].told}
Live(x,g) == {r \in Pending(x) : x.r[r].goal=g /\ x.r[r].stop=None}
OpenRows(x) == {r \in Rows(x) : x.r[r].phase # "closed"}
Exists(x,g) == x.g[g].status \in {"active", "proposed", "paused"}
Space(x) == Cardinality(Pending(x))+x.ownerPending < MaxOpen-1 /\
  Cardinality(Rows(x))+x.ownerRows < MaxRows-1
Detached(x,r) == ~Exists(x,x.r[r].goal) \/ x.g[x.r[r].goal].check # r
Rule(x,r,out) == CASE Detached(x,r) \/ out="stopped" -> 0
  [] x.g[x.r[r].goal].verdict="done" -> 1
  [] x.g[x.r[r].goal].verdict="news" -> 2
  [] x.g[x.r[r].goal].verdict="quiet" -> 3 [] OTHER -> 4
GoalData(x,g) == <<x.g[g].status, x.g[g].due, x.g[g].arrived,
  x.g[g].ownerNext, x.g[g].failures, x.g[g].plan, x.g[g].pause>>
Safe(x,y,a,g,r,n) == CASE n="ClaimOnlyActive" -> (a="Due" =>
  x.g[g].status="active" /\ x.g[g].check=0 /\ Untold(x,g)={} /\ ~x.quietHour /\
  (IF x.g[g].checksDay=x.day THEN x.g[g].checksToday ELSE 0)<DayMax /\ Space(x))
 [] n="DetachedChangesNothing" -> (a="Finalize" /\
  (Detached(x,r) \/ x.r[r].bornEdit # x.g[g].edits \/ y.r[r].outcome="stopped") =>
  GoalData(y,g)=GoalData(x,g))
 [] n="OwnerNextKept" -> (a="Finalize" /\ x.g[g].ownerNext /\ y.g[g].status="active" => y.g[g].due="owner")
 [] n="ContentTold" -> (a="Finalize" /\ Rule(x,r,y.r[r].outcome) \in {1,2} =>
  y.r[r].phase="outcome" /\ ~y.r[r].told /\ (x.g[g].verdict="done" => y.g[g].status="proposed"))
 [] n="SilentBranches" -> (a="Finalize" /\ (Rule(x,r,y.r[r].outcome) \in {0,3} \/
  (Rule(x,r,y.r[r].outcome)=4 /\ x.g[g].failures+1<FailuresToPause)) => y.r[r].phase="closed")
 [] n="FailureCount" -> (a="Finalize" => y.g[g].failures =
  CASE Rule(x,r,y.r[r].outcome)=4 -> x.g[g].failures+1
  [] Rule(x,r,y.r[r].outcome) \in {1,2,3} -> 0 [] OTHER -> x.g[g].failures)
 [] n="UntoldKept" -> (a="SweepRow" /\ r \in Untold(x,g) => y.r[r]=x.r[r])
 [] n="OnlyOwnerActs" -> (\A h \in Goals :
  ((y.g[h].status="removed" /\ x.g[h].status # "removed") \/
   (y.g[h].status="active" /\ x.g[h].status # "active")) =>
  a \in {"Start", "OwnerEdit", "OwnerResume", "OwnerClose"})
 [] n="OwnerPlace" -> (a="Due" => Cardinality(Pending(y))+y.ownerPending<=MaxOpen-1 /\
  Cardinality(Rows(y))+y.ownerRows<=MaxRows-1) [] OTHER -> FALSE
ReaderAccepts(x) == Mutant # "link-stop" \/ (\A g \in Goals :
  x.g[g].check # 0 => x.r[x.g[g].check].stop=None)
Commit(y,a,g,r) ==
 /\ s'=[y EXCEPT !.readable=ReaderAccepts(y)]
 /\ audit'=IF ~TrackSafety THEN audit ELSE
  [n \in SafetyNames |-> audit[n] /\ Safe(s,y,a,g,r,n)]
Init ==
 /\ \E owner \in (IF Mode="capacity" THEN {0,2} ELSE IF Mode="reserve" THEN {2} ELSE {0}) :
  s=[g |-> [g \in Goals |-> IF Mode="day" /\ g=1 THEN LoadedDayGoal ELSE EmptyGoal],
  r |-> [r \in RowIds |-> EmptyRow], day |-> 0, quietHour |-> FALSE,
  ownerPending |-> owner,
  ownerRows |-> IF owner>0 THEN owner ELSE IF Mode="capacity" THEN 1 ELSE 0,
  ownerAdded |-> FALSE, readable |-> TRUE, actual |-> [g \in Goals |-> 0]]
 /\ audit=[n \in SafetyNames |-> TRUE]
Start(g) ==
 /\ g \in ActiveGoals /\ s.g[g].status="absent"
 /\ Commit([s EXCEPT !.g[g]=[EmptyGoal EXCEPT !.status="active", !.due="owner",
  !.arrived=TRUE, !.ownerNext=TRUE, !.checksDay=s.day]],"Start",g,0)
NormalizeDay(g) ==
 /\ Exists(s,g) /\ s.g[g].checksDay # s.day /\ Mutant # "nonormalize"
 /\ Commit([s EXCEPT !.g[g].checksDay=s.day, !.g[g].checksToday=0],"NormalizeDay",g,0)
Due(g) ==
 /\ s.g[g].status="active" /\ s.g[g].arrived /\ ~s.g[g].expired /\ Mode # "limits"
 /\ (s.g[g].check=0 \/ Mutant="doublecheck") /\ (Untold(s,g)={} \/ Mutant="due-untold") /\ ~s.quietHour
 /\ (IF s.g[g].checksDay # s.day /\ Mutant # "nonormalize" THEN 0 ELSE s.g[g].checksToday)<DayMax
 /\ s.g[g].allocated<MaxAlloc /\ Available(s) # {}
 /\ (IF Mutant="no-reserve" THEN Cardinality(Pending(s))<MaxOpen /\ Cardinality(Rows(s))<MaxRows ELSE Space(s))
 /\ LET r == CHOOSE q \in Available(s) : TRUE IN
  Commit([s EXCEPT !.g[g].check=r, !.g[g].verdict=None, !.g[g].verdictBy=0,
   !.g[g].checksDay=IF Mutant="nonormalize" THEN @ ELSE s.day,
   !.g[g].checksToday=(IF s.g[g].checksDay # s.day /\ Mutant # "nonormalize" THEN 0 ELSE @)+1,
   !.g[g].allocated=@+1, !.g[g].due="auto", !.g[g].arrived=FALSE, !.g[g].ownerNext=FALSE,
   !.actual[g]=@+1, !.r[r]=[EmptyRow EXCEPT !.goal=g, !.phase="pending", !.bornEdit=s.g[g].edits]],"Due",g,r)
Claim(r) ==
 /\ Cardinality(Running(s))<RunningLimit /\ s.ownerPending=0
 /\ ((s.r[r].phase="pending" /\ s.r[r].stop=None) \/
  (Mutant="claim-detached" /\ s.r[r].phase="closed" /\ Detached(s,r)))
 /\ Commit([s EXCEPT !.r[r].phase="running", !.r[r].stop=None, !.r[r].claimed=TRUE],"Claim",s.r[r].goal,r)
Stop(r) ==
 /\ s.r[r].phase="running" /\ s.r[r].stop=None
 /\ Mode \notin {"capacity", "day", "failure"}
 /\ Commit([s EXCEPT !.r[r].stop="limit"],"Stop",s.r[r].goal,r)
Verdict(r,v) ==
 /\ s.r[r].claimed /\ v \in
  (IF Mode="failure" THEN {"blocked"} ELSE IF Mode="day" THEN {"quiet"}
   ELSE IF Mode="capacity" THEN {"quiet"} ELSE Verdicts)
 /\ LET g == s.r[r].goal IN
  /\ Exists(s,g) /\ (IF Mutant="verdict-cas-goal" THEN s.g[g].check # 0
     ELSE s.g[g].check=r /\ s.r[r].outcome=None)
  /\ Commit([s EXCEPT !.g[g].verdict=v, !.g[g].verdictBy=r],"Verdict",g,r)
ActualRule(r,out) == LET k == Rule(s,r,out) IN
  IF (Mutant="require-done" /\ k \in {1,2} /\ out # "ok") \/
     (Mutant="quiet-empty" /\ k=3 /\ out="interrupted") THEN 4 ELSE k
EndRow(x,r,out) == LET g == x.r[r].goal k == ActualRule(r,out)
  f == IF k=4 THEN x.g[g].failures+1 ELSE IF k=0 THEN x.g[g].failures ELSE 0
  status == IF k=0 THEN x.g[g].status ELSE IF k=1 THEN "proposed"
    ELSE IF k=4 /\ f>=FailuresToPause THEN "paused" ELSE "active"
  goal == [x.g[g] EXCEPT !.check=0, !.verdict=None, !.verdictBy=0,
    !.status=status, !.failures=IF Mutant="content-failure" /\ k=2 /\ out="bad" THEN 1 ELSE f,
    !.pause=IF k=4 /\ f>=FailuresToPause THEN "failures" ELSE @,
    !.plan=IF k \in {1,2,3} \/ (k=4 /\ x.g[g].verdict="blocked") THEN x.g[g].verdict ELSE @,
    !.due=IF k=0 THEN @ ELSE IF status # "active" THEN "none"
      ELSE IF Mutant="owner-time" \/ (Mutant="fail-default" /\ k=4) THEN "auto"
      ELSE IF k=4 \/ x.g[g].ownerNext THEN @ ELSE "auto",
    !.arrived=IF status="active" THEN @ ELSE FALSE]
  IN [x EXCEPT !.g[g]=IF x.g[g].check=r THEN goal ELSE @,
    !.r[r].phase=IF k \in {1,2} \/ (k=4 /\ f>=FailuresToPause) THEN "outcome" ELSE "closed",
    !.r[r].outcome=out, !.r[r].staleAtEnd=Detached(x,r) \/ x.r[r].bornEdit # x.g[g].edits]
Finalize(r,out) ==
 /\ s.r[r].phase="running"
 /\ out \in (IF s.r[r].stop="closed" THEN {"stopped"} ELSE IF s.r[r].stop="limit" THEN {"bad"}
    ELSE IF Mode="capacity" THEN {"ok"} ELSE {"ok", "bad", "interrupted"})
 /\ Commit(EndRow(s,r,out),"Finalize",s.r[r].goal,r)
CloseRow(x,r) == IF x.r[r].phase="pending" /\ Mutant # "pending-close" THEN
  [x.r[r] EXCEPT !.phase="closed", !.stop="closed", !.outcome="stopped"]
 ELSE [x.r[r] EXCEPT !.phase=IF @="outcome" THEN "closed" ELSE @,
  !.stop=IF x.r[r].phase \in {"pending", "running"} /\ @=None THEN "closed" ELSE @]
DetachRows(g,close) == [r \in RowIds |-> IF s.g[g].check=r \/
  (close /\ r \in Untold(s,g) /\ Mutant # "noclosed") THEN CloseRow(s,r) ELSE s.r[r]]
OwnerEdit(g) ==
 /\ Exists(s,g) /\ s.g[g].edits<MaxEdits
 /\ Commit([s EXCEPT !.r=DetachRows(g,FALSE), !.g[g].check=IF Mutant="nodetach" THEN @ ELSE 0,
  !.g[g].verdict=IF Mutant="nodetach" THEN @ ELSE None, !.g[g].verdictBy=IF Mutant="nodetach" THEN @ ELSE 0,
  !.g[g].status="active", !.g[g].pause=None, !.g[g].edits=@+1, !.g[g].plan="owner",
  !.g[g].failures=IF s.g[g].status \in {"paused", "proposed"} THEN 0 ELSE @,
  !.g[g].expired=IF s.g[g].status \in {"paused", "proposed"} THEN FALSE ELSE @,
  !.g[g].due="owner", !.g[g].ownerNext=TRUE, !.g[g].arrived=TRUE],"OwnerEdit",g,0)
OwnerResume(g) ==
 /\ s.g[g].status \in {"paused", "proposed"} /\ s.g[g].edits<MaxEdits
 /\ Commit([s EXCEPT !.g[g].status="active", !.g[g].pause=None, !.g[g].failures=0,
  !.g[g].expired=FALSE, !.g[g].due="owner", !.g[g].arrived=TRUE,
  !.g[g].ownerNext=TRUE, !.g[g].edits=@+1],"OwnerResume",g,0)
OwnerNextCheck(g) ==
 /\ s.g[g].status="active" /\ s.g[g].edits<MaxEdits
 /\ Commit([s EXCEPT !.g[g].due="owner", !.g[g].ownerNext=TRUE, !.g[g].arrived=FALSE,
  !.g[g].edits=@+1, !.r=[r \in RowIds |-> IF s.g[g].check=r THEN
   [s.r[r] EXCEPT !.bornEdit=s.g[g].edits+1] ELSE s.r[r]]],"OwnerNextCheck",g,0)
OwnerClose(g) ==
 /\ Exists(s,g) /\ Mode # "capacity"
 /\ Commit([s EXCEPT !.r=DetachRows(g,TRUE), !.g[g].status="removed", !.g[g].check=0,
  !.g[g].verdict=None, !.g[g].verdictBy=0, !.g[g].due="none", !.g[g].pause=None,
  !.g[g].arrived=FALSE],"OwnerClose",g,0)
OwnerHelperClose(r) ==
 /\ s.r[r].phase \in {"pending", "running", "outcome"}
 /\ LET g == s.r[r].goal IN Commit(IF s.r[r].phase="pending" THEN
  [EndRow(s,r,"stopped") EXCEPT !.r[r].stop="closed"] ELSE
  [s EXCEPT !.r[r]=CloseRow(s,r)],"OwnerHelperClose",g,r)
WatchNudge(g) ==
 /\ s.g[g].status="active" /\ s.g[g].check=0 /\ ~s.g[g].arrived
 /\ s.g[g].allocated<MaxAlloc /\ Available(s) # {}
 /\ Commit([s EXCEPT !.g[g].arrived=TRUE],"WatchNudge",g,0)
Expire(g) ==
 /\ s.g[g].status="active" /\ ~s.g[g].expired /\ Mode \notin {"capacity", "day", "failure"}
 /\ Commit([s EXCEPT !.g[g].expired=TRUE],"Expire",g,0)
PauseByExpiry(g) ==
 /\ s.g[g].status="active" /\ s.g[g].check=0 /\ s.g[g].expired
 /\ Commit([s EXCEPT !.g[g].status="paused", !.g[g].pause="expired",
  !.g[g].due="none", !.g[g].arrived=FALSE],"PauseByExpiry",g,0)
Arrive(g) ==
 /\ s.g[g].status="active" /\ ~s.g[g].arrived
 /\ s.g[g].allocated<MaxAlloc /\ Available(s) # {}
 /\ Commit([s EXCEPT !.g[g].arrived=TRUE],"Arrive",g,0)
Tell(r) ==
 /\ r \in Untold(s,s.r[r].goal)
 /\ Commit([s EXCEPT !.r[r].told=TRUE],"Tell",s.r[r].goal,r)
SweepRow(r) ==
 /\ s.r[r].phase \in {"closed", "outcome"}
 /\ (s.r[r].phase="closed" \/ s.r[r].told \/ Mutant="sweep-untold")
 /\ Commit([s EXCEPT !.r[r].phase="removed"],"SweepRow",s.r[r].goal,r)
DayPasses ==
 /\ Mode # "capacity" /\ Commit([s EXCEPT !.day=1-@, !.actual=[g \in Goals |-> 0]],"DayPasses",0,0)
QuietOn ==
 /\ Mode # "capacity" /\ ~s.quietHour /\ Commit([s EXCEPT !.quietHour=TRUE],"QuietOn",0,0)
QuietOff ==
 /\ Mode # "capacity" /\ s.quietHour /\ Commit([s EXCEPT !.quietHour=FALSE],"QuietOff",0,0)
OwnerRowAdd ==
 /\ ~s.ownerAdded /\ s.ownerRows+Cardinality(Rows(s))<MaxRows
 /\ s.ownerPending+Cardinality(Pending(s))<MaxOpen
 /\ Commit([s EXCEPT !.ownerRows=@+1, !.ownerPending=@+1, !.ownerAdded=TRUE],"OwnerRowAdd",0,0)
OwnerRowDrop ==
 /\ s.ownerRows>0
 /\ Commit([s EXCEPT !.ownerRows=@-1, !.ownerPending=IF @>0 THEN @-1 ELSE @],"OwnerRowDrop",0,0)
Next == DayPasses \/ QuietOn \/ QuietOff \/ OwnerRowAdd \/ OwnerRowDrop
 \/ (\E g \in Goals : Start(g) \/ NormalizeDay(g) \/ Due(g) \/ PauseByExpiry(g) \/ Expire(g) \/
  Arrive(g) \/ WatchNudge(g) \/ OwnerEdit(g) \/ OwnerResume(g) \/ OwnerNextCheck(g) \/ OwnerClose(g))
 \/ (\E r \in RowIds : Claim(r) \/ Stop(r) \/ OwnerHelperClose(r) \/ Tell(r) \/ SweepRow(r) \/
  (\E v \in Verdicts : Verdict(r,v)) \/ (\E out \in Outcomes : Finalize(r,out)))
Fair ==
 /\ (\A r \in RowIds : SF_vars(Claim(r)) /\ WF_vars(\E out \in Outcomes : Finalize(r,out)) /\
  WF_vars(Tell(r)) /\ WF_vars(SweepRow(r)))
 /\ (\A g \in ActiveGoals : WF_vars(PauseByExpiry(g)) /\
  (IF OpportunityFair THEN SF_vars(Due(g)) /\ SF_vars(NormalizeDay(g))
   ELSE WF_vars(Due(g)) /\ WF_vars(NormalizeDay(g))))
 /\ WF_vars(QuietOn) /\ WF_vars(QuietOff) /\ WF_vars(DayPasses) /\ WF_vars(OwnerRowDrop)
Spec == Init /\ [][Next]_vars /\ Fair
TypeOK ==
 /\ s.day \in {0,1} /\ {s.quietHour, s.ownerAdded, s.readable} \subseteq BOOLEAN
 /\ s.ownerPending \in 0..MaxOpen /\ s.ownerRows \in 0..MaxRows /\ s.ownerPending<=s.ownerRows
 /\ (\A g \in Goals : s.g[g].status \in {"absent", "active", "proposed", "paused", "removed"}
  /\ s.g[g].check \in RowIds \cup {0} /\ s.g[g].verdict \in Verdicts \cup {None}
  /\ s.g[g].verdictBy \in RowIds \cup {0} /\ s.g[g].due \in {"none", "owner", "auto"}
  /\ s.g[g].failures \in 0..FailuresToPause /\ s.g[g].checksDay \in {0,1}
  /\ s.g[g].checksToday \in 0..DayMax /\ s.g[g].allocated \in 0..MaxAlloc
  /\ s.g[g].edits \in 0..MaxEdits /\ s.g[g].plan \in Verdicts \cup {None, "owner"}
  /\ s.g[g].pause \in {None, "expired", "failures"}
  /\ {s.g[g].arrived, s.g[g].ownerNext, s.g[g].expired} \subseteq BOOLEAN
  /\ s.actual[g] \in 0..DayMax)
 /\ (\A r \in RowIds : s.r[r].goal \in Goals \cup {0}
  /\ s.r[r].phase \in {"unused", "pending", "running", "outcome", "closed", "removed"}
  /\ s.r[r].stop \in {None, "closed", "limit"} /\ s.r[r].outcome \in Outcomes \cup {None}
  /\ s.r[r].bornEdit \in 0..MaxEdits /\ {s.r[r].told, s.r[r].claimed, s.r[r].staleAtEnd} \subseteq BOOLEAN)
 /\ (\A n \in SafetyNames : audit[n] \in BOOLEAN)
StoreLinks == s.readable /\ (\A g \in Goals : /\ (s.g[g].due # "none") = (s.g[g].status="active")
 /\ (s.g[g].pause # None) = (s.g[g].status="paused") /\ (s.g[g].verdict # None => s.g[g].check # 0)
 /\ (s.g[g].check # 0 => s.r[s.g[g].check].goal=g /\
  s.r[s.g[g].check].phase \in {"pending", "running"}))
OneLiveCheck == \A g \in Goals : Cardinality(Live(s,g))<=1 /\ \A r \in Live(s,g) : s.g[g].check=r
OneUntoldPerGoal == \A g \in Goals : Cardinality(Untold(s,g))<=1
RemovedMeansSilent == \A g \in Goals : s.g[g].status="removed" => Untold(s,g)={}
RowsBounded == Cardinality(OpenRows(s))<=Cardinality(ActiveGoals)+1 /\
 Cardinality(Rows(s))+s.ownerRows<=MaxRows /\ Cardinality(Pending(s))+s.ownerPending<=MaxOpen
RowsBoundedReach == Cardinality(Rows(s))+s.ownerRows<MaxRows
DayCountBounded == \A g \in Goals : s.actual[g]<=DayMax
VerdictOwnCheck == \A g \in Goals : s.g[g].verdict # None => s.g[g].verdictBy=s.g[g].check
ClaimOnlyActive == audit["ClaimOnlyActive"]
DetachedChangesNothing == audit["DetachedChangesNothing"]
OwnerNextKept == audit["OwnerNextKept"]
ContentTold == audit["ContentTold"]
SilentBranches == audit["SilentBranches"]
FailureCount == audit["FailureCount"]
UntoldKept == audit["UntoldKept"]
OnlyOwnerActs == audit["OnlyOwnerActs"]
OwnerPlace == audit["OwnerPlace"]
CheckReleased == \A r \in RowIds : s.r[r].phase \in {"pending", "running"} ~>
 s.r[r].phase \in {"outcome", "closed", "removed"}
DueServed == \A g \in ActiveGoals : \A e \in 0..MaxEdits :
 (s.g[g].status="active" /\ s.g[g].arrived /\ s.g[g].edits=e /\
  s.g[g].allocated<MaxAlloc /\ Available(s) # {}) ~>
 (s.g[g].check # 0 \/ s.g[g].status # "active" \/ s.g[g].edits # e \/
  ~s.g[g].arrived \/ s.g[g].allocated=MaxAlloc \/ Available(s)={})
====
