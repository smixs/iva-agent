import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./fixtures/temp-dir.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// The script retires state beside itself, so each run gets its own copy of it.
function app(): string {
  const root = tempDir("iva-recover-");
  for (const file of [
    "scripts/recover-interrupted-turns.ts",
    "scripts/lib/data-dir.ts",
    "scripts/lib/link-target.ts",
    "scripts/lib/wf-store.ts",
    "agent/lib/run-status.ts",
    "agent/lib/fs-atomic.ts",
    "agent/lib/data-dir.ts",
    "packages/data-dir/index.ts",
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  return root;
}

function recover(root: string) {
  const run = spawnSync(
    process.execPath,
    [join(root, "scripts/recover-interrupted-turns.ts")],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ASSISTANT_DATA_DIR: join(root, "data") },
    },
  );
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

void test("a failed recovery is one journal line and lets the service start", () => {
  const root = app();
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data/run-status.d"), "not a directory");

  const run = recover(root);

  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr.trimEnd().split("\n").length, 1, run.stderr);
  assert.match(run.stderr, /recovery failed/u);
});

void test("the second start after an interrupted turn touches and prints nothing", () => {
  const root = app();
  mkdirSync(join(root, "data/run-status.d"), { recursive: true });
  mkdirSync(join(root, ".eve/.workflow-data"), { recursive: true });
  writeFileSync(
    join(root, "data/run-status.d/chat.json"),
    JSON.stringify({ status: "running", updatedAt: Date.now() }),
  );

  const first = recover(root);
  mkdirSync(join(root, ".eve/.workflow-data"), { recursive: true });
  const second = recover(root);

  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /retired workflow state after 1 interrupted/u);
  assert.deepEqual(second, { code: 0, stdout: "", stderr: "" });
  assert.equal(
    readdirSync(join(root, ".eve")).filter((name) => name.includes(".trash-"))
      .length,
    1,
  );
});
