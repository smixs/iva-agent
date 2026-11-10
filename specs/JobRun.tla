---- MODULE JobRun ----
\* Job: запуск расписания через бронь в data/rollup-status.json и факт в data/jobs.json
\* (машина №26 разбора машин состояний). Модель описывает код, написанный раньше неё:
\* agent/lib/schedule-runner.ts (admitUnderLock, recordJobFact, completeUnderLock,
\* clearReservation), сторож Job scripts/lib/job-watchdog.ts (runJobWatchdog).
\*
\* Что описывает. Одно имя расписания. Процессы Ивы — слоты Procs; слот умирает и
\* поднимается заново новым воплощением (OWNER_STARTED_AT другой). Бронь — владелец
\* <<слот, воплощение>> и startedAt запуска (жетон). Допуск под замком статуса атомарен:
\* бронь чужая, не истекла и владелец жив — пропуск; иначе новая бронь поверх. Ребёнок
\* работает, выходит; раннер пишет факт (или отказ записи — промис отклонён); пробуждение
\* агента по факту; итог в статус под замком снимает бронь только свою (ownsReservation),
\* иначе её снимает finally (clearReservation) с той же сверкой. Срок брони — шаг Expire
\* (timeoutMs; Deadline = FALSE — срока нет). Сторож раз в сутки смотрит факты: провал без
\* состоявшегося хода агента после него — одно сообщение владельцу за сутки.
\*
\* «Владелец жив» в коде — process.kill(ownerPid, 0). Pid — слот: при PidReuse новое
\* воплощение слота получает прежний pid, и старая бронь этого слота выглядит живой.
\* SelfCheck — бронь со своим pid и чужим OWNER_STARTED_AT считается мёртвой.
\*
\* Политика фактов — константа SparseSuccess: успех пишется строкой при любой политике, но
\* у расписания с factOnSuccess = after-failure (получасовой proactive) успех без провала
\* прошлого факта строки не пишет: след остаётся только в статусе (lastFinishedAt,
\* lastSuccessAt). Провал пишется всегда. FactKept формулируется через политику.
\*
\* Чего не описывает: порядок «последнего факта» (здесь — по жетону запуска, в коде — по
\* finishedAt/startedAt строки job-facts latestFact), гвард «последний успех» (только частота),
\* засев seededAt миграцией (не бронь), замок статуса с кражей через 30 с и отказ его взять
\* (пропуск без записи), flock .memory.lock вокруг ребёнка, текст факта и хвосты, ротацию
\* jobs.json, ack.
\*
\* Действие модели -> файл:функция
\*   Admit / Skip   schedule-runner.ts admitUnderLock (reservationOwnerIsDead, deadlineMs)
\*   ChildExit      watchChild: close ребёнка
\*   Fact           recordJobFact -> job-facts.ts recordFact по политике factOnSuccess
\*                  (after-failure пропускает успех без прошлого провала); отказ — run.factFailure
\*   Wake           scripts/jobs/wake.ts -> recordWake: answered | empty | failed
\*   Complete       completeUnderLock: ownsReservation -> снять бронь, lastFinishedAt
\*   Cleanup        runScheduledJob finally -> clearReservation
\*   Expire         прошёл timeoutMs; SIGTERM группе ребёнка (watchChild killTimer)
\*   Die / Restart  процесс Ивы умер (KillMode=control-group гасит ребёнка) и поднялся
\*   Watch / Day    job-watchdog.ts watchdogDecision + runJobWatchdog; сутки прошли
EXTENDS Naturals, FiniteSets

CONSTANTS
  Procs,
  MaxTok,        \* запусков всего
  MaxRestarts,
  MaxFail,       \* отказов записи (факт, итог в статус)
  MaxDays,
  Deadline,      \* у брони есть срок (timeoutMs не null)
  PidReuse,      \* новое воплощение слота получает прежний pid
  SelfCheck,     \* своя pid-бронь чужого воплощения — мёртвая (починка v5)
  Grace,         \* свидетель: ребёнок живёт после срока брони (killGraceMs)
  Orphan,        \* свидетель: ребёнок переживает смерть процесса Ивы
  OverLive,      \* мутант (1): допуск поверх живой брони
  IgnoreDeath,   \* мутант (2): смерть владельца не освобождает бронь
  NoFact,        \* мутант (3): итог без записи факта
  ForeignClear,  \* мутант (4): итог снимает бронь без сверки владельца
  SparseSuccess, \* политика фактов: успех пишется только после провала прошлого факта
  SparseNoStatus \* мутант (5): успех, пропущенный политикой без факта, не пишется в статус успехом

NoRes == [p |-> "none", inc |-> 0, t |-> 0]
Tokens == 1..MaxTok

VARIABLES
  alive, inc,     \* процессы: жив, номер воплощения
  phase, run,     \* запуск слота: "idle" | "child" | "fact" | "complete" | "cleanup"; жетон
  res, expired,   \* диск: бронь и «срок брони прошёл»
  facts, failed,  \* диск: жетоны с фактом; из них провалы
  woke,           \* диск: жетоны, у которых ход агента состоялся (answered/empty)
  orphans,        \* живые дети умерших процессов
  tok, fails, restarts, day,
  done,           \* призрак: завершённые запуски (раннер дошёл до итога в статус)
  loud,           \* призрак: запуски с отклонённым промисом (факт не записан)
  foreign,        \* призрак: снята бронь чужого запуска
  blockedDead,    \* призрак: пропуск из-за брони мёртвого владельца
  sent,           \* призрак: сообщений сторожа за текущие сутки
  quiet,          \* призрак: запуски, чей успех политика записала только в статус, без строки
  statusOk        \* призрак: пропущенные политикой успехи, записанные в статус успехом

vars == <<alive, inc, phase, run, res, expired, facts, failed, woke, orphans, tok, fails,
          restarts, day, done, loud, foreign, blockedDead, sent, quiet, statusOk>>

Init ==
  /\ alive = [p \in Procs |-> TRUE] /\ inc = [p \in Procs |-> 1]
  /\ phase = [p \in Procs |-> "idle"] /\ run = [p \in Procs |-> 0]
  /\ res = NoRes /\ expired = FALSE
  /\ facts = {} /\ failed = {} /\ woke = {} /\ orphans = 0
  /\ tok = 0 /\ fails = 0 /\ restarts = 0 /\ day = 0
  /\ done = {} /\ loud = {} /\ foreign = FALSE /\ blockedDead = FALSE /\ sent = 0
  /\ quiet = {} /\ statusOk = {}

CanFail == fails < MaxFail

\* Владелец брони на самом деле мёртв.
OwnerDead == res # NoRes /\ ~(alive[res.p] /\ inc[res.p] = res.inc)

\* reservationOwnerIsDead глазами слота q.
SeenDead(q) ==
  /\ res # NoRes
  /\ ~IgnoreDeath
  /\ IF SelfCheck /\ res.p = q
       THEN res.inc # inc[q]
       ELSE IF PidReuse THEN ~alive[res.p] ELSE OwnerDead

Owns(q) == res = [p |-> q, inc |-> inc[q], t |-> run[q]]

LiveChildren == Cardinality({q \in Procs : alive[q] /\ phase[q] = "child"}) + orphans

Admit(q) ==
  /\ alive[q] /\ phase[q] = "idle" /\ tok < MaxTok
  /\ OverLive \/ res = NoRes \/ expired \/ SeenDead(q)
  /\ tok' = tok + 1
  /\ res' = [p |-> q, inc |-> inc[q], t |-> tok + 1] /\ expired' = FALSE
  /\ phase' = [phase EXCEPT ![q] = "child"] /\ run' = [run EXCEPT ![q] = tok + 1]
  /\ UNCHANGED <<alive, inc, facts, failed, woke, orphans, fails, restarts, day, done, loud,
                 foreign, blockedDead, sent, quiet, statusOk>>

Skip(q) ==
  /\ alive[q] /\ phase[q] = "idle" /\ tok < MaxTok
  /\ ~(OverLive \/ res = NoRes \/ expired \/ SeenDead(q))
  /\ blockedDead' = (blockedDead \/ OwnerDead)
  /\ UNCHANGED <<alive, inc, phase, run, res, expired, facts, failed, woke, orphans, tok,
                 fails, restarts, day, done, loud, foreign, sent, quiet, statusOk>>

ChildExit(q) ==
  /\ alive[q] /\ phase[q] = "child"
  /\ phase' = [phase EXCEPT ![q] = IF NoFact THEN "complete" ELSE "fact"]
  /\ UNCHANGED <<alive, inc, run, res, expired, facts, failed, woke, orphans, tok, fails,
                 restarts, day, done, loud, foreign, blockedDead, sent, quiet, statusOk>>

\* Последний факт этого имени — провал (job-facts latestFact в recordFact).
PrevFailed == (CHOOSE u \in facts \cup {0} : \A v \in facts : v <= u) \in failed

Fact(q) ==
  /\ alive[q] /\ phase[q] = "fact"
  /\ \/ \* Провал: строка в таблице при любой политике.
        /\ facts' = facts \cup {run[q]}
        /\ failed' = failed \cup {run[q]}
        /\ UNCHANGED <<fails, loud, quiet>>
     \/ \* Успех: политика always пишет строку всегда, after-failure — только закрывая провал
        \* прошлого факта. Пропущенный политикой успех остаётся в статусе (statusOk).
        /\ \/ /\ facts' = facts \cup {run[q]}
              /\ UNCHANGED <<failed, quiet>>
           \/ /\ SparseSuccess /\ ~PrevFailed
              /\ facts' = facts
              /\ quiet' = quiet \cup {run[q]}
              /\ UNCHANGED failed
        /\ UNCHANGED <<fails, loud, statusOk>>
     \/ /\ CanFail /\ fails' = fails + 1 /\ loud' = loud \cup {run[q]}
        /\ UNCHANGED <<facts, failed, quiet>>
  /\ phase' = [phase EXCEPT ![q] = "complete"]
  /\ UNCHANGED <<alive, inc, run, res, expired, woke, orphans, tok, restarts, day, done,
                 foreign, blockedDead, sent, statusOk>>

\* Пробуждение отвязано от раннера: идёт по факту и после его смерти.
Wake(t) ==
  /\ t \in facts /\ t \notin woke
  /\ woke' = woke \cup {t}
  /\ UNCHANGED <<alive, inc, phase, run, res, expired, facts, failed, orphans, tok, fails,
                 restarts, day, done, loud, foreign, blockedDead, sent, quiet, statusOk>>

\* Снятие брони итогом или finally: своя — снимается, чужая — нет (мутант снимает).
Release(q) ==
  IF Owns(q) THEN res' = NoRes /\ UNCHANGED foreign
  ELSE IF ForeignClear /\ res # NoRes THEN res' = NoRes /\ foreign' = TRUE
  ELSE UNCHANGED <<res, foreign>>

Complete(q) ==
  /\ alive[q] /\ phase[q] = "complete"
  /\ \/ /\ Release(q) /\ phase' = [phase EXCEPT ![q] = "idle"]
        /\ done' = done \cup {run[q]}
        /\ statusOk' = IF SparseNoStatus
                          THEN statusOk
                          ELSE statusOk \cup ({run[q]} \cap quiet)
        /\ UNCHANGED fails
     \/ /\ CanFail /\ fails' = fails + 1 /\ phase' = [phase EXCEPT ![q] = "cleanup"]
        /\ UNCHANGED <<res, foreign, done, statusOk>>
  /\ UNCHANGED <<alive, inc, run, expired, facts, failed, woke, orphans, tok, restarts, day,
                 loud, blockedDead, sent, quiet>>

Cleanup(q) ==
  /\ alive[q] /\ phase[q] = "cleanup"
  /\ \/ Release(q)
     \/ UNCHANGED <<res, foreign>>      \* best-effort: бронь остаётся до срока или смерти
  /\ phase' = [phase EXCEPT ![q] = "idle"]
  /\ UNCHANGED <<alive, inc, run, expired, facts, failed, woke, orphans, tok, fails, restarts,
                 day, done, loud, blockedDead, sent, quiet, statusOk>>

\* Срок брони прошёл; раннер владельца шлёт SIGTERM, ребёнок выходит (Grace — живёт ещё).
Expire ==
  /\ Deadline /\ res # NoRes /\ ~expired
  /\ expired' = TRUE
  /\ IF ~Grace /\ alive[res.p] /\ inc[res.p] = res.inc /\ phase[res.p] = "child"
       THEN phase' = [phase EXCEPT ![res.p] = IF NoFact THEN "complete" ELSE "fact"]
       ELSE UNCHANGED phase
  /\ UNCHANGED <<alive, inc, run, res, facts, failed, woke, orphans, tok, fails, restarts,
                 day, done, loud, foreign, blockedDead, sent, quiet, statusOk>>

Die(q) ==
  /\ alive[q] /\ restarts < MaxRestarts
  /\ alive' = [alive EXCEPT ![q] = FALSE]
  /\ orphans' = IF Orphan /\ phase[q] = "child" THEN orphans + 1 ELSE orphans
  /\ phase' = [phase EXCEPT ![q] = "idle"]
  /\ UNCHANGED <<inc, run, res, expired, facts, failed, woke, tok, fails, restarts, day, done,
                 loud, foreign, blockedDead, sent, quiet, statusOk>>

Restart(q) ==
  /\ ~alive[q] /\ restarts < MaxRestarts
  /\ alive' = [alive EXCEPT ![q] = TRUE] /\ inc' = [inc EXCEPT ![q] = @ + 1]
  /\ restarts' = restarts + 1
  /\ UNCHANGED <<phase, run, res, expired, facts, failed, woke, orphans, tok, fails, day, done,
                 loud, foreign, blockedDead, sent, quiet, statusOk>>

OrphanExit ==
  /\ orphans > 0 /\ orphans' = orphans - 1
  /\ UNCHANGED <<alive, inc, phase, run, res, expired, facts, failed, woke, tok, fails,
                 restarts, day, done, loud, foreign, blockedDead, sent, quiet, statusOk>>

\* Сторож: провал без состоявшегося хода агента после него — сообщение; дроссель — сутки.
Watch ==
  /\ sent = 0
  /\ \E t \in failed : \A u \in woke : u < t
  /\ sent' = 1
  /\ UNCHANGED <<alive, inc, phase, run, res, expired, facts, failed, woke, orphans, tok,
                 fails, restarts, day, done, loud, foreign, blockedDead, quiet, statusOk>>

Day ==
  /\ day < MaxDays /\ day' = day + 1 /\ sent' = 0
  /\ UNCHANGED <<alive, inc, phase, run, res, expired, facts, failed, woke, orphans, tok,
                 fails, restarts, done, loud, foreign, blockedDead, quiet, statusOk>>

Next ==
  \/ \E q \in Procs :
       Admit(q) \/ Skip(q) \/ ChildExit(q) \/ Fact(q) \/ Complete(q) \/ Cleanup(q)
       \/ Die(q) \/ Restart(q)
  \/ \E t \in Tokens : Wake(t)
  \/ Expire \/ OrphanExit \/ Watch \/ Day

Spec == Init /\ [][Next]_vars

\* ---------- инварианты ----------

TypeOK ==
  /\ phase \in [Procs -> {"idle", "child", "fact", "complete", "cleanup"}]
  /\ res \in {NoRes} \cup [p : Procs, inc : 1..(MaxRestarts + 1), t : Tokens]
  /\ facts \subseteq Tokens /\ failed \subseteq facts /\ woke \subseteq facts
  /\ quiet \subseteq Tokens /\ statusOk \subseteq quiet /\ statusOk \subseteq done

\* (1) У одного расписания не больше одного живого запуска (ребёнка).
OneLive == LiveChildren <= 1

\* (2) Бронь мёртвого владельца не держит допуск.
DeadFreed == ~blockedDead

\* (3) Завершённый запуск (раннер дошёл до итога в статус) оставляет след: строку в таблице
\* фактов — провал при любой политике, успех при always или после провала прошлого факта
\* (after-failure), — либо его промис отклонён с причиной «fact not recorded». Успех,
\* пропущенный политикой, записан в статус успехом (lastSuccessAt).
FactKept ==
  /\ \A t \in done : t \in facts \/ t \in loud \/ t \in quiet
  /\ \A t \in done \cap quiet : t \in statusOk

\* (4) Итог и уборка не снимают чужую бронь.
NoForeignClear == ~foreign

\* Сторож: не больше одного сообщения за сутки.
WatchOnce == sent <= 1

====
