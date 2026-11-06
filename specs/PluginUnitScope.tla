------------------------ MODULE PluginUnitScope ------------------------
EXTENDS Naturals, FiniteSets
CONSTANT BadGlobalCleanup
Actors == {"A", "B"}
Units == {"LA", "SA", "LB", "SB", "Unknown", "Collision", "Link", "LoadedForeign", "OverwrittenLegacy", "UnloadedScoped", "UnloadedLegacy"}
Legacy(i) == IF i = "A" THEN "LA" ELSE "LB"
Scoped(i) == IF i = "A" THEN "SA" ELSE "SB"
Reps(i) == {Legacy(i), Scoped(i)}
Key(u) == CASE u \in {"LA","SA"} -> "plugin-a"
          [] u \in {"LB","SB"} -> "plugin-b" [] OTHER -> u
Data(i) == IF i = "A" THEN "/data/a" ELSE "/data/b"
Scope(i) == IF i = "A" THEN "hash-a" ELSE "hash-b"
Port(i) == IF i = "A" THEN 11 ELSE 22
None == "none"

(* Ground truth belongs only to invariant evaluation, never to the classifier.
   LoadedForeign/OverwrittenLegacy already have an A file over a B process. *)
TrueFile == [u \in Units |-> IF u \in {"LA", "SA", "LoadedForeign", "OverwrittenLegacy", "UnloadedScoped", "UnloadedLegacy"} THEN "A" ELSE "B"]
TrueProcess == [u \in Units |-> IF u \in {"LA", "SA", "UnloadedScoped", "UnloadedLegacy"} THEN "A" ELSE "B"]

(* Independently observable fixed fields of bounded fixture bodies and queries.
   Port stands for the plugins.json port. FileData stands for validated service
   WorkingDirectory/PLUGIN_DATA or MCP data/token. LoadedData stands for the
   narrow manager WorkingDirectory or loaded MCP data/token/port proof. *)
FileData == [u \in Units |-> CASE u \in {"LA", "SA", "Link", "LoadedForeign", "OverwrittenLegacy", "UnloadedScoped", "UnloadedLegacy"} -> "/data/a"
                            [] u = "Unknown" -> "unreadable" [] OTHER -> "/data/b"]
LoadedData == [u \in Units |-> CASE u \in {"LA", "SA", "UnloadedScoped", "UnloadedLegacy"} -> "/data/a"
                              [] u = "Unknown" -> "unreadable" [] OTHER -> "/data/b"]
FilePort == [u \in Units |-> IF FileData[u] = "/data/a" THEN 11 ELSE 22]
NameScope == [u \in Units |-> CASE u \in {"SA", "Collision", "Link", "LoadedForeign", "UnloadedScoped"} -> "hash-a"
                             [] u = "SB" -> "hash-b" [] OTHER -> "legacy"]
MarkerScope == [u \in Units |-> IF FileData[u] = "/data/a" THEN "hash-a" ELSE "hash-b"]
Regular == [u \in Units |-> u # "Link"]
PayloadValid == [u \in Units |-> u # "Unknown"]
InitialPresent == Units \ {"SA", "SB"}
InitialActive == InitialPresent \ {"UnloadedScoped", "UnloadedLegacy"}
InitialMarked == {"Collision", "Link", "LoadedForeign", "UnloadedScoped"}
BadFixtures == {"Unknown", "Collision", "Link", "LoadedForeign", "OverwrittenLegacy"}

VARIABLES present, active, loaded, marked, wanted, armed, effect, codeVersion
vars == <<present, active, loaded, marked, wanted, armed, effect, codeVersion>>
EmptyEffect == [actor |-> None, files |-> {}, controls |-> {}, startedData |-> None]
Init == /\ present = InitialPresent /\ active = InitialActive
        /\ loaded = InitialActive /\ marked = InitialMarked /\ wanted = [i \in Actors |-> TRUE]
        /\ armed = [i \in Actors |-> TRUE] /\ effect = EmptyEffect
        /\ codeVersion = 0

(* Only evidence is read here. A removed state entry cannot authorize an
   unmarked legacy; a marked stale unit still decodes its own key/data. *)
DiskProof(i,u) == /\ u \in present /\ Regular[u] /\ PayloadValid[u]
                  /\ FileData[u] = Data(i) /\ FilePort[u] = Port(i)
                  /\ IF u \in marked
                        THEN /\ MarkerScope[u] = Scope(i)
                             /\ NameScope[u] \in {"legacy", Scope(i)}
                        ELSE /\ NameScope[u] = "legacy" /\ wanted[i]
(* loaded is the observed manager LoadState. Data fields are evidence only when
   loaded; absence (launchd print 113 / systemd not-found) is not a data mismatch. *)
LoadState(u) == IF u = "Unknown" THEN "unknown"
                ELSE IF u \in loaded THEN "loaded" ELSE "not-found"
LoadedProof(i,u) == /\ LoadState(u) = "loaded" /\ LoadedData[u] = Data(i)
Owned(i,u) == /\ DiskProof(i,u)
              /\ IF NameScope[u] = "legacy" THEN LoadedProof(i,u)
                    ELSE (LoadState(u) = "not-found" \/ LoadedProof(i,u))
RemovalProof(i,u) == /\ Owned(i,u)
                      /\ (LoadState(u) = "not-found" \/ LoadedProof(i,u))
Actual(i,k) == LET choices == {u \in Units: Key(u) = k /\ Owned(i,u)}
             IN IF Cardinality(choices) = 1 THEN CHOOSE u \in choices: TRUE ELSE None
Audit(i,files,controls,data) ==
    effect' = [actor |-> i, files |-> files, controls |-> controls, startedData |-> data]

(* Only marker bytes change; there is no service-control effect. *)
Adopt(i,u) == /\ Actual(i,Key(u)) = u /\ NameScope[u] = "legacy"
              /\ u \notin marked /\ u \in active /\ wanted[i]
              /\ marked' = marked \cup {u} /\ Audit(i,{u},{},None)
              /\ UNCHANGED <<present,active,loaded,wanted,armed,codeVersion>>
RequestRemove(i) == /\ wanted[i]
                    /\ wanted' = [wanted EXCEPT ![i] = FALSE]
                    /\ armed' = [armed EXCEPT ![i] = FALSE]
                    /\ effect' = EmptyEffect
                    /\ UNCHANGED <<present,active,loaded,marked,codeVersion>>
Stop(i,u) == /\ ~wanted[i] /\ RemovalProof(i,u) /\ u \in active
             /\ active' = active \ {u}
             /\ loaded' \in {loaded, loaded \ {u}} /\ Audit(i,{}, {u},None)
             /\ UNCHANGED <<present,marked,wanted,armed,codeVersion>>
Delete(i,u) == /\ ~wanted[i] /\ RemovalProof(i,u) /\ u \notin active
               /\ present' = present \ {u} /\ marked' = marked \ {u}
               /\ Audit(i,{u},{},None)
               /\ UNCHANGED <<active,loaded,wanted,armed,codeVersion>>
ReEnable(i) == /\ ~wanted[i]
               /\ wanted' = [wanted EXCEPT ![i] = TRUE]
               /\ effect' = EmptyEffect
               /\ UNCHANGED <<present,active,loaded,marked,armed,codeVersion>>
Create(i) == /\ wanted[i] /\ Reps(i) \cap present = {}
              /\ Reps(i) \cap active = {}
              /\ present' = present \cup {Scoped(i)}
              /\ marked' = marked \cup {Scoped(i)}
              /\ Audit(i,{Scoped(i)},{},None)
              /\ UNCHANGED <<active,loaded,wanted,armed,codeVersion>>
Start(i) == /\ wanted[i] /\ Actual(i,Key(Scoped(i))) = Scoped(i)
             /\ LoadedData[Scoped(i)] = Data(i) /\ Scoped(i) \notin active
             /\ Legacy(i) \notin active
             /\ active' = active \cup {Scoped(i)}
             /\ loaded' = loaded \cup {Scoped(i)}
             /\ armed' = [armed EXCEPT ![i] = TRUE]
             /\ Audit(i,{}, {Scoped(i)},LoadedData[Scoped(i)])
             /\ UNCHANGED <<present,marked,wanted,codeVersion>>
Restart(i,u) == /\ wanted[i] /\ Actual(i,Key(u)) = u /\ u \in active /\ LoadedProof(i,u)
                /\ Audit(i,{}, {u},LoadedData[u])
                /\ UNCHANGED <<present,active,loaded,marked,wanted,armed,codeVersion>>
Observe(i) == /\ effect' = EmptyEffect
              /\ UNCHANGED <<present,active,loaded,marked,wanted,armed,codeVersion>>
Flip == /\ codeVersion' = 1 - codeVersion /\ effect' = EmptyEffect
        /\ UNCHANGED <<present,active,loaded,marked,wanted,armed>>
(* removeOwnedUnit: Stop is disableNow; Delete is rmSync after reinspection.
   Crash after Stop preserves the file with loaded absent (bootout completed),
   so retry must still enable Delete for a marked scoped unit. UnloadedScoped
   starts at exactly this boundary; UnloadedLegacy must never be adopted.
   Failed stop is a stutter: the existing listener/file still block Create.
   Adopt changes marker only, irrespective of old payload drift; the explicit
   Restart transition represents applyPlannedUnit on explicit moved update,
   restartMoved and update-finish, not default adoption. Payload/moved and the
   per-call restartAttempted counter/confirmation are abstracted; fake assertions
   check one accepted restart despite a failed confirmation within one update. *)
Crash == UNCHANGED vars

(* Mutant is the previous global-name stale removal. Same real side effects
   and same audit as a normal deletion; no hidden owner check or error flag. *)
GlobalCleanup(i,u) == /\ BadGlobalCleanup /\ ~wanted[i]
                      /\ u \in {"LA","LB"} /\ u \in present
                      /\ present' = present \ {u}
                      /\ active' = active \ {u} /\ loaded' = loaded \ {u} /\ marked' = marked \ {u}
                      /\ Audit(i,{u}, IF u \in active THEN {u} ELSE {},None)
                      /\ UNCHANGED <<wanted,armed,codeVersion>>
Next == (\E i \in Actors:
           (\E u \in Units: Adopt(i,u) \/ Stop(i,u) \/ Delete(i,u)
                             \/ Restart(i,u) \/ GlobalCleanup(i,u))
           \/ RequestRemove(i) \/ ReEnable(i) \/ Create(i) \/ Start(i) \/ Observe(i))
        \/ Flip \/ Crash
TypeOK == /\ present \subseteq Units /\ active \subseteq Units /\ marked \subseteq Units
          /\ loaded \subseteq Units /\ active \subseteq loaded
          /\ wanted \in [Actors -> BOOLEAN] /\ armed \in [Actors -> BOOLEAN]
          /\ codeVersion \in {0,1}
CrossInstallSafety == /\ \A u \in effect.files: TrueFile[u] = effect.actor
                      /\ \A u \in effect.controls: TrueProcess[u] = effect.actor
UnknownPreserved == /\ BadFixtures \subseteq present /\ BadFixtures \subseteq active
                    /\ marked \cap BadFixtures = InitialMarked \ {"UnloadedScoped"}
                    /\ "UnloadedLegacy" \in present /\ "UnloadedLegacy" \notin marked
NoWrongRoots == effect.startedData = None \/ effect.startedData = Data(effect.actor)
OneListener == \A i \in Actors: Cardinality(Reps(i) \cap active) <= 1
Continuity == \A i \in Actors: armed[i] => Actual(i,Key(Scoped(i))) \in (Reps(i) \cap active)
UnloadedRemovable == \A i \in Actors, u \in Units:
  (~wanted[i] /\ DiskProof(i,u) /\ NameScope[u] = Scope(i)
   /\ LoadState(u) = "not-found" /\ u \notin active) => ENABLED Delete(i,u)
Spec == Init /\ [][Next]_vars
=============================================================================
