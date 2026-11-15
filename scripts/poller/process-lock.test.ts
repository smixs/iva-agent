import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  acquireTelegramProcessLock,
  parseTelegramGuardHolderMarker,
  parseTelegramProcessOwner,
  readProcessStartIdentity,
  TELEGRAM_PROCESS_RESOURCE,
  telegramProcessOwnerIsLive,
} from "./process-lock.ts";
import { parseBacklogDropMarker } from "./startup-state.ts";

const CHILD = join(
  import.meta.dirname,
  "../fixtures/telegram-process-lock-child.ts",
);
const MAIN_GUARD_CHILD = join(
  import.meta.dirname,
  "../fixtures/telegram-main-guard-child.ts",
);
let guardSequence = 0;

type TestGuard = { identity: string; directory: string };
type RunningChild = {
  child: ChildProcess;
  stdout: string;
  stderr: string;
};
type ReadyEvidence = {
  resource: string;
  guardRoot: string;
  lockFile: string;
  guardOwnerFile: string;
  holderPid: number;
};

function makeGuard(root: string, label: string): TestGuard {
  return {
    identity: `${label}-${process.pid}-${++guardSequence}`.slice(0, 64),
    directory: join(root, "guard"),
  };
}

function runningChild(t: TestContext, args: string[]): RunningChild {
  const state: RunningChild = {
    child: spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    }),
    stdout: "",
    stderr: "",
  };
  state.child.stdout?.setEncoding("utf8");
  state.child.stderr?.setEncoding("utf8");
  state.child.stdout?.on("data", (chunk: string) => {
    state.stdout += chunk;
  });
  state.child.stderr?.on("data", (chunk: string) => {
    state.stderr += chunk;
  });
  t.after(() => {
    if (state.child.exitCode === null && state.child.signalCode === null) {
      state.child.kill("SIGKILL");
    }
  });
  return state;
}

function startChild(
  t: TestContext,
  mode: "hold" | "write-on-signal" | "kill-holder",
  dataDir: string,
  guard: TestGuard,
  botId: string,
): RunningChild {
  return runningChild(t, [
    CHILD,
    mode,
    dataDir,
    botId,
    guard.directory,
    guard.identity,
  ]);
}

function startMainChild(
  t: TestContext,
  dataDir: string,
  guard: TestGuard,
  mode = "hang",
): RunningChild {
  return runningChild(t, [
    MAIN_GUARD_CHILD,
    dataDir,
    mode,
    guard.directory,
    guard.identity,
  ]);
}

function readyEvidence(state: RunningChild): ReadyEvidence {
  const line = state.stdout
    .split("\n")
    .find((candidate) => candidate.includes('"event":"READY"'));
  assert.ok(line, `missing READY evidence: ${state.stderr}`);
  return JSON.parse(line) as ReadyEvidence;
}

/**
 * Выход ребёнка ждём по сигналу процесса, а не по стенным часам: под нагрузкой
 * пятисекундный срок истекал на живом ребёнке, который просто ждал планировщика. Таймер
 * здесь — страховка от ребёнка, который не выходит никогда (в проекте нет --test-timeout):
 * тест обязан упасть с его pid, а не висеть до конца прогона.
 */
async function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      const guard = setTimeout(
        () =>
          rejectExit(
            new Error(
              `child ${child.pid} did not exit in ${WAIT_HANG_GUARD_MS}ms`,
            ),
          ),
        WAIT_HANG_GUARD_MS,
      );
      child.once("error", (error) => {
        clearTimeout(guard);
        rejectExit(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(guard);
        resolveExit({ code, signal });
      });
    },
  );
}

/**
 * Потолок ожидания — та же страховка, что у `waitForExit`, а не расписание: живой ребёнок
 * под нагрузкой ждёт планировщика сколько нужно. Там, где конец предиката держит чужая
 * жизнь (внук-холдер, контендер с убитым холдером), без потолка регрессия превращается из
 * красного теста в вечное ожидание: у проекта нет --test-timeout, дефолт node:test —
 * Infinity.
 */
const WAIT_HANG_GUARD_MS = 30_000;

/**
 * Опрос признака (файл-замок, строка READY). Предикат терминален: признак появится или
 * процесс закончится; `what` называет, чего не дождались. Исход проверяет assert рядом с
 * вызовом, потому что только там есть свежий stderr ребёнка.
 */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > WAIT_HANG_GUARD_MS)
      assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

void test("process owner parser requires PID and OS start identity", () => {
  const currentStart = readProcessStartIdentity(process.pid);
  assert.ok(currentStart);
  const owner = {
    schema: "iva-telegram-poll-owner/v2",
    pid: process.pid,
    processStart: currentStart,
    nonce: "a".repeat(32),
  };
  assert.deepEqual(parseTelegramProcessOwner(JSON.stringify(owner)), owner);
  for (const invalid of [
    { ...owner, pid: 0 },
    { ...owner, processStart: "" },
    { ...owner, nonce: "short" },
    { ...owner, extra: true },
  ]) {
    assert.throws(
      () => parseTelegramProcessOwner(JSON.stringify(invalid)),
      /invalid Telegram process owner schema/u,
    );
  }
});

void test("the production holder resource is uid-global and contains no bot, path, or secret", () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  assert.equal(TELEGRAM_PROCESS_RESOURCE, `telegram:${uid}`);
  const holder = {
    schema: "iva-telegram-poll-holder/v2",
    resource: TELEGRAM_PROCESS_RESOURCE,
    pid: process.pid,
    processStart: readProcessStartIdentity(process.pid),
    nonce: "b".repeat(32),
  };
  assert.ok(holder.processStart);
  const marker = `iva-telegram-poll-holder-v2=${Buffer.from(
    JSON.stringify(holder),
  ).toString("base64url")}`;
  assert.deepEqual(parseTelegramGuardHolderMarker(marker), holder);
  const decoded = Buffer.from(marker.split("=")[1], "base64url").toString(
    "utf8",
  );
  assert.equal(decoded.includes("test-token"), false);
  assert.equal(decoded.includes("/private/data"), false);
  assert.deepEqual(Object.keys(JSON.parse(decoded) as object).sort(), [
    "nonce",
    "pid",
    "processStart",
    "resource",
    "schema",
  ]);
});

void test("different bots and DATA_DIR values share one uid-global lease", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-global-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const guard = makeGuard(root, "global");
  const firstData = join(root, "first-data");
  const secondData = join(root, "second-data");
  const contenders = [
    startChild(t, "hold", firstData, guard, "71021"),
    startChild(t, "hold", secondData, guard, "71022"),
  ];
  await waitFor(
    () =>
      contenders.every(
        ({ child, stdout }) =>
          stdout.includes('"event":"READY"') ||
          child.exitCode !== null ||
          child.signalCode !== null,
      ),
    "both global contenders to settle",
  );
  assert.equal(
    contenders.filter(({ stdout }) => stdout.includes('"event":"READY"'))
      .length,
    1,
    `global contenders did not settle: ${contenders.map(({ stderr }) => stderr).join(" | ")}`,
  );
  const winner = contenders.find(({ stdout }) =>
    stdout.includes('"event":"READY"'),
  );
  const loser = contenders.find((candidate) => candidate !== winner);
  assert.ok(winner && loser);
  assert.equal((await waitForExit(loser.child)).code, 1, loser.stderr);
  const evidence = readyEvidence(winner);
  assert.equal(evidence.resource, `test:${guard.identity}`);
  assert.equal(statSync(evidence.guardRoot).mode & 0o777, 0o700);
  assert.equal(statSync(evidence.guardOwnerFile).mode & 0o777, 0o600);
  assert.equal(
    parseTelegramProcessOwner(readFileSync(evidence.guardOwnerFile, "utf8"))
      .pid,
    winner.child.pid,
  );
  const holderCommand = spawnSync(
    "/bin/ps",
    ["-o", "command=", "-p", String(evidence.holderPid)],
    { encoding: "utf8" },
  );
  assert.equal(holderCommand.status, 0, holderCommand.stderr);
  assert.match(holderCommand.stdout, /iva-telegram-poll-holder-v2=/u);
  assert.equal(holderCommand.stdout.includes(firstData), false);
  assert.equal(holderCommand.stdout.includes(secondData), false);
  assert.equal(holderCommand.stdout.includes("test-token"), false);

  const winnerExit = waitForExit(winner.child);
  assert.equal(winner.child.kill("SIGKILL"), true);
  assert.equal((await winnerExit).signal, "SIGKILL");
  let successor: RunningChild | null = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = startChild(t, "hold", secondData, guard, "71023");
    await waitFor(
      () =>
        candidate.stdout.includes('"event":"READY"') ||
        candidate.child.exitCode !== null ||
        candidate.child.signalCode !== null,
      "the successor candidate to settle",
    );
    if (candidate.stdout.includes('"event":"READY"')) {
      successor = candidate;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(successor, "global lease did not recover after parent SIGKILL");
  assert.equal(
    parseTelegramProcessOwner(
      readFileSync(readyEvidence(successor).guardOwnerFile, "utf8"),
    ).pid,
    successor.child.pid,
  );
});

void test("the production default conflicts before I/O regardless of botId or DATA_DIR", async () => {
  const processStart = readProcessStartIdentity(process.pid);
  assert.ok(processStart);
  const observedResources: string[] = [];
  const configuredInstances = [
    { botId: "71041", dataDir: "/state/one" },
    { botId: "71042", dataDir: "/state/two" },
  ];
  await assert.rejects(
    acquireTelegramProcessLock({
      processStartImpl: () => processStart,
      listGuardHoldersImpl: (resource) => {
        observedResources.push(resource);
        return [
          {
            holderPid: 999_001,
            holder: {
              schema: "iva-telegram-poll-holder/v2",
              resource,
              pid: 999_000,
              processStart,
              nonce: "e".repeat(32),
            },
          },
        ];
      },
    }),
    /held by active PID 999000/u,
  );
  assert.deepEqual(
    configuredInstances.map(() => observedResources[0]),
    [TELEGRAM_PROCESS_RESOURCE, TELEGRAM_PROCESS_RESOURCE],
  );
  assert.deepEqual(observedResources, [TELEGRAM_PROCESS_RESOURCE]);
});

void test("direct DATA_DIR recreation cannot admit an aliased second Bridge", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-direct-recreate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const guard = makeGuard(root, "direct-recreate");
  const dataDir = join(root, "data");
  const alias = join(root, "new-alias");
  mkdirSync(dataDir);
  const first = startChild(t, "write-on-signal", dataDir, guard, "71910");
  await waitFor(
    () =>
      first.stdout.includes('"event":"READY"') ||
      first.child.exitCode !== null ||
      first.child.signalCode !== null,
    "the first owner to acquire",
  );
  assert.ok(
    first.stdout.includes('"event":"READY"'),
    `first owner did not acquire: ${first.stderr}`,
  );
  renameSync(dataDir, join(root, "data.old"));
  mkdirSync(dataDir);
  symlinkSync(dataDir, alias, "dir");
  assert.equal(first.child.kill("SIGUSR1"), true);
  await waitFor(
    () =>
      existsSync(join(dataDir, "active-writer")) ||
      first.child.exitCode !== null ||
      first.child.signalCode !== null,
    "the first Bridge to write the recreated state",
  );
  assert.ok(
    existsSync(join(dataDir, "active-writer")),
    `first Bridge did not write the recreated state: ${first.stderr}`,
  );
  assert.equal(
    readFileSync(join(dataDir, "active-writer"), "utf8"),
    `${first.child.pid}\n`,
  );

  const second = startChild(t, "hold", alias, guard, "71911");
  await waitFor(
    () =>
      second.stdout.includes('"event":"READY"') ||
      second.child.exitCode !== null ||
      second.child.signalCode !== null,
    "the second Bridge to settle",
  );
  assert.equal(
    second.stdout.includes('"event":"READY"'),
    false,
    `both Bridges write recreated state: first=${first.child.pid}, second=${second.child.pid}`,
  );
  assert.equal((await waitForExit(second.child)).code, 1, second.stderr);
  assert.equal(first.child.exitCode, null);
});

void test("guard root, lock, and owner replacement cannot bypass one constant live resource", async (t) => {
  const resourceIdentity = `replacement-${process.pid}-${++guardSequence}`;
  for (const mutation of ["lock", "owner", "owner-and-lock", "root"] as const) {
    await t.test(mutation, async (caseTest) => {
      const root = mkdtempSync(join(tmpdir(), `iva-process-${mutation}-`));
      caseTest.after(() => rmSync(root, { recursive: true, force: true }));
      const guard = {
        identity: resourceIdentity,
        directory: join(root, "guard"),
      };
      const first = startChild(
        caseTest,
        "hold",
        join(root, "first-data"),
        guard,
        "71101",
      );
      await waitFor(
        () =>
          first.stdout.includes('"event":"READY"') ||
          first.child.exitCode !== null ||
          first.child.signalCode !== null,
        "the first owner to acquire",
      );
      assert.ok(
        first.stdout.includes('"event":"READY"'),
        `first owner did not acquire: ${first.stderr}`,
      );
      const evidence = readyEvidence(first);
      if (mutation === "root") {
        renameSync(evidence.guardRoot, `${evidence.guardRoot}.old`);
        mkdirSync(evidence.guardRoot, { mode: 0o700 });
      } else {
        if (mutation === "owner" || mutation === "owner-and-lock") {
          writeFileSync(evidence.guardOwnerFile, "foreign owner\n");
        }
        if (mutation !== "owner") {
          rmSync(evidence.lockFile, { force: true });
        }
      }
      const second = startChild(
        caseTest,
        "hold",
        join(root, "second-data"),
        guard,
        "71102",
      );
      await waitFor(
        () =>
          second.stdout.includes('"event":"READY"') ||
          second.child.exitCode !== null ||
          second.child.signalCode !== null,
        "the second Bridge to settle",
      );
      assert.equal(second.stdout.includes('"event":"READY"'), false);
      assert.equal((await waitForExit(second.child)).code, 1, second.stderr);
      assert.equal(first.child.exitCode, null);
      const firstExit = waitForExit(first.child);
      assert.equal(first.child.kill("SIGKILL"), true);
      assert.equal((await firstExit).signal, "SIGKILL");
      await waitFor(() => {
        try {
          process.kill(evidence.holderPid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }, `holder ${evidence.holderPid} to exit after its parent was killed`);
    });
  }
});

void test("a same-PID successor with a different start identity takes stale ownership", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-pid-reuse-"));
  const guard = makeGuard(root, "pid-reuse");
  mkdirSync(guard.directory, { recursive: true, mode: 0o700 });
  const staleOwner = {
    schema: "iva-telegram-poll-owner/v2" as const,
    pid: process.pid,
    processStart: "Mon Jan 01 00:00:00 2001",
    nonce: "c".repeat(32),
  };
  writeFileSync(
    join(guard.directory, "telegram-poll-owner.json"),
    `${JSON.stringify(staleOwner)}\n`,
    { mode: 0o600 },
  );
  assert.equal(telegramProcessOwnerIsLive(staleOwner), false);
  const lease = await acquireTelegramProcessLock({ testGuard: guard });
  t.after(async () => {
    await lease.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(lease.owner.pid, process.pid);
  assert.notEqual(lease.owner.processStart, staleOwner.processStart);
});

void test("a late release never removes a successor owner record", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-late-release-"));
  const guard = makeGuard(root, "late-release");
  const lease = await acquireTelegramProcessLock({ testGuard: guard });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const successorBytes = `${JSON.stringify({
    schema: "iva-telegram-poll-owner/v2",
    pid: process.pid,
    processStart: readProcessStartIdentity(process.pid),
    nonce: "d".repeat(32),
  })}\n`;
  writeFileSync(lease.guardOwnerFile, successorBytes);
  await lease.close();
  assert.equal(readFileSync(lease.guardOwnerFile, "utf8"), successorBytes);
});

void test("Bridge exits if its single kernel lease child dies", () => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-lock-loss-"));
  try {
    const guard = makeGuard(root, "holder-loss");
    const result = spawnSync(
      process.execPath,
      [
        CHILD,
        "kill-holder",
        join(root, "data"),
        "71201",
        guard.directory,
        guard.identity,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /process lock holder exited unexpectedly/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("kernel helper death blocks the first Bot API call", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-helper-death-boundary-"));
  try {
    const guard = makeGuard(dataDir, "helper-death-boundary");
    const result = spawnSync(
      process.execPath,
      [
        MAIN_GUARD_CHILD,
        dataDir,
        "kill-holder-before-bot-api",
        guard.directory,
        guard.identity,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /process lock holder exited unexpectedly/u);
    assert.equal(
      existsSync(join(dataDir, "telegram-bot-api-calls.jsonl")),
      false,
    );
    assert.equal(
      readdirSync(dataDir).some((name) => name.startsWith("first-bot-api-")),
      false,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

void test("holder death during publication cannot return an unguarded lease", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-acquire-race-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const guard = makeGuard(root, "publication-death");
  let holder: ChildProcess | null = null;
  let leaseLostCalls = 0;
  await assert.rejects(
    acquireTelegramProcessLock({
      testGuard: guard,
      spawnImpl: (command, args, options) => {
        holder = spawn(command, [...args], options);
        return holder;
      },
      writeOwnerImpl: async () => {
        assert.ok(holder?.pid);
        const exit = waitForExit(holder);
        holder.kill("SIGKILL");
        assert.equal((await exit).signal, "SIGKILL");
      },
      onLeaseLost: () => {
        leaseLostCalls++;
      },
    }),
    /holder exited during acquisition/u,
  );
  assert.equal(leaseLostCalls, 0);
});

void test("corrupt owner and a missing lock helper both fail closed", async (t) => {
  await t.test("corrupt owner", async (caseTest) => {
    const root = mkdtempSync(join(tmpdir(), "iva-process-corrupt-owner-"));
    caseTest.after(() => rmSync(root, { recursive: true, force: true }));
    const guard = makeGuard(root, "corrupt-owner");
    mkdirSync(guard.directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(guard.directory, "telegram-poll-owner.json"),
      "{corrupt\n",
    );
    await assert.rejects(
      acquireTelegramProcessLock({ testGuard: guard }),
      /cannot verify Telegram guard owner/u,
    );
  });
  await t.test("missing helper", async (caseTest) => {
    const root = mkdtempSync(join(tmpdir(), "iva-process-missing-helper-"));
    caseTest.after(() => rmSync(root, { recursive: true, force: true }));
    const guard = makeGuard(root, "missing-helper");
    await assert.rejects(
      acquireTelegramProcessLock({
        testGuard: guard,
        timeoutMs: 100,
        spawnImpl: (_command, _args, options) =>
          spawn("/iva/definitely-missing-lock-helper", [], options),
      }),
      /ENOENT/u,
    );
  });
});

void test("the test-only guard identity rejects paths and secrets before I/O", async () => {
  const directory = join(tmpdir(), `iva-invalid-guard-${process.pid}`);
  await assert.rejects(
    acquireTelegramProcessLock({
      testGuard: { identity: "../../test-token", directory },
    }),
    /invalid test Telegram guard identity/u,
  );
  assert.equal(existsSync(directory), false);
});

void test("OS lease permits exactly one ordered first-run drop attempt", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-main-guard-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const guard = makeGuard(dataDir, "main-drop");
  const mainContenders = [
    startMainChild(t, dataDir, guard),
    startMainChild(t, dataDir, guard),
  ];
  await waitFor(() => {
    const firstCalls = readdirSync(dataDir).filter((name) =>
      name.startsWith("first-bot-api-"),
    );
    assert.ok(firstCalls.length <= 1, "both Bridge mains reached Bot API");
    // Терминально и «дроп не состоялся»: пока ни одного first-bot-api нет, ждать
    // больше нечего, если оба контендера вышли, — следующий assert назовёт провал,
    // а не оставит прогон висеть.
    return firstCalls.length === 1
      ? mainContenders.some(
          ({ child }) => child.exitCode !== null || child.signalCode !== null,
        )
      : mainContenders.every(
          ({ child }) => child.exitCode !== null || child.signalCode !== null,
        );
  }, "the first-run drop to settle");
  const firstCalls = readdirSync(dataDir).filter((name) =>
    name.startsWith("first-bot-api-"),
  );
  assert.equal(
    firstCalls.length,
    1,
    `main guard did not settle: ${mainContenders.map(({ stderr }) => stderr).join(" | ")}`,
  );
  const evidence = JSON.parse(
    readFileSync(join(dataDir, firstCalls[0]), "utf8"),
  ) as {
    method?: unknown;
    body?: unknown;
    markerAtCall?: unknown;
    ownerAtCall?: unknown;
  };
  assert.equal(evidence.method, "deleteWebhook");
  assert.deepEqual(evidence.body, { drop_pending_updates: true });
  assert.deepEqual(parseBacklogDropMarker(String(evidence.markerAtCall)), {
    schema: "iva-telegram-backlog-drop/v1",
  });
  assert.equal(
    parseTelegramProcessOwner(String(evidence.ownerAtCall)).pid,
    Number(firstCalls[0].slice("first-bot-api-".length)),
  );
  const winnerPid = Number(firstCalls[0].slice("first-bot-api-".length));
  const winner = mainContenders.find(({ child }) => child.pid === winnerPid);
  const loser = mainContenders.find(({ child }) => child.pid !== winnerPid);
  assert.ok(winner && loser);
  assert.equal((await waitForExit(loser.child)).code, 1, loser.stderr);
  const winnerExit = waitForExit(winner.child);
  assert.equal(winner.child.kill("SIGKILL"), true);
  assert.equal((await winnerExit).signal, "SIGKILL");

  const successor = startMainChild(t, dataDir, guard);
  // Ждём именно выход ребёнка — сигналом процесса, а не таймером.
  assert.equal((await waitForExit(successor.child)).code, 1, successor.stderr);
  assert.match(successor.stderr, /marker exists without an offset/u);
  assert.equal(
    readdirSync(dataDir).filter((name) => name.startsWith("first-bot-api-"))
      .length,
    1,
  );
});

void test("deleteWebhook ok:false aborts before commands, offset, or polling", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-delete-webhook-false-"));
  try {
    const guard = makeGuard(dataDir, "delete-webhook-false");
    const result = spawnSync(
      process.execPath,
      [
        MAIN_GUARD_CHILD,
        dataDir,
        "delete-webhook-false",
        guard.directory,
        guard.identity,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 1, result.stdout);
    assert.match(
      result.stderr,
      /deleteWebhook failed.*fixture rejected deleteWebhook/u,
    );
    const calls = readFileSync(
      join(dataDir, "telegram-bot-api-calls.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string });
    assert.deepEqual(
      calls.map(({ method }) => method),
      ["deleteWebhook"],
    );
    assert.equal(existsSync(join(dataDir, "telegram-offset.json")), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
