// Соответствие кода модели specs/ReminderLifecycle.tla: каждый тест называет инвариант модели и
// проигрывает на настоящих сторе, тике и ребёнке порядок шагов, которым его ломает мутант
// модели. «Жизнь агента» — своя память тика (TickMemory): в ней тик держит идущих детей.
// «Падение агента» — тик с dispatchOnly и ребёнком, который не возвращается, после чего его
// память выбрасывается вместе с продолжением; «перезапуск» — следующий тик со свежей памятью.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { tempDir } from "../fixtures/temp-dir.ts";
import type {
  RunScheduledJobOptions,
  RunScheduledJobResult,
} from "#lib/schedule-runner.ts";
import type { Reminder } from "#lib/reminder-store.ts";

const root = tempDir("iva-reminder-lifecycle-");
process.env.ASSISTANT_DATA_DIR = root;

const {
  REMINDER_ABANDONED,
  REMINDER_FIRED_KEEP_MS,
  add,
  closeAbandoned,
  commandFile,
  fireDue,
  list,
  recordDelivery,
  reminderPhase,
  sweepFired,
} = await import("#lib/reminder-store.ts");
const { runReminderTick } = await import("#lib/reminder-tick.ts");
const { describeReminder } = await import("#lib/reminder-tool.ts");
const { RUN_STALE_MS, setChatStatus } = await import("#lib/run-status.ts");
const { sendTelegramHtml } = await import("../lib/telegram-send.ts");
const { runReminderFire } = await import("./fire.ts");
const { runCommandFire } = await import("./command.ts");

beforeEach(() => {
  process.env.ASSISTANT_DATA_DIR = mkdtempSync(join(root, "case-"));
});

const MINUTE = 60_000;
const TEXT = "позвонить маме";

const done: RunScheduledJobResult = {
  skipped: false,
  ok: true,
  code: 0,
  signal: null,
};
/** Ребёнок, который не возвращается: агент упал, и исход за него дописать некому. */
const never = (): Promise<RunScheduledJobResult> => new Promise(() => {});

function jobs(
  run: (argv: string[]) => Promise<RunScheduledJobResult> = () =>
    Promise.resolve(done),
) {
  const calls: string[][] = [];
  const runJob = (options: RunScheduledJobOptions) => {
    calls.push([...options.argv]);
    return run([...options.argv]);
  };
  return { calls, runJob };
}

const quiet = () => {};

/** Память тика одного процесса агента: новая — перезапуск. */
const life = () => ({ firing: new Set<string>(), alerting: new Set<string>() });

/** Ребёнок, которого тик запускает по-настоящему: и срабатывание, и Alert. */
const realChild =
  (deps: ReturnType<typeof fireDeps>) =>
  async ([, id, mode]: string[]): Promise<RunScheduledJobResult> => ({
    ...done,
    code: await runReminderFire(id, deps, mode),
  });

/** Двойник отправки: всё, что ушло в чат. */
function chat() {
  const texts: string[] = [];
  const send = (_bot: string, _chat: string, text: unknown) => {
    texts.push(String(text));
    return Promise.resolve({ ok: true, fellBack: false, error: "" });
  };
  return { texts, send };
}

const fireDeps = (send: ReturnType<typeof chat>["send"]) => ({
  env: {
    TELEGRAM_BOT_TOKEN: "bot-token",
    ASSISTANT_BEARER: "test-bearer",
  } as NodeJS.ProcessEnv,
  chat: () => "555",
  translator: () => Promise.resolve((_en: string, ru: string) => ru),
  runTurn: () =>
    Promise.resolve({
      status: "completed" as const,
      message: TEXT,
      feedback: () => Promise.resolve(undefined),
    }),
  log: quiet,
  send,
});

const once = (now: number, id = "lost") =>
  add({ id, text: TEXT, schedule: { kind: "at", atMs: now - MINUTE } });

/** Тик взял строку, и агент упал до записи исхода: его память пропала вместе с ним. */
async function takenThenCrash(now: number): Promise<void> {
  const first = await runReminderTick({
    nowMs: now,
    dispatchOnly: true,
    runJob: jobs(never).runJob,
    log: quiet,
    memory: life(),
  });
  assert.equal(first.claimed, 1);
}

void test("ReminderLifecycle BoundedOutcome: строка, взятая перед падением агента, после перезапуска получает исход, и владельцу уходит Alert", async () => {
  const now = Date.now();
  await once(now);
  await takenThenCrash(now);
  const [taken] = await list();
  assert.deepEqual(
    [taken?.status, taken?.delivered, taken?.error],
    ["fired", null, null],
  );

  // Перезапуск: до срока жизни срабатывания строка ещё «идёт», после — закрыта.
  const early = jobs();
  await runReminderTick({
    nowMs: now + RUN_STALE_MS - MINUTE,
    runJob: early.runJob,
    log: quiet,
  });
  assert.deepEqual(early.calls, []);
  assert.equal((await list())[0]?.error, null);

  const restarted = jobs();
  await runReminderTick({
    nowMs: now + RUN_STALE_MS + MINUTE,
    runJob: restarted.runJob,
    log: quiet,
  });
  const [closed] = await list();
  assert.ok(closed, "строка убрана без исхода");
  assert.equal(closed.delivered, null, "факта доставки нет: текст мог уйти");
  assert.equal(closed.error, REMINDER_ABANDONED);
  assert.deepEqual(restarted.calls, [
    ["scripts/reminders/fire.ts", "lost", "abandoned"],
  ]);
});

void test("ReminderLifecycle OneAttemptPerCapture: текст ушёл, ребёнок умер до записи факта — после перезапуска текст второй раз не уходит, уходит Alert", async () => {
  const now = Date.now();
  await once(now);
  const { texts, send } = chat();

  // Ребёнок отправил текст и умер до записи факта; агент упал вместе с ним.
  await runReminderTick({
    nowMs: now,
    dispatchOnly: true,
    runJob: jobs(async ([, id]) => {
      await runReminderFire(id, {
        ...fireDeps(send),
        recordDelivery: () => new Promise(() => {}),
      });
      return done;
    }).runJob,
    log: quiet,
    memory: life(),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(texts, [TEXT]);
  assert.equal((await list())[0]?.delivered, null);

  // Перезапуск после срока жизни: тик закрывает строку, ребёнок шлёт Alert.
  await runReminderTick({
    nowMs: now + RUN_STALE_MS + MINUTE,
    runJob: jobs(async ([, id, mode]) => ({
      ...done,
      code: await runReminderFire(id, fireDeps(send), mode),
    })).runJob,
    log: quiet,
  });
  assert.equal(texts.length, 2);
  assert.equal(
    texts.filter((text) => text === TEXT).length,
    1,
    "текст напоминания ушёл второй раз",
  );
  assert.match(texts[1], /^Напоминание «позвонить маме» на .+ могло не дойти/u);
  // Ребёнок с Alert в таблицу не пишет: причину записал тик.
  assert.deepEqual(
    [(await list())[0]?.delivered, (await list())[0]?.error],
    [null, REMINDER_ABANDONED],
  );
});

void test("ReminderLifecycle AlertOnce: закрытую строку следующий тик не закрывает, а после записанного факта Alert не повторяет", async () => {
  const now = Date.now();
  await once(now);
  await takenThenCrash(now);
  const later = now + RUN_STALE_MS + MINUTE;
  assert.equal((await closeAbandoned(later)).length, 1);
  assert.deepEqual(await closeAbandoned(later + MINUTE), []);
  const { texts, send } = chat();
  const first = jobs(realChild(fireDeps(send)));
  await runReminderTick({
    nowMs: later + MINUTE,
    runJob: first.runJob,
    log: quiet,
  });
  assert.deepEqual(first.calls, [
    ["scripts/reminders/fire.ts", "lost", "abandoned"],
  ]);
  assert.equal(texts.length, 1);
  // Факт «Alert отправлен» в дросселе: ни тик, ни перезапуск больше не зовут ребёнка с Alert.
  for (const memory of [undefined, life()]) {
    const next = jobs();
    await runReminderTick({
      nowMs: later + 2 * MINUTE,
      runJob: next.runJob,
      log: quiet,
      memory,
    });
    assert.deepEqual(next.calls, []);
  }
  // Ребёнок, позванный повторно, тоже молчит: факт уже есть.
  assert.equal(await runReminderFire("lost", fireDeps(send), "abandoned"), 0);
  assert.equal(texts.length, 1);
});

void test("ReminderLifecycle AbandonedAlerted: агент упал между записью причины и ребёнком с Alert — после перезапуска Alert уходит, и один", async () => {
  const now = Date.now();
  await once(now);
  await takenThenCrash(now);
  // Причина записана, ребёнок с Alert не запущен: агент упал сразу после closeAbandoned.
  assert.equal((await closeAbandoned(now + RUN_STALE_MS + MINUTE)).length, 1);

  const { texts, send } = chat();
  const refused = jobs(
    realChild({
      ...fireDeps(send),
      send: () =>
        Promise.resolve({
          ok: false,
          fellBack: false,
          error: "502: Bad Gateway",
        }),
    }),
  );
  const at = now + RUN_STALE_MS + 2 * MINUTE;
  await runReminderTick({
    nowMs: at,
    runJob: refused.runJob,
    log: quiet,
    memory: life(),
  });
  assert.deepEqual(refused.calls, [
    ["scripts/reminders/fire.ts", "lost", "abandoned"],
  ]);

  // Telegram отказал: факта нет, следующий проход зовёт ребёнка снова.
  const retried = jobs(realChild(fireDeps(send)));
  await runReminderTick({
    nowMs: at + MINUTE,
    runJob: retried.runJob,
    log: quiet,
  });
  assert.deepEqual(retried.calls, [
    ["scripts/reminders/fire.ts", "lost", "abandoned"],
  ]);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /могло не дойти/u);

  const after = jobs();
  await runReminderTick({
    nowMs: at + 2 * MINUTE,
    runJob: after.runJob,
    log: quiet,
  });
  assert.deepEqual(after.calls, []);
});

void test("ReminderLifecycle NoFalseAlert: чат занят ходом владельца, ребёнок напоминания жив без пульса — срок жизни его не закрывает, Alert не уходит", async () => {
  const now = Date.now();
  await once(now);
  setChatStatus("555:", { status: "running", sessionId: "owner-turn" });
  let release: (turn: {
    status: "completed";
    message: string;
  }) => void = () => {};
  const held = new Promise<{ status: "completed"; message: string }>(
    (resolve) => (release = resolve),
  );
  let claimed: boolean | undefined;
  let turns = 0;
  const { texts, send } = chat();
  const deps = {
    ...fireDeps(send),
    runTurn: async (
      _prompt: string,
      _client: unknown,
      { watch }: { watch: { claim: (id: string) => Promise<boolean> } },
    ) => {
      turns += 1;
      claimed = await watch.claim("reminder-turn");
      return held;
    },
  } as unknown as ReturnType<typeof fireDeps>;
  const memory = life();
  const first = await runReminderTick({
    nowMs: now,
    dispatchOnly: true,
    runJob: jobs(realChild(deps)).runJob,
    log: quiet,
    memory,
  });
  assert.equal(first.claimed, 1);
  while (claimed === undefined)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(claimed, false, "чат занят: пульса у хода нет");

  const late = jobs();
  await runReminderTick({
    nowMs: now + RUN_STALE_MS + MINUTE,
    runJob: late.runJob,
    log: quiet,
    memory,
  });
  assert.deepEqual(late.calls, [], "живое срабатывание закрыто сроком");
  assert.equal((await list())[0]?.error, null);

  release({ status: "completed", message: TEXT });
  while ((await list())[0]?.delivered === null)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.deepEqual(texts, [TEXT]);
  assert.equal(turns, 1);
  const [row] = await list();
  assert.deepEqual([row?.delivered, row?.error], [true, null]);
  const after = jobs();
  await runReminderTick({
    nowMs: now + RUN_STALE_MS + 2 * MINUTE,
    runJob: after.runJob,
    log: quiet,
    memory,
  });
  assert.deepEqual(after.calls, []);
});

void test("ReminderLifecycle NoFalseAlert: опоздавший факт доставки, записанный до ребёнка с Alert, снимает Alert", async () => {
  const now = Date.now();
  await once(now);
  await takenThenCrash(now);
  const [taken] = await list();
  assert.equal((await closeAbandoned(now + RUN_STALE_MS + MINUTE)).length, 1);
  // Ребёнок, переживший агента, успел записать факт.
  await recordDelivery("lost", {
    firedAt: taken?.firedAt ?? null,
    delivered: true,
    error: null,
  });
  const { texts, send } = chat();
  assert.equal(await runReminderFire("lost", fireDeps(send), "abandoned"), 0);
  assert.deepEqual(texts, []);
  const next = jobs();
  await runReminderTick({
    nowMs: now + RUN_STALE_MS + 2 * MINUTE,
    runJob: next.runJob,
    log: quiet,
  });
  assert.deepEqual(next.calls, []);
});

/** Telegram принимает каждое сообщение, а ответ на первое теряется. */
function lostFirstAnswer() {
  let accepted = 0;
  const send: typeof sendTelegramHtml = (bot, target, text, options) =>
    sendTelegramHtml(bot, target, text, {
      ...options,
      sleep: () => Promise.resolve(),
      fetchImpl: () => {
        accepted += 1;
        if (accepted === 1)
          return Promise.reject(
            new TypeError("response lost after acceptance"),
          );
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });
  return { send, accepted: () => accepted };
}

void test("ReminderLifecycle OneAttemptPerCapture: ответ Telegram потерян после принятия — транспорт шлёт тот же текст ещё раз, второго хода нет", async () => {
  const now = Date.now();
  await once(now);
  await fireDue(now, 5);
  const wire = lostFirstAnswer();
  let turns = 0;
  const deps = {
    ...fireDeps(chat().send),
    send: wire.send,
    runTurn: () => {
      turns += 1;
      return Promise.resolve({
        status: "completed" as const,
        message: TEXT,
        feedback: () => Promise.resolve(undefined),
      });
    },
  };
  assert.equal(await runReminderFire("lost", deps), 0);
  assert.equal(turns, 1, "повтор транспорта запустил второй ход");
  assert.equal(
    wire.accepted(),
    2,
    "не меньше одного раза: повтор после потерянного ответа",
  );
  assert.equal((await list())[0]?.delivered, true);

  // Alert идёт тем же путём; факт записан один раз, тик его больше не зовёт.
  await once(now, "alert");
  await takenThenCrash(now);
  await closeAbandoned(now + RUN_STALE_MS + MINUTE);
  const alertWire = lostFirstAnswer();
  assert.equal(
    await runReminderFire(
      "alert",
      { ...fireDeps(chat().send), send: alertWire.send },
      "abandoned",
    ),
    0,
  );
  assert.equal(alertWire.accepted(), 2);
  const next = jobs();
  await runReminderTick({
    nowMs: now + RUN_STALE_MS + 2 * MINUTE,
    runJob: next.runJob,
    log: quiet,
  });
  assert.deepEqual(next.calls, []);
});

void test("ReminderLifecycle DeliveredOrReason: строку без исхода уборка не трогает — после суток простоя она сначала получает причину и Alert", async () => {
  const now = Date.now();
  await once(now);
  await takenThenCrash(now);
  const dayLater = now + REMINDER_FIRED_KEEP_MS + MINUTE;
  assert.equal(await sweepFired(dayLater), 0);

  const restarted = jobs(async ([, id, mode]) => {
    // Ребёнок с Alert читает строку: тик, закрывший её, её же не убрал.
    assert.equal((await list()).length, 1);
    return {
      ...done,
      code: await runReminderFire(id, fireDeps(chat().send), mode),
    };
  });
  const tick = await runReminderTick({
    nowMs: dayLater,
    runJob: restarted.runJob,
    log: quiet,
  });
  assert.equal(tick.swept, 0);
  assert.deepEqual(restarted.calls, [
    ["scripts/reminders/fire.ts", "lost", "abandoned"],
  ]);
  // Следующий тик убирает строку уже с исходом.
  const after = await runReminderTick({
    nowMs: dayLater + MINUTE,
    runJob: jobs().runJob,
    log: quiet,
  });
  assert.equal(after.swept, 1);
});

void test("ReminderLifecycle FactOfThisFiring: исход брошенного срабатывания Routine не ложится на следующее", async () => {
  const now = Date.UTC(2026, 9, 19, 3);
  await add({
    id: "daily",
    text: TEXT,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    nextRunAtMs: now,
  });
  await takenThenCrash(now);
  const hour = now + 60 * MINUTE;

  // Срок следующего срабатывания пришёл, прошлое без исхода: строку не берут, а закрывают.
  const closing = jobs();
  const closingTick = await runReminderTick({
    nowMs: hour,
    runJob: closing.runJob,
    log: quiet,
  });
  assert.equal(closingTick.claimed, 0);
  assert.deepEqual(closing.calls, [
    ["scripts/reminders/fire.ts", "daily", "abandoned"],
  ]);

  // Следующий тик берёт её на новый срок, и агент снова падает.
  await takenThenCrash(hour + MINUTE);
  const lines: string[] = [];
  await recordDelivery(
    "daily",
    { firedAt: now, delivered: true, error: null },
    { log: (...args) => lines.push(args.join(" ")) },
  );
  const [row] = await list();
  assert.equal(row?.firedAt, hour + MINUTE);
  assert.equal(row?.delivered, null, "факт старого срабатывания лёг на новое");
  assert.match(lines[0] ?? "", /ignored/u);
});

void test("ReminderLifecycle OncePerDue: один срок берут один раз — ни два тика разом, ни тик после исхода", async () => {
  const now = Date.UTC(2026, 9, 19, 3);
  await add({
    id: "daily",
    text: TEXT,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    nextRunAtMs: now,
  });
  const [a, b] = await Promise.all([fireDue(now, 5), fireDue(now, 5)]);
  assert.equal(a.length + b.length, 1);
  await recordDelivery("daily", { firedAt: now, delivered: true, error: null });
  assert.deepEqual(await fireDue(now + MINUTE, 5), []);
  assert.equal((await fireDue(now + 60 * MINUTE, 5)).length, 1);
});

void test("ReminderLifecycle: расписание-команда без исхода закрывается по своему сроку, владельцу уходит Alert, команда не выполняется заново", async () => {
  const now = Date.now();
  const file = commandFile();
  await add(
    {
      id: "c-lost",
      text: "touch should-not-run",
      schedule: { kind: "at", atMs: now - MINUTE },
    },
    { file },
  );
  await runReminderTick({
    command: true,
    nowMs: now,
    dispatchOnly: true,
    runJob: jobs(never).runJob,
    log: quiet,
    memory: life(),
  });
  const past = now + 2 * MINUTE + 10_000;
  const restarted = jobs();
  await runReminderTick({
    command: true,
    nowMs: past,
    runJob: restarted.runJob,
    log: quiet,
  });
  assert.deepEqual(restarted.calls, [
    ["scripts/reminders/command.ts", "c-lost", String(now), "abandoned"],
  ]);
  const [row] = await list(file);
  assert.deepEqual([row?.delivered, row?.error], [null, REMINDER_ABANDONED]);

  const { texts, send } = chat();
  process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "555";
  try {
    assert.equal(
      await runCommandFire("c-lost", { firedAt: now, abandoned: true, send }),
      0,
    );
  } finally {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  }
  assert.equal(texts.length, 1);
  assert.match(texts[0], /^Задача «touch should-not-run» осталась без исхода/u);
  // Факт Alert записан дросселем команд: ни следующий проход, ни перезапуск Alert не повторяют.
  const next = jobs();
  await runReminderTick({
    command: true,
    nowMs: past + MINUTE,
    runJob: next.runJob,
    log: quiet,
    memory: life(),
  });
  assert.deepEqual(next.calls, []);
});

void test("reminderPhase: одна фаза последнего срабатывания для тика, доктора и инструментов", () => {
  const now = 10_000_000_000;
  const row = (over: Partial<Reminder>): Reminder => ({
    id: "r",
    text: TEXT,
    chat: null,
    schedule: { kind: "at", atMs: now },
    nextRunAtMs: now,
    createdAt: now,
    status: "fired",
    firedAt: now,
    delivered: null,
    error: null,
    sessionId: null,
    ...over,
  });
  const cases: [Partial<Reminder>, number, string][] = [
    [{ status: "pending", firedAt: null }, now, "waiting"],
    [{}, now + RUN_STALE_MS - 1, "running"],
    [{}, now + RUN_STALE_MS, "abandoned"],
    [{ error: REMINDER_ABANDONED }, now, "abandoned"],
    [{ error: "delivery fact not recorded" }, now, "abandoned"],
    [{ delivered: true }, now + RUN_STALE_MS, "delivered"],
    [{ delivered: true, error: "agent turn failed: x" }, now, "delivered"],
    [{ delivered: false, error: "sendMessage 400" }, now, "failed"],
  ];
  for (const [over, at, phase] of cases)
    assert.equal(reminderPhase(row(over), at), phase, JSON.stringify(over));
  // Команда живёт свой срок, а не срок хода.
  assert.equal(
    reminderPhase(row({}), now + 2 * MINUTE + 9_999, true),
    "running",
  );
  assert.equal(
    reminderPhase(row({}), now + 2 * MINUTE + 10_000, true),
    "abandoned",
  );
  // remind list показывает ту же фазу словом.
  assert.equal(
    describeReminder(row({ delivered: false, error: "x" }), "UTC").phase,
    "failed",
  );
});
