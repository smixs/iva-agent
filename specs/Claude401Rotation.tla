------------------------- MODULE Claude401Rotation -------------------------
EXTENDS Naturals
CONSTANTS ExtraRetry, AfterEffect, LateAdopt
VARIABLES phase, calls, visible, currentTool, oldTool, proven, version,
          valid, expired, resources, auth, alerts, unsafe, cancelCalls,
          acquiring, acquires, closed, cancelled
vars == <<phase, calls, visible, currentTool, oldTool, proven, version,
          valid, expired, resources, auth, alerts, unsafe, cancelCalls,
          acquiring, acquires, closed, cancelled>>
Init == /\ phase = "ready" /\ calls = 0 /\ visible = FALSE
        /\ currentTool \in BOOLEAN /\ oldTool \in BOOLEAN /\ proven \in BOOLEAN
        /\ version = 0 /\ valid = TRUE /\ expired = FALSE
        /\ resources = FALSE /\ auth = FALSE /\ alerts = 0
        /\ unsafe = FALSE /\ cancelCalls = 0 /\ acquiring = FALSE
        /\ acquires = 0 /\ closed = FALSE /\ cancelled = FALSE
Safe == ~visible /\ ~currentTool /\ proven
CanRepeat == calls < (IF ExtraRetry THEN 3 ELSE 2) /\ proven
             /\ ((~visible /\ ~currentTool) \/ AfterEffect)
Usable == ~acquiring /\ acquires = 2
Begin == /\ phase = "ready" /\ phase' = "call" /\ calls' = 1
         /\ acquiring' = TRUE
         /\ UNCHANGED <<visible, currentTool, oldTool, proven, version, valid,
                         expired, resources, auth, alerts, unsafe, cancelCalls,
                         acquires, closed, cancelled>>
(* Relay listen/adopt and CLI spawn/attach can each complete after cancellation. *)
Adopt == /\ acquiring /\ phase \in {"call", "cancelling"}
         /\ acquiring' = FALSE /\ acquires' = acquires + 1 /\ resources' = TRUE
         /\ UNCHANGED <<phase, calls, visible, currentTool, oldTool, proven,
                         version, valid, expired, auth, alerts, unsafe,
                         cancelCalls, closed, cancelled>>
AcquireChild == /\ phase = "call" /\ ~cancelled /\ ~acquiring /\ acquires = 1
                /\ acquiring' = TRUE
                /\ UNCHANGED <<phase, calls, visible, currentTool, oldTool, proven,
                                version, valid, expired, resources, auth, alerts,
                                unsafe, cancelCalls, acquires, closed, cancelled>>
AcquireFailure == /\ acquiring /\ phase \in {"call", "cancelling"}
                  /\ acquiring' = FALSE /\ auth' = FALSE
                  /\ phase' = (IF cancelled THEN "cancelling" ELSE "failure")
                  /\ resources' = (IF cancelled THEN resources ELSE FALSE)
                  /\ closed' = (IF cancelled THEN closed ELSE TRUE)
                  /\ UNCHANGED <<calls, visible, currentTool, oldTool, proven,
                                  version, valid, expired, alerts, unsafe,
                                  cancelCalls, acquires, cancelled>>
Output == /\ phase = "call" /\ Usable /\ ~visible /\ visible' = TRUE
          /\ UNCHANGED <<phase, calls, currentTool, oldTool, proven, version,
                          valid, expired, resources, auth, alerts, unsafe, cancelCalls,
                          acquiring, acquires, closed, cancelled>>
Fail401 == /\ phase = "call" /\ Usable /\ phase' = "close401" /\ auth' = TRUE
           /\ UNCHANGED <<calls, visible, currentTool, oldTool, proven, version,
                           valid, expired, resources, alerts, unsafe, cancelCalls,
                           acquiring, acquires, closed, cancelled>>
Close == /\ phase = "close401" /\ resources' = FALSE /\ closed' = TRUE
         /\ phase' = (IF CanRepeat THEN "wait" ELSE "failure")
         /\ UNCHANGED <<calls, visible, currentTool, oldTool, proven, version,
                         valid, expired, auth, alerts, unsafe, cancelCalls,
                         acquiring, acquires, cancelled>>
Change == /\ phase \in {"call", "close401", "wait"} /\ version = 0
          /\ version' = 1 /\ valid' = TRUE
          /\ UNCHANGED <<phase, calls, visible, currentTool, oldTool, proven,
                          expired, resources, auth, alerts, unsafe, cancelCalls,
                          acquiring, acquires, closed, cancelled>>
Invalid == /\ phase \in {"call", "close401", "wait"} /\ valid /\ valid' = FALSE
           /\ UNCHANGED <<phase, calls, visible, currentTool, oldTool, proven,
                           version, expired, resources, auth, alerts, unsafe, cancelCalls,
                           acquiring, acquires, closed, cancelled>>
Valid == /\ phase \in {"call", "close401", "wait"} /\ ~valid /\ valid' = TRUE
         /\ UNCHANGED <<phase, calls, visible, currentTool, oldTool, proven,
                         version, expired, resources, auth, alerts, unsafe, cancelCalls,
                         acquiring, acquires, closed, cancelled>>
Expire == /\ phase = "wait" /\ ~expired /\ expired' = TRUE
          /\ UNCHANGED <<phase, calls, visible, currentTool, oldTool, proven,
                          version, valid, resources, auth, alerts, unsafe, cancelCalls,
                          acquiring, acquires, closed, cancelled>>
Repeat == /\ phase = "wait" /\ ((valid /\ version = 1) \/ expired)
          /\ phase' = "call" /\ calls' = calls + 1 /\ resources' = FALSE
          /\ acquiring' = TRUE /\ acquires' = 0 /\ closed' = FALSE
          /\ unsafe' = (unsafe \/ ~Safe) /\ auth' = FALSE
          /\ UNCHANGED <<visible, currentTool, oldTool, proven, version, valid,
                          expired, alerts, cancelCalls, cancelled>>
Succeed == /\ phase = "call" /\ Usable /\ phase' = "success"
           /\ resources' = FALSE /\ auth' = FALSE /\ closed' = TRUE
           /\ UNCHANGED <<calls, visible, currentTool, oldTool, proven, version,
                           valid, expired, alerts, unsafe, cancelCalls,
                           acquiring, acquires, cancelled>>
OtherFailure == /\ phase = "call" /\ Usable /\ phase' = "failure"
                /\ resources' = FALSE /\ auth' = FALSE /\ closed' = TRUE
                /\ UNCHANGED <<calls, visible, currentTool, oldTool, proven, version,
                                valid, expired, alerts, unsafe, cancelCalls,
                                acquiring, acquires, cancelled>>
(* Cancellation requests abort. Only the attempt's finally closes ownership. *)
Cancel == /\ phase \in {"ready", "call", "close401", "wait"}
          /\ phase' = "cancelling" /\ cancelled' = TRUE /\ cancelCalls' = calls
          /\ closed' = (IF LateAdopt /\ acquiring THEN TRUE ELSE closed)
          /\ resources' = (IF LateAdopt /\ acquiring THEN FALSE ELSE resources)
          /\ UNCHANGED <<calls, visible, currentTool, oldTool, proven, version,
                          valid, expired, auth, alerts, unsafe, acquiring, acquires>>
FinishCancel == /\ phase = "cancelling" /\ ~acquiring /\ phase' = "cancelled"
                /\ resources' = (IF closed THEN resources ELSE FALSE) /\ closed' = TRUE
                /\ UNCHANGED <<calls, visible, currentTool, oldTool, proven, version,
                                valid, expired, auth, alerts, unsafe, cancelCalls,
                                acquiring, acquires, cancelled>>
Notify == /\ phase = "failure" /\ auth /\ alerts = 0 /\ alerts' = 1
          /\ UNCHANGED <<phase, calls, visible, currentTool, oldTool, proven,
                          version, valid, expired, resources, auth, unsafe, cancelCalls,
                          acquiring, acquires, closed, cancelled>>
Next == Begin \/ Adopt \/ AcquireChild \/ AcquireFailure \/ Output \/ Fail401 \/ Close
        \/ Change \/ Invalid \/ Valid \/ Expire \/ Repeat \/ Succeed \/ OtherFailure
        \/ Cancel \/ FinishCancel \/ Notify
Spec == Init /\ [][Next]_vars
CallsAtMostTwo == calls <= 2
RepeatIsSafe == ~unsafe
CancelStopsCalls == cancelled => calls = cancelCalls
OneFinalAlert == alerts <= 1 /\ (alerts > 0 => phase = "failure" /\ auth)
SuccessIsSilent == phase = "success" => alerts = 0
WaitingIsClean == phase = "wait" => (~resources /\ ~acquiring)
(* Acknowledgement at our attempt/auth-wrapper boundary waits for its finally.
   Existing SDK pipeThrough wrappers may acknowledge earlier; their cancellation
   still reaches Cancel, and FinishCancel closes each late acquired resource. *)
CancelAcknowledgedClean == phase = "cancelled" => (~resources /\ ~acquiring)
NoUseAfterCancel == phase = "call" => ~cancelled
=============================================================================
