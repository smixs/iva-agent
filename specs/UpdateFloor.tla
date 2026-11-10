----------------------------- MODULE UpdateFloor -----------------------------
(* The oldest release an update is taken from: `minUpdater` in update-compat.json.
   One installation runs one update onto a tree that names a floor. The old half is the
   CLI already on disk: from 0.3.30 it reads the marker before its first write; 0.3.15 to
   0.3.29 do not know the marker and hand off to the new half all the same. The new half
   is the first code of the new tree to run on the machine. Once the new tree serves, it
   meets one state file that only releases below the floor wrote.
   Outside the model: repair.sh on a checkout (it resets the tree before any CLI runs)
   and the in-place updater before 0.3.15, which never hands off. *)
CONSTANTS
  FinishChecks,  \* the new half refuses an installation below the floor
  CheckFirst,    \* the old half reads the marker before it unpacks anything
  Says,          \* a refusal names the release and the way out
  Readers        \* what the new code may do with an old-format file

VARIABLES below, readsMarker, oldFormat, pc, serving, unpacked, told, file

vars == <<below, readsMarker, oldFormat, pc, serving, unpacked, told, file>>

Init ==
  /\ below \in BOOLEAN
  /\ readsMarker \in BOOLEAN
  /\ oldFormat \in BOOLEAN
  /\ pc = "start"
  /\ serving = "old"
  /\ unpacked = FALSE
  /\ told = FALSE
  /\ file = "intact"

Refuse ==
  /\ pc' = "refused"
  /\ told' = Says
  /\ UNCHANGED <<below, readsMarker, oldFormat, serving, unpacked, file>>

Step(next) ==
  /\ pc' = next
  /\ UNCHANGED <<below, readsMarker, oldFormat, serving, unpacked, told, file>>

Gated == readsMarker /\ below

(* scripts/lib/version-update.ts, runVersionUpdate: the last step before store.stage. *)
OldHalfChecks ==
  /\ pc = "start"
  /\ IF CheckFirst /\ Gated THEN Refuse ELSE Step("fetched")

OldHalfUnpacks ==
  /\ pc = "fetched"
  /\ unpacked' = TRUE
  /\ pc' = IF ~CheckFirst /\ Gated THEN "late" ELSE "handoff"
  /\ UNCHANGED <<below, readsMarker, oldFormat, serving, told, file>>

LateRefusal == pc = "late" /\ Refuse

(* scripts/update-finish.ts, main: before the lock is adopted and before any build. *)
NewHalfChecks ==
  /\ pc = "handoff"
  /\ IF FinishChecks /\ below THEN Refuse ELSE Step("finishing")

Quiesce ==
  /\ pc = "finishing"
  /\ serving' = "none"
  /\ pc' = "stopped"
  /\ UNCHANGED <<below, readsMarker, oldFormat, unpacked, told, file>>

Flip ==
  /\ pc = "stopped"
  /\ serving' = "new"
  /\ pc' = "served"
  /\ UNCHANGED <<below, readsMarker, oldFormat, unpacked, told, file>>

(* The new code meets the file: it refuses by name, leaves the bytes alone, or drops them. *)
Read ==
  /\ pc = "served"
  /\ oldFormat
  /\ file = "intact"
  /\ \E how \in Readers :
       file' = CASE how = "refuse" -> "refused"
                 [] how = "leave" -> "intact"
                 [] OTHER -> "lost"
  /\ pc' = "read"
  /\ UNCHANGED <<below, readsMarker, oldFormat, serving, unpacked, told>>

Next ==
  \/ OldHalfChecks \/ OldHalfUnpacks \/ LateRefusal \/ NewHalfChecks
  \/ Quiesce \/ Flip \/ Read

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

(* Invariant 1: an installation below the floor keeps serving its own release. *)
StaysOnItsRelease == below => serving = "old"
(* A CLI that reads the marker stops before its first write. *)
NothingWritten == (pc = "refused" /\ readsMarker) => ~unpacked
RefusedIsTold == pc = "refused" => told
(* Invariant 2: an old-format file is refused by name or left as it was. *)
NoSilentLoss == file # "lost"
(* Invariant 3: at the floor and above the update ends on the new release. *)
Served == ~below ~> serving = "new"
=============================================================================
