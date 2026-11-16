/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and reset test doubles intentionally preserve asynchronous production boundaries. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { tempDir } from "./fixtures/temp-dir.ts";

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
  resetFence?: number;
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
  resetEpoch?: number;
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
};
type PerformResetOptions = {
  clearQueue?: boolean;
  discardThroughUpdateId?: number;
  persistIntentImpl?: (
    chatKey: string,
    discardThroughUpdateId?: number,
  ) => Promise<unknown>;
  requestResetImpl?: (intent: ResetIntent) => Promise<unknown>;
  completeStateImpl?: () => Promise<unknown>;
  clearIntentImpl?: () => Promise<unknown>;
  logImpl?: (line: string) => void;
  now?: () => number;
  retryAfterMs?: number;
};
type ReconcileResetOptions = {
  loadIntentsImpl?: () => Promise<DurableResetIntent[]>;
  requestResetImpl?: (intent: ResetIntent) => Promise<unknown>;
  completeStateImpl?: (
    chatKey: string,
    options: {
      clearQueue?: boolean;
      discardThroughUpdateId?: number;
      resetFence?: number;
    },
  ) => Promise<unknown>;
  clearIntentImpl?: (
    chatKey: string,
    expectedRequestedAt?: number,
  ) => Promise<unknown>;
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
  clearChatQueue: (
    chatKey: string,
    discardThroughUpdateId?: number,
    resetFence?: number,
  ) => Promise<void>;
  clearPrivateResetIntent: (
    chatKey: string,
    options?: {
      clearImpl?: (directory: string, chatKey: string) => Promise<void>;
      expectedRequestedAt?: number;
    },
  ) => Promise<boolean>;
  completeScopedResetState: (
    chatKey: string,
    options: CompleteResetOptions,
  ) => Promise<void>;
  drainReadyQueueHeads: (options: DrainOptions) => Promise<number>;
  hasPrivateResetIntent: (chatKey: string) => boolean;
  privateResetIntentPhase: (chatKey: string, now?: () => number) => string;
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
      now?: () => number;
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

const dataDir = tempDir("iva-scoped-reset-");
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "test-secret";
await import("./lib/ts-esm-hooks.ts");

const [pollModule, runStatusModule, inboxModule] = (await Promise.all([
  import(`./telegram-poll.mjs?reset-test=${Date.now()}`),
  import(`#lib/run-status.ts?reset-test=${Date.now()}`),
  import("./poller/inbox.ts"),
])) as [unknown, unknown, unknown];
type InboxModule = {
  admitTelegramUpdate: (
    update: QueueUpdate,
    options?: { trustedLocal?: boolean },
  ) => Promise<string>;
  promoteReadyInbox: (options?: {
    now?: () => number;
    collectorOptions?: { quietMs?: number };
    routeImpl?: (
      update: QueueUpdate,
      options?: { arrivedAt?: number; resetFence?: number | null },
    ) => Promise<string>;
  }) => Promise<number>;
};
const {
  clearChatQueue,
  clearPrivateResetIntent,
  completeScopedResetState,
  drainReadyQueueHeads,
  hasPrivateResetIntent,
  loadPrivateResetIntents,
  loadQueue,
  performScopedReset,
  persistPrivateResetIntent,
  privateResetIntentPhase,
  reconcileScopedResetIntents,
  routeMessageUpdate,
  retireSettledSessions,
  writeQueueAtomic,
} = pollModule as PollModule;
const status = runStatusModule as RunStatusModule;
const inbox = inboxModule as InboxModule;

const inboxKey = (chatId: number, fromId: number) => `${chatId}::${fromId}`;
const inboxDocument = () =>
  JSON.parse(
    readFileSync(join(dataDir, "telegram-inbox.json"), "utf8"),
  ) as unknown as QueueDocument;
const inboxUpdate = (chatId: number, updateId: number, text: string) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1,
    chat: { id: chatId, type: "private" },
    from: { id: 42, is_bot: false, first_name: "Owner" },
    text,
  },
});

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

// Тесты соответствия specs/ResetEpoch.tla: имя называет инвариант модели.
const privateUpdate = (updateId: number, chatId: number, text: string) => ({
  version: 1,
  updateId,
  enqueuedAt: 1,
  update: {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: chatId, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Owner" },
      text,
    },
  },
});

test("ResetIntent Phase: /new moves the phase none -> blocked -> recorded -> waiting -> recorded -> none", async () => {
  const key = "601:";
  let now = 1_000;
  const phase = () => privateResetIntentPhase(key, () => now);
  await writeQueueAtomic({ version: 1, queues: {} });
  assert.equal(phase(), "none");
  await assert.rejects(
    performScopedReset(
      key,
      { sessionId: "session-601" },
      {
        clearQueue: true,
        discardThroughUpdateId: 600,
        persistIntentImpl: async () => {
          throw new Error("disk full");
        },
        now: () => now,
      },
    ),
    /disk full/u,
  );
  assert.equal(phase(), "blocked");
  assert.equal(hasPrivateResetIntent(key), false);
  now += 30_000;
  assert.equal(phase(), "none");
  await assert.rejects(
    performScopedReset(
      key,
      { sessionId: "session-601" },
      {
        clearQueue: true,
        discardThroughUpdateId: 600,
        requestResetImpl: async () => {
          throw new Error("eve unavailable");
        },
        now: () => now,
      },
    ),
    /eve unavailable/u,
  );
  assert.equal(phase(), "waiting");
  assert.equal(hasPrivateResetIntent(key), true);
  now += 30_000;
  assert.equal(phase(), "recorded");
  assert.equal(
    await reconcileScopedResetIntents({
      requestResetImpl: async () => ({ status: "reset" }),
      logImpl: () => {},
      now: () => now,
    }),
    1,
  );
  assert.equal(phase(), "none");
  assert.deepEqual(await loadPrivateResetIntents(), []);
});

test("ResetIntent IntentUntilClean and ConfirmOnce: a failed queue cleanup keeps the intent, recovery sends no confirmation", async () => {
  const key = "602:";
  let now = 0;
  const notices: string[] = [];
  await writeQueueAtomic({
    version: 1,
    queues: { [key]: [privateUpdate(700, 602, "before /new")] },
  });
  await persistPrivateResetIntent(key, 701);
  const options = {
    requestResetImpl: async () => ({ status: "reset" }),
    logImpl: () => {},
    sendImpl: async (_chatKey: string, text: string) => {
      notices.push(text);
    },
    now: () => now,
  };

  assert.equal(
    await reconcileScopedResetIntents({
      ...options,
      completeStateImpl: async () => {
        throw new Error("queue rewrite failed");
      },
    }),
    0,
  );
  assert.deepEqual(
    (await loadPrivateResetIntents()).map(({ chatKey }) => chatKey),
    [key],
    "the intent must survive until its queue is cleared",
  );
  assert.equal(
    privateResetIntentPhase(key, () => now),
    "waiting",
  );
  const delivered: number[] = [];
  const drain = () =>
    drainReadyQueueHeads({
      deliverImpl: async (update) => {
        delivered.push(update.update_id);
        return true;
      },
      settleUntil: new Map(),
      inFlight: new Map(),
      pins: new Map(),
    });
  await drain();
  assert.deepEqual(delivered, [], "a message before /new never drains");

  now += 30_000;
  assert.equal(await reconcileScopedResetIntents(options), 1);
  assert.equal((await loadQueue()).queues[key], undefined);
  assert.deepEqual(await loadPrivateResetIntents(), []);
  await drain();
  assert.deepEqual(delivered, []);
  assert.deepEqual(notices, [], "recovery never repeats the confirmation");
});

test("ResetEpoch ExactCut: recovery clears the queue through the recorded update_id and keeps later messages", async () => {
  const key = "603:";
  const intent = (await persistPrivateResetIntent(key, 801, {
    now: () => 1000,
  })) as DurableResetIntent;
  await writeQueueAtomic({
    version: 1,
    queues: {
      [key]: [
        privateUpdate(800, 603, "before /new"),
        // Принятое под живым намерением: промоут ставит эпоху намерения,
        // и правило >= границы оставляет такой элемент.
        { ...privateUpdate(802, 603, "after /new"), resetFence: intent.requestedAt },
      ],
    },
  });
  assert.equal(
    await reconcileScopedResetIntents({
      requestResetImpl: async () => ({ status: "reset" }),
      logImpl: () => {},
    }),
    1,
  );
  assert.deepEqual(
    (await loadQueue()).queues[key]?.map(({ updateId }) => updateId),
    [802],
  );
  await writeQueueAtomic({ version: 1, queues: {} });
});

test("ResetIntent ExactCut: a reconciliation that scanned before /new does not reset the session the delivery filled", async () => {
  const key = "735:";
  await persistPrivateResetIntent(key, 731, { now: () => 1000 });
  // Эпоха /new детерминирована: floor = намерение + 1.
  await writeQueueAtomic({
    version: 1,
    queues: {
      [key]: [
        privateUpdate(730, 735, "before /new"),
        // Принятое под намерением нового /new (эпоха 1001): живо по >=.
        { ...privateUpdate(732, 735, "after /new"), resetFence: 1001 },
      ],
    },
  });
  // Удалённая сторона: агент разрешает сессию чата по адресу и сбрасывает её.
  const session: number[] = [730];
  const resets: string[] = [];
  const reset = (name: string) => {
    resets.push(name);
    session.length = 0;
    return Promise.resolve({ status: "reset" });
  };

  // Барьер в сверке: скан намерений на диске задерживается до /new и доставки 732.
  let releaseScan = () => {};
  let scanStarted = () => {};
  const started = new Promise<void>((resolve) => (scanStarted = resolve));
  const gate = new Promise<void>((resolve) => (releaseScan = resolve));
  let scans = 0;
  const reconciliation = reconcileScopedResetIntents({
    loadIntentsImpl: async () => {
      const intents = await loadPrivateResetIntents();
      scans += 1;
      if (scans === 1) {
        scanStarted();
        await gate;
      }
      return intents;
    },
    requestResetImpl: async () => reset("late-reconcile"),
    logImpl: () => {},
    sendImpl: async () => {},
  });
  await started;

  await performScopedReset(
    key,
    { address: { chatId: "735" } },
    {
      clearQueue: true,
      discardThroughUpdateId: 731,
      persistIntentImpl: () =>
        persistPrivateResetIntent(key, 731, { now: () => 1001 }),
      requestResetImpl: async () => reset("new"),
      logImpl: () => {},
    },
  );
  assert.deepEqual(
    [...session],
    [],
    "/new resets the session before the queue drains",
  );
  await drainReadyQueueHeads({
    deliverImpl: async (update) => {
      session.push(update.update_id);
      return true;
    },
    settleUntil: new Map(),
    inFlight: new Map(),
    pins: new Map(),
  });
  assert.deepEqual(
    session,
    [732],
    "the message after /new reached the new session",
  );

  releaseScan();
  assert.equal(
    await reconciliation,
    0,
    "an intent that /new removed is not reconciled",
  );
  assert.deepEqual(
    session,
    [732],
    "the late reconciliation must not reset the session /new already filled",
  );
  assert.deepEqual(resets, ["new"], "one remote reset — the main path of /new");
  await writeQueueAtomic({ version: 1, queues: {} });
});

test("ResetIntent ExactCut: delivery of a chat waits while its reset holds the chat queue", async () => {
  const key = "736:";
  await writeQueueAtomic({
    version: 1,
    queues: { [key]: [privateUpdate(740, 736, "queued while the reset runs")] },
  });
  let enteredReset = () => {};
  let releaseReset = () => {};
  const entered = new Promise<void>((resolve) => (enteredReset = resolve));
  const gate = new Promise<void>((resolve) => (releaseReset = resolve));
  // Сброс отставки сессии: очередь чата не чистится и намерения нет — доставку держит
  // только очередь сброса чата.
  const reset = performScopedReset(
    key,
    { sessionId: "session-736" },
    {
      requestResetImpl: async () => {
        enteredReset();
        await gate;
        return { status: "reset" };
      },
      logImpl: () => {},
    },
  );
  await entered;
  const delivered: number[] = [];
  const drain = () =>
    drainReadyQueueHeads({
      deliverImpl: async (update) => {
        delivered.push(update.update_id);
        return true;
      },
      settleUntil: new Map(),
      inFlight: new Map(),
      pins: new Map(),
    });
  await drain();
  assert.deepEqual(
    delivered,
    [],
    "the chat waits while its reset holds the chat queue",
  );
  releaseReset();
  await reset;
  await drain();
  assert.deepEqual(
    delivered,
    [740],
    "the head drains after the reset finishes",
  );
  await writeQueueAtomic({ version: 1, queues: {} });
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
  await persistPrivateResetIntent(key, undefined, { now: () => 4242 });

  const remoteRetries: ResetIntent[] = [];
  await reconcileScopedResetIntents({
    requestResetImpl: async (intent) => {
      remoteRetries.push(intent);
    },
  });

  assert.deepEqual(remoteRetries, [
    {
      chatKey: key,
      resetEpoch: 4242,
      target: { address: { chatId: "106" } },
    },
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

// update_id Telegram не обязан расти (опыт c1, backlog IVB-501): сообщение до /new с
// бо́льшим номером обязано уйти, а сообщение после /new с меньшим — остаться.
// Границу задаёт эпоха сброса (requestedAt намерения), а не номер и не штамп времени.
test("a reset cuts the queue by reset fence, not by update_id", async () => {
  const key = "512:";
  await writeQueueAtomic({
    version: 1,
    queues: {
      [key]: [
        {
          version: 1,
          updateId: 900,
          enqueuedAt: 1,
          update: { update_id: 900, message: { text: "before /new" } },
        },
      ],
    },
  });
  await performScopedReset(
    key,
    { sessionId: "session-512" },
    {
      clearQueue: true,
      discardThroughUpdateId: 500,
      requestResetImpl: async () => {
        // Пришло, пока шёл сброс: номер меньше отсечки, но элемент помечается
        // эпохой ожидающего намерения и переживает чистку.
        await routeMessageUpdate(
          {
            update_id: 400,
            message: {
              message_id: 400,
              date: 1,
              chat: { id: 512, type: "private" },
              from: { id: 42, is_bot: false, first_name: "Owner" },
              text: "after /new",
            },
          },
          {
            deliverImpl: () => Promise.resolve(true),
            acknowledgeImpl: () => Promise.resolve(),
            shouldQueueImpl: () => true,
          },
        );
        return { status: "reset" };
      },
    },
  );
  assert.deepEqual(
    (await loadQueue()).queues[key]?.map(({ updateId }) => updateId),
    [400],
  );
  await writeQueueAtomic({ version: 1, queues: {} });
});

test("reconcile cuts the queue by reset fence too", async () => {
  const key = "513:";
  const intent = (await persistPrivateResetIntent(
    key,
    500,
  )) as DurableResetIntent;
  await writeQueueAtomic({
    version: 1,
    queues: {
      [key]: [
        {
          // До /new: без пометки эпохи, время постановки старше границы — уходит.
          version: 1,
          updateId: 900,
          enqueuedAt: intent.requestedAt - 1,
          update: { update_id: 900, message: { text: "before /new" } },
        },
        {
          // Штамп совпадает с границей миллисекунда в миллисекунду — без эпохи
          // это не доказывает «после», элемент уходит.
          version: 1,
          updateId: 700,
          enqueuedAt: intent.requestedAt,
          update: { update_id: 700, message: { text: "same ms" } },
        },
        {
          // После /new: помечен эпохой намерения — живёт, хотя штамп старше её.
          version: 1,
          updateId: 400,
          enqueuedAt: intent.requestedAt - 1,
          resetFence: intent.requestedAt,
          update: { update_id: 400, message: { text: "after /new" } },
        },
        {
          // Запись до появления пометок: время постановки строго позже границы —
          // пришла после /new, живёт.
          version: 1,
          updateId: 500,
          enqueuedAt: intent.requestedAt + 1,
          update: { update_id: 500, message: { text: "legacy post" } },
        },
      ],
    },
  });
  assert.equal(
    await reconcileScopedResetIntents({
      requestResetImpl: () => Promise.resolve({ status: "reset" }),
      logImpl: () => {},
    }),
    1,
  );
  assert.deepEqual(
    (await loadQueue()).queues[key]?.map(({ updateId }) => updateId),
    [400, 500],
  );
  await writeQueueAtomic({ version: 1, queues: {} });
});

const intentFileFor = (key: string) =>
  join(
    dataDir,
    "telegram-reset-intents",
    `${Buffer.from(key, "utf8").toString("base64url")}.json`,
  );
// Новое /new перезаписывает durable-намерение той же пары чат:эпоха новой
// requestedAt. persistImpl пишет файл сама, потому что подменяет durable-слой.
const persistFreshIntent = async (
  key: string,
  requestedAt: number,
): Promise<DurableResetIntent> => {
  const fresh: DurableResetIntent = { version: 1, chatKey: key, requestedAt };
  await persistPrivateResetIntent(key, undefined, {
    persistImpl: async (_directory, chatKey) => {
      writeFileSync(intentFileFor(chatKey), JSON.stringify(fresh));
      return fresh;
    },
  });
  return fresh;
};

// Второй возврат IVB-501: сверка завершила намерение, которое за время remote-вызова
// уступило новому /new, — её clearChatQueue резал элементы новой эпохи, а clearIntent
// снимал чужое намерение. Теперь сверка проверяет актуальность перед чисткой.
test("a reconcile superseded during remote reset keeps the newer intent and its queue", async () => {
  const key = "516:";
  status.setChatStatus(key, { status: "idle" });
  await writeQueueAtomic({ version: 1, queues: {} });
  const stale = (await persistPrivateResetIntent(key)) as DurableResetIntent;
  let remoteEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    remoteEntered = resolve;
  });
  let releaseRemote: (() => void) | undefined;
  const remoteGate = new Promise<void>((resolve) => {
    releaseRemote = resolve;
  });
  const reconciling = reconcileScopedResetIntents({
    loadIntentsImpl: async () => [stale],
    requestResetImpl: async () => {
      remoteEntered?.();
      await remoteGate;
      return { status: "reset" };
    },
    logImpl: () => {},
  });
  await entered;
  const fresh = await persistFreshIntent(key, stale.requestedAt + 1);
  await routeMessageUpdate(
    {
      update_id: 600,
      message: {
        message_id: 600,
        date: 1,
        chat: { id: 516, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Owner" },
        text: "after second /new",
      },
    },
    {
      deliverImpl: () => Promise.resolve(true),
      acknowledgeImpl: () => Promise.resolve(),
      shouldQueueImpl: () => true,
    },
  );
  releaseRemote?.();

  assert.equal(await reconciling, 0);
  assert.deepEqual(
    (await loadQueue()).queues[key]?.map(({ updateId }) => updateId),
    [600],
  );
  assert.deepEqual(
    (await loadPrivateResetIntents()).filter(({ chatKey }) => chatKey === key),
    [fresh],
  );
  assert.equal(hasPrivateResetIntent(key), true);
  await clearPrivateResetIntent(key);
});

test("a reconcile skips an intent already superseded before its remote call", async () => {
  const key = "517:";
  status.setChatStatus(key, { status: "idle" });
  const stale = (await persistPrivateResetIntent(key)) as DurableResetIntent;
  const fresh = await persistFreshIntent(key, stale.requestedAt + 1);
  let remoteCalls = 0;
  assert.equal(
    await reconcileScopedResetIntents({
      loadIntentsImpl: async () => [stale],
      requestResetImpl: async () => {
        remoteCalls += 1;
        return { status: "reset" };
      },
      logImpl: () => {},
    }),
    0,
  );
  assert.equal(remoteCalls, 0);
  assert.deepEqual(
    (await loadPrivateResetIntents()).filter(({ chatKey }) => chatKey === key),
    [fresh],
  );
  await clearPrivateResetIntent(key);
});

test("a reconcile completing under a newer intent leaves its durable record", async () => {
  const key = "518:";
  status.setChatStatus(key, { status: "idle" });
  const stale = (await persistPrivateResetIntent(key)) as DurableResetIntent;
  assert.equal(
    await reconcileScopedResetIntents({
      loadIntentsImpl: async () => [stale],
      requestResetImpl: async () => ({ status: "reset" }),
      completeStateImpl: async () => {
        // Новое /new приземлилось между remote и снятием намерения.
        await persistFreshIntent(key, stale.requestedAt + 1);
      },
      logImpl: () => {},
    }),
    0,
  );
  assert.equal(hasPrivateResetIntent(key), true);
  assert.deepEqual(
    (await loadPrivateResetIntents()).filter(({ chatKey }) => chatKey === key),
    [{ version: 1, chatKey: key, requestedAt: stale.requestedAt + 1 }],
  );
  await clearPrivateResetIntent(key);
});

// Слот remote-сброса един на чат (T341): пока remote /new летит, проход сверки
// ждёт его конца и, видя упавший за эту эпоху вызов, второй не выпускает — за
// одно намерение remote уходит один раз, запоздать ему некуда.
test("a reconcile during a delayed /new remote issues no second remote for the intent", async () => {
  const key = "522:";
  status.setChatStatus(key, { status: "idle" });
  await writeQueueAtomic({ version: 1, queues: {} });
  let remoteCalls = 0;
  let remoteEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    remoteEntered = resolve;
  });
  let releaseRemote: (() => void) | undefined;
  const remoteGate = new Promise<void>((resolve) => {
    releaseRemote = resolve;
  });
  const requestResetImpl = async () => {
    remoteCalls += 1;
    remoteEntered?.();
    await remoteGate;
    return { status: "reset" };
  };
  const resetting = performScopedReset(
    key,
    { address: { chatId: "522" } },
    { clearQueue: true, requestResetImpl, logImpl: () => {} },
  );
  await entered; // remote /new в полёте и держит слот
  const reconciling = reconcileScopedResetIntents({
    requestResetImpl,
    logImpl: () => {},
  });
  releaseRemote?.();
  await resetting;
  await reconciling;
  assert.equal(remoteCalls, 1);
  assert.equal(hasPrivateResetIntent(key), false);
});

// Пока remote сверки за F1 летит, remote нового /new F2 ждёт слота: старый
// вызов падает первым, и свежий разговор он не стирает (T341).
test("a /new remote waits for the reconciled intent's remote to land first", async () => {
  const key = "523:";
  status.setChatStatus(key, { status: "idle" });
  await writeQueueAtomic({ version: 1, queues: {} });
  const stale = (await persistPrivateResetIntent(key)) as DurableResetIntent;
  const events: string[] = [];
  let remoteEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    remoteEntered = resolve;
  });
  let releaseRemote: (() => void) | undefined;
  const remoteGate = new Promise<void>((resolve) => {
    releaseRemote = resolve;
  });
  const reconciling = reconcileScopedResetIntents({
    loadIntentsImpl: async () => [stale],
    requestResetImpl: async () => {
      events.push("reconcile-issued");
      remoteEntered?.();
      await remoteGate;
      events.push("reconcile-landed");
      return { status: "reset" };
    },
    logImpl: () => {},
  });
  await entered; // remote F1 в полёте и держит слот
  const resetting = performScopedReset(
    key,
    { address: { chatId: "523" } },
    {
      clearQueue: true,
      requestResetImpl: async () => {
        events.push("new-issued");
        return { status: "reset" };
      },
      logImpl: () => {},
    },
  );
  // remote F2 ждёт слота: пока намерение не перезаписано и чуть дольше — его
  // выпуск недопустим, пока F1 не упал.
  for (
    let intent = (await loadPrivateResetIntents()).find(
      ({ chatKey }) => chatKey === key,
    );
    intent === undefined || intent.requestedAt === stale.requestedAt;
    intent = (await loadPrivateResetIntents()).find(
      ({ chatKey }) => chatKey === key,
    )
  ) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["reconcile-issued"]);
  releaseRemote?.();
  const [reconciled] = await Promise.all([reconciling, resetting]);
  assert.deepEqual(events, [
    "reconcile-issued",
    "reconcile-landed",
    "new-issued",
  ]);
  assert.equal(reconciled, 0);
  assert.equal(hasPrivateResetIntent(key), false);
});

// Запоздалый remote после завершённого /new: сверка со старым снимком намерения
// вызова не выпускает — слот видит упавшую за эту эпоху посадку (отметка
// процесса и resetEpoch статуса), и доставленное в свежий разговор не
// стирается (T341).
test("a stale reconcile lands no remote after the completed /new and delivery", async () => {
  const key = "524:";
  status.setChatStatus(key, { status: "idle" });
  await writeQueueAtomic({ version: 1, queues: {} });
  let f1: DurableResetIntent | undefined;
  let remoteCalls = 0;
  await performScopedReset(
    key,
    { address: { chatId: "524" } },
    {
      clearQueue: true,
      persistIntentImpl: async (chatKey, discardThroughUpdateId) => {
        f1 = (await persistPrivateResetIntent(
          chatKey,
          discardThroughUpdateId,
        )) as DurableResetIntent;
        return f1;
      },
      requestResetImpl: async () => {
        remoteCalls += 1;
        return { status: "reset" };
      },
      logImpl: () => {},
    },
  );
  assert.equal(remoteCalls, 1);
  const delivered: number[] = [];
  const result = await routeMessageUpdate(
    {
      update_id: 610,
      message: {
        message_id: 610,
        date: 1,
        chat: { id: 524, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Owner" },
        text: "fresh conversation",
      },
    },
    {
      deliverImpl: async () => {
        delivered.push(610);
        return true;
      },
      acknowledgeImpl: () => Promise.resolve(),
      shouldQueueImpl: () => false,
    },
  );
  assert.equal(result, "delivered");
  assert.deepEqual(delivered, [610]);
  // Снимок старого намерения: сверка его отпускает ещё до слота.
  assert.equal(
    await reconcileScopedResetIntents({
      loadIntentsImpl: async () => [f1 as DurableResetIntent],
      requestResetImpl: async () => {
        remoteCalls += 1;
        return { status: "reset" };
      },
      logImpl: () => {},
    }),
    0,
  );
  assert.equal(remoteCalls, 1);
  // Окно «remote упал, намерение не снято» (падение процесса между записью
  // статуса и снятием): сверка дожимает намерение локально, второй вызов не
  // выпускает.
  await persistFreshIntent(key, (f1 as DurableResetIntent).requestedAt);
  assert.equal(
    await reconcileScopedResetIntents({
      requestResetImpl: async () => {
        remoteCalls += 1;
        return { status: "reset" };
      },
      logImpl: () => {},
    }),
    1,
  );
  assert.equal(remoteCalls, 1);
  assert.equal(hasPrivateResetIntent(key), false);
  assert.equal(
    status.getChatStatus(key).resetEpoch,
    (f1 as DurableResetIntent).requestedAt,
  );
});

// Окно внутри чистки очереди: новое /new успело записать свою эпоху, пока старое
// завершение ждало блокировку — отсечка идёт по живой границе, а не по аргументу.
test("a stale fence cleans the queue for the live epoch, not its own", async () => {
  const key = "519:";
  const stale = (await persistPrivateResetIntent(key)) as DurableResetIntent;
  const fresh: DurableResetIntent = {
    version: 1,
    chatKey: key,
    requestedAt: stale.requestedAt + 1,
  };
  await writeQueueAtomic({
    version: 1,
    queues: {
      [key]: [
        {
          version: 1,
          updateId: 910,
          enqueuedAt: stale.requestedAt + 1,
          resetFence: stale.requestedAt,
          update: { update_id: 910, message: { text: "stale epoch" } },
        },
        {
          version: 1,
          updateId: 600,
          enqueuedAt: stale.requestedAt + 1,
          resetFence: fresh.requestedAt,
          update: { update_id: 600, message: { text: "live epoch" } },
        },
        {
          version: 1,
          updateId: 700,
          enqueuedAt: fresh.requestedAt + 1,
          update: { update_id: 700, message: { text: "unmarked after" } },
        },
        {
          version: 1,
          updateId: 800,
          enqueuedAt: fresh.requestedAt,
          update: { update_id: 800, message: { text: "unmarked at fence" } },
        },
      ],
    },
  });
  await persistFreshIntent(key, fresh.requestedAt);
  await clearChatQueue(key, undefined, stale.requestedAt);
  assert.deepEqual(
    (await loadQueue()).queues[key]?.map(({ updateId }) => updateId),
    [600, 700],
  );
  await clearPrivateResetIntent(key);
});

// Пометка новее отсекаемой границы — наследие отменённого намерения: сброс не
// состоялся, и элемент живёт по тому же правилу, что в promoteReadyInbox.
test("a fence newer than the cleared one keeps its queue item", async () => {
  const key = "521:";
  await writeQueueAtomic({
    version: 1,
    queues: {
      [key]: [
        {
          version: 1,
          updateId: 600,
          enqueuedAt: 500,
          resetFence: 2000,
          update: { update_id: 600, message: { text: "newer epoch" } },
        },
      ],
    },
  });
  await clearChatQueue(key, undefined, 1000);
  assert.deepEqual(
    (await loadQueue()).queues[key]?.map(({ updateId }) => updateId),
    [600],
  );
});

test("a reset superseded during remote leaves the newer epoch's state", async () => {
  const key = "520:";
  status.setChatStatus(key, { status: "running", sessionId: "live-session" });
  await writeQueueAtomic({ version: 1, queues: {} });
  let stale: DurableResetIntent | undefined;
  await performScopedReset(
    key,
    { sessionId: "old-session" },
    {
      clearQueue: true,
      persistIntentImpl: async (chatKey, discardThroughUpdateId) => {
        stale = (await persistPrivateResetIntent(
          chatKey,
          discardThroughUpdateId,
        )) as DurableResetIntent;
        return stale;
      },
      requestResetImpl: async () => {
        await persistFreshIntent(
          key,
          (stale as DurableResetIntent).requestedAt + 1,
        );
        await routeMessageUpdate(
          {
            update_id: 600,
            message: {
              message_id: 600,
              date: 1,
              chat: { id: 520, type: "private" },
              from: { id: 42, is_bot: false, first_name: "Owner" },
              text: "after second /new",
            },
          },
          {
            deliverImpl: () => Promise.resolve(true),
            acknowledgeImpl: () => Promise.resolve(),
            shouldQueueImpl: () => true,
          },
        );
        return { status: "reset" };
      },
    },
  );
  assert.equal(status.getChatStatus(key).status, "running");
  assert.equal(status.getChatStatus(key).sessionId, "live-session");
  assert.deepEqual(
    (await loadQueue()).queues[key]?.map(({ updateId }) => updateId),
    [600],
  );
  assert.equal(hasPrivateResetIntent(key), true);
  await clearPrivateResetIntent(key);
});

// Склейка через границу /new: до-часть мертва и снимается с durable inbox до
// коллектора, после-часть идёт в маршрут со своей эпохой (возврат IVB-501).
test("a burst merged across the reset keeps only the post-reset part", async () => {
  const key = "515:";
  await inbox.admitTelegramUpdate(inboxUpdate(515, 900, "before /new"), {
    trustedLocal: true,
  });
  const intent = (await persistPrivateResetIntent(key)) as DurableResetIntent;
  await inbox.admitTelegramUpdate(inboxUpdate(515, 400, "after /new"), {
    trustedLocal: true,
  });
  const routed: Array<{
    update: QueueUpdate;
    resetFence?: number | null;
  }> = [];
  await inbox.promoteReadyInbox({
    now: () => Date.now() + 60_000,
    collectorOptions: { quietMs: 800 },
    routeImpl: async (update, options) => {
      routed.push({ update, resetFence: options?.resetFence });
      return "queued";
    },
  });
  assert.deepEqual(
    routed.map(({ update }) => update.update_id),
    [400],
  );
  assert.equal(routed[0]?.resetFence, intent.requestedAt);
  assert.deepEqual(inboxDocument().queues[inboxKey(515, 42)] ?? [], []);
  await clearPrivateResetIntent(key);
});

// Запись, принятая до /new, не доходит до нового разговора ни напрямую, ни через
// очередь: успешный сброс оставляет эпоху в статусе, и промоут снимает её до
// маршрута (возврат IVB-501).
test("an inbox message admitted before /new is dropped before delivery", async () => {
  const key = "514:";
  await inbox.admitTelegramUpdate(inboxUpdate(514, 900, "before /new"), {
    trustedLocal: true,
  });
  await performScopedReset(
    key,
    { sessionId: "session-514" },
    {
      clearQueue: true,
      requestResetImpl: () => Promise.resolve({ status: "reset" }),
    },
  );
  const routed: number[] = [];
  await inbox.promoteReadyInbox({
    routeImpl: async (update) => {
      routed.push(update.update_id);
      return "delivered";
    },
  });
  assert.deepEqual(routed, []);
  assert.deepEqual(inboxDocument().queues[inboxKey(514, 42)] ?? [], []);
});

// Эпоха сброса — счётчик, а не показание часов (замечание D53 п.1): повторное
// /new обязано поднять эпоху выше последней durable, иначе принятое до него
// переживает чистку новой границы (проба приёмки T122: actualQueue=[900],
// actualDelivered=[900]). Первый /new завершается при часах firstNow, затем 900
// принимается в inbox и в очередь под его эпохой, а второй /new записывает
// намерение при часах secondNow.
const secondNewProbe = async (
  key: string,
  chatId: number,
  firstNow: number,
  secondNow: number,
) => {
  status.setChatStatus(key, { status: "idle" });
  await writeQueueAtomic({ version: 1, queues: {} });
  await performScopedReset(
    key,
    { sessionId: `session-${chatId}-first` },
    {
      clearQueue: true,
      persistIntentImpl: (chatKey, discardThroughUpdateId) =>
        persistPrivateResetIntent(chatKey, discardThroughUpdateId, {
          now: () => firstNow,
        }),
      requestResetImpl: () => Promise.resolve({ status: "reset" }),
      now: () => firstNow,
    },
  );
  // Чат занят ходом: принятое до второго /new идёт в inbox и в очередь под
  // эпохой первого сброса.
  status.setChatStatus(key, { status: "running", sessionId: "busy" });
  const update = inboxUpdate(chatId, 900, "before second /new");
  await inbox.admitTelegramUpdate(update, { trustedLocal: true });
  assert.equal(
    await routeMessageUpdate(update, {
      deliverImpl: () => Promise.resolve(true),
      acknowledgeImpl: () => Promise.resolve(),
      shouldQueueImpl: () => true,
    }),
    "queued",
  );
  const second = (await persistPrivateResetIntent(key, undefined, {
    now: () => secondNow,
  })) as DurableResetIntent;
  assert.equal(
    await reconcileScopedResetIntents({
      requestResetImpl: () => Promise.resolve({ status: "reset" }),
      logImpl: () => {},
      now: () => secondNow,
    }),
    1,
  );
  const delivered: number[] = [];
  await inbox.promoteReadyInbox({
    now: () => secondNow + 60_000,
    routeImpl: async (candidate) => {
      delivered.push(candidate.update_id);
      return "delivered";
    },
  });
  return {
    second,
    queueItems: (await loadQueue()).queues[key],
    inboxItems: inboxDocument().queues[inboxKey(chatId, 42)] ?? [],
    delivered,
  };
};

test("a second /new in the same millisecond still retires the accepted message", async () => {
  const { second, queueItems, inboxItems, delivered } = await secondNewProbe(
    "530:",
    530,
    30_000,
    30_000,
  );
  assert.equal(second.requestedAt, 30_001);
  assert.equal(queueItems, undefined);
  assert.deepEqual(inboxItems, []);
  assert.deepEqual(delivered, []);
});

test("a clock rollback cannot lower the reset epoch", async () => {
  // Часы ушли на 10 с назад между первым и вторым /new.
  const { second, queueItems, inboxItems, delivered } = await secondNewProbe(
    "531:",
    531,
    30_000,
    20_000,
  );
  assert.equal(second.requestedAt, 30_001);
  assert.equal(queueItems, undefined);
  assert.deepEqual(inboxItems, []);
  assert.deepEqual(delivered, []);
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
  await persistPrivateResetIntent(key, undefined, { now: () => 4242 });
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
    {
      chatKey: key,
      resetEpoch: 4242,
      target: { address: { chatId: "108" } },
    },
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

test("a durable reset intent reconstructs its Telegram address and carries the epoch on the wire", async () => {
  const key = "429888768:";
  await persistPrivateResetIntent(key, undefined, { now: () => 4242 });

  const requested: ResetIntent[] = [];
  await reconcileScopedResetIntents({
    requestResetImpl: async (request) => {
      requested.push(request);
    },
  });

  assert.deepEqual(requested, [
    {
      chatKey: key,
      resetEpoch: 4242,
      target: { address: { chatId: "429888768" } },
    },
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

test("/new carries the intent epoch on the wire", async () => {
  const requested: ResetIntent[] = [];
  await performScopedReset(
    "epoch-wire:",
    { sessionId: "session-1" },
    {
      clearQueue: true,
      persistIntentImpl: async () => ({ requestedAt: 31415 }),
      requestResetImpl: async (request) => requested.push(request),
      completeStateImpl: async () => {},
      clearIntentImpl: async () => {},
    },
  );

  assert.deepEqual(requested, [
    {
      chatKey: "epoch-wire:",
      resetEpoch: 31415,
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
