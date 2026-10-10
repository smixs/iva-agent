import assert from "node:assert/strict";
import { spawn, type SpawnSyncReturns } from "node:child_process";
import test, { type TestContext } from "node:test";
import { createServer } from "node:http";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plantCliTree } from "../fixtures/cli-tree.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SECRET = "userbot-characterization-secret";

interface FixtureOptions {
  readonly env?: string;
  readonly existingToken?: string;
  readonly existingVenv?: boolean;
}

interface RunOptions {
  readonly input?: string;
}

async function fixture(
  t: TestContext,
  { env = "", existingToken, existingVenv = false }: FixtureOptions = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "iva-userbot-entrypoints-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const project = join(dir, "iva");
  const home = join(dir, "home");
  const fakeBin = join(dir, "bin");
  const callsPath = join(dir, "calls.log");
  const stateDir = join(dir, "systemd-state");
  const envPath = join(project, ".env");
  const tokenPath = join(project, "data/telegram-userbot.token");
  const userbotDir = join(project, "services/telegram-userbot");
  const venvPython = join(userbotDir, ".venv/bin/python");

  await mkdir(userbotDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await plantCliTree(ROOT, project, { copy: ["scripts/cli"] });
  await copyFile(
    join(ROOT, "services/telegram-userbot/requirements.lock"),
    join(userbotDir, "requirements.lock"),
  );
  if (env.includes("TELEGRAM_API_ID=") && env.includes("TELEGRAM_API_HASH=")) {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"state":"unauthorized"}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    env += "TELEGRAM_MCP_PORT=" + address.port + "\n";
  }
  if (env) await writeFile(envPath, env, { mode: 0o600 });
  if (existingToken !== undefined) {
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, existingToken);
    // Explicit chmod: the creation mode is masked by the umask of the machine.
    await chmod(tokenPath, 0o640);
  }

  const pythonScript = [
    "#!/bin/sh",
    'printf "python:%s\\n" "$*" >> "$IVA_USERBOT_CALLS"',
    "exit 0",
    "",
  ].join("\n");
  if (existingVenv) {
    await mkdir(dirname(venvPython), { recursive: true });
    await writeFile(venvPython, pythonScript);
    await chmod(venvPython, 0o755);
  }

  const uv = join(fakeBin, "uv");
  await writeFile(
    uv,
    [
      "#!/bin/sh",
      'printf "uv:%s\\n" "$*" >> "$IVA_USERBOT_CALLS"',
      'if [ "$1" = "venv" ]; then',
      '  mkdir -p "$IVA_USERBOT_DIR/.venv/bin"',
      "  printf '%s\\n' '#!/bin/sh' 'printf \"python:%s\\n\" \"$*\" >> \"$IVA_USERBOT_CALLS\"' 'exit 0' > \"$IVA_USERBOT_DIR/.venv/bin/python\"",
      '  chmod 755 "$IVA_USERBOT_DIR/.venv/bin/python"',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  await chmod(uv, 0o755);

  const systemctl = join(fakeBin, "systemctl");
  await writeFile(
    systemctl,
    [
      "#!/bin/sh",
      '[ "$1" = "--user" ] && shift',
      'printf "systemctl:%s\\n" "$*" >> "$IVA_USERBOT_CALLS"',
      'action="$1"',
      "shift",
      'case "$action" in',
      "  enable)",
      '    [ "${1:-}" = "--now" ] && shift',
      '    : > "$IVA_USERBOT_STATE/$1.enabled"',
      '    : > "$IVA_USERBOT_STATE/$1.active"',
      "    ;;",
      "  restart)",
      '    : > "$IVA_USERBOT_STATE/$1.active"',
      "    ;;",
      "  disable)",
      '    [ "${1:-}" = "--now" ] && shift',
      '    rm -f "$IVA_USERBOT_STATE/$1.enabled" "$IVA_USERBOT_STATE/$1.active"',
      "    ;;",
      "  is-enabled)",
      '    if [ -f "$IVA_USERBOT_STATE/$1.enabled" ]; then echo enabled; else echo disabled; exit 1; fi',
      "    ;;",
      "  is-active)",
      '    if [ -f "$IVA_USERBOT_STATE/$1.active" ]; then echo active; else echo inactive; exit 3; fi',
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  await chmod(systemctl, 0o755);

  const run = (
    args: readonly string[],
    { input }: RunOptions = {},
  ): Promise<SpawnSyncReturns<string>> =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [join(project, "bin/iva.mjs"), "userbot", ...args],
        {
          cwd: project,
          env: {
            ...process.env,
            HOME: home,
            NO_COLOR: "1",
            PATH: fakeBin + ":/usr/bin:/bin",
            IVA_USERBOT_CALLS: callsPath,
            IVA_USERBOT_DIR: userbotDir,
            IVA_USERBOT_STATE: stateDir,
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
      child.once("close", (status, signal) =>
        resolve({
          status,
          signal,
          stdout,
          stderr,
          pid: child.pid ?? 0,
          output: [null, stdout, stderr],
        }),
      );
      child.stdin.end(input);
    });

  return {
    calls: async (): Promise<string[]> => {
      try {
        return (await readFile(callsPath, "utf8")).trim().split("\n");
      } catch {
        return [];
      }
    },
    envPath,
    home,
    project,
    run,
    seedActive: async () => {
      await writeFile(
        join(stateDir, "iva-telegram-userbot.service.enabled"),
        "",
      );
      await writeFile(
        join(stateDir, "iva-telegram-userbot.service.active"),
        "",
      );
    },
    stateDir,
    tokenPath,
    venvPython,
  };
}

void test("userbot creds trims two stdin lines, persists them, and never echoes the hash", async (t) => {
  const { envPath, run } = await fixture(t, { env: "KEEP=value\n" });
  const result = await run(["creds"], {
    input: `\n  123456  \n\n  ${SECRET}  \nignored\n`,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    await readFile(envPath, "utf8"),
    `KEEP=value\nTELEGRAM_API_ID=123456\nTELEGRAM_API_HASH=${SECRET}\n`,
  );
  assert.equal(
    result.stdout,
    "✓ Ключи Telegram записаны в .env. Теперь: iva userbot setup\n",
  );
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(SECRET));
});

void test("userbot creds rejects missing or nonnumeric input without changing env", async (t) => {
  const initial = "KEEP=unchanged\n";
  const { envPath, run } = await fixture(t, { env: initial });

  const missing = await run(["creds"], { input: "123456\n" });
  assert.equal(missing.status, 1);
  assert.equal(
    missing.stdout,
    "✗ stdin: жду две строки — api_id и api_hash (создай приложение на my.telegram.org)\n",
  );
  assert.equal(await readFile(envPath, "utf8"), initial);

  const nonnumeric = await run(["creds"], {
    input: `not-a-number\n${SECRET}\n`,
  });
  assert.equal(nonnumeric.status, 1);
  assert.equal(nonnumeric.stdout, "✗ api_id должен быть числом\n");
  assert.doesNotMatch(
    `${nonnumeric.stdout}\n${nonnumeric.stderr}`,
    new RegExp(SECRET),
  );
  assert.equal(await readFile(envPath, "utf8"), initial);
});

void test("userbot setup fails before token, uv, units, or systemd when credentials are absent", async (t) => {
  const { calls, home, run, tokenPath } = await fixture(t);
  const result = await run(["setup"]);

  assert.equal(result.status, 1);
  assert.equal(
    result.stdout,
    [
      "✗ Нет TELEGRAM_API_ID/TELEGRAM_API_HASH в .env. Создай приложение на my.telegram.org,",
      "✗ впиши оба ключа в .env и запусти снова: iva userbot setup",
      "",
    ].join("\n"),
  );
  await assert.rejects(stat(tokenPath), { code: "ENOENT" });
  assert.deepEqual(await calls(), []);
  await assert.rejects(stat(join(home, ".config/systemd/user")), {
    code: "ENOENT",
  });
});

void test("userbot setup creates a 0600 token and preserves venv, unit, activation, and restart order", async (t) => {
  const { calls, home, run, tokenPath, venvPython } = await fixture(t, {
    env: `TELEGRAM_API_ID=123456\nTELEGRAM_API_HASH=${SECRET}\n`,
  });
  const result = await run(["setup"]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(await readFile(tokenPath, "utf8"), /^[a-f0-9]{48}$/);
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  assert.equal((await stat(venvPython)).mode & 0o111, 0o111);
  assert.match(
    await readFile(
      join(home, ".config/systemd/user/iva-telegram-userbot.service"),
      "utf8",
    ),
    new RegExp(venvPython.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  const events = await calls();
  assert.equal(events[0], "systemctl:is-active iva-telegram-userbot.service");
  assert.equal(events[1], "uv:venv --python 3.12 .venv");
  assert.equal(
    events[2]?.replaceAll("/private/var/", "/var/"),
    `uv:pip sync --python ${venvPython} --require-hashes --strict ${join(dirname(dirname(dirname(venvPython))), "requirements.lock")}`,
  );
  assert.equal(
    events[3],
    "python:-c import telethon, telegram_mcp, qrcode, mcp",
  );
  const reload = events.indexOf("systemctl:daemon-reload");
  const enable = events.indexOf(
    "systemctl:enable iva-telegram-userbot.service",
  );
  const restart = events.indexOf(
    "systemctl:restart iva-telegram-userbot.service",
  );
  assert.ok(reload > 2, events.join("\n"));
  assert.ok(enable > reload, events.join("\n"));
  assert.ok(restart > enable, events.join("\n"));
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(SECRET));
});

void test("userbot setup gives the proxy one canonical custom data directory", async (t) => {
  const { home, project, run } = await fixture(t, {
    env: [
      "TELEGRAM_API_ID=123456",
      `TELEGRAM_API_HASH=${SECRET}`,
      "ASSISTANT_DATA_DIR= state/../runtime ",
      "",
    ].join("\n"),
  });

  const result = await run(["setup"]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const canonical = join(project, "runtime");
  const physicalCanonical = await realpath(canonical);
  const canonicalEnvironment = `"ASSISTANT_DATA_DIR=${physicalCanonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`;
  assert.match(
    await readFile(join(canonical, "telegram-userbot.token"), "utf8"),
    /^[a-f0-9]{48}$/,
  );
  await assert.rejects(stat(join(project, "data/telegram-userbot.token")), {
    code: "ENOENT",
  });
  assert.match(
    await readFile(
      join(home, ".config/systemd/user/iva-telegram-userbot.service"),
      "utf8",
    ),
    new RegExp(`^ExecStart=/usr/bin/env ${canonicalEnvironment} `, "mu"),
  );
  for (const unit of [
    "iva.service",
    "iva-telegram-poll.service",
    "iva-brain.service",
    "iva-update-check.service",
  ]) {
    assert.match(
      await readFile(join(home, ".config/systemd/user", unit), "utf8"),
      new RegExp(`^ExecStart=/usr/bin/env ${canonicalEnvironment} `, "mu"),
      unit,
    );
  }
});

void test("userbot setup never rewrites an existing token", async (t) => {
  const token = "existing-token-must-stay-byte-identical";
  const { run, tokenPath } = await fixture(t, {
    env: `TELEGRAM_API_ID=123456\nTELEGRAM_API_HASH=${SECRET}\n`,
    existingToken: token,
    existingVenv: true,
  });
  const before = await stat(tokenPath);
  const result = await run(["setup"]);
  const after = await stat(tokenPath);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await readFile(tokenPath, "utf8"), token);
  assert.equal(after.mode & 0o777, 0o640);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

void test("userbot status is the default and reports service, venv, and token on three lines", async (t) => {
  const { run, seedActive } = await fixture(t);
  await seedActive();
  const explicit = await run(["status"]);
  const implicit = await run([]);
  const expected = [
    "iva-telegram-userbot.service: unreachable",
    "venv: нет — будет собран при setup",
    "токен: нет — создастся при setup",
    "",
  ].join("\n");

  assert.equal(explicit.status, 0, explicit.stderr || explicit.stdout);
  assert.equal(implicit.status, 0, implicit.stderr || implicit.stdout);
  assert.equal(explicit.stdout, expected);
  assert.equal(implicit.stdout, expected);
});

void test("userbot diagnose requires --json before probing", async (t) => {
  const { calls, run } = await fixture(t);
  const result = await run(["diagnose"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "✗ Использование: iva userbot diagnose --json\n");
  assert.deepEqual(await calls(), []);
});

void test("userbot off disables the active proxy and unknown subcommands fail without mutation", async (t) => {
  const { calls, run, seedActive, stateDir } = await fixture(t);
  await seedActive();
  const off = await run(["off"]);

  assert.equal(off.status, 0, off.stderr || off.stdout);
  assert.equal(off.stdout, "✓ Userbot-прокси остановлен и выключен.\n");
  await assert.rejects(
    stat(join(stateDir, "iva-telegram-userbot.service.active")),
    { code: "ENOENT" },
  );
  assert.deepEqual(await calls(), [
    "systemctl:disable --now iva-telegram-userbot.service",
  ]);

  const before = await calls();
  const unknown = await run(["surprise"]);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, "✗ Неизвестная команда userbot: surprise\n");
  assert.deepEqual(await calls(), before);
});
