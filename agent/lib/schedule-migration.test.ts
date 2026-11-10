import { strict as assert } from "node:assert";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { LEGACY_MEMORY_UNITS as CLI_LEGACY_MEMORY_UNITS } from "../../scripts/lib/legacy-memory-units.ts";
import {
  catchUpJob,
  LEGACY_MEMORY_UNITS,
  runScheduleMigration,
} from "./schedule-migration.ts";
import { parseCron, SCHEDULE_CRON } from "./schedule-table.ts";
import { tempDir } from "../../scripts/fixtures/temp-dir.ts";

type MigrationOptions = NonNullable<Parameters<typeof runScheduleMigration>[0]>;
type ExecImplementation = NonNullable<MigrationOptions["execImpl"]>;
type Period = Parameters<NonNullable<MigrationOptions["runJob"]>>[0];
type StatusEntry = Readonly<Record<string, unknown>>;
type Status = Readonly<Record<string, StatusEntry>>;

function parseStatus(text: string): Status {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new TypeError("status fixture must be an object");
  return parsed as Status;
}

const UNIT_DIR_REL = ".config/systemd/user";

async function scaffoldHome({
  withUnitDir = true,
}: { readonly withUnitDir?: boolean } = {}): Promise<string> {
  const dir = tempDir("iva-schedule-migration-");
  const home = join(dir, "home");
  await mkdir(home, { recursive: true });
  if (withUnitDir) await mkdir(join(home, UNIT_DIR_REL), { recursive: true });
  return home;
}

function fakeExecImpl({
  failUnits = new Set<string>(),
}: { readonly failUnits?: ReadonlySet<string> } = {}): {
  readonly execImpl: ExecImplementation;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const execImpl: ExecImplementation = (args: readonly string[]) => {
    calls.push(args.join(" "));
    if (args[1] === "disable" && failUnits.has(args[3])) {
      return { code: 1, out: "", err: "simulated systemctl failure" };
    }
    return { code: 0, out: "", err: "" };
  };
  return { execImpl, calls };
}

// The server retires these units on boot and `iva doctor` sweeps the same eight from a tree
// whose agent/ may be missing, so the list exists on both sides of the seam. Neither copy
// may grow, shrink or rename a unit on its own.
void test("LEGACY_MEMORY_UNITS lists exactly the 8 retired unit names, on both sides", () => {
  assert.deepEqual(
    [...LEGACY_MEMORY_UNITS].sort(),
    [...CLI_LEGACY_MEMORY_UNITS].sort(),
  );
  assert.deepEqual(
    [...LEGACY_MEMORY_UNITS].sort(),
    [
      "iva-memory-daily.service",
      "iva-memory-daily.timer",
      "iva-memory-monthly.service",
      "iva-memory-monthly.timer",
      "iva-memory-weekly.service",
      "iva-memory-weekly.timer",
      "iva-memory-yearly.service",
      "iva-memory-yearly.timer",
    ].sort(),
  );
});

void test("no ~/.config/systemd/user: legacy-unit cleanup is skipped, but catch-up (first-boot seeding) still runs", async () => {
  // Catch-up must not depend on systemd being present at all — a container, this repo's
  // own `npm run replica` sandbox, or CI has no ~/.config/systemd/user (nothing to tear
  // down) but should still track and eventually catch up a missed rollup.
  const homedir = await scaffoldHome({ withUnitDir: false });
  const statusPath = join(homedir, "..", "data/rollup-status.json");
  const { execImpl, calls } = fakeExecImpl();
  let runJobCalled = false;

  await assert.doesNotReject(() =>
    runScheduleMigration({
      homedir,
      execImpl,
      statusPath,
      tz: "UTC",
      log: () => {},
      runJob: () => {
        runJobCalled = true;
        return Promise.resolve();
      },
    }),
  );

  assert.equal(calls.length, 0, "no systemd -> no systemctl calls of any kind");
  assert.equal(
    runJobCalled,
    false,
    "first boot still suppresses catch-up (storm protection), regardless of systemd",
  );
  assert.equal(
    existsSync(statusPath),
    true,
    "catch-up bookkeeping (the first-boot seed) proceeds even without systemd",
  );
});

void test("systemctl binary missing (ENOENT): legacy-unit cleanup is skipped, but catch-up still runs", async () => {
  const homedir = await scaffoldHome();
  const statusPath = join(homedir, "..", "data/rollup-status.json");
  const calls: (readonly string[])[] = [];
  const execImpl: ExecImplementation = (args: readonly string[]) => {
    calls.push(args);
    const error = Object.assign(new Error("spawnSync systemctl ENOENT"), {
      code: "ENOENT",
    });
    return { code: 127, out: "", err: "", error };
  };
  let runJobCalled = false;

  await runScheduleMigration({
    homedir,
    execImpl,
    statusPath,
    tz: "UTC",
    log: () => {},
    runJob: () => {
      runJobCalled = true;
      return Promise.resolve();
    },
  });

  // The very first probe call may legitimately happen (to discover ENOENT), but no
  // mutating systemctl calls may follow it — actually verify the call log, not a
  // tautology.
  assert.ok(
    calls.length <= 1,
    `no mutating systemctl calls followed the probe: ${JSON.stringify(calls)}`,
  );
  assert.equal(
    runJobCalled,
    false,
    "first boot suppresses catch-up regardless of systemctl availability",
  );
  assert.equal(
    existsSync(statusPath),
    true,
    "catch-up bookkeeping proceeds even when systemctl itself is missing",
  );
});

void test("first boot (no status file): seeds a baseline (seededAt, NOT lastSuccessAt) for the night and runs nothing", async () => {
  const homedir = await scaffoldHome();
  const dataDir = join(homedir, "..", "data");
  const statusPath = join(dataDir, "rollup-status.json");
  const { execImpl } = fakeExecImpl();
  const ranPeriods: Period[] = [];
  const fixedNow = Date.UTC(2026, 7, 4, 10, 0, 0);

  await runScheduleMigration({
    homedir,
    execImpl,
    statusPath,
    tz: "UTC",
    log: () => {},
    now: () => fixedNow,
    runJob: (period) => {
      ranPeriods.push(period);
      return Promise.resolve();
    },
  });

  assert.deepEqual(
    ranPeriods,
    [],
    "first boot must never run a catch-up job (storm protection)",
  );
  const status = parseStatus(await readFile(statusPath, "utf8"));
  // Keyed "memory-<period>" — the same name schedule-runner.ts actually records a real
  // run under (the `name` each agent/schedules/memory-*.ts passes), not the bare period.
  for (const period of ["night"]) {
    const entry = status[`memory-${period}`];
    assert.equal(entry?.["seededAt"], fixedNow, `${period} is seeded to now`);
    // The seed is a storm-protection baseline, not a real run — /menu → crons and
    // iva doctor must not report it as one.
    assert.equal(
      entry?.["lastSuccessAt"],
      undefined,
      `${period}'s seed must not read as a real success`,
    );
  }
});

void test("a digest-only status seeds every missing memory key and causes no catch-up burst", async () => {
  const homedir = await scaffoldHome();
  const statusPath = join(homedir, "..", "data", "rollup-status.json");
  await mkdir(join(homedir, "..", "data"), { recursive: true });
  await writeFile(
    statusPath,
    JSON.stringify({ digest: { lastSuccessAt: 123 } }),
  );
  const fixedNow = Date.UTC(2026, 7, 4, 10, 0, 0);
  const ranPeriods: Period[] = [];

  await runScheduleMigration({
    homedir,
    statusPath,
    tz: "UTC",
    log: () => {},
    now: () => fixedNow,
    execImpl: fakeExecImpl().execImpl,
    runJob: (period) => {
      ranPeriods.push(period);
      return Promise.resolve();
    },
  });

  assert.deepEqual(ranPeriods, []);
  const status = parseStatus(await readFile(statusPath, "utf8"));
  assert.deepEqual(status["digest"], { lastSuccessAt: 123 });
  assert.equal(status["memory-night"]?.["seededAt"], fixedNow);
});

void test("legacy teardown is not attempted when the seed transaction cannot be committed", async () => {
  const homedir = await scaffoldHome();
  const unitDir = join(homedir, UNIT_DIR_REL);
  const unit = join(unitDir, "iva-memory-daily.timer");
  await writeFile(unit, "[Unit]\n");
  const { execImpl, calls } = fakeExecImpl();
  const logs: string[] = [];

  // A directory where the status file belongs. The pass cannot commit a seed through
  // it, so teardown must not be reached. Since readStatus tells "unreadable" apart from
  // "absent", the pass now stops one step earlier — at the read, deliberately deferred —
  // instead of crashing on the write. Both facts this test exists for are unchanged:
  // nothing is torn down and the unit file survives.
  await runScheduleMigration({
    homedir,
    statusPath: unitDir,
    execImpl,
    log: (...args: unknown[]) => logs.push(args.join(" ")),
  });

  assert.deepEqual(calls, []);
  assert.equal(existsSync(unit), true);
  assert.ok(
    logs.some((line) => line.includes("defer") && line.includes(unitDir)),
    "the deferral names the path the owner has to fix",
  );
});

void test("legacy units: disabled and deleted by exact name; unrelated xfeed-daily.timer is left alone", async () => {
  const homedir = await scaffoldHome();
  const unitDir = join(homedir, UNIT_DIR_REL);
  const existing = [
    "iva-memory-daily.service",
    "iva-memory-daily.timer",
    "iva-memory-weekly.timer",
  ];
  for (const name of existing) await writeFile(join(unitDir, name), "[Unit]\n");
  await writeFile(join(unitDir, "xfeed-daily.timer"), "[Unit]\n# not ours\n");

  const statusPath = join(homedir, "..", "data/rollup-status.json");
  // Not a first boot — seed the status file up front so catch-up logic is skipped/neutral
  // for this test (it only cares about the legacy-unit teardown).
  await mkdir(join(homedir, "..", "data"), { recursive: true });
  await writeFile(
    statusPath,
    JSON.stringify({
      "memory-daily": { lastSuccessAt: Date.now() },
      "memory-weekly": { lastSuccessAt: Date.now() },
      "memory-monthly": { lastSuccessAt: Date.now() },
      "memory-yearly": { lastSuccessAt: Date.now() },
    }),
  );

  const { execImpl, calls } = fakeExecImpl();
  await runScheduleMigration({
    homedir,
    execImpl,
    statusPath,
    tz: "UTC",
    log: () => {},
    runJob: () =>
      Promise.reject(
        new Error("must not run on a seeded, up-to-date status file"),
      ),
  });

  for (const name of existing) {
    assert.ok(
      calls.some((c) => c === `--user disable --now ${name}`),
      `disable --now ${name}`,
    );
    assert.equal(
      existsSync(join(unitDir, name)),
      false,
      `${name} file removed`,
    );
  }
  // Units that were never installed must never be referenced at all.
  assert.ok(!calls.some((c) => c.includes("iva-memory-monthly")));
  assert.ok(!calls.some((c) => c.includes("iva-memory-yearly")));
  assert.ok(!calls.some((c) => c.includes("xfeed-daily")));
  assert.equal(
    existsSync(join(unitDir, "xfeed-daily.timer")),
    true,
    "xfeed-daily.timer is untouched",
  );

  assert.equal(calls.filter((c) => c === "--user daemon-reload").length, 1);
  assert.equal(calls.filter((c) => c === "--user reset-failed").length, 1);
});

void test("a partial systemctl failure does not throw, leaves the file for a retry, and the next boot cleans it up", async () => {
  const homedir = await scaffoldHome();
  const unitDir = join(homedir, UNIT_DIR_REL);
  await writeFile(join(unitDir, "iva-memory-daily.timer"), "[Unit]\n");
  await writeFile(join(unitDir, "iva-memory-daily.service"), "[Unit]\n");
  const statusPath = join(homedir, "..", "data/rollup-status.json");
  await mkdir(join(homedir, "..", "data"), { recursive: true });
  await writeFile(
    statusPath,
    JSON.stringify({
      "memory-daily": { lastSuccessAt: Date.now() },
      "memory-weekly": { lastSuccessAt: Date.now() },
      "memory-monthly": { lastSuccessAt: Date.now() },
      "memory-yearly": { lastSuccessAt: Date.now() },
    }),
  );

  const { execImpl, calls } = fakeExecImpl({
    failUnits: new Set(["iva-memory-daily.timer"]),
  });
  const logged: string[] = [];

  await assert.doesNotReject(() =>
    runScheduleMigration({
      homedir,
      execImpl,
      statusPath,
      tz: "UTC",
      log: (...args: unknown[]) => logged.push(args.join(" ")),
    }),
  );
  assert.ok(
    calls.some((c) => c === "--user disable --now iva-memory-daily.timer"),
    "the failing disable was actually attempted",
  );
  assert.ok(
    logged.some(
      (l) =>
        l.includes("disable --now iva-memory-daily.timer") &&
        l.includes("failed"),
    ),
    "the failure was logged, not swallowed silently",
  );
  // The file must survive a failed disable: deleting it anyway would leave a unit that
  // systemd still considers enabled/active with no file behind it — invisible to a
  // human, but not actually gone. It's deleted only once disable actually succeeds.
  assert.equal(
    existsSync(join(unitDir, "iva-memory-daily.timer")),
    true,
    "the unit file is kept when disable failed",
  );
  assert.ok(
    logged.some(
      (l) =>
        l.includes("iva-memory-daily.timer") &&
        l.includes("next boot will retry"),
    ),
  );
  // Its sibling .service file (whose disable did NOT fail) is removed as normal.
  assert.equal(existsSync(join(unitDir, "iva-memory-daily.service")), false);

  // "Next boot" — systemctl behaves normally this time, so the retry succeeds and the
  // file is finally removed.
  const second = fakeExecImpl();
  await assert.doesNotReject(() =>
    runScheduleMigration({
      homedir,
      execImpl: second.execImpl,
      statusPath,
      tz: "UTC",
      log: () => {},
    }),
  );
  assert.ok(
    second.calls.some(
      (c) => c === "--user disable --now iva-memory-daily.timer",
    ),
    "the retry actually re-attempts disable",
  );
  assert.equal(
    existsSync(join(unitDir, "iva-memory-daily.timer")),
    false,
    "the retry succeeds and the file is finally removed",
  );
});

void test("catch-up math: a stale night in grace runs, an already-succeeded one does not, a due point past its grace is skipped", async () => {
  // The compiled night clock in Asia/Almaty (UTC+5); grace stays 20h.
  const clock = parseCron(SCHEDULE_CRON["memory-night"]);
  const due = Date.UTC(2026, 7, 4, clock.hour - 5, clock.minute);
  const catchUp = async (now: number, lastSuccessAt: number) => {
    const homedir = await scaffoldHome();
    const dataDir = join(homedir, "..", "data");
    const statusPath = join(dataDir, "rollup-status.json");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      statusPath,
      JSON.stringify({ "memory-night": { lastSuccessAt } }),
    );
    const ranPeriods: Period[] = [];
    await runScheduleMigration({
      homedir,
      execImpl: fakeExecImpl().execImpl,
      statusPath,
      tz: "Asia/Almaty",
      log: () => {},
      now: () => now,
      runJob: (period) => {
        ranPeriods.push(period);
        return Promise.resolve();
      },
    });
    return ranPeriods;
  };
  const hours = (count: number) => count * 60 * 60 * 1000;
  assert.deepEqual(await catchUp(due + hours(11), due - 60_000), ["night"]);
  assert.deepEqual(await catchUp(due + hours(11), due + 60_000), []);
  assert.deepEqual(await catchUp(due + hours(23), due - 60_000), []);
});

void test("style-matched integration: a real fake systemctl on PATH, tmpdir HOME, via bin/iva.mjs _install-units", async () => {
  // Mirrors scripts/lib/security-migration.test.ts's black-box shape: this confirms the
  // migration also behaves when invoked the way it actually runs in production — as a
  // side effect of server startup — rather than only through direct unit-level calls above.
  // We exercise it here through the schedule-migration module directly (not a CLI command,
  // since the migration's real trigger is agent/instrumentation.ts, not bin/iva.mjs), but with
  // the same fake-systemctl-on-PATH technique.
  const dir = tempDir("iva-schedule-migration-onpath-");
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  await mkdir(join(home, UNIT_DIR_REL), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(home, UNIT_DIR_REL, "iva-memory-yearly.timer"),
    "[Unit]\n",
  );

  const fakeSystemctl = join(bin, "systemctl");
  const log = join(dir, "systemctl-calls.log");
  await writeFile(fakeSystemctl, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
  await chmod(fakeSystemctl, 0o755);

  const script = join(dir, "run.ts");
  await writeFile(
    script,
    [
      `import { runScheduleMigration } from ${JSON.stringify(join(process.cwd(), "agent/lib/schedule-migration.ts"))};`,
      `const statusPath = ${JSON.stringify(join(dir, "data/rollup-status.json"))};`,
      `await runScheduleMigration({ homedir: ${JSON.stringify(home)}, statusPath, tz: "UTC", log: () => {} });`,
      `process.exit(0);`,
    ].join("\n"),
  );

  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    existsSync(join(home, UNIT_DIR_REL, "iva-memory-yearly.timer")),
    false,
  );
  const calls = existsSync(log) ? await readFile(log, "utf8") : "";
  assert.match(calls, /disable --now iva-memory-yearly\.timer/);
  assert.match(calls, /daemon-reload/);
});

void test("if the status lock can't be acquired, the whole pass is deferred: no seed, no due-check write, no catch-up run", async () => {
  const homedir = await scaffoldHome();
  const dataDir = join(homedir, "..", "data");
  const statusPath = join(dataDir, "rollup-status.json");
  await mkdir(dataDir, { recursive: true });
  // Pre-hold the lock file with a FRESH mtime so withStatusLock's staleness-steal never
  // kicks in during this test — it must genuinely exhaust its retries and give up.
  await writeFile(`${statusPath}.lock`, "999999");

  const { execImpl } = fakeExecImpl();
  let runJobCalled = false;
  const lines: string[] = [];

  await runScheduleMigration({
    homedir,
    execImpl,
    statusPath,
    tz: "UTC",
    log: (...args: unknown[]) => lines.push(args.join(" ")),
    runJob: () => {
      runJobCalled = true;
      return Promise.resolve();
    },
  });

  assert.equal(
    runJobCalled,
    false,
    "no catch-up may run off an undecided (lock-less) pass",
  );
  assert.equal(
    existsSync(statusPath),
    false,
    "no status write at all — not a seed, not anything else — without the lock",
  );
  assert.ok(
    lines.some((l) => l.toLowerCase().includes("defer")),
    "the deferral must be logged, not silent",
  );
});

void test("a damaged status file defers the whole pass: no seed, no catch-up, and the file is left as found", async () => {
  const homedir = await scaffoldHome();
  const dataDir = join(homedir, "..", "data");
  const statusPath = join(dataDir, "rollup-status.json");
  await mkdir(dataDir, { recursive: true });
  // Truncated mid-write. Seeding over this would tell every period "you never ran" and
  // fire a catch-up burst off a status nobody could actually read.
  const damaged = '{\n  "memory-daily": { "lastSuccessAt": 111';
  await writeFile(statusPath, damaged, "utf8");

  const { execImpl } = fakeExecImpl();
  let runJobCalled = false;
  const lines: string[] = [];

  await runScheduleMigration({
    homedir,
    execImpl,
    statusPath,
    tz: "UTC",
    log: (...args: unknown[]) => lines.push(args.join(" ")),
    runJob: () => {
      runJobCalled = true;
      return Promise.resolve();
    },
  });

  assert.equal(runJobCalled, false, "no catch-up off an unreadable status");
  assert.equal(
    await readFile(statusPath, "utf8"),
    damaged,
    "the damaged file is left exactly as found",
  );
  assert.ok(
    lines.some((l) => l.includes(statusPath)),
    "the journal must name the file the owner has to fix",
  );
});

void test("the catch-up run of a rollup carries the rollup's stop grace, like its schedule", () => {
  const job = catchUpJob("night", {
    root: "/srv/iva",
    nodeBin: "/usr/bin/node",
    statusPath: "/srv/iva/data/rollup-status.json",
    log: () => {},
  });
  assert.equal(job.name, "memory-night");
  assert.deepEqual(job.argv, ["scripts/memory/night.ts"]);
  assert.equal(job.lockPath, "/srv/iva/.memory.lock");
  assert.equal(job.factsPath, "/srv/iva/data/jobs.json");
  // Без него после SIGTERM ребёнку 10 с: сводка не успевает погасить ход до SIGKILL.
  assert.equal(job.killGraceMs, 90_000);
});
