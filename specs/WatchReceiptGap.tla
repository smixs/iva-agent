---- MODULE WatchReceiptGap ----
EXTENDS Naturals
CONSTANTS DurableAck, RetryUnknown
VARIABLES phase, remote, acknowledged, volatileId, receiptId, stateId, crashed,
          unknown, sends, retriedUnknown
vars == <<phase, remote, acknowledged, volatileId, receiptId, stateId, crashed,
          unknown, sends, retriedUnknown>>
\* Owner decision 2026-11-03: I5 covers confirmed Outbox delivery.
\* A visible remote signal before receipt may remain UNKNOWN and unaddressable.
\* UNKNOWN never authorizes another send. The durable pre-send claim survives crash.
\* Receive, fsync and Outbox ack are separate; state is a recoverable projection.
Init == /\ phase = "intent" /\ remote = FALSE /\ acknowledged = FALSE
        /\ volatileId = 0 /\ receiptId = 0 /\ stateId = 0 /\ crashed = FALSE
        /\ unknown = FALSE /\ sends = 0 /\ retriedUnknown = FALSE
Send == /\ phase = "intent" /\ phase' = "remote" /\ remote' = TRUE
        /\ sends' = sends + 1
        /\ UNCHANGED <<acknowledged, volatileId, receiptId, stateId, crashed,
                       unknown, retriedUnknown>>
Receive == /\ phase = "remote" /\ phase' = "body" /\ volatileId' = 1
           /\ UNCHANGED <<remote, acknowledged, receiptId, stateId, crashed,
                          unknown, sends, retriedUnknown>>
Persist == /\ phase = "body" /\ phase' = "receipt" /\ receiptId' = volatileId
           /\ UNCHANGED <<remote, acknowledged, volatileId, stateId, crashed,
                          unknown, sends, retriedUnknown>>
\* Missing/lost body, network/ambiguous response or first receipt write failure.
Failure == /\ phase \in {"remote", "body"} /\ phase' = "unknown"
           /\ unknown' = TRUE
           /\ UNCHANGED <<remote, acknowledged, volatileId, receiptId, stateId,
                          crashed, sends, retriedUnknown>>
Ack == /\ phase \in {"body", "receipt"}
       /\ (~DurableAck \/ receiptId > 0)
       /\ phase' = "ack" /\ acknowledged' = TRUE
       /\ UNCHANGED <<remote, volatileId, receiptId, stateId, crashed,
                      unknown, sends, retriedUnknown>>
Save == /\ phase = "ack" /\ phase' = "saved" /\ stateId' = receiptId
        /\ UNCHANGED <<remote, acknowledged, volatileId, receiptId, crashed,
                       unknown, sends, retriedUnknown>>
Crash == /\ ~crashed /\ phase \in {"remote", "body", "receipt", "ack", "saved", "unknown"}
         /\ phase' = "restart" /\ crashed' = TRUE /\ volatileId' = 0
         /\ unknown' = (unknown \/ receiptId = 0)
         /\ UNCHANGED <<remote, acknowledged, receiptId, stateId, sends, retriedUnknown>>
Recover == /\ phase = "restart"
           /\ stateId' = receiptId
           /\ phase' = IF receiptId > 0 THEN "saved" ELSE "unknown"
           /\ UNCHANGED <<remote, acknowledged, volatileId, receiptId, crashed,
                          unknown, sends, retriedUnknown>>
RepeatUnknown == /\ RetryUnknown /\ phase = "unknown" /\ sends < 2
                 /\ phase' = "remote" /\ sends' = sends + 1
                 /\ retriedUnknown' = TRUE
                 /\ UNCHANGED <<remote, acknowledged, volatileId, receiptId,
                                stateId, crashed, unknown>>
Next == Send \/ Receive \/ Persist \/ Failure \/ Ack \/ Save \/ Crash \/ Recover \/ RepeatUnknown
Spec == Init /\ [][Next]_vars
NoLostId == acknowledged => receiptId > 0 \/ stateId > 0
Recoverable == phase = "restart" /\ acknowledged => receiptId > 0 \/ stateId > 0
NoUnknownRetry == ~retriedUnknown
TypeOK == /\ phase \in {"intent", "remote", "body", "receipt", "ack", "saved", "unknown", "restart"}
          /\ sends \in 0..2 /\ receiptId \in 0..1 /\ stateId \in 0..1 /\ volatileId \in 0..1
====
