/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROBE_FLAG } from "./lib/eve-health.ts";
import instrumentation from "./instrumentation.ts";
import { processTimeZone } from "./lib/process-timezone.ts";

/** Run the server-start hook with console output captured. */
function boot(t: { after(fn: () => void): void }): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  t.after(() => {
    console.log = original;
  });
  instrumentation.setup?.();
  return lines;
}

test("eve keeps the startup hook active without recording payloads", () => {
  assert.equal(typeof instrumentation.setup, "function");
  assert.equal(instrumentation.recordInputs, false);
  assert.equal(instrumentation.recordOutputs, false);
});

test("a start that is an update's health probe migrates nothing", (t) => {
  process.env[PROBE_FLAG] = "1";
  process.env.ASSISTANT_TIMEZONE = "Asia/Tashkent";
  t.after(() => {
    delete process.env[PROBE_FLAG];
    delete process.env.ASSISTANT_TIMEZONE;
  });

  const lines = boot(t);

  // The probe start is the one start that must leave the installation alone: the
  // migration retires systemd units and can spawn a rollup, and the version it
  // would do that for is one the installation has not accepted yet.
  assert.deepEqual(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /schedule-migration: skipped/u);
  assert.match(lines[0], /health probe/u);
  // The timezone is still applied: it decides what the process thinks "now" is,
  // and a probe that starts in the wrong one proves the wrong thing.
  assert.equal(process.env.TZ, "Asia/Tashkent");
});

test("server start gives every non-TS child the canonical absolute data dir", (t) => {
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env[PROBE_FLAG] = "1";
  process.env.ASSISTANT_DATA_DIR = " state/../runtime ";
  t.after(() => {
    delete process.env[PROBE_FLAG];
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
  });

  boot(t);

  const canonical = resolve(process.cwd(), "runtime");
  assert.equal(process.env.ASSISTANT_DATA_DIR, canonical);
  const child = spawnSync(
    "/bin/sh",
    ["-c", 'printf %s "$ASSISTANT_DATA_DIR"'],
    {
      env: { ASSISTANT_DATA_DIR: process.env.ASSISTANT_DATA_DIR },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, canonical);
});

test("the TZ exported to children is a name this host has a zone file for", () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-zoneinfo-"));
  try {
    mkdirSync(join(dir, "Europe"), { recursive: true });
    writeFileSync(join(dir, "Europe/Kyiv"), "TZif2");

    // Only the modern file exists: that spelling is exported, never the legacy one.
    const kyiv = processTimeZone("Europe/Kyiv", dir);
    assert.equal(kyiv.exported, "Europe/Kyiv");
    // The legacy spelling resolves to the same file name, Intl keeps its own name.
    assert.equal(processTimeZone("Europe/Kiev", dir).exported, "Europe/Kyiv");
    // The owner's spelling is used when the host has that file.
    writeFileSync(join(dir, "Europe/Kiev"), "TZif2");
    assert.equal(processTimeZone("Europe/Kiev", dir).exported, "Europe/Kiev");
    // An invalid value is never exported as the owner's spelling.
    const bad = processTimeZone("Not/AZone", dir);
    assert.equal(bad.invalid, true);
    assert.equal(bad.exported, "UTC");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
