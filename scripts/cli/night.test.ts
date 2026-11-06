import "../lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { createNightCommand } from "./night.ts";
import {
  NIGHT_DEFAULTS,
  parseNightSettings,
} from "../../agent/lib/memory-night-constants.ts";
import {
  acquireFileLockSync,
  releaseFileLock,
} from "../../agent/lib/fs-atomic.ts";

function harness(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "iva-cli-night-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out: string[] = [];
  t.mock.method(console, "log", (line: string) => out.push(line));
  const cmd = createNightCommand({
    ok: (line) => out.push(line),
    dataDirAbs: () => dir,
    readEnv: () => ({}),
  });
  const file = join(dir, "settings.json");
  return {
    file,
    cmd,
    out,
    read: () =>
      JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>,
  };
}

void test("night CLI shows seven defaults, sets one field and preserves neighbours", async (t) => {
  const h = harness(t);
  await h.cmd(["show"]);
  assert.deepEqual(
    h.out.slice(0, 7),
    Object.entries(NIGHT_DEFAULTS).map(([key, value]) => `${key}: ${value}`),
  );
  writeFileSync(
    h.file,
    JSON.stringify({ language: "en", night: { calls: 50, future: true } }),
  );
  await h.cmd(["set", "inputTokens", "600000"]);
  await h.cmd(["set", "raisesPerNight", "0"]);
  assert.deepEqual(h.read(), {
    language: "en",
    night: { calls: 50, future: true, inputTokens: 600_000, raisesPerNight: 0 },
  });
  assert.ok(h.out.includes("Night inputTokens: 600000"));
});

void test("night CLI refuses bad values, ceilings and syntax without changing bytes", async (t) => {
  const h = harness(t);
  const bytes = '{"language":"ru","night":{"inputTokens":600000}}';
  writeFileSync(h.file, bytes);
  for (const args of [
    ["set", "inputTokens", "5000000"],
    ["set", "calls", "no"],
    ["set", "calls", "0"],
    ["set", "calls", "-1"],
    ["set", "calls", "0.5"],
    ["set", "calls", "Infinity"],
    ["set", "calls", " "],
    ["set", "maxInputTokens", "300000"],
    ["set", "__proto__", "1"],
    ["set", "calls", "2", "extra"],
    ["show", "extra"],
    [],
  ]) {
    await assert.rejects(h.cmd(args), /Команда: iva night/u);
    assert.equal(readFileSync(h.file, "utf8"), bytes);
  }
  await h.cmd(["set", "maxInputTokens", "5000000"]);
  await h.cmd(["set", "inputTokens", "5000000"]);
  assert.equal(
    (h.read().night as { inputTokens: number }).inputTokens,
    5_000_000,
  );
});

void test("night CLI refuses corrupt and busy settings; show remains available", async (t) => {
  const h = harness(t);
  writeFileSync(h.file, "{broken");
  await h.cmd(["show"]);
  assert.ok(h.out.some((line) => line.includes("corrupt")));
  await assert.rejects(
    h.cmd(["set", "calls", "50"]),
    /Сохранить настройки ночи/u,
  );
  assert.equal(readFileSync(h.file, "utf8"), "{broken");
  writeFileSync(h.file, "{}");
  const lock = acquireFileLockSync(`${h.file}.lock`);
  assert.ok(lock);
  try {
    await assert.rejects(
      h.cmd(["set", "calls", "50"]),
      /Сохранить настройки ночи/u,
    );
  } finally {
    releaseFileLock(lock);
  }
  assert.equal(readFileSync(h.file, "utf8"), "{}");
});

void test("night settings parser always returns bounded safe integers for arbitrary JSON", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (raw) => {
      const { values } = parseNightSettings({ night: raw });
      for (const [key, value] of Object.entries(values)) {
        assert.ok(Number.isSafeInteger(value));
        assert.ok(key === "raisesPerNight" ? value >= 0 : value > 0);
      }
      assert.ok(values.calls <= values.maxCalls);
      assert.ok(values.inputTokens <= values.maxInputTokens);
      assert.ok(values.gitTimeoutMs <= values.maxGitTimeoutMs);
    }),
    { numRuns: 150, seed: 261026 },
  );
  assert.ok(
    parseNightSettings({ night: { calls: "40" } }).invalid.includes(
      "night.calls",
    ),
  );
  assert.equal(
    parseNightSettings({ night: { raisesPerNight: 0 } }).values.raisesPerNight,
    0,
  );
});

void test("night updates and a menu language change share the settings lock", async (t) => {
  const h = harness(t);
  writeFileSync(
    h.file,
    JSON.stringify({ language: "ru", night: { calls: 40 }, reports: true }),
  );
  const hooks = resolve(import.meta.dirname, "../lib/ts-esm-hooks.ts");
  const settings = resolve(import.meta.dirname, "../../agent/lib/settings.ts");
  const child = spawn(
    process.execPath,
    [
      "--import",
      hooks,
      "--input-type=module",
      "-e",
      `
    import { updateSettings } from ${JSON.stringify(settings)};
    updateSettings(current => {
      process.stdout.write("locked");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      return { ...current, language: "en" };
    }, ${JSON.stringify(h.file)});
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const done = new Promise<number | null>((accept) =>
    child.once("close", accept),
  );
  await new Promise<void>((accept) =>
    child.stdout.once("data", () => accept()),
  );
  await h.cmd(["set", "inputTokens", "600000"]);
  assert.equal(await done, 0, stderr);
  assert.deepEqual(h.read(), {
    language: "en",
    night: { calls: 40, inputTokens: 600000 },
    reports: true,
  });
});
