import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import {
  FAKE_SYSTEMCTL,
  FAKE_EVE,
  BEFORE,
  service,
} from "../fixtures/update-run-installation.ts";
import { assertPinnedFinal } from "../fixtures/update-pin-harness.ts";
import { createVersionStore, versionName } from "../lib/version-store.ts";
import { readUpdateRun } from "../lib/update-run-journal.ts";

const ROOT = join(import.meta.dirname, "../..");
function write(path: string, body: string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode });
}
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
}
function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; out: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      let out = "";
      child.stdout.on("data", (chunk) => (out += String(chunk)));
      child.stderr.on("data", (chunk) => (out += String(chunk)));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out }));
    },
  );
}

await test(
  "S-update-cycle: shipped CLI hands off, SIGKILL before pin recovers, rollback preserves data",
  { timeout: 110_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "iva-smoke-update-"));
    let passed = false;
    t.after(() => {
      if (passed) rmSync(root, { recursive: true, force: true });
      else console.error(`S-update-cycle evidence: ${root}`);
    });
    const source = join(root, "source");
    const home = join(root, "iva");
    const bin = join(root, "bin");
    const state = join(root, "units.json");
    mkdirSync(bin);
    cpSync(process.execPath, join(bin, "node"));
    mkdirSync(source);
    // Copy runtime sources, not a second running Iva. npm and systemctl are fixtures.
    for (const dir of ["scripts", "agent", "packages", "deploy", "bin"])
      cpSync(join(ROOT, dir), join(source, dir), {
        recursive: true,
        filter: (path) =>
          !path.endsWith(".test.ts") &&
          !path.includes("/fixtures") &&
          !path.includes("/smoke"),
      });
    for (const file of ["package.json", "update-compat.json"])
      cpSync(join(ROOT, file), join(source, file));
    const manifest = JSON.parse(
      readFileSync(join(source, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    write(
      join(source, "package.json"),
      JSON.stringify({ ...manifest, version: "0.5.13" }),
    );
    rmSync(join(source, "scripts/migrations"), {
      recursive: true,
      force: true,
    });
    write(join(source, "scripts/vault-cleanup.ts"), "export {};\n");
    // Instrument the copied candidate at the precise R1 boundary, before active.json.
    const storePath = join(source, "scripts/lib/version-store.ts");
    write(
      storePath,
      readFileSync(storePath, "utf8").replace(
        "    const before = activeState();",
        '    if (process.env.IVA_KILL_AT === "pin") process.kill(process.pid, "SIGKILL");\n    const before = activeState();',
      ),
    );
    const entry = join(source, "scripts/update-finish.ts");
    write(
      entry,
      'import {appendFileSync} from "node:fs";\nappendFileSync(process.env.IVA_TRACE!, "new update-finish\\n");\n' +
        readFileSync(entry, "utf8"),
    );
    git(source, "init", "-q", "--initial-branch=main");
    git(source, "commit", "--allow-empty", "-qm", "previous release");
    const old = versionName("0.5.12", git(source, "rev-parse", "HEAD"));
    git(source, "tag", "v0.5.12");
    git(source, "add", ".");
    git(source, "commit", "-qm", "candidate");
    git(source, "tag", "v0.5.13");
    const sha = git(source, "rev-parse", "HEAD");
    const name = versionName("0.5.13", sha);
    mkdirSync(home);
    git(root, "clone", "-q", "--mirror", source, join(home, "repo"));
    const store = createVersionStore(home);
    const oldDir = store.stage(old);
    execFileSync("tar", ["-xf", "-", "-C", oldDir], {
      input: execFileSync(
        "git",
        [
          "archive",
          "v0.5.12",
          "scripts",
          "agent",
          "packages",
          "bin",
          "deploy",
          "package.json",
        ],
        { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 },
      ),
    });
    symlinkSync(join(ROOT, "node_modules"), join(oldDir, "node_modules"));
    store.linkState(oldDir);
    store.complete(old);
    store.activate(old);
    store.settle(old);
    const server = await service(state, 0);
    t.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address === "object");
    write(
      join(home, ".env"),
      `MODEL_PROVIDER=ollama\nAGENT_LANGUAGE=en\nIVA_PORT=${address.port}\nASSISTANT_TIMEZONE=UTC\nASSISTANT_BEARER=${"a".repeat(43)}\n`,
    );
    write(
      join(home, ".eve/.workflow-data/session-sentinel.json"),
      '{"kept":true}\n',
    );
    write(join(home, "data/sentinel"), "owner data survives\n");
    write(
      state,
      JSON.stringify({
        ...BEFORE,
        "iva-telegram-userbot.service": { active: false, enabled: false },
      }),
    );
    write(join(root, "systemctl.ts"), FAKE_SYSTEMCTL);
    write(
      join(bin, "systemctl"),
      `#!/bin/sh\nexec '${process.execPath}' '${join(root, "systemctl.ts")}' "$@"\n`,
      0o755,
    );
    // All dependency/build effects stay local. Use the existing updater build fixture.
    write(
      join(root, "npm.ts"),
      `import {mkdirSync,writeFileSync,symlinkSync,readdirSync,existsSync} from "node:fs";
import {join} from "node:path";
import {fixtureRunner} from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/fixtures/version-update-harness.ts")).href)};
const dir=process.cwd(); const args=process.argv.slice(2);
if(args[0]==="ci") {
 mkdirSync(join(dir,"node_modules"),{recursive:true});
 for(const n of readdirSync(${JSON.stringify(join(ROOT, "node_modules"))})) if(n!=="eve" && !existsSync(join(dir,"node_modules",n))) symlinkSync(join(${JSON.stringify(join(ROOT, "node_modules"))},n),join(dir,"node_modules",n));
 mkdirSync(join(dir,"node_modules/eve/bin"),{recursive:true});
 writeFileSync(join(dir,"node_modules/eve/package.json"),'{"type":"module"}');
 writeFileSync(join(dir,"node_modules/eve/bin/eve.js"),${JSON.stringify(FAKE_EVE)});
}
const result=await fixtureRunner()("npm",args,dir); console.log(result.output); process.exitCode=result.code;
`,
    );
    write(
      join(bin, "npm"),
      `#!/bin/sh\nexec '${process.execPath}' '${join(root, "npm.ts")}' "$@"\n`,
      0o755,
    );
    const env = {
      ...process.env,
      HOME: root,
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      IVA_KILL_STATE: state,
      IVA_TRACE: join(root, "trace.log"),
      AGENT_LANGUAGE: "en",
      NO_COLOR: "1",
      NODE_OPTIONS: `--import=${join(ROOT, "scripts/fixtures/shifted-clock.ts")}`,
      IVA_TEST_NOW: "2026-11-01T00:00:00.000Z",
    };
    const cli = join(oldDir, "bin/iva.mjs");
    const killed = await run(join(bin, "node"), [cli, "update"], {
      ...env,
      IVA_KILL_AT: "pin",
    });
    write(join(root, "killed.log"), killed.out);
    assert.notEqual(killed.code, 0, killed.out);
    assert.equal(store.currentName(), name, killed.out);
    assert.equal(store.settled(), old);
    const interrupted = readUpdateRun(store.layout.data);
    assert.equal(interrupted?.phase, "started");
    assert.ok(interrupted.quarantine.length > 0);
    const again = await run(join(bin, "node"), [cli, "update"], env);
    write(join(root, "again.log"), again.out);
    assert.equal(again.code, 0, again.out);
    assert.equal(store.currentName(), name);
    assert.equal(store.settled(), name);
    assert.ok(
      ["settled", "done"].includes(
        readUpdateRun(store.layout.data)?.phase ?? "",
      ),
    );
    assert.deepEqual(
      readUpdateRun(store.layout.data)?.quarantine,
      interrupted.quarantine,
    );
    assert.equal(readUpdateRun(store.layout.data)?.attempts, 2);
    assert.ok(
      interrupted.quarantine.some((item) =>
        existsSync(join(item.trash, "session-sentinel.json")),
      ),
    );
    assert.match(
      readFileSync(join(root, "trace.log"), "utf8"),
      /new update-finish/u,
    );
    const rollback = await run(join(bin, "node"), [cli, "rollback"], env);
    assert.equal(rollback.code, 0, rollback.out);
    assert.equal(store.currentName(), old);
    assert.equal(store.settled(), old);
    assert.equal(
      readFileSync(join(home, "data/sentinel"), "utf8"),
      "owner data survives\n",
    );
    passed = true;
  },
);

await test(
  "S-update-cycle: FinalOnlyWhenPinned keeps UpdateJob pending before active.json",
  assertPinnedFinal,
);
