--------------------------- MODULE SendFileFallback ---------------------------
EXTENDS TLC

CONSTANT LegacyFallback
VARIABLES photoReply, documentSent

vars == <<photoReply, documentSent>>

PhotoReplies == {"accepted", "rejected", "fetchFailed", "bodyInterrupted", "unexpected"}

Init == /\ photoReply = "pending"
        /\ documentSent = FALSE

ObservePhoto ==
  /\ photoReply = "pending"
  /\ photoReply' \in PhotoReplies
  /\ UNCHANGED documentSent

SendDocument ==
  /\ ~documentSent
  /\ \/ photoReply = "rejected"
     \/ LegacyFallback /\ photoReply \in {"bodyInterrupted", "unexpected"}
  /\ documentSent' = TRUE
  /\ UNCHANGED photoReply

Spec == Init /\ [][ObservePhoto \/ SendDocument]_vars

(* After a photo attempt, a document may be sent only on an explicit refusal. *)
FallbackRequiresPhotoRejection == documentSent => photoReply = "rejected"
=============================================================================
