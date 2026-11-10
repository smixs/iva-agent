----------------------------- MODULE UpdateFloor -----------------------------
(* The oldest release an update is taken from: `minUpdater` in update-compat.json.
   One installation, three classes of the updater already on its disk:
     "marker"  - from 0.3.30: reads the marker before its first write;
     "handoff" - 0.3.15 to 0.3.29: unpacks the new tree and hands off to its new half
                 without knowing the marker;
     "inplace" - 0.3.7 to 0.3.14: builds a candidate of the new tree beside the checkout
                 (`npm ci` there is the first code of the new tree to run) and only then
                 moves the checkout onto it.
   An update aims at the newest release, or at the step release while repair.sh has the
   Update branch pinned to it. The step release is the last one that takes an update
   from every release below the floor. Once the new tree serves, it meets one file that
   only releases below the floor wrote and one that a release at the floor or above wrote.
   Outside the model: the updater of 0.3.0 to 0.3.6, which moves the checkout and
   replaces node_modules before any code of the new tree runs; a failed fetch or build
   (the updater's own rollback); a kill in the middle of one
   update. *)
CONSTANTS
  FinishChecks,   \* the new half refuses an installation below the floor
  FinishFirst,    \* ... as its first act, before services are stopped
  CheckFirst,     \* a CLI that reads the marker reads it before it unpacks anything
  InstallChecks,  \* `npm ci` of the tree refuses an in-place candidate below the floor
  Says,           \* a refusal names the release and the way out
  Steps,          \* repair takes an installation below the floor through the step release
  SavesBranch,    \* repair records the owner's Update branch before it pins the step
  OldReaders,     \* what the new code may do with a file only older releases wrote
  LiveReaders     \* ... with a file a release at the floor or above wrote

VARIABLES
  below,     \* the installed release is below the floor
  class,     \* the updater of the installed release
  oldFormat, \* a file only releases below the floor wrote is on disk
  cli,       \* the release whose updater runs: "old" or "step"
  serving,   \* the release that serves: "old", "step", "new", or "none" between two
  aim,       \* what the running update installs: fixed when it starts
  pc, unpacked, staging, told,
  branch,    \* the Update branch: the owner's "own" or the pinned "step"
  saved,     \* repair's record of the owner's branch
  repair,    \* "none", "step" (pinned), "cut" (killed), "return" (branch back), "done"
  cut,       \* repair was killed once
  oldFile, liveFile

vars == <<below, class, oldFormat, cli, serving, aim, pc, unpacked, staging, told,
          branch, saved, repair, cut, oldFile, liveFile>>

Init ==
  /\ below \in BOOLEAN
  /\ class \in IF below THEN {"marker", "handoff", "inplace"} ELSE {"marker"}
  /\ oldFormat \in BOOLEAN
  /\ cli = "old"
  /\ serving = "old"
  /\ aim = "new"
  /\ pc = "idle"
  /\ unpacked = FALSE
  /\ staging = FALSE
  /\ told = FALSE
  /\ branch = "own"
  /\ saved = FALSE
  /\ repair = "none"
  /\ cut = FALSE
  /\ oldFile = "intact"
  /\ liveFile = "intact"

Branch == IF branch = "step" THEN "step" ELSE "new"
Class == IF cli = "old" THEN class ELSE "marker"
(* The floor is the new tree's: the step release takes an update from all of them. *)
Kept(to) == cli = "old" /\ below /\ to = "new"

Refuse ==
  /\ pc' = "refused"
  /\ told' = Says
  /\ UNCHANGED <<below, class, oldFormat, aim, cli, serving, unpacked, branch, saved,
                 repair, cut, oldFile, liveFile>>

Step(next) ==
  /\ pc' = next
  /\ UNCHANGED <<below, class, oldFormat, aim, cli, serving, unpacked, staging, told,
                 branch, saved, repair, cut, oldFile, liveFile>>

(* `iva update`. scripts/lib/version-update.ts, runVersionUpdate: a CLI that reads the
   marker does it as the last step before store.stage. *)
OldHalfChecks ==
  /\ pc = "idle"
  /\ serving \in {"old", "step"}
  /\ serving # Branch
  /\ aim' = Branch
  /\ UNCHANGED <<below, class, oldFormat, cli, serving, unpacked, branch, saved,
                 repair, cut, oldFile, liveFile>>
  /\ CASE Class = "inplace" -> staging' = TRUE /\ pc' = "candidate" /\ UNCHANGED told
       [] Class = "marker" /\ CheckFirst /\ Kept(Branch) ->
            pc' = "refused" /\ told' = Says /\ UNCHANGED staging
       [] OTHER -> pc' = "fetched" /\ UNCHANGED <<staging, told>>

OldHalfUnpacks ==
  /\ pc = "fetched"
  /\ unpacked' = TRUE
  /\ pc' = IF Class = "marker" /\ ~CheckFirst /\ Kept(aim) THEN "late" ELSE "handoff"
  /\ UNCHANGED <<below, class, oldFormat, aim, cli, serving, staging, told, branch, saved,
                 repair, cut, oldFile, liveFile>>

LateRefusal == pc = "late" /\ Refuse /\ UNCHANGED staging

(* scripts/floor-guard.ts, the `preinstall` of package.json: the candidate's `npm ci`
   fails, and the in-place updater removes its candidate and stays where it was. *)
InPlaceCandidate ==
  /\ pc = "candidate"
  /\ staging' = FALSE
  /\ IF InstallChecks /\ Kept(aim)
       THEN Refuse
       ELSE /\ serving' = aim
            /\ pc' = "idle"
            /\ UNCHANGED <<below, class, oldFormat, aim, cli, unpacked, told, branch, saved,
                           repair, cut, oldFile, liveFile>>

(* scripts/update-finish.ts, main: before the lock is adopted and before any build. *)
NewHalfChecks ==
  /\ pc = "handoff"
  /\ IF FinishChecks /\ FinishFirst /\ Kept(aim)
       THEN Refuse /\ UNCHANGED staging
       ELSE Step("finishing")

Quiesce ==
  /\ pc = "finishing"
  /\ serving' = "none"
  /\ pc' = "stopped"
  /\ UNCHANGED <<below, class, oldFormat, aim, cli, unpacked, staging, told, branch, saved,
                 repair, cut, oldFile, liveFile>>

Flip ==
  /\ pc = "stopped"
  /\ IF FinishChecks /\ ~FinishFirst /\ Kept(aim)
       THEN Refuse /\ UNCHANGED staging
       ELSE /\ serving' = aim
            \* The updater on disk is the step release's from here on; the release that
            \* put the new tree in place stays on record.
            /\ cli' = IF aim = "step" THEN "step" ELSE cli
            /\ unpacked' = FALSE
            /\ pc' = "idle"
            /\ UNCHANGED <<below, class, oldFormat, aim, staging, told, branch, saved,
                           repair, cut, oldFile, liveFile>>

(* repair.sh on an installation below the floor: the Update branch goes to the step
   release, the owner's branch is put on record first. A checkout is reset onto the
   step release, so its updater is the one that runs. *)
RepairPins ==
  /\ repair = "none"
  /\ pc \in {"idle", "refused"}
  /\ below /\ serving = "old"
  /\ pc' = "idle"
  /\ IF Steps
       THEN /\ saved' = SavesBranch
            /\ branch' = "step"
            /\ repair' = "step"
            /\ cli' = IF class = "inplace" THEN "step" ELSE cli
       ELSE /\ repair' = "return"
            /\ UNCHANGED <<saved, branch, cli>>
  /\ UNCHANGED <<below, class, oldFormat, aim, serving, unpacked, staging, told, cut,
                 oldFile, liveFile>>

RepairReturns ==
  /\ repair = "step"
  /\ pc = "idle"
  /\ serving = "step"
  /\ branch' = "own"
  /\ saved' = FALSE
  /\ repair' = "return"
  /\ UNCHANGED <<below, class, oldFormat, aim, cli, serving, pc, unpacked, staging, told,
                 cut, oldFile, liveFile>>

RepairDone ==
  /\ repair = "return"
  /\ pc = "idle"
  /\ serving = "new"
  /\ repair' = "done"
  /\ UNCHANGED <<below, class, oldFormat, aim, cli, serving, pc, unpacked, staging, told,
                 branch, saved, cut, oldFile, liveFile>>

(* repair.sh is killed between two updates, with no chance to put the branch back. *)
Interrupt ==
  /\ repair = "step"
  /\ pc = "idle"
  /\ ~cut
  /\ cut' = TRUE
  /\ repair' = "cut"
  /\ UNCHANGED <<below, class, oldFormat, aim, cli, serving, pc, unpacked, staging, told,
                 branch, saved, oldFile, liveFile>>

(* repair.sh again: the record puts the owner's branch back before anything else. *)
Rerun ==
  /\ repair = "cut"
  /\ branch' = IF saved THEN "own" ELSE branch
  /\ saved' = FALSE
  /\ repair' = IF serving = "old" THEN "none" ELSE "return"
  /\ UNCHANGED <<below, class, oldFormat, aim, cli, serving, pc, unpacked, staging, told,
                 cut, oldFile, liveFile>>

(* The new code meets a file only older releases wrote: it refuses it by name, leaves
   the bytes alone, or drops them. *)
ReadOld ==
  /\ pc = "idle" /\ serving = "new"
  /\ oldFormat /\ oldFile = "intact"
  /\ \E how \in OldReaders :
       oldFile' = CASE how = "refuse" -> "refused"
                    [] how = "leave" -> "intact"
                    [] OTHER -> "lost"
  /\ UNCHANGED <<below, class, oldFormat, aim, cli, serving, pc, unpacked, staging, told,
                 branch, saved, repair, cut, liveFile>>

(* ... and a file a release at the floor or above wrote: it serves what the file holds,
   or moves the record out of the working file. *)
ReadLive ==
  /\ pc = "idle" /\ serving = "new"
  /\ liveFile = "intact"
  /\ \E how \in LiveReaders :
       liveFile' = IF how = "serve" THEN "served" ELSE "quarantined"
  /\ UNCHANGED <<below, class, oldFormat, aim, cli, serving, pc, unpacked, staging, told,
                 branch, saved, repair, cut, oldFile>>

Next ==
  \/ OldHalfChecks \/ OldHalfUnpacks \/ LateRefusal \/ InPlaceCandidate
  \/ NewHalfChecks \/ Quiesce \/ Flip
  \/ RepairPins \/ RepairReturns \/ RepairDone \/ Interrupt \/ Rerun
  \/ ReadOld \/ ReadLive

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

(* Invariant 1: the new release is put in place only by an updater at the floor or
   above: an installation below the floor reaches it through the step release alone. *)
StaysOnItsRelease == (below /\ serving = "new") => cli = "step"
(* A CLI that reads the marker stops before its first write; an in-place updater has
   removed its candidate by the time it reports. *)
NothingWritten == pc = "refused" => (Class = "marker" => ~unpacked) /\ ~staging
(* 0.3.15 to 0.3.29 are refused after the unpack: the unpacked version directory is the
   one thing written, and what serves is what served. *)
OnlyTheVersionDirectory == pc = "refused" => serving = "old"
RefusedIsTold == pc = "refused" => told
(* Invariant 2: a file only older releases wrote is refused by name or left as it was. *)
NoSilentLoss == oldFile # "lost"
(* A file a release at the floor or above wrote is read and served as it was before. *)
SupportedIsServed == liveFile \in {"intact", "served"}
(* The owner's Update branch is never forgotten, and is back once repair is over. *)
BranchKept ==
  /\ branch = "step" => saved
  /\ repair \in {"none", "return", "done"} => branch = "own"
(* Invariant 3: at the floor and above the update ends on the new release. *)
Served == ~below ~> serving = "new"
(* Repair, killed once or not, ends on the new release with the owner's branch back. *)
Repaired == repair # "none" ~> (serving = "new" /\ branch = "own")
=============================================================================
