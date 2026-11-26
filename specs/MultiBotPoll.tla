---- MODULE MultiBotPoll ----
\* Приём обновлений Telegram от нескольких ботов одним процессом Bridge (ADR-0030).
\* Модель написана ДО кода: проверяет инварианты изоляции курсоров (offset), одного замка
\* процесса, переживания перезапуска между admit и записью offset, независимости ботов при
\* задержке одного из них и точной атрибуции бота при совпадении update_id.
\*
\* Действия модели -> код:
\*   StartProc(p)      scripts/poller/main.ts: acquireTelegramProcessLock + prepareTelegramStartup
\*   CrashProc(p)      обрыв/перезапуск процесса Bridge; замок ОС снимается, память теряется,
\*                     дисковые offset и inbox переживают перезапуск
\*   TelegramReceive   Telegram Bot API выдаёт следующий независимый update_id для бота b
\*   ToggleSlow(b)     бот b подвис на long-poll / получил 409 conflict backoff или восстановился
\*   Admit(p, b)       scripts/poller/inbox.ts: admitTelegramUpdate с меткой бота b (iva_bot_id)
\*   SaveOffset(p, b)  scripts/poller/offset.ts: saveOffset в файл бота b (или общий в мутанте)
\*   ToggleColleagues  владелец включает/выключает опцию colleagues (iva colleague on/off)
\*   InitColleague(p, b)  scripts/poller/main.ts: lazy init коллеги после включения опции
\*   ManagedHire*        scripts/poller/managed-bot.ts: durable стадии найма коллеги
\*
\* Переключатели (TRUE в рабочей модели; каждый мутант снимает один):
\*   PerBotOffset        свой файл offset на каждого бота (FALSE -> общий курсор)
\*   EnforceProcessLock  один процесс под общим замком (FALSE -> два поллера одновременно)
\*   PerBotTag           метка бота в ключе inbox (FALSE -> общий update_id двух ботов сталкивается)
\*   PreserveActivationBacklog  первая активация коллеги сохраняет очередь (FALSE -> drop/fast-forward)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Bots,
  Procs,
  MaxUpdates,
  MaxRestarts,
  PerBotOffset,
  EnforceProcessLock,
  PerBotTag,
  PreserveActivationBacklog

ASSUME MaxUpdates \in Nat \ {0}
ASSUME MaxRestarts \in Nat
ASSUME {PerBotOffset, EnforceProcessLock, PerBotTag, PreserveActivationBacklog} \subseteq BOOLEAN

Updates == 1..MaxUpdates
Offsets == 1..(MaxUpdates + 1)

VARIABLES
  lockHolder,     \* процесс, держащий telegram-poll.lock, либо "none"
  procState,      \* [Procs -> {"idle", "running"}]
  tgUpdates,      \* [Bots -> 0..MaxUpdates] — сколько апдейтов выдал Telegram боту b
  diskOffset,     \* [Bots -> Offsets] — сохранённый на диск курсор каждого бота
  memOffset,      \* [Procs -> [Bots -> Offsets]] — курсор в памяти процесса
  pendingSave,    \* [Procs -> [Bots -> 0..(MaxUpdates + 1)]] — admit прошёл, saveOffset впереди
  botSlow,        \* [Bots -> BOOLEAN] — бот временно медленный / в backoff
  admitted,       \* SUBSET (Bots \X Updates) — апдейты, принятые в durable inbox
  inboxUntagged,  \* SUBSET Updates — при ~PerBotTag: ключи без метки бота
  restarts,       \* 0..MaxRestarts
  overlapBad,     \* два процесса одновременно опрашивали Telegram
  wrongBotBad,    \* апдейт бота потерялся из-за столкновения update_id другого бота
  colleaguesEnabled, \* опция коллег в настройках; по умолчанию FALSE
  initialized,      \* [Procs -> [Bots -> BOOLEAN]] — lazy init бота завершён в этом процессе
  hireStage,        \* durable найм colleague: none/profile/settings/complete/terminal
  hireEventBlocked  \* управляющее событие ещё держит acknowledgement ingress

vars == <<lockHolder, procState, tgUpdates, diskOffset, memOffset, pendingSave,
          botSlow, admitted, inboxUntagged, restarts, overlapBad, wrongBotBad,
          colleaguesEnabled, initialized, hireStage, hireEventBlocked>>

RunningProcs == {p \in Procs : procState[p] = "running"}

Init ==
  /\ lockHolder = "none"
  /\ procState = [p \in Procs |-> "idle"]
  /\ tgUpdates = [b \in Bots |-> 0]
  /\ diskOffset = [b \in Bots |-> 1]
  /\ memOffset = [p \in Procs |-> [b \in Bots |-> 1]]
  /\ pendingSave = [p \in Procs |-> [b \in Bots |-> 0]]
  /\ botSlow = [b \in Bots |-> FALSE]
  /\ admitted = {}
  /\ inboxUntagged = {}
  /\ restarts = 0
  /\ overlapBad = FALSE
  /\ wrongBotBad = FALSE
  /\ colleaguesEnabled = FALSE
  /\ initialized = [p \in Procs |-> [b \in Bots |-> b = "iva"]]
  /\ hireStage = "none"
  /\ hireEventBlocked = FALSE

StartProc(p) ==
  /\ procState[p] = "idle"
  /\ EnforceProcessLock => lockHolder = "none"
  /\ lockHolder' = IF EnforceProcessLock THEN p ELSE lockHolder
  /\ procState' = [procState EXCEPT ![p] = "running"]
  /\ memOffset' = [memOffset EXCEPT ![p] = diskOffset]
  /\ pendingSave' = [pendingSave EXCEPT ![p] = [b \in Bots |-> 0]]
  /\ initialized' = [initialized EXCEPT ![p] = [b \in Bots |-> b = "iva"]]
  /\ UNCHANGED <<tgUpdates, diskOffset, botSlow, admitted, inboxUntagged,
                 restarts, overlapBad, wrongBotBad, colleaguesEnabled, hireStage,
                 hireEventBlocked>>

CrashProc(p) ==
  /\ procState[p] = "running"
  /\ restarts < MaxRestarts
  /\ restarts' = restarts + 1
  /\ procState' = [procState EXCEPT ![p] = "idle"]
  /\ lockHolder' = IF lockHolder = p THEN "none" ELSE lockHolder
  /\ memOffset' = [memOffset EXCEPT ![p] = [b \in Bots |-> 1]]
  /\ pendingSave' = [pendingSave EXCEPT ![p] = [b \in Bots |-> 0]]
  /\ initialized' = [initialized EXCEPT ![p] = [b \in Bots |-> b = "iva"]]
  /\ UNCHANGED <<tgUpdates, diskOffset, botSlow, admitted, inboxUntagged,
                 overlapBad, wrongBotBad, colleaguesEnabled, hireStage, hireEventBlocked>>

TelegramReceive(b) ==
  /\ tgUpdates[b] < MaxUpdates
  /\ tgUpdates' = [tgUpdates EXCEPT ![b] = @ + 1]
  /\ UNCHANGED <<lockHolder, procState, diskOffset, memOffset, pendingSave,
                 botSlow, admitted, inboxUntagged, restarts, overlapBad, wrongBotBad,
                 colleaguesEnabled, initialized, hireStage, hireEventBlocked>>

ToggleSlow(b) ==
  /\ botSlow' = [botSlow EXCEPT ![b] = ~@]
  /\ UNCHANGED <<lockHolder, procState, tgUpdates, diskOffset, memOffset,
                 pendingSave, admitted, inboxUntagged, restarts, overlapBad, wrongBotBad,
                 colleaguesEnabled, initialized, hireStage, hireEventBlocked>>

\* Владелец переключает опцию colleagues. Цикл коллеги уже существует, но пока опция
\* выключена он спит до проверки настройки и не трогает Telegram.
ToggleColleagues ==
  /\ colleaguesEnabled' = ~colleaguesEnabled
  /\ UNCHANGED <<lockHolder, procState, tgUpdates, diskOffset, memOffset,
                 pendingSave, botSlow, admitted, inboxUntagged, restarts,
                 overlapBad, wrongBotBad, initialized, hireStage, hireEventBlocked>>

\* Отложенная инициализация коллеги после включения опции. В рабочей модели она
\* сохраняет очередь первой активации: отсутствие cursor-файла означает опрос с первого
\* неподтверждённого апдейта (модельный offset 1), а не fast-forward за хвост очереди.
\* Мутант PreserveActivationBacklog=FALSE воспроизводит ошибочный drop/fast-forward:
\* апдейты, пришедшие до включения, перепрыгиваются без durable admit и ловятся
\* инвариантом NoSkippedUpdate.
InitColleague(p, b) ==
  /\ procState[p] = "running"
  /\ b /= "iva"
  /\ colleaguesEnabled
  /\ hireStage = "complete"
  /\ ~initialized[p][b]
  /\ EnforceProcessLock => lockHolder = p
  /\ initialized' = [initialized EXCEPT ![p][b] = TRUE]
  /\ LET next == tgUpdates[b] + 1 IN
     /\ diskOffset' = IF PreserveActivationBacklog
          THEN diskOffset
          ELSE [diskOffset EXCEPT ![b] = IF diskOffset[b] = 1 THEN next ELSE diskOffset[b]]
     /\ memOffset' = IF PreserveActivationBacklog
          THEN memOffset
          ELSE [memOffset EXCEPT ![p][b] = IF diskOffset[b] = 1 THEN next ELSE memOffset[p][b]]
  /\ UNCHANGED <<lockHolder, procState, tgUpdates, pendingSave, botSlow,
                 admitted, inboxUntagged, restarts, overlapBad, wrongBotBad,
                 colleaguesEnabled, hireStage, hireEventBlocked>>

\* Бот b принимает следующий апдейт u = memOffset[p][b] независимо от состояния других ботов.
Admit(p, b) ==
  /\ procState[p] = "running"
  /\ ~botSlow[b]
  /\ pendingSave[p][b] = 0
  /\ (b = "iva" => ~hireEventBlocked)
  /\ b = "iva" \/ (colleaguesEnabled /\ initialized[p][b])
  /\ LET u == memOffset[p][b] IN
     /\ u <= tgUpdates[b]
     /\ overlapBad' = (overlapBad \/ Cardinality(RunningProcs) > 1)
     /\ IF PerBotTag
          THEN /\ admitted' = admitted \cup {<<b, u>>}
               /\ UNCHANGED <<inboxUntagged, wrongBotBad>>
          ELSE IF u \in inboxUntagged /\ <<b, u>> \notin admitted
                 THEN \* Чужой бот уже занял этот update_id в inbox без метки бота.
                      /\ wrongBotBad' = TRUE
                      /\ UNCHANGED <<admitted, inboxUntagged>>
                 ELSE /\ admitted' = admitted \cup {<<b, u>>}
                      /\ inboxUntagged' = inboxUntagged \cup {u}
                      /\ UNCHANGED wrongBotBad
     /\ pendingSave' = [pendingSave EXCEPT ![p][b] = u + 1]
  /\ UNCHANGED <<lockHolder, procState, tgUpdates, diskOffset, memOffset, botSlow, restarts,
                 colleaguesEnabled, initialized, hireStage, hireEventBlocked>>

\* Сохранение offset на диск после durable admit. В мутанте ~PerBotOffset один общий offset
\* сдвигает курсоры всех ботов разом.
SaveOffset(p, b) ==
  /\ procState[p] = "running"
  /\ pendingSave[p][b] > 0
  /\ LET next == pendingSave[p][b] IN
     /\ IF PerBotOffset
          THEN /\ diskOffset' = [diskOffset EXCEPT ![b] = IF next > @ THEN next ELSE @]
               /\ memOffset' = [memOffset EXCEPT ![p][b] = IF next > @ THEN next ELSE @]
          ELSE /\ diskOffset' = [x \in Bots |-> IF next > diskOffset[x] THEN next ELSE diskOffset[x]]
               /\ memOffset' = [memOffset EXCEPT ![p] =
                    [x \in Bots |-> IF next > memOffset[p][x] THEN next ELSE memOffset[p][x]]]
     /\ pendingSave' = [pendingSave EXCEPT ![p][b] = 0]
  /\ UNCHANGED <<lockHolder, procState, tgUpdates, botSlow, admitted, inboxUntagged,
                 restarts, overlapBad, wrongBotBad, colleaguesEnabled, initialized, hireStage, hireEventBlocked>>


\* Токен managed-бота временно недоступен: управляющее событие не подтверждается,
\* Telegram redelivery сохраняет порядок ingress, а обычные апдейты Ивы ждут за ним.
ManagedHireTokenTemporary ==
  /\ hireStage = "none"
  /\ hireEventBlocked' = TRUE
  /\ UNCHANGED <<hireStage, lockHolder, procState, tgUpdates, diskOffset, memOffset,
                 pendingSave, botSlow, admitted, inboxUntagged, restarts, overlapBad,
                 wrongBotBad, colleaguesEnabled, initialized>>

\* Постоянный отказ Telegram (например 400 bot not found) терминален для события:
\* оно подтверждается без записи токена и не может бесконечно держать обычный вход.
ManagedHireTokenPermanent ==
  /\ hireStage = "none"
  /\ hireStage' = "terminal"
  /\ hireEventBlocked' = FALSE
  /\ UNCHANGED <<lockHolder, procState, tgUpdates, diskOffset, memOffset,
                 pendingSave, botSlow, admitted, inboxUntagged, restarts, overlapBad,
                 wrongBotBad, colleaguesEnabled, initialized>>

\* Токен получен и сохранён рядом с токеном Ивы, но найм ещё не complete:
\* durable стадия profile переживает перезапуск. Пока событие не обработано до
\* acknowledgement-границы, ingress остаётся удержанным.
ManagedHireTokenSuccess ==
  /\ hireStage = "none"
  /\ hireStage' = "profile"
  /\ hireEventBlocked' = TRUE
  /\ UNCHANGED <<lockHolder, procState, tgUpdates, diskOffset, memOffset,
                 pendingSave, botSlow, admitted, inboxUntagged, restarts, overlapBad,
                 wrongBotBad, colleaguesEnabled, initialized>>

\* Профиль Bot API записан; durable стадия переходит к записи settings.json.
ManagedHireProfileSuccess ==
  /\ hireStage = "profile"
  /\ hireStage' = "settings"
  /\ UNCHANGED <<hireEventBlocked, lockHolder, procState, tgUpdates, diskOffset,
                 memOffset, pendingSave, botSlow, admitted, inboxUntagged, restarts,
                 overlapBad, wrongBotBad, colleaguesEnabled, initialized>>

\* После предела повторов управляющего события или постоянного сбоя settings.json
\* событие подтверждается, но durable стадия остаётся: обычный вход не замирает,
\* а фоновая сверка доведёт найм после ремонта среды.
ManagedHireDeferEvent ==
  /\ hireStage \in {"profile", "settings"}
  /\ hireEventBlocked
  /\ hireEventBlocked' = FALSE
  /\ UNCHANGED <<hireStage, lockHolder, procState, tgUpdates, diskOffset, memOffset,
                 pendingSave, botSlow, admitted, inboxUntagged, restarts, overlapBad,
                 wrongBotBad, colleaguesEnabled, initialized>>

\* Фоновая сверка durable журнала найма завершает запись settings.json. Только после
\* этого коллега допускается к lazy init и опросу: одного токена в .env недостаточно.
ManagedHireComplete ==
  /\ hireStage = "settings"
  /\ hireStage' = "complete"
  /\ hireEventBlocked' = FALSE
  /\ UNCHANGED <<lockHolder, procState, tgUpdates, diskOffset, memOffset,
                 pendingSave, botSlow, admitted, inboxUntagged, restarts, overlapBad,
                 wrongBotBad, colleaguesEnabled, initialized>>

Next ==
  \/ \E p \in Procs : StartProc(p) \/ CrashProc(p)
  \/ \E b \in Bots : TelegramReceive(b) \/ ToggleSlow(b)
  \/ ToggleColleagues
  \/ \E p \in Procs, b \in Bots : InitColleague(p, b) \/ Admit(p, b) \/ SaveOffset(p, b)
  \/ ManagedHireTokenTemporary \/ ManagedHireTokenPermanent \/ ManagedHireTokenSuccess
  \/ ManagedHireProfileSuccess \/ ManagedHireDeferEvent \/ ManagedHireComplete

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ lockHolder \in Procs \cup {"none"}
  /\ procState \in [Procs -> {"idle", "running"}]
  /\ tgUpdates \in [Bots -> 0..MaxUpdates]
  /\ diskOffset \in [Bots -> Offsets]
  /\ memOffset \in [Procs -> [Bots -> Offsets]]
  /\ pendingSave \in [Procs -> [Bots -> 0..(MaxUpdates + 1)]]
  /\ botSlow \in [Bots -> BOOLEAN]
  /\ admitted \subseteq (Bots \X Updates)
  /\ inboxUntagged \subseteq Updates
  /\ restarts \in 0..MaxRestarts
  /\ overlapBad \in BOOLEAN
  /\ wrongBotBad \in BOOLEAN
  /\ colleaguesEnabled \in BOOLEAN
  /\ initialized \in [Procs -> [Bots -> BOOLEAN]]
  /\ hireStage \in {"none", "profile", "settings", "complete", "terminal"}
  /\ hireEventBlocked \in BOOLEAN

\* (1) В каждый момент не больше одного живого процесса Bridge держит опрос.
SinglePollerLock == ~overlapBad /\ Cardinality(RunningProcs) <= 1

\* (2) Ни один апдейт ни одного бота не перепрыгнут сохранённым offset без durable admit.
NoSkippedUpdate ==
  \A b \in Bots : \A u \in Updates :
    u < diskOffset[b] => <<b, u>> \in admitted

\* (3) Совпадение update_id у двух ботов никогда не приводит к потере или подмене бота.
ExactBotAttribution == ~wrongBotBad

\* (4) При перезапуске курсор в памяти рабочего процесса не опережает подтверждённый admit.
MemOffsetAdmitted ==
  \A p \in RunningProcs, b \in Bots, u \in Updates :
    u < memOffset[p][b] => <<b, u>> \in admitted

\* (5) Терминальный отказ токена и завершённый найм не держат acknowledgement ingress.
HireEventTerminalRelease ==
  hireStage \in {"complete", "terminal"} => ~hireEventBlocked

\* (6) Опрос коллеги начинается только после complete-стадии durable найма:
\* токен без роли/модели в settings.json не является работающим коллегой.
ColleaguePollingRequiresCompleteHire ==
  \A p \in Procs, b \in Bots :
    (b /= "iva" /\ initialized[p][b]) => hireStage = "complete"

\* Свидетель независимости (нарочно ложный инвариант в отдельном .cfg):
\* пока iva медленная (botSlow["iva"] = TRUE), colleague успевает принять и сохранить свой offset.
NoIndependentProgress ==
  ~(botSlow["iva"] /\ diskOffset["colleague"] > 1 /\ diskOffset["iva"] = 1)
====
