/**
 * ReminderLifecycle.tla, Kind="at", Fault="none": waiting -> captured/open ->
 * delivered/refused, or child death -> expired/abandoned -> Alert fact.
 * OneAttemptPerCapture: ticks never start another text after a capture/fact.
 * NoFalseAlert: a live child or a delivery fact prevents an abandonment Alert.
 * AbandonedAlerted: after recovery, an abandoned firing gets one Alert fact.
 * EveryFiringConcludes: with fair completion/recovery, no capture remains open.
 * The transport double refuses BEFORE acceptance (no lost answers); therefore
 * lostText/misses are zero. /stop is ChildRefused; /new preserves the original text when it interrupts a task.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { Cron } from "croner";
import { REMINDER_TICK_CRON } from "../../agent/lib/schedule-table.ts";
import * as store from "../../agent/lib/reminder-store.ts";
import { chatKeyOf } from "../../agent/lib/run-status.ts";
import { requestTurnCancel } from "../../agent/lib/telegram-stop.ts";
import {
  runReminderFire,
  type ReminderFireDependencies,
} from "../reminders/fire.ts";
import { runReminderTurn } from "../lib/reminder-turn.ts";
import {
  createHarness,
  diskTmp,
  kill,
  message,
  OWNER,
  smokeParameters,
  waitFor,
} from "./harness.ts";

type Harness = Awaited<ReturnType<typeof createHarness>>;
const TEXT = "SMOKE_REMINDER_TEXT";
const ANSWER = "SMOKE_REMINDER_ANSWER";
const TOPIC = 73;
const rows = async (h: Harness): Promise<store.Reminder[]> => {
  const table = JSON.parse(
    await readFile(join(h.app, "data/reminders.json"), "utf8").catch(
      () => '{"rows":[]}',
    ),
  ) as { rows: store.Reminder[] };
  return table.rows;
};
const texts = (h: Harness, text: string) =>
  h.telegram.requests.filter(
    (r) => r.method === "sendMessage" && r.body.text === text,
  );
const tick = (h: Harness, now: number, capture = false) => {
  // All newly spawned processes start at this logical instant. Advancing it on
  // each tick avoids rewinding the Alert throttle's clock between children.
  h.env.IVA_TEST_NOW = new Date(now).toISOString();
  return h.run([
    join(h.app, "scripts/smoke/reminder-tick.ts"),
    String(now),
    ...(capture ? ["capture"] : []),
  ]);
};

async function askReminder(
  h: Harness,
  topic = false,
  content: "text" | "task" = "task",
) {
  h.provider.enqueue(
    {
      kind: "tool",
      name: "remind",
      arguments: JSON.stringify({
        action: "add",
        content,
        text: TEXT,
        at: "in 3s",
      }),
    },
    { kind: "text", text: "SMOKE_REMINDER_ADDED" },
  );
  const update = message(301, "Remind me in three seconds");
  h.telegram.push(
    topic
      ? { ...update, message: { ...update.message, message_thread_id: TOPIC } }
      : update,
  );
  const row = await waitFor(async () => (await rows(h))[0]);
  await waitFor(() => texts(h, "SMOKE_REMINDER_ADDED").length === 1);
  assert.equal(row.text, TEXT);
  assert.deepEqual(row.chat, {
    id: String(OWNER),
    threadId: topic ? String(TOPIC) : null,
  });
  return row;
}

void test(
  "S-rem-ontime: ready text reaches its topic within 15s of the stored deadline without a model turn",
  { timeout: 120_000 },
  async (t) => {
    const h = await createHarness(t);
    const row = await askReminder(h, true, "text");
    const requests = h.provider.requests.length;
    const cron = new Cron(REMINDER_TICK_CRON, { paused: true });
    t.after(() => cron.stop());
    const next = cron.nextRun(new Date(row.nextRunAtMs - 1));
    assert.ok(next);
    const tickDelay = next.getTime() - row.nextRunAtMs;
    assert.ok(
      tickDelay >= 0 && tickDelay <= 1_000,
      "seconds cron admits within one second",
    );
    await tick(h, row.nextRunAtMs - 1);
    assert.equal(texts(h, TEXT).length, 0, "not before the deadline");
    const started = performance.now();
    let latency = Infinity;
    await Promise.all([
      tick(h, next.getTime()),
      waitFor(() => texts(h, TEXT).length === 1).then(() => {
        latency = tickDelay + performance.now() - started;
      }),
    ]);
    t.diagnostic(
      `S-rem-ontime text deadline-to-send=${Math.round(latency)}ms (cron wait=${tickDelay}ms + child/transport wall time); bound=15000ms`,
    );
    assert.ok(
      latency <= 15_000,
      `text delivered ${Math.round(latency)}ms after deadline`,
    );
    assert.equal(h.provider.requests.length, requests, "TextNeverRunsTurn");
    assert.equal(String(texts(h, TEXT)[0].chat), String(OWNER));
    assert.equal(String(texts(h, TEXT)[0].topic), String(TOPIC));
    assert.equal((await rows(h))[0].delivered, true);
    await tick(h, row.nextRunAtMs + 60_000);
    assert.equal(texts(h, TEXT).length, 1, "OneAttemptPerCapture");
    await h.saveEvidence("reminder-ontime");
    h.pass();
  },
);

void test(
  "S-rem-ontime: remind add -> Schedule tick -> one reply in the originating topic",
  { timeout: 120_000 },
  async (t) => {
    smokeParameters();
    const h = await createHarness(t);
    const row = await askReminder(h, true);
    h.provider.enqueue({ kind: "text", text: ANSWER });
    await tick(h, row.nextRunAtMs - 1);
    assert.equal((await rows(h))[0].firedAt, null, "not before the deadline");
    assert.equal(texts(h, ANSWER).length, 0);
    const started = performance.now();
    let sentAt = started;
    await Promise.all([
      tick(h, row.nextRunAtMs),
      waitFor(() => texts(h, ANSWER).length === 1).then(() => {
        sentAt = performance.now();
      }),
    ]);
    t.diagnostic(
      `S-rem-ontime deadline-to-send=${Math.round(sentAt - started)}ms; logical clock advanced to deadline; invoked runReminderTick as Schedule does; task turn latency is separate from ready text`,
    );
    assert.equal((await rows(h))[0].delivered, true);
    const requests = h.provider.requests.length;
    assert.equal(requests, 3, "tool call, confirmation, one reminder turn");
    await tick(h, row.nextRunAtMs + 60_000);
    await tick(h, row.nextRunAtMs + 120_000);
    assert.equal(texts(h, ANSWER).length, 1, "OneAttemptPerCapture");
    assert.equal(h.provider.requests.length, requests, "one reminder turn");
    assert.equal(String(texts(h, ANSWER)[0].chat), String(OWNER));
    assert.equal(String(texts(h, ANSWER)[0].topic), String(TOPIC));
    assert.match(
      JSON.stringify(h.provider.requests.at(-1)),
      /Reminder.*SMOKE_REMINDER_TEXT/u,
    );
    assert.equal(texts(h, TEXT).length, 0, "the turn's answer is delivered");
    h.pass();
  },
);

void test(
  "S-rem-ontime: failed reminder turn sends the original text and records the reason",
  { timeout: 120_000 },
  async (t) => {
    const h = await createHarness(t);
    const row = await askReminder(h, true);
    h.provider.enqueue({ kind: "overloaded", times: 3 });
    await tick(h, row.nextRunAtMs);
    const delivered = (await rows(h))[0];
    t.diagnostic(JSON.stringify({ row: delivered, sends: texts(h, TEXT) }));
    assert.equal(
      h.provider.requests.length,
      5,
      "two setup requests and three refused attempts",
    );
    assert.equal(
      texts(h, TEXT).length,
      1,
      "a failed turn preserves the reminder text verbatim",
    );
    assert.equal(String(texts(h, TEXT)[0].chat), String(OWNER));
    assert.equal(String(texts(h, TEXT)[0].topic), String(TOPIC));
    assert.equal(delivered.delivered, true);
    assert.match(delivered.error ?? "", /^agent turn failed: .+/u);
    assert.match(
      await readFile(join(h.root, "process.log"), "utf8"),
      /agent turn failed:/u,
    );
    await tick(h, row.nextRunAtMs + 60_000);
    assert.equal(
      texts(h, TEXT).length,
      1,
      "OneAttemptPerCapture after a failed turn",
    );
    assert.equal(h.provider.requests.length, 5);
    await h.saveEvidence("reminder-failed");
    h.pass();
  },
);

void test(
  "S-rem-reset: /new during a reminder turn delivers its text",
  { timeout: 90_000 },
  async (t) => {
    const h = await createHarness(t);
    const row = await askReminder(h);
    h.provider.enqueue({ kind: "overloaded", times: 100 });
    await tick(h, row.nextRunAtMs, true);
    const cursor = h.provider.requests.length;
    const child = h.start([join(h.app, "scripts/reminders/fire.ts"), row.id]);
    await waitFor(async () => (await rows(h))[0].sessionId);
    await waitFor(() => h.provider.requests.length > cursor);
    h.telegram.push(message(302, "/new"));
    await waitFor(() => child.exitCode !== null || child.signalCode !== null);
    await tick(h, row.nextRunAtMs + 31 * 60_000);
    t.diagnostic(
      JSON.stringify({
        row: (await rows(h))[0],
        sends: h.telegram.requests
          .filter((r) => r.method === "sendMessage")
          .map((r) => r.body.text),
      }),
    );
    const preserved = h.telegram.requests.filter(
      (r) => r.method === "sendMessage" && String(r.body.text).startsWith(TEXT),
    );
    assert.equal(
      preserved.length,
      1,
      "F1: reset must preserve the reminder text",
    );
    assert.match(String(preserved[0].body.text), /conversation reset/u);
    assert.equal((await rows(h))[0].delivered, true);
    await h.saveEvidence("reminder-reset");
    h.pass();
  },
);

void test(
  "SIGKILL reminder child: abandoned firing gets exactly one Alert, no repeated text",
  { timeout: 90_000 },
  async (t) => {
    const h = await createHarness(t);
    const row = await askReminder(h);
    h.provider.enqueue({ kind: "overloaded", times: 100 });
    // Capture is durable, but the old tick continuation is gone (agent restart).
    await tick(h, row.nextRunAtMs, true);
    const child = h.start([join(h.app, "scripts/reminders/fire.ts"), row.id]);
    await waitFor(async () => (await rows(h))[0].sessionId);
    // Kill during the turn, after the session transaction released its lock.
    await waitFor(
      async () =>
        !(await stat(join(h.app, "data/reminders.json.lock")).catch(
          () => null,
        )),
    );
    await kill(child);
    assert.equal(child.signalCode, "SIGKILL");
    assert.equal((await rows(h))[0].delivered, null);
    // Recovery after agent death: stop its real second Schedule before advancing
    // the separate recovery process by 31 minutes. Otherwise two agents with
    // incompatible clocks race to alert, and alertDue treats the old clock as a rewind.
    await kill(h.eve);

    await tick(h, row.nextRunAtMs + 31 * 60_000);
    await tick(h, row.nextRunAtMs + 32 * 60_000);
    const alerts = h.telegram.requests.filter(
      (r) =>
        r.method === "sendMessage" &&
        String(r.body.text).includes("may not have reached you"),
    );
    assert.equal(alerts.length, 1, "AbandonedAlerted + AlertOnce");
    assert.match(String(alerts[0].body.text), /SMOKE_REMINDER_TEXT/u);
    assert.equal(String(alerts[0].chat), String(OWNER));
    assert.equal(texts(h, TEXT).length, 0);
    assert.equal(texts(h, ANSWER).length, 0);
    assert.equal((await rows(h))[0].firedAt, row.nextRunAtMs);
    assert.equal((await rows(h))[0].error, store.REMINDER_ABANDONED);
    h.pass();
  },
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const BASE = Date.parse("2026-06-15T12:00:00Z");
type Model = {
  now: number;
  captured: boolean;
  active: boolean;
  started: boolean;
  capturedAt: number | null;
  delivered: boolean | null;
  abandoned: boolean;
  reason: boolean;
  alerted: boolean;
  up: boolean;
  texts: number;
};
type Real = {
  id: string;
  sends: string[];
  up: boolean;
  crashed: boolean;
  deps: ReminderFireDependencies;
  finish: (stop: boolean) => void;
  ready: Promise<void>;
  pending?: Promise<number>;
  counts: Partial<Record<Operation, number>>;
};
type Operation =
  | "mature"
  | "tick"
  | "start"
  | "finish"
  | "crash"
  | "stop"
  | "offline"
  | "recover"
  | "alert"
  | "stale";

async function invariant(m: Model, r: Real) {
  const row = (await store.list())[0];
  assert.equal(row.firedAt !== null, m.captured, "OncePerDue");
  assert.equal(row.delivered, m.delivered, "FactOfThisFiring");
  assert.equal(row.error !== null, m.reason, "DeliveredOrReason");
  assert.equal(
    r.sends.filter((s) => s === ANSWER).length,
    m.texts,
    "OneAttemptPerCapture",
  );
  assert.ok(m.texts <= 1, "OneAttemptPerCapture (no lost answers)");
  const alerts = r.sends.filter((s) => s.includes("may not have reached you"));
  assert.equal(alerts.length, m.alerted ? 1 : 0, "NoFalseAlert / AlertOnce");
  if (m.alerted) assert.ok(m.abandoned && !m.active && m.delivered === null);
}

class ReminderCommand implements fc.AsyncCommand<Model, Real> {
  readonly op: Operation;
  constructor(op: Operation) {
    this.op = op;
  }
  check(m: Readonly<Model>) {
    if (this.op === "start")
      return m.captured && !m.started && !m.reason && m.delivered === null;
    if (["finish", "crash", "stop"].includes(this.op)) return m.active;
    if (this.op === "stale") return m.captured;
    return true;
  }
  async run(m: Model, r: Real) {
    r.counts[this.op] = (r.counts[this.op] ?? 0) + 1;
    switch (this.op) {
      case "mature":
        m.now += 31 * 60_000;
        break;
      case "offline":
        m.up = r.up = false;
        break;
      case "recover":
        m.up = r.up = true;
        break;
      case "tick": {
        const captures = await store.fireDue(m.now, 5);
        const take = !m.captured && m.now >= BASE + 1000;
        assert.equal(captures.length, take ? 1 : 0, "OncePerDue");
        if (take) {
          m.captured = true;
          m.capturedAt = m.now;
        }
        const closed = await store.closeAbandoned(
          m.now,
          undefined,
          () => m.active,
        );
        const expires =
          m.captured &&
          !m.active &&
          !m.reason &&
          m.delivered === null &&
          m.now >= m.capturedAt! + 30 * 60_000;
        assert.equal(closed.length, expires ? 1 : 0, "EveryFiringConcludes");
        if (expires) m.abandoned = m.reason = true;
        break;
      }
      case "start": {
        r.pending = runReminderFire(r.id, r.deps);
        await r.ready;
        m.active = m.started = true;
        break;
      }
      case "finish":
      case "stop": {
        const stop = this.op === "stop";
        if (stop) {
          const outcome = await requestTurnCancel(
            chatKeyOf(String(OWNER), null),
            {
              url: "http://fixture/cancel",
              secret: "fixture",
              cancelImpl: ({ sessionId }) => {
                assert.equal(sessionId, `session-${r.id}`);
                r.finish(true);
                return Promise.resolve({ status: "cancelled" });
              },
            },
          );
          assert.equal(outcome, "requested");
        } else r.finish(false);
        assert.equal(await r.pending, 0);
        m.active = false;
        m.delivered = !stop && m.up;
        m.reason = stop || !m.up;
        if (m.delivered) m.texts++;
        break;
      }
      case "crash": {
        // SIGKILL itself is covered above. A severed child leaves no fact:
        // suppress its final write, then let the real table/tick recover it.
        r.crashed = true;
        r.up = false;
        r.finish(false);
        await r.pending;
        r.up = m.up;
        m.active = false;
        break;
      }
      case "alert": {
        assert.equal(
          await runReminderFire(r.id, r.deps, "abandoned"),
          m.abandoned && !m.alerted && !m.up ? 1 : 0,
        );
        if (m.abandoned && m.up) m.alerted = true;
        break;
      }
      case "stale": {
        const row = (await store.list())[0];
        await store.recordDelivery(
          r.id,
          { firedAt: row.firedAt! - 1, delivered: true, error: null },
          { log: () => {} },
        );
        break;
      }
    }
    await invariant(m, r);
  }
  toString() {
    return this.op;
  }
}

void test(
  "P-reminder: lifecycle commands preserve delivery facts",
  { timeout: 180_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: BASE });
    await mkdir(diskTmp, { recursive: true });
    const previous = process.env.ASSISTANT_DATA_DIR;
    const parameters = smokeParameters();
    let index = 0;
    const counts: Partial<Record<Operation, number>> = {};
    const operations: Operation[] = [
      "mature",
      "tick",
      "start",
      "finish",
      "crash",
      "stop",
      "offline",
      "recover",
      "alert",
      "stale",
    ];
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.boolean(),
          fc.commands(
            operations.map((op) => fc.constant(new ReminderCommand(op))),
            { maxCommands: 24, size: "+1" },
          ),
          async (initiallyOpen, commands) => {
            const dir = await mkdtemp(join(diskTmp, "reminder-model-"));
            process.env.ASSISTANT_DATA_DIR = dir;
            const m: Model = {
              now: BASE,
              captured: false,
              active: false,
              started: false,
              capturedAt: null,
              delivered: null,
              abandoned: false,
              reason: false,
              alerted: false,
              up: true,
              texts: 0,
            };
            const id = `r-model-${++index}`;
            const ready = deferred<void>();
            const finish = deferred<boolean>();
            const r: Real = {
              id,
              counts,
              sends: [],
              up: true,
              crashed: false,
              deps: {},
              ready: ready.promise,
              finish: (stop) => finish.resolve(stop),
            };
            r.deps = {
              env: {
                TELEGRAM_BOT_TOKEN: "fixture",
                ASSISTANT_BEARER: "fixture",
              },
              chat: () => String(OWNER),
              translator: () => Promise.resolve((en: string) => en),
              log: () => {},
              recordDelivery: async (...args) =>
                r.crashed
                  ? (await store.list())[0]
                  : store.recordDelivery(...args),
              send: async (_token, _chat, text, options) => {
                if (options?.beforeAttempt && !(await options.beforeAttempt()))
                  return { ok: false, error: "withdrawn", fellBack: false };
                assert.equal(typeof text, "string");
                if (r.up) r.sends.push(text as string);
                return {
                  ok: r.up,
                  error: r.up ? "" : "transport refused",
                  fellBack: false,
                };
              },
              runTurn: (prompt, options, deps) =>
                runReminderTurn(prompt, options, {
                  ...deps,
                  createClient: () =>
                    Promise.resolve({
                      sessions: {
                        create: () =>
                          Promise.resolve({
                            session: {
                              send: async () => {},
                              cancel: async () => {},
                              reset: async () => {},
                            },
                            response: Object.assign(
                              (async function* () {
                                ready.resolve();
                                if (await finish.promise)
                                  yield { type: "turn.cancelled" };
                                else
                                  yield {
                                    type: "message.completed",
                                    data: { message: ANSWER },
                                  };
                                yield { type: "session.waiting" };
                              })(),
                              {
                                sessionId: `session-${id}`,
                                cancel: async () => {},
                              },
                            ),
                          }),
                      },
                    }),
                }),
            };
            try {
              await store.add({
                id,
                text: TEXT,
                chat: { id: String(OWNER), threadId: null },
                schedule: { kind: "at", atMs: BASE + 1000 },
              });
              // Fair suffix discharges temporal obligations after the finite random prefix.
              const step = async (op: Operation) => {
                const c = new ReminderCommand(op);
                if (c.check(m)) await c.run(m, r);
              };
              if (initiallyOpen) {
                await step("mature");
                await step("tick");
                await step("start");
              }
              await fc.asyncModelRun(() => ({ model: m, real: r }), commands);
              await step("recover");
              if (m.active) await step("finish");
              await step("mature");
              await step("tick");
              if (!m.started && !m.reason && m.delivered === null) {
                await step("start");
                await step("finish");
              }
              await step("mature");
              await step("tick");
              await step("alert");
              await step("alert");
              await step("stale");
              assert.ok(
                m.delivered !== null || m.reason,
                "EveryFiringConcludes",
              );
              if (m.abandoned) assert.ok(m.alerted, "AbandonedAlerted");
            } finally {
              if (m.active) {
                r.finish(true);
                await r.pending;
              }
              await rm(dir, { recursive: true, force: true });
            }
          },
        ),
        parameters,
      );
      t.diagnostic(`P-reminder executed commands: ${JSON.stringify(counts)}`);
    } finally {
      if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
      else process.env.ASSISTANT_DATA_DIR = previous;
    }
  },
);
