/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and reset test doubles intentionally preserve asynchronous production boundaries. */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";

type ChatStatus = {
  status: string;
  sessionId?: string;
  turnId?: string;
  [key: string]: unknown;
};
type RunStatusModule = {
  setChatStatus: (chatKey: string, status: ChatStatus) => void;
  getChatStatus: (chatKey: string) => ChatStatus;
};
type QueueUpdate = {
  update_id: number;
  message?: Record<string, unknown>;
};
type QueueItem = {
  version: number;
  updateId: number;
  enqueuedAt?: number;
  update?: QueueUpdate;
};
type QueueDocument = {
  version: number;
  queues: Record<string, QueueItem[]>;
};
const queued = (updateId: number, text: string): QueueItem => ({
  version: 1,
  updateId,
  enqueuedAt: 1,
  update: { update_id: updateId, message: { text } },
});
type ResetIntent = {
  chatKey: string;
  discardThroughUpdateId?: number;
  target:
    | { sessionId: string }
    | { address: { chatId: string; messageThreadId?: number } };
};
type DurableResetIntent = {
  version: 1;
  chatKey: string;
  requestedAt: number;
  discardThroughUpdateId?: number;
};
type CompleteResetOptions = {
  clearQueue?: boolean;
  clearQueueImpl?: () => Promise<unknown>;
  deleteMessageImpl?: (
    chatKey: string,
    messageId: string | number,
  ) => Promise<unknown>;
};
type PerformResetOptions = {
  clearQueue?: boolean;
  discardThroughUpdateId?: number;
  persistIntentImpl?: () => Promise<unknown>;
  requestResetImpl?: (intent: ResetIntent) => Promise<unknown>;
  completeStateImpl?: () => Promise<unknown>;
  clearIntentImpl?: () => Promise<unknown>;
  logImpl?: (line: string) => void;
  now?: () => number;
  retryAfterMs?: number;
};
type ReconcileResetOptions = {
  requestResetImpl?: (intent: ResetIntent) => Promise<unknown>;
  logImpl?: (line: string) => void;
  now?: () => number;
  retryAfterMs?: number;
  sendImpl?: (chatKey: string, text: string) => Promise<unknown>;
  escalatedRetryAfterMs?: number;
};
type DrainOptions = {
  deliverImpl: (update: QueueUpdate) => Promise<boolean>;
  settleUntil: Map<string, number>;
  inFlight: Map<string, unknown>;
  pins: Map<string, readonly number[]>;
};
type WriteQueueOptions = {
  nonce?: string;
  renameImpl?: () => Promise<unknown>;
};
type PollModule = {
  clearPrivateResetIntent: (
    chatKey: string,
    options?: {
      clearImpl?: (directory: string, chatKey: string) => Promise<void>;
    },
  ) => Promise<void>;
  completeScopedResetState: (
    chatKey: string,
    options: CompleteResetOptions,
  ) => Promise<void>;
  drainReadyQueueHeads: (options: DrainOptions) => Promise<number>;
  hasPrivateResetIntent: (chatKey: string) => boolean;
  loadPrivateResetIntents: (options?: {
    loadImpl?: () => Promise<DurableResetIntent[]>;
  }) => Promise<DurableResetIntent[]>;
  loadQueue: () => Promise<QueueDocument>;
  performScopedReset: (
    chatKey: string,
    target: ResetIntent["target"],
    options?: PerformResetOptions,
  ) => Promise<void>;
  persistPrivateResetIntent: (
    chatKey: string,
    discardThroughUpdateId?: number,
    options?: {
      persistImpl?: (
        directory: string,
        chatKey: string,
        options: { discardThroughUpdateId?: number },
      ) => Promise<DurableResetIntent>;
    },
  ) => Promise<unknown>;
  reconcileScopedResetIntents: (
    options?: ReconcileResetOptions,
  ) => Promise<number>;
  routeMessageUpdate: (
    update: QueueUpdate,
    options: {
      deliverImpl: (update: QueueUpdate) => Promise<boolean>;
      acknowledgeImpl: () => Promise<unknown>;
      shouldQueueImpl: () => boolean;
      replyToBotImpl?: () => boolean;
    },
  ) => Promise<string>;
  retireSettledSessions: (options?: Record<string, unknown>) => Promise<number>;
  writeQueueAtomic: (
    queue: QueueDocument | Record<string, string[]>,
    options?: WriteQueueOptions,
  ) => Promise<void>;
};

const dataDir = mkdtempSync(join(tmpdir(), "iva-scoped-reset-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "test-secret";
await import("./lib/ts-esm-hooks.ts");

const [pollModule, runStatusModule] = (await Promise.all([
  import(`./telegram-poll.mjs?reset-test=${Date.now()}`),
  import(`#lib/run-status.ts?reset-test=${Date.now()}`),
])) as [unknown, unknown];
const {
  clearPrivateResetIntent,
  completeScopedResetState,
  drainReadyQueueHeads,
  hasPrivateResetIntent,
  loadPrivateResetIntents,
  loadQueue,
  performScopedReset,
  persistPrivateResetIntent,
  reconcileScopedResetIntents,
  routeMessageUpdate,
  retireSettledSessions,
  writeQueueAtomic,
} = pollModule as PollModule;
const status = runStatusModule as RunStatusModule;

test("private reset clears only the target chat status and queue", async () => {
  status.setChatStatus("chat-a:", {
    status: "running",
    sessionId: "session-a",
    turnId: "turn-a",
    retiredSessionId: "session-retired",
  });
  status.setChatStatus("chat-b:7", {
    status: "running",
    sessionId: "session-b",
    turnId: "turn-b",
  });
  writeFileSync(
    join(dataDir, "telegram-queue.json"),
    JSON.stringify({
      version: 1,
      queues: {
        "chat-a:": [queued(1, "discard me")],
        "chat-b:7": [queued(2, "keep me")],
      },
    }),
  );

  await completeScopedResetState("chat-a:", { clearQueue: true });

  const reset = status.getChatStatus("chat-a:");
  assert.equal(reset.status, "idle");
  assert.equal(reset.sessionId, undefined);
  assert.equal(reset.turnId, undefined);
  assert.equal(reset.retiredSessionId, undefined);

  const untouched = status.getChatStatus("chat-b:7");
  assert.equal(untouched.status, "running");
  assert.equal(untouched.sessionId, "session-b");

  const queue = JSON.parse(
    readFileSync(join(dataDir, "telegram-queue.json"), "utf8"),
  ) as unknown as QueueDocument;
  assert.equal(queue.version, 1);
  assert.deepEqual(Object.keys(queue.queues), ["chat-b:7"]);
  assert.deepEqual(queue.queues["chat-b:7"], [queued(2, "keep me")]);
});

test("group reset preserves the shared topic queue", async () => {
  status.setChatStatus("group:7", {
    status: "running",
    sessionId: "session-a",
  });
  writeFileSync(
    join(dataDir, "telegram-queue.json"),
    JSON.stringify({
      "group:7": ["future standalone conversation"],
      "other:9": ["keep me too"],
    }),
  );

  await completeScopedResetState("group:7", {
    clearQueue: false,
  });

  assert.equal(status.getChatStatus("group:7").status, "idle");
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(dataDir, "telegram-queue.json"), "utf8"),
    ) as unknown,
    {
      "group:7": ["future standalone conversation"],
      "other:9": ["keep me too"],
    },
  );
});

test("scoped reset deletes the pre-reset Working message", async () => {
  const key = "chat-working:";
  status.setChatStatus(key, {
    status: "running",
    sessionId: "s1",
    draftId: 999,
  });
  const calls: Array<{ calledKey: string; id: string | number }> = [];

  await completeScopedResetState(key, {
    clearQueue: false,
  });

  assert.deepEqual(calls, []);
  const reset = status.getChatStatus(key);
  assert.equal(reset.status, "idle");
  assert.equal(reset.draftId, undefined);
});

test("failed private queue cleanup does not expose an idle tombstone", async () => {
  status.setChatStatus("chat-c:", {
    status: "running",
    sessionId: "session-c",
  });

  await assert.rejects(
    completeScopedResetState("chat-c:", {
      clearQueue: true,
      clearQueueImpl: async () => {
        throw new Error("disk full");
      },
    }),
    /disk full/,
  );
  assert.equal(status.getChatStatus("chat-c:").status, "running");
  assert.equal(status.getChatStatus("chat-c:").sessionId, "session-c");
});

test("private reset intent is durable before remote reset and clears after local cleanup", async () => {
  const events: string[] = [];
  await performScopedReset(
    "chat-intent:",
    { sessionId: "session-105" },
    {
      clearQueue: true,
      persistIntentImpl: async () => events.push("intent"),
      requestResetImpl: async () => events.push("remote"),
      completeStateImpl: async () => events.push("cleanup"),
      clearIntentImpl: async () => events.push("clear-intent"),
    },
  );

  assert.deepEqual(events, ["intent", "remote", "cleanup", "clear-intent"]);
});

test("startup reconciliation prevents a remotely reset private queue from draining after a crash", async () => {
  const key = "106:";
  status.setChatStatus(key, {
    status: "running",
    sessionId: "old-session",
    turnId: "old-turn",
  });
  await writeQueueAtomic({
    version: 1,
    queues: {
      [key]: [
        {
          version: 1,
          updateId: 901,
          enqueuedAt: 1,
          update: {
            update_id: 901,
            message: {
              message_id: 901,
              date: 1,
              chat: { id: 901, type: "private" },
              from: { id: 42, is_bot: false, first_name: "Owner" },
              text: "must be discarded after reset",
            },
          },
        },
      ],
    },
  });
  await persistPrivateResetIntent(key);

  const remoteRetries: ResetIntent[] = [];
  await reconcileScopedResetIntents({
    requestResetImpl: async (intent) => {
      remoteRetries.push(intent);
    },
  });

  assert.deepEqual(remoteRetries, [
    { chatKey: key, target: { address: { chatId: "106" } } },
  ]);
  assert.deepEqual(await loadPrivateResetIntents(), []);
  assert.equal(status.getChatStatus(key).status, "idle");
  assert.equal(status.getChatStatus(key).sessionId, undefined);
  assert.equal((await loadQueue()).queues[key], undefined);

  const delivered: number[] = [];
  assert.equal(
    await drainReadyQueueHeads({
      deliverImpl: async (update) => {
        delivered.push(update.update_id);
        return true;
      },
      settleUntil: new Map(),
      inFlight: new Map(),
      pins: new Map(),
    }),
    0,
  );
  assert.deepEqual(
    delivered,
    [],
    "startup must reconcile reset intent before any old head can drain",
  );
});

test("a pending reset intent fences its queue head while other chats drain", async () => {
  const blockedKey = "910:";
  const readyKey = "911:";
  await writeQueueAtomic({
    version: 1,
    queues: {
      [blockedKey]: [
        {
          version: 1,
          updateId: 910,
          enqueuedAt: 1,
          update: { update_id: 910, message: { text: "old head" } },
        },
      ],
      [readyKey]: [
        {
          version: 1,
          updateId: 911,
          enqueuedAt: 1,
          update: { update_id: 911, message: { text: "ready head" } },
        },
      ],
    },
  });
  await persistPrivateResetIntent(blockedKey);
  const delivered: number[] = [];

  await drainReadyQueueHeads({
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      return true;
    },
    settleUntil: new Map(),
    inFlight: new Map(),
    pins: new Map(),
  });

  assert.deepEqual(delivered, [911]);
  assert.equal((await loadQueue()).queues[blockedKey]?.[0]?.updateId, 910);
  await clearPrivateResetIntent(blockedKey);
});

test("an intent persisted during a disk scan remains fenced", async () => {
  const freshKey = "9600:";
  const scanned = Array.from({ length: 60 }, (_, index) => ({
    version: 1 as const,
    chatKey: `${9601 + index}:`,
    requestedAt: index,
  }));
  let releaseScan: (() => void) | undefined;
  let scanStarted: (() => void) | undefined;
  const scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  const started = new Promise<void>((resolve) => {
    scanStarted = resolve;
  });

  const loading = loadPrivateResetIntents({
    loadImpl: async () => {
      scanStarted?.();
      await scanGate;
      return scanned;
    },
  });
  await started;
  await persistPrivateResetIntent(freshKey);
  releaseScan?.();
  const loaded = await loading;

  assert.equal(hasPrivateResetIntent(freshKey), true);
  assert.deepEqual(loaded, scanned);
  await clearPrivateResetIntent(freshKey);
});

test("an intent cleared during a disk scan stays unfenced", async () => {
  const key = "9661:";
  const intent = (await persistPrivateResetIntent(key)) as DurableResetIntent;
  let releaseScan: (() => void) | undefined;
  let scanStarted: (() => void) | undefined;
  const scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  const started = new Promise<void>((resolve) => {
    scanStarted = resolve;
  });

  const loading = loadPrivateResetIntents({
    loadImpl: async () => {
      scanStarted?.();
      await scanGate;
      return [intent];
    },
  });
  await started;
  await clearPrivateResetIntent(key);
  releaseScan?.();
  const loaded = await loading;

  assert.equal(hasPrivateResetIntent(key), false);
  assert.deepEqual(loaded, []);
});

test("a scan removes a fence whose intent disappeared before clear failed", async () => {
  const key = "9664:";
  await persistPrivateResetIntent(key);

  await assert.rejects(
    clearPrivateResetIntent(key, {
      clearImpl: async (directory) => {
        for (const filename of readdirSync(directory)) {
          const path = join(directory, filename);
          const intent = JSON.parse(readFileSync(path, "utf8")) as {
            chatKey?: string;
          };
          if (intent.chatKey === key) rmSync(path);
        }
        throw new Error("directory fsync failed");
      },
    }),
    /directory fsync failed/u,
  );
  assert.equal(hasPrivateResetIntent(key), true);

  assert.deepEqual(await loadPrivateResetIntents(), []);
  assert.equal(hasPrivateResetIntent(key), false);
});

test("persist and clear for one intent execute in call order", async () => {
  const persistFirstKey = "9662:";
  let releasePersist: (() => void) | undefined;
  let persistStarted: (() => void) | undefined;
  const persistGate = new Promise<void>((resolve) => {
    releasePersist = resolve;
  });
  const startedPersist = new Promise<void>((resolve) => {
    persistStarted = resolve;
  });
  const persistingFirst = persistPrivateResetIntent(
    persistFirstKey,
    undefined,
    {
      persistImpl: async () => {
        persistStarted?.();
        await persistGate;
        return {
          version: 1,
          chatKey: persistFirstKey,
          requestedAt: 1,
        };
      },
    },
  );
  await startedPersist;
  let clearCalls = 0;
  const clearingSecond = clearPrivateResetIntent(persistFirstKey, {
    clearImpl: async () => {
      clearCalls += 1;
    },
  });
  await Promise.resolve();
  assert.equal(clearCalls, 0);
  releasePersist?.();
  await Promise.all([persistingFirst, clearingSecond]);
  assert.equal(hasPrivateResetIntent(persistFirstKey), false);

  const clearFirstKey = "9663:";
  await persistPrivateResetIntent(clearFirstKey);
  let releaseClear: (() => void) | undefined;
  let clearStarted: (() => void) | undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  const startedClear = new Promise<void>((resolve) => {
    clearStarted = resolve;
  });
  const clearingFirst = clearPrivateResetIntent(clearFirstKey, {
    clearImpl: async () => {
      clearStarted?.();
      await clearGate;
    },
  });
  await startedClear;
  let persistCalls = 0;
  const persistingSecond = persistPrivateResetIntent(clearFirstKey, undefined, {
    persistImpl: async () => {
      persistCalls += 1;
      return {
        version: 1,
        chatKey: clearFirstKey,
        requestedAt: 2,
      };
    },
  });
  await Promise.resolve();
  assert.equal(persistCalls, 0);
  releaseClear?.();
  await Promise.all([clearingFirst, persistingSecond]);
  assert.equal(hasPrivateResetIntent(clearFirstKey), true);
  await clearPrivateResetIntent(clearFirstKey);
});

test("a pending reset intent queues a fresh idle update before direct delivery", async () => {
  const key = "912:";
  status.setChatStatus(key, { status: "idle" });
  await writeQueueAtomic({ version: 1, queues: {} });
  await assert.rejects(
    performScopedReset(
      key,
      { sessionId: "session-912" },
      {
        clearQueue: true,
        requestResetImpl: async () => {
          throw new Error("eve reset timeout");
        },
      },
    ),
    /eve reset timeout/u,
  );
  assert.deepEqual(
    (await loadPrivateResetIntents()).map((intent) => intent.chatKey),
    [key],
  );
  let directDeliveries = 0;
  const update = {
    update_id: 912,
    message: {
      message_id: 912,
      date: 1,
      chat: { id: 912, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Owner" },
      text: "after failed reset",
    },
  };

  const result = await routeMessageUpdate(update, {
    deliverImpl: async () => {
      directDeliveries += 1;
      return true;
    },
    acknowledgeImpl: async () => {},
    shouldQueueImpl: () => true,
  });

  assert.equal(result, "queued");
  assert.equal(directDeliveries, 0);
  assert.equal((await loadQueue()).queues[key]?.[0]?.updateId, 912);
  await clearPrivateResetIntent(key);
});

test("a pending reset intent also fences a reply to the bot", async () => {
  const key = "913:";
  status.setChatStatus(key, { status: "idle" });
  await writeQueueAtomic({ version: 1, queues: {} });
  await persistPrivateResetIntent(key);
  let directDeliveries = 0;
  const update = {
    update_id: 913,
    message: {
      message_id: 913,
      date: 1,
      chat: { id: 913, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Owner" },
      reply_to_message: { from: { is_bot: true } },
      text: "reply after failed reset",
    },
  };

  const result = await routeMessageUpdate(update, {
    deliverImpl: async () => {
      directDeliveries += 1;
      return true;
    },
    acknowledgeImpl: async () => {},
    shouldQueueImpl: () => true,
    replyToBotImpl: () => true,
  });

  assert.equal(result, "queued");
  assert.equal(directDeliveries, 0);
  assert.equal((await loadQueue()).queues[key]?.[0]?.updateId, 913);
  await clearPrivateResetIntent(key);
});

test("a message queued after failed /new survives reconcile and enters the new session once", async () => {
  const key = "501:";
  let now = 0;
  await writeQueueAtomic({ version: 1, queues: {} });
  await assert.rejects(
    performScopedReset(
      key,
      { sessionId: "old-session-501" },
      {
        clearQueue: true,
        discardThroughUpdateId: 500,
        requestResetImpl: () => Promise.reject(new Error("reset unavailable")),
        now: () => now,
      },
    ),
    /reset unavailable/u,
  );

  const update = {
    update_id: 501,
    message: {
      message_id: 501,
      date: 1,
      chat: { id: 501, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Owner" },
      text: "deliver after reset",
    },
  };
  assert.equal(
    await routeMessageUpdate(update, {
      deliverImpl: () => Promise.resolve(true),
      acknowledgeImpl: () => Promise.resolve(),
      shouldQueueImpl: () => true,
    }),
    "queued",
  );

  now = 31_000;
  assert.equal(
    await reconcileScopedResetIntents({
      requestResetImpl: () => Promise.resolve({ status: "reset" }),
      now: () => now,
    }),
    1,
  );
  assert.equal((await loadQueue()).queues[key]?.[0]?.updateId, 501);

  const delivered: number[] = [];
  const inFlight = new Map<string, unknown>();
  const pins = new Map<string, readonly number[]>();
  assert.equal(
    await drainReadyQueueHeads({
      deliverImpl: (candidate) => {
        delivered.push(candidate.update_id);
        return Promise.resolve(true);
      },
      settleUntil: new Map(),
      inFlight,
      pins,
    }),
    0,
  );
  assert.equal(
    await drainReadyQueueHeads({
      deliverImpl: (candidate) => {
        delivered.push(candidate.update_id);
        return Promise.resolve(true);
      },
      settleUntil: new Map(),
      inFlight,
      pins,
    }),
    0,
  );
  assert.deepEqual(delivered, [501]);
});

test("remote reset failures keep their intent and share one retry backoff", async () => {
  const key = "107:";
  let now = 1_000;
  let reconciliationAttempts = 0;
  let reconciliationFails = true;

  await assert.rejects(
    performScopedReset(
      key,
      { sessionId: "session-107" },
      {
        clearQueue: true,
        requestResetImpl: async () => {
          throw new Error("initial timeout");
        },
        now: () => now,
        retryAfterMs: 30_000,
      },
    ),
    /initial timeout/,
  );

  const options = {
    requestResetImpl: async () => {
      reconciliationAttempts += 1;
      if (reconciliationFails) throw new Error("eve unavailable");
      return { status: "reset" };
    },
    logImpl: () => {},
    now: () => now,
    retryAfterMs: 30_000,
  };

  assert.equal(await reconcileScopedResetIntents(options), 0);
  assert.deepEqual(
    (await loadPrivateResetIntents()).map(({ chatKey }) => chatKey),
    [key],
  );
  assert.equal(reconciliationAttempts, 0);

  now += 30_000;
  assert.equal(await reconcileScopedResetIntents(options), 0);
  assert.equal(reconciliationAttempts, 1);

  reconciliationFails = false;
  assert.equal(await reconcileScopedResetIntents(options), 0);
  assert.equal(reconciliationAttempts, 1);
  now += 30_000;
  assert.equal(await reconcileScopedResetIntents(options), 1);
  assert.equal(reconciliationAttempts, 2);
  assert.deepEqual(await loadPrivateResetIntents(), []);

  const cleanupKey = "109:";
  let cleanupRemoteAttempts = 0;
  await assert.rejects(
    performScopedReset(
      cleanupKey,
      { sessionId: "session-109" },
      {
        clearQueue: true,
        requestResetImpl: async () => {
          cleanupRemoteAttempts += 1;
          return { status: "reset" };
        },
        completeStateImpl: async () => {
          throw new Error("cleanup failed");
        },
        now: () => now,
        retryAfterMs: 30_000,
      },
    ),
    /cleanup failed/,
  );
  await assert.rejects(
    performScopedReset(
      cleanupKey,
      { sessionId: "session-109" },
      {
        clearQueue: true,
        requestResetImpl: async () => {
          cleanupRemoteAttempts += 1;
          return { status: "reset" };
        },
        now: () => now,
        retryAfterMs: 30_000,
      },
    ),
    /backoff/u,
  );
  assert.equal(cleanupRemoteAttempts, 1);
  await clearPrivateResetIntent(cleanupKey);
});

test("control failure counts toward escalation and a failed notice retries", async () => {
  const key = "110:";
  let now = 0;
  let attempts = 0;
  let noticeAttempts = 0;
  const notices: string[] = [];
  await assert.rejects(
    performScopedReset(
      key,
      { sessionId: "session-110" },
      {
        clearQueue: true,
        requestResetImpl: async () => {
          throw new Error("initial eve failure");
        },
        now: () => now,
        retryAfterMs: 30_000,
      },
    ),
    /initial eve failure/u,
  );
  now += 30_000;
  const options = {
    requestResetImpl: async () => {
      attempts += 1;
      throw new Error("eve wedged");
    },
    logImpl: () => {},
    sendImpl: async (_chatKey: string, text: string) => {
      noticeAttempts += 1;
      if (noticeAttempts === 1) throw new Error("Telegram unavailable");
      notices.push(text);
    },
    now: () => now,
    retryAfterMs: 30_000,
    escalatedRetryAfterMs: 5 * 60_000,
  };

  for (let attempt = 0; attempt < 9; attempt += 1) {
    assert.equal(await reconcileScopedResetIntents(options), 0);
    now += 30_000;
  }

  assert.equal(attempts, 9);
  assert.equal(noticeAttempts, 1);
  assert.deepEqual(notices, []);
  assert.equal(await reconcileScopedResetIntents(options), 0);
  assert.equal(attempts, 9);
  now += 5 * 60_000;
  assert.equal(await reconcileScopedResetIntents(options), 0);
  assert.equal(attempts, 10);
  assert.equal(noticeAttempts, 2);
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /iva reset/u);
  now += 5 * 60_000;
  assert.equal(await reconcileScopedResetIntents(options), 0);
  assert.equal(noticeAttempts, 2);
  await clearPrivateResetIntent(key);
});

test("a corrupt reset intent does not block a valid chat", async (t) => {
  const key = "108:";
  await persistPrivateResetIntent(key);
  const intentDirectory = join(dataDir, "telegram-reset-intents");
  const corruptFile = join(intentDirectory, "corrupt.json");
  writeFileSync(corruptFile, "{broken", "utf8");
  t.after(() => rmSync(corruptFile, { force: true }));
  t.mock.method(console, "error", () => {});

  const requested: ResetIntent[] = [];
  await reconcileScopedResetIntents({
    requestResetImpl: async (intent) => {
      requested.push(intent);
    },
  });

  assert.deepEqual(requested, [
    { chatKey: key, target: { address: { chatId: "108" } } },
  ]);
  assert.equal(readdirSync(intentDirectory).includes("corrupt.json"), true);
  assert.deepEqual(await loadPrivateResetIntents(), []);
});

test("queue rename failure keeps the previous whole queue byte-for-byte", async () => {
  const queueFile = join(dataDir, "telegram-queue.json");
  const original = JSON.stringify({
    version: 1,
    queues: {
      "chat-d:": [queued(1, "keep this")],
      "chat-e:": [queued(2, "keep this too")],
    },
  });
  writeFileSync(queueFile, original);

  await assert.rejects(
    writeQueueAtomic(
      { version: 1, queues: { "chat-d:": [queued(3, "replacement")] } },
      {
        nonce: "fault-injection",
        renameImpl: async () => {
          throw new Error("injected rename failure");
        },
      },
    ),
    /injected rename failure/,
  );

  assert.equal(readFileSync(queueFile, "utf8"), original);
  assert.equal(
    readdirSync(dataDir).some((name) =>
      name.startsWith("telegram-queue.json.tmp-"),
    ),
    false,
  );
});

test("corrupt queue is not treated as empty during reset", async () => {
  const queueFile = join(dataDir, "telegram-queue.json");
  const corrupt = '{"chat-f:": ["unfinished"';
  writeFileSync(queueFile, corrupt);
  status.setChatStatus("chat-f:", {
    status: "running",
    sessionId: "session-f",
  });

  await assert.rejects(
    completeScopedResetState("chat-f:", { clearQueue: true }),
    SyntaxError,
  );

  assert.equal(readFileSync(queueFile, "utf8"), corrupt);
  assert.equal(status.getChatStatus("chat-f:").status, "running");
});

test("ordinary queue load quarantines corrupt bytes and continues", async () => {
  const queueFile = join(dataDir, "telegram-queue.json");
  const corrupt = '{"chat-g:": ["unfinished"';
  writeFileSync(queueFile, corrupt);

  assert.deepEqual(await loadQueue(), { version: 1, queues: {} });

  const backups = readdirSync(dataDir).filter((name) =>
    name.startsWith("telegram-queue.json.corrupt-"),
  );
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dataDir, backups[0]), "utf8"), corrupt);
});

test("a durable reset intent reconstructs its Telegram address", async () => {
  const key = "429888768:";
  await persistPrivateResetIntent(key);

  const requested: ResetIntent[] = [];
  await reconcileScopedResetIntents({
    requestResetImpl: async (request) => {
      requested.push(request);
    },
  });

  assert.deepEqual(requested, [
    { chatKey: key, target: { address: { chatId: "429888768" } } },
  ]);
  assert.equal(status.getChatStatus(key).status, "idle");
});

test("/new sends the exact stored session target", async () => {
  const requested: ResetIntent[] = [];
  await performScopedReset(
    "7091451031:",
    { sessionId: "session-1" },
    {
      clearQueue: true,
      persistIntentImpl: async () => {},
      requestResetImpl: async (request) => requested.push(request),
      completeStateImpl: async () => {},
      clearIntentImpl: async () => {},
    },
  );

  assert.deepEqual(requested, [
    {
      chatKey: "7091451031:",
      target: { sessionId: "session-1" },
    },
  ]);
});

test("reset outcome is logged for session and address targets", async () => {
  const lines: string[] = [];
  await performScopedReset(
    "7091451031:",
    { sessionId: "session-1" },
    {
      clearQueue: true,
      persistIntentImpl: async () => {},
      requestResetImpl: async () => ({ ok: true, status: "no_active_session" }),
      completeStateImpl: async () => {},
      clearIntentImpl: async () => {},
      logImpl: (line) => lines.push(line),
    },
  );

  assert.deepEqual(lines, [
    "reset for chat 7091451031: -> no_active_session (session-1)",
  ]);

  const successes: string[] = [];
  await performScopedReset(
    "7091451031:",
    { address: { chatId: "7091451031" } },
    {
      persistIntentImpl: async () => {},
      requestResetImpl: async () => ({
        ok: true,
        status: "reset",
        previousSessionId: "wrun_1",
      }),
      completeStateImpl: async () => {},
      clearIntentImpl: async () => {},
      logImpl: (line) => successes.push(line),
    },
  );
  assert.deepEqual(successes, [
    "reset for chat 7091451031: -> reset (address)",
  ]);
});

test("intent reconciliation logs its reset outcome too", async () => {
  await persistPrivateResetIntent("429888768:");
  const lines: string[] = [];
  await reconcileScopedResetIntents({
    requestResetImpl: async () => ({ ok: true, status: "reset" }),
    logImpl: (line) => lines.push(line),
  });

  assert.deepEqual(lines, ["reset for chat 429888768: -> reset (address)"]);
});

test("slow replay retires once and only after the turn settles", async () => {
  const key = "retire-once:";
  const marker = {
    replayMs: 30_001,
    sessionId: "session-retire",
    turnId: "turn-retire",
  };
  let current: ChatStatus = {
    status: "running",
    generation: 1,
    updatedAt: 1,
    sessionId: marker.sessionId,
    turnId: marker.turnId,
    retireAfterTurn: marker,
  };
  const resets: string[] = [];
  const resetOptions: Array<{ clearQueue?: boolean } | undefined> = [];
  const notices: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const options = {
    listStatusesImpl: () => [{ chatKey: key, status: current }],
    statusImpl: () => current,
    resetImpl: async (
      _chatKey: string,
      target: { sessionId: string },
      resetOptionsArg?: { clearQueue?: boolean },
    ) => {
      resetOptions.push(resetOptionsArg);
      resets.push(target.sessionId);
      current = {
        ...current,
        status: "idle",
        generation: Number(current.generation) + 1,
        updatedAt: Number(current.updatedAt) + 1,
        sessionId: undefined,
        turnId: undefined,
      };
    },
    setStatusIfImpl: (
      _chatKey: string,
      _expected: Record<string, unknown>,
      patch: Record<string, unknown>,
    ) => {
      current = { ...current, ...patch };
      if (patch.retireAfterTurn === null) delete current.retireAfterTurn;
      return current;
    },
    sendImpl: async (_chatKey: string, text: string) => notices.push(text),
    traceImpl: (event: Record<string, unknown>) => traces.push(event),
    trImpl: (en: string) => en,
    logImpl: () => {},
  };

  assert.equal(await retireSettledSessions(options), 0);
  assert.deepEqual(resets, []);

  current = {
    ...current,
    status: "idle",
    generation: 2,
    updatedAt: 2,
    sessionId: undefined,
    turnId: undefined,
  };
  assert.equal(await retireSettledSessions(options), 1);
  assert.equal(await retireSettledSessions(options), 0);

  assert.deepEqual(resets, [marker.sessionId]);
  assert.deepEqual(resetOptions, [{ clearQueue: false }]);
  assert.deepEqual(notices, [
    "The conversation grew large, so I started a fresh one. Memory is intact.",
  ]);
  assert.deepEqual(traces, [
    {
      source: "telegram",
      kind: "turn",
      name: "retired",
      turn: marker.turnId,
      session: marker.sessionId,
      data: { replayMs: marker.replayMs },
    },
  ]);
});

test("an awaiting-running delivery keeps the retirement marker", async () => {
  const key = "retire-in-flight:";
  const marker = {
    replayMs: 31_000,
    sessionId: "session-in-flight",
    turnId: "turn-settled",
  };
  let current: ChatStatus = {
    status: "idle",
    generation: 8,
    updatedAt: 8,
    retireAfterTurn: marker,
  };
  let resets = 0;

  assert.equal(
    await retireSettledSessions({
      listStatusesImpl: () => [{ chatKey: key, status: current }],
      statusImpl: () => current,
      inFlight: new Map([[key, "awaiting-running"]]),
      setStatusIfImpl: (
        _chatKey: string,
        _expected: Record<string, unknown>,
        patch: Record<string, unknown>,
      ) => {
        current = { ...current, ...patch };
        if (patch.retireAfterTurn === null) delete current.retireAfterTurn;
        return current;
      },
      resetImpl: async () => {
        resets += 1;
      },
      sendImpl: async () => {},
      traceImpl: () => {},
      logImpl: () => {},
    }),
    0,
  );
  assert.equal(resets, 0);
  assert.deepEqual(current.retireAfterTurn, marker);
});

test("a new running turn between scan and action keeps the retirement marker", async () => {
  const marker = {
    replayMs: 31_000,
    sessionId: "session-race",
    turnId: "turn-old",
  };
  const scanned: ChatStatus = {
    status: "idle",
    generation: 4,
    updatedAt: 4,
    retireAfterTurn: marker,
  };
  const current: ChatStatus = {
    ...scanned,
    status: "running",
    generation: 5,
    updatedAt: 5,
    sessionId: "session-new",
    turnId: "turn-new",
  };
  let resets = 0;

  assert.equal(
    await retireSettledSessions({
      listStatusesImpl: () => [{ chatKey: "retire-race:", status: scanned }],
      statusImpl: () => current,
      setStatusIfImpl: () => {
        throw new Error("CAS must not run for a live turn");
      },
      resetImpl: async () => {
        resets += 1;
      },
      sendImpl: async () => {},
      traceImpl: () => {},
      logImpl: () => {},
    }),
    0,
  );
  assert.equal(resets, 0);
  assert.deepEqual(current.retireAfterTurn, marker);
});

test("a failed retirement CAS does not reset the session", async () => {
  const marker = {
    replayMs: 31_000,
    sessionId: "session-cas",
    turnId: "turn-cas",
  };
  const current: ChatStatus = {
    status: "idle",
    generation: 6,
    updatedAt: 6,
    retireAfterTurn: marker,
  };
  let resets = 0;

  assert.equal(
    await retireSettledSessions({
      listStatusesImpl: () => [{ chatKey: "retire-cas:", status: current }],
      statusImpl: () => current,
      setStatusIfImpl: () => null,
      resetImpl: async () => {
        resets += 1;
      },
      sendImpl: async () => {},
      traceImpl: () => {},
      logImpl: () => {},
    }),
    0,
  );
  assert.equal(resets, 0);
  assert.deepEqual(current.retireAfterTurn, marker);
});

test("a failed reset keeps the marker and the next pass retires once", async () => {
  const marker = {
    replayMs: 31_000,
    sessionId: "session-reset-failure",
    turnId: "turn-reset-failure",
  };
  let current: ChatStatus = {
    status: "idle",
    generation: 7,
    updatedAt: 7,
    retireAfterTurn: marker,
  };
  const notices: string[] = [];
  const traces: Record<string, unknown>[] = [];
  let resetAttempts = 0;

  const options = {
    listStatusesImpl: () => [
      { chatKey: "retire-reset-failure:", status: current },
    ],
    statusImpl: () => current,
    setStatusIfImpl: (
      _chatKey: string,
      expected: Record<string, unknown>,
      patch: Record<string, unknown>,
    ) => {
      if (
        Object.entries(expected).some(
          ([key, value]) => !Object.is(current[key], value),
        )
      ) {
        return null;
      }
      current = {
        ...current,
        ...patch,
        generation: Number(current.generation) + 1,
        updatedAt: Number(current.updatedAt) + 1,
      };
      if (patch.retireAfterTurn === null) delete current.retireAfterTurn;
      return current;
    },
    resetImpl: async () => {
      resetAttempts += 1;
      if (resetAttempts === 1) throw new Error("eve unavailable");
    },
    sendImpl: async (_chatKey: string, text: string) => notices.push(text),
    traceImpl: (event: Record<string, unknown>) => traces.push(event),
    trImpl: (en: string) => en,
    logImpl: () => {},
  };

  assert.equal(await retireSettledSessions(options), 0);
  assert.deepEqual(current.retireAfterTurn, marker);
  assert.equal(current.retiredSessionId, undefined);
  assert.deepEqual(notices, []);
  assert.deepEqual(traces, []);

  assert.equal(await retireSettledSessions(options), 1);
  assert.equal(await retireSettledSessions(options), 0);
  assert.equal(current.retireAfterTurn, undefined);
  assert.equal(current.retiredSessionId, marker.sessionId);
  assert.equal(resetAttempts, 2);
  assert.equal(notices.length, 1);
  assert.deepEqual(traces, [
    {
      source: "telegram",
      kind: "turn",
      name: "retired",
      turn: marker.turnId,
      session: marker.sessionId,
      data: { replayMs: marker.replayMs },
    },
  ]);
});

const RETIRE_ORDER_PBT_SEED = 1_903_627;

test(`retirement never runs mid-turn or twice (fast-check seed ${RETIRE_ORDER_PBT_SEED})`, async () => {
  const traceHook = await import("../agent/hooks/trace.ts");
  const eventType = fc.constantFrom(
    "turn.started" as const,
    "message.received" as const,
    "turn.completed" as const,
    "turn.cancelled" as const,
    "turn.failed" as const,
  );
  const turnId = fc.constantFrom("turn-a", "turn-b", "turn-c");

  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 10_000_000 }),
      fc.array(fc.record({ type: eventType, turnId }), {
        maxLength: 12,
      }),
      async (replayMs, noise) => {
        const events = [
          { type: "turn.started" as const, turnId: "turn-a" },
          { type: "message.received" as const, turnId: "turn-a" },
          { type: "turn.completed" as const, turnId: "turn-a" },
          ...noise,
          { type: "turn.started" as const, turnId: "turn-b" },
          { type: "message.received" as const, turnId: "turn-b" },
          { type: "turn.completed" as const, turnId: "turn-b" },
        ];
        let now = 0;
        let current: ChatStatus = {
          status: "idle",
          generation: 1,
          updatedAt: 1,
        };
        let resetCount = 0;
        const markerFor = (
          sessionId: string,
          turnId: string,
          replayMs: number,
        ) => {
          if (
            current.status !== "running" ||
            current.sessionId !== sessionId ||
            current.turnId !== turnId ||
            current.retiredSessionId === sessionId ||
            current.retireAfterTurn !== undefined
          ) {
            return false;
          }
          current = {
            ...current,
            retireAfterTurn: { replayMs, sessionId, turnId },
          };
          return true;
        };
        const observe = traceHook.createTelegramReplayRetirementObserver({
          now: () => now,
          markImpl: markerFor,
        });
        const propertyContext = {
          session: {
            id: "property-session",
            turn: { id: "property-turn", sequence: 1 },
          },
          channel: { kind: "channel:telegram" },
        };
        const options = {
          listStatusesImpl: () => [
            { chatKey: "property-chat:", status: current },
          ],
          statusImpl: () => current,
          resetImpl: async () => {
            assert.equal(current.status, "idle");
            resetCount += 1;
          },
          setStatusIfImpl: (
            _chatKey: string,
            expected: Record<string, unknown>,
            patch: Record<string, unknown>,
          ) => {
            if (
              Object.entries(expected).some(
                ([key, value]) => !Object.is(current[key], value),
              )
            ) {
              return null;
            }
            current = { ...current, ...patch };
            if (patch.retireAfterTurn === null) delete current.retireAfterTurn;
            return current;
          },
          sendImpl: async () => {},
          traceImpl: () => {},
          trImpl: (en: string) => en,
        };

        for (const event of events) {
          now =
            event.type === "turn.started"
              ? 0
              : event.type === "message.received"
                ? replayMs
                : replayMs + 1;
          if (event.type === "turn.started") {
            current = {
              ...current,
              status: "running",
              sessionId: "property-session",
              turnId: event.turnId,
            };
          }
          const data = {
            sequence: 1,
            turnId: event.turnId,
            ...(event.type === "message.received"
              ? { message: "property" }
              : {}),
            ...(event.type === "turn.failed"
              ? { code: "FAILED", details: {}, message: "failed" }
              : {}),
          };
          observe({ type: event.type, data }, propertyContext);
          if (
            event.type === "turn.completed" ||
            event.type === "turn.cancelled" ||
            event.type === "turn.failed"
          ) {
            current = {
              ...current,
              status: "idle",
              sessionId: undefined,
              turnId: undefined,
            };
          }
          await retireSettledSessions(options);
        }

        assert.ok(resetCount <= 1);
      },
    ),
    { numRuns: 250, seed: RETIRE_ORDER_PBT_SEED },
  );
});
