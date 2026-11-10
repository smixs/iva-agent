/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registration promises and the harness preserves production async seams. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramChannel } from "eve/channels/telegram";
import type {
  TelegramChannelState,
  TelegramContext,
  TelegramMessage,
} from "eve/channels/telegram";
import type { RouteHandlerArgs, Session } from "eve/channels";
import type { MessageStreamEvent } from "eve/client";
import {
  createQueueItem,
  enqueueItem,
  queueHead,
  removeQueueItems,
} from "./lib/telegram-queue.ts";
import {
  addTelegramQueueReceipt,
  handleAcceptedTelegramWebhook,
  TELEGRAM_CLOSED_SESSION_KIND,
  telegramTurnPolicy,
  wrapTelegramQueueOnMessage,
} from "#lib/telegram-acceptance.ts";
import { TELEGRAM_QUEUE_RECEIPT_FIELD } from "#lib/telegram-parts.ts";
import { setChatStatus } from "#lib/run-status.ts";
import { tempDir } from "./fixtures/temp-dir.ts";

const WEBHOOK_SECRET = "test-secret";

// Журнал хода (ADR-0010): обёртка onMessage — единственное место, где видны и апдейт, и
// результат inbound-пайплайна, поэтому состав контекста и связка «апдейт ↔ ход» пишутся
// здесь, а не внутри самого пайплайна.
const traceRoot = mkdtempSync(join(tmpdir(), "iva-acceptance-trace-"));
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

function inboundMessage(chatId: number, messageId: number): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: String(chatId), type: "private" },
    from: { id: "42", isBot: false },
    messageId: String(messageId),
    raw: {},
    text: "привет",
  } as unknown as TelegramMessage;
}
type TestMessageUpdate = {
  update_id: number;
  message: {
    message_id: number;
    date: number;
    chat: { id: number; type: string };
    from: { id: number; is_bot: boolean; first_name: string };
    text?: string;
    [key: string]: unknown;
  };
};
type TestCallbackUpdate = {
  update_id: number;
  callback_query: {
    id: string;
    from: { id: number; is_bot: boolean; first_name: string };
    message: {
      message_id: number;
      date: number;
      chat: { id: number; type: string };
    };
    data: string;
  };
};
type TestUpdate = TestMessageUpdate | TestCallbackUpdate;
type DeliveryResult = true | false | "handled" | "closed-session";
type SendImpl = (
  update: TestUpdate,
  input: unknown,
  options: unknown,
) => Promise<unknown>;
type TelegramRouteHandler = (
  request: Request,
  args: RouteHandlerArgs<TelegramChannelState>,
) => Promise<Response>;
type DeliveryOptions = {
  webhookVerifier?: (
    request: Request,
    rawBody: string,
  ) => Promise<string | boolean>;
  onMessage?: (context: TelegramContext, message: TelegramMessage) => unknown;
  marked?: boolean;
  webhookSecretHeader?: string;
  completedUpdatesFile?: string;
  observeResponse?: (response: Response) => void;
  handler?: TelegramRouteHandler;
  sessionEvents?: readonly MessageStreamEvent[];
  sessionEventStreamError?: Error;
  onSessionEventStream?: (startIndex: number) => void;
};
type DrainReadyQueueHeads = (
  options: Record<string, unknown>,
) => Promise<number>;

const isCompletedLedger = (
  value: unknown,
): value is { botId: string; updates: number[] } =>
  value !== null &&
  typeof value === "object" &&
  "botId" in value &&
  typeof value.botId === "string" &&
  "updates" in value &&
  Array.isArray(value.updates) &&
  value.updates.every((id) => typeof id === "number");

const fakeBotToken = (id: number, label: string): string =>
  `${id}:${Buffer.from(label).toString("base64url")}`;
const fakeSession = (
  id: string,
  respond: Session["respond"] = async () => ({
    sessionId: id,
    status: "accepted",
  }),
  events: readonly MessageStreamEvent[] = [],
  eventStreamError?: Error,
  onEventStream?: (startIndex: number) => void,
): Session => ({
  id,
  respond,
  send: () => {
    throw new Error("not used");
  },
  cancel: () => {
    throw new Error("not used");
  },
  clear: () => {
    throw new Error("not used");
  },
  compact: () => {
    throw new Error("not used");
  },
  getEventStream: async ({ startIndex = 0 } = {}) => {
    onEventStream?.(startIndex);
    if (eventStreamError !== undefined) throw eventStreamError;
    return new ReadableStream<MessageStreamEvent>({
      start(controller) {
        for (const event of events.slice(startIndex)) controller.enqueue(event);
        controller.close();
      },
    });
  },
  getStreamTailIndex: async () => events.length - 1,
  reset: () => {
    throw new Error("not used");
  },
});
process.env.TELEGRAM_BOT_TOKEN = fakeBotToken(999, "acceptance-default");
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = WEBHOOK_SECRET;
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.TELEGRAM_POLL_SETTLE_MS = "0";
const pollModulePath = "./telegram-poll.mjs";
const { drainReadyQueueHeads } = (await import(pollModulePath)) as {
  drainReadyQueueHeads: DrainReadyQueueHeads;
};

test("turn policy defaults to queue and accepts only the steer setting", () => {
  assert.equal(telegramTurnPolicy({}), "queue");
  assert.equal(telegramTurnPolicy({ turnPolicy: "queue" }), "queue");
  assert.equal(telegramTurnPolicy({ turnPolicy: "steer" }), "steer");
  assert.equal(telegramTurnPolicy({ turnPolicy: "junk" }), "queue");
});

const privateUpdate = (updateId: number, text?: string): TestMessageUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1,
    chat: { id: 1, type: "private" },
    from: { id: 42, is_bot: false, first_name: "Owner" },
    text,
  },
});

const hitlCallbackUpdate = (updateId: number): TestCallbackUpdate => ({
  update_id: updateId,
  callback_query: {
    id: `callback-${updateId}`,
    from: { id: 42, is_bot: false, first_name: "Owner" },
    message: {
      message_id: updateId - 1,
      date: 1,
      chat: { id: 1, type: "private" },
    },
    data: "eve:1",
  },
});

const inputRequestedEvent = (requestId: string): MessageStreamEvent => ({
  type: "input.requested",
  data: {
    requests: [
      {
        action: {
          callId: `call-${requestId}`,
          input: {},
          kind: "tool-call",
          toolName: "ask_question",
        },
        allowFreeform: true,
        display: "text",
        kind: "question",
        prompt: "Continue?",
        requestId,
      },
    ],
    sequence: 0,
    stepIndex: 0,
    turnId: "turn-pending",
  },
  meta: { at: "2026-09-02T00:00:00.000Z", id: `event-${requestId}` },
});

const inputResolvedEvent = (requestId: string): MessageStreamEvent => ({
  type: "input.resolved",
  data: {
    resolutions: [
      {
        kind: "question",
        outcome: "answered",
        requestId,
        response: { requestId, text: "done" },
      },
    ],
    sequence: 0,
    stepIndex: 0,
    turnId: "turn-pending",
  },
  meta: { at: "2026-09-02T00:00:01.000Z", id: `resolved-${requestId}` },
});

function deferred(): {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: unknown) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function productionTelegramDelivery(
  sendImpl: SendImpl,
  {
    webhookVerifier,
    onMessage = () => ({ auth: null }),
    marked = true,
    webhookSecretHeader = WEBHOOK_SECRET,
    observeResponse,
    handler,
    sessionEvents = [],
    sessionEventStreamError,
    onSessionEventStream,
    completedUpdatesFile = join(
      tempDir("iva-completed-updates-test-"),
      "completed-updates.json",
    ),
  }: DeliveryOptions = {},
): (update: TestUpdate) => Promise<DeliveryResult> {
  const channel = telegramChannel({
    api: {
      fetch: async () => Response.json({ ok: true, result: true }),
    },
    credentials: {
      botToken: fakeBotToken(999, "acceptance-channel"),
      webhookVerifier:
        webhookVerifier ?? (async (_request, rawBody) => rawBody),
    },
    onMessage: wrapTelegramQueueOnMessage(
      onMessage as Parameters<typeof wrapTelegramQueueOnMessage>[0],
    ),
  });
  const route = channel.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" &&
      candidate.method === "POST" &&
      candidate.path === "/eve/v1/telegram",
  );
  assert.ok(route && route.transport !== "websocket");

  return async (update: TestUpdate) => {
    const sessionId = `test-session-${update.update_id}`;
    const call = async (input: unknown, options: unknown) =>
      sendImpl(update, input, options);
    const routeArgs = {
      attachSession: (id: string) => fakeSession(id),
      from: () => ({
        send: async (message: unknown, options: unknown) => {
          await call({ message }, options);
          return fakeSession(sessionId);
        },
        respond: () => {
          throw new Error("acceptance proxy must own respond");
        },
        cancel: () => {
          throw new Error("not used");
        },
        clear: () => {
          throw new Error("not used");
        },
        compact: () => {
          throw new Error("not used");
        },
        reset: () => {
          throw new Error("not used");
        },
      }),
      resolveSession: async () =>
        fakeSession(
          sessionId,
          async (inputResponses, options) => {
            const message =
              "message" in update ? (update.message.text ?? "") : "";
            const result = await call({ inputResponses, message }, options);
            return typeof result === "object" &&
              result !== null &&
              "status" in result &&
              result.status === "session_not_active"
              ? { status: "session_not_active" }
              : { sessionId, status: "accepted" };
          },
          sessionEvents,
          sessionEventStreamError,
          onSessionEventStream,
        ),
      to: () => {
        throw new Error("not used");
      },
      params: {},
      waitUntil: () => {},
      requestIp: "127.0.0.1",
    } as unknown as RouteHandlerArgs<TelegramChannelState>;
    const response = await handleAcceptedTelegramWebhook(
      handler ?? route.handler,
      new Request("http://iva.test/eve/v1/telegram/accepted", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": webhookSecretHeader,
        },
        body: JSON.stringify(marked ? addTelegramQueueReceipt(update) : update),
      }),
      routeArgs,
      { completedUpdatesFile },
    );
    observeResponse?.(response);
    if (!response.ok) {
      return response.headers.get("x-iva-telegram-acceptance") ===
        TELEGRAM_CLOSED_SESSION_KIND
        ? TELEGRAM_CLOSED_SESSION_KIND
        : false;
    }
    return response.headers.get("x-iva-telegram-acceptance") === "handled"
      ? "handled"
      : true;
  };
}

test("intentional authored no-send accepts queued contact, then the later text keeps FIFO order", async () => {
  const contact = {
    ...privateUpdate(101, undefined),
    message: {
      ...privateUpdate(101, undefined).message,
      contact: { first_name: "Ada", phone_number: "+99800" },
    },
  };
  let document = enqueueItem(
    enqueueItem({ version: 1, queues: {} }, "1:", createQueueItem(contact, 1))
      .document,
    "1:",
    createQueueItem(privateUpdate(102, "/x"), 2),
  ).document;
  const sent: number[] = [];
  const deliverImpl = productionTelegramDelivery(
    async (update) => {
      sent.push(update.update_id);
      return { id: `session-${update.update_id}` };
    },
    {
      onMessage: (_ctx, message) => {
        assert.equal(
          Object.hasOwn(message.raw, TELEGRAM_QUEUE_RECEIPT_FIELD),
          false,
        );
        return message.raw.contact ? null : { auth: null };
      },
    },
  );
  const acknowledgeImpl = async (key: string, updateIds: readonly number[]) => {
    document = removeQueueItems(document, key, updateIds).document;
  };
  const inFlight = new Map();
  const pins = new Map();

  assert.equal(
    await drainReadyQueueHeads({
      loadImpl: async () => document,
      runningImpl: () => false,
      deliverImpl,
      acknowledgeImpl,
      settleUntil: new Map(),
      inFlight,
      pins,
    }),
    1,
  );
  assert.equal(queueHead(document, "1:")?.updateId, 102);
  assert.deepEqual(sent, []);

  assert.equal(
    await drainReadyQueueHeads({
      loadImpl: async () => document,
      runningImpl: () => false,
      deliverImpl,
      acknowledgeImpl,
      settleUntil: new Map(),
      inFlight,
      pins,
    }),
    0,
  );
  assert.deepEqual(sent, [102]);
});

test("intentional silent sticker no-send is accepted, while throw and unmarked null are rejected", async () => {
  const sticker = {
    ...privateUpdate(201, undefined),
    message: {
      ...privateUpdate(201, undefined).message,
      sticker: { file_id: "silent-sticker" },
    },
  };
  let sendCalls = 0;
  const silent = productionTelegramDelivery(
    async () => {
      sendCalls++;
      return { id: "must-not-send" };
    },
    { onMessage: () => null },
  );
  assert.equal(await silent(sticker), "handled");
  assert.equal(sendCalls, 0);

  const thrown = productionTelegramDelivery(
    async () => {
      sendCalls++;
      return { id: "must-not-send" };
    },
    {
      onMessage: () => {
        throw new Error("injected authored handler failure");
      },
    },
  );
  assert.equal(await thrown(sticker), false);
  assert.equal(sendCalls, 0);

  const unmarked = productionTelegramDelivery(
    async () => {
      sendCalls++;
      return { id: "must-not-send" };
    },
    { onMessage: () => null, marked: false },
  );
  assert.equal(await unmarked(sticker), false);
  assert.equal(sendCalls, 0);
});

test("acceptance route preserves Telegram auth failure and rejects malformed no-send updates", async () => {
  let sendCalls = 0;
  const rejectedByVerifier = productionTelegramDelivery(
    async () => {
      sendCalls++;
      return { id: "must-not-run" };
    },
    { webhookVerifier: async () => false },
  );
  assert.equal(
    await rejectedByVerifier(privateUpdate(1, "unauthorized")),
    false,
  );
  assert.equal(sendCalls, 0);

  const channel = telegramChannel({
    credentials: { webhookVerifier: async (_request, rawBody) => rawBody },
    onMessage: () => ({ auth: null }),
  });
  const route = channel.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" &&
      candidate.method === "POST" &&
      candidate.path === "/eve/v1/telegram",
  );
  assert.ok(route && route.transport !== "websocket");
  const malformed = await handleAcceptedTelegramWebhook(
    route.handler,
    new Request("http://iva.test/eve/v1/telegram/accepted", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    }),
    {
      attachSession: () => fakeSession("unused"),
      from: () => {
        sendCalls++;
        throw new Error("must not run");
      },
      resolveSession: async () => undefined,
      to: () => {
        throw new Error("must not run");
      },
      params: {},
      waitUntil: () => {},
      requestIp: "127.0.0.1",
    },
  );
  assert.equal(malformed.ok, false);
  assert.equal(malformed.status, 503);
  assert.equal(sendCalls, 0);
});

test("production Telegram deferred failure retains the head and cannot start the next head", async () => {
  let document = enqueueItem(
    enqueueItem(
      { version: 1, queues: {} },
      "1:",
      createQueueItem(privateUpdate(101, "first"), 1),
    ).document,
    "1:",
    createQueueItem(privateUpdate(102, "/x"), 2),
  ).document;
  const attempts: number[] = [];

  const remaining = await drainReadyQueueHeads({
    loadImpl: async () => document,
    runningImpl: () => false,
    deliverImpl: productionTelegramDelivery(async (update) => {
      attempts.push(update.update_id);
      throw new Error("injected Eve acceptance failure");
    }),
    acknowledgeImpl: async (key: string, updateIds: readonly number[]) => {
      document = removeQueueItems(document, key, updateIds).document;
    },
    settleUntil: new Map(),
    inFlight: new Map(),
    pins: new Map(),
  });

  assert.equal(remaining, 2);
  assert.equal(queueHead(document, "1:")?.updateId, 101);
  assert.deepEqual(attempts, [101]);
});

test("production Telegram receipt removes exactly the batch only after Eve send resolves", async () => {
  let document = [
    privateUpdate(101, "first"),
    privateUpdate(102, "second"),
    privateUpdate(103, "/x"),
  ].reduce<ReturnType<typeof enqueueItem>["document"]>(
    (current, update, index) =>
      enqueueItem(current, "1:", createQueueItem(update, index + 1)).document,
    { version: 1, queues: {} },
  );
  const acceptance = deferred();
  const attempts: number[] = [];

  const drain = drainReadyQueueHeads({
    loadImpl: async () => document,
    runningImpl: () => false,
    deliverImpl: productionTelegramDelivery(async (update) => {
      attempts.push(update.update_id);
      return acceptance.promise;
    }),
    acknowledgeImpl: async (key: string, updateIds: readonly number[]) => {
      document = removeQueueItems(document, key, updateIds).document;
    },
    settleUntil: new Map(),
    inFlight: new Map(),
    pins: new Map(),
  });

  await waitFor(() => attempts.length === 1, "the first delivery attempt");
  assert.equal(queueHead(document, "1:")?.updateId, 101);
  assert.deepEqual(attempts, [102], "the batch speaks with its last id");

  acceptance.resolve({ id: "accepted-session" });
  assert.equal(await drain, 1);
  assert.equal(queueHead(document, "1:")?.updateId, 103);
  assert.deepEqual(
    attempts,
    [102],
    "one drain pass must keep one in-flight batch per chat",
  );
});

test("the same in-flight update waits for one acceptance instead of starting a second turn", async () => {
  const acceptance = deferred();
  let turns = 0;
  const delivery = productionTelegramDelivery(async () => {
    turns++;
    return acceptance.promise;
  });
  const update = privateUpdate(500, "slow acceptance");

  const first = delivery(update);
  await waitFor(() => turns === 1, "the original acceptance");
  const duplicate = delivery(update);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(turns, 1);

  acceptance.resolve({ id: "accepted-session" });
  assert.deepEqual(await Promise.all([first, duplicate]), [true, true]);
  assert.equal(turns, 1);
});

test("a completed update is handled from disk without invoking the authored handler", async () => {
  const root = tempDir("iva-completed-ledger-test-");
  const completedUpdatesFile = join(root, "completed-updates.json");
  let handlerCalls = 0;
  const first = productionTelegramDelivery(
    async () => ({ id: "accepted-session" }),
    {
      completedUpdatesFile,
      onMessage: () => {
        handlerCalls++;
        return { auth: null };
      },
    },
  );
  assert.equal(await first(privateUpdate(501, "first")), true);

  handlerCalls = 0;
  const afterReload = productionTelegramDelivery(
    async () => {
      throw new Error("duplicate must not send");
    },
    {
      completedUpdatesFile,
      onMessage: () => {
        handlerCalls++;
        return { auth: null };
      },
    },
  );
  assert.equal(await afterReload(privateUpdate(501, "duplicate")), "handled");
  assert.equal(handlerCalls, 0);
  assert.deepEqual(JSON.parse(readFileSync(completedUpdatesFile, "utf8")), {
    botId: "999",
    updates: [501],
  });

  const unauthorized = productionTelegramDelivery(
    async () => {
      throw new Error("unauthorized duplicate must not send");
    },
    {
      completedUpdatesFile,
      webhookSecretHeader: "wrong-secret",
      webhookVerifier: async (request): Promise<boolean> =>
        request.headers.get("x-telegram-bot-api-secret-token") ===
        WEBHOOK_SECRET,
      onMessage: () => {
        handlerCalls++;
        return { auth: null };
      },
    },
  );
  assert.equal(
    await unauthorized(privateUpdate(501, "unauthorized duplicate")),
    false,
  );
  assert.equal(handlerCalls, 0);
});

test("an update is recorded only after successful acceptance", async () => {
  const root = tempDir("iva-completed-ledger-reject-test-");
  const completedUpdatesFile = join(root, "completed-updates.json");
  let handlerCalls = 0;
  const rejected = productionTelegramDelivery(
    async () => {
      throw new Error("injected rejection");
    },
    {
      completedUpdatesFile,
      onMessage: () => {
        handlerCalls++;
        return { auth: null };
      },
    },
  );
  assert.equal(await rejected(privateUpdate(601, "retry me")), false);

  let acceptedOptions: unknown;
  const accepted = productionTelegramDelivery(
    async (_update, _input, options) => {
      acceptedOptions = options;
      return { id: "accepted-session" };
    },
    {
      completedUpdatesFile,
      onMessage: () => {
        handlerCalls++;
        return { auth: null };
      },
    },
  );
  assert.equal(await accepted(privateUpdate(601, "retry me")), true);
  assert.equal(
    (acceptedOptions as { turnPolicy?: unknown }).turnPolicy,
    "queue",
  );
  assert.equal(handlerCalls, 2);
  assert.deepEqual(JSON.parse(readFileSync(completedUpdatesFile, "utf8")), {
    botId: "999",
    updates: [601],
  });
});

test("the completed-update ledger keeps the latest 200 ids", async () => {
  const root = tempDir("iva-completed-ledger-bound-test-");
  const completedUpdatesFile = join(root, "completed-updates.json");
  writeFileSync(
    completedUpdatesFile,
    JSON.stringify({
      botId: "999",
      updates: Array.from({ length: 200 }, (_, id) => id),
    }),
  );
  const delivery = productionTelegramDelivery(
    async () => ({ id: "accepted-session" }),
    { completedUpdatesFile },
  );

  assert.equal(await delivery(privateUpdate(999, "newest")), true);
  const completed: unknown = JSON.parse(
    readFileSync(completedUpdatesFile, "utf8"),
  );
  assert.ok(isCompletedLedger(completed));
  assert.equal(completed.botId, "999");
  assert.equal(completed.updates.length, 200);
  assert.equal(completed.updates.includes(0), false);
  assert.equal(completed.updates.includes(999), true);
});

test("a completed-update ledger is isolated by Telegram bot id", async () => {
  const root = tempDir("iva-completed-ledger-bot-test-");
  const completedUpdatesFile = join(root, "completed-updates.json");
  let sends = 0;
  const delivery = productionTelegramDelivery(
    async () => ({ id: `accepted-${++sends}` }),
    { completedUpdatesFile },
  );
  const priorToken = process.env.TELEGRAM_BOT_TOKEN;
  try {
    process.env.TELEGRAM_BOT_TOKEN = fakeBotToken(111, "first-bot");
    assert.equal(await delivery(privateUpdate(701, "first bot")), true);
    process.env.TELEGRAM_BOT_TOKEN = fakeBotToken(222, "second-bot");
    assert.equal(await delivery(privateUpdate(701, "second bot")), true);
    assert.equal(
      await delivery(privateUpdate(701, "second bot duplicate")),
      "handled",
    );
    assert.equal(sends, 2);
    assert.deepEqual(JSON.parse(readFileSync(completedUpdatesFile, "utf8")), {
      botId: "222",
      updates: [701],
    });
  } finally {
    if (priorToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = priorToken;
  }
});

test("an invalid completed-update schema is recovered after acceptance", async () => {
  const root = tempDir("iva-completed-ledger-schema-test-");
  const completedUpdatesFile = join(root, "completed-updates.json");
  writeFileSync(completedUpdatesFile, JSON.stringify({ updates: "broken" }));
  let sends = 0;
  const delivery = productionTelegramDelivery(
    async () => ({ id: `accepted-${++sends}` }),
    { completedUpdatesFile },
  );

  assert.equal(await delivery(privateUpdate(801, "recover")), true);
  assert.equal(await delivery(privateUpdate(801, "duplicate")), "handled");
  assert.equal(sends, 1);
  assert.deepEqual(JSON.parse(readFileSync(completedUpdatesFile, "utf8")), {
    botId: "999",
    updates: [801],
  });
});

test("missing webhook secret disables deduplication and reports it once", async () => {
  const root = tempDir("iva-completed-ledger-secret-test-");
  const completedUpdatesFile = join(root, "completed-updates.json");
  const priorSecret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  const priorError = console.error;
  const logs: string[] = [];
  let sends = 0;
  delete process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  console.error = (...parts: unknown[]) =>
    logs.push(parts.map(String).join(" "));
  try {
    const delivery = productionTelegramDelivery(
      async () => ({ id: `accepted-${++sends}` }),
      { completedUpdatesFile },
    );
    assert.equal(await delivery(privateUpdate(901, "first")), true);
    assert.equal(await delivery(privateUpdate(901, "repeat")), true);
  } finally {
    console.error = priorError;
    process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = priorSecret;
  }
  assert.equal(sends, 2);
  assert.equal(
    logs.filter((line) => line.includes("durable deduplication")).length,
    1,
  );
});

test("Trace: обёртка пишет состав контекста и связывает ход с апдейтом", async () => {
  const before = traceEvents().length;
  const accepted = wrapTelegramQueueOnMessage(() => ({
    auth: null,
    context: ["[reply]", "[voice] spoken words"],
  }));
  const dropped = wrapTelegramQueueOnMessage(() => null);

  await accepted({} as TelegramContext, inboundMessage(77, 5));
  await dropped({} as TelegramContext, inboundMessage(78, 6));

  const added = traceEvents()
    .slice(before)
    .filter((event) => event.kind === "inbound");
  assert.deepEqual(
    added.map((event) => event.name),
    ["accepted", "dropped"],
  );
  assert.equal(added[0].turn, "tg:77:5");
  assert.deepEqual(added[0].data, {
    chatId: "77",
    chatKey: "77:",
    parts: 2,
    partChars: [7, 20],
    context: ["[reply]", "[voice] spoken words"],
  });
  // Принятый апдейт помечен для старта хода, отброшенный — нет.
  assert.equal(trace.traceBoundUpdate("77:"), "tg:77:5");
  assert.equal(trace.traceBoundUpdate("78:"), "");
});

// --- Reply на закрытую сессию (issue #203) ---
// eve строит inputResponses из reply на сообщение бота. Сессия под цитатой может
// закрыться штатно. Session.respond сообщает это структурным session_not_active.

const replyToBotUpdate = (
  updateId: number,
  text?: string,
): TestMessageUpdate => ({
  ...privateUpdate(updateId, text),
  message: {
    ...privateUpdate(updateId, text).message,
    reply_to_message: {
      message_id: updateId - 1,
      date: 1,
      chat: { id: 1, type: "private" },
      from: { id: 999, is_bot: true, first_name: "Iva" },
      text: "старый ответ бота",
    },
  },
});

const inputResponsesOf = (input: unknown): unknown[] =>
  typeof input === "object" && input !== null && "inputResponses" in input
    ? ((input as { inputResponses?: unknown[] }).inputResponses ?? [])
    : [];

test("a 20k-event session without pending input reroutes in O(1) without opening the stream", async () => {
  const replyContext = JSON.stringify({
    type: "telegram_reply",
    text: "старый ответ бота",
  });
  const attempts: Array<{ input: unknown; options: unknown }> = [];
  const streamStarts: number[] = [];
  const delivery = productionTelegramDelivery(
    async (_update, input, options) => {
      attempts.push({ input, options });
      return { id: "reply-turn" };
    },
    {
      onMessage: () => ({ auth: null, context: [replyContext] }),
      sessionEvents: Array.from({ length: 20_000 }, (_, index) =>
        inputResolvedEvent(`resolved-${index}`),
      ),
      onSessionEventStream: (startIndex) => streamStarts.push(startIndex),
    },
  );

  const startedAt = performance.now();
  assert.equal(await delivery(replyToBotUpdate(1100, "и что дальше?")), true);
  assert.ok(performance.now() - startedAt < 1_000);
  assert.deepEqual(streamStarts, []);
  assert.equal(attempts.length, 1);
  assert.equal(inputResponsesOf(attempts[0].input).length, 0);
  assert.match(
    JSON.stringify((attempts[0].options as { context?: unknown }).context),
    /старый ответ бота/u,
  );
});

test("a reply with pending input still responds without starting a turn", async () => {
  const attempts: unknown[] = [];
  const delivery = productionTelegramDelivery(
    async (_update, input) => {
      attempts.push(input);
      return { status: "accepted" };
    },
    { sessionEvents: [] },
  );

  try {
    setChatStatus("1:", {
      pendingInputRequestIds: ["pending-reply"],
      pendingInputSessionId: "test-session-1101",
    });
    assert.equal(await delivery(replyToBotUpdate(1101, "да")), true);
    assert.equal(attempts.length, 1);
    assert.equal(inputResponsesOf(attempts[0]).length, 1);
  } finally {
    setChatStatus("1:", {
      pendingInputRequestIds: null,
      pendingInputSessionId: null,
    });
  }
});

test("a reply reroutes once without touching an unreadable event stream", async () => {
  const attempts: unknown[] = [];
  const logs: string[] = [];
  const streamStarts: number[] = [];
  const priorError = console.error;
  console.error = (...parts: unknown[]) =>
    logs.push(parts.map(String).join(" "));
  try {
    const delivery = productionTelegramDelivery(
      async (_update, input) => {
        attempts.push(input);
        return { id: "reply-turn" };
      },
      {
        sessionEvents: [inputRequestedEvent("unreadable")],
        sessionEventStreamError: new Error("injected stream failure"),
        onSessionEventStream: (startIndex) => streamStarts.push(startIndex),
      },
    );

    assert.equal(await delivery(replyToBotUpdate(1102, "дальше")), true);
  } finally {
    console.error = priorError;
  }

  assert.equal(attempts.length, 1);
  assert.equal(inputResponsesOf(attempts[0]).length, 0);
  assert.deepEqual(streamStarts, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /reply has no pending input after \d+ms/u);
});

test("a thrown reply response reroutes once with the prepared context", async () => {
  const replyContext = JSON.stringify({
    type: "telegram_reply",
    text: "старый ответ бота",
  });
  const attempts: Array<{ input: unknown; options: unknown }> = [];
  const priorError = console.error;
  console.error = () => {};
  setChatStatus("1:", {
    pendingInputRequestIds: ["pending-throw"],
    pendingInputSessionId: "test-session-1102",
  });
  try {
    const delivery = productionTelegramDelivery(
      async (_update, input, options) => {
        attempts.push({ input, options });
        if (inputResponsesOf(input).length > 0)
          throw new Error("reply response failed");
        return { id: "rerouted-turn" };
      },
      {
        onMessage: () => ({ auth: null, context: [replyContext] }),
        sessionEvents: [inputRequestedEvent("pending-throw")],
      },
    );
    assert.equal(await delivery(replyToBotUpdate(1102, "и что дальше?")), true);
  } finally {
    console.error = priorError;
    setChatStatus("1:", {
      pendingInputRequestIds: null,
      pendingInputSessionId: null,
    });
  }

  assert.equal(attempts.length, 2);
  assert.equal(inputResponsesOf(attempts[0].input).length, 1);
  assert.equal(inputResponsesOf(attempts[1].input).length, 0);
  assert.match(
    JSON.stringify((attempts[1].options as { context?: unknown }).context),
    /старый ответ бота/u,
  );
});

test("a reply to a closed session is delivered as a new turn exactly once", async () => {
  const attempts: unknown[] = [];
  const priorError = console.error;
  const logs: string[] = [];
  console.error = (...parts: unknown[]) =>
    logs.push(parts.map(String).join(" "));
  setChatStatus("1:", {
    pendingInputRequestIds: ["pending-closed"],
    pendingInputSessionId: "test-session-1101",
  });
  try {
    const delivery = productionTelegramDelivery(
      async (_update, input) => {
        attempts.push(input);
        if (inputResponsesOf(input).length > 0)
          return { status: "session_not_active" };
        return { id: "new-turn" };
      },
      { sessionEvents: [inputRequestedEvent("pending-closed")] },
    );
    assert.equal(await delivery(replyToBotUpdate(1101, "и что дальше?")), true);
  } finally {
    console.error = priorError;
    setChatStatus("1:", {
      pendingInputRequestIds: null,
      pendingInputSessionId: null,
    });
  }

  assert.equal(attempts.length, 2, "ровно одна перемаршрутизация");
  assert.equal(inputResponsesOf(attempts[0]).length, 1);
  assert.equal(inputResponsesOf(attempts[1]).length, 0);
  // Текст и контекст хода те же — теряется только привязка к закрытой сессии.
  assert.deepEqual(
    (attempts[1] as { message: unknown }).message,
    (attempts[0] as { message: unknown }).message,
  );
  assert.deepEqual(
    logs.filter((line) => line.includes("closed session")),
    [
      "[telegram] reply to a closed session; delivering as a new message (update 1101)",
    ],
  );
});

test("a media-only reply can reroute with its prepared context", async () => {
  const mediaContext = "[photo] vault/path.jpg\n\nописание";
  const attempts: Array<{ input: unknown; options: unknown }> = [];
  const delivery = productionTelegramDelivery(
    async (_update, input, options) => {
      attempts.push({ input, options });
      if (inputResponsesOf(input).length > 0)
        return { status: "session_not_active" };
      return { id: "new-media-turn" };
    },
    {
      sessionEvents: [inputRequestedEvent("pending-media")],
      handler: async (_request, args) => {
        args.waitUntil(
          args.from("telegram:1::").respond([{ requestId: "media-reply" }], {
            auth: null,
            context: [mediaContext],
          }),
        );
        return new Response("ok");
      },
    },
  );
  const update = replyToBotUpdate(1102);
  update.message.photo = [{ file_id: "f1", width: 90, height: 90 }];

  try {
    setChatStatus("1:", {
      pendingInputRequestIds: ["pending-media"],
      pendingInputSessionId: "test-session-1102",
    });
    assert.equal(await delivery(update), true);
  } finally {
    setChatStatus("1:", {
      pendingInputRequestIds: null,
      pendingInputSessionId: null,
    });
  }
  assert.equal(attempts.length, 2, "ровно одна перемаршрутизация");
  assert.equal(inputResponsesOf(attempts[0].input).length, 1);
  assert.equal(inputResponsesOf(attempts[1].input).length, 0);
  assert.deepEqual((attempts[1].options as { context?: unknown }).context, [
    mediaContext,
  ]);
});

test("a new turn refused by an unavailable eve is retained, then delivered on the next healthy cycle", async () => {
  const attempts: unknown[] = [];
  let eveIsDown = true;
  const priorError = console.error;
  console.error = () => {};
  setChatStatus("1:", {
    pendingInputRequestIds: ["pending-unavailable"],
    pendingInputSessionId: "test-session-1102",
  });
  try {
    const delivery = productionTelegramDelivery(
      async (_update, input) => {
        attempts.push(input);
        if (inputResponsesOf(input).length > 0)
          return { status: "session_not_active" };
        if (eveIsDown) throw new Error("eve is restarting");
        return { id: "new-turn" };
      },
      { sessionEvents: [inputRequestedEvent("pending-unavailable")] },
    );
    const update = replyToBotUpdate(1102, "и что дальше?");
    // Сессия не найдена, но новый ход упал по недоступности eve — сообщение владельца
    // не теряется (ADR-0002): транзиентный отказ, мост сохраняет апдейт.
    assert.equal(await delivery(update), false);
    eveIsDown = false;
    assert.equal(await delivery(update), true);
  } finally {
    console.error = priorError;
    setChatStatus("1:", {
      pendingInputRequestIds: null,
      pendingInputSessionId: null,
    });
  }
  assert.equal(attempts.length, 4, "по две попытки на каждый проход моста");
  assert.equal(inputResponsesOf(attempts[3]).length, 0);
});

test("a HITL callback to a closed session returns the frozen 409 receipt", async () => {
  const attempts: unknown[] = [];
  let responseStatus: number | undefined;
  const priorError = console.error;
  console.error = () => {};
  try {
    const delivery = productionTelegramDelivery(
      async (_update, input) => {
        attempts.push(input);
        return { status: "session_not_active" };
      },
      {
        marked: false,
        observeResponse: (response) => {
          responseStatus = response.status;
        },
      },
    );
    assert.equal(
      await delivery(hitlCallbackUpdate(1104)),
      TELEGRAM_CLOSED_SESSION_KIND,
    );
  } finally {
    console.error = priorError;
  }

  assert.equal(responseStatus, 409);
  assert.equal(attempts.length, 1);
  assert.equal(inputResponsesOf(attempts[0]).length, 1);
});

test("a failed HITL callback response returns 503 through the production route", async () => {
  let responseStatus: number | undefined;
  const priorError = console.error;
  console.error = () => {};
  try {
    const delivery = productionTelegramDelivery(
      async (_update, input) => {
        assert.equal(inputResponsesOf(input).length, 1);
        throw new Error("HITL delivery failed");
      },
      {
        marked: false,
        observeResponse: (response) => {
          responseStatus = response.status;
        },
      },
    );
    assert.equal(await delivery(hitlCallbackUpdate(1105)), false);
  } finally {
    console.error = priorError;
  }

  assert.equal(responseStatus, 503);
});

test("an ordinary send failure stays transient and never claims the closed-session class", async () => {
  let attempts = 0;
  const priorError = console.error;
  console.error = () => {};
  try {
    const delivery = productionTelegramDelivery(
      async () => {
        attempts++;
        throw new Error("eve is restarting");
      },
      { sessionEvents: [] },
    );
    assert.equal(
      await delivery(replyToBotUpdate(1103, "и что дальше?")),
      false,
    );
  } finally {
    console.error = priorError;
  }
  assert.equal(attempts, 1, "транзиентный сбой не перемаршрутизируется");
});

test("POISON completed ledger retains good ids while removing only bad entries", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-poison-ledger-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const completedUpdatesFile = join(root, "completed.json");
  writeFileSync(
    completedUpdatesFile,
    JSON.stringify({
      botId: "999",
      updates: [701, null, -1, "private id", {}, 702],
    }),
  );
  let sends = 0;
  const logs: string[] = [];
  t.mock.method(console, "error", (...parts: unknown[]) =>
    logs.push(parts.map(String).join(" ")),
  );
  const delivery = productionTelegramDelivery(
    async () => ({ id: `accepted-${++sends}` }),
    { completedUpdatesFile },
  );
  for (const id of [701, 702, 701])
    assert.equal(await delivery(privateUpdate(id, "duplicate")), "handled");
  assert.equal(sends, 0);
  assert.deepEqual(JSON.parse(readFileSync(completedUpdatesFile, "utf8")), {
    botId: "999",
    updates: [701, 702],
  });
  assert.ok(logs.length > 0);
  assert.ok(logs.every((line) => !line.includes("private id")));
  const copies = readdirSync(root).filter((name) => name.includes(".damaged-"));
  assert.equal(copies.length, 4);
  assert.deepEqual(
    copies
      .map(
        (name) =>
          (
            JSON.parse(readFileSync(join(root, name), "utf8")) as {
              record: unknown;
            }
          ).record,
      )
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [null, -1, "private id", {}].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
  );
  assert.equal(await delivery(privateUpdate(703, "new")), true);
  assert.equal(sends, 1);
  assert.deepEqual(JSON.parse(readFileSync(completedUpdatesFile, "utf8")), {
    botId: "999",
    updates: [701, 702, 703],
  });
});
