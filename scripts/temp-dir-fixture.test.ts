/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Уборка фикстуры tempDir на выходе процесса: каталог, который удалить нельзя, не оставляет
// за собой остальные (находка C2 слепого критика волны А).
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const FIXTURE = pathToFileURL(
  join(import.meta.dirname, "fixtures/temp-dir.ts"),
).href;

test(
  "tempDir: a folder that cannot be removed is named, and the next one is still removed",
  { skip: process.getuid?.() === 0 && "root removes a folder with mode 000" },
  (t) => {
    const home = mkdtempSync(join(tmpdir(), "iva-temp-dir-"));
    t.after(() => {
      for (const locked of [join(home, "first", "locked")])
        if (existsSync(locked)) chmodSync(locked, 0o700);
      rmSync(home, { recursive: true, force: true });
    });
    const child = `import { tempDir } from ${JSON.stringify(FIXTURE)};
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const first = tempDir("first-"), second = tempDir("second-");
mkdirSync(join(first, "locked"));
writeFileSync(join(first, "locked", "x"), "x");
chmodSync(join(first, "locked"), 0);
console.log(JSON.stringify([first, second]));`;
    const run = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", child],
      { encoding: "utf8", env: { ...process.env, TMPDIR: home } },
    );
    assert.equal(run.status, 0, run.stderr);
    const [first, second] = JSON.parse(run.stdout) as [string, string];
    assert.match(run.stderr, /tempDir: .*first-.* is left behind/u);
    assert.equal(existsSync(second), false, "the second folder is removed");
    chmodSync(join(first, "locked"), 0o700);
  },
);
