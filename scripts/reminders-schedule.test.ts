/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
// Диспетчер напоминаний как eve-расписание: тик уходит в waitUntil, cron берётся из
// таблицы. Тест живёт в scripts/, а не рядом с расписанием: eve собирает authored tree по
// файлам в agent/schedules/, и лишний тест там стал бы седьмым расписанием
// (scripts/eve-schedules-guard.test.ts).
import "./lib/ts-esm-hooks.ts"; // agent/** импортирует соседей как "./x.js" — см. сам хук
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "iva-reminders-schedule-"));
process.env.ASSISTANT_DATA_DIR = DATA;
mkdirSync(DATA, { recursive: true });

type Schedule = {
  cron: string;
  run: (context: { waitUntil: (work: Promise<unknown>) => void }) => void;
};

const loaded: unknown = await import(
  new URL("../agent/schedules/reminders.ts", import.meta.url).href
);
if (typeof loaded !== "object" || loaded === null || !("default" in loaded))
  throw new Error("the reminders schedule has no default export");
const schedule = loaded.default as Schedule;

const { REMINDER_TICK_CRON } = await import("../agent/lib/schedule-table.ts");
const { readTickPulse } = await import("../agent/lib/reminder-tick.ts");

after(() => rmSync(DATA, { recursive: true, force: true }));

test("the reminders dispatcher ticks every second through waitUntil", async () => {
  assert.equal(schedule.cron, REMINDER_TICK_CRON);

  const started: Promise<unknown>[] = [];
  schedule.run({ waitUntil: (work) => started.push(work) });

  assert.equal(started.length, 1, "the tick is handed to waitUntil");
  const result = await started[0];
  // Таблицы в свежем каталоге нет: тик ничего не забирает, но пульс о себе пишет.
  assert.ok(Array.isArray(result));
  assert.deepEqual(result, [
    {
      status: "fulfilled",
      value: { claimed: 0, spawned: 0, filled: 0, swept: 0 },
    },
  ]);
  assert.notEqual(readTickPulse(), null);
});

test("ReminderLifecycle OncePerDue: reminder admission remains available within and across minutes", async (t) => {
  let now = Date.UTC(2026, 10, 10, 23, 18, 0);
  t.mock.method(Date, "now", () => now);
  const run = async () => {
    const work: Promise<unknown>[] = [];
    schedule.run({ waitUntil: (task) => work.push(task) });
    assert.equal(work.length, 1);
    const result = await work[0];
    assert.ok(Array.isArray(result));
    return result.length;
  };
  assert.equal(await run(), 1);
  now += 1_000;
  assert.equal(await run(), 1, "only reminder admission on a second tick");
  now += 59_000;
  assert.equal(await run(), 1, "reminder admission on the next minute");
});
