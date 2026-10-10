import { strict as assert } from "node:assert";
import test, { type TestContext } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as systemdControl from "./systemd-control.ts";
import { plantCliTree } from "../fixtures/cli-tree.ts";

const { createSystemdControl } = systemdControl;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SECRET = "iva-systemd-test-secret-do-not-log";

interface RunCommandOptions {
  readonly args?: readonly string[];
  readonly exit?: number;
  readonly failAction?: string;
  readonly inactiveUnit?: string;
  readonly failedUnit?: string;
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "iva-systemd-activation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const project = join(dir, "iva");
  const home = join(dir, "home");
  const fakeBin = join(dir, "bin");
  const calls = join(dir, "systemctl.calls");
  const state = join(dir, "systemd-state");
  const envPath = join(project, ".env");
  const userbotDir = join(project, "services/telegram-userbot");
  await mkdir(join(project, ".output/server"), { recursive: true });
  await mkdir(join(userbotDir, ".venv/bin"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(state, { recursive: true });
  await plantCliTree(ROOT, project, { copy: ["scripts/cli"] });
  // The real nightly entrypoint: the retained-legacy-unit tests check that the unit kept on
  // disk names a script that actually exists in the tree it will run against.
  await symlink(
    join(ROOT, "scripts/memory"),
    join(project, "scripts/memory"),
    "dir",
  );
  await writeFile(join(project, ".output/server/index.mjs"), "");
  await copyFile(
    join(ROOT, "services/telegram-userbot/requirements.lock"),
    join(userbotDir, "requirements.lock"),
  );
  await writeFile(join(userbotDir, ".venv/bin/python"), "#!/bin/sh\nexit 0\n");
  await chmod(join(userbotDir, ".venv/bin/python"), 0o755);
  await writeFile(
    envPath,
    `MODEL_PROVIDER=codex\nOPENAI_API_KEY=${SECRET}\nTELEGRAM_API_ID=12345\nTELEGRAM_API_HASH=old-desired-hash\n`,
    { mode: 0o600 },
  );

  const fakeUv = join(fakeBin, "uv");
  await writeFile(fakeUv, "#!/bin/sh\nexit 0\n");
  await chmod(fakeUv, 0o755);

  const fakeSystemctl = join(fakeBin, "systemctl");
  await writeFile(
    fakeSystemctl,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$IVA_FAKE_SYSTEMCTL_CALLS"',
      '[ "$1" = "--user" ] && shift',
      'action="$1"',
      "shift",
      'if [ "${IVA_FAKE_SYSTEMCTL_EXIT:-0}" -ne 0 ] && { [ -z "${IVA_FAKE_FAIL_ACTION:-}" ] || [ "$IVA_FAKE_FAIL_ACTION" = "$action" ]; }; then',
      '  printf "fake systemctl failure: %s\\n" "$IVA_FAKE_SECRET_OUTPUT" >&2',
      '  exit "$IVA_FAKE_SYSTEMCTL_EXIT"',
      "fi",
      'case "$action" in',
      "  show)",
      '    unit="$1"',
      '    if [ -f "$HOME/.config/systemd/user/$unit" ]; then echo loaded; else echo not-found; fi',
      "    ;;",
      "  enable)",
      '    now=0; [ "${1:-}" = "--now" ] && { now=1; shift; }',
      '    unit="$1"',
      '    : > "$IVA_FAKE_SYSTEMD_STATE/$unit.enabled"',
      '    if [ "$now" -eq 1 ] && [ "${IVA_FAKE_INACTIVE_UNIT:-}" != "$unit" ]; then : > "$IVA_FAKE_SYSTEMD_STATE/$unit.active"; fi',
      "    ;;",
      "  start)",
      '    unit="$1"',
      '    if [ "${IVA_FAKE_INACTIVE_UNIT:-}" != "$unit" ]; then : > "$IVA_FAKE_SYSTEMD_STATE/$unit.active"; fi',
      "    ;;",
      "  restart)",
      '    unit="$1"',
      '    if [ "${IVA_FAKE_INACTIVE_UNIT:-}" != "$unit" ]; then : > "$IVA_FAKE_SYSTEMD_STATE/$unit.active"; fi',
      "    ;;",
      "  stop)",
      '    rm -f "$IVA_FAKE_SYSTEMD_STATE/$1.active"',
      "    ;;",
      "  disable)",
      '    [ "${1:-}" = "--now" ] && shift',
      '    rm -f "$IVA_FAKE_SYSTEMD_STATE/$1.enabled" "$IVA_FAKE_SYSTEMD_STATE/$1.active"',
      "    ;;",
      "  is-enabled)",
      '    if [ -f "$IVA_FAKE_SYSTEMD_STATE/$1.enabled" ]; then echo enabled; else echo disabled; exit 1; fi',
      "    ;;",
      "  is-active)",
      '    if [ -f "$IVA_FAKE_SYSTEMD_STATE/$1.active" ]; then echo active; else echo inactive; exit 3; fi',
      "    ;;",
      "  is-failed)",
      '    if [ "${IVA_FAKE_FAILED_UNIT:-}" = "$1" ]; then echo failed; else echo inactive; exit 1; fi',
      "    ;;",
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(fakeSystemctl, 0o755);

  const runCommand = (
    command: string,
    {
      args = [],
      exit = 0,
      failAction = "",
      inactiveUnit = "",
      failedUnit = "",
    }: RunCommandOptions = {},
  ) =>
    spawnSync(
      process.execPath,
      [join(project, "bin/iva.mjs"), command, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          NO_COLOR: "1",
          PATH: `${fakeBin}:/usr/bin:/bin`,
          IVA_FAKE_SYSTEMCTL_CALLS: calls,
          IVA_FAKE_SYSTEMCTL_EXIT: String(exit),
          IVA_FAKE_FAIL_ACTION: failAction,
          IVA_FAKE_SECRET_OUTPUT: SECRET,
          IVA_FAKE_SYSTEMD_STATE: state,
          IVA_FAKE_INACTIVE_UNIT: inactiveUnit,
          IVA_FAKE_FAILED_UNIT: failedUnit,
        },
      },
    );

  const runScript = (script: string) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        NO_COLOR: "1",
        PATH: `${fakeBin}:/usr/bin:/bin`,
        IVA_FAKE_SYSTEMCTL_CALLS: calls,
        IVA_FAKE_SYSTEMCTL_EXIT: "0",
        IVA_FAKE_FAIL_ACTION: "",
        IVA_FAKE_SECRET_OUTPUT: SECRET,
        IVA_FAKE_SYSTEMD_STATE: state,
        IVA_FAKE_INACTIVE_UNIT: "",
        IVA_FAKE_FAILED_UNIT: "",
      },
    });

  return {
    calls,
    envPath,
    home,
    project,
    state,
    runStart: (exit = 0) => runCommand("start", { exit }),
    runCommand,
    runScript,
    seedQuarantineFailure: async () => {
      const eveDir = join(project, ".eve");
      await mkdir(join(eveDir, ".workflow-data"), { recursive: true });
      await chmod(eveDir, 0o500);
    },
    seedUnit: async (unit: string) => {
      await writeFile(join(state, `${unit}.enabled`), "");
      await writeFile(join(state, `${unit}.active`), "");
    },
  };
}

void test("iva start propagates a systemctl enable failure", async (t) => {
  const { runStart } = await fixture(t);
  const result = runStart(1);

  assert.equal(result.status, 1, result.stderr || result.stdout);
});

void test("iva start does not print success after a systemctl enable failure", async (t) => {
  const { runStart } = await fixture(t);
  const result = runStart(1);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.doesNotMatch(output, /Started and enabled at boot/);
});

void test("iva start is idempotent when systemctl reports success", async (t) => {
  const { calls, runStart } = await fixture(t);
  const first = runStart();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const firstCalls = (await readFile(calls, "utf8")).trim().split("\n");

  const second = runStart();
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const allCalls = (await readFile(calls, "utf8")).trim().split("\n");

  assert.deepEqual(allCalls.slice(firstCalls.length), firstCalls);
});

void test("iva start diagnostics do not expose .env secrets", async (t) => {
  const { runStart } = await fixture(t);
  const result = runStart(1);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.doesNotMatch(output, new RegExp(SECRET));
});

void test("iva start reports the exact unit journal after activation fails", async (t) => {
  const { runStart } = await fixture(t);
  const result = runStart(1);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.match(output, /journalctl --user -u iva\.service -n 100 --no-pager/);
  assert.doesNotMatch(output, /fake systemctl failure/);
});

void test("iva start waits for enabled and active postconditions", async (t) => {
  const { runCommand } = await fixture(t);
  const result = runCommand("start", { inactiveUnit: "iva.service" });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /iva\.service did not become active/);
  assert.doesNotMatch(output, /Started and enabled at boot/);
});

void test("installer activation seam uses the same checked CLI path", async (t) => {
  const { runCommand } = await fixture(t);
  const result = runCommand("_activate-units", { exit: 1 });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const installer = await readFile(join(ROOT, "install.sh"), "utf8");
  assert.match(installer, /bin\/iva\.mjs" _activate-units/);
  assert.doesNotMatch(installer, /^\s*systemctl --user enable --now/m);
});

void test("doctor reports checked activation failures and keeps its summary", async (t) => {
  const { runCommand } = await fixture(t);
  const result = runCommand("doctor", { exit: 1, failAction: "enable" });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /journalctl --user -u iva\.service -n 100 --no-pager/);
  assert.match(output, /Summary:/);
  assert.doesNotMatch(output, /Units installed, enabled and active/);
});

void test("doctor checks the installed brain service and reports a failed one with a journal hint", async (t) => {
  // daily/weekly/monthly/yearly moved to in-process eve schedules (agent/schedules/memory-*.ts,
  // see agent/lib/schedule-migration.ts) — brain stays the only external systemd watchdog.
  const { calls, runCommand } = await fixture(t);
  const result = runCommand("doctor", {
    failedUnit: "iva-brain.service",
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const systemctlCalls = (await readFile(calls, "utf8")).trim().split("\n");
  const checked = systemctlCalls
    .filter((call) => call.startsWith("--user is-failed "))
    .map((call) => call.split(" ").at(-1));

  assert.equal(result.status, 1, output);
  assert.deepEqual(checked, ["iva-brain.service"]);
  assert.match(output, /iva-brain\.service failed/);
  assert.match(
    output,
    /journalctl --user -u iva-brain\.service -n 100 --no-pager/,
  );
});

void test("doctor checks the single memory-night schedule", async (t) => {
  const { project, runCommand } = await fixture(t);
  const now = Date.now();
  await mkdir(join(project, "data"), { recursive: true });
  await writeFile(
    join(project, "data/rollup-status.json"),
    JSON.stringify({
      "memory-night": { lastSuccessAt: now - 27 * 60 * 60 * 1000 },
    }),
  );

  const result = runCommand("doctor");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /memory-night schedule hasn't succeeded/);
  assert.doesNotMatch(output, /memory-daily schedule/u);
  assert.doesNotMatch(output, /memory-weekly schedule/u);
  assert.doesNotMatch(output, /memory-monthly schedule/u);
  assert.doesNotMatch(output, /memory-yearly schedule/u);
});

void test("doctor warns on a non-zero last exit code even right after a fresh success", async (t) => {
  const { project, runCommand } = await fixture(t);
  const now = Date.now();
  await mkdir(join(project, "data"), { recursive: true });
  await writeFile(
    join(project, "data/rollup-status.json"),
    JSON.stringify({
      // Recently succeeded (well inside the 26h nightly threshold)...
      "memory-night": { lastSuccessAt: now - 60 * 60 * 1000, lastExitCode: 1 },
      // ...but the run recorded here is the LATEST attempt, and it failed after that
      // success (e.g. a retry). The staleness check alone would call this fine.
    }),
  );

  const result = runCommand("doctor");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.match(output, /memory-night schedule last succeeded/);
  assert.match(output, /memory-night schedule's last run exited 1/);
  // На этой установке нет authored tree: раздел расписаний по data/jobs.json читать
  // нечем, и он обязан молчать — про дерево доктор уже сказал своей строкой.
  assert.match(output, /the agent tree is missing/);
  assert.doesNotMatch(output, /таблица фактов не читается/);
});

void test("legacy memory-timer cleanup is skipped when the current build doesn't contain the eve schedules yet", async (t) => {
  const { home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await mkdir(unitDir, { recursive: true });
  await writeFile(join(unitDir, "iva-memory-daily.timer"), "[Unit]\n");
  // The fixture's stub .output/server/index.mjs is empty — no schedule names in it,
  // i.e. exactly what a build made before this migration landed looks like.
  await writeFile(join(project, ".output/server/index.mjs"), "");

  const result = runCommand("restart");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /skipping legacy memory-timer cleanup/);
  assert.equal(
    existsSync(join(unitDir, "iva-memory-daily.timer")),
    true,
    "the legacy unit is left alone on a stale build",
  );
});

void test("a build that only bundles LEGACY_MEMORY_UNITS strings (not the compiled schedules) still counts as stale", async (t) => {
  // Regression test: instrumentation.ts always imports schedule-migration.ts, whose
  // LEGACY_MEMORY_UNITS array contains "iva-memory-daily.service" — which itself
  // contains "memory-daily" as a substring. A marker that was just the bare string
  // "memory-daily" would match THIS text and wrongly conclude the schedules compiled.
  const { home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await mkdir(unitDir, { recursive: true });
  await writeFile(join(unitDir, "iva-memory-daily.timer"), "[Unit]\n");
  await writeFile(
    join(project, ".output/server/index.mjs"),
    'const LEGACY_MEMORY_UNITS = ["iva-memory-daily.service", "iva-memory-daily.timer"];\n',
  );

  const result = runCommand("restart");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(
    output,
    /skipping legacy memory-timer cleanup/,
    "the legacy-units array text must not be mistaken for a compiled schedule",
  );
  assert.equal(existsSync(join(unitDir, "iva-memory-daily.timer")), true);
});

// Mirrors the actual shape Nitro's schedule-task wrapper compiles (see a real
// `.output/server/_virtual/*.schedule.mjs`) — the description string embeds the
// schedule's own source path, which is what BUILD_SCHEDULE_MARKERS looks for.
const scheduleDescriptionMjs = (period: string): string =>
  `var eve_schedule_default = { meta: { description: 'Run eve schedule "memory-${period}" from "schedules/memory-${period}.ts".' } };\n`;

function updaterMemoryTransferScript(
  project: string,
  afterRestart = "",
): string {
  const runtime = pathToFileURL(join(project, "scripts/cli/runtime.ts")).href;
  const systemd = pathToFileURL(join(project, "scripts/cli/systemd.ts")).href;
  return `
    const { createCliRuntime } = await import(${JSON.stringify(runtime)});
    const { createCliSystemd } = await import(${JSON.stringify(systemd)});
    const runtime = createCliRuntime(${JSON.stringify(project)});
    const services = createCliSystemd(runtime);
    services.restartServices({ deferMemoryMigration: true });
    ${afterRestart}
  `;
}

async function seedCompiledMemorySchedules(project: string): Promise<void> {
  await mkdir(join(project, ".output/server/_virtual"), { recursive: true });
  await writeFile(
    join(project, ".output/server/_virtual/eve-night.schedule.mjs"),
    scheduleDescriptionMjs("night"),
  );
}

void test("legacy memory-timer cleanup proceeds once the build contains memory-night", async (t) => {
  const { calls, home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await mkdir(unitDir, { recursive: true });
  await writeFile(join(unitDir, "iva-memory-daily.timer"), "[Unit]\n");
  await mkdir(join(project, ".output/server/_virtual"), { recursive: true });
  await writeFile(
    join(project, ".output/server/_virtual/eve-night.schedule.mjs"),
    scheduleDescriptionMjs("night"),
  );

  const result = runCommand("restart");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /skipping legacy memory-timer cleanup/);
  assert.equal(
    existsSync(join(unitDir, "iva-memory-daily.timer")),
    false,
    "a build that has the single night schedule lets cleanup proceed",
  );
  const systemctlCalls = (await readFile(calls, "utf8")).trim().split("\n");
  assert.ok(
    systemctlCalls.some(
      (c) => c === "--user disable --now iva-memory-daily.timer",
    ),
  );
});

void test("an updater restart keeps legacy memory recoverable while live health is pending", async (t) => {
  const { calls, home, project, runScript, seedUnit, state } = await fixture(t);
  const unit = "iva-memory-daily.timer";
  const unitDir = join(home, ".config/systemd/user");
  await mkdir(unitDir, { recursive: true });
  await writeFile(join(unitDir, unit), "[Unit]\n");
  await seedUnit(unit);
  await seedCompiledMemorySchedules(project);

  const result = runScript(updaterMemoryTransferScript(project));
  const output = `${result.stdout}\n${result.stderr}`;
  const systemctlCalls = (await readFile(calls, "utf8")).trim().split("\n");

  assert.equal(result.status, 0, output);
  assert.equal(existsSync(join(unitDir, unit)), true);
  assert.equal(existsSync(join(state, `${unit}.enabled`)), true);
  assert.equal(existsSync(join(state, `${unit}.active`)), true);
  assert.equal(systemctlCalls.includes(`--user disable --now ${unit}`), false);
});

void test("committed updater cleanup retires legacy memory after active-owner proof", async (t) => {
  const { home, project, runScript } = await fixture(t);
  const unit = "iva-memory-daily.timer";
  const unitDir = join(home, ".config/systemd/user");
  await mkdir(unitDir, { recursive: true });
  await writeFile(join(unitDir, unit), "[Unit]\n");
  await seedCompiledMemorySchedules(project);

  const result = runScript(
    updaterMemoryTransferScript(project, "services.retireLegacyMemoryUnits();"),
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.equal(existsSync(join(unitDir, unit)), false);
});

void test("committed updater cleanup keeps legacy memory when the new owner is inactive", async (t) => {
  const { calls, home, project, runScript } = await fixture(t);
  const unit = "iva-memory-daily.timer";
  const unitDir = join(home, ".config/systemd/user");
  await mkdir(unitDir, { recursive: true });
  await writeFile(join(unitDir, unit), "[Unit]\n");
  await seedCompiledMemorySchedules(project);

  const result = runScript(
    updaterMemoryTransferScript(
      project,
      "runtime.systemd.stop(runtime.SERVICES); services.retireLegacyMemoryUnits();",
    ),
  );
  const systemctlCalls = (await readFile(calls, "utf8")).trim().split("\n");

  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(unitDir, unit)), true);
  assert.equal(systemctlCalls.includes(`--user disable --now ${unit}`), false);
});

void test("a restart fault after unit write keeps legacy memory units and their state", async (t) => {
  const { calls, home, project, runCommand, seedUnit, state } =
    await fixture(t);
  const unit = "iva-memory-daily.timer";
  const unitDir = join(home, ".config/systemd/user");
  await mkdir(unitDir, { recursive: true });
  await writeFile(join(unitDir, unit), "[Unit]\n");
  await seedUnit(unit);
  await mkdir(join(project, ".output/server/_virtual"), { recursive: true });
  for (const period of ["daily", "weekly", "monthly", "yearly"]) {
    await writeFile(
      join(project, `.output/server/_virtual/eve-${period}.schedule.mjs`),
      scheduleDescriptionMjs(period),
    );
  }

  const result = runCommand("restart", { exit: 1, failAction: "restart" });
  const output = `${result.stdout}\n${result.stderr}`;
  const systemctlCalls = (await readFile(calls, "utf8")).trim().split("\n");

  assert.equal(result.status, 1, output);
  assert.equal(await readFile(join(unitDir, unit), "utf8"), "[Unit]\n");
  assert.equal(existsSync(join(state, `${unit}.enabled`)), true);
  assert.equal(existsSync(join(state, `${unit}.active`)), true);
  assert.ok(systemctlCalls.includes("--user restart iva.service"));
  assert.equal(systemctlCalls.includes(`--user disable --now ${unit}`), false);
});

void test("a build without memory-night keeps legacy units", async (t) => {
  const { home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await mkdir(unitDir, { recursive: true });
  for (const period of ["daily", "weekly", "monthly", "yearly"]) {
    await writeFile(join(unitDir, `iva-memory-${period}.timer`), "[Unit]\n");
  }
  await mkdir(join(project, ".output/server/_virtual"), { recursive: true });
  await writeFile(
    join(project, ".output/server/_virtual/eve.schedule.mjs"),
    scheduleDescriptionMjs("daily"),
  );

  const result = runCommand("restart");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(
    output,
    /skipping legacy memory-timer cleanup/,
    "a retired schedule marker must not stand in for memory-night",
  );
  for (const period of ["daily", "weekly", "monthly", "yearly"]) {
    assert.equal(
      existsSync(join(unitDir, `iva-memory-${period}.timer`)),
      true,
      `${period}'s legacy unit survives a partial build`,
    );
  }
});

// ── Brain rename: iva-memory-doctor.{service,timer} → iva-brain.{service,timer} ─────────
// The nightly vault care is the one thing that must never be absent, so the migration is
// ordered: write the new timer, enable it, and only then tear the old pair down. Every test
// below drives the real CLI against the fake systemctl, so it proves the ORDER of the calls,
// not just the end state.

// Two units, one nightly job: the state an install carries before it is updated. The service
// body is the pre-rename one, placeholders already substituted the way writeUnits() left them
// — including the ExecStart naming scripts/memory/doctor.ts, which this tree no longer ships.
async function seedLegacyBrainUnits(
  unitDir: string,
  project: string,
): Promise<void> {
  await mkdir(unitDir, { recursive: true });
  await writeFile(
    join(unitDir, "iva-memory-doctor.service"),
    [
      "[Unit]",
      "Description=Iva nightly vault care (pre-rename unit)",
      "",
      "[Service]",
      "Type=oneshot",
      `WorkingDirectory=${project}`,
      `ExecStart=/usr/bin/flock -w 900 ${project}/.memory.lock ${process.execPath} --env-file=.env scripts/memory/doctor.ts`,
      "",
    ].join("\n"),
  );
  await writeFile(
    join(unitDir, "iva-memory-doctor.timer"),
    "[Unit]\nDescription=Iva nightly vault care (pre-rename unit)\n\n[Timer]\nOnCalendar=*-*-* 05:00:00\n",
  );
}

// What the retained unit will actually try to run: the trailing script path of its ExecStart,
// resolved against the project it runs in. A unit whose entrypoint is missing is a lost night,
// not a safety net — existsSync on the unit FILE proves nothing about that.
async function nightlyEntrypoint(
  unitDir: string,
  unit: string,
): Promise<string> {
  const body = await readFile(join(unitDir, unit), "utf8");
  const execStart = body.match(/^ExecStart=(.*)$/m);
  assert.ok(execStart, `${unit} has no ExecStart: ${body}`);
  return execStart[1].trim().split(/\s+/).at(-1) as string;
}

// At no point may a run leave the install with zero nightly units on disk.
function nightlyUnitsOnDisk(unitDir: string): string[] {
  return ["iva-brain.timer", "iva-memory-doctor.timer"].filter((unit) =>
    existsSync(join(unitDir, unit)),
  );
}

function updaterBrainTransferScript(project: string): string {
  const runtime = pathToFileURL(join(project, "scripts/cli/runtime.ts")).href;
  const systemd = pathToFileURL(join(project, "scripts/cli/systemd.ts")).href;
  const finish = pathToFileURL(join(ROOT, "scripts/update-finish.ts")).href;
  return `
    const { createCliRuntime } = await import(${JSON.stringify(runtime)});
    const { createCliSystemd } = await import(${JSON.stringify(systemd)});
    const {
      captureOptionalWriterState,
      restoreWriterOwnership,
      stopWriterUnits,
    } = await import(${JSON.stringify(finish)});
    const runtime = createCliRuntime(${JSON.stringify(project)});
    const before = captureOptionalWriterState(runtime);
    stopWriterUnits(runtime, before);
    let unitMigrationStarted = false;
    const services = createCliSystemd(runtime);
    services.restartServices({
      deferBrainMigration: true,
      afterUnitWrite: () => { unitMigrationStarted = true; },
    });
    restoreWriterOwnership(runtime, before, {
      unitMigrationStarted,
      legacyMemoryOwnerProven: true,
      userbotReady: true,
    });
    services.retireDeferredBrainUnits();
  `;
}

void test("a disabled legacy Brain timer stays disabled throughout updater ownership transfer", async (t) => {
  const { calls, home, project, runScript, state } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await seedLegacyBrainUnits(unitDir, project);

  const result = runScript(updaterBrainTransferScript(project));
  const output = `${result.stdout}\n${result.stderr}`;
  const systemctlCalls = existsSync(calls)
    ? (await readFile(calls, "utf8")).trim().split("\n")
    : [];

  assert.equal(result.status, 0, output);
  assert.equal(existsSync(join(state, "iva-brain.timer.enabled")), false);
  assert.equal(existsSync(join(state, "iva-brain.timer.active")), false);
  assert.equal(
    systemctlCalls.some(
      (call) =>
        call === "--user enable --now iva-brain.timer" ||
        call === "--user start iva-brain.timer",
    ),
    false,
  );
});

void test("an active legacy Brain timer can fire only after core restart and exact-state restore", async (t) => {
  const { calls, home, project, runScript, seedUnit } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await seedLegacyBrainUnits(unitDir, project);
  await seedUnit("iva-memory-doctor.timer");

  const result = runScript(updaterBrainTransferScript(project));
  const output = `${result.stdout}\n${result.stderr}`;
  const systemctlCalls = existsSync(calls)
    ? (await readFile(calls, "utf8")).trim().split("\n")
    : [];
  const coreRestart = systemctlCalls.indexOf("--user restart iva.service");
  const newTimerStart = systemctlCalls.indexOf("--user start iva-brain.timer");
  const oldTimerRetire = systemctlCalls.indexOf(
    "--user disable --now iva-memory-doctor.timer",
  );

  assert.equal(result.status, 0, output);
  assert.equal(
    systemctlCalls.includes("--user enable --now iva-brain.timer"),
    false,
  );
  assert.ok(coreRestart >= 0, systemctlCalls.join("\n"));
  assert.ok(newTimerStart > coreRestart, systemctlCalls.join("\n"));
  assert.ok(oldTimerRetire > newTimerStart, systemctlCalls.join("\n"));
});

void test("the brain rename enables the new timer BEFORE retiring the old memory-doctor pair", async (t) => {
  const { calls, home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await seedLegacyBrainUnits(unitDir, project);

  const result = runCommand("_install-units");
  const output = `${result.stdout}\n${result.stderr}`;
  const systemctlCalls = (await readFile(calls, "utf8")).trim().split("\n");

  assert.equal(result.status, 0, output);
  assert.equal(
    existsSync(join(unitDir, "iva-brain.timer")),
    true,
    "the new timer is installed",
  );
  assert.deepEqual(
    nightlyUnitsOnDisk(unitDir),
    ["iva-brain.timer"],
    "the old pair is gone and the new timer stands in its place",
  );
  assert.equal(existsSync(join(unitDir, "iva-memory-doctor.service")), false);

  const enabledNew = systemctlCalls.indexOf(
    "--user enable --now iva-brain.timer",
  );
  const activeNew = systemctlCalls.indexOf("--user is-active iva-brain.timer");
  const disabledOld = systemctlCalls.indexOf(
    "--user disable --now iva-memory-doctor.timer",
  );
  assert.ok(enabledNew >= 0, "the new timer is enabled by the migration");
  assert.ok(disabledOld >= 0, "the old timer is disabled by the migration");
  assert.ok(
    enabledNew < disabledOld && activeNew < disabledOld,
    `the new timer must be confirmed up first: ${systemctlCalls.join(" | ")}`,
  );
});

void test("the brain rename is idempotent and stops touching systemd once the old pair is gone", async (t) => {
  const { calls, home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await seedLegacyBrainUnits(unitDir, project);

  assert.equal(runCommand("_install-units").status, 0);
  await writeFile(calls, "");
  const second = runCommand("_install-units");

  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const systemctlCalls = (await readFile(calls, "utf8")).trim();
  assert.doesNotMatch(systemctlCalls, /enable --now iva-brain\.timer/);
  assert.doesNotMatch(systemctlCalls, /iva-memory-doctor/);
  assert.deepEqual(nightlyUnitsOnDisk(unitDir), ["iva-brain.timer"]);
});

// A half-unpacked deploy/: only the named units of the new pair landed — the shape that must
// make the migration keep the old pair. Used by every "the kept unit must still work" test
// below; the default (service only) is the tree an update died in before writing the timer.
async function partialDeploy(
  project: string,
  units: readonly string[] = ["iva-brain.service"],
): Promise<void> {
  const deploy = join(project, "deploy");
  await rm(deploy); // the fixture symlinks the real deploy/ — swap in a partial copy
  await mkdir(deploy, { recursive: true });
  for (const unit of units)
    await copyFile(join(ROOT, "deploy", unit), join(deploy, unit));
}

void test("an update interrupted before deploy/ carries iva-brain.timer keeps the old nightly unit", async (t) => {
  // A half-extracted tree: the new service file landed, the timer did not. Removing the old
  // pair here would leave the install with no nightly vault care at all until the next
  // successful update — the exact night this migration must not cost anyone.
  const { home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await seedLegacyBrainUnits(unitDir, project);
  await partialDeploy(project);

  const result = runCommand("_install-units");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /skipping legacy brain-unit cleanup/);
  assert.deepEqual(
    nightlyUnitsOnDisk(unitDir),
    ["iva-memory-doctor.timer"],
    "the old nightly timer survives an update that never delivered the new one",
  );
});

void test("an update interrupted before deploy/ carries iva-brain.service keeps the old nightly unit", async (t) => {
  // The mirror half-extracted tree: the new TIMER landed, the service it points at did not.
  // A timer alone is not a nightly job — OnCalendar fires and systemd finds no iva-brain
  // .service to start. Retiring the old pair on that state costs every night until the next
  // successful update, and the timer on disk makes the install look migrated while it is not.
  const { home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await seedLegacyBrainUnits(unitDir, project);
  await partialDeploy(project, ["iva-brain.timer"]);

  const result = runCommand("_install-units");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.equal(
    existsSync(join(unitDir, "iva-brain.service")),
    false,
    "the fixture must really lack the new service — otherwise this proves nothing",
  );
  assert.match(output, /skipping legacy brain-unit cleanup/);
  assert.match(output, /iva-brain\.service/);
  assert.deepEqual(
    nightlyUnitsOnDisk(unitDir).sort(),
    ["iva-brain.timer", "iva-memory-doctor.timer"],
    "the old nightly pair survives a timer that has no service to start",
  );
  assert.equal(
    existsSync(join(unitDir, "iva-memory-doctor.service")),
    true,
    "the kept timer needs its own service to stay a working nightly job",
  );
  const entrypoint = await nightlyEntrypoint(
    unitDir,
    "iva-memory-doctor.service",
  );
  assert.equal(entrypoint, "scripts/memory/brain.ts");
  assert.equal(existsSync(join(project, entrypoint)), true);
});

void test("iva status and iva doctor both see the nightly unit kept by a service-less new timer", async (t) => {
  // The blind-spot check for the mirror case: iva-brain.timer IS on disk here, so a status
  // built from this version's unit list alone looks complete while the unit actually carrying
  // the night is the kept pre-rename one.
  const { calls, home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await seedLegacyBrainUnits(unitDir, project);
  await partialDeploy(project, ["iva-brain.timer"]);

  assert.equal(runCommand("_install-units").status, 0);
  await writeFile(calls, "");
  const status = runCommand("status");
  const statusOutput = `${status.stdout}\n${status.stderr}`;

  assert.equal(status.status, 0, statusOutput);
  assert.match(
    await readFile(calls, "utf8"),
    /--user list-timers --no-pager iva-brain\.timer iva-update-check\.timer iva-memory-doctor\.timer/,
  );
  assert.match(statusOutput, /iva-memory-doctor\.timer still installed/);

  await writeFile(calls, "");
  const doctor = runCommand("doctor", {
    failedUnit: "iva-memory-doctor.service",
  });
  const doctorOutput = `${doctor.stdout}\n${doctor.stderr}`;
  assert.match(doctorOutput, /iva-memory-doctor\.service failed/);
  assert.match(
    doctorOutput,
    /journalctl --user -u iva-memory-doctor\.service -n 100 --no-pager/,
  );
});

void test("a new brain timer that refuses to come up keeps the old pair installed", async (t) => {
  // enable --now succeeded but the unit is not active: systemd took the file and the job
  // still is not scheduled. Tearing down the old pair on that signal would lose the night.
  const { home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await seedLegacyBrainUnits(unitDir, project);

  const result = runCommand("_install-units", {
    inactiveUnit: "iva-brain.timer",
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /skipping legacy brain-unit cleanup/);
  assert.match(output, /did not become active/);
  assert.deepEqual(nightlyUnitsOnDisk(unitDir).sort(), [
    "iva-brain.timer",
    "iva-memory-doctor.timer",
  ]);
});

void test("a legacy nightly unit kept by an interrupted update still names a script that exists", async (t) => {
  // The unit file surviving on disk proves nothing: its ExecStart was written before the
  // rename and names scripts/memory/doctor.ts, while writeUnits() runs on the ALREADY updated
  // tree (update.ts calls it from postCommit), where that file is gone. Kept as-is, the unit
  // dies at 05:00 with "Cannot find module" — the lost night, just quieter.
  const { home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await seedLegacyBrainUnits(unitDir, project);
  await partialDeploy(project);

  const result = runCommand("_install-units");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.deepEqual(nightlyUnitsOnDisk(unitDir), ["iva-memory-doctor.timer"]);
  const entrypoint = await nightlyEntrypoint(
    unitDir,
    "iva-memory-doctor.service",
  );
  assert.equal(
    existsSync(join(project, entrypoint)),
    true,
    `the kept unit runs ${entrypoint}, which this tree does not ship`,
  );
  assert.equal(entrypoint, "scripts/memory/brain.ts");
  assert.match(output, /repointed at scripts\/memory\/brain\.ts/);
});

void test("a legacy nightly unit kept because the new timer stayed down is repointed too", async (t) => {
  const { home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await seedLegacyBrainUnits(unitDir, project);

  const result = runCommand("_install-units", {
    inactiveUnit: "iva-brain.timer",
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  const entrypoint = await nightlyEntrypoint(
    unitDir,
    "iva-memory-doctor.service",
  );
  assert.equal(entrypoint, "scripts/memory/brain.ts");
  assert.equal(existsSync(join(project, entrypoint)), true);
});

void test("repointing a kept legacy unit is idempotent and leaves the rest of the unit alone", async (t) => {
  const { home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await seedLegacyBrainUnits(unitDir, project);
  await partialDeploy(project);
  const before = await readFile(
    join(unitDir, "iva-memory-doctor.service"),
    "utf8",
  );

  assert.equal(runCommand("_install-units").status, 0);
  const first = await readFile(
    join(unitDir, "iva-memory-doctor.service"),
    "utf8",
  );
  assert.equal(runCommand("_install-units").status, 0);
  const second = await readFile(
    join(unitDir, "iva-memory-doctor.service"),
    "utf8",
  );

  assert.equal(second, first, "a second run rewrites nothing");
  assert.equal(
    first,
    before.replaceAll("scripts/memory/doctor.ts", "scripts/memory/brain.ts"),
    "only the entrypoint changes — flock, TimeoutStartSec, WorkingDirectory stay",
  );
});

void test("doctor reports a failed legacy nightly service the migration had to keep", async (t) => {
  // Without this the failure is invisible: the kept unit is the one carrying the nightly
  // vault care, and doctor used to query only the new service's failed state.
  const { calls, home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await seedLegacyBrainUnits(unitDir, project);
  await partialDeploy(project);

  const doctor = runCommand("doctor", {
    failedUnit: "iva-memory-doctor.service",
  });
  const output = `${doctor.stdout}\n${doctor.stderr}`;
  const checked = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .filter((call) => call.startsWith("--user is-failed "))
    .map((call) => call.split(" ").at(-1));

  assert.ok(
    checked.includes("iva-memory-doctor.service"),
    `doctor never asked about the kept unit: ${checked.join(", ")}`,
  );
  assert.match(output, /iva-memory-doctor\.service failed/);
  assert.match(
    output,
    /journalctl --user -u iva-memory-doctor\.service -n 100 --no-pager/,
  );
});

void test("iva status and iva doctor both see the renamed nightly unit", async (t) => {
  const { calls, home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await seedLegacyBrainUnits(unitDir, project);

  const status = runCommand("status");
  assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
  assert.match(
    await readFile(calls, "utf8"),
    /--user list-timers --no-pager iva-brain\.timer iva-update-check\.timer/,
    "the old iva-memory-* glob stopped matching the renamed unit",
  );

  await writeFile(calls, "");
  const doctor = runCommand("doctor");
  const output = `${doctor.stdout}\n${doctor.stderr}`;
  const systemctlCalls = await readFile(calls, "utf8");

  assert.match(systemctlCalls, /--user enable --now iva-brain\.timer/);
  assert.match(systemctlCalls, /--user is-failed iva-brain\.service/);
  assert.match(output, /Background timers enabled and active \(2/);
  assert.doesNotMatch(output, /iva-memory-doctor/);
  assert.deepEqual(nightlyUnitsOnDisk(unitDir), ["iva-brain.timer"]);
});

void test("iva status lists the pre-rename nightly timer an interrupted update kept", async (t) => {
  // The blind spot the rename opened: with the migration held back, the only nightly unit on
  // disk is iva-memory-doctor.timer, and a status built from this version's unit list alone
  // prints a timer table with nothing in it. The night is still running — invisibly.
  const { calls, home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await seedLegacyBrainUnits(unitDir, project);
  await partialDeploy(project);

  assert.equal(runCommand("_install-units").status, 0);
  assert.deepEqual(nightlyUnitsOnDisk(unitDir), ["iva-memory-doctor.timer"]);
  await writeFile(calls, "");
  const status = runCommand("status");
  const output = `${status.stdout}\n${status.stderr}`;

  assert.equal(status.status, 0, output);
  assert.match(
    await readFile(calls, "utf8"),
    /--user list-timers --no-pager iva-brain\.timer iva-update-check\.timer iva-memory-doctor\.timer/,
    "the nightly unit actually installed here never reached list-timers",
  );
  assert.match(output, /iva-memory-doctor\.timer still installed/);
  assert.match(output, /run: iva doctor/);
});

void test("iva status stays quiet about legacy units once the brain rename is done", async (t) => {
  const { calls, home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await seedLegacyBrainUnits(unitDir, project);

  assert.equal(runCommand("_install-units").status, 0);
  assert.deepEqual(nightlyUnitsOnDisk(unitDir), ["iva-brain.timer"]);
  await writeFile(calls, "");
  const status = runCommand("status");
  const output = `${status.stdout}\n${status.stderr}`;

  assert.equal(status.status, 0, output);
  assert.match(
    await readFile(calls, "utf8"),
    /--user list-timers --no-pager iva-brain\.timer iva-update-check\.timer\n/,
  );
  assert.doesNotMatch(output, /iva-memory-doctor/);
});

// enforce-report.json писал удалённый autograph (enforce.py); новый Brain его не пишет.
// Живость Brain доктор видит по состоянию iva-brain.service, а не по отчёту.
void test("doctor does not ask for the enforce report nobody writes any more", async (t) => {
  const { project, runCommand, seedUnit } = await fixture(t);
  await seedUnit("iva-brain.timer");
  await mkdir(join(project, "vault/.graph"), { recursive: true });

  const result = runCommand("doctor");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.doesNotMatch(output, /maintenance/u);
  // Живость Brain по-прежнему проверяется: по состоянию его юнита.
  assert.match(output, /iva-brain\.service has no failed state/u);
});

void test("userbot setup restarts an already enabled and active unit for new desired config", async (t) => {
  const { calls, envPath, home, project, state, seedUnit } = await fixture(t);
  await seedUnit("iva-telegram-userbot.service");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"state":"unauthorized"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(
    envPath,
    `MODEL_PROVIDER=codex\nOPENAI_API_KEY=${SECRET}\nTELEGRAM_API_ID=12345\nTELEGRAM_API_HASH=new-desired-hash\nTELEGRAM_MCP_PORT=${address.port}\n`,
    { mode: 0o600 },
  );

  const result = await new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(project, "bin/iva.mjs"), "userbot", "setup"],
      {
        env: {
          ...process.env,
          HOME: home,
          NO_COLOR: "1",
          PATH: `${join(dirname(home), "bin")}:/usr/bin:/bin`,
          IVA_FAKE_SYSTEMCTL_CALLS: calls,
          IVA_FAKE_SYSTEMCTL_EXIT: "0",
          IVA_FAKE_SYSTEMD_STATE: state,
        },
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const systemctlCalls = (await readFile(calls, "utf8")).trim().split("\n");
  const enableAt = systemctlCalls.indexOf(
    "--user enable iva-telegram-userbot.service",
  );
  const restartAt = systemctlCalls.indexOf(
    "--user restart iva-telegram-userbot.service",
  );

  assert.ok(enableAt >= 0, systemctlCalls.join("\n"));
  assert.ok(restartAt > enableAt, systemctlCalls.join("\n"));
});

void test("every systemd mutation rejects a non-zero command", () => {
  const control = createSystemdControl({
    run: () => ({ code: 1, out: "", err: `ignored ${SECRET}` }),
  });

  const rejectsSafely = (action: () => unknown) =>
    assert.throws(action, (error) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      return true;
    });

  rejectsSafely(() => control.activate(["iva.service"]));
  rejectsSafely(() => control.restart(["iva.service"]));
  rejectsSafely(() => control.stop(["iva.service"]));
  rejectsSafely(() => control.disableNow(["iva.service"]));
  rejectsSafely(() => control.resetFailed(["iva.service"]));
  rejectsSafely(() => control.daemonReload());
});

void test("iva reset keeps quarantine-only and restart-only diagnostics distinct", async (t) => {
  await t.test("quarantine failure only", async (t) => {
    const { runCommand, seedQuarantineFailure } = await fixture(t);
    await seedQuarantineFailure();
    const result = runCommand("reset");
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /Reset INCOMPLETE/);
    assert.doesNotMatch(output, /systemctl --user restart .* failed/);
  });

  await t.test("restart failure only", async (t) => {
    const { runCommand } = await fixture(t);
    const result = runCommand("reset", { exit: 1, failAction: "restart" });
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /systemctl --user restart iva\.service failed/);
    assert.doesNotMatch(output, /Reset INCOMPLETE/);
  });
});

void test("iva reset reports both failures when quarantine and restart fail", async (t) => {
  const { runCommand, seedQuarantineFailure } = await fixture(t);
  await seedQuarantineFailure();
  const result = runCommand("reset", { exit: 1, failAction: "restart" });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /systemctl --user restart iva\.service failed/);
  assert.match(output, /Reset INCOMPLETE/);
  assert.doesNotMatch(output, new RegExp(SECRET));
  assert.doesNotMatch(output, /fake systemctl failure/);
});

void test("unit removal finishes every cleanup step before reporting aggregated failures", () => {
  const calls: string[] = [];
  const units = ["iva.service", "iva-update-check.timer"];
  let successReported = false;

  assert.throws(
    () => {
      systemdControl.cleanupSystemdUnits({
        units,
        disable: (unit) => {
          calls.push(`disable:${unit}`);
          if (unit === "iva.service") throw new Error("disable failed");
        },
        remove: (unit) => {
          calls.push(`remove:${unit}`);
        },
        reload: () => {
          calls.push("reload");
          throw new Error("reload failed");
        },
        reset: () => {
          calls.push("reset");
        },
      });
      successReported = true;
    },
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.message, /disable iva\.service: disable failed/);
      assert.match(error.message, /daemon-reload: reload failed/);
      return true;
    },
  );

  assert.equal(successReported, false);
  assert.deepEqual(calls, [
    "disable:iva.service",
    "disable:iva-update-check.timer",
    "remove:iva.service",
    "remove:iva-update-check.timer",
    "reload",
    "reset",
  ]);
});

void test("unit removal preserves legacy cleanup error normalization", () => {
  const errorLike = Object.assign(Object.create(null) as object, {
    message: "permission denied",
  });

  assert.throws(
    () =>
      systemdControl.cleanupSystemdUnits({
        units: ["iva.service"],
        disable: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- legacy cleanup accepts error-like values from injected system operations
          throw errorLike;
        },
        remove: () => {},
        reload: () => {
          throw new Error("");
        },
        reset: () => {},
      }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /disable iva\.service: permission denied/);
      assert.match(error.message, /daemon-reload: Error/);
      return true;
    },
  );
});

void test("systemd errors preserve legacy enumerable property order", () => {
  const error = new systemdControl.SystemdControlError("failed", {
    unit: "iva.service",
    code: 1,
  });

  assert.deepEqual(Object.keys(error), ["name", "unit", "code"]);
  assert.equal(
    JSON.stringify(error),
    '{"name":"SystemdControlError","unit":"iva.service","code":1}',
  );
});
