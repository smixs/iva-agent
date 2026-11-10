---------------------------- MODULE UserbotLogin ----------------------------
(* The QR login of the userbot proxy: one account, one process, one Telegram auth key.
   services/telegram-userbot/onboarding.py holds the phase in memory and one marker file
   on disk; Telegram holds its own side of the login for the auth key in the session file.
   The owner scans the QR, may be asked for the cloud password, may mistype it, and the
   proxy may be restarted at any step. Every call of qr_login_password is written to Trace
   before the proxy answers it.
   Outside the model: the session history of eve, which keeps the call as the model made
   it beside the owner's own message with the same password; a QR scanned after the
   restart that cut its login; the marker file that cannot be written (the login is
   refused before it begins); the sixty seconds Telethon sleeps through a short flood wait
   by itself; a second account. *)
EXTENDS Naturals

CONSTANTS
  WrongPasswordEnds,  \* the code before this model: a wrong password ends the login
  MarksLogin,         \* a login in progress is marked on disk before it begins
  ChecksSession,      \* "authorized" is told only with the session file on disk
  Redacts,            \* a failure is told in fixed words, never in the words of the exception
  HonoursWait,        \* no password goes to Telegram before the wait it named has passed
  HidesArguments,     \* Trace writes a mark in place of an argument the tool names secret
  ReadFinishes,       \* a read that sees the account let in ends the login it belongs to
  ReplyReads,         \* the reply to the right password is the read, not a fixed "connected"
  MaxRefresh,         \* how many times one login draws a fresh QR
  MaxWrong            \* bound of the model: wrong passwords typed

VARIABLES
  phase,       \* memory of the proxy: Login.phase
  marker,      \* disk: telegram-userbot.login, a login is in progress
  session,     \* disk: the session file with the auth key
  tg,          \* Telegram, for this auth key: none | token | password | authorized
  refreshes,   \* fresh QR codes drawn by the running login
  wrongs,      \* wrong passwords typed so far
  flood,       \* Telegram: a flood wait on password checks is running
  waitKnown,   \* memory of the proxy: Telegram named a wait that has not passed
  answer,      \* how the last qr_login_password ended: none | ok | wrong | wait | failed
  cut,         \* history: a restart cut a login, and neither a new login nor its end followed
  leaked,      \* history: a secret reached the journal, the disk, Trace or a tool reply
  sentInWait,  \* history: a password went to Telegram inside a wait the proxy knew
  seenIn,      \* history: a read told "authorized" and no login was started since
  falseOk      \* history: the right password was answered "connected" while the read said otherwise

vars == <<phase, marker, session, tg, refreshes, wrongs, flood, waitKnown, answer, cut,
          leaked, sentInWait, seenIn, falseOk>>

Phases == {"idle", "starting", "waiting", "password_needed", "authorized", "expired",
           "error", "interrupted"}
InProgress == {"starting", "waiting", "password_needed"}

(* Login.phase(): Telegram's answer first, the phase in memory otherwise. *)
Reported ==
  IF tg = "authorized"
    THEN IF session \/ ~ChecksSession THEN "authorized" ELSE "error"
    ELSE IF phase = "authorized" THEN "idle" ELSE phase

Init ==
  /\ phase = "idle"
  /\ marker = FALSE
  /\ session = TRUE
  /\ tg = "none"
  /\ refreshes = 0
  /\ wrongs = 0
  /\ flood = FALSE
  /\ waitKnown = FALSE
  /\ answer = "none"
  /\ cut = FALSE
  /\ leaked = FALSE
  /\ sentInWait = FALSE
  /\ seenIn = FALSE
  /\ falseOk = FALSE

Ends(next) == phase' = next /\ marker' = FALSE

(* qr_login_start: the marker is written before the login task exists. *)
StartLogin ==
  /\ tg # "authorized"
  /\ phase \notin {"starting", "waiting"}
  /\ phase' = "starting"
  /\ marker' = MarksLogin
  /\ refreshes' = 0
  /\ answer' = "none"
  /\ cut' = FALSE
  /\ seenIn' = FALSE
  /\ UNCHANGED <<session, tg, wrongs, flood, waitKnown, leaked, sentInWait, falseOk>>

(* _run: client.qr_login() answered and the QR went to the owner's chat. *)
QrSent ==
  /\ phase = "starting"
  /\ phase' = "waiting"
  /\ tg' = "token"
  /\ UNCHANGED <<marker, session, refreshes, wrongs, flood, waitKnown, answer, cut, leaked,
                 sentInWait, seenIn, falseOk>>

(* _run: Telegram or the delivery of the QR failed. The exception may quote the bot token. *)
LoginFails ==
  /\ phase \in {"starting", "waiting"}
  /\ Ends("error")
  /\ tg' = IF tg = "token" THEN "none" ELSE tg
  /\ leaked' = (leaked \/ ~Redacts)
  /\ UNCHANGED <<session, refreshes, wrongs, flood, waitKnown, answer, cut, sentInWait, seenIn, falseOk>>

(* The owner scans the QR; Telegram accepts it, with or without the cloud password. *)
OwnerScans ==
  /\ tg = "token"
  /\ tg' \in {"password", "authorized"}
  /\ UNCHANGED <<phase, marker, session, refreshes, wrongs, flood, waitKnown, answer, cut,
                 leaked, sentInWait, seenIn, falseOk>>

ProxySeesLogin ==
  /\ phase = "waiting"
  /\ tg = "authorized"
  /\ Ends("authorized")
  /\ UNCHANGED <<session, tg, refreshes, wrongs, flood, waitKnown, answer, cut, leaked,
                 sentInWait, seenIn, falseOk>>

ProxySeesPasswordAsked ==
  /\ phase = "waiting"
  /\ tg = "password"
  /\ phase' = "password_needed"
  /\ UNCHANGED <<marker, session, tg, refreshes, wrongs, flood, waitKnown, answer, cut,
                 leaked, sentInWait, seenIn, falseOk>>

QrExpires ==
  /\ phase = "waiting"
  /\ tg = "token"
  /\ IF refreshes < MaxRefresh
       THEN /\ refreshes' = refreshes + 1
            /\ UNCHANGED <<phase, marker, tg>>
       ELSE /\ Ends("expired")
            /\ tg' = "none"
            /\ UNCHANGED refreshes
  /\ UNCHANGED <<session, wrongs, flood, waitKnown, answer, cut, leaked, sentInWait, seenIn, falseOk>>

(* Trace writes the call before the proxy answers it: the password is in its arguments.
   `replyLeaks` is the reply of the proxy telling a secret. *)
Traced(replyLeaks) == leaked' = (leaked \/ replyLeaks \/ ~HidesArguments)

(* qr_login_password inside a wait the proxy knows: nothing goes to Telegram. *)
PasswordHeldBack ==
  /\ phase = "password_needed"
  /\ waitKnown
  /\ HonoursWait
  /\ answer' = "wait"
  /\ Traced(FALSE)
  /\ UNCHANGED <<phase, marker, session, tg, refreshes, wrongs, flood, waitKnown, cut,
                 sentInWait, seenIn, falseOk>>

Sent ==
  /\ phase = "password_needed"
  /\ ~(waitKnown /\ HonoursWait)
  /\ sentInWait' = (sentInWait \/ waitKnown)

(* A refusal of the password itself: wrong, or too many checks. The login is still open
   on Telegram's side; only the mutant throws it away. *)
Refused(reply) ==
  /\ answer' = reply
  /\ IF WrongPasswordEnds THEN Ends("error") ELSE UNCHANGED <<phase, marker>>
  /\ Traced(~Redacts)

WrongPassword ==
  /\ Sent
  /\ tg = "password"
  /\ ~flood
  /\ wrongs < MaxWrong
  /\ wrongs' = wrongs + 1
  /\ Refused("wrong")
  /\ UNCHANGED <<session, tg, refreshes, flood, waitKnown, cut, seenIn, falseOk>>

TelegramNamesWait ==
  /\ Sent
  /\ flood
  /\ waitKnown' = ~WrongPasswordEnds
  /\ Refused("wait")
  /\ UNCHANGED <<session, tg, refreshes, wrongs, flood, cut, seenIn, falseOk>>

(* Telegram lets the account in. The reply is what the read says right after it
   (Reported'): "connected" only with the session file on disk. *)
RightPassword ==
  /\ Sent
  /\ tg = "password"
  /\ ~flood
  /\ tg' = "authorized"
  /\ Ends("authorized")
  /\ LET told == session \/ ~ChecksSession
     IN /\ answer' = IF told \/ ~ReplyReads THEN "ok" ELSE "failed"
        /\ falseOk' = (falseOk \/ (answer' = "ok" /\ ~told))
  /\ Traced(FALSE)
  /\ UNCHANGED <<session, refreshes, wrongs, flood, waitKnown, cut, seenIn>>

(* Any other failure of the check: the network, a login Telegram no longer holds. *)
PasswordCheckFails ==
  /\ Sent
  /\ Ends("error")
  /\ answer' = "failed"
  /\ Traced(~Redacts)
  /\ UNCHANGED <<session, tg, refreshes, wrongs, flood, waitKnown, cut, seenIn, falseOk>>

(* qr_login_status, login_status, qr_login_start or /healthz read the phase while Telegram
   has let the account in: the process that let it in may have died before it said so.
   The read ends that login, so the marker goes and no old "interrupted" comes back. *)
ReadSeesLogin ==
  /\ Reported = "authorized"
  /\ seenIn' = TRUE
  /\ IF ReadFinishes
       THEN /\ Ends("authorized")
            /\ cut' = FALSE
       ELSE UNCHANGED <<phase, marker, cut>>
  /\ UNCHANGED <<session, tg, refreshes, wrongs, flood, waitKnown, answer, leaked,
                 sentInWait, falseOk>>

TooManyChecks ==
  /\ wrongs > 0
  /\ ~flood
  /\ flood' = TRUE
  /\ UNCHANGED <<phase, marker, session, tg, refreshes, wrongs, waitKnown, answer, cut,
                 leaked, sentInWait, seenIn, falseOk>>

WaitPasses ==
  /\ flood
  /\ flood' = FALSE
  /\ waitKnown' = FALSE
  /\ UNCHANGED <<phase, marker, session, tg, refreshes, wrongs, answer, cut, leaked,
                 sentInWait, seenIn, falseOk>>

(* The unit restarts the proxy: memory is gone, the disk and Telegram stay. A missing
   session file is created anew with a fresh auth key, which Telegram does not know. *)
Restart ==
  /\ phase' = IF marker THEN "interrupted" ELSE "idle"
  /\ cut' = (cut \/ phase \in InProgress)
  /\ tg' = IF ~session \/ tg = "token" THEN "none" ELSE tg
  /\ session' = TRUE
  /\ refreshes' = 0
  /\ waitKnown' = FALSE
  /\ answer' = "none"
  /\ UNCHANGED <<marker, wrongs, flood, leaked, sentInWait, seenIn, falseOk>>

SessionFileLost ==
  /\ session
  /\ session' = FALSE
  /\ UNCHANGED <<phase, marker, tg, refreshes, wrongs, flood, waitKnown, answer, cut,
                 leaked, sentInWait, seenIn, falseOk>>

(* The owner ends the session from another device. *)
SignedOutElsewhere ==
  /\ tg = "authorized"
  /\ tg' = "none"
  /\ UNCHANGED <<phase, marker, session, refreshes, wrongs, flood, waitKnown, answer, cut,
                 leaked, sentInWait, seenIn, falseOk>>

Next ==
  \/ StartLogin \/ QrSent \/ LoginFails \/ OwnerScans \/ ProxySeesLogin
  \/ ProxySeesPasswordAsked \/ QrExpires \/ PasswordHeldBack \/ WrongPassword
  \/ TelegramNamesWait \/ RightPassword \/ PasswordCheckFails \/ TooManyChecks
  \/ WaitPasses \/ Restart \/ SessionFileLost \/ SignedOutElsewhere \/ ReadSeesLogin

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in Phases
  /\ marker \in BOOLEAN
  /\ session \in BOOLEAN
  /\ tg \in {"none", "token", "password", "authorized"}
  /\ refreshes \in 0..MaxRefresh
  /\ wrongs \in 0..MaxWrong
  /\ flood \in BOOLEAN
  /\ waitKnown \in BOOLEAN
  /\ answer \in {"none", "ok", "wrong", "wait", "failed"}
  /\ cut \in BOOLEAN
  /\ leaked \in BOOLEAN
  /\ sentInWait \in BOOLEAN
  /\ seenIn \in BOOLEAN
  /\ falseOk \in BOOLEAN

(* 1. A refused password leaves the login where it was: the owner types it again. *)
WrongPasswordKeepsAsking == answer \in {"wrong", "wait"} => phase = "password_needed"

(* 2. A login cut by a restart is named, unless Telegram already let the account in or
      the session file is gone; it never reads as a login that was not begun. *)
NoSilentIdle == cut => Reported \in {"interrupted", "authorized", "error"}

(* 3. "authorized" is told only while the session file is on disk. *)
AuthorizedHasSession == Reported = "authorized" => session /\ tg = "authorized"

(* 4. The password, the login token and the bot token stay out of the journal, the disk,
      Trace and the tool replies: everything Iva and the proxy write. The owner's own
      message with the password, and the session history of eve beside it, are outside. *)
NoSecretLeaves == ~leaked

(* 5. Inside a wait Telegram named, no password is sent. *)
WaitRespected == ~sentInWait

(* 6. A read that saw the account let in ended the login: no marker stays on disk and no
      old "interrupted" comes back after a sign-out elsewhere. *)
ReadEndsLogin == seenIn => ~marker /\ phase # "interrupted"

(* 7. The right password is answered "connected" only when the read says "authorized". *)
SuccessIsTheRead == ~falseOk

(* Witness, expected to fail: a login that got a wrong password still ends authorized. *)
NoLoginAfterWrongPassword == ~(Reported = "authorized" /\ wrongs > 0)
=============================================================================
