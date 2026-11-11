/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node owns registrations; doubles preserve asynchronous boundaries. */
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import type { Session } from "eve/channels";
import type { ToolContext } from "eve/tools";
import fc from "fast-check";
import { Cron } from "croner";
import "../lib/ts-esm-hooks.ts";
import { tempDir } from "../fixtures/temp-dir.ts";
import { runReminderFire, type ReminderFireDependencies } from "./fire.ts";
import { runReminderTurn, type ReminderClient } from "../lib/reminder-turn.ts";
import {
  add,
  list,
  fireDue,
  reminderFile,
  reminderContentFile,
  reminderContent,
  readReminderContents,
  remove,
  sweepFired,
  recordDelivery,
  parseReminderTable,
  REMINDER_SCHEMA_VERSION,
} from "#lib/reminder-store.ts";
import { requestTurnCancel } from "#lib/telegram-stop.ts";
import { REMINDER_TICK_CRON } from "#lib/schedule-table.ts";
import { runReminderTick } from "#lib/reminder-tick.ts";
import { chatKeyOf, getChatStatus } from "#lib/run-status.ts";
import { handleTelegramResetRequest } from "#lib/telegram-reset-route.ts";
import { resetTargetForControl } from "../lib/telegram-reset.ts";
import remind from "../../agent/tools/remind.ts";

const NOW = Date.UTC(2026, 10, 10, 23, 18, 8);
const TEXT = "позвонить в клинику";
const env = {
  TELEGRAM_BOT_TOKEN: "fixture",
  TELEGRAM_DIGEST_CHAT_ID: "555",
  ASSISTANT_BEARER: "fixture",
};
beforeEach(() => {
  process.env.ASSISTANT_DATA_DIR = tempDir("iva-reminder-precision-");
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function delivery(sends: string[], ok = true): ReminderFireDependencies {
  return {
    env,
    chat: () => "555",
    translator: async () => (_en, ru) => ru,
    log: () => {},
    send: async (_bot, _chat, text) => {
      sends.push(String(text));
      return { ok, error: ok ? "" : "403 forbidden", fellBack: false };
    },
  };
}
async function accepted(content?: "text" | "task") {
  await add({
    id: "r-f1",
    text: TEXT,
    chat: { id: "555", threadId: null },
    ...(content === undefined ? {} : { content }),
    schedule: { kind: "at", atMs: NOW },
  });
  assert.equal((await fireDue(NOW, 5)).length, 1);
}

for (const address of [false, true])
  for (const transport of [true, false]) {
    test(`ReminderLifecycle ResetRetainsDelivery: /new (${address ? "address" : "session"}), transport=${transport}`, async (t) => {
      t.mock.method(globalThis, "fetch", async () => {
        throw new Error("NETWORK FORBIDDEN");
      });
      await accepted();
      const gate = deferred();
      const ready = deferred();
      t.after(() => gate.resolve());
      const sessionId = "f1-reminder-session";
      const reasons: string[] = [];
      const session = {
        id: sessionId,
        send: async () => {},
        cancel: async () => {},
        reset: async ({ reason }: { reason: string }) => {
          reasons.push(reason);
          gate.resolve();
          return { status: "reset" };
        },
      };
      const response = Object.assign(
        (async function* () {
          ready.resolve();
          await gate.promise;
          yield { type: "turn.cancelled" };
          yield { type: "session.waiting" };
        })(),
        { sessionId, cancel: async () => {} },
      ) as Awaited<
        ReturnType<ReminderClient["sessions"]["create"]>
      >["response"];
      const sends: string[] = [];
      let turns = 0;
      const firing = runReminderFire("r-f1", {
        ...delivery(sends, transport),
        runTurn: (prompt, options, deps) => {
          turns++;
          return runReminderTurn(prompt, options, {
            ...deps,
            createClient: async () => ({
              sessions: { create: async () => ({ session, response }) },
            }),
          });
        },
      });
      await ready.promise;
      const key = chatKeyOf("555", null);
      assert.equal(getChatStatus(key)?.sessionId, sessionId);
      const selected = resetTargetForControl(
        { message: { chat: { id: 555, type: "private" }, message_id: 2 } },
        getChatStatus(key),
      );
      assert.equal(selected?.sessionId, sessionId);
      const target = address ? { address: { chatId: "555" } } : selected;
      const result = await handleTelegramResetRequest(
        new Request("http://fixture/reset", {
          method: "POST",
          headers: { "X-Telegram-Bot-Api-Secret-Token": "fixture" },
          body: JSON.stringify(target),
        }),
        {
          attachSession: () => session as unknown as Session,
          resolveSession: async () => session as unknown as Session,
        },
        "fixture",
      );
      assert.equal(result.status, 200);
      assert.equal(await firing, 0);
      assert.equal(turns, 1);
      assert.equal(
        sends.length,
        1,
        "ResetRetainsDelivery: reset must preserve the original text",
      );
      assert.equal(sends[0], `${TEXT}\n\nВыполнение прервал сброс разговора.`);
      const [row] = await list();
      assert.equal(
        row?.delivered,
        transport,
        "delivery fact is the transport answer",
      );
      assert.match(row?.error ?? "", /conversation reset/);
      if (!transport) assert.match(row?.error ?? "", /403 forbidden/);
      assert.equal(reasons[0], "Telegram recovery command");
    });
  }

test("ReminderLifecycle ResetRetainsDelivery: explicit /stop still sends nothing", async () => {
  await accepted("task");
  const sends: string[] = [];
  assert.equal(
    await runReminderFire("r-f1", {
      ...delivery(sends),
      runTurn: async () => ({
        status: "waiting",
        cancelled: true,
        feedback: async () => {},
      }),
    }),
    0,
  );
  assert.deepEqual(sends, []);
  assert.equal((await list())[0]?.delivered, false);
  assert.equal((await list())[0]?.error, "cancelled by owner");
});

test("ReminderLifecycle ResetRetainsDelivery: an explicit /stop wins after a reset request fails", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("NETWORK FORBIDDEN");
  });
  await accepted("task");
  const gate = deferred();
  const ready = deferred();
  t.after(() => gate.resolve());
  const sessionId = "reset-failed-then-stop";
  const session = {
    id: sessionId,
    send: async () => {},
    cancel: async () => {},
    reset: async ({ reason }: { reason: string }) => {
      if (reason === "Telegram recovery command")
        throw new Error("reset refused");
      return { status: "reset" };
    },
  };
  const response = Object.assign(
    (async function* () {
      ready.resolve();
      await gate.promise;
      yield { type: "turn.cancelled" };
      yield { type: "session.waiting" };
    })(),
    { sessionId, cancel: async () => {} },
  ) as Awaited<ReturnType<ReminderClient["sessions"]["create"]>>["response"];
  const sends: string[] = [];
  const firing = runReminderFire("r-f1", {
    ...delivery(sends),
    runTurn: (prompt, options, deps) =>
      runReminderTurn(prompt, options, {
        ...deps,
        createClient: async () => ({
          sessions: { create: async () => ({ session, response }) },
        }),
      }),
  });
  await ready.promise;
  await assert.rejects(
    handleTelegramResetRequest(
      new Request("http://fixture/reset", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "fixture" },
        body: JSON.stringify({ sessionId }),
      }),
      {
        attachSession: () => session as unknown as Session,
        resolveSession: async () => undefined,
      },
      "fixture",
    ),
    /reset refused/,
  );
  assert.equal(
    await requestTurnCancel(chatKeyOf("555", null), {
      url: "http://fixture/cancel",
      secret: "fixture",
      cancelImpl: async () => {
        gate.resolve();
        return { status: "cancelled" };
      },
    }),
    "requested",
  );
  assert.equal(await firing, 0);
  assert.deepEqual(sends, []);
  assert.equal((await list())[0]?.error, "cancelled by owner");
});

test("ReminderLifecycle TextNeverRunsTurn and OneAttemptPerCapture: direct text, exactly one send", async () => {
  await accepted("text");
  const sends: string[] = [];
  await runReminderFire("r-f1", {
    ...delivery(sends),
    runTurn: async () => {
      assert.fail("TextNeverRunsTurn");
    },
  });
  assert.deepEqual(sends, [TEXT]);
  assert.equal((await list())[0]?.delivered, true);
  assert.deepEqual(await fireDue(NOW + 60_000, 5), []);
});

test("ReminderLifecycle NoMinuteDelay exact-second admission: 23:18:08 reaches delivery within 5s, including a row added after the minute tick", async (t) => {
  const now = t.mock.method(Date, "now", () => NOW - 1_000);
  const cron = new Cron(REMINDER_TICK_CRON, { paused: true });
  t.after(() => cron.stop());
  const next = cron.nextRun(new Date(NOW - 1));
  assert.ok(next);
  assert.ok(
    next.getTime() >= NOW && next.getTime() <= NOW + 5_000,
    `next dispatcher: ${next.toISOString()}`,
  );
  await add({
    id: "r-f1",
    text: TEXT,
    content: "text",
    chat: { id: "555", threadId: null },
    schedule: { kind: "at", atMs: NOW },
  });
  now.mock.mockImplementation(() => next.getTime());
  const sends: string[] = [];
  let started = 0;
  const result = await runReminderTick({
    nowMs: next.getTime(),
    runJob: async () => {
      started = Date.now();
      await runReminderFire("r-f1", {
        ...delivery(sends),
        runTurn: async () => {
          assert.fail("TextNeverRunsTurn");
        },
      });
      return { ok: true, skipped: false };
    },
  });
  assert.equal(result.claimed, 1);
  assert.ok(started - NOW <= 5_000);
  assert.deepEqual(sends, [TEXT]);
});

const SEED = 11112026;
test(`ReminderLifecycle legacy content: schema-2 rows from 0.5.0–0.5.12 remain tasks (seed ${SEED})`, async () => {
  // All these releases wrote schema 2; chat and sessionId appeared as optional fields.
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        text: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        atMs: fc.integer({ min: 0, max: 2_000_000_000_000 }),
        chat: fc.boolean(),
        session: fc.boolean(),
      }),
      async ({ text, atMs, chat, session }) => {
        const row = {
          id: "legacy",
          text,
          schedule: { kind: "at", atMs },
          nextRunAtMs: atMs,
          createdAt: atMs,
          status: "fired",
          firedAt: atMs,
          delivered: null,
          error: null,
          ...(chat ? { chat: { id: "555", threadId: null } } : {}),
          ...(session ? { sessionId: null } : {}),
        };
        const [read] = parseReminderTable(
          reminderFile(),
          { schemaVersion: 2, rows: [row] },
          NOW,
        );
        assert.ok(read);
        assert.equal(reminderContent(read), "task");
        writeFileSync(
          reminderFile(),
          JSON.stringify({ schemaVersion: 2, rows: [row] }),
        );
        let turns = 0;
        const sends: string[] = [];
        await runReminderFire("legacy", {
          ...delivery(sends),
          runTurn: async () => {
            turns++;
            return {
              status: "completed",
              message: "done",
              feedback: async () => {},
            };
          },
        });
        assert.equal(turns, 1);
        assert.deepEqual(sends, ["done"]);
      },
    ),
    { seed: SEED, numRuns: 40 },
  );
});

test("Reminder content: invalid or absent choice returns a ready call and does not write", async () => {
  for (const content of [undefined, "wrong"]) {
    const result = (await remind.execute(
      { action: "add", text: TEXT, at: "in 2m", content: content as "text" },
      {} as ToolContext,
    )) as { ok: boolean; error: string };
    assert.equal(result.ok, false);
    assert.match(result.error, /Example:.*"content":"text"/);
  }
  assert.deepEqual(await list(), []);
  // The enum remains on the wire; invalid schema input becomes a recoverable refusal.
  const parsed = (
    remind.inputSchema as import("zod").z.ZodType<{ content?: string }>
  ).parse({ action: "add", content: "wrong", text: TEXT, at: "in 2m" });
  assert.equal(parsed.content, undefined);
});

test("Reminder format: unchanged schema 2, content stored beside the table", async () => {
  await accepted("text");
  const raw = JSON.parse(readFileSync(reminderFile(), "utf8")) as {
    schemaVersion: number;
    rows: Array<Record<string, unknown>>;
  };
  assert.equal(raw.schemaVersion, REMINDER_SCHEMA_VERSION);
  assert.equal(raw.schemaVersion, 2);
  assert.equal(Object.hasOwn(raw.rows[0], "content"), false);
  assert.equal(Object.hasOwn(raw.rows[0], "resetSessionId"), false);
  assert.deepEqual(readReminderContents(), { "r-f1": "text" });
  assert.equal(reminderContent((await list())[0]), "text");
  assert.equal(statSync(reminderContentFile()).mode & 0o777, 0o600);
  assert.equal(
    join(process.env.ASSISTANT_DATA_DIR!, "reminders.json"),
    reminderFile(),
  );
});

test("ReminderLifecycle LoseContent: AcceptedVisibleOutcome and OneAttemptPerCapture survive loss", async () => {
  await accepted("text");
  unlinkSync(reminderContentFile());
  assert.equal(reminderContent((await list())[0]), "task");
  let turns = 0;
  const sends: string[] = [];
  await runReminderFire("r-f1", {
    ...delivery(sends),
    runTurn: async () => {
      turns++;
      return { status: "completed", message: TEXT, feedback: async () => {} };
    },
  });
  assert.equal(turns, 1);
  assert.deepEqual(sends, [TEXT]);
  assert.equal((await list())[0]?.delivered, true);
  assert.deepEqual(await fireDue(NOW + 60_000, 5), []);
});

for (const raw of [
  "{broken",
  JSON.stringify({ schemaVersion: 99, rows: [] }),
]) {
  test(`Reminder content: damaged or future file degrades to task with reason: ${raw}`, async (t) => {
    await accepted("text");
    writeFileSync(reminderContentFile(), raw);
    const reasons: string[] = [];
    t.mock.method(console, "warn", (reason: string) => reasons.push(reason));
    let turns = 0;
    const sends: string[] = [];
    await runReminderFire("r-f1", {
      ...delivery(sends),
      runTurn: async () => {
        turns++;
        return { status: "completed", message: TEXT, feedback: async () => {} };
      },
    });
    assert.equal(turns, 1);
    assert.deepEqual(sends, [TEXT]);
    assert.ok(
      reasons.some((reason) =>
        /reminder-content.json.*unreadable.*using tasks/u.test(reason),
      ),
    );
    assert.equal(readFileSync(reminderContentFile(), "utf8"), raw);
  });
}

test("Reminder content: unreadable directory degrades add to task; orphan sweep still works", async () => {
  mkdirSync(reminderContentFile());
  await add({
    id: "degraded",
    text: TEXT,
    content: "text",
    schedule: { kind: "at", atMs: NOW },
  });
  assert.equal((await list()).length, 1);
  assert.equal(reminderContent({ id: "degraded" }), "task");
  await remove("degraded");
  assert.ok(statSync(reminderContentFile()).isDirectory());
  rmSync(reminderContentFile(), { recursive: true });
  writeFileSync(reminderContentFile(), JSON.stringify({ orphan: "text" }));
  assert.equal((await list()).length, 0);
  assert.equal(await sweepFired(NOW), 0);
  assert.deepEqual(readReminderContents(), {});
});

test("Reminder content: a failed kind write still refuses the row", async (t) => {
  const rename = fsp.rename;
  t.mock.method(fsp, "rename", (...args: Parameters<typeof fsp.rename>) => {
    if (String(args[1]) === reminderContentFile())
      return Promise.reject(new Error("injected content write failure"));
    return rename(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    add({
      id: "rejected",
      text: TEXT,
      content: "text",
      schedule: { kind: "at", atMs: NOW },
    }),
    /injected content write failure/,
  );
  assert.deepEqual(await list(), []);
});

for (const operation of ["add", "remove", "sweep"] as const) {
  test(`Reminder content: EIO during ${operation} preserves bytes and existing text kind`, async (t) => {
    await add({
      id: "existing",
      text: TEXT,
      content: "text",
      schedule: { kind: "at", atMs: NOW },
    });
    await add({
      id: "removed",
      text: TEXT,
      content: "text",
      schedule: { kind: "at", atMs: NOW },
    });
    const before = readFileSync(reminderContentFile());
    const read = fs.readFileSync;
    let injected = false;
    const warnings: string[] = [];
    t.mock.method(console, "warn", (reason: string) => warnings.push(reason));
    t.mock.method(
      fs,
      "readFileSync",
      (...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]) === reminderContentFile() && !injected) {
          injected = true;
          throw Object.assign(new Error("injected content read failure"), {
            code: "EIO",
          });
        }
        return read(...args);
      },
    );
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    if (operation === "add")
      await add({
        id: "new",
        text: TEXT,
        content: "text",
        schedule: { kind: "at", atMs: NOW },
      });
    else if (operation === "remove") await remove("removed");
    else await sweepFired(NOW);
    assert.equal(injected, true);
    assert.deepEqual(readFileSync(reminderContentFile()), before);
    assert.equal(reminderContent({ id: "existing" }), "text");
    if (operation === "add")
      assert.equal(reminderContent({ id: "new" }), "task");
    assert.ok(
      warnings.some((reason) =>
        /preserving content map.*EIO|preserving content map.*injected/.test(
          reason,
        ),
      ),
    );
  });
}

for (const raw of [
  "{broken",
  "null",
  "[]",
  '{"schemaVersion":99,"existing":"text"}',
]) {
  test(`Reminder content: unsupported map is byte-preserved across all mutations: ${raw}`, async (t) => {
    t.mock.method(console, "warn", () => {});
    await add({
      id: "existing",
      text: TEXT,
      content: "text",
      schedule: { kind: "at", atMs: NOW },
    });
    writeFileSync(reminderContentFile(), raw);
    await add({
      id: "new",
      text: TEXT,
      content: "text",
      schedule: { kind: "at", atMs: NOW },
    });
    assert.equal(reminderContent({ id: "new" }), "task");
    await remove("new");
    await sweepFired(NOW);
    await assert.rejects(remove("missing"), /not found/);
    assert.equal(readFileSync(reminderContentFile(), "utf8"), raw);
  });
}

test("Reminder content: a future entry matching a new row id is preserved", async (t) => {
  t.mock.method(console, "warn", () => {});
  const raw = '{"future":{"content":"text","schemaVersion":99}}';
  writeFileSync(reminderContentFile(), raw);
  await add({
    id: "future",
    text: TEXT,
    content: "text",
    schedule: { kind: "at", atMs: NOW },
  });
  assert.equal(reminderContent({ id: "future" }), "task");
  await remove("future");
  assert.equal(readFileSync(reminderContentFile(), "utf8"), raw);
});

test(`Reminder content: future values survive add/remove/sweep (seed ${SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(fc.jsonValue(), async (future) => {
      process.env.ASSISTANT_DATA_DIR = tempDir("iva-reminder-future-");
      await add({
        id: "existing",
        text: TEXT,
        content: "text",
        schedule: { kind: "at", atMs: NOW },
      });
      const unknown = { content: "future", schemaVersion: 99, payload: future };
      writeFileSync(
        reminderContentFile(),
        JSON.stringify({ existing: "text", future: unknown }),
      );
      await add({
        id: "new",
        text: TEXT,
        content: "text",
        schedule: { kind: "at", atMs: NOW },
      });
      assert.equal(reminderContent({ id: "existing" }), "text");
      assert.equal(reminderContent({ id: "new" }), "text");
      await remove("new");
      await sweepFired(NOW);
      assert.deepEqual(
        JSON.parse(readFileSync(reminderContentFile(), "utf8")),
        { existing: "text", future: unknown },
      );
    }),
    { seed: SEED, numRuns: 30 },
  );
});

test("Reminder content: remove and sweep prune only ids absent from the remaining rows", async () => {
  await accepted("text");
  await recordDelivery("r-f1", { firedAt: NOW, delivered: true, error: null });
  await add({
    id: "pending",
    text: TEXT,
    content: "text",
    schedule: { kind: "at", atMs: NOW + 100_000 },
  });
  writeFileSync(
    reminderContentFile(),
    JSON.stringify({ ...readReminderContents(), orphan: "text" }),
  );
  assert.equal(await sweepFired(NOW + 24 * 60 * 60_000), 1);
  assert.deepEqual(readReminderContents(), { pending: "text" });
  await remove("pending");
  assert.deepEqual(readReminderContents(), {});
  writeFileSync(reminderContentFile(), JSON.stringify({ orphan: "text" }));
  await assert.rejects(remove("orphan"), /not found/u);
  assert.deepEqual(readReminderContents(), {});
});

test(`Reminder content roundtrip: rows keep legacy keys, text and kind survive (seed ${SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          text: fc
            .string({ minLength: 1, maxLength: 80 })
            .filter((text) => text.trim().length > 0),
          content: fc.constantFrom("text" as const, "task" as const),
        }),
        { minLength: 1, maxLength: 8 },
      ),
      async (inputs) => {
        process.env.ASSISTANT_DATA_DIR = tempDir("iva-reminder-roundtrip-");
        for (const [i, input] of inputs.entries())
          await add({
            id: `row-${i}`,
            ...input,
            schedule: { kind: "at", atMs: NOW + i },
          });
        const rows = await list();
        const raw = JSON.parse(readFileSync(reminderFile(), "utf8")) as {
          schemaVersion: number;
          rows: Array<Record<string, unknown>>;
        };
        assert.equal(raw.schemaVersion, 2);
        assert.deepEqual(
          rows.map((row) => row.text),
          inputs.map((input) => input.text),
        );
        assert.deepEqual(
          rows.map(reminderContent),
          inputs.map((input) => input.content),
        );
        for (const row of raw.rows)
          assert.deepEqual(
            Object.keys(row).sort(),
            [
              "id",
              "text",
              "chat",
              "schedule",
              "nextRunAtMs",
              "createdAt",
              "status",
              "firedAt",
              "delivered",
              "error",
              "sessionId",
            ].sort(),
          );
        for (const row of rows) await remove(row.id);
        assert.deepEqual(await list(), []);
        assert.deepEqual(readReminderContents(), {});
      },
    ),
    { seed: SEED, numRuns: 30 },
  );
});

test("Reminder content: removing or sweeping commands preserves reminder kinds", async () => {
  await accepted("text");
  const commandFile = join(
    process.env.ASSISTANT_DATA_DIR!,
    "schedule-commands.json",
  );
  await add(
    {
      id: "c-example",
      text: "echo fixture",
      schedule: { kind: "at", atMs: NOW },
    },
    { file: commandFile },
  );
  await remove("c-example", commandFile);
  assert.deepEqual(readReminderContents(), { "r-f1": "text" });
  await sweepFired(NOW, 0, commandFile);
  assert.deepEqual(readReminderContents(), { "r-f1": "text" });
});
