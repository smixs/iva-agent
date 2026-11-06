/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registrations. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "eve/tools";
import fc from "fast-check";
import { z } from "zod";
const dir = mkdtempSync(join(tmpdir(), "iva-schedule-tool-"));
process.env.ASSISTANT_DATA_DIR = dir;
process.env.ASSISTANT_TIMEZONE = "Asia/Tashkent";
process.env.TELEGRAM_DIGEST_CHAT_ID = "123";
const { default: schedule } = await import("../agent/tools/schedule.ts");
const { commandFile, list, fireDue, recordDelivery } =
  await import("../agent/lib/reminder-store.ts");
const ctx = {} as ToolContext;
const view = z.object({
  id: z.string(),
  text: z.string(),
  next_run_at: z.string(),
});
const answer = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  reminder: view.optional(),
  schedule: view.optional(),
  next_run_at: z.string().optional(),
  schedules: z.array(z.object({ action_kind: z.string() })).optional(),
});
const call = async (input: Parameters<typeof schedule.execute>[0]) =>
  answer.parse(await schedule.execute(input, ctx));
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});
test("prompt uses the old rows, move preserves id and payload, list includes both kinds", async () => {
  const added = await call({
    action: "add",
    text: "find the news",
    at: "in 30m",
  });
  assert.equal(added.ok, true);
  assert.ok(added.reminder);
  const moved = await call({
    action: "move",
    id: added.reminder.id,
    at: "in 1h",
  });
  assert.ok(moved.schedule);
  assert.equal(moved.schedule.id, added.reminder.id);
  assert.equal(moved.schedule.text, "find the news");
  const command = await call({
    action: "add",
    command: "printf done",
    cron: "0 6 * * *",
  });
  assert.equal(command.ok, true);
  assert.ok(command.schedule && command.next_run_at);
  assert.match(command.next_run_at, /06:00/);
  const rows = (await call({ action: "list" })).schedules;
  assert.ok(rows);
  assert.deepEqual(
    rows.map((row: { action_kind: string }) => row.action_kind),
    ["prompt", "command"],
  );
  await call({ action: "run_now", id: command.schedule.id });
  assert.equal((await list(commandFile()))[0]?.schedule.kind, "cron");
  const removed = await call({ action: "remove", id: command.schedule.id });
  assert.equal(removed.ok, true);
  assert.equal((await list(commandFile())).length, 0);
});
test("invalid input returns a textual error and leaves the table untouched", async () => {
  for (const input of [
    { action: "add", command: "echo x", text: "both", at: "in 5m" },
    { action: "add", command: "echo x", at: "bad" },
    { action: "move", id: "missing", at: "in 30m" },
    { action: "run_now" },
  ] as const) {
    const result = await call(input);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
  }
  assert.equal((await list()).length, 0);
  assert.equal((await list(commandFile())).length, 0);
});
test("time and daily cron resolve in the owner zone with a replayable seed", async (t) => {
  const now = Date.UTC(2026, 9, 19, 0, 0);
  t.mock.timers.enable({ apis: ["Date"], now });
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 23 }),
      fc.integer({ min: 0, max: 59 }),
      async (hour, minute) => {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const at = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        const command = await call({
          action: "add",
          command: "true",
          cron: `${minute} ${hour} * * *`,
        });
        const prompt = await call({ action: "add", text: "test", at });
        assert.equal(command.ok, true);
        assert.ok(command.schedule && command.next_run_at);
        assert.equal(prompt.ok, true);
        assert.ok(prompt.reminder);
        assert.equal(command.next_run_at, prompt.reminder.next_run_at);
        const local = new Date(`${command.next_run_at.replace(" ", "T")}`);
        assert.ok(Number.isFinite(local.getTime()));
      },
    ),
    { seed: 20261019, numRuns: 30 },
  );
});
test("scheduling skill explains all actions within forty lines", () => {
  const text = readFileSync("agent/skills/scheduling/SKILL.md", "utf8");
  assert.ok(text.trimEnd().split("\n").length <= 40);
  for (const action of ["add", "move", "remove", "list", "run_now"])
    assert.match(text, new RegExp(action));
});

for (const action of ["run_now", "move"] as const)
  for (const recurring of [true, false])
    test(`running text keeps its first fact during ${action}, recurring=${recurring}`, async (t) => {
      const now = Date.UTC(2026, 9, 19, 3);
      t.mock.timers.enable({ apis: ["Date"], now });
      const added = await call({
        action: "add",
        text: "report",
        ...(recurring ? { cron: "0 9 * * *" } : { at: "in 1h" }),
      });
      assert.ok(added.reminder);
      const id = added.reminder.id;
      await call({ action: "run_now", id });
      assert.equal((await fireDue(now, 5)).length, 1);
      const result = await schedule.execute(
        { action, id, ...(action === "move" ? { at: "in 1m" } : {}) },
        ctx,
      );
      assert.deepEqual(await fireDue(now + 60_000, 5), []);
      assert.equal((await list())[0].firedAt, now);
      await recordDelivery(id, { firedAt: now, delivered: true, error: null });
      assert.equal((await list())[0].delivered, true);
      const response = z
        .object({
          ok: z.literal(true),
          message: z.string(),
          schedule: z.object({ last_status: z.literal("running") }),
        })
        .parse(result);
      assert.match(
        response.message,
        /задача сейчас выполняется.*перенос применится после/iu,
      );
      assert.equal((await fireDue(now + 60_000, 5)).length, 1);
    });

test("command timeouts survive add/move/list and invalid values return text (seed 20261020)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 60 }), async (minutes) => {
      const added = await call({
        action: "add",
        command: "true",
        at: "in 1m",
        timeout_minutes: minutes,
      });
      assert.equal(added.ok, true);
      assert.equal(
        (await list(commandFile())).find((r) => r.id === added.schedule?.id)
          ?.timeout_minutes,
        minutes,
      );
      const id = added.schedule!.id;
      await call({ action: "move", id, at: "in 2m", timeout_minutes: 20 });
      const result = await schedule.execute({ action: "list" }, ctx);
      assert.equal(
        z
          .object({
            schedules: z.array(
              z.object({
                id: z.string(),
                timeout_minutes: z.number().optional(),
              }),
            ),
          })
          .parse(result)
          .schedules.find((r) => r.id === id)?.timeout_minutes,
        20,
      );
      await call({ action: "remove", id });
    }),
    { seed: 20261020, numRuns: 20 },
  );
  for (const timeout_minutes of [0, 61, 1.5, NaN, Infinity]) {
    const result = await call({
      action: "add",
      command: "true",
      at: "in 1m",
      timeout_minutes,
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /timeout_minutes/);
  }
  assert.equal(
    (
      await call({
        action: "add",
        text: "prompt",
        at: "in 1m",
        timeout_minutes: 20,
      })
    ).ok,
    false,
  );
  assert.equal((await list(commandFile())).length, 0);
});
