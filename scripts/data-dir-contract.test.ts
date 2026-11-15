/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { resolveDataDir as resolveAuthoredDataDir } from "#lib/data-dir.ts";
import { resolveDataDir as resolveOperationalDataDir } from "../packages/data-dir/index.ts";
import { resolveDataDir as canonicalDataDir } from "@iva/data-dir";
import { imageRoots } from "./cli/post.ts";
import { systemdExecArgument } from "./cli/systemd.ts";
import { layoutFor } from "./lib/version-store.ts";
import { commandRunner } from "./lib/version-update.ts";

const ROOT = process.cwd();
const AUTHORED = pathToFileURL(join(ROOT, "agent/lib/data-dir.ts")).href;
const OPERATIONAL = pathToFileURL(
  join(ROOT, "packages/data-dir/index.ts"),
).href;
const CONNECTION = pathToFileURL(
  join(ROOT, "agent/connections/telegram-userbot.ts"),
).href;
const CLI_RUNTIME = pathToFileURL(join(ROOT, "scripts/cli/runtime.ts")).href;

function fromProcess(
  moduleUrl: string,
  expression: string,
  configured: string | undefined,
  cwd = ROOT,
): string {
  const env: NodeJS.ProcessEnv = {};
  if (configured !== undefined) env.ASSISTANT_DATA_DIR = configured;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const m = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(${expression});`,
    ],
    { cwd, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function sandbox(t: { after: (cleanup: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "iva-c4-data-dir-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function expected(configured: string | undefined): string {
  return resolve(ROOT, configured?.trim() || "data");
}

test("C4: every process resolves the same canonical data directory", () => {
  for (const configured of [
    undefined,
    "",
    " \t ",
    " state/../custom ",
    " /tmp/iva-absolute/../canonical ",
  ]) {
    const canonical = expected(configured);
    assert.equal(canonicalDataDir(ROOT, configured), canonical);
    assert.equal(resolveAuthoredDataDir(ROOT, configured), canonical);
    assert.equal(resolveOperationalDataDir(ROOT, configured), canonical);
    assert.equal(fromProcess(AUTHORED, "m.dataDir()", configured), canonical);
    assert.equal(
      fromProcess(OPERATIONAL, "m.resolveDataDir(process.cwd())", configured),
      canonical,
    );
  }
});

test("C4 PBT: authored and operational consumers share one contract", () => {
  fc.assert(
    fc.property(fc.string(), (configured) => {
      const canonical = expected(configured);
      assert.equal(resolveAuthoredDataDir(ROOT, configured), canonical);
      assert.equal(resolveOperationalDataDir(ROOT, configured), canonical);
      const home = join(ROOT, "synthetic-install");
      const version = join(home, "versions/0.3.22-aaaaaaaaaaaa");
      assert.equal(
        resolveOperationalDataDir(version, configured),
        resolve(home, configured.trim() || "data"),
      );
      const checkout = join(ROOT, "synthetic-checkout");
      assert.equal(
        resolveOperationalDataDir(checkout, configured),
        resolve(checkout, configured.trim() || "data"),
      );
    }),
    { seed: 18804, numRuns: 500 },
  );
});

test("C4: an explicit missing setting cannot inherit stale process state", () => {
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = "stale-process-state";
  try {
    assert.equal(
      resolveOperationalDataDir(ROOT, undefined),
      join(ROOT, "data"),
    );
    assert.equal(
      resolveOperationalDataDir(ROOT),
      join(ROOT, "stale-process-state"),
    );
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
  }
});

test("C4: a relative directory stays at installation home across a version flip", (t) => {
  const home = sandbox(t);
  const version = join(home, "versions/0.3.22-rc-hotfix-aaaaaaaaaaaa");
  mkdirSync(version, { recursive: true });
  writeFileSync(join(home, ".env"), "ASSISTANT_DATA_DIR=runtime\n");
  symlinkSync(join(home, ".env"), join(version, ".env"));
  symlinkSync(version, join(home, "current"));

  const expected = join(home, "runtime", "telegram-userbot.token");
  const cliToken = fromProcess(
    CLI_RUNTIME,
    `m.createCliRuntime(${JSON.stringify(join(home, "current"))}).TOKEN_FILE`,
    undefined,
  );

  assert.equal(cliToken, expected);
  assert.equal(
    fromProcess(
      CLI_RUNTIME,
      `m.createCliRuntime(${JSON.stringify(join(home, "current"))}).childEnv.ASSISTANT_DATA_DIR`,
      undefined,
    ),
    join(home, "runtime"),
  );
  assert.equal(join(layoutFor(home).data, "telegram-userbot.token"), expected);
  assert.equal(
    resolveOperationalDataDir(home, "runtime"),
    join(home, "runtime"),
  );
  const checkout = join(home, "checkout");
  assert.equal(
    resolveOperationalDataDir(checkout, "runtime"),
    join(checkout, "runtime"),
  );
});

test("C4: a checkout named like an installed Version keeps its own data", (t) => {
  const home = sandbox(t);
  const checkout = join(home, "versions/0.3.22-aaaaaaaaaaaa");
  mkdirSync(join(checkout, ".git"), { recursive: true });

  assert.equal(
    resolveOperationalDataDir(checkout, "runtime"),
    join(checkout, "runtime"),
  );
});

test("C4: an installed prerelease with build metadata stays at installation home", (t) => {
  const home = sandbox(t);
  const version = join(home, "versions/1.2.3-rc.1+build.7-aaaaaaaaaaaa");
  mkdirSync(version, { recursive: true });

  assert.equal(
    resolveOperationalDataDir(version, "runtime"),
    join(home, "runtime"),
  );
});

test("C4: the userbot production path receives and consumes the canonical directory", (t) => {
  const root = sandbox(t);
  const configured = " state/../runtime ";
  const canonical = resolve(root, configured.trim());
  const token = "synthetic-userbot-token";
  mkdirSync(canonical, { recursive: true });
  writeFileSync(join(canonical, "telegram-userbot.token"), token);
  writeFileSync(join(root, ".env"), `ASSISTANT_DATA_DIR=${configured}\n`);

  assert.equal(
    fromProcess(
      CLI_RUNTIME,
      `m.createCliRuntime(${JSON.stringify(root)}).TOKEN_FILE`,
      undefined,
    ),
    join(canonical, "telegram-userbot.token"),
  );
  assert.equal(
    fromProcess(
      CONNECTION,
      "(await m.default.auth.getToken()).token",
      configured,
      root,
    ),
    token,
  );

  const python = spawnSync(
    "uv",
    [
      "run",
      "--no-project",
      "python",
      "-c",
      [
        "import importlib.util, json, sys",
        `sys.path.insert(0, ${JSON.stringify(join(ROOT, "services/telegram-userbot"))})`,
        "import serve",
        "print(json.dumps([str(serve._session_file()), str(serve._token_file())]))",
      ].join("; "),
    ],
    {
      cwd: join(ROOT, "services/telegram-userbot"),
      env: {
        ASSISTANT_DATA_DIR: canonical,
        HOME: process.env.HOME,
        PATH: process.env.PATH,
      },
      encoding: "utf8",
    },
  );
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(JSON.parse(python.stdout), [
    join(canonical, "telegram-userbot.session"),
    join(canonical, "telegram-userbot.token"),
  ]);
  // `iva post` берёт корни для локальных картинок у того же резолвера: собственный
  // расчёт каталога данных увёл бы media-гейт мимо реального data и открыл бы
  // публичному хосту то, что гейт считает «вне корней».
  assert.deepEqual(imageRoots(root, { ASSISTANT_DATA_DIR: configured }), [
    realpathSync(root),
    realpathSync(canonical),
  ]);

  assert.match(
    readFileSync(join(ROOT, "deploy/iva-telegram-userbot.service"), "utf8"),
    /^ExecStart=\/usr\/bin\/env __DATA_DIR_ENV__ /mu,
  );
});

test("C4: iva post resolves its image roots through the canonical resolver", (t) => {
  const home = sandbox(t);
  const version = join(home, "versions/0.3.22-rc-hotfix-aaaaaaaaaaaa");
  mkdirSync(version, { recursive: true });

  // Относительный каталог данных остаётся у дома установки, а не у каталога версии:
  // после переезда `current` картинка из data обязана оставаться внутри корней.
  const data = canonicalDataDir(version, " runtime ");
  assert.equal(data, join(home, "runtime"));
  assert.deepEqual(imageRoots(version, { ASSISTANT_DATA_DIR: " runtime " }), [
    realpathSync(version),
    data,
  ]);
});

test("C4: systemd preserves canonical data-dir metacharacters as one argument", () => {
  assert.equal(
    systemdExecArgument('ASSISTANT_DATA_DIR=/state/a b/"quoted"/\\/$/%/\t'),
    '"ASSISTANT_DATA_DIR=/state/a b/\\"quoted\\"/\\\\/$$/%%/\\x09"',
  );
  assert.throws(
    () => systemdExecArgument("ASSISTANT_DATA_DIR=/state/line\nbreak"),
    /NUL or a newline/u,
  );
});

test("C4: immutable update children receive installation-home data", async (t) => {
  const home = sandbox(t);
  const version = join(home, "versions/1.2.3-rc.1+build.7-aaaaaaaaaaaa");
  mkdirSync(version, { recursive: true });
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = " state/../runtime ";
  try {
    const result = await commandRunner(false)(
      process.execPath,
      ["-e", "process.stdout.write(process.env.ASSISTANT_DATA_DIR || '')"],
      version,
    );
    assert.equal(result.code, 0, result.output);
    assert.equal(result.output, join(home, "runtime"));
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
  }
});

test("C4: every product-owned Iva child boundary passes canonical data", () => {
  const inventory: ReadonlyArray<{
    readonly boundary: string;
    readonly file: string;
    readonly proofs: readonly RegExp[];
  }> = [
    {
      boundary: "build core",
      file: "scripts/build.ts",
      proofs: [/ASSISTANT_DATA_DIR: dataDir\(\)/u],
    },
    {
      boundary: "CLI children and updater handoff",
      file: "scripts/cli/runtime.ts",
      proofs: [/ASSISTANT_DATA_DIR: dataDirAbs\(\)/u],
    },
    {
      boundary: "immutable npm install and build",
      file: "scripts/lib/version-update.ts",
      proofs: [/ASSISTANT_DATA_DIR: resolveDataDir\(cwd\)/u],
    },
    {
      boundary: "Telegram detached updater",
      file: "scripts/poller/update-flow.ts",
      proofs: [/--setenv=ASSISTANT_DATA_DIR=\$\{DATA_DIR\}/u],
    },
    {
      boundary: "menu doctor",
      file: "scripts/lib/menu/service.ts",
      proofs: [/ASSISTANT_DATA_DIR: ctx\.deps\.dataDir/u],
    },
    {
      boundary: "menu userbot setup",
      file: "scripts/lib/menu/userbot.ts",
      proofs: [/dataDir: resolveDataDir\(/u, /ASSISTANT_DATA_DIR: dataDir/u],
    },
    {
      boundary: "Eve schedule jobs",
      file: "agent/lib/schedule-runner.ts",
      proofs: [
        /ASSISTANT_DATA_DIR: resolveDataDir\([\s\S]*?root \?\? process\.cwd\(\),[\s\S]*?env\.ASSISTANT_DATA_DIR/u,
      ],
    },
    {
      boundary: "candidate health probe",
      file: "scripts/lib/health-probe.ts",
      proofs: [/ASSISTANT_DATA_DIR: join\(dir, "data"\)/u, /\.\.\.env/u],
    },
  ];

  for (const { boundary, file, proofs } of inventory) {
    const source = readFileSync(join(ROOT, file), "utf8");
    for (const proof of proofs)
      assert.match(source, proof, `${boundary} (${file})`);
  }
});
