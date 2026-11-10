// Thin spawner shared by agent/schedules/*.ts and agent/lib/schedule-migration.ts.
// Runs an existing cron script exactly the way the (now retired) systemd units did —
// `flock -w 3900 <lockPath> <nodeBin> --env-file-if-exists=.env <argv...>` — under a
// deadline (`timeoutMs: null` means none: a reminder turn lives as long as it works), and
// records the outcome to a status file so `iva doctor` and the /menu → crons screen
// can see it. Never throws: eve's schedule runner and the fire-and-forget migration hook
// both need a promise that always settles. The flag is the tolerant one on purpose: the
// parent (systemd EnvironmentFile, eve start) already carries every key of .env in its own
// process.env, so a checkout or version tree without the file must not kill the child —
// node prints one honest `not found. Continuing without it.` line to the tail instead.
import { lockCommand } from "./lock-command.ts";
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { resolveDataDir } from "./data-dir.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jobTail, recordFact, recordWake } from "./job-facts.ts";
import { jobReservation, jobState, OWNER_STARTED_AT } from "./job-state.ts";
import {
  acquireFileLock,
  releaseFileLock,
  writeFileAtomicSync,
} from "./fs-atomic.ts";

// A repeat within this window is almost certainly a double-fire (a Nitro schedule tick
// racing a catch-up run, or a manual retrigger) rather than a genuine second cron slot —
// none of the four periods fire more than once every 2h.
const GUARD_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 3600_000;
// How long flock may WAIT for .memory.lock before giving up. All four rollups plus the
// brain share that one lock and start 5..15 minutes apart, so a wait shorter than the
// job timeout meant a long daily silently threw the weekly (and everything behind it)
// off the night: flock exited 1 and the run was recorded as failed without ever starting.
// Keeping it above DEFAULT_TIMEOUT_MS makes the queue WAIT instead: the runner's own
// timeout is then the only thing that ends a wedged night, and it kills the whole group.
const LOCK_WAIT_SECONDS = 3900;
const DEFAULT_KILL_GRACE_MS = 10_000;
// Срок остановки ночи (killGraceMs её задания, agent/lib/schedule-paths.ts):
// ребёнок получает момент «работу кончить» (JOB_STOP_AT_ENV) ровно за этот срок до SIGTERM
// и столько же живёт после SIGTERM до SIGKILL — ночь успевает оборвать вызов модели
// (scripts/memory/night-call.ts). Тот же срок у тика proactive: он отменяет ход Insight на
// сервере (agent/schedules/proactive.ts). Прочим заданиям гасить нечего, у них прежние 10 с.
export const JOB_STOP_GRACE_MS = 90_000;
// Имя переменной с моментом «работу кончить», epoch ms. Её ставит только раннер, поверх
// окружения сервиса: у ребёнка одно число, и оно выведено из срока запуска.
export const JOB_STOP_AT_ENV = "IVA_JOB_STOP_AT";
// Раннер держит .memory.lock своим flock вокруг ребёнка и говорит ему об этом: ребёнок
// (scripts/lib/memory-lock.ts) второй раз замок не берёт. Срок признаком владения не служит.
export const MEMORY_LOCK_HELD_ENV = "IVA_MEMORY_LOCK_HELD";
const TAIL_MAX = 4000;
// The admission critical section below is a handful of synchronous fs calls — always
// microseconds. A lock still held after this long almost certainly means its owner
// crashed mid-section without cleanup, so it gets stolen once instead of wedging every
// future run of every schedule forever (this lock guards the shared status FILE, not
// one job — every name's admission check and finish-write goes through it).
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 20;
const LOCK_TIMEOUT_MS = 500;
export { OWNER_STARTED_AT };

// Запись имени в статусе: гварды и бронь (agent/lib/job-state.ts читает её объединением).
interface ScheduleStatusEntry {
  readonly lastSuccessAt?: number;
  readonly [key: string]: unknown;
}

type ScheduleStatus = Record<string, ScheduleStatusEntry>;

type SpawnImplementation = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface RunScheduledJobOptions {
  readonly name: string;
  readonly argv: readonly string[];
  readonly root?: string;
  readonly nodeBin?: string;
  readonly lockPath?: string;
  /**
   * Срок запуска. `null` — срока нет: ход живёт, пока идёт работа (напоминания).
   * Ночные задания срока не задают и получают DEFAULT_TIMEOUT_MS.
   */
  readonly timeoutMs?: number | null;
  readonly killGraceMs?: number;
  readonly guardMs?: number;
  readonly statusPath?: string;
  /** Путь к data/jobs.json; по умолчанию — рядом с данными при наличии statusPath. */
  readonly factsPath?: string;
  /** Будить агента после запуска (по умолчанию да). */
  readonly wake?: boolean;
  /**
   * Когда писать факт успеха. По умолчанию — всегда. `"after-failure"` — только если последний
   * факт этого имени провал: частое расписание (тик Watch) не забивает таблицу успехами, а
   * провал всё равно закрывается первым успехом (agent/lib/open-failures.ts).
   */
  readonly factOnSuccess?: "always" | "after-failure";
  readonly wakeImpl?: (name: string, startedAt: number) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnImpl?: SpawnImplementation;
  readonly killImpl?: (pid: number, signal: NodeJS.Signals) => unknown;
  readonly now?: () => number;
  readonly log?: (...args: unknown[]) => void;
}

export interface RunScheduledJobResult {
  readonly skipped: boolean;
  readonly ok: boolean;
  readonly code?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly error?: unknown;
}

interface SpawnOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly tail: string;
  /** Хвост для факта: только stderr и уже без секретов (см. onErrData ниже). */
  readonly errTail: string;
  readonly error?: unknown;
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null | undefined)?.code;
}

function errorMessage(error: unknown): string {
  return (error as { message: string }).message;
}

function ownsReservation(
  entry: ScheduleStatusEntry | undefined,
  startedAt: number,
): boolean {
  const reservation = jobReservation(entry);
  return (
    reservation.kind === "owned" &&
    reservation.since === startedAt &&
    reservation.ownerPid === process.pid &&
    reservation.ownerStartedAt === OWNER_STARTED_AT
  );
}

/**
 * Срок запуска как число. `null` — срока нет (ход напоминания живёт, пока идут события),
 * и тогда срока нет и у брони: она держится, пока жив её владелец, а его смерть освобождает
 * её сразу (reservationOwnerIsDead, agent/lib/job-state.ts).
 */
function deadlineMs(timeoutMs: number | null): number {
  return timeoutMs ?? Number.POSITIVE_INFINITY;
}

export class ScheduleStatusError extends Error {}

// Shared with schedule-migration.ts — one status file, one implementation of how it's
// safely read/written/locked, rather than two copies that could drift.
//
// No file yet → empty status: that is a fresh install, and every caller's guards read
// correctly off it. Anything else — damaged JSON, EACCES, EISDIR, a JSON value that
// isn't an object — throws with the path: answering "{}" there would claim nothing had
// ever run, which turns off the in-progress and last-success guards AND makes the very
// next `{ ...existing, [name]: … }` write erase every other schedule's record. Same
// split, for the same reason, in agent/lib/json-store.ts and agent/lib/reminder-tick.ts.
export function readStatus(statusPath: string): ScheduleStatus {
  let raw: string;
  try {
    raw = readFileSync(statusPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw new ScheduleStatusError(
      `${statusPath} unreadable: ${errorMessage(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ScheduleStatusError(
      `${statusPath} damaged (invalid JSON): ${errorMessage(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new ScheduleStatusError(
      `${statusPath} is not a schedule status object`,
    );
  return parsed as ScheduleStatus;
}

export function writeStatusAtomic(
  statusPath: string,
  data: ScheduleStatus,
): void {
  writeFileAtomicSync(statusPath, JSON.stringify(data, null, 2));
}

/** Причина провала одной строкой: спавн, сигнал или код выхода. */
function factError(outcome: SpawnOutcome, ok: boolean): string | null {
  if (outcome.error !== undefined) return errorMessage(outcome.error);
  if (outcome.signal) return `killed by ${outcome.signal}`;
  if (!ok) return `exited ${outcome.code ?? "n/a"}`;
  return null;
}

// Fire-and-forget: раннер не ждёт хода агента (он идёт, сколько нужно работе) и не падает, если
// ребёнок не поднялся. Но и молчать о таком провале нельзя: ребёнок отвязан (detached,
// stdio ignore), поэтому единственный его след — строка журнала и отметка в строке факта,
// которую раннер ставит только если сам ход ничего записать не успел. Повторов нет: провал
// пробуждения — факт, а не повод будить снова.
function spawnWake(
  root: string,
  nodeBin: string,
  env: NodeJS.ProcessEnv,
  name: string,
  startedAt: number,
  factsFile: string,
  log: (...args: unknown[]) => void,
): void {
  const child = spawn(
    nodeBin,
    [
      // Тот же терпимый флаг, что у самого запуска (шапка файла): родитель уже несёт
      // ключи .env в своём окружении, и дерево без файла не должно убивать пробуждение.
      "--env-file-if-exists=.env",
      join(root, "scripts/jobs/wake.ts"),
      name,
      String(startedAt),
    ],
    {
      cwd: root,
      env: {
        ...env,
        ASSISTANT_DATA_DIR: resolveDataDir(root, env.ASSISTANT_DATA_DIR),
      },
      detached: true,
      stdio: "ignore",
    },
  );
  const failed = (reason: string): void => {
    log(`schedule-runner: ${name} wake failed — ${reason}`);
    void recordWake(
      factsFile,
      name,
      startedAt,
      { at: Date.now(), status: "failed", error: reason },
      true,
    ).catch((error: unknown) => {
      log(
        `schedule-runner: ${name} wake outcome not recorded — ${errorMessage(error)}`,
      );
    });
  };
  child.on("error", (error) => failed(errorMessage(error)));
  child.on("exit", (code, signal) => {
    if (code === 0) return;
    // Ход сам пишет свой исход и выходит 1 на провале: тогда отметка уже стоит и
    // onlyIfMissing её не тронет, а строка журнала останется единственным следом.
    failed(
      signal ? `wake child killed by ${signal}` : `wake child exited ${code}`,
    );
  });
  child.unref();
}

// Окружение ребёнка: родительское, каталог данных, момент «работу кончить», если у
// запуска есть срок, и признак замка, если ребёнок идёт под flock. Снимок окружения
// сервиса ни то, ни другое не перекрывает.
function childEnv(
  env: NodeJS.ProcessEnv,
  root: string | undefined,
  stopAt: number | null,
  lockHeld: boolean,
): NodeJS.ProcessEnv {
  const rest = { ...env };
  delete rest[MEMORY_LOCK_HELD_ENV];
  return {
    ...rest,
    ASSISTANT_DATA_DIR: resolveDataDir(
      root ?? process.cwd(),
      env.ASSISTANT_DATA_DIR,
    ),
    ...(stopAt === null ? {} : { [JOB_STOP_AT_ENV]: String(stopAt) }),
    ...(lockHeld ? { [MEMORY_LOCK_HELD_ENV]: "1" } : {}),
  };
}

function tailLines(tail: string, n = 5): string {
  return tail
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(" | ");
}

// True mutual exclusion around a read-modify-write of the shared status file. Two
// runScheduledJob calls — a Nitro schedule tick and schedule-migration.ts's catch-up
// firing at nearly the same instant is the concrete case this guards against — could
// otherwise both read the same pre-reservation status and both decide to proceed before
// either's write lands, since the tmp+rename write above is atomic per-write but doesn't
// by itself serialize the READ-THEN-DECIDE-THEN-WRITE sequence across two callers.
// `fn` receives whether the lock was actually acquired — on the rare timeout path we
// still run `fn` (best-effort, logged by the caller) rather than leaving admission
// unchecked forever.
export async function withStatusLock<T>(
  statusPath: string,
  fn: (acquired: boolean) => T | PromiseLike<T>,
): Promise<T> {
  const lockPath = `${statusPath}.lock`;
  const held = await acquireFileLock(lockPath, {
    timeoutMs: LOCK_TIMEOUT_MS,
    staleMs: LOCK_STALE_MS,
    retryMs: LOCK_RETRY_DELAY_MS,
  });
  try {
    return await fn(held !== null);
  } finally {
    if (held) releaseFileLock(held);
  }
}

type ResolvedOptions = RunScheduledJobOptions &
  Required<
    Pick<
      RunScheduledJobOptions,
      | "timeoutMs"
      | "killGraceMs"
      | "guardMs"
      | "wake"
      | "env"
      | "spawnImpl"
      | "killImpl"
      | "now"
      | "log"
    >
  >;

// Значения по умолчанию, как у деструктуризации: явный undefined их не перекрывает.
function resolveOptions(options: RunScheduledJobOptions): ResolvedOptions {
  const given = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as RunScheduledJobOptions;
  return {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    killGraceMs: DEFAULT_KILL_GRACE_MS,
    guardMs: GUARD_MS,
    wake: true,
    env: process.env,
    spawnImpl: spawn,
    killImpl: (pid: number, signal: NodeJS.Signals) =>
      process.kill(pid, signal),
    now: () => Date.now(),
    log: (...args: unknown[]) => console.log(new Date().toISOString(), ...args),
    ...given,
  };
}

// Запуск со статус-файлом: бронь, гварды и итог пишутся в него.
type WithStatus = ResolvedOptions & { readonly statusPath: string };

function hasStatus(o: ResolvedOptions): o is WithStatus {
  return typeof o.statusPath === "string" && o.statusPath !== "";
}

// Что запуск держит между шагами: момент старта, своя бронь в статусе и провал факта.
interface RunState {
  startedAt: number;
  reserved: boolean;
  // Провал записи обязательного факта: причину обязан увидеть тот, кто ждёт промис
  // (waitUntil расписаний), поэтому она выезжает отклонением, а не полем результата.
  factFailure: Error | null;
}

// Решение «пускать ли» под замком статуса. Бронь пишется в том же критическом участке,
// где читаются гварды.
function admitUnderLock(
  o: WithStatus,
  run: RunState,
  acquired: boolean,
): boolean {
  const { name, now, log, timeoutMs, guardMs, statusPath } = o;
  if (!acquired) {
    // Could not get exclusive access to the read-decide-write critical section in
    // time. Proceeding anyway would defeat the entire point of the lock — two
    // concurrent callers could both read the same pre-reservation snapshot and
    // both admit themselves, exactly the race this lock exists to close. Defer
    // instead: skip this attempt with no status write at all, and let the next
    // Nitro tick or migration boot retry — nothing unsafe happens meanwhile.
    log(
      `schedule-runner: ${name} could not acquire the status lock in time — deferring this attempt (retried on the next tick/boot)`,
    );
    return false;
  }
  let existing: ScheduleStatus;
  try {
    existing = readStatus(statusPath);
  } catch (error) {
    // Deciding off a status we could not read means deciding off "nothing ever
    // ran": both guards below would wave this attempt through, and the
    // reservation write would erase every other schedule's record. Defer exactly
    // like the lock-less path above — no write, retried next tick.
    log(
      `schedule-runner: ${name} deferring this attempt — ${errorMessage(error)} (retried on the next tick/boot)`,
    );
    return false;
  }
  const prior = existing[name];

  // Genuinely still running — a run that hasn't succeeded OR failed yet, so the
  // lastSuccessAt guard below can't see it. Without this, a Nitro tick and a
  // migration catch-up landing on the same period at nearly the same instant would
  // both read the same stale lastSuccessAt and both pass that guard.
  const current = jobState(name, {
    entry: prior,
    now: now(),
    deadlineMs: deadlineMs(timeoutMs),
  });
  if (current.state === "running" && current.reservation.kind !== "none") {
    const ageS = Math.round((now() - current.reservation.since) / 1000);
    log(
      `schedule-runner: ${name} skipped — already in progress (started ${ageS}s ago)`,
    );
    return false;
  }
  if (
    typeof prior?.lastSuccessAt === "number" &&
    now() - prior.lastSuccessAt < guardMs
  ) {
    const ageMin = Math.round((now() - prior.lastSuccessAt) / 60000);
    log(
      `schedule-runner: ${name} skipped — last success ${ageMin}m ago (< ${Math.round(guardMs / 60000)}m guard)`,
    );
    return false;
  }

  run.startedAt = now();
  writeStatusAtomic(statusPath, {
    ...existing,
    [name]: {
      ...prior,
      lastStartedAt: run.startedAt,
      inProgressSince: run.startedAt,
      ownerPid: process.pid,
      ownerStartedAt: OWNER_STARTED_AT,
    },
  });
  run.reserved = true;
  return true;
}

// Запуск ребёнка под сроком. Промис всегда разрешается исходом, никогда не отклоняется.
function spawnChild(
  o: ResolvedOptions,
  startedAt: number,
): Promise<SpawnOutcome> {
  const { argv, root, nodeBin, lockPath, timeoutMs, killGraceMs, env } = o;
  const lock = lockPath
    ? lockCommand({ file: lockPath, waitSeconds: LOCK_WAIT_SECONDS })
    : null;
  const node = nodeBin ?? process.execPath;
  const cmd = lock?.command ?? node;
  const args = lock
    ? [...lock.args, node, "--env-file-if-exists=.env", ...argv]
    : ["--env-file-if-exists=.env", ...argv];

  return new Promise<SpawnOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      // detached: true makes the child the leader of its OWN process group (POSIX
      // setpgid) instead of sharing ours. That matters specifically for the flock-
      // wrapped case: flock fork()s node as its child, and that fork inherits the
      // flock()'d file descriptor — the lock is held by the OPEN FILE DESCRIPTION,
      // not by whichever process id we happen to signal. Killing only flock's own
      // pid on timeout left node (and the lock) alive. Signaling the whole process
      // group (killImpl(-pid, ...) below) reaches flock AND the node it forked.
      child = o.spawnImpl(cmd, args, {
        cwd: root,
        env: childEnv(
          env,
          root,
          timeoutMs === null ? null : startedAt + timeoutMs - killGraceMs,
          Boolean(lockPath),
        ),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      resolve({ code: null, signal: null, tail: "", errTail: "", error });
      return;
    }
    watchChild(o, child, resolve);
  });
}

// Хвосты вывода, срок с SIGTERM/SIGKILL группе и исход ребёнка.
function watchChild(
  o: ResolvedOptions,
  child: ChildProcess,
  resolve: (outcome: SpawnOutcome) => void,
): void {
  const { name, lockPath, timeoutMs, killGraceMs, env, killImpl, log } = o;
  let tail = "";
  const onData = (chunk: { toString(): string }) => {
    tail = (tail + chunk.toString()).slice(-TAIL_MAX);
  };
  // Хвост для факта отдельный, и он копится иначе, чем хвост для журнала сервиса:
  //  • только stderr — спека T20 просит в факте причину, а отчёт скрипта в stdout
  //    вытеснял её из хвоста и ехал в текст пробуждения (лишние токены);
  //  • вырезание секретов идёт ДО обрезки, поэтому граница буфера не может рассечь
  //    значение и оставить в jobs.json его суффикс (jobTail сам держит 20 строк
  //    и потолок знаков, так что буфер остаётся ограниченным).
  let errTail = "";
  const onErrData = (chunk: { toString(): string }) => {
    errTail = jobTail(errTail + chunk.toString(), env);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", (chunk: { toString(): string }) => {
    onData(chunk);
    onErrData(chunk);
  });

  // Signal the process GROUP (negative pid), not just this one pid — see the
  // detached:true comment above. Falls back to a direct child.kill if the group
  // signal fails for any reason (e.g. the child already reaped its own group).
  const killGroup = (signal: NodeJS.Signals): void => {
    const pid = child.pid;
    try {
      if (pid) killImpl(-pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch (error) {
        // process may have exited between the timer firing and the kill call
        log(
          `schedule-runner: ${name} ${signal} not delivered — ${errorMessage(error)}`,
        );
      }
    }
  };

  let settled = false;
  let hardTimer: NodeJS.Timeout | undefined;
  const settle = (result: SpawnOutcome): void => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    // Only cancel a still-pending hard-kill when "child" exiting is proof the actual
    // TARGET process is gone — true for the direct (no lockPath) spawn, where child
    // literally is the schedule's own script, so leaving hardTimer dangling there would
    // risk it firing later against a since-reused pid. NOT true for the flock-wrapped
    // case: there "child" is flock itself, which — unlike the target it forks — has no
    // custom SIGTERM handler, so flock dying from the very SIGTERM we just sent proves
    // nothing about whether the grandchild node process (which still holds the lock) is
    // dead too. Canceling hardTimer there would orphan exactly the process this whole
    // group-kill exists to reach. (Caught this the hard way: an earlier, lockPath-blind
    // version of this cancellation left a real, unkillable orphan behind in this file's
    // own test suite.)
    if (!lockPath) clearTimeout(hardTimer);
    resolve(result);
  };

  // Без срока убивать нечего: таймер не заводится вовсе (setTimeout с бесконечностью
  // Node схлопывает в 1 мс — это и был бы потолок, которого больше нет).
  const killTimer =
    timeoutMs === null
      ? undefined
      : setTimeout(() => {
          log(
            `schedule-runner: ${name} exceeded ${timeoutMs}ms — sending SIGTERM to its process group`,
          );
          killGroup("SIGTERM");
          hardTimer = setTimeout(() => {
            log(
              `schedule-runner: ${name} still running after SIGTERM — sending SIGKILL to its process group`,
            );
            killGroup("SIGKILL");
          }, killGraceMs);
          if (hardTimer.unref) hardTimer.unref();
        }, timeoutMs);
  if (killTimer?.unref) killTimer.unref();

  child.on("error", (error) =>
    settle({ code: null, signal: null, tail, errTail, error }),
  );
  // close, а не exit: exit приходит до слива потоков, и поздняя причина из stderr
  // не попадала бы в факт (T30 №8).
  child.on("close", (code, signal) => settle({ code, signal, tail, errTail }));
}

function logOutcome(o: ResolvedOptions, outcome: SpawnOutcome): void {
  const { name, log } = o;
  const codeDesc = outcome.code ?? "n/a";
  const signalDesc = outcome.signal ? `, signal=${outcome.signal}` : "";
  log(`schedule-runner: ${name} finished (code=${codeDesc}${signalDesc})`);
  if (outcome.tail)
    log(`schedule-runner: ${name} tail: ${tailLines(outcome.tail)}`);
  if (outcome.error)
    log(`schedule-runner: ${name} spawn error: ${errorMessage(outcome.error)}`);
}

// Факт — история запуска (одна таблица, п.1 T20): провал пишется всегда, успех — по политике
// задания (factOnSuccess): always — всегда, after-failure — только закрывая прошлый провал.
// Будим агента только когда факт на диске — иначе ходу нечего показать.
interface Finish {
  readonly finishedAt: number;
  readonly outcome: SpawnOutcome;
  readonly childOk: boolean;
}

async function recordJobFact(
  o: ResolvedOptions,
  factsFile: string,
  run: RunState,
  { finishedAt, outcome, childOk }: Finish,
): Promise<void> {
  const { name, log } = o;
  let written: boolean;
  try {
    written = await recordFact(
      factsFile,
      {
        name,
        startedAt: run.startedAt,
        finishedAt,
        ok: childOk,
        error: factError(outcome, childOk),
        exitCode: outcome.code,
        tail: outcome.errTail,
        acked: false,
        wake: null,
      },
      finishedAt,
      { afterFailure: childOk && o.factOnSuccess === "after-failure" },
    );
  } catch (error) {
    log(`schedule-runner: ${name} fact not recorded — ${errorMessage(error)}`);
    run.factFailure = error instanceof Error ? error : new Error(String(error));
    return;
  }
  if (written && o.wake) startWake(o, factsFile, run.startedAt);
}

function startWake(
  o: ResolvedOptions,
  factsFile: string,
  startedAt: number,
): void {
  const { name, root, nodeBin, env, log } = o;
  try {
    (
      o.wakeImpl ??
      ((wakeName: string, at: number) =>
        spawnWake(
          root ?? process.cwd(),
          nodeBin ?? process.execPath,
          env,
          wakeName,
          at,
          factsFile,
          log,
        ))
    )(name, startedAt);
  } catch (error) {
    log(`schedule-runner: ${name} wake not started — ${errorMessage(error)}`);
  }
}

// Итог в статус под замком: гварды («идёт сейчас», «последний успех»). Возвращает, снята
// ли своя бронь.
function completeUnderLock(
  o: WithStatus,
  run: RunState,
  finish: { finishedAt: number; code: number | null; ok: boolean },
  acquired: boolean,
): boolean {
  const { name, log, statusPath } = o;
  if (!acquired) {
    log(
      `schedule-runner: ${name} could not acquire the status lock to record completion`,
    );
    return false;
  }
  let current: ScheduleStatus;
  try {
    current = readStatus(statusPath);
  } catch (error) {
    // The job already ran; we simply cannot record it. Writing from an unreadable
    // snapshot would erase the neighbours, so leave the file alone: the
    // reservation stays, and the inProgressSince/timeoutMs staleness check frees
    // it on a later attempt.
    log(
      `schedule-runner: ${name} outcome not recorded — ${errorMessage(error)}`,
    );
    return false;
  }
  if (!ownsReservation(current[name], run.startedAt)) {
    log(
      `schedule-runner: ${name} completion ignored because its reservation changed owner`,
    );
    return false;
  }
  writeStatusAtomic(statusPath, {
    ...current,
    [name]: {
      ...withoutReservation(current[name]),
      lastStartedAt: run.startedAt,
      lastFinishedAt: finish.finishedAt,
      lastExitCode: finish.code,
      ...(finish.ok ? { lastSuccessAt: finish.finishedAt } : {}),
      // Роли файлов: здесь — гварды («идёт сейчас», «последний успех») и след того,
      // что запуск вообще был (scripts/lib/notice-policy.ts). Исход запуска и его
      // история живут в data/jobs.json — второго ответа на «как прошло» тут нет.
    },
  });
  return true;
}

function withoutReservation(
  entry: ScheduleStatusEntry | undefined,
): Record<string, unknown> {
  const {
    inProgressSince: _drop,
    ownerPid: _ownerPid,
    ownerStartedAt: _ownerStartedAt,
    ...rest
  } = entry ?? {};
  void _drop;
  void _ownerPid;
  void _ownerStartedAt;
  return rest;
}

// Belt-and-suspenders: if something threw between reserving and the normal
// finish-write (which already clears inProgressSince on every ordinary path),
// don't leave the reservation stuck for the rest of timeoutMs for no reason.
async function clearReservation(o: WithStatus, run: RunState): Promise<void> {
  const { name, log, statusPath } = o;
  try {
    const cleaned = await withStatusLock(statusPath, (acquired) => {
      if (!acquired) {
        log(
          `schedule-runner: ${name} could not acquire the status lock to clear its reservation`,
        );
        return false;
      }
      const current = readStatus(statusPath);
      if (!ownsReservation(current[name], run.startedAt)) {
        log(
          `schedule-runner: ${name} cleanup ignored because its reservation changed owner`,
        );
        return false;
      }
      writeStatusAtomic(statusPath, {
        ...current,
        [name]: withoutReservation(current[name]),
      });
      return true;
    });
    if (cleaned) run.reserved = false;
  } catch (error) {
    // best-effort cleanup only — a stuck reservation still self-heals via the
    // inProgressSince/timeoutMs staleness check above on the next attempt.
    log(
      `schedule-runner: ${name} reservation not cleared — ${errorMessage(error)}`,
    );
  }
}

// Бронь в статусе, если он есть. Без статуса пускается всегда.
async function admit(o: ResolvedOptions, run: RunState): Promise<boolean> {
  if (!hasStatus(o)) {
    run.startedAt = o.now();
    return true;
  }
  return await withStatusLock(o.statusPath, (acquired) =>
    admitUnderLock(o, run, acquired),
  );
}

// Исход запуска: журнал, факт с пробуждением, итог в статус. Успех — это ещё и
// записанный факт: без строки в таблице агента никто не разбудит, а «последний успех»
// в статусе скажет, что всё в порядке (слепая приёмка T20 по v6).
async function finishRun(
  o: ResolvedOptions,
  run: RunState,
  outcome: SpawnOutcome,
): Promise<RunScheduledJobResult> {
  const finishedAt = o.now();
  const childOk = outcome.code === 0 && !outcome.error;
  logOutcome(o, outcome);
  if (o.factsPath)
    await recordJobFact(o, o.factsPath, run, { finishedAt, outcome, childOk });

  // Запуск успешен, только если ребёнок вышел нулём И запись факта не отказала: успех,
  // пропущенный политикой after-failure, — тоже успех, его след остаётся в статусе.
  const ok = childOk && run.factFailure === null;
  if (hasStatus(o)) {
    const finish = { finishedAt, code: outcome.code, ok };
    run.reserved = !(await withStatusLock(o.statusPath, (acquired) =>
      completeUnderLock(o, run, finish, acquired),
    ));
  }

  // Отказ записи обязан отклонить промис, иначе расписание считает шаг успешным (T30 №5):
  // без строки нет ни пробуждения, ни следа в таблице для провала и для политики always.
  if (run.factFailure !== null) throw run.factFailure;

  // Ошибка spawn (ENOENT и любая другая) едет наружу: потребитель обязан сказать
  // причину, а не «exited unknown» — ребёнок не запускался вовсе.
  return {
    skipped: false,
    ok,
    code: outcome.code,
    signal: outcome.signal,
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  };
}

export function runScheduledJob(
  options: RunScheduledJobOptions,
): Promise<RunScheduledJobResult>;

export async function runScheduledJob(
  options: RunScheduledJobOptions = {} as RunScheduledJobOptions,
): Promise<RunScheduledJobResult> {
  const o = resolveOptions(options);
  const run: RunState = {
    startedAt: o.now(),
    reserved: false,
    factFailure: null,
  };
  try {
    if (!(await admit(o, run))) return { skipped: true, ok: true };
    o.log(`schedule-runner: ${o.name} start`);
    return await finishRun(o, run, await spawnChild(o, run.startedAt));
  } catch (error) {
    // Провал факта уже назван в журнале строкой «fact not recorded» — не выдаём его за
    // неожиданный сбой, а отдаём тому, кто ждёт промис.
    if (error === run.factFailure) throw error;
    return await unexpectedFailure(o, error);
  } finally {
    if (run.reserved && hasStatus(o)) await clearReservation(o, run);
  }
}

// Неожиданный сбой — провал запуска с причиной. Бросивший журнал причину не меняет:
// промис расписания обязан разрешиться этим же провалом.
async function unexpectedFailure(
  o: ResolvedOptions,
  error: unknown,
): Promise<RunScheduledJobResult> {
  await Promise.resolve()
    .then(() =>
      o.log(
        `schedule-runner: ${o.name} unexpected failure: ${errorMessage(error)}`,
      ),
    )
    .catch(() => undefined);
  return { skipped: false, ok: false, error };
}
