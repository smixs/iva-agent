# TLA+ models

The repository keeps bounded models of the lock, the night writer, restart recovery, proactive notices, plugin proposals, idle compaction, the tap on a model's button and the drain of the Bridge queue in batches. Run them from a temporary directory because TLC writes state files beside the model.

## FileLock

`FileLock.tla` models the directory lock, owner token, heartbeat, stale takeover, crashes and bounded event-loop delay. The configurations vary process count, stale interval, deadline and synchronous holders:

- `FileLock.cfg`
- `FileLock-2p.cfg`
- `FileLock-deadline.cfg`
- `FileLock-hold.cfg`
- `FileLock-lag.cfg`
- `FileLock-slow.cfg`
- `FileLock-sync-slow.cfg`
- `FileLock-witness.cfg`

Example:

```sh
d=$(mktemp -d)
cp specs/FileLock.tla specs/FileLock.cfg "$d"/
(cd "$d" && tlc -workers 2 -deadlock -config FileLock.cfg FileLock.tla)
```

The model assumes that a live asynchronous holder's event loop runs often enough to refresh the lock before the stale threshold. A fully stopped process can still lose the lock after that threshold. Filesystem errors and unknown directory members are outside the model and covered by executable tests.

## NightWriter

`NightWriter.tla` models one writer under the memory lock: a model call whose answer is cached before any write, a whole-section replacement guarded by the file hash read for the call, an owner edit racing the night, commit-gated readiness, a crash at any step and restart, and an ordered queue of days. On a hash mismatch nothing is written, the answer is dropped, the Card gets `truth_pending` and the day still closes; the call repeats next night.

`Check`, `SavePost`, `Recheck` and `Replace` are separate steps. The night rereads the Card after saving its answer to the day cache. Cooperating Iva writers share the Card lock; a direct owner save can occur between filesystem operations. `HumanPublishStable` explicitly assumes a stable file from the final reread through the atomic rename. With that assumption disabled, `NightWriter-publish-window.cfg` demonstrates the remaining direct-edit window; `NightWriter-save-window.cfg` demonstrates publication without the reread. `night-writer-check.sh` checks those witnesses and the positive `NightWriter.cfg`. Card drafts, pending facts, daily summaries and periods have separate executable tests.

```sh
d=$(mktemp -d)
cp specs/NightWriter.tla specs/NightWriter.cfg "$d"/
(cd "$d" && tlc -workers 2 -config NightWriter.cfg NightWriter.tla)
```

Checked invariants:

1. `FileNeverPartial`: the visible file is always one complete old, new or owner version.
2. `ReadyOnlyAfterCommit`: a ready day has passed the commit state.
3. `HumanEditWins`: an observed owner edit is not overwritten by the night.
4. `NoSecondCall`: a restart reuses the cached answer; a second paid call happens only when the crash hit the call itself.
5. `QueueDrains`: with the stated fairness assumptions, the bounded queue reaches zero.

Mutants that must fail: the hash check removed (`HumanEditWins`), restart without the cache (`NoSecondCall`), readiness without a commit (`ReadyOnlyAfterCommit`). After a restart an uncommitted new file is committed first, before any call — the production contract of the night's opening sweep.

## UpdateLock

`UpdateLock.tla` separates abandoned-owner inspection, rename, owner comparison,
restoration, mkdir and publication. `UpdateLock.cfg` and `UpdateLock-ownerless.cfg`
check two new contenders with recorded and missing owners. The ownerless model
distinguishes an old empty directory from the fresh `mkdir → owner.json` publication
window; `UpdateLock-ownerless-unsafe.cfg` shows two holders when null contents are
accepted without checking freshness. `UpdateLock-by-path.cfg`, `UpdateLock-mixed.cfg`
and `UpdateLock-three.cfg` retain witnesses for path deletion, legacy contenders
and a third contender in the restore window. Run `sh specs/update-lock-check.sh`.
Actual milliseconds, process liveness and crashes during displacement are covered
by executable tests and the accepted residual windows in `docs/tech-debt.md` §18.

## UpdateFloor

`UpdateFloor.tla` models one installation and a tree that names the oldest release an update is taken from (`minUpdater` in `update-compat.json`). The updater already on disk is one of three classes: from 0.3.30 it reads the marker before its first write; 0.3.15 to 0.3.29 unpack the new tree and hand off to its new half without knowing the marker; 0.3.7 to 0.3.14 build a candidate of the new tree beside the checkout, where `npm ci` is the first code of the new tree to run. An update aims at the newest release, or at the step release while `repair.sh` has the Update branch pinned to it: the last release that takes an update from every release below the floor. Once the new tree serves, it meets one file that only releases below the floor wrote and one that a release at the floor or above wrote, and two forms the step release reads but turns over only lazily, when its Bridge starts or a chat first writes: "kept" the new code reads itself (the reminder table of schema 1), "turned" it refuses by name, so repair runs the step release's own conversion of it before the next update (the queue of strings, the shared `run-status.json`). The step is a tag on origin: its branch exists only for the update repair runs, so no other update aims at it.

`update-floor-check.sh` checks `UpdateFloor.cfg` and eleven mutants:

- `StaysOnItsRelease`: the new release is put in place only by an updater at the floor or above, so an installation below the floor reaches it through the step release alone. `UpdateFloor-no-finish-check.cfg` drops the check in the new half and a CLI that does not read the marker lands on the new tree; `UpdateFloor-no-install-check.cfg` drops the check in `npm ci` and an in-place updater does.
- `NothingWritten`: a CLI that reads the marker stops before it unpacks anything, and an in-place updater has removed its candidate by the time it reports. `UpdateFloor-late-check.cfg` moves the marker check after the unpack.
- `OnlyTheVersionDirectory`: 0.3.15 to 0.3.29 are refused after the unpack, so the unpacked version directory is the one thing written and what serves is what served. `UpdateFloor-finish-after-stop.cfg` moves the new half's check after services are stopped.
- `RefusedIsTold`: a refusal names the release and the way out (`UpdateFloor-mute.cfg`).
- `NoSilentLoss`: a file only releases below the floor wrote is refused by name or left as it was (`UpdateFloor-silent-drop.cfg`).
- `SupportedIsServed`: a file a release at the floor or above wrote is read and served as before; moving its record out of the working file is a violation (`UpdateFloor-quarantine.cfg`). No lazy form is refused: `UpdateFloor-lazy-unread.cfg` takes the reader of "kept" out of the new code, `UpdateFloor-lazy-unturned.cfg` takes the step's conversion of "turned" out of repair.
- `BranchKept`: `repair.sh` records the owner's Update branch before it pins the step release, and the branch is back once repair is over, killed in between or not (`UpdateFloor-no-saved-branch.cfg`).
- `Served`: at the floor and above the update ends on the new release.
- `Repaired`: repair, killed once between its two updates or not, ends on the new release with the owner's branch back. `UpdateFloor-no-step.cfg` runs the installed updater straight at the newest release and it is refused for good.

Outside the model: the updater of 0.3.0 to 0.3.6, which moves the checkout and replaces `node_modules` before any code of the new tree runs; a failed fetch or build, which is the updater's own rollback; a kill in the middle of one update; that the step's own tree has its dependencies before its CLI runs on a checkout (`repair.sh` stops before the first update when its `npm ci` fails); that the step exists on origin, which `repair.sh` takes from the tag `v<step>`. `scripts/repair-shell.test.ts` covers these with an origin that has the tag and no branch, a checkout with the dependencies of its own lock, and repair killed before each of its commands.

## RestartRecovery

`RestartRecovery.cfg` checks restart, quarantine, failures, notification and queue
drain; `RestartRecovery-candidate.cfg` retains the earlier blocking behavior.
`RestartRecovery-window.cfg` checks scan, lock acquisition, reread and publication
against Bridge closing a turn or starting a new one. Publication uses the stored
reread snapshot. The chat lock holds `ClosedStaysClosed`; the generation comparison
holds `NewTurnKept` for a new turn started before acquisition.
`RestartRecovery-window-unsafe.cfg` removes the lock and must violate
`ClosedStaysClosed`. Run `sh specs/restart-recovery-check.sh`.
The two-second recovery stale threshold has the same short synchronous-section
assumption as `FileLock`; a stalled live writer exceeding it can lose its lock.

## Proactive

`Proactive.tla` models the half-hourly proactive run before its code exists (`scripts/proactive/tick.ts`): a no-wait lock that expires `staleMs` after it is taken, the state file `data/proactive.json` written whole from the run's memory, the Brief claim and turn, the Insight claim and turn (a run with an Insight ends after it, without Watch), the Watch claim before the turn, delivery and the `wakes` write after it, a crash or a failed write at any step and the runner's deadline. One `Tick` is 8 minutes: a 40-minute `staleMs` gives `Stale = 5`, a run that lives at most `timeoutMs + killGraceMs` (31 min 30 s, at most 4 boundaries) gives `MaxRun = 4`; the run itself cancels a turn at `IVA_JOB_STOP_AT`, and after a Brief that ran past its deadline Watch does not go. A comment in the model maps every action to its future file and function.

Checked invariants:

1. `NoDoubleTake`: a key reaches at most one turn between two growths of its unread count.
2. `OneBriefPerSlot`: one Brief per slot and day.
3. `WakesCapped`: ordinary wakes with a message per day stay within `watchCapPerDay` plus the number of runs lost between delivery and the `wakes` write.
4. `OneRun`: two runs never overlap.
5. `OneInsightPerDay`: at most one Insight turn per owner's day.

The run takes its `now` right after the lock (`NowAfterLock = TRUE`). Witnesses must fail, each on its own invariant first: `Proactive-noclaim.cfg` (claim after the turn, 1), `Proactive-nolock.cfg` (no lock: 4, then 1, then 2), `Proactive-nocap.cfg` (no cap filter, 3), `Proactive-shortstale.cfg` (`staleMs` shorter than a run, 4), `Proactive-nowfirst.cfg` (`now` taken before the lock: a run with an older day overwrites `briefDone` written for a newer day, 2, and without 2 the Insight day, 5), `Proactive-noinsightclaim.cfg` (Insight claim after the turn, 5), `Proactive-dropinsight.cfg` (a Brief or Watch write that drops the `insight` field, 5); without the lock and without 1–4 `Proactive-nolock.cfg` also fails on 5. Every earlier witness line drops `OneInsightPerDay` as well: without the lock or with `now` taken before it, a double Insight is as short as a double Brief and could come out first. The Ceiling of the day (`proactive.ceilingTokensPerDay`) is outside the model like `modelWakesPerDay`: it only drops candidates, and the model already takes any subset of them. The `?` mark and the draft fingerprint of the Insight are outside the model: they do not depend on the order of events and are written under the same lock; property tests cover them. An Insight has no pause (ADR-0022).

```sh
specs/proactive-check.sh
```

## PluginProposal

`PluginProposal.tla` models the life of a plugin proposal (ADR-0009) and was written after the code: it checks the code, not a design. Two identical `iva plugin propose` runs (sweep, claim by rename, utimes, send, removal on a failed send), two taps of the one button in the Bridge (take by rename, age check and the tap time on the taken copy, tree hash check, installer launch or return), the installer (first hash check, copy into its own staging, hash check of the staged copy, install, removal of the taken copy), a second writer changing the files of the proposal or the taken copy, and a crash at every step of every process. One `Tick` is a boundary; a day is `TTL = 2`. The comment in the model maps every action to its function.

The model assumes that a holder of the taken copy (a tap before launch, a live installer) finishes within a day of its tap, and that `renameSync`, the age check and the stamp in `takeProposal` run without an `await` between them, so the other tap of the same Bridge cannot interleave (`BridgeFree`). Without the second assumption TLC finds two taps holding one taken copy: tap A takes an old copy, the sweep removes it, a new proposal and tap B put a fresh copy under the same name, and A stamps it as its own.

Checked invariants:

1. `OneInstaller`: at most one live installer per proposal.
2. `OnlyButtonBytes`: the store receives only bytes whose tree hash is the button's.
3. `SweepSparesTaken`: the sweep never removes a taken copy while a tap or an installer holds it.

Witnesses must fail: `PluginProposal-norename.cfg` (the tap copies the proposal instead of taking it by rename, `OneInstaller`, checked without `SweepSparesTaken`, which breaks at the same depth), `PluginProposal-nostamp.cfg` (the taken copy keeps the propose time, as before the repair, `SweepSparesTaken`), `PluginProposal-nostaged.cfg` (the installer checks only the taken copy and installs its copy unchecked, as before the repair, `OnlyButtonBytes`).

```sh
specs/plugin-proposal-check.sh
```

## DraftStop

`DraftStop.tla` models a private chat's draft stream and native stop. The final
`message.completed` closes the stream before Outbox sends the answer; the core
turn can still be running. A request already in flight can settle during close,
and the final answer waits for it and for a 429 pause. A later callback cannot
schedule another frame after close. New text and the refresh timer request the
latest frame. First rejection disables drafts; three rejections since the last
successful frame do the same. Only success resets the rejection series; a 429
or network timeout preserves the count without increasing it.

Two turns may use the same session. Stop reads the draft id and pair once, then
cancel uses that snapshot even if another turn has started. Duplicate updates
can cancel a core turn only once. Compaction has a null turn id. An additional
initial case supplies an inconsistent persisted compaction record with a positive
draft id to check the null-turn guard independently of the record writer.
Turn completion releases the chat record only when its session and turn still
match. Compaction release checks its session and the compacting flag. Both keep
a record acquired by another owner.

Reset and takeover can change the chat record in another process. Each typing
tick compares status, session, turn and draft id and closes a stale stream.
Restart clears local streams; a resumed core turn can lazily create a fresh
draft through a CAS on its pair. Restart also forgets the old process's 429 pause.
The final answer can receive another 429 after restart; Outbox retries it.
Draft ids are abstract fresh values, so random
collisions and clock durations require implementation tests.

The main BFS configuration checks two turns and one restart. Nine mutants must
violate their named state invariant: missing draft comparison (`StopOwnDraft`),
cancel with a null turn (`StopHasTurn`), a frame after final delivery
(`NoFrameAfterFinal`), a missing record check (`SelfCheckCloses`), resetting the
rejection count on a 429 or timeout (`FailurePolicy`), releasing another owner's
record at turn completion or compaction end (two mutants, `ForeignRecordPreserved`),
retaining a pre-restart pause (`RestartForgetsPause`), and starting an older
turn's frame after a newer final answer (`NoOlderInFlightAfterFinal`). The main
configuration also checks `StopOnce`, `FramesOnlyWhileOpen`, `FinalAfterClose`
and `TypeOK`. `NoOlderInFlightAfterFinal` checks the whole chat: after a turn's
final answer, requests from earlier turns must have settled. It also covers
earlier turns in another session, and retains that requirement after the chat
record changes. A cancelled turn's request surviving into the next turn's final
answer violates this invariant even when both per-turn final invariants hold.
Final delivery drains its own turn and every closed stream still known in the
same chat. A cancelled stream stays known until its request settles, while the
cancellation handler keeps its two-second wait limit. Other open turns retain
their streams. The earlier per-turn-only guard has a recorded counterexample
to `NoOlderInFlightAfterFinal`.
Frame closure forbids new requests; an earlier in-flight request
can still finish before the final answer. HTTP wire shapes, redaction, authorization
parsing, real timer deadlines and the live Telegram client have separate checks.

```sh
LOG_DIR="$PWD/.scratch/draft-stop-results" specs/draft-stop-check.sh
```

## IdleCompaction

`IdleCompaction.tla` models the compaction between turns (ADR-0021) and was written after the code: it checks the code, not a design. One eve session in one chat: the bridge (routing under queue or steer, replies to bot messages, the disk queue, the drain, the reaper), the chat status record, the process memory of `agent/lib/idle-compaction.ts` (with the open ask `reclaim`), eve's input buffer, control queue and current action, the compact POST that the `session.waiting` handler awaits with its outcomes (accepted, refused, unknown, accepted after the client's timeout), the `compaction.requested` hook that claims the chat again, `/stop` and steer aborts in eve's order (parking, `turn.cancelled`, parking), and a restart with the ExecStartPre quarantine. The comment in the model maps every action to its function and lists the assumptions about eve (facts Ф3–Ф13 of the spec).

Checked on the code with a late compact request allowed, queue and steer (`IdleCompaction.cfg`, `-steer`): every invariant of spec section 7 (`QueuedWhileCompacting`, `CompactionGuarded`, `TurnRecordKept`, `NoFalseInterruptNotice`, `NoCancelMarkForCompaction`, `CompactingNeverInTurn`, `OffOnlyAfterUselessCompaction`, `AtMostOneAskPerTurn`, `NoStackedCompaction`, `NoAskOverCompactingRecord`, `NoAskWhileOff`) and the liveness `NoLostMessage` and `ChatFreed`. With a restart (`-restart`, `-restart-steer`) the safety invariants and `NoHangAfterRestart` hold, except `CompactionGuarded` and `QueuedWhileCompacting` (F7, `-restart-guarded`): a late request queued in eve survives the restart while the process memory does not. The proposed repair `BeginAnyIdle` (R5, a model switch, not code) makes `-r5` and `-r5-steer` pass every safety invariant. The drain hands eve the queued messages as one batch, and a message waits behind a non-empty queue under steer too (route R1 of `.scratch/work/wave-1010/l5/spec-v2.md`).

Findings that must fail: the window between the start of a late compaction and its hook (`-window`: `QueuedInRequestWindow`; `-window-restart`: `NoHangInRequestWindow`, F6); a message already in eve's input lost without a notice by a restart mid-compaction (`-silentloss`) and waiting in that input (`-inbox`); a compaction longer than `RUN_STALE_MS` reaped while a buffered turn runs without a record (`-turnhang`, outside the feature).

Witnesses must fail: `-offfail` (R3 off: `OffOnlyAfterUselessCompaction`), `-nobeginclaim` (no claim on `compaction.requested`: `CompactionGuarded`), `-noaskguard` (a second ask while one is open: `NoStackedCompaction`), `-releasebysession` (on the base without the await: `TurnRecordKept`), `-noclaim` (`QueuedWhileCompacting`), `-noopenguard` (`OffOnlyAfterUselessCompaction`), `-noisyreap` (`NoFalseInterruptNotice`), `-turnkeeps` (`CompactingNeverInTurn`), `-dueagain` (`AtMostOneAskPerTurn`), `-offnotchecked` (`NoAskWhileOff`), `-repliesdirect` (`QueuedWhileCompacting`), `-noreap` (`ChatFreed`). `-void` (no await) and `-noparkrelease` pass: the hook's claim covers the first, the reaper the second.

The draft/stop change retires the queued status message. This model retains queue ownership, buffered input, compaction and recovery; `DraftStop.tla` covers the new stream lifecycle.

```sh
specs/idle-compaction-check.sh
```

## ButtonTap

`ButtonTap.tla` models the Bridge's answer to a tap on a model's button (ADR-0015) and was written before the code (`scripts/poller/control.ts`): one button of one message, taps that arrive as updates with new `update_id`s, the in-process memory of taps (button key to the `update_id` that became a message), the edit that marks the button in flight, landing or failing, admission to the queue with the outcomes `owned` and `write-failed` (Telegram hands the same update out again), and restarts of the Bridge that empty the memory. A tap on an already marked button is allowed: that clients refuse a tap on a `disabled` button is not proven, so only the memory guards against a second message.

Checked invariants:

1. `NoSwallow`: the button is not marked, and no edit is in flight, without a tap that is in the queue or still to be handled.
2. `OnePerProcess`: while the Bridge lives, one button gives at most one message.

Witnesses must fail: `ButtonTap-keyonly.cfg` (a repeat is judged by the key alone, without the `update_id`: the same update handed out again after `write-failed` is dropped, `NoSwallow`), `ButtonTap-nomemory.cfg` (no memory: every tap becomes a message, `OnePerProcess`).

```sh
specs/button-tap-check.sh
```

## QueueDrain

`QueueDrain.tla` models the drain of the Bridge queue in batches (spec `.scratch/work/wave-1010/l5/spec-v2.md`, section 7) and was written before the code: it checks the design. One chat, two authors, messages that join a batch (`plain`) or go alone (`alone`: a command, a reply, a tap on a model's button, a message without `from`); the inbox of each author with routing and the removal from the inbox as separate steps; routing to the queue or a direct delivery, with route R1 (`QueueFirst`: while the chat's queue is not empty a message waits behind it under steer too) and, with `Replies`, an `alone` message that may skip the queue as a reply to the bot; the drain (a batch pinned until its removal, else `queueBatchLength`), a delivery whose id is the last item of the batch, removal of the batch with one write; eve's ledger of delivery ids that began a turn (`handled` for a known id) and the loss of an id from it; a delivery accepted after the Bridge's deadline; a busy chat (a turn or a compaction); `queueInFlight`; the owner switching between queue and steer; a Bridge restart. `Loop = "seq"` follows the code's main loop (inbox promotion, then a drain pass); `Loop = "any"` lets routing land between any steps of the drain, wider than the code. The inbox collector, limits in parts and characters (`MaxItems` items instead), `/new` with `clearChatQueue`, `closed-session`, negative ids without a ledger and time are outside the model. Ids are compared only for equality, so numbering them in arrival order loses nothing; the authors are symmetric, so the first message comes from `a`.

Checked invariants:

1. `NoLoss`: every message that arrived is in an inbox, in the queue or was in at least one turn.
2. `NoDupBeyondBreak`: a message is in two turns only when a restart cut its delivery (a batch in flight or pinned, a routing not yet removed from the inbox), its direct delivery ended for the Bridge without an answer while eve began the turn, or the ledger lost the id of a delivery that carried it.
3. `QueueOrder`: first appearances of messages that came to a turn from the queue follow their first enqueue order.
4. `WholeBatch`: a batch chosen without a pin is a prefix of the queue, allowed and maximal.
5. `AloneStaysAlone`: a turn from the queue with an `alone` message holds only that message.
6. `BatchAtHead` and `PinAtHead`: the batch in flight and the pin stand whole at the head of the queue, so `removeQueueItems` never meets a batch off the head and a partial pin never happens.

The design of spec v2 passes every invariant with routing between any steps of the drain, a late acceptance, replies that skip the queue, a restart and two switches of the policy, starting under queue (`QueueDrain.cfg`) and under steer (`-steer`), and with a lost ledger id (`-ledgerloss`). Without R1 the drain loses a message (finding F1, `-switch` and `-switch-norestart`, in the code's order): after the owner switches queue to steer while messages wait, a direct delivery overtakes the queue and puts its id into the ledger; a later batch that ends with this id gets `handled`, and the message before it in the batch is lost. A reply to the bot overtakes the queue under R1 too, but it always goes alone, so its id is never the last id of a batch of several items.

Witnesses must fail: `-staleack` (the removal writes the snapshot of the pass without the batch, `NoLoss`), `-nopin` (no pin: a batch accepted after the deadline is counted again with a new last id, `NoDupBeyondBreak`), `-anysender` (batches of any authors, `NoLoss`), `-mergealone` (`alone` joins a batch, `AloneStaysAlone`), `-switch` and `-switch-norestart` (no R1, `NoLoss`).

```sh
specs/queue-drain-check.sh
```

## LaunchdUnit

`LaunchdUnit.tla` models the units of Iva under launchd on macOS (spec `.scratch/macos-install/spec.md` v3, sections 3.1, 3.3 and 7) and was written before the code: it checks the design of the seam that maps `systemctl --user` verbs to `launchctl`. Two labels: a KeepAlive service (`Restart=always`, for example the userbot) and a oneshot with a calendar, where `iva-brain.timer` and `iva-brain.service` share one label `app.iva.iva-brain`. A label is `unloaded`, `idle`, `running`, `throttled` or `stopping` (`state = SIGTERMed`: `bootout` and `kill` are asynchronous, `bootout` returns 0 while the process still exits, and `bootstrap` in this window gives 5 while `print` still shows the job, so the label vanishes afterwards), has the `enabled` flag and a `stale` flag for a plist rewritten after the last `bootstrap` (launchd reads the plist only there). launchd itself crashes and respawns the KeepAlive process (`throttleExpire` and `processExit` are weakly fair), fires the calendar, bootstraps every plist at login and boots everything out at logout. Writers: `stop`, `start`, `restart`, `enable --now`, `disable --now`, `is-active`, cancel and start of the night from the menu, `restart` of a plugin timer, and the update path `captureOptionalWriterState` + `stopWriterUnits`, a body that may change `enabled`, and `restoreOptionalWriterState` one unit name per step. Writers and launchd events other than `throttleExpire` do not interleave with the update; plists are always present; process exit codes, `SuccessfulExit`, the launcher's process group and the 10 s wait are abstracted.

Choices that spec v3 leaves open or sets otherwise are constants; `LaunchdUnit.cfg` takes the choice under which everything holds: `stop` of a `.timer` is `bootout`, `kill` of an unloaded label (113) is success, `is-active` of a throttled KeepAlive unit answers `activating`, `restart` of a loaded unit is `bootout` + `bootstrap`, and `stop` and `restart` wait for the exit (113 from `print`, no pid for a oneshot) before they return (spec v3.3). Logout is atomic: without the `gui/<uid>` domain no writer runs.

Checked invariants: `NoSelfStart` (after `stop` a KeepAlive unit does not come up by itself until `start`/`restart`/`bootstrap`), `ActiveOnlyRunning` (`active` only at `running`), `RestoreExact` (restore ends with the captured `enabled`/`active` or an error), `CalendarKept` (cancelling the night keeps the calendar loaded), `QuiesceStops`, `KeepAliveSurvivesUpdate`, `RestartLoadsPlist`, `TimerVerbNoRun`, `RestartWorks` (after `restart` an enabled label works), `WritersStopped` (between stop and restore no writer runs or exits), and the property `CrashRecovers` (after a crash the KeepAlive unit returns to `running` or is unloaded).

Witnesses must fail: `-stop-kill` (`NoSelfStart`), `-active-loaded` (`ActiveOnlyRunning`), `-oneshot-bootout` (`CalendarKept`), `-kill-unloaded` and `-stop-timer-kill` (`QuiesceStops`), `-throttled-inactive` (`KeepAliveSurvivesUpdate`), `-restart-kickstart` (`RestartLoadsPlist`), `-timer-restart-kickstart` (`TimerVerbNoRun`), `-restart-nowait` (`RestartWorks`), `-stop-nowait` (`QuiesceStops`), `-nokeepalive` (`CrashRecovers`).

```sh
specs/launchd-unit-check.sh
```

## Helpers

`HelperRun.tla` описывает узел конца по v7.3 §2 и §7: один писатель исхода —
минутный тик, durable-события ядра — среда. `cancel` доставляет команду и
сохраняет возможность продолжения ядра. `resetQueued` обозначает cancel/reset по известному id после
исхода; успех reset для finalize не требуется.

Граф состоит из claim, HTTP create, T3, событий ядра, смены owner/карантина,
close и последовательного прохода тика. Окончательный отказ HTTP даёт failed;
сеть/срок после отправки оставляет lost-id. Отказ T3 отправляет отмену и уборку
по известному локально id, затем делает failed по CAS. Конечный снимок либо
ошибка/срок/мусор/404 — отдельные ответы среды. Тик сначала использует первое
терминальное событие; затем смену owner с подтверждённой доставкой отмены либо
неизвестным id; затем безусловную границу часов. Только продолжающаяся строка
до этой границы получает новый stop по объёму/сроку. При записанном stop отмена
отправляется и при ошибке чтения снимка. Первый конец фиксирует исход, а текст
и usage сворачиваются из всего снимка, включая события после первого конца.

`Claim` разрешён в начальную минуту; время относительно firedAt нормализовано:
deadline=2, grace=1. `TickStart` фиксирует строки прохода, `TickRow` исполняет
одну строку, `TickDone` публикует завершённую минуту. Clock допускает следующий
проход после текущего. `BoundedEnd` требует исход у каждого claim после первого
завершённого прохода на deadline+grace; это Ф16 «граница + минута + один проход»,
а не безусловное eventual завершение ядра. Отдельное `NoSilentEnd` проверяется
под справедливостью Clock и действий тика помощников, независимо от хода напоминания.
`reminderBusy = TRUE` остаётся во всех состояниях: задача напоминаний может
ожидать бесконечно, а тик помощников в `agent/schedules/reminders.ts` стартует
отдельным шагом, вне ожидания напоминаний, и продолжает исполняться. `shared-schedule` возвращает ожидание напоминания
и нарушает `NoSilentEnd` даже со справедливостью доступных действий. Справедливость End, успешного снимка,
доставки cancel, reset или появления событий не предполагается.

`TickRow` атомарно абстрагирует конечную последовательность HTTP-вызовов:
каждый возвращает ответ или достигает HELPER_CHECK_MS.
Перекрытие трёх тиков, гонку тика с перезапуском и замок/CAS проверяют тесты
`agent/lib/helper-tick.test.ts`; модель представляет последовательные проходы.
Реальные 15 секунд и порядок отдельных awaits относятся к проверкам реализации.
Предел трёх одновременно идущих помощников относится к строкам таблицы:
`RunningBounded` считает `run`. `HelperRun-capacity3` перебирает claim четырёх
кандидатов, `capacity3-reach` достигает трёх, `no-running-cap` допускает четвёртого
и нарушает предел. Остальные конфигурации проверяют жизненный цикл.
`HelperOutcome-slots` моделирует заполненную таблицу из двух сохранённых строк
и резерв для goal; число одновременно идущих ходов в её переходах отсутствует.
В `GoalCheck` claim использует тот же предел 3; `MaxOpen=3` ограничивает сумму
ожидающих и идущих строк и сохраняет место для помощника владельца. Durable work после interrupted/границы/lost-id — принятое следствие;
`NoDetachedWork` даёт ожидаемый красный свидетель на обычной модели.

Свойства `HelperRun` читают состояние и независимую историю входов CAS:
`OutcomeOnce` — число commits; `StopOnce` — первый stop в журнале просьб;
`OutcomeJustified` — событие, отказ старта/T3, доставленная отмена при смене
owner или часы; `OutcomeMatches` — таблица исходов v7.3; `RestartDelivered` —
доставка перед interrupted при известном id; `PartialKept` и `WorkMeasured` —
текст и формула по данным снимка; `RowConsistent` — исход/claim.
`StopOnlyWhileRunning` читает наблюдатель назначения нового stop на финализирующем
тике; `StopCancelSent` читает наблюдатель пропущенной отмены при известном id
и записанном stop. Оба наблюдателя вычисляются из фактического перехода.
`SnapshotFolded` сравнивает свёрнутые поля с полным журналом текста и usage,
который продолжает обновляться после первого конца. Имена мутантов
в свойствах отсутствуют. Мутанты меняют только переходы/запись результатов.
Bounds: один helper, в capacity — два; 0..4 минуты, две завершённые реплики,
две usage-записи, input 0..2/output 0..1, нормированный предел работы 3.
Порядок исходов, last string/null/дельты и реальные токены дополнительно держит
property-based проверка foldHelperSnapshot в продукте.

`HelperOutcome.tla` сохраняет прежний отдельный контракт чтения/пересказа:
несколько исходов, память полной пары session/turn у потребителя,
durable deliveredAt после непустого подтверждённого ответа, retention/visibility,
owner access и восстановление Bridge. NoTwoReads/NoRepeatedRead и потеря
offline-события — ожидаемые красные свидетели принятых последствий. Bounds:
две строки, две сессии, clock 0..2, KEEP=1, два чтения строки. Переписывание
свойств чтения по находкам FN4–FN5 ночи остаётся отдельной работой этой модели.

```sh
PATH=/opt/homebrew/opt/openjdk@25/bin:$PATH JAVA_TOOL_OPTIONS=-Xmx3g sh specs/helper-check.sh
```

Load <20 перед каждым cfg, workers 1..4, heap по умолчанию 3 GiB; BFS
seed 20261013/fingerprint 1. Simulation отделена от полного перебора.
Trap удаляет metadir/states; LOG_DIR сохраняет журналы и results.tsv.
Срок на конфигурацию — `TLC_TIMEOUT`, по умолчанию 1800 с: на стенде WSL2 (8 потоков, 7,8 ГБ, TLC 1.7.4, Java 21) самая долгая, `HelperRun-v72-run`, идёт 699 с, весь скрипт — 859 с (замер 10.11.2026).
Ожидаемый invariant отказ требует exit12 и точное имя; temporal отказ — exit13
и единственное свойство конфигурации. Инфраструктурная ошибка не убивает мутант.
Всего 48 конфигураций: 24 HelperRun (10 зелёных, 12 разных мутантов,
дополнительная temporal проверка «нет потолка», свидетель durable-хвоста)
и 24 HelperOutcome, включая семь проверок освобождения мест. Все прогоны выполняются на Mac mini.

| Конфигурация                                                                   | Ожидаемый результат       |
| ------------------------------------------------------------------------------ | ------------------------- |
| [HelperRun-v72-run.cfg](HelperRun-v72-run.cfg)                                 | PASS                      |
| [HelperRun-v72-silent.cfg](HelperRun-v72-silent.cfg)                           | PASS                      |
| [HelperRun-v72-restart.cfg](HelperRun-v72-restart.cfg)                         | PASS                      |
| [HelperRun-v72-quarantine.cfg](HelperRun-v72-quarantine.cfg)                   | PASS                      |
| [HelperRun-v72-cancel-failure.cfg](HelperRun-v72-cancel-failure.cfg)           | PASS                      |
| [HelperRun-v72-snapshot-failure.cfg](HelperRun-v72-snapshot-failure.cfg)       | PASS                      |
| [HelperRun-v72-lost-id.cfg](HelperRun-v72-lost-id.cfg)                         | PASS                      |
| [HelperRun-v72-record-failure.cfg](HelperRun-v72-record-failure.cfg)           | PASS                      |
| [HelperRun-v72-reminder-busy.cfg](HelperRun-v72-reminder-busy.cfg)             | PASS                      |
| [HelperRun-v72-capacity.cfg](HelperRun-v72-capacity.cfg)                       | PASS                      |
| [HelperRun-v72-cancel-finish.cfg](HelperRun-v72-cancel-finish.cfg)             | RED: OutcomeJustified     |
| [HelperRun-v72-no-ceiling.cfg](HelperRun-v72-no-ceiling.cfg)                   | RED: BoundedEnd           |
| [HelperRun-v72-restart-undelivered.cfg](HelperRun-v72-restart-undelivered.cfg) | RED: RestartDelivered     |
| [HelperRun-v72-finalize-twice.cfg](HelperRun-v72-finalize-twice.cfg)           | RED: OutcomeOnce          |
| [HelperRun-v72-stop-overwrite.cfg](HelperRun-v72-stop-overwrite.cfg)           | RED: StopOnce             |
| [HelperRun-v72-wrong-event.cfg](HelperRun-v72-wrong-event.cfg)                 | RED: OutcomeMatches       |
| [HelperRun-v72-drop-text.cfg](HelperRun-v72-drop-text.cfg)                     | RED: PartialKept          |
| [HelperRun-v72-work-output.cfg](HelperRun-v72-work-output.cfg)                 | RED: WorkMeasured         |
| [HelperRun-v72-no-ceiling-live.cfg](HelperRun-v72-no-ceiling-live.cfg)         | RED: NoSilentEnd          |
| [HelperRun-v72-shared-schedule.cfg](HelperRun-v72-shared-schedule.cfg)         | RED: NoSilentEnd          |
| [HelperRun-v72-detached-work.cfg](HelperRun-v72-detached-work.cfg)             | RED: NoDetachedWork       |
| [HelperRun-v73-stop-before-end.cfg](HelperRun-v73-stop-before-end.cfg)         | RED: StopOnlyWhileRunning |
| [HelperRun-v73-stop-needs-snapshot.cfg](HelperRun-v73-stop-needs-snapshot.cfg) | RED: StopCancelSent       |
| [HelperRun-v73-end-cutoff.cfg](HelperRun-v73-end-cutoff.cfg)                   | RED: SnapshotFolded       |

`HelperOutcome.SlotSpec` описывает полный список, новый запуск и проверку Goal. Две старые
строки представляют заполненный список, `admitted` представляет нового
помощника. Перебираются ждущие строки, неотданные исходы, сданные строки с разным
временем доставки, закрытые строки и принадлежность Goal. `ProtectedKept` сохраняет неотданные
исходы и строки Goal, `OldestEvicted` проверяет выбор самой старой записи по доставке или окончанию,
`AdmissionAvailable` проверяет доступность запуска при подходящей записи,
`GoalAdmissionAvailable` проверяет доступность проверки Goal с резервом места владельцу;
`ClosedAdmissionAvailable` проверяет вытеснение закрытых строк. `SlotCapacity` проверяет вместимость с резервом. Закрытие сданной строки без Goal сразу
удаляет её. Работа и завершение хода в `HelperRun` сохраняют прежние переходы.

| Конфигурация HelperOutcome                    | Ожидаемый результат                       |
| --------------------------------------------- | ----------------------------------------- |
| `-slots`                                      | PASS                                      |
| `-evict-unread`, `-evict-goal`, `-close-goal` | RED: ProtectedKept                        |
| `-evict-newest`                               | RED: OldestEvicted                        |
| `-admission`                                  | RED: NoAdmission, свидетель запуска       |
| `-delivered-close`                            | RED: NoDeliveredClose, свидетель закрытия |
| `-goal-no-eviction`                           | RED: GoalAdmissionAvailable               |
| `-goal-evict-unread`                          | RED: ProtectedKept                        |
| `-evict-closed-blocked`                       | RED: ClosedAdmissionAvailable             |

HelperOutcome: `-safety`, `-bridge-recovery` — PASS; остальные прежние конфиги
проверяют отрицательные свидетели, перечисленные в `helper-check.sh`.

## GoalCheck

`GoalCheck.tla` проверяет goal v3.5.1, §3 и §7. Goal и строки проверок меняются
одной записью `helpers.json` под замком. `Finalize` одновременно заканчивает строку
и применяет первое подходящее правило 0–4. Владелец может поменять постановку,
назначить срок, продолжить или удалить goal между любыми двумя записями.

Предпосылка среды после сокращения по ADR-0026: служебный ход Watch, Brief,
Insight, Reminder, Signal или Alert действует по скиллу `goal`. На границе
инструмента такой ход имеет полномочия хода владельца. В модели его допустимые
действия представлены `WatchNudge`/`Owner*` с прежними охранами: Watch приближает
проверку только у `active` с `check=0`, Brief читает, остальные служебные ходы
сохраняют goal. Чтение и сохранение состояния представлены пустым шагом.
Изменения `Owner*` требуют указания или тапа владельца. `OnlyOwnerActs`
проверяет переходы при этой предпосылке соблюдения скилла.

Принятое последствие: код не различает сторону, служебный ход держит скилл.

С3 принят как предпосылка штатного запуска: тик создаёт сессию проверки после
`claimHelper`, поэтому `Verdict` требует наблюдение `claimed`. Прямой вызов
инструмента с доверенным bearer до захвата относится к принятой границе среды.
Охрана `Claim` с `ownerPending=0` сохраняется как требование к коду, С4.

```sh
PATH=/opt/homebrew/opt/openjdk@25/bin:$PATH sh specs/goal-check.sh
```

Скрипт последовательно выполняет полный BFS девяти штатных конфигураций,
17 мутантов и одного свидетеля достижимости. Предел всего набора составляет
600 секунд, каждого запуска 150 секунд; `WORKERS` принимает 1–4, умолчание 4.
Каждый JVM получает отдельный `java.io.tmpdir`. Рабочее дерево TLC и `states`
живут в `.scratch/goal-tla` и удаляются при выходе. `LOG_DIR=/absolute/path`
сохраняет журналы и `results.tsv`. `TLC`, `TIMEOUT`, `TLC_TIMEOUT` и
`JAVA_TOOL_OPTIONS` задают инструменты и ресурсы; умолчание памяти JVM 2 ГБ.
`GOAL_CONFIGS="GoalCheck GoalCheck-owner"` выбирает отдельные сценарии при разработке;
полная приёмка выполняется с пустой переменной `GOAL_CONFIGS`.

Состояние содержит два id goal, статусы `absent`, `active`, `proposed`, `paused`,
`removed`, связь `check` и четыре вердикта. Фаза `running` соответствует строке
помощника со статусом `pending` и заполненным `run`. `limit` объединяет срок и
потолок помощника, которые заканчиваются исходом `bad`. Исход `interrupted`
моделирует след перезапуска. `Verdict` вызывается любой когда-либо захваченной
строкой, включая закончившуюся; CAS проверяет текущий `check` и отсутствие исхода.

`audit` удерживает результат предиката атомарного перехода по состояниям до и
после записи. `bornEdit` наблюдает смену постановки, `claimed` сохраняет факт
захвата, `staleAtEnd` наблюдает отвязку перед концом, `verdictBy` записывает автора
вердикта, `actual` независимо считает проверки за день. Эти наблюдатели проверяют
кодовые условия. Формулы свойств используют состояние и наблюдения переходов.
`readable` наблюдает принятие записи читателем; мутант `link-stop` меняет проверку
читателя и отклоняет допустимую привязанную строку с остановкой.

| Штатный конфиг              | Сценарий и конечные границы                                             |
| --------------------------- | ----------------------------------------------------------------------- |
| `GoalCheck`                 | Все вердикты и исходы, один goal, одна строка, одна правка              |
| `owner`                     | Одна проверка и две правки владельца, отвязка и срок при живой проверке |
| `failures`, `failures-live` | Два сбоя, порог паузы 2; второй конфиг проверяет живость                |
| `limits`                    | Истечение срока жизни; запуск проверки отключён для выделения паузы     |
| `live`                      | `CheckReleased` и `DueServed`                                           |
| `capacity`                  | Два goal, четыре id строк, стабильные часы, очередь и таблица владельца |
| `day`                       | Дневной предел 2, три проверки; безопасность, живость проверяет `live`  |
| `zombie`                    | Две проверки, поздний вердикт захваченной строки после её конца         |

`MaxOpen=3`, `MaxRows=5`, `FailuresToPause=2`, `DayMax=2`. Конфиги ограничивают
число выделений строки на goal и правок, диапазон вердиктов и исходов.
Id строки используется один раз на трассу; убранная строка сохраняет наблюдения.
`DueServed` проверяет ограниченный запрос до обслуживания, переноса срока,
смены постановки, паузы или исчерпания конечных id. День циклический, 0 или 1.
В `capacity` часы и тихий час закреплены, правок владельца 0, вердикт `quiet`,
обычный исход `ok`. Два начальных состояния задают одну сохранённую строку
владельца либо две его ждущие строки. В `owner` одна проверка при двух правках;
`zombie` проверяет последовательные проверки. В `day` три проверки держат дневной
предел независимо от конечного числа выделений. Живость смены дня отдельно
проверяется `live` на одной проверке, как у свидетелей `nonormalize` и `spec-weak-fair`.
`OwnerRowAdd` доступен один раз на трассу, `OwnerRowDrop` освобождает место;
так задаётся конечное вмешательство владельца в очередь.

Безопасность проверяют `TypeOK`, `StoreLinks`, `OneLiveCheck`, `ClaimOnlyActive`,
`DetachedChangesNothing`, `OwnerNextKept`, `ContentTold`, `SilentBranches`,
`FailureCount`, `OneUntoldPerGoal`, `UntoldKept`, `RemovedMeansSilent`,
`OnlyOwnerActs`, `OwnerPlace`, `RowsBounded`, `DayCountBounded`, `VerdictOwnCheck`.
`RowsBounded` считает незакрытые строки goal, общие строки и всю очередь.
`OwnerPlace` проверяет резерв сразу после `Due`, включая строки владельца.

Живость `CheckReleased` относится к каждой строке от постановки в очередь до
конца. Её предпосылка `WF Finalize` наследует `HelperRun.NoSilentEnd` и
`BoundedEnd`. `DueServed` использует `SF Due`, `SF NormalizeDay`, `SF Claim`,
повторяющиеся нетихие часы и смену дня, конечное добавление строк владельца и
справедливое освобождение его очереди. `WF Tell` наследует `HelperOutcome.Visible`
и `DeliveredAfterReply`. Суточное хранение исходов применяется к обычным
помощникам; тихие и рассказанные строки goal убираются сразу.

| Отрицательный конфиг             | Ожидаемое свойство                                                             |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `nodetach`                       | `DetachedChangesNothing`                                                       |
| `noclosed`                       | `RemovedMeansSilent`                                                           |
| `owner-time`, `fail-default`     | `OwnerNextKept`                                                                |
| `doublecheck`, `claim-detached`  | `OneLiveCheck`                                                                 |
| `pending-close`                  | `CheckReleased`                                                                |
| `require-done`                   | `ContentTold`                                                                  |
| `quiet-empty`, `content-failure` | `FailureCount`                                                                 |
| `due-untold`                     | `OneUntoldPerGoal`                                                             |
| `verdict-cas-goal`               | `VerdictOwnCheck`                                                              |
| `no-reserve`                     | `OwnerPlace`                                                                   |
| `link-stop`                      | `StoreLinks`                                                                   |
| `sweep-untold`                   | `UntoldKept`                                                                   |
| `nonormalize`, `spec-weak-fair`  | `DueServed`                                                                    |
| `capacity-reach`                 | `RowsBoundedReach`, свидетель полной таблицы после добавления строки владельца |

Каждый отрицательный конфиг проверяет одно свойство. Скрипт требует точный
первый отказ и exit 12 для инварианта либо 13 для живости. `capacity-reach`
проверяет достижимость на штатных переходах с `Mutant=none`. `claim-detached`
воскрешает уже закрытую отвязанную строку при захвате. `nodetach` оставляет
привязку и вердикт при смене постановки. Зомби `verdict-cas-goal` пишет вердикт
чужой проверки того же goal. У остальных мутантов меняется условие названного
перехода; свойства остаются теми же.

| Действие модели                                                     | Место в коде по §3                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Start`, `OwnerEdit`, `OwnerResume`, `OwnerNextCheck`, `OwnerClose` | `agent/lib/goal-store.ts`, G1/G6/G6r/G6t/G8 через `goal-tool.ts`                                 |
| `NormalizeDay`, `PauseByExpiry`, `Due`                              | `goal-store.ts:dueGoals` из `helper-tick.ts:runHelperTick`                                       |
| `WatchNudge`                                                        | `goal-tool.ts`, сторона Watch, G6w                                                               |
| `OwnerHelperClose`                                                  | `helper-store.ts:closeHelper` → `closeRow`                                                       |
| `Claim`, `Stop`, `Finalize`                                         | `helper-tick.ts`, `helper-store.ts:claimHelper/stopHelper/finishRow`, `goal-rules.ts:settleGoal` |
| `Verdict`                                                           | `goal-store.ts:verdictGoal`, CAS по `iva_helper`                                                 |
| `Tell`                                                              | `helper-outcome.ts:readHelperOutcome/finishHelperOutcomes`                                       |
| `SweepRow`                                                          | `helper-store.ts:sweepHelpers`, ветка строк goal                                                 |
| `DayPasses`, `QuietOn`, `QuietOff`, `Arrive`, `Expire`              | Часы, пояс владельца и `isQuietHour`                                                             |
| `OwnerRowAdd`, `OwnerRowDrop`                                       | Среда общей очереди и таблицы помощников                                                         |

Модель проверяет атомарные записи и порядок событий. Реальные миллисекунды,
матрица `goalActor`, транспорт Telegram, права файлов, текст заданий и соответствие
фактическому коду G1 проверяются при реализации и общей приёмке.

## ChatRecord

`ChatRecord.tla` models the chat record, the file `data/run-status.d/<chat>.json`, as
one state machine. Two processes write it under one lock with compare-and-set: the
agent (Channel, draft, hooks) and the Bridge; a Reminder turn writes from its own
process. A restart of the agent forgets every process memory and keeps the file;
recovery before the start may mark the record or fail. The Bridge can crash and
come back.

A chat is in one of eight states. Busy: `accepted` (a message is accepted, the
turn has not started), `turn`, `compacting`. `stale` is a busy record without a
write for the stale interval, or marked by recovery; the Bridge no longer waits
for it and the reaper frees it. Free: `free`, and three marked free states read by
precedence — `retiring` (the session leaves after its turn), `retry-offered`
(the reaper offered a retry), `awaiting-owner` (a question to the owner is open).
`chatState` in `agent/lib/run-status.ts` is the same function in the code, and
`rowRules` there holds the row invariants: which turn fields each state owns.

Checked invariants:

1. `OneState`: every reachable record satisfies exactly one of eight
   independent state predicates.
2. `TurnFieldsOnlyWhenBusy`: `ingress`, `session`, `turn` and `compacting` are
   filled only while the record is busy; a compaction has a session and no turn;
   a turn id needs a session.
3. `ReleasedByOwnerOrReaper`: a busy record becomes free through its owner (the
   turn by session and turn, the session by itself, an accepted message by its
   ingress id), through the reaper after the deadline, or through a reset.
4. `FreeAfterRestart`: after any restart the chat becomes free in finite time.
   Fairness: every started step ends, time passes, the Bridge comes back.

Mutants that must fail: a turn's terminal write that compares the session
without the turn (`ReleasedByOwnerOrReaper`); the reaper that frees a live
record (`ReleasedByOwnerOrReaper`); a release that leaves `compacting` on a
free chat (`TurnFieldsOnlyWhenBusy`, and `OneState` in a second
configuration); the reaper switched off (`FreeAfterRestart`).

Run `sh specs/chat-record-check.sh`. `scripts/chat-record.test.ts` replays
each counterexample on the real writers and names the invariant in the test
title.

Outside the model: the queued sign (`queued*`), the Stop mark, the turn
question and latency stamps, which do not decide the state; the Bridge queue
and its in-flight phases (`QueueDrain.tla`); the two awaits inside one session
retirement and the choice of the reset target; the file lock (`FileLock.tla`);
wall-clock values. The model assumes that eve handles the events of one session
in order, so a session-level release never overlaps a turn of that session.
`IdleCompaction`, `RestartRecovery`, `DraftStop`, `DeferredRestart` and
`TurnLifecycle` keep their own scenarios over the same record.
