// Слив очереди Bridge пачкой и маршрут R1 (спека L5 v2, §3.3, §3.4, §3.9). Шов — сам
// drainReadyQueueHeads и routeMessageUpdate: подменены только файл очереди (документ в
// памяти поверх настоящего removeQueueItems), eve и запись run-status.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TELEGRAM_BUTTON_TAP_FIELD } from "#lib/telegram-parts.ts";

const root = mkdtempSync(join(tmpdir(), "iva-queue-batch-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
process.env.TELEGRAM_BOT_TOKEN ??= "1:test-token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.TELEGRAM_POLL_SETTLE_MS = "0";
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const routing = await import("./routing.ts");
const queueRuntime = await import("./queue.ts");
const {
  createQueueItem,
  enqueueItem,
  enqueueQueueFile,
  isTelegramQueueUpdate,
  loadQueueFile,
  queueCount,
  removeQueueItems,
  TELEGRAM_QUEUE_ACK_ROLLED_BACK,
  TELEGRAM_QUEUE_FATAL_DURABILITY,
} = await import("../lib/telegram-queue.ts");
type Doc = import("../lib/telegram-queue.ts").TelegramQueueDocument;
type Update = import("../lib/telegram-queue.ts").TelegramQueueUpdate;
type Message = import("../lib/telegram-queue.ts").TelegramQueueMessage;
type DrainOptions = NonNullable<
  Parameters<typeof routing.drainReadyQueueHeads>[0]
>;
type RouteOptions = NonNullable<
  Parameters<typeof routing.routeMessageUpdate>[1]
>;

const KEY = "1:";

function text(
  updateId: number,
  body: string,
  extra: Partial<Message> = {},
): Update {
  return {
    update_id: updateId,
    message: {
      message_id: Math.abs(updateId),
      date: 1,
      chat: { id: 1, type: "private" },
      from: { id: 42, is_bot: false },
      text: body,
      ...extra,
    },
  };
}

function queueOf(...updates: Update[]): Doc {
  return updates.reduce<Doc>(
    (document, update, index) =>
      enqueueItem(document, KEY, createQueueItem(update, index + 1)).document,
    { version: 1, queues: {} },
  );
}

const ids = (document: Doc, key = KEY) =>
  Object.hasOwn(document.queues, key)
    ? document.queues[key].map((item) => item.updateId)
    : [];

const partTexts = (update: Update) =>
  (update.message?.iva_parts ?? [update.message]).map((part) => part?.text);

/**
 * Очередь в памяти, подделка eve и запись run-status одного чата. Принятая доставка
 * проходит весь ход сразу (поколение растёт), поэтому следующий проход видит чат
 * свободным — как после законченного хода.
 */
function bench(document: Doc) {
  const state = {
    document,
    running: false,
    generation: 0,
    deliveries: [] as Update[],
    acks: [] as number[][],
    verdicts: [] as Array<boolean | "handled">,
  };
  const options = (overrides: Partial<DrainOptions> = {}): DrainOptions => ({
    loadImpl: () => Promise.resolve(state.document),
    runningImpl: () => state.running,
    statusImpl: () =>
      state.running
        ? { status: "running", sessionId: "s", generation: state.generation }
        : { status: "idle", generation: state.generation },
    deliverImpl: (update) => {
      state.deliveries.push(update);
      const verdict = state.verdicts.shift() ?? true;
      if (verdict === true) state.generation += 2;
      return Promise.resolve(verdict);
    },
    acknowledgeImpl: (key, updateIds) => {
      state.acks.push([...updateIds]);
      state.document = removeQueueItems(
        state.document,
        key,
        updateIds,
      ).document;
      return Promise.resolve();
    },
    settleUntil: new Map(),
    inFlight: new Map(),
    pins: new Map(),
    rotationState: { afterKey: null },
    now: () => 1_000,
    resetPendingImpl: () => false,
    ...overrides,
  });
  return { state, options };
}

async function drainAll(
  run: ReturnType<typeof bench>,
  options = run.options(),
  passes = 20,
) {
  for (let pass = 0; pass < passes; pass++) {
    if (queueCount(run.state.document) === 0) break;
    await routing.drainReadyQueueHeads(options);
  }
}

await test("three plain messages of one author reach Iva in one delivery", async () => {
  const run = bench(
    queueOf(text(101, "first"), text(102, "second"), text(103, "third")),
  );
  await drainAll(run);

  assert.equal(run.state.deliveries.length, 1);
  const [delivery] = run.state.deliveries;
  assert.equal(delivery.update_id, 103, "the batch speaks with its last id");
  assert.equal(delivery.message?.message_id, 101, "the carrier is the first");
  assert.deepEqual(partTexts(delivery), ["first", "second", "third"]);
  assert.deepEqual(run.state.acks, [[101, 102, 103]]);
  assert.deepEqual(run.state.document, { version: 1, queues: {} });
});

await test("an input merge inside the queue unfolds into flat parts of the batch", async () => {
  const merged = text(102, "a");
  merged.message!.iva_parts = [
    { ...text(101, "a").message },
    { ...text(102, "b").message },
  ];
  const run = bench(queueOf(merged, text(103, "c")));
  await drainAll(run);

  assert.equal(run.state.deliveries.length, 1);
  const parts = run.state.deliveries[0].message?.iva_parts ?? [];
  assert.deepEqual(
    parts.map((part) => part.text),
    ["a", "b", "c"],
  );
  assert.ok(parts.every((part) => !Object.hasOwn(part, "iva_parts")));
});

await test("commands, replies, taps, synthetic ids and authorless items go alone; neighbours merge", async () => {
  const reply = text(105, "yes", {
    reply_to_message: { message_id: 50, from: { id: 9, is_bot: true } },
  });
  const tap = text(107, "Remind me", { [TELEGRAM_BUTTON_TAP_FIELD]: true });
  const authorless = text(112, "anon");
  delete authorless.message!.from;
  const captionCommand = text(114, "");
  delete captionCommand.message!.text;
  Object.assign(captionCommand.message!, {
    caption: " /summary",
    document: { file_id: "doc" },
  });
  const run = bench(
    queueOf(
      text(101, "a"),
      text(102, "b"),
      text(103, "/x"),
      text(104, "c"),
      reply,
      text(106, "d"),
      tap,
      text(108, "e"),
      text(109, "f"),
      text(-110, "synthetic menu text"),
      text(111, "g"),
      authorless,
      text(113, "h"),
      captionCommand,
    ),
  );
  await drainAll(run, run.options(), 30);

  assert.deepEqual(run.state.acks, [
    [101, 102],
    [103],
    [104],
    [105],
    [106],
    [107],
    [108, 109],
    [-110],
    [111],
    [112],
    [113],
    [114],
  ]);
  assert.deepEqual(
    run.state.deliveries.map((delivery) => delivery.update_id),
    [102, 103, 104, 105, 106, 107, 109, -110, 111, 112, 113, 114],
  );
  // Одиночная пачка уходит тем же апдейтом, что лежал в очереди.
  assert.deepEqual(run.state.deliveries[1], text(103, "/x"));
});

await test("in a group only consecutive messages of one author merge", async () => {
  const group = (updateId: number, body: string, fromId: number) =>
    text(updateId, body, {
      chat: { id: -100, type: "supergroup" },
      from: { id: fromId, is_bot: false },
    });
  const document = [
    group(1, "A1", 42),
    group(2, "A2", 42),
    group(3, "B1", 7),
    group(4, "A3", 42),
  ].reduce<Doc>(
    (current, update, index) =>
      enqueueItem(current, "-100:", createQueueItem(update, index)).document,
    { version: 1, queues: {} },
  );
  const run = bench(document);
  await drainAll(run);

  assert.deepEqual(run.state.acks, [[1, 2], [3], [4]]);
  assert.deepEqual(partTexts(run.state.deliveries[0]), ["A1", "A2"]);
});

await test("a batch stops at 20 parts or 50 000 characters; an oversized head still leaves alone", async () => {
  const many = bench(
    queueOf(
      ...Array.from({ length: 21 }, (_, index) =>
        text(201 + index, `p${index}`),
      ),
    ),
  );
  await drainAll(many);
  assert.deepEqual(
    many.state.acks.map((batch) => batch.length),
    [20, 1],
  );
  assert.equal(many.state.deliveries[0].update_id, 220);
  assert.equal(many.state.deliveries[1].update_id, 221);

  const long = bench(
    queueOf(
      text(301, "x".repeat(30_000)),
      text(302, "y".repeat(20_001)),
      text(303, "z"),
    ),
  );
  await drainAll(long);
  assert.deepEqual(long.state.acks, [[301], [302, 303]]);

  const huge = bench(queueOf(text(401, "h".repeat(60_000)), text(402, "z")));
  await drainAll(huge);
  assert.deepEqual(huge.state.acks, [[401], [402]]);
});

await test("an unanswered batch stays pinned: the next delivery carries the same ids even if the queue grew", async () => {
  const run = bench(queueOf(text(101, "first"), text(102, "second")));
  const options = run.options();
  run.state.verdicts.push(false);

  await routing.drainReadyQueueHeads(options);
  assert.deepEqual(run.state.acks, []);
  assert.deepEqual(ids(run.state.document), [101, 102]);
  run.state.document = enqueueItem(
    run.state.document,
    KEY,
    createQueueItem(text(103, "third"), 3),
  ).document;

  await routing.drainReadyQueueHeads(options);
  assert.deepEqual(
    run.state.deliveries.map((delivery) => [
      delivery.update_id,
      partTexts(delivery),
    ]),
    [
      [102, ["first", "second"]],
      [102, ["first", "second"]],
    ],
  );
  assert.deepEqual(run.state.acks, [[101, 102]]);
  assert.equal(options.pins!.has(KEY), false, "acknowledged batch unpins");

  await routing.drainReadyQueueHeads(options);
  assert.deepEqual(run.state.acks, [[101, 102], [103]]);
  assert.equal(run.state.deliveries[2].update_id, 103);
});

await test("a rolled-back acknowledgement keeps the batch: eve's ledger answers handled and no second turn starts", async () => {
  const run = bench(queueOf(text(101, "first"), text(102, "second")));
  const ledger = new Set<number>();
  let turns = 0;
  let failAck = true;
  const options = run.options({
    deliverImpl: (update) => {
      run.state.deliveries.push(update);
      if (ledger.has(update.update_id)) return Promise.resolve("handled");
      ledger.add(update.update_id);
      turns++;
      run.state.generation += 2;
      return Promise.resolve(true);
    },
    acknowledgeImpl: (key, updateIds) => {
      if (failAck) {
        failAck = false;
        return Promise.reject(
          Object.assign(new Error("injected ack rollback"), {
            code: TELEGRAM_QUEUE_ACK_ROLLED_BACK,
          }),
        );
      }
      run.state.acks.push([...updateIds]);
      run.state.document = removeQueueItems(
        run.state.document,
        key,
        updateIds,
      ).document;
      return Promise.resolve();
    },
  });

  await routing.drainReadyQueueHeads(options);
  assert.deepEqual(ids(run.state.document), [101, 102]);
  assert.deepEqual(options.pins!.get(KEY), [101, 102]);
  run.state.document = enqueueItem(
    run.state.document,
    KEY,
    createQueueItem(text(103, "third"), 3),
  ).document;

  await routing.drainReadyQueueHeads(options);
  assert.equal(turns, 1, "the ledger turned the repeat into handled");
  assert.deepEqual(run.state.acks, [[101, 102]]);
  assert.deepEqual(
    run.state.deliveries.map((delivery) => delivery.update_id),
    [102, 102],
  );

  await routing.drainReadyQueueHeads(options);
  assert.equal(turns, 2);
  assert.deepEqual(ids(run.state.document), []);
});

await test("an item queued between the snapshot and the acknowledgement stays queued", async () => {
  const run = bench(queueOf(text(101, "first"), text(102, "second")));
  const options = run.options({
    deliverImpl: (update) => {
      run.state.deliveries.push(update);
      run.state.document = enqueueItem(
        run.state.document,
        KEY,
        createQueueItem(text(103, "late"), 3),
      ).document;
      return Promise.resolve(true);
    },
  });

  await routing.drainReadyQueueHeads(options);
  assert.deepEqual(run.state.acks, [[101, 102]]);
  assert.deepEqual(ids(run.state.document), [103]);
});

await test("a reset that cleared part of the batch before the acknowledgement leaves no error and no leftovers", async () => {
  const run = bench(
    queueOf(text(101, "first"), text(102, "second"), text(103, "third")),
  );
  const logged: unknown[][] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    await queueRuntime.writeQueueAtomic(run.state.document);
    await routing.drainReadyQueueHeads({
      loadImpl: () => queueRuntime.loadQueue({ strict: true }),
      runningImpl: () => false,
      statusImpl: () => ({ status: "idle", generation: 0 }),
      deliverImpl: async (update) => {
        run.state.deliveries.push(update);
        // Фоновая сверка сброса между снимком и снятием (main.ts → clearChatQueue).
        await queueRuntime.clearChatQueue(KEY, 101);
        return true;
      },
      settleUntil: new Map(),
      inFlight: new Map(),
      pins: new Map(),
      rotationState: { afterKey: null },
      resetPendingImpl: () => false,
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(run.state.deliveries[0].update_id, 103);
  assert.deepEqual(await queueRuntime.loadQueue({ strict: true }), {
    version: 1,
    queues: {},
  });
  assert.deepEqual(
    logged.filter((line) => line.join(" ").includes("ack failed")),
    [],
  );
});

// update_id Telegram не обязан расти (§5 п. 1), а сброс /new убирает id не больше своего:
// из закреплённой пачки 1000+5 он уносит 5 и оставляет 1000. Остаток уже был в ходе с id 5.
await test("a reset that cut a pinned batch replays the rest under the batch's update_id, so the ledger answers handled", async () => {
  await queueRuntime.writeQueueAtomic(
    queueOf(text(1000, "first"), text(5, "last")),
  );
  const ledger = new Set<number>();
  const turns: unknown[][] = [];
  const delivered: number[] = [];
  let generation = 0;
  let failAck = true;
  const options: DrainOptions = {
    loadImpl: () => queueRuntime.loadQueue({ strict: true }),
    runningImpl: () => false,
    statusImpl: () => ({ status: "idle", generation }),
    deliverImpl: (update) => {
      delivered.push(update.update_id);
      if (ledger.has(update.update_id)) return Promise.resolve("handled");
      ledger.add(update.update_id);
      turns.push(partTexts(update));
      generation += 2;
      return Promise.resolve(true);
    },
    acknowledgeImpl: (key, updateIds) => {
      if (!failAck)
        return queueRuntime.acknowledgeTelegramQueueItems(key, updateIds);
      failAck = false;
      return Promise.reject(
        Object.assign(new Error("injected ack rollback"), {
          code: TELEGRAM_QUEUE_ACK_ROLLED_BACK,
        }),
      );
    },
    settleUntil: new Map(),
    inFlight: new Map(),
    pins: new Map(),
    rotationState: { afterKey: null },
    now: () => 1_000,
    resetPendingImpl: () => false,
  };
  const originalLog = console.log;
  console.log = () => {};
  try {
    await routing.drainReadyQueueHeads(options);
    assert.deepEqual(turns, [["first", "last"]]);
    assert.deepEqual(options.pins!.get(KEY), [1000, 5]);

    await queueRuntime.clearChatQueue(KEY, 6); // /new с update_id 6
    assert.deepEqual(
      ids(await queueRuntime.loadQueue({ strict: true })),
      [1000],
    );

    await routing.drainReadyQueueHeads(options);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(turns, [["first", "last"]], "first reached one turn only");
  assert.deepEqual(delivered, [5, 5]);
  assert.equal(options.pins!.has(KEY), false);
  assert.deepEqual(await queueRuntime.loadQueue({ strict: true }), {
    version: 1,
    queues: {},
  });
});

await test("a fatal acknowledgement drops the pin with the in-flight gate and stops the pass", async () => {
  const run = bench(queueOf(text(101, "first"), text(102, "second")));
  const fatal = Object.assign(new Error("ack durability is unknown"), {
    code: TELEGRAM_QUEUE_FATAL_DURABILITY,
  });
  const options = run.options({
    acknowledgeImpl: () => Promise.reject(fatal),
  });

  await assert.rejects(routing.drainReadyQueueHeads(options), fatal);
  assert.equal(options.pins!.has(KEY), false);
  assert.equal(options.inFlight!.has(KEY), false);
});

await test("a pin that no longer matches the head is dropped and the batch is chosen afresh", async () => {
  const run = bench(queueOf(text(101, "first"), text(102, "second")));
  const options = run.options();
  options.pins!.set(KEY, [999]);

  await routing.drainReadyQueueHeads(options);
  assert.deepEqual(run.state.acks, [[101, 102]]);
  assert.equal(options.pins!.has(KEY), false);
});

await test("messages queued during compaction reach Iva in one delivery once the chat is free", async () => {
  const run = bench({ version: 1, queues: {} });
  run.state.running = true;
  const notices: number[] = [];
  for (const [updateId, body] of [
    [101, "one"],
    [102, "two"],
    [103, "three"],
  ] as const) {
    const result = await routing.routeMessageUpdate(
      text(updateId, body),
      routeOptions({
        loadQueueImpl: () => Promise.resolve(run.state.document),
        runningImpl: () => run.state.running,
        turnPolicyImpl: () => "queue",
        compactingImpl: () => true,
        enqueueImpl: (key, candidate) => {
          const result = enqueueItem(
            run.state.document,
            key,
            createQueueItem(candidate, updateId),
          );
          run.state.document = result.document;
          return Promise.resolve(result);
        },
        acknowledgeImpl: (_update, count) => {
          notices.push(count);
          return Promise.resolve();
        },
      }),
    );
    assert.equal(result, "queued");
  }
  assert.deepEqual(notices, [1, 2, 3]);
  const options = run.options();
  await routing.drainReadyQueueHeads(options);
  assert.deepEqual(run.state.deliveries, [], "compaction holds the chat");

  run.state.running = false;
  await drainAll(run, options);
  assert.equal(run.state.deliveries.length, 1);
  assert.deepEqual(partTexts(run.state.deliveries[0]), ["one", "two", "three"]);
});

// --- Маршрут R1 и Trace постановки ---

function routeOptions(overrides: Partial<RouteOptions> = {}): RouteOptions {
  return {
    chatKeyImpl: () => KEY,
    loadQueueImpl: () => Promise.resolve({ version: 1, queues: {} }),
    runningImpl: () => false,
    turnPolicyImpl: () => "steer",
    inFlight: new Map(),
    queueCountImpl: queueCount,
    shouldQueueImpl: () => true,
    enqueueImpl: () => Promise.resolve({ count: 1, added: true }),
    acknowledgeImpl: () => Promise.resolve(),
    traceQueuedImpl: () => {},
    deliverImpl: () => Promise.resolve(true),
    statusImpl: () => null,
    setStatusIfImpl: () => null,
    sendFailureImpl: () => Promise.resolve(),
    alertImpl: (_dir, _key, _essence, send) =>
      send().then((sent) => (sent ? "sent" : "failed")),
    alertResolvedImpl: () => {},
    alertDataDir: root,
    now: () => 1_000,
    logImpl: () => {},
    resetPendingImpl: () => false,
    compactingImpl: () => false,
    ...overrides,
  };
}

const waiting = queueOf(text(90, "waiting"));

await test("steer with a non-empty chat queue puts the new message behind it, even when the chat is free", async () => {
  const delivered: number[] = [];
  const enqueued: number[] = [];
  const result = await routing.routeMessageUpdate(
    text(101, "new"),
    routeOptions({
      loadQueueImpl: () => Promise.resolve(waiting),
      enqueueImpl: (_key, candidate) => {
        enqueued.push(candidate.update_id);
        return Promise.resolve({ count: 2, added: true });
      },
      deliverImpl: (update) => {
        delivered.push(update.update_id);
        return Promise.resolve(true);
      },
    }),
  );
  assert.equal(result, "queued");
  assert.deepEqual(enqueued, [101]);
  assert.deepEqual(delivered, []);
});

await test("steer with an empty queue still interrupts a running turn directly", async () => {
  const delivered: number[] = [];
  const result = await routing.routeMessageUpdate(
    text(101, "now"),
    routeOptions({
      runningImpl: () => true,
      enqueueImpl: () => assert.fail("an empty queue does not hold steer"),
      deliverImpl: (update) => {
        delivered.push(update.update_id);
        return Promise.resolve(true);
      },
    }),
  );
  assert.equal(result, "delivered");
  assert.deepEqual(delivered, [101]);
});

await test("a reply to Iva bypasses a non-empty queue in steer mode", async () => {
  const delivered: number[] = [];
  const reply = text(101, "yes", {
    reply_to_message: { message_id: 50, from: { id: 9, is_bot: true } },
  });
  const result = await routing.routeMessageUpdate(
    reply,
    routeOptions({
      loadQueueImpl: () => Promise.resolve(waiting),
      replyToBotImpl: (message) => message.reply_to_message !== undefined,
      enqueueImpl: () => assert.fail("a reply goes straight to Iva"),
      deliverImpl: (update) => {
        delivered.push(update.update_id);
        return Promise.resolve(true);
      },
    }),
  );
  assert.equal(result, "delivered");
  assert.deepEqual(delivered, [101]);
});

await test("queue mode keeps its decision: free chat with an empty queue goes direct, a running turn queues", async () => {
  assert.equal(
    await routing.routeMessageUpdate(
      text(101, "free"),
      routeOptions({ turnPolicyImpl: () => "queue" }),
    ),
    "delivered",
  );
  assert.equal(
    await routing.routeMessageUpdate(
      text(102, "busy"),
      routeOptions({
        turnPolicyImpl: () => "queue",
        runningImpl: () => true,
        deliverImpl: () => assert.fail("a running turn holds queue mode"),
      }),
    ),
    "queued",
  );
});

await test("bridge.queued is traced once per new queue item and never breaks the route", async () => {
  const traced: Array<[number, number]> = [];
  const trace = (update: Update, count: number) => {
    traced.push([update.update_id, count]);
  };
  const order: string[] = [];
  assert.equal(
    await routing.routeMessageUpdate(
      text(101, "new"),
      routeOptions({
        runningImpl: () => true,
        turnPolicyImpl: () => "queue",
        enqueueImpl: () => Promise.resolve({ count: 3, added: true }),
        traceQueuedImpl: (update, count) => {
          order.push("trace");
          trace(update, count);
        },
        acknowledgeImpl: () => {
          order.push("notice");
          return Promise.resolve();
        },
      }),
    ),
    "queued",
  );
  assert.deepEqual(traced, [[101, 3]]);
  assert.deepEqual(order, ["trace", "notice"]);

  assert.equal(
    await routing.routeMessageUpdate(
      text(101, "new"),
      routeOptions({
        runningImpl: () => true,
        turnPolicyImpl: () => "queue",
        enqueueImpl: () => Promise.resolve({ count: 3, added: false }),
        traceQueuedImpl: trace,
      }),
    ),
    "queued",
  );
  assert.deepEqual(traced, [[101, 3]], "a duplicate keeps its first time");

  let noticed = 0;
  assert.equal(
    await routing.routeMessageUpdate(
      text(102, "disk full"),
      routeOptions({
        runningImpl: () => true,
        turnPolicyImpl: () => "queue",
        traceQueuedImpl: () => {
          throw new Error("ENOSPC");
        },
        acknowledgeImpl: () => {
          noticed++;
          return Promise.resolve();
        },
      }),
    ),
    "queued",
  );
  assert.equal(noticed, 1);
});

await test("a queued message names why it waits: the chat record state, a pending reset or the queue", async () => {
  const reasons: string[] = [];
  const logged: string[] = [];
  const at = Date.now();
  const route = (overrides: Partial<RouteOptions>) =>
    routing.routeMessageUpdate(
      text(103 + reasons.length, "new"),
      routeOptions({
        turnPolicyImpl: () => "queue",
        traceQueuedImpl: (_update, _count, reason) => reasons.push(reason),
        logImpl: (...parts) => logged.push(parts.join(" ")),
        ...overrides,
      }),
    );
  const busy = { status: "running", sessionId: "s", updatedAt: at } as const;
  for (const statusImpl of [
    () => ({ ...busy, turnId: "t" }),
    () => ({ ...busy, compacting: true as const }),
    () => ({ status: "running" as const, ingressId: "i", updatedAt: at }),
  ])
    assert.equal(
      await route({ runningImpl: () => true, statusImpl }),
      "queued",
    );
  assert.equal(await route({ resetPendingImpl: () => true }), "queued");
  assert.equal(
    await route({ loadQueueImpl: () => Promise.resolve(waiting) }),
    "queued",
  );
  assert.deepEqual(reasons, [
    "chat busy: turn",
    "chat busy: compacting",
    "chat busy: accepted",
    "reset pending",
    "earlier messages wait",
  ]);
  assert.deepEqual(
    logged,
    reasons.map((reason, index) => `queued update ${103 + index}: ${reason}`),
  );
});

// --- Пометка тапа ---

await test("a tap marker survives the queue validator and the queue file round trip", async () => {
  const tap = text(101, "Remind me", { [TELEGRAM_BUTTON_TAP_FIELD]: true });
  assert.equal(isTelegramQueueUpdate(tap), true);
  const file = join(root, "tap-queue.json");
  await enqueueQueueFile(file, KEY, tap);
  const { document } = await loadQueueFile(file, { strict: true });
  assert.equal(
    document.queues[KEY][0].update?.message?.[TELEGRAM_BUTTON_TAP_FIELD],
    true,
  );
});
