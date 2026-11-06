import { defineTool } from "eve/tools";
import { z } from "zod";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { Worker } from "node:worker_threads";

// Host-native bash. Переопределяет встроенный sandbox-bash eve: команда выполняется
// напрямую на реальной файловой системе VPS через node:child_process (без sandbox).
// Самодостаточно: импортирует только eve/tools, zod и node-builtins.

const MAX_OUTPUT = 30_000; // оставляем последние ~30k символов каждого потока
// Отмена хода и таймаут — разные исходы: модель и журнал обязаны видеть какой именно.
const CANCELLED_NOTE = "Команда отменена: ход прерван.";
const TERM_GRACE_MS = 400;
const KILL_GRACE_MS = 400;
const REAP_POLL_MS = 20;
const PIPE_DRAIN_GRACE_MS = 100;
export function selectCommandShell(
  fileExists: (path: string) => boolean = existsSync,
): string | true {
  return ["/bin/bash", "/usr/bin/bash"].find(fileExists) ?? true;
}
const COMMAND_SHELL = selectCommandShell();
// A per-call Worker must have enough time to start and observe the root process.
// Shorter deadlines are rejected instead of pretending they can be enforced reliably.
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 2_147_483_647;
const DEADLINE_ARMED = 0;
const DEADLINE_CANCELLED = 1;
const DEADLINE_EXPIRED = 2;
const DEADLINE_PROBE_FAILED = 3;

// setTimeout shares the agent's event loop. A synchronous tool or native call can
// block that loop past the deadline, so a small worker owns the deadline signal.
// The worker only observes the root PID and signals the process group created by
// this invocation; manager-owned jobs in another group remain outside its scope.
const DEADLINE_WATCHDOG_SOURCE = String.raw`
  const { execFileSync } = require("node:child_process");
  const { readFileSync } = require("node:fs");
  const { workerData } = require("node:worker_threads");
  const state = new Int32Array(workerData.state);
  const pid = workerData.pid;
  const deadlineNs = workerData.deadlineNs;
  const termGraceNs = BigInt(workerData.termGraceMs) * 1000000n;
  const killGraceNs = BigInt(workerData.killGraceMs) * 1000000n;
  const pollMs = workerData.pollMs;

  function signalGroup(signal) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      return error && error.code !== "ESRCH";
    }
  }

  function signalRoot(signal) {
    try {
      process.kill(pid, signal);
      return true;
    } catch (error) {
      return !error || error.code !== "ESRCH";
    }
  }

  function portableRootState() {
    try {
      const stat = execFileSync(
        "/bin/ps",
        ["-o", "stat=", "-p", String(pid)],
        {
          encoding: "utf8",
          maxBuffer: 1024,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 100,
        },
      ).trim();
      if (!stat || stat.startsWith("Z")) return 0;
      return 1;
    } catch {
      return signalRoot(0) ? -1 : 0;
    }
  }

  function rootState() {
    if (process.platform === "linux" && !workerData.forcePortableProbe) {
      try {
        const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
        const stateOffset = stat.lastIndexOf(") ") + 2;
        if (stateOffset >= 2) {
          const processState = stat[stateOffset];
          return processState === "Z" || processState === "X" || processState === "x"
            ? 0
            : 1;
        }
      } catch (error) {
        if (error && error.code === "ENOENT") return 0;
      }
    }
    return portableRootState();
  }

  function waitUntilDeadline(deadline) {
    while (Atomics.load(state, 0) === 0) {
      const remainingNs = deadline - process.hrtime.bigint();
      if (remainingNs <= 0n) return true;
      const remainingMs = Number((remainingNs + 999999n) / 1000000n);
      Atomics.wait(state, 0, 0, Math.min(pollMs, remainingMs));
    }
    return false;
  }

  function waitForGroupExit(deadline) {
    while (process.hrtime.bigint() < deadline) {
      if (!signalGroup(0)) return true;
      Atomics.wait(state, 1, 0, pollMs);
    }
    return !signalGroup(0);
  }

  const reachedDeadline = waitUntilDeadline(deadlineNs);
  if (reachedDeadline && Atomics.load(state, 0) === 0) {
    const observedRootState = rootState();
    const deadlineResult =
      observedRootState === 1 ? 2 : observedRootState === 0 ? 1 : 3;
    Atomics.compareExchange(state, 0, 0, deadlineResult);
  }
  const deadlineResult = Atomics.load(state, 0);
  if (deadlineResult === 2 || deadlineResult === 3) {
    if (signalGroup("SIGTERM")) {
      const termDeadline = process.hrtime.bigint() + termGraceNs;
      if (!waitForGroupExit(termDeadline)) {
        signalGroup("SIGKILL");
        waitForGroupExit(process.hrtime.bigint() + killGraceNs);
      }
    }
  } else {
    Atomics.compareExchange(state, 0, 0, 1);
  }
`;

export const deadlineWorkerRuntime = {
  create(options: ConstructorParameters<typeof Worker>[1]): Worker {
    return new Worker(DEADLINE_WATCHDOG_SOURCE, options);
  },
};

type BashResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  truncated?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
};

// Отменённый вызов отдаёт то, что успело накопиться, плюс явный признак отмены: timedOut
// здесь не выставляется никогда, иначе исход не отличить от таймаута. Примечание проходит
// тот же потолок вывода, что и сток команды: иначе результат пробивает его ровно на длину
// примечания.
function cancelledResult(run: CommandRun): BashResult {
  appendNotice(run, CANCELLED_NOTE);
  return {
    stdout: run.stdout,
    stderr: run.stderr,
    exitCode: 1,
    cwd: run.runCwd,
    truncated: run.outputTruncated || undefined,
    cancelled: true,
  };
}

// Ход, отменённый до запуска, не спавнит процесс вовсе: явный результат вместо спавна.
function cancelledBeforeStart(
  signal: AbortSignal | undefined,
  cwd: string,
): BashResult | null {
  if (!signal?.aborted) return null;
  return {
    stdout: "",
    stderr: CANCELLED_NOTE,
    exitCode: 1,
    cwd,
    cancelled: true,
  };
}

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_OUTPUT) return { text: s, truncated: false };
  return { text: s.slice(s.length - MAX_OUTPUT), truncated: true };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    // detached:true makes the shell the leader of a fresh POSIX process group.
    // A negative pid addresses that whole group, including grandchildren.
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return false;
    return false;
  }
}

function processGroupExists(pid: number): boolean {
  return signalProcessGroup(pid, 0);
}

type RootProcessState = "live" | "exited" | "unknown";

function signalRootExists(pid: number): RootProcessState {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ESRCH"
      ? "exited"
      : "unknown";
  }
}

function portableRootProcessState(pid: number): RootProcessState {
  try {
    const stat = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 100,
    }).trim();
    if (!stat || stat.startsWith("Z")) return "exited";
    return "live";
  } catch {
    return signalRootExists(pid) === "exited" ? "exited" : "unknown";
  }
}

function rootProcessState(pid: number): RootProcessState {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const stateOffset = stat.lastIndexOf(") ") + 2;
      if (stateOffset >= 2) {
        const state = stat[stateOffset];
        return state === "Z" || state === "X" || state === "x"
          ? "exited"
          : "live";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "exited";
    }
  }
  return portableRootProcessState(pid);
}

async function waitForGroupExit(
  groupPid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(groupPid)) return true;
    await delay(REAP_POLL_MS);
  }
  return !processGroupExists(groupPid);
}

async function reapProcessGroup(
  groupPid: number,
  { immediate = false }: { immediate?: boolean } = {},
): Promise<void> {
  // Отмена хода не уговаривает: первый сигнал группе — сразу SIGKILL, без паузы на SIGTERM.
  // У таймаута первым идёт терпеливый SIGTERM: обычной команде дают убраться самой.
  const first = immediate ? "SIGKILL" : "SIGTERM";
  const firstGrace = immediate ? KILL_GRACE_MS : TERM_GRACE_MS;
  if (!signalProcessGroup(groupPid, first)) return;
  if (await waitForGroupExit(groupPid, firstGrace)) return;
  // Одна рассылка — не гарантия: процесс мог появиться в группе уже во время неё
  // (fork ровно в момент сигнала). Повторный SIGKILL ловит такого, когда форкать уже некому.
  signalProcessGroup(groupPid, "SIGKILL");
  await waitForGroupExit(groupPid, KILL_GRACE_MS);
}

// Модель иногда угадывает cwd (например /root/... вместо реального HOME или несуществующий
// /workspace) — exec тогда падает сырым EACCES/ENOENT ещё до запуска команды, и агент строит
// неверные выводы (см. issue #17). Разворачиваем ~ и проверяем директорию ДО exec, чтобы вернуть
// понятную диагностику вместо низкоуровневого сбоя Node.
// /workspace намеренно НЕ маппим на корень проекта — молчаливая догадка хуже ясной ошибки.
export function normalizeCwd(cwd?: string): { cwd?: string; error?: string } {
  if (!cwd || !cwd.trim()) return {}; // exec возьмёт process.cwd()
  let resolved = cwd;
  if (cwd === "~") resolved = homedir();
  else if (cwd.startsWith("~/")) resolved = join(homedir(), cwd.slice(2));
  try {
    if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
  } catch {
    return {
      error:
        `cwd "${cwd}"${resolved !== cwd ? ` → "${resolved}"` : ""}: не существует, не директория ` +
        `или нет доступа. Сервис работает в ${process.cwd()}, HOME=${homedir()}. ` +
        `Повтори без cwd или укажи существующий абсолютный host-путь (не /workspace).`,
    };
  }
  return { cwd: resolved };
}

// Состояние одного запуска команды. Фазы жизни ниже — обычные функции над ним:
// раньше это были замыкания одного Promise, и каждая тянула весь вызов целиком.
type CommandRun = {
  resolve: (result: BashResult) => void;
  runCwd: string;
  abortSignal: AbortSignal | undefined;
  onAbort: () => void;
  childPid: number;
  childStdout: Readable;
  childStderr: Readable;
  deadlineNs: bigint;
  deadlineState: Int32Array;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
  commandExited: boolean;
  pipesDone: boolean;
  cleanupDone: boolean;
  settled: boolean;
  cleanup: Promise<void> | null;
  pipeDrainTimer: ReturnType<typeof setTimeout> | undefined;
  timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  workerFailure: string | null;
  initialized: boolean;
};

// Дедлайн уже сработал — исход остаётся таймаутом: отмена его задним числом не переписывает.
function deadlineFired(run: CommandRun): boolean {
  const state = Atomics.load(run.deadlineState, 0);
  return state === DEADLINE_EXPIRED || state === DEADLINE_PROBE_FAILED;
}

function spawnFailureResult(error: unknown, cwd: string): BashResult {
  const detail = error instanceof Error ? error.message : String(error);
  const failure = truncate(`Не удалось запустить shell: ${detail}`);
  return {
    stdout: "",
    stderr: failure.text,
    exitCode: 1,
    cwd,
    truncated: failure.truncated || undefined,
  };
}

function appendChunk(
  run: CommandRun,
  chunk: string,
  stream: "stdout" | "stderr",
): void {
  const next = truncate(run[stream] + chunk);
  if (next.truncated) run.outputTruncated = true;
  run[stream] = next.text;
}

function appendNotice(run: CommandRun, text: string): void {
  appendChunk(run, `${run.stderr ? "\n" : ""}${text}`, "stderr");
}

function cancelDeadline(run: CommandRun): void {
  if (
    Atomics.compareExchange(
      run.deadlineState,
      0,
      DEADLINE_ARMED,
      DEADLINE_CANCELLED,
    ) === DEADLINE_ARMED
  ) {
    Atomics.notify(run.deadlineState, 0);
  }
}

// Дедлайн снят вместе с наблюдением за ним: дальше исход решает только сама команда.
function observeDeadlineExpiry(run: CommandRun): void {
  cancelDeadline(run);
  run.timedOut ||= Atomics.load(run.deadlineState, 0) === DEADLINE_EXPIRED;
}

function buildRunResult(run: CommandRun): BashResult {
  if (run.cancelled) return cancelledResult(run);
  const deadlineResult = Atomics.load(run.deadlineState, 0);
  run.timedOut ||= deadlineResult === DEADLINE_EXPIRED;
  if (deadlineResult === DEADLINE_PROBE_FAILED) {
    appendNotice(
      run,
      "Не удалось проверить состояние shell на дедлайне; группа процессов остановлена.",
    );
    run.exitCode = 1;
  }
  // Worker не поднялся — дедлайн держал таймер главного потока. Если он всё-таки
  // сработал, причину видит тот, кто читает исход: тихо проглотить её нельзя.
  if (
    run.workerFailure &&
    (run.timedOut || deadlineResult === DEADLINE_PROBE_FAILED)
  )
    appendNotice(run, `deadline worker не поднялся: ${run.workerFailure}`);
  return {
    stdout: run.stdout,
    stderr: run.stderr,
    exitCode: run.exitCode,
    cwd: run.runCwd,
    truncated: run.outputTruncated || undefined,
    timedOut: run.timedOut || undefined,
  };
}

function finishRun(run: CommandRun): void {
  if (run.settled || !run.commandExited || !run.pipesDone || !run.cleanupDone)
    return;
  run.settled = true;
  // Слушатель живёт ровно столько, сколько живёт вызов.
  run.abortSignal?.removeEventListener("abort", run.onAbort);
  if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
  if (run.pipeDrainTimer) clearTimeout(run.pipeDrainTimer);
  run.resolve(buildRunResult(run));
}

function startCleanup(run: CommandRun, immediate = false): Promise<void> {
  if (run.cleanup) return run.cleanup;
  run.cleanup = reapProcessGroup(run.childPid, { immediate })
    .catch(() => {})
    .finally(() => {
      run.cleanupDone = true;
      if (!run.pipesDone) {
        run.pipeDrainTimer = setTimeout(() => {
          run.childStdout.destroy();
          run.childStderr.destroy();
          run.pipesDone = true;
          finishRun(run);
        }, PIPE_DRAIN_GRACE_MS);
      }
      finishRun(run);
    });
  return run.cleanup;
}

// Отмена хода: потолок времени команды больше не при чём, группу убивает именно стоп.
// Корень, который успел выйти сам, задним числом отменённым не считается — иначе
// обычный результат переписывался бы на "cancelled" после каждого быстрого выхода.
// Периметр отмены — группа процессов команды: процесс, ушедший через setsid в свою
// сессию, её переживает, и стоп его не ищет.
function abortRun(run: CommandRun): void {
  if (run.commandExited || deadlineFired(run)) return;
  run.cancelled = true;
  cancelDeadline(run);
  void startCleanup(run, true).then(() => finishRun(run));
}

function settleOnExit(run: CommandRun, code: number | null): void {
  run.commandExited = true;
  run.exitCode = typeof code === "number" ? code : 1;
  observeDeadlineExpiry(run);
  void startCleanup(run).then(() => finishRun(run));
}

function settleOnClose(run: CommandRun): void {
  run.pipesDone = true;
  if (run.pipeDrainTimer) clearTimeout(run.pipeDrainTimer);
  observeDeadlineExpiry(run);
  void startCleanup(run);
  finishRun(run);
}

function handleChildError(run: CommandRun, error: Error): void {
  if (!run.initialized) {
    run.resolve(spawnFailureResult(error, run.runCwd));
    return;
  }
  appendChunk(run, error.message, "stderr");
  run.commandExited = true;
  run.cleanupDone = true;
  run.pipesDone = true;
  cancelDeadline(run);
  finishRun(run);
}

function markDeadlineProbeFailed(run: CommandRun): void {
  if (
    Atomics.compareExchange(
      run.deadlineState,
      0,
      DEADLINE_ARMED,
      DEADLINE_PROBE_FAILED,
    ) === DEADLINE_ARMED
  ) {
    Atomics.notify(run.deadlineState, 0);
  }
}

function markDeadlineExpired(run: CommandRun): boolean {
  if (
    Atomics.compareExchange(
      run.deadlineState,
      0,
      DEADLINE_ARMED,
      DEADLINE_EXPIRED,
    ) !== DEADLINE_ARMED
  )
    return false;
  Atomics.notify(run.deadlineState, 0);
  return true;
}

function enforceDeadline(run: CommandRun): void {
  const remainingNs = run.deadlineNs - process.hrtime.bigint();
  if (remainingNs > 0n) {
    run.timeoutTimer = setTimeout(
      () => enforceDeadline(run),
      Number((remainingNs + 999_999n) / 1_000_000n),
    );
    return;
  }
  if (run.commandExited) return;
  const deadlineResult = Atomics.load(run.deadlineState, 0);
  if (deadlineResult === DEADLINE_EXPIRED) {
    run.timedOut = true;
    void startCleanup(run);
    return;
  }
  if (deadlineResult === DEADLINE_PROBE_FAILED) {
    void startCleanup(run);
    return;
  }
  const observedRootState = rootProcessState(run.childPid);
  if (observedRootState === "exited") {
    cancelDeadline(run);
    void startCleanup(run);
    return;
  }
  if (observedRootState === "unknown") {
    markDeadlineProbeFailed(run);
    void startCleanup(run);
    return;
  }
  if (markDeadlineExpired(run)) {
    run.timedOut = true;
    void startCleanup(run);
  }
}

// A per-call Worker owns the deadline signal: setTimeout shares the agent's event loop,
// and a synchronous tool or native call can block that loop past the deadline.
function startDeadlineWorker(run: CommandRun): void {
  try {
    const deadlineWorker = deadlineWorkerRuntime.create({
      eval: true,
      workerData: {
        state: run.deadlineState.buffer,
        pid: run.childPid,
        deadlineNs: run.deadlineNs,
        termGraceMs: TERM_GRACE_MS,
        killGraceMs: KILL_GRACE_MS,
        pollMs: REAP_POLL_MS,
      },
    });
    // An asynchronous Worker failure leaves the already-armed main-thread
    // deadline and process lifecycle handlers in charge.
    deadlineWorker.on("error", () => {});
    deadlineWorker.unref();
  } catch (error) {
    // Исчерпание ресурсов: вместо Worker дедлайн держит таймер главного потока,
    // пока тот отвечает. Причина не теряется — её получает исход вызова.
    run.workerFailure = error instanceof Error ? error.message : String(error);
  }
}

function createCommandRun(input: {
  resolve: (result: BashResult) => void;
  child: ReturnType<typeof spawn>;
  runCwd: string;
  timeout: number;
  abortSignal: AbortSignal | undefined;
}): CommandRun | null {
  const { resolve, child, runCwd, timeout, abortSignal } = input;
  const childPid = child.pid;
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (childPid === undefined || !childStdout || !childStderr) return null;
  const run: CommandRun = {
    resolve,
    runCwd,
    abortSignal,
    onAbort: () => abortRun(run),
    childPid,
    childStdout,
    childStderr,
    deadlineNs: process.hrtime.bigint() + BigInt(timeout) * 1_000_000n,
    deadlineState: new Int32Array(
      new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT),
    ),
    stdout: "",
    stderr: "",
    outputTruncated: false,
    exitCode: 1,
    timedOut: false,
    cancelled: false,
    commandExited: false,
    pipesDone: false,
    cleanupDone: false,
    settled: false,
    cleanup: null,
    pipeDrainTimer: undefined,
    timeoutTimer: undefined,
    workerFailure: null,
    initialized: false,
  };
  childStdout.setEncoding("utf8");
  childStderr.setEncoding("utf8");
  childStdout.on("data", (chunk: string) => appendChunk(run, chunk, "stdout"));
  childStderr.on("data", (chunk: string) => appendChunk(run, chunk, "stderr"));
  return run;
}

export default defineTool({
  description:
    "Shell-команда на хосте (без sandbox), в bash (/bin/sh, если bash нет): " +
    "возвращает { stdout, stderr, exitCode }, " +
    "вывод обрезается до последних ~30000 символов каждого потока.",
  inputSchema: z.object({
    command: z.string().min(1).describe("Shell-команда"),
    cwd: z
      .string()
      .optional()
      .describe("Абсолютный host-путь; ~ → HOME; /workspace нет."),
    timeoutMs: z
      .number()
      .int()
      .min(
        MIN_TIMEOUT_MS,
        `timeoutMs должен быть не меньше ${MIN_TIMEOUT_MS} ms`,
      )
      .max(
        MAX_TIMEOUT_MS,
        `timeoutMs должен быть не больше ${MAX_TIMEOUT_MS} ms`,
      )
      .optional()
      .describe(
        `Таймаут, мс: ${MIN_TIMEOUT_MS}…${MAX_TIMEOUT_MS} (по умолчанию 120000)`,
      ),
  }),
  async execute({ command, cwd, timeoutMs }, ctx) {
    const timeout = timeoutMs ?? 120_000;
    if (
      !Number.isSafeInteger(timeout) ||
      timeout < MIN_TIMEOUT_MS ||
      timeout > MAX_TIMEOUT_MS
    ) {
      return {
        stdout: "",
        stderr:
          `timeoutMs должен быть целым числом от ${MIN_TIMEOUT_MS} до ` +
          `${MAX_TIMEOUT_MS} ms.`,
        exitCode: 1,
      };
    }
    const norm = normalizeCwd(cwd);
    if (norm.error) return { stdout: "", stderr: norm.error, exitCode: 1 };
    const runCwd = norm.cwd ?? process.cwd();
    return await new Promise<BashResult>((resolve) => {
      const abortSignal = ctx?.abortSignal;
      // Ход может быть отменён и до этой команды: тогда процесс не запускаем вовсе,
      // а не убиваем уже стартовавший.
      const preAborted = cancelledBeforeStart(abortSignal, runCwd);
      if (preAborted) {
        resolve(preAborted);
        return;
      }
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, {
          cwd: runCwd,
          env: { ...process.env, IVA_AGENT_TURN: "1" },
          shell: COMMAND_SHELL,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolve(spawnFailureResult(error, runCwd));
        return;
      }
      const run = createCommandRun({
        resolve,
        child,
        runCwd,
        timeout,
        abortSignal,
      });
      if (!run) {
        // Спавн не отдал ни PID, ни потоков (EMFILE и родственное): о сбое сообщает
        // асинхронное событие error, и его обязан кто-то слушать.
        child.once("error", (error) =>
          resolve(spawnFailureResult(error, runCwd)),
        );
        return;
      }
      child.once("error", (error) => handleChildError(run, error));
      child.once("exit", (code) => settleOnExit(run, code));
      child.once("close", () => settleOnClose(run));
      run.initialized = true;
      run.timeoutTimer = setTimeout(() => enforceDeadline(run), timeout);
      if (abortSignal) {
        // Ход мог быть отменён между проверкой выше и этой подпиской:
        // addEventListener на уже отменённом сигнале не сработает.
        abortSignal.addEventListener("abort", run.onAbort, { once: true });
        if (abortSignal.aborted) run.onAbort();
      }
      startDeadlineWorker(run);
    });
  },
});
