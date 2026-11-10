----------------------------- MODULE UpdateJob -----------------------------
(* Задание обновления из меню: что видит Bridge после того, как обновлятор умер.

   Задание пишет Bridge по тапу (scripts/poller/update-flow.ts), обновлятор его исполняет,
   а исход в чат отправляет процесс, который перезапуск поднимает заново: обновлятор
   умирает вместе с версией, которую он выводит из обращения. Между переключением
   `current` и записью исхода процесс можно убить - и тогда в чате остаётся крутилка, а на
   диске установка, которая уже переехала.

   Откуда Bridge берёт исход (update-flow.ts:concludeUpdateJob):
     журнал хода           фаза "done" пишется после settle, то есть после ответа
                           кандидата (UpdateRun.tla, serveAndFinish);
     четыре источника      симлинк `current` + active.json (store.settled) +
                           live-failures.json + исход в самом задании - для хода,
                           начатого версией без журнала (обновление с 0.5.0-0.5.11);
     срок задания          через UPDATE_JOB_TTL_MS задание получает итог «не завершилось»
                           и файл снимается.

   Инварианты (нумерация задания):
     (1) FinalOnlyWhenPinned «✅ старая → новая» появляется, только когда новая версия
                            закреплена и отвечала
     (2) NoEndlessWatch      каждое задание получает итог за ограниченное время
     (3) ShownOnce           итог показан один раз

   Мутанты (свидетели):
     SymlinkAlone = TRUE   итог по одному симлинку `current` -> (1)
     DropAfter = FALSE     файл задания переживает отправленный итог: второй старт Bridge
                           говорит его снова -> (3)

   Вне модели: живость самого Bridge (его поднимает systemd), доставка в Telegram и её
   повторы (reporter.complete), точный текст экрана. Deadline - это TTL в тиках.
*)
EXTENDS Naturals

CONSTANTS
  FromJournal,  \* TRUE - Bridge читает исход из журнала хода
  FromSources,  \* TRUE - ... из четырёх источников: current + active.json + live-failures + задание
  SymlinkAlone, \* TRUE - ... только из симлинка `current` (мутант)
  DropAfter,    \* TRUE - файл задания снимается после отправленного итога
  Deadline      \* через сколько тиков задание обязано получить итог

VARIABLES
  job,       \* "none" | "open" | "dropped" - файл задания в data/update-jobs
  current,   \* что называет симлинк `current`: "old" | "new"
  answered,  \* версия, ответившая на порту установки: "old" | "new"
  pinned,    \* что называет active.json: "old" | "new"
  journal,   \* фаза журнала хода: "none" | "flipped" | "done"
  step,      \* где стоит обновлятор: "fetch" | "start" | "settle" | "write" | "done"
  update,    \* "idle" | "running" | "killed"
  bridge,    \* "watching" | "done"
  ticks,     \* сколько тиков Bridge смотрит на задание
  final,     \* отправленный итог: "none" | "ok" | "fail"
  delivered  \* сколько итогов ушло в чат

vars == <<job, current, answered, pinned, journal, step, update, bridge, ticks, final,
          delivered>>

AtRest == bridge = "done"

Init ==
  /\ job = "none"
  /\ current = "old" /\ answered = "old" /\ pinned = "old"
  /\ journal = "none"
  /\ step = "done"
  /\ update = "idle"
  /\ bridge = "watching"
  /\ ticks = 0
  /\ final = "none"
  /\ delivered = 0

\* Тап по кнопке: задание на диске, обновлятор запущен, Bridge смотрит.
Ask ==
  /\ update = "idle" /\ job = "none"
  /\ job' = "open"
  /\ update' = "running" /\ step' = "fetch"
  /\ bridge' = "watching" /\ ticks' = 0 /\ final' = "none"
  /\ UNCHANGED <<current, answered, pinned, journal, delivered>>

\* Переключение симлинка: журнал хода получает фазу "flipped".
Flip ==
  /\ step = "fetch"
  /\ current' = "new"
  /\ journal' = "flipped"
  /\ step' = "start"
  /\ UNCHANGED <<job, answered, pinned, update, bridge, ticks, final, delivered>>

\* Службы кандидата поднялись, и он ответил на порту установки.
Start ==
  /\ step = "start"
  /\ answered' = "new"
  /\ step' = "settle"
  /\ UNCHANGED <<job, current, pinned, journal, update, bridge, ticks, final, delivered>>

\* store.settle: active.json называет кандидата. Только после ответа.
Settle ==
  /\ step = "settle"
  /\ pinned' = "new"
  /\ journal' = "done"
  /\ step' = "write"
  /\ UNCHANGED <<job, current, answered, update, bridge, ticks, final, delivered>>

\* Обновлятор записал исход в задание, и ход закончился.
Write ==
  /\ step = "write"
  /\ step' = "done" /\ update' = "idle"
  /\ UNCHANGED <<job, current, answered, pinned, journal, bridge, ticks, final, delivered>>

\* Процесс обновлятора убит между двумя шагами.
Kill ==
  /\ update = "running"
  /\ update' = "killed"
  /\ UNCHANGED <<job, current, answered, pinned, journal, step, bridge, ticks, final,
                 delivered>>

\* Тик наблюдения.
Tick ==
  /\ bridge = "watching" /\ final = "none" /\ ticks < Deadline
  /\ ticks' = ticks + 1
  /\ UNCHANGED <<job, current, answered, pinned, journal, step, update, bridge, final,
                 delivered>>

\* «✅ старая → новая» по журналу хода: фаза "done" уже после settle и ответа.
FinalFromJournal ==
  /\ FromJournal /\ journal = "done"
  /\ job = "open" /\ bridge = "watching" /\ final = "none"
  /\ final' = "ok" /\ delivered' = delivered + 1 /\ bridge' = "done"
  /\ job' = IF DropAfter THEN "dropped" ELSE job
  /\ UNCHANGED <<current, answered, pinned, journal, step, update, ticks>>

\* «✅» по четырём источникам: ход, начатый версией без журнала. Симлинк переехал,
\* active.json закрепил кандидата, список мёртвых сборок молчит, ответ был.
FinalFromSources ==
  /\ FromSources
  /\ pinned = "new" /\ current = "new" /\ answered = "new"
  /\ job = "open" /\ bridge = "watching" /\ final = "none"
  /\ final' = "ok" /\ delivered' = delivered + 1 /\ bridge' = "done"
  /\ job' = IF DropAfter THEN "dropped" ELSE job
  /\ UNCHANGED <<current, answered, pinned, journal, step, update, ticks>>

\* Мутант: «✅» по одному симлинку `current`.
FinalFromSymlink ==
  /\ SymlinkAlone /\ current = "new"
  /\ job = "open" /\ bridge = "watching" /\ final = "none"
  /\ final' = "ok" /\ delivered' = delivered + 1 /\ bridge' = "done"
  /\ job' = IF DropAfter THEN "dropped" ELSE job
  /\ UNCHANGED <<current, answered, pinned, journal, step, update, ticks>>

\* Срок вышел: задание получает итог «не завершилось» и файл снимается.
Expire ==
  /\ job = "open" /\ bridge = "watching" /\ final = "none" /\ ticks = Deadline
  /\ final' = "fail" /\ delivered' = delivered + 1 /\ bridge' = "done"
  /\ job' = IF DropAfter THEN "dropped" ELSE job
  /\ UNCHANGED <<current, answered, pinned, journal, step, update, ticks>>

\* Bridge перезапустили. Задание на диске он читает заново - и говорит снова, если файл
\* пережил отправленный итог.
RestartBridge ==
  /\ bridge = "done" /\ job = "open"
  /\ bridge' = "watching" /\ ticks' = 0 /\ final' = "none"
  /\ UNCHANGED <<job, current, answered, pinned, journal, step, update, delivered>>

Next ==
  \/ Ask \/ Flip \/ Start \/ Settle \/ Write \/ Kill \/ Tick
  \/ FinalFromJournal \/ FinalFromSources \/ FinalFromSymlink \/ Expire \/ RestartBridge

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ job \in {"none", "open", "dropped"}
  /\ current \in {"old", "new"} /\ answered \in {"old", "new"}
  /\ pinned \in {"old", "new"}
  /\ journal \in {"none", "flipped", "done"}
  /\ step \in {"fetch", "start", "settle", "write", "done"}
  /\ update \in {"idle", "running", "killed"}
  /\ bridge \in {"watching", "done"}
  /\ ticks \in 0..Deadline
  /\ final \in {"none", "ok", "fail"}
  /\ delivered \in 0..Deadline + 1

\* (1) «✅ старая → новая» появляется, только когда новая версия закреплена и отвечала.
FinalOnlyWhenPinned ==
  final = "ok" => current = "new" /\ pinned = "new" /\ answered = "new"

\* (2) Наблюдение кончается итогом и не длится дольше срока.
NoEndlessWatch == AtRest => /\ ticks <= Deadline /\ final # "none"

\* (3) Итог показан один раз.
ShownOnce == delivered <= 1
====
