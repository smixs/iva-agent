import { mock } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type JsonRecord = Record<string, unknown>;
type Message = {
  message_id: number;
  date: number;
  chat: { id: number; type: string; [key: string]: unknown };
  from: { id: number; is_bot: boolean; first_name: string };
  text?: string;
  reply_to_message?: Message;
  [key: string]: unknown;
};
type Update = {
  update_id: number;
  message?: Message;
  callback_query?: { id: string; message: Message; [key: string]: unknown };
  [key: string]: unknown;
};
type MessageUpdate = Update & { message: Message };
type ChatStatus = {
  status: string;
  [key: string]: string | number | null | undefined;
};
type RunStatusModule = {
  setChatStatus: (chatKey: string, status: ChatStatus) => void;
  getChatStatus: (chatKey: string) => ChatStatus;
  isRunning: (chatKey: string) => boolean;
};
type FetchOptions = { body?: string; signal?: AbortSignal };
type FileOperation = (...args: unknown[]) => Promise<unknown>;
type SyncHandle = {
  sync: () => Promise<void>;
  close: () => Promise<void>;
};

const [modeArg, dataDirArg, fault = "none"] = process.argv.slice(2);
if (!modeArg || !dataDirArg)
  throw new Error("usage: harness <mode> <data-dir> [fault]");
const mode = modeArg;
const dataDir = dataDirArg;

process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.ASSISTANT_HOST = "http://iva-red.invalid";
process.env.TELEGRAM_BOT_TOKEN = "73002:test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "test-secret";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.TELEGRAM_POLL_SETTLE_MS = "0";
process.env.TELEGRAM_COLLECT_QUIET_MS ??= "0";
process.env.AGENT_LANGUAGE = "en";
process.env.ASSISTANT_VAULT_DIR = join(dataDir, "vault");

mkdirSync(dataDir, { recursive: true });
const offsetFile = join(dataDir, "telegram-offset.json");
const queueFile = join(dataDir, "telegram-queue.json");
const inboxFile = join(dataDir, "telegram-inbox.json");
const resultFile = join(dataDir, "queue-harness-result.json");
if (!existsSync(offsetFile))
  writeFileSync(offsetFile, JSON.stringify({ offset: 100 }));
let queueDirSyncAttempts = 0;
let queueDirSyncSuccesses = 0;
let inboxWriteAttempts = 0;
let inboxDirectorySyncArmed = false;
const inboxOwnershipStages = new Set<string>();

const statusModulePath = "#lib/run-status.ts";
const status = (await import(statusModulePath)) as RunStatusModule;
const privateKey = "1:";
const groupKey = "-100:";
const topicKey = "-100:7";

if (
  mode === "disk-failure" ||
  mode === "dir-sync-retry" ||
  mode === "auto-drain" ||
  mode === "collect-burst" ||
  mode === "burst-ownership-crash" ||
  mode === "restart-persist" ||
  mode === "routing"
) {
  status.setChatStatus(privateKey, {
    status: "running",
    sessionId: "session-1",
    turnId: "turn-1",
  });
} else if (mode === "restart-drain") {
  status.setChatStatus(privateKey, {
    status: "idle",
    sessionId: null,
    turnId: null,
    draftId: null,
    ingressId: null,
    ingressAt: null,
  });
} else if (mode === "direct-retry" || mode === "closed-session") {
  status.setChatStatus(privateKey, {
    status: "idle",
    sessionId: null,
    turnId: null,
    draftId: null,
    ingressId: null,
    ingressAt: null,
  });
} else if (
  mode === "core-distill-ownership-crash" ||
  mode === "core-distill-write-failure" ||
  mode === "core-distill-eio-retry" ||
  mode === "core-distill-eio-crash" ||
  mode === "core-distill-eio-restart"
) {
  status.setChatStatus(privateKey, {
    status: "idle",
    sessionId: null,
    turnId: null,
    draftId: null,
    ingressId: null,
    ingressAt: null,
  });
}
if (mode === "group-noise" || mode === "routing") {
  status.setChatStatus(groupKey, {
    status: "running",
    sessionId: "session-group",
    turnId: "turn-group",
  });
}
if (mode === "routing") {
  status.setChatStatus(topicKey, {
    status: "running",
    sessionId: "session-topic",
    turnId: "turn-topic",
  });
}

if (fault !== "none") {
  const fsPromises = await import("node:fs/promises");
  const namedExports = Object.fromEntries(
    Object.entries(fsPromises).filter(([name]) => name !== "default"),
  ) as Record<string, unknown>;
  const originalWriteFile = fsPromises.writeFile as unknown as FileOperation;
  const originalRename = fsPromises.rename as unknown as FileOperation;
  const originalOpen = fsPromises.open as unknown as FileOperation;
  namedExports.writeFile = async (path: unknown, ...args: unknown[]) => {
    if (String(path).startsWith(`${inboxFile}.tmp-`)) {
      inboxWriteAttempts++;
      const staged = JSON.parse(String(args[0])) as {
        queues?: Record<string, unknown[]>;
      };
      if (
        Object.values(staged.queues ?? {}).some((items) => items.length > 0)
      ) {
        inboxOwnershipStages.add(String(path));
      }
    }
    if (fault === "write" && String(path).startsWith(`${inboxFile}.tmp-`)) {
      throw Object.assign(new Error("injected inbox write failure"), {
        code: "ENOSPC",
      });
    }
    if (
      fault === "write-once" &&
      inboxWriteAttempts === 1 &&
      String(path).startsWith(`${inboxFile}.tmp-`)
    ) {
      throw Object.assign(new Error("injected one-shot inbox write failure"), {
        code: "EIO",
      });
    }
    return originalWriteFile(path, ...args);
  };
  namedExports.rename = async (
    from: unknown,
    to: unknown,
    ...args: unknown[]
  ) => {
    if (fault === "rename" && String(to) === inboxFile) {
      throw Object.assign(new Error("injected inbox rename failure"), {
        code: "EIO",
      });
    }
    const ownsMessage = inboxOwnershipStages.delete(String(from));
    const result = await originalRename(from, to, ...args);
    if (
      (fault === "dir-sync-once" || fault === "hold-after-inbox-sync") &&
      String(to) === inboxFile &&
      ownsMessage
    ) {
      inboxDirectorySyncArmed = true;
    }
    return result;
  };
  namedExports.open = async (
    path: unknown,
    flags: unknown,
    ...args: unknown[]
  ) => {
    const handle = (await originalOpen(path, flags, ...args)) as SyncHandle;
    if (
      (fault !== "dir-sync-once" && fault !== "hold-after-inbox-sync") ||
      String(path) !== dataDir ||
      flags !== "r" ||
      !inboxDirectorySyncArmed
    ) {
      return handle;
    }
    inboxDirectorySyncArmed = false;
    return {
      sync: async () => {
        queueDirSyncAttempts++;
        if (fault === "hold-after-inbox-sync") {
          await handle.sync();
          queueDirSyncSuccesses++;
          writeFileSync(
            join(dataDir, "core-distill-ownership-ready"),
            "ready\n",
          );
          return new Promise<void>(() => {});
        }
        if (queueDirSyncAttempts === 1) {
          throw Object.assign(
            new Error("injected queue directory sync failure"),
            {
              code: "EIO",
            },
          );
        }
        await handle.sync();
        queueDirSyncSuccesses++;
      },
      close: () => handle.close(),
    };
  };
  mock.module("node:fs/promises", {
    defaultExport: fsPromises.default,
    namedExports,
  });
}

if (mode === "callback-rejected" || mode === "callback-rejected-crash") {
  mock.module("../poller/routing.ts", {
    namedExports: {
      deliverDirectUpdate: () => Promise.resolve("delivered"),
      drainReadyQueueHeads: () => Promise.resolve(0),
      routeMessageUpdate: () => Promise.resolve("rejected"),
    },
  });
}

const privateUpdate = (
  updateId: number,
  text: string,
  chatId = 1,
): MessageUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1,
    chat: { id: chatId, type: "private" },
    from: { id: 42, is_bot: false, first_name: "Owner" },
    text,
  },
});
const replyToBotUpdate = (updateId: number, text: string): Update => {
  const update = privateUpdate(updateId, text);
  update.message.reply_to_message = {
    message_id: updateId - 1,
    date: 1,
    chat: update.message.chat,
    from: { id: 999, is_bot: true, first_name: "Iva" },
    text: "previous bot reply",
  };
  return update;
};
// eve's own callback data (eve: prefix) stays a callback on the webhook route; any other
// data is a model-written button that the bridge rewrites into a message (control.ts).
const callbackUpdate = {
  update_id: 101,
  callback_query: {
    id: "foreign-callback-101",
    from: { id: 42, is_bot: false, first_name: "Owner" },
    message: privateUpdate(100, "button owner").message,
    data: "eve:foreign_callback",
  },
};
const buttonTapUpdate = {
  ...callbackUpdate,
  callback_query: {
    ...callbackUpdate.callback_query,
    id: "button-tap-101",
    data: "Remind me in an hour",
  },
};
const coreFinishCallbackUpdate = {
  update_id: 101,
  callback_query: {
    id: "core-finish-callback-101",
    from: { id: 42, is_bot: false, first_name: "Owner" },
    message: privateUpdate(100, "core menu").message,
    data: "iva_menu:core:fin",
  },
};
const inlineCallbackUpdate = {
  update_id: 101,
  callback_query: {
    id: "foreign-inline-callback-101",
    from: { id: 42, is_bot: false, first_name: "Owner" },
    inline_message_id: "inline-message-101",
    data: "eve:foreign_inline_callback",
  },
};
const unauthorizedCallbackUpdate = {
  ...callbackUpdate,
  callback_query: {
    ...callbackUpdate.callback_query,
    id: "unauthorized-callback-101",
    from: { id: 99, is_bot: false, first_name: "Stranger" },
  },
};
const unownableCallbackUpdate = {
  update_id: 101,
  callback_query: {
    id: "unownable-callback-101",
    from: { id: 42, is_bot: false, first_name: "Owner" },
    data: "eve:foreign_callback",
  },
};
const groupNoiseUpdate = {
  update_id: 102,
  message: {
    message_id: 102,
    date: 1,
    chat: { id: -100, type: "supergroup", title: "Test group" },
    from: { id: 42, is_bot: false, first_name: "Owner" },
    text: "side conversation, not addressed to Iva",
  },
};
const groupUpdate = (
  updateId: number,
  text: string,
  threadId?: number,
): Update => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1,
    chat: { id: -100, type: "supergroup", title: "Test group" },
    from: { id: 42, is_bot: false, first_name: "Owner" },
    text,
    ...(threadId === undefined ? {} : { message_thread_id: threadId }),
  },
});

const deliveries: Update[] = [];
const deliveryRoutes: string[] = [];
const reactions: JsonRecord[] = [];
const queueStatuses: JsonRecord[] = [];
const failureNotices: JsonRecord[] = [];
const deletedMessages: JsonRecord[] = [];
const requestedOffsets: number[] = [];
let getUpdatesCalls = 0;
let directAcceptanceAttempts = 0;
// Файл очереди в момент, когда ход кончается: склейку делает слив, а не коллектор входа.
let queueBeforeIdle: unknown = null;
let statusBeforeRetry: ChatStatus | null = null;

// Ответ eve на reply в закрытую сессию: тот же заголовок приёмки, но терминальный класс.
const closedSessionResponse = () => ({
  ok: false,
  status: 409,
  headers: {
    get: (name: string) =>
      String(name).toLowerCase() === "x-iva-telegram-acceptance"
        ? "closed-session"
        : null,
  },
  body: null,
  json: () => Promise.resolve({}),
});

const jsonResponse = (payload: unknown, statusCode = 200) => ({
  ok: statusCode >= 200 && statusCode < 300,
  status: statusCode,
  headers: {
    get: (name: string) =>
      statusCode === 204 &&
      String(name).toLowerCase() === "x-iva-telegram-acceptance"
        ? "turn"
        : null,
  },
  body: null,
  json: () => Promise.resolve(payload),
});

function readJson(path: string, fallback: unknown): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return fallback;
  }
}

function finish() {
  writeFileSync(
    resultFile,
    JSON.stringify({
      deliveries,
      deliveryRoutes,
      reactions,
      queueStatuses,
      failureNotices,
      deletedMessages,
      requestedOffsets,
      queueDirSyncAttempts,
      queueDirSyncSuccesses,
      statusBeforeRetry,
      queueBeforeIdle,
      finalStatus: status.getChatStatus(privateKey),
      offset: readJson(offsetFile, null),
      queue: readJson(queueFile, { version: 1, queues: {} }),
      inbox: readJson(inboxFile, { version: 1, queues: {} }),
    }),
  );
  process.exit(0);
}

if (mode === "fair-drain") {
  writeFileSync(
    queueFile,
    JSON.stringify({
      version: 1,
      queues: {
        "1:": [
          {
            version: 1,
            updateId: 101,
            enqueuedAt: 1,
            update: privateUpdate(101, "poison head", 1),
          },
        ],
        "2:": [
          {
            version: 1,
            updateId: 102,
            enqueuedAt: 2,
            update: privateUpdate(102, "healthy head", 2),
          },
        ],
      },
    }),
  );
}

const fetchHarness = async (url: unknown, options: FetchOptions = {}) => {
  const target = String(url);
  if (target.startsWith("http://iva-red.invalid/")) {
    const deliveryRoute = new URL(target).pathname;
    deliveryRoutes.push(deliveryRoute);
    const delivery = JSON.parse(options.body ?? "{}") as unknown as Update;
    deliveries.push(delivery);
    if (
      mode === "fair-drain" &&
      new URL(target).pathname === "/eve/v1/telegram/accepted" &&
      delivery.message?.chat?.id === 1
    ) {
      return jsonResponse({}, 503);
    }
    if (
      mode === "closed-session" &&
      deliveryRoute === "/eve/v1/telegram/accepted"
    ) {
      directAcceptanceAttempts++;
      status.setChatStatus(privateKey, {
        status: "running",
        ingressId: "33333333333333333333333333333333",
        ingressAt: Date.now(),
        draftId: 79,
        sessionId: null,
        turnId: null,
      });
      return closedSessionResponse();
    }
    if (
      mode === "direct-retry" &&
      deliveryRoute === "/eve/v1/telegram/accepted"
    ) {
      directAcceptanceAttempts++;
      if (directAcceptanceAttempts === 1) {
        status.setChatStatus(privateKey, {
          status: "running",
          ingressId: "11111111111111111111111111111111",
          ingressAt: Date.now(),
          draftId: 77,
          sessionId: null,
          turnId: null,
        });
        return jsonResponse({}, 503);
      }
      statusBeforeRetry = status.getChatStatus(privateKey);
      status.setChatStatus(privateKey, {
        status: "running",
        sessionId: `session-${delivery.update_id}`,
        turnId: `turn-${delivery.update_id}`,
      });
    }
    if (
      (mode === "direct-timeout" ||
        mode === "direct-timeout-twice" ||
        mode === "core-distill-ownership-crash" ||
        mode === "core-distill-write-failure" ||
        mode === "core-distill-eio-retry" ||
        mode === "core-distill-eio-crash") &&
      deliveryRoute === "/eve/v1/telegram/accepted"
    ) {
      directAcceptanceAttempts++;
      status.setChatStatus(privateKey, {
        status: "running",
        ingressId: "22222222222222222222222222222222",
        ingressAt: Date.now(),
        draftId: 78,
        sessionId: null,
        turnId: null,
      });
      return new Promise((_resolve, reject) => {
        // AbortSignal.timeout() uses an unref'd timer; keep this subprocess alive
        // long enough for the mocked hung request to observe the real abort signal.
        const keepAlive = setTimeout(
          () => reject(new Error("direct acceptance abort was not observed")),
          Number(process.env.TELEGRAM_DIRECT_ACCEPTANCE_TIMEOUT_MS) + 1_000,
        );
        const rejectTimeout = () => {
          clearTimeout(keepAlive);
          reject(
            options.signal?.reason instanceof Error
              ? options.signal.reason
              : Object.assign(new Error("direct acceptance timed out"), {
                  name: "TimeoutError",
                }),
          );
        };
        if (options.signal?.aborted) {
          rejectTimeout();
          return;
        }
        options.signal?.addEventListener("abort", rejectTimeout, {
          once: true,
        });
      });
    }
    if (
      (mode === "auto-drain" ||
        mode === "collect-burst" ||
        mode === "restart-drain") &&
      deliveryRoute === "/eve/v1/telegram/accepted"
    ) {
      status.setChatStatus(privateKey, {
        status: "running",
        sessionId: `session-${delivery.update_id}`,
        turnId: `turn-${delivery.update_id}`,
      });
    }
    return jsonResponse(
      {},
      deliveryRoute === "/eve/v1/telegram/accepted" ? 204 : 200,
    );
  }

  const method = new URL(target).pathname.split("/").at(-1);
  const body = options.body
    ? (JSON.parse(options.body) as unknown as JsonRecord)
    : {};
  if (method === "getUpdates") {
    getUpdatesCalls++;
    requestedOffsets.push(
      typeof body.offset === "number" ? body.offset : Number.NaN,
    );

    if (mode === "disk-failure") {
      if (getUpdatesCalls === 1)
        return jsonResponse({
          ok: true,
          result: [privateUpdate(101, "persist me")],
        });
      finish();
    }
    if (mode === "dir-sync-retry") {
      if (getUpdatesCalls <= 2) {
        return jsonResponse({
          ok: true,
          result: [privateUpdate(101, "persist me")],
        });
      }
      finish();
    }
    if (mode === "auto-drain") {
      // Три сообщения приходят тремя вызовами getUpdates, пока чат занят ходом.
      const texts = ["first", "second", "third"];
      if (getUpdatesCalls <= texts.length) {
        return jsonResponse({
          ok: true,
          result: [
            privateUpdate(100 + getUpdatesCalls, texts[getUpdatesCalls - 1]),
          ],
        });
      }
      if (getUpdatesCalls === texts.length + 1) {
        queueBeforeIdle = readJson(queueFile, null);
        status.setChatStatus(privateKey, {
          status: "idle",
          sessionId: null,
          turnId: null,
          draftId: null,
          ingressId: null,
          ingressAt: null,
        });
      }
      if (getUpdatesCalls > texts.length + 1 && status.isRunning(privateKey)) {
        status.setChatStatus(privateKey, {
          status: "idle",
          sessionId: null,
          turnId: null,
          draftId: null,
          ingressId: null,
          ingressAt: null,
        });
      }
      if (getUpdatesCalls >= 8) finish();
      return jsonResponse({ ok: true, result: [] });
    }
    if (mode === "collect-burst") {
      if (getUpdatesCalls === 1) {
        return jsonResponse({
          ok: true,
          result: [privateUpdate(101, "first"), privateUpdate(102, "second")],
        });
      }
      if (getUpdatesCalls === 2) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
      }
      if (
        getUpdatesCalls === 3 ||
        (getUpdatesCalls > 3 && status.isRunning(privateKey))
      ) {
        status.setChatStatus(privateKey, {
          status: "idle",
          sessionId: null,
          turnId: null,
          draftId: null,
          ingressId: null,
          ingressAt: null,
        });
      }
      if (getUpdatesCalls >= 5) finish();
      return jsonResponse({ ok: true, result: [] });
    }
    if (mode === "burst-ownership-crash") {
      if (getUpdatesCalls === 1) {
        return jsonResponse({
          ok: true,
          result: [privateUpdate(101, "first"), privateUpdate(102, "second")],
        });
      }
      writeFileSync(join(dataDir, "ownership-ready"), "ready\n");
      return new Promise(() => {
        setInterval(() => {}, 60_000);
      });
    }
    if (mode === "restart-persist") {
      if (getUpdatesCalls === 1) {
        return jsonResponse({
          ok: true,
          result: [privateUpdate(101, "first"), privateUpdate(102, "second")],
        });
      }
      finish();
    }
    if (mode === "restart-drain") {
      if (status.isRunning(privateKey)) {
        status.setChatStatus(privateKey, {
          status: "idle",
          sessionId: null,
          turnId: null,
          draftId: null,
          ingressId: null,
          ingressAt: null,
        });
      }
      if (getUpdatesCalls >= 6) finish();
      return jsonResponse({ ok: true, result: [] });
    }
    if (mode === "group-noise") {
      if (getUpdatesCalls === 1)
        return jsonResponse({ ok: true, result: [groupNoiseUpdate] });
      finish();
    }
    if (mode === "routing") {
      if (getUpdatesCalls === 1) {
        return jsonResponse({
          ok: true,
          result: [
            privateUpdate(101, "private follow-up"),
            groupNoiseUpdate,
            groupUpdate(103, "@my_bot group follow-up"),
            groupUpdate(104, "/task topic follow-up", 7),
          ],
        });
      }
      finish();
    }
    if (
      mode === "direct-success" ||
      mode === "direct-retry" ||
      mode === "closed-session" ||
      mode === "direct-timeout" ||
      mode === "direct-timeout-twice"
    ) {
      if (getUpdatesCalls === 1) {
        return jsonResponse({
          ok: true,
          result: [
            mode === "direct-retry" || mode === "closed-session"
              ? replyToBotUpdate(101, "direct reply")
              : privateUpdate(101, "direct message"),
          ],
        });
      }
      // Ещё один пустой проход: терминальный апдейт обязан не вернуться в доставку.
      if (mode === "closed-session" && getUpdatesCalls === 2) {
        return jsonResponse({ ok: true, result: [] });
      }
      if (mode === "direct-timeout-twice" && getUpdatesCalls === 2) {
        return jsonResponse({ ok: true, result: [] });
      }
      finish();
    }
    if (mode === "restart-direct-drain" || mode === "restart-callback-drain")
      finish();
    if (
      mode === "inline-callback" ||
      mode === "unauthorized-callback" ||
      mode === "unownable-callback"
    ) {
      if (getUpdatesCalls === 1) {
        return jsonResponse({
          ok: true,
          result: [
            mode === "inline-callback"
              ? inlineCallbackUpdate
              : mode === "unauthorized-callback"
                ? unauthorizedCallbackUpdate
                : unownableCallbackUpdate,
          ],
        });
      }
      finish();
    }
    if (
      mode === "callback" ||
      mode === "button-tap" ||
      mode === "callback-rejected" ||
      mode === "callback-rejected-crash"
    ) {
      if (getUpdatesCalls === 1) {
        return jsonResponse({
          ok: true,
          result: [mode === "button-tap" ? buttonTapUpdate : callbackUpdate],
        });
      }
      if (mode === "callback-rejected-crash") {
        writeFileSync(join(dataDir, "callback-rejected-ready"), "ready\n");
        return new Promise(() => {
          setInterval(() => {}, 60_000);
        });
      }
      finish();
    }
    if (
      mode === "core-distill-ownership-crash" ||
      mode === "core-distill-write-failure"
    ) {
      if (getUpdatesCalls === 1) {
        return jsonResponse({ ok: true, result: [coreFinishCallbackUpdate] });
      }
      if (mode === "core-distill-write-failure") finish();
      writeFileSync(join(dataDir, "core-distill-ownership-ready"), "ready\n");
      return new Promise(() => {
        setInterval(() => {}, 60_000);
      });
    }
    if (mode === "core-distill-eio-retry") {
      if (getUpdatesCalls <= 3) {
        return jsonResponse({ ok: true, result: [coreFinishCallbackUpdate] });
      }
      finish();
    }
    if (mode === "core-distill-eio-crash") {
      if (getUpdatesCalls === 1) {
        return jsonResponse({ ok: true, result: [coreFinishCallbackUpdate] });
      }
      writeFileSync(join(dataDir, "core-distill-eio-ready"), "ready\n");
      return new Promise(() => {
        setInterval(() => {}, 60_000);
      });
    }
    if (mode === "core-distill-eio-restart") {
      if (getUpdatesCalls === 1) {
        return jsonResponse({ ok: true, result: [coreFinishCallbackUpdate] });
      }
      finish();
    }
    if (mode === "fair-drain") finish();
    throw new Error(`unknown harness mode: ${mode}`);
  }
  if (method === "setMessageReaction") reactions.push(body);
  const bodyText = typeof body.text === "string" ? body.text : "";
  if (method === "sendMessage" && /^Queued \(\d+\)/.test(bodyText)) {
    queueStatuses.push(body);
  }
  if (
    method === "sendMessage" &&
    bodyText === "Couldn't process the message - repeat it or use /new"
  ) {
    failureNotices.push(body);
  }
  if (method === "deleteMessage") deletedMessages.push(body);
  return jsonResponse({ ok: true, result: { message_id: 1 } });
};
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: fetchHarness,
  writable: true,
});

if (
  mode === "core-distill-ownership-crash" ||
  mode === "core-distill-write-failure" ||
  mode === "core-distill-eio-retry" ||
  mode === "core-distill-eio-crash"
) {
  const { flows } = await import("../poller/wizards.ts");
  const state = flows.start(1, "42", "menu", {
    screen: "core",
    page: 0,
    msgId: 100,
  });
  state.data = {
    iv: {
      i: 1,
      qa: [{ q: "How should I address you?", a: "Sergey" }],
      chat: { id: 1, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Owner" },
      threadId: null,
    },
  };
  state.awaitText = { kind: "interview", secret: false, data: {} };
}

const testGuardIdentity = `queue-harness-${process.pid}`;
const { main } = (await import(
  `../poller/main.ts?harness=${process.pid}`
)) as unknown as {
  main: (options: {
    acquireProcessLockImpl: () => Promise<unknown>;
  }) => Promise<void>;
};
const { acquireTelegramProcessLock } =
  (await import("../poller/process-lock.ts")) as unknown as {
    acquireTelegramProcessLock: (options: {
      testGuard: { identity: string; directory: string };
    }) => Promise<unknown>;
  };
await main({
  acquireProcessLockImpl: () =>
    acquireTelegramProcessLock({
      testGuard: {
        identity: testGuardIdentity,
        directory: join(dataDir, ".telegram-process-test-guard"),
      },
    }),
});
