/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import fc from "fast-check";

import { localStamp } from "#lib/vault-daily.ts";
import { resolveTimeZone as resolveAuthoredTimeZone } from "@iva/timezone";
import { resolveTimeZone as resolveOperationalTimeZone } from "../packages/timezone/index.ts";

const ROOT = process.cwd();

function assertValidTimeZone(timeZone: string): void {
  assert.doesNotThrow(() =>
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0)),
  );
}

test("R1: valid, empty, and invalid timezone settings resolve identically", () => {
  for (const [input, expected] of [
    [" Asia/Tashkent ", "Asia/Tashkent"],
    ["", "UTC"],
    ["Mars/Olympus", "UTC"],
    // Канон, а не ввод: `europe/moscow` в `OnCalendar=` не поднимает таймер systemd.
    ["europe/moscow", "Europe/Moscow"],
  ] as const) {
    assert.equal(resolveAuthoredTimeZone(input), expected);
    assert.equal(resolveOperationalTimeZone(input), expected);
  }
});

test("R1 PBT: arbitrary strings always resolve to a valid timezone", () => {
  fc.assert(
    fc.property(fc.string(), (input) => {
      const authored = resolveAuthoredTimeZone(input);
      const operational = resolveOperationalTimeZone(input);
      assert.equal(authored, operational);
      assertValidTimeZone(authored);
    }),
    { seed: 18801, numRuns: 1_000 },
  );
});

test("R1: an invalid setting cannot crash an authored Intl consumer", (t) => {
  const previous = process.env.ASSISTANT_TIMEZONE;
  process.env.ASSISTANT_TIMEZONE = "Mars/Olympus";
  t.after(() => {
    if (previous === undefined) delete process.env.ASSISTANT_TIMEZONE;
    else process.env.ASSISTANT_TIMEZONE = previous;
  });

  assert.match(localStamp().date, /^\d{4}-\d{2}-\d{2}$/u);
});

test("R1: server startup canonicalizes timezone for every child", () => {
  const instrumentation = pathToFileURL(
    join(ROOT, "agent/instrumentation.ts"),
  ).href;
  const eveHealth = pathToFileURL(join(ROOT, "agent/lib/eve-health.ts")).href;
  const program = [
    `const { PROBE_FLAG } = await import(${JSON.stringify(eveHealth)});`,
    `const instrumentation = (await import(${JSON.stringify(instrumentation)})).default;`,
    `process.env[PROBE_FLAG] = "1";`,
    `const logs = [];`,
    `console.log = (...args) => logs.push(args.map(String).join(" "));`,
    `instrumentation.setup?.();`,
    `process.stdout.write(JSON.stringify({ assistant: process.env.ASSISTANT_TIMEZONE, tz: process.env.TZ, logs }));`,
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", program],
    {
      cwd: ROOT,
      env: { ...process.env, ASSISTANT_TIMEZONE: "Mars/Olympus" },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout) as {
    assistant: string;
    tz: string;
    logs: string[];
  };
  assert.equal(result.assistant, "UTC");
  assert.equal(result.tz, "UTC");
  assert.equal(
    result.logs.filter((line) => /invalid timezone/u.test(line)).length,
    1,
  );
});

test("R1: the dynamic time instruction reports UTC for invalid input", () => {
  const moduleUrl = pathToFileURL(join(ROOT, "agent/instructions/now.ts")).href;
  const program = [
    `const instruction = (await import(${JSON.stringify(moduleUrl)})).default;`,
    `const result = instruction.events["turn.started"]();`,
    `process.stdout.write(result.content);`,
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", program],
    {
      cwd: ROOT,
      env: { ...process.env, ASSISTANT_TIMEZONE: "Mars/Olympus" },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /UTC/u);
  assert.doesNotMatch(child.stdout, /Mars\/Olympus/u);
});

test("R1: operational and authored consumers share the invalid-value fallback", () => {
  assert.equal(resolveAuthoredTimeZone("Mars/Olympus"), "UTC");
  assert.equal(resolveOperationalTimeZone("Mars/Olympus"), "UTC");
});

test("R1: every TypeScript time consumer calls the shared resolver", () => {
  assert.equal(resolveAuthoredTimeZone("Mars/Olympus"), "UTC");
  assert.equal(resolveOperationalTimeZone("Mars/Olympus"), "UTC");
  assertValidTimeZone(resolveOperationalTimeZone("Mars/Olympus"));
  const consumers = [
    "agent/instrumentation.ts",
    "agent/instructions/now.ts",
    "agent/lib/vault-daily.ts",
    "scripts/memory/night.ts",
    "scripts/lib/usage.ts",
    "scripts/cli/systemd.ts",
  ];

  for (const file of consumers) {
    const source = readFileSync(join(ROOT, file), "utf8");
    assert.match(source, /resolveTimeZone/u, `${file} bypasses the resolver`);
  }
});
