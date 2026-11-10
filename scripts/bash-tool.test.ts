/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { getEventListeners } from "node:events";
import { z } from "zod";

const {
  default: bash,
  deadlineWorkerRuntime,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  normalizeCwd,
  selectCommandShell,
} = await import("../agent/tools/bash.ts");

type BashInput = Parameters<typeof bash.execute>[0];
type BashResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd?: string;
  truncated?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
};

type BashTurnContext = { abortSignal: AbortSignal };

async function executeBash(
  input: BashInput,
  ctx?: BashTurnContext,
): Promise<BashResult> {
  return await (
    bash.execute as unknown as (
      input: BashInput,
      ctx?: BashTurnContext,
    ) => Promise<BashResult>
  )(input, ctx);
}

const inputSchema = bash.inputSchema;
assert.ok(inputSchema instanceof z.ZodType);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const HAS_SETSID =
  spawnSync("sh", ["-c", "command -v setsid"], { stdio: "ignore" }).status ===
  0;

function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function readPid(file: string): number | null {
  if (!existsSync(file)) return null;
  const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

// «Нашего процесса здесь уже нет»: ESRCH — номера никто не держит; EPERM — номер занят
// чужим процессом (наш исчез, а чужой нам не подчиняется). То же правило и для группы:
// спрашиваем её отрицательным PID. Всё остальное — неожиданность, её не глотаем.
function isGone(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error))
    return false;
  return error.code === "ESRCH" || error.code === "EPERM";
}

function isAlive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isGone(error)) return false;
    throw error;
  }
}

function killIfAlive(
  pid: number | null | undefined,
  signal: NodeJS.Signals,
  processGroup = false,
): void {
  if (!isAlive(pid)) return;
  assert.ok(pid !== null && pid !== undefined);
  process.kill(processGroup ? -pid : pid, signal);
}

function isBashResult(value: unknown): value is BashResult {
  if (value === null || typeof value !== "object") return false;
  return (
    "stdout" in value &&
    typeof value.stdout === "string" &&
    "stderr" in value &&
    typeof value.stderr === "string" &&
    "exitCode" in value &&
    typeof value.exitCode === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

async function waitForPid(file: string, timeoutMs = 500): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPid(file);
    if (pid !== null) return pid;
    await delay(10);
  }
  assert.fail(`child did not write its PID to ${file}`);
}

// Собственная группа команды проверяется отрицательным PID: так тест видит
// именно тот периметр, который обязан умереть, а не один корневой процесс.
function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    if (isGone(error)) return false;
    throw error;
  }
}

// Дети корневого shell нужны ДО убийства группы: после её смерти они
// переподчиняются init, и найти их по родителю уже нечем.
function pidsWithParent(parentPid: number): number[] {
  const result = spawnSync("pgrep", ["-P", String(parentPid)], {
    encoding: "utf8",
  });
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 1);
}

// Команда не отдала PID — ищем её по уникальному пути из её же командной строки:
// брошенный ребёнок держал бы тестовый процесс живым до собственного таймаута.
function killByCommandFragment(fragment: string): void {
  const found = spawnSync("pgrep", ["-f", fragment], { encoding: "utf8" });
  for (const line of (found.stdout ?? "").split("\n")) {
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 1) killIfAlive(pid, "SIGKILL", true);
  }
}

async function waitForFile(file: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await delay(10);
  }
  assert.fail(`file ${file} was never written`);
}

async function waitForChildren(
  parentPid: number,
  count: number,
  timeoutMs = 2_000,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = pidsWithParent(parentPid);
    if (pids.length >= count) return pids;
    await delay(10);
  }
  assert.fail(`root shell ${parentPid} did not start ${count} children`);
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(20);
  }
  return !isAlive(pid);
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runWithExhaustedFileDescriptors(): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  const script = String.raw`
    import { closeSync, openSync } from "node:fs";
    const { default: bash } = await import("./agent/tools/bash.ts");
    const descriptors = [];
    try {
      while (true) descriptors.push(openSync("/dev/null", "r"));
    } catch (error) {
      if (error?.code !== "EMFILE") throw error;
    }
    let result;
    try {
      result = await bash.execute({ command: ":", timeoutMs: 1_000 });
    } finally {
      for (const descriptor of descriptors) closeSync(descriptor);
    }
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawn(
    "bash",
    [
      "-c",
      'ulimit -n 64; exec "$1" --input-type=module -e "$2"',
      "bash",
      process.execPath,
      script,
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { stdout, stderr, exitCode };
}

function termResistantCommand(
  pidFile: string,
  {
    asChild = false,
    detachIo = false,
  }: { asChild?: boolean; detachIo?: boolean } = {},
): string {
  const redirect = detachIo ? " </dev/null >/dev/null 2>&1" : "";
  const processCommand =
    `trap '' TERM HUP; printf '%s\\n' "$$" > ${shellQuote(pidFile)}; ` +
    `exec sleep 3600${redirect}`;
  if (!asChild) return processCommand;
  // Keep exec's /bin/sh as the timed process and make the TERM-resistant process
  // its child. A timeout must reap the whole tree, not only this outer shell.
  return `bash -c ${shellQuote(processCommand)} & wait`;
}

function escapedProcessGroupCommand(
  pidFile: string,
  {
    detachIo = false,
    wait = false,
  }: { detachIo?: boolean; wait?: boolean } = {},
): string {
  const redirect = detachIo ? " </dev/null >/dev/null 2>&1" : "";
  const escaped =
    `trap '' TERM HUP; printf '%s\\n' "$$" > ${shellQuote(pidFile)}; ` +
    "exec sleep 3600";
  return (
    `setsid sh -c ${shellQuote(escaped)}${redirect} & ` +
    `while [ ! -s ${shellQuote(pidFile)} ]; do sleep 0.01; done` +
    (wait ? "; wait" : "")
  );
}

function startFakeManager(requestFile: string, pidFile: string): () => void {
  let managed: ChildProcess | null = null;
  const poll = setInterval(() => {
    if (managed || !existsSync(requestFile)) return;
    managed = spawn("sleep", ["3600"], {
      detached: true,
      stdio: "ignore",
      // A manager starts the unit in its own process group.
      env: { PATH: process.env.PATH },
    });
    managed.unref();
    writeFileSync(pidFile, `${managed.pid}\n`);
  }, 5);
  return () => {
    clearInterval(poll);
    killIfAlive(managed?.pid, "SIGKILL");
  };
}

// Живость проверяется отрицательным PID, и под нагрузкой ядро отвечает EPERM: номер
// переиспользован чужим процессом — значит, нашей группы с ним уже нет. Неожиданную
// ошибку глотать нельзя: иначе проверка молча считала бы живую группу мёртвой.
test("a foreign owner of the group id counts as a dead group, other errors are thrown", () => {
  assert.equal(isGone({ code: "EPERM" }), true);
  assert.equal(isGone({ code: "ESRCH" }), true);
  assert.equal(isGone({ code: "EINVAL" }), false);
  assert.equal(isGone(new Error("boom")), false);
  assert.throws(() => isGroupAlive(Number.MAX_SAFE_INTEGER));
});

test("normalizeCwd expands ~ and names a bad directory before exec", () => {
  // Пусто или не задан — без cwd и без ошибки: exec возьмёт process.cwd().
  assert.deepEqual(normalizeCwd(undefined), {});
  assert.deepEqual(normalizeCwd(""), {});
  assert.deepEqual(normalizeCwd("   "), {});
  assert.equal(normalizeCwd("~").cwd, homedir());
  assert.equal(normalizeCwd("~/").cwd, homedir());
  assert.deepEqual(normalizeCwd(tmpdir()), { cwd: tmpdir() });

  const missing = normalizeCwd("/workspace/definitely-missing-xyz");
  assert.equal(missing.cwd, undefined);
  assert.match(missing.error ?? "", /не существует/);
  assert.ok(missing.error?.includes(process.cwd()));

  const file = normalizeCwd(import.meta.filename);
  assert.equal(file.cwd, undefined);
  assert.ok(file.error);
});

test("bash preserves stdout, stderr and the effective cwd", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "iva-bash-normal-"));
  try {
    const result = await executeBash({
      command: "printf stdout; printf stderr >&2",
      cwd,
      timeoutMs: 1_000,
    });
    assert.deepEqual(result, {
      stdout: "stdout",
      stderr: "stderr",
      exitCode: 0,
      cwd,
      truncated: undefined,
      timedOut: undefined,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bash executes bash-specific syntax", async (t) => {
  if (!existsSync("/bin/bash")) {
    t.skip("/bin/bash is unavailable on this machine");
    return;
  }
  const cases = [
    ["[[ a == a ]] && echo ok", "ok\n"],
    ["cat <(echo x)", "x\n"],
    ['x=(a b); echo "${x[1]}"', "b\n"],
    ['v=aXb; echo "${v//X/-}"', "a-b\n"],
    ["cat <<< hi", "hi\n"],
    ["echo ok &> /dev/null; echo done", "done\n"],
  ] as const;
  for (const [command, stdout] of cases) {
    const result = await executeBash({ command, timeoutMs: 1_000 });
    assert.equal(result.exitCode, 0, command);
    assert.equal(result.stdout, stdout, command);
  }
});

test("shell selection falls back to the platform shell", () => {
  assert.equal(
    selectCommandShell((path) => path === "/bin/bash"),
    "/bin/bash",
  );
  assert.equal(
    selectCommandShell((path) => path === "/usr/bin/bash"),
    "/usr/bin/bash",
  );
  assert.equal(
    selectCommandShell(() => false),
    true,
  );
  const script = String.raw`
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const realExists = fs.existsSync;
    fs.existsSync = (path) =>
      path === "/bin/bash" || path === "/usr/bin/bash"
        ? false
        : realExists(path);
    syncBuiltinESMExports();
    const { default: bash } = await import("./agent/tools/bash.ts?fallback-shell-test");
    const result = await bash.execute({ command: "echo ok", timeoutMs: 1_000 });
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout) as BashResult;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok\n");
});

test("bash preserves an ordinary non-zero shell exit code", async () => {
  const result = await executeBash({
    command: "printf failed >&2; exit 7",
    timeoutMs: 1_000,
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "failed");
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, undefined);
});

test("bash input schema rejects deadlines below the documented floor", () => {
  assert.equal(MIN_TIMEOUT_MS, 100);
  const rejected = inputSchema.safeParse({
    command: ":",
    timeoutMs: MIN_TIMEOUT_MS - 1,
  });
  assert.equal(rejected.success, false);
  assert.match(rejected.error.issues[0].message, /100 ms/);
  assert.equal(
    inputSchema.safeParse({ command: ":", timeoutMs: MIN_TIMEOUT_MS }).success,
    true,
  );
});

test("bash input schema enforces Node's maximum timer delay", () => {
  assert.equal(MAX_TIMEOUT_MS, 2_147_483_647);
  const rejected = inputSchema.safeParse({
    command: ":",
    timeoutMs: MAX_TIMEOUT_MS + 1,
  });
  assert.equal(rejected.success, false);
  assert.match(rejected.error.issues[0].message, /2147483647 ms/);
  assert.equal(
    inputSchema.safeParse({ command: ":", timeoutMs: MAX_TIMEOUT_MS }).success,
    true,
  );
});

test("direct execute rejects a deadline below the floor before spawning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-timeout-floor-"));
  const marker = join(dir, "spawned");
  try {
    const result = await executeBash({
      command: `: > ${shellQuote(marker)}`,
      timeoutMs: MIN_TIMEOUT_MS - 1,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /timeoutMs.*100.*2147483647 ms/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("direct execute rejects a deadline above Node's timer limit before spawning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-timeout-ceiling-"));
  const marker = join(dir, "spawned");
  try {
    const result = await executeBash({
      command: `: > ${shellQuote(marker)}`,
      timeoutMs: MAX_TIMEOUT_MS + 1,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /timeoutMs.*100.*2147483647 ms/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawn resource failure returns a bounded result without an unhandled error", async () => {
  const child = await within(
    runWithExhaustedFileDescriptors(),
    3_000,
    "EMFILE regression process did not settle",
  );
  assert.equal(child.exitCode, 0, child.stderr);
  const result: unknown = JSON.parse(child.stdout);
  assert.ok(isBashResult(result));
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /EMFILE|too many open files/i);
  assert.equal(result.stderr.length <= 30_000, true);
});

test("worker initialization failure falls back without orphaning the child group", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-worker-init-"));
  const pidFile = join(dir, "shell.pid");
  t.mock.method(deadlineWorkerRuntime, "create", () => {
    throw new Error("injected Worker initialization failure");
  });
  const execution = executeBash({
    command: `printf '%s\\n' "$$" > ${shellQuote(pidFile)}; sleep 3600`,
    timeoutMs: MIN_TIMEOUT_MS,
  });
  let pid: number | null = null;
  try {
    pid = await waitForPid(pidFile);
    const result = await within(
      execution,
      1_800,
      "main-thread deadline fallback did not settle after Worker init failure",
    );
    assert.equal(result.timedOut, true);
    // Причина снятого Worker доходит до исхода, а не теряется в catch.
    assert.match(
      result.stderr,
      /deadline worker не поднялся: injected Worker initialization failure/,
    );
    assert.equal(await waitUntilGone(pid, 1_500), true);
  } finally {
    pid ??= readPid(pidFile);
    killIfAlive(pid, "SIGKILL", true);
    await execution.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a delayed exit event does not turn an already-exited command into a timeout", async () => {
  const execution = executeBash({ command: "exit 7", timeoutMs: 100 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  const result = await within(
    execution,
    1_800,
    "delayed exit event did not settle",
  );
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, undefined);
});

test("portable deadline probe recognizes an exited root while the main loop is blocked", async (t) => {
  // Preserve the original unbound factory call; the worker implementation does
  // not consume `this`, and this test intentionally exercises that exact path.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const createWorker = deadlineWorkerRuntime.create;
  t.mock.method(
    deadlineWorkerRuntime,
    "create",
    (options: Parameters<typeof deadlineWorkerRuntime.create>[0]) => {
      assert.ok(options !== undefined);
      const workerData: unknown = options.workerData;
      assert.ok(isRecord(workerData));
      return createWorker({
        ...options,
        workerData: {
          ...workerData,
          forcePortableProbe: true,
        },
      });
    },
  );
  const execution = executeBash({
    command: "exit 7",
    timeoutMs: MIN_TIMEOUT_MS,
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  const result = await within(
    execution,
    1_800,
    "portable deadline probe did not settle",
  );
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, undefined);
});

test("minimum deadline is enforced while the Node event loop is blocked", async () => {
  const execution = executeBash({
    command: "sleep 0.2; printf completed",
    timeoutMs: MIN_TIMEOUT_MS,
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  const result = await within(
    execution,
    1_800,
    "blocked event loop disabled the deadline",
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.stdout.includes("completed"), false);
});

test("deadline checks the root PID rather than a surviving process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-root-pid-"));
  const pidFile = join(dir, "child.pid");
  const command =
    `${termResistantCommand(pidFile)} & ` +
    `while [ ! -s ${shellQuote(pidFile)} ]; do sleep 0.01; done; exit 7`;
  // The deadline only has to outlast starting a shell and its background child -
  // a loaded machine can take a while over that, and the point of the test is
  // which process the deadline watches, not how fast the box is.
  const execution = executeBash({ command, timeoutMs: 3_000 });
  let pid: number | null = null;
  try {
    const pidDeadline = Date.now() + 3_000;
    // `>` creates the file before printf fills it: wait for a parsable PID, not the file.
    while ((pid = readPid(pidFile)) === null && Date.now() < pidDeadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    assert.ok(pid !== null, "background child did not write its PID");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    const result = await within(
      execution,
      6_000,
      "root PID deadline check did not settle",
    );
    // The sleeping child outlives the root shell: if the deadline watched the
    // process group instead, this execution would have timed out rather than
    // reporting the root's own exit code.
    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, undefined);
    assert.equal(await waitUntilGone(pid, 3_000), true);
  } finally {
    pid ??= readPid(pidFile);
    killIfAlive(pid, "SIGKILL");
    await within(
      execution.catch(() => {}),
      1_000,
      "root PID execution did not settle",
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closing fd 4 cannot crash bash execution or change its exit code", async () => {
  const result = await within(
    executeBash({ command: "exec 4<&-; exit 9", timeoutMs: 1_000 }),
    1_800,
    "closing fd 4 prevented bash execution from settling",
  );
  assert.equal(result.exitCode, 9);
  assert.equal(result.timedOut, undefined);
});

test("closing fd 3 cannot turn a normal exit into a timeout", async () => {
  const result = await within(
    executeBash({ command: "exec 3>&-; exit 0", timeoutMs: 1_000 }),
    1_800,
    "closing fd 3 prevented bash execution from settling",
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, undefined);
});

test("writing to fd 3 cannot disable the command deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-fd-spoof-"));
  const pidFile = join(dir, "shell.pid");
  const execution = executeBash({
    command:
      `printf '%s\\n' "$$" > ${shellQuote(pidFile)}; ` +
      "(printf x >&3) 2>/dev/null || :; while :; do :; done",
    timeoutMs: 100,
  });
  let pid: number | null = null;
  try {
    pid = await waitForPid(pidFile);
    const result = await within(
      execution,
      1_800,
      "writing to fd 3 disabled the command deadline",
    );
    assert.equal(result.timedOut, true);
  } finally {
    pid ??= readPid(pidFile);
    killIfAlive(pid, "SIGKILL", true);
    await within(
      execution.catch(() => {}),
      1_000,
      "fd spoof execution did not settle",
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash closes stdin so a command waiting for input receives EOF", async () => {
  const result = await executeBash({
    command:
      "if IFS= read -r line; then printf unexpected; else printf stdin-closed; fi",
    timeoutMs: 1_000,
  });
  assert.equal(result.stdout, "stdin-closed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, undefined);
});

test("bash preserves the last 30000 characters of each output stream", async () => {
  const script =
    `process.stdout.write("prefix-" + "o".repeat(30000));` +
    `process.stderr.write("prefix-" + "e".repeat(30000));`;
  const result = await executeBash({
    command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
    timeoutMs: 1_000,
  });
  assert.equal(result.stdout, "o".repeat(30_000));
  assert.equal(result.stderr, "e".repeat(30_000));
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.timedOut, undefined);
});

test("normal calls do not accumulate cleanup timers", async () => {
  const timeoutHandles = () =>
    process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;
  const before = timeoutHandles();
  const started = Date.now();
  for (let index = 0; index < 3; index++) {
    const result = await executeBash({ command: ":", timeoutMs: 1_000 });
    assert.equal(result.exitCode, 0);
  }
  await delay(50);
  assert.equal(
    timeoutHandles() <= before,
    true,
    "completed bash calls leaked cleanup timers",
  );
  assert.equal(
    Date.now() - started < 1_800,
    true,
    "normal calls performed unbounded cleanup work",
  );
});

test("timeout resolves within two seconds when a child ignores SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-term-"));
  const pidFile = join(dir, "child.pid");
  const execution = executeBash({
    command: termResistantCommand(pidFile),
    timeoutMs: 100,
  });
  let pid: number | null = null;
  try {
    pid = await waitForPid(pidFile);
    const result = await within(
      execution,
      1_800,
      "bash timeout did not resolve within 1800ms for a TERM-resistant child",
    );
    assert.equal(result.timedOut, true);
  } finally {
    pid ??= readPid(pidFile);
    killIfAlive(pid, "SIGKILL");
    await within(
      execution.catch(() => {}),
      1_000,
      "bash execution did not settle after test cleanup",
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normal shell exit reaps a background TERM-resistant descendant in its group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-normal-reap-"));
  const pidFile = join(dir, "child.pid");
  const command = `${termResistantCommand(pidFile)} &`;
  let pid: number | null = null;
  try {
    const result = await within(
      executeBash({ command, timeoutMs: 1_000 }),
      1_800,
      "bash did not settle after a normal shell exit with a background child",
    );
    pid = await waitForPid(pidFile);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, undefined);
    assert.equal(
      await waitUntilGone(pid, 1_500),
      true,
      `background child PID ${pid} survived its parent shell`,
    );
  } finally {
    pid ??= readPid(pidFile);
    killIfAlive(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("descendant cleanup after a normal shell exit does not report a timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-normal-deadline-"));
  const pidFile = join(dir, "child.pid");
  const command = `${termResistantCommand(pidFile, { detachIo: true })} &`;
  let pid: number | null = null;
  try {
    const result = await within(
      executeBash({ command, timeoutMs: 100 }),
      1_800,
      "bash did not settle after cleanup crossed the command deadline",
    );
    pid = await waitForPid(pidFile);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, undefined);
    assert.equal(
      await waitUntilGone(pid, 1_500),
      true,
      `background child PID ${pid} survived cleanup after its parent exited`,
    );
  } finally {
    pid ??= readPid(pidFile);
    killIfAlive(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "a setsid process outside the owned group cannot hold result pipes open",
  {
    skip: !HAS_SETSID,
  },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "iva-bash-setsid-bounded-"));
    const pidFile = join(dir, "child.pid");
    let pid: number | null = null;
    try {
      const result = await within(
        executeBash({
          command: escapedProcessGroupCommand(pidFile),
          timeoutMs: 1_000,
        }),
        1_800,
        "a process outside the owned group held inherited output pipes open",
      );
      pid = await waitForPid(pidFile);
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, undefined);
      assert.equal(
        isAlive(pid),
        true,
        "setsid must place the process outside the owned group",
      );
    } finally {
      pid ??= readPid(pidFile);
      killIfAlive(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "timeout settles when a setsid process outside the owned group inherits output pipes",
  {
    skip: !HAS_SETSID,
  },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "iva-bash-setsid-timeout-"));
    const pidFile = join(dir, "child.pid");
    const execution = executeBash({
      command: escapedProcessGroupCommand(pidFile, { wait: true }),
      timeoutMs: 100,
    });
    let pid: number | null = null;
    try {
      pid = await waitForPid(pidFile);
      const result = await within(
        execution,
        1_800,
        "bash timeout did not settle after a setsid descendant inherited its pipes",
      );
      assert.equal(result.timedOut, true);
      assert.equal(
        isAlive(pid),
        true,
        "setsid must place the process outside the owned group",
      );
    } finally {
      pid ??= readPid(pidFile);
      killIfAlive(pid, "SIGKILL");
      await within(
        execution.catch(() => {}),
        1_000,
        "bash execution did not settle after test cleanup",
      );
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("timeout leaves no TERM-resistant child PID behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-reap-"));
  const pidFile = join(dir, "child.pid");
  const execution = executeBash({
    command: termResistantCommand(pidFile, { asChild: true, detachIo: true }),
    timeoutMs: 100,
  });
  let pid: number | null = null;
  try {
    pid = await waitForPid(pidFile);
    const result = await within(
      execution,
      1_800,
      "bash timeout did not settle",
    );
    assert.equal(result.timedOut, true);
    assert.equal(
      await waitUntilGone(pid, 1_500),
      true,
      `TERM-resistant child PID ${pid} survived the timeout`,
    );
  } finally {
    pid ??= readPid(pidFile);
    killIfAlive(pid, "SIGKILL");
    await execution.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fake-manager process outside the PGID remains outside bash cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-fake-manager-"));
  const requestFile = join(dir, "start.request");
  const pidFile = join(dir, "managed.pid");
  const stopManager = startFakeManager(requestFile, pidFile);
  let pid: number | null = null;
  try {
    const result = await executeBash({
      command:
        `: > ${shellQuote(requestFile)}; ` +
        `while [ ! -s ${shellQuote(pidFile)} ]; do sleep 0.01; done`,
      timeoutMs: 2_000,
    });
    assert.equal(result.exitCode, 0);
    pid = await waitForPid(pidFile);
    assert.equal(
      isAlive(pid),
      true,
      "manager-owned work must outlive the requesting bash client",
    );
  } finally {
    stopManager();
    pid ??= readPid(pidFile);
    killIfAlive(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── отмена хода (ctx.abortSignal) ────────────────────────────────────────────
// Стоп и steer обрывают запрос к модели, а группа процессов команды жила до
// собственного timeoutMs. Эти тесты держат обратное: abort убивает группу сразу
// и отличим от таймаута.

test("an aborted turn kills the whole process group within two seconds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-abort-group-"));
  const pidFile = join(dir, "shell.pid");
  const controller = new AbortController();
  const signal = controller.signal;
  const execution = executeBash(
    {
      command: `printf '%s\\n' "$$" > ${shellQuote(pidFile)}; sleep 300`,
      // Десять минут: без подписки на abort вызов висел бы ровно столько.
      timeoutMs: 600_000,
    },
    { abortSignal: signal },
  );
  let pid: number | null = null;
  try {
    pid = await waitForPid(pidFile);
    controller.abort();
    const result = await within(
      execution,
      2_000,
      "abort did not settle the bash call within two seconds",
    );
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, undefined);
    assert.equal(isAlive(pid), false, `shell PID ${pid} survived the abort`);
    assert.equal(
      isGroupAlive(pid),
      false,
      `process group ${pid} survived the abort`,
    );
    assert.equal(
      getEventListeners(signal, "abort").length,
      0,
      "bash leaked an abort listener after an aborted call",
    );
  } finally {
    pid ??= readPid(pidFile);
    killIfAlive(pid, "SIGKILL", true);
    await within(
      execution.catch(() => {}),
      1_000,
      "aborted bash call did not settle after test cleanup",
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an aborted turn kills a child that ignores SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-abort-term-"));
  const pidFile = join(dir, "child.pid");
  const controller = new AbortController();
  const execution = executeBash(
    { command: termResistantCommand(pidFile), timeoutMs: 600_000 },
    { abortSignal: controller.signal },
  );
  let pid: number | null = null;
  try {
    pid = await waitForPid(pidFile);
    controller.abort();
    const result = await within(
      execution,
      2_000,
      "abort did not settle a TERM-resistant command",
    );
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, undefined);
    assert.equal(
      await waitUntilGone(pid, 1_500),
      true,
      `TERM-resistant PID ${pid} survived the abort`,
    );
    assert.equal(isGroupAlive(pid), false);
  } finally {
    pid ??= readPid(pidFile);
    killIfAlive(pid, "SIGKILL", true);
    await within(
      execution.catch(() => {}),
      1_000,
      "aborted bash call did not settle after test cleanup",
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an aborted turn kills the shell's grandchildren", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-abort-grandchildren-"));
  const pidFile = join(dir, "shell.pid");
  // Форма из спеки: два фоновых сна и wait. Она же проходит гвард T2 -
  // длинный sleep судится только тогда, когда за ним идёт полезная команда.
  const inner =
    `printf '%s\\n' "$$" > ${shellQuote(pidFile)}; ` +
    "sleep 300 & sleep 300 & wait";
  const controller = new AbortController();
  const execution = executeBash(
    { command: `sh -c ${shellQuote(inner)}`, timeoutMs: 600_000 },
    { abortSignal: controller.signal },
  );
  let rootPid: number | null = null;
  let children: number[] = [];
  try {
    rootPid = await waitForPid(pidFile);
    children = await waitForChildren(rootPid, 2);
    controller.abort();
    const result = await within(
      execution,
      2_000,
      "abort did not settle a command with grandchildren",
    );
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, undefined);
    for (const pid of children) {
      assert.equal(
        await waitUntilGone(pid, 1_500),
        true,
        `grandchild PID ${pid} survived the abort`,
      );
    }
    assert.equal(isGroupAlive(rootPid), false);
  } finally {
    rootPid ??= readPid(pidFile);
    for (const pid of children) killIfAlive(pid, "SIGKILL");
    killIfAlive(rootPid, "SIGKILL", true);
    await within(
      execution.catch(() => {}),
      1_000,
      "aborted bash call did not settle after test cleanup",
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an already aborted turn does not start the command at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-abort-before-start-"));
  const marker = join(dir, "spawned");
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await executeBash(
      { command: `: > ${shellQuote(marker)}`, timeoutMs: 1_000 },
      { abortSignal: controller.signal },
    );
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, undefined);
    assert.equal(result.exitCode, 1);
    assert.equal(
      existsSync(marker),
      false,
      "an aborted turn still spawned the command",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a finished command keeps its result and leaves no abort listener behind", async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  const result = await executeBash(
    { command: "printf done", timeoutMs: 1_000 },
    { abortSignal: signal },
  );
  assert.equal(result.stdout, "done");
  assert.equal(result.exitCode, 0);
  assert.equal(result.cancelled, undefined);
  assert.equal(result.timedOut, undefined);
  assert.equal(
    getEventListeners(signal, "abort").length,
    0,
    "bash leaked an abort listener after a normal exit",
  );
  // Отмена после естественного завершения не переписывает уже отданный результат.
  controller.abort();
  assert.equal(result.cancelled, undefined);
  assert.equal(getEventListeners(signal, "abort").length, 0);
});

test("one shared abort signal cancels concurrent calls without leaking listeners", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-abort-shared-"));
  const pidFiles = [join(dir, "first.pid"), join(dir, "second.pid")];
  const controller = new AbortController();
  const signal = controller.signal;
  const executions = pidFiles.map((pidFile) =>
    executeBash(
      {
        command: `printf '%s\\n' "$$" > ${shellQuote(pidFile)}; sleep 300`,
        timeoutMs: 600_000,
      },
      { abortSignal: signal },
    ),
  );
  let pids: number[] = [];
  try {
    pids = await Promise.all(pidFiles.map((file) => waitForPid(file)));
    // Ход один, значит сигнал один: обе команды подписаны на него.
    assert.equal(getEventListeners(signal, "abort").length, 2);
    controller.abort();
    const results = await within(
      Promise.all(executions),
      2_000,
      "a shared abort did not settle every concurrent call",
    );
    for (const result of results) {
      assert.equal(result.cancelled, true);
      assert.equal(result.timedOut, undefined);
    }
    for (const pid of pids) {
      assert.equal(isGroupAlive(pid), false);
    }
    assert.equal(
      getEventListeners(signal, "abort").length,
      0,
      "concurrent calls leaked abort listeners",
    );
  } finally {
    for (const pid of pids) killIfAlive(pid, "SIGKILL", true);
    await within(
      Promise.all(executions.map((execution) => execution.catch(() => {}))),
      1_000,
      "concurrent aborted bash calls did not settle after test cleanup",
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an aborted turn does not give the command a SIGTERM grace period", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-abort-nograce-"));
  const pidFile = join(dir, "shell.pid");
  const termSeen = join(dir, "term-seen");
  // Команда, которая на вежливый SIGTERM успела бы оставить след: отмена такого
  // шанса не даёт — первым в группу уходит SIGKILL.
  const command =
    `trap 'printf term > ${shellQuote(termSeen)}' TERM; ` +
    `printf '%s\\n' "$$" > ${shellQuote(pidFile)}; ` +
    "sleep 300 & wait";
  const controller = new AbortController();
  const execution = executeBash(
    { command, timeoutMs: 600_000 },
    { abortSignal: controller.signal },
  );
  let pid: number | null = null;
  try {
    pid = await waitForPid(pidFile);
    controller.abort();
    const result = await within(
      execution,
      2_000,
      "abort did not settle a command that traps SIGTERM",
    );
    assert.equal(result.cancelled, true);
    assert.equal(
      existsSync(termSeen),
      false,
      "abort sent SIGTERM before SIGKILL",
    );
    assert.equal(isGroupAlive(pid), false);
  } finally {
    pid ??= readPid(pidFile);
    killIfAlive(pid, "SIGKILL", true);
    await within(
      execution.catch(() => {}),
      1_000,
      "aborted bash call did not settle after test cleanup",
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an abort after the deadline fired leaves the timeout as the outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-abort-after-timeout-"));
  const pidFile = join(dir, "shell.pid");
  const termSeen = join(dir, "term-seen");
  // Команда сама говорит, когда её настиг дедлайн: ловит SIGTERM и остаётся живой,
  // так что отмена падает в окно чистки, которое сторожит никем не убитый корень.
  const script =
    `require("node:fs").writeFileSync(` +
    `${JSON.stringify(pidFile)}, String(process.pid));` +
    `process.on("SIGTERM", () => require("node:fs").writeFileSync(` +
    `${JSON.stringify(termSeen)}, "term"));` +
    `setTimeout(() => {}, 600000);`;
  const controller = new AbortController();
  const execution = executeBash(
    {
      command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
      // Дедлайн заметно длиннее холодного старта node (и под нагрузкой тоже):
      // иначе SIGTERM придёт раньше, чем команда успеет поймать его.
      timeoutMs: 2_000,
    },
    { abortSignal: controller.signal },
  );
  let pid: number | null = null;
  try {
    pid = await waitForPid(pidFile, 3_000);
    // Ждём улику, а не таймер: след от SIGTERM — это и есть сработавший дедлайн.
    await waitForFile(termSeen, 5_000);
    assert.equal(isAlive(pid), true, "the root must still be alive");
    controller.abort();
    const result = await within(
      execution,
      2_000,
      "abort after the deadline did not settle",
    );
    assert.equal(result.cancelled, undefined);
    assert.equal(result.timedOut, true);
  } finally {
    pid ??= readPid(pidFile);
    if (pid === null) killByCommandFragment(pidFile);
    else killIfAlive(pid, "SIGKILL", true);
    await within(
      execution.catch(() => {}),
      1_000,
      "timed-out bash call did not settle after test cleanup",
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cancelled result stays under the output ceiling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-abort-truncate-"));
  const pidFile = join(dir, "shell.pid");
  const script =
    `require("node:fs").writeFileSync(` +
    `${JSON.stringify(pidFile)}, String(process.pid));` +
    `process.stderr.write("e".repeat(30000));` +
    `setTimeout(() => {}, 600000);`;
  const controller = new AbortController();
  const execution = executeBash(
    {
      command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
      timeoutMs: 600_000,
    },
    { abortSignal: controller.signal },
  );
  let pid: number | null = null;
  try {
    pid = await waitForPid(pidFile, 3_000);
    await delay(200); // потолок потока уже набран до отказа
    controller.abort();
    const result = await within(
      execution,
      2_000,
      "abort did not settle a command with full output",
    );
    assert.equal(result.cancelled, true);
    assert.equal(
      result.stderr.length <= 30_000,
      true,
      `cancelled stderr is ${result.stderr.length} characters long`,
    );
    assert.equal(result.truncated, true);
    assert.match(result.stderr, /Команда отменена/);
  } finally {
    pid ??= readPid(pidFile);
    if (pid === null) killByCommandFragment(pidFile);
    else killIfAlive(pid, "SIGKILL", true);
    await within(
      execution.catch(() => {}),
      1_000,
      "aborted bash call did not settle after test cleanup",
    );
    rmSync(dir, { recursive: true, force: true });
  }
});
