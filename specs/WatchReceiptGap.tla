---- MODULE WatchReceiptGap ----
EXTENDS Naturals
CONSTANT DurableAck
VARIABLES phase, remote, acknowledged, volatileId, receiptId, stateId, crashed
vars == <<phase, remote, acknowledged, volatileId, receiptId, stateId, crashed>>
\* An external send can precede the local acknowledgement: its outcome is unknown.
\* DurableAck exposes success only after the synchronous atomic receipt write+fsync.
\* Full proactive state is a projection; failed writes recover from that receipt.
Init == /\ phase = "intent" /\ remote = FALSE /\ acknowledged = FALSE
        /\ volatileId = 0 /\ receiptId = 0 /\ stateId = 0 /\ crashed = FALSE
Send == /\ phase = "intent" /\ phase' = "remote" /\ remote' = TRUE
        /\ UNCHANGED <<acknowledged, volatileId, receiptId, stateId, crashed>>
Ack == /\ phase = "remote" /\ phase' = "ack" /\ acknowledged' = TRUE
       /\ volatileId' = 1 /\ receiptId' = IF DurableAck THEN 1 ELSE 0
       /\ UNCHANGED <<remote, stateId, crashed>>
Save == /\ phase = "ack" /\ phase' = "saved" /\ stateId' = volatileId
        /\ UNCHANGED <<remote, acknowledged, volatileId, receiptId, crashed>>
Crash == /\ ~crashed /\ phase \in {"remote", "ack", "saved"}
         /\ phase' = "restart" /\ crashed' = TRUE /\ volatileId' = 0
         /\ UNCHANGED <<remote, acknowledged, receiptId, stateId>>
Recover == /\ phase = "restart" /\ receiptId > 0 /\ stateId' = receiptId
           /\ phase' = "saved"
           /\ UNCHANGED <<remote, acknowledged, volatileId, receiptId, crashed>>
Next == Send \/ Ack \/ Save \/ Crash \/ Recover
Spec == Init /\ [][Next]_vars
NoLostId == acknowledged => volatileId > 0 \/ receiptId > 0 \/ stateId > 0
Recoverable == phase = "restart" /\ acknowledged => receiptId > 0 \/ stateId > 0
====
