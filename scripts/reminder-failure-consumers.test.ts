/* eslint-disable @typescript-eslint/require-await -- Async client and delivery doubles preserve external I/O boundaries. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type {
  ReminderClientOptions,
  TurnStreamEvent,
} from "./lib/reminder-turn.ts";

const root = mkdtempSync(join(tmpdir(), "iva-turn-failure-"));
process.env.ASSISTANT_DATA_DIR = root;
process.env.ASSISTANT_TIMEZONE = "UTC";
after(() => rmSync(root, { recursive: true, force: true }));
const { runReminderTurn } = await import("./lib/reminder-turn.ts");
const { runReminderFire } = await import("./reminders/fire.ts");
const { add, fireDue, list } = await import("#lib/reminder-store.ts");
const { runJobWake } = await import("./lib/job-wake.ts");
const { recordFact, jobFactsFile, readFacts } =
  await import("#lib/job-facts.ts");
const { runProactiveTick } = await import("./proactive/tick.ts");
const { PROACTIVE_DEFAULTS } = await import("#lib/proactive-config.ts");
const { initialState } = await import("./proactive/state.ts");
// Use the installed core's actual failure emitter; only the external client is replaced.
const { emitRecoverableFailedTurn } = (await import(
  new URL("../node_modules/eve/dist/src/harness/emission.js", import.meta.url)
    .href
)) as typeof import("../node_modules/eve/dist/src/harness/emission.js");
const now = Date.UTC(2026, 9, 14, 12);
const intermediate = "Сначала проверю источник";
const failure = "fixture provider rejected the second request";
const options: ReminderClientOptions = {
  host: "http://fixture.invalid",
  auth: { bearer: async () => "fixture" },
};
const tr = (_en: string, ru: string) => ru;

const failedTurn: typeof runReminderTurn = (prompt, clientOptions, deps) =>
  runReminderTurn(prompt, clientOptions, {
    ...deps,
    createClient: async () => ({
      sessions: {
        create: async () => ({
          response: {
            sessionId: "fixture-session",
            cancel: async () => {},
            async *[Symbol.asyncIterator]() {
              yield { type: "turn.started", data: { turnId: "fixture-turn" } };
              yield {
                type: "message.completed",
                data: { message: intermediate, finishReason: "tool-calls" },
              };
              const events: TurnStreamEvent[] = [];
              await emitRecoverableFailedTurn(
                async (event: TurnStreamEvent) => {
                  events.push(event);
                },
                {
                  sessionStarted: true,
                  sequence: 1,
                  stepIndex: 1,
                  turnId: "fixture-turn",
                },
                {
                  code: "FIXTURE_FAILURE",
                  message: failure,
                  continuationToken: "fixture-session",
                },
              );
              yield* events;
            },
          },
          session: {
            send: async () => {},
            cancel: async () => {},
            reset: async () => {},
          },
        }),
      },
    }),
  });

void test("recoverable turn failure returns its reason instead of intermediate text", async () => {
  const turn = await failedTurn("fixture", options);
  assert.equal(turn.status, "failed");
  assert.equal(turn.message, failure);
  assert.equal(turn.cancelled, false);
});

for (const id of ["r-failure", "signal-failure"]) {
  void test(`${id} sends the reminder fallback and records the turn failure`, async () => {
    const text = "Ожидаемое напоминание";
    await add({
      id,
      text,
      chat: { id: "424242", threadId: null },
      schedule: { kind: "at", atMs: now },
    });
    await fireDue(now, 10);
    const sent: string[] = [];
    const exit = await runReminderFire(id, {
      env: {
        TELEGRAM_BOT_TOKEN: "fixture",
        ASSISTANT_BEARER: "fixture",
        ASSISTANT_TIMEZONE: "UTC",
      },
      runTurn: failedTurn,
      send: async (_bot, _chat, text) => {
        sent.push(String(text));
        return { ok: true, fellBack: false, error: "" };
      },
      translator: async () => tr,
      log: () => {},
    });
    assert.equal(exit, 0);
    // Строка Signal — данные, идёт как есть; Reminder — задание, к нему строка «не выполнено».
    assert.deepEqual(sent, [
      id.startsWith("signal-")
        ? text
        : `${text}\n\nНе выполнено: ход не дал ответа.`,
    ]);
    const row = (await list()).find((row) => row.id === id);
    assert.equal(row?.delivered, true); // The fallback itself was delivered.
    assert.equal(row?.error, `agent turn failed: ${failure}`);
  });
}

void test("Alert records a failed wake and sends no intermediate answer", async () => {
  const factsFile = jobFactsFile(join(root, "alert"));
  await recordFact(
    factsFile,
    {
      name: "fixture-job",
      startedAt: now - 1000,
      finishedAt: now,
      ok: false,
      error: "job exited 1",
      exitCode: 1,
      tail: "",
      acked: false,
      wake: null,
    },
    now,
  );
  const sent: string[] = [];
  const wake = await runJobWake("fixture-job", now - 1000, {
    factsFile,
    tr,
    runTurn: (prompt) => failedTurn(prompt, options),
    send: async (text) => {
      sent.push(text);
      return true;
    },
    now: () => now + 1,
    log: () => {},
  });
  assert.equal(wake, "failed");
  assert.deepEqual(sent, []);
  assert.equal(
    (await readFacts(factsFile))[0]?.wake?.error,
    `turn failed: ${failure}`,
  );
});

for (const kind of ["watch", "brief", "insight"] as const) {
  void test(`${kind} reports failure and sends no intermediate answer`, async () => {
    const dir = join(root, kind);
    mkdirSync(dir);
    const statePath = join(dir, "proactive.json");
    writeFileSync(statePath, JSON.stringify(initialState(now - 3600000)));
    const sent: string[] = [];
    const turns: string[] = [];
    const logs: string[] = [];
    const code = await runProactiveTick(now, {
      config: () => ({
        ...PROACTIVE_DEFAULTS,
        briefTimes: kind === "brief" ? ["12:00"] : [],
        insightTimes: kind === "insight" ? ["12:00"] : [],
        staleMinutes: 0,
        urgentSenders: ["Probe"],
      }),
      timeZone: "UTC",
      statePath,
      sources: [
        {
          name: "fixture",
          prefix: "tg:",
          check: async () => ({
            items:
              kind === "watch"
                ? [{ key: "tg:fixture", unread: 2, from: { name: "Probe" } }]
                : [],
            error: null,
          }),
        },
      ],
      runTurn: async (prompt, turnKind, signal) => {
        turns.push(turnKind);
        return failedTurn(
          prompt,
          { ...options, headers: { "x-iva-turn": turnKind } },
          { signal },
        );
      },
      send: async (text) => {
        sent.push(text);
        return { ok: true, error: "" };
      },
      translate: async () => tr,
      log: (line) => {
        logs.push(line);
      },
    });
    assert.deepEqual(turns, [kind]);
    assert.deepEqual(sent, []);
    assert.equal(code, kind === "insight" ? 0 : 1);
    assert.ok(logs.some((line) => line.includes(failure)));
  });
}
