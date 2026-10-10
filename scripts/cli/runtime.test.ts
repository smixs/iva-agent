/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { createCliRuntime } from "./runtime.ts";

const RUNTIME_MODULE = new URL("./runtime.ts", import.meta.url);

async function sandbox(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "iva-cli-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("runtime exposes the CLI primitives and shared unit constants", async (t) => {
  const root = await sandbox(t);
  const runtime = createCliRuntime(root);

  assert.deepEqual(Object.keys(runtime).sort(), [
    "BRAIN_SERVICE",
    "BRAIN_TIMER",
    "C",
    "DEFAULT_PORT",
    "ENV_PATH",
    "NODE",
    "NODE_BIN_DIR",
    "NPM",
    "OLD_DEFAULT_HOST",
    "ROOT",
    "SERVICES",
    "SVC_USERBOT",
    "TIMERS",
    "TOKEN_FILE",
    "UNIT_DIR",
    "UPDATE_TIMER",
    "USERBOT_DIR",
    "VENV_PY",
    "bad",
    "cap",
    "childEnv",
    "confirm",
    "dataDirAbs",
    "gitHead",
    "hasSystemd",
    "ok",
    "readEnv",
    "requireSystemd",
    "run",
    "scQ",
    "step",
    "systemd",
    "uvExecutable",
    "warn",
    "writeEnvVars",
  ]);
  assert.equal(runtime.ROOT, root);
  assert.equal(runtime.ENV_PATH, join(root, ".env"));
  assert.equal(runtime.UNIT_DIR, join(homedir(), ".config/systemd/user"));
  assert.equal(runtime.NODE, process.execPath);
  assert.equal(runtime.NODE_BIN_DIR, dirname(process.execPath));
  assert.equal(
    runtime.NPM,
    existsSync(join(dirname(process.execPath), "npm"))
      ? join(dirname(process.execPath), "npm")
      : "npm",
  );
  assert.deepEqual(runtime.SERVICES, [
    "iva.service",
    "iva-telegram-poll.service",
  ]);
  assert.equal(runtime.BRAIN_SERVICE, "iva-brain.service");
  assert.equal(runtime.BRAIN_TIMER, "iva-brain.timer");
  assert.equal(runtime.UPDATE_TIMER, "iva-update-check.timer");
  assert.deepEqual(runtime.TIMERS, [
    "iva-brain.timer",
    "iva-update-check.timer",
  ]);
  assert.equal(runtime.SVC_USERBOT, "iva-telegram-userbot.service");
  assert.equal(runtime.USERBOT_DIR, join(root, "services/telegram-userbot"));
  assert.equal(
    runtime.VENV_PY,
    join(root, "services/telegram-userbot/.venv/bin/python"),
  );
  assert.equal(runtime.TOKEN_FILE, join(root, "data/telegram-userbot.token"));
  assert.equal(runtime.DEFAULT_PORT, "8723");
  assert.equal(runtime.OLD_DEFAULT_HOST, "http://127.0.0.1:3000");
});

test("runtime resolves executable uv from its captured child PATH", async (t) => {
  const root = await sandbox(t);
  const bin = join(root, "commands with spaces");
  mkdirSync(bin);
  const uv = join(bin, "uv");
  writeFileSync(uv, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const previousPath = process.env.PATH;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  process.env.PATH = `${bin}:${dirname(process.execPath)}`;
  const runtime = createCliRuntime(root);
  process.env.PATH = dirname(process.execPath);

  assert.equal(runtime.uvExecutable(), uv);
  assert.equal(runtime.cap(runtime.uvExecutable()!, []).code, 0);
});

test("import is side-effect free and factory evaluation snapshots env and color", async (t) => {
  const root = await sandbox(t);
  const snapshotKey = "IVA_RUNTIME_SNAPSHOT_TEST";
  const savedSnapshot = process.env[snapshotKey];
  const savedNoColor = process.env.NO_COLOR;
  const savedTerm = process.env.TERM;
  t.after(() => {
    if (savedSnapshot === undefined) delete process.env[snapshotKey];
    else process.env[snapshotKey] = savedSnapshot;
    if (savedNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = savedNoColor;
    if (savedTerm === undefined) delete process.env.TERM;
    else process.env.TERM = savedTerm;
  });

  process.env.NO_COLOR = "1";
  process.env.TERM = "xterm-256color";
  process.env[snapshotKey] = "at-import";
  const imported = (await import(
    `${RUNTIME_MODULE.href}?side-effect=${Date.now()}`
  )) as typeof import("./runtime.ts");

  delete process.env.NO_COLOR;
  process.env[snapshotKey] = "at-factory";
  const colored = imported.createCliRuntime(root);
  assert.equal(colored.C.g, "\x1b[32m");
  assert.equal(colored.childEnv[snapshotKey], "at-factory");

  process.env.NO_COLOR = "1";
  process.env[snapshotKey] = "after-factory";
  assert.equal(colored.C.g, "\x1b[32m");
  assert.equal(colored.childEnv[snapshotKey], "at-factory");

  const plain = imported.createCliRuntime(root);
  assert.deepEqual(plain.C, {
    g: "",
    y: "",
    r: "",
    c: "",
    b: "",
    d: "",
    x: "",
  });
  assert.equal(plain.childEnv[snapshotKey], "after-factory");
});

test("run and cap preserve caller option precedence", async (t) => {
  const root = await sandbox(t);
  const overrideCwd = join(root, "override-cwd");
  mkdirSync(overrideCwd);
  const evaluatedCwd = realpathSync(overrideCwd);
  const runtime = createCliRuntime(root);
  const childScript =
    "process.stdout.write(`${process.cwd()}|${process.env.IVA_RUNTIME_OPTION_TEST || ''}`)";
  const overrideEnv = { IVA_RUNTIME_OPTION_TEST: "caller" };

  const runResult = runtime.run(process.execPath, ["-e", childScript], {
    cwd: overrideCwd,
    encoding: "utf8",
    env: overrideEnv,
    stdio: "pipe",
  });
  assert.equal(runResult.status, 0);
  assert.equal(runResult.stdout, `${evaluatedCwd}|caller`);

  const capResult = runtime.cap(process.execPath, ["-e", childScript], {
    cwd: overrideCwd,
    env: overrideEnv,
  });
  assert.deepEqual(capResult, {
    code: 0,
    out: `${evaluatedCwd}|caller`,
    err: "",
  });
});

test("cap trims output and normalizes a missing status to one", async (t) => {
  const root = await sandbox(t);
  const runtime = createCliRuntime(root);

  assert.deepEqual(
    runtime.cap(process.execPath, [
      "-e",
      "process.stdout.write('  output \\n'); process.stderr.write('  warning \\n'); process.exit(7)",
    ]),
    { code: 7, out: "output", err: "warning" },
  );
  assert.deepEqual(runtime.cap("iva-command-that-does-not-exist", []), {
    code: 1,
    out: "",
    err: "",
  });
});

test("readEnv and dataDirAbs retain the CLI path rules", async (t) => {
  const root = await sandbox(t);
  const runtime = createCliRuntime(root);

  assert.deepEqual(runtime.readEnv(), {});
  writeFileSync(
    runtime.ENV_PATH,
    [
      "# comment",
      " MODEL_PROVIDER = 'codex' ",
      'ASSISTANT_DATA_DIR="runtime-data"',
      "lowercase=ignored",
      "MODEL_PROVIDER=ollama",
      "",
    ].join("\n"),
  );
  // Ровно то, что видит сервис: `node --env-file` (и `util.parseEnv` за ним) пускает
  // строчные имена и режет незакавыченный `#` как начало комментария — CLI обязан читать
  // тот же файл так же, иначе `iva doctor` и список секретов `iva diagnose` расходятся с
  // тем, как процесс получил своё окружение (T21).
  assert.deepEqual(runtime.readEnv(), {
    MODEL_PROVIDER: "ollama",
    ASSISTANT_DATA_DIR: "runtime-data",
    lowercase: "ignored",
  });
  assert.equal(runtime.dataDirAbs(), join(root, "runtime-data"));
  assert.equal(runtime.dataDirAbs({}), join(root, "data"));
  assert.equal(
    runtime.dataDirAbs({ ASSISTANT_DATA_DIR: "nested/data" }),
    join(root, "nested/data"),
  );
  assert.equal(
    runtime.dataDirAbs({ ASSISTANT_DATA_DIR: "/srv/iva-data" }),
    "/srv/iva-data",
  );
  assert.equal(
    runtime.dataDirAbs({ ASSISTANT_DATA_DIR: "" }),
    join(root, "data"),
  );
});

test("readEnv читает инлайн-комментарий и многострочное значение как node --env-file", async (t) => {
  const root = await sandbox(t);
  const runtime = createCliRuntime(root);
  writeFileSync(
    runtime.ENV_PATH,
    [
      "COMMENT_KEY=commentDDD3456 # inline note",
      'MULTI_KEY="multiEEE7890',
      'multiFFF1234"',
      "",
    ].join("\n"),
  );

  // Золотые значения сняты с самого `node --env-file` (слепая приёмка T21): значение
  // кончается на `#`, а многострочная кавычка собирается в одну строку с переводом.
  assert.deepEqual(runtime.readEnv(), {
    COMMENT_KEY: "commentDDD3456",
    MULTI_KEY: "multiEEE7890\nmultiFFF1234",
  });
});

test("writeEnvVars rejects CRLF values before writing", async (t) => {
  const root = await sandbox(t);
  const runtime = createCliRuntime(root);
  writeFileSync(runtime.ENV_PATH, "KEEP=original\n");

  assert.throws(
    () => runtime.writeEnvVars({ TELEGRAM_API_HASH: "first\rsecond" }),
    /env value for TELEGRAM_API_HASH has a newline/u,
  );
  assert.throws(
    () => runtime.writeEnvVars({ TELEGRAM_API_HASH: "first\nsecond" }),
    /env value for TELEGRAM_API_HASH has a newline/u,
  );
  assert.equal(readFileSync(runtime.ENV_PATH, "utf8"), "KEEP=original\n");
});

test("writeEnvVars deduplicates CRLF input and writes one atomic LF record", async (t) => {
  const root = await sandbox(t);
  const runtime = createCliRuntime(root);
  writeFileSync(
    runtime.ENV_PATH,
    "# keep\r\nTELEGRAM_API_ID=old\r\nOTHER=value\r\nTELEGRAM_API_ID=duplicate\r\n\r\n",
  );

  runtime.writeEnvVars({ TELEGRAM_API_ID: 42, NEW_FLAG: false });

  assert.equal(
    readFileSync(runtime.ENV_PATH, "utf8"),
    "# keep\nTELEGRAM_API_ID=42\nOTHER=value\nNEW_FLAG=false\n",
  );
  assert.equal(statSync(runtime.ENV_PATH).mode & 0o777, 0o600);
});

test("childEnv keeps the caller's PATH order when NODE_BIN_DIR is already on it", async (t) => {
  const root = await sandbox(t);
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const nodeBinDir = dirname(process.execPath);
  // Both fixture entries live under the sandbox, so neither can accidentally
  // equal nodeBinDir on a machine that keeps node somewhere unusual.
  const stubBin = join(root, "stub-bin");
  const tailBin = join(root, "tail-bin");
  process.env.PATH = `${stubBin}:${nodeBinDir}:${tailBin}`;

  const entries = (createCliRuntime(root).childEnv.PATH ?? "").split(":");

  // The whole array, not just the head: a dropped or reordered tail entry is
  // the same defect as a stub that stops winning.
  assert.deepEqual(entries, [stubBin, nodeBinDir, tailBin]);
});

test("childEnv prepends NODE_BIN_DIR when PATH does not carry it", async (t) => {
  const root = await sandbox(t);
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const nodeBinDir = dirname(process.execPath);
  process.env.PATH = "/nonexistent-a:/nonexistent-b";

  assert.equal(
    createCliRuntime(root).childEnv.PATH,
    `${nodeBinDir}:/nonexistent-a:/nonexistent-b`,
  );
});

// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает в отчёте строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь их вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
test("property: childEnv stably filters PATH and prepends NODE_BIN_DIR only when absent", async (t) => {
  const root = await sandbox(t);
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const nodeBinDir = dirname(process.execPath);
  const otherSegment = fc.oneof(
    fc.constantFrom(
      join(root, "stub-bin"),
      join(root, "tail-bin"),
      "/usr/local/bin",
      `${nodeBinDir}-old`,
      `x${nodeBinDir}`,
      `${nodeBinDir}/sub`,
    ),
    fc
      .string({ minLength: 1, maxLength: 40, unit: "grapheme" })
      .filter((segment) => segment !== nodeBinDir && !segment.includes(":")),
  );
  const pathSegments = fc
    .record({
      segments: fc.array(fc.oneof(fc.constant(""), otherSegment), {
        maxLength: 12,
      }),
      nodePositions: fc.array(fc.nat(), { maxLength: 3 }),
    })
    .map(({ segments, nodePositions }) => {
      const withNode = [...segments];
      for (const nodePosition of nodePositions) {
        withNode.splice(nodePosition % (withNode.length + 1), 0, nodeBinDir);
      }
      return withNode;
    });

  fc.assert(
    fc.property(pathSegments, (inputSegments) => {
      process.env.PATH = inputSegments.join(":");

      const result = (createCliRuntime(root).childEnv.PATH ?? "").split(":");
      const filteredInput = inputSegments.filter(Boolean);
      const inputNodeCount = filteredInput.filter(
        (segment) => segment === nodeBinDir,
      ).length;

      assert.equal(
        result.filter((segment) => segment === nodeBinDir).length,
        inputNodeCount || 1,
      );
      if (inputNodeCount === 0) {
        assert.deepEqual(result, [nodeBinDir, ...filteredInput]);
      } else {
        assert.deepEqual(result, filteredInput);
      }
      assert.ok(result.every(Boolean));
    }),
    { numRuns: 500 },
  );
});
