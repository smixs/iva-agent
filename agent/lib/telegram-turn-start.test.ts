import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  abandonTelegramEarlyStatus,
  chatTakeOverPatch,
  emitTelegramTurnLatency,
  markTelegramFirstOutput,
  markTelegramTurnAlive,
  publishTelegramEarlyStatus,
  publishTelegramTurnStarted,
  takeOverTelegramChat,
  type TurnHeartbeat,
} from "./telegram-turn-start.ts";
import { RETIRED_SESSION_ROUTING_FIELD } from "./run-status.ts";

// Старт хода — единственное место, где ключ апдейта сшивается с turnId (ADR-0010).
// Каталог данных временный: писатель журнала резолвит его на каждой записи.
const traceRoot = mkdtempSync(join(tmpdir(), "iva-turn-start-trace-"));
process.env.ASSISTANT_DATA_DIR = join(traceRoot, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
const trace = await import("./trace.ts");
process.on("exit", () => rmSync(traceRoot, { recursive: true, force: true }));

function traceEvents(): Record<string, unknown>[] {
  try {
    return readFileSync(
      trace.traceFilePath(trace.traceDay(), process.env.ASSISTANT_DATA_DIR),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return []; // журнала ещё нет — событий тоже
  }
}

type Status = Record<string, unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Двойник run-status. Контракт настоящего updateChatStatus (agent/lib/run-status.ts)
// шире, чем «слить patch»: КАЖДАЯ успешная запись двигает generation и updatedAt —
// на них держатся и CAS раннего статуса, и жнец протухших ходов. Двойник, который их
// не двигал, тихо прощал бы пульсу хода не делать свою работу.
function statusStore(initial: Status = {}, now: () => number = Date.now) {
  let value = initial;
  const commit = (patch: Status, options: { touch?: boolean } = {}) => {
    const previousGeneration =
      typeof value.generation === "number" &&
      Number.isSafeInteger(value.generation) &&
      value.generation >= 0
        ? value.generation
        : 0;
    value = {
      ...value,
      ...patch,
      generation: previousGeneration + 1,
      updatedAt: options.touch === false ? value.updatedAt : now(),
    };
    delete value[RETIRED_SESSION_ROUTING_FIELD];
    for (const key of Object.keys(value))
      if (value[key] === null) delete value[key];
    return value;
  };
  return {
    get: () => value,
    set: (_key: string, patch: Status) => commit(patch),
    cas: (
      _key: string,
      expected: Status,
      patch: Status,
      options?: { touch?: boolean },
    ) => {
      if (
        Object.entries(expected).some(
          ([key, expectedValue]) => !Object.is(value[key], expectedValue),
        )
      ) {
        return null;
      }
      return commit(patch, options);
    },
  };
}

void test("a trusted dispatch creates one status before a fake 20-second pre-turn delay and turn.started adopts it", async () => {
  const events: string[] = [];
  const store = statusStore({ status: "idle" });
  let nowMs = 1_000;

  await publishTelegramEarlyStatus({
    chatKey: "1:",
    ingressId: "ingress-1",
    now: () => nowMs++,
    getStatusImpl: store.get,
    setStatusIfImpl: store.cas,
  });
  events.push("provider-work");
  nowMs += 20_000;

  const adopted = await publishTelegramTurnStarted({
    draftId: 42,
    chatKey: "1:",
    sessionId: "session-1",
    turnId: "turn-1",
    now: () => nowMs,
    getStatusImpl: store.get,
    setStatusIfImpl: store.cas,
  });

  assert.equal(adopted, true);
  assert.equal(store.get().sessionId, "session-1");
  assert.equal(store.get().turnId, "turn-1");
  assert.equal(store.get().ingressAt, 1_000);
  assert.equal(store.get().turnAt, 21_001);
});

void test("a reset racing a late early-status response cannot revive the old session", async () => {
  const working = deferred<number>();
  const store = statusStore({ status: "idle" });

  const publishing = publishTelegramEarlyStatus({
    chatKey: "1:",
    ingressId: "ingress-1",
    getStatusImpl: store.get,
    setStatusIfImpl: store.cas,
  });

  await new Promise((resolve) => setImmediate(resolve));
  store.set("1:", {
    status: "idle",
    ingressId: null,
    sessionId: null,
    turnId: null,
    resetAt: 2_000,
  });
  working.resolve(78);
  await publishing;
  const adopted = await publishTelegramTurnStarted({
    draftId: 42,
    chatKey: "1:",
    sessionId: "session-old",
    turnId: "turn-old",
    getStatusImpl: store.get,
    setStatusIfImpl: store.cas,
  });

  assert.equal(adopted, false);
  assert.equal(store.get().status, "idle");
  assert.equal(store.get().sessionId, undefined);
});

void test("latency logging emits one allowlisted JSON record with no sensitive fields", () => {
  const store = statusStore({
    status: "running",
    sessionId: "session-secret",
    ingressAt: 1_000,
    statusAt: 1_010,
    turnAt: 1_100,
    prompt: "private prompt",
    userId: "123456",
    token: "bot-token",
  });
  const lines: string[] = [];
  assert.equal(
    markTelegramFirstOutput({
      chatKey: "1:",
      sessionId: "session-secret",
      now: () => 1_500,
      getStatusImpl: store.get,
      setStatusIfImpl: store.cas,
    }),
    true,
  );
  assert.equal(
    markTelegramFirstOutput({
      chatKey: "1:",
      sessionId: "session-secret",
      now: () => 1_600,
      getStatusImpl: store.get,
      setStatusIfImpl: store.cas,
    }),
    false,
  );
  const options = {
    chatKey: "1:",
    sessionId: "session-secret",
    deliveryAt: 1_700,
    delivered: true,
    getStatusImpl: store.get,
    setStatusIfImpl: store.cas,
    logImpl: (line: string) => lines.push(line),
  };

  assert.equal(
    emitTelegramTurnLatency({ ...options, delivered: false }),
    false,
  );
  assert.equal(store.get().latencyLogged, undefined);
  assert.equal(emitTelegramTurnLatency(options), true);
  assert.equal(emitTelegramTurnLatency(options), false);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(
    lines[0],
    /private prompt|123456|bot-token|session-secret|1:/,
  );
});

// --- Гонка «реплай во время бегущего хода» (кейс залипшего «Работаю…/Стоп») ---
// Мост пропускает реплаи на сообщения бота мимо busy-очереди, поэтому ранний статус
// обязан не красть состояние живого хода: иначе его finishStatus теряет draftId
// и индикатор первого хода остаётся в чате навсегда.

void test("early status during a live running turn does not steal its indicator, the message gets a queued sign", async () => {
  const store = statusStore({
    status: "running",
    sessionId: "session-A",
    turnId: "turn-A",
    draftId: 41,
    ingressAt: 9_000,
    updatedAt: 10_000,
    generation: 5,
  });

  const ingressId = await publishTelegramEarlyStatus({
    chatKey: "1:",
    ingressId: "ingress-B",
    now: () => 11_000,
    staleMs: 30 * 60_000,
    getStatusImpl: store.get,
    setStatusIfImpl: store.cas,
  });

  assert.equal(ingressId, null);
  assert.equal(store.get().sessionId, "session-A");
  assert.equal(store.get().queuedIngressAt, 11_000);
  // Терминальная уборка бегущего хода (контракт finishStatus) обязана пройти.
  const cleaned = store.cas(
    "1:",
    { sessionId: "session-A" },
    { status: "idle", sessionId: null, turnId: null, draftId: null },
  );
  assert.notEqual(cleaned, null);
});

void test("early status over a stale running turn claims the chat and removes the orphan indicator", async () => {
  const store = statusStore({
    status: "running",
    sessionId: "session-dead",
    draftId: 55,
    updatedAt: 0,
    generation: 7,
  });

  const ingressId = await publishTelegramEarlyStatus({
    chatKey: "1:",
    ingressId: "ingress-B",
    now: () => 31 * 60_000,
    staleMs: 30 * 60_000,
    getStatusImpl: store.get,
    setStatusIfImpl: store.cas,
  });

  assert.equal(ingressId, "ingress-B");
  assert.equal(store.get().status, "running");
  assert.equal(store.get().ingressId, "ingress-B");
  assert.equal(store.get().sessionId, undefined);
});

void test("ingresses behind a fresh early status get one queued sign, not a stack of indicators", async () => {
  const store = statusStore({
    status: "running",
    ingressId: "ingress-prev",
    draftId: 60,
    updatedAt: 9_000,
    generation: 3,
  });

  for (const ingress of ["ingress-second", "ingress-third"]) {
    const ingressId = await publishTelegramEarlyStatus({
      chatKey: "1:",
      ingressId: ingress,
      now: () => 10_000,
      staleMs: 30 * 60_000,
      getStatusImpl: store.get,
      setStatusIfImpl: store.cas,
    });
    assert.equal(ingressId, null);
  }
  assert.equal(store.get().ingressId, "ingress-prev");
});

void test("early status still claims an idle chat with a reset tombstone", async () => {
  const store = statusStore({ status: "idle", resetAt: 2_000, generation: 9 });

  const ingressId = await publishTelegramEarlyStatus({
    chatKey: "1:",
    ingressId: "ingress-1",
    now: () => 5_000,
    staleMs: 30 * 60_000,
    getStatusImpl: store.get,
    setStatusIfImpl: store.cas,
  });

  assert.equal(ingressId, "ingress-1");
  assert.equal(store.get().status, "running");
  assert.equal(store.get().resetAt, undefined);
});

void test("a broken status read fails safe: no send, no state change", async () => {
  const store = statusStore({
    status: "running",
    sessionId: "session-A",
    draftId: 41,
    updatedAt: 10_000,
  });
  const errors: string[] = [];

  const ingressId = await publishTelegramEarlyStatus({
    chatKey: "1:",
    ingressId: "ingress-B",
    now: () => 11_000,
    getStatusImpl: () => {
      throw new Error("status store unreadable");
    },
    setStatusIfImpl: store.cas,
    onWorkingStatusError: (error) =>
      errors.push(error instanceof Error ? error.message : String(error)),
  });

  assert.equal(ingressId, null);
  assert.deepEqual(errors, ["status store unreadable"]);
});

void test("losing the claim race to a new live turn skips the early status", async () => {
  // Между read и CAS другой процесс успел начать живой ход — клейм обязан
  // отступить, не отправив второй индикатор и не тронув чужое состояние.
  const store = statusStore({ status: "idle", generation: 4 });
  let interposed = false;

  const ingressId = await publishTelegramEarlyStatus({
    chatKey: "1:",
    ingressId: "ingress-B",
    now: () => 10_000,
    staleMs: 30 * 60_000,
    getStatusImpl: store.get,
    setStatusIfImpl: (key, expected, patch) => {
      if (!interposed) {
        interposed = true;
        store.set(key, {
          status: "running",
          sessionId: "session-raced",
          draftId: 70,
          updatedAt: 10_000,
          generation: 5,
        });
        return null;
      }
      return store.cas(key, expected, patch);
    },
  });

  assert.equal(ingressId, null);
  assert.equal(store.get().sessionId, "session-raced");
});

void test("randomized interleaving never steals a fresh running turn (seed exposed)", async () => {
  const seed = Number(process.env.IVA_TEST_SEED ?? Date.now() % 100_000);
  console.log(
    `randomized early-status seed: ${seed} (IVA_TEST_SEED to replay)`,
  );
  let lcg = seed >>> 0;
  const rand = () => {
    lcg = (lcg * 1664525 + 1013904223) >>> 0;
    return lcg / 2 ** 32;
  };
  const STALE_MS = 30 * 60_000;

  for (let i = 0; i < 200; i++) {
    const kind = rand();
    const nowMs = 1_000_000;
    const initial: Status =
      kind < 0.4
        ? {
            status: "running",
            sessionId: `session-${i}`,
            draftId: 500 + i,
            updatedAt: nowMs - Math.floor(rand() * STALE_MS * 2),
            generation: i,
          }
        : kind < 0.6
          ? {
              status: "running",
              ingressId: `prev-${i}`,
              draftId: 500 + i,
              updatedAt: nowMs - Math.floor(rand() * STALE_MS * 2),
              generation: i,
            }
          : kind < 0.8
            ? { status: "idle", generation: i }
            : { status: "idle", resetAt: nowMs - 1_000, generation: i };
    const wasFreshRunning =
      initial.status === "running" &&
      nowMs - (initial.updatedAt as number) < STALE_MS;
    const store = statusStore({ ...initial });

    const ingressId = await publishTelegramEarlyStatus({
      chatKey: "1:",
      ingressId: `ingress-${i}`,
      now: () => nowMs,
      staleMs: STALE_MS,
      getStatusImpl: store.get,
      setStatusIfImpl: store.cas,
    });

    if (wasFreshRunning) {
      assert.equal(ingressId, null, `seed ${seed} iter ${i}: stole a live run`);
      // Живой ход не тронут: все его поля как были (и updatedAt), добавлен только знак.
      const after = store.get();
      for (const key of Object.keys(initial).filter(
        (field) => field !== "generation",
      ))
        assert.deepEqual(
          after[key],
          initial[key],
          `seed ${seed} iter ${i}: live state mutated (${key})`,
        );
    } else {
      assert.equal(ingressId, `ingress-${i}`, `seed ${seed} iter ${i}`);
      assert.equal(store.get().status, "running", `seed ${seed} iter ${i}`);
    }
  }
});

void test("a queued reply's turn starting on an idle chat sends its own stoppable indicator", async () => {
  // Новый маршрут второго сообщения: ранний статус пропущен (чат был занят живым
  // ходом), индикатор обязан появиться на turn.started и штатно убираться терминалом.
  const store = statusStore({ status: "idle", generation: 12 });

  const started = await publishTelegramTurnStarted({
    draftId: 42,
    chatKey: "1:",
    sessionId: "session-B",
    turnId: "turn-B",
    now: () => 20_000,
    getStatusImpl: store.get,
    setStatusIfImpl: store.cas,
  });

  assert.equal(started, true);
  const cleaned = store.cas(
    "1:",
    { sessionId: "session-B" },
    { status: "idle", sessionId: null, turnId: null, draftId: null },
  );
  assert.notEqual(cleaned, null);
});

void test("a takeover carries the queued sign: compaction and reminder claims keep its fields", async () => {
  // Свёртка между ходами и напоминание занимают свободный чат тем же захватом. Знак ждёт
  // хода своего сообщения, а удалить его ни у кого из них нечем: номер обязан доехать.
  const sign = {
    queuedIngressId: "ingress-Q",
    queuedIngressAt: 5_000,
    queuedSessionId: "session-1",
  };
  for (const patch of [
    chatTakeOverPatch({ sessionId: "session-1", compacting: true }),
    chatTakeOverPatch({ sessionId: "session-reminder" }),
  ]) {
    const store = statusStore({ status: "idle", generation: 3, ...sign });
    assert.equal(
      await takeOverTelegramChat({
        chatKey: "1:",
        patch,
        now: () => 90_000,
        getStatusImpl: store.get,
        setStatusIfImpl: store.cas,
      }),
      true,
    );
    for (const [field, value] of Object.entries(sign))
      assert.equal(store.get()[field], value, field);
  }
});

void test("a turn of another session does not inherit the sign: no ingressAt, the sign is deleted", async () => {
  const store = statusStore({
    status: "idle",
    generation: 3,
    queuedIngressId: "ingress-Q",
    queuedIngressAt: 5_000,
    queuedSessionId: "session-reminder",
  });

  assert.equal(
    await publishTelegramTurnStarted({
      draftId: 42,
      chatKey: "1:",
      sessionId: "session-1",
      turnId: "turn-callback",
      now: () => 90_000,
      getStatusImpl: store.get,
      setStatusIfImpl: store.cas,
    }),
    true,
  );
  assert.equal(store.get().ingressAt, undefined);
  assert.equal(store.get().queuedSessionId, undefined);
});

void test("a turn with its own early status deletes the sign: the input buffer went into this turn", async () => {
  const store = statusStore({
    status: "running",
    ingressId: "ingress-M",
    ingressAt: 1_000,
    draftId: 40,
    generation: 3,
    queuedIngressId: "ingress-Q",
    queuedIngressAt: 1_200,
  });

  assert.equal(
    await publishTelegramTurnStarted({
      draftId: 42,
      chatKey: "1:",
      sessionId: "session-1",
      turnId: "turn-M",
      getStatusImpl: store.get,
      setStatusIfImpl: store.cas,
    }),
    true,
  );
  assert.equal(store.get().ingressAt, 1_000);
});

void test("a turn refused by a reset tombstone still deletes the sign", async () => {
  const store = statusStore({
    status: "idle",
    resetAt: 4_000,
    generation: 3,
    queuedIngressId: "ingress-Q",
    queuedIngressAt: 1_200,
  });

  assert.equal(
    await publishTelegramTurnStarted({
      draftId: 42,
      chatKey: "1:",
      sessionId: "session-1",
      turnId: "turn-late",
      getStatusImpl: store.get,
      setStatusIfImpl: store.cas,
    }),
    false,
  );
  assert.equal(store.get().resetAt, 4_000);
});

void test("the sign write keeps updatedAt: a dead turn's record does not live 30 more minutes", async () => {
  const store = statusStore(
    {
      status: "running",
      sessionId: "session-A",
      draftId: 41,
      updatedAt: 10_000,
      generation: 5,
    },
    () => 50_000,
  );

  await publishTelegramEarlyStatus({
    chatKey: "1:",
    ingressId: "ingress-Q",
    now: () => 11_000,
    staleMs: 30 * 60_000,
    getStatusImpl: store.get,
    setStatusIfImpl: store.cas,
  });
  assert.equal(store.get().queuedSessionId, "session-A");
  assert.equal(store.get().updatedAt, 10_000);
});

void test("a sign attached by a racer between read and write is not overwritten", async () => {
  const store = statusStore({
    status: "running",
    sessionId: "session-A",
    draftId: 41,
    updatedAt: Date.now(),
    generation: 5,
  });
  let raced = false;

  await publishTelegramEarlyStatus({
    chatKey: "1:",
    ingressId: "ingress-late",
    getStatusImpl: store.get,
    setStatusIfImpl: (key, expected, patch, options) => {
      // Другое сообщение успело поставить свой знак после нашего чтения.
      if (!raced && "queuedIngressId" in patch) {
        raced = true;
        store.set(key, {
          queuedIngressId: "ingress-first",
          queuedIngressAt: 1,
        });
      }
      return store.cas(key, expected, patch, options);
    },
  });

  assert.equal(raced, true);
  assert.equal(store.get().queuedIngressId, "ingress-first");
});

void test("a message the inbound pipeline drops takes its queued sign with it", async () => {
  const store = statusStore({
    status: "running",
    sessionId: "session-A",
    draftId: 41,
    updatedAt: Date.now(),
    generation: 5,
  });
  const common = {
    chatKey: "1:",
    getStatusImpl: store.get,
    setStatusIfImpl: store.cas,
  };
  await publishTelegramEarlyStatus({
    ...common,
    ingressId: "ingress-Q",
  });

  // Чужой знак не трогаем.
  assert.equal(
    await abandonTelegramEarlyStatus({ ...common, ingressId: "ingress-X" }),
    false,
  );
  assert.equal(
    await abandonTelegramEarlyStatus({ ...common, ingressId: "ingress-Q" }),
    true,
  );
  assert.equal(store.get().sessionId, "session-A");
});

void test("turn start retires a legacy routing field on both claim paths", async () => {
  const claimed = statusStore({
    status: "idle",
    [RETIRED_SESSION_ROUTING_FIELD]: "legacy",
  });
  assert.equal(
    await publishTelegramTurnStarted({
      draftId: 42,
      chatKey: "7091451031:",
      sessionId: "session-1",
      turnId: "turn-1",
      getStatusImpl: claimed.get,
      setStatusIfImpl: claimed.cas,
    }),
    true,
  );
  assert.equal(claimed.get()[RETIRED_SESSION_ROUTING_FIELD], undefined);
  assert.equal(claimed.get().sessionId, "session-1");

  const adopted = statusStore({
    status: "idle",
    [RETIRED_SESSION_ROUTING_FIELD]: "legacy",
  });
  await publishTelegramEarlyStatus({
    chatKey: "-1001:77",
    ingressId: "ingress-1",
    getStatusImpl: adopted.get,
    setStatusIfImpl: adopted.cas,
  });
  assert.equal(
    await publishTelegramTurnStarted({
      draftId: 42,
      chatKey: "-1001:77",
      sessionId: "session-2",
      turnId: "turn-2",
      getStatusImpl: adopted.get,
      setStatusIfImpl: adopted.cas,
    }),
    true,
  );
  assert.equal(adopted.get()[RETIRED_SESSION_ROUTING_FIELD], undefined);
  assert.equal(adopted.get().sessionId, "session-2");
});

void test("a live turn's heartbeat moves updatedAt and is throttled between events", () => {
  // Событий у длинного хода много (каждый tool-вызов), а запись в run-status —
  // файл под локом. Пульс обязан ходить редко и всё же не давать ходу протухнуть.
  let nowMs = 1_000_000;
  const store = statusStore(
    { status: "running", sessionId: "session-1", generation: 3 },
    () => nowMs,
  );
  const beats = new Map<string, TurnHeartbeat>();
  const beat = () =>
    markTelegramTurnAlive({
      chatKey: "1:",
      sessionId: "session-1",
      now: () => nowMs,
      minIntervalMs: 60_000,
      beats,
      getStatusImpl: store.get,
      setStatusIfImpl: store.cas,
    });

  assert.equal(beat(), true);
  assert.equal(store.get().updatedAt, 1_000_000);
  const generationAfterFirst = store.get().generation;

  nowMs += 59_999; // тот же ход, интервал не вышел — записи нет
  assert.equal(beat(), false);
  assert.equal(store.get().generation, generationAfterFirst);
  assert.equal(store.get().updatedAt, 1_000_000);

  nowMs += 1; // ровно интервал — пульс проходит
  assert.equal(beat(), true);
  assert.equal(store.get().updatedAt, 1_060_000);
  assert.equal(store.get().status, "running");
  assert.equal(store.get().sessionId, "session-1");
});

void test("a late heartbeat cannot revive a finished, reset or foreign turn", () => {
  let nowMs = 2_000_000;
  const beats = new Map<string, TurnHeartbeat>();
  const alive = (store: ReturnType<typeof statusStore>, sessionId: string) =>
    markTelegramTurnAlive({
      chatKey: "1:",
      sessionId,
      now: () => nowMs,
      beats,
      getStatusImpl: store.get,
      setStatusIfImpl: store.cas,
    });

  // Ход уже финишировал: статус idle.
  const finished = statusStore({ status: "idle", generation: 9 }, () => nowMs);
  assert.equal(alive(finished, "session-1"), false);
  assert.equal(finished.get().status, "idle");
  assert.equal(finished.get().generation, 9);

  // /new успел сбросить сессию, на её месте уже другая.
  const replaced = statusStore(
    { status: "running", sessionId: "session-2", generation: 4 },
    () => nowMs,
  );
  assert.equal(alive(replaced, "session-1"), false);
  assert.equal(replaced.get().generation, 4);

  // Свой живой ход по тому же чату пульс всё ещё пишет.
  assert.equal(alive(replaced, "session-2"), true);
  assert.equal(replaced.get().updatedAt, 2_000_000);
  assert.equal(replaced.get().generation, 5);

  // Новый ход в том же чате не ждёт интервала от предыдущего.
  nowMs += 10;
  const next = statusStore(
    { status: "running", sessionId: "session-3", generation: 1 },
    () => nowMs,
  );
  assert.equal(alive(next, "session-3"), true);
  assert.equal(next.get().updatedAt, 2_000_010);
});

void test("a heartbeat losing the CAS race reports failure without retry storms", () => {
  let nowMs = 3_000_000;
  const store = statusStore(
    { status: "running", sessionId: "session-1", generation: 2 },
    () => nowMs,
  );
  const beats = new Map<string, TurnHeartbeat>();
  let casCalls = 0;
  const beat = () =>
    markTelegramTurnAlive({
      chatKey: "1:",
      sessionId: "session-1",
      now: () => nowMs,
      minIntervalMs: 60_000,
      beats,
      getStatusImpl: store.get,
      // Гонка: между чтением и записью терминальное событие увело статус.
      setStatusIfImpl: () => {
        casCalls++;
        return null;
      },
    });

  assert.equal(beat(), false);
  assert.equal(casCalls, 1);
  nowMs += 1_000;
  assert.equal(beat(), false);
  assert.equal(casCalls, 1); // отметка стоит: поток событий не превращается в поток записей
});

void test("Trace: старт хода связывает ключ апдейта с turnId", async () => {
  const chatKey = "931:";
  const status = statusStore();
  // Так же, как это делает acceptance-обёртка на принятом апдейте.
  trace.traceBindUpdate(chatKey, "tg:931:12");
  const before = traceEvents().length;

  await publishTelegramTurnStarted({
    draftId: 42,
    chatKey,
    sessionId: "wrun_31",
    turnId: "turn_2",
    getStatusImpl: status.get,
    setStatusIfImpl: status.cas,
  });

  const added = traceEvents().slice(before);
  const bound = added.filter((event) => event.kind === "turn");
  assert.equal(bound.length, 1);
  assert.equal(added[0].kind, "turn");
  assert.equal(added[0].name, "bound");
  assert.equal(added[0].turn, "turn_2");
  assert.equal(added[0].session, "wrun_31");
  assert.deepEqual(added[0].data, { chatKey, updateKey: "tg:931:12" });
});

void test("Trace: старт хода снимает состав памяти, которая уедет в промпт", async (t) => {
  const vault = mkdtempSync(join(tmpdir(), "iva-turn-start-vault-"));
  const previous = process.env.ASSISTANT_VAULT_DIR;
  process.env.ASSISTANT_VAULT_DIR = vault;
  writeFileSync(join(vault, "CORE.md"), "ядро памяти");
  writeFileSync(join(vault, "MOC.md"), "карта тем");
  t.after(() => {
    if (previous === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = previous;
    rmSync(vault, { recursive: true, force: true });
  });
  const status = statusStore();
  const before = traceEvents().length;

  await publishTelegramTurnStarted({
    draftId: 42,
    chatKey: "941:",
    sessionId: "wrun_41",
    turnId: "turn_5",
    getStatusImpl: status.get,
    setStatusIfImpl: status.cas,
  });

  const parts = traceEvents()
    .slice(before)
    .filter((event) => event.kind === "context");
  assert.equal(parts.length, 1);
  assert.equal(parts[0].name, "parts");
  assert.equal(parts[0].turn, "turn_5");
  assert.equal(parts[0].session, "wrun_41");
  const data = parts[0].data as Record<string, unknown>;
  // Размеры в БАЙТАХ тех же файлов, которые прочитают динамические инструкции eve.
  assert.equal(data.core, 21);
  assert.equal(data.moc, 17);
  assert.equal(data.persona, 0); // квиз не пройден — файла нет
  assert.equal(data.unit, "bytes");
  assert.equal(data.approximate, true);
});

void test("a reset-refused turn whose sign cleanup throws reports the error instead of throwing", async () => {
  const store = statusStore({
    status: "idle",
    resetAt: 4_000,
    queuedIngressId: "ingress-Q",
  });
  const errors: string[] = [];

  assert.equal(
    await publishTelegramTurnStarted({
      draftId: 42,
      chatKey: "1:",
      sessionId: "session-1",
      turnId: "turn-late",
      getStatusImpl: store.get,
      setStatusIfImpl: () => {
        throw new Error("run-status lock timeout");
      },
      onWorkingStatusError: (error) =>
        errors.push(error instanceof Error ? error.message : String(error)),
    }),
    false,
  );
  assert.deepEqual(errors, ["run-status lock timeout"]);
});

void test("early ingress time survives adoption when the same session also owns queued ingress", async () => {
  const store = statusStore({
    status: "running",
    ingressId: "early",
    ingressAt: 1000,
    queuedIngressId: "queued",
    queuedIngressAt: 2000,
    queuedSessionId: "same",
  });
  assert.equal(
    await publishTelegramTurnStarted({
      chatKey: "1:",
      sessionId: "same",
      turnId: "t",
      draftId: 21,
      getStatusImpl: store.get,
      setStatusIfImpl: store.cas,
    }),
    true,
  );
  assert.equal(store.get().ingressAt, 1000);
  assert.equal(store.get().queuedIngressId, undefined);
});

void test("a takeover for compaction or a reminder clears the previous Stop fact", async () => {
  for (const fields of [
    { sessionId: "session-1", compacting: true },
    { sessionId: "session-reminder" },
  ]) {
    const store = statusStore({
      status: "idle",
      generation: 3,
      wasCancelled: true,
    });
    assert.equal(
      await takeOverTelegramChat({
        chatKey: "1:",
        patch: chatTakeOverPatch(fields),
        now: () => 90_000,
        getStatusImpl: store.get,
        setStatusIfImpl: store.cas,
      }),
      true,
    );
    assert.equal(store.get().wasCancelled, undefined);
  }
});

void test("a started reminder clears the previous Stop fact", async () => {
  const store = statusStore({
    status: "idle",
    generation: 3,
    wasCancelled: true,
  });
  assert.equal(
    await publishTelegramTurnStarted({
      chatKey: "1:",
      sessionId: "session-reminder",
      turnId: "turn-reminder",
      draftId: 41,
      getStatusImpl: store.get,
      setStatusIfImpl: store.cas,
    }),
    true,
  );
  assert.equal(store.get().wasCancelled, undefined);
});
