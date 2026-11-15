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
\*   Check         scripts/memory/brain.ts:commitOwnerChanges -> agent/lib/vault-commit.ts
\*                 commitVaultSweep -> commitPaths: список путей и lstat; путь больше
\*                 VAULT_BLOB_LIMIT_BYTES в git add не идёт (его блоб не пишется в базу
\*                 объектов). Тот же commitPaths у дневных писателей и ночной подметки
\*                 «до ночи» (scripts/memory/night.ts): порог один для всех коммитов vault.
\*   Store         commitFitting: git add читает файлы — их размер в этот миг; stagedBlobs
\*                 меряет блоб в индексе, больший порога снимается с индекса (restoreIndex);
\*                 commitWith коммитит ровно эти блобы из своего индекса, рабочее дерево не
\*                 перечитывает. Между Check и Store файл может вырасти: Write — любой миг.
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
\*   ChecksBlob = FALSE   решает только проверка до add: файл, выросший между lstat и
\*                        чтением git, уходит в коммит (BigNeverCommitted)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Files,       \* файлы vault, которые меняются
  MaxWrites,   \* сколько записей файлов
  Threshold, Tells, SkipAborts, Throttled, Unstages, ChecksBlob

Sizes == {"small", "big"}
Version(f, s) == <<f, s>>
History0 == {Version(f, "small") : f \in Files} \cup {Version("old", "big")}

VARIABLES
  size,      \* размер файла в рабочем дереве
  changed,   \* файл изменён и не закоммичен
  history,   \* версии файлов, которые бэкап хранит (уходят push и остаются в его дереве)
  phase,     \* Brain: idle | checked (lstat прошёл, git ещё не читал) | committed (до Alert)
  paths,     \* пути, которые взяла проверка
  early,     \* пути, которые проверка до add оставила вне коммита
  skipped,   \* пути, которые последний коммит не взял по порогу
  told,      \* суть последнего отправленного Alert (набор имён); {} — нет записи
  failed,    \* последняя отправка Alert не удалась
  repeated,  \* Alert ушёл о наборе, о котором уже сказано
  stuck,     \* файлы до порога, которые последний коммит не взял
  writes

vars == <<size, changed, history, phase, paths, early, skipped, told, failed, repeated, stuck,
          writes>>

Init ==
  /\ size = [f \in Files |-> "small"]
  /\ changed = [f \in Files |-> FALSE]
  /\ history = History0
  /\ phase = "idle"
  /\ paths = {} /\ early = {}
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
  /\ UNCHANGED <<history, phase, paths, early, skipped, told, failed, repeated, stuck>>

Check ==
  /\ phase = "idle"
  /\ paths' = {f \in Files : changed[f]}
  /\ early' = IF Threshold THEN {f \in Files : changed[f] /\ size[f] = "big"} ELSE {}
  /\ phase' = "checked"
  /\ UNCHANGED <<size, changed, history, skipped, told, failed, repeated, stuck, writes>>

\* Блоб — файл в миг чтения git; коммит берёт эти блобы, а не рабочее дерево ещё раз.
Store ==
  /\ phase = "checked"
  /\ LET late == IF Threshold /\ ChecksBlob
                    THEN {f \in paths \ early : size[f] = "big"} ELSE {}
         over == early \cup late
         taken == IF SkipAborts /\ over # {} THEN {} ELSE paths \ over
     IN /\ skipped' = over
        /\ stuck' = (paths \ over) \ taken
        /\ changed' = [f \in Files |-> changed[f] /\ f \notin taken]
        /\ history' =
             (IF Unstages /\ over # {}
                THEN history \ {Version(f, "small") : f \in over}
                ELSE history)
             \cup {Version(f, size[f]) : f \in taken}
  /\ phase' = "committed"
  /\ paths' = {} /\ early' = {}
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
  /\ UNCHANGED <<size, changed, history, paths, early, skipped, stuck, writes>>

Next ==
  \/ \E f \in Files, s \in Sizes : Write(f, s)
  \/ Check \/ Store
  \/ \E ok \in BOOLEAN : Tell(ok)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ size \in [Files -> Sizes]
  /\ changed \in [Files -> BOOLEAN]
  /\ phase \in {"idle", "checked", "committed"}
  /\ paths \subseteq Files /\ early \subseteq paths
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
