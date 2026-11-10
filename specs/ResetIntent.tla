---- MODULE ResetIntent ----
\* Интент сброса: /new личного чата через перезапуск Bridge (машина №5 разбора машин состояний).
\* Модель описывает код, написанный раньше неё.
\*
\* Что описывает. Один личный чат. Telegram держит апдейты 1..N по порядку и отдаёт их с
\* offset; offset на диске сдвигается только после разбора апдейта. Апдейты из News — /new,
\* остальные — обычные сообщения. Очередь чата на диске (scripts/lib/telegram-queue.ts), файл
\* намерения на диске (scripts/lib/telegram-reset-intent.ts, хранит discardThroughUpdateId),
\* память Bridge (scripts/poller/queue.ts): зеркало «намерение записано» для ограды, счёт
\* отказов, отсрочка повтора и отметка «эскалация отправлена». Агент: сессия чата
\* (номер поколения), ход на доставку, сброс сессии по просьбе Bridge. Главный цикл Bridge:
\* разбор /new шагами performScopedReset, приём обычного сообщения, слив очереди. Сверка
\* намерений — фоновый слот Bridge (scheduleResetIntentReconciliation) и сверка при старте.
\* Перезапуск Bridge между любыми двумя шагами: память пуста, диск цел. Запрос сброса,
\* который агент уже принял из маршрута (agent/lib/telegram-reset-route.ts), перезапуск
\* переживает: клиент мог умереть, а resolveSession ещё идёт. Адрес разрешается в момент
\* завершения запроса, поэтому поздний сброс бьёт по сессии, в которую новый Bridge уже
\* доставил сообщение после отсечки. Номер завершённого сброса ограждает сессию от старых
\* запросов: если после приёма запроса чат уже сбросили, он ничего не делает (AgentStale,
\* шаг AgentDone). Восстановление заканчивается независимо от прежнего resolveSession.
\*
\* Чего не описывает: время (отсрочка 30 с и 5 мин — шаг Expire; срок доставки, ожидание
\* running); групповые чаты (там очередь не чистится и намерения нет); черновик ответа и правку
\* сообщения «сбрасываю…» (ответ владельцу — счётчики); ошибки чтения каталога намерений и файла
\* очереди при старте (Bridge тогда не стартует); склейку пачек и inbox (приём апдейта и маршрут —
\* один шаг); /restart (тот же путь, плюс перезапуск сервиса); двойной процесс Bridge (его
\* исключает замок процесса, specs/... нет, scripts/poller/process-lock.ts).
\*
\* Сверка и главный путь сброса одного чата идут по одной очереди чата (chatResetTails в
\* scripts/poller/queue.ts): сверка берёт её, перечитывает намерение с диска и исполняет
\* удалённый сброс только для того же discardThroughUpdateId; /new и доставка из очереди
\* чата ждут, пока сверка держит очередь. RecInterleave — часть основной конфигурации:
\* проход сверки идёт, пока главный цикл разбирает следующий апдейт. Мутант -interleave
\* (RecReread = FALSE) — сверка берёт очередь, но не перечитывает намерение: запоздалый
\* сброс стирает сессию, в которую /new уже доставил следующее сообщение.
\*
\* Действие модели -> файл:функция
\*   Admit        scripts/poller/main.ts processTelegramUpdate -> inbox -> routing.ts
\*                routeMessageUpdate: при ограде сброса (hasPrivateResetIntent) или непустой
\*                очереди — в очередь, иначе прямая доставка или очередь (занятый чат); offset
\*                сдвинут
\*   Drain        routing.ts drainReadyQueueHeads: ограда закрыта — чат пропускается
\*   NewStart     control.ts startReset / holdForPendingRetry по фазе намерения
\*   Persist      queue.ts performScopedReset -> persistPrivateResetIntent
\*   Remote       queue.ts releaseScopedSession: агент сбрасывает сессию; отказ после сброса
\*                (агент сбросил, Bridge не узнал) — тот же отказ
\*   Complete     queue.ts completeScopedResetState -> clearChatQueue(discardThroughUpdateId)
\*   ClearIntent  queue.ts clearPrivateResetIntent (+ clearResetRetryState)
\*   Confirm      control.ts finishReset: «Диалог сброшен»
\*   Save         main.ts processTelegramUpdate: saveOffset(update_id + 1)
\*   RecLoad      queue.ts loadPrivateResetIntents внутри reconcileScopedResetIntents:
\*                скан каталога намерений и зеркало ограды
\*   RecTake      reconcileScopedResetIntents: очередь сброса чата взята, намерение
\*                перечитано с диска (RecReread); намерения нет или cut другой — сброса нет
\*   RecRemote / RecComplete / RecClear — шаги reconcileScopedResetIntents под очередью
\*                чата; отказ: счёт, отсрочка, эскалация владельцу на EscalateAt-м отказе
\*                один раз за процесс
\*   Expire       прошёл срок отсрочки (resetIntentRetryAt)
\*   Restart      Bridge умер; при старте сверка до первого getUpdates (main.ts main)
\*   Remote       агент принял запрос сброса из маршрута: запрос остаётся у агента (pending)
\*   AgentDone    агент закончил запрос: адрес разрешён, сброс идёт по текущей сессии;
\*                AgentStale — запрос, после приёма которого чат уже сбросили, ничего не
\*                делает (telegram-reset-route.ts: resetAcceptedSeq, resetCompletedByAddress)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
  N,              \* апдейты 1..N
  News,           \* какие из них /new
  MaxFail,        \* сколько отказов среды всего (запись, агент, очистка)
  MaxRestarts,
  EscalateAt,     \* RESET_INTENT_ESCALATION_ATTEMPTS (в коде 10)
  ClearFirst,     \* мутант: намерение снимается до очистки очереди
  ClearAll,       \* мутант: очередь чистится по последний в очереди, а не по записанный update_id
  ConfirmOnRecovery, \* мутант: сверка тоже подтверждает сброс
  ConfirmWindow,  \* свидетель: перезапуск между «Диалог сброшен» и записью offset
  RecInterleave,  \* проход сверки идёт, пока главный цикл разбирает следующий апдейт
  RecReread,      \* мутант: сверка исполняет сброс, не перечитав намерение с диска
  AgentStale      \* мутант: запоздалый сброс не смотрит, что чат уже сбросили после приёма

Ids == 1..N
Plain == Ids \ News
NoIntent == 0

VARIABLES
  off,        \* диск: следующий апдейт, который отдаст Telegram
  queue,      \* диск: id в очереди чата
  intent,     \* диск: discardThroughUpdateId файла намерения, 0 — файла нет
  gen,        \* агент: поколение сессии чата
  turns,      \* агент: <<id, поколение>> доставленных сообщений
  mirror,     \* память: pendingResetIntentKeys содержит чат
  mainWaits,  \* память: номер принятого запроса, ответ которого ждёт главный цикл (0 — нет)
  recWaits,   \* память: номер принятого запроса, ответ которого ждёт сверка (0 — нет)
  fails,      \* память: resetIntentFailureCount
  backoff,    \* память: срок resetIntentRetryAt ещё не прошёл
  escalated,  \* память: resetIntentEscalationDelivered
  main,       \* главный цикл: "boot" | "loop" | "persist" | "remote" | "complete" | "clear" | "confirm" | "save"
  cur,        \* /new, который разбирает главный цикл (0 — нет)
  rec,        \* сверка: "idle" | "remote" | "complete" | "clear"
  recU,       \* discardThroughUpdateId, загруженный сверкой
  booted,     \* сверка при старте прошла загрузку
  confirms,   \* призрак: «Диалог сброшен» на каждый /new
  answered,   \* призрак: /new, получившие любой итог (сброшен, отказ, повтор позже)
  gaveUp,     \* призрак: /new, отпущенные с текстом «запусти iva reset»
  resetGen,   \* призрак: поколение после первого сброса сессии ради /new u (0 — не было)
  wiped,      \* призрак: сброс ради u стёр сессию, где уже было сообщение после u
  escalations,\* призрак: эскалаций за жизнь процесса
  failsUsed,
  restarts,
  pending,    \* агент: принятые и не законченные запросы сброса <<кто, u, номер приёма>>
  acceptSeq,  \* агент: номер последнего принятого запроса
  doneSeq     \* агент: номер последнего законченного запроса сброса этого чата

vars == <<off, queue, intent, gen, turns, mirror, mainWaits, recWaits, fails, backoff,
          escalated, main, cur, rec, recU, booted, confirms, answered, gaveUp, resetGen,
          wiped, escalations, failsUsed, restarts, pending, acceptSeq, doneSeq>>
diskless == <<mirror, mainWaits, recWaits, fails, backoff, escalated>>
agent == <<pending, acceptSeq, doneSeq>>   \* память агента о принятых запросах сброса

\* Фаза намерения по записи и памяти — resetIntentPhase (scripts/lib/telegram-reset-intent.ts).
Phase ==
  IF ~mirror THEN (IF backoff THEN "blocked" ELSE "none")
  ELSE IF ~backoff THEN "recorded"
  ELSE IF escalated THEN "escalated" ELSE "waiting"

Fence == Phase \in {"recorded", "waiting", "escalated"}
RetryPending == Phase \in {"blocked", "waiting", "escalated"}

\* Очередь сброса чата: главный путь держит её от записи намерения до его снятия, сверка —
\* от перечитывания намерения до его снятия.
MainHolds == main \in {"persist", "remote", "await", "complete", "clear"}
RecHolds == rec \in {"remote", "await", "complete", "clear"}

Max(S) == CHOOSE x \in S : \A y \in S : y <= x

Init ==
  /\ off = 1 /\ queue = {} /\ intent = NoIntent /\ gen = 1 /\ turns = {}
  /\ mirror = FALSE /\ fails = 0 /\ backoff = FALSE /\ escalated = FALSE
  /\ mainWaits = 0 /\ recWaits = 0
  /\ main = "loop" /\ cur = 0 /\ rec = "idle" /\ recU = 0 /\ booted = TRUE
  /\ confirms = [u \in News |-> 0] /\ answered = {} /\ gaveUp = {}
  /\ resetGen = [u \in News |-> 0] /\ wiped = FALSE /\ escalations = 0
  /\ failsUsed = 0 /\ restarts = 0
  /\ pending = <<>> /\ acceptSeq = 0 /\ doneSeq = 0

CanFail == failsUsed < MaxFail

\* Сброс сессии агентом ради u: новое поколение.
ResetSession(u) ==
  /\ gen' = gen + 1
  /\ resetGen' = IF resetGen[u] = 0 THEN [resetGen EXCEPT ![u] = gen + 1] ELSE resetGen
  /\ wiped' = (wiped \/ \E t \in turns : t[1] > u /\ t[2] = gen)

\* clearChatQueue: элементы с id <= through уходят, остальные остаются.
Cleared(through) ==
  IF ClearAll THEN {} ELSE {x \in queue : x > through}

\* Отказ шага с отсрочкой (recordResetFailure + deferResetRetry).
FailMemory ==
  /\ failsUsed' = failsUsed + 1
  /\ fails' = fails + 1
  /\ backoff' = TRUE

\* ---------- главный цикл ----------

Admit ==
  /\ main = "loop" /\ off <= N /\ off \in Plain
  /\ ~RecHolds                        \* прямая доставка ждёт очередь сброса чата
  /\ \/ (Fence \/ queue # {}) /\ queue' = queue \cup {off} /\ UNCHANGED turns
     \/ ~Fence /\ queue = {} /\ turns' = turns \cup {<<off, gen>>} /\ UNCHANGED queue
     \/ ~Fence /\ queue = {} /\ queue' = queue \cup {off} /\ UNCHANGED turns  \* чат занят ходом
  /\ off' = off + 1
  /\ UNCHANGED <<intent, gen, diskless, main, cur, rec, recU, booted, confirms, answered,
                 gaveUp, resetGen, wiped, escalations, failsUsed, restarts, agent, mainWaits, recWaits>>

Drain ==
  /\ main = "loop" /\ ~Fence /\ queue # {}
  /\ ~RecHolds
  /\ \E x \in queue :
       /\ \A y \in queue : x <= y
       /\ queue' = queue \ {x}
       /\ turns' = turns \cup {<<x, gen>>}
  /\ UNCHANGED <<off, intent, gen, diskless, main, cur, rec, recU, booted, confirms,
                 answered, gaveUp, resetGen, wiped, escalations, failsUsed, restarts, agent, mainWaits, recWaits>>

NewStart ==
  /\ main = "loop" /\ off <= N /\ off \in News
  /\ ~RecHolds                        \* /new берёт очередь сброса чата
  /\ Phase # "blocked"          \* blocked: апдейт остаётся в Telegram (answerPendingRetry бросает)
  /\ IF Phase \in {"waiting", "escalated"}
       THEN \* «повтор запланирован»: намерение на диске, апдейт подтверждается
            /\ answered' = answered \cup {off}
            /\ off' = off + 1
            /\ UNCHANGED <<main, cur>>
       ELSE /\ main' = "persist" /\ cur' = off
            /\ UNCHANGED <<off, answered>>
  /\ UNCHANGED <<queue, intent, gen, turns, diskless, rec, recU, booted, confirms, gaveUp,
                 resetGen, wiped, escalations, failsUsed, restarts, agent, mainWaits, recWaits>>

Persist ==
  /\ main = "persist"
  /\ \/ /\ intent' = cur /\ mirror' = TRUE /\ main' = "remote"
        /\ UNCHANGED <<off, fails, backoff, failsUsed, answered, gaveUp, cur>>
     \/ /\ CanFail /\ FailMemory /\ UNCHANGED <<intent, mirror>>
        /\ answered' = answered \cup {cur}
        /\ IF fails + 1 >= EscalateAt
             THEN \* «не удалось сохранить сброс, запусти iva reset»: апдейт отпущен
                  /\ gaveUp' = gaveUp \cup {cur} /\ off' = cur + 1
             ELSE /\ UNCHANGED <<gaveUp, off>>
        /\ main' = "loop" /\ cur' = 0
  /\ UNCHANGED <<queue, gen, turns, escalated, rec, recU, booted, confirms, resetGen,
                 wiped, escalations, restarts, agent, mainWaits, recWaits>>

\* Мост позвал маршрут сброса, агент запрос принял: сброс идёт, когда resolveSession вернётся,
\* — возможно, уже после перезапуска Bridge (AgentDone).
Remote ==
  /\ main = "remote"
  /\ \/ /\ acceptSeq' = acceptSeq + 1
        /\ pending' = Append(pending, <<"main", cur, acceptSeq + 1>>)
        /\ main' = "await" /\ mainWaits' = acceptSeq + 1
        /\ UNCHANGED <<gen, resetGen, wiped, off, fails, backoff, failsUsed, answered, cur,
                       doneSeq, recWaits>>
     \/ /\ CanFail /\ FailMemory
        /\ UNCHANGED <<pending, acceptSeq, doneSeq, mainWaits, recWaits>>
        /\ \/ ResetSession(cur)                       \* агент сбросил, Bridge не узнал
           \/ UNCHANGED <<gen, resetGen, wiped>>
        \* «не удалось подтвердить сброс, восстановление повторит его»: апдейт подтверждается
        /\ answered' = answered \cup {cur} /\ off' = cur + 1
        /\ main' = "loop" /\ cur' = 0
  /\ UNCHANGED <<queue, intent, turns, mirror, escalated, rec, recU, booted, confirms,
                 gaveUp, escalations, restarts>>

\* RemoveAt(pending, i): очередь запросов у агента без i-го.
RemoveAt(seq, i) ==
  [j \in 1..(Len(seq) - 1) |-> IF j < i THEN seq[j] ELSE seq[j + 1]]

\* Агент закончил запрос: адрес разрешён в этот момент, поэтому сброс бьёт по сессии, которая
\* сейчас владеет чатом, — в том числе по той, куда новый Bridge уже доставил сообщение после
\* отсечки. AgentStale: если после приёма запроса чат уже сбросили (doneSeq больше номера
\* приёма), запоздалый запрос ничего не делает.
AgentDone ==
  /\ \E i \in 1..Len(pending) :
       /\ pending' = RemoveAt(pending, i)
       /\ IF AgentStale /\ pending[i][3] < doneSeq
            THEN UNCHANGED <<gen, resetGen, wiped, doneSeq>>
            ELSE /\ ResetSession(pending[i][2])
                 /\ doneSeq' = (IF doneSeq < pending[i][3]
                                  THEN pending[i][3] ELSE doneSeq)
       /\ IF (main = "await") /\ (pending[i][3] = mainWaits)
            THEN /\ main' = (IF ClearFirst THEN "clear" ELSE "complete")
                 /\ mainWaits' = 0
                 /\ UNCHANGED <<rec, recWaits>>
            ELSE IF (rec = "await") /\ (pending[i][3] = recWaits)
                 THEN /\ rec' = (IF ClearFirst THEN "clear" ELSE "complete")
                      /\ recWaits' = 0
                      /\ UNCHANGED <<main, mainWaits>>
                 ELSE UNCHANGED <<main, mainWaits, rec, recWaits>>
  /\ UNCHANGED <<off, queue, intent, turns, mirror, fails, backoff, escalated, cur, recU,
                 booted, confirms, answered, gaveUp, escalations, failsUsed, restarts,
                 acceptSeq>>

\* Неудача очистки или снятия: текст «восстановление не завершено», апдейт ждёт в Telegram.
StepFails ==
  /\ CanFail /\ FailMemory
  /\ answered' = answered \cup {cur}
  /\ main' = "loop" /\ cur' = 0

Complete ==
  /\ main = "complete"
  /\ \/ /\ queue' = Cleared(cur)
        /\ main' = (IF ClearFirst THEN "confirm" ELSE "clear")
        /\ UNCHANGED <<fails, backoff, failsUsed, answered, cur>>
     \/ StepFails /\ UNCHANGED queue
  /\ UNCHANGED <<off, intent, gen, turns, mirror, escalated, rec, recU, booted, confirms,
                 gaveUp, resetGen, wiped, escalations, restarts, agent, mainWaits, recWaits>>

ClearIntent ==
  /\ main = "clear"
  /\ \/ /\ intent' = NoIntent /\ mirror' = FALSE
        /\ fails' = 0 /\ backoff' = FALSE /\ escalated' = FALSE
        /\ main' = (IF ClearFirst THEN "complete" ELSE "confirm")
        /\ UNCHANGED <<failsUsed, answered, cur>>
     \/ StepFails /\ UNCHANGED <<intent, mirror, escalated>>
  /\ UNCHANGED <<off, queue, gen, turns, rec, recU, booted, confirms, gaveUp, resetGen,
                 wiped, escalations, restarts, agent, mainWaits, recWaits>>

Confirm ==
  /\ main = "confirm"
  /\ confirms' = [confirms EXCEPT ![cur] = @ + 1]
  /\ answered' = answered \cup {cur}
  /\ fails' = 0 /\ backoff' = FALSE /\ escalated' = FALSE
  /\ main' = "save"
  /\ UNCHANGED <<off, queue, intent, gen, turns, mirror, cur, rec, recU, booted, gaveUp,
                 resetGen, wiped, escalations, failsUsed, restarts, agent, mainWaits, recWaits>>

Save ==
  /\ main = "save"
  /\ off' = cur + 1 /\ main' = "loop" /\ cur' = 0
  /\ UNCHANGED <<queue, intent, gen, turns, diskless, rec, recU, booted, confirms, answered,
                 gaveUp, resetGen, wiped, escalations, failsUsed, restarts, agent, mainWaits, recWaits>>

\* ---------- сверка ----------

RecLoad ==
  /\ rec = "idle"
  /\ RecInterleave \/ main \in {"loop", "boot"}
  /\ mirror' = (intent # NoIntent)
  /\ booted' = TRUE
  /\ IF intent # NoIntent /\ ~backoff
       THEN rec' = "loaded" /\ recU' = intent
       ELSE UNCHANGED <<rec, recU>>
  /\ UNCHANGED <<off, queue, intent, gen, turns, fails, backoff, escalated, main, cur,
                 confirms, answered, gaveUp, resetGen, wiped, escalations, failsUsed, restarts, agent, mainWaits, recWaits>>

\* Очередь сброса чата взята, намерение перечитано с диска: удалённый сброс идёт только
\* для намерения, которое всё ещё лежит на диске в том же виде. Мутант RecReread = FALSE
\* берёт записанный при скане cut и сбрасывает сессию, которую /new уже заменил.
RecTake ==
  /\ rec = "loaded" /\ ~MainHolds
  /\ IF ~RecReread \/ intent = recU
       THEN rec' = "remote" /\ UNCHANGED recU
       ELSE rec' = "idle" /\ recU' = 0
  /\ UNCHANGED <<off, queue, intent, gen, turns, diskless, main, cur, booted, confirms,
                 answered, gaveUp, resetGen, wiped, escalations, failsUsed, restarts, agent, mainWaits, recWaits>>

RecFails ==
  /\ CanFail /\ FailMemory
  /\ IF fails + 1 >= EscalateAt /\ ~escalated
       THEN escalated' = TRUE /\ escalations' = escalations + 1
       ELSE UNCHANGED <<escalated, escalations>>
  /\ rec' = "idle"

RecRemote ==
  /\ rec = "remote"
  /\ \/ /\ acceptSeq' = acceptSeq + 1
        /\ pending' = Append(pending, <<"recovery", recU, acceptSeq + 1>>)
        /\ rec' = "await" /\ recWaits' = acceptSeq + 1
        /\ UNCHANGED <<gen, resetGen, wiped, fails, backoff, escalated, escalations,
                       failsUsed, doneSeq, mainWaits>>
     \/ /\ RecFails
        /\ UNCHANGED <<pending, acceptSeq, doneSeq, mainWaits, recWaits>>
        /\ \/ ResetSession(recU)                      \* агент сбросил, Bridge не узнал
           \/ UNCHANGED <<gen, resetGen, wiped>>
  /\ UNCHANGED <<off, queue, intent, turns, mirror, main, cur, recU, booted, confirms,
                 answered, gaveUp, restarts>>

RecComplete ==
  /\ rec = "complete"
  /\ \/ /\ queue' = Cleared(recU)
        /\ rec' = (IF ClearFirst THEN "idle" ELSE "clear")
        /\ UNCHANGED <<fails, backoff, escalated, escalations, failsUsed>>
     \/ RecFails /\ UNCHANGED queue
  /\ UNCHANGED <<off, intent, gen, turns, mirror, main, cur, recU, booted, confirms,
                 answered, gaveUp, resetGen, wiped, restarts, agent, mainWaits, recWaits>>

RecClear ==
  /\ rec = "clear"
  /\ \/ /\ intent' = NoIntent /\ mirror' = FALSE
        /\ fails' = 0 /\ backoff' = FALSE /\ escalated' = FALSE
        /\ rec' = (IF ClearFirst THEN "complete" ELSE "idle")
        /\ confirms' = IF ConfirmOnRecovery
                         THEN [confirms EXCEPT ![recU] = @ + 1] ELSE confirms
        /\ UNCHANGED <<escalations, failsUsed>>
     \/ RecFails /\ UNCHANGED <<intent, mirror, confirms>>
  /\ UNCHANGED <<off, queue, gen, turns, main, cur, recU, booted, answered, gaveUp,
                 resetGen, wiped, restarts, agent, mainWaits, recWaits>>

\* ---------- время, перезапуск, старт ----------

Expire ==
  /\ backoff /\ backoff' = FALSE
  /\ UNCHANGED <<off, queue, intent, gen, turns, mirror, fails, escalated, main, cur, rec,
                 recU, booted, confirms, answered, gaveUp, resetGen, wiped, escalations,
                 failsUsed, restarts, agent, mainWaits, recWaits>>

Restart ==
  /\ restarts < MaxRestarts
  /\ ConfirmWindow \/ main # "save"
  /\ restarts' = restarts + 1
  /\ mirror' = FALSE /\ fails' = 0 /\ backoff' = FALSE /\ escalated' = FALSE
  /\ mainWaits' = 0 /\ recWaits' = 0
  /\ main' = "boot" /\ cur' = 0 /\ rec' = "idle" /\ recU' = 0 /\ booted' = FALSE
  /\ escalations' = 0
  /\ UNCHANGED <<off, queue, intent, gen, turns, confirms, answered, gaveUp, resetGen,
                 wiped, failsUsed, agent>>

\* main.ts main: первый getUpdates — после сверки при старте.
BootDone ==
  /\ main = "boot" /\ booted /\ rec = "idle"
  /\ main' = "loop"
  /\ UNCHANGED <<off, queue, intent, gen, turns, diskless, cur, rec, recU, booted, confirms,
                 answered, gaveUp, resetGen, wiped, escalations, failsUsed, restarts, agent, mainWaits, recWaits>>

Done ==
  /\ main = "loop" /\ off > N /\ queue = {} /\ rec = "idle" /\ intent = NoIntent
  /\ UNCHANGED vars

Next ==
  \/ Admit \/ Drain \/ NewStart \/ Persist \/ Remote \/ AgentDone \/ Complete \/ ClearIntent
  \/ Confirm \/ Save \/ RecLoad \/ RecTake \/ RecRemote \/ RecComplete \/ RecClear
  \/ Expire \/ Restart \/ BootDone \/ Done

Fairness ==
  /\ WF_vars(Admit) /\ WF_vars(Drain) /\ WF_vars(NewStart) /\ WF_vars(Persist)
  /\ WF_vars(Remote) /\ WF_vars(AgentDone) /\ WF_vars(Complete)
  /\ WF_vars(ClearIntent) /\ WF_vars(Confirm)
  /\ WF_vars(Save) /\ WF_vars(RecLoad) /\ WF_vars(RecTake) /\ WF_vars(RecRemote)
  /\ WF_vars(RecComplete)
  /\ WF_vars(RecClear) /\ WF_vars(Expire) /\ WF_vars(BootDone)

Spec == Init /\ [][Next]_vars /\ Fairness

\* ---------- инварианты ----------

TypeOK ==
  /\ off \in 1..(N + 1) /\ queue \subseteq Plain /\ intent \in {NoIntent} \cup News
  /\ main \in {"boot", "loop", "persist", "remote", "await", "complete", "clear",
              "confirm", "save"}
  /\ rec \in {"idle", "loaded", "remote", "await", "complete", "clear"}
  /\ doneSeq <= acceptSeq /\ Len(pending) <= acceptSeq
  /\ mainWaits <= acceptSeq /\ recWaits <= acceptSeq
  /\ \A i \in 1..Len(pending) : /\ pending[i][1] \in {"main", "recovery"}
                                 /\ pending[i][3] <= acceptSeq

\* (1) После /new очередь чата очищена ровно по записанный update_id: сообщение до /new не
\* попадает в новую сессию, сообщение после /new не теряется, не идёт в старую сессию и не
\* стирается повторным сбросом.
ExactCut ==
  /\ \A m \in Plain : m < off =>
       \/ m \in queue
       \/ \E t \in turns : t[1] = m
       \/ \E u \in News : m < u /\ resetGen[u] # 0   \* /new u отбросил его намеренно
  /\ \A t \in turns, u \in News :
       /\ t[1] < u /\ resetGen[u] # 0 => t[2] < resetGen[u]
       /\ t[1] > u /\ u \notin gaveUp => resetGen[u] # 0 /\ t[2] >= resetGen[u]
  /\ ~wiped

\* (2) Намерение снимается только после очистки: нет файла намерения — нет в очереди
\* сообщений до последнего /new, который сбросил сессию.
IntentUntilClean ==
  intent = NoIntent =>
    \A u \in News : resetGen[u] # 0 => \A x \in queue : x > u

\* (3) Владелец получает «Диалог сброшен» на один /new не больше одного раза.
ConfirmOnce == \A u \in News : confirms[u] <= 1

\* Эскалация — одна за жизнь процесса.
EscalationOnce == escalations <= 1

\* (4) Перезапуск на любом шаге доводит намерение до конца: каждый /new получает итог, и
\* намерение снимается после сброса сессии и очистки очереди — либо владелец получил
\* «запусти iva reset».
Finished ==
  <>[](/\ intent = NoIntent
       /\ \A u \in News : u \in answered
       /\ \A u \in News : u \in gaveUp \/ resetGen[u] # 0)

====
