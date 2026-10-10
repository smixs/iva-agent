import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveUv, userbotSyncArgs } from "./userbot-deps.ts";

void test("userbot install enforces hashes and exact environment sync", () => {
  assert.deepEqual(
    userbotSyncArgs({
      pythonPath: "/tmp/venv/bin/python",
      requirementsFile: "requirements.lock",
      requirementsText: "idna==3.18 --hash=sha256:abc",
    }),
    [
      "pip",
      "sync",
      "--python",
      "/tmp/venv/bin/python",
      "--require-hashes",
      "--strict",
      "requirements.lock",
    ],
  );
});

void test("unhashed requirements are rejected during normal setup and update", () => {
  assert.throws(
    () =>
      userbotSyncArgs({
        pythonPath: "/tmp/venv/bin/python",
        requirementsFile: "requirements.lock",
        requirementsText: "idna>=3",
      }),
    /requirements\.lock не содержит hashes/,
  );
});

void test("rollback syncs the exact frozen environment and removes extras", () => {
  assert.deepEqual(
    userbotSyncArgs({
      pythonPath: "/tmp/venv/bin/python",
      requirementsFile: "/tmp/userbot-before-update.txt",
      requirementsText: "idna==3.17",
      requireHashes: false,
    }),
    [
      "pip",
      "sync",
      "--python",
      "/tmp/venv/bin/python",
      "/tmp/userbot-before-update.txt",
    ],
  );
});

void test("uv resolution requires an executable file and falls back to the installed home binary (seed 20261005)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-uv-resolution-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let run = 0;
  fc.assert(
    fc.property(
      fc.constantFrom(
        "missing",
        "directory",
        "not-executable",
        "dangling",
        "executable",
        "symlink",
      ),
      fc.boolean(),
      fc.constantFrom("owner", "owner with spaces", "владелец"),
      (kind, local, name) => {
        const home = join(root, String(run++) + name);
        const bin = join(home, "caller-bin"),
          fallback = join(home, ".local/bin/uv"),
          candidate = join(bin, "uv");
        mkdirSync(bin, { recursive: true });
        const make = (path: string) => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, "#!/bin/sh\nexit 0\n");
          chmodSync(path, 0o755);
        };
        if (local) make(fallback);
        if (kind === "directory") mkdirSync(candidate);
        if (kind === "not-executable") {
          make(candidate);
          chmodSync(candidate, 0o600);
        }
        if (kind === "dangling") symlinkSync(join(home, "absent"), candidate);
        if (kind === "executable") make(candidate);
        if (kind === "symlink") {
          const target = join(home, "uv-real");
          make(target);
          symlinkSync(target, candidate);
        }
        assert.equal(
          resolveUv(bin, home),
          ["executable", "symlink"].includes(kind)
            ? candidate
            : local
              ? fallback
              : null,
        );
      },
    ),
    { seed: 20261005, numRuns: 60 },
  );
});
