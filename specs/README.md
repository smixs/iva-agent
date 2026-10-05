# TLA+ models

The repository keeps bounded models of the lock, the night writer, restart recovery, proactive notices, plugin proposals and idle compaction. Run them from a temporary directory because TLC writes state files beside the model.

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

`Replace` and `Conflict` are single steps, and `HumanEdit` is enabled only while the night waits for or holds the answer, because the hash check, the write and the commit run under the Card lock that the day writers take too (`write_card`, CORE through `writeCore`): an owner edit cannot land between the check and the write.

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

## Proactive

`Proactive.tla` models the half-hourly proactive run before its code exists (`scripts/proactive/tick.ts`): a no-wait lock that expires `staleMs` after it is taken, the state file `data/proactive.json` written whole from the run's memory, the Brief claim and turn, the source check, the Watch claim before the turn, delivery and the `wakes` write after it, a crash or a failed write at any step and the runner's deadline. One `Tick` is 8 minutes: a 40-minute `staleMs` gives `Stale = 5`, a run that lives at most `timeoutMs + killGraceMs` (30 min 10 s) gives `MaxRun = 4`. A comment in the model maps every action to its future file and function.

Checked invariants:

1. `NoDoubleTake`: a key reaches at most one turn between two growths of its unread count.
2. `OneBriefPerSlot`: one Brief per slot and day.
3. `WakesCapped`: ordinary wakes with a message per day stay within `watchCapPerDay` plus the number of runs lost between delivery and the `wakes` write.
4. `OneRun`: two runs never overlap.

The run takes its `now` right after the lock (`NowAfterLock = TRUE`). Witnesses must fail, each on its own invariant first: `Proactive-noclaim.cfg` (claim after the turn, 1), `Proactive-nolock.cfg` (no lock: 4, then 1, then 2), `Proactive-nocap.cfg` (no cap filter, 3), `Proactive-shortstale.cfg` (`staleMs` shorter than a run, 4), `Proactive-nowfirst.cfg` (`now` taken before the lock: a run with an older day overwrites `briefDone` written for a newer day, 2).

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

## IdleCompaction

`IdleCompaction.tla` models the compaction between turns (ADR-0021) and was written after the code: it checks the code, not a design. One eve session in one chat: the bridge (routing under queue or steer, replies to bot messages, the disk queue, the drain, the reaper), the chat status record, the process memory of `agent/lib/idle-compaction.ts` (with the open ask `reclaim`), eve's input buffer, control queue and current action, the compact POST that the `session.waiting` handler awaits with its outcomes (accepted, refused, unknown, accepted after the client's timeout), the `compaction.requested` hook that claims the chat again, `/stop` and steer aborts in eve's order (parking, `turn.cancelled`, parking), and a restart with the ExecStartPre quarantine. The comment in the model maps every action to its function and lists the assumptions about eve (facts Ф3–Ф13 of the spec).

Checked on the code with a late compact request allowed, queue and steer (`IdleCompaction.cfg`, `-steer`): every invariant of spec section 7 (`QueuedWhileCompacting`, `CompactionGuarded`, `TurnRecordKept`, `NoFalseInterruptNotice`, `NoCancelMarkForCompaction`, `CompactingNeverInTurn`, `OffOnlyAfterUselessCompaction`, `AtMostOneAskPerTurn`, `NoStackedCompaction`, `NoAskOverCompactingRecord`, `NoAskWhileOff`) and the liveness `NoLostMessage` and `ChatFreed`. With a restart (`-restart`, `-restart-steer`) the safety invariants and `NoHangAfterRestart` hold, except `CompactionGuarded` and `QueuedWhileCompacting` (F7, `-restart-guarded`): a late request queued in eve survives the restart while the process memory does not. The proposed repair `BeginAnyIdle` (R5, a model switch, not code) makes `-r5` and `-r5-steer` pass every safety invariant.

Findings that must fail: the window between the start of a late compaction and its hook (`-window`: `QueuedInRequestWindow`; `-window-restart`: `NoHangInRequestWindow`, F6); a message already in eve's input lost without a notice by a restart mid-compaction (`-silentloss`) and waiting in that input (`-inbox`); a compaction longer than `RUN_STALE_MS` reaped while a buffered turn runs without a record (`-turnhang`, outside the feature).

Witnesses must fail: `-offfail` (R3 off: `OffOnlyAfterUselessCompaction`), `-nobeginclaim` (no claim on `compaction.requested`: `CompactionGuarded`), `-noaskguard` (a second ask while one is open: `NoStackedCompaction`), `-releasebysession` (on the base without the await: `TurnRecordKept`), `-noclaim` (`QueuedWhileCompacting`), `-noopenguard` (`OffOnlyAfterUselessCompaction`), `-noisyreap` (`NoFalseInterruptNotice`), `-turnkeeps` (`CompactingNeverInTurn`), `-dueagain` (`AtMostOneAskPerTurn`), `-offnotchecked` (`NoAskWhileOff`), `-repliesdirect` (`QueuedWhileCompacting`), `-noreap` (`ChatFreed`). `-void` (no await) and `-noparkrelease` pass: the hook's claim covers the first, the reaper the second.

```sh
specs/idle-compaction-check.sh
```
