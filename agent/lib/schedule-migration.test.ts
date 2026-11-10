import { strict as assert } from "node:assert";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { catchUpJob, runScheduleMigration } from "./schedule-migration.ts";
import { parseCron, SCHEDULE_CRON } from "./schedule-table.ts";
import { tempDir } from "../../scripts/fixtures/temp-dir.ts";

type MigrationOptions = NonNullable<Parameters<typeof runScheduleMigration>[0]>;
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

void test("first boot (no status file): seeds a baseline (seededAt, NOT lastSuccessAt) for the night and runs nothing", async () => {
  const homedir = await scaffoldHome();
  const dataDir = join(homedir, "..", "data");
  const statusPath = join(dataDir, "rollup-status.json");
  const ranPeriods: Period[] = [];
  const fixedNow = Date.UTC(2026, 7, 4, 10, 0, 0);

  await runScheduleMigration({
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
    statusPath,
    tz: "UTC",
    log: () => {},
    now: () => fixedNow,
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

void test("a status path that cannot be read defers the pass and names the path", async () => {
  const homedir = await scaffoldHome();
  const unitDir = join(homedir, UNIT_DIR_REL);
  const logs: string[] = [];

  // A directory where the status file belongs: the read fails, the pass is deferred.
  await runScheduleMigration({
    statusPath: unitDir,
    log: (...args: unknown[]) => logs.push(args.join(" ")),
  });

  assert.ok(
    logs.some((line) => line.includes("defer") && line.includes(unitDir)),
    "the deferral names the path the owner has to fix",
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

// UpdateFloor.NoSilentLoss: the eight iva-memory-{daily,weekly,monthly,yearly} units belong
// to releases below the floor. The server start neither removes them nor calls systemctl:
// a real fake systemctl on PATH would record any call.
void test("NoSilentLoss: units of a release below the floor stay byte for byte and systemctl is never called", async () => {
  const dir = tempDir("iva-schedule-migration-onpath-");
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  await mkdir(join(home, UNIT_DIR_REL), { recursive: true });
  await mkdir(bin, { recursive: true });
  const old = new Map([
    ["iva-memory-daily.service", "[Service]\nExecStart=/bin/true\n"],
    ["iva-memory-daily.timer", "[Timer]\nOnCalendar=daily\n"],
    ["iva-memory-yearly.timer", "[Timer]\nOnCalendar=yearly\n"],
  ]);
  for (const [unit, body] of old)
    await writeFile(join(home, UNIT_DIR_REL, unit), body);

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
      `await runScheduleMigration({ statusPath, tz: "UTC", log: () => {} });`,
      `await runScheduleMigration({ statusPath, tz: "UTC", log: () => {} });`,
      `process.exit(0);`,
    ].join("\n"),
  );

  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const [unit, body] of old)
    assert.equal(
      await readFile(join(home, UNIT_DIR_REL, unit), "utf8"),
      body,
      unit,
    );
  assert.equal(existsSync(log), false, "systemctl was called");
  assert.equal(existsSync(join(dir, "data/rollup-status.json")), true);
});

void test("if the status lock can't be acquired, the whole pass is deferred: no seed, no due-check write, no catch-up run", async () => {
  const homedir = await scaffoldHome();
  const dataDir = join(homedir, "..", "data");
  const statusPath = join(dataDir, "rollup-status.json");
  await mkdir(dataDir, { recursive: true });
  // Pre-hold the lock file with a FRESH mtime so withStatusLock's staleness-steal never
  // kicks in during this test — it must genuinely exhaust its retries and give up.
  await writeFile(`${statusPath}.lock`, "999999");

  let runJobCalled = false;
  const lines: string[] = [];

  await runScheduleMigration({
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

  let runJobCalled = false;
  const lines: string[] = [];

  await runScheduleMigration({
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
