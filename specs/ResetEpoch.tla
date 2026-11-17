---- MODULE ResetEpoch ----
\* Эпоха сброса /new одного личного чата (замечание 3 арбитра T122, D53). Единственная
\* спека сброса: подменяет снятую ResetIntent.tla (T348). Карта её проверок: ExactCut —
\* пара NoStaleInConv + LossOnlyByNewer/DropOnlyByNewer (до границы не попадает в новый
\* разговор, после — не теряется); IntentUntilClean — чистка очереди идёт только под
\* живой своей границей (NewClear/RcClear с Guards; без намерения поток до неё не
\* доходит); RecReread — RcScan перечитывает намерение и сверки intentIsCurrent
\* (Guards=FALSE — мутант); AgentStale и порядок исполнения вызовов — WireFence +
\* RemoteInOrder; SessionCompletion — журнал srvMax ведётся по ключу чата для обеих
\* форм цели. ConfirmOnce — счётчик подтверждений confirmed[seq] <= 1 (снимок
\* finishReset control.ts: подтверждение уходит одним завершением потока /new; мутант
\* -confirm-recovery подаёт его ещё и из сверки). EscalationOnce — escalations <= 1 за
\* жизнь процесса (queue.ts: эскалация одна по флагу escalated, перезапуск флаг теряет).
\* Finished — живость прежней спеки: под fairness, ограниченных отказах (failsUsed <=
\* MaxFails) и ограниченных перезапусках каждое намерение доезжает — <>[](намерения нет,
\* потоки стоят и за каждым seq упал remote его эпохи или новее). Mutant
\* -live-nofair снимает fairness: статтеринг без работы — Finished красный, пара
\* доказывает, что гарантию даёт справедливость, а не форма Next. Снятые переключатели
\* прежней спеки без пары в новой модели: ClearFirst/ClearAll — порядок завершения один
\* (чистка очереди → статус → снятие намерения, как completeScopedResetState), ConfirmWindow —
\* подтверждение считается на seq потока, повторный /new — новый seq, RecInterleave —
\* переплетение сверки и потока всегда разрешено (RcScan не ждёт), SessionCompletion и
\* AgentStale — свёрнуты в srvMax/WireFence.
\*
\* Модель написана
\* ПОСЛЕ кода: она проверяет код scripts/poller/{queue,inbox,routing}.ts на базе dd50c6ad
\* с правками замечаний 1 (T326, монотонная эпоха) и 2 (T325, правило живости >=),
\* перенесённый на базу origin/beta fb8f89da (T348).
\*
\* Что описывает. Приём сообщения в durable inbox с пометкой живой эпохи (admitTelegramUpdate
\* -> admitFenceFields, inbox.ts:202-206): эпоха pending-намерения или resetEpoch статуса
\* (resetEpochFor, queue.ts:551-556). Запись без эпохи (принята до первого /new) пометки не
\* несёт и доказывает «после» строго бо́льшим enqueuedAt. /new (performScopedReset,
\* queue.ts:607-693): durable-намерение с эпохой max(now, последняя durable + 1)
\* (persistPrivateResetIntent, :453-477), удалённый сброс сессии (releaseScopedSession),
\* завершение (completeScopedResetState, :364-441): выход при сменившейся эпохе, чистка
\* очереди по живой границе (clearChatQueue, :246-299), resetEpoch = max(прежний, fence),
\* снятие только своего намерения (clearPrivateResetIntent expectedRequestedAt, :511-537).
\* Фоновый reconcile (reconcileScopedResetIntents, :695-807): сверка намерения до remote и
\* после него, то же завершение, то же снятие. Промоут inbox (promoteReadyInbox,
\* inbox.ts:264-369): записи старше живой эпохи мертвы и снимаются до склейки; пометка
\* новее эпохи живая — наследие пропавшего намерения. Маршрут (routeMessageUpdate,
\* routing.ts:315-330) и слив (drainReadyQueueHeads, :472): пока намерение ждёт, всё идёт
\* в очередь и слив чата не идёт. Память моста об намерении (resetIntentMemory, queue.ts:
\* 125-145) волатильна: перезапуск теряет зеркало, счёт отказов, отсрочку и эскалацию —
\* сверка при старте (Boot) возвращает зеркало с диска до первого getUpdates, поэтому в
\* модели приём и маршрут не идут, пока мост не поднялся. Отказы remote-ожидания и
\* persist считаются одним счётчиком с отсрочкой (recordResetFailure + deferResetRetry);
\* на EscalateAt-м подряд отказе сверка шлёт владельцу «запусти iva reset» один раз
\* (escalated). Подтверждение «Диалог сброшен» — finishReset в конце потока /new
\* (control.ts:1585-1600); сверка завершает сброс молча (ConfirmOnRecovery=FALSE в коде).
\*
\* Абстракции. Эпоха и время приёма — натуральные числа; часы не убывают. Порядок запросов
\* /new — reqSeq: у сообщения aseq — сколько намерений записано до его приёма, у разговора —
\* seq намерения, чей remote его начал; значения fence повторяться могут (мутант часов),
\* порядок запросов — нет. Remote — POST на /eve/v1/telegram/reset, несёт адрес чата,
\* ключ chatKey и эпоху намерения на проводе (reconcile — всегда {address};
\* /new — {address} или sessionId сохранённой сессии; telegram-reset-route.ts).
\* Три события разделены: выпуск, конец клиентского ожидания и падение на
\* сервере. Таймаут или обрыв клиента не доказывает, что вызов до сервера не
\* дошёл: дошедший остаётся в wire и падает позже — возврат S69, дыра «слот
\* освобождён по ошибке клиента, а серверный вызов жив». Исправление T341 —
\* два слоя: слот на чат у клиента (remoteResetSlot + issueRemoteReset,
\* queue.ts) сериализует выпуски и не выпускает вызов за уже упавшую эпоху
\* (дедуп по seq намерения; в коде — по fence, при монотонной эпохе
\* эквивалентно), а журнал упавших эпох у роута (resetLandedEpochs,
\* telegram-reset-route.ts) отклоняет вызов, чья эпоха уже упала по этому
\* ключу: запоздавшее исполнение старого намерения свежий разговор не трёт.
\* Переключатели: RemoteSlot — клиентский слот, WireFence — серверный журнал;
\* оба FALSE — поведение до исправления, мутанты ResetEpoch-late-remote и
\* ResetEpoch-late-remote-order; WireFence = FALSE при слоте — мутант
\* ResetEpoch-remote-timeout: дыра таймаута без журнала. LossOnlyByNewer ловит
\* стёртое доставленное по gone-атрибуции, RemoteInOrder — откат convSeq.
\* Одновременных /new нет (цикл последователен); второй /new приживается только
\* после конца первого потока, уступленное намерение дожимает reconcile.
\* Волатильный журнал приземлений vLanded — remoteResetLandedEpochs моста:
\* перезапуск его теряет, и дедуп падает до durable-эпохи статуса (код
\* remoteLandedEpoch = max(память, statusEpoch)); wipeMax при этом остаётся
\* историей упавших remote для порядка и не сбрасывается.
\* Пропажа намерения извне (MayAbandon: вайп каталога, откат бинаря — durable-реестр эпох
\* её не видит) в основном cfg выключена: пометка пропавшего намерения может совпасть с
\* новой эпохой, и принятое до /new переживёт его (протечка, свидетель
\* ResetEpoch-abandon), а немаркированное, принятое после запроса /new в ту же
\* миллисекунду, снимется его же границей (потеря, свидетель
\* ResetEpoch-abandon-loss). Телеграм-очередь до inbox, коллектор, занятость чата,
\* группы и closed-session вне модели. Отказы чистки и снятия намерения свёрнуты в
\* отказы remote-ожидания и persist: код считает их одним счётчиком отказов.
\*
\* Действие модели -> файл:функция
\*   Admit        inbox.ts:208 admitTelegramUpdate: пометка живой эпохой при записи
\*   Promote      inbox.ts:264 promoteReadyInbox: stale-снятие, маршрут в очередь или
\*                прямой доставкой (routing.ts:212); пока намерение ждёт — только очередь
\*   Drain        routing.ts:401 drainReadyQueueHeads: слив не идёт при resetPending (:472)
\*   NewPersist   persistPrivateResetIntent: эпоха = max(now, floor); отказ — ветка
\*                CanFail, счёт отказов и отсрочка общие (recordResetFailure +
\*                deferResetRetry)
\*   NewRemote    releaseScopedSession -> remoteResetSlot: выпуск remote ждёт слот;
\*                упавшую за эту эпоху не дублирует; вызов уходит в wire
\*   NewDone      конец клиентского ожидания: ответ — сервер исполнил вызов
\*                (применил или отклонил по эпохе), таймаут/сбой — отказ в счётчик,
\*                вызов может остаться живым в wire
\*   SrvLand      запоздавшее падение remote на сервере: журнал эпох роута
\*                отклоняет уже упавшую (WireFence)
\*   NewClear     completeScopedResetState -> clearChatQueue: живая эпоха внутри мутации
\*   NewStatus    completeScopedResetState: resetEpoch = max(прежняя, fence)
\*   NewIntent    clearPrivateResetIntent(expectedRequestedAt) + finishReset:
\*                подтверждение «Диалог сброшен» владельцу, снятие отсрочки
\*   RcScan       reconcileScopedResetIntents + сверка при старте: обход намерений,
\*                зеркало памяти с диска
\*   RcRemote     сверка intentIsCurrent и выпуск requestResetImpl через remoteResetSlot
\*   RcDone       конец клиентского ожидания сверки — как у /new; отказ считается и
\*                на EscalateAt-м подряд шлёт эскалацию один раз (escalated)
\*   RcPost       пост-сверка intentIsCurrent после возврата remote
\*   RcClear/RcStatus/RcIntent  завершение и снятие — как у /new, без подтверждения
\*   Boot         старт моста: сверка при старте восстановила зеркало, поллинг пошёл
\*   Expire       истекла отсрочка повтора (retryAt)
\*   Restart      перезапуск Bridge: память пуста (fails/backoff/escalated/vLanded,
\*                зеркало), durable и wire целы
\*   Abandon      вайп каталога намерений / откат: pending-память сходится к пустому файлу
\*                (loadPrivateResetIntents, :479-509 удаляет записи без файла)
\*
\* Переключатели кода (TRUE/«geq» — поведение dd50c6ad + T325 + T326 + T341):
\*   FenceRule      "geq" — элемент жив при пометке >= границы (код); "eq" — мутант ===
\*   Guards         сверки: намерения в reconcile (до выпуска remote и после его падения),
\*                  живой эпохи в complete (перед чисткой и перед статусом),
\*                  expectedRequestedAt при снятии; FALSE — мутант «без сверки намерения»
\*   MonotoneEpoch  эпоха намерения = max(clock, последняя durable + 1); FALSE — мутант
\*                  «эпоха = Date.now»
\*   EpochMax       статус пишет max(прежняя эпоха, fence); FALSE — пишет fence
\*   MayAbandon     намерение может пропасть извне; FALSE в основном cfg
\*   RemoteSlot     слот remote-сброса на чат у клиента (T341): выпуски
\*                  сериализованы, второй ждёт, а remote за уже упавшую эпоху
\*                  не выпускается вовсе; FALSE — выпуски двух потоков за одно
\*                  намерение не упорядочены
\*   WireFence      журнал упавших эпох у роута (T341, S69): вызов, чья эпоха
\*                  уже упала по ключу чата, отклоняется — конец клиентского
\*                  ожидания по ошибке/таймауту не отменяет серверный вызов;
\*                  FALSE — падение сбрасывает живую сессию безусловно
\*   ConfirmOnRecovery сверка тоже шлёт «Диалог сброшен»; FALSE в коде —
\*                  мутант: тогда одно намерение подтверждается дважды
EXTENDS Naturals, FiniteSets

CONSTANTS
  N, MaxSeq, MaxClock, MaxRestarts, MaxFails, EscalateAt,
  FenceRule, Guards, MonotoneEpoch, EpochMax, MayAbandon, RemoteSlot, WireFence,
  ConfirmOnRecovery

ASSUME FenceRule \in {"geq", "eq"}
ASSUME {Guards, MonotoneEpoch, EpochMax, MayAbandon, RemoteSlot, WireFence,
        ConfirmOnRecovery} \subseteq BOOLEAN
ASSUME N \in Nat \ {0} /\ MaxSeq \in Nat \ {0} /\ MaxClock \in Nat \ {0}
\* MaxFails = 0 / MaxRestarts = 0 — выключатели среды для малых cfg: без
\* отказов и перезапусков пространство совпадает с моделью до T348.
ASSUME MaxRestarts \in Nat /\ MaxFails \in Nat
ASSUME EscalateAt \in Nat /\ EscalateAt <= MaxFails

Msgs == 1..N
Seqs == 0..MaxSeq
\* Эпоха растёт за счёт часов и durable-пола: больше MaxFence не бывает.
MaxFence == MaxClock + MaxSeq + 1
Fences == 0..MaxFence

\* На чат одновременно живых серверных вызовов за одно намерение не больше
\* двух (свой /new и сверка; повтор сверки — после конца прежнего ожидания).
MaxWire == 2

VARIABLES
  clock,     \* Date.now, не убывает
  reqSeq,    \* сколько намерений записано (порядок запросов /new)
  pFence,    \* pending-намерение: fence; 0 — намерения нет
  pSeq,      \* его seq
  cFence,    \* status.resetEpoch; 0 — сброса ещё не было
  cSeq,      \* seq намерения, записавшего cFence
  convSeq,   \* seq намерения, чей remote последним начал текущий разговор
  wipeMax,   \* наибольший seq среди упавших remote (история для порядка)
  srvMax,    \* журнал роута: наибольшая упавшая по ключу эпоха (resetLandedEpochs)
  vLanded,   \* память моста: наибольший seq remote, про который клиент узнал ответ
  wire,      \* [Seqs -> 0..MaxWire] серверные вызовы seq, дошедшие и не упавшие
  wFence,    \* [Seqs -> Fences] эпоха вызова на проводе
  mState,    \* [m -> "none" | "inbox" | "queue" | "conv" | "gone" | "dropped"]
  mMark,     \* [m -> Fences] пометка эпохой; 0 — запись без пометки
  mAt,       \* [m -> 0..MaxClock] время приёма (enqueuedAt записей без пометки)
  mASeq,     \* [m -> Seqs] reqSeq на момент приёма
  mDrop,     \* [m -> Seqs] seq границы/remote, снявшей сообщение
  nPhase,    \* /new: "idle" | "remote" | "flight" | "clear" | "status" | "intent"
  nFence, nSeq,
  rPhase,    \* reconcile: "idle" | "remote" | "flight" | "landed" | "clear" | "status" | "intent"
  rFence, rSeq,
  booted,    \* сверка при старте прошла: зеркало намерений с диска в памяти
  fails,     \* подряд идущие отказы потоков сброса (память, recordResetFailure)
  failsUsed, \* всего отказов за прогон: граница недетерминизма отказов среды
  backoff,   \* отсрочка повтора (retryAt; Expire снимает)
  escalated, \* эскалация уже отправлена в этой жизни процесса
  escalations, \* сколько эскалаций отправлено за жизнь процесса
  confirmed, \* [Seqs -> 0..2] «Диалог сброшен» по seq намерения
  restarts   \* сколько перезапусков было: граница недетерминизма сбоев моста

epochV == <<clock, reqSeq, pFence, pSeq, cFence, cSeq, convSeq, wipeMax, srvMax, vLanded>>
wireV == <<wire, wFence>>
msgV == <<mState, mMark, mAt, mASeq, mDrop>>
newV == <<nPhase, nFence, nSeq>>
rcV == <<rPhase, rFence, rSeq>>
memV == <<booted, fails, failsUsed, backoff, escalated, escalations, confirmed, restarts>>
vars == <<epochV, wireV, msgV, newV, rcV, memV>>

live == IF pFence # 0 THEN pFence ELSE cFence
liveSeq == IF pFence # 0 THEN pSeq ELSE cSeq
LastDurable == IF pFence >= cFence THEN pFence ELSE cFence

\* remoteLandedEpoch моста (queue.ts:571-579): max(память приземлений, durable
\* эпоха статуса). Память перезапуск теряет (vLanded = 0), статус — нет.
LandedEpoch == IF vLanded >= cSeq THEN vLanded ELSE cSeq

CanFail == failsUsed < MaxFails

\* Правило живости (queue.ts:282-289, inbox.ts:321-325): помеченная эпохой запись жива,
\* если её пометка >= границы (мутант "eq" — только при равенстве); запись без пометки
\* доказывает «после» строго бо́льшим временем приёма. Границы 0 (эпохи нет) живут все.
Fresh(mark, at, f) ==
  \/ f = 0
  \/ mark # 0 /\ (IF FenceRule = "eq" THEN mark = f ELSE mark >= f)
  \/ mark = 0 /\ at > f

\* Снятие сообщения границей чужой seq (для инварианта потерь).
Drop(m, s) ==
  /\ mState' = [mState EXCEPT ![m] = "dropped"]
  /\ mDrop' = [mDrop EXCEPT ![m] = s]

\* clearChatQueue: режет только очередь (inbox не трогает). f — граница, s — её seq.
ClearQueue(f, s) ==
  LET stale(m) == mState[m] = "queue" /\ ~Fresh(mMark[m], mAt[m], f)
  IN /\ mState' = [m \in Msgs |-> IF stale(m) THEN "dropped" ELSE mState[m]]
     /\ mDrop' = [m \in Msgs |-> IF stale(m) THEN s ELSE mDrop[m]]

\* Запись статуса эпохи: с EpochMax прежняя эпоха не падает (её seq у значения),
\* без — пишется fence завершаемого намерения.
WriteStatus(f, s) ==
  IF EpochMax /\ cFence >= f
    THEN UNCHANGED <<cFence, cSeq>>
    ELSE cFence' = f /\ cSeq' = s

\* Удалённый сброс, упавший по сети: разговор стирается целиком, доставленное уходит
\* в "gone" со штампом seq упавшего remote.
RemoteWipe(s) ==
  /\ mState' = [m \in Msgs |-> IF mState[m] = "conv" THEN "gone" ELSE mState[m]]
  /\ mDrop' = [m \in Msgs |-> IF mState[m] = "conv" THEN s ELSE mDrop[m]]
  /\ convSeq' = s
  /\ wipeMax' = IF s > wipeMax THEN s ELSE wipeMax

\* Исполнение remote на сервере (handleTelegramResetRequest): журнал упавших
\* эпох по ключу чата (WireFence) отклоняет вызов, чья эпоха уже упала —
\* запрос снимается, сессию он не трогает. Без журнала вызов сбрасывает живую
\* на момент падения сессию безусловно — запоздалый remote старого намерения
\* трёт свежий разговор (возврат S69).
ApplyRemote(s, f) ==
  IF WireFence /\ f <= srvMax
    THEN /\ UNCHANGED <<mState, mDrop, convSeq, wipeMax, srvMax>>
    ELSE /\ RemoteWipe(s)
         /\ srvMax' = IF f > srvMax THEN f ELSE srvMax

\* Снятие вызова seq из wire после ApplyRemote.
TakeWire(s) == wire' = [wire EXCEPT ![s] = @ - 1]

\* Отказ шага сброса: общий счётчик и отсрочка (recordResetFailure +
\* deferResetRetry); на EscalateAt-м подряд сверка шлёт эскалацию однажды.
\* Escalate — только путь сверки: у потока /new отказ кончается текстом статуса,
\* отметку escalated ставит только catch reconcile (queue.ts:975-986).
FailStep(escalate) ==
  /\ CanFail
  /\ fails' = fails + 1
  /\ failsUsed' = failsUsed + 1
  /\ backoff' = TRUE
  /\ IF escalate /\ fails + 1 >= EscalateAt /\ ~escalated
       THEN /\ escalated' = TRUE /\ escalations' = escalations + 1
       ELSE UNCHANGED <<escalated, escalations>>

\* Успешное завершение потока у /new: снятие отсрочки (clearResetRetryState) и
\* «Диалог сброшен» владельцу (finishReset идёт и когда снятие отступило чужому —
\* его guarded-ветка всё равно возвращает успех).
SettleNew ==
  /\ confirmed' = [confirmed EXCEPT ![nSeq] = @ + 1]
  /\ fails' = 0 /\ backoff' = FALSE /\ escalated' = FALSE

Init ==
  /\ clock = 0 /\ reqSeq = 0
  /\ pFence = 0 /\ pSeq = 0 /\ cFence = 0 /\ cSeq = 0 /\ convSeq = 0 /\ wipeMax = 0
  /\ srvMax = 0 /\ vLanded = 0
  /\ wire = [s \in Seqs |-> 0]
  /\ wFence = [s \in Seqs |-> 0]
  /\ mState = [m \in Msgs |-> "none"]
  /\ mMark = [m \in Msgs |-> 0]
  /\ mAt = [m \in Msgs |-> 0]
  /\ mASeq = [m \in Msgs |-> 0]
  /\ mDrop = [m \in Msgs |-> 0]
  /\ nPhase = "idle" /\ nFence = 0 /\ nSeq = 0
  /\ rPhase = "idle" /\ rFence = 0 /\ rSeq = 0
  /\ booted = FALSE
  /\ fails = 0 /\ failsUsed = 0 /\ backoff = FALSE
  /\ escalated = FALSE /\ escalations = 0
  /\ confirmed = [s \in Seqs |-> 0]
  /\ restarts = 0

\* Часы идут только вперёд; равенство соседних запросов — «та же миллисекунда».
Tick ==
  /\ clock < MaxClock /\ clock' = clock + 1
  /\ UNCHANGED <<reqSeq, pFence, pSeq, cFence, cSeq, convSeq, wipeMax, srvMax, vLanded,
                 wireV, msgV, newV, rcV, memV>>

\* Старт моста: сверка при старте прочитала намерения с диска в зеркало — до неё
\* поллинга нет, поэтому приём, промоут, слив и /new ждут подъёма (main.ts: первый
\* getUpdates — после сверки при старте).
Boot ==
  /\ ~booted /\ booted' = TRUE
  /\ UNCHANGED <<epochV, wireV, msgV, newV, rcV, fails, failsUsed, backoff, escalated,
                 escalations, confirmed, restarts>>

\* Приём: пометка живой эпохой; без эпохи — запись без пометки со своим временем.
Admit ==
  /\ booted
  /\ \E m \in Msgs :
    /\ mState[m] = "none"
    /\ mState' = [mState EXCEPT ![m] = "inbox"]
    /\ mMark' = [mMark EXCEPT ![m] = live]
    /\ mAt' = [mAt EXCEPT ![m] = clock]
    /\ mASeq' = [mASeq EXCEPT ![m] = reqSeq]
    /\ UNCHANGED <<epochV, mDrop, wireV, newV, rcV, memV>>

\* Промоут: мёртвое снимается живой эпохой; живое встаёт в очередь, а без намерения
\* и пустой очереди может пройти прямой доставкой в разговор.
Promote ==
  /\ booted
  /\ \E m \in Msgs :
    /\ mState[m] = "inbox"
    /\ IF ~Fresh(mMark[m], mAt[m], live)
         THEN /\ Drop(m, liveSeq)
              /\ UNCHANGED <<epochV, mMark, mAt, mASeq, wireV>>
         ELSE /\ \/ mState' = [mState EXCEPT ![m] = "queue"]
                 \/ /\ pFence = 0
                    /\ ~(\E m2 \in Msgs : mState[m2] = "queue")
                    /\ mState' = [mState EXCEPT ![m] = "conv"]
              /\ UNCHANGED <<epochV, mMark, mAt, mASeq, mDrop>>
    /\ UNCHANGED <<wireV, newV, rcV, memV>>

\* Слив: при живом намерении не идёт (routing.ts:472); без него отдаёт всю очередь.
Drain ==
  /\ booted /\ pFence = 0
  /\ \E m \in Msgs : mState[m] = "queue"
  /\ mState' = [m \in Msgs |-> IF mState[m] = "queue" THEN "conv" ELSE mState[m]]
  /\ UNCHANGED <<epochV, mMark, mAt, mASeq, mDrop, wireV, newV, rcV, memV>>

\* /new: намерение с эпохой max(now, последняя durable + 1); мутант — голый clock.
\* Перезаписывает ожидающее намерение (своего потока у /new одновременно нет).
\* Отказ записи: отказ в общий счёт и отсрочка, seq не расходуется — повторный
\* /new после отсрочки запишет своё намерение (фаза "blocked").
NewPersist ==
  /\ booted /\ ~backoff
  /\ nPhase = "idle" /\ reqSeq < MaxSeq /\ clock >= 1
  /\ LET f == IF MonotoneEpoch
                THEN IF clock >= LastDurable + 1 THEN clock ELSE LastDurable + 1
                ELSE clock
         s == reqSeq + 1
     IN \/ /\ pFence' = f /\ pSeq' = s /\ reqSeq' = s
           /\ nPhase' = "remote" /\ nFence' = f /\ nSeq' = s
           /\ UNCHANGED <<fails, failsUsed, backoff>>
        \/ /\ FailStep(FALSE)
           /\ UNCHANGED <<pFence, pSeq, reqSeq, nPhase, nFence, nSeq>>
  /\ UNCHANGED <<clock, cFence, cSeq, convSeq, wipeMax, srvMax, vLanded, wireV, msgV,
                 rcV, booted, escalated, escalations, confirmed, restarts>>

\* Выпуск remote своего /new: вызов уходит в wire и долетает до сервера или
\* нет — решает сеть, не клиент. Со слотом выпуск сериализован с чужим
\* (rPhase = "flight" — ждём), а remote за уже упавшую эпоху
\* (LandedEpoch >= nSeq: её падение клиент видел) не выпускается вовсе. Без слота
\* второй вызов за то же намерение улетает, пока первый ещё в wire.
NewRemote ==
  /\ nPhase = "remote" /\ ~backoff
  /\ \/ /\ RemoteSlot /\ LandedEpoch >= nSeq
        /\ nPhase' = "clear"
        /\ UNCHANGED <<wireV, mState, mDrop, convSeq, wipeMax>>
     \/ /\ (~RemoteSlot \/ LandedEpoch < nSeq)
        /\ (RemoteSlot => rPhase # "flight")
        /\ wire[nSeq] < MaxWire
        /\ nPhase' = "flight"
        /\ wire' = [wire EXCEPT ![nSeq] = @ + 1]
        /\ wFence' = [wFence EXCEPT ![nSeq] = nFence]
        /\ UNCHANGED <<mState, mDrop, convSeq, wipeMax>>
  /\ UNCHANGED <<clock, reqSeq, pFence, pSeq, cFence, cSeq, srvMax, vLanded, mMark, mAt,
                 mASeq, rcV, nFence, nSeq, memV>>

\* Конец клиентского ожидания — не падение remote. Ответ: сервер исполнил
\* вызов (применил или отклонил по эпохе — оба ответа для клиента успех), и
\* журнал приземлений запоминает эпоху (issueRemoteReset после возврата issue).
\* Таймаут/обрыв: клиент отказался ждать, отказ в общий счёт с отсрочкой, а
\* серверный вызов мог доехать и остаться — он падает позже отдельным событием
\* (SrvLand). Именно разрыв «ожидание кончилось»/«вызов жив» — дыра возврата S69.
NewDone ==
  /\ nPhase = "flight"
  /\ \/ /\ nPhase' = "clear"
        /\ vLanded' = IF vLanded >= nSeq THEN vLanded ELSE nSeq
        /\ IF wire[nSeq] > 0
             THEN /\ ApplyRemote(nSeq, wFence[nSeq])
                  /\ TakeWire(nSeq)
             ELSE /\ srvMax >= wFence[nSeq]  \* упал или отклонён до ответа
                  /\ UNCHANGED <<wire, mState, mDrop, convSeq, wipeMax, srvMax>>
        /\ UNCHANGED <<fails, failsUsed, backoff>>
     \/ /\ nPhase' = "idle"   \* remote-сбой/таймаут: намерение дожмёт reconcile
        /\ FailStep(FALSE)
        /\ \/ /\ wire[nSeq] > 0 /\ TakeWire(nSeq)  \* не доехал до сервера
           \/ UNCHANGED wire   \* доехал и остался — упадёт позже (SrvLand)
        /\ UNCHANGED <<mState, mDrop, convSeq, wipeMax, srvMax, vLanded>>
  /\ UNCHANGED <<clock, reqSeq, pFence, pSeq, cFence, cSeq, mMark, mAt, mASeq, wFence,
                 rcV, nFence, nSeq, booted, escalated, escalations, confirmed, restarts>>

\* Запоздавшее падение remote на сервере — после того, как его клиент кончил
\* ждать, и наравне с ожидаемыми: журнал эпох (WireFence) отклоняет уже
\* упавшую. Модель допускает любой порядок падений — сильнее серверной очереди
\* по ключу: журнал делает порядок безразличным. Клиент о падении не узнаёт:
\* vLanded остаётся.
SrvLand ==
  \E s \in Seqs :
    /\ wire[s] > 0
    /\ ApplyRemote(s, wFence[s])
    /\ TakeWire(s)
    /\ UNCHANGED <<clock, reqSeq, pFence, pSeq, cFence, cSeq, mMark, mAt, mASeq, wFence,
                   vLanded, newV, rcV, memV>>

\* completeScopedResetState, ч.1: выход при сменившейся эпохе, затем чистка по живой.
NewClear ==
  /\ nPhase = "clear"
  /\ IF Guards /\ live # 0 /\ live # nFence
       THEN nPhase' = "idle" /\ UNCHANGED msgV
       ELSE /\ ClearQueue(IF live # 0 THEN live ELSE nFence,
                          IF live # 0 THEN liveSeq ELSE nSeq)
            /\ nPhase' = "status"
  /\ UNCHANGED <<epochV, mMark, mAt, mASeq, wireV, rcV, nFence, nSeq, memV>>

\* completeScopedResetState, ч.2: повторная сверка за время чистки, затем статус.
NewStatus ==
  /\ nPhase = "status"
  /\ IF Guards /\ live # 0 /\ live # nFence
       THEN nPhase' = "idle" /\ UNCHANGED <<cFence, cSeq>>
       ELSE /\ WriteStatus(nFence, nSeq)
            /\ nPhase' = "intent"
  /\ UNCHANGED <<clock, reqSeq, pFence, pSeq, convSeq, wipeMax, srvMax, vLanded, wireV,
                 msgV, rcV, nFence, nSeq, memV>>

\* Снятие только своего намерения: чужое (уже следующее /new) не трогаем.
\* Любой исход потока — успех для владельца: finishReset и clearResetRetryState.
NewIntent ==
  /\ nPhase = "intent"
  /\ IF Guards /\ pFence # nFence
       THEN UNCHANGED <<pFence, pSeq>>
       ELSE pFence' = 0 /\ pSeq' = 0
  /\ nPhase' = "idle"
  /\ SettleNew
  /\ UNCHANGED <<clock, reqSeq, cFence, cSeq, convSeq, wipeMax, srvMax, vLanded, wireV,
                 msgV, rcV, nFence, nSeq, booted, failsUsed, escalations, restarts>>

\* reconcile: снимок намерения; без живого или на отсрочке — нечего дожимать.
RcScan ==
  /\ booted /\ ~backoff
  /\ rPhase = "idle" /\ pFence # 0
  /\ rFence' = pFence /\ rSeq' = pSeq /\ rPhase' = "remote"
  /\ UNCHANGED <<epochV, wireV, msgV, newV, memV>>

\* Сверка намерения до выпуска remote и сам выпуск. Со слотом выпуск идёт только
\* по свободному слоту (nPhase = "flight" — ждём) и только если remote за эту
\* эпоху ещё не падал по слову клиента: его уже посадил /new — дожимаем локально,
\* без вызова (rPhase' = "landed"). Без слота выпуск не упорядочен: пока вызов в
\* wire, намерение могут дожать или уступить — падение это уже не отменяет, см.
\* SrvLand.
RcRemote ==
  /\ rPhase = "remote"
  /\ IF Guards /\ pFence # rFence
       THEN /\ rPhase' = "idle"
            /\ UNCHANGED <<wireV, mState, mDrop, convSeq, wipeMax>>
       ELSE \/ /\ RemoteSlot /\ LandedEpoch >= rSeq
               /\ rPhase' = "landed"
               /\ UNCHANGED <<wireV, mState, mDrop, convSeq, wipeMax>>
            \/ /\ (~RemoteSlot \/ LandedEpoch < rSeq)
               /\ (RemoteSlot => nPhase # "flight")
               /\ wire[rSeq] < MaxWire
               /\ rPhase' = "flight"
               /\ wire' = [wire EXCEPT ![rSeq] = @ + 1]
               /\ wFence' = [wFence EXCEPT ![rSeq] = rFence]
               /\ UNCHANGED <<mState, mDrop, convSeq, wipeMax>>
  /\ UNCHANGED <<clock, reqSeq, pFence, pSeq, cFence, cSeq, srvMax, vLanded, mMark, mAt,
                 mASeq, newV, rFence, rSeq, memV>>

\* Конец клиентского ожидания сверки — как у /new: ответ — сервер исполнил
\* вызов, таймаут оставляет его живым в wire (падение позже — SrvLand). Отказ
\* идёт в общий счёт; на EscalateAt-м подряд владельцу уходит «запусти iva
\* reset» один раз за жизнь процесса.
RcDone ==
  /\ rPhase = "flight"
  /\ \/ /\ rPhase' = "landed"
        /\ vLanded' = IF vLanded >= rSeq THEN vLanded ELSE rSeq
        /\ IF wire[rSeq] > 0
             THEN /\ ApplyRemote(rSeq, wFence[rSeq])
                  /\ TakeWire(rSeq)
             ELSE /\ srvMax >= wFence[rSeq]
                  /\ UNCHANGED <<wire, mState, mDrop, convSeq, wipeMax, srvMax>>
        /\ UNCHANGED <<fails, failsUsed, backoff, escalated, escalations>>
     \/ /\ rPhase' = "idle"   \* сбой/таймаут: намерение ждёт следующего прохода
        /\ FailStep(TRUE)
        /\ \/ /\ wire[rSeq] > 0 /\ TakeWire(rSeq)
           \/ UNCHANGED wire
        /\ UNCHANGED <<mState, mDrop, convSeq, wipeMax, srvMax, vLanded>>
  /\ UNCHANGED <<clock, reqSeq, pFence, pSeq, cFence, cSeq, mMark, mAt, mASeq, wFence,
                 newV, rFence, rSeq, booted, confirmed, restarts>>

\* Пост-сверка: уступленное или снятое намерение локальной чистки не получает —
\* упавший remote это уже не возвращает.
RcPost ==
  /\ rPhase = "landed"
  /\ IF Guards /\ pFence # rFence
       THEN rPhase' = "idle"
       ELSE rPhase' = "clear"
  /\ UNCHANGED <<epochV, wireV, msgV, newV, rFence, rSeq, memV>>

\* Завершение, ч.1 (та же логика, что у /new): сверка живой эпохи, чистка очереди.
RcClear ==
  /\ rPhase = "clear"
  /\ IF Guards /\ pFence # rFence
       THEN rPhase' = "idle" /\ UNCHANGED msgV
       ELSE /\ ClearQueue(IF live # 0 THEN live ELSE rFence,
                          IF live # 0 THEN liveSeq ELSE rSeq)
            /\ rPhase' = "status"
  /\ UNCHANGED <<epochV, mMark, mAt, mASeq, wireV, newV, rFence, rSeq, memV>>

RcStatus ==
  /\ rPhase = "status"
  /\ IF Guards /\ live # 0 /\ live # rFence
       THEN rPhase' = "idle" /\ UNCHANGED <<cFence, cSeq>>
       ELSE /\ WriteStatus(rFence, rSeq)
            /\ rPhase' = "intent"
  /\ UNCHANGED <<clock, reqSeq, pFence, pSeq, convSeq, wipeMax, srvMax, vLanded, wireV,
                 msgV, newV, rFence, rSeq, memV>>

\* Снятие своего намерения сверкой. Успех снимает и отсрочку со счётчиком;
\* отступившее снятие возвращает false раньше — память не трогаем. «Диалог
\* сброшен» по коду шлёт только поток /new; мутант ConfirmOnRecovery подаёт его
\* и здесь — тогда одно намерение подтверждается дважды (ConfirmOnce красный).
RcIntent ==
  /\ rPhase = "intent"
  /\ IF Guards /\ pFence # rFence
       THEN /\ UNCHANGED <<pFence, pSeq, fails, backoff, escalated, confirmed>>
       ELSE /\ pFence' = 0 /\ pSeq' = 0
            /\ fails' = 0 /\ backoff' = FALSE /\ escalated' = FALSE
            /\ confirmed' = IF ConfirmOnRecovery
                              THEN [confirmed EXCEPT ![rSeq] = @ + 1]
                              ELSE confirmed
  /\ rPhase' = "idle"
  /\ UNCHANGED <<clock, reqSeq, cFence, cSeq, convSeq, wipeMax, srvMax, vLanded, wireV,
                 msgV, newV, rFence, rSeq, booted, failsUsed, escalations, restarts>>

\* Отсрочка повтора истекла: потокам снова можно к remote и сверке.
Expire ==
  /\ backoff /\ backoff' = FALSE
  /\ UNCHANGED <<epochV, wireV, msgV, newV, rcV, booted, fails, failsUsed, escalated,
                 escalations, confirmed, restarts>>

\* Перезапуск Bridge между любыми шагами: волатильная память пуста (зеркало до
\* сверки при старте, счёт отказов, отсрочка, эскалация, журнал приземлений),
\* потоки мертвы. Durable переживает: намерение и эпоха статуса, журнал роута и
\* wire — выпущенный вызов может долететь и без клиента. Эскалации нового
\* процесса считаются заново.
Restart ==
  /\ restarts < MaxRestarts
  /\ restarts' = restarts + 1
  /\ booted' = FALSE
  /\ fails' = 0 /\ backoff' = FALSE /\ escalated' = FALSE /\ escalations' = 0
  /\ vLanded' = 0
  /\ nPhase' = "idle" /\ rPhase' = "idle" /\ rFence' = 0 /\ rSeq' = 0
  /\ UNCHANGED <<clock, reqSeq, pFence, pSeq, cFence, cSeq, convSeq, wipeMax, srvMax,
                 wireV, msgV, nFence, nSeq, failsUsed, confirmed>>

\* Намерение пропадает извне: вайп каталога или откат; pending-память сходится к
\* пустому месту, эпоха падает до статуса — пометки его элементов живут дальше.
Abandon ==
  /\ MayAbandon /\ pFence # 0
  /\ pFence' = 0 /\ pSeq' = 0
  /\ UNCHANGED <<clock, reqSeq, cFence, cSeq, convSeq, wipeMax, srvMax, vLanded, wireV,
                 msgV, newV, rcV, memV>>

\* Стоять можно, только когда делать больше нечего: иначе вечный статтеринг был бы
\* законным поведением и живость проверять было бы нечем.
Idle ==
  /\ booted /\ pFence = 0 /\ nPhase = "idle" /\ rPhase = "idle"
  /\ \A s \in Seqs : wire[s] = 0
  /\ UNCHANGED vars

Next ==
  \/ Tick \/ Boot \/ Admit \/ Promote \/ Drain
  \/ NewPersist \/ NewRemote \/ NewDone \/ NewClear \/ NewStatus \/ NewIntent
  \/ RcScan \/ RcRemote \/ RcDone \/ RcPost \/ RcClear \/ RcStatus \/ RcIntent
  \/ SrvLand \/ Expire \/ Restart \/ Abandon \/ Idle

\* Справедливость по рабочим шагам: непрерывно возможный шаг когда-нибудь делается.
\* Сбои среды (Restart, Abandon), часы и отказ-ветки внутрь шагов fairness не
\* требует — их и без того достаточно для достижимости.
Fairness ==
  /\ WF_vars(Boot) /\ WF_vars(Admit) /\ WF_vars(Promote) /\ WF_vars(Drain)
  /\ WF_vars(NewPersist) /\ WF_vars(NewRemote) /\ WF_vars(NewDone)
  /\ WF_vars(NewClear) /\ WF_vars(NewStatus) /\ WF_vars(NewIntent)
  /\ WF_vars(RcScan) /\ WF_vars(RcRemote) /\ WF_vars(RcDone) /\ WF_vars(RcPost)
  /\ WF_vars(RcClear) /\ WF_vars(RcStatus) /\ WF_vars(RcIntent)
  /\ WF_vars(SrvLand) /\ WF_vars(Expire)

Spec == Init /\ [][Next]_vars /\ Fairness
UnfairSpec == Init /\ [][Next]_vars

TypeOK ==
  /\ clock \in 0..MaxClock /\ reqSeq \in Seqs
  /\ {pFence, cFence, srvMax} \subseteq Fences
  /\ {pSeq, cSeq, convSeq, wipeMax, vLanded} \subseteq Seqs
  /\ \A s \in Seqs : wire[s] \in 0..MaxWire /\ wFence[s] \in Fences
  /\ mState \in [Msgs -> {"none", "inbox", "queue", "conv", "gone", "dropped"}]
  /\ mMark \in [Msgs -> Fences] /\ mAt \in [Msgs -> 0..MaxClock]
  /\ mASeq \in [Msgs -> Seqs] /\ mDrop \in [Msgs -> Seqs]
  /\ nPhase \in {"idle", "remote", "flight", "clear", "status", "intent"}
  /\ {nFence, rFence} \subseteq Fences /\ {nSeq, rSeq} \subseteq Seqs
  /\ rPhase \in {"idle", "remote", "flight", "landed", "clear", "status", "intent"}
  /\ booted \in BOOLEAN /\ fails \in 0..MaxFails /\ failsUsed \in 0..MaxFails
  /\ backoff \in BOOLEAN /\ escalated \in BOOLEAN /\ escalations \in 0..2
  /\ confirmed \in [Seqs -> 0..2] /\ restarts \in 0..MaxRestarts

\* (1) Принятое до последнего успешного /new в новый разговор не попадает: в
\* разговоре, начатом remote намерения s, только сообщения, принятые не раньше
\* запроса s (aseq >= s; принятое при pending s тоже принадлежит ему).
NoStaleInConv == \A m \in Msgs : mState[m] = "conv" => mASeq[m] >= convSeq

\* (2) Принятое после последнего успешного /new не теряется: снять или стереть
\* сообщение вправе только граница или remote, запрошенные после его приёма
\* (seq снявшего > aseq сообщения). Покрывает и dropped (чистка очереди), и
\* gone (упавший remote): запоздалый remote своей же эпохи стирает доставленное
\* под ней — mDrop = aseq, и инвариант краснеет.
LossOnlyByNewer == \A m \in Msgs :
  mState[m] \in {"dropped", "gone"} => mDrop[m] > mASeq[m]

\* (2а) Тот же смысл потерь только для снятий границей (чистка очереди и
\* промоут), хронологический — seq снявшей границы против aseq записи; gone не
\* считается: запоздалый remote — дефект базы (свидетель ResetEpoch-late-remote),
\* он красит gone-часть LossOnlyByNewer и в контроле. Пара FenceRule проверяет
\* только помеченные записи: ветка mark = 0 от FenceRule не зависит ("eq" и
\* "geq" в ней совпадают — доказательство «после» одно, время приёма), а её
\* потерю показывает окно пропавшего намерения — свидетель ниже. Под "geq"
\* помеченная запись снимается только границей, запрошенной после её приёма;
\* под "eq" пометка новой эпохи не равна прежней границе и снимается ею —
\* mDrop < aseq (D65, часть 1; решение арбитра T340).
DropOnlyByNewer == \A m \in Msgs :
  mState[m] = "dropped" /\ mMark[m] # 0 => mDrop[m] > mASeq[m]

\* (2б) Та же гарантия без исключения по пометке — мишень свидетеля окна
\* abandon (ResetEpoch-abandon-loss): намерение пропало после выпуска remote,
\* а его поток продолжается и чистит очередь своей границей. Немаркированная
\* запись, принятая после запроса /new в ту же миллисекунду (enqueuedAt равен
\* fence и «после» не доказывает), снимается ею — mDrop = aseq, потеря.
DropAllByNewer == \A m \in Msgs :
  mState[m] = "dropped" => mDrop[m] > mASeq[m]

\* (3) Порядок завершений: последним упал самый новый remote. convSeq откатывает
\* только запоздалый remote чужой эпохи — он же стирает свежий разговор.
RemoteInOrder == convSeq = wipeMax

\* (4) Владелец получает «Диалог сброшен» на один /new не больше одного раза
\* (control.ts finishReset — одно на завершившийся поток; сверка молчит).
ConfirmOnce == \A s \in Seqs : confirmed[s] <= 1

\* (5) Эскалация «запусти iva reset» — одна за жизнь процесса: счётчик живёт до
\* перезапуска, флаг escalated его и держит (queue.ts:975-986). Флаг снимается
\* успехом (clearResetRetryState), поэтому проверка невакуумна только внутри
\* бюджета отказов cfg: при EscalateAt подряд отказах сверки эскалация уходит,
\* следующий отказ той же серии её не дублирует.
EscalationOnce == escalations <= 1

\* Свидетель достижимости эскалации, не инвариант кода: в cfg с отказами TLC
\* обязан его опровергнуть — иначе EscalationOnce проверяет пустое место.
NoEscalation == escalations = 0

\* (6) Живость прежней ResetIntent (Finished): при справедливости, конечных
\* отказах и перезапусках каждое намерение доезжает — pending пуст, потоки стоят
\* и за каждым seq записанного намерения упал remote его эпохи или новее.
Finished ==
  <>[](pFence = 0 /\ nPhase = "idle" /\ rPhase = "idle"
       /\ \A s \in 1..reqSeq : wipeMax >= s)
====
