----------------------------- MODULE UpdateRun -----------------------------
(* Один ход обновления: шаги `scripts/update-finish.ts` и `scripts/lib/version-update.ts`,
   убийство процесса между любыми двумя шагами и повтор после него.

   Ход, как он идёт в коде (scripts/lib/version-update.ts):
     prepare     запись журнала хода на диск: снимок юнитов и пути карантина
     stop        stopWriterUnits: таймеры, brain, юзербот, службы стоят
     quarantine  quarantineUpdateState: состояние сессий унесено в `.trash-<штамп>`
     migrate     runMigrations + cleanVault
     flip        store.activate: `current` переброшен на кандидата
     start       startCandidateServices: службы кандидата, юниты возвращены по снимку
     serve       проба порта установки: кандидат ответил (store.recordLive)
     settle      store.settle: active.json называет кандидата
     cleanup     gc версий, шим, Google CLI; журнал закрыт

   Обрыв — убийство процесса между любыми двумя шагами (Kill). Повтор (Retry) читает
   журнал и продолжает с записанной фазы; процесс, которого убили, своей памяти не
   оставил. Замок обновления (UpdateLock.tla) и точное восстановление юнитов по снимку
   (LaunchdUnit.tla, RestoreExact) — вне модели: здесь снимок либо пережил обрыв, либо нет,
   а как именно restore ставит enabled/active — это дело LaunchdUnit.

   Инварианты (нумерация задания):
     (1) AnswersAtRest     после любого обрыва и повтора прежняя или новая версия отвечает
     (2) UnitsReturn       юниты, работавшие до обновления, работают после него - при успехе,
                           откате и обрыве с повтором (или владельцу сказано, почему нет)
     (3) SessionsAccounted состояние из карантина либо возвращено, либо снято осознанно,
                           и путь к нему записан
     (4) PinnedAnswered    active.json называет только версию, которая отвечала

   Мутанты (свидетели):
     JournalUnits = FALSE       снимок юнитов живёт только в памяти процесса (код до ремонта):
                                повтор снимает остановленное состояние за исходное -> (2)
     RetryReadsJournal = FALSE  журнал пишется, повтор его не читает -> (2)
     JournalTrash = FALSE       карантин без записанного пути -> (3)
     SettleAfterServe = FALSE   active.json до ответа кандидата -> (4)

   Конфигурации, которые держат зелёное поведение на обоих исходах хода:
     CandidateAnswers = FALSE   кандидат не поднялся: откат, юниты возвращаются
     UserbotRebuilds = FALSE    окружение юзербота не собрать: он остаётся выключен,
                                и владельцу это сказано (told), а не потеряно молча

   Вне модели: сам замок и вытеснение брошенного (UpdateLock.tla); что значит «юнит
   работает» на launchd и systemd и как restore ставит ровно снятое (LaunchdUnit.tla);
   сборка кандидата и проба (buildCandidate/probeCandidate) — до переезда, общего
   состояния не трогают; вывод версий после успеха (gc) и вывод чекаута.
*)
EXTENDS Naturals

CONSTANTS
  JournalUnits,       \* TRUE - снимок юнитов записан на диск до первой остановки
  JournalTrash,       \* TRUE - путь каждого карантина записан на диск
  RetryReadsJournal,  \* TRUE - повтор берёт снимок и пути из журнала
  SettleAfterServe,   \* TRUE - active.json пишется только после ответа кандидата
  CandidateAnswers,   \* TRUE - кандидат поднимается и отвечает на порту установки
  UserbotRebuilds     \* TRUE - окружение юзербота собирается (uv на месте)

Units == {"timer", "userbot"}
Steps == {"prepare", "stop", "quarantine", "migrate", "flip", "start", "serve",
          "settle", "cleanup"}

VARIABLES
  run,       \* "idle" | "running" | "killed"
  step,      \* следующий шаг хода
  current,   \* что называет симлинк `current`: "old" | "new"
  answered,  \* версия, которая последней ответила на порту: "old" | "new" | "none"
  pinned,    \* что называет active.json: "old" | "new"
  units,     \* [u \in Units |-> "run" | "stop"] что работает сейчас
  base,      \* снимок: что работало до обновления (то, что вернут)
  was,       \* что работало до обновления на самом деле - не меняется ни одним шагом
  sessions,  \* "live" | "moved" - состояние сессий
  trash,     \* "none" | "known" - известен ли путь унесённого состояния
  told,      \* [u \in Units |-> BOOLEAN] владельцу сказано, почему юнит остался выключен
  journal,   \* последняя фаза, записанная на диск: "none" | "prepared" | "stopped" | ...
  ever       \* версии, которые отвечали хотя бы раз: {"old"}, {"old","new"}

vars == <<run, step, current, answered, pinned, units, base, was, sessions, trash, told,
          journal, ever>>

AtRest == run = "idle"

\* Фаза журнала -> следующий шаг. "none" значит «журнала нет или он не прочитан».
PhaseStep == [prepared |-> "stop", stopped |-> "quarantine", quarantined |-> "migrate",
              migrated |-> "flip", flipped |-> "start", started |-> "serve",
              settled |-> "cleanup", rolledback |-> "cleanup", done |-> "done"]

\* Что вернёт startCandidate/resumeOldWriters по снимку. Юзербот, чьё окружение не
\* собралось, остаётся выключен - и это сказано владельцу, а не потеряно.
Restored == [u \in Units |->
               IF ~base[u] THEN "stop"
               ELSE IF u = "userbot" /\ ~UserbotRebuilds THEN "stop"
               ELSE "run"]
Told == [u \in Units |->
           told[u] \/ (u = "userbot" /\ base[u] /\ ~UserbotRebuilds)]

Init ==
  /\ run = "idle" /\ step = "done"
  /\ current = "old" /\ answered = "old" /\ pinned = "old"
  /\ units = [u \in Units |-> "run"]
  /\ base = [u \in Units |-> TRUE]
  /\ was = [u \in Units |-> TRUE]
  /\ sessions = "live" /\ trash = "none"
  /\ told = [u \in Units |-> FALSE]
  /\ journal = "none"
  /\ ever = {"old"}

\* `iva update`: журнал хода пишется до первой остановки (scripts/update-finish.ts,
\* quiesce). Без журнала снимок живёт только в памяти процесса.
Begin ==
  /\ run = "idle"
  /\ run' = "running" /\ step' = "stop"
  /\ base' = [u \in Units |-> units[u] = "run"]
  /\ journal' = IF JournalUnits THEN "prepared" ELSE "none"
  /\ UNCHANGED <<current, answered, pinned, units, sessions, trash, told, ever, was>>

StopWriters ==
  /\ step = "stop"
  /\ units' = [u \in Units |-> "stop"]
  /\ answered' = "none"
  /\ step' = "quarantine"
  /\ journal' = IF JournalUnits THEN "stopped" ELSE journal
  /\ UNCHANGED <<run, current, pinned, base, sessions, trash, told, ever, was>>

\* Состояние сессий унесено. Путь известен, если его записали; уже унесённое вторым
\* проходом не записывается заново - снимать нечего.
Quarantine ==
  /\ step = "quarantine"
  /\ sessions' = "moved"
  /\ trash' = IF sessions = "moved" THEN trash ELSE "known"
  /\ step' = "migrate"
  /\ journal' = IF JournalUnits THEN "quarantined" ELSE journal
  /\ UNCHANGED <<run, current, answered, pinned, units, base, told, ever, was>>

\* Миграции и чистка vault: общего состояния юнитов не трогают, но убить здесь можно.
Migrate ==
  /\ step = "migrate"
  /\ step' = "flip"
  /\ journal' = IF JournalUnits THEN "migrated" ELSE journal
  /\ UNCHANGED <<run, current, answered, pinned, units, base, sessions, trash, told, ever, was>>

Flip ==
  /\ step = "flip"
  /\ current' = "new"
  /\ step' = "start"
  /\ journal' = IF JournalUnits THEN "flipped" ELSE journal
  /\ UNCHANGED <<run, answered, pinned, units, base, sessions, trash, told, ever, was>>

\* Службы кандидата и возврат юнитов по снимку.
Start ==
  /\ step = "start"
  /\ units' = Restored
  /\ told' = Told
  /\ step' = IF CandidateAnswers THEN "serve" ELSE "back"
  /\ journal' = IF JournalUnits THEN "started" ELSE journal
  /\ UNCHANGED <<run, current, answered, pinned, base, sessions, trash, ever, was>>

\* Кандидат ответил на порту установки: recordLive(name, true).
Serve ==
  /\ step \in {"serve", "settle"}
  /\ answered' = current
  /\ ever' = ever \cup {current}
  /\ step' = "settle"
  /\ UNCHANGED <<run, current, pinned, units, base, sessions, trash, told, journal, was>>

\* Кандидат не ответил: goBack - прежняя версия перезапущена и отвечает, состояние из
\* карантина возвращено. active.json остаётся прежним.
Back ==
  /\ step = "back"
  /\ current' = "old" /\ answered' = "old" /\ pinned' = "old"
  /\ units' = Restored
  /\ told' = Told
  /\ sessions' = "live"
  /\ step' = "cleanup"
  /\ journal' = IF JournalUnits THEN "rolledback" ELSE journal
  /\ UNCHANGED <<run, base, trash, ever, was>>

\* active.json называет кандидата. В коде - после ответа; мутант делает это до него.
Settle ==
  /\ step = "settle" \/ (step = "serve" /\ ~SettleAfterServe)
  /\ ~SettleAfterServe \/ answered = current
  /\ pinned' = current
  /\ step' = IF step = "settle" THEN "cleanup" ELSE step
  /\ journal' = IF JournalUnits /\ step = "settle" THEN "settled" ELSE journal
  /\ UNCHANGED <<run, current, answered, units, base, sessions, trash, told, ever, was>>

\* Уборка после ответа: gc версий, шим, Google CLI. Юниты уже возвращены.
Cleanup ==
  /\ step = "cleanup"
  /\ run' = "idle" /\ step' = "done"
  /\ journal' = IF JournalUnits
                 THEN IF journal = "rolledback" THEN "rolledback" ELSE "done"
                 ELSE journal
  /\ UNCHANGED <<current, answered, pinned, units, base, sessions, trash, told, ever, was>>

\* Процесс убит между двумя шагами: память процесса ушла, диск остался.
Kill ==
  /\ run = "running"
  /\ run' = "killed"
  /\ UNCHANGED <<step, current, answered, pinned, units, base, sessions, trash, told,
                 journal, ever, was>>

\* Повтор после обрыва. С журналом - с записанной фазы и с записанным снимком.
\* Без журнала (код до ремонта) ход начинается заново и снимает то, что видит: юниты
\* стоят, значит «так и было».
Retry ==
  /\ run = "killed"
  /\ IF JournalUnits /\ RetryReadsJournal
     THEN /\ step' = IF journal = "none" THEN "stop" ELSE PhaseStep[journal]
          /\ base' = base
          /\ trash' = IF JournalTrash THEN trash ELSE "none"
          /\ journal' = journal
     ELSE /\ step' = "stop"
          /\ base' = [u \in Units |-> units[u] = "run"]
          /\ trash' = "none"
          /\ journal' = "none"
  /\ run' = "running"
  /\ UNCHANGED <<current, answered, pinned, units, sessions, told, ever, was>>

Next ==
  \/ Begin \/ StopWriters \/ Quarantine \/ Migrate \/ Flip \/ Start \/ Serve \/ Back
  \/ Settle \/ Cleanup \/ Kill \/ Retry

Spec == Init /\ [][Next]_vars /\ WF_vars(Retry) /\ WF_vars(StopWriters)
        /\ WF_vars(Quarantine) /\ WF_vars(Migrate) /\ WF_vars(Flip) /\ WF_vars(Start)
        /\ WF_vars(Serve) /\ WF_vars(Back) /\ WF_vars(Settle) /\ WF_vars(Cleanup)

TypeOK ==
  /\ run \in {"idle", "running", "killed"}
  /\ step \in Steps \cup {"back", "done"}
  /\ current \in {"old", "new"}
  /\ answered \in {"old", "new", "none"}
  /\ pinned \in {"old", "new"}
  /\ units \in [Units -> {"run", "stop"}]
  /\ base \in [Units -> BOOLEAN]
  /\ was \in [Units -> BOOLEAN]
  /\ sessions \in {"live", "moved"}
  /\ trash \in {"none", "known"}
  /\ told \in [Units -> BOOLEAN]
  /\ journal \in {"none", "prepared", "stopped", "quarantined", "migrated", "flipped",
                  "started", "settled", "rolledback", "done"}
  /\ ever \in SUBSET {"old", "new"}

\* (1) В покое версия отвечает: обрыв и повтор не оставляют установку без ответа.
AnswersAtRest == AtRest => answered # "none"

\* (2) Юнит, работавший до обновления, работает после него - или владельцу сказано, почему
\* он остался выключен. `was` - то, что работало до обновления, а не снимок: снимок и есть
\* то, что теряется.
UnitsReturn ==
  AtRest => \A u \in Units: was[u] => (units[u] = "run" \/ told[u])

\* (3) Состояние сессий либо на месте, либо унесено на записанный путь.
SessionsAccounted ==
  AtRest => (sessions = "live" \/ (sessions = "moved" /\ trash = "known"))

\* (4) active.json называет только ту версию, которая отвечала.
PinnedAnswered == pinned \in ever

\* (2) и (1) вместе на обрыве: повтор доходит до покоя и снова отвечает.
AnswersAgain == (run = "killed") ~> (answered # "none")
====
