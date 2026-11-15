import { strict as assert } from "node:assert";
import test from "node:test";
import {
  spawn as realSpawn,
  spawnSync,
  type SpawnOptions,
} from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { readFacts } from "./job-facts.ts";
import {
  OWNER_STARTED_AT,
  ScheduleStatusError,
  readStatus,
  runScheduledJob,
  type RunScheduledJobResult,
} from "./schedule-runner.ts";
import { tempDir } from "../../scripts/fixtures/temp-dir.ts";

function typecheckRequiredOptions(): void {
  // @ts-expect-error The pre-conversion declaration required an options object.
  void runScheduledJob();
}
void typecheckRequiredOptions;

interface SeenSpawn {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly opts: SpawnOptions;
}

interface TestStatusEntry {
  readonly lastSuccessAt: number;
  readonly lastExitCode: number;
  readonly lastStartedAt: number;
  readonly lastFinishedAt: number;
  readonly inProgressSince: number;
  readonly [key: string]: unknown;
}

type TestStatus = Record<string, TestStatusEntry>;

function parseStatus(source: string): TestStatus {
  const parsed: unknown = JSON.parse(source);
  return parsed as TestStatus;
}

function scaffold() {
  const dir = tempDir("iva-schedule-runner-");
  // No .env on purpose: the runner spawns `node --env-file-if-exists=.env <argv>`, so a
  // checkout or version tree without the file still starts the child. The one line node
  // prints about the missing file is what the tail test below pins.
  return dir;
}

function collectLogs() {
  const lines: string[] = [];
  return {
    log: (...args: unknown[]) => {
      lines.push(args.join(" "));
    },
    lines,
  };
}

void test("direct run (no lockPath): success writes lastSuccessAt and does not touch other entries", async () => {
  const root = scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(
    statusPath,
    JSON.stringify({ "memory-weekly": { lastSuccessAt: 111 } }),
    "utf8",
  );

  const { log, lines } = collectLogs();
  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log,
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  const status = parseStatus(await readFile(statusPath, "utf8"));
  assert.equal(
    status["memory-weekly"].lastSuccessAt,
    111,
    "other entries are preserved",
  );
  assert.ok(status["memory-daily"].lastSuccessAt > 0);
  assert.equal(status["memory-daily"].lastExitCode, 0);
  assert.ok(
    status["memory-daily"].lastStartedAt <=
      status["memory-daily"].lastFinishedAt,
  );
  assert.ok(
    lines.some((l) => l.includes("memory-daily") && l.includes("start")),
    "logs a start line",
  );
  // Unique per call (pid + random suffix), not a single "<statusPath>.tmp" — check the
  // whole prefix family, not one exact stale name.
  const statusFileName = statusPath.split("/").pop();
  const strayTmp = readdirSync(dirname(statusPath)).filter((f) =>
    f.startsWith(`${statusFileName}.tmp-`),
  );
  assert.deepEqual(strayTmp, [], "no stray tmp file left behind");
});

void test("non-zero exit: lastExitCode recorded, lastSuccessAt left untouched", async () => {
  const root = scaffold();
  await writeFile(join(root, "fail.ts"), "process.exit(7);\n");
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(
    statusPath,
    JSON.stringify({ "memory-daily": { lastSuccessAt: 42 } }),
    "utf8",
  );

  const { log } = collectLogs();
  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["fail.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 7);
  const status = parseStatus(await readFile(statusPath, "utf8"));
  assert.equal(status["memory-daily"].lastExitCode, 7);
  assert.equal(
    status["memory-daily"].lastSuccessAt,
    42,
    "a failed run must not bump lastSuccessAt",
  );
});

void test("guard: a lastSuccessAt inside the 2h window skips the job without spawning", async () => {
  const root = scaffold();
  await writeFile(join(root, "boom.ts"), "process.exit(1);\n"); // would fail loudly if actually spawned
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  const recentSuccess = Date.now() - 5 * 60 * 1000; // 5 minutes ago
  await writeFile(
    statusPath,
    JSON.stringify({ "memory-daily": { lastSuccessAt: recentSuccess } }),
    "utf8",
  );

  let spawned = false;
  const { log, lines } = collectLogs();
  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["boom.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log,
    spawnImpl: (...args) => {
      spawned = true;
      return realSpawn(...args);
    },
  });

  assert.equal(result.skipped, true);
  assert.equal(spawned, false, "the guard must prevent spawning entirely");
  assert.ok(lines.some((l) => l.toLowerCase().includes("skip")));
  const status = parseStatus(await readFile(statusPath, "utf8"));
  assert.equal(
    status["memory-daily"].lastSuccessAt,
    recentSuccess,
    "guard does not touch the status file",
  );
});

void test("guard: a lastSuccessAt older than 2h runs normally", async () => {
  const root = scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  const oldSuccess = Date.now() - 3 * 60 * 60 * 1000; // 3 hours ago
  await writeFile(
    statusPath,
    JSON.stringify({ "memory-daily": { lastSuccessAt: oldSuccess } }),
    "utf8",
  );

  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log: () => {},
  });

  assert.equal(result.skipped, false);
  assert.equal(result.ok, true);
});

void test("lockPath given: the spawned command is flock-wrapped in the documented shape", async () => {
  const root = scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  const lockPath = join(root, ".memory.lock");
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });

  let seen: SeenSpawn | null = null;
  const result = await runScheduledJob({
    name: "memory-weekly",
    argv: ["scripts/memory/rollup.ts", "weekly"],
    root,
    nodeBin: "/usr/bin/node-stand-in",
    lockPath,
    statusPath,
    log: () => {},
    spawnImpl: (cmd, args, opts) => {
      seen = { cmd, args, opts };
      // Actually run something trivial regardless of the (unrunnable) recorded command,
      // so the promise still settles quickly and deterministically.
      return realSpawn(process.execPath, [join(root, "ok.ts")], opts);
    },
  });

  assert.equal(
    seen!.cmd,
    process.platform === "darwin" ? "/usr/bin/lockf" : "flock",
  );
  assert.deepEqual(seen!.args, [
    process.platform === "darwin" ? "-t" : "-w",
    // Above the job timeout on purpose: a queued rollup must WAIT for .memory.lock, not
    // give up on the night while the previous period is still holding it.
    "3900",
    lockPath,
    "/usr/bin/node-stand-in",
    "--env-file-if-exists=.env",
    "scripts/memory/rollup.ts",
    "weekly",
  ]);
  assert.equal(seen!.opts.cwd, root);
  // Ребёнок под flock раннера знает, что замок уже взят, и не берёт его второй раз.
  assert.equal(seen!.opts.env?.IVA_MEMORY_LOCK_HELD, "1");
  assert.equal(result.ok, true);
});

void test("no lockPath: the spawned command invokes nodeBin directly (digest case)", async () => {
  const root = scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  const statusPath = join(root, "data/rollup-status.json");

  let seen: SeenSpawn | null = null;
  await runScheduledJob({
    name: "proactive",
    argv: ["scripts/proactive/tick.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    // Признак замка из окружения сервиса ребёнку без flock не достаётся.
    env: { ...process.env, IVA_MEMORY_LOCK_HELD: "1" },
    log: () => {},
    spawnImpl: (cmd, args, opts) => {
      seen = { cmd, args, opts };
      return realSpawn(process.execPath, [join(root, "ok.ts")], opts);
    },
  });

  assert.equal(seen!.cmd, process.execPath);
  assert.deepEqual(seen!.args, [
    "--env-file-if-exists=.env",
    "scripts/proactive/tick.ts",
  ]);
  assert.equal(seen!.opts.env?.IVA_MEMORY_LOCK_HELD, undefined);
});

void test("root без .env: ребёнок стартует, и node говорит об этом одной честной строкой", async () => {
  const root = scaffold();
  await writeFile(
    join(root, "ok.ts"),
    "console.log(`mark=${process.env.MARK}`);\n",
  );
  const { log, lines } = collectLogs();

  const result = await runScheduledJob({
    name: "reminders",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    env: { ...process.env, MARK: "from-parent" },
    log,
  });

  assert.equal(
    result.ok,
    true,
    "без .env ребёнок обязан стартовать: файл больше не обязателен",
  );
  assert.equal(result.code, 0);
  // Ровно одна строка, и она честная: файла правда нет. На проде .env есть, и строки нет.
  const missing = lines.filter((line) =>
    line.includes("not found. Continuing"),
  );
  assert.equal(missing.length, 1);
  assert.match(
    String(missing[0]),
    /\.env not found\. Continuing without it\./u,
  );
  // Ключи родителя доезжают наследством: файл только добавляет то, чего в env нет.
  assert.ok(lines.some((line) => line.includes("mark=from-parent")));
});

void test(
  "full flock integration (real /usr/bin/flock): success path end to end",
  { skip: !existsSync("/usr/bin/flock") },
  async () => {
    const root = scaffold();
    await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
    const statusPath = join(root, "data/rollup-status.json");
    await mkdir(join(root, "data"), { recursive: true });

    const result = await runScheduledJob({
      name: "memory-daily",
      argv: ["ok.ts"],
      root,
      nodeBin: process.execPath,
      lockPath: join(root, ".memory.lock"),
      statusPath,
      log: () => {},
    });

    assert.equal(result.ok, true);
    const status = parseStatus(await readFile(statusPath, "utf8"));
    assert.equal(status["memory-daily"].lastExitCode, 0);
  },
);

void test("timeout: SIGTERM first, escalates to SIGKILL after the grace window", async () => {
  const root = scaffold();
  const sigtermMarker = join(root, "got-sigterm");
  // Ignores SIGTERM and spins forever — forces the SIGKILL escalation. Writes a marker
  // file the INSTANT it receives SIGTERM: that's the real proof the process was still
  // alive and actively ignoring the signal, as opposed to dying from the *default*
  // (unhandled) SIGTERM action because process.on('SIGTERM', ...) hadn't finished
  // registering yet — a genuine race for a freshly-spawned node process under heavy CPU
  // contention (the full suite running many workers at once), where a too-tight
  // timeoutMs can fire before the child has even finished starting up. That race, not
  // "grace-window drift", is what made this test flaky in the full suite while passing
  // reliably in isolation: on an unlucky schedule the child died from the FIRST SIGTERM
  // (code=null, signal="SIGTERM") instead of ever needing the SIGKILL escalation this
  // test exists to exercise.
  await writeFile(
    join(root, "stubborn.ts"),
    [
      "import { writeFileSync } from 'node:fs';",
      `process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(sigtermMarker)}, 'x'); });`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const statusPath = join(root, "data/rollup-status.json");
  const marker = `iva-schedule-runner-sigkill-test-${randomBytes(6).toString("hex")}`;

  const { log, lines } = collectLogs();
  // Generous on purpose (was 150/150): under load, spawning and starting up a fresh node
  // process can itself take longer than that, well before the timeout/grace logic even
  // becomes relevant. Production uses 3600_000/10_000 by default, so this is still a
  // tiny fraction of that — plenty of margin without meaningfully slowing the suite.
  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["stubborn.ts", marker],
    root,
    nodeBin: process.execPath,
    statusPath,
    log,
    timeoutMs: 1000,
    killGraceMs: 1000,
  });

  // Semantic checks, in order, rather than trusting exact timing:
  //   1. the child really did receive and handle SIGTERM (not killed by the default action);
  //   2. SIGTERM was logged before SIGKILL, never the other way round;
  //   3. given (1), the only way the job could still have ended is the SIGKILL escalation;
  //   4. nothing survives afterward.
  assert.equal(
    existsSync(sigtermMarker),
    true,
    "the child must have actually received and handled SIGTERM",
  );

  const sigtermLine = lines.findIndex((l) => l.includes("SIGTERM"));
  const sigkillLine = lines.findIndex((l) => l.includes("SIGKILL"));
  assert.notEqual(sigtermLine, -1, "SIGTERM must be logged");
  assert.notEqual(sigkillLine, -1, "SIGKILL must be logged");
  assert.ok(
    sigtermLine < sigkillLine,
    "SIGTERM must be sent before SIGKILL, not the other way round",
  );

  assert.equal(result.ok, false);
  assert.equal(
    result.signal,
    "SIGKILL",
    "with SIGTERM confirmed handled (not fatal), only the escalation can have ended it",
  );
  assert.equal(result.code, null);

  // No survivors after the escalation — same proof-of-death pattern as the group-kill test.
  const noLingeringProcess = async () => {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      const r = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
      if ((r.stdout || "").trim() === "") return true;
      await new Promise((res) => setTimeout(res, 50));
    }
    return false;
  };
  assert.equal(
    await noLingeringProcess(),
    true,
    "no process must survive the SIGKILL escalation",
  );
});

void test("spawn failure (bad nodeBin) never throws and records the error", async () => {
  const root = scaffold();
  const statusPath = join(root, "data/rollup-status.json");

  let threw = false;
  let result!: RunScheduledJobResult;
  try {
    result = await runScheduledJob({
      name: "memory-daily",
      argv: ["whatever"],
      root,
      nodeBin: join(root, "does-not-exist-binary"),
      statusPath,
      log: () => {},
    });
  } catch {
    threw = true;
  }

  assert.equal(threw, false, "runScheduledJob must never throw");
  assert.equal(result.ok, false);
  assert.match(
    String(result.error),
    /ENOENT/u,
    "причина незапуска едет наружу, а не теряется",
  );
});

void test(
  "timeout kills the WHOLE process group, not just flock's own pid: the lock is released and no grandchild lingers",
  { skip: !existsSync("/usr/bin/flock") },
  async () => {
    const root = scaffold();
    const marker = `iva-schedule-runner-test-${randomBytes(6).toString("hex")}`;
    // Ignores SIGTERM (forces the SIGKILL escalation) and never exits on its own — a stand-in
    // for a wedged rollup that would otherwise keep the flock lock held via its inherited fd.
    await writeFile(
      join(root, "stubborn.ts"),
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
    );
    const lockPath = join(root, ".memory.lock");
    const statusPath = join(root, "data/rollup-status.json");

    const result = await runScheduledJob({
      name: "memory-daily",
      argv: ["stubborn.ts", marker],
      root,
      nodeBin: process.execPath,
      lockPath,
      statusPath,
      log: () => {},
      timeoutMs: 150,
      killGraceMs: 150,
    });

    assert.equal(result.ok, false);

    // No process (flock, or the node it forked) still carries the marker in its command line.
    // Zombies can briefly remain visible to pgrep right after SIGKILL until their parent (or
    // init, once re-parented) reaps them, so poll for a moment rather than asserting instantly.
    const noLingeringProcess = async () => {
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        const r = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
        if ((r.stdout || "").trim() === "") return true;
        await new Promise((res) => setTimeout(res, 50));
      }
      return false;
    };
    assert.equal(
      await noLingeringProcess(),
      true,
      "flock's forked node child must not survive the group kill",
    );

    // The strongest proof the lock itself is free: a non-blocking flock probe succeeds.
    const probe = spawnSync("flock", ["-n", lockPath, "-c", "true"], {
      encoding: "utf8",
    });
    assert.equal(
      probe.status,
      0,
      "the lock must be released once the whole group is dead, not just flock's own pid",
    );
  },
);

void test("double entry: two concurrent calls for the same name only run once (inProgressSince admission guard)", async () => {
  const root = scaffold();
  await writeFile(
    join(root, "slow.ts"),
    "await new Promise((r) => setTimeout(r, 250)); process.exit(0);\n",
  );
  const statusPath = join(root, "data/rollup-status.json");

  const call = () =>
    runScheduledJob({
      name: "memory-daily",
      argv: ["slow.ts"],
      root,
      nodeBin: process.execPath,
      statusPath,
      log: () => {},
    });

  // Promise.all([call(), call()]) invokes both async functions synchronously back to
  // back — the first call's admission check + reservation write (readStatus, guard
  // checks, writeStatusAtomic) all run to completion before the JS engine yields at
  // its first genuine await, so by the time the second call's own admission check
  // runs, it reads the first call's already-written inProgressSince.
  const [r1, r2] = await Promise.all([call(), call()]);

  const results = [r1, r2];
  const skipped = results.filter((r) => r.skipped);
  const ran = results.filter((r) => !r.skipped);
  assert.equal(
    skipped.length,
    1,
    "exactly one of the two concurrent calls must be skipped",
  );
  assert.equal(ran.length, 1, "exactly one must actually run");
  assert.equal(ran[0].ok, true);

  const status = parseStatus(await readFile(statusPath, "utf8"));
  assert.equal(
    Object.hasOwn(status["memory-daily"], "inProgressSince"),
    false,
    "inProgressSince is cleared once the run finishes, not left dangling",
  );
  assert.ok(status["memory-daily"].lastSuccessAt > 0);
  assert.equal(
    existsSync(`${statusPath}.lock`),
    false,
    "the reservation lock file never lingers after use",
  );
});

void test("a stale inProgressSince (older than timeoutMs — a presumed crash) does not block a new run forever", async () => {
  const root = scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  const staleStart = Date.now() - 10_000; // "started" 10s ago
  await writeFile(
    statusPath,
    JSON.stringify({ "memory-daily": { inProgressSince: staleStart } }),
    "utf8",
  );

  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log: () => {},
    timeoutMs: 5_000, // shorter than the 10s-old inProgressSince above -> stale, not "still running"
  });

  assert.equal(
    result.skipped,
    false,
    "a stale in-progress marker (older than timeoutMs) must not block a new attempt",
  );
  assert.equal(result.ok, true);
});

void test("a fresh reservation owned by a dead process is recovered immediately", async () => {
  const root = scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(
    statusPath,
    JSON.stringify({
      "memory-daily": {
        inProgressSince: Date.now(),
        ownerPid: 2_147_483_647,
        ownerStartedAt: Date.now(),
      },
    }),
  );

  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log: () => {},
  });

  assert.equal(result.skipped, false);
  assert.equal(result.ok, true);
});

void test("a fresh reservation owned by a live process still blocks duplicate entry", async () => {
  // Живой владелец — этот же процесс: свой pid с чужим OWNER_STARTED_AT — прошлое воплощение.
  const root = scaffold();
  await writeFile(join(root, "boom.ts"), "process.exit(1);\n");
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(
    statusPath,
    JSON.stringify({
      "memory-daily": {
        inProgressSince: Date.now(),
        ownerPid: process.pid,
        ownerStartedAt: OWNER_STARTED_AT,
      },
    }),
  );
  let spawned = false;

  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["boom.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log: () => {},
    spawnImpl: (...args) => {
      spawned = true;
      return realSpawn(...args);
    },
  });

  assert.equal(result.skipped, true);
  assert.equal(spawned, false);
});

void test("completion and finally do not modify status when their lock acquisition fails", async () => {
  const root = scaffold();
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(
    join(root, "hold-status-lock.ts"),
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(`${statusPath}.lock`)}, 'held');`,
      "process.exit(0);",
    ].join("\n"),
  );
  const { log, lines } = collectLogs();

  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["hold-status-lock.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log,
  });

  assert.equal(result.ok, true, "the child outcome remains successful");
  const status = parseStatus(await readFile(statusPath, "utf8"));
  assert.equal(typeof status["memory-daily"].inProgressSince, "number");
  assert.equal(status["memory-daily"].lastFinishedAt, undefined);
  assert.ok(lines.some((line) => line.includes("record completion")));
  assert.ok(lines.some((line) => line.includes("clear its reservation")));
});

void test("no lockPath: a clean exit right after SIGTERM cancels the pending hard-kill (no stale SIGKILL later)", async () => {
  // The direct-spawn case (digest has no lockPath): "child" IS the actual target, so its
  // exit really does mean the process is gone, and any still-pending hard-kill timer must
  // be canceled — left dangling, it would risk firing later against a since-reused pid.
  const root = scaffold();
  await writeFile(
    join(root, "graceful.ts"),
    "process.on('SIGTERM', () => { process.exit(0); });\nsetInterval(() => {}, 1000);\n",
  );
  const statusPath = join(root, "data/rollup-status.json");
  const signals: NodeJS.Signals[] = [];

  // Generous margins for the same reason as the SIGTERM/SIGKILL escalation test above
  // (was 100/150): too tight a timeoutMs risks the first SIGTERM arriving before a
  // freshly-spawned node process has even finished registering its handler under load,
  // which would make it die from the *default* SIGTERM action (code=null, signal=
  // "SIGTERM") instead of the handler's process.exit(0) this test actually checks for.
  const result = await runScheduledJob({
    name: "digest",
    argv: ["graceful.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log: () => {},
    timeoutMs: 800,
    killGraceMs: 500,
    killImpl: (pid, signal) => {
      signals.push(signal);
      process.kill(pid, signal);
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  // Give the (should-be-canceled) hard-kill window a chance to elapse and confirm no
  // second, stale SIGKILL followed the graceful exit. Must outlast killGraceMs above.
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(
    signals,
    ["SIGTERM"],
    "the pending SIGKILL escalation must be canceled once the direct target exits cleanly",
  );
});

void test("if the status lock can't be acquired, the run is deferred: no unlocked reservation write, nothing spawned", async () => {
  const root = scaffold();
  await writeFile(join(root, "boom.ts"), "process.exit(1);\n"); // would fail loudly if actually spawned
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  // Pre-hold the lock file with a FRESH mtime so withStatusLock's staleness-steal never
  // kicks in during this test — it must genuinely exhaust its retries and give up.
  await writeFile(`${statusPath}.lock`, "999999");

  let spawned = false;
  const { log, lines } = collectLogs();
  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["boom.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log,
    spawnImpl: (...args) => {
      spawned = true;
      return realSpawn(...args);
    },
  });

  assert.equal(
    result.skipped,
    true,
    "must defer, never proceed with an unlocked read-decide-write",
  );
  assert.equal(
    spawned,
    false,
    "must never spawn without having safely reserved first",
  );
  assert.ok(
    lines.some((l) => l.toLowerCase().includes("defer")),
    "the deferral must be logged, not silent",
  );
  assert.equal(
    existsSync(statusPath),
    false,
    "no status write at all — not even an unlocked reservation",
  );
});

// ── readStatus: «нет файла» и «файл испорчен» — разные исходы ────────────────────────
// Возврат {} на ЛЮБУЮ ошибку означал «ничего никогда не запускалось»: гварды «уже идёт»
// и «успех был N минут назад» отключались, а первая же запись сносила записи соседних
// расписаний. Та же развилка, что в agent/lib/reminder-tick.ts:50-74.

void test("readStatus: no status file yet (fresh install) is an empty status, not an error", () => {
  const root = scaffold();
  assert.deepEqual(readStatus(join(root, "data/rollup-status.json")), {});
});

void test("readStatus: damaged JSON throws, naming the file and the reason", async () => {
  const root = scaffold();
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(statusPath, '{"memory-daily": {"lastSuccessAt": 1', "utf8");

  assert.throws(
    () => readStatus(statusPath),
    (error: unknown) =>
      error instanceof ScheduleStatusError &&
      error.message.includes(statusPath) &&
      /json/i.test(error.message),
    "a damaged status file must not read as an empty one",
  );
});

void test("readStatus: an unreadable path throws instead of reading as empty", async () => {
  const root = scaffold();
  // A directory where the file belongs: EISDIR on every platform and every uid, unlike
  // chmod 000, which root would read straight through.
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(statusPath, { recursive: true });

  assert.throws(
    () => readStatus(statusPath),
    (error: unknown) =>
      error instanceof ScheduleStatusError &&
      error.message.includes(statusPath),
    "an unreadable status file must not read as an empty one",
  );
});

void test("readStatus: valid JSON that is not an object throws", async () => {
  const root = scaffold();
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(statusPath, '["memory-daily"]', "utf8");

  assert.throws(
    () => readStatus(statusPath),
    (error: unknown) => error instanceof ScheduleStatusError,
    "an array is not a schedule status",
  );
});

void test("damaged status file: the attempt is deferred, nothing is spawned, and the neighbours survive on disk", async () => {
  const root = scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  // Truncated mid-write: memory-weekly's record and digest's live reservation are still
  // in there, and a read that answers "{}" would take both out with the next write.
  const damaged =
    '{\n  "memory-weekly": { "lastSuccessAt": 111 },\n  "digest": { "inProgressSince": 22';
  await writeFile(statusPath, damaged, "utf8");

  let spawned = false;
  const { log, lines } = collectLogs();
  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log,
    spawnImpl: (...args) => {
      spawned = true;
      return realSpawn(...args);
    },
  });

  assert.equal(
    result.skipped,
    true,
    "a status file we cannot read defers the attempt",
  );
  assert.equal(spawned, false, "nothing runs off a status we could not read");
  assert.equal(
    await readFile(statusPath, "utf8"),
    damaged,
    "the damaged file is left exactly as found — no write may clobber the neighbours",
  );
  assert.ok(
    lines.some((l) => l.includes(statusPath)),
    "the journal must name the file the owner has to fix",
  );
});

// T50c: напоминание запускается без срока (timeoutMs: null) — ход живёт, пока идут события.
void test("no deadline (timeoutMs: null): a working child runs to completion, nothing kills it", async () => {
  const root = scaffold();
  const marker = join(root, "done");
  await writeFile(
    join(root, "slow.ts"),
    [
      "import { writeFileSync } from 'node:fs';",
      `setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0); }, 400);`,
    ].join("\n"),
  );
  const { log, lines } = collectLogs();

  const result = await runScheduledJob({
    name: "reminder-r1",
    argv: ["slow.ts"],
    root,
    nodeBin: process.execPath,
    timeoutMs: null,
    log,
  });

  assert.equal(result.ok, true, "ребёнок без срока доходит до конца сам");
  assert.equal(existsSync(marker), true, "ребёнку дали доработать");
  assert.equal(
    lines.some((l) => l.includes("SIGTERM") || l.includes("exceeded")),
    false,
    "срока нет — убивать нечего",
  );
});

void test("the child reads its stop time from the runner, never from a stale service environment", async () => {
  const root = scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  let seen: SpawnOptions | null = null;
  await runScheduledJob({
    name: "memory-daily",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    timeoutMs: 5000,
    killGraceMs: 1000,
    now: () => 1_000_000,
    // Снимок окружения сервиса со старым числом: ребёнок обязан видеть число раннера.
    env: { ...process.env, IVA_JOB_STOP_AT: "1" },
    log: () => {},
    spawnImpl: (cmd, args, opts) => {
      seen = opts;
      return realSpawn(cmd, args, opts);
    },
  });
  // Работа кончается за срок остановки до SIGTERM: сводка успевает погасить ход сама.
  assert.equal(seen!.env?.IVA_JOB_STOP_AT, String(1_000_000 + 5000 - 1000));
});

void test("a throwing log still settles the run as a failure", async () => {
  const root = scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  const result = await runScheduledJob({
    name: "digest",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    log: () => {
      throw new Error("log is broken");
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof Error);
  assert.equal(result.error.message, "log is broken");
});

void test("a job without its own stop grace keeps the short SIGKILL grace", async () => {
  const root = scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  let seen: SpawnOptions | null = null;
  await runScheduledJob({
    name: "digest",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    timeoutMs: 60_000,
    now: () => 1_000_000,
    log: () => {},
    spawnImpl: (cmd, args, opts) => {
      seen = opts;
      return realSpawn(cmd, args, opts);
    },
  });
  // 90 с на остановку нужны только сводке; остальным заданиям — прежние 10 с.
  assert.equal(seen!.env?.IVA_JOB_STOP_AT, String(1_000_000 + 60_000 - 10_000));
});

// factOnSuccess: "after-failure" (тик Watch): успех пишется фактом только после провала
// этого имени — он и закрывает провал; провал пишется всегда; остальные расписания (без
// опции) пишут успех как прежде.
void test("factOnSuccess after-failure: a success is written only to close a failure of the same name", async () => {
  const root = scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  await writeFile(join(root, "fail.ts"), "process.exit(3);\n");
  const statusPath = join(root, "data/rollup-status.json");
  const factsPath = join(root, "data/jobs.json");
  await mkdir(join(root, "data"), { recursive: true });
  const run = (script: string, name = "proactive") =>
    runScheduledJob({
      name,
      argv: [script],
      root,
      nodeBin: process.execPath,
      statusPath,
      factsPath,
      guardMs: 0,
      wake: false,
      factOnSuccess: name === "proactive" ? "after-failure" : undefined,
      log: () => {},
    });
  const shape = async () =>
    (await readFacts(factsPath)).map((fact) => `${fact.name}:${fact.ok}`);

  assert.equal((await run("ok.ts")).ok, true);
  assert.deepEqual(await shape(), [], "a success after nothing leaves no row");
  assert.equal((await run("fail.ts")).ok, false);
  assert.deepEqual(await shape(), ["proactive:false"]);
  assert.equal((await run("ok.ts")).ok, true);
  assert.deepEqual(await shape(), ["proactive:false", "proactive:true"]);
  assert.equal((await run("ok.ts")).ok, true);
  assert.deepEqual(
    await shape(),
    ["proactive:false", "proactive:true"],
    "the closed failure is not closed twice",
  );
  // Чужой провал не открывает запись успеха этому имени; расписание без опции пишет всегда.
  assert.equal((await run("fail.ts", "digest")).ok, false);
  assert.equal((await run("ok.ts")).ok, true);
  assert.equal((await run("ok.ts", "digest")).ok, true);
  assert.deepEqual(await shape(), [
    "proactive:false",
    "proactive:true",
    "digest:false",
    "digest:true",
  ]);
  const status = JSON.parse(await readFile(statusPath, "utf8")) as Record<
    string,
    { lastSuccessAt?: number }
  >;
  assert.ok(typeof status.proactive?.lastSuccessAt === "number");
});
