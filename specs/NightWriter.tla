---- MODULE NightWriter ----
\* Писатель ночи (ADR-0016, Дополнение 2 п.4): ответ модели сохраняется в кэш дня до
\* записи; запись — замена раздела целиком, если хеш файла равен хешу при чтении для
\* вызова; иначе ничего не пишется, ответ стирается из кэша, Card получает truth_pending
\* и вызов повторяется следующей ночью. Каждая запись атомарна и коммитится; день готов
\* только после коммита. Обрыв (kill -9) возможен на любом шаге применения.
EXTENDS Naturals

CONSTANTS MaxDays, RecheckAfterSave, HumanPublishStable, RememberSummaryHash, RememberWrittenSummaryHash, CompareRecomputedSummary, SummaryFileFirst

VARIABLES phase, file, answer, committed, calls, lost, queue, human, pending, crashedOnce

VARIABLES summaryFile, summarySeen, summaryExpected, summaryPhase, summaryHuman, summaryNight, summaryWritten, summaryOutput, summaryHasResult

cardVars == <<phase, file, answer, committed, calls, lost, queue, human, pending, crashedOnce>>
summaryVars == <<summaryFile, summarySeen, summaryExpected, summaryPhase, summaryHuman, summaryNight, summaryWritten, summaryOutput, summaryHasResult>>
vars == <<cardVars, summaryVars>>

Init ==
  /\ phase = "idle"
  /\ file = "old"
  /\ answer = FALSE
  /\ committed = FALSE
  /\ calls = 0
  /\ lost = 0
  /\ queue = MaxDays
  /\ human = FALSE
  /\ pending = FALSE
  /\ crashedOnce = FALSE
  /\ summaryFile \in {"absent", "old"}
  /\ summarySeen = summaryFile /\ summaryExpected = summaryFile
  \* A closed legacy cache has no publication hash. completedAt remembers its
  \* publication independently of the current file mtime (ADR-0002).
  /\ summaryNight \in {1, 2}
  /\ summaryPhase = IF summaryNight = 2 THEN "done" ELSE "idle"
  /\ summaryHuman = FALSE /\ summaryHasResult = (summaryNight = 2)
  /\ summaryWritten = "absent" /\ summaryOutput = "new"

Keep(v) == UNCHANGED <<v, summaryVars>>

\* A day pass stores the summary snapshot before asking the model.
OpenSummaryPass ==
  /\ summaryPhase = "idle"
  /\ summaryPhase' = "open"
  /\ summarySeen' = summaryFile /\ summaryExpected' = summaryFile
  /\ UNCHANGED <<cardVars, summaryFile, summaryHuman, summaryNight, summaryWritten, summaryOutput, summaryHasResult>>

EditSummary ==
  /\ summaryPhase \in {"idle", "open", "prepared", "published", "done"} /\ ~summaryHuman
  /\ (summaryPhase # "prepared" \/ ~HumanPublishStable)
  /\ (summaryPhase # "idle" \/ summaryNight > 1)
  /\ summaryFile' = "human" /\ summaryHuman' = TRUE
  /\ UNCHANGED <<cardVars, summarySeen, summaryExpected, summaryPhase, summaryNight, summaryWritten, summaryOutput, summaryHasResult>>

\* Two durable writes, with a restart possible between them.
\* SummaryFileFirst = FALSE is the old hash-before-file ordering mutant.
PublishSummary ==
  /\ summaryPhase = "open"
  /\ LET seen == IF RememberSummaryHash THEN summarySeen ELSE summaryExpected
         expected == IF RememberWrittenSummaryHash /\ summaryWritten # "absent"
                        /\ ~CompareRecomputedSummary THEN summaryWritten ELSE seen
         conflict == summaryFile # summaryOutput /\
                       ((RememberWrittenSummaryHash /\ summaryWritten = "absent"
                          /\ summaryHasResult /\ summaryFile # "absent")
                         \/ summaryFile # expected)
     IN /\ summaryPhase' = IF conflict THEN "waiting" ELSE "prepared"
        /\ summaryFile' = IF conflict \/ ~SummaryFileFirst THEN summaryFile ELSE summaryOutput
        /\ summaryWritten' = IF conflict \/ SummaryFileFirst \/ ~RememberWrittenSummaryHash
                                THEN summaryWritten ELSE summaryOutput
  /\ UNCHANGED <<cardVars, summarySeen, summaryExpected, summaryHuman, summaryNight, summaryOutput, summaryHasResult>>

CacheSummaryHash ==
  /\ summaryPhase = "prepared" /\ summaryPhase' = "published"
  /\ summaryFile' = IF SummaryFileFirst THEN summaryFile ELSE summaryOutput
  /\ summaryWritten' = IF SummaryFileFirst /\ RememberWrittenSummaryHash
                          THEN summaryOutput ELSE summaryWritten
  /\ UNCHANGED <<cardVars, summarySeen, summaryExpected, summaryHuman, summaryNight, summaryOutput, summaryHasResult>>

CommitSummary ==
  /\ summaryPhase = "published" /\ summaryPhase' = "done"
  /\ UNCHANGED <<cardVars, summaryFile, summarySeen, summaryExpected, summaryHuman, summaryNight, summaryWritten, summaryOutput, summaryHasResult>>

\* Publication followed by interruption or refused commit; the input may change.
\* A closed day may also acquire a late entry, opening another pass after an owner edit.
NextSummaryNight ==
  /\ summaryPhase \in {"waiting", "prepared", "published", "done"} /\ summaryNight < 3
  /\ summaryHasResult' = (summaryHasResult \/ (summaryPhase = "done"))
  /\ summaryNight' = summaryNight + 1
  /\ summaryPhase' = IF summaryPhase = "done" THEN "idle" ELSE "open"
  \* A new pass has a different input_hash; an interrupted pass may retain its output.
  /\ summaryOutput' \in IF summaryPhase = "done"
        THEN {IF summaryOutput = "new" THEN "changed" ELSE "later"}
        ELSE {summaryOutput, IF summaryNight = 1 THEN "changed" ELSE "later"}
  /\ summaryExpected' = summaryFile
  /\ UNCHANGED <<cardVars, summaryFile, summarySeen, summaryHuman, summaryWritten>>

\* Платный вызов модели: только когда ответа в кэше нет.
Call ==
  /\ phase = "idle" /\ queue > 0 /\ ~answer
  /\ phase' = "called" /\ calls' = calls + 1
  /\ Keep(<<file, answer, committed, lost, queue, human, pending, crashedOnce>>)

SaveAnswer ==
  /\ phase = "called"
  /\ phase' = "cached" /\ answer' = TRUE
  /\ Keep(<<file, committed, calls, lost, queue, human, pending, crashedOnce>>)

\* Владелец правит Card, пока ночь ждёт ответа или держит его в кэше.
HumanEdit ==
  /\ phase \in {"called", "cached", "checked", "saved", "rechecked"} /\ file = "old"
  /\ (phase # "rechecked" \/ ~HumanPublishStable)
  /\ file' = "human" /\ human' = TRUE
  /\ Keep(<<phase, answer, committed, calls, lost, queue, pending, crashedOnce>>)

\* First CAS read; run.save() publishes the cache before Card publication.
Check ==
  /\ phase = "cached" /\ file = "old"
  /\ phase' = "checked"
  /\ Keep(<<file, answer, committed, calls, lost, queue, human, pending, crashedOnce>>)
SavePost ==
  /\ phase = "checked"
  /\ phase' = "saved"
  /\ Keep(<<file, answer, committed, calls, lost, queue, human, pending, crashedOnce>>)
Recheck ==
  /\ phase = "saved"
  /\ phase' = IF RecheckAfterSave /\ file = "human" THEN "cached" ELSE "rechecked"
  /\ Keep(<<file, answer, committed, calls, lost, queue, human, pending, crashedOnce>>)
\* Explicit filesystem assumption: the owner keeps the destination stable from the
\* final reread through atomic rename. Cooperating Iva writers also share Card lock.
\* With HumanPublishStable = FALSE the residual direct-edit window has a witness.
Replace ==
  /\ phase = "rechecked"
  /\ phase' = "written" /\ file' = "new"
  /\ Keep(<<answer, committed, calls, lost, queue, human, pending, crashedOnce>>)

\* Хеш не совпал: запись не идёт, сам ответ стёрт, но кэш помнит, что Card в этом
\* проходе решена (done); Card получает truth_pending, вызов — следующей ночью.
Conflict ==
  /\ phase = "cached" /\ file = "human"
  /\ phase' = "written" /\ pending' = TRUE
  /\ Keep(<<file, answer, committed, calls, lost, queue, human, crashedOnce>>)

\* Повтор после обрыва: файл уже новый (хеш post) — применять нечего.
Resume ==
  /\ phase = "cached" /\ file = "new"
  /\ phase' = "written"
  /\ Keep(<<file, answer, committed, calls, lost, queue, human, pending, crashedOnce>>)

Commit ==
  /\ phase = "written"
  /\ phase' = "committed" /\ committed' = TRUE
  /\ Keep(<<file, answer, calls, lost, queue, human, pending, crashedOnce>>)

Ready ==
  /\ phase = "committed"
  /\ phase' = "done"
  /\ Keep(<<file, answer, committed, calls, lost, queue, human, pending, crashedOnce>>)

NextDay ==
  /\ phase = "done"
  /\ phase' = "idle" /\ file' = "old" /\ answer' = FALSE /\ committed' = FALSE
  /\ calls' = 0 /\ lost' = 0 /\ queue' = queue - 1 /\ human' = FALSE /\ pending' = FALSE
  /\ Keep(crashedOnce)

\* kill -9 на любом шаге до готовности.
Crash ==
  /\ ~crashedOnce /\ phase \in {"called", "cached", "checked", "saved", "rechecked", "written", "committed"}
  /\ phase' = "crashed" /\ crashedOnce' = TRUE
  /\ lost' = IF phase = "called" THEN 1 ELSE lost
  /\ Keep(<<file, answer, committed, calls, queue, human, pending>>)

\* Перезапуск: незакоммиченное коммитится первым делом; ответ из кэша не зовёт модель.
Restart ==
  /\ phase = "crashed"
  /\ phase' = IF file = "new" /\ ~committed THEN "written"
              ELSE IF answer THEN "cached" ELSE "idle"
  /\ Keep(<<file, answer, committed, calls, lost, queue, human, pending, crashedOnce>>)

Done == queue = 0 /\ UNCHANGED vars

Next ==
  \/ Call \/ SaveAnswer \/ HumanEdit \/ Check \/ SavePost \/ Recheck \/ Replace \/ Conflict \/ Resume
  \/ OpenSummaryPass \/ EditSummary \/ PublishSummary \/ CacheSummaryHash \/ CommitSummary \/ NextSummaryNight
  \/ Commit \/ Ready \/ NextDay \/ Crash \/ Restart \/ Done

Spec == Init /\ [][Next]_vars
  /\ WF_vars(Call) /\ WF_vars(SaveAnswer) /\ WF_vars(Replace) /\ WF_vars(Conflict)
  /\ WF_vars(Check) /\ WF_vars(SavePost) /\ WF_vars(Recheck)
  /\ WF_vars(Resume) /\ WF_vars(Commit) /\ WF_vars(Ready) /\ WF_vars(NextDay)
  /\ WF_vars(Restart)

TypeOK ==
  /\ summaryFile \in {"absent", "old", "human", "new", "changed", "later"}
  /\ summarySeen \in {"absent", "old", "human", "new", "changed", "later"}
  /\ summaryExpected \in {"absent", "old", "human", "new", "changed", "later"}
  /\ summaryPhase \in {"idle", "open", "waiting", "prepared", "published", "done"}
  /\ summaryWritten \in {"absent", "new", "changed", "later"} /\ summaryOutput \in {"new", "changed", "later"}
  /\ summaryHuman \in BOOLEAN /\ summaryNight \in 1..3
  /\ summaryHasResult \in BOOLEAN
  /\ phase \in {"idle", "called", "cached", "checked", "saved", "rechecked", "written", "committed", "done", "crashed"}
  /\ file \in {"old", "new", "human"}
  /\ answer \in BOOLEAN /\ committed \in BOOLEAN /\ human \in BOOLEAN
  /\ pending \in BOOLEAN /\ crashedOnce \in BOOLEAN
  /\ calls \in 0..2 /\ lost \in 0..1 /\ queue \in 0..MaxDays

\* (1) Файл не бывает частичным: старый, новый или правка человека.
FileNeverPartial == file \in {"old", "new", "human"}
\* Готовность дня — только после коммита.
ReadyOnlyAfterCommit == phase = "done" => committed
\* (3) Правка человека не перетирается.
HumanEditWins == (human => file = "human") /\ (summaryHuman => summaryFile = "human")
\* A cached publication hash with its original file is our interrupted write.
PendingSummaryResumes == summaryPhase = "waiting" =>
  ~(summaryWritten = summaryOutput /\ summaryFile = summarySeen)
PublishedSummaryResumes == summaryPhase = "waiting" => summaryFile # summaryWritten
\* (2), (4) Повтор ночи не зовёт модель второй раз: лишний вызов — только если обрыв
\* случился во время самого вызова, до сохранения ответа.
NoSecondCall == calls <= 1 + lost
\* Живость: без падений очередь дней доходит до пустой.
QueueDrains == <>(queue = 0)

====
