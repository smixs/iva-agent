---- MODULE GroupAndAssignments ----
\* Очерёдность ответов ботов в общей группе и поручений между ботами (ADR-0030, T911).
\* Модель согласована с реальными границами отправки и обработки пачек:
\*   1) сериализация ходов разных ботов в одной группе (SingleActiveGroupBot);
\*   2) сохранность сообщений группы при занятой группе и сбое моста (NoLostGroupMessage);
\*   3) отсутствие повторной обработки при повторе доставки (NoDuplicateGroupProcessing);
\*   4) раздельные границы захвата слота и отправки видимой строки владельцу (BeginOwnerNotice
\*      под файловым замком с CAS-claim vs FinishOwnerNotice вне замка по сети) для обоих
\*      порядков доставки sender/receiver (AtMostOneOwnerNotice, DoneAssignmentNotifiedOwner);
\*   5) обработка пачек поручений (iva_parts), в которых повтор уже исполненного поручения
\*      соседствует с новым поручением от того же бота (ExecuteAssignmentBatch проверяет все
\*      части пачки, а не только первую — NoLostAssignment, NoDuplicateAssignment).
\*
\* Действия модели -> код:
\*   GroupMsgArrive(b, m)         scripts/poller/inbox.ts + routing.ts: приём сообщения группы
\*                                ботом b (без @, владелец или коллега-бот, не сам бот)
\*   StartGroupTurn(b, m)         scripts/poller/routing.ts + agent/lib/telegram-acceptance.ts:
\*                                доставка головы очереди бота b в свободную группу
\*   FinishGroupTurn(b, out)      agent/channels/telegram.ts: завершение хода в группе —
\*                                либо ответ ("reply"), либо штатное молчание ("silent", iva:none)
\*   AckGroupQueue(b, m)          scripts/poller/routing.ts: снятие принятой головы с очереди
\*   SendAssignment(a, f, t)      agent/lib/colleague-assignments.ts: отправка Bot API DM
\*                                от бота f боту t (запись в ledger + появление в очереди DM)
\*   BeginOwnerNotice(a, actor)   agent/lib/colleague-assignments.ts (claimOwnerNoticeSlot):
\*                                проверка и CAS-захват слота ownerNoticeClaimed под замком
\*                                (actor \in {"sender", "receiver"}) до сетевого вызова
\*   FinishOwnerNotice(a, actor)  agent/lib/colleague-assignments.ts (postBotMessage + commit):
\*                                принятый Bot API sendMessage владельцу и фиксация ownerNotified=TRUE
\*   RejectOwnerNotice(a, actor)  подтверждённый отказ Bot API (например, 429): строка точно
\*                                не принята, durable CAS-слот освобождается и ставится
\*                                конечный повтор по retry_after (ownerNoticeRetryScheduled)
\*   UncertainOwnerNotice(a, actor) обрыв/таймаут без ответа Bot API: слот остаётся занятым,
\*                                повтор запрещён, потому что строка могла уйти владельцу
\*   ExecuteAssignmentBatch(B)    agent/lib/telegram-acceptance.ts (preparePeerBotWebhookRequest)
\*                                + scripts/poller/inbox.ts (promoteReadyInbox): разбор пачки
\*                                поручений B (повтор + новое), фильтрация дублей, запуск свежих
\*   AckAssignmentBatch           scripts/poller/inbox.ts / routing.ts: снятие принятой пачки
\*   CrashBeforeAck               обрыв моста между принятием хода в Channel и ack очереди/inbox
\*
\* Переключатели (TRUE в рабочей модели; каждый мутант снимает ровно один):
\*   SerializeGroupTurns          в группе одновременно идёт ход не более одного бота
\*   QueueWhileGroupBusy          сообщение при занятой группе встаёт в очередь, а не теряется
\*   DeduplicateGroupUpdates      повтор доставки после сбоя не запускает второй ход
\*   DeduplicateAssignments       повтор доставки поручения не запускает его второй раз
\*   AckOnlyAfterAccept           пачка поручений снимается только после принятия в Channel
\*   ClaimBeforeSendOwnerNotice   отправитель и получатель захватывают слот под замком до sendMessage
\*   CheckAllBatchAssignments     пачка проверяет каждое поручение (а не только первое)
\*   ReleaseOwnerNoticeAfterReject подтверждённый отказ Bot API освобождает слот для повтора
\*   RetryOwnerNoticeAfterReject   подтверждённый отказ ставит повтор по retry_after,
\*                                пока не исчерпан MaxOwnerNoticeAttempts
EXTENDS Naturals, FiniteSets

CONSTANTS
  Bots,
  MaxGroupMsgs,
  MaxAssignments,
  MaxCrashes,
  SerializeGroupTurns,
  QueueWhileGroupBusy,
  DeduplicateGroupUpdates,
  DeduplicateAssignments,
  AckOnlyAfterAccept,
  ClaimBeforeSendOwnerNotice,
  CheckAllBatchAssignments,
  ReleaseOwnerNoticeAfterReject,
  RetryOwnerNoticeAfterReject,
  MaxOwnerNoticeAttempts

ASSUME MaxGroupMsgs \in Nat \ {0}
ASSUME MaxAssignments \in Nat \ {0}
ASSUME MaxCrashes \in Nat
ASSUME MaxOwnerNoticeAttempts \in Nat \ {0}
ASSUME {SerializeGroupTurns, QueueWhileGroupBusy, DeduplicateGroupUpdates,
        DeduplicateAssignments, AckOnlyAfterAccept, ClaimBeforeSendOwnerNotice,
        CheckAllBatchAssignments, ReleaseOwnerNoticeAfterReject,
        RetryOwnerNoticeAfterReject} \subseteq BOOLEAN

GroupMsgs == 1..MaxGroupMsgs
Assignments == 1..MaxAssignments
GroupOutcomes == {"reply", "silent"}
NoticeActors == {"sender", "receiver"}

VARIABLES
  \* --- Общая группа ---
  groupReceived,       \* [Bots -> SUBSET GroupMsgs] — сообщения группы, дошедшие до бота b
  groupQueue,          \* [Bots -> SUBSET GroupMsgs] — durable-очередь группы у бота b
  groupActive,         \* [Bots -> GroupMsgs \cup {0}] — сообщение активного хода (0 = idle)
  groupCompleted,      \* [Bots -> SUBSET GroupMsgs] — durable ledger завершённых апдейтов
  groupPendingAck,     \* [Bots -> SUBSET GroupMsgs] — принято Channel, ждёт ack моста
  groupExecCount,      \* [Bots -> [GroupMsgs -> 0..2]] — число реальных исполнений хода
  groupReplyCount,     \* число ответов в группе
  groupSilentCount,    \* число штатных молчаний (iva:none)
  \* --- Поручения между ботами (DM) и пачки ---
  assignPhase,         \* [Assignments -> {"idle", "delivered", "done"}]
  assignFrom,          \* [Assignments -> Bots \cup {"none"}]
  assignTo,            \* [Assignments -> Bots \cup {"none"}]
  assignQueued,        \* [Assignments -> BOOLEAN] — поручение в durable inbox/очереди DM
  assignPendingAck,    \* SUBSET Assignments — пачка, принятая Channel, ждёт ack
  assignExecCount,     \* [Assignments -> 0..2] — сколько раз поручение реально исполнено
  \* --- Разделённый цикл уведомления владельца ---
  ownerNoticeClaimed,  \* [Assignments -> BOOLEAN] — durable CAS-слот под замком
  ownerNoticeInFlight, \* [Assignments -> SUBSET NoticeActors] — HTTP sendMessage в полёте
  ownerNotified,       \* [Assignments -> BOOLEAN] — durable признак после ответа Bot API
  ownerNoticeCount,    \* [Assignments -> 0..2] — число принятых Bot API строк владельцу
  ownerNoticeUncertain, \* [Assignments -> BOOLEAN] — обрыв/таймаут без ответа Bot API; слот не освобождается
  ownerNoticeAttempts, \* [Assignments -> 0..MaxOwnerNoticeAttempts] — начатые сетевые попытки строки
  ownerNoticeRetryScheduled, \* [Assignments -> BOOLEAN] — подтверждённый отказ ждёт повтора по retry_after
  \* --- Сбои моста ---
  crashes              \* 0..MaxCrashes

vars == <<groupReceived, groupQueue, groupActive, groupCompleted, groupPendingAck,
          groupExecCount, groupReplyCount, groupSilentCount,
          assignPhase, assignFrom, assignTo, assignQueued, assignPendingAck,
          assignExecCount, ownerNoticeClaimed, ownerNoticeInFlight,
          ownerNotified, ownerNoticeCount, ownerNoticeUncertain,
          ownerNoticeAttempts, ownerNoticeRetryScheduled, crashes>>

ActiveGroupBots == {b \in Bots : groupActive[b] /= 0}
GroupBusy == ActiveGroupBots /= {}

Init ==
  /\ groupReceived = [b \in Bots |-> {}]
  /\ groupQueue = [b \in Bots |-> {}]
  /\ groupActive = [b \in Bots |-> 0]
  /\ groupCompleted = [b \in Bots |-> {}]
  /\ groupPendingAck = [b \in Bots |-> {}]
  /\ groupExecCount = [b \in Bots |-> [m \in GroupMsgs |-> 0]]
  /\ groupReplyCount = 0
  /\ groupSilentCount = 0
  /\ assignPhase = [a \in Assignments |-> "idle"]
  /\ assignFrom = [a \in Assignments |-> "none"]
  /\ assignTo = [a \in Assignments |-> "none"]
  /\ assignQueued = [a \in Assignments |-> FALSE]
  /\ assignPendingAck = {}
  /\ assignExecCount = [a \in Assignments |-> 0]
  /\ ownerNoticeClaimed = [a \in Assignments |-> FALSE]
  /\ ownerNoticeInFlight = [a \in Assignments |-> {}]
  /\ ownerNotified = [a \in Assignments |-> FALSE]
  /\ ownerNoticeCount = [a \in Assignments |-> 0]
  /\ ownerNoticeUncertain = [a \in Assignments |-> FALSE]
  /\ ownerNoticeAttempts = [a \in Assignments |-> 0]
  /\ ownerNoticeRetryScheduled = [a \in Assignments |-> FALSE]
  /\ crashes = 0

\* Рабочий старт сетевой попытки строки владельцу: первая попытка либо конечный
\* повтор после подтверждённого отказа. Мутант без CAS этому правилу не следует.
OwnerNoticeMayBegin(a) ==
  /\ ownerNoticeAttempts[a] < MaxOwnerNoticeAttempts
  /\ (ownerNoticeAttempts[a] = 0 \/ ownerNoticeRetryScheduled[a])

\* Получатель в ExecuteAssignmentBatch начинает строку по тем же правилам, что BeginOwnerNotice.
ReceiverNoticeStarts(a) ==
  /\ ~ownerNotified[a]
  /\ "receiver" \notin ownerNoticeInFlight[a]
  /\ ownerNoticeAttempts[a] < MaxOwnerNoticeAttempts
  /\ IF ClaimBeforeSendOwnerNotice
       THEN /\ ~ownerNoticeClaimed[a]
            /\ (ownerNoticeAttempts[a] = 0 \/ ownerNoticeRetryScheduled[a])
       ELSE TRUE

\* Сообщение группы дошло до бота b. Если группа занята (или уже есть очередь), в рабочей
\* модели оно ставится в durable-очередь; мутант ~QueueWhileGroupBusy отбрасывает его.
GroupMsgArrive(b, m) ==
  /\ m \notin groupReceived[b]
  /\ groupReceived' = [groupReceived EXCEPT ![b] = @ \cup {m}]
  /\ IF (~QueueWhileGroupBusy) /\ (GroupBusy \/ groupQueue[b] /= {})
       THEN UNCHANGED groupQueue
       ELSE groupQueue' = [groupQueue EXCEPT ![b] = @ \cup {m}]
  /\ UNCHANGED <<groupActive, groupCompleted, groupPendingAck, groupExecCount,
                 groupReplyCount, groupSilentCount, assignPhase, assignFrom, assignTo,
                 assignQueued, assignPendingAck, assignExecCount,
                 ownerNoticeClaimed, ownerNoticeInFlight, ownerNotified,
                 ownerNoticeCount, ownerNoticeUncertain,
                 ownerNoticeAttempts, ownerNoticeRetryScheduled, crashes>>

\* Мост доставляет очередное сообщение m из очереди бота b в Channel.
StartGroupTurn(b, m) ==
  /\ m \in groupQueue[b]
  /\ groupActive[b] = 0
  /\ m \notin groupPendingAck[b]
  /\ SerializeGroupTurns => ~GroupBusy
  /\ IF DeduplicateGroupUpdates /\ m \in groupCompleted[b]
       THEN /\ groupPendingAck' = [groupPendingAck EXCEPT ![b] = @ \cup {m}]
            /\ UNCHANGED <<groupActive, groupCompleted, groupExecCount>>
       ELSE /\ groupActive' = [groupActive EXCEPT ![b] = m]
            /\ groupCompleted' = [groupCompleted EXCEPT ![b] = @ \cup {m}]
            /\ groupPendingAck' = [groupPendingAck EXCEPT ![b] = @ \cup {m}]
            /\ groupExecCount' = [groupExecCount EXCEPT ![b][m] =
                  IF @ < 2 THEN @ + 1 ELSE @]
  /\ UNCHANGED <<groupReceived, groupQueue, groupReplyCount, groupSilentCount,
                 assignPhase, assignFrom, assignTo, assignQueued, assignPendingAck,
                 assignExecCount, ownerNoticeClaimed, ownerNoticeInFlight,
                 ownerNotified, ownerNoticeCount, ownerNoticeUncertain,
                 ownerNoticeAttempts, ownerNoticeRetryScheduled, crashes>>

\* Бот b завершает ход в группе: отвечает (reply) либо штатно молчит (silent, iva:none).
FinishGroupTurn(b, outcome) ==
  /\ groupActive[b] /= 0
  /\ outcome \in GroupOutcomes
  /\ groupActive' = [groupActive EXCEPT ![b] = 0]
  /\ IF outcome = "reply"
       THEN /\ groupReplyCount' = groupReplyCount + 1
            /\ UNCHANGED groupSilentCount
       ELSE /\ groupSilentCount' = groupSilentCount + 1
            /\ UNCHANGED groupReplyCount
  /\ UNCHANGED <<groupReceived, groupQueue, groupCompleted, groupPendingAck,
                 groupExecCount, assignPhase, assignFrom, assignTo, assignQueued,
                 assignPendingAck, assignExecCount, ownerNoticeClaimed,
                 ownerNoticeInFlight, ownerNotified, ownerNoticeCount, ownerNoticeUncertain,
                 ownerNoticeAttempts, ownerNoticeRetryScheduled, crashes>>

\* Мост снимает принятое сообщение с durable-очереди бота b.
AckGroupQueue(b, m) ==
  /\ m \in groupPendingAck[b]
  /\ groupQueue' = [groupQueue EXCEPT ![b] = @ \ {m}]
  /\ groupPendingAck' = [groupPendingAck EXCEPT ![b] = @ \ {m}]
  /\ UNCHANGED <<groupReceived, groupActive, groupCompleted, groupExecCount,
                 groupReplyCount, groupSilentCount, assignPhase, assignFrom, assignTo,
                 assignQueued, assignPendingAck, assignExecCount,
                 ownerNoticeClaimed, ownerNoticeInFlight, ownerNotified,
                 ownerNoticeCount, ownerNoticeUncertain,
                 ownerNoticeAttempts, ownerNoticeRetryScheduled, crashes>>

\* Поручение бота fromB боту toB личным сообщением Bot API (самому себе запрещено).
\* Номера поручений выдаются последовательно (1, затем 2) для сжатия симметрий TLC.
SendAssignment(a, fromB, toB) ==
  /\ assignPhase[a] = "idle"
  /\ \A prev \in Assignments : prev < a => assignPhase[prev] /= "idle"
  /\ fromB /= toB
  /\ assignPhase' = [assignPhase EXCEPT ![a] = "delivered"]
  /\ assignFrom' = [assignFrom EXCEPT ![a] = fromB]
  /\ assignTo' = [assignTo EXCEPT ![a] = toB]
  /\ assignQueued' = [assignQueued EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<groupReceived, groupQueue, groupActive, groupCompleted, groupPendingAck,
                 groupExecCount, groupReplyCount, groupSilentCount, assignPendingAck,
                 assignExecCount, ownerNoticeClaimed, ownerNoticeInFlight,
                 ownerNotified, ownerNoticeCount, ownerNoticeUncertain,
                 ownerNoticeAttempts, ownerNoticeRetryScheduled, crashes>>

\* Начало отправки видимой строки владельцу в чате коллеги (разделено с FinishOwnerNotice):
\*   - в рабочей модели (ClaimBeforeSendOwnerNotice) отправитель и получатель берут
\*     CAS-слот ownerNoticeClaimed под замком withLedger до сетевого вызова;
\*   - в мутанте (~ClaimBeforeSendOwnerNotice) отправитель шлёт без проверки слота под замком,
\*     и получатель может успеть отправить и записать строку до него (гонка из возврата п.3а).
BeginOwnerNotice(a, actor) ==
  /\ actor \in NoticeActors
  /\ assignPhase[a] \in {"delivered", "done"}
  /\ actor \notin ownerNoticeInFlight[a]
  /\ ownerNoticeCount[a] < 2
  /\ IF ClaimBeforeSendOwnerNotice
       THEN /\ ~ownerNoticeClaimed[a]
            /\ ~ownerNotified[a]
            /\ OwnerNoticeMayBegin(a)
            /\ ownerNoticeClaimed' = [ownerNoticeClaimed EXCEPT ![a] = TRUE]
            /\ ownerNoticeInFlight' = [ownerNoticeInFlight EXCEPT ![a] = @ \cup {actor}]
       ELSE \* Баг 127a9dae: отправитель шлёт owner-notice без предварительной проверки
            \* ledger; получатель проверяет только ownerNotified, не видя in-flight отправителя.
            /\ (actor = "sender" \/ ~ownerNotified[a])
            /\ ownerNoticeAttempts[a] < MaxOwnerNoticeAttempts
            /\ ownerNoticeInFlight' = [ownerNoticeInFlight EXCEPT ![a] = @ \cup {actor}]
            /\ UNCHANGED ownerNoticeClaimed
  /\ ownerNoticeAttempts' = [ownerNoticeAttempts EXCEPT ![a] =
        IF @ < MaxOwnerNoticeAttempts THEN @ + 1 ELSE @]
  /\ ownerNoticeRetryScheduled' = [ownerNoticeRetryScheduled EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<groupReceived, groupQueue, groupActive, groupCompleted, groupPendingAck,
                 groupExecCount, groupReplyCount, groupSilentCount, assignPhase,
                 assignFrom, assignTo, assignQueued, assignPendingAck, assignExecCount,
                 ownerNotified, ownerNoticeCount, ownerNoticeUncertain, crashes>>

\* Успешное завершение сетевой отправки sendMessage владельцу и фиксация ownerNotified в ledger.
FinishOwnerNotice(a, actor) ==
  /\ actor \in ownerNoticeInFlight[a]
  /\ ownerNoticeInFlight' = [ownerNoticeInFlight EXCEPT ![a] = @ \ {actor}]
  /\ ownerNotified' = [ownerNotified EXCEPT ![a] = TRUE]
  /\ ownerNoticeCount' = [ownerNoticeCount EXCEPT ![a] = IF @ < 2 THEN @ + 1 ELSE @]
  /\ ownerNoticeRetryScheduled' = [ownerNoticeRetryScheduled EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<groupReceived, groupQueue, groupActive, groupCompleted, groupPendingAck,
                 groupExecCount, groupReplyCount, groupSilentCount, assignPhase,
                 assignFrom, assignTo, assignQueued, assignPendingAck, assignExecCount,
                 ownerNoticeClaimed, ownerNoticeUncertain, ownerNoticeAttempts, crashes>>

\* Подтверждённый отказ Bot API (например, 429 с ответом в JSON): строка точно не принята.
\* В рабочей модели durable CAS-слот освобождается, поэтому следующий проход sender/receiver
\* может повторить строку; мутант ~ReleaseOwnerNoticeAfterReject оставляет слот занятым навсегда.
RejectOwnerNotice(a, actor) ==
  /\ actor \in ownerNoticeInFlight[a]
  /\ ownerNoticeInFlight' = [ownerNoticeInFlight EXCEPT ![a] = @ \ {actor}]
  /\ IF ReleaseOwnerNoticeAfterReject
       THEN ownerNoticeClaimed' = [ownerNoticeClaimed EXCEPT ![a] = FALSE]
       ELSE UNCHANGED ownerNoticeClaimed
  /\ IF ReleaseOwnerNoticeAfterReject /\ RetryOwnerNoticeAfterReject /\
        ~ownerNotified[a] /\ ownerNoticeAttempts[a] < MaxOwnerNoticeAttempts
       THEN ownerNoticeRetryScheduled' = [ownerNoticeRetryScheduled EXCEPT ![a] = TRUE]
       ELSE ownerNoticeRetryScheduled' = [ownerNoticeRetryScheduled EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<groupReceived, groupQueue, groupActive, groupCompleted, groupPendingAck,
                 groupExecCount, groupReplyCount, groupSilentCount, assignPhase,
                 assignFrom, assignTo, assignQueued, assignPendingAck, assignExecCount,
                 ownerNotified, ownerNoticeCount, ownerNoticeUncertain,
                 ownerNoticeAttempts, crashes>>

\* Неопределённый результат (обрыв сети или таймаут до ответа Bot API): строка могла
\* уйти владельцу. Слот не освобождается, поэтому повтора и возможного дубля нет.
UncertainOwnerNotice(a, actor) ==
  /\ actor \in ownerNoticeInFlight[a]
  /\ ownerNoticeInFlight' = [ownerNoticeInFlight EXCEPT ![a] = @ \ {actor}]
  /\ ownerNoticeUncertain' = [ownerNoticeUncertain EXCEPT ![a] = TRUE]
  /\ ownerNoticeRetryScheduled' = [ownerNoticeRetryScheduled EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<groupReceived, groupQueue, groupActive, groupCompleted, groupPendingAck,
                 groupExecCount, groupReplyCount, groupSilentCount, assignPhase,
                 assignFrom, assignTo, assignQueued, assignPendingAck, assignExecCount,
                 ownerNoticeClaimed, ownerNotified, ownerNoticeCount, ownerNoticeAttempts, crashes>>

\* Получатель принимает пачку поручений batch \subseteq queued из inbox/очереди DM.
\* В рабочей модели (CheckAllBatchAssignments) preparePeerBotWebhookRequest проверяет
\* каждую часть пачки: отбрасывает уже исполненные повторы и запускает все свежие части.
\* В мутанте (~CheckAllBatchAssignments — баг 127a9dae из возврата п.3б) проверяется только
\* первая часть пачки first: если она уже done, вся пачка отвечает handled и теряет свежие части.
ExecuteAssignmentBatch(batch) ==
  /\ batch /= {}
  /\ assignPendingAck = {}
  /\ \A a \in batch : assignQueued[a] /\ assignPhase[a] \in {"delivered", "done"}
  /\ LET first == CHOOSE x \in batch : \A y \in batch : x <= y
         fresh == {a \in batch : assignPhase[a] = "delivered"}
         allDuplicate ==
           IF CheckAllBatchAssignments
             THEN DeduplicateAssignments /\ fresh = {}
             ELSE DeduplicateAssignments /\ assignPhase[first] = "done"
         toRun ==
           IF allDuplicate THEN {}
           ELSE IF DeduplicateAssignments THEN fresh
           ELSE batch
     IN
       IF toRun = {}
         THEN \* Вся пачка признана дублем -> 204 handled, ack пойдёт на всю пачку batch.
              /\ assignPendingAck' = batch
              /\ UNCHANGED <<assignPhase, assignExecCount, ownerNoticeClaimed,
                             ownerNoticeInFlight, ownerNoticeAttempts, ownerNoticeRetryScheduled>>
         ELSE \* Для каждой свежей части claimInboundPeerAssignment гарантирует, что
              \* слот уведомления владельца занят (либо уже был, либо захватывается получателем).
              /\ assignPhase' = [a \in Assignments |->
                    IF a \in toRun THEN "done" ELSE assignPhase[a]]
              /\ assignPendingAck' = batch
              /\ assignExecCount' = [a \in Assignments |->
                    IF a \in toRun
                      THEN (IF assignExecCount[a] < 2 THEN assignExecCount[a] + 1 ELSE assignExecCount[a])
                      ELSE assignExecCount[a]]
              /\ ownerNoticeClaimed' = [a \in Assignments |->
                    IF a \in toRun /\ ClaimBeforeSendOwnerNotice /\ ReceiverNoticeStarts(a)
                      THEN TRUE
                      ELSE ownerNoticeClaimed[a]]
              /\ ownerNoticeInFlight' = [a \in Assignments |->
                    IF a \in toRun /\ ReceiverNoticeStarts(a)
                      THEN ownerNoticeInFlight[a] \cup {"receiver"}
                      ELSE ownerNoticeInFlight[a]]
              /\ ownerNoticeAttempts' = [a \in Assignments |->
                    IF a \in toRun /\ ReceiverNoticeStarts(a)
                      THEN (IF ownerNoticeAttempts[a] < MaxOwnerNoticeAttempts
                            THEN ownerNoticeAttempts[a] + 1 ELSE ownerNoticeAttempts[a])
                      ELSE ownerNoticeAttempts[a]]
              /\ ownerNoticeRetryScheduled' = [a \in Assignments |->
                    IF a \in toRun /\ ReceiverNoticeStarts(a)
                      THEN FALSE
                      ELSE ownerNoticeRetryScheduled[a]]
  /\ UNCHANGED <<groupReceived, groupQueue, groupActive, groupCompleted, groupPendingAck,
                 groupExecCount, groupReplyCount, groupSilentCount, assignFrom, assignTo,
                 assignQueued, ownerNotified, ownerNoticeCount, ownerNoticeUncertain, crashes>>

\* Снятие принятой пачки поручений с durable inbox/очереди.
\* В мутанте ~AckOnlyAfterAccept мост может снять элемент до принятия, теряя поручение.
AckAssignmentBatch ==
  /\ IF AckOnlyAfterAccept
       THEN /\ assignPendingAck /= {}
            /\ assignQueued' = [a \in Assignments |->
                  IF a \in assignPendingAck THEN FALSE ELSE assignQueued[a]]
            /\ assignPendingAck' = {}
       ELSE \E a \in Assignments :
              /\ assignQueued[a]
              /\ assignQueued' = [assignQueued EXCEPT ![a] = FALSE]
              /\ assignPendingAck' = assignPendingAck \ {a}
  /\ UNCHANGED <<groupReceived, groupQueue, groupActive, groupCompleted, groupPendingAck,
                 groupExecCount, groupReplyCount, groupSilentCount, assignPhase,
                 assignFrom, assignTo, assignExecCount, ownerNoticeClaimed,
                 ownerNoticeInFlight, ownerNotified, ownerNoticeCount, ownerNoticeUncertain,
                 ownerNoticeAttempts, ownerNoticeRetryScheduled, crashes>>

\* Обрыв моста до снятия ack: оперативная память pendingAck теряется, но дисковые очереди,
\* ledger завершённых апдейтов/поручений и CAS-слот уведомлений переживают перезапуск.
CrashBeforeAck ==
  /\ crashes < MaxCrashes
  /\ ((\E b \in Bots : groupPendingAck[b] /= {}) \/ assignPendingAck /= {})
  /\ crashes' = crashes + 1
  /\ groupPendingAck' = [b \in Bots |-> {}]
  /\ assignPendingAck' = {}
  /\ UNCHANGED <<groupReceived, groupQueue, groupActive, groupCompleted, groupExecCount,
                 groupReplyCount, groupSilentCount, assignPhase, assignFrom, assignTo,
                 assignQueued, assignExecCount, ownerNoticeClaimed, ownerNoticeInFlight,
                 ownerNotified, ownerNoticeCount, ownerNoticeUncertain,
                 ownerNoticeAttempts, ownerNoticeRetryScheduled>>

Next ==
  \/ \E b \in Bots, m \in GroupMsgs : GroupMsgArrive(b, m) \/ StartGroupTurn(b, m) \/ AckGroupQueue(b, m)
  \/ \E b \in Bots, o \in GroupOutcomes : FinishGroupTurn(b, o)
  \/ \E a \in Assignments, f \in Bots, t \in Bots : SendAssignment(a, f, t)
  \/ \E a \in Assignments, actor \in NoticeActors :
       BeginOwnerNotice(a, actor) \/ FinishOwnerNotice(a, actor) \/
       RejectOwnerNotice(a, actor) \/ UncertainOwnerNotice(a, actor)
  \/ \E batch \in SUBSET Assignments : ExecuteAssignmentBatch(batch)
  \/ AckAssignmentBatch
  \/ CrashBeforeAck

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ groupReceived \in [Bots -> SUBSET GroupMsgs]
  /\ groupQueue \in [Bots -> SUBSET GroupMsgs]
  /\ groupActive \in [Bots -> GroupMsgs \cup {0}]
  /\ groupCompleted \in [Bots -> SUBSET GroupMsgs]
  /\ groupPendingAck \in [Bots -> SUBSET GroupMsgs]
  /\ groupExecCount \in [Bots -> [GroupMsgs -> 0..2]]
  /\ groupReplyCount \in Nat
  /\ groupSilentCount \in Nat
  /\ assignPhase \in [Assignments -> {"idle", "delivered", "done"}]
  /\ assignFrom \in [Assignments -> Bots \cup {"none"}]
  /\ assignTo \in [Assignments -> Bots \cup {"none"}]
  /\ assignQueued \in [Assignments -> BOOLEAN]
  /\ assignPendingAck \in SUBSET Assignments
  /\ assignExecCount \in [Assignments -> 0..2]
  /\ ownerNoticeClaimed \in [Assignments -> BOOLEAN]
  /\ ownerNoticeInFlight \in [Assignments -> SUBSET NoticeActors]
  /\ ownerNotified \in [Assignments -> BOOLEAN]
  /\ ownerNoticeCount \in [Assignments -> 0..2]
  /\ ownerNoticeUncertain \in [Assignments -> BOOLEAN]
  /\ ownerNoticeAttempts \in [Assignments -> 0..MaxOwnerNoticeAttempts]
  /\ ownerNoticeRetryScheduled \in [Assignments -> BOOLEAN]
  /\ crashes \in 0..MaxCrashes

\* (1) В одной группе одновременно работает не более одного бота (очерёдность ответов).
SingleActiveGroupBot == Cardinality(ActiveGroupBots) <= 1

\* (2) Ни одно принятое сообщение группы не теряется до обработки.
NoLostGroupMessage ==
  \A b \in Bots, m \in GroupMsgs :
    m \in groupReceived[b] =>
      (m \in groupQueue[b] \/ groupActive[b] = m \/ m \in groupCompleted[b])

\* (3) Ни одно сообщение группы не обрабатывается ботом дважды.
NoDuplicateGroupProcessing ==
  \A b \in Bots, m \in GroupMsgs : groupExecCount[b][m] <= 1

\* (4) Бот не поручает задачу сам себе.
NoSelfAssignment ==
  \A a \in Assignments :
    assignPhase[a] /= "idle" => assignFrom[a] /= assignTo[a]

\* (5) Ни одно отправленное поручение не теряется до исполнения (даже в пачке с повтором).
NoLostAssignment ==
  \A a \in Assignments :
    assignPhase[a] = "delivered" => assignQueued[a]

\* (6) Ни одно поручение не исполняется дважды даже при сбое до ack и повторной пачке.
NoDuplicateAssignment ==
  \A a \in Assignments : assignExecCount[a] <= 1

\* (7) Строка о поручении владельцу в чате коллеги отправляется не более одного раза
\*     при обоих порядках доставки sender/receiver.
AtMostOneOwnerNotice ==
  \A a \in Assignments : ownerNoticeCount[a] <= 1

\* (8) Исполненное поручение не остаётся без строки владельцу молча:
\*     либо строка принята ровно один раз, либо отправка ещё в полёте, либо
\*     подтверждённый отказ уже поставил конечный повтор по retry_after, либо
\*     попытки исчерпаны явно. Неопределённый обрыв повтора не даёт, потому что
\*     строка могла уйти владельцу до обрыва.
DoneAssignmentNotifiedOwner ==
  \A a \in Assignments :
    assignPhase[a] = "done" =>
      /\ (ownerNotified[a] => ownerNoticeCount[a] = 1)
      /\ (ownerNotified[a] \/ ownerNoticeInFlight[a] /= {} \/ ownerNoticeUncertain[a] \/
           ownerNoticeRetryScheduled[a] \/ ownerNoticeAttempts[a] >= MaxOwnerNoticeAttempts)

\* Свидетель достижимости (нарочно ложный инвариант в отдельном .cfg):
\* доказывает, что достижима трасса, где один ход в группе завершился ответом,
\* другой — штатным молчанием, и два поручения (включая обработку после повтора)
\* дошли до done с ровно 1 строкой владельцу на каждое.
NoSilenceAndAssignmentWitness ==
  ~(groupReplyCount >= 1 /\ groupSilentCount >= 1 /\
    \A a \in Assignments : assignPhase[a] = "done" /\ ownerNoticeCount[a] = 1)
====
