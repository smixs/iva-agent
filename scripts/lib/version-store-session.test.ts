/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises */
// The real end-to-end of the collection: a demoted version's sandbox session is
// state a rollback returns to, not cache. A serving writes a file through the
// just-bash backend, persists its reconnect record the way eve's captureState
// does, the update collects its `.eve`, the rollback lands back on it, and a
// fresh process must still open the session and find the file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { justbash } from "eve/sandbox/just-bash";
import { createVersionStore, KEEP } from "./version-store.ts";

const REATTACH = fileURLToPath(
  new URL("../fixtures/sandbox-session-reattach.ts", import.meta.url),
);
const SESSION_KEY = "session-under-test";
const STAGED = "staged payload survives the version switch\n";

test("collection of a demoted version keeps the sandbox session a rollback reattaches to", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "iva-versions-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = createVersionStore(home);
  const previous = "0.3.13-333333333333";
  const current = "0.3.14-444444444444";
  const install = (name: string): string => {
    const dir = store.stage(name);
    writeFileSync(join(dir, "marker.txt"), name);
    store.complete(name);
    return dir;
  };
  const demotedDir = install(previous);
  install(current);

  // The demoted version served once: a real just-bash session staged a file
  // and its reconnect record went to disk the way eve persists captureState.
  const backend = justbash();
  const handle = await backend.create({
    runtimeContext: { appRoot: demotedDir },
    sessionKey: SESSION_KEY,
    templateKey: null,
  });
  await handle.session.writeTextFile({
    content: STAGED,
    path: "attachment.txt",
  });
  const state = await handle.captureState();
  const statePath = join(home, "persisted-session.json");
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  await handle.shutdown();

  // The switch to `current` collects the demoted version's `.eve`; the
  // rollback lands back on it.
  store.activate(previous);
  store.settle(previous);
  store.activate(current);
  store.settle(current);
  store.gc(KEEP);
  store.activate(previous);
  store.settle(previous);

  // A separate process — a start knows nothing of the serving that wrote the
  // session — reopens it from the persisted record and must see the file.
  const child = spawnSync(
    process.execPath,
    [REATTACH, demotedDir, statePath, "attachment.txt"],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, STAGED);
});
