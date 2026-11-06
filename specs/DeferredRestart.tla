---- MODULE DeferredRestart ----
EXTENDS Naturals, FiniteSets
CONSTANTS Unsafe, Overwrite, PauseInput, OnlyChat
VARIABLES running, helper, compacting, pending, claimed, done, bridge, issued,
          queued, executed, executedBusy, launches
vars == <<running, helper, compacting, pending, claimed, done, bridge, issued,
          queued, executed, executedBusy, launches>>
ActualBusy == running \/ helper \/ compacting
Busy == IF OnlyChat THEN running ELSE ActualBusy
Init == /\ running = TRUE /\ helper = FALSE /\ compacting = FALSE
        /\ pending = 0 /\ claimed = 0 /\ done = {} /\ bridge = TRUE
        /\ issued = 0 /\ queued = 0 /\ executed = <<0, 0>>
        /\ executedBusy = FALSE /\ launches = <<0, 0>>
\* A second distinct command receives an explicit refusal, never an issued id.
Request == /\ issued < 2 /\ ((pending = 0 /\ claimed = 0) \/ Overwrite)
           /\ issued' = issued + 1 /\ pending' = issued'
           /\ UNCHANGED <<running, helper, compacting, claimed, done, bridge,
                          queued, executed, executedBusy, launches>>
Message == /\ bridge /\ queued < 2 /\ (~PauseInput \/ pending = 0) /\ queued' = queued + 1
           /\ UNCHANGED <<running, helper, compacting, pending, claimed, done,
                          bridge, issued, executed, executedBusy, launches>>
Start == /\ bridge /\ ~Busy /\ queued > 0
         /\ running' = TRUE /\ queued' = queued - 1
         /\ UNCHANGED <<helper, compacting, pending, claimed, done, bridge,
                        issued, executed, executedBusy, launches>>
Finish == /\ running /\ running' = FALSE
          /\ UNCHANGED <<helper, compacting, pending, claimed, done, bridge,
                         issued, queued, executed, executedBusy, launches>>
\* The running chat becomes compacting in one atomic status transition.
Compact == /\ running /\ running' = FALSE /\ compacting' = TRUE
           /\ UNCHANGED <<helper, pending, claimed, done, bridge, issued,
                          queued, executed, executedBusy, launches>>
Background == /\ helper' = ~helper
              /\ UNCHANGED <<running, compacting, pending, claimed, done, bridge,
                             issued, queued, executed, executedBusy, launches>>
Compacted == /\ compacting /\ compacting' = FALSE
             /\ UNCHANGED <<running, helper, pending, claimed, done, bridge,
                            issued, queued, executed, executedBusy, launches>>
Claim == /\ bridge /\ pending # 0 /\ claimed = 0 /\ (~Busy \/ Unsafe)
         /\ claimed' = pending /\ pending' = 0
         /\ launches' = [launches EXCEPT ![claimed'] = @ + 1]
         /\ UNCHANGED <<running, helper, compacting, done, bridge, issued,
                        queued, executed, executedBusy>>
Execute == /\ claimed # 0 /\ claimed \notin done /\ (~Busy \/ Unsafe)
           /\ done' = done \cup {claimed}
           /\ executed' = [executed EXCEPT ![claimed] = @ + 1]
           /\ executedBusy' = ActualBusy
           /\ UNCHANGED <<running, helper, compacting, pending, claimed, bridge,
                          issued, queued, launches>>
\* A failed launch or an unconfirmed owner resolves with an explicit error notice.
Failed == /\ claimed # 0 /\ claimed \notin done
          /\ done' = done \cup {claimed}
          /\ UNCHANGED <<running, helper, compacting, pending, claimed, bridge,
                         issued, queued, executed, executedBusy, launches>>
Report == /\ bridge /\ claimed \in done /\ claimed' = 0
          /\ UNCHANGED <<running, helper, compacting, pending, done, bridge,
                         issued, queued, executed, executedBusy, launches>>
Crash == /\ bridge' = ~bridge
         /\ UNCHANGED <<running, helper, compacting, pending, claimed, done,
                        issued, queued, executed, executedBusy, launches>>
Next == Request \/ Message \/ Start \/ Finish \/ Compact \/ Background \/ Compacted
        \/ Claim \/ Execute \/ Failed \/ Report \/ Crash
Spec == Init /\ [][Next]_vars
OnlyIdle == ~executedBusy
AtMostOnce == \A i \in 1..2 : executed[i] <= 1 /\ launches[i] <= 1
DurableAll == \A i \in 1..issued : pending = i \/ claimed = i \/ i \in done
InputAvailable == (bridge /\ queued < 2) => ENABLED Message
====
