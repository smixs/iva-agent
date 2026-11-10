/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { isUtf8 } from "node:buffer";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { tempDir } from "../../scripts/fixtures/temp-dir.ts";

// settings.ts фиксирует каталог данных на импорте, поэтому ASSISTANT_DATA_DIR ставим
// ДО динамического импорта. Абсолютный temp-путь заодно уводит запись подальше от
// репо (ветку прода трогать нельзя) и минует cwd-относительную ветку — её проверяем
// отдельным подпроцессом ниже.
const DATA_DIR = mkdtempSync(join(tmpdir(), "iva-settings-"));
process.env.ASSISTANT_DATA_DIR = DATA_DIR;
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
const SETTINGS_LOCK = `${SETTINGS_FILE}.lock`;
const SETTINGS_URL = pathToFileURL(
  join(import.meta.dirname, "settings.ts"),
).href;
const FS_ATOMIC_URL = pathToFileURL(
  join(import.meta.dirname, "fs-atomic.ts"),
).href;
const { readSettings, readSettingsState, writeSettings } =
  await import("./settings.ts");

after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

function reset() {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
}

test("readSettings returns {} when the file is missing", () => {
  reset();
  assert.deepEqual(readSettings(), {});
  assert.deepEqual(readSettingsState(), { state: "missing" });
});

test("readSettings returns {} on corrupt JSON", () => {
  reset();
  writeFileSync(SETTINGS_FILE, "{ broken");
  assert.deepEqual(readSettings(), {});
  assert.equal(readSettingsState().state, "corrupt");
});

test("writeSettings refuses to replace corrupt bytes", () => {
  reset();
  const corrupt = '{"language":"ru","theme":"dark"';
  writeFileSync(SETTINGS_FILE, corrupt);

  assert.throws(
    () => writeSettings({ memoryReports: true }),
    (error: unknown) =>
      (error as { code?: unknown; state?: unknown }).code ===
        "ESETTINGS_WRITE_REFUSED" &&
      (error as { state?: unknown }).state === "corrupt",
  );
  assert.equal(readFileSync(SETTINGS_FILE, "utf8"), corrupt);
});

test("invalid UTF-8 is corrupt and patching preserves its exact bytes", () => {
  reset();
  const corrupt = Buffer.concat([
    Buffer.from('{"future":"'),
    Buffer.from([0x80]),
    Buffer.from('","language":"ru"}'),
  ]);
  writeFileSync(SETTINGS_FILE, corrupt);

  assert.equal(readSettingsState().state, "corrupt");
  assert.throws(
    () => writeSettings({ memoryReports: true }),
    (error: unknown) =>
      (error as { code?: unknown; state?: unknown }).code ===
        "ESETTINGS_WRITE_REFUSED" &&
      (error as { state?: unknown }).state === "corrupt",
  );
  assert.deepEqual(readFileSync(SETTINGS_FILE), corrupt);
});

test("readSettings returns {} for non-object JSON", () => {
  reset();
  writeFileSync(SETTINGS_FILE, "42");
  assert.deepEqual(readSettings(), {});
  assert.equal(readSettingsState().state, "corrupt");
});

test("settings state distinguishes valid and unreadable files", () => {
  reset();
  writeFileSync(SETTINGS_FILE, '{"language":"ru"}');
  assert.deepEqual(readSettingsState(), {
    state: "valid",
    settings: { language: "ru" },
  });

  reset();
  mkdirSync(SETTINGS_FILE);
  assert.equal(readSettingsState().state, "unreadable");
  assert.throws(
    () => writeSettings({ language: "en" }),
    (error: unknown) =>
      (error as { code?: unknown; state?: unknown }).code ===
        "ESETTINGS_WRITE_REFUSED" &&
      (error as { state?: unknown }).state === "unreadable",
  );
  assert.equal(statSync(SETTINGS_FILE).isDirectory(), true);
});

test("writeSettings persists and returns the merged object", () => {
  reset();
  assert.deepEqual(writeSettings({ language: "ru" }), { language: "ru" });
  assert.deepEqual(readSettings(), { language: "ru" });
  assert.equal(statSync(SETTINGS_FILE).mode & 0o777, 0o600);
});

test("writeSettings merges over existing keys", () => {
  reset();
  writeSettings({ language: "ru" });
  assert.deepEqual(writeSettings({ theme: "dark" }), {
    language: "ru",
    theme: "dark",
  });
  assert.deepEqual(writeSettings({ language: "en" }), {
    language: "en",
    theme: "dark",
  });
});

test("a null patch value deletes the key", () => {
  reset();
  writeSettings({ language: "ru", theme: "dark" });
  assert.deepEqual(writeSettings({ theme: null }), { language: "ru" });
  assert.deepEqual(readSettings(), { language: "ru" });
});

test("deleting a missing key is a no-op", () => {
  reset();
  writeSettings({ language: "ru" });
  assert.deepEqual(writeSettings({ missing: null }), { language: "ru" });
});

test("existing unknown null keys survive an unrelated patch", () => {
  reset();
  writeFileSync(
    SETTINGS_FILE,
    JSON.stringify({ future: null, language: "ru" }),
  );
  assert.deepEqual(writeSettings({ language: "en" }), {
    future: null,
    language: "en",
  });
});

test("invalid JSON stays byte-identical after every generated patch attempt (seed 18702)", () => {
  console.log("settings corrupt-byte PBT seed: 18702");
  const invalidJson = fc.string().filter((raw) => {
    try {
      JSON.parse(raw);
      return false;
    } catch {
      return true;
    }
  });
  fc.assert(
    fc.property(invalidJson, (corrupt) => {
      reset();
      writeFileSync(SETTINGS_FILE, corrupt);
      assert.throws(() => writeSettings({ language: "en" }));
      assert.equal(readFileSync(SETTINGS_FILE, "utf8"), corrupt);
    }),
    { seed: 18_702, numRuns: 100 },
  );
});

test("invalid UTF-8 stays byte-identical after every generated patch attempt (seed 18702)", () => {
  console.log("settings invalid-UTF-8 PBT seed: 18702");
  const invalidUtf8 = fc
    .uint8Array({ minLength: 1, maxLength: 256 })
    .filter((bytes) => !isUtf8(bytes));
  fc.assert(
    fc.property(invalidUtf8, (generated) => {
      reset();
      const corrupt = Buffer.from(generated);
      writeFileSync(SETTINGS_FILE, corrupt);
      assert.equal(readSettingsState().state, "corrupt");
      assert.throws(() => writeSettings({ language: "en" }));
      assert.deepEqual(readFileSync(SETTINGS_FILE), corrupt);
    }),
    { seed: 18_702, numRuns: 100 },
  );
});

test("generated valid unknown keys survive a known-key patch (seed 18702)", () => {
  console.log("settings unknown-key PBT seed: 18702");
  const unknownSettings = fc.dictionary(
    fc.string().filter((key) => key !== "language"),
    fc.jsonValue(),
    { maxKeys: 20 },
  );
  fc.assert(
    fc.property(unknownSettings, (unknown) => {
      reset();
      const serialized = JSON.stringify(unknown);
      const persisted = JSON.parse(serialized) as Record<string, unknown>;
      writeFileSync(SETTINGS_FILE, serialized);
      const next = writeSettings({ language: "en" });
      for (const [key, value] of Object.entries(persisted)) {
        assert.deepEqual(next[key], value, `unknown key ${key} changed`);
      }
      assert.equal(next.language, "en");
    }),
    { seed: 18_702, numRuns: 100 },
  );
});

test("the write is atomic: no staging leftovers and the file is valid JSON", () => {
  reset();
  writeSettings({ language: "ru" });
  const leftovers = readdirSync(DATA_DIR).filter((name) =>
    name.startsWith("settings.json.tmp-"),
  );
  assert.deepEqual(leftovers, []);
  assert.deepEqual(JSON.parse(readFileSync(SETTINGS_FILE, "utf8")), {
    language: "ru",
  });
});

test("two processes serialize read-merge-write without losing unique patches", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-settings-race-"));
  const gate = join(dataDir, "go");
  const writesPerProcess = 60;
  const source = [
    "const { existsSync } = await import('node:fs');",
    "const { writeSettings } = await import(process.env.SETTINGS_URL);",
    'process.stdout.write("ready\\n");',
    "while (!existsSync(process.env.GATE))",
    "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);",
    "for (let i = 0; i < Number(process.env.WRITES); i++)",
    "  writeSettings({ [process.env.PREFIX + i]: i });",
  ].join("\n");
  const start = (prefix: string) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        env: {
          ...process.env,
          ASSISTANT_DATA_DIR: dataDir,
          SETTINGS_URL,
          GATE: gate,
          PREFIX: prefix,
          WRITES: String(writesPerProcess),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.ok(child.stdout);
    return child;
  };
  const children = [start("a"), start("b")];
  try {
    await Promise.all(children.map((child) => once(child.stdout, "data")));
    writeFileSync(gate, "go");
    const exits = await Promise.all(
      children.map(
        (child) =>
          new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve, reject) => {
              child.once("error", reject);
              child.once("exit", (code, signal) => resolve({ code, signal }));
            },
          ),
      ),
    );
    assert.deepEqual(exits, [
      { code: 0, signal: null },
      { code: 0, signal: null },
    ]);
    const settings = JSON.parse(
      readFileSync(join(dataDir, "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(Object.keys(settings).length, writesPerProcess * 2);
    for (const prefix of ["a", "b"]) {
      for (let i = 0; i < writesPerProcess; i++) {
        assert.equal(settings[`${prefix}${i}`], i);
      }
    }
  } finally {
    for (const child of children) child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a crashed settings-lock owner leaves evidence and stale takeover recovers", async () => {
  reset();
  const source = [
    "const { acquireFileLockSync } = await import(process.env.FS_ATOMIC_URL);",
    "const lock = acquireFileLockSync(process.env.SETTINGS_LOCK);",
    "if (!lock) process.exit(2);",
    'process.stdout.write("ready\\n");',
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, FS_ATOMIC_URL, SETTINGS_LOCK },
    stdio: ["ignore", "pipe", "inherit"],
  });
  assert.ok(child.stdout);
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");

  assert.equal(existsSync(SETTINGS_LOCK), true);
  const stale = new Date(Date.now() - 30_000);
  utimesSync(SETTINGS_LOCK, stale, stale);
  assert.deepEqual(writeSettings({ language: "en" }), { language: "en" });
  assert.equal(existsSync(SETTINGS_LOCK), false);
});

test("data dir defaults to <cwd>/data for a relative ASSISTANT_DATA_DIR", () => {
  // Абсолютный ASSISTANT_DATA_DIR у родителя минует эту ветку, поэтому проверяем её
  // в отдельном процессе с cwd=temp и без ASSISTANT_DATA_DIR (дефолт "data").
  const cwd = tempDir("iva-settings-cwd-");
  const url = pathToFileURL(join(import.meta.dirname, "settings.ts")).href;
  const code =
    'const { writeSettings } = await import(process.env.__URL); writeSettings({ language: "en" });';
  const env: NodeJS.ProcessEnv = { ...process.env, __URL: url };
  delete env.ASSISTANT_DATA_DIR;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env,
    cwd,
    encoding: "utf8",
  });
  assert.deepEqual(
    JSON.parse(readFileSync(join(cwd, "data", "settings.json"), "utf8")),
    { language: "en" },
  );
});

test("updateSettings: two processes changing one nested object lose no update", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-settings-update-race-"));
  const gate = join(dataDir, "go");
  const updatesPerProcess = 40;
  const source = [
    "const { existsSync } = await import('node:fs');",
    "const { updateSettings } = await import(process.env.SETTINGS_URL);",
    'process.stdout.write("ready\\n");',
    "while (!existsSync(process.env.GATE))",
    "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);",
    "for (let i = 0; i < Number(process.env.UPDATES); i++)",
    "  updateSettings((s) => ({ ...s, proactive: { ...s.proactive, n: (s.proactive?.n ?? 0) + 1 } }));",
  ].join("\n");
  const children = ["a", "b"].map(() => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        env: {
          ...process.env,
          ASSISTANT_DATA_DIR: dataDir,
          SETTINGS_URL,
          GATE: gate,
          UPDATES: String(updatesPerProcess),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.ok(child.stdout);
    return child;
  });
  try {
    writeFileSync(
      join(dataDir, "settings.json"),
      JSON.stringify({ language: "ru", proactive: { staleMinutes: 30 } }),
    );
    await Promise.all(children.map((child) => once(child.stdout, "data")));
    writeFileSync(gate, "go");
    const exits = await Promise.all(
      children.map((child) => once(child, "exit") as Promise<[number | null]>),
    );
    assert.deepEqual(
      exits.map(([code]) => code),
      [0, 0],
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")),
      {
        language: "ru",
        proactive: { staleMinutes: 30, n: updatesPerProcess * 2 },
      },
    );
  } finally {
    for (const child of children) child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("updateSettings on an explicit path refuses corrupt bytes and keeps them", async () => {
  const { updateSettings } = await import("./settings.ts");
  const dir = mkdtempSync(join(tmpdir(), "iva-settings-path-"));
  try {
    const file = join(dir, "settings.json");
    writeFileSync(file, "[1,2]");
    assert.throws(
      () => updateSettings((s) => ({ ...s, a: 1 }), file),
      (error: unknown) =>
        (error as { code?: unknown }).code === "ESETTINGS_WRITE_REFUSED",
    );
    assert.equal(readFileSync(file, "utf8"), "[1,2]");
    writeFileSync(file, '{"keep":true}');
    assert.deepEqual(
      updateSettings((s) => ({ ...s, a: 1 }), file),
      { keep: true, a: 1 },
    );
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      keep: true,
      a: 1,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
