// Соответствие кода модели specs/ChatRecord.tla: каждый тест назван инвариантом модели и
// проигрывает на настоящих писателях записи чата контрпример её мутанта. Писатели двух
// процессов (агент и Bridge) пишут в один временный каталог данных.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { tempDir } from "./fixtures/temp-dir.ts";

const dataDir = tempDir("iva-chat-record-");
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN ??= "test:token";
const records = await import("#lib/run-status.ts");
const turns = await import("#lib/telegram-turn-start.ts");
const { finishTelegramStatus } = await import("#lib/telegram-draft.ts");
const bridge = await import("./poller/queue.ts");
const { rewriteRunStatusesForUpdate } = await import("./lib/wf-store.ts");

const { chatState, getChatStatus, setChatStatusIf } = records;
const io = { getStatusImpl: getChatStatus, setStatusIfImpl: setChatStatusIf };
const STALE_MS = records.RUN_STALE_MS;
const fileOf = (chatKey: string) =>
  join(
    dataDir,
    "run-status.d",
    `${Buffer.from(chatKey).toString("base64url")}.json`,
  );
const rawOf = (chatKey: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileOf(chatKey), "utf8")) as Record<string, unknown>;
const channelOf = (chatKey: string) => ({
  telegram: {
    chatId: Number(chatKey.split(":")[0]),
    messageThreadId: undefined,
  },
});
let nextChat = 1000;
const freshChat = () => `${++nextChat}:`;

const startTurn = (chatKey: string, sessionId: string, turnId: string) =>
  turns.publishTelegramTurnStarted({
    chatKey,
    sessionId,
    turnId,
    draftId: 7,
    ...io,
  });
const finishTurn = (
  chatKey: string,
  sessionId: string,
  turnId?: string,
  keepBusy = false,
) =>
  finishTelegramStatus(
    channelOf(chatKey) as never,
    sessionId,
    "completed",
    turnId,
    keepBusy,
  );
// Жнец Bridge над одним чатом: остальные записи каталога этому тесту чужие.
const reap = (chatKey: string, at: number) =>
  bridge.reapStaleRuns({
    listStatusesImpl: () => [{ chatKey, status: getChatStatus(chatKey) }],
    now: () => at,
    resetImpl: () => Promise.resolve(),
    sendImpl: () => Promise.resolve(),
    inFlight: new Map(),
    logImpl: () => {},
  });

// Те же предикаты, что `Is` в модели: независимые, без старшинства веток.
function namedStates(raw: Record<string, unknown>, now: number): string[] {
  const running = raw.status === "running";
  const live =
    running &&
    typeof raw.updatedAt === "number" &&
    now - raw.updatedAt < STALE_MS;
  const noTurnFields = [
    "ingressId",
    "ingressAt",
    "sessionId",
    "turnId",
    "draftId",
    "turnAt",
    "firstOutputAt",
    "latencyLogged",
    "compacting",
  ].every((field) => raw[field] === undefined);
  const idle = !running && noTurnFields;
  const retire = raw.retireAfterTurn !== undefined;
  const retry = raw.restartRetryData !== undefined;
  const pending = raw.pendingInputSessionId !== undefined;
  const is: Record<string, boolean> = {
    free: idle && !retire && !retry && !pending,
    "awaiting-owner": idle && !retire && !retry && pending,
    "retry-offered": idle && !retire && retry,
    retiring: idle && retire,
    accepted:
      live &&
      raw.sessionId === undefined &&
      raw.ingressId !== undefined &&
      raw.turnId === undefined &&
      raw.compacting === undefined,
    turn: live && raw.sessionId !== undefined && raw.compacting === undefined,
    compacting:
      live &&
      raw.sessionId !== undefined &&
      raw.compacting === true &&
      raw.turnId === undefined,
    stale: running && !live,
  };
  return Object.keys(is).filter((name) => is[name]);
}

// Шаги писателей: каждый — настоящая функция своего процесса. `at` — часы шага.
type Step = (chatKey: string, at: number) => unknown;
// Сессии свои у каждого чата: хуки ищут запись по сессии среди всех чатов.
const session = (chatKey: string, n: 1 | 2) => `s${n}-${chatKey}`;
const steps: Record<string, Step> = {
  accept: (key, at) =>
    turns.publishTelegramEarlyStatus({ chatKey: key, now: () => at, ...io }),
  abandon: (key) => {
    const ingressId = getChatStatus(key)?.ingressId;
    return ingressId === undefined
      ? undefined
      : turns.abandonTelegramEarlyStatus({ chatKey: key, ingressId, ...io });
  },
  startTurn1: (key, at) => startTurn(key, session(key, 1), `t${at}`),
  startTurn2: (key, at) => startTurn(key, session(key, 2), `t${at}`),
  beat: (key) =>
    turns.markTelegramTurnAlive({
      chatKey: key,
      sessionId: String(getChatStatus(key)?.sessionId),
      minIntervalMs: 0,
      ...io,
    }),
  firstOutput: (key) =>
    turns.markTelegramFirstOutput({
      chatKey: key,
      sessionId: String(getChatStatus(key)?.sessionId),
      ...io,
    }),
  finishOwnTurn: (key) => {
    const own = getChatStatus(key);
    return own?.sessionId === undefined
      ? undefined
      : finishTurn(key, own.sessionId, own.turnId);
  },
  finishIntoCompaction: (key) => {
    const own = getChatStatus(key);
    return own?.sessionId === undefined || own.turnId === undefined
      ? undefined
      : finishTurn(key, own.sessionId, own.turnId, true);
  },
  lateFinish: (key) => finishTurn(key, session(key, 1), "t-gone"),
  sessionEnds: (key) => finishTurn(key, session(key, 1)),
  compact: (key, at) =>
    turns.takeOverTelegramChat({
      chatKey: key,
      patch: turns.chatTakeOverPatch({
        sessionId: session(key, 1),
        compacting: true,
      }),
      now: () => at,
      refuseImpl: (status) => status?.resetAt !== undefined,
      ...io,
    }),
  reminderTurn: (key, at) =>
    turns.takeOverTelegramChat({
      chatKey: key,
      patch: turns.chatTakeOverPatch({ sessionId: `reminder-${key}` }),
      now: () => at,
      ...io,
    }),
  // Тот же патч, что releaseChat (scripts/reminders/fire.ts) и releaseReminderStatus
  // (agent/lib/reminder-tick.ts): обе функции внутренние.
  reminderEnds: (key) =>
    setChatStatusIf(
      key,
      { sessionId: `reminder-${key}` },
      { status: "idle", ...records.TURN_FIELDS_CLEARED },
    ),
  slowReplay: (key) => {
    const own = getChatStatus(key);
    return own?.sessionId === undefined || own.turnId === undefined
      ? undefined
      : records.markTelegramSessionForRetirement(own.sessionId, own.turnId, 9);
  },
  ask: (key) => {
    const sessionId = getChatStatus(key)?.sessionId;
    return sessionId === undefined
      ? undefined
      : records.updateTelegramPendingInputRequests(sessionId, {
          requested: ["q"],
        });
  },
  answer: (key) => {
    const sessionId = getChatStatus(key)?.pendingInputSessionId;
    return sessionId === undefined
      ? undefined
      : records.updateTelegramPendingInputRequests(sessionId, {
          resolved: ["q"],
        });
  },
  reap: (key, at) => reap(key, at),
  retire: (key) =>
    bridge.retireSettledSessions({
      listStatusesImpl: () => [{ chatKey: key, status: getChatStatus(key) }],
      resetImpl: (key) => bridge.completeScopedResetState(key),
      sendImpl: () => Promise.resolve(),
      traceImpl: () => {},
      logImpl: () => {},
      inFlight: new Map(),
    }),
  newConversation: (key) => bridge.completeScopedResetState(key),
  deliveryFailed: (key, at) =>
    bridge.clearFailedDirectIngress(key, {
      baselineGeneration: -1,
      startedAt: 0,
      now: () => at,
    }),
  restart: () => rewriteRunStatusesForUpdate(dataDir, true),
  update: () => rewriteRunStatusesForUpdate(dataDir, false),
};
const stepNames = Object.keys(steps);

void test("OneState, TurnFieldsOnlyWhenBusy: after any order of writer steps the record satisfies its schema and names exactly one state", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          step: fc.constantFrom(...stepNames),
          // Полчаса тишины перед шагом: запись успевает протухнуть.
          silence: fc.boolean(),
        }),
        { maxLength: 14 },
      ),
      async (script) => {
        const key = freshChat();
        let at = Date.now();
        const trail: string[] = [];
        for (const { step, silence } of script) {
          if (silence) at += STALE_MS + 1;
          await steps[step](key, at);
          trail.push(silence ? `silence, ${step}` : step);
          let raw: Record<string, unknown>;
          try {
            raw = rawOf(key);
          } catch {
            continue; // записи ещё нет: чат свободен
          }
          const where = `${trail.join(" → ")}: ${JSON.stringify(raw)}`;
          assert.deepEqual(records.chatRecordViolations(raw), [], where);
          assert.deepEqual(
            namedStates(raw, at),
            [chatState(getChatStatus(key), at)],
            where,
          );
        }
      },
    ),
    { numRuns: 150 },
  );
});

void test("ReleasedByOwnerOrReaper: the late terminal write of turn 1 keeps the record of turn 2 in the same session", async () => {
  // Контрпример мутанта release-by-session: TurnStart, TurnEnd, TurnStart, Release.
  const key = freshChat();
  await startTurn(key, "s", "turn-1");
  await startTurn(key, "s", "turn-2");
  assert.equal(await finishTurn(key, "s", "turn-1"), false);
  const record = getChatStatus(key);
  assert.equal(chatState(record), "turn");
  assert.equal(record?.turnId, "turn-2");
  assert.equal(await finishTurn(key, "s", "turn-2"), true);
  assert.equal(chatState(getChatStatus(key)), "free");
});

void test("ReleasedByOwnerOrReaper: the reaper leaves a live record and frees it only past the deadline", async () => {
  // Контрпример мутанта reap-live: TurnStart, Reap.
  const key = freshChat();
  await startTurn(key, "s", "turn-1");
  const written = Number(getChatStatus(key)?.updatedAt);
  assert.equal(await reap(key, written + STALE_MS - 1), 0);
  assert.equal(chatState(getChatStatus(key), written + STALE_MS - 1), "turn");
  assert.equal(await reap(key, written + STALE_MS), 1);
  assert.equal(chatState(getChatStatus(key)), "retry-offered");
});

void test("TurnFieldsOnlyWhenBusy: a writer that leaves compacting on a free chat gets an error and the record stays whole", () => {
  // Контрпример мутанта leave-compacting: TurnStart, TurnEnd, ReleaseIntoCompaction, CompactEnd.
  const key = freshChat();
  setChatStatusIf(
    key,
    {},
    { status: "running", sessionId: "s", compacting: true },
  );
  const before = rawOf(key);
  assert.throws(
    () =>
      setChatStatusIf(
        key,
        { sessionId: "s", compacting: true },
        { status: "idle", sessionId: null },
      ),
    /TurnFieldsOnlyWhenBusy.*compacting/u,
  );
  assert.deepEqual(rawOf(key), before);
});

void test("TurnFieldsOnlyWhenBusy: a reminder turn that printed output frees the chat without its turn fields", async () => {
  // Контрпример, найденный тестом свойств: reminderTurn → firstOutput → reminderEnds. Канал
  // агента ставит firstOutputAt и сессии напоминания; прежний патч снимал три поля из девяти.
  const key = freshChat();
  const at = Date.now();
  for (const step of ["reminderTurn", "firstOutput", "reminderEnds"])
    await steps[step](key, at);
  const raw = rawOf(key);
  assert.deepEqual(records.chatRecordViolations(raw), []);
  assert.equal(raw.firstOutputAt, undefined);
  assert.equal(chatState(getChatStatus(key), at), "free");
});

void test("TurnFieldsOnlyWhenBusy: outside a test run the same write goes through without the field and is named in the journal", () => {
  const key = freshChat();
  setChatStatusIf(
    key,
    {},
    { status: "running", sessionId: "s", compacting: true },
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const live = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { setChatStatusIf } = await import("#lib/run-status.ts");
       const written = setChatStatusIf(${JSON.stringify(key)},
         { sessionId: "s", compacting: true }, { status: "idle", sessionId: null });
       if (written === null) process.exit(3);`,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(live.status, 0, live.stderr);
  const journal = live.stderr;
  const raw = rawOf(key);
  assert.equal(raw.status, "idle");
  assert.equal(raw.compacting, undefined);
  assert.deepEqual(records.chatRecordViolations(raw), []);
  assert.equal(chatState(getChatStatus(key)), "free");
  assert.match(journal, /TurnFieldsOnlyWhenBusy.*compacting/u);
});

void test("FreeAfterRestart: with no owner left every busy record is freed by the reaper, with and without recovery", async () => {
  // Контрпример мутанта no-reaper: TurnStart, Restart — запись остаётся занятой навсегда.
  const claims: Record<string, (key: string) => unknown> = {
    accepted: (key) =>
      turns.publishTelegramEarlyStatus({ chatKey: key, ...io }),
    turn: (key) => startTurn(key, "s", "turn-1"),
    compacting: (key) => steps.compact(key, Date.now()),
    "reminder turn": (key) => steps.reminderTurn(key, Date.now()),
  };
  for (const [name, claim] of Object.entries(claims)) {
    for (const recovery of [true, false]) {
      const key = freshChat();
      await claim(key);
      assert.equal(records.isRunning(key), true, name);
      // Перезапуск: память процесса пропала, осталась запись. Восстановление метит её
      // либо не отрабатывает — тогда запись протухает сама.
      if (recovery) rewriteRunStatusesForUpdate(dataDir, false);
      const at = recovery ? Date.now() : Date.now() + STALE_MS;
      assert.equal(chatState(getChatStatus(key), at), "stale", name);
      assert.equal(await reap(key, at), 1, name);
      const freed = getChatStatus(key);
      assert.equal(freed?.status, "idle", name);
      assert.equal(records.isRunning(key), false, name);
      assert.deepEqual(records.chatRecordViolations(rawOf(key)), [], name);
    }
  }
});

// Формат на диске прежний: записи, как их писали 0.5.0–0.5.11, читаются без потери, а
// незнакомое поле остаётся в файле после следующей записи.
void test("a record written by 0.5.11 reads into its state and keeps every field", () => {
  const now = Date.now();
  const written: Array<[string, Record<string, unknown>]> = [
    ["free", { status: "idle", generation: 4, updatedAt: now, resetAt: now }],
    [
      "accepted",
      {
        status: "running",
        generation: 1,
        updatedAt: now,
        ingressId: "i",
        ingressAt: now,
      },
    ],
    [
      "turn",
      {
        status: "running",
        generation: 9,
        updatedAt: now,
        ingressId: "i",
        ingressAt: now,
        sessionId: "s",
        turnId: "t",
        draftId: 12,
        turnAt: now,
        firstOutputAt: now,
        latencyLogged: true,
        turnQuestion: "вопрос",
        queuedIngressId: "q",
        queuedIngressAt: now,
        queuedSessionId: "s",
        wasCancelled: true,
        retireAfterTurn: { replayMs: 40_000, sessionId: "s", turnId: "t" },
        pendingInputRequestIds: ["r"],
        pendingInputSessionId: "s",
      },
    ],
    [
      "compacting",
      {
        status: "running",
        generation: 2,
        updatedAt: now,
        sessionId: "s",
        compacting: true,
      },
    ],
    [
      "stale",
      { status: "running", generation: 3, updatedAt: 0, sessionId: "s" },
    ],
    [
      "retry-offered",
      {
        status: "idle",
        generation: 5,
        updatedAt: now,
        resetAt: now,
        restartRetryData: "Повторить:1",
        restartRetryUpdate: 7,
        restartRetryQuestion: "вопрос",
        restartRetryMedia: true,
      },
    ],
    [
      "retiring",
      {
        status: "idle",
        generation: 6,
        updatedAt: now,
        retireAfterTurn: { replayMs: 40_000, sessionId: "s", turnId: "t" },
        retiredSessionId: "old",
      },
    ],
    [
      "awaiting-owner",
      {
        status: "idle",
        generation: 7,
        updatedAt: now,
        pendingInputRequestIds: ["r"],
        pendingInputSessionId: "s",
      },
    ],
  ];
  mkdirSync(join(dataDir, "run-status.d"), { recursive: true });
  for (const [state, record] of written) {
    const key = freshChat();
    const onDisk = { ...record, fromAnotherVersion: { kept: true } };
    writeFileSync(fileOf(key), JSON.stringify(onDisk));
    assert.deepEqual(getChatStatus(key), onDisk, state);
    assert.equal(chatState(getChatStatus(key), now), state);
    // Запись, которая не говорит «ход жив»: меняется только счётчик.
    setChatStatusIf(key, {}, {}, { touch: false });
    assert.deepEqual(rawOf(key), {
      ...onDisk,
      generation: Number(record.generation) + 1,
    });
  }
});

void test("progress claim belongs to the turn pair through start replay, heartbeat and terminal cleanup", async () => {
  const chatKey = freshChat();
  await startTurn(chatKey, "progress-session", "turn-1");
  const turnAt = getChatStatus(chatKey)?.turnAt;
  assert.ok(
    setChatStatusIf(
      chatKey,
      {
        sessionId: "progress-session",
        turnId: "turn-1",
        progressClaimed: undefined,
      },
      { progressClaimed: true },
    ),
  );
  assert.equal(
    setChatStatusIf(
      chatKey,
      { progressClaimed: undefined },
      { progressClaimed: true },
    ),
    null,
  );
  await startTurn(chatKey, "progress-session", "turn-1");
  assert.equal(getChatStatus(chatKey)?.progressClaimed, true);
  assert.equal(getChatStatus(chatKey)?.turnAt, turnAt);
  setChatStatusIf(chatKey, { sessionId: "progress-session" }, {});
  assert.equal(getChatStatus(chatKey)?.progressClaimed, true);
  await startTurn(chatKey, "progress-session", "turn-2");
  assert.equal(getChatStatus(chatKey)?.progressClaimed, undefined);
  setChatStatusIf(chatKey, { turnId: "turn-2" }, { progressClaimed: true });
  await finishTurn(chatKey, "progress-session", "turn-2");
  assert.equal(getChatStatus(chatKey)?.progressClaimed, undefined);
});
