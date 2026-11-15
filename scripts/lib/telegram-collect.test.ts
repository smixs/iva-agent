import test from "node:test";
import assert from "node:assert/strict";
import { TELEGRAM_BUTTON_TAP_FIELD } from "#lib/telegram-parts.ts";
import {
  collectorKeyFor,
  collectorOffer,
  collectorPending,
  collectorTakeExpired,
  createCollector,
  deliveredAlone,
  joinUpdates,
  queueBatchLength,
  updateParts,
  type TelegramCollectUpdate,
} from "./telegram-collect.ts";

interface UpdateOptions {
  chatId?: number;
  threadId?: number;
  fromId?: number;
  mediaGroupId?: string;
}

function update(
  updateId: number,
  text: string,
  options: UpdateOptions = {},
): TelegramCollectUpdate & {
  message: {
    message_id: number;
    date: number;
    chat: { id: number; type: string };
    from: { id: number; is_bot: boolean };
    text: string;
    message_thread_id?: number;
    media_group_id?: string;
  };
} {
  const { chatId = 1, threadId, fromId = 42, mediaGroupId } = options;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup" },
      from: { id: fromId, is_bot: false },
      text,
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      ...(mediaGroupId === undefined ? {} : { media_group_id: mediaGroupId }),
    },
  };
}

void test("a solitary part flushes as the original update verbatim", () => {
  const collector = createCollector();
  const original = update(1, "one");

  assert.deepEqual(collectorOffer(collector, original, 100), {
    status: "buffered",
  });
  assert.deepEqual(collectorTakeExpired(collector, 899), []);
  const [flushed] = collectorTakeExpired(collector, 900);

  assert.equal(flushed, original);
  assert.equal(Object.hasOwn(flushed.message, "iva_parts"), false);
  assert.equal(collectorPending(collector), 0);
});

void test("two text messages merge in message_id order with the maximum update_id", () => {
  const collector = createCollector();
  const laterMessage = update(10, "second");
  laterMessage.message.message_id = 20;
  const earlierMessage = update(11, "first");
  earlierMessage.message.message_id = 10;

  collectorOffer(collector, laterMessage, 0);
  collectorOffer(collector, earlierMessage, 100);
  const [flushed] = collectorTakeExpired(collector, 900);

  assert.equal(flushed.update_id, 11);
  assert.equal(flushed.message!.message_id, 10);
  assert.deepEqual(
    flushed.message!.iva_parts!.map((part) => [part.message_id, part.text]),
    [
      [10, "first"],
      [20, "second"],
    ],
  );
  assert.equal(Object.hasOwn(earlierMessage.message, "iva_parts"), false);
});

void test("each offer resets the trailing quiet window", () => {
  const collector = createCollector();
  collectorOffer(collector, update(1, "first"), 0);
  assert.deepEqual(collectorTakeExpired(collector, 799), []);

  collectorOffer(collector, update(2, "second"), 799);
  assert.deepEqual(collectorTakeExpired(collector, 1598), []);
  assert.equal(collectorTakeExpired(collector, 1599).length, 1);
});

void test("a last media-group part uses the longer quiet window", () => {
  const collector = createCollector();
  collectorOffer(collector, update(1, "caption", { mediaGroupId: "album" }), 0);

  assert.deepEqual(collectorTakeExpired(collector, 1499), []);
  assert.equal(collectorTakeExpired(collector, 1500).length, 1);
});

void test("chat, topic and sender are all part of the collector key", () => {
  const collector = createCollector();
  const owner = update(1, "owner", { chatId: -100, threadId: 7, fromId: 42 });
  const guest = update(2, "guest", { chatId: -100, threadId: 7, fromId: 7 });

  assert.equal(collectorKeyFor(owner), "-100:7:42");
  collectorOffer(collector, owner, 0);
  collectorOffer(collector, guest, 10);
  const flushed = collectorTakeExpired(collector, 810);

  assert.equal(flushed.length, 2);
  assert.equal(flushed[0], owner);
  assert.equal(flushed[1], guest);
});

void test("part, character and age caps force a ready update", () => {
  const byParts = createCollector({ maxParts: 2 });
  collectorOffer(byParts, update(1, "a"), 0);
  const partReady = collectorOffer(byParts, update(2, "b"), 1);
  assert.equal(partReady.status, "ready");
  assert.equal(partReady.update.message!.iva_parts!.length, 2);

  const byChars = createCollector({ maxChars: 3 });
  collectorOffer(byChars, update(3, "ab"), 0);
  assert.equal(collectorOffer(byChars, update(4, "c"), 1).status, "ready");

  const byAge = createCollector({ maxAgeMs: 10 });
  collectorOffer(byAge, update(5, "old"), 0);
  assert.equal(collectorOffer(byAge, update(6, "new"), 10).status, "ready");
});

void test("quietMs zero disables collection and returns the untouched update", () => {
  const collector = createCollector({ quietMs: 0 });
  const original = update(1, "now");

  assert.deepEqual(collectorOffer(collector, original, 0), {
    status: "passthrough",
    update: original,
  });
  assert.equal(collectorPending(collector), 0);
});

// --- Склейка очереди Bridge (спека L5 v2, §3.2) ---
//
// Очередь за занятым ходом отдаёт подряд идущие сообщения одного автора одной доставкой.
// Отдельно идёт всё, чей смысл держится на том, что оно первое и единственное: команда,
// ответ на сообщение, тап по кнопке модели, синтетика с отрицательным id, сообщение без
// автора.

void test("a merged update keeps its parts flat: nested and empty iva_parts unfold in order", () => {
  const nested = update(1, "carrier");
  Object.assign(nested.message, {
    iva_parts: [
      { message_id: 1, text: "a" },
      {
        message_id: 2,
        text: "b-carrier",
        iva_parts: [
          { message_id: 2, text: "b" },
          { message_id: 3, text: "c", iva_parts: [] },
        ],
      },
      42,
      { message_id: 4, text: "d" },
    ],
  });

  const parts = updateParts(nested);
  assert.deepEqual(
    parts.map((part) => [part.message_id, part.text]),
    [
      [1, "a"],
      [2, "b"],
      [3, "c"],
      [4, "d"],
    ],
  );
  assert.ok(parts.every((part) => !Object.hasOwn(part, "iva_parts")));

  const plain = update(5, "alone");
  assert.equal(updateParts(plain)[0], plain.message);
  assert.equal(updateParts(plain).length, 1);

  const empty = update(6, "self");
  Object.assign(empty.message, { iva_parts: [] });
  assert.deepEqual(
    updateParts(empty).map((part) => [part.message_id, part.text]),
    [[6, "self"]],
  );
  assert.equal(Object.hasOwn(updateParts(empty)[0], "iva_parts"), false);
  assert.deepEqual(updateParts({ update_id: 7 }), []);
});

void test("commands, replies, taps, synthetic ids and authorless messages are delivered alone", () => {
  const command = update(1, "  /task call mom");
  const captionCommand = update(2, "");
  delete (captionCommand.message as { text?: string }).text;
  Object.assign(captionCommand.message, {
    caption: "/summary",
    document: { file_id: "doc" },
  });
  const reply = update(3, "yes");
  Object.assign(reply.message, {
    reply_to_message: { message_id: 1, from: { id: 9, is_bot: true } },
  });
  const tap = update(4, "Remind me");
  Object.assign(tap.message, { [TELEGRAM_BUTTON_TAP_FIELD]: true });
  const synthetic = update(-5, "menu text");
  const authorless = update(6, "anon");
  delete (authorless.message as { from?: unknown }).from;
  const commandInsideMerge = update(7, "first");
  Object.assign(commandInsideMerge.message, {
    iva_parts: [
      { message_id: 7, text: "first" },
      { message_id: 8, text: "/new" },
    ],
  });

  for (const alone of [
    command,
    captionCommand,
    reply,
    tap,
    synthetic,
    authorless,
    commandInsideMerge,
    { update_id: 9 },
  ]) {
    assert.equal(deliveredAlone(alone), true, JSON.stringify(alone));
  }
  assert.equal(deliveredAlone(update(10, "a path like a/b")), false);
  assert.equal(deliveredAlone(update(11, "")), false);
});

void test("only consecutive messages of one author merge: A1 A2 B1 A3 gives three deliveries", () => {
  const queue = [
    update(1, "A1", { chatId: -100, fromId: 42 }),
    update(2, "A2", { chatId: -100, fromId: 42 }),
    update(3, "B1", { chatId: -100, fromId: 7 }),
    update(4, "A3", { chatId: -100, fromId: 42 }),
  ];
  const batches: number[][] = [];
  let rest = queue;
  while (rest.length) {
    const n = queueBatchLength(rest);
    batches.push(rest.slice(0, n).map((item) => item.update_id));
    rest = rest.slice(n);
  }
  assert.deepEqual(batches, [[1, 2], [3], [4]]);
  assert.equal(queueBatchLength([]), 0);
});

void test("an alone message cuts the batch: neighbours merge before and after it", () => {
  const queue = [
    update(1, "one"),
    update(2, "two"),
    update(3, "/x"),
    update(4, "three"),
    update(5, "four"),
  ];
  assert.equal(queueBatchLength(queue), 2);
  assert.equal(queueBatchLength(queue.slice(2)), 1);
  assert.equal(queueBatchLength(queue.slice(3)), 2);
});

void test("a batch stops at 20 parts and 50 000 characters; an oversized head still leaves alone", () => {
  const parts = Array.from({ length: 21 }, (_, index) =>
    update(index + 1, `part ${index}`),
  );
  assert.equal(queueBatchLength(parts), 20);
  assert.equal(queueBatchLength(parts.slice(20)), 1);

  const long = [
    update(1, "x".repeat(30_000)),
    update(2, "y".repeat(20_001)),
    update(3, "z"),
  ];
  assert.equal(queueBatchLength(long), 1);
  assert.equal(queueBatchLength(long.slice(1)), 2);

  const exact = [update(1, "x".repeat(30_000)), update(2, "y".repeat(20_000))];
  assert.equal(queueBatchLength(exact), 2);

  const huge = [update(1, "h".repeat(60_000)), update(2, "after")];
  assert.equal(queueBatchLength(huge), 1);

  // Части считаются после выравнивания: склейка входа из 19 частей и ещё две — уже 21.
  const merged = update(1, "p0");
  Object.assign(merged.message, {
    iva_parts: Array.from({ length: 19 }, (_, index) => ({
      message_id: index + 1,
      text: `p${index}`,
    })),
  });
  assert.equal(queueBatchLength([merged, update(30, "a")]), 2);
  assert.equal(queueBatchLength([merged, update(30, "a"), update(31, "b")]), 2);
});

void test("joining keeps queue order: carrier of the first, update_id of the last, parts flat", () => {
  const first = update(102, "first");
  const merged = update(90, "second");
  Object.assign(merged.message, {
    iva_parts: [
      { message_id: 90, text: "second" },
      { message_id: 91, text: "third" },
    ],
  });
  const last = update(7, "fourth");

  const joined = joinUpdates([first, merged, last]);
  assert.equal(joined.update_id, 7);
  assert.equal(joined.message!.message_id, 102);
  assert.equal(joined.message!.text, "first");
  assert.deepEqual(
    joined.message!.iva_parts!.map((part) => [part.message_id, part.text]),
    [
      [102, "first"],
      [90, "second"],
      [91, "third"],
      [7, "fourth"],
    ],
  );
  assert.ok(
    joined.message!.iva_parts!.every(
      (part) => !Object.hasOwn(part, "iva_parts"),
    ),
  );
  assert.equal(Object.hasOwn(first.message, "iva_parts"), false);

  assert.equal(joinUpdates([first]), first);
  assert.throws(() => joinUpdates([]), /at least one update/u);
});

void test("the input collector flattens a part that is itself a merge", () => {
  const collector = createCollector();
  const merged = update(10, "a");
  Object.assign(merged.message, {
    iva_parts: [
      { message_id: 10, text: "a" },
      { message_id: 11, text: "b" },
    ],
  });
  merged.message.message_id = 10;
  const next = update(12, "c");

  collectorOffer(collector, merged, 0);
  collectorOffer(collector, next, 1);
  const [flushed] = collectorTakeExpired(collector, 900);

  assert.equal(flushed.update_id, 12);
  assert.deepEqual(
    flushed.message!.iva_parts!.map((part) => [part.message_id, part.text]),
    [
      [10, "a"],
      [11, "b"],
      [12, "c"],
    ],
  );
});
