import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { plantCliTree } from "../fixtures/cli-tree.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type CliFixture = {
  readonly fakeBin: string;
  readonly home: string;
  readonly journalctlLog: string;
  readonly project: string;
  readonly systemctlLog: string;
};

async function fixture(t: TestContext): Promise<CliFixture> {
  const dir = await mkdtemp(join(tmpdir(), "iva-cli-services-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const project = join(dir, "iva");
  const home = join(dir, "home");
  const fakeBin = join(dir, "bin");
  const systemctlLog = join(dir, "systemctl.log");
  const journalctlLog = join(dir, "journalctl.log");
  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await plantCliTree(ROOT, project, { copy: ["scripts/cli"] });

  const systemctl = join(fakeBin, "systemctl");
  await writeFile(
    systemctl,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$IVA_SERVICE_SYSTEMCTL_LOG"',
      '[ "$1" = "--user" ] && shift',
      'action="$1"',
      "shift",
      'if [ "${IVA_SERVICE_FAIL_ACTION:-}" = "$action" ]; then',
      '  exit "${IVA_SERVICE_FAIL_CODE:-1}"',
      "fi",
      'if [ "$action" = "status" ]; then',
      '  exit "${IVA_SERVICE_STATUS_EXIT:-0}"',
      "fi",
      "for unit; do :; done",
      'if [ -n "${IVA_SERVICE_USERBOT_STATE:-}" ] && [ "$unit" = "iva-telegram-userbot.service" ]; then',
      '  case "$action" in',
      '    is-active) state=$(cat "$IVA_SERVICE_USERBOT_STATE"); printf "%s\\n" "$state"; [ "$state" = active ] || exit 3 ;;',
      '    is-enabled) if [ -e "$IVA_SERVICE_USERBOT_STATE.enabled" ]; then printf "enabled\\n"; else printf "disabled\\n"; exit 1; fi ;;',
      '    stop) printf inactive > "$IVA_SERVICE_USERBOT_STATE" ;;',
      '    disable) printf inactive > "$IVA_SERVICE_USERBOT_STATE"; rm -f "$IVA_SERVICE_USERBOT_STATE.enabled" ;;',
      '    start|restart) printf active > "$IVA_SERVICE_USERBOT_STATE" ;;',
      '    enable) : > "$IVA_SERVICE_USERBOT_STATE.enabled" ;;',
      "  esac",
      "  exit 0",
      "fi",
      'if [ "$action" = "is-enabled" ]; then printf "enabled\\n"; fi',
      'if [ "$action" = "is-active" ] && [ "$1" = "iva-telegram-userbot.service" ]; then printf "inactive\\n"; exit 3; fi',
      'if [ "$action" = "is-active" ]; then printf "active\\n"; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  await chmod(systemctl, 0o755);

  const journalctl = join(fakeBin, "journalctl");
  await writeFile(
    journalctl,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$IVA_SERVICE_JOURNALCTL_LOG"',
      'exit "${IVA_SERVICE_JOURNALCTL_EXIT:-0}"',
      "",
    ].join("\n"),
  );
  await chmod(journalctl, 0o755);

  return { fakeBin, home, journalctlLog, project, systemctlLog };
}

function runCli(
  { fakeBin, home, journalctlLog, project, systemctlLog }: CliFixture,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
) {
  return spawnSync(process.execPath, [join(project, "bin/iva.mjs"), ...args], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_LANGUAGE: "en",
      HOME: home,
      IVA_SERVICE_JOURNALCTL_LOG: journalctlLog,
      IVA_SERVICE_SYSTEMCTL_LOG: systemctlLog,
      NO_COLOR: "1",
      PATH: `${fakeBin}:/usr/bin:/bin`,
      TERM: "dumb",
      ...env,
    },
  });
}

/** Like runCli, but the test's own process keeps serving while `iva` runs. */
function runCliAsync(
  { fakeBin, home, journalctlLog, project, systemctlLog }: CliFixture,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    [join(project, "bin/iva.mjs"), ...args],
    {
      cwd: project,
      env: {
        ...process.env,
        AGENT_LANGUAGE: "en",
        HOME: home,
        IVA_SERVICE_JOURNALCTL_LOG: journalctlLog,
        IVA_SERVICE_SYSTEMCTL_LOG: systemctlLog,
        NO_COLOR: "1",
        PATH: `${fakeBin}:/usr/bin:/bin`,
        TERM: "dumb",
        ...env,
      },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function calls(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).trim().split("\n");
}

void test("status preserves both systemctl argv vectors and ignores a failed status result", async (t) => {
  const context = await fixture(t);

  const result = runCli(context, ["status"], {
    IVA_SERVICE_STATUS_EXIT: "7",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(await calls(context.systemctlLog), [
    "--user status --no-pager -n 5 iva.service iva-telegram-poll.service",
    "--user list-timers --no-pager iva-brain.timer iva-update-check.timer",
  ]);
});

void test("restart regenerates units before checked service restarts and reports success last", async (t) => {
  const context = await fixture(t);

  const result = runCli(context, ["restart"]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "✓ Restarted: iva + telegram-poll\n");
  assert.deepEqual(await calls(context.systemctlLog), [
    "--user daemon-reload",
    "--user restart iva.service",
    "--user is-active iva.service",
    "--user restart iva-telegram-poll.service",
    "--user is-active iva-telegram-poll.service",
    "--user is-active iva.service",
    "--user is-active iva-telegram-userbot.service",
  ]);
});

void test("restart leaves a healthy userbot running and never re-syncs it, so no network is needed", async (t) => {
  const context = await fixture(t);
  const data = join(context.project, "data");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "telegram-userbot.token"), "synthetic-token\n");
  const server = createServer((request, response) => {
    const authorized =
      request.headers.authorization === "Bearer synthetic-token";
    response.writeHead(authorized ? 200 : 401, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ state: authorized ? "ready" : "denied" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(
    join(context.project, ".env"),
    `TELEGRAM_MCP_PORT=${address.port}\n`,
  );
  const userbotState = join(context.home, "userbot.state");
  await writeFile(userbotState, "active");
  await writeFile(`${userbotState}.enabled`, "");
  const userbot = join(context.project, "services/telegram-userbot");
  await mkdir(join(userbot, ".venv/bin"), { recursive: true });
  await writeFile(
    join(userbot, "requirements.lock"),
    "telethon==1 --hash=sha256:synthetic\n",
  );
  await writeFile(join(userbot, ".venv/bin/python"), "#!/bin/sh\nexit 0\n");
  await chmod(join(userbot, ".venv/bin/python"), 0o755);
  // A re-sync of a ready venv still fetches telegram-mcp's GitHub archive: offline it fails.
  const uvLog = join(context.home, "uv.log");
  const uv = join(context.fakeBin, "uv");
  await writeFile(
    uv,
    `#!/bin/sh\nprintf "%s\\n" "$*" >> "${uvLog}"\necho "error: Failed to fetch" >&2\nexit 2\n`,
  );
  await chmod(uv, 0o755);

  const result = await runCliAsync(context, ["restart"], {
    IVA_SERVICE_USERBOT_STATE: userbotState,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "✓ Restarted: iva + telegram-poll\n");
  assert.equal(existsSync(uvLog), false, "uv must not run");
  assert.equal(await readFile(userbotState, "utf8"), "active");
  assert.ok(existsSync(`${userbotState}.enabled`), "the userbot stays enabled");
  assert.deepEqual(
    (await calls(context.systemctlLog)).filter(
      (call) =>
        call.includes("iva-telegram-userbot.service") &&
        !/ is-(active|enabled) /u.test(call),
    ),
    [],
  );
});

void test("reset stops services, quarantines every state target with one stamp, then restarts", async (t) => {
  const context = await fixture(t);
  const targets = [
    ".eve/.workflow-data",
    ".workflow-data",
    "data/run-status.d",
    "data/run-status.json",
    "data/telegram-queue.json",
  ];
  for (const target of targets) {
    const path = join(context.project, target);
    if (target.endsWith(".json")) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "{}\n");
    } else {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "state"), "keep\n");
    }
  }

  const result = runCli(context, ["reset"]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const quarantineLines = result.stdout
    .split("\n")
    .filter((line) => line.includes("reset state quarantined"));
  assert.equal(quarantineLines.length, targets.length);
  assert.deepEqual(
    quarantineLines.map((line) => line.split(" → ")[0]),
    targets.map((target) => `✓ ${target}`),
  );
  const stamps = quarantineLines.map(
    (line) => line.split(".trash-")[1]?.split(" — ")[0],
  );
  assert.equal(new Set(stamps).size, 1);
  assert.match(stamps[0] ?? "", /^\d{4}-\d{2}-\d{2}T.+Z$/u);
  for (const target of targets)
    assert.equal(existsSync(join(context.project, target)), false);
  assert.match(result.stdout, /✓ Restarted: iva \+ telegram-poll\n$/u);
  assert.deepEqual(await calls(context.systemctlLog), [
    "--user stop iva.service",
    "--user stop iva-telegram-poll.service",
    "--user daemon-reload",
    "--user restart iva.service",
    "--user is-active iva.service",
    "--user restart iva-telegram-poll.service",
    "--user is-active iva-telegram-poll.service",
    "--user is-active iva.service",
  ]);
});

void test("reset reports an already empty state before restarting services", async (t) => {
  const context = await fixture(t);

  const result = runCli(context, ["reset"]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    /✓ workflow and Telegram control state already empty\n✓ Restarted: iva \+ telegram-poll\n$/u,
  );
});

void test("reset stop failure leaves state untouched and exits before quarantine or restart", async (t) => {
  const context = await fixture(t);
  const state = join(context.project, ".eve/.workflow-data");
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "run.json"), "{}\n");

  const result = runCli(context, ["reset"], {
    IVA_SERVICE_FAIL_ACTION: "stop",
    IVA_SERVICE_FAIL_CODE: "7",
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    /Workflow and Telegram control state left untouched/u,
  );
  assert.doesNotMatch(result.stdout, /reset state quarantined|Restarted:/u);
  assert.equal(existsSync(state), true);
  assert.deepEqual(await calls(context.systemctlLog), [
    "--user stop iva.service",
  ]);
});

void test("start activates services and timers in order before printing success", async (t) => {
  const context = await fixture(t);

  const result = runCli(context, ["start"]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "✓ Started and enabled at boot\n");
  assert.deepEqual(await calls(context.systemctlLog), [
    "--user enable --now iva.service",
    "--user is-enabled iva.service",
    "--user is-active iva.service",
    "--user enable --now iva-telegram-poll.service",
    "--user is-enabled iva-telegram-poll.service",
    "--user is-active iva-telegram-poll.service",
    "--user enable --now iva-brain.timer",
    "--user is-enabled iva-brain.timer",
    "--user is-active iva-brain.timer",
    "--user enable --now iva-update-check.timer",
    "--user is-enabled iva-update-check.timer",
    "--user is-active iva-update-check.timer",
  ]);
});

void test("stop stops both services in order before printing success", async (t) => {
  const context = await fixture(t);

  const result = runCli(context, ["stop"]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "✓ Stopped\n");
  assert.deepEqual(await calls(context.systemctlLog), [
    "--user stop iva.service",
    "--user stop iva-telegram-poll.service",
  ]);
});

void test("logs keeps exact poll-token selection and ignores journalctl exit status", async (t) => {
  const context = await fixture(t);
  const env = { IVA_SERVICE_JOURNALCTL_EXIT: "9" };

  const primary = runCli(context, ["logs"], env);
  const longFlag = runCli(context, ["logs", "--poll"], env);
  const poll = runCli(context, ["logs", "anything", "poll"], env);

  assert.equal(primary.status, 0, primary.stderr || primary.stdout);
  assert.equal(longFlag.status, 0, longFlag.stderr || longFlag.stdout);
  assert.equal(poll.status, 0, poll.stderr || poll.stdout);
  assert.deepEqual(await calls(context.journalctlLog), [
    "--user -u iva.service -f -n 50",
    "--user -u iva.service -f -n 50",
    "--user -u iva-telegram-poll.service -f -n 50",
  ]);
});
