/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// .memory.lock мимо раннера: процесс перезапускает себя под `flock -n` на том же файле.
// Фальшивый flock в PATH пишет свои аргументы и отвечает «занято» или кодом команды.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { memoryLockPath } from "#lib/schedule-paths.ts";
import { underMemoryLock } from "./memory-lock.ts";

function withFlock(t: { after: (fn: () => void) => void }, body: string) {
  const dir = mkdtempSync(join(tmpdir(), "iva-memory-lock-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  mkdirSync(join(dir, "bin"));
  writeFileSync(
    join(dir, "bin", "flock"),
    // printf, а не echo: у dash (sh на Linux) `echo -n …` съедает сам флаг.
    `#!/bin/sh\nprintf '%s\\n' "$*" > "${join(dir, "args")}"\n${body}\n`,
    { mode: 0o755 },
  );
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: join(dir, "bin") };
  delete env.IVA_MEMORY_LOCK_HELD;
  return { dir, env, args: () => readFileSync(join(dir, "args"), "utf8") };
}

test("a process already under the lock just works", () => {
  assert.equal(
    underMemoryLock("/srv/iva/.memory.lock", { IVA_MEMORY_LOCK_HELD: "1" }),
    null,
  );
});

test("a free lock reruns the process under flock on the resolver's path and returns its exit code", (t) => {
  const { env, args } = withFlock(t, "exit 7");
  assert.equal(underMemoryLock(memoryLockPath("/srv/iva"), env, "linux"), 7);
  assert.match(args(), /^-n -E 75 \/srv\/iva\/\.memory\.lock /u);
});

test("the job's stop time is not a sign of holding the lock", (t) => {
  const { env, args } = withFlock(t, "exit 0");
  assert.equal(
    underMemoryLock(
      memoryLockPath("/srv/iva"),
      {
        ...env,
        IVA_JOB_STOP_AT: String(Date.now() + 60_000),
      },
      "linux",
    ),
    0,
  );
  assert.match(args(), /\.memory\.lock/u, "flock was taken all the same");
});

test("a held lock and a missing flock both refuse with exit 1", (t) => {
  const { env } = withFlock(t, "exit 75");
  assert.equal(underMemoryLock("/srv/iva/.memory.lock", env, "linux"), 1);
  assert.equal(
    underMemoryLock(
      "/srv/iva/.memory.lock",
      { ...env, PATH: "/nonexistent" },
      "linux",
    ),
    1,
  );
});
