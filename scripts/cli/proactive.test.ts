/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// `iva proactive show | on | off | set`: проверка входа, соседние ключи на месте, битые
// настройки и неверный вход — отказ без записи (диспетчер CLI превращает отказ в код 1).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { createProactiveCommand } from "./proactive.ts";
import { dispatchCli } from "./main.ts";

const ROOT = mkdtempSync(join(tmpdir(), "iva-cli-proactive-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

function harness(t: TestContext) {
  const dir = mkdtempSync(join(ROOT, "data-"));
  const ok: string[] = [];
  const out: string[] = [];
  t.mock.method(console, "log", (line: string) => out.push(line));
  const cmd = createProactiveCommand(
    {
      ok: (message: string) => ok.push(message),
      dataDirAbs: () => dir,
      readEnv: () => ({ ASSISTANT_TIMEZONE: "UTC" }),
    },
    { now: () => Date.UTC(2026, 9, 5, 12) },
  );
  const file = join(dir, "settings.json");
  return {
    cmd,
    ok,
    out,
    file,
    dir,
    settings: () =>
      JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>,
  };
}

test("set writes one field of proactive and keeps every neighbour", async (t) => {
  const h = harness(t);
  writeFileSync(
    h.file,
    JSON.stringify({
      language: "ru",
      proactive: { staleMinutes: 30 },
      memoryReports: { enabled: true },
    }),
  );
  await h.cmd(["set", "watchCapPerDay", "3"]);
  await h.cmd(["set", "urgentSenders", "Жена, @boss"]);
  await h.cmd(["off"]);
  assert.deepEqual(h.settings(), {
    language: "ru",
    memoryReports: { enabled: true },
    proactive: {
      staleMinutes: 30,
      watchCapPerDay: 3,
      urgentSenders: ["Жена", "@boss"],
      enabled: false,
    },
  });
  await h.cmd(["on"]);
  assert.equal((h.settings().proactive as { enabled: boolean }).enabled, true);
  assert.deepEqual(h.ok, [
    "proactive watchCapPerDay: 3",
    "proactive urgentSenders: Жена,@boss",
    "proactive enabled: false",
    "proactive enabled: true",
  ]);
});

test("set without a settings file creates it with only proactive", async (t) => {
  const h = harness(t);
  await h.cmd(["set", "briefTimes", "09:00,18:30"]);
  assert.deepEqual(h.settings(), {
    proactive: { briefTimes: ["09:00", "18:30"] },
  });
});

test("a bad value or key is refused and the file is not touched", async (t) => {
  const h = harness(t);
  const before = JSON.stringify({ language: "en" });
  writeFileSync(h.file, before);
  for (const args of [
    ["set", "watchCapPerDay", "many"],
    ["set", "briefTimes", "09:10"],
    ["set", "nope", "1"],
    ["set", "enabled"],
    ["set", "enabled", "on", "extra"],
    ["toggle"],
    [],
  ])
    await assert.rejects(h.cmd(args));
  assert.equal(readFileSync(h.file, "utf8"), before);
});

test("corrupt settings: the write is refused, the bytes stay; the dispatcher exits 1", async (t) => {
  const h = harness(t);
  writeFileSync(h.file, "{ broken");
  await assert.rejects(
    h.cmd(["off"]),
    /Refusing to patch settings: settings.json is corrupt/u,
  );
  assert.equal(readFileSync(h.file, "utf8"), "{ broken");
  const codes: number[] = [];
  const bad: string[] = [];
  await dispatchCli(
    ["proactive", "off"],
    { proactive: h.cmd },
    {
      bad: (m) => bad.push(m),
      help: () => undefined,
      exit: ((code: number) => {
        codes.push(code);
      }) as never,
    },
  );
  assert.deepEqual(codes, [1]);
  assert.match(bad[0] ?? "", /corrupt/u);
});

test("show prints the effective settings and today's counters", async (t) => {
  const h = harness(t);
  writeFileSync(
    h.file,
    JSON.stringify({
      proactive: { watchCapPerDay: 2, urgentSenders: ["wife"] },
    }),
  );
  writeFileSync(
    join(h.dir, "proactive.json"),
    JSON.stringify({
      schemaVersion: 1,
      seen: {},
      wakes: { day: "2026-10-05", count: 2 },
      modelWakes: { day: "2026-10-04", count: 9 },
      briefDone: { day: "", slots: [] },
      failuresSeenUpToMs: 0,
    }),
  );
  await h.cmd(["show"]);
  assert.deepEqual(h.out, [
    "enabled: true",
    "quietFromHour: 23",
    "quietToHour: 8",
    "staleMinutes: 60",
    "watchCapPerDay: 2",
    "modelWakesPerDay: 15",
    "ceilingTokensPerDay: 0",
    "briefTimes: 08:30,14:00",
    "insightTimes: ",
    "urgentSenders: wife",
    "excludedSources: ",
    "wakes today: 2",
    "model wakes today: 0",
  ]);
});

test("show with a broken state prints the settings, then fails naming the file (the tick is stopped by it)", async (t) => {
  const h = harness(t);
  writeFileSync(join(h.dir, "proactive.json"), "nope");
  await assert.rejects(
    h.cmd(["show"]),
    /proactive\.json unreadable or damaged.*the tick exits 1 until it is fixed or removed/su,
  );
  assert.equal(h.out[0], "enabled: true");
  assert.ok(!h.out.some((line) => line.startsWith("wakes today")));
});
