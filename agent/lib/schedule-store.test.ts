/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registrations. */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
const dir = mkdtempSync(join(tmpdir(), "iva-schedule-store-"));
process.env.ASSISTANT_DATA_DIR = dir;
const store = await import("./reminder-store.ts");
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
test("move preserves identity and payload; concurrent ticks claim run_now once per request", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 1000000 }), async (time) => {
      rmSync(dir, { recursive: true, force: true });
      const row = await store.add({
        id: "r-test",
        text: "instruction",
        schedule: { kind: "at", atMs: time },
      });
      const moved = await store.reschedule(row.id, {
        schedule: { kind: "at", atMs: time + 100 },
        nowMs: time,
      });
      assert.equal(moved.id, row.id);
      assert.equal(moved.text, row.text);
      assert.equal(moved.nextRunAtMs, time + 100);
      await store.reschedule(row.id, { nowMs: time });
      const claims = await Promise.all([
        store.fireDue(time, 5),
        store.fireDue(time, 5),
      ]);
      assert.equal(claims.flat().length, 1);
      assert.equal((await store.fireDue(time + 1, 5)).length, 0);
    }),
    { seed: 20261019, numRuns: 30 },
  );
});
test("dispatchOnly releases the minute task while observing an unfinished child", async () => {
  const { runReminderTick } = await import("./reminder-tick.ts");
  await store.add({
    id: "r-slow",
    text: "instruction",
    schedule: { kind: "at", atMs: 1 },
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let recorded!: () => void;
  const recordedFact = new Promise<void>((resolve) => {
    recorded = resolve;
  });
  const tick = await runReminderTick({
    nowMs: 2,
    dispatchOnly: true,
    runJob: async () => {
      await finished;
      await store.recordDelivery("r-slow", {
        firedAt: 2,
        delivered: true,
        error: null,
      });
      recorded();
      return { ok: true, skipped: false, code: 0, signal: null };
    },
    log: () => {},
  });
  assert.equal(tick.claimed, 1);
  assert.equal((await store.fireDue(3, 5)).length, 0);
  finish();
  await recordedFact;
});

test("run_now consumes one tick and preserves the recurring schedule", async () => {
  const now = Date.UTC(2026, 9, 19, 6);
  await store.add({
    id: "r-cron",
    text: "repeat",
    schedule: { kind: "cron", expr: "0 6 * * *", tz: "Asia/Tashkent" },
    nextRunAtMs: now + 86400000,
  });
  await store.reschedule("r-cron", { nowMs: now });
  const claims = await Promise.all([
    store.fireDue(now, 5),
    store.fireDue(now, 5),
  ]);
  assert.equal(claims.flat().length, 1);
  const row = (await store.list())[0];
  assert.equal(row.schedule.kind, "cron");
  assert.ok(row.nextRunAtMs > now);
  assert.equal((await store.fireDue(now + 1, 5)).length, 0);
});
test("R3 seeded moves keep a single live command until its fact arrives or deadline expires", async () => {
  const now = Date.now();
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 120000 }), {
        minLength: 1,
        maxLength: 8,
      }),
      async (times) => {
        rmSync(dir, { recursive: true, force: true });
        await store.add(
          {
            id: "c-live",
            text: "true",
            schedule: { kind: "cron", expr: "*/10 * * * *", tz: "UTC" },
            nextRunAtMs: now,
          },
          { file: store.commandFile() },
        );
        await store.fireDue(now, 5, store.commandFile());
        for (const offset of times) {
          await store.reschedule(
            "c-live",
            { nowMs: now + offset },
            store.commandFile(),
          );
          const claims = await Promise.all([
            store.fireDue(now + offset, 5, store.commandFile()),
            store.fireDue(now + offset, 5, store.commandFile()),
          ]);
          assert.equal(claims.flat().length, 0);
          assert.equal((await store.list(store.commandFile()))[0].firedAt, now);
        }
        await store.recordDelivery(
          "c-live",
          { firedAt: now, delivered: false, error: "timeout" },
          { file: store.commandFile() },
        );
        assert.equal(
          (await store.list(store.commandFile()))[0].error,
          "timeout",
        );
        assert.equal(
          (await store.fireDue(now + 120001, 5, store.commandFile())).length,
          1,
        );
      },
    ),
    { seed: 20261019, numRuns: 20 },
  );
});

test("text claim expires at the existing run-status stale boundary", async () => {
  const { RUN_STALE_MS } = await import("./run-status.ts");
  const now = Date.now();
  await store.add({
    id: "r-expire",
    text: "report",
    schedule: { kind: "at", atMs: now },
  });
  await store.fireDue(now, 5);
  await store.reschedule("r-expire", { nowMs: now });
  assert.deepEqual(await store.fireDue(now + RUN_STALE_MS - 1, 5), []);
  assert.equal((await store.fireDue(now + RUN_STALE_MS, 5)).length, 1);
});

test("a live text session pulse extends overlap protection beyond its initial stale boundary", async (t) => {
  const { RUN_STALE_MS, setChatStatus } = await import("./run-status.ts");
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  await store.add({
    id: "r-long",
    text: "report",
    schedule: { kind: "at", atMs: now },
  });
  await store.fireDue(now, 5);
  await store.recordTurnSession("r-long", {
    firedAt: now,
    sessionId: "live-text",
  });
  await store.reschedule("r-long", { nowMs: now });
  t.mock.timers.setTime(now + RUN_STALE_MS - 1);
  setChatStatus("123:", { status: "running", sessionId: "live-text" });
  assert.deepEqual(await store.fireDue(now + RUN_STALE_MS + 1, 5), []);
  assert.equal((await store.list())[0].firedAt, now);
  assert.equal((await store.fireDue(now + 2 * RUN_STALE_MS - 1, 5)).length, 1);
});

test("a recurring text waits for its first delivery before admitting an overdue interval", async () => {
  const now = Date.UTC(2026, 9, 19, 3);
  await store.add({
    id: "r-interval",
    text: "report",
    schedule: { kind: "cron", expr: "*/10 * * * *", tz: "UTC" },
    nextRunAtMs: now,
  });
  const [first] = await store.fireDue(now, 5);
  assert.equal(first.nextRunAtMs, now + 600_000);
  assert.deepEqual(await store.fireDue(first.nextRunAtMs, 5), []);
  const fact = await store.recordDelivery(first.id, {
    firedAt: now,
    delivered: true,
    error: null,
  });
  assert.equal(fact.firedAt, now);
  assert.equal(fact.delivered, true);
  assert.equal((await store.fireDue(first.nextRunAtMs, 5)).length, 1);
});
