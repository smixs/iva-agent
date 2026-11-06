---- MODULE RestartRecovery ----
\* Перезапуск Ивы посреди хода (0.4.10). До старта сервиса ExecStartPre смотрит run-status:
\* есть оборванный ход — хранилище workflow уходит в карантин (замок входящих сессии исчезает
\* вместе с ним), запись хода помечается (updatedAt = 0), Bridge закрывает её одним уведомлением
\* владельцу. Очередь Telegram живёт отдельно и переживает перезапуск. Процесс может упасть на
\* любом шаге, в том числе посреди восстановления; само восстановление может отказать (нет
\* прав, диск) на любом из двух шагов. Карантинов хранится Keep, старые вытесняются.
\*
\* Fixed = FALSE — поведение кандидата 19fd4bea: помеченный ход снова считается оборванным,
\* отказ восстановления не даёт сервису стартовать. Fixed = TRUE — поведение после ремонта.
EXTENDS Naturals, FiniteSets

CONSTANTS MaxMsgs, MaxCrashes, MaxFaults, Keep, Fixed, RecoveryCAS

VARIABLES proc, turn, lock, status, queue, sent, answered, noticed,
          crashes, faults, interrupted, quarantines, origKept, blocked

VARIABLES recoveryPhase, diskStatus, diskGeneration, scanGeneration, checkedGeneration, checkedStatus, statusLock, bridgeDone, newTurn
recoveryVars == <<recoveryPhase, diskStatus, diskGeneration, scanGeneration, checkedGeneration, checkedStatus, statusLock, bridgeDone, newTurn>>

vars == <<proc, turn, lock, status, queue, sent, answered, noticed,
          crashes, faults, interrupted, quarantines, origKept, blocked>>

VARIABLES offerPhase, offerToken, offerUpdate, offerPending, offerAdmitted,
          offerNotices, offerTaps, offerRestarts, offerExpired
buttonVars == <<offerPhase, offerToken, offerUpdate, offerPending, offerAdmitted,
               offerNotices, offerTaps, offerRestarts, offerExpired>>
ButtonInit ==
  /\ offerPhase = "running" /\ offerToken = FALSE /\ offerUpdate = 0
  /\ offerPending = {} /\ offerAdmitted = {} /\ offerNotices = 0
  /\ offerTaps = {} /\ offerRestarts = 0 /\ offerExpired = FALSE

Init ==
  /\ ButtonInit
  /\ recoveryPhase = "idle" /\ diskStatus = "running" /\ diskGeneration = 1
  /\ scanGeneration = 0 /\ checkedGeneration = 0 /\ checkedStatus = "none"
  /\ statusLock = FALSE /\ bridgeDone = FALSE /\ newTurn = FALSE
  /\ proc = "up" /\ turn = FALSE /\ lock = FALSE /\ status = "none"
  /\ queue = 0 /\ sent = 0 /\ answered = 0 /\ noticed = 0
  /\ crashes = 0 /\ faults = 0 /\ interrupted = 0
  /\ quarantines = 0 /\ origKept = TRUE /\ blocked = FALSE

Send ==
  /\ sent < MaxMsgs
  /\ sent' = sent + 1 /\ queue' = queue + 1
  /\ UNCHANGED <<proc, turn, lock, status, answered, noticed, crashes, faults,
                 interrupted, quarantines, origKept, blocked>>

\* Ход берёт сообщение: живой процесс, свободный замок, прошлый ход закрыт.
StartTurn ==
  /\ proc = "up" /\ ~turn /\ ~lock /\ queue > 0 /\ status = "none"
  /\ turn' = TRUE /\ lock' = TRUE /\ status' = "running" /\ queue' = queue - 1
  /\ UNCHANGED <<proc, sent, answered, noticed, crashes, faults,
                 interrupted, quarantines, origKept, blocked>>

FinishTurn ==
  /\ proc = "up" /\ turn
  /\ turn' = FALSE /\ lock' = FALSE /\ status' = "none" /\ answered' = answered + 1
  /\ UNCHANGED <<proc, queue, sent, noticed, crashes, faults,
                 interrupted, quarantines, origKept, blocked>>

\* kill или restart: ход пропадает, замок и запись остаются на диске.
Crash ==
  /\ proc \in {"up", "recovering"} /\ crashes < MaxCrashes
  /\ proc' = "down" /\ turn' = FALSE /\ crashes' = crashes + 1
  /\ interrupted' = IF turn THEN interrupted + 1 ELSE interrupted
  /\ UNCHANGED <<lock, status, queue, sent, answered, noticed, faults,
                 quarantines, origKept, blocked>>

Boot ==
  /\ proc = "down"
  /\ proc' = "recovering"
  /\ UNCHANGED <<turn, lock, status, queue, sent, answered, noticed, crashes, faults,
                 interrupted, quarantines, origKept, blocked>>

\* Что восстановление считает оборванным ходом.
Counts == IF Fixed THEN status = "running" ELSE status \in {"running", "stale"}

\* Шаг 1: карантин хранилища. Снимает замок; лишний карантин вытесняет старые.
Quarantine ==
  /\ proc = "recovering" /\ Counts /\ (lock \/ ~Fixed) /\ quarantines < MaxCrashes + 1
  /\ lock' = FALSE /\ quarantines' = quarantines + 1
  /\ origKept' = (origKept /\ quarantines' - interrupted < Keep)
  /\ UNCHANGED <<proc, turn, status, queue, sent, answered, noticed, crashes, faults,
                 interrupted, blocked>>

\* Шаг 2: запись хода помечается.
MarkStale ==
  /\ proc = "recovering" /\ status = "running" /\ ~lock
  /\ status' = "stale"
  /\ UNCHANGED <<proc, turn, lock, queue, sent, answered, noticed, crashes, faults,
                 interrupted, quarantines, origKept, blocked>>

\* Отказ восстановления на любом шаге (нет прав, диск).
Fault ==
  /\ proc = "recovering" /\ faults < MaxFaults /\ status = "running"
  /\ faults' = faults + 1
  /\ IF Fixed
       THEN /\ proc' = "up" /\ blocked' = blocked
       ELSE /\ proc' = "down" /\ blocked' = TRUE
  /\ UNCHANGED <<turn, lock, status, queue, sent, answered, noticed, crashes,
                 interrupted, quarantines, origKept>>

Start ==
  /\ proc = "recovering" /\ status # "running"
  /\ proc' = "up" /\ blocked' = FALSE
  /\ UNCHANGED <<turn, lock, status, queue, sent, answered, noticed, crashes, faults,
                 interrupted, quarantines, origKept>>

\* Bridge закрывает оборванный ход одной строкой владельцу. Запись running без хода у живого
\* процесса (восстановление отказало) Bridge закрывает так же, когда она устареет.
Notice ==
  /\ proc = "up" /\ ~turn /\ status \in {"stale", "running"}
  /\ status' = "none" /\ noticed' = noticed + 1 /\ lock' = FALSE
  /\ UNCHANGED <<proc, turn, queue, sent, answered, crashes, faults,
                 interrupted, quarantines, origKept, blocked>>

LegacyNext ==
  \/ Send \/ StartTurn \/ FinishTurn \/ Crash \/ Boot
  \/ Quarantine \/ MarkStale \/ Fault \/ Start \/ Notice

Next == LegacyNext /\ UNCHANGED <<recoveryVars, buttonVars>>

\* H2: scan -> repeated read -> publication, with Bridge closing the same chat.
\* RecoveryCAS uses the same per-chat lock and generation comparison as writers.
RecoveryScan ==
  /\ recoveryPhase = "idle"
  /\ recoveryPhase' = "scanned" /\ scanGeneration' = diskGeneration
  /\ UNCHANGED <<diskStatus, diskGeneration, checkedGeneration, checkedStatus, statusLock, bridgeDone, newTurn>>
RecoveryRead ==
  /\ recoveryPhase = "scanned" /\ ~statusLock
  /\ recoveryPhase' = "checked" /\ checkedGeneration' = diskGeneration
  /\ checkedStatus' = diskStatus
  /\ statusLock' = RecoveryCAS
  /\ UNCHANGED <<diskStatus, diskGeneration, scanGeneration, bridgeDone, newTurn>>
BridgeFinish ==
  /\ ~statusLock /\ ~bridgeDone
  /\ diskStatus' = "idle" /\ diskGeneration' = diskGeneration + 1 /\ bridgeDone' = TRUE
  /\ UNCHANGED <<recoveryPhase, scanGeneration, checkedGeneration, checkedStatus, statusLock, newTurn>>
BridgeStart ==
  /\ bridgeDone /\ ~newTurn /\ ~statusLock /\ recoveryPhase \in {"scanned", "checked"}
  /\ newTurn' = TRUE /\ diskStatus' = "running" /\ diskGeneration' = diskGeneration + 1
  /\ UNCHANGED <<recoveryPhase, scanGeneration, checkedGeneration, checkedStatus, statusLock, bridgeDone>>
RecoveryPublish ==
  /\ recoveryPhase = "checked"
  /\ recoveryPhase' = "done" /\ statusLock' = FALSE
  \* Publication uses the locked READ snapshot, as the code does. There is no
  \* atomic last-minute disk-status check hiding a missing/early-released lock.
  /\ IF checkedStatus = "running" /\ scanGeneration = checkedGeneration
       THEN /\ diskStatus' = "stale"
            /\ diskGeneration' = checkedGeneration + 1
       ELSE UNCHANGED <<diskStatus, diskGeneration>>
  /\ UNCHANGED <<scanGeneration, checkedGeneration, checkedStatus, bridgeDone, newTurn>>
SecondWindowNext == (RecoveryScan \/ RecoveryRead \/ BridgeFinish \/ BridgeStart \/ RecoveryPublish)
  /\ UNCHANGED <<vars, buttonVars>>
SecondWindowSpec == Init /\ [][SecondWindowNext]_<<vars, recoveryVars>>
ClosedStaysClosed == bridgeDone /\ ~newTurn => diskStatus = "idle"
NewTurnKept == newTurn => diskStatus = "running"
GenerationAdvances == diskGeneration >= checkedGeneration

Fair ==
  /\ WF_vars(StartTurn) /\ WF_vars(FinishTurn) /\ WF_vars(Boot)
  /\ WF_vars(Quarantine) /\ WF_vars(MarkStale) /\ WF_vars(Start) /\ WF_vars(Notice)

Spec == Init /\ [][Next]_vars /\ Fair

TypeOK ==
  /\ proc \in {"up", "down", "recovering"}
  /\ turn \in BOOLEAN /\ lock \in BOOLEAN /\ origKept \in BOOLEAN /\ blocked \in BOOLEAN
  /\ status \in {"none", "running", "stale"}
  /\ queue \in 0..MaxMsgs /\ sent \in 0..MaxMsgs
  /\ answered \in 0..MaxMsgs /\ noticed \in 0..MaxMsgs
  /\ crashes \in 0..MaxCrashes /\ faults \in 0..MaxFaults
  /\ interrupted \in 0..MaxCrashes /\ quarantines \in 0..(MaxCrashes + 1)

\* Сообщение не теряется.
NothingLost ==
  sent = queue + answered + noticed + (IF status \in {"running", "stale"} THEN 1 ELSE 0)

\* Об одном оборванном ходе владелец узнаёт не больше одного раза.
NoticeBounded == noticed <= interrupted

\* Карантин — один на оборванный ход: повторный старт хранилище не трогает.
OneQuarantinePerTurn == quarantines <= interrupted

\* Карантин оборванного хода не вытесняется лишними карантинами.
OriginalKept == origKept

\* Отказ восстановления не оставляет сервис лежать.
NeverBlocked == ~blocked

\* Очередь доигрывается.
QueueDrains == <>[](queue = 0 /\ ~turn /\ status = "none")

\* Кнопка после оборванного хода, модель до кода (21.10.2026).
\* ReapOffer -> queue.reapStaleRuns: CAS закрывает ход и сохраняет жетон кнопки.
\* NotifyOffer -> queue.notifyInterruptedTurn: один вызов Outbox после CAS.
\* TapOffer -> control.handleOwnerTap: CAS запоминает update_id в run-status и берёт вопрос той же generation.
\* AdmitOffer -> обычный inbound pipeline; повтор того же update_id идемпотентен.
\* ExpireOffer -> сброс жетона при /new и захвате нового хода.
\* RestartBridge -> память процесса исчезает, run-status и очередь остаются.
\* Допущение: вызов Outbox завершается успешно. Сбой отправки и падение между CAS и
\* отправкой дают at-most-once attempt; атомарность диска с Telegram вне модели.
\* Fixed = FALSE: мутант сам ставит вопрос в очередь сразу после уведомления.
\* RecoveryCAS = FALSE: мутант пропускает сверку сохранённого update_id.
ReapOffer ==
  /\ offerPhase = "running"
  /\ offerPhase' = "closed" /\ offerToken' = TRUE
  /\ UNCHANGED <<offerUpdate, offerPending, offerAdmitted, offerNotices,
                 offerTaps, offerRestarts, offerExpired>>
NotifyOffer ==
  /\ offerPhase = "closed"
  /\ offerPhase' = "notified" /\ offerNotices' = offerNotices + 1
  /\ offerPending' = IF Fixed THEN offerPending ELSE {1}
  /\ UNCHANGED <<offerToken, offerUpdate, offerAdmitted, offerTaps, offerRestarts, offerExpired>>
TapOffer(u) ==
  /\ offerPhase = "notified" /\ offerToken /\ ~offerExpired
  /\ (RecoveryCAS => offerUpdate \in {0, u})
  /\ offerUpdate' = u /\ offerPending' = offerPending \cup {u}
  /\ offerTaps' = offerTaps \cup {u}
  /\ UNCHANGED <<offerPhase, offerToken, offerAdmitted, offerNotices, offerRestarts, offerExpired>>
AdmitOffer(u) ==
  /\ u \in offerPending
  /\ offerPending' = offerPending \ {u} /\ offerAdmitted' = offerAdmitted \cup {u}
  /\ UNCHANGED <<offerPhase, offerToken, offerUpdate, offerNotices, offerTaps, offerRestarts, offerExpired>>
ExpireOffer ==
  /\ ~offerExpired
  /\ offerExpired' = TRUE /\ offerToken' = FALSE
  /\ UNCHANGED <<offerPhase, offerUpdate, offerPending, offerAdmitted, offerNotices, offerTaps, offerRestarts>>
RestartBridge ==
  /\ offerRestarts < MaxCrashes
  /\ offerRestarts' = offerRestarts + 1
  /\ UNCHANGED <<offerPhase, offerToken, offerUpdate, offerPending, offerAdmitted, offerNotices, offerTaps, offerExpired>>
ButtonNext == ReapOffer \/ NotifyOffer \/ ExpireOffer \/ RestartBridge
              \/ (\E u \in 1..MaxMsgs: TapOffer(u) \/ AdmitOffer(u))
ButtonSpec == Init /\ [][ButtonNext /\ UNCHANGED <<vars, recoveryVars>>]_<<vars, recoveryVars, buttonVars>>
              /\ WF_buttonVars(NotifyOffer)
\* Mutant: a reaper without the running -> idle CAS takes a notified turn again.
ReapNotifiedOffer ==
  /\ offerPhase = "notified" /\ offerNotices < 2
  /\ offerPhase' = "closed"
  /\ UNCHANGED <<offerToken, offerUpdate, offerPending, offerAdmitted,
                 offerNotices, offerTaps, offerRestarts, offerExpired>>
ButtonDoubleNoticeSpec == Init /\ [][(ButtonNext \/ ReapNotifiedOffer)
  /\ UNCHANGED <<vars, recoveryVars>>]_<<vars, recoveryVars, buttonVars>>
  /\ WF_buttonVars(NotifyOffer)
\* Mutant: closing a turn drops its notification instead of invoking Outbox.
ButtonLostNoticeSpec == Init /\ [][(ButtonNext /\ offerPhase' # "notified")
  /\ UNCHANGED <<vars, recoveryVars>>]_<<vars, recoveryVars, buttonVars>>
OneNoticePerTurn == offerNotices <= 1
NoticeEventually == offerPhase = "closed" ~> offerNotices = 1
OnlyOwnerTap == offerPending \cup offerAdmitted \subseteq offerTaps
OneNewTurn == Cardinality(offerAdmitted) <= 1
====
