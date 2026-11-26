import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stableNodeExecutable } from "./node-executable.ts";
import { refreshOwnedShim } from "./version-layout.ts";
import { unitToPlist } from "./launchd-plist.ts";

void test(
  "Homebrew upgrade keeps generated shim and launchd executables usable",
  { skip: process.platform !== "darwin" },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "iva-node-upgrade-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const old = join(root, "Cellar/node/24.1/bin/node");
    const stable = join(root, "opt/node/bin/node");
    for (const path of [old, stable])
      mkdirSync(dirname(path), { recursive: true });
    symlinkSync(process.execPath, old);
    symlinkSync(old, stable);
    const home = join(root, "iva-home");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(
      join(home, "bin/iva.mjs"),
      'console.log("entrypoint", process.argv[2]);\n',
    );
    const shim = join(root, "iva");
    assert.equal(refreshOwnedShim(shim, home, old, join(home, "data")), true);
    const plist = unitToPlist(
      { unit: "iva.service", body: `ExecStart=${old} ${home}/bin/iva.mjs\n` },
      undefined,
      { root: home, home: root, node: old },
    );
    assert.ok(readFileSync(shim, "utf8").includes(`exec "${stable}"`));
    assert.ok(plist.includes(`<string>${stable}</string>`));
    assert.ok(!plist.includes(old));
    unlinkSync(stable);
    symlinkSync(process.execPath, stable); // Homebrew links opt to the upgraded keg.
    rmSync(join(root, "Cellar/node/24.1"), { recursive: true });
    const result = spawnSync("/bin/sh", [shim, "version"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /entrypoint version/u);
    assert.equal(spawnSync(stable, ["--version"]).status, 0);
  },
);

void test("only a matching executable Homebrew link is selected", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-node-validation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = join(root, "Cellar/node@24/24.1/bin/node");
  const stable = join(root, "opt/node@24/bin/node");
  mkdirSync(dirname(old), { recursive: true });
  mkdirSync(dirname(stable), { recursive: true });
  symlinkSync(process.execPath, old);
  assert.throws(() => stableNodeExecutable(old, "darwin"), /Cannot persist/u);
  symlinkSync("/bin/sh", stable);
  assert.throws(() => stableNodeExecutable(old, "darwin"), /Cannot persist/u);
  unlinkSync(stable);
  symlinkSync(old, stable);
  assert.equal(stableNodeExecutable(old, "darwin"), stable);
  assert.equal(stableNodeExecutable(old, "linux"), old);
  for (const path of [
    "/usr/local/bin/node",
    "/home/u/.nvm/versions/node/v24/bin/node",
    "/custom/Cellar/other/1/bin/node",
  ])
    assert.equal(stableNodeExecutable(path, "darwin"), path);
});
