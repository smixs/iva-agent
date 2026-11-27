---- MODULE ColleagueHireLock ----
\* The Bridge's managed_bot handler and background reconciliation share a bot's
\* journal. The token in .env survives a failed journal phase write.
EXTENDS Naturals, FiniteSets

CONSTANTS EnforceHireLock, CompareBeforeWrite
ASSUME /\ EnforceHireLock \in BOOLEAN
       /\ CompareBeforeWrite \in BOOLEAN

Writers == {"handler", "reconcile"}
OpenPhases == {"token", "profile", "settings"}
Phases == OpenPhases \cup {"completed"}
Events == {1, 2}
Idle == [event |-> 0, phase |-> "idle"]

VARIABLES journal, seen, tokenEvent, completed, regressed

vars == <<journal, seen, tokenEvent, completed, regressed>>
Active == {w \in Writers : seen[w] # Idle}

NextPhase(phase) ==
  CASE phase = "token" -> "profile"
    [] phase = "profile" -> "settings"
    [] OTHER -> "completed"

Init ==
  /\ journal = [event |-> 1, phase |-> "token"]
  /\ seen = [w \in Writers |-> Idle]
  /\ tokenEvent = 0
  /\ completed = {}
  /\ regressed = FALSE

Begin(w) ==
  /\ w \notin Active
  /\ EnforceHireLock => Active = {}
  /\ journal.phase \in OpenPhases
  /\ seen' = [seen EXCEPT ![w] = journal]
  /\ UNCHANGED <<journal, tokenEvent, completed, regressed>>

\* A later managed_bot event can replace the previous event, including its
\* completed marker. The comparison includes both event id and source phase.
BeginNewEvent ==
  /\ "handler" \notin Active
  /\ EnforceHireLock => Active = {}
  /\ journal.event = 1
  /\ journal' = [event |-> 2, phase |-> "token"]
  /\ seen' = [seen EXCEPT !["handler"] = journal']
  /\ UNCHANGED <<tokenEvent, completed, regressed>>

StoreToken(w) ==
  /\ w \in Active
  /\ seen[w].phase = "token"
  /\ seen[w].event # tokenEvent
  /\ CompareBeforeWrite => seen[w] = journal
  /\ tokenEvent' = seen[w].event
  /\ UNCHANGED <<journal, seen, completed, regressed>>

Advance(w) ==
  /\ w \in Active
  /\ seen[w].phase \in OpenPhases
  /\ CompareBeforeWrite => seen[w] = journal
  /\ seen[w].phase = "token" => tokenEvent = seen[w].event
  /\ journal' = [seen[w] EXCEPT !.phase = NextPhase(@)]
  /\ seen' = [seen EXCEPT ![w] = journal']
  /\ completed' = IF journal'.phase = "completed"
                   THEN completed \cup {journal'.event} ELSE completed
  /\ regressed' = (regressed \/ (journal'.event \in completed /\ journal'.phase # "completed"))
  /\ UNCHANGED tokenEvent

\* A writer may stop after storing the token and before advancing the journal.
\* The next writer can then advance from token without storing it again.
End(w) ==
  /\ w \in Active
  /\ seen' = [seen EXCEPT ![w] = Idle]
  /\ UNCHANGED <<journal, tokenEvent, completed, regressed>>

Next ==
  BeginNewEvent \/ \E w \in Writers : Begin(w) \/ StoreToken(w) \/ Advance(w) \/ End(w)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ journal \in [event: Events, phase: Phases]
  /\ seen \in [Writers -> [event: Events \cup {0}, phase: Phases \cup {"idle"}]]
  /\ tokenEvent \in Events \cup {0}
  /\ completed \subseteq Events
  /\ regressed \in BOOLEAN

SingleHireWriter == Cardinality(Active) <= 1
CompleteNotOverwritten == ~regressed
====
