import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  runSteps,
  step,
  SETTLE,
  updateIds,
  SEED,
} from "../fixtures/queue-drain-model.ts";
await test("property: the queue drain never loses a message, duplicates only after a break, keeps order and alone stays alone", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom<"queue" | "steer">("queue", "steer"),
      updateIds,
      fc.array(step, { minLength: 10, maxLength: 60, size: "max" }),
      async (policy, ids, steps) => {
        const machine = await runSteps(policy, ids, [...steps, ...SETTLE]);
        assert.deepEqual(machine.violations, []);
        assert.equal(
          new Set([...machine.seen, ...machine.discarded]).size,
          machine.arrived,
          "everything reached a turn or was discarded by a reset",
        );
      },
    ),
    { seed: SEED, numRuns: 600 },
  );
});

// Контрпример F1 из модели (QueueDrain-switch.cfg): у автора в очереди 1 и 2, Bridge
// перезапускается между маршрутом 2 и снятием 2 с inbox, владелец включает
// «Перебивать». Без R1 сообщение 2 ушло бы прямой доставкой в ledger, пачка 1+2 с id 2
// получила бы handled, и 1 пропало бы. С R1 2 встаёт за 1.
await test("a restart between the route and the inbox removal, then steer, keeps every message", async () => {
  const machine = await runSteps(
    "queue",
    [501, 502, 503, 504, 505, 506, 507],
    [
      { t: "arrive", author: 0, kind: "plain" },
      { t: "arrive", author: 0, kind: "plain" },
      { t: "busy" },
      { t: "route", author: 0, outcome: "accept" },
      { t: "inboxAck", author: 0 },
      { t: "route", author: 0, outcome: "accept" },
      { t: "restart" },
      { t: "switch" },
      { t: "route", author: 0, outcome: "accept" },
      { t: "inboxAck", author: 0 },
      { t: "free" },
      { t: "drain", outcome: "accept" },
    ],
  );
  assert.deepEqual(machine.violations, []);
  assert.deepEqual([...machine.seen].sort(), [1, 2]);
  assert.deepEqual(machine.document, { version: 1, queues: {} });
});

await test("switching to steer while messages wait keeps the new message behind them", async () => {
  const machine = await runSteps(
    "queue",
    [9, 3, 7, 1, 5, 2, 4],
    [
      { t: "busy" },
      { t: "arrive", author: 0, kind: "plain" },
      { t: "route", author: 0, outcome: "accept" },
      { t: "inboxAck", author: 0 },
      { t: "switch" },
      { t: "free" },
      { t: "arrive", author: 0, kind: "plain" },
      { t: "route", author: 0, outcome: "accept" },
      { t: "inboxAck", author: 0 },
      { t: "drain", outcome: "accept" },
    ],
  );
  assert.deepEqual(machine.violations, []);
  assert.deepEqual(machine.recordedBy.get(3), [1, 2], "one turn for both");
});

// Сброс /new режет закреплённую пачку: id не обязаны расти, и фильтр clearChatQueue
// уносит из пачки 1000+5 только 5. Остаток 1000 уже был в ходе с id 5 и обязан уйти
// под тем же id: ledger отвечает handled, второго хода с 1000 нет.
await test("a reset that cuts a pinned batch does not start a second turn with its rest", async () => {
  const machine = await runSteps(
    "queue",
    [1000, 5, 7, 8, 9, 10, 11],
    [
      { t: "busy" },
      { t: "arrive", author: 0, kind: "plain" },
      { t: "promote", author: 0, outcome: "accept" },
      { t: "arrive", author: 0, kind: "plain" },
      { t: "promote", author: 0, outcome: "accept" },
      { t: "free" },
      { t: "ackFail" },
      { t: "drain", outcome: "accept" },
      { t: "reset", pick: 1 },
      { t: "free" },
      { t: "drain", outcome: "accept" },
    ],
  );
  assert.deepEqual(machine.violations, []);
  assert.deepEqual(machine.recordedBy.get(5), [1, 2], "one turn for both");
  assert.equal(machine.recordedBy.size, 1);
  assert.deepEqual(machine.document, { version: 1, queues: {} });
});

// Сброс унёс последний id закрепа, а маршрут из inbox после перезапуска вернул его в
// хвост за чужим сообщением. Снятие берёт только голову, иначе пачка «не с головы» и
// чат встаёт; сам возвращённый id получает handled — он уже был в ходе.
await test("a reset id that comes back behind another author's message does not block the chat", async () => {
  const machine = await runSteps(
    "queue",
    [453256, 2, 3, 4, 5, 6, 7],
    [
      { t: "busy" },
      { t: "arrive", author: 0, kind: "plain" },
      { t: "promote", author: 0, outcome: "accept" },
      { t: "arrive", author: 0, kind: "plain" },
      { t: "route", author: 0, outcome: "accept" },
      { t: "restart" },
      { t: "free" },
      { t: "ackFail" },
      { t: "drain", outcome: "accept" },
      { t: "reset", pick: 1 },
      { t: "arrive", author: 1, kind: "plain" },
      { t: "promote", author: 1, outcome: "accept" },
      { t: "promote", author: 0, outcome: "accept" },
      ...SETTLE,
    ],
  );
  assert.deepEqual(machine.violations, []);
  assert.deepEqual([...machine.seen].sort(), [1, 2, 3]);
  assert.equal(machine.recordedBy.get(453256), undefined, "no turn under 1");
  assert.deepEqual(machine.document, { version: 1, queues: {} });
});
