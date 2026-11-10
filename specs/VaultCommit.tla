---- MODULE VaultCommit ----
\* Коммит правки памяти vault. Шов собирает дерево из снимка HEAD и наших блобов; пока он
\* это делает, другой писатель (ночной Brain в своём процессе, git владельца) коммитит
\* соседний файл. Наивный `git commit` берёт родителем уже новый HEAD, а дерево - из снимка:
\* соседний файл возвращается к старому блобу и следующий push уносит старые данные
\* (находка B3-R критика 10.11.2026).
\*
\* Действие модели -> код (agent/lib/vault-commit.ts)
\*   Stage(f)         commitFitting: `git add` кладёт блоб файла f в общий индекс; наш путь.
\*   ForeignWrite(f)  другой процесс пишет соседний файл (рабочее дерево)
\*   ForeignCommit(f) другой процесс коммитит соседний файл: HEAD сдвинулся
\*   Snapshot         commitWith: копия общего индекса и `read-tree --reset <HEAD>`
\*   Store            `write-tree` -> `commit-tree -p <снимок>` -> `update-ref HEAD <новый>
\*                    <снимок>` (перевод HEAD сравнением со снимком); при CompareHead = FALSE
\*                    это прежний `git commit`, который сравнивает только сам с собой
\*   Retry            `update-ref` отказал: снимок пересобирается от нового HEAD
\*   GiveUp           повторы кончились (до MaxAttempts): обычная ошибка записи, HEAD цел
\*
\* Версия содержимого - одно из значений; 0 - та, что лежит в HEAD с самого начала.
EXTENDS Naturals, FiniteSets

CONSTANTS
  Ours,        \* наши пути: их меняет правка памяти
  Neighbors,   \* соседние файлы: их коммитит другой писатель
  MaxWrites,   \* сколько записей файлов в модели
  MaxAttempts, \* сколько раз шов пересобирает снимок (HEAD_MOVES в коде)
  CompareHead  \* сравнивает ли `update-ref` HEAD со снимком

Files == Ours \cup Neighbors
Contents == {"0", "1", "2"}

VARIABLES
  staged,   \* наши блобы в индексе (git add)
  pending,   \* незакоммиченное содержимое соседнего файла
  foreign,   \* что другой писатель закоммитил в свой файл; "none" - ещё ничего
  head,      \* содержимое HEAD по файлам
  ours,      \* наши значения, которые уже уехали в HEAD
  snap,      \* снимок HEAD, из которого собран временный индекс
  phase,     \* idle (до снимка) | snapped (дерево собрано, HEAD не записан)
  attempts,  \* сколько раз снимок собран в этом коммите
  writes

vars == <<staged, pending, foreign, head, ours, snap, phase, attempts, writes>>

Init ==
  /\ staged = [f \in Ours |-> "0"]
  /\ pending = [f \in Neighbors |-> "none"]
  /\ foreign = [f \in Neighbors |-> "none"]
  /\ head = [f \in Files |-> "0"]
  /\ ours = [f \in Ours |-> "none"]
  /\ snap = [f \in Files |-> "none"]
  /\ phase = "idle"
  /\ attempts = 0
  /\ writes = 0

Stage(f) ==
  /\ f \in Ours
  /\ writes < MaxWrites
  /\ \E v \in {"1", "2"} : staged' = [staged EXCEPT ![f] = v]
  /\ writes' = writes + 1
  /\ UNCHANGED <<pending, foreign, head, ours, snap, phase, attempts>>

ForeignWrite(f) ==
  /\ f \in Neighbors
  /\ writes < MaxWrites
  /\ \E v \in {"1", "2"} : pending' = [pending EXCEPT ![f] = v]
  /\ writes' = writes + 1
  /\ UNCHANGED <<staged, foreign, head, ours, snap, phase, attempts>>

\* Чужой коммит: HEAD сдвинулся на блоб соседа. Наш снимок остаётся старым.
ForeignCommit(f) ==
  /\ f \in Neighbors
  /\ pending[f] # "none"
  /\ head' = [head EXCEPT ![f] = pending[f]]
  /\ foreign' = [foreign EXCEPT ![f] = pending[f]]
  /\ pending' = [pending EXCEPT ![f] = "none"]
  /\ UNCHANGED <<staged, ours, snap, phase, attempts, writes>>

\* Снимок HEAD: копия общего индекса, `read-tree --reset`. Дерево собирается из него.
Snapshot ==
  /\ phase = "idle"
  /\ snap' = head
  /\ attempts' = 1
  /\ phase' = "snapped"
  /\ UNCHANGED <<staged, pending, foreign, head, ours, writes>>

\* Запись HEAD: дерево - снимок, в наших путях - наши блобы. Сравнение со снимком проходит
\* только если HEAD не сдвинулся; мутант пишет поверх любого HEAD.
Store ==
  /\ phase = "snapped"
  /\ (head = snap \/ ~CompareHead)
  /\ head' = [f \in Files |-> IF f \in Ours THEN staged[f] ELSE snap[f]]
  /\ ours' = [f \in Ours |-> staged[f]]
  /\ phase' = "idle"
  /\ UNCHANGED <<staged, pending, foreign, snap, attempts, writes>>

\* HEAD сдвинулся: снимок пересобирается от нового HEAD, дерево - заново.
Retry ==
  /\ phase = "snapped"
  /\ CompareHead
  /\ head # snap
  /\ attempts < MaxAttempts
  /\ snap' = head
  /\ attempts' = attempts + 1
  /\ UNCHANGED <<staged, pending, foreign, head, ours, phase, writes>>

\* Повторы кончились: правка не закоммичена, HEAD не тронут, причина уходит в журнал.
GiveUp ==
  /\ phase = "snapped"
  /\ CompareHead
  /\ head # snap
  /\ attempts >= MaxAttempts
  /\ phase' = "idle"
  /\ UNCHANGED <<staged, pending, foreign, head, ours, snap, attempts, writes>>

Next ==
  \/ \E f \in Ours : Stage(f)
  \/ \E f \in Neighbors : ForeignWrite(f) \/ ForeignCommit(f)
  \/ Snapshot \/ Store \/ Retry \/ GiveUp

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ staged \in [Ours -> Contents]
  /\ pending \in [Neighbors -> Contents \cup {"none"}]
  /\ foreign \in [Neighbors -> Contents \cup {"none"}]
  /\ head \in [Files -> Contents]
  /\ ours \in [Ours -> Contents \cup {"none"}]
  /\ snap \in [Files -> Contents \cup {"none"}]
  /\ phase \in {"idle", "snapped"}
  /\ attempts \in 0..MaxAttempts
  /\ writes \in 0..MaxWrites

\* (1) Чужой коммит соседнего файла не откатывается: HEAD держит то, что сосед закоммитил.
ForeignKept == \A f \in Neighbors : foreign[f] = "none" \/ head[f] = foreign[f]

\* (2) Наша правка доезжает: наш блоб, ушедший в коммит, HEAD и держит.
OursStored == \A f \in Ours : ours[f] = "none" \/ head[f] = ours[f]

====
