import assert from "node:assert/strict";
import test from "node:test";
import { createSystemdControl } from "../lib/systemd-control.ts";
import {
  createUserbotCommands,
  reinstallUserbot,
  type UserbotDependencies,
  type UserbotRuntime,
} from "./userbot.ts";

const ROOT = "/tmp/iva-userbot-unit";
const USERBOT_DIR = `${ROOT}/services/telegram-userbot`;
const VENV_PY = `${USERBOT_DIR}/.venv/bin/python`;
const TOKEN_FILE = `${ROOT}/data/telegram-userbot.token`;
const REQUIREMENTS = `${USERBOT_DIR}/requirements.lock`;
const SERVICE = "iva-telegram-userbot.service";
const HASHED_REQUIREMENTS = "telethon==1.0 --hash=sha256:abc\n";

class ExitError extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function exit(code: number): never {
  throw new ExitError(code);
}

function runResult(status: number): ReturnType<UserbotRuntime["run"]> {
  return { status } as ReturnType<UserbotRuntime["run"]>;
}

function captureResult(
  code: number,
  out = "",
  err = "",
): ReturnType<UserbotRuntime["cap"]> {
  return { code, out, err };
}

interface RuntimeFixtureOptions {
  readonly active?: boolean;
  readonly uv?: string | null;
  readonly env?: Readonly<Record<string, string>>;
  readonly run?: UserbotRuntime["run"];
  readonly cap?: UserbotRuntime["cap"];
  readonly writeEnvVars?: UserbotRuntime["writeEnvVars"];
}

function runtimeFixture({
  active = false,
  uv = "/usr/bin/uv",
  env = {},
  run,
  cap,
  writeEnvVars,
}: RuntimeFixtureOptions = {}) {
  const events: string[] = [];
  let serviceActive = active;
  let serviceEnabled = active;
  const systemd = createSystemdControl({
    run: (args) => {
      events.push(`systemd:${args.join(" ")}`);
      if (args[0] === "enable") {
        serviceEnabled = true;
        serviceActive = true;
      }
      if (args[0] === "restart") serviceActive = true;
      if (args[0] === "stop") serviceActive = false;
      if (args[0] === "disable") {
        serviceEnabled = false;
        serviceActive = false;
      }
      if (args[0] === "is-active")
        return {
          code: serviceActive ? 0 : 3,
          out: serviceActive ? "active" : "inactive",
        };
      if (args[0] === "is-enabled")
        return {
          code: serviceEnabled ? 0 : 1,
          out: serviceEnabled ? "enabled" : "disabled",
        };
      return { code: 0, out: "" };
    },
  });
  const runtime: UserbotRuntime = {
    ROOT,
    uvExecutable: () => uv,
    SVC_USERBOT: SERVICE,
    USERBOT_DIR,
    VENV_PY,
    TOKEN_FILE,
    ok: (message) => events.push(`ok:${message}`),
    bad: (message) => events.push(`bad:${message}`),
    step: (message) => events.push(`step:${message}`),
    run:
      run ??
      ((command, args) => {
        events.push(`run:${command}:${args.join(" ")}`);
        return runResult(0);
      }),
    cap:
      cap ??
      ((command, args) => {
        events.push(`cap:${command}:${args.join(" ")}`);
        return command === "sh"
          ? captureResult(0, "/usr/bin/uv")
          : captureResult(0);
      }),
    systemd,
    readEnv: () => ({ ...env }),
    dataDirAbs: () => `${ROOT}/data`,
    writeEnvVars:
      writeEnvVars ?? ((vars) => events.push(`env:${JSON.stringify(vars)}`)),
  };
  return { events, runtime };
}

function memoryFileSystem({
  venv = true,
  token = false,
  requirements = HASHED_REQUIREMENTS,
}: {
  readonly venv?: boolean;
  readonly token?: boolean;
  readonly requirements?: string;
} = {}) {
  let hasVenv = venv;
  let hasToken = token;
  const events: string[] = [];
  const fileSystem: NonNullable<UserbotDependencies["fileSystem"]> = {
    exists: (path) => {
      events.push(`exists:${path}`);
      if (path === VENV_PY) return hasVenv;
      if (path === TOKEN_FILE) return hasToken;
      return false;
    },
    readUtf8: (path) => {
      events.push(`read:${String(path)}`);
      return requirements;
    },
    mkdir: (path) => events.push(`mkdir:${path}`),
    writePrivate: (path, data) => {
      events.push(`write:${path}:${data}`);
      if (path === TOKEN_FILE) hasToken = true;
    },
    chmodPrivate: (path) => events.push(`chmod:${path}`),
  };
  return {
    events,
    fileSystem,
    markVenvCreated: () => {
      hasVenv = true;
    },
  };
}

void test("creating the userbot command group is side-effect free", () => {
  const { events, runtime } = runtimeFixture();
  const fail = (): never => {
    throw new Error("unexpected eager dependency access");
  };

  createUserbotCommands(
    runtime,
    { writeUnits: fail },
    {
      fileSystem: {
        exists: fail,
        readUtf8: fail,
        mkdir: fail,
        writePrivate: fail,
        chmodPrivate: fail,
      },
      randomHex: fail,
      probeHealth: fail,
      log: fail,
      exit: fail,
    },
  );

  assert.deepEqual(events, []);
});

void test("ensureUserbotVenv creates, syncs, and import-checks in legacy order", () => {
  const files = memoryFileSystem({ venv: false });
  const events: string[] = [];
  const { runtime } = runtimeFixture({
    run: (command, args, options) => {
      events.push(`run:${command}:${args.join(" ")}:${String(options?.cwd)}`);
      if (args[0] === "venv") files.markVenvCreated();
      return runResult(0);
    },
    cap: (command, args, options) => {
      events.push(`cap:${command}:${args.join(" ")}:${String(options?.cwd)}`);
      return command === "sh"
        ? captureResult(0, "/usr/bin/uv")
        : captureResult(0);
    },
  });
  const commands = createUserbotCommands(
    runtime,
    { writeUnits: () => [] },
    {
      fileSystem: files.fileSystem,
    },
  );

  commands.ensureUserbotVenv();

  assert.deepEqual(events, [
    `run:/usr/bin/uv:venv --python 3.12 .venv:${USERBOT_DIR}`,
    `run:/usr/bin/uv:pip sync --python ${VENV_PY} --require-hashes --strict ${REQUIREMENTS}:${USERBOT_DIR}`,
    `cap:${VENV_PY}:-c import telethon, telegram_mcp, qrcode, mcp:${USERBOT_DIR}`,
  ]);
  assert.deepEqual(files.events, [
    `read:${REQUIREMENTS}`,
    `exists:${VENV_PY}`,
    `exists:${VENV_PY}`,
  ]);
});

void test("ensureUserbotVenv preserves exact failure diagnostics", async (t) => {
  await t.test("uv missing", () => {
    const { runtime } = runtimeFixture({
      uv: null,
      cap: () => captureResult(1),
    });
    const commands = createUserbotCommands(runtime, { writeUnits: () => [] });
    assert.throws(
      () => commands.ensureUserbotVenv(),
      /userbot: uv не найден — повторно запусти install\.sh/,
    );
  });

  await t.test("venv command fails", () => {
    const files = memoryFileSystem({ venv: false });
    const { runtime } = runtimeFixture({
      run: () => runResult(1),
    });
    const commands = createUserbotCommands(
      runtime,
      { writeUnits: () => [] },
      {
        fileSystem: files.fileSystem,
      },
    );
    assert.throws(
      () => commands.ensureUserbotVenv(),
      /userbot: создание venv не удалось/,
    );
  });

  await t.test("venv command succeeds without creating python", () => {
    const files = memoryFileSystem({ venv: false });
    const { runtime } = runtimeFixture();
    const commands = createUserbotCommands(
      runtime,
      { writeUnits: () => [] },
      {
        fileSystem: files.fileSystem,
      },
    );
    assert.throws(
      () => commands.ensureUserbotVenv(),
      /userbot: venv не создан — проверь python3\/uv/,
    );
  });

  await t.test("dependency sync fails", () => {
    const files = memoryFileSystem();
    const { runtime } = runtimeFixture({
      run: () => runResult(1),
    });
    const commands = createUserbotCommands(
      runtime,
      { writeUnits: () => [] },
      {
        fileSystem: files.fileSystem,
      },
    );
    assert.throws(
      () => commands.ensureUserbotVenv(),
      /userbot: установка зависимостей не удалось/,
    );
  });

  await t.test("import check reports the last stderr line", () => {
    const files = memoryFileSystem();
    const { runtime } = runtimeFixture({
      cap: (command) =>
        command === "sh"
          ? captureResult(0, "/usr/bin/uv")
          : captureResult(1, "", "first line\nlast import error"),
    });
    const commands = createUserbotCommands(
      runtime,
      { writeUnits: () => [] },
      {
        fileSystem: files.fileSystem,
      },
    );
    assert.throws(
      () => commands.ensureUserbotVenv(),
      /userbot: зависимости не импортируются — last import error/,
    );
  });
});

void test("ensureUserbotVenv preserves the legacy explicit-null requirements failure", () => {
  const { runtime } = runtimeFixture();
  const commands = createUserbotCommands(
    runtime,
    { writeUnits: () => [] },
    {
      fileSystem: { exists: () => true },
    },
  );

  assert.throws(
    () => commands.ensureUserbotVenv({ requirementsPath: null }),
    (error: unknown) =>
      error instanceof TypeError &&
      (error as NodeJS.ErrnoException).code === "ERR_INVALID_ARG_TYPE" &&
      error.message ===
        'The "path" argument must be of type string or an instance of Buffer or URL. Received null',
  );
});

void test("ensureUserbotToken is one-shot and tolerates chmod failure", () => {
  const existing = memoryFileSystem({ token: true });
  const existingRuntime = runtimeFixture();
  const existingCommands = createUserbotCommands(
    existingRuntime.runtime,
    { writeUnits: () => [] },
    {
      fileSystem: existing.fileSystem,
      randomHex: () => {
        throw new Error("must not regenerate token");
      },
    },
  );
  existingCommands.ensureUserbotToken();
  assert.deepEqual(existing.events, [`exists:${TOKEN_FILE}`]);
  assert.deepEqual(existingRuntime.events, []);

  const created = memoryFileSystem({ token: false });
  created.fileSystem.chmodPrivate = () => {
    created.events.push(`chmod-failed:${TOKEN_FILE}`);
    throw new Error("read-only chmod");
  };
  const createdRuntime = runtimeFixture();
  const createdCommands = createUserbotCommands(
    createdRuntime.runtime,
    { writeUnits: () => [] },
    {
      fileSystem: created.fileSystem,
      randomHex: (bytes) => {
        assert.equal(bytes, 24);
        return "ab".repeat(24);
      },
    },
  );
  createdCommands.ensureUserbotToken();

  assert.deepEqual(created.events, [
    `exists:${TOKEN_FILE}`,
    `mkdir:${ROOT}/data`,
    `write:${TOKEN_FILE}:${"ab".repeat(24)}`,
    `chmod-failed:${TOKEN_FILE}`,
  ]);
  assert.deepEqual(createdRuntime.events, [
    "ok:Сгенерировал токен прокси (data/telegram-userbot.token).",
  ]);
});

void test("restartUserbotIfActive is inert when inactive and preserves rollback options", async () => {
  const inactiveFiles = memoryFileSystem();
  const inactive = runtimeFixture({ active: false });
  const inactiveCommands = createUserbotCommands(
    inactive.runtime,
    { writeUnits: () => [] },
    { fileSystem: inactiveFiles.fileSystem },
  );
  await inactiveCommands.restartUserbotIfActive();
  assert.deepEqual(inactive.events, [`systemd:is-active ${SERVICE}`]);
  assert.deepEqual(inactiveFiles.events, []);

  const rollbackPath = "/tmp/rollback-requirements.lock";
  const rollbackFiles = memoryFileSystem({
    requirements: "telethon==old-version\n",
  });
  const quietStdio: unknown[] = [];
  const rollbackRuns: string[] = [];
  const rollback = runtimeFixture({
    active: false,
    run: (command, args, options) => {
      rollbackRuns.push(`${command}:${args.join(" ")}`);
      quietStdio.push(options?.stdio);
      return runResult(0);
    },
    cap: (command, _args, options) => {
      if (command !== "sh") quietStdio.push(options?.stdio);
      return command === "sh"
        ? captureResult(0, "/usr/bin/uv")
        : captureResult(0);
    },
  });
  const rollbackCommands = createUserbotCommands(
    rollback.runtime,
    { writeUnits: () => [] },
    {
      fileSystem: rollbackFiles.fileSystem,
      probeHealth: () => Promise.resolve({ state: "ready", reason: "ok" }),
    },
  );
  await rollbackCommands.restartUserbotIfActive({
    quiet: true,
    knownActive: true,
    requirementsPath: rollbackPath,
    requireHashes: false,
  });

  assert.deepEqual(rollbackRuns, [
    `/usr/bin/uv:pip sync --python ${VENV_PY} ${rollbackPath}`,
  ]);
  assert.ok(
    rollback.events.includes(`systemd:restart ${SERVICE}`),
    rollback.events.join("\n"),
  );
  assert.ok(
    rollback.events.includes(`systemd:is-active ${SERVICE}`),
    rollback.events.join("\n"),
  );
  assert.equal(
    rollback.events.some(
      (event) => event.startsWith("step:") || event.startsWith("ok:"),
    ),
    false,
  );
  assert.ok(rollbackFiles.events.includes(`read:${rollbackPath}`));
  assert.deepEqual(quietStdio, ["ignore", "ignore"]);
});

void test("cmdUserbot setup keeps token, venv, units, activation, and restart ordered", async () => {
  const files = memoryFileSystem({ venv: true, token: false });
  const { events, runtime } = runtimeFixture({
    env: {
      TELEGRAM_API_ID: "123456",
      TELEGRAM_API_HASH: "secret-hash",
    },
  });
  const commands = createUserbotCommands(
    runtime,
    { writeUnits: () => events.push("units:write") as unknown as string[] },
    {
      fileSystem: files.fileSystem,
      randomHex: () => "cd".repeat(24),
      probeHealth: () =>
        Promise.resolve({
          state: "unauthorized",
          reason: "telegram_login_required",
        }),
    },
  );

  await commands.cmdUserbot(["setup"]);

  const tokenWrite = files.events.indexOf(
    `write:${TOKEN_FILE}:${"cd".repeat(24)}`,
  );
  const dependencySync = events.findIndex((event) =>
    event.startsWith("run:/usr/bin/uv:pip sync"),
  );
  const units = events.indexOf("units:write");
  const activate = events.indexOf(`systemd:enable ${SERVICE}`);
  const restart = events.indexOf(`systemd:restart ${SERVICE}`);
  assert.ok(tokenWrite >= 0, files.events.join("\n"));
  assert.ok(dependencySync >= 0, events.join("\n"));
  assert.ok(units > dependencySync, events.join("\n"));
  assert.ok(activate > units, events.join("\n"));
  assert.ok(restart > activate, events.join("\n"));
});

void test("cmdUserbot propagates non-Error runtime failures without normalization", async () => {
  const marker = Symbol("write-units-failure");
  const files = memoryFileSystem({ venv: true, token: true });
  const { runtime } = runtimeFixture({
    env: {
      TELEGRAM_API_ID: "123456",
      TELEGRAM_API_HASH: "secret-hash",
    },
  });
  const commands = createUserbotCommands(
    runtime,
    {
      writeUnits: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the legacy router accepts arbitrary JavaScript failures and must receive this value unchanged
        throw marker;
      },
    },
    { fileSystem: files.fileSystem },
  );

  try {
    await commands.cmdUserbot(["setup"]);
    assert.fail("expected the original Symbol failure");
  } catch (error) {
    assert.equal(error, marker);
  }
});

void test("cmdUserbot preserves credentials, health, off, and unknown-command behavior", async () => {
  const writes: Array<Readonly<Record<string, unknown>>> = [];
  const files = memoryFileSystem({ venv: true, token: true });
  files.fileSystem.readUtf8 = () => `  123456  \n\n  secret-hash  \n`;
  const { events, runtime } = runtimeFixture({
    env: { TELEGRAM_MCP_PORT: "9999" },
    writeEnvVars: (vars) => writes.push(vars),
  });
  const healthCalls: Array<{
    readonly root: string;
    readonly dataDir: string;
    readonly port: string;
  }> = [];
  const logs: string[] = [];
  const commands = createUserbotCommands(
    runtime,
    { writeUnits: () => [] },
    {
      fileSystem: files.fileSystem,
      probeHealth: (options) => {
        healthCalls.push(options);
        return Promise.resolve({ state: "ready", reason: "ok" });
      },
      log: (message) => logs.push(message),
      exit,
    },
  );

  await commands.cmdUserbot(["creds"]);
  assert.deepEqual(writes, [
    { TELEGRAM_API_ID: "123456", TELEGRAM_API_HASH: "secret-hash" },
  ]);
  assert.equal(
    events.some((event) => event.includes("secret-hash")),
    false,
  );

  await commands.cmdUserbot(["diagnose", "--json", "ignored"]);
  await commands.cmdUserbot([]);
  assert.deepEqual(healthCalls, [
    { root: ROOT, dataDir: `${ROOT}/data`, port: "9999" },
    { root: ROOT, dataDir: `${ROOT}/data`, port: "9999" },
  ]);
  assert.deepEqual(logs, [
    '{"state":"ready","reason":"ok"}',
    `${SERVICE}: ready`,
    "venv: собран",
    "токен: есть",
  ]);

  await commands.cmdUserbot(["off"]);
  assert.ok(events.includes(`systemd:disable --now ${SERVICE}`));
  await assert.rejects(commands.cmdUserbot(["surprise"]), {
    name: "Error",
    message: "exit 1",
    code: 1,
  });
  assert.ok(events.includes("bad:Неизвестная команда userbot: surprise"));
});

void test("recovery preserves the preparation error when keeping the userbot off also fails", async () => {
  const { runtime } = runtimeFixture({ uv: null });
  runtime.systemd.disableNow = () => {
    throw new Error("disable refused");
  };
  const reports: string[] = [];
  const result = await reinstallUserbot(
    runtime,
    { writeUnits: () => [] },
    (message) => reports.push(message),
    { knownActive: true },
    { fileSystem: memoryFileSystem({ token: true }).fileSystem },
  );
  assert.equal(result.status, "failed");
  assert.match(reports.join("\n"), /uv не найден/);
  assert.match(reports.join("\n"), /disable refused/);
});

void test("a restart still prepares a userbot that is active but does not answer", async () => {
  const { events, runtime } = runtimeFixture({ active: true });
  const probes: string[] = [];
  const result = await reinstallUserbot(
    runtime,
    { writeUnits: () => [] },
    (message) => events.push(`report:${message}`),
    { keepHealthy: true },
    {
      fileSystem: memoryFileSystem({ token: true }).fileSystem,
      probeHealth: () => {
        // The first probe sees the loop of #273; after the restart the proxy answers.
        const state = probes.length === 0 ? "starting" : "ready";
        probes.push(state);
        return Promise.resolve({ state, reason: state });
      },
    },
  );

  assert.equal(result.status, "ready");
  assert.deepEqual(probes, ["starting", "ready"]);
  const stop = events.indexOf(`systemd:stop ${SERVICE}`);
  const sync = events.findIndex((event) =>
    event.startsWith("run:/usr/bin/uv:pip sync"),
  );
  const restart = events.indexOf(`systemd:restart ${SERVICE}`);
  assert.ok(stop >= 0 && sync > stop && restart > sync, events.join("\n"));
});
