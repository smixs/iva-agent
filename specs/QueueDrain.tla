---- MODULE QueueDrain ----
\* Слив очереди Bridge пачкой (спека .scratch/work/wave-1010/l5/spec-v2.md, раздел 7). Модель
\* написана ДО кода: она проверяет замысел, не код.
\*
\* Что описывает. Один чат; два автора; сообщения 1..N, у каждого автор и вид: plain —
\* склеивается; alone — идёт отдельной доставкой (команда, подпись-команда, тап по кнопке
\* модели, сообщение без from, ответ на сообщение бота). При Replies = TRUE любое alone может
\* быть ответом боту и пройти мимо очереди: шире кода, где мимо очереди идёт только ответ.
\* Inbox каждого автора — свой FIFO; маршрут головы inbox (в очередь или прямой доставкой в
\* eve) и снятие её с inbox — разные шаги. Очередь Bridge этого чата. Слив: выбор пачки (закреп или queueBatchLength), доставка, снятие набора одной
\* записью. Ledger eve — id доставок, на которые она начала ход: доставка с id из ledger
\* получает handled. Занятость чата ходом или свёрткой (запись running). queueInFlight чата.
\* Переключение «Очередь» / «Перебивать». Перезапуск Bridge: память (фаза слива, закреп,
\* inFlight) пуста, inbox, очередь и ledger на диске. Потеря id ledger (ошибка записи после
\* принятия, вытеснение из последних 200).
\*
\* Чего не описывает: склейку входа коллектором (элемент inbox — одно сообщение); границы в
\* частях и знаках (вместо них MaxItems элементов); /new, ограду сброса и clearChatQueue (ответ
\* боту, который они возвращают в обычный маршрут, — недетерминированный выбор, шире кода);
\* closed-session; отрицательные id без ledger (синтетика меню и старый формат: их повтор и
\* сегодня даёт второй ход); время (срок доставки 5 с, settleUntil, ожидание running после
\* принятия — недетерминизм порядка шагов); несколько чатов; содержимое частей и как Inbound
\* pipeline их читает (нечитаемая часть, §3.8); то, что Ива отвечает по смыслу на все части.
\* Свойств живости нет.
\*
\* id сравниваются только на равенство (последний элемент пачки, принадлежность ledger и
\* закрепу), поэтому номер id по порядку прихода не теряет общности: случайный скачок update_id
\* у Telegram в модели ничего не меняет.
\*
\* Чтобы проверка шла минуты, а не часы, без потери поведений: авторы симметричны, поэтому
\* первое сообщение — от "a"; QueueOrder и WholeBatch проверяются в момент хода и выбора пачки
\* (призраки orderBad, batchBad), а не по номерам появлений; снимок snap ведётся только без
\* FreshAck, призрак recBy — только при потере id ledger.
\*
\* Действие модели -> файл:функция (база ef7966cd; слив пачкой и маршрут R1 — из спеки v2, §3)
\*   Arrive       scripts/poller/inbox.ts:169 admitTelegramUpdate: апдейт в inbox своего автора
\*                (ключ collectorKeyFor = чат + тема + автор, scripts/lib/telegram-collect.ts:75)
\*   Route(a)     inbox.ts:214 promoteReadyInbox -> scripts/poller/routing.ts:212
\*                routeMessageUpdate. Ответ боту идёт мимо очереди прямой доставкой, кроме
\*                ограды сброса и свёртки (:287-293; модель выбирает любой путь). Иначе
\*                mustQueue (спека v2 §3.4) = inFlight.has(key) или очередь чата не пуста или
\*                «Очередь» и running; QueueFirst = FALSE — маршрут ef7966cd (:295): inFlight
\*                или «Очередь» и (running или очередь не пуста). mustQueue -> постановка
\*                (Enqueue); иначе прямая доставка routing.ts:97 deliverDirectUpdate: id в
\*                ledger -> handled = delivered; принято; не принято (шага нет: голова ждёт в
\*                inbox); принято после срока Bridge (Late): ход и ledger есть, Bridge видит
\*                rejected, голова остаётся в inbox
\*   Enqueue      scripts/lib/telegram-queue.ts:453 enqueueItem: в хвост, дубль id не добавляется
\*   InboxAck(a)  promoteReadyInbox: снятие головы inbox после queued/delivered
\*   StartDrain   routing.ts:335 drainReadyQueueHeads: чат свободен; закреп, если его id стоят с
\*                головы, иначе queueBatchLength; pins.set до доставки; inFlight delivering
\*   Deliver      scripts/poller/deliver.ts:52 deliver -> agent/lib/telegram-acceptance.ts:294:
\*                последний id пачки в ledger -> handled; иначе принято (ход, ledger, чат занят,
\*                inFlight остаётся) / не принято / принято после срока Bridge (Late: ход и ledger
\*                есть, Bridge видит false)
\*   Ack          acknowledgeQueueItems под serializeQueueMutation: очередь, прочитанная заново,
\*                без id пачки; закреп снят. ACK_ROLLED_BACK: очередь прежняя, закреп остаётся.
\*                FATAL_DURABILITY — то же, что Restart
\*   Settle       проход слива видит фазу running и свободный чат: inFlight.delete (routing.ts:416)
\*   Free         ход кончился (agent/channels/telegram.ts)
\*   LedgerLoss   recordCompletedUpdate упала после принятия (telegram-acceptance.ts:457) или id
\*                вытеснен из последних 200 (:53)
\*   Switch       владелец переключает «Очередь» / «Перебивать» в /menu (data/settings.json;
\*                telegramTurnPolicy читается на каждом маршруте)
\*   Restart      systemd: память Bridge пуста; .ack-pending восстанавливается до чтения
\*                (telegram-queue.ts:778), поэтому обрыв внутри Ack равен обрыву до него
\*
\* Ack атомарен для других писателей (serializeQueueMutation). Loop = "seq" — главный цикл кода
\* (scripts/poller/main.ts:335-431): продвижение inbox, затем проход слива; маршрут в слив не
\* вклинивается. Loop = "any" — маршрут и постановка между любыми шагами слива: шире кода, так
\* модель покрывает фонового писателя очереди, которого сегодня нет.
\*
\* Переключатели кода (TRUE — спека v2; каждый свидетель снимает один):
\*   Pin         закреп пачки до снятия (§3.3 шаги 2, 4, 6, 7)
\*   SameSender  склеиваются только сообщения автора головы (§3.2 queueBatchLength)
\*   FreshAck    снятие читает очередь заново и снимает только id пачки (§3.6)
\*   AloneRule   alone идёт отдельной доставкой (§3.2 deliveredAlone)
\*   QueueFirst  R1 (§3.4): пока очередь чата не пуста, сообщение встаёт за ней и при
\*               «Перебивать»; прямая доставка не обгоняет очередь (кроме ответа боту)
\* Окружение: Policy в начале ("queue" — «Очередь», "steer" — «Перебивать»); MaxSwitches —
\* сколько раз владелец переключает режим (при одном «Перебивать» очередь копится только за
\* сливом в полёте, а он бывает только при непустой очереди: без переключения она пуста); Loop;
\* Late — доставка принята после срока Bridge; Replies — alone может идти мимо очереди как ответ
\* боту; MaxLedgerLoss; MaxRestarts.
\*
\* Потеря id ledger даёт только дубль. Она убирает ответы handled, а потерять сообщение может
\* только лишний handled. Призрак recBy помнит, какие сообщения несла доставка, записавшая id в
\* ledger; потеря id m разрешает дубль каждому из них (exposed).
\*
\* Контрпример F1 (свидетель QueueDrain-switch.cfg: QueueFirst = FALSE, Loop = "seq", то есть в
\* порядке кода). Спека v1 теряла сообщение. Режим «Очередь», чат занят, у автора a в очереди
\* 1 и 2; владелец включает «Перебивать»; Bridge перезапускается между маршрутом 2 и снятием 2 с
\* inbox; после старта 2 уходит прямой доставкой (очередь «Перебивать» не держит) и попадает в
\* ledger; слив берёт пачку 1+2 с id 2 -> handled -> снятие убирает и 1, хода с 1 не было. Тот
\* же исход без перезапуска (QueueDrain-switch-norestart.cfg): 2 принято после срока Bridge и
\* снова встаёт в очередь за 1, пока inFlight держит чат после чужой пачки. Довод «всё, что
\* стоит перед X, было в доставке, которая записала X в ledger» неверен для прямой доставки X,
\* обогнавшей очередь. R1 закрывает оба пути (QueueDrain.cfg и QueueDrain-steer.cfg с двумя
\* переключениями — без ошибок). Ответ боту обгоняет очередь и при R1, но он всегда один в
\* пачке, поэтому его id не бывает последним id пачки из нескольких элементов.
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  N,              \* сколько сообщений
  MaxItems,       \* граница пачки в элементах (COLLECT_MAX_PARTS / COLLECT_MAX_CHARS в коде)
  MaxRestarts,    \* перезапуски Bridge
  MaxLedgerLoss,  \* сколько id ledger может потерять; 0 — не теряет
  MaxSwitches,    \* сколько раз владелец переключает «Очередь» / «Перебивать»
  Policy, Loop, Late, Replies,
  Pin, SameSender, FreshAck, AloneRule, QueueFirst

ASSUME Policy \in {"queue", "steer"}
ASSUME Loop \in {"seq", "any"}
ASSUME N \in Nat /\ MaxItems \in Nat \ {0}
ASSUME {Late, Replies, Pin, SameSender, FreshAck, AloneRule, QueueFirst} \subseteq BOOLEAN

Msgs == 1..N
Authors == {"a", "b"}
Kinds == {"plain", "alone"}

VARIABLES
  arrived,    \* сколько сообщений пришло; id = номер прихода
  author,     \* автор сообщения; "none" — ещё не пришло
  kind,       \* вид сообщения; "none" — ещё не пришло
  inbox,      \* inbox каждого автора (FIFO id)
  routed,     \* голова inbox автора прошла маршрут, снятие с inbox впереди
  q,          \* очередь Bridge этого чата
  busy,       \* чат занят ходом или свёрткой
  ledger,     \* id доставок, на которые eve начала ход
  recBy,      \* призрак: id в ledger -> сообщения доставки, которая его записала
  phase,      \* слив: "idle" | "deliver" | "ack"
  batch,      \* пачка текущего слива
  snap,       \* снимок очереди, по которому выбрана пачка (нужен только снятию без FreshAck)
  pin,        \* закреп: id пачки до её снятия; {} — нет
  inflight,   \* queueInFlight содержит чат
  pol,        \* turnPolicy сейчас
  restarts, losses, switches,
  \* призраки
  seen,       \* id, которые были хотя бы в одном начатом ходе
  enqN,       \* номер первой постановки в очередь; 0 — не было
  enqC,
  exposed,    \* id, которым дубль разрешён: их доставку оборвал перезапуск, прямая доставка
              \* кончилась для Bridge без ответа, а eve ход начала, или ledger потерял id
              \* доставки, в которой они были
  dupBad,     \* был ход с id, который уже был в ходе и не exposed
  aloneBad,   \* ход из очереди склеил alone с другим сообщением
  orderBad,   \* сообщение пришло в ход из очереди раньше того, что встало в очередь до него
  batchBad    \* пачка без закрепа недопустима или не максимальна

inboxV == <<arrived, author, kind, inbox, routed>>
drainV == <<q, phase, batch, snap, pin, inflight>>
eveV == <<busy, ledger, recBy>>
countV == <<pol, restarts, losses, switches>>
ghostV == <<seen, enqN, enqC, exposed, dupBad, aloneBad, orderBad, batchBad>>
vars == <<inboxV, drainV, eveV, countV, ghostV>>

Range(s) == {s[i] : i \in 1..Len(s)}
Max(S) == CHOOSE x \in S : \A y \in S : y <= x
Without(s, S) == SelectSeq(s, LAMBDA x : x \notin S)
InboxIds == UNION {Range(inbox[a]) : a \in Authors}

\* deliveredAlone: команда, тап, сообщение без from, ответ боту.
Alone(m) == kind[m] = "alone"

\* Пачка допустима: один элемент любого вида, или до MaxItems склеиваемых одного автора.
Valid(b) ==
  \/ Len(b) = 1
  \/ /\ Len(b) <= MaxItems
     /\ \A i \in 1..Len(b) : ~Alone(b[i]) /\ author[b[i]] = author[b[1]]

\* queueBatchLength: голова alone -> 1; дальше по порядку до первого alone, чужого автора или
\* границы. Пропусков нет: остановились — дальше не смотрим.
RECURSIVE Grow(_, _)
Grow(s, n) ==
  IF n = Len(s) THEN n
  ELSE LET nx == s[n + 1] IN
       IF \/ AloneRule /\ Alone(nx)
          \/ SameSender /\ author[nx] # author[s[1]]
          \/ n + 1 > MaxItems
         THEN n
         ELSE Grow(s, n + 1)
SelectLen(s) == IF AloneRule /\ Alone(s[1]) THEN 1 ELSE Grow(s, 1)

\* Сколько элементов с головы очереди стоят в закрепе (до первого не из закрепа).
PinLen == Max({k \in 0..Len(q) : \A i \in 1..k : q[i] \in pin})

\* id доставки пачки: последний элемент (joinUpdates).
Rep == batch[Len(batch)]

\* В Loop = "seq" маршрут и слив не пересекаются.
NoRouteOpen == \A a \in Authors : ~routed[a]

\* eve начала ход с доставкой b (fromQ — доставка из очереди). Порядок проверяется здесь же:
\* сообщение m2 впервые приходит в ход из очереди, и всё, что встало в очередь раньше m2, уже
\* было в ходе или стоит в этой доставке перед m2.
Start(b, fromQ) ==
  LET pos(m) == CHOOSE i \in 1..Len(b) : b[i] = m
      earlier(m1, m2) == m1 \in seen \/ (m1 \in Range(b) /\ pos(m1) < pos(m2))
  IN /\ seen' = seen \cup Range(b)
     /\ dupBad' = (dupBad \/ \E m \in Range(b) : m \in seen /\ m \notin exposed)
     /\ aloneBad' = (aloneBad \/ (fromQ /\ Len(b) > 1 /\ \E i \in 1..Len(b) : Alone(b[i])))
     /\ orderBad' =
          (orderBad \/ (fromQ /\ \E m2 \in Range(b), m1 \in Msgs :
                          /\ m2 \notin seen /\ enqN[m2] # 0
                          /\ enqN[m1] # 0 /\ enqN[m1] < enqN[m2]
                          /\ ~earlier(m1, m2)))

NoStart == UNCHANGED <<seen, dupBad, aloneBad, orderBad>>

\* eve записывает id доставки d с сообщениями ms в ledger и занимает чат. recBy читает только
\* потеря id ledger; без неё призрак не ведётся, чтобы не множить состояния.
Record(d, ms) ==
  /\ ledger' = ledger \cup {d}
  /\ recBy' = IF MaxLedgerLoss > 0 THEN [recBy EXCEPT ![d] = ms] ELSE recBy
  /\ busy' = TRUE

Init ==
  /\ arrived = 0
  /\ author = [m \in Msgs |-> "none"]
  /\ kind = [m \in Msgs |-> "none"]
  /\ inbox = [a \in Authors |-> <<>>]
  /\ routed = [a \in Authors |-> FALSE]
  /\ q = <<>> /\ busy = FALSE /\ ledger = {} /\ recBy = [m \in Msgs |-> {}]
  /\ phase = "idle" /\ batch = <<>> /\ snap = <<>> /\ pin = {}
  /\ inflight = FALSE
  /\ pol = Policy /\ restarts = 0 /\ losses = 0 /\ switches = 0
  /\ seen = {} /\ enqN = [m \in Msgs |-> 0] /\ enqC = 0
  /\ exposed = {} /\ dupBad = FALSE /\ aloneBad = FALSE /\ orderBad = FALSE /\ batchBad = FALSE

\* Авторы симметричны: первое сообщение без потери общности от "a" (вдвое меньше состояний).
Arrive ==
  /\ arrived < N
  /\ \E a \in (IF arrived = 0 THEN {"a"} ELSE Authors), k \in Kinds :
       LET m == arrived + 1 IN
       /\ arrived' = m
       /\ author' = [author EXCEPT ![m] = a]
       /\ kind' = [kind EXCEPT ![m] = k]
       /\ inbox' = [inbox EXCEPT ![a] = Append(@, m)]
  /\ UNCHANGED <<routed, drainV, eveV, countV, ghostV>>

Enqueue(h) ==
  /\ q' = IF h \in Range(q) THEN q ELSE Append(q, h)
  /\ enqN' = IF enqN[h] = 0 THEN [enqN EXCEPT ![h] = enqC + 1] ELSE enqN
  /\ enqC' = IF enqN[h] = 0 THEN enqC + 1 ELSE enqC

\* mustQueue без ответа боту и ограды сброса: R1 (спека v2 §3.4) или маршрут ef7966cd.
MustQueue ==
  IF QueueFirst
    THEN inflight \/ q # <<>> \/ (pol = "queue" /\ busy)
    ELSE inflight \/ (pol = "queue" /\ (busy \/ q # <<>>))

Route(a) ==
  /\ inbox[a] # <<>> /\ ~routed[a]
  /\ Loop = "seq" => (phase = "idle" /\ NoRouteOpen)
  /\ LET h == Head(inbox[a]) IN
     \* bypass: ответ боту вне ограды сброса и свёртки идёт прямо, не глядя на очередь
     \E bypass \in (IF Replies /\ Alone(h) THEN BOOLEAN ELSE {FALSE}) :
       IF ~bypass /\ MustQueue
         THEN /\ Enqueue(h)
              /\ routed' = [routed EXCEPT ![a] = TRUE]
              /\ UNCHANGED <<eveV, exposed>> /\ NoStart
         ELSE /\ UNCHANGED <<q, enqN, enqC>>
              /\ IF h \in ledger
                   THEN \* handled -> delivered
                        /\ routed' = [routed EXCEPT ![a] = TRUE]
                        /\ UNCHANGED <<eveV, exposed>> /\ NoStart
                   ELSE \/ \* принято
                           /\ Start(<<h>>, FALSE) /\ Record(h, {h})
                           /\ routed' = [routed EXCEPT ![a] = TRUE]
                           /\ UNCHANGED exposed
                        \/ \* принято после срока Bridge: голова остаётся в inbox
                           /\ Late
                           /\ Start(<<h>>, FALSE) /\ Record(h, {h})
                           /\ exposed' = exposed \cup {h}
                           /\ UNCHANGED routed
  /\ UNCHANGED <<arrived, author, kind, inbox>>
  /\ UNCHANGED <<phase, batch, snap, pin, inflight>> /\ UNCHANGED <<countV, batchBad>>

InboxAck(a) ==
  /\ routed[a]
  /\ inbox' = [inbox EXCEPT ![a] = Tail(@)]
  /\ routed' = [routed EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<arrived, author, kind, drainV, eveV, countV, ghostV>>

StartDrain ==
  /\ phase = "idle" /\ ~busy /\ q # <<>>
  /\ Loop = "seq" => NoRouteOpen
  /\ LET pl == IF Pin THEN PinLen ELSE 0
         n == IF pl > 0 THEN pl ELSE SelectLen(q)
         b == SubSeq(q, 1, n)
     IN /\ batch' = b
        /\ snap' = IF FreshAck THEN <<>> ELSE q
        /\ pin' = IF Pin THEN Range(b) ELSE {}
        \* WholeBatch: пачка без закрепа (префикс q по построению) допустима и максимальна
        /\ batchBad' =
             (batchBad \/ (pl = 0 /\ ~(Valid(b) /\ (n < Len(q) => ~Valid(SubSeq(q, 1, n + 1))))))
  /\ phase' = "deliver" /\ inflight' = TRUE
  /\ UNCHANGED <<q, inboxV, eveV, countV>>
  /\ UNCHANGED <<seen, enqN, enqC, exposed, dupBad, aloneBad, orderBad>>

DrainIdle ==
  /\ phase' = "idle" /\ batch' = <<>> /\ snap' = <<>>

Deliver ==
  /\ phase = "deliver"
  /\ IF Rep \in ledger
       THEN \* handled: хода нет, снятие
            /\ phase' = "ack" /\ inflight' = FALSE
            /\ UNCHANGED <<batch, snap, eveV>> /\ NoStart
       ELSE \/ \* принято: ход, ledger, чат занят; inFlight остаётся (фаза running)
               /\ Start(batch, TRUE) /\ Record(Rep, Range(batch))
               /\ phase' = "ack"
               /\ UNCHANGED <<batch, snap, inflight>>
            \/ \* не принято: закреп остаётся
               /\ DrainIdle /\ inflight' = FALSE
               /\ UNCHANGED eveV /\ NoStart
            \/ \* принято после срока Bridge: Bridge видит false, закреп остаётся
               /\ Late
               /\ Start(batch, TRUE) /\ Record(Rep, Range(batch))
               /\ DrainIdle /\ inflight' = FALSE
  /\ UNCHANGED <<q, pin, inboxV, countV, enqN, enqC, exposed, batchBad>>

Ack ==
  /\ phase = "ack"
  /\ \/ /\ q' = IF FreshAck THEN Without(q, Range(batch)) ELSE Without(snap, Range(batch))
        /\ pin' = {}
     \/ \* ACK_ROLLED_BACK: очередь прежняя, закреп остаётся
        UNCHANGED <<q, pin>>
  /\ DrainIdle
  /\ UNCHANGED <<inflight, inboxV, eveV, countV, ghostV>>

Settle ==
  /\ inflight /\ phase = "idle" /\ ~busy
  /\ Loop = "seq" => NoRouteOpen
  /\ inflight' = FALSE
  /\ UNCHANGED <<q, phase, batch, snap, pin, inboxV, eveV, countV, ghostV>>

Busy ==
  /\ ~busy /\ busy' = TRUE
  /\ UNCHANGED <<ledger, recBy, inboxV, drainV, countV, ghostV>>

Free ==
  /\ busy /\ busy' = FALSE
  /\ UNCHANGED <<ledger, recBy, inboxV, drainV, countV, ghostV>>

\* Ledger забыл id m: дубль разрешён каждому сообщению доставки, которая записала m.
LedgerLoss ==
  /\ losses < MaxLedgerLoss
  /\ \E m \in ledger :
       /\ ledger' = ledger \ {m}
       /\ exposed' = exposed \cup recBy[m]
  /\ losses' = losses + 1
  /\ UNCHANGED <<busy, recBy, pol, restarts, switches, inboxV, drainV>>
  /\ UNCHANGED <<seen, enqN, enqC, dupBad, aloneBad, orderBad, batchBad>>

\* Владелец переключает «Очередь» / «Перебивать» в /menu (data/settings.json).
Switch ==
  /\ switches < MaxSwitches
  /\ switches' = switches + 1
  /\ pol' = IF pol = "queue" THEN "steer" ELSE "queue"
  /\ UNCHANGED <<restarts, losses, inboxV, drainV, eveV, ghostV>>

Restart ==
  /\ restarts < MaxRestarts
  /\ restarts' = restarts + 1
  /\ exposed' = exposed \cup pin \cup Range(batch)
                \cup {Head(inbox[a]) : a \in {x \in Authors : routed[x]}}
  /\ DrainIdle /\ pin' = {} /\ inflight' = FALSE
  /\ routed' = [a \in Authors |-> FALSE]
  /\ UNCHANGED <<q, arrived, author, kind, inbox, eveV, pol, losses, switches>>
  /\ UNCHANGED <<seen, enqN, enqC, dupBad, aloneBad, orderBad, batchBad>>

Next ==
  \/ Arrive
  \/ \E a \in Authors : Route(a) \/ InboxAck(a)
  \/ StartDrain \/ Deliver \/ Ack \/ Settle
  \/ Busy \/ Free \/ LedgerLoss \/ Switch \/ Restart

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ arrived \in 0..N
  /\ author \in [Msgs -> Authors \cup {"none"}]
  /\ kind \in [Msgs -> Kinds \cup {"none"}]
  /\ \A a \in Authors : Range(inbox[a]) \subseteq 1..arrived /\ Len(inbox[a]) <= N
  /\ routed \in [Authors -> BOOLEAN]
  /\ Range(q) \subseteq 1..arrived /\ Len(q) = Cardinality(Range(q))
  /\ busy \in BOOLEAN /\ ledger \subseteq Msgs /\ recBy \in [Msgs -> SUBSET Msgs]
  /\ phase \in {"idle", "deliver", "ack"}
  /\ (phase = "idle") = (batch = <<>>)
  /\ pin \subseteq Msgs /\ inflight \in BOOLEAN /\ pol \in {"queue", "steer"}
  /\ seen \subseteq Msgs /\ exposed \subseteq Msgs /\ enqN \in [Msgs -> 0..N]

\* (1) Каждое пришедшее сообщение лежит в inbox, в очереди или было хотя бы в одном ходе.
NoLoss == \A m \in 1..arrived : m \in InboxIds \/ m \in Range(q) \/ m \in seen

\* (2) Сообщение бывает в двух ходах, только если оно exposed: его доставку оборвал перезапуск
\* Bridge (пачка в полёте или в закрепе, маршрут без снятия с inbox), его прямая доставка
\* кончилась для Bridge без ответа, а eve ход начала, или ledger потерял id доставки, в которой
\* оно было. Срок ответа слива сам дубля не даёт.
NoDupBeyondBreak == ~dupBad

\* (3) Первые появления сообщений, пришедших в ход из очереди, идут в порядке первой постановки;
\* внутри хода части — в порядке очереди (проверка в Start).
QueueOrder == ~orderBad

\* (4) Пачка, выбранная без закрепа, — префикс снимка, допустима и максимальна: следующий
\* элемент alone, другого автора, или пачка уже MaxItems; голова alone -> пачка из неё одной.
\* Проверка в StartDrain, на снимке q, по которому выбрана пачка.
WholeBatch == ~batchBad

\* (5) Ход из очереди, в котором есть alone, состоит из одного сообщения.
AloneStaysAlone == ~aloneBad

\* (6) Пачка в полёте стоит с головы очереди целиком: removeQueueItems не встречает набор не с
\* головы (там код бросает ошибку без записи).
BatchAtHead ==
  phase # "idle" => (Len(q) >= Len(batch) /\ SubSeq(q, 1, Len(batch)) = batch)

\* (7) Закреп стоит с головы очереди целиком: ветка «закреп частичный или пустой» недостижима.
\* Только в модели: сброс /new (вне модели) режет закреп по update_id; остаток код отдаёт под
\* id закрепа, чтобы ledger ответил handled (routing.ts queueBatch, тесты queue-drain.property).
PinAtHead ==
  pin # {} =>
    (Len(q) >= Cardinality(pin) /\ {q[i] : i \in 1..Cardinality(pin)} = pin)
====
