/* eslint-disable @typescript-eslint/require-await -- Async client doubles preserve the external I/O boundary. */
// Контракт хода напоминания: он длится, пока идут события (потолка длительности нет),
// молчащий стрим гасится на окне тишины, а пока ход идёт — чат видит его сессию, чтобы
// ⏹ и /stop гасили её тем же путём, что и ход канала. Самой записи в run-status ход не
// знает: её передаёт хозяин хода (scripts/reminders/fire.ts) зависимостью, иначе модуль
// не загрузился бы на установке без agent/.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import type {
  CreateClient,
  ReminderClient,
  ReminderClientOptions,
  TurnStreamEvent,
  TurnWatch,
} from "./reminder-turn.ts";

const { ReminderTurnError, runReminderTurn } =
  await import("./reminder-turn.ts");

const OPTIONS: ReminderClientOptions = {
  host: "http://127.0.0.1:8723",
  auth: { bearer: () => Promise.resolve("bearer") },
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

type TurnSpy = {
  readonly createClient: CreateClient;
  readonly prompts: string[];
  readonly sent: string[];
  readonly resets: string[];
  readonly cancelCount: () => number;
  /** Остановки через сессию (session.cancel), в порядке вызова вместе с reset. */
  readonly sessionCalls: string[];
};

type WatchCalls = {
  readonly claimed: string[];
  readonly pulsed: string[];
  readonly released: string[];
};

/** Присмотр чата, каким его видит ход: запись живёт в fire.ts, здесь важен только контракт. */
function watchSpy(claim = true): { watch: TurnWatch; calls: WatchCalls } {
  const calls: WatchCalls = { claimed: [], pulsed: [], released: [] };
  return {
    watch: {
      claim: (sessionId) => {
        calls.claimed.push(sessionId);
        return Promise.resolve(claim);
      },
      pulse: (sessionId) => {
        calls.pulsed.push(sessionId);
      },
      release: (sessionId) => {
        calls.released.push(sessionId);
      },
    },
    calls,
  };
}

// A turn reads its response as a stream and cancels it cooperatively, the way eve's
// MessageResponse does; the session records what the turn told it to do.
function spyTurn(
  events: (cancelled: Promise<void>) => AsyncGenerator<TurnStreamEvent>,
  sessionId = "sess-1",
  sessionCancel: () => Promise<unknown> = () =>
    Promise.resolve({ status: "accepted", sessionId }),
): TurnSpy {
  const prompts: string[] = [];
  const sent: string[] = [];
  const resets: string[] = [];
  const sessionCalls: string[] = [];
  let cancels = 0;
  let releaseCancel = (): void => {};
  const cancelled = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  const response = Object.assign(events(cancelled), {
    cancel: () => {
      cancels += 1;
      releaseCancel();
      return Promise.resolve();
    },
    sessionId,
  });
  const client: ReminderClient = {
    sessions: {
      create: (input) => {
        prompts.push(input.message);
        return Promise.resolve({
          response,
          session: {
            send: (message) => {
              sent.push(message);
              return Promise.resolve();
            },
            cancel: (options) => {
              sessionCalls.push(`cancel tasks=${String(options.tasks)}`);
              return sessionCancel();
            },
            reset: ({ reason }) => {
              resets.push(reason);
              sessionCalls.push("reset");
              return Promise.resolve();
            },
          },
        });
      },
    },
  };
  return {
    createClient: () => Promise.resolve(client),
    prompts,
    sent,
    resets,
    cancelCount: () => cancels,
    sessionCalls,
  };
}

function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

for (const data of [undefined, null, { message: 42 }] as const) {
  void test(`turn.failed without string text is failed with a cause: ${JSON.stringify(data)}`, async () => {
    const spy = spyTurn(async function* () {
      yield { type: "message.completed", data: { message: "intermediate" } };
      yield { type: "turn.failed", data };
      yield { type: "session.waiting" };
    });
    const turn = await runReminderTurn("fixture", OPTIONS, {
      createClient: spy.createClient,
    });
    assert.equal(turn.status, "failed");
    assert.equal(turn.message, "ход упал");
    assert.equal(turn.cancelled, false);
    assert.deepEqual(spy.resets, ["Reminder finished"]);
  });
}

for (const mode of [
  "accepted",
  "rejected",
  "hanging",
  "reset-hanging",
] as const) {
  void test(`silence-before-turn-start cancels the known session: ${mode}`, async (t) => {
    const { MessageResponse } = (await import(
      new URL(
        "../../node_modules/eve/dist/src/client/message-response.js",
        import.meta.url,
      ).href
    )) as typeof import("../../node_modules/eve/dist/src/client/message-response.js");
    let release = () => {};
    let releaseReset = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resetGate = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    const calls: string[] = [];
    const logs: unknown[][] = [];
    let finished = false;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const flush = async () => {
      for (let i = 0; i < 10; i++)
        await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const response = new MessageResponse({
      sessionId: "prestart",
      cancelTurn: async () => {
        calls.push("response.cancel");
        return { status: "accepted", sessionId: "prestart" };
      },
      createStream: async function* () {
        await gate;
        yield {
          type: "turn.started",
          data: { turnId: "late-turn", sequence: 1 },
          meta: { at: "2026-10-14T12:00:00Z", id: "fixture-start" },
        };
        yield {
          type: "session.waiting",
          data: { continuationToken: "prestart", wait: "next-user-message" },
          meta: { at: "2026-10-14T12:00:00Z", id: "fixture-waiting" },
        };
      },
    });
    const work = failureOf(
      runReminderTurn("fixture", OPTIONS, {
        inactivityMs: 15,
        log: (...parts) => {
          logs.push(parts);
        },
        watch: {
          claim: async () => true,
          pulse: () => {},
          release: () => {
            calls.push("release");
          },
        },
        createClient: async () => ({
          sessions: {
            create: async () => ({
              response,
              session: {
                send: async () => {},
                cancel: async ({ tasks }) => {
                  calls.push(`session.cancel tasks=${String(tasks)}`);
                  if (mode === "rejected")
                    throw new Error("cancel unavailable");
                  if (mode === "hanging") await new Promise(() => {});
                },
                reset: async () => {
                  calls.push("reset");
                  if (mode === "reset-hanging") await resetGate;
                },
              },
            }),
          },
        }),
      }),
    ).then((error) => {
      finished = true;
      return error;
    });
    try {
      await flush();
      t.mock.timers.tick(15);
      await flush();
      assert.deepEqual(
        calls,
        mode === "hanging"
          ? ["session.cancel tasks=true"]
          : ["session.cancel tasks=true", "release", "reset"],
      );
      if (mode === "hanging" || mode === "reset-hanging") {
        t.mock.timers.tick(30_000);
        await flush();
      }
      assert.equal(
        finished,
        true,
        "the watchdog returns before turn.started is released",
      );
      const error = await work;
      assert.ok(error instanceof ReminderTurnError);
      assert.equal(error.message, "no activity for 15ms");
      assert.deepEqual(calls, [
        "session.cancel tasks=true",
        "release",
        "reset",
      ]);
      assert.equal(
        logs.length,
        mode === "rejected" || mode === "hanging" ? 1 : 0,
      );
    } finally {
      release();
      releaseReset();
      await flush();
      t.mock.timers.tick(30_000);
      await work;
    }
  });
}

for (const mark of ["cancel", "limit", "cancel-and-limit"] as const) {
  void test(`recoverable failure preserves ${mark} priority`, async () => {
    const spy = spyTurn(async function* () {
      yield { type: "message.completed", data: { message: "intermediate" } };
      yield { type: "turn.failed", data: { message: "provider unavailable" } };
      if (mark !== "limit") yield { type: "turn.cancelled" };
      if (mark !== "cancel") yield SESSION_LIMIT_REQUESTED;
      yield { type: "session.waiting" };
    });
    const turn = await runReminderTurn("fixture", OPTIONS, {
      createClient: spy.createClient,
    });
    assert.equal(turn.cancelled, mark !== "limit");
    assert.equal(turn.sessionLimit, mark === "limit" ? true : undefined);
    assert.equal(turn.status, mark === "limit" ? "failed" : "waiting");
    assert.equal(
      turn.message,
      mark === "limit"
        ? "the turn hit the eve session token limit"
        : "intermediate",
    );
  });
}

for (const kind of [
  "reminder",
  "signal",
  "watch",
  "brief",
  "insight",
  "alert",
] as const) {
  void test(`${kind} delivers the final ceiling outcome as a successful turn`, async () => {
    const message = "Остановилась на 40 шагах. Вот что успела: нашла документ.";
    const spy = spyTurn(async function* () {
      yield { type: "message.completed", data: { message } };
      yield { type: "turn.completed", data: { reason: "step-limit" } };
      yield { type: "session.waiting" };
    });
    const turn = await runReminderTurn(
      "fixture",
      { ...OPTIONS, headers: { "x-iva-turn": kind } },
      {
        createClient: spy.createClient,
      },
    );
    assert.equal(turn.message, message);
    assert.equal(turn.status, "waiting");
    assert.equal(turn.cancelled, false);
    assert.deepEqual(spy.resets, ["Reminder finished"]);
  });
}

void test("the last message.completed text is returned and the session is reset", async () => {
  const spy = spyTurn(async function* () {
    // Each gap stays under the idle window while the whole turn runs past it: a window that
    // is only armed once, instead of once per event, has to cut this stream off.
    for (const event of [
      { type: "step.started" },
      { type: "message.appended" },
      { type: "message.completed", data: { message: "draft" } },
      { type: "message.completed", data: { message: null } },
      { type: "message.completed", data: { message: "final" } },
      { type: "reasoning.appended" },
      { type: "action.result" },
      { type: "session.waiting" },
    ] as const) {
      await delay(40);
      yield event;
    }
  });

  const turn = await runReminderTurn("сформулируй напоминание", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 200,
  });

  assert.deepEqual(spy.prompts, ["сформулируй напоминание"]);
  assert.equal(turn.status, "waiting");
  assert.equal(turn.message, "final");
  assert.equal(turn.cancelled, false);
  await turn.feedback("hint");
  assert.deepEqual(spy.sent, ["hint"]);
  assert.deepEqual(spy.resets, ["Reminder finished"]);
});

void test("a silent stream is cancelled at the idle window, never swallowed", async () => {
  const silent = spyTurn(async function* (cancelled) {
    await delay(40);
    yield { type: "step.started" };
    // The turn hangs here; the window has to cut the silence, and cancel() is the only
    // thing that ends the wait.
    await Promise.race([cancelled, delay(400)]);
  });

  const idle = await failureOf(
    runReminderTurn("зависни", OPTIONS, {
      createClient: silent.createClient,
      inactivityMs: 80,
    }),
  );

  assert.ok(idle instanceof ReminderTurnError);
  assert.match(idle.message, /no activity for 80ms/u);
  assert.deepEqual(silent.sessionCalls, ["cancel tasks=true", "reset"]);
  assert.deepEqual(silent.resets, ["Reminder finished"]);
});

void test("a turn that keeps sending events lasts many idle windows and ends on its own boundary", async () => {
  const talkative = spyTurn(async function* () {
    // Events arrive faster than the idle window, so the turn outlives it many times over
    // and only the stream's own boundary may end it: no wall-clock cap cuts a working turn.
    for (let count = 0; count < 40; count += 1) {
      await delay(5);
      yield { type: "step.started" };
    }
    yield { type: "message.completed", data: { message: "готово" } };
    yield { type: "session.completed" };
  });

  const long = await runReminderTurn("работай долго", OPTIONS, {
    createClient: talkative.createClient,
    inactivityMs: 60,
  });

  assert.equal(long.status, "completed");
  assert.equal(long.message, "готово");
  assert.equal(long.cancelled, false);
  assert.equal(talkative.cancelCount(), 0, "рабочий ход никто не гасил");
  assert.deepEqual(talkative.resets, ["Reminder finished"]);
});

void test("the turn claims the chat for the whole run and releases it when it ends", async () => {
  const { watch, calls } = watchSpy();
  const seen: string[][] = [];
  const spy = spyTurn(async function* () {
    // ⏹ и /stop ищут сессию хода именно здесь, поэтому запись обязана существовать уже
    // на первом событии, а не появиться к концу хода.
    seen.push([...calls.claimed]);
    await delay(0);
    yield { type: "message.completed", data: { message: "готово" } };
    yield { type: "session.completed" };
  }, "sess-run");

  const turn = await runReminderTurn("напиши статью", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 1_000,
    watch,
  });

  assert.deepEqual(seen, [["sess-run"]], "чат занят на первом же событии хода");
  assert.equal(turn.status, "completed");
  assert.deepEqual(calls.claimed, ["sess-run"]);
  assert.deepEqual(calls.released, ["sess-run"]);
  // Пульс идёт по событиям хода: без него долгий ход выглядит протухшим и стоп слепнет.
  assert.ok(calls.pulsed.includes("sess-run"), calls.pulsed.join(","));
  assert.deepEqual(
    [...new Set(calls.pulsed)],
    ["sess-run"],
    "пульс — только своя сессия",
  );
});

void test("a stalled turn releases the chat too", async () => {
  const { watch, calls } = watchSpy();
  const spy = spyTurn(async function* (cancelled) {
    yield { type: "step.started" };
    await Promise.race([cancelled, delay(400)]);
  }, "sess-stall");

  const stalled = await failureOf(
    runReminderTurn("зависни", OPTIONS, {
      createClient: spy.createClient,
      inactivityMs: 40,
      watch,
    }),
  );

  assert.ok(stalled instanceof ReminderTurnError);
  assert.deepEqual(calls.released, ["sess-stall"], "запись снята и на провале");
});

void test("a chat taken by another turn is left alone: no record, no release", async () => {
  const { watch, calls } = watchSpy(false);
  const spy = spyTurn(async function* () {
    await delay(0);
    yield { type: "message.completed", data: { message: "готово" } };
    yield { type: "session.completed" };
  }, "sess-busy");

  const turn = await runReminderTurn("напиши статью", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 1_000,
    watch,
  });

  assert.equal(turn.status, "completed", "ход всё равно работает");
  assert.deepEqual(calls.claimed, ["sess-busy"]);
  assert.deepEqual(calls.pulsed, [], "чужую запись пульсом не трогаем");
  assert.deepEqual(calls.released, [], "и не снимаем чужое");
});

void test("a cancelled turn is a cancellation even when the stream has no boundary", async () => {
  const spy = spyTurn(async function* () {
    // Границы сессии нет вовсе: eve штатно шлёт её после отмены, но признак отмены
    // терять нельзя — иначе код отправит владельцу дословный текст напоминания.
    await delay(0);
    yield { type: "turn.cancelled" };
  }, "sess-cut");

  const turn = await runReminderTurn("долгая работа", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 1_000,
  });

  assert.equal(turn.cancelled, true);
  assert.equal(turn.status, "waiting");
  assert.deepEqual(spy.resets, ["Reminder finished"]);
});

void test("a stream that breaks right after the cancellation still comes back cancelled", async () => {
  const spy = spyTurn(async function* () {
    // Боевой /stop: eve успел сказать turn.cancelled, session.* не прислал, и связь
    // оборвалась — обрыв не имеет права отменить отмену.
    await delay(0);
    yield { type: "turn.cancelled" };
    throw new Error("stream reset by peer");
  }, "sess-broken");

  const turn = await runReminderTurn("долгая работа", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 1_000,
  });

  assert.equal(turn.cancelled, true, "отмену видно вызывающему и на обрыве");
  assert.equal(turn.status, "waiting");
  assert.deepEqual(spy.resets, ["Reminder finished"], "сессия погашена");
});

void test("the owner's stop ends the turn as cancelled, not as a failure", async () => {
  const { watch, calls } = watchSpy();
  const spy = spyTurn(async function* () {
    // Ровно это eve шлёт ходу, который погасили снаружи: turn.cancelled → session.waiting.
    await delay(0);
    yield { type: "turn.cancelled" };
    yield { type: "session.waiting" };
  }, "sess-cancel");

  const turn = await runReminderTurn("долгая работа", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 1_000,
    watch,
  });

  assert.equal(turn.status, "waiting");
  assert.equal(turn.cancelled, true, "отмену видно вызывающему");
  assert.equal(spy.cancelCount(), 0, "гасил владелец, а не сторож тишины");
  assert.deepEqual(
    calls.released,
    ["sess-cancel"],
    "запись снята и после отмены",
  );
});

// Запрос лимита сессии eve ровно в той форме, в какой его шлёт стрим
// (eve/dist/src/harness/session-limit-continuation.js): вопрос «Approve/Stop» к человеку.
const SESSION_LIMIT_REQUESTED: TurnStreamEvent = {
  type: "input.requested",
  data: {
    requests: [
      {
        kind: "session-limit",
        requestId: "sess-limit:limit:input:40064924",
        display: "confirmation",
        options: [
          { id: "continue", label: "Approve" },
          { id: "stop", label: "Stop" },
        ],
      },
    ],
    sequence: 1424,
    stepIndex: 712,
    turnId: "turn-1",
  },
};

void test("a turn parked on the eve session limit fails with the reason, not the stale step text", async () => {
  const { watch, calls } = watchSpy();
  const spy = spyTurn(async function* (cancelled) {
    await delay(0);
    yield { type: "message.completed", data: { message: "текст шага 6" } };
    yield SESSION_LIMIT_REQUESTED;
    // Дальше eve молчит: ход стоит на вопросе, который в фоне некому показать. Ждать
    // сторожа тишины нельзя — окно ниже на порядок длиннее теста.
    await Promise.race([cancelled, delay(5_000)]);
    yield { type: "turn.completed" };
    yield { type: "session.waiting" };
  }, "sess-limit");

  const started = Date.now();
  const turn = await runReminderTurn("долгая работа", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 60_000,
    watch,
    log: () => {},
  });

  assert.ok(Date.now() - started < 2_000, "ход не ждёт тишины после вопроса");
  assert.equal(turn.status, "failed");
  assert.equal(turn.sessionLimit, true);
  assert.equal(turn.cancelled, false);
  assert.match(turn.message ?? "", /session token limit/u);
  assert.doesNotMatch(turn.message ?? "", /текст шага 6/u);
  assert.deepEqual(
    spy.sessionCalls,
    ["cancel tasks=true", "reset"],
    "ход гасится с задачами, как у сводки, и только потом сессия снимается",
  );
  assert.deepEqual(calls.released, ["sess-limit"]);
});

void test("a failed stop of the parked turn keeps the honest failure and still resets", async () => {
  const logged: unknown[][] = [];
  const spy = spyTurn(
    async function* () {
      await delay(0);
      yield SESSION_LIMIT_REQUESTED;
      yield { type: "turn.completed" };
      yield { type: "session.waiting" };
    },
    "sess-limit-down",
    () => Promise.reject(new Error("eve is down")),
  );

  const turn = await runReminderTurn("долгая работа", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 1_000,
    log: (...args) => logged.push(args),
  });

  assert.equal(turn.status, "failed");
  assert.equal(turn.sessionLimit, true);
  assert.deepEqual(spy.sessionCalls, ["cancel tasks=true", "reset"]);
  assert.ok(
    logged.some((line) =>
      /session-limit turn cancel failed/u.test(String(line[0])),
    ),
    "отказ остановки виден в журнале",
  );
});

void test("another input request is not the session limit: the turn ends as before", async () => {
  const spy = spyTurn(async function* () {
    await delay(0);
    yield {
      type: "input.requested",
      data: { requests: [{ kind: "approval", requestId: "r-1" }] },
    };
    yield { type: "message.completed", data: { message: "готово" } };
    yield { type: "session.waiting" };
  }, "sess-ask");

  const turn = await runReminderTurn("долгая работа", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 1_000,
  });

  assert.equal(turn.status, "waiting");
  assert.equal(turn.sessionLimit, undefined);
  assert.equal(turn.message, "готово");
  assert.deepEqual(spy.sessionCalls, ["reset"], "чужой вопрос ход не гасит");
});

void test("the owner's stop before the limit question stays a cancellation", async () => {
  const spy = spyTurn(async function* () {
    await delay(0);
    yield { type: "turn.cancelled" };
    yield SESSION_LIMIT_REQUESTED;
    yield { type: "session.waiting" };
  }, "sess-stop-limit");

  const turn = await runReminderTurn("долгая работа", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 1_000,
  });

  assert.equal(
    turn.cancelled,
    true,
    "владелец погасил ход сам — текста не ждут",
  );
  assert.notEqual(turn.status, "failed");
  assert.deepEqual(spy.sessionCalls, ["reset"]);
});

// ── Вид хода (D1): заголовок x-iva-turn на проводе и одно место списка ─────────────────────

const { REMINDER_TURN_KINDS, reminderClientOptions } =
  await import("./reminder-turn.ts");
const { TURN_KINDS } = await import("#lib/eve-auth.ts");

void test("the turn kinds of the turn and of the bearer auth are one list", () => {
  assert.deepEqual(
    [...TURN_KINDS].sort(),
    [...REMINDER_TURN_KINDS].sort(),
    "agent/lib/eve-auth.ts keeps a copy: agent/ does not import scripts/",
  );
});

/** Заголовки запросов настоящего eve Client: ответ сервера — отказ, ход падает на create. */
async function wireHeaders(
  options: ReminderClientOptions,
  t: import("node:test").TestContext,
): Promise<Headers[]> {
  const seen: Headers[] = [];
  t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return Promise.resolve(new Response("nope", { status: 503 }));
  });
  await failureOf(runReminderTurn("инсайт", options, { log: () => {} }));
  return seen;
}

void test("on the wire: the session create carries x-iva-turn with the kind, and no header without one", async (t) => {
  const env = { ASSISTANT_BEARER: "secret", IVA_PORT: "8723" };
  const named = await wireHeaders(reminderClientOptions(env, "insight"), t);
  assert.ok(named.length > 0, "the client went to the wire");
  for (const headers of named) {
    assert.equal(headers.get("x-iva-turn"), "insight");
    assert.equal(headers.get("authorization"), "Bearer secret");
  }
  t.mock.restoreAll();
  const plain = await wireHeaders(reminderClientOptions(env), t);
  assert.ok(plain.length > 0);
  for (const headers of plain) assert.equal(headers.get("x-iva-turn"), null);
});

// ── Срок хода (D2): сигнал тика гасит ход на сервере с задачами и сбрасывает сессию ────────

const DEADLINE = "the turn ran past its deadline";

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

type DeadlineSpy = {
  readonly createClient: CreateClient;
  readonly calls: string[];
  /** Отпускает висящий create: сессия «возвращается позже». */
  readonly releaseCreate: () => void;
};

/**
 * Клиент с управляемыми частями: create может висеть, стрим молчит до отмены, cancel и reset
 * могут висеть или отказывать. `calls` — всё, что ход попросил у eve, по порядку.
 */
function deadlineClient(
  over: {
    readonly createHangs?: boolean;
    /** Ход кончается сам границей session.waiting, без отмены. */
    readonly ends?: boolean;
    readonly onCreate?: () => void;
    readonly cancel?: () => Promise<unknown>;
    readonly reset?: () => Promise<unknown>;
    readonly events?: readonly TurnStreamEvent[];
  } = {},
): DeadlineSpy {
  const calls: string[] = [];
  let releaseCreate = (): void => {};
  let stop = (): void => {};
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  async function* stream(): AsyncGenerator<TurnStreamEvent> {
    for (const event of over.events ?? []) {
      await flush();
      yield event;
    }
    if (over.ends) {
      yield { type: "session.waiting" };
      return;
    }
    await stopped;
    yield { type: "turn.cancelled" };
    yield { type: "session.waiting" };
  }
  const created = () => ({
    response: Object.assign(stream(), {
      cancel: () => {
        calls.push("response.cancel");
        return Promise.resolve();
      },
      sessionId: "sess-deadline",
    }),
    session: {
      send: () => Promise.resolve(),
      cancel: (options: { readonly tasks: boolean }) => {
        calls.push(`cancel tasks=${String(options.tasks)}`);
        stop();
        return over.cancel ? over.cancel() : Promise.resolve();
      },
      reset: () => {
        calls.push("reset");
        return over.reset ? over.reset() : Promise.resolve();
      },
    },
  });
  const client: ReminderClient = {
    sessions: {
      create: () => {
        calls.push("create");
        over.onCreate?.();
        if (!over.createHangs) return Promise.resolve(created());
        return new Promise((resolve) => {
          releaseCreate = () => resolve(created());
        });
      },
    },
  };
  return {
    createClient: () => {
      calls.push("client");
      return Promise.resolve(client);
    },
    calls,
    releaseCreate: () => releaseCreate(),
  };
}

void test("a deadline in the middle of a turn: cancel with tasks once, reset once, the turn fails with the reason", async () => {
  const spy = deadlineClient({
    events: [
      { type: "step.started" },
      { type: "message.completed", data: { message: "полдела" } },
    ],
  });
  const controller = new AbortController();
  const running = runReminderTurn("инсайт", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 60_000,
    signal: controller.signal,
    log: () => {},
  });
  await delay(20);
  controller.abort();
  const turn = await running;
  assert.equal(turn.status, "failed");
  assert.equal(turn.cancelled, false);
  assert.equal(turn.message, DEADLINE);
  assert.deepEqual(
    spy.calls.filter((call) => call !== "client" && call !== "create"),
    ["cancel tasks=true", "reset"],
  );
});

void test("a signal already aborted: no client and no session at all", async () => {
  const spy = deadlineClient();
  const controller = new AbortController();
  controller.abort();
  const turn = await runReminderTurn("инсайт", OPTIONS, {
    createClient: spy.createClient,
    signal: controller.signal,
  });
  assert.equal(turn.status, "failed");
  assert.equal(turn.message, DEADLINE);
  assert.deepEqual(spy.calls, []);
});

void test(
  "a deadline while create hangs: the turn fails on time; the session that comes back later is cancelled and reset",
  { timeout: 10_000 },
  async () => {
    const spy = deadlineClient({ createHangs: true });
    const controller = new AbortController();
    const running = runReminderTurn("инсайт", OPTIONS, {
      createClient: spy.createClient,
      signal: controller.signal,
      log: () => {},
    });
    await flush();
    controller.abort();
    const turn = await running;
    assert.equal(turn.message, DEADLINE);
    assert.deepEqual(spy.calls, ["client", "create"]);
    spy.releaseCreate();
    await delay(10);
    assert.deepEqual(spy.calls, [
      "client",
      "create",
      "cancel tasks=true",
      "reset",
    ]);
  },
);

void test("create comes back with the signal already aborted: cancel with tasks, reset, failed", async () => {
  const controller = new AbortController();
  const spy = deadlineClient({ onCreate: () => controller.abort() });
  const turn = await runReminderTurn("инсайт", OPTIONS, {
    createClient: spy.createClient,
    signal: controller.signal,
    log: () => {},
  });
  assert.equal(turn.message, DEADLINE);
  assert.deepEqual(spy.calls, [
    "client",
    "create",
    "cancel tasks=true",
    "reset",
  ]);
});

void test("a failed stop on the deadline is logged as a deadline cancel, not as the session limit", async () => {
  const logged: string[] = [];
  const controller = new AbortController();
  const spy = deadlineClient({
    cancel: () => Promise.reject(new Error("eve is down")),
  });
  const running = runReminderTurn("инсайт", OPTIONS, {
    createClient: spy.createClient,
    signal: controller.signal,
    log: (...args) => logged.push(String(args[0])),
  });
  await delay(10);
  controller.abort();
  const turn = await running;
  assert.equal(turn.message, DEADLINE);
  assert.ok(spy.calls.includes("reset"), "the session is reset anyway");
  assert.deepEqual(logged, ["remind: deadline turn cancel failed:"]);
});

void test("after the deadline a hanging cancel and a hanging reset each wait 30 s, no longer (clock pinned)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logged: string[] = [];
  const hang = () => new Promise<never>(() => {});
  const controller = new AbortController();
  const spy = deadlineClient({ cancel: hang, reset: hang });
  let done = false;
  const running = runReminderTurn("инсайт", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 600_000,
    signal: controller.signal,
    log: (...args) => logged.push(String(args[0])),
  }).finally(() => {
    done = true;
  });
  for (let i = 0; i < 5; i += 1) await flush();
  controller.abort();
  for (let i = 0; i < 5; i += 1) await flush();
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(done, false, "cancel still has its window");
  t.mock.timers.tick(1);
  for (let i = 0; i < 5; i += 1) await flush();
  assert.deepEqual(logged, ["remind: deadline turn cancel failed:"]);
  assert.equal(done, false, "reset has its own window");
  t.mock.timers.tick(30_000);
  for (let i = 0; i < 5; i += 1) await flush();
  assert.equal(done, true);
  const turn = await running;
  assert.equal(turn.message, DEADLINE);
  assert.deepEqual(
    spy.calls.filter((call) => call !== "client" && call !== "create"),
    ["cancel tasks=true", "reset"],
  );
});

// Ход кончился до срока, а reset повис: срок, пришедший во время reset, ограничивает и его
// (таймлайн 3.2.2: finally тика снимает замок до SIGTERM).
void test("a reset begun before the deadline waits 30 s after the deadline, no longer (clock pinned)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const spy = deadlineClient({
    ends: true,
    events: [{ type: "message.completed", data: { message: "готово" } }],
    reset: () => new Promise<never>(() => {}),
  });
  let done = false;
  const running = runReminderTurn("инсайт", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 600_000,
    signal: controller.signal,
    log: () => {},
  }).finally(() => {
    done = true;
  });
  for (let i = 0; i < 10; i += 1) await flush();
  assert.ok(spy.calls.includes("reset"), "the turn ended and reset began");
  assert.equal(done, false, "reset hangs");
  controller.abort();
  for (let i = 0; i < 5; i += 1) await flush();
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(done, false, "reset still has its window");
  t.mock.timers.tick(1);
  for (let i = 0; i < 5; i += 1) await flush();
  assert.equal(done, true);
  const turn = await running;
  assert.equal(turn.message, "готово", "the turn's own text stays");
});

const { settleLateTurns } = await import("./reminder-turn.ts");

void test(
  "before the run exits, a session that came back after the deadline is cancelled and reset",
  { timeout: 10_000 },
  async () => {
    const spy = deadlineClient({ createHangs: true });
    const controller = new AbortController();
    const running = runReminderTurn("инсайт", OPTIONS, {
      createClient: spy.createClient,
      signal: controller.signal,
      log: () => {},
    });
    await flush();
    controller.abort();
    assert.equal((await running).message, DEADLINE);
    let settled = false;
    const settling = settleLateTurns(60_000).then(() => {
      settled = true;
    });
    await delay(10);
    assert.equal(settled, false, "create has not come back yet");
    spy.releaseCreate();
    await settling;
    assert.deepEqual(spy.calls.slice(2), ["cancel tasks=true", "reset"]);
    await settleLateTurns(60_000);
  },
);

void test("waiting for late sessions ends at its cap even when create never comes back (clock pinned)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const spy = deadlineClient({ createHangs: true });
  const controller = new AbortController();
  const running = runReminderTurn("инсайт", OPTIONS, {
    createClient: spy.createClient,
    signal: controller.signal,
    log: () => {},
  });
  await flush();
  controller.abort();
  await running;
  let settled = false;
  const settling = settleLateTurns(60_000).then(() => {
    settled = true;
  });
  for (let i = 0; i < 5; i += 1) await flush();
  t.mock.timers.tick(59_999);
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await settling;
  assert.deepEqual(spy.calls, ["client", "create"]);
});

const requestedTool = (
  callId: string,
  timeoutMs = 240_000,
): TurnStreamEvent => ({
  type: "actions.requested",
  data: {
    actions: [
      { kind: "tool-call", callId, toolName: "bash", input: { timeoutMs } },
    ],
  },
});
const toolResult = (callId: string): TurnStreamEvent => ({
  type: "action.result",
  data: { result: { callId } },
});
const drainEvents = async () => {
  for (let i = 0; i < 12; i += 1) await flush();
};

void test("tool timeouts above the bash maximum use 120 seconds (seed=20261021)", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(
        fc.constant(9e15),
        fc.integer({ min: 2_147_483_648, max: Number.MAX_SAFE_INTEGER }),
      ),
      async (timeout) => {
        const controller = new AbortController();
        const spy = spyTurn(async function* (cancelled) {
          yield requestedTool("oversized", timeout);
          await cancelled;
        });
        const outcome = runReminderTurn("oversized", OPTIONS, {
          createClient: spy.createClient,
          signal: controller.signal,
        }).catch((error: unknown) => error);
        try {
          await drainEvents();
          t.mock.timers.tick(299_999);
          await drainEvents();
          assert.deepEqual(spy.sessionCalls, []);
          t.mock.timers.tick(1);
          await drainEvents();
          assert.deepEqual(spy.sessionCalls, ["cancel tasks=true", "reset"]);
          assert.ok((await outcome) instanceof ReminderTurnError);
        } finally {
          controller.abort();
          await outcome;
        }
      },
    ),
    { seed: 20261021, numRuns: 50, examples: [[2_147_483_648], [9e15]] },
  );
});

for (const { name, event, waitMs } of [
  {
    name: "missing actions",
    event: { type: "actions.requested", data: {} },
    waitMs: 180_000,
  },
  {
    name: "missing tool input",
    event: {
      type: "actions.requested",
      data: {
        actions: [{ kind: "tool-call", callId: "no-input", toolName: "bash" }],
      },
    },
    waitMs: 300_000,
  },
]) {
  void test(`tool events with ${name} retain the default silence deadline`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const spy = spyTurn(async function* (cancelled) {
      yield event;
      await cancelled;
    });
    const outcome = runReminderTurn(name, OPTIONS, {
      createClient: spy.createClient,
    }).catch((error: unknown) => error);
    await drainEvents();
    t.mock.timers.tick(waitMs - 1);
    await drainEvents();
    assert.deepEqual(spy.sessionCalls, []);
    t.mock.timers.tick(1);
    assert.ok((await outcome) instanceof ReminderTurnError);
    assert.deepEqual(spy.sessionCalls, ["cancel tasks=true", "reset"]);
  });
}

void test("a four-minute command returns the reminder result after the ordinary silence window", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let finish = () => {};
  const command = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const spy = spyTurn(async function* () {
    yield requestedTool("long");
    await command;
    yield toolResult("long");
    yield {
      type: "message.completed",
      data: { message: "command result delivered" },
    };
    yield { type: "session.waiting" };
  });
  const running = runReminderTurn("four minutes", OPTIONS, {
    createClient: spy.createClient,
  });
  const outcome = running.catch((error: unknown) => error);
  await drainEvents();
  t.mock.timers.tick(240_000);
  await drainEvents();
  assert.deepEqual(spy.sessionCalls, [], "the command still owns its timeout");
  finish();
  const turn = await outcome;
  assert.ok(!(turn instanceof Error));
  assert.equal(
    (turn as { message: string }).message,
    "command result delivered",
  );
  assert.deepEqual(spy.sessionCalls, ["reset"]);
});

void test("a tool that never returns is cancelled at its timeout plus the silence grace", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const spy = spyTurn(async function* (cancelled) {
    yield requestedTool("hung");
    await cancelled;
  });
  const outcome = runReminderTurn("hung", OPTIONS, {
    createClient: spy.createClient,
  }).catch((error: unknown) => error);
  await drainEvents();
  t.mock.timers.tick(419_999);
  await drainEvents();
  assert.deepEqual(spy.sessionCalls, []);
  t.mock.timers.tick(1);
  assert.ok((await outcome) instanceof ReminderTurnError);
  assert.deepEqual(spy.sessionCalls, ["cancel tasks=true", "reset"]);
});

void test("a result removes only its callId; after all results the ordinary silence window applies", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let finish = () => {};
  const command = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const spy = spyTurn(async function* (cancelled) {
    yield requestedTool("long");
    yield requestedTool("short", 100);
    yield toolResult("short");
    yield toolResult("unknown");
    await command;
    yield toolResult("long");
    await cancelled;
  });
  const outcome = runReminderTurn("parallel", OPTIONS, {
    createClient: spy.createClient,
  }).catch((error: unknown) => error);
  await drainEvents();
  t.mock.timers.tick(240_000);
  await drainEvents();
  assert.deepEqual(spy.sessionCalls, []);
  finish();
  await drainEvents();
  t.mock.timers.tick(179_999);
  await drainEvents();
  assert.deepEqual(spy.sessionCalls, []);
  t.mock.timers.tick(1);
  assert.ok((await outcome) instanceof ReminderTurnError);
});

void test("the job deadline cancels a tool even while its command timeout is running", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const controller = new AbortController();
  const spy = spyTurn(async function* (cancelled) {
    yield requestedTool("long");
    await cancelled;
  });
  const running = runReminderTurn("deadline", OPTIONS, {
    createClient: spy.createClient,
    signal: controller.signal,
  });
  await drainEvents();
  controller.abort();
  assert.equal((await running).message, DEADLINE);
  assert.deepEqual(spy.sessionCalls, ["cancel tasks=true", "reset"]);
});

void test("tool deadlines preserve random timeouts, duplicate calls and timer overflow (seed=20261020)", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(
        fc.integer({ min: 100, max: 500_000 }),
        fc.constant(2_147_483_647),
      ),
      async (timeout) => {
        const spy = spyTurn(async function* (cancelled) {
          yield requestedTool("same", timeout);
          yield requestedTool("same", timeout * 2);
          await cancelled;
        });
        const outcome = runReminderTurn("property", OPTIONS, {
          createClient: spy.createClient,
        }).catch((error: unknown) => error);
        await drainEvents();
        t.mock.timers.tick(timeout);
        await drainEvents();
        assert.deepEqual(spy.sessionCalls, []);
        t.mock.timers.tick(179_999);
        await drainEvents();
        assert.deepEqual(spy.sessionCalls, []);
        t.mock.timers.tick(1);
        assert.ok((await outcome) instanceof ReminderTurnError);
      },
    ),
    { seed: 20261020, numRuns: 50 },
  );
});

// Лиза, 03.11.2026: «no Telegram tools» модель прочла как запрет и на чтение, сводка вышла без чатов.
// Промпт держит обе половины: запись в Telegram запрещена, чтение через telegram-userbot разрешено.
void test("reminder prompt forbids Telegram writes and allows Telegram reads", async () => {
  const { reminderPrompt } = await import("./reminder-turn.ts");
  const prompt = reminderPrompt({ text: "начало дня" }, (en) => en);
  assert.match(prompt, /Do not send anything yourself/u);
  assert.match(
    prompt,
    /no Telegram tool that writes \(send, reply, forward, edit, delete, react, mark read\)/u,
  );
  assert.match(
    prompt,
    /Reading Telegram with the read-only tools of telegram-userbot/u,
  );
  assert.doesNotMatch(prompt, /no Telegram tools/u);
});
