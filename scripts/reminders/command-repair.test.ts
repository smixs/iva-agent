/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registrations. */
import "../lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runCommand, runCommandFire } from "./command.ts";
import {
  add,
  list,
  fireDue,
  commandFile,
  commandLog,
  reschedule,
  recordDelivery,
  remove,
} from "../../agent/lib/reminder-store.ts";
import { runReminderTick } from "../../agent/lib/reminder-tick.ts";
import { recordAlert } from "../lib/notice-policy.ts";
import schedule from "../../agent/tools/schedule.ts";
import type { ToolContext } from "eve/tools";
const dir = mkdtempSync(join(tmpdir(), "iva-r328-"));
process.env.ASSISTANT_DATA_DIR = dir;
process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
const now = Date.now();
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});
async function ready(command: string) {
  await add(
    { id: "c-probe", text: command, schedule: { kind: "at", atMs: now } },
    { file: commandFile() },
  );
  await fireDue(now, 5, commandFile());
}
test("R1 escaped descendant holding stdout cannot hold the timeout fact or Alert", async () => {
  const pidFile = join(dir, "escaped.pid");
  await ready(
    `perl -MPOSIX -e 'POSIX::setsid(); exec sleep 30' & echo $! > '${pidFile}'; echo started`,
  );
  const sent: string[] = [];
  const work = runCommandFire("c-probe", {
    root: dir,
    timeoutMs: 500,
    send: (_bot, _chat, text) => {
      sent.push(String(text));
      return Promise.resolve({ ok: true, fellBack: false, error: "" });
    },
  });
  const result = await Promise.race([work, delay(1500, "held")]);
  try {
    assert.notEqual(result, "held");
    assert.equal((await list(commandFile()))[0]?.delivered, false);
    assert.match((await list(commandFile()))[0]?.error ?? "", /timeout/);
    assert.equal(sent.length, 1);
  } finally {
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      }
    }
    await work;
  }
});
test("R1 the command child has a finite parent deadline", async () => {
  await ready("true");
  await reschedule("c-probe", { nowMs: now }, commandFile());
  await recordDelivery(
    "c-probe",
    { firedAt: now, delivered: true, error: null },
    { file: commandFile() },
  );
  let timeout: number | null | undefined;
  await runReminderTick({
    nowMs: now + 1,
    command: true,
    runJob: (o) => {
      timeout = o.timeoutMs;
      return Promise.resolve({ ok: false, skipped: false, code: 1 });
    },
    log: () => {},
  });
  assert.equal(typeof timeout, "number");
  assert.ok((timeout ?? 0) > 0 && (timeout ?? Infinity) <= 140000);
});
test("R2 command environment carries the bash turn marker", async () => {
  const result = await runCommand('printf %s "$IVA_AGENT_TURN"', dir, 500);
  assert.equal(result.output, "1");
});
test("R3 run_now/move and recurring ticks preserve the in-flight command fact", async () => {
  await add(
    {
      id: "c-probe",
      text: "true",
      schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      nextRunAtMs: now,
    },
    { file: commandFile() },
  );
  await fireDue(now, 5, commandFile());
  const running = (await list(commandFile()))[0];
  assert.equal(running.delivered, null);
  const visible = (await schedule.execute(
    { action: "list" },
    {} as ToolContext,
  )) as { schedules: { id: string; last_status: string }[] };
  assert.equal(
    visible.schedules.find((candidate) => candidate.id === "c-probe")
      ?.last_status,
    "running",
  );
  assert.equal(
    (await fireDue(running.nextRunAtMs, 5, commandFile())).length,
    0,
  );
  for (const change of [
    { nowMs: now + 60000 },
    { nowMs: now + 60000, schedule: { kind: "at", atMs: now + 60000 } },
  ]) {
    await reschedule("c-probe", change, commandFile());
    assert.equal((await fireDue(now + 60000, 5, commandFile())).length, 0);
    assert.equal((await list(commandFile()))[0]?.firedAt, now);
  }
  await recordDelivery(
    "c-probe",
    { firedAt: now, delivered: true, error: null },
    { file: commandFile() },
  );
  assert.equal((await list(commandFile()))[0]?.delivered, true);
  assert.equal((await fireDue(now + 60000, 5, commandFile())).length, 1);
});
test("R5 failure uses the notice Gate and a human name and reason", async () => {
  const secret = "sk-ant-api03-r328-secret-for-outbound-gate"; // qg:allow Synthetic outbound Gate fixture, never a credential.
  process.env.ANTHROPIC_API_KEY = secret;
  try {
    await ready(`false # ${secret}`);
    const sent: string[] = [];
    await runCommandFire("c-probe", {
      root: dir,
      send: (_bot, _chat, text) => {
        sent.push(String(text));
        return Promise.resolve({ ok: true, fellBack: false, error: "" });
      },
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Задача «false/);
    assert.match(sent[0], /завершилась с ошибкой/);
    assert.match(sent[0], /Журнал: list/);
    assert.ok(!sent[0].includes(secret));
    assert.doesNotMatch(sent[0], /exit \d/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});
test("R6 remove clears the schedule Alert and journal", async () => {
  await ready("true");
  recordAlert(dir, "schedule-c-probe", "exit 3");
  recordAlert(dir, "other-problem", "keep");
  writeFileSync(commandLog("c-probe"), "old");
  await schedule.execute(
    { action: "remove", id: "c-probe" },
    {} as ToolContext,
  );
  const state: unknown = JSON.parse(
    readFileSync(join(dir, "alert-state.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(state as object, "schedule-c-probe"), false);
  assert.equal(Object.hasOwn(state as object, "other-problem"), true);
  assert.equal(existsSync(commandLog("c-probe")), false);
});
test("R6 deleting a running row prevents late journal and Alert state recreation", async () => {
  const started = join(dir, "started");
  const finish = join(dir, "finish");
  await ready(
    `touch '${started}'; while [ ! -f '${finish}' ]; do sleep 0.02; done; exit 3`,
  );
  const work = runCommandFire("c-probe", {
    root: dir,
    timeoutMs: 1000,
    send: () => Promise.resolve({ ok: true, fellBack: false, error: "" }),
  });
  while (!existsSync(started)) await delay(5);
  await remove("c-probe", commandFile());
  writeFileSync(finish, "go");
  const result = await Promise.allSettled([work]);
  assert.equal(existsSync(commandLog("c-probe")), false);
  assert.equal(result[0].status, "fulfilled");
});
test("R6 an Alert finishing after remove cannot restore its key", async () => {
  await ready("exit 3");
  let acknowledge!: () => void;
  let sending!: () => void;
  const entered = new Promise<void>((resolve) => {
    sending = resolve;
  });
  const receipt = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const work = runCommandFire("c-probe", {
    root: dir,
    send: async () => {
      sending();
      await receipt;
      return { ok: true, fellBack: false, error: "" };
    },
  });
  await entered;
  await schedule.execute(
    { action: "remove", id: "c-probe" },
    {} as ToolContext,
  );
  acknowledge();
  await work;
  assert.equal(existsSync(commandLog("c-probe")), false);
  const state: unknown = JSON.parse(
    readFileSync(join(dir, "alert-state.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(state as object, "schedule-c-probe"), false);
});

test("R3 a command can recur every minute while prompt frequency stays bounded", async () => {
  const command = await schedule.execute(
    { action: "add", command: "true", cron: "* * * * *" },
    {} as ToolContext,
  );
  assert.equal((command as { ok: boolean }).ok, true);
  const prompt = await schedule.execute(
    { action: "add", text: "repeat", cron: "* * * * *" },
    {} as ToolContext,
  );
  assert.equal((prompt as { ok: boolean }).ok, false);
});
test("R1 the parent distinguishes deadline expiry from an early signal", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  for (const elapsed of [0, 130000]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await add(
      { id: "c-probe", text: "true", schedule: { kind: "at", atMs: now } },
      { file: commandFile() },
    );
    t.mock.timers.setTime(now + elapsed);
    await runReminderTick({
      nowMs: now,
      command: true,
      runJob: () =>
        Promise.resolve({
          ok: false,
          skipped: false,
          code: null,
          signal: "SIGKILL",
        }),
      log: () => {},
    });
    const error = (await list(commandFile()))[0].error;
    assert.equal(
      error,
      elapsed === 0 ? "fire process killed by SIGKILL" : "timeout",
    );
  }
});
test("R1 delayed child consumes the remaining claim deadline before starting a shell", async (t) => {
  await ready(`touch '${join(dir, "too-late")}'`);
  t.mock.timers.enable({ apis: ["Date"], now: now + 120001 });
  let notices = 0;
  await runCommandFire("c-probe", {
    root: dir,
    firedAt: now,
    send: () => {
      notices++;
      return Promise.resolve({ ok: true, fellBack: false, error: "" });
    },
  });
  assert.equal(existsSync(join(dir, "too-late")), false);
  assert.equal((await list(commandFile()))[0].error, "timeout");
  assert.equal(notices, 1);
});
