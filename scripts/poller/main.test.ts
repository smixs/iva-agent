import assert from "node:assert/strict";
import test from "node:test";

const {
  conflictBackoff,
  handleControlSafely,
  processTelegramBatch,
  processTelegramUpdate,
  scheduleResetIntentReconciliation,
} = await import("./main.ts");
const { clearChatQueue, enqueueTelegramQueueUpdate } =
  await import("./queue.ts");
const { parseTelegramUpdates } = await import("../lib/telegram-queue.ts");

void test("conflictBackoff alerts starting at 10 consecutive conflicts", () => {
  assert.equal(conflictBackoff(9).shouldAlert, false);
  assert.equal(conflictBackoff(10).shouldAlert, true);
});

void test("conflictBackoff sleep grows and caps at 60000", () => {
  assert.equal(conflictBackoff(1).sleepMs, 3000);
  assert.ok(conflictBackoff(2).sleepMs > conflictBackoff(1).sleepMs);
  assert.ok(conflictBackoff(5).sleepMs > conflictBackoff(3).sleepMs);
  for (let n = 1; n <= 20; n += 1) {
    assert.ok(conflictBackoff(n).sleepMs <= 60_000);
  }
  assert.equal(conflictBackoff(20).sleepMs, 60_000);
});

void test("conflictBackoff resets to a short sleep after conflicts clear", () => {
  assert.equal(conflictBackoff(15).sleepMs, 60_000);
  assert.equal(conflictBackoff(15).shouldAlert, true);
  assert.equal(conflictBackoff(0).sleepMs, 3000);
  assert.equal(conflictBackoff(0).shouldAlert, false);
  assert.equal(conflictBackoff(1).sleepMs, 3000);
  assert.equal(conflictBackoff(1).shouldAlert, false);
});

void test("control timeout does not escape the polling-loop boundary", async () => {
  const lines: unknown[][] = [];
  const timeout = Object.assign(
    new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    ),
    { resetPhase: "remote" },
  );

  const result = await handleControlSafely(
    { update_id: 41 },
    {
      handleControlImpl: () => Promise.reject(timeout),
      logImpl: (...args: unknown[]) => lines.push(args),
    },
  );

  assert.equal(result, "retry");
  assert.deepEqual(lines, [
    ["control remote failed for update 41:", timeout.message],
  ]);
});

void test("the polling cycle survives a tagged control failure and holds its offset", async () => {
  const timeout = Object.assign(new Error("eve reset timed out"), {
    resetPhase: "remote",
  });
  let admitted = false;
  const saved: number[] = [];

  const result = await processTelegramUpdate({ update_id: 56 }, 56, null, {
    handleControlImpl: () => Promise.reject(timeout),
    admitImpl: () => {
      admitted = true;
      return Promise.resolve("owned" as const);
    },
    saveOffsetImpl: (offset: number) => {
      saved.push(offset);
      return Promise.resolve();
    },
    logImpl: () => {},
  });

  assert.deepEqual(result, { offset: 56, ingressBlocked: true });
  assert.equal(admitted, false);
  assert.deepEqual(saved, []);
});

void test("an ordinary control failure releases its offset after ten attempts and logs once", async () => {
  const lines: unknown[][] = [];
  const saved: number[] = [];
  const results: Array<{ offset: number; ingressBlocked: boolean }> = [];
  let result = { offset: 57, ingressBlocked: true };

  for (let attempt = 0; attempt < 200; attempt += 1) {
    result = await processTelegramUpdate({ update_id: 57 }, 57, null, {
      handleControlImpl: () => Promise.reject(new Error("unexpected failure")),
      admitImpl: () => Promise.resolve("owned" as const),
      saveOffsetImpl: (offset: number) => {
        saved.push(offset);
        return Promise.resolve();
      },
      logImpl: (...args: unknown[]) => lines.push(args),
    });
    results.push(result);
  }

  assert.deepEqual(result, { offset: 58, ingressBlocked: false });
  assert.equal(
    results.slice(0, 9).every(({ ingressBlocked }) => ingressBlocked),
    true,
  );
  assert.deepEqual(results[9], { offset: 58, ingressBlocked: false });
  assert.equal(saved.includes(58), true);
  assert.equal(lines.length, 1);
  assert.match(String(lines[0]?.[0]), /releasing update 57/u);
});

void test("background reset reconciliation never holds the polling cycle", async () => {
  let finish: ((value: number) => void) | undefined;
  let attempts = 0;
  const pending = new Promise<number>((resolve) => {
    finish = resolve;
  });

  assert.equal(
    scheduleResetIntentReconciliation({
      reconcileImpl: () => {
        attempts += 1;
        return pending;
      },
      logImpl: () => {},
    }),
    true,
  );
  assert.equal(attempts, 1);
  assert.equal(
    scheduleResetIntentReconciliation({
      reconcileImpl: () => Promise.resolve(0),
      logImpl: () => {},
    }),
    false,
  );
  finish?.(0);
  await pending;
});

void test("reset cleanup and post-intent enqueue cannot overwrite each other", async () => {
  const events: string[] = [];
  let releaseClear = () => {};
  let markClearStarted = () => {};
  const clearStarted = new Promise<void>((resolve) => {
    markClearStarted = resolve;
  });
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  const clearing = clearChatQueue("77:", undefined, undefined, {
    clearQueueFileKeyImpl: async () => {
      events.push("clear-start");
      markClearStarted();
      await clearGate;
      events.push("clear-end");
    },
  });
  await clearStarted;

  const enqueuing = enqueueTelegramQueueUpdate("77:", { update_id: 78 }, () => {
    events.push("enqueue");
    return Promise.resolve({} as never);
  });
  await Promise.resolve();
  assert.deepEqual(events, ["clear-start"]);

  releaseClear();
  await Promise.all([clearing, enqueuing]);
  assert.deepEqual(events, ["clear-start", "clear-end", "enqueue"]);
});

// 16.10.2026, c1: один апдейт, не прошедший проверку, держал всю пачку — offset не двигался,
// сообщения после него стояли, пока апдейт не подтвердили руками.
void test("an invalid update in a batch is skipped and the message after it is processed", async () => {
  const message = {
    update_id: 924152901,
    message: { message_id: 7, chat: { id: 7, type: "private" }, text: "hi" },
  };
  const items = parseTelegramUpdates([
    { update_id: 924152900, stopped_message_generation: "unexpected" },
    message,
  ]);
  assert.ok(items);
  const processed: number[] = [];
  const saved: number[] = [];
  const lines: unknown[][] = [];
  const result = await processTelegramBatch(items, 924152900, null, {
    processImpl: (update, offset, delivered) =>
      processTelegramUpdate(update, offset, delivered, {
        handleControlImpl: () => Promise.resolve(false),
        admitImpl: (admitted) => {
          processed.push(admitted.update_id);
          return Promise.resolve("owned" as const);
        },
        saveOffsetImpl: (offset: number) => {
          saved.push(offset);
          return Promise.resolve();
        },
        logImpl: () => {},
      }),
    saveOffsetImpl: (offset: number) => {
      saved.push(offset);
      return Promise.resolve();
    },
    logImpl: (...args: unknown[]) => lines.push(args),
  });

  assert.deepEqual(result, { offset: 924152902, ingressBlocked: false });
  assert.deepEqual(processed, [924152901]);
  assert.deepEqual(saved, [924152901, 924152902]);
  assert.equal(lines.length, 1);
  assert.match(String(lines[0]?.[1]), /"updateId":924152900/);
  assert.match(String(lines[0]?.[1]), /stopped_message_generation/);
});

void test("a skipped update without update_id never moves the offset back or stalls the batch", async () => {
  const items = parseTelegramUpdates([
    { stopped_message_generation: {} },
    { update_id: 3, message: { text: 1 } },
  ]);
  assert.ok(items);
  const saved: number[] = [];
  const result = await processTelegramBatch(items, 10, null, {
    processImpl: () => assert.fail("nothing here is a valid update"),
    saveOffsetImpl: (offset: number) => {
      saved.push(offset);
      return Promise.resolve();
    },
    logImpl: () => {},
  });
  assert.deepEqual(result, { offset: 10, ingressBlocked: false });
  assert.deepEqual(saved, []);
});
