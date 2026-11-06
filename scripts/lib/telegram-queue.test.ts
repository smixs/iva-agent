/* eslint-disable @typescript-eslint/require-await -- async test doubles preserve production promise boundaries */
/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- regression cases preserve non-Error boundary failures */
import test, { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  link,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import {
  TELEGRAM_MESSAGE_ENVELOPE_KEYS,
  TELEGRAM_MESSAGE_TEXT_KEYS,
} from "#lib/telegram-parts.ts";
import {
  acknowledgeQueueItems,
  createQueueItem,
  enqueueItem,
  enqueueQueueFile,
  invalidTelegramUpdatesDiagnostic,
  loadQueueFile,
  materializeQueueItem,
  migrateQueueFile,
  normalizeQueueDocument,
  parseTelegramUpdates,
  quarantineQueueRecords,
  queueCount,
  queueHead,
  queueKeys,
  removeQueueItems,
  shouldQueueBusyUpdate,
  TELEGRAM_QUEUE_ACK_ROLLED_BACK,
  TELEGRAM_QUEUE_FATAL_DURABILITY,
  TELEGRAM_QUEUE_ITEM_VERSION,
  TELEGRAM_QUEUE_VERSION,
  writeQueueFileAtomic,
  type TelegramQueueDocument,
  type TelegramQueueUpdate,
} from "./telegram-queue.ts";

type InFlightGate = {
  state: string;
  [key: string]: unknown;
};

type DrainOptions = {
  loadImpl: () => Promise<TelegramQueueDocument>;
  runningImpl: (chatKey: string) => boolean;
  deliverImpl: (
    update: TelegramQueueUpdate,
    options: { timeoutMs: number },
  ) => Promise<boolean | "handled" | "closed-session">;
  acknowledgeImpl: (
    chatKey: string,
    updateIds: readonly number[],
  ) => Promise<void>;
  settleUntil: Map<string, number>;
  inFlight?: Map<string, InFlightGate>;
  pins?: Map<string, readonly number[]>;
  statusImpl?: () => unknown;
  now?: () => number;
  gateWaitMs?: number;
  rotationState?: { afterKey: string | null };
  passBudgetMs?: number;
  deliveryTimeoutMs?: number;
  legacyAllowedUserIds?: ReadonlySet<string>;
  quarantineImpl?: (
    records: Parameters<typeof quarantineQueueRecords>[1],
  ) => Promise<unknown>;
};

type RouteMessageOptions = {
  chatKeyImpl: (update: TelegramQueueUpdate) => string;
  loadQueueImpl: () => Promise<TelegramQueueDocument>;
  runningImpl: (chatKey: string) => boolean;
  inFlight: Map<string, InFlightGate>;
  queueCountImpl: typeof queueCount;
  replyToBotImpl: (message: unknown) => boolean;
  shouldQueueImpl: (update: TelegramQueueUpdate) => boolean;
  enqueueImpl: (
    chatKey: string,
    update: TelegramQueueUpdate,
  ) => Promise<{ count: number }>;
  acknowledgeImpl: (
    update: TelegramQueueUpdate,
    count: number,
  ) => Promise<void>;
  deliverImpl: (update: TelegramQueueUpdate) => Promise<boolean>;
};

type PollModule = {
  drainReadyQueueHeads: (options: DrainOptions) => Promise<number>;
  routeMessageUpdate: (
    update: TelegramQueueUpdate,
    options: RouteMessageOptions,
  ) => Promise<string>;
};

type PrivateUpdate = {
  update_id: number;
  message: {
    message_id: number;
    date: number;
    chat: { id: number; type: string };
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
    };
    text: string;
  };
};

process.env.TELEGRAM_BOT_TOKEN ??= "999:test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN ??= "test-secret";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.TELEGRAM_POLL_SETTLE_MS = "0";
const statusDataDir = mkdtempSync(join(tmpdir(), "iva-telegram-queue-status-"));
process.env.ASSISTANT_DATA_DIR = statusDataDir;
void after(() => rmSync(statusDataDir, { recursive: true, force: true }));
const status = await import("#lib/run-status.ts");
const pollModulePath = "../telegram-poll.mjs";
const { drainReadyQueueHeads, routeMessageUpdate } = (await import(
  pollModulePath
)) as PollModule;

const privateUpdate = (updateId: number, text: string): PrivateUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1,
    chat: { id: 1, type: "private" },
    from: { id: 42, is_bot: false, first_name: "Owner" },
    text,
  },
});

async function queueFile(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iva-telegram-queue-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "telegram-queue.json");
}

async function waitForFile(file: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${file}`);
}

void test("atomic queue writes invoke a fresh nonce factory per write", async (t) => {
  const file = await queueFile(t);
  let calls = 0;
  const options = {
    nonce: () => `nonce-${(calls += 1)}`,
  };

  await writeQueueFileAtomic(file, { version: 1, queues: {} }, options);
  await writeQueueFileAtomic(file, { version: 1, queues: {} }, options);

  assert.equal(calls, 2);
});

void test("Telegram update parsing skips malformed items, not the whole batch", () => {
  const valid = privateUpdate(1, "valid");
  const callbackOnly = {
    update_id: 2,
    callback_query: {
      id: "callback-2",
      data: "iva_menu:r:o",
      from: { id: 42, is_bot: false, username: "owner" },
      message: {
        message_id: 9,
        date: 1,
        chat: { id: -100, type: "supergroup", title: "Iva" },
        text: "menu",
        reply_markup: { inline_keyboard: [] },
      },
      chat_instance: "instance-2",
    },
    extra_bot_api_field: { preserved: true },
  };

  const updatesOf = (value: unknown) =>
    parseTelegramUpdates(value)?.map((item) =>
      "update" in item ? item.update : { skipped: item.updateId },
    );
  assert.deepEqual(updatesOf([]), []);
  assert.deepEqual(updatesOf([valid]), [valid]);
  assert.deepEqual(updatesOf([callbackOnly]), [callbackOnly]);
  assert.equal(parseTelegramUpdates({ result: [valid] }), null);
  assert.deepEqual(updatesOf([{ ...valid, update_id: "1" }]), [
    { skipped: null },
  ]);
  assert.deepEqual(updatesOf([{ ...valid, update_id: 1.5 }]), [
    { skipped: null },
  ]);
  assert.deepEqual(
    updatesOf([
      { ...valid, message: { ...valid.message, text: 42 } },
      callbackOnly,
    ]),
    [{ skipped: valid.update_id }, callbackOnly],
  );
  assert.deepEqual(
    updatesOf([
      {
        ...valid,
        callback_query: { id: 42, data: "iva_menu:r:o" },
      },
    ]),
    [{ skipped: valid.update_id }],
  );
});

// 16.10.2026, c1: живой стоп не прошёл проверку по документации, и вход стоял. Поля стопа
// сверяет обработчик; пачка принимает любой объект и не пропускает его.
void test("a native stop with an unexpected shape stays an update, not a stalled batch", () => {
  for (const stop of [
    { chat: { id: 7, type: "private" }, draft_id: 41 },
    { chat: { id: 7 }, draft_id: "41" },
    { chat_id: 7, draft_id: 0 },
    {},
  ]) {
    const update = { update_id: 924152900, stopped_message_generation: stop };
    assert.deepEqual(parseTelegramUpdates([update]), [{ update }]);
  }
  assert.deepEqual(
    parseTelegramUpdates([
      { update_id: 5, stopped_message_generation: 1 },
    ])?.map((item) => ("skipped" in item ? item.updateId : "update")),
    [5],
  );
});

void test("invalid Telegram update diagnostics identify the item without logging content", () => {
  const valid = privateUpdate(1, "valid");
  const malformed = {
    ...privateUpdate(2, "secret message text"),
    update_id: "2",
  };

  assert.deepEqual(invalidTelegramUpdatesDiagnostic(undefined), {
    index: null,
    updateId: null,
    item: { type: "undefined" },
  });
  const diagnostic = invalidTelegramUpdatesDiagnostic([valid, malformed]);
  assert.deepEqual(diagnostic, {
    index: 1,
    updateId: "2",
    item: {
      type: "object",
      keys: ["message", "update_id"],
      fields: {
        message: [
          "chat:object",
          "date:number",
          "from:object",
          "message_id:number",
          "text:string",
        ],
      },
    },
  });
  assert.equal(
    JSON.stringify(diagnostic).includes("secret message text"),
    false,
  );
});

void test("newer queue documents refuse loading and migration without changing bytes", async (t) => {
  const file = await queueFile(t);
  const raw = Buffer.from(
    '{ "version": 2, "queues": { "1:": ["сохранить"] } }\n',
  );
  for (const strict of [true, false]) {
    for (const load of [loadQueueFile, migrateQueueFile]) {
      await writeFile(file, raw);
      await assert.rejects(
        load(file, { strict }),
        /записано более новой Ивой.*версия 2.*понимает 1.*обновите Иву или верните файл/,
      );
      assert.deepEqual(await readFile(file), raw);
      assert.deepEqual(await readdir(dirname(file)), ["telegram-queue.json"]);
    }
  }
});

for (const seed of [18102026, 18102027]) {
  void test(`PROPERTY: newer queue versions preserve arbitrary bytes (seed=${seed})`, async (t) => {
    const file = await queueFile(t);
    await fc.assert(
      fc.asyncProperty(
        fc.integer({
          min: TELEGRAM_QUEUE_VERSION + 1,
          max: Number.MAX_SAFE_INTEGER,
        }),
        fc.jsonValue(),
        fc.boolean(),
        async (version, queues, strict) => {
          const raw = Buffer.from(`  ${JSON.stringify({ version, queues })}\n`);
          for (const load of [loadQueueFile, migrateQueueFile]) {
            await writeFile(file, raw);
            await assert.rejects(
              load(file, { strict }),
              /записано более новой Ивой/,
            );
            assert.deepEqual(await readFile(file), raw);
            assert.deepEqual(await readdir(dirname(file)), [
              "telegram-queue.json",
            ]);
          }
        },
      ),
      { seed, numRuns: 100 },
    );
  });
}

void test("newer queue documents preserve both files during pending acknowledgement recovery", async (t) => {
  const file = await queueFile(t);
  const pendingFile = `${file}.ack-pending`;
  const current = JSON.stringify({
    version: TELEGRAM_QUEUE_VERSION,
    queues: {},
  });
  const newer = JSON.stringify({
    version: TELEGRAM_QUEUE_VERSION + 1,
    queues: { "1:": ["keep"] },
  });
  for (const strict of [true, false]) {
    for (const [main, pending] of [
      [current, newer],
      [newer, current],
    ]) {
      await writeFile(file, main);
      await writeFile(pendingFile, pending);
      await assert.rejects(
        migrateQueueFile(file, { strict }),
        /записано более новой Ивой/,
      );
      assert.equal(await readFile(file, "utf8"), main);
      assert.equal(await readFile(pendingFile, "utf8"), pending);
      assert.deepEqual((await readdir(dirname(file))).sort(), [
        "telegram-queue.json",
        "telegram-queue.json.ack-pending",
      ]);
    }
  }
});

void test("a newer queue item is preserved whole in the existing record quarantine", async (t) => {
  const file = await queueFile(t);
  const future = {
    version: TELEGRAM_QUEUE_ITEM_VERSION + 1,
    updateId: 10,
    futurePayload: { text: "сохранить", extra: [1, true, null] },
  };
  const good = createQueueItem(privateUpdate(11, "keep working"), 1);
  const raw = JSON.stringify({
    version: TELEGRAM_QUEUE_VERSION,
    queues: { "1:": [future, good] },
  });
  await writeFile(file, raw);
  const logs: unknown[][] = [];
  for (const strict of [true, false]) {
    assert.deepEqual(
      (
        await loadQueueFile(file, {
          strict,
          logImpl: (...parts) => logs.push(parts),
        })
      ).document.queues,
      { "1:": [good] },
    );
    assert.equal(await readFile(file, "utf8"), raw);
  }
  const copies = (await readdir(dirname(file))).filter((name) =>
    name.includes(".damaged-"),
  );
  assert.equal(copies.length, 1);
  const copy = JSON.parse(
    await readFile(join(dirname(file), copies[0]), "utf8"),
  ) as { record: unknown; reason: string };
  assert.deepEqual(copy.record, future);
  assert.match(copy.reason, /записано более новой Ивой.*версия 2.*понимает 1/);
  assert.equal(logs.length, 1);
  await enqueueQueueFile(file, "1:", privateUpdate(12, "next"), {
    strict: true,
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(dirname(file), copies[0]), "utf8")),
    copy,
  );
  assert.deepEqual(
    (await loadQueueFile(file, { strict: true })).document.queues["1:"].map(
      (item) => item.updateId,
    ),
    [11, 12],
  );
});

void test("queue reads preserve nullish non-Error failures", async () => {
  const firstSentinel = Symbol("not rejected");
  let firstCaught: unknown = firstSentinel;
  try {
    await loadQueueFile("/virtual/queue.json", {
      readFileImpl: () => Promise.reject(null),
    });
  } catch (error) {
    firstCaught = error;
  }
  assert.equal(firstCaught, null);

  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const secondSentinel = Symbol("not rejected");
  let secondCaught: unknown = secondSentinel;
  let reads = 0;
  try {
    await loadQueueFile("/virtual/queue.json", {
      readFileImpl: () =>
        (reads += 1) === 1
          ? Promise.reject(missing)
          : Promise.reject(undefined),
    });
  } catch (error) {
    secondCaught = error;
  }
  assert.equal(reads, 2);
  assert.equal(secondCaught, undefined);
});

void test("legacy quarantine preserves a null link failure", async (t) => {
  const file = await queueFile(t);
  await writeFile(file, JSON.stringify({ "-100:": ["legacy group text"] }));
  const sentinel = Symbol("not rejected");
  let caught: unknown = sentinel;

  try {
    await migrateQueueFile(file, {
      linkImpl: () => Promise.reject(null),
      quarantineNow: () => 1,
      quarantineNonce: () => "fixed",
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, null);
});

void test("versioned FIFO items preserve update ids, order and duplicate retries across reload", async (t) => {
  const file = await queueFile(t);
  await enqueueQueueFile(file, "1:", privateUpdate(101, "first"), {
    now: () => 1,
  });
  await enqueueQueueFile(file, "1:", privateUpdate(102, "second"), {
    now: () => 2,
  });
  const duplicate = await enqueueQueueFile(
    file,
    "1:",
    privateUpdate(101, "first"),
    {
      now: () => 3,
    },
  );

  assert.equal(duplicate.added, false);
  const { document } = await loadQueueFile(file, { strict: true });
  assert.equal(document.version, 1);
  assert.equal(queueCount(document, "1:"), 2);
  assert.deepEqual(
    document.queues["1:"].map((item) => [
      item.version,
      item.updateId,
      item.enqueuedAt,
    ]),
    [
      [1, 101, 1],
      [1, 102, 2],
    ],
  );
});

void test("failed batch removal leaves the whole FIFO byte-for-byte intact", async (t) => {
  const file = await queueFile(t);
  await enqueueQueueFile(file, "1:", privateUpdate(101, "first"));
  await enqueueQueueFile(file, "1:", privateUpdate(102, "second"));
  const before = await readFile(file, "utf8");

  await assert.rejects(
    acknowledgeQueueItems(file, "1:", [101], {
      renameImpl: async () => {
        throw new Error("injected ack rename failure");
      },
    }),
    /injected ack rename failure/,
  );

  assert.equal(await readFile(file, "utf8"), before);
  const { document } = await loadQueueFile(file, { strict: true });
  assert.equal(queueHead(document, "1:")!.updateId, 101);
});

void test("ack directory-sync failure durably rolls back the original FIFO batch", async (t) => {
  const file = await queueFile(t);
  await enqueueQueueFile(file, "1:", privateUpdate(101, "first"));
  await enqueueQueueFile(file, "1:", privateUpdate(102, "second"));
  let directorySyncs = 0;

  await assert.rejects(
    acknowledgeQueueItems(file, "1:", [101], {
      openImpl: async (path, flags) => {
        const handle = await open(path, flags);
        if (String(path) !== dirname(file) || flags !== "r") return handle;
        return {
          sync: async () => {
            directorySyncs++;
            if (directorySyncs === 2)
              throw new Error("injected ack directory sync failure");
            await handle.sync();
          },
          close: () => handle.close(),
        };
      },
    }),
    (error: unknown) =>
      (error as NodeJS.ErrnoException).code ===
        TELEGRAM_QUEUE_ACK_ROLLED_BACK &&
      (error as Error).message.includes("original batch 101 was restored"),
  );

  assert.equal(
    directorySyncs,
    4,
    "pending publication, failed removal, rollback and pending cleanup must all be ordered",
  );
  const { document } = await loadQueueFile(file, { strict: true });
  assert.deepEqual(
    document.queues["1:"].map((item) => item.updateId),
    [101, 102],
  );
});

void test("SIGKILL after acknowledgement rename restores the pending original queue on load", async (t) => {
  const file = await queueFile(t);
  const marker = join(dirname(file), "ack-renamed");
  await enqueueQueueFile(file, "1:", privateUpdate(101, "first"));
  await enqueueQueueFile(file, "1:", privateUpdate(102, "second"));
  await enqueueQueueFile(file, "1:", privateUpdate(103, "third"));
  await enqueueQueueFile(file, "1:", privateUpdate(104, "fourth"));
  const child = spawn(
    process.execPath,
    [
      join(
        import.meta.dirname,
        "../fixtures/telegram-queue-ack-crash-child.ts",
      ),
      file,
      marker,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });

  await waitForFile(marker);
  child.kill("SIGKILL");
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: null, signal: "SIGKILL" }, stderr);

  const { document } = await loadQueueFile(file, { strict: true });
  assert.deepEqual(
    document.queues["1:"].map((item) => item.updateId),
    [101, 102, 103, 104],
    "recovery may duplicate the accepted batch 101-103 but must not lose it",
  );
  assert.equal(existsSync(`${file}.ack-pending`), false);
});

void test("failed ack rollback becomes fatal and stops drain before another queue", async (t) => {
  const file = await queueFile(t);
  await enqueueQueueFile(file, "1:", privateUpdate(101, "first"));
  await enqueueQueueFile(file, "1:", privateUpdate(102, "second"));
  let directorySyncs = 0;

  await assert.rejects(
    acknowledgeQueueItems(file, "1:", [101], {
      openImpl: async (path, flags) => {
        const handle = await open(path, flags);
        if (String(path) !== dirname(file) || flags !== "r") return handle;
        return {
          sync: async () => {
            directorySyncs++;
            if (directorySyncs >= 2) {
              throw new Error("injected persistent directory sync failure");
            }
            await handle.sync();
          },
          close: () => handle.close(),
        };
      },
    }),
    (error: unknown) =>
      (error as NodeJS.ErrnoException).code === TELEGRAM_QUEUE_FATAL_DURABILITY,
  );

  const fatal = Object.assign(new Error("ack durability is unknown"), {
    code: TELEGRAM_QUEUE_FATAL_DURABILITY,
  });
  const delivered: number[] = [];
  const document = {
    version: 1,
    queues: Object.fromEntries([
      ["1:", [createQueueItem(privateUpdate(101, "first"), 1)]],
      ["2:", [createQueueItem(privateUpdate(201, "must not pass"), 2)]],
    ]),
  };
  await assert.rejects(
    drainReadyQueueHeads({
      loadImpl: async () => document,
      runningImpl: () => false,
      deliverImpl: async (update) => {
        delivered.push(update.update_id);
        return true;
      },
      acknowledgeImpl: async () => {
        throw fatal;
      },
      settleUntil: new Map(),
      inFlight: new Map(),
      pins: new Map(),
    }),
    (error) => error === fatal,
  );
  assert.deepEqual(delivered, [101]);
});

void test("acknowledging the same batch again writes nothing", async (t) => {
  const file = await queueFile(t);
  for (const [updateId, body] of [
    [101, "first"],
    [102, "second"],
    [103, "third"],
  ] as const) {
    await enqueueQueueFile(file, "1:", privateUpdate(updateId, body));
  }
  await acknowledgeQueueItems(file, "1:", [101, 102]);
  const before = await readFile(file, "utf8");
  let writes = 0;

  const document = await acknowledgeQueueItems(file, "1:", [101, 102], {
    writeFileImpl: async (...args) => {
      writes++;
      await writeFile(...args);
    },
  });

  assert.equal(writes, 0, "an acknowledgement after a break writes nothing");
  assert.equal(await readFile(file, "utf8"), before);
  assert.deepEqual(
    document.queues["1:"].map((item) => item.updateId),
    [103],
  );
});

void test("an acknowledgement skips ids a reset already removed and keeps what arrived after the snapshot", async (t) => {
  const file = await queueFile(t);
  for (const [updateId, body] of [
    [102, "second"],
    [103, "third"],
    [104, "after the snapshot"],
  ] as const) {
    await enqueueQueueFile(file, "1:", privateUpdate(updateId, body));
  }

  await acknowledgeQueueItems(file, "1:", [101, 102, 103]);

  const { document } = await loadQueueFile(file, { strict: true });
  assert.deepEqual(
    document.queues["1:"].map((item) => item.updateId),
    [104],
  );
});

void test("a batch that no longer stands at the head is refused without a write", async (t) => {
  const file = await queueFile(t);
  await enqueueQueueFile(file, "1:", privateUpdate(101, "first"));
  await enqueueQueueFile(file, "1:", privateUpdate(102, "second"));
  const before = await readFile(file, "utf8");

  await assert.rejects(
    acknowledgeQueueItems(file, "1:", [102]),
    /Telegram queue batch changed for 1:; expected updates 102/u,
  );
  await assert.rejects(
    acknowledgeQueueItems(file, "1:", []),
    /Telegram queue batch is empty/u,
  );
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal(existsSync(`${file}.ack-pending`), false);
});

void test("drain keeps the batch before acceptance and removes exactly the batch after acceptance", async () => {
  let document = [
    privateUpdate(101, "first"),
    privateUpdate(102, "second"),
    privateUpdate(103, "/x"),
  ].reduce<TelegramQueueDocument>(
    (current, update, index) =>
      enqueueItem(current, "1:", createQueueItem(update, index + 1)).document,
    { version: 1, queues: {} },
  );
  const delivered: number[] = [];
  const inFlight = new Map<string, InFlightGate>();
  const pins = new Map<string, readonly number[]>();
  const loadImpl = async () => document;
  const acknowledgeImpl: DrainOptions["acknowledgeImpl"] = async (
    key,
    updateIds,
  ) => {
    document = removeQueueItems(document, key, updateIds).document;
  };

  const rejectedCount = await drainReadyQueueHeads({
    loadImpl,
    runningImpl: () => false,
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      return false;
    },
    acknowledgeImpl,
    settleUntil: new Map(),
    inFlight,
    pins,
  });
  assert.equal(rejectedCount, 3);
  assert.equal(queueHead(document, "1:")!.updateId, 101);

  const acceptedCount = await drainReadyQueueHeads({
    loadImpl,
    runningImpl: () => false,
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      return true;
    },
    acknowledgeImpl,
    settleUntil: new Map(),
    inFlight,
    pins,
  });
  assert.equal(acceptedCount, 1);
  assert.equal(queueHead(document, "1:")!.updateId, 103);
  assert.deepEqual(
    delivered,
    [102, 102],
    "a second delivery may duplicate only the durable batch, under its last id",
  );
});

void test("a terminally closed session releases the queue head instead of blocking the chat", async () => {
  let document = enqueueItem(
    enqueueItem(
      { version: 1, queues: {} },
      "1:",
      createQueueItem(privateUpdate(101, "reply to a closed session"), 1),
    ).document,
    "1:",
    createQueueItem(privateUpdate(102, "/x"), 2),
  ).document;
  const delivered: number[] = [];
  const options: DrainOptions = {
    loadImpl: async () => document,
    runningImpl: () => false,
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      return update.update_id === 101 ? "closed-session" : true;
    },
    acknowledgeImpl: async (key, updateIds) => {
      document = removeQueueItems(document, key, updateIds).document;
    },
    settleUntil: new Map(),
    inFlight: new Map<string, InFlightGate>(),
    pins: new Map(),
  };

  assert.equal(await drainReadyQueueHeads(options), 1);
  assert.equal(queueHead(document, "1:")!.updateId, 102);
  assert.equal(await drainReadyQueueHeads(options), 0);
  assert.deepEqual(
    delivered,
    [101, 102],
    "терминальная голова уходит с одной попытки и не держит очередь",
  );
});

void test("an accepted head must observe its turn running and then idle before the next FIFO head", async () => {
  let document = enqueueItem(
    enqueueItem(
      { version: 1, queues: {} },
      "1:",
      createQueueItem(privateUpdate(101, "first"), 1),
    ).document,
    "1:",
    createQueueItem(privateUpdate(102, "/x"), 2),
  ).document;
  let running = false;
  const delivered: number[] = [];
  const inFlight = new Map<string, InFlightGate>();
  const options: DrainOptions = {
    loadImpl: async () => document,
    runningImpl: () => running,
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      return true;
    },
    acknowledgeImpl: async (key, updateIds) => {
      document = removeQueueItems(document, key, updateIds).document;
    },
    settleUntil: new Map(),
    inFlight,
    pins: new Map(),
  };

  assert.equal(await drainReadyQueueHeads(options), 1);
  assert.deepEqual(delivered, [101]);

  await drainReadyQueueHeads(options);
  assert.deepEqual(
    delivered,
    [101],
    "idle before turn.started must keep the next head gated",
  );

  running = true;
  await drainReadyQueueHeads(options);
  assert.deepEqual(
    delivered,
    [101],
    "the accepted turn itself must keep the next head gated",
  );

  running = false;
  assert.equal(await drainReadyQueueHeads(options), 0);
  assert.deepEqual(delivered, [101, 102]);
});

void test("drain removes an orphaned running gate after the last queued turn becomes idle", async () => {
  const key = "1:";
  let document = enqueueItem(
    { version: 1, queues: {} },
    key,
    createQueueItem(privateUpdate(101, "queued"), 1),
  ).document;
  let running = false;
  const delivered: number[] = [];
  const inFlight = new Map<string, InFlightGate>();
  const options: DrainOptions = {
    loadImpl: async () => document,
    runningImpl: () => running,
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      running = true;
      return true;
    },
    acknowledgeImpl: async (chatKey, updateIds) => {
      document = removeQueueItems(document, chatKey, updateIds).document;
    },
    settleUntil: new Map(),
    inFlight,
    pins: new Map(),
  };

  assert.equal(await drainReadyQueueHeads(options), 0);
  assert.equal(inFlight.get(key)?.state, "running");

  await drainReadyQueueHeads(options);
  assert.equal(
    inFlight.get(key)?.state,
    "running",
    "the active turn must keep its gate",
  );
  assert.deepEqual(delivered, [101]);

  running = false;
  await drainReadyQueueHeads(options);
  assert.equal(inFlight.has(key), false);

  const fresh = privateUpdate(102, "fresh");
  const routed = await routeMessageUpdate(fresh, {
    chatKeyImpl: () => key,
    loadQueueImpl: async () => document,
    runningImpl: () => running,
    inFlight,
    queueCountImpl: queueCount,
    replyToBotImpl: () => false,
    shouldQueueImpl: () => true,
    enqueueImpl: async () => ({ count: 1 }),
    acknowledgeImpl: async () => {},
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      return true;
    },
  });

  assert.equal(routed, "delivered");
  assert.deepEqual(delivered, [101, 102]);
});

void test("a completed run-status generation releases a turn whose running state fell between polls", async () => {
  let document = enqueueItem(
    enqueueItem(
      { version: 1, queues: {} },
      "1:",
      createQueueItem(privateUpdate(101, "first"), 1),
    ).document,
    "1:",
    createQueueItem(privateUpdate(102, "/x"), 2),
  ).document;
  let currentStatus = { status: "idle", generation: 10 };
  const delivered: number[] = [];
  const options: DrainOptions = {
    loadImpl: async () => document,
    statusImpl: () => currentStatus,
    runningImpl: () => currentStatus.status === "running",
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      if (update.update_id === 101) {
        // turn.started and turn.completed both happened while acceptance was pending.
        currentStatus = { status: "idle", generation: 12 };
      }
      return true;
    },
    acknowledgeImpl: async (key, updateIds) => {
      document = removeQueueItems(document, key, updateIds).document;
    },
    settleUntil: new Map(),
    inFlight: new Map(),
    pins: new Map(),
  };

  assert.equal(await drainReadyQueueHeads(options), 1);
  assert.equal(await drainReadyQueueHeads(options), 0);
  assert.deepEqual(delivered, [101, 102]);
});

void test("an accepted turn with no observable status transition releases only after the stale bound", async () => {
  let document = enqueueItem(
    enqueueItem(
      { version: 1, queues: {} },
      "1:",
      createQueueItem(privateUpdate(101, "first"), 1),
    ).document,
    "1:",
    createQueueItem(privateUpdate(102, "/x"), 2),
  ).document;
  let nowMs = 1_000;
  const delivered: number[] = [];
  const options: DrainOptions = {
    loadImpl: async () => document,
    statusImpl: () => ({ status: "idle", generation: 5 }),
    runningImpl: () => false,
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      return true;
    },
    acknowledgeImpl: async (key, updateIds) => {
      document = removeQueueItems(document, key, updateIds).document;
    },
    now: () => nowMs,
    settleUntil: new Map(),
    inFlight: new Map(),
    pins: new Map(),
    gateWaitMs: 100,
  };

  await drainReadyQueueHeads(options);
  nowMs += 99;
  await drainReadyQueueHeads(options);
  assert.deepEqual(delivered, [101]);

  nowMs += 1;
  await drainReadyQueueHeads(options);
  assert.deepEqual(delivered, [101, 102]);
});

void test("a drain pass has one global delivery budget and rotates a stalled first key", async () => {
  let nowMs = 0;
  const attempts: [number, number][] = [];
  const rotationState = { afterKey: null };
  const document = {
    version: 1,
    queues: Object.fromEntries(
      [1, 2, 3].map((chatId) => {
        const update = privateUpdate(chatId, `head ${chatId}`);
        update.message.chat.id = chatId;
        return [`${chatId}:`, [createQueueItem(update, chatId)]];
      }),
    ),
  };
  const options: DrainOptions = {
    loadImpl: async () => document,
    runningImpl: () => false,
    deliverImpl: async (update, { timeoutMs }) => {
      attempts.push([update.message!.chat!.id, timeoutMs]);
      nowMs += timeoutMs;
      return false;
    },
    acknowledgeImpl: async () =>
      assert.fail("a stalled head must remain durable"),
    now: () => nowMs,
    settleUntil: new Map(),
    inFlight: new Map(),
    pins: new Map(),
    rotationState,
    passBudgetMs: 5_000,
    deliveryTimeoutMs: 5_000,
  };

  await drainReadyQueueHeads(options);
  assert.deepEqual(attempts, [[1, 5_000]]);

  await drainReadyQueueHeads(options);
  assert.deepEqual(
    attempts,
    [
      [1, 5_000],
      [2, 5_000],
    ],
    "the next pass must give the next chat the global timeout budget",
  );

  await drainReadyQueueHeads(options);
  assert.deepEqual(attempts, [
    [1, 5_000],
    [2, 5_000],
    [3, 5_000],
  ]);
});

void test("a missing terminal event becomes drainable after the run-status TTL", async () => {
  const key = "9:";
  status.setChatStatus(key, {
    status: "running",
    sessionId: "orphaned-session",
    turnId: "orphaned-turn",
  });
  const staleAt =
    (status.getChatStatus(key) as { updatedAt: number }).updatedAt +
    status.RUN_STALE_MS +
    1;
  let document = enqueueItem(
    { version: 1, queues: {} },
    key,
    createQueueItem(privateUpdate(301, "recover after stale status"), 1),
  ).document;
  const delivered: number[] = [];

  const remaining = await drainReadyQueueHeads({
    loadImpl: async () => document,
    runningImpl: (chatKey) => status.isRunning(chatKey, staleAt),
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      return true;
    },
    acknowledgeImpl: async (chatKey, updateIds) => {
      document = removeQueueItems(document, chatKey, updateIds).document;
    },
    settleUntil: new Map(),
    inFlight: new Map(),
    pins: new Map(),
  });

  assert.deepEqual(delivered, [301]);
  assert.equal(remaining, 0);
});

void test("legacy string arrays preserve private owner text but never invent a group author", async (t) => {
  const file = await queueFile(t);
  await writeFile(
    file,
    JSON.stringify({
      "42:": ["first", "second"],
      "-100:7": ["topic follow-up"],
    }),
  );

  const document = await migrateQueueFile(file);
  assert.equal(document.version, 1);
  assert.equal(queueCount(document), 2);
  assert.deepEqual(
    document.queues["42:"].map((item) => item.legacyText),
    ["first", "second"],
  );
  const privateReplay = materializeQueueItem("42:", document.queues["42:"][0], {
    legacyAllowedUserIds: new Set(["42"]),
  });
  assert.equal(privateReplay!.message!.text, "first");
  assert.equal(privateReplay!.message!.chat!.id, 42);
  assert.equal(privateReplay!.message!.from!.id, 42);
  const legacyGroupItem = normalizeQueueDocument({
    "-100:7": ["topic follow-up"],
  }).document.queues["-100:7"][0];
  assert.equal(
    materializeQueueItem("-100:7", legacyGroupItem, {
      legacyAllowedUserIds: new Set(["42"]),
    }),
    null,
  );

  const persisted = JSON.parse(
    await readFile(file, "utf8"),
  ) as unknown as TelegramQueueDocument;
  assert.equal(persisted.version, 1);
  assert.equal(queueCount(persisted), 2);
  const [quarantineName] = (await readdir(dirname(file))).filter((name) =>
    name.includes(".legacy-unattributed-"),
  );
  const quarantined = JSON.parse(
    await readFile(join(dirname(file), quarantineName), "utf8"),
  ) as unknown as TelegramQueueDocument;
  assert.equal(queueCount(quarantined), 1);
  assert.equal(quarantined.queues["-100:7"][0].legacyText, "topic follow-up");
});

void test("legacy group quarantine failure leaves the original queue active for retry", async (t) => {
  const file = await queueFile(t);
  const original = JSON.stringify({
    "42:": ["private follow-up"],
    "-100:": ["group text with unknown author"],
  });
  await writeFile(file, original);

  await assert.rejects(
    migrateQueueFile(file, {
      linkImpl: async (source, target) => {
        if (target.includes(".legacy-unattributed-")) {
          throw new Error("quarantine link failed");
        }
        await link(source, target);
      },
    }),
    /quarantine link failed/,
  );

  assert.equal(await readFile(file, "utf8"), original);
  assert.deepEqual(
    (await readdir(dirname(file))).filter((name) =>
      name.includes(".legacy-unattributed-"),
    ),
    [],
  );
});

void test("failed active migration keeps both the old queue and its group quarantine", async (t) => {
  const file = await queueFile(t);
  const original = JSON.stringify({
    "42:": ["private follow-up"],
    "-100:": ["group text with unknown author"],
  });
  await writeFile(file, original);

  await assert.rejects(
    migrateQueueFile(file, {
      renameImpl: async (source, target) => {
        if (target === file) throw new Error("active rename failed");
        await rename(source, target);
      },
    }),
    /active rename failed/,
  );

  assert.equal(await readFile(file, "utf8"), original);
  const [quarantineName] = (await readdir(dirname(file))).filter((name) =>
    name.includes(".legacy-unattributed-"),
  );
  const quarantined = JSON.parse(
    await readFile(join(dirname(file), quarantineName), "utf8"),
  ) as unknown as TelegramQueueDocument;
  assert.equal(
    quarantined.queues["-100:"][0].legacyText,
    "group text with unknown author",
  );
});

void test("separate legacy migrations never overwrite an earlier group quarantine", async (t) => {
  const file = await queueFile(t);
  const first = JSON.stringify({ "-100:": ["first byte set"] });
  const second = JSON.stringify({ "-100:": ["second byte set"] });
  const logged: string[] = [];
  const options = {
    quarantineNow: () => 123,
    quarantineNonce: () => "same",
    onLegacyQuarantine: (path: string) => logged.push(path),
  };

  await writeFile(file, first);
  await migrateQueueFile(file, options);
  await writeFile(file, second);
  await migrateQueueFile(file, options);

  assert.equal(logged.length, 2);
  assert.notEqual(logged[0], logged[1]);
  assert.match(logged[0], /\.legacy-unattributed-/);
  assert.match(logged[1], /\.legacy-unattributed-/);
  const preserved = await Promise.all(
    logged.map(
      async (path) =>
        JSON.parse(
          await readFile(path, "utf8"),
        ) as unknown as TelegramQueueDocument,
    ),
  );
  assert.deepEqual(
    preserved.map((document) => document.queues["-100:"][0].legacyText),
    ["first byte set", "second byte set"],
  );
});

void test("drain preserves legacy group text with unknown author in quarantine before ack", async (t) => {
  const file = await queueFile(t);
  let document = normalizeQueueDocument({
    "-100:": ["unaddressed group text"],
  }).document;
  const delivered: TelegramQueueUpdate[] = [];
  const acknowledged: [string, readonly number[]][] = [];

  const remaining = await drainReadyQueueHeads({
    loadImpl: async () => document,
    runningImpl: () => false,
    legacyAllowedUserIds: new Set(["42"]),
    deliverImpl: async (update) => {
      delivered.push(update);
      return true;
    },
    acknowledgeImpl: async (chatKey, updateIds) => {
      acknowledged.push([chatKey, updateIds]);
      document = removeQueueItems(document, chatKey, updateIds).document;
    },
    quarantineImpl: (records) =>
      quarantineQueueRecords(file, records, { logImpl: () => {} }),
    settleUntil: new Map(),
    inFlight: new Map(),
    pins: new Map(),
  });

  assert.deepEqual(delivered, []);
  assert.equal(acknowledged.length, 1);
  assert.equal(remaining, 0);
  assert.equal(queueHead(document, "-100:"), null);
  const [copy] = (await readdir(dirname(file))).filter((name) =>
    name.includes(".damaged-"),
  );
  assert.equal(
    (
      JSON.parse(await readFile(join(dirname(file), copy), "utf8")) as {
        record: { legacyText: string };
      }
    ).record.legacyText,
    "unaddressed group text",
  );
});

void test("queued media and quoted metadata replay from the durable update without transformation", async (t) => {
  const file = await queueFile(t);
  const update = {
    update_id: 201,
    message: {
      message_id: 9,
      date: 1,
      chat: { id: 1, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Owner" },
      caption: "look at this",
      photo: [{ file_id: "small" }, { file_id: "large" }],
      reply_to_message: {
        message_id: 8,
        from: { id: 7, is_bot: false, first_name: "Quoted" },
        text: "quoted source",
      },
    },
  };
  await enqueueQueueFile(file, "1:", update);
  const { document } = await loadQueueFile(file, { strict: true });

  assert.deepEqual(
    materializeQueueItem("1:", queueHead(document, "1:")!),
    update,
  );
});

void test("busy routing is fail-closed and keeps addressed private, group and topic updates", () => {
  const allowedUserIds = new Set(["42"]);
  const options = { allowedUserIds, botUsername: "my_bot" };
  const group = (
    text: string,
    threadId?: number,
    userId = 42,
  ): TelegramQueueUpdate => ({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: -100, type: "supergroup" },
      from: { id: userId, is_bot: false },
      text,
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
    },
  });

  assert.equal(
    shouldQueueBusyUpdate(privateUpdate(1, "private"), options),
    true,
  );
  assert.equal(
    shouldQueueBusyUpdate(
      {
        ...privateUpdate(1, "untrusted"),
        message: { ...privateUpdate(1, "untrusted").message, from: { id: 7 } },
      },
      options,
    ),
    false,
  );
  assert.equal(shouldQueueBusyUpdate(group("group noise"), options), false);
  assert.equal(
    shouldQueueBusyUpdate(group("@my_bot addressed"), options),
    true,
  );
  assert.equal(shouldQueueBusyUpdate(group("/task topic", 7), options), true);
  assert.equal(
    shouldQueueBusyUpdate(group("@my_bot untrusted", 7, 7), options),
    false,
  );
  assert.equal(
    shouldQueueBusyUpdate(group("x@my_botany.example"), options),
    false,
  );
  assert.equal(shouldQueueBusyUpdate(group("@my_bot_suffix"), options), false);
});

void test("busy group routing sees mentions and commands in collected iva_parts", () => {
  const options = { allowedUserIds: new Set(["42"]), botUsername: "my_bot" };
  const collected = (
    text: string,
  ): TelegramQueueUpdate & { message: { iva_parts: unknown[] } } => ({
    update_id: 2,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: -100, type: "supergroup" },
      from: { id: 42, is_bot: false },
      photo: [{ file_id: "photo" }],
      iva_parts: [
        {
          message_id: 1,
          date: 1,
          chat: { id: -100, type: "supergroup" },
          from: { id: 42, is_bot: false },
          photo: [{ file_id: "photo" }],
        },
        {
          message_id: 2,
          date: 1,
          chat: { id: -100, type: "supergroup" },
          from: { id: 42, is_bot: false },
          text,
        },
      ],
    },
  });

  assert.equal(
    shouldQueueBusyUpdate(collected("@my_bot see album"), options),
    true,
  );
  assert.equal(
    shouldQueueBusyUpdate(collected("/task save album"), options),
    true,
  );
  assert.equal(
    shouldQueueBusyUpdate(collected("unaddressed caption"), options),
    false,
  );
  const malformed = collected("unaddressed caption");
  malformed.message.iva_parts.splice(1, 0, null, "broken");
  assert.doesNotThrow(() => shouldQueueBusyUpdate(malformed, options));
  assert.equal(shouldQueueBusyUpdate(malformed, options), false);
});

void test("group routing validates exact Telegram entities across Unicode and malformed input", () => {
  const options = { allowedUserIds: new Set(["42"]), botUsername: "my_bot" };
  const group = (text: string, entities: unknown): TelegramQueueUpdate => ({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: -100, type: "supergroup" },
      from: { id: 42, is_bot: false },
      text,
      entities,
    },
  });

  const unicodeText = "🙂 ask @my_bot now";
  assert.equal(
    shouldQueueBusyUpdate(
      group(unicodeText, [
        {
          type: "mention",
          offset: unicodeText.indexOf("@my_bot"),
          length: "@my_bot".length,
        },
      ]),
      options,
    ),
    true,
  );
  assert.equal(
    shouldQueueBusyUpdate(group("İ @MY_BOT", undefined), options),
    true,
  );
  assert.equal(
    shouldQueueBusyUpdate(
      group("Ж@my_bot", [{ type: "mention", offset: 1, length: 7 }]),
      options,
    ),
    false,
  );
  assert.equal(
    shouldQueueBusyUpdate(
      group("@my_bot_suffix", [{ type: "mention", offset: 0, length: 7 }]),
      options,
    ),
    false,
  );
  assert.equal(
    shouldQueueBusyUpdate(
      group("@my_bot", [{ type: "mention", offset: -1, length: 999 }]),
      options,
    ),
    false,
  );
  assert.equal(
    shouldQueueBusyUpdate(
      group("/task@my_bot", [
        {
          type: "bot_command",
          offset: 0,
          length: "/task@my_bot".length,
        },
      ]),
      options,
    ),
    true,
  );
  assert.equal(
    shouldQueueBusyUpdate(
      group("/task@my_bot_suffix", [
        {
          type: "bot_command",
          offset: 0,
          length: "/task@my_bot".length,
        },
      ]),
      options,
    ),
    false,
  );
  assert.doesNotThrow(() =>
    shouldQueueBusyUpdate(group("@my_bot", { offset: 0, length: 7 }), options),
  );
  assert.equal(
    shouldQueueBusyUpdate(group("@my_bot", { offset: 0, length: 7 }), options),
    false,
  );
});

void test("group command routing ignores null Telegram entities", () => {
  const update: TelegramQueueUpdate = {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: -100, type: "supergroup" },
      from: { id: 42, is_bot: false },
      text: "/task@my_bot",
      entities: [
        null,
        {
          type: "bot_command",
          offset: 0,
          length: "/task@my_bot".length,
        },
      ],
    },
  };
  const options = {
    allowedUserIds: new Set(["42"]),
    botUsername: "my_bot",
  };
  const message = update.message;
  assert.ok(message);
  const nullOnly = {
    ...update,
    message: { ...message, entities: [null] },
  };

  assert.doesNotThrow(() => shouldQueueBusyUpdate(nullOnly, options));
  assert.equal(shouldQueueBusyUpdate(nullOnly, options), false);
  assert.equal(shouldQueueBusyUpdate(update, options), true);
});

// --- конверт против содержимого ---------------------------------------------
//
// Мост судит конверт: содержимое — любой собственный ключ вне
// TELEGRAM_MESSAGE_ENVELOPE_KEYS. Списка видов содержимого у моста нет, поэтому поле,
// которого Bot API ещё не придумал, доезжает до агента само.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт. Seed каждого прогона стоит в имени теста.
const ENVELOPE_SEEDS = [1, 424242, 20260826];

const BUSY_OPTIONS = {
  allowedUserIds: new Set(["42"]),
  botUsername: "my_bot",
};

// Апдейт Bot API 10.1 с боевого VPS: текстовой проекции нет вовсе, статья целиком
// лежит в rich_message. До правки мост считал такое сообщение пустым и дропал его.
const RICH_MESSAGE = {
  blocks: [
    { type: "paragraph", text: "Долгий текст, который не влез в 4096 знаков." },
    {
      type: "list",
      items: [
        {
          label: "1.",
          blocks: [
            { type: "paragraph", text: { type: "bold", text: "Первый пункт" } },
          ],
        },
      ],
    },
  ],
};

function richOnlyUpdate(
  chat: TelegramChatShape = { id: 42, type: "private" },
  extra: Record<string, unknown> = {},
): TelegramQueueUpdate {
  return {
    update_id: 924_151_861,
    message: {
      message_id: 3401,
      from: { id: 42, is_bot: false },
      chat,
      date: 1_780_000_000,
      rich_message: RICH_MESSAGE,
      ...extra,
    },
  };
}

type TelegramChatShape = { id: number; type: string };

void test("REGRESSION: rich_message from an allowed private sender is admitted", () => {
  assert.equal(shouldQueueBusyUpdate(richOnlyUpdate(), BUSY_OPTIONS), true);
});

void test("forum topic metadata enters the queue only with user content", () => {
  const { message_id, date, chat, from } = privateUpdate(1, "").message;
  const message = {
    message_id,
    date,
    chat,
    from,
    forum_topic_created: { name: "Тема", icon_color: 1 },
  };
  assert.equal(
    shouldQueueBusyUpdate({ update_id: 1, message }, BUSY_OPTIONS),
    false,
  );
  assert.equal(
    shouldQueueBusyUpdate(
      { update_id: 2, message: { ...message, some_future_field: {} } },
      BUSY_OPTIONS,
    ),
    true,
  );
  assert.equal(
    shouldQueueBusyUpdate(
      { update_id: 3, message: { ...message, text: "Привет" } },
      BUSY_OPTIONS,
    ),
    true,
  );
});

void test("a message of envelope keys alone carries nothing, whitespace text included", () => {
  assert.equal(
    shouldQueueBusyUpdate(
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 42, type: "private" },
          from: { id: 42, is_bot: false },
        },
      },
      BUSY_OPTIONS,
    ),
    false,
  );
  assert.equal(
    shouldQueueBusyUpdate(
      {
        update_id: 2,
        message: {
          message_id: 2,
          date: 1,
          chat: { id: 42, type: "private" },
          from: { id: 42, is_bot: false },
          text: "   ",
        },
      },
      BUSY_OPTIONS,
    ),
    false,
  );
});

// Конверт минус структурные ключи: iva_parts задаёт форму пачки и проверяется
// отдельным тестом, остальное годится как случайный шум конверта.
const ENVELOPE_NOISE_KEYS = [...TELEGRAM_MESSAGE_ENVELOPE_KEYS].filter(
  (key) => key !== "iva_parts" && key !== "from" && key !== "chat",
);

const LETTERS = "abcdefghijklmnopqrstuvwxyz_".split("");

const contentKeyName = fc
  .array(fc.constantFrom(...LETTERS), { minLength: 1, maxLength: 14 })
  .map((letters) => letters.join(""))
  .filter(
    (key) =>
      !TELEGRAM_MESSAGE_ENVELOPE_KEYS.has(key) &&
      !TELEGRAM_MESSAGE_TEXT_KEYS.has(key),
  );

// Любое JSON-значение, юникод-мусор и пустая строка — всё это содержимое.
// Не считается только undefined: такого ключа в сообщении фактически нет.
const contentValue = fc.oneof(
  fc.jsonValue(),
  fc.string({ unit: "binary" }),
  fc.constant(""),
  fc.constant(null),
);

const envelopeNoise = fc
  .uniqueArray(fc.constantFrom(...ENVELOPE_NOISE_KEYS), { maxLength: 8 })
  .chain((keys) =>
    fc
      .tuple(
        ...keys.map(() => fc.oneof(fc.jsonValue(), fc.constant(undefined))),
      )
      .map((values) =>
        Object.fromEntries(keys.map((key, i) => [key, values[i]])),
      ),
  );

function privateEnvelope(
  noise: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): TelegramQueueUpdate {
  return {
    update_id: 7,
    message: {
      ...noise,
      message_id: 7,
      date: 1,
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false },
      ...extra,
    },
  };
}

for (const seed of ENVELOPE_SEEDS) {
  void test(`PROPERTY: envelope keys alone never look like content (seed=${seed})`, () => {
    fc.assert(
      fc.property(envelopeNoise, (noise) => {
        assert.equal(
          shouldQueueBusyUpdate(privateEnvelope(noise), BUSY_OPTIONS),
          false,
          `payload=${JSON.stringify(noise)}`,
        );
      }),
      { seed, numRuns: 500 },
    );
  });

  void test(`PROPERTY: one key outside the envelope is content (seed=${seed})`, () => {
    fc.assert(
      fc.property(
        envelopeNoise,
        contentKeyName,
        contentValue,
        (noise, key, value) => {
          assert.equal(
            shouldQueueBusyUpdate(
              privateEnvelope(noise, { [key]: value }),
              BUSY_OPTIONS,
            ),
            true,
            `key=${key} value=${JSON.stringify(value)}`,
          );
        },
      ),
      { seed, numRuns: 500 },
    );
  });

  void test(`PROPERTY: malformed updates never throw (seed=${seed})`, () => {
    fc.assert(
      fc.property(fc.anything(), (candidate) => {
        assert.doesNotThrow(() =>
          shouldQueueBusyUpdate(candidate as TelegramQueueUpdate, BUSY_OPTIONS),
        );
      }),
      { seed, numRuns: 500 },
    );
  });
}

void test("in a group, content without text is admitted only when it answers the bot", () => {
  const chat = { id: -100, type: "supergroup" };
  assert.equal(
    shouldQueueBusyUpdate(richOnlyUpdate(chat), BUSY_OPTIONS),
    false,
  );
  assert.equal(
    shouldQueueBusyUpdate(
      richOnlyUpdate(chat, {
        reply_to_message: { message_id: 1, from: { id: 9, is_bot: true } },
      }),
      BUSY_OPTIONS,
    ),
    true,
  );
  assert.equal(
    shouldQueueBusyUpdate(
      richOnlyUpdate(chat, {
        iva_parts: [
          {
            message_id: 3401,
            date: 1,
            chat,
            from: { id: 42, is_bot: false },
            rich_message: RICH_MESSAGE,
          },
          {
            message_id: 3402,
            date: 1,
            chat,
            from: { id: 42, is_bot: false },
            text: "@my_bot look at this",
          },
        ],
      }),
      BUSY_OPTIONS,
    ),
    true,
  );
});

void test("__proto__ is persisted as a queue data key without prototype mutation or loss", async (t) => {
  const file = await queueFile(t);
  await enqueueQueueFile(
    file,
    "__proto__",
    privateUpdate(401, "prototype-safe"),
  );

  const { document } = await loadQueueFile(file, { strict: true });
  assert.equal(Object.hasOwn(document.queues, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(document.queues), Object.prototype);
  assert.equal(queueCount(document, "__proto__"), 1);
  assert.equal(queueHead(document, "__proto__")!.updateId, 401);
  assert.deepEqual(queueKeys(document), ["__proto__"]);

  await acknowledgeQueueItems(file, "__proto__", [401]);
  const after = await loadQueueFile(file, { strict: true });
  assert.equal(Object.hasOwn(after.document.queues, "__proto__"), false);
  assert.equal(queueCount(after.document), 0);
});

// 16.10.2026: одна плохая запись очереди уносила весь файл в карантин (обычная загрузка)
// или роняла мост (строгая). Теперь в карантин уходит только она, остальные остаются.
void test("a damaged queue record is quarantined alone and the rest of the queue survives", async (t) => {
  const file = await queueFile(t);
  const good = createQueueItem(privateUpdate(11, "keep me"), 1);
  const damagedItem = {
    version: 1,
    updateId: "11b",
    update: { text: "secret text" },
  };
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      queues: { "1:": [damagedItem, good], "2:": "not a list" },
    }),
  );
  const logs: unknown[][] = [];
  for (const strict of [true, false, true]) {
    const loaded = await loadQueueFile(file, {
      strict,
      logImpl: (...parts) => logs.push(parts),
    });
    assert.deepEqual(loaded.document.queues, { "1:": [good] });
    assert.equal(loaded.quarantined, null);
  }

  const copies = (await readdir(dirname(file))).filter((name) =>
    name.startsWith("telegram-queue.json.damaged-"),
  );
  assert.equal(copies.length, 2);
  // Повторная загрузка той же записи не пишет журнал и копию заново.
  assert.equal(logs.length, 2);
  assert.equal(JSON.stringify(logs).includes("secret text"), false);
  const records = await Promise.all(
    copies.map(
      async (name) =>
        JSON.parse(await readFile(join(dirname(file), name), "utf8")) as {
          record: unknown;
        },
    ),
  );
  assert.deepEqual(
    records
      .map(({ record }) => record)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [damagedItem, "not a list"].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
  );

  // Следующая запись файла убирает плохую запись из самого файла.
  await enqueueQueueFile(file, "1:", privateUpdate(12, "next"), {
    strict: true,
  });
  const after = JSON.parse(
    await readFile(file, "utf8"),
  ) as TelegramQueueDocument;
  assert.deepEqual(Object.keys(after.queues), ["1:"]);
  assert.deepEqual(
    after.queues["1:"].map((item) => item.updateId),
    [11, 12],
  );
});

void test("quarantine copies of the same record are written once", async (t) => {
  const file = await queueFile(t);
  const record = { chatKey: "1:", index: 0, reason: "bad", record: { a: 1 } };
  const logs: unknown[][] = [];
  const first = await quarantineQueueRecords(file, [record], {
    logImpl: (...parts) => logs.push(parts),
  });
  const second = await quarantineQueueRecords(file, [record], {
    logImpl: (...parts) => logs.push(parts),
  });
  assert.deepEqual(first, second);
  assert.equal(logs.length, 1);
});

void test("POISON malformed pending acknowledgement is preserved and main queue is loaded", async (t) => {
  const file = await queueFile(t);
  const good = createQueueItem(privateUpdate(11, "keep"), 1);
  const document = { version: 1, queues: { "1:": [good] } };
  const logs: string[] = [];
  for (const raw of [
    "{bad",
    "null",
    JSON.stringify({ version: 1, queues: null }),
  ]) {
    await writeFile(file, JSON.stringify(document));
    await writeFile(`${file}.ack-pending`, raw);
    await assert.rejects(loadQueueFile(file, { strict: true }));
    assert.equal(await readFile(`${file}.ack-pending`, "utf8"), raw);
    const before = (await readdir(dirname(file))).filter((name) =>
      name.includes(".ack-pending.corrupt-"),
    ).length;
    for (let i = 0; i < 2; i++)
      assert.deepEqual(
        (
          await loadQueueFile(file, {
            logImpl: (...parts) => logs.push(parts.map(String).join(" ")),
          })
        ).document,
        document,
      );
    const copies = (await readdir(dirname(file))).filter((name) =>
      name.includes(".ack-pending.corrupt-"),
    );
    assert.equal(copies.length, before + 1);
    assert.ok(
      (
        await Promise.all(
          copies.map((name) => readFile(join(dirname(file), name), "utf8")),
        )
      ).includes(raw),
    );
  }
  assert.equal(logs.length, 3);
});

void test("POISON an unreplayable queue head is quarantined before ack and next head runs", async (t) => {
  const file = await queueFile(t);
  let document = normalizeQueueDocument({
    "-100:": ["private legacy"],
  }).document;
  const bad = document.queues["-100:"][0];
  document = enqueueItem(
    document,
    "-100:",
    createQueueItem(
      {
        ...privateUpdate(12, "next"),
        message: {
          ...privateUpdate(12, "next").message,
          chat: { id: -100, type: "group" },
        },
      },
      2,
    ),
  ).document;
  const events: string[] = [];
  const logs: unknown[][] = [];
  const options = {
    loadImpl: async () => document,
    runningImpl: () => false,
    statusImpl: () => null,
    deliverImpl: async () => {
      events.push("deliver");
      return "handled" as const;
    },
    acknowledgeImpl: async (key: string, ids: readonly number[]) => {
      events.push("ack");
      document = removeQueueItems(document, key, ids).document;
    },
    quarantineImpl: async (
      records: Parameters<typeof quarantineQueueRecords>[1],
    ) => {
      events.push("copy");
      return quarantineQueueRecords(file, records, {
        logImpl: (...parts) => logs.push(parts),
      });
    },
    settleUntil: new Map<string, number>(),
    inFlight: new Map<string, InFlightGate>(),
    pins: new Map(),
    resetPendingImpl: () => false,
  };
  // A failed copy keeps this head while another chat is delivered in the same pass.
  const failures: unknown[][] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => failures.push(parts));
  for (const code of ["EACCES", "ENOSPC"]) {
    document = enqueueItem(
      document,
      "1:",
      createQueueItem(privateUpdate(13, "other chat"), 3),
    ).document;
    assert.equal(
      await drainReadyQueueHeads({
        ...options,
        quarantineImpl: async () => {
          throw Object.assign(new Error("private copy failure"), { code });
        },
      }),
      2,
    );
    assert.deepEqual(events, ["deliver", "ack"]);
    assert.equal(queueCount(document), 2);
    assert.deepEqual(queueHead(document, "-100:"), bad);
    const line = JSON.stringify(failures.at(-1));
    assert.match(line, new RegExp(code));
    assert.ok(!line.includes("private"));
    events.length = 0;
  }
  assert.equal(failures.length, 2);
  await assert.rejects(
    drainReadyQueueHeads({
      ...options,
      acknowledgeImpl: async () => {
        events.push("ack-failed");
        throw new Error("ack failed");
      },
    }),
    /ack failed/,
  );
  assert.equal(queueCount(document), 2);
  assert.equal(await drainReadyQueueHeads(options), 1);
  assert.deepEqual(events, ["copy", "ack-failed", "copy", "ack"]);
  assert.equal(await drainReadyQueueHeads(options), 0);
  assert.deepEqual(events, [
    "copy",
    "ack-failed",
    "copy",
    "ack",
    "deliver",
    "ack",
  ]);
  assert.equal(logs.length, 1);
  const copies = (await readdir(dirname(file))).filter((name) =>
    name.includes(".damaged-"),
  );
  assert.equal(copies.length, 1);
  assert.deepEqual(
    (
      JSON.parse(await readFile(join(dirname(file), copies[0]), "utf8")) as {
        record: unknown;
      }
    ).record,
    bad,
  );
});
