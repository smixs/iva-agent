/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns top-level registrations; injected test doubles preserve the asynchronous runtime contracts. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { parseOffsetFile } from "./lib/offset-store.ts";
import {
  normalizeQueueDocument,
  createQueueItem,
  loadQueueFile,
  materializeQueueItem,
  writeQueueFileAtomic,
  type TelegramQueueDocument,
  type TelegramQueueUpdate,
} from "./lib/telegram-queue.ts";

type HarnessMessage = {
  message_id: number;
  text?: string;
  message_thread_id?: number;
  chat: { id: number };
  iva_parts?: Array<{ message_id: number; text?: string }>;
  iva_durable_queue_receipt?: unknown;
};
type HarnessUpdate = TelegramQueueUpdate & {
  message?: HarnessMessage;
  callback_query?: { id: string };
};
type HarnessResult = {
  offset: { offset: number; delivered?: number | null };
  deliveries: HarnessUpdate[];
  deliveryRoutes: string[];
  reactions: unknown[];
  queueStatuses: Array<{ text?: string }>;
  queue: TelegramQueueDocument;
  inbox: TelegramQueueDocument;
  requestedOffsets: number[];
  queueDirSyncAttempts: number;
  queueDirSyncSuccesses: number;
  statusBeforeRetry: { status: string; ingressId?: unknown };
  queueBeforeIdle: TelegramQueueDocument | null;
  deletedMessages: Array<{ chat_id: string; message_id: number }>;
  failureNotices: Array<{ chat_id: string; text: string }>;
  finalStatus: { status: string; ingressId?: unknown };
};
type HarnessOptions = {
  collectQuietMs?: string;
  directAcceptanceTimeoutMs?: string;
};
type ResetRequest = {
  chatKey: string;
  target: { sessionId: string } | { address: { chatId: string } };
};
type RoutingCall =
  | ["enqueue", string, TelegramQueueUpdate]
  | ["acknowledge", TelegramQueueUpdate, number]
  | ["deliver"];
type FetchCall = { url: string; init: RequestInit | undefined };

const ROOT = resolve(import.meta.dirname, "..");
const HARNESS = join(ROOT, "scripts/fixtures/telegram-poll-queue-harness.ts");
const [queueRuntime, routingRuntime, deliverRuntime] = await Promise.all([
  import("./poller/queue.ts"),
  import("./poller/routing.ts"),
  import("./poller/deliver.ts"),
]);

function makeDataDir(t: TestContext, label: string) {
  const path = mkdtempSync(join(tmpdir(), `iva-008-${label}-`));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

function runHarness(
  mode: string,
  dataDir: string,
  fault = "none",
  { collectQuietMs = "0", directAcceptanceTimeoutMs }: HarnessOptions = {},
): HarnessResult {
  const result = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", HARNESS, mode, dataDir, fault],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        TELEGRAM_COLLECT_QUIET_MS: collectQuietMs,
        ...(directAcceptanceTimeoutMs === undefined
          ? {}
          : {
              TELEGRAM_DIRECT_ACCEPTANCE_TIMEOUT_MS: directAcceptanceTimeoutMs,
            }),
      },
      encoding: "utf8",
      // Предел убивает зависший процесс, а не меряет скорость: под полным npm test (4 потока)
      // обычный прогон сценария доходил до 10 с, и его снимало сигналом без вывода.
      timeout: 30_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `harness failed (${mode}/${fault})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return JSON.parse(
    readFileSync(join(dataDir, "queue-harness-result.json"), "utf8"),
  ) as HarnessResult;
}

function ownedUpdates(result: Pick<HarnessResult, "inbox" | "queue">) {
  return [
    ...Object.values(result.inbox.queues)
      .flat()
      .map((item) => ({
        location: "inbox" as const,
        updateId: item.updateId,
      })),
    ...Object.values(result.queue.queues)
      .flat()
      .map((item) => ({
        location: "delivery" as const,
        updateId: item.updateId,
      })),
  ];
}

async function waitForFile(
  file: string,
  child: ChildProcess,
  stderr: () => string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      assert.fail(
        `child exited before ${file} (code ${String(child.exitCode)}, signal ${String(child.signalCode)})\nstderr:\n${stderr()}`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert.fail(
    `timed out after ${timeoutMs} ms waiting for ${file}\nstderr:\n${stderr()}`,
  );
}

test("waitForFile reports a child that died before its ready file", async (t: TestContext) => {
  const dataDir = makeDataDir(t, "wait-dead-child");
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.stderr.write('harness died before ready\\n'); process.exit(3)",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await assert.rejects(
    waitForFile(join(dataDir, "never-ready"), child, () => stderr),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exited before/u);
      assert.match(error.message, /harness died before ready/u);
      return true;
    },
  );
});

test("direct queue runtime forwards an immutable session target", async () => {
  const requests: ResetRequest[] = [];
  const result = await queueRuntime.releaseScopedSession(
    "1:",
    { sessionId: "session-1" },
    {
      requestResetImpl: async (request) => {
        requests.push(request);
        return { ok: true, status: "reset" };
      },
      logImpl: () => {},
    },
  );

  assert.deepEqual(result, { ok: true, status: "reset" });
  assert.deepEqual(requests, [
    { chatKey: "1:", target: { sessionId: "session-1" } },
  ]);
});

test("direct routing runtime durably queues a busy private update", async () => {
  const update = {
    update_id: 501,
    message: {
      message_id: 501,
      chat: { id: 1, type: "private" },
      from: { id: 42, is_bot: false },
      text: "follow-up",
    },
  };
  const calls: RoutingCall[] = [];
  const result = await routingRuntime.routeMessageUpdate(update, {
    chatKeyImpl: () => "1:",
    loadQueueImpl: async () => ({ version: 1, queues: {} }),
    runningImpl: () => true,
    inFlight: new Map(),
    queueCountImpl: () => 0,
    replyToBotImpl: () => false,
    shouldQueueImpl: () => true,
    enqueueImpl: async (key, candidate) => {
      calls.push(["enqueue", key, candidate]);
      return { count: 1 };
    },
    acknowledgeImpl: async (candidate, count) => {
      calls.push(["acknowledge", candidate, count]);
    },
    traceQueuedImpl: () => {},
    deliverImpl: async () => {
      calls.push(["deliver"]);
      return true;
    },
    logImpl: () => {},
  });

  assert.equal(result, "queued");
  assert.deepEqual(calls, [
    ["enqueue", "1:", update],
    ["acknowledge", update, 1],
  ]);
});

test("direct delivery runtime requires the accepted-route receipt", async (t: TestContext) => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  let includeAcceptanceReceipt = true;
  globalThis.fetch = async (url, init) => {
    const requestUrl =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: requestUrl, init });
    return new Response(null, {
      status: 204,
      headers: includeAcceptanceReceipt
        ? { "x-iva-telegram-acceptance": "turn" }
        : undefined,
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const update = {
    update_id: 601,
    message: {
      message_id: 601,
      chat: { id: 1, type: "private" },
      from: { id: 42, is_bot: false },
      text: "hello",
    },
  };

  const accepted = await deliverRuntime.deliver(update);

  assert.equal(accepted, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/eve\/v1\/telegram\/accepted$/);

  includeAcceptanceReceipt = false;
  const requestsBeforeMissingReceipt = calls.length;
  const retained = await deliverRuntime.deliver(update, { retry: false });

  assert.equal(retained, false);
  assert.equal(calls.length, requestsBeforeMissingReceipt + 1);
});

for (const fault of ["write", "rename"]) {
  test(`durable inbox ${fault} failure does not advance Telegram offset`, (t: TestContext) => {
    const dataDir = makeDataDir(t, `disk-${fault}`);
    const result = runHarness("disk-failure", dataDir, fault);

    assert.equal(
      result.offset.offset,
      100,
      "the same Telegram update must be retried until its FIFO item is durable",
    );
    assert.deepEqual(result.deliveries, []);
    assert.deepEqual(ownedUpdates(result), []);
  });
}

test("directory sync failure requires a durable duplicate retry before offset advances", (t: TestContext) => {
  const dataDir = makeDataDir(t, "dir-sync-retry");
  const result = runHarness("dir-sync-retry", dataDir, "dir-sync-once");

  assert.deepEqual(
    result.requestedOffsets,
    [100, 100, 102],
    "the update must be requested again before its offset is committed",
  );
  assert.equal(result.queueDirSyncAttempts, 2);
  assert.equal(
    result.queueDirSyncSuccesses,
    1,
    "the duplicate retry must repeat the atomic write through a successful parent-dir fsync",
  );
  assert.equal(result.offset.offset, 102);
  assert.equal(result.queue.queues["1:"].length, 1);
  assert.equal(result.queue.queues["1:"][0].updateId, 101);
  assert.deepEqual(result.inbox, { version: 1, queues: {} });
});

test("queued follow-ups reach Iva as one delivery in FIFO order when the current turn becomes idle", (t: TestContext) => {
  const dataDir = makeDataDir(t, "auto-drain");
  const result = runHarness("auto-drain", dataDir);

  assert.deepEqual(
    result.queueBeforeIdle?.queues["1:"]?.map((item) => item.updateId),
    [101, 102, 103],
    "the queue holds three items until the chat is free: the drain merges, not the input collector",
  );
  assert.equal(result.deliveries.length, 1);
  const [delivery] = result.deliveries;
  assert.equal(delivery?.update_id, 103, "the batch speaks with its last id");
  assert.equal(delivery?.message?.message_id, 101);
  assert.deepEqual(
    delivery?.message?.iva_parts?.map((part) => [part.message_id, part.text]),
    [
      [101, "first"],
      [102, "second"],
      [103, "third"],
    ],
  );
  assert.deepEqual(result.deliveryRoutes, ["/eve/v1/telegram/accepted"]);
  assert.deepEqual(
    result.queue,
    { version: 1, queues: {} },
    "accepted FIFO items must be removed only after Eve accepts them",
  );
  assert.deepEqual(
    result.queueStatuses.map((status) => status.text),
    [
      "Queued (1). I'll start it automatically when the current task finishes.",
      "Queued (2). I'll start it automatically when the current task finishes.",
      "Queued (3). I'll start it automatically when the current task finishes.",
    ],
  );
});

test("collector merges a two-text burst into one durable queue item and delivery", (t: TestContext) => {
  const dataDir = makeDataDir(t, "collect-burst");
  const result = runHarness("collect-burst", dataDir, "none", {
    collectQuietMs: "75",
  });

  assert.equal(result.deliveries.length, 1);
  const delivery = result.deliveries[0];
  assert.ok(delivery);
  assert.equal(delivery.update_id, 102);
  assert.ok(delivery.message);
  assert.ok(delivery.message.iva_parts);
  assert.deepEqual(
    delivery.message.iva_parts.map((part) => [part.message_id, part.text]),
    [
      [101, "first"],
      [102, "second"],
    ],
  );
  assert.deepEqual(result.deliveryRoutes, ["/eve/v1/telegram/accepted"]);
  assert.equal(result.reactions.length, 1);
  assert.deepEqual(
    result.queueStatuses.map((status) => status.text),
    ["Queued (1). I'll start it automatically when the current task finishes."],
  );
  assert.deepEqual(result.queue, { version: 1, queues: {} });
});

test("SIGKILL after offset ownership preserves every burst part for restart", async (t: TestContext) => {
  const dataDir = makeDataDir(t, "burst-crash");
  const child = spawn(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      HARNESS,
      "burst-ownership-crash",
      dataDir,
      "none",
    ],
    {
      cwd: ROOT,
      env: { ...process.env, TELEGRAM_COLLECT_QUIET_MS: "60000" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });

  await waitForFile(join(dataDir, "ownership-ready"), child, () => stderr);
  const childExit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  child.kill("SIGKILL");
  const exit = await childExit;
  assert.deepEqual(exit, { code: null, signal: "SIGKILL" }, stderr);

  const crashed: Pick<HarnessResult, "offset" | "inbox" | "queue"> = {
    offset: parseOffsetFile(
      readFileSync(join(dataDir, "telegram-offset.json"), "utf8"),
    ),
    inbox: normalizeQueueDocument(
      parseJson(readFileSync(join(dataDir, "telegram-inbox.json"), "utf8")),
    ).document,
    queue: existsSync(join(dataDir, "telegram-queue.json"))
      ? normalizeQueueDocument(
          parseJson(readFileSync(join(dataDir, "telegram-queue.json"), "utf8")),
        ).document
      : { version: 1, queues: {} },
  };
  assert.deepEqual(crashed.offset, { offset: 103, delivered: null });
  assert.deepEqual(ownedUpdates(crashed), [
    { location: "inbox", updateId: 101 },
    { location: "inbox", updateId: 102 },
  ]);
  assert.equal(
    statSync(join(dataDir, "telegram-inbox.json")).mode & 0o777,
    0o600,
  );

  const restarted = runHarness("restart-drain", dataDir);
  assert.deepEqual(
    restarted.deliveries.map((update) => update.update_id),
    [101, 102],
  );
  assert.deepEqual(ownedUpdates(restarted), []);
});

test("a restarted bridge recovers and drains the persisted FIFO without a third user message", (t: TestContext) => {
  const dataDir = makeDataDir(t, "restart");
  const beforeRestart = runHarness("restart-persist", dataDir);
  assert.deepEqual(
    ownedUpdates(beforeRestart),
    [
      { location: "inbox", updateId: 102 },
      { location: "delivery", updateId: 101 },
    ],
    "the first process must leave exactly two busy-time follow-ups under durable ownership",
  );

  const afterRestart = runHarness("restart-drain", dataDir);
  // Остаток inbox встаёт за сохранённой очередью, и оба уходят одной доставкой.
  assert.deepEqual(
    afterRestart.deliveries.map((update) => [
      update.update_id,
      update.message?.iva_parts?.map((part) => part.text),
    ]),
    [[102, ["first", "second"]]],
  );
  assert.deepEqual(afterRestart.queue, { version: 1, queues: {} });
  assert.deepEqual(afterRestart.inbox, { version: 1, queues: {} });
});

test("a persistently failing queue head does not block other chats or Telegram polling", (t: TestContext) => {
  const dataDir = makeDataDir(t, "fair-drain");
  const result = runHarness("fair-drain", dataDir);

  assert.deepEqual(
    result.deliveries.map((update) => {
      assert.ok(update.message);
      return [update.message.chat.id, update.update_id];
    }),
    [
      [1, 101],
      [2, 102],
    ],
    "one failed acceptance attempt must yield to the next chat key",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(result.queue.queues).map(([key, items]) => [
        key,
        items.map((item) => item.updateId),
      ]),
    ),
    { "1:": [101] },
    "the poison head stays durable while an accepted head is acknowledged",
  );
  assert.deepEqual(
    result.requestedOffsets,
    [100],
    "the bridge must return to getUpdates after a bounded drain pass",
  );
});

test("unaddressed group noise is excluded from a busy conversation FIFO", (t: TestContext) => {
  const dataDir = makeDataDir(t, "group-noise");
  const result = runHarness("group-noise", dataDir);

  assert.equal(result.queue.queues?.["-100:"], undefined);
  assert.deepEqual(result.deliveries, []);
  assert.deepEqual(result.reactions, []);
  assert.equal(
    result.offset.offset,
    103,
    "ignored group noise is consumed exactly once",
  );
});

test("busy FIFO routes private, group and forum-topic updates without absorbing group noise", (t: TestContext) => {
  const dataDir = makeDataDir(t, "routing");
  const result = runHarness("routing", dataDir);
  const queues = result.queue.queues;

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(queues).map(([key, items]) => [
        key,
        items.map((item) => [
          item.version,
          item.updateId,
          item.update?.message?.text,
        ]),
      ]),
    ),
    {
      "1:": [[1, 101, "private follow-up"]],
      "-100:": [[1, 103, "@my_bot group follow-up"]],
      "-100:7": [[1, 104, "/task topic follow-up"]],
    },
  );
  const topicQueue = queues["-100:7"];
  assert.ok(topicQueue);
  const topicItem = topicQueue[0];
  assert.ok(topicItem);
  assert.ok(topicItem.update?.message);
  assert.equal(topicItem.update.message.message_thread_id, 7);
  assert.equal(result.offset.offset, 105);
  assert.equal(result.reactions.length, 3);
  assert.equal(result.queueStatuses.length, 3);
});

test("an idle direct message uses one accepted POST and keeps offset semantics", (t: TestContext) => {
  const dataDir = makeDataDir(t, "direct-success");
  const result = runHarness("direct-success", dataDir);

  assert.equal(result.deliveries.length, 1);
  assert.deepEqual(result.deliveryRoutes, ["/eve/v1/telegram/accepted"]);
  const delivery = result.deliveries[0];
  assert.ok(delivery);
  assert.equal(delivery.update_id, 101);
  assert.ok(delivery.message);
  assert.equal(typeof delivery.message.iva_durable_queue_receipt, "string");
  assert.deepEqual(result.offset, { offset: 102 });
  assert.deepEqual(result.inbox, { version: 1, queues: {} });
  assert.deepEqual(result.queue, { version: 1, queues: {} });
});

test("a direct acceptance 503 resets immediately, notifies once, then retries", (t: TestContext) => {
  const dataDir = makeDataDir(t, "direct-retry");
  const result = runHarness("direct-retry", dataDir);

  assert.deepEqual(result.deliveryRoutes, [
    "/eve/v1/telegram/accepted",
    "/eve/v1/telegram/accepted",
  ]);
  assert.equal(result.statusBeforeRetry.status, "idle");
  assert.equal(result.statusBeforeRetry.ingressId, undefined);
  assert.deepEqual(result.deletedMessages, []);
  assert.deepEqual(
    result.failureNotices.map(({ chat_id, text }) => [chat_id, text]),
    [["1", "Couldn't process the message - repeat it or use /new"]],
  );
  assert.deepEqual(result.offset, { offset: 102 });
  assert.deepEqual(result.inbox, { version: 1, queues: {} });
  assert.deepEqual(result.queue, { version: 1, queues: {} });
});

test("a reply to a closed session is delivered once, then leaves the durable inbox", (t: TestContext) => {
  const dataDir = makeDataDir(t, "closed-session");
  const result = runHarness("closed-session", dataDir);

  assert.deepEqual(
    result.deliveryRoutes,
    ["/eve/v1/telegram/accepted"],
    "терминальный класс не повторяется ни в этом проходе, ни в следующем",
  );
  // Ранний «Работаю…» убран, чат снова свободен, пользователю сказано, что вышло.
  assert.deepEqual(result.deletedMessages, []);
  assert.equal(result.finalStatus.status, "idle");
  assert.deepEqual(
    result.failureNotices.map(({ chat_id, text }) => [chat_id, text]),
    [["1", "Couldn't process the message - repeat it or use /new"]],
  );
  assert.deepEqual(result.offset, { offset: 102 });
  assert.deepEqual(
    ownedUpdates(result),
    [],
    "отравленный апдейт не остаётся ни в inbox, ни в очереди",
  );
});

test("a direct acceptance timeout rejects once and returns to Telegram polling", (t: TestContext) => {
  const dataDir = makeDataDir(t, "direct-timeout");
  const result = runHarness("direct-timeout", dataDir, "none", {
    directAcceptanceTimeoutMs: "25",
  });

  assert.deepEqual(
    result.deliveryRoutes,
    ["/eve/v1/telegram/accepted"],
    "a timed-out POST must never be repeated because it may still start later",
  );
  assert.deepEqual(result.deletedMessages, []);
  assert.deepEqual(
    result.failureNotices.map(({ chat_id, text }) => [chat_id, text]),
    [["1", "Couldn't process the message - repeat it or use /new"]],
  );
  assert.equal(result.finalStatus.status, "idle");
  assert.equal(result.finalStatus.ingressId, undefined);
  assert.deepEqual(
    result.requestedOffsets,
    [100, 102],
    "the rejected result must let the main loop advance and poll again",
  );
  assert.deepEqual(result.offset, { offset: 102 });
  assert.deepEqual(ownedUpdates(result), [
    { location: "inbox", updateId: 101 },
  ]);

  const retried = runHarness("restart-direct-drain", dataDir);
  assert.deepEqual(
    retried.deliveryRoutes,
    ["/eve/v1/telegram/accepted"],
    "a restart must retry the one durably owned message exactly once",
  );
  assert.deepEqual(retried.inbox, { version: 1, queues: {} });
  assert.deepEqual(retried.queue, { version: 1, queues: {} });
  assert.deepEqual(
    parseJson(readFileSync(join(dataDir, "alert-state.json"), "utf8")),
    {},
    "a successful durable retry resolves the throttled acceptance alert",
  );
});

test("a retained acceptance failure stays owned and alerts once", (t: TestContext) => {
  const dataDir = makeDataDir(t, "direct-timeout-alert-throttle");
  writeFileSync(join(dataDir, "alert-state.json"), "{corrupt\n");
  const result = runHarness("direct-timeout-twice", dataDir, "none", {
    directAcceptanceTimeoutMs: "25",
  });

  assert.deepEqual(result.deliveryRoutes, ["/eve/v1/telegram/accepted"]);
  assert.deepEqual(
    result.failureNotices.map(({ chat_id, text }) => [chat_id, text]),
    [["1", "Couldn't process the message - repeat it or use /new"]],
    "the first failure must alert once even when persisted alert state is corrupt",
  );
  assert.deepEqual(ownedUpdates(result), [
    { location: "inbox", updateId: 101 },
  ]);
});

test("callback_query delivery stays on the original webhook route", (t: TestContext) => {
  const dataDir = makeDataDir(t, "callback");
  const result = runHarness("callback", dataDir);

  assert.equal(result.deliveries.length, 1);
  assert.deepEqual(result.deliveryRoutes, ["/eve/v1/telegram"]);
  const delivery = result.deliveries[0];
  assert.ok(delivery);
  assert.ok(delivery.callback_query);
  assert.equal(delivery.callback_query.id, "foreign-callback-101");
  assert.deepEqual(result.offset, { offset: 102 });
  assert.deepEqual(result.inbox, { version: 1, queues: {} });
});

test("button tap daily text survives durable queue reload and materialization", async (t: TestContext) => {
  const { applyTelegramButtonTap } = await import("./poller/control.ts");
  const { TELEGRAM_BUTTON_TAP_DAILY_TEXT_FIELD } =
    await import("#lib/telegram-parts.ts");
  const dataDir = makeDataDir(t, "tap-daily");
  const callback = {
    id: "tap-daily",
    data: "Keep this data 🚀",
    from: { id: 42, is_bot: false },
    message: {
      message_id: 12,
      chat: { id: 42, type: "private" },
      text: "First line\nSecond line",
    },
  };
  const update: Parameters<typeof applyTelegramButtonTap>[0] = {
    update_id: 123,
    callback_query: callback,
  };
  assert.equal(applyTelegramButtonTap(update, callback), true);
  const daily = update.message![TELEGRAM_BUTTON_TAP_DAILY_TEXT_FIELD];
  assert.equal(typeof daily, "string");
  assert.ok(String(daily).endsWith("«First line…»)"));
  const file = join(dataDir, "queue.json");
  await writeQueueFileAtomic(file, {
    version: 1,
    queues: { "42:": [createQueueItem(update)] },
  });
  const loaded = await loadQueueFile(file, { strict: true });
  const materialized = materializeQueueItem(
    "42:",
    loaded.document.queues["42:"][0],
  );
  assert.deepEqual(materialized, update);
  assert.equal(
    materialized?.message?.[TELEGRAM_BUTTON_TAP_DAILY_TEXT_FIELD],
    daily,
  );
  assert.ok(materialized?.message?.text?.includes("Second line"));
});

test("a tap on a model-written button is delivered as the tapper's message on the acceptance route", (t: TestContext) => {
  const dataDir = makeDataDir(t, "button-tap");
  const result = runHarness("button-tap", dataDir);

  assert.deepEqual(result.deliveryRoutes, ["/eve/v1/telegram/accepted"]);
  const delivery = result.deliveries[0];
  assert.equal(delivery?.callback_query, undefined);
  // Нажатие несёт data и текст сообщения, под которым стояла кнопка (8133dc8d).
  assert.equal(
    delivery?.message?.text,
    "Remind me in an hour\n\n(button under Iva's message: «button owner»)",
  );
  assert.equal(delivery?.message?.from?.id, 42);
  assert.deepEqual(result.offset, { offset: 102 });
  assert.deepEqual(result.inbox, { version: 1, queues: {} });
});

test("a rejected callback is durably owned before its offset advances", (t: TestContext) => {
  const dataDir = makeDataDir(t, "callback-rejected");
  const result = runHarness("callback-rejected", dataDir);

  assert.deepEqual(result.deliveries, []);
  assert.deepEqual(result.offset, { offset: 102 });
  assert.deepEqual(ownedUpdates(result), [
    { location: "inbox", updateId: 101 },
  ]);
});

test("an allowed inline callback is durably owned and delivered", (t: TestContext) => {
  const dataDir = makeDataDir(t, "inline-callback");
  const result = runHarness("inline-callback", dataDir);

  assert.deepEqual(result.deliveryRoutes, ["/eve/v1/telegram"]);
  assert.equal(
    result.deliveries[0]?.callback_query?.id,
    "foreign-inline-callback-101",
  );
  assert.deepEqual(result.offset, { offset: 102 });
  assert.deepEqual(ownedUpdates(result), []);
});

test("an unauthorised callback is an explicit terminal drop, not an endless blocker", (t: TestContext) => {
  const dataDir = makeDataDir(t, "unauthorized-callback");
  const result = runHarness("unauthorized-callback", dataDir);

  assert.deepEqual(result.requestedOffsets, [100, 102]);
  assert.deepEqual(result.offset, { offset: 102 });
  assert.deepEqual(result.deliveries, []);
  assert.deepEqual(ownedUpdates(result), []);
});

test("an allowed callback without a stable ingress key fails closed", (t: TestContext) => {
  const dataDir = makeDataDir(t, "unownable-callback");
  const result = runHarness("unownable-callback", dataDir);

  // Неопознаваемый апдейт подтверждается и не блокирует offset навсегда (H2, main
  // cefd33f): «fails closed» здесь про доставку — она пустая, а не про замерший вход.
  assert.deepEqual(result.requestedOffsets, [100, 102]);
  assert.deepEqual(result.offset, { offset: 102 });
  assert.deepEqual(result.deliveries, []);
  assert.deepEqual(ownedUpdates(result), []);
});

test("SIGKILL after callback rejection preserves it for restart delivery", async (t: TestContext) => {
  const dataDir = makeDataDir(t, "callback-rejected-crash");
  const child = spawn(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      HARNESS,
      "callback-rejected-crash",
      dataDir,
      "none",
    ],
    {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });

  await waitForFile(
    join(dataDir, "callback-rejected-ready"),
    child,
    () => stderr,
  );
  const childExit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  child.kill("SIGKILL");
  assert.deepEqual(await childExit, { code: null, signal: "SIGKILL" }, stderr);

  const crashedInbox = normalizeQueueDocument(
    parseJson(readFileSync(join(dataDir, "telegram-inbox.json"), "utf8")),
  ).document;
  assert.deepEqual(
    parseOffsetFile(
      readFileSync(join(dataDir, "telegram-offset.json"), "utf8"),
    ),
    { offset: 102, delivered: null },
  );
  assert.deepEqual(
    ownedUpdates({
      inbox: crashedInbox,
      queue: { version: 1, queues: {} },
    }),
    [{ location: "inbox", updateId: 101 }],
  );

  const restarted = runHarness("restart-callback-drain", dataDir);
  assert.deepEqual(restarted.deliveryRoutes, ["/eve/v1/telegram"]);
  assert.equal(
    restarted.deliveries[0]?.callback_query?.id,
    "foreign-callback-101",
  );
  assert.deepEqual(ownedUpdates(restarted), []);
});

test("SIGKILL after core synthetic ownership replays distillation text", async (t: TestContext) => {
  const dataDir = makeDataDir(t, "core-distill-crash");
  const child = spawn(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      HARNESS,
      "core-distill-ownership-crash",
      dataDir,
      "hold-after-inbox-sync",
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        TELEGRAM_COLLECT_QUIET_MS: "60000",
        TELEGRAM_DIRECT_ACCEPTANCE_TIMEOUT_MS: "25",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const childExit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });

  await waitForFile(
    join(dataDir, "core-distill-ownership-ready"),
    child,
    () => stderr,
  );
  child.kill("SIGKILL");
  assert.deepEqual(await childExit, { code: null, signal: "SIGKILL" }, stderr);

  const crashedInbox = normalizeQueueDocument(
    parseJson(readFileSync(join(dataDir, "telegram-inbox.json"), "utf8")),
  ).document;
  const crashedItems = Object.values(crashedInbox.queues).flat();
  assert.deepEqual(
    parseOffsetFile(
      readFileSync(join(dataDir, "telegram-offset.json"), "utf8"),
    ),
    { offset: 100, delivered: null },
  );
  assert.equal(crashedItems.length, 1);
  assert.ok(crashedItems[0].update?.message);
  assert.equal(crashedItems[0].update?.callback_query, undefined);
  assert.match(crashedItems[0].update.message.text ?? "", /Sergey/u);
  assert.match(crashedItems[0].update.message.text ?? "", /Core memory setup/u);

  const restarted = runHarness("restart-drain", dataDir);
  assert.equal(restarted.deliveries.length, 1);
  assert.equal(restarted.deliveries[0].callback_query, undefined);
  assert.match(restarted.deliveries[0].message?.text ?? "", /Sergey/u);
  assert.match(
    restarted.deliveries[0].message?.text ?? "",
    /Core memory setup/u,
  );
  assert.deepEqual(ownedUpdates(restarted), []);
});

test("core synthetic inbox write failure keeps the Telegram callback offset", (t: TestContext) => {
  const dataDir = makeDataDir(t, "core-distill-write-failure");
  const result = runHarness("core-distill-write-failure", dataDir, "write", {
    directAcceptanceTimeoutMs: "25",
  });

  assert.deepEqual(result.requestedOffsets, [100, 100]);
  assert.deepEqual(result.offset, { offset: 100 });
  assert.deepEqual(ownedUpdates(result), []);
});

test("one-shot core synthetic EIO retries the semantic message without callback-only acknowledgement", (t: TestContext) => {
  const dataDir = makeDataDir(t, "core-distill-eio-retry");
  const result = runHarness("core-distill-eio-retry", dataDir, "write-once", {
    directAcceptanceTimeoutMs: "25",
  });

  assert.deepEqual(result.requestedOffsets, [100, 100, 102, 102]);
  assert.equal(
    result.deliveries.some((update) => update.callback_query !== undefined),
    false,
  );
  const owned = Object.values(result.inbox.queues).flat();
  assert.equal(owned.length, 1, "duplicate callback retries must dedup");
  const ownedUpdate = owned[0]?.update;
  assert.ok(ownedUpdate?.message);
  assert.equal(ownedUpdate.callback_query, undefined);
  assert.match(ownedUpdate.message.text ?? "", /Sergey/u);
  assert.deepEqual(result.offset, { offset: 102 });
});

test("SIGKILL after first core synthetic EIO reconstructs distillation from the durable interview", async (t: TestContext) => {
  const dataDir = makeDataDir(t, "core-distill-eio-crash");
  const child = spawn(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      HARNESS,
      "core-distill-eio-crash",
      dataDir,
      "write-once",
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        TELEGRAM_DIRECT_ACCEPTANCE_TIMEOUT_MS: "25",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const childExit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });

  await waitForFile(
    join(dataDir, "core-distill-eio-ready"),
    child,
    () => stderr,
  );
  child.kill("SIGKILL");
  assert.deepEqual(await childExit, { code: null, signal: "SIGKILL" }, stderr);
  assert.deepEqual(
    parseOffsetFile(
      readFileSync(join(dataDir, "telegram-offset.json"), "utf8"),
    ),
    { offset: 100, delivered: null },
  );
  assert.match(
    readFileSync(join(dataDir, "vault", "core-interview.md"), "utf8"),
    /Sergey/u,
  );

  const restarted = runHarness("core-distill-eio-restart", dataDir);
  assert.deepEqual(restarted.requestedOffsets, [100, 102]);
  assert.deepEqual(restarted.offset, { offset: 102 });
  assert.equal(restarted.deliveries.length, 1);
  assert.equal(restarted.deliveries[0]?.callback_query, undefined);
  assert.match(restarted.deliveries[0]?.message?.text ?? "", /Sergey/u);
  assert.match(
    restarted.deliveries[0]?.message?.text ?? "",
    /Core memory setup/u,
  );
  assert.deepEqual(ownedUpdates(restarted), []);
});
