import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import {
  acknowledgeQueueItems,
  createQueueItem,
  enqueueItem,
  loadQueueFile,
  quarantineQueueRecords,
  removeQueueItems,
  type TelegramQueueDocument,
  type TelegramQueueUpdate,
} from "../lib/telegram-queue.ts";
import {
  admitTelegramUpdate,
  inboxKeyFor,
  promoteReadyInbox,
  selectReadyInboxBatch,
  terminalDropLine,
} from "./inbox.ts";

const SEED = 18_702;

// Мост пишет журнал хода (ADR-0010) из СВОЕГО процесса, в тот же дневной файл, что и
// агент. Каталог данных — временный: писатель резолвит его на каждой записи.
const traceRoot = mkdtempSync(join(tmpdir(), "iva-bridge-trace-"));
process.env.ASSISTANT_DATA_DIR = join(traceRoot, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
const trace = await import("#lib/trace.ts");
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

function update(updateId: number, text: string): TelegramQueueUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 1, type: "private" },
      from: { id: 42, is_bot: false },
      text,
    },
  };
}

function inboxDocument(
  ...updates: TelegramQueueUpdate[]
): TelegramQueueDocument {
  return updates.reduce<TelegramQueueDocument>(
    (document, candidate, index) => {
      const key = inboxKeyFor(candidate);
      assert.ok(key);
      return enqueueItem(document, key, createQueueItem(candidate, index * 100))
        .document;
    },
    { version: 1, queues: {} },
  );
}

function promotionBackoff() {
  return new Map<string, { failures: number; nextAttemptAt: number }>();
}

function callback(updateId: number, fromId = 42): TelegramQueueUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: fromId, is_bot: false },
      message: {
        message_id: updateId - 1,
        chat: { id: 1, type: "private" },
      },
      data: "foreign_callback",
    },
  };
}

function inlineCallback(updateId: number, fromId = 42): TelegramQueueUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `inline-callback-${updateId}`,
      from: { id: fromId, is_bot: false },
      inline_message_id: "inline-message-1",
      data: "foreign_inline_callback",
    },
  };
}

void test("durable inbox waits for quiet and then merges the owned burst", () => {
  const document = inboxDocument(update(101, "first"), update(102, "second"));
  assert.equal(
    selectReadyInboxBatch("1::42", document.queues["1::42"], 899, {
      quietMs: 800,
    }),
    null,
  );
  const batch = selectReadyInboxBatch("1::42", document.queues["1::42"], 900, {
    quietMs: 800,
  });
  assert.ok(batch?.update.message?.iva_parts);
  assert.equal(batch.update.update_id, 102);
  assert.deepEqual(batch.updateIds, [101, 102]);
  assert.deepEqual(
    batch.update.message.iva_parts.map((part) => part.text),
    ["first", "second"],
  );
});

void test("property: durable reconstruction returns the exact ready prefix", () => {
  fc.assert(
    fc.property(
      fc
        .uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), {
          minLength: 1,
          maxLength: 10,
        })
        .map((ids) => ids.sort((left, right) => left - right)),
      fc.integer({ min: 0, max: 500 }),
      (updateIds, quietMs) => {
        const document = inboxDocument(
          ...updateIds.map((updateId) => update(updateId, `part-${updateId}`)),
        );
        const batch = selectReadyInboxBatch(
          "1::42",
          document.queues["1::42"],
          (updateIds.length - 1) * 100 + quietMs,
          { quietMs },
        );
        assert.ok(batch);
        const expectedIds = quietMs === 0 ? updateIds.slice(0, 1) : updateIds;
        assert.deepEqual(batch.updateIds, expectedIds);
        assert.equal(batch.update.update_id, Math.max(...expectedIds));
      },
    ),
    { seed: SEED, numRuns: 1_000 },
  );
});

void test("callback inbox keys are stable passthrough keys and cannot collide with message collectors", () => {
  const message = update(101, "message");
  const callbackUpdate = callback(102);
  assert.equal(inboxKeyFor(message), "1::42");
  assert.equal(inboxKeyFor(callbackUpdate), "callback:1:");
  assert.notEqual(inboxKeyFor(message), inboxKeyFor(callbackUpdate));

  const document = inboxDocument(callbackUpdate);
  const batch = selectReadyInboxBatch(
    "callback:1:",
    document.queues["callback:1:"],
    0,
    { quietMs: 800 },
  );
  assert.deepEqual(batch, {
    update: callbackUpdate,
    updateIds: [102],
    arrivedAt: 0,
    resetFence: null,
  });
});

void test("an allowed inline callback has a bounded sender key and remains passthrough", async () => {
  const candidate = inlineCallback(103);
  const key = inboxKeyFor(candidate);
  assert.match(key ?? "", /^callback:inline:[0-9a-f]{64}$/u);
  const owned: string[] = [];
  assert.equal(
    await admitTelegramUpdate(candidate, {
      allowedUserIds: new Set(["42"]),
      enqueueImpl: (candidateKey) => {
        owned.push(candidateKey);
        return Promise.resolve();
      },
    }),
    "owned",
  );
  assert.deepEqual(owned, [key]);
  const document = inboxDocument(candidate);
  assert.deepEqual(
    selectReadyInboxBatch(key as string, document.queues[key as string], 0, {
      quietMs: 800,
    }),
    { update: candidate, updateIds: [103], arrivedAt: 0, resetFence: null },
  );
});

void test("property: callback and message inbox key spaces never collide", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: undefined }),
      (chatId, fromId, threadId) => {
        const message = update(101, "message");
        assert.ok(message.message);
        message.message.chat = { id: chatId, type: "private" };
        message.message.from = { id: fromId, is_bot: false };
        if (threadId !== undefined)
          message.message.message_thread_id = threadId;
        const callbackUpdate = callback(102, fromId);
        assert.ok(callbackUpdate.callback_query?.message);
        callbackUpdate.callback_query.message.chat = {
          id: chatId,
          type: "private",
        };
        if (threadId !== undefined) {
          callbackUpdate.callback_query.message.message_thread_id = threadId;
        }
        const messageKey = inboxKeyFor(message);
        const callbackKey = inboxKeyFor(callbackUpdate);
        assert.ok(messageKey);
        assert.ok(callbackKey);
        assert.match(callbackKey, /^callback:/u);
        assert.notEqual(messageKey, callbackKey);
      },
    ),
    { seed: SEED, numRuns: 1_000 },
  );
});

void test("promotion publishes the delivery item before removing raw ownership", async () => {
  let document = inboxDocument(update(101, "first"), update(102, "second"));
  const events: string[] = [];
  const remaining = await promoteReadyInbox({
    backoff: promotionBackoff(),
    now: () => 1_000,
    collectorOptions: { quietMs: 800 },
    loadImpl: () => Promise.resolve(document),
    routeImpl: (candidate) => {
      events.push(`route:${candidate.update_id}`);
      return Promise.resolve("queued");
    },
    acknowledgeImpl: (key, updateIds) => {
      events.push(`ack:${updateIds.join(",")}`);
      document = removeQueueItems(document, key, updateIds).document;
      return Promise.resolve();
    },
  });

  assert.equal(remaining, 0);
  // Пачка inbox снимается одной записью: обрыв между частями не оставит остаток
  // с тем же update_id, который ушёл бы прямой доставкой мимо полной копии.
  assert.deepEqual(events, ["route:102", "ack:101,102"]);
});

// IVB-501: отсечка сброса идёт по времени прибытия. Элемент очереди обязан
// унаследовать enqueuedAt входящей записи, иначе сообщение до /new, пролежавшее
// в коллекторе, выжило бы сброс со свежим штампом промоута.
void test("promotion carries the inbox arrival time to the queue item", async () => {
  const document = inboxDocument(update(101, "early"));
  const routed: { updateId: number; arrivedAt?: number }[] = [];
  await promoteReadyInbox({
    backoff: promotionBackoff(),
    now: () => 1_000,
    collectorOptions: { quietMs: 800 },
    loadImpl: () => Promise.resolve(document),
    routeImpl: (candidate, options) => {
      routed.push({
        updateId: candidate.update_id,
        arrivedAt: options?.arrivedAt,
      });
      return Promise.resolve("queued");
    },
    acknowledgeImpl: () => Promise.resolve(),
  });
  assert.deepEqual(routed, [{ updateId: 101, arrivedAt: 0 }]);
});

// IVB-501: записи до границы /new мертвы — промоут снимает их с durable-владения
// до склейки коллектора, и до маршрута доходят только части текущей эпохи.
void test("promotion drops pre-reset items before merging the batch", async () => {
  let document: TelegramQueueDocument = {
    version: 1,
    queues: {
      "1::42": [
        createQueueItem(update(101, "before /new"), 0),
        { ...createQueueItem(update(102, "after /new"), 100), resetFence: 7 },
      ],
    },
  };
  const acknowledgements: number[][] = [];
  const routed: { updateId: number; resetFence?: number | null }[] = [];
  const remaining = await promoteReadyInbox({
    backoff: promotionBackoff(),
    now: () => 1_000,
    collectorOptions: { quietMs: 800 },
    loadImpl: () => Promise.resolve(document),
    resetEpochImpl: (key) => (key === "1:" ? 7 : undefined),
    routeImpl: (candidate, options) => {
      routed.push({
        updateId: candidate.update_id,
        resetFence: options?.resetFence,
      });
      return Promise.resolve("queued");
    },
    acknowledgeImpl: (key, updateIds) => {
      acknowledgements.push([...updateIds]);
      document = removeQueueItems(document, key, updateIds).document;
      return Promise.resolve();
    },
  });
  assert.equal(remaining, 0);
  assert.deepEqual(routed, [{ updateId: 102, resetFence: 7 }]);
  assert.deepEqual(acknowledgements, [[101], [102]]);
});

void test("failed promotion keeps every raw part for retry", async () => {
  const document = inboxDocument(update(101, "first"), update(102, "second"));
  let acknowledgements = 0;
  assert.equal(
    await promoteReadyInbox({
      backoff: promotionBackoff(),
      now: () => 1_000,
      collectorOptions: { quietMs: 800 },
      loadImpl: () => Promise.resolve(document),
      routeImpl: () => Promise.resolve("enqueue-failed"),
      acknowledgeImpl: () => {
        acknowledgements++;
        return Promise.resolve();
      },
    }),
    0,
  );
  assert.equal(acknowledgements, 0);
});

void test("rejected inbox promotion backs off the key until its next attempt", async () => {
  const document = inboxDocument(update(101, "retry me"));
  const backoff = promotionBackoff();
  let currentNow = 1_000;
  let routes = 0;
  const promote = () =>
    promoteReadyInbox({
      backoff,
      now: () => currentNow,
      collectorOptions: { quietMs: 0 },
      loadImpl: () => Promise.resolve(document),
      routeImpl: () => {
        routes++;
        return Promise.resolve("rejected");
      },
    });

  assert.equal(await promote(), 0);
  assert.equal(routes, 1);
  currentNow = 15_999;
  assert.equal(await promote(), 0);
  assert.equal(routes, 1);
  currentNow = 16_000;
  assert.equal(await promote(), 0);
  assert.equal(routes, 2);
});

void test("successful inbox promotion clears prior backoff state", async () => {
  let document = inboxDocument(update(101, "deliver me"));
  const backoff = promotionBackoff();
  backoff.set("1::42", { failures: 2, nextAttemptAt: 1_000 });

  assert.equal(
    await promoteReadyInbox({
      backoff,
      now: () => 1_000,
      collectorOptions: { quietMs: 0 },
      loadImpl: () => Promise.resolve(document),
      routeImpl: () => Promise.resolve("delivered"),
      acknowledgeImpl: (key, updateIds) => {
        document = removeQueueItems(document, key, updateIds).document;
        return Promise.resolve();
      },
    }),
    0,
  );
  assert.equal(backoff.has("1::42"), false);
});

void test("callback rejection and enqueue failure retain inbox ownership", async () => {
  for (const result of ["rejected", "enqueue-failed"] as const) {
    const document = inboxDocument(callback(101));
    let acknowledgements = 0;
    assert.equal(
      await promoteReadyInbox({
        backoff: promotionBackoff(),
        now: () => 0,
        loadImpl: () => Promise.resolve(document),
        routeImpl: () => Promise.resolve(result),
        acknowledgeImpl: () => {
          acknowledgements++;
          return Promise.resolve();
        },
      }),
      0,
    );
    assert.equal(acknowledgements, 0, result);
  }
});

void test("a terminally dropped update leaves the inbox instead of looping forever", async () => {
  let document = inboxDocument(update(101, "reply to a closed session"));
  const routed: number[] = [];
  const remaining = await promoteReadyInbox({
    backoff: promotionBackoff(),
    now: () => 1_000,
    collectorOptions: { quietMs: 800 },
    loadImpl: () => Promise.resolve(document),
    routeImpl: (candidate) => {
      routed.push(candidate.update_id);
      return Promise.resolve("terminal-drop");
    },
    acknowledgeImpl: (key, updateIds) => {
      document = removeQueueItems(document, key, updateIds).document;
      return Promise.resolve();
    },
  });

  assert.equal(remaining, 0);
  assert.deepEqual(routed, [101]);
  assert.deepEqual(document.queues, {});
});

void test("property: terminal results never loop while transient results never lose an update", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom("terminal-drop", "rejected", "delivered"), {
        minLength: 1,
        maxLength: 8,
      }),
      fc.integer({ min: 1, max: 6 }),
      async (outcomes, passes) => {
        // Свой чат на каждый апдейт: иначе коллектор склеит их в одну голову.
        let document = outcomes.reduce<TelegramQueueDocument>(
          (accumulator, _outcome, index) => {
            const candidate = update(200 + index, `part-${index}`);
            assert.ok(candidate.message);
            candidate.message.chat = { id: 200 + index, type: "private" };
            const key = inboxKeyFor(candidate);
            assert.ok(key);
            return enqueueItem(accumulator, key, createQueueItem(candidate, 0))
              .document;
          },
          { version: 1, queues: {} },
        );
        const verdicts = new Map(
          outcomes.map((outcome, index) => [200 + index, outcome]),
        );
        const deliveries: number[] = [];
        const attempts = new Map<number, number>();
        const backoff = promotionBackoff();

        for (let pass = 0; pass < passes; pass++) {
          await promoteReadyInbox({
            backoff,
            now: () => pass * 300_001,
            collectorOptions: { quietMs: 0 },
            loadImpl: () => Promise.resolve(document),
            routeImpl: (candidate) => {
              const verdict = verdicts.get(candidate.update_id);
              assert.ok(verdict);
              attempts.set(
                candidate.update_id,
                (attempts.get(candidate.update_id) ?? 0) + 1,
              );
              if (verdict === "delivered") deliveries.push(candidate.update_id);
              return Promise.resolve(verdict);
            },
            acknowledgeImpl: (key, updateIds) => {
              document = removeQueueItems(document, key, updateIds).document;
              return Promise.resolve();
            },
          });
        }

        // Терминальный апдейт живёт ровно один проход, доставленный уходит в агента
        // ровно один раз, транзиентный ретраится каждый проход и остаётся на месте.
        for (const [updateId, verdict] of verdicts) {
          const seen = attempts.get(updateId) ?? 0;
          assert.equal(
            seen,
            verdict === "rejected" ? passes : 1,
            `${verdict} ${String(updateId)}`,
          );
        }
        assert.equal(new Set(deliveries).size, deliveries.length);
        assert.equal(
          Object.values(document.queues).flat().length,
          outcomes.filter((outcome) => outcome === "rejected").length,
        );
        return true;
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
});

void test("admission owns trusted input and drops group noise before any offset may move", async () => {
  const owned: Array<[string, number]> = [];
  assert.equal(
    await admitTelegramUpdate(update(101, "private"), {
      allowedUserIds: new Set(["42"]),
      botUsername: "iva_bot",
      enqueueImpl: (key, candidate) => {
        owned.push([key, candidate.update_id]);
        return Promise.resolve();
      },
    }),
    "owned",
  );
  const noise = update(102, "group noise");
  assert.ok(noise.message);
  noise.message.chat = { id: -100, type: "supergroup" };
  assert.equal(
    await admitTelegramUpdate(noise, {
      allowedUserIds: new Set(["42"]),
      botUsername: "iva_bot",
      enqueueImpl: () => assert.fail("noise must not be persisted"),
    }),
    "terminal-drop",
  );
  assert.deepEqual(owned, [["1::42", 101]]);
});

void test("trusted local synthetic input uses the canonical inbox despite group ingress policy", async () => {
  const synthetic = update(-401, "[Core memory setup]");
  assert.ok(synthetic.message);
  synthetic.message.message_id = 401;
  synthetic.message.chat = { id: -100, type: "supergroup" };
  const owned: Array<[string, number]> = [];

  assert.equal(
    await admitTelegramUpdate(synthetic, {
      trustedLocal: true,
      allowedUserIds: new Set(),
      enqueueImpl: (key, candidate) => {
        owned.push([key, candidate.update_id]);
        return Promise.resolve();
      },
    }),
    "owned",
  );
  assert.deepEqual(owned, [["-100::42", -401]]);
});

void test("trusted local duplicate retry stays one canonical inbox item", async () => {
  const synthetic = update(-402, "[Core memory setup]");
  assert.ok(synthetic.message);
  synthetic.message.message_id = 402;
  let document: TelegramQueueDocument = { version: 1, queues: {} };
  const added: boolean[] = [];
  const enqueueImpl = (key: string, candidate: TelegramQueueUpdate) => {
    const result = enqueueItem(document, key, createQueueItem(candidate, 1));
    document = result.document;
    added.push(result.added);
    return Promise.resolve();
  };

  assert.equal(
    await admitTelegramUpdate(synthetic, { trustedLocal: true, enqueueImpl }),
    "owned",
  );
  assert.equal(
    await admitTelegramUpdate(synthetic, { trustedLocal: true, enqueueImpl }),
    "owned",
  );
  assert.deepEqual(added, [true, false]);
  assert.equal(document.queues["1::42"].length, 1);
});

void test("trusted local inbox write fault fails ownership proof", async () => {
  const synthetic = update(-403, "[Core memory setup]");
  assert.equal(
    await admitTelegramUpdate(synthetic, {
      trustedLocal: true,
      enqueueImpl: () => Promise.reject(new Error("injected write fault")),
      logImpl: () => {},
    }),
    "write-failed",
  );
});

void test("callback admission owns allowed users, terminally drops known unauthorised users, and fails closed without a key", async () => {
  const owned: Array<[string, number]> = [];
  assert.equal(
    await admitTelegramUpdate(callback(101), {
      allowedUserIds: new Set(["42"]),
      enqueueImpl: (key, candidate) => {
        owned.push([key, candidate.update_id]);
        return Promise.resolve();
      },
    }),
    "owned",
  );
  assert.equal(
    await admitTelegramUpdate(callback(102, 99), {
      allowedUserIds: new Set(["42"]),
      enqueueImpl: () => assert.fail("unauthorised callback must not persist"),
    }),
    "terminal-drop",
  );
  const unownable = callback(103);
  assert.ok(unownable.callback_query);
  delete unownable.callback_query.message;
  assert.equal(
    await admitTelegramUpdate(unownable, {
      allowedUserIds: new Set(["42"]),
      enqueueImpl: () => assert.fail("callback without a key must fail closed"),
    }),
    "unownable",
  );
  const missingSender = inlineCallback(104);
  assert.ok(missingSender.callback_query);
  delete missingSender.callback_query.from;
  assert.equal(
    await admitTelegramUpdate(missingSender, {
      allowedUserIds: new Set(["42"]),
      enqueueImpl: () =>
        assert.fail("callback without a sender must fail closed"),
    }),
    "unownable",
  );
  const missingId = callback(105);
  assert.ok(missingId.callback_query);
  missingId.callback_query.id = "";
  assert.equal(
    await admitTelegramUpdate(missingId, {
      allowedUserIds: new Set(["42"]),
      enqueueImpl: () => assert.fail("callback without an id must fail closed"),
    }),
    "unownable",
  );
  assert.deepEqual(owned, [["callback:1:", 101]]);
});

void test("Trace: мост пишет вердикт приёма своим ключом апдейта", async () => {
  const before = traceEvents().length;

  await admitTelegramUpdate(update(701, "принимай"), {
    allowedUserIds: new Set(["42"]),
    enqueueImpl: () => Promise.resolve(),
  });
  await admitTelegramUpdate(update(702, "чужое"), {
    allowedUserIds: new Set(["7"]),
    enqueueImpl: () => assert.fail("чужой апдейт не ставится в очередь"),
  });

  const added = traceEvents().slice(before);
  // Имя события следует исходу: принятый апдейт и отброшенный — разные строки ленты.
  assert.deepEqual(
    added.map((event) => `${String(event.kind)}.${String(event.name)}`),
    ["bridge.admitted", "bridge.dropped"],
  );
  // Ключ апдейта — тот же, что напишет ядро: чат и сообщение, а не update_id.
  assert.equal(added[0].turn, "tg:1:701");
  assert.equal(added[0].source, "bridge");
  assert.deepEqual(added[0].data, {
    updateId: 701,
    chatId: 1,
    messageId: "701",
    kind: "message",
    decision: "owned",
  });
  assert.equal(
    (added[1].data as Record<string, unknown>).decision,
    "terminal-drop",
  );
});

void test("Trace: сбой записи в inbox виден в журнале отдельным вердиктом", async () => {
  const before = traceEvents().length;

  assert.equal(
    await admitTelegramUpdate(update(703, "не влезло"), {
      allowedUserIds: new Set(["42"]),
      enqueueImpl: () => Promise.reject(new Error("ENOSPC")),
      logImpl: () => {},
    }),
    "write-failed",
  );

  const added = traceEvents().slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].name, "dropped");
  assert.equal(
    (added[0].data as Record<string, unknown>).decision,
    "write-failed",
  );
});

// --- Bot API 10.1: rich_message ---------------------------------------------
//
// Мост судит конверт, а не список известных видов содержимого, поэтому сообщение,
// у которого текстовой проекции нет вовсе, доезжает до агента целым (ADR-0002).
const RICH_UPDATE: TelegramQueueUpdate = {
  update_id: 924_151_861,
  message: {
    message_id: 3401,
    from: { id: 42, is_bot: false },
    chat: { id: 42, type: "private" },
    date: 1_780_000_000,
    rich_message: {
      blocks: [
        {
          type: "paragraph",
          text: "Долгий текст, который не влез в 4096 знаков.",
        },
        {
          type: "list",
          items: [
            {
              label: "1.",
              blocks: [
                {
                  type: "paragraph",
                  text: { type: "bold", text: "Первый пункт" },
                },
              ],
            },
          ],
        },
      ],
    },
  },
};

void test("REGRESSION: a rich_message update from an allowed sender is owned, not dropped", async () => {
  const owned: Array<[string, number]> = [];

  assert.equal(
    await admitTelegramUpdate(RICH_UPDATE, {
      allowedUserIds: new Set(["42"]),
      botUsername: "iva_bot",
      enqueueImpl: (key, candidate) => {
        owned.push([key, candidate.update_id]);
        return Promise.resolve();
      },
    }),
    "owned",
  );
  assert.deepEqual(owned, [["42::42", 924_151_861]]);
});

void test("the drop line names the message fields and never their values", () => {
  const dropped: TelegramQueueUpdate = {
    update_id: 924_151_862,
    message: {
      message_id: 3402,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: "private" },
      date: 1_780_000_000,
      rich_message: { blocks: [{ type: "paragraph", text: "секрет" }] },
      Ключ: "мусор",
      "a b": 1,
    },
  };

  const line = terminalDropLine(dropped);

  assert.equal(
    line,
    'drop update 924151862 — terminal ingress policy; message keys: ["chat","date","from","message_id","rich_message"]',
  );
  assert.equal(line.includes("секрет"), false);
  assert.equal(line.includes("Ключ"), false);
  // Апдейт без message — это колбэк: строка остаётся прежней.
  assert.equal(
    terminalDropLine({ update_id: 5, callback_query: { id: "cb" } }),
    "drop update 5 — terminal ingress policy",
  );
});

void test("the drop line prints at most twelve field names", () => {
  const many = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`f${index}`, index]),
  );
  const line = terminalDropLine({
    update_id: 6,
    message: { ...many, chat: { id: 42, type: "private" } },
  });
  const keys = JSON.parse(line.slice(line.indexOf("["))) as string[];

  assert.equal(keys.length, 12);
  assert.deepEqual(keys, [...keys].sort());
});

// 16.10.2026: одна плохая запись входящих роняла мост, а на старте падала снова — приём
// вставал по кругу падений. Теперь она уходит в карантин, остальные доставляются.
for (const [name, damaged] of [
  ["a record the loader rejects", { version: 1, updateId: "202" }],
  [
    "a record the inbox cannot deliver",
    {
      version: 1,
      updateId: 202,
      enqueuedAt: 0,
      update: {
        ...update(202, "x"),
        message: { ...update(202, "x").message, text: 42 },
      },
    },
  ],
] as const)
  void test(`inbox promotion quarantines ${name} and delivers the rest`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "iva-inbox-damaged-"));
    try {
      const file = join(dir, "telegram-inbox.json");
      const good = update(203, "hello");
      const key = inboxKeyFor(good);
      assert.ok(key);
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          queues: { [key]: [damaged, createQueueItem(good, 0)] },
        }),
      );
      const logs: unknown[][] = [];
      const logImpl = (...parts: unknown[]) => logs.push(parts);
      const routed: number[] = [];
      const remaining = await promoteReadyInbox({
        backoff: promotionBackoff(),
        now: () => 1_000,
        collectorOptions: { quietMs: 800 },
        loadImpl: async () =>
          (await loadQueueFile(file, { strict: true, logImpl })).document,
        routeImpl: (candidate) => {
          routed.push(candidate.update_id);
          return Promise.resolve("queued");
        },
        acknowledgeImpl: (ackKey, ids) =>
          acknowledgeQueueItems(file, ackKey, ids, { strict: true }),
        quarantineImpl: (records) =>
          quarantineQueueRecords(file, records, { logImpl }),
      });

      assert.equal(remaining, 0);
      assert.deepEqual(routed, [203]);
      assert.deepEqual(
        (JSON.parse(readFileSync(file, "utf8")) as TelegramQueueDocument)
          .queues,
        {},
      );
      const copies = readdirSync(dir).filter((entry) =>
        entry.startsWith("telegram-inbox.json.damaged-"),
      );
      assert.equal(copies.length, 1);
      assert.deepEqual(
        (
          JSON.parse(readFileSync(join(dir, copies[0]), "utf8")) as {
            record: unknown;
          }
        ).record,
        damaged,
      );
      assert.equal(logs.length, 1);
      assert.equal(JSON.stringify(logs).includes("hello"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

void test("POISON dropped routing result is acknowledged once and the next inbox item proceeds", async () => {
  let document = inboxDocument(update(101, "dropped"));
  const routed: number[] = [];
  const options = {
    backoff: promotionBackoff(),
    now: () => 1000,
    collectorOptions: { quietMs: 800 },
    loadImpl: () => Promise.resolve(document),
    routeImpl: (candidate: TelegramQueueUpdate) => {
      routed.push(candidate.update_id);
      return Promise.resolve("dropped" as const);
    },
    acknowledgeImpl: (key: string, ids: readonly number[]) => {
      document = removeQueueItems(document, key, ids).document;
      return Promise.resolve();
    },
  };
  assert.equal(await promoteReadyInbox(options), 0);
  assert.deepEqual(document.queues, {});
  assert.equal(await promoteReadyInbox(options), 0);
  assert.deepEqual(routed, [101]);
  document = inboxDocument(update(102, "next"));
  assert.equal(await promoteReadyInbox(options), 0);
  assert.deepEqual(routed, [101, 102]);
});
