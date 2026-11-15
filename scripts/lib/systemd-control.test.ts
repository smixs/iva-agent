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
import { fileURLToPath } from "node:url";
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

// UpdateFloor.NoSilentLoss: a .env written before 0.3.15 names no port. Doctor says so with
// the file's name and adds no line of its own; every line the owner wrote stays.
void test("NoSilentLoss: doctor names a .env without IVA_PORT and does not add the line", async (t) => {
  const { envPath, runCommand } = await fixture(t);
  const before = await readFile(envPath, "utf8");
  assert.doesNotMatch(before, /^IVA_PORT=/mu);

  const result = runCommand("doctor");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.ok(
    output.includes(`${envPath} has no IVA_PORT`),
    `the file is not named: ${output.replaceAll(SECRET, "<secret>")}`,
  );
  const after = await readFile(envPath, "utf8");
  assert.doesNotMatch(after, /^IVA_PORT=/mu);
  for (const line of before.split("\n")) assert.ok(after.includes(line));
});

// UpdateFloor.NoSilentLoss: unit files of a release below the floor (the eight
// iva-memory-{daily,weekly,monthly,yearly} units and the iva-memory-doctor pair) are not
// this CLI's. Every command that writes or reads units leaves them byte for byte and names
// none of them to systemctl.
void test("NoSilentLoss: unit files of a release below the floor stay as they were through install, restart, doctor and status", async (t) => {
  const { calls, home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await mkdir(unitDir, { recursive: true });
  const old = new Map([
    [
      "iva-memory-doctor.service",
      `[Service]\nExecStart=${process.execPath} scripts/memory/doctor.ts\n`,
    ],
    ["iva-memory-doctor.timer", "[Timer]\nOnCalendar=*-*-* 05:00:00\n"],
    ["iva-memory-daily.service", "[Service]\nExecStart=/bin/true\n"],
    ["iva-memory-daily.timer", "[Timer]\nOnCalendar=daily\n"],
    ["iva-memory-yearly.timer", "[Timer]\nOnCalendar=yearly\n"],
  ]);
  for (const [unit, body] of old) await writeFile(join(unitDir, unit), body);
  await mkdir(join(project, ".output/server/_virtual"), { recursive: true });
  await writeFile(
    join(project, ".output/server/_virtual/eve.schedule.mjs"),
    `var eve_schedule_default = { meta: { description: 'Run eve schedule "memory-night" from "schedules/memory-night.ts".' } };\n`,
  );

  for (const command of ["_install-units", "restart", "doctor", "status"]) {
    const result = runCommand(command);
    const output = `${result.stdout}\n${result.stderr}`;
    // The fixture's .env is incomplete, so doctor reports a failure of its own.
    if (command !== "doctor")
      assert.equal(result.status, 0, `${command}: ${output}`);
    assert.doesNotMatch(output, /iva-memory-/u, command);
  }

  for (const [unit, body] of old)
    assert.equal(await readFile(join(unitDir, unit), "utf8"), body, unit);
  const systemctlCalls = await readFile(calls, "utf8");
  assert.doesNotMatch(systemctlCalls, /iva-memory-/u);
  assert.match(systemctlCalls, /--user enable --now iva-brain\.timer/u);
  assert.match(systemctlCalls, /--user is-failed iva-brain\.service/u);
  assert.match(
    systemctlCalls,
    /--user list-timers --no-pager iva-brain\.timer iva-update-check\.timer\n/u,
  );
  assert.equal(existsSync(join(unitDir, "iva-brain.timer")), true);
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
