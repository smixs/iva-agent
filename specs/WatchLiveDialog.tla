---- MODULE WatchLiveDialog ----
EXTENDS Integers
CONSTANTS Chats, Horizon, LiveWindow, NoWindow, PeerWindow, FalseClose, DoubleEdit, LoseId
VARIABLES now, peer, owner, signal, at, msgId, edits, sentOwner, sentPeer,
          closeOwner, passDue, waitFrom
vars == <<now, peer, owner, signal, at, msgId, edits, sentOwner, sentPeer,
          closeOwner, passDue, waitFrom>>
\* One signal per chat bounds exploration; file lock serializes Watch passes.
\* A Pass includes a fresh read, delivery acknowledgement/id persistence, or close.
\* Network/crash boundaries are exercised by implementation tests, not abstracted as success.
Init == /\ now = 0
        /\ peer = [c \in Chats |-> -1] /\ owner = [c \in Chats |-> -1]
        /\ signal = [c \in Chats |-> "none"] /\ at = [c \in Chats |-> -1]
        /\ msgId = [c \in Chats |-> 0] /\ edits = [c \in Chats |-> 0]
        /\ sentOwner = owner /\ sentPeer = peer /\ closeOwner = owner
        /\ passDue = [c \in Chats |-> FALSE] /\ waitFrom = owner
Time == /\ now < Horizon /\ now' = now + 1
        /\ UNCHANGED <<peer, owner, signal, at, msgId, edits, sentOwner, sentPeer,
                       closeOwner, passDue, waitFrom>>
Peer(c) == /\ peer[c] < now /\ peer' = [peer EXCEPT ![c] = now]
           /\ UNCHANGED <<now, owner, signal, at, msgId, edits, sentOwner, sentPeer,
                          closeOwner, passDue, waitFrom>>
Owner(c) == /\ owner[c] < now /\ owner' = [owner EXCEPT ![c] = now]
            /\ UNCHANGED <<now, peer, signal, at, msgId, edits, sentOwner, sentPeer,
                           closeOwner, passDue, waitFrom>>
Deliver(c) == /\ signal[c] = "none" /\ peer[c] >= 0 /\ peer[c] > owner[c]
              /\ (NoWindow \/ (IF PeerWindow THEN now-peer[c] >= LiveWindow
                                ELSE owner[c] < 0 \/ now-owner[c] >= LiveWindow))
              /\ signal' = [signal EXCEPT ![c] = "delivered"]
              /\ at' = [at EXCEPT ![c] = now]
              /\ msgId' = [msgId EXCEPT ![c] = IF LoseId THEN 0 ELSE 1]
              /\ sentOwner' = [sentOwner EXCEPT ![c] = owner[c]]
              /\ sentPeer' = [sentPeer EXCEPT ![c] = peer[c]]
              /\ waitFrom' = [waitFrom EXCEPT ![c] = IF PeerWindow THEN peer[c] ELSE owner[c]]
              /\ UNCHANGED <<now, peer, owner, edits, closeOwner, passDue>>
Pass(c) == /\ signal[c] \in {"delivered", "closed"}
           /\ LET due == signal[c] = "delivered" /\ owner[c] > at[c]
                  closing == due \/ (FalseClose /\ signal[c] = "delivered")
                             \/ (DoubleEdit /\ signal[c] = "closed")
              IN /\ signal' = [signal EXCEPT ![c] = IF closing THEN "closed" ELSE @]
                 /\ edits' = [edits EXCEPT ![c] = IF closing THEN @+1 ELSE @]
                 /\ closeOwner' = [closeOwner EXCEPT ![c] = IF closing THEN owner[c] ELSE @]
                 /\ passDue' = [passDue EXCEPT ![c] = due]
           /\ UNCHANGED <<now, peer, owner, at, msgId, sentOwner, sentPeer, waitFrom>>
Next == Time \/ (\E c \in Chats: Peer(c) \/ Owner(c) \/ Deliver(c) \/ Pass(c))
Spec == Init /\ [][Next]_vars
LiveSilence == \A c \in Chats: signal[c] # "none" =>
                sentOwner[c] < 0 \/ at[c]-sentOwner[c] >= LiveWindow
WaitFromOwner == \A c \in Chats: signal[c] # "none" =>
                  sentPeer[c] > sentOwner[c] /\ waitFrom[c] = sentOwner[c]
AutoClose == \A c \in Chats: passDue[c] => signal[c] = "closed" /\ edits[c] = 1
NoFalseClose == \A c \in Chats: edits[c] > 0 => closeOwner[c] > at[c]
NoDoubleEdit == \A c \in Chats: edits[c] <= 1
NoLostId == \A c \in Chats: signal[c] # "none" => msgId[c] > 0
====
