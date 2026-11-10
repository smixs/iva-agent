---- MODULE BrainOversize ----
\* Ночной бэкап vault (Brain) и файл больше порога (90 МБ). GitHub отклоняет блоб от 100 МБ,
\* и тогда не уходит весь push: один огромный файл останавливает бэкап всей памяти.
\* Решение владельца 10.11.2026: «Вернуть защиту минимально».
\*
\* Модель о коде, не о дизайне: каждое действие — шаг существующей функции (карта ниже).
\* Размер файла абстрагирован в два значения: small (до порога) и big (больше порога).
\* В начальной истории уже лежит большой блоб old: его записала версия до защиты.
\*
\* Действие модели -> код
\*   Write(f, s)   владелец, агент или вложение пишут файл vault (рабочее дерево)
\*   Commit        scripts/memory/brain.ts:commitOwnerChanges -> agent/lib/vault-commit.ts
\*                 commitVaultSweep -> commitPaths: пути больше VAULT_BLOB_LIMIT_BYTES в
\*                 git add и коммит не идут и возвращаются полем oversize; остальные
\*                 коммитятся. Тот же commitPaths у дневных писателей и ночной подметки
\*                 «до ночи» (scripts/memory/night.ts): порог один для всех коммитов vault.
\*   Tell(ok)      brain.ts:alertOversize — набор пропущенных путей; есть — alertOnce с сутью
\*                 «отсортированные имена» (packages/alert-state: та же суть молчит неделю,
\*                 неотправленный Alert не записывается); пусто — alertResolved
\*   Push          brain.ts:pushBackup — git push origin HEAD
\*
\* Мутанты (свидетели), каждый нарушает свой инвариант:
\*   Threshold = FALSE    порог не применён: большой файл идёт в коммит (BigNeverCommitted)
\*   Tells = FALSE        пропуск без Alert (SkippedIsTold)
\*   SkipAborts = TRUE    пропуск останавливает весь коммит (OthersGo)
\*   Throttled = FALSE    Alert о том же наборе каждую ночь (OneAlertPerSet)
\*   Unstages = TRUE      пропуск убирает из индекса уже взятый под git файл: следующий
\*                        коммит удаляет его прежнюю версию из бэкапа (HistoryKept)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Files,       \* файлы vault, которые меняются
  MaxWrites,   \* сколько записей файлов
  Threshold, Tells, SkipAborts, Throttled, Unstages

Sizes == {"small", "big"}
Version(f, s) == <<f, s>>
History0 == {Version(f, "small") : f \in Files} \cup {Version("old", "big")}

VARIABLES
  size,      \* размер файла в рабочем дереве
  changed,   \* файл изменён и не закоммичен
  history,   \* версии файлов, которые бэкап хранит (уходят push и остаются в его дереве)
  phase,     \* Brain: idle | committed (между коммитом и Alert)
  skipped,   \* пути, которые последний коммит не взял по порогу
  told,      \* суть последнего отправленного Alert (набор имён); {} — нет записи
  failed,    \* последняя отправка Alert не удалась
  repeated,  \* Alert ушёл о наборе, о котором уже сказано
  stuck,     \* файлы до порога, которые последний коммит не взял
  writes

vars == <<size, changed, history, phase, skipped, told, failed, repeated, stuck, writes>>

Init ==
  /\ size = [f \in Files |-> "small"]
  /\ changed = [f \in Files |-> FALSE]
  /\ history = History0
  /\ phase = "idle"
  /\ skipped = {}
  /\ told = {}
  /\ failed = FALSE
  /\ repeated = FALSE
  /\ stuck = {}
  /\ writes = 0

Write(f, s) ==
  /\ writes < MaxWrites
  /\ size' = [size EXCEPT ![f] = s]
  /\ changed' = [changed EXCEPT ![f] = TRUE]
  /\ writes' = writes + 1
  /\ UNCHANGED <<history, phase, skipped, told, failed, repeated, stuck>>

Commit ==
  /\ phase = "idle"
  /\ LET dirty == {f \in Files : changed[f]}
         over == IF Threshold THEN {f \in dirty : size[f] = "big"} ELSE {}
         taken == IF SkipAborts /\ over # {} THEN {} ELSE dirty \ over
     IN /\ skipped' = over
        /\ stuck' = (dirty \ over) \ taken
        /\ changed' = [f \in Files |-> changed[f] /\ f \notin taken]
        /\ history' =
             (IF Unstages /\ over # {}
                THEN history \ {Version(f, "small") : f \in over}
                ELSE history)
             \cup {Version(f, size[f]) : f \in taken}
  /\ phase' = "committed"
  /\ UNCHANGED <<size, told, failed, repeated, writes>>

Tell(ok) ==
  /\ phase = "committed"
  /\ phase' = "idle"
  /\ IF skipped = {} \/ ~Tells
       THEN /\ told' = IF Tells THEN {} ELSE told
            /\ failed' = FALSE
            /\ UNCHANGED repeated
       ELSE IF Throttled /\ told = skipped
         THEN UNCHANGED <<told, failed, repeated>>
         ELSE /\ failed' = ~ok
              /\ told' = IF ok THEN skipped ELSE told
              /\ repeated' = (repeated \/ (ok /\ told = skipped))
  /\ UNCHANGED <<size, changed, history, skipped, stuck, writes>>

Next ==
  \/ \E f \in Files, s \in Sizes : Write(f, s)
  \/ Commit
  \/ \E ok \in BOOLEAN : Tell(ok)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ size \in [Files -> Sizes]
  /\ changed \in [Files -> BOOLEAN]
  /\ phase \in {"idle", "committed"}
  /\ skipped \subseteq Files
  /\ told \subseteq Files
  /\ failed \in BOOLEAN /\ repeated \in BOOLEAN
  /\ stuck \subseteq Files

\* (1) Версия больше порога не попадает в историю (кроме той, что лежала до защиты).
BigNeverCommitted == \A v \in history \ History0 : v[2] = "small"

\* (2) Каждый пропущенный файл назван владельцу: после ночи суть последнего Alert — этот
\*     набор, или отправка не удалась и следующая ночь повторит её.
SkippedIsTold == phase = "idle" => (skipped = {} \/ told = skipped \/ failed)

\*     Об одном и том же наборе Alert уходит один раз (дроссель — неделя, вне модели).
OneAlertPerSet == ~repeated

\* (3) Остальные файлы уходят: коммит берёт каждый изменённый файл до порога.
OthersGo == stuck = {}

\* (4) Уже лежащее в истории не удаляется и не переписывается.
HistoryKept == History0 \subseteq history
====
