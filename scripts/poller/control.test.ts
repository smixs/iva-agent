/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node owns test registration; async doubles preserve the I/O boundary. */
import assert from "node:assert/strict";
import {
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
  TELEGRAM_BUTTON_TAP_FIELD,
  TELEGRAM_BUTTON_TAP_DAILY_TEXT_FIELD,
} from "#lib/telegram-parts.ts";

type Event = string | [string, string, number | undefined, string | undefined];
type CaptureMessage = { message_id?: number };
type CaptureState = { flow: unknown; awaitText?: unknown };
type CancelCall = {
  url: string;
  secret: string;
  sessionId: string;
  turnId?: string;
};
type ControlUpdate = Record<string, unknown>;
type ControlModule = {
  applyTelegramButtonTap: (
    update: ControlUpdate,
    callback: Record<string, unknown>,
  ) => boolean;
  handleAwaitNonText: (
    message: CaptureMessage & Record<string, unknown>,
    pending: CaptureState,
    io: Record<string, unknown>,
  ) => Promise<boolean>;
  handleControl: (
    update: ControlUpdate,
    deps?: {
      replyImpl?: (
        chatId: number | undefined,
        text: string,
      ) => Promise<{ message_id: number } | null>;
      ackImpl?: (id: string, text?: string) => Promise<unknown>;
      cancelImpl?: (input: CancelCall) => Promise<unknown>;
      confirmTimeoutMs?: number;
      performResetImpl?: (
        chatKey: string,
        target: Record<string, unknown>,
        options: {
          clearQueue?: boolean;
          discardThroughUpdateId?: number;
        },
      ) => Promise<unknown>;
      resetRetryPendingImpl?: (chatKey: string) => boolean;
      resetIntentPendingImpl?: (chatKey: string) => boolean;
      pluginTapImpl?: (tap: {
        digest12: string;
        chatId: number;
      }) => Promise<unknown>;
      scheduleImpl?: (key: string, task: () => Promise<void>) => boolean;
      deleteImpl?: (chatId: number, messageId: number) => Promise<boolean>;
      editTapImpl?: (
        chatId: number,
        messageId: number,
        edit: unknown,
      ) => Promise<boolean>;
    },
  ) => Promise<boolean>;
  OUT_OF_BAND_COMMANDS: string[];
  TELEGRAM_EVE_CALLBACK_PREFIXES: readonly string[];
  TAP_CONTEXT_LIMIT: number;
  tapContextText: (message: Record<string, unknown> | undefined) => string;
};
type RunStatusModule = {
  setChatStatus: (chatKey: string, patch: Record<string, unknown>) => void;
  getChatStatus: (chatKey: string) => Record<string, unknown> | undefined;
};
type QueueModule = {
  reapStaleRuns: (options?: Record<string, unknown>) => Promise<number>;
  clearPrivateResetIntent: (chatKey: string) => Promise<void>;
  loadPrivateResetIntents: () => Promise<
    Array<{ chatKey: string; discardThroughUpdateId?: number }>
  >;
  performScopedReset: (
    chatKey: string,
    target: Record<string, unknown>,
    options: {
      clearQueue?: boolean;
      requestResetImpl?: () => Promise<unknown>;
      persistIntentImpl?: () => Promise<unknown>;
      retryAfterMs?: number;
    },
  ) => Promise<unknown>;
};
type MainModule = {
  handleControlSafely: (
    update: ControlUpdate,
    deps: {
      handleControlImpl: (update: ControlUpdate) => Promise<boolean>;
      logImpl: (...args: unknown[]) => void;
    },
  ) => Promise<boolean | "retry">;
};
type FlowState = Record<string, unknown>;
type WizardsModule = {
  flows: {
    start: (
      chatId: number,
      userId: string,
      flow: string,
      extra: Record<string, unknown>,
    ) => FlowState;
    get: (chatId: number, userId: string) => FlowState | null;
  };
};

// Мост читает run-status с диска и берёт allowlist из окружения на импорте, поэтому
// и то и другое ставим ДО загрузки модуля, в свежей data-директории.
const dataDir = mkdtempSync(join(tmpdir(), "iva-control-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
// Экраны моста в тестах проверяются в rich-стиле (по умолчанию у пользователя classic).
writeFileSync(
  join(dataDir, "settings.json"),
  JSON.stringify({ menuStyle: "rich" }),
);
process.env.TELEGRAM_BOT_TOKEN = "424242:test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "test-secret";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42,7";
process.env.IVA_PORT = "8723";
delete process.env.ASSISTANT_HOST;
delete process.env.AGENT_LANGUAGE; // без настроек язык моста — ru

const [controlModule, runStatusModule, wizardsModule, queueModule, mainModule] =
  (await Promise.all([
    import(`./control.ts?control-test=${Date.now()}`),
    import(`#lib/run-status.ts?control-test=${Date.now()}`),
    import("./wizards.ts"),
    import("./queue.ts"),
    import("./main.ts"),
  ])) as [unknown, unknown, unknown, unknown, unknown];
const {
  applyTelegramButtonTap,
  handleAwaitNonText,
  handleControl,
  OUT_OF_BAND_COMMANDS,
  TAP_CONTEXT_LIMIT,
  tapContextText,
  TELEGRAM_EVE_CALLBACK_PREFIXES,
} = controlModule as ControlModule;
const status = runStatusModule as RunStatusModule;
const { flows } = wizardsModule as WizardsModule;
const queue = queueModule as QueueModule;
const main = mainModule as MainModule;

const CANCEL_ROUTE = "http://127.0.0.1:8723/eve/v1/telegram/cancel";
const trustedFrom = { id: 42, is_bot: false };
const chat = { id: 7, type: "private" };

function runningTurn(overrides: Record<string, unknown> = {}) {
  status.setChatStatus("7:", {
    status: "running",
    sessionId: "session-1",
    turnId: "turn-1",
    draftId: 41,
    wasCancelled: null,
    ...overrides,
  });
}

function nativeStop(): ControlUpdate {
  return { update_id: 5, stopped_message_generation: { chat, draft_id: 41 } };
}

function stopButton(): ControlUpdate {
  return {
    update_id: 5,
    callback_query: {
      id: "cq-5",
      from: trustedFrom,
      message: { message_id: 4, date: 1, chat },
      data: "iva_cancel",
    },
  };
}

function stopCommand(): ControlUpdate {
  return {
    update_id: 6,
    message: {
      message_id: 6,
      date: 1,
      chat,
      from: trustedFrom,
      text: "/stop",
    },
  };
}

test("a second /new during reset backoff is consumed without pinning offset", async () => {
  const firstReplies: string[] = [];
  const first = await handleControl(
    {
      update_id: 7,
      message: {
        message_id: 7,
        date: 1,
        chat,
        from: trustedFrom,
        text: "/new",
      },
    },
    {
      replyImpl: async (_chatId, text) => {
        firstReplies.push(text);
        return null;
      },
      performResetImpl: (key, target, options) =>
        queue.performScopedReset(key, target, {
          ...options,
          requestResetImpl: async () => {
            throw new Error("eve reset timed out");
          },
        }),
    },
  );
  assert.equal(first, true);
  assert.equal(firstReplies.length, 1);
  assert.equal(
    (await queue.loadPrivateResetIntents())[0]?.discardThroughUpdateId,
    7,
  );

  const secondReplies: string[] = [];
  let resetAttempts = 0;
  const second = await main.handleControlSafely(
    {
      update_id: 8,
      message: {
        message_id: 8,
        date: 1,
        chat,
        from: trustedFrom,
        text: "/new",
      },
    },
    {
      handleControlImpl: (update) =>
        handleControl(update, {
          replyImpl: async (_chatId, text) => {
            secondReplies.push(text);
            return null;
          },
          performResetImpl: async () => {
            resetAttempts += 1;
          },
        }),
      logImpl: () => {},
    },
  );

  assert.equal(second, true);
  assert.equal(resetAttempts, 0);
  assert.equal(secondReplies.length, 1);
  assert.match(secondReplies[0] ?? "", /повтор.+запланирован/iu);
  await queue.clearPrivateResetIntent("7:");
});

test("an intent-write backoff holds the offset without another status message", async () => {
  const update = {
    update_id: 9,
    message: {
      message_id: 9,
      date: 1,
      chat,
      from: trustedFrom,
      text: "/new",
    },
  };
  const first = await main.handleControlSafely(update, {
    handleControlImpl: (candidate) =>
      handleControl(candidate, {
        replyImpl: () => Promise.resolve(null),
        performResetImpl: (key, target, options) =>
          queue.performScopedReset(key, target, {
            ...options,
            persistIntentImpl: () => Promise.reject(new Error("disk full")),
          }),
      }),
    logImpl: () => {},
  });
  assert.equal(first, "retry");

  const secondReplies: string[] = [];
  let resetAttempts = 0;
  const second = await main.handleControlSafely(update, {
    handleControlImpl: (candidate) =>
      handleControl(candidate, {
        replyImpl: (_chatId, text) => {
          secondReplies.push(text);
          return Promise.resolve(null);
        },
        performResetImpl: () => {
          resetAttempts += 1;
          return Promise.resolve();
        },
      }),
    logImpl: () => {},
  });

  assert.equal(second, "retry");
  assert.equal(resetAttempts, 0);
  assert.deepEqual(secondReplies, []);
  await queue.clearPrivateResetIntent("7:");
});

test("persistent intent-write failure escalates and releases the global offset", async () => {
  const update = {
    update_id: 10,
    message: {
      message_id: 10,
      date: 1,
      chat,
      from: trustedFrom,
      text: "/new",
    },
  };
  const results: Array<boolean | "retry"> = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    results.push(
      await main.handleControlSafely(update, {
        handleControlImpl: (candidate) =>
          handleControl(candidate, {
            replyImpl: () => Promise.resolve(null),
            performResetImpl: (key, target, options) =>
              queue.performScopedReset(key, target, {
                ...options,
                persistIntentImpl: () =>
                  Promise.reject(new Error("disk remains read-only")),
                retryAfterMs: 0,
              }),
          }),
        logImpl: () => {},
      }),
    );
  }

  assert.deepEqual(results.slice(0, 9), Array(9).fill("retry"));
  assert.equal(results[9], true);
  await queue.clearPrivateResetIntent("7:");
});

function recordingDeps() {
  const cancels: CancelCall[] = [];
  const acks: Array<[string, string | undefined]> = [];
  const replies: Array<[number | undefined, string]> = [];
  return {
    cancels,
    acks,
    replies,
    deps: {
      // Двойник успешного пути: eve принял отмену, а терминальное turn.cancelled
      // переписал запись — то есть ход действительно остановился.
      cancelImpl: async (input: CancelCall) => {
        cancels.push(input);
        stopTurn("7:");
        return { ok: true, status: "accepted" };
      },
      ackImpl: async (id: string, text?: string) => {
        acks.push([id, text]);
        return { ok: true, result: true };
      },
      replyImpl: async (chatId: number | undefined, text: string) => {
        replies.push([chatId, text]);
        return { message_id: replies.length };
      },
    },
  };
}

test("secret document capture deletes before download and never reaches Eve", async () => {
  const events: Event[] = [];
  const io = {
    deleteSecret: async () => {
      events.push("delete");
      return true;
    },
    download: async () => {
      events.push("download");
      return "client secret";
    },
    deliver: async (
      text: string,
      message: CaptureMessage,
      state: CaptureState,
    ) => {
      events.push([
        "deliver",
        text,
        message.message_id,
        (state.awaitText as { kind?: string } | undefined)?.kind,
      ]);
    },
    reply: async () => assert.fail("must not reply after a successful capture"),
  };

  const consumed = await handleAwaitNonText(
    {
      message_id: 7,
      chat: { id: 42 },
      document: { file_id: "file", file_size: 100 },
    },
    { flow: "menu", awaitText: { kind: "gws_client_secret", file: true } },
    io,
  );

  assert.equal(consumed, true);
  assert.deepEqual(events, [
    "delete",
    "download",
    ["deliver", "client secret", 7, "gws_client_secret"],
  ]);
});

test("failed deletion consumes a secret document without downloading it", async () => {
  const events: Event[] = [];
  const consumed = await handleAwaitNonText(
    {
      message_id: 8,
      chat: { id: 42 },
      document: { file_id: "file", file_size: 100 },
    },
    { flow: "menu", awaitText: { kind: "gws_client_secret", file: true } },
    {
      deleteSecret: async () => {
        events.push("delete");
        return false;
      },
      download: async () => assert.fail("must not download a visible secret"),
      deliver: async () => assert.fail("must not deliver a visible secret"),
      reply: async () => assert.fail("deleteSecret owns the failure warning"),
    },
  );

  assert.equal(consumed, true);
  assert.deepEqual(events, ["delete"]);
});

test("the ⏹ Stop button cancels through the channel route, never through Eve", async () => {
  runningTurn();
  const { cancels, acks, replies, deps } = recordingDeps();

  const consumed = await handleControl(nativeStop(), deps);

  assert.equal(consumed, true); // тап съеден мостом и в eve не уходит
  assert.deepEqual(cancels, [
    {
      url: CANCEL_ROUTE,
      secret: "test-secret",
      sessionId: "session-1",
      turnId: "turn-1",
    },
  ]);
  assert.deepEqual(acks, []);
  assert.deepEqual(replies, []);
});

test("the legacy iva_cancel button stays out of the inbox and cancels the recorded pair", async () => {
  runningTurn();
  writeFileSync(
    join(
      dataDir,
      "run-status.d",
      `${Buffer.from("7:").toString("base64url")}.json`,
    ),
    JSON.stringify({ ...status.getChatStatus("7:"), statusMessageId: 4 }),
  );
  const { cancels, acks, deps } = recordingDeps();
  assert.equal(await handleControl(stopButton(), deps), true);
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].sessionId, "session-1");
  assert.equal(cancels[0].turnId, "turn-1");
  assert.equal(status.getChatStatus("7:")?.wasCancelled, true);
  assert.deepEqual(acks, [["cq-5", undefined]]);
});

test("/stop takes the same door and stays silent while the status message speaks", async () => {
  runningTurn({ sessionId: "session-2", turnId: "turn-2" });
  const { cancels, replies, deps } = recordingDeps();

  const consumed = await handleControl(stopCommand(), deps);

  assert.equal(consumed, true);
  assert.deepEqual(cancels, [
    {
      url: CANCEL_ROUTE,
      secret: "test-secret",
      sessionId: "session-2",
      turnId: "turn-2",
    },
  ]);
  // Подтверждение — переписанное «Работаю…», а не второе сообщение в чате.
  assert.deepEqual(replies, []);
});

test("Stop on an idle chat explains itself and never calls cancel", async () => {
  status.setChatStatus("7:", {
    status: "idle",
    sessionId: null,
    turnId: null,
  });
  const { cancels, acks, replies, deps } = recordingDeps();

  assert.equal(await handleControl(nativeStop(), deps), true);
  assert.equal(await handleControl(stopCommand(), deps), true);

  assert.deepEqual(cancels, []);
  assert.deepEqual(acks, []);
  assert.deepEqual(replies, [[7, "Сейчас ничего не выполняется."]]);
});

test("an early running status without a session is not cancellable", async () => {
  status.setChatStatus("7:", {
    status: "running",
    sessionId: null,
    turnId: null,
    ingressId: "ingress-1",
  });
  const { cancels, acks, deps } = recordingDeps();

  assert.equal(await handleControl(nativeStop(), deps), true);

  assert.deepEqual(cancels, []);
  assert.deepEqual(acks, []);
});

test("an untrusted tap on someone else's Stop button is swallowed", async () => {
  runningTurn();
  const { cancels, acks, deps } = recordingDeps();
  const update = nativeStop();
  (update.stopped_message_generation as Record<string, unknown>).chat = {
    id: 999,
    type: "private",
  };

  assert.equal(await handleControl(update, deps), true);
  assert.deepEqual(cancels, []);
  // Спиннер кнопки гасим, но ход чужого пользователя не трогаем и ничего не объясняем.
  assert.deepEqual(acks, []);
});

// Терминальное событие освобождает пару, сохраняя факт кнопки из настоящего пути.
function stopTurn(key: string) {
  status.setChatStatus(key, {
    status: "idle",
    sessionId: null,
    turnId: null,
  });
}

// Состарить запись run-status, не трогая её раскладку: правим ровно одно поле.
// Иначе тест «Стоп» после краша не отличить от свежего хода.
function backdateRunStatus(sessionId: string, ageMs: number) {
  const dir = join(dataDir, "run-status.d");
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      sessionId?: string;
      updatedAt?: number;
    };
    if (parsed.sessionId !== sessionId) continue;
    writeFileSync(
      file,
      JSON.stringify({ ...parsed, updatedAt: Date.now() - ageMs }),
    );
    return;
  }
  throw new Error(`run-status record for ${sessionId} not found`);
}

test("a stale run record still reaches the cancel route while it remembers the session", async () => {
  runningTurn();
  backdateRunStatus("session-1", 31 * 60_000);
  const cancels: CancelCall[] = [];
  const acks: Array<[string, string | undefined]> = [];
  const consumed = await handleControl(nativeStop(), {
    cancelImpl: async (input: CancelCall) => {
      cancels.push(input);
      stopTurn("7:");
      return { ok: true, status: "accepted" };
    },
    ackImpl: async (id: string, text?: string) => {
      acks.push([id, text]);
      return { ok: true, result: true };
    },
  });

  assert.equal(consumed, true);
  assert.deepEqual(cancels, [
    {
      url: CANCEL_ROUTE,
      secret: "test-secret",
      sessionId: "session-1",
      turnId: "turn-1",
    },
  ]);
  assert.deepEqual(acks, []);
});

test("a stale run record whose turn is already gone ends as idle", async () => {
  runningTurn();
  backdateRunStatus("session-1", 31 * 60_000);
  const cancels: CancelCall[] = [];
  const acks: Array<[string, string | undefined]> = [];
  const consumed = await handleControl(nativeStop(), {
    cancelImpl: async (input: CancelCall) => {
      cancels.push(input);
      return { ok: true, status: "no_active_turn" };
    },
    ackImpl: async (id: string, text?: string) => {
      acks.push([id, text]);
      return { ok: true, result: true };
    },
  });

  assert.equal(consumed, true);
  assert.equal(cancels.length, 1);
  assert.deepEqual(acks, []);
});

test("/start is answered by the bridge and never becomes a model turn", async () => {
  const { replies, deps } = recordingDeps();
  const consumed = await handleControl(
    {
      update_id: 7,
      message: {
        message_id: 7,
        date: 1,
        chat,
        from: trustedFrom,
        text: "/start",
      },
    },
    deps,
  );

  assert.equal(consumed, true);
  assert.equal(replies.length, 1);
  assert.equal(replies[0][0], 7);
  assert.match(replies[0][1], /Iva/u);
  assert.match(replies[0][1], /\/help/u);
  assert.match(replies[0][1], /\/menu/u);
  assert.ok(OUT_OF_BAND_COMMANDS.includes("/start"));
});

test("/start from an untrusted user is not answered by the bridge", async () => {
  const { replies, deps } = recordingDeps();
  const consumed = await handleControl(
    {
      update_id: 8,
      message: {
        message_id: 8,
        date: 1,
        chat,
        from: { id: 999, is_bot: false },
        text: "/start",
      },
    },
    deps,
  );

  assert.equal(consumed, false); // дальше его молча уронит allowlist входного пайплайна
  assert.deepEqual(replies, []);
});

test("non-private group-safe commands leave stale pending flows unchanged", async () => {
  const previousFetch = globalThis.fetch;
  const botApiMethods: string[] = [];
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    botApiMethods.push(url.split("/").at(-1) ?? "");
    return Response.json({ ok: true, result: { message_id: 99 } });
  };
  try {
    for (const chatType of ["group", "supergroup", "channel", undefined]) {
      const state = flows.start(7, "42", "menu", {
        screen: "srch",
        msgId: 701,
        awaitText: {
          kind: "apikey",
          secret: true,
          data: { provider: "synthetic" },
        },
      });
      const before = structuredClone(state);
      const { replies, deps } = recordingDeps();

      const consumed = await handleControl(
        {
          update_id: 701,
          message: {
            message_id: 701,
            date: 1,
            chat: { id: 7, type: chatType },
            from: trustedFrom,
            text: "/help",
          },
        },
        deps,
      );

      assert.equal(consumed, true, String(chatType));
      assert.deepEqual(flows.get(7, "42"), before, String(chatType));
      assert.equal(replies.length, 1, String(chatType));
    }
    assert.deepEqual(botApiMethods, []);
  } finally {
    const stale = flows.get(7, "42");
    if (stale) {
      stale.createdAt = 0;
      flows.get(7, "42");
    }
    globalThis.fetch = previousFetch;
  }
});

test("settings commands reject every non-private chat before state or Bot API effects", async () => {
  const previousFetch = globalThis.fetch;
  const botApiMethods: string[] = [];
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    botApiMethods.push(url.split("/").at(-1) ?? "");
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 99 } }),
      { headers: { "content-type": "application/json" } },
    );
  };
  try {
    for (const command of ["/menu", "/model", "/think"]) {
      for (const chatType of ["group", "supergroup", "channel", undefined]) {
        const { replies, deps } = recordingDeps();
        const consumed = await handleControl(
          {
            update_id: 800,
            message: {
              message_id: 800,
              date: 1,
              chat: { id: -800, type: chatType },
              from: trustedFrom,
              text: command,
            },
          },
          deps,
        );

        assert.equal(consumed, true, `${command}:${String(chatType)}`);
        assert.equal(replies.length, 1, `${command}:${String(chatType)}`);
        assert.match(
          replies[0][1],
          /private|личн/u,
          `${command}:${String(chatType)}`,
        );
      }
    }
    assert.deepEqual(botApiMethods, []);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("local callbacks reject non-private chats before cancellation or dispatch", async () => {
  for (const data of [
    "iva_update:do",
    "iva_model:keep",
    "iva_think:keep",
    "iva_menu:r:o",
  ]) {
    for (const chatType of ["group", "supergroup", "channel", undefined]) {
      runningTurn();
      const { cancels, acks, deps } = recordingDeps();
      const update = stopButton();
      const callback = update.callback_query as Record<string, unknown>;
      callback.data = data;
      callback.message = {
        message_id: 4,
        date: 1,
        chat: { id: 7, type: chatType },
      };

      const label = `${data}:${String(chatType)}`;
      assert.equal(await handleControl(update, deps), true, label);
      assert.deepEqual(cancels, [], label);
      assert.equal(acks.length, 1, label);
      assert.match(acks[0][1] ?? "", /private|личн/u, label);
    }
  }
});

test("a non-private rejection does not reveal controls to an untrusted user", async () => {
  runningTurn();
  const { cancels, acks, deps } = recordingDeps();
  const update = stopButton();
  const callback = update.callback_query as Record<string, unknown>;
  callback.data = "iva_menu:r:o";
  callback.from = { id: 999, is_bot: false };
  callback.message = {
    message_id: 4,
    date: 1,
    chat: { id: 7, type: "group" },
  };

  assert.equal(await handleControl(update, deps), true);
  assert.deepEqual(cancels, []);
  assert.deepEqual(acks, []);
});

// Кнопка, написанная моделью: её data — реплика пользователя, поэтому тап уходит
// дальше обычным сообщением (allowlist, очередь и доставка — как у текста), а не
// колбэком в eve: сессию наполняет inbound pipeline, а он читает сообщения.
test("тап по кнопке модели уходит дальше обычным сообщением", async () => {
  const { acks, deps } = recordingDeps();
  const update: ControlUpdate = {
    update_id: 61,
    callback_query: {
      id: "cq-tap",
      from: trustedFrom,
      data: "Отложи на час",
      message: {
        message_id: 77,
        date: 1_700_000_000,
        message_thread_id: 5,
        chat,
        from: { id: 424242, is_bot: true },
        text: "Напомнить?",
      },
    },
  };

  assert.equal(
    await handleControl(update, deps),
    false,
    "тап идёт в admission",
  );
  // Сообщение без кнопок в ответе Telegram: подсказка называет data, правки нет.
  assert.deepEqual(acks, [["cq-tap", "✅ Отложи на час"]]);
  assert.equal(update.callback_query, undefined, "колбэк больше не колбэк");
  assert.deepEqual(update.message, {
    message_id: 77,
    date: 1_700_000_000,
    message_thread_id: 5,
    chat,
    from: { id: 42, is_bot: false },
    text: "Отложи на час\n\n(кнопка под сообщением Ивы: «Напомнить?»)",
    // Пометка тапа: слив очереди отдаёт его отдельным ходом, не склеивая с соседями.
    [TELEGRAM_BUTTON_TAP_FIELD]: true,
    [TELEGRAM_BUTTON_TAP_DAILY_TEXT_FIELD]:
      "Отложи на час\n\n(кнопка под сообщением Ивы: «Напомнить?»)",
  });
});

// Отправителя — нажавшего, не бота, и чат — тот же, где стоит кнопка: иначе ответ
// уедет в чужой чат, а allowlist будет судить чат-бота.
test("тап отвечает от нажавшего и в чат кнопки, а не в чат бота", async () => {
  const update: ControlUpdate = {
    update_id: 62,
    callback_query: {
      id: "cq-sender",
      from: { id: 42, is_bot: false, username: "owner" },
      data: "Да",
      message: {
        message_id: 78,
        chat: { id: 7, type: "private", title: "bot chat" },
        from: { id: 424242, is_bot: true },
      },
    },
  };

  assert.equal(
    applyTelegramButtonTap(update, update.callback_query as never),
    true,
  );
  const tap = update.message as Record<string, unknown>;
  assert.deepEqual(tap.from, { id: 42, is_bot: false, username: "owner" });
  assert.deepEqual(tap.chat, { id: 7, type: "private", title: "bot chat" });
});

// eve владеет двумя префиксами: подтверждения HITL и кнопки входа в подключения.
// Подмена их сообщением молча теряет подтверждение или вход, поэтому они уходят в eve.
test("колбэки eve мост не подменяет сообщением", async () => {
  const eve = (await import("eve/channels/telegram")) as {
    TELEGRAM_HITL_CALLBACK_PREFIX: string;
  };
  assert.equal(
    TELEGRAM_EVE_CALLBACK_PREFIXES[0],
    eve.TELEGRAM_HITL_CALLBACK_PREFIX,
    "префикс HITL-колбэка обязан совпадать с eve",
  );

  for (const data of ["eve:1", "eve_auth:42"]) {
    const { acks, deps } = recordingDeps();
    const update: ControlUpdate = {
      update_id: 63,
      callback_query: {
        id: `cq-${data}`,
        from: trustedFrom,
        message: { message_id: 1, date: 1, chat },
        data,
      },
    };

    assert.equal(await handleControl(update, deps), false, data);
    assert.equal(update.message, undefined, data);
    assert.ok(update.callback_query, data);
    assert.deepEqual(acks, [], data);
  }
});

// Пространство `iva_*` — моста: незнакомый его колбэк остаётся колбэком (сегодня его
// доставляет eve), в сообщение его не превращаем даже когда экрана для него ещё нет.
test("незнакомый iva-колбэк остаётся в пространстве моста", async () => {
  const { acks, deps } = recordingDeps();
  const update: ControlUpdate = {
    update_id: 64,
    callback_query: {
      id: "cq-iva-future",
      from: trustedFrom,
      message: { message_id: 1, date: 1, chat },
      data: "iva_future:x",
    },
  };

  assert.equal(await handleControl(update, deps), false);
  assert.equal(update.message, undefined);
  assert.deepEqual(acks, []);
});

// Чужому тапу — пустой ack без подсказок (наличие контрола знать нечего), а решение
// по allowlist остаётся за admission: он же пишет отброс в журнал.
test("чужой тап гасит спиннер и не становится сообщением", async () => {
  const { acks, deps } = recordingDeps();
  const update: ControlUpdate = {
    update_id: 65,
    callback_query: {
      id: "cq-stranger",
      from: { id: 999, is_bot: false },
      message: { message_id: 1, date: 1, chat },
      data: "Отложи на час",
    },
  };

  assert.equal(await handleControl(update, deps), false);
  assert.deepEqual(acks, [["cq-stranger", undefined]]);
  assert.equal(update.message, undefined);
  assert.ok(update.callback_query, "allowlist судит admission, а не мост");
});

// В группе текст принимается только как упоминание, команда или reply боту, а нажатие
// кнопки — ни то, ни другое: тап там не доедет, поэтому говорим про личку прямо.
test("тап в группе отвечает подсказкой про личный чат", async () => {
  const { acks, deps } = recordingDeps();
  const update: ControlUpdate = {
    update_id: 66,
    callback_query: {
      id: "cq-group-tap",
      from: trustedFrom,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: -1001, type: "supergroup" },
      },
      data: "Отложи на час",
    },
  };

  assert.equal(await handleControl(update, deps), true, "тап проглочен");
  assert.equal(acks.length, 1);
  assert.match(acks[0][1] ?? "", /private|личн/u);
  assert.equal(update.message, undefined);
  assert.ok(update.callback_query, "подсказка — не доставка");
});

// Конверт без сообщения (inline_message_id) или без чата сообщением стать не может —
// гасим тап здесь, иначе admission запишет его и очередь встанет на повторе.
test("неполный конверт тапа не превращается в сообщение", async () => {
  for (const callback of [
    { id: "cq-inline", from: trustedFrom, data: "Да" },
    {
      id: "cq-no-chat",
      from: trustedFrom,
      data: "Да",
      message: { message_id: 1, date: 1 },
    },
  ]) {
    const { acks, deps } = recordingDeps();
    const update: ControlUpdate = { update_id: 67, callback_query: callback };
    const label = String(callback.id);

    assert.equal(await handleControl(update, deps), true, label);
    assert.deepEqual(acks, [[String(callback.id), undefined]], label);
    assert.equal(update.message, undefined, label);
    assert.ok(update.callback_query, label);
  }
});

// Тап без отправителя — не наш: allowlist судит admission по from, а его нет.
test("тап без отправителя не подменяется, его снимает admission", async () => {
  const { acks, deps } = recordingDeps();
  const update: ControlUpdate = {
    update_id: 68,
    callback_query: {
      id: "cq-no-from",
      data: "Да",
      message: { message_id: 1, date: 1, chat },
    },
  };

  assert.equal(await handleControl(update, deps), false);
  assert.deepEqual(acks, [["cq-no-from", undefined]]);
  assert.equal(update.message, undefined);
  assert.ok(update.callback_query);
});

test("malformed update callback is not claimed as a local control", async () => {
  const methods: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    methods.push(url.split("/").at(-1) ?? "");
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const consumed = await handleControl({
      update_id: 9,
      callback_query: {
        id: "cq-invalid-update",
        from: trustedFrom,
        message: { message_id: 9, date: 1, chat },
        data: "iva_update:do-now",
      },
    });

    assert.equal(consumed, false);
    assert.deepEqual(methods, []);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a falsey local reply does not authorize offset acknowledgement", async () => {
  const consumed = await handleControl(
    {
      update_id: 10,
      message: {
        message_id: 10,
        date: 1,
        chat,
        from: trustedFrom,
        text: "/help",
      },
    },
    { replyImpl: async () => null },
  );

  assert.equal(consumed, false);
});

test("a falsey callback ack does not claim a local control", async () => {
  status.setChatStatus("7:", {
    status: "idle",
    sessionId: null,
    turnId: null,
  });

  const consumed = await handleControl(
    {
      ...stopButton(),
      callback_query: {
        ...(stopButton().callback_query as Record<string, unknown>),
        data: "iva_model:keep",
      },
    },
    {
      ackImpl: async () => null,
    },
  );

  assert.equal(consumed, false);
});

test("a false callback ack result does not claim a local control", async () => {
  status.setChatStatus("7:", {
    status: "idle",
    sessionId: null,
    turnId: null,
  });

  const consumed = await handleControl(
    {
      ...stopButton(),
      callback_query: {
        ...(stopButton().callback_query as Record<string, unknown>),
        data: "iva_model:keep",
      },
    },
    {
      ackImpl: async () => ({ ok: true, result: false }),
    },
  );

  assert.equal(consumed, false);
});

for (const [command, updateId] of [
  ["/model", 21],
  ["/think", 22],
] as const) {
  test(`${command} is retained when its initial Bot API screen fails`, async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: false, result: false }), {
        headers: { "content-type": "application/json" },
      });
    try {
      const consumed = await handleControl({
        update_id: updateId,
        message: {
          message_id: updateId,
          date: 1,
          chat,
          from: trustedFrom,
          text: command,
        },
      });

      assert.equal(consumed, false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
}

test("model keep callback is retained when only spinner ack succeeds", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 71 } }), {
      headers: { "content-type": "application/json" },
    });
  try {
    assert.equal(
      await handleControl({
        update_id: 11,
        message: {
          message_id: 11,
          date: 1,
          chat: { id: 71, type: "private" },
          from: trustedFrom,
          text: "/model",
        },
      }),
      true,
    );

    const methods: string[] = [];
    globalThis.fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      methods.push(url.split("/").at(-1) ?? "");
      return new Response(
        JSON.stringify(
          url.endsWith("/answerCallbackQuery")
            ? { ok: true, result: true }
            : { ok: false, result: false },
        ),
        { headers: { "content-type": "application/json" } },
      );
    };

    const callback = {
      update_id: 12,
      callback_query: {
        id: "cq-model-keep",
        from: trustedFrom,
        message: {
          message_id: 71,
          date: 1,
          chat: { id: 71, type: "private" },
        },
        data: "iva_model:keep",
      },
    };
    const consumed = await handleControl(callback);

    assert.equal(consumed, false);
    // Терминальный экран визарда — rich-сообщение: новый экран уходит sendRichMessage'ом.
    assert.deepEqual(methods, [
      "answerCallbackQuery",
      "editMessageText",
      "sendRichMessage",
    ]);

    globalThis.fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      methods.push(url.split("/").at(-1) ?? "");
      return new Response(
        JSON.stringify(
          url.endsWith("/answerCallbackQuery")
            ? { ok: true, result: true }
            : { ok: true, result: { message_id: 71 } },
        ),
        { headers: { "content-type": "application/json" } },
      );
    };

    assert.equal(await handleControl(callback), true);
    assert.deepEqual(methods.slice(3), [
      "answerCallbackQuery",
      "editMessageText",
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

// Тап по кнопке мёртвого экрана в СТАРОМ сообщении не забирает у живого меню ни его
// сообщение, ни ожидание ввода. Иначе ожидание переезжает в корень, где обрабатывать
// его kind нечем, и следующий ОБЫЧНЫЙ текст пользователя мост удаляет как креденшл
// вместо доставки в eve.
test("a dead menu tap leaves the live menu's pending input alone", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const raw = init?.body;
    calls.push({
      method: url.split("/").at(-1) ?? "",
      body:
        typeof raw === "string"
          ? (JSON.parse(raw) as Record<string, unknown>)
          : {},
    });
    return Response.json({ ok: true, result: { message_id: 100 } });
  };
  try {
    const live = flows.start(7, "42", "menu", {
      screen: "srch",
      page: 0,
      msgId: 100,
      awaitText: { kind: "apikey", secret: true, data: { provider: "tavily" } },
    });

    const tapped = await handleControl(
      {
        update_id: 910,
        callback_query: {
          id: "cq-dead-menu",
          from: trustedFrom,
          message: { message_id: 55, date: 1, chat },
          data: "iva_menu:zzz:o",
        },
      },
      recordingDeps().deps,
    );

    assert.equal(tapped, true);
    assert.equal(flows.get(7, "42"), live, "живое меню не вытеснено");
    assert.equal(live.msgId, 100, "меню осталось за своим сообщением");
    assert.equal(live.awaitText, null, "ожидание ввода снято, а не перенесено");
    assert.ok(
      calls.some(
        (call) =>
          call.method === "editMessageText" && call.body.message_id === 100,
      ),
      "корень перерисован в сообщении живого меню",
    );

    calls.length = 0;
    const ordinary = await handleControl(
      {
        update_id: 911,
        message: {
          message_id: 911,
          date: 1,
          chat,
          from: trustedFrom,
          text: "сколько времени?",
        },
      },
      recordingDeps().deps,
    );

    assert.equal(ordinary, false, "обычное сообщение уходит в eve");
    assert.deepEqual(
      calls.map((call) => call.method),
      [],
      "обычное сообщение не удалено и не перехвачено",
    );
  } finally {
    const stale = flows.get(7, "42");
    if (stale) {
      stale.createdAt = 0;
      flows.get(7, "42");
    }
    globalThis.fetch = previousFetch;
  }
});

// Усыновление старого сообщения переносит ждущий ввод только на экран, который владеет
// его kind. Экран-получатель без texts[kind] обработать ввод не может, поэтому ожидание
// снимается, а корень рисуется в сообщении живого меню: иначе следующий ОБЫЧНЫЙ текст
// владельца снова удалялся бы из чата как ключ вместо доставки в eve.
test("adoption drops a pending input the target screen cannot handle", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const raw = init?.body;
    calls.push({
      method: url.split("/").at(-1) ?? "",
      body:
        typeof raw === "string"
          ? (JSON.parse(raw) as Record<string, unknown>)
          : {},
    });
    return Response.json({ ok: true, result: { message_id: 100 } });
  };
  try {
    // Живое меню ждёт ключ поиска (texts.apikey есть только у srch), тап приходит по
    // кнопке экрана языка в ДРУГОМ сообщении.
    const live = flows.start(7, "42", "menu", {
      screen: "srch",
      page: 0,
      msgId: 100,
      awaitText: { kind: "apikey", secret: true, data: { provider: "tavily" } },
    });

    const tapped = await handleControl(
      {
        update_id: 920,
        callback_query: {
          id: "cq-foreign-await",
          from: trustedFrom,
          message: { message_id: 55, date: 1, chat },
          data: "iva_menu:lang:o",
        },
      },
      recordingDeps().deps,
    );

    assert.equal(tapped, true);
    assert.equal(flows.get(7, "42"), live, "живое меню не вытеснено");
    assert.equal(live.msgId, 100, "меню осталось за своим сообщением");
    assert.equal(live.awaitText, null, "ожидание ввода снято, а не перенесено");
    assert.ok(
      calls.some(
        (call) =>
          call.method === "editMessageText" && call.body.message_id === 100,
      ),
      "корень перерисован в сообщении живого меню",
    );

    calls.length = 0;
    const ordinary = await handleControl(
      {
        update_id: 921,
        message: {
          message_id: 921,
          date: 1,
          chat,
          from: trustedFrom,
          text: "что по погоде?",
        },
      },
      recordingDeps().deps,
    );

    assert.equal(ordinary, false, "обычное сообщение уходит в eve");
    assert.deepEqual(
      calls.map((call) => call.method),
      [],
      "обычное сообщение не удалено и не перехвачено",
    );
  } finally {
    const stale = flows.get(7, "42");
    if (stale) {
      stale.createdAt = 0;
      flows.get(7, "42");
    }
    globalThis.fetch = previousFetch;
  }
});

// Ожидание ввода принадлежит тому flow, который его поставил. Живой визард /model ждёт
// API-ключ (secret) в СВОЁМ сообщении; тап по старой кнопке меню не имеет права забрать ни
// это ожидание, ни общий слот — совпадение имени kind (у экрана поиска тоже есть
// texts.apikey) владением не является. Иначе ключ уходит обычной доставкой в eve и
// остаётся в чате.
test("a stale menu tap cannot take the pending key away from the /model wizard", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const raw = init?.body;
    calls.push({
      method: url.split("/").at(-1) ?? "",
      body:
        typeof raw === "string"
          ? (JSON.parse(raw) as Record<string, unknown>)
          : {},
    });
    return Response.json({ ok: true, result: { message_id: 100 } });
  };
  try {
    const wizard = flows.start(7, "42", "model", {
      provider: "custom",
      pendingBase: "https://api.example.test/v1",
      step: "awaiting_key",
      msgId: 100,
      awaitText: { kind: "apikey", secret: true, data: {} },
    });

    const tapped = await handleControl(
      {
        update_id: 930,
        callback_query: {
          id: "cq-wizard-await",
          from: trustedFrom,
          message: { message_id: 55, date: 1, chat },
          data: "iva_menu:srch:o",
        },
      },
      recordingDeps().deps,
    );

    assert.equal(tapped, true);
    assert.equal(flows.get(7, "42"), wizard, "слот визарда не вытеснен");
    assert.equal(wizard.flow, "model");
    assert.deepEqual(
      wizard.awaitText,
      { kind: "apikey", secret: true, data: {} },
      "ожидание осталось у визарда",
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ["answerCallbackQuery"],
      "тап только гасит кнопку: ни правок сообщений, ни рендера",
    );
    assert.equal(
      typeof calls[0].body.text,
      "string",
      "в ack ушёл тост, а не тишина",
    );

    calls.length = 0;
    const keyMessage = await handleControl(
      {
        update_id: 931,
        message: {
          message_id: 931,
          date: 1,
          chat,
          from: trustedFrom,
          text: "sk-real-secret-value",
        },
      },
      recordingDeps().deps,
    );

    assert.equal(keyMessage, true, "ключ обработан визардом, а не доставкой");
    assert.ok(
      calls.some(
        (call) =>
          call.method === "deleteMessage" && call.body.message_id === 931,
      ),
      "сообщение с ключом удалено из чата",
    );
  } finally {
    const stale = flows.get(7, "42");
    if (stale) {
      stale.createdAt = 0;
      flows.get(7, "42");
    }
    globalThis.fetch = previousFetch;
  }
});

// ── Характеристика handleControl: ветки, которые раньше не держал ни один тест ──

type BotCall = { method: string; body: Record<string, unknown> };

// Подменяет Bot API на время прогона: ответ решает respond(method), Error = обрыв сети.
async function withBotApi<T>(
  respond: (method: string) => unknown,
  run: (calls: BotCall[]) => Promise<T>,
): Promise<T> {
  const previousFetch = globalThis.fetch;
  const calls: BotCall[] = [];
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = url.split("/").at(-1) ?? "";
    const raw = init?.body;
    calls.push({
      method,
      body:
        typeof raw === "string"
          ? (JSON.parse(raw) as Record<string, unknown>)
          : {},
    });
    const answer = respond(method);
    if (answer instanceof Error) throw answer;
    return Response.json(answer);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

const botOk = () => ({ ok: true, result: { message_id: 500 } });
const botDown = () => new Error("network down");

function textUpdate(
  updateId: number,
  text: string | undefined,
  overrides: Record<string, unknown> = {},
): ControlUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat,
      from: trustedFrom,
      ...(text === undefined ? {} : { text }),
      ...overrides,
    },
  };
}

function callbackUpdate(updateId: number, data: string): ControlUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: trustedFrom,
      message: { message_id: updateId, date: 1, chat },
      data,
    },
  };
}

function dropFlow() {
  const stale = flows.get(7, "42");
  if (stale) {
    stale.createdAt = 0;
    flows.get(7, "42");
  }
}

const sentTexts = (calls: BotCall[]) =>
  calls.map((call) => JSON.stringify(call.body)).join("\n");

test("a wizard callback that throws is retained for the inbox", async () => {
  await withBotApi(botDown, async () => {
    assert.equal(
      await handleControl(callbackUpdate(1001, "iva_model:keep")),
      false,
    );
  });
});

test("a menu callback that throws is still consumed", async () => {
  await withBotApi(botDown, async () => {
    assert.equal(
      await handleControl(callbackUpdate(1002, "iva_menu:r:o")),
      true,
    );
  });
  dropFlow();
});

test("a command while input is awaited ends the wait and still runs", async () => {
  await withBotApi(botOk, async (calls) => {
    flows.start(7, "42", "menu", {
      screen: "srch",
      msgId: 1003,
      awaitText: { kind: "apikey", secret: true, data: {} },
    });
    const { replies, deps } = recordingDeps();

    assert.equal(await handleControl(textUpdate(1003, "/help"), deps), true);
    assert.equal(flows.get(7, "42"), null, "ожидание снято");
    assert.match(sentTexts(calls), /Отменено/u);
    assert.equal(replies.length, 1, "/help ответил");
  });
  dropFlow();
});

test("a menu screen claims the awaited text and never delivers it", async () => {
  await withBotApi(botOk, async (calls) => {
    flows.start(7, "42", "menu", {
      screen: "r",
      msgId: 1004,
      awaitText: { kind: "nothing-handles-this", secret: false },
    });

    assert.equal(await handleControl(textUpdate(1004, "hello")), true);
    assert.equal(flows.get(7, "42"), null);
    assert.ok(!calls.some((call) => call.method === "deleteMessage"));
    assert.match(sentTexts(calls), /Обработчик ввода недоступен/u);
  });
  dropFlow();
});

test("a failing menu capture still consumes the secret", async () => {
  await withBotApi(botDown, async () => {
    flows.start(7, "42", "menu", {
      screen: "srch",
      msgId: 1005,
      awaitText: { kind: "apikey", secret: true, data: {} },
    });

    assert.equal(
      await handleControl(textUpdate(1005, "tvly-secret-value")),
      true,
    );
  });
  dropFlow();
});

test("a failing wizard key intake still consumes the key", async () => {
  await withBotApi(botDown, async () => {
    flows.start(7, "42", "model", {
      provider: "custom",
      step: "awaiting_key",
      msgId: 1006,
      awaitText: { kind: "apikey", secret: true, data: {} },
    });

    assert.equal(
      await handleControl(textUpdate(1006, "sk-secret-value")),
      true,
    );
  });
  dropFlow();
});

test("a photo while a secret is awaited is deleted and never reaches eve", async () => {
  await withBotApi(botOk, async (calls) => {
    flows.start(7, "42", "menu", {
      screen: "srch",
      msgId: 1007,
      awaitText: { kind: "apikey", secret: true, data: {} },
    });

    const consumed = await handleControl(
      textUpdate(1007, undefined, { photo: [{ file_id: "p" }] }),
    );

    assert.equal(consumed, true);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["deleteMessage", "sendMessage"],
    );
    assert.match(sentTexts(calls), /текстом/u);
  });
  dropFlow();
});

test("a photo during a non-secret wait goes on to eve untouched", async () => {
  await withBotApi(botOk, async (calls) => {
    flows.start(7, "42", "menu", {
      screen: "r",
      msgId: 1008,
      awaitText: { kind: "interview" },
    });

    const consumed = await handleControl(
      textUpdate(1008, undefined, { photo: [{ file_id: "p" }] }),
    );

    assert.equal(consumed, false);
    assert.deepEqual(calls, []);
  });
  dropFlow();
});

test("/menu opens the menu in a private chat", async () => {
  await withBotApi(botOk, async (calls) => {
    assert.equal(await handleControl(textUpdate(1009, "/menu")), true);
    assert.ok(calls.length > 0, "экран меню отправлен");
    assert.equal(flows.get(7, "42")?.flow, "menu");
  });
  dropFlow();
});

test("a failing /menu is still consumed", async () => {
  await withBotApi(botDown, async () => {
    assert.equal(await handleControl(textUpdate(1010, "/menu")), true);
  });
  dropFlow();
});

test("/usage answers from the usage log without the model", async () => {
  await withBotApi(botOk, async (calls) => {
    assert.equal(await handleControl(textUpdate(1011, "/usage today")), true);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["sendMessage"],
    );
  });
});

test("/usage names the reason when the log cannot be summarized", async () => {
  const usageLog = join(dataDir, "usage.jsonl");
  writeFileSync(
    usageLog,
    JSON.stringify({ turnId: { toString: null } }) + "\n",
  );
  try {
    await withBotApi(botOk, async (calls) => {
      assert.equal(await handleControl(textUpdate(1012, "/usage")), true);
      assert.match(sentTexts(calls), /Couldn't read the usage log: /u);
    });
  } finally {
    rmSync(usageLog, { force: true });
  }
});

test("/usage skips non-object rows and replies with an empty report", async () => {
  const usageLog = join(dataDir, "usage.jsonl");
  const raw = "null\n42\n[]\n";
  writeFileSync(usageLog, raw);
  try {
    await withBotApi(botOk, async (calls) => {
      assert.equal(await handleControl(textUpdate(1012, "/usage")), true);
      assert.match(sentTexts(calls), /No usage logged yet\./u);
      assert.equal(readFileSync(usageLog, "utf8"), raw);
    });
  } finally {
    rmSync(usageLog, { force: true });
  }
});

test("/usage is retained when its reply fails", async () => {
  await withBotApi(
    () => ({ ok: false }),
    async () => {
      assert.equal(await handleControl(textUpdate(1013, "/usage")), false);
    },
  );
});

test("/update checks upstream and /update --force asks for a rebuild", async () => {
  await withBotApi(
    () => ({ ok: false }),
    async (calls) => {
      assert.equal(await handleControl(textUpdate(1014, "/update")), false);
      assert.equal(
        await handleControl(textUpdate(1015, "/update@iva_bot --force")),
        false,
      );
      assert.deepEqual(
        calls.map((call) => call.body.text),
        ["◇ Проверяю обновления", "◇ Пересобираю текущую версию"],
      );
      assert.ok(calls.every((call) => call.body.disable_notification === true));
    },
  );
});

for (const command of ["/model", "/think"]) {
  test(`${command} that throws is retained for the inbox`, async () => {
    await withBotApi(botDown, async () => {
      assert.equal(await handleControl(textUpdate(1016, command)), false);
    });
    dropFlow();
  });
}

// ── /new и /restart ──

type ResetCall = [string, Record<string, unknown>, Record<string, unknown>];

function resetDeps(
  performReset: () => Promise<unknown> = async () => {},
  { retryPending = false, intentPending = false } = {},
) {
  const resets: ResetCall[] = [];
  const replies: string[] = [];
  return {
    resets,
    replies,
    deps: {
      replyImpl: async (_chatId: number | undefined, text: string) => {
        replies.push(text);
        return { message_id: 900 };
      },
      performResetImpl: async (
        key: string,
        target: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        resets.push([key, target, options]);
        return performReset();
      },
      resetRetryPendingImpl: () => retryPending,
      resetIntentPendingImpl: () => intentPending,
    },
  };
}

function idleSession() {
  status.setChatStatus("7:", {
    status: "idle",
    sessionId: "session-r",
    turnId: null,
  });
}

const edits = (calls: BotCall[]) =>
  calls
    .filter((call) => call.method === "editMessageText")
    .map((call) => JSON.stringify(call.body));

// systemctl подменяется скриптом на PATH: тест никогда не трогает настоящий сервис.
async function withFakeSystemctl<T>(
  exitCode: number,
  run: (argsLog: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iva-systemctl-"));
  const argsLog = join(dir, "args.log");
  writeFileSync(
    join(dir, "systemctl"),
    `#!/bin/sh\necho "$@" >> "${argsLog}"\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath ?? ""}`;
  try {
    return await run(argsLog);
  } finally {
    process.env.PATH = previousPath;
  }
}

test("/new resets this private conversation and reports completion", async () => {
  idleSession();
  await withBotApi(botOk, async (calls) => {
    const { resets, replies, deps } = resetDeps();

    assert.equal(await handleControl(textUpdate(1020, "/new"), deps), true);
    assert.deepEqual(resets, [
      [
        "7:",
        { sessionId: "session-r" },
        { clearQueue: true, discardThroughUpdateId: 1020 },
      ],
    ]);
    assert.equal(replies.length, 1);
    assert.equal(edits(calls).length, 1);
    assert.match(edits(calls)[0] ?? "", /"message_id":900/u);
  });
});

test("/restart restarts the service after the reset", async () => {
  idleSession();
  await withFakeSystemctl(0, async (argsLog) => {
    await withBotApi(botOk, async (calls) => {
      const { deps } = resetDeps();

      assert.equal(
        await handleControl(textUpdate(1021, "/restart"), deps),
        true,
      );
      assert.equal(
        readFileSync(argsLog, "utf8"),
        "--user restart iva.service\n",
      );
      assert.equal(edits(calls).length, 1);
      assert.doesNotMatch(edits(calls)[0] ?? "", /не удалось/u);
    });
  });
});

test("/restart says so when the service cannot restart", async () => {
  idleSession();
  await withFakeSystemctl(1, async () => {
    await withBotApi(botOk, async (calls) => {
      const { deps } = resetDeps();

      assert.equal(
        await handleControl(textUpdate(1022, "/restart"), deps),
        true,
      );
      assert.match(edits(calls)[0] ?? "", /перезапустить Iva не удалось/u);
    });
  });
});

const groupChat = { id: -100, type: "group" };

test("/new in a group without an addressed message names the problem", async () => {
  await withBotApi(botOk, async (calls) => {
    const { resets, deps } = resetDeps();

    assert.equal(
      await handleControl(textUpdate(1023, "/new", { chat: groupChat }), deps),
      true,
    );
    assert.deepEqual(resets, []);
    assert.match(edits(calls)[0] ?? "", /Не удалось определить этот диалог/u);
  });
});

test("an unidentified /new whose status reply failed is retained", async () => {
  const { resets, deps } = resetDeps();
  deps.replyImpl = async (_chatId, text) => {
    void text;
    return null as unknown as { message_id: number };
  };

  assert.equal(
    await handleControl(textUpdate(1024, "/new", { chat: groupChat }), deps),
    false,
  );
  assert.deepEqual(resets, []);
});

test("a failed group reset keeps the shared queue and is consumed", async () => {
  await withBotApi(botOk, async (calls) => {
    const { resets, deps } = resetDeps(async () => {
      throw new Error("cleanup failed");
    });
    const update = textUpdate(1025, "/new", {
      chat: groupChat,
      reply_to_message: {
        message_id: 50,
        date: 1,
        chat: groupChat,
        from: { id: 424242, is_bot: true },
      },
    });

    assert.equal(await handleControl(update, deps), true);
    assert.equal(resets.length, 1);
    assert.deepEqual(resets[0]?.[2], {
      clearQueue: false,
      discardThroughUpdateId: undefined,
    });
    assert.match(
      edits(calls)[0] ?? "",
      /Восстановление после сброса не завершено/u,
    );
  });
});

test("a failed private reset of unknown phase is thrown back for retry", async () => {
  idleSession();
  const failure = new Error("cleanup failed");
  await withBotApi(botOk, async (calls) => {
    const { deps } = resetDeps(async () => {
      throw failure;
    });

    await assert.rejects(
      handleControl(textUpdate(1026, "/new"), deps),
      (error) => error === failure,
    );
    assert.match(
      edits(calls)[0] ?? "",
      /Восстановление после сброса не завершено/u,
    );
  });
});

test("a remote reset failure is left to recovery", async () => {
  idleSession();
  await withBotApi(botOk, async (calls) => {
    const { deps } = resetDeps(async () => {
      throw Object.assign(new Error("eve down"), { resetPhase: "remote" });
    });

    assert.equal(await handleControl(textUpdate(1027, "/new"), deps), true);
    assert.match(edits(calls)[0] ?? "", /Не удалось подтвердить сброс/u);
  });
});

test("a backoff failure is consumed only while the reset intent is saved", async () => {
  idleSession();
  const backoff = () =>
    Promise.reject(
      Object.assign(new Error("backoff"), { resetPhase: "backoff" }),
    );
  await withBotApi(botOk, async (calls) => {
    const saved = resetDeps(backoff, { intentPending: true });
    assert.equal(
      await handleControl(textUpdate(1028, "/new"), saved.deps),
      true,
    );
    assert.match(edits(calls)[0] ?? "", /Повтор сброса уже запланирован/u);

    const unsaved = resetDeps(backoff, { intentPending: false });
    await assert.rejects(
      handleControl(textUpdate(1029, "/new"), unsaved.deps),
      /backoff/u,
    );
  });
});

test("an escalated intent failure tells the owner to run iva reset", async () => {
  idleSession();
  await withBotApi(botOk, async (calls) => {
    const { deps } = resetDeps(async () => {
      throw Object.assign(new Error("disk"), {
        resetPhase: "intent",
        resetFailures: 1_000,
      });
    });

    assert.equal(await handleControl(textUpdate(1030, "/new"), deps), true);
    assert.match(edits(calls)[0] ?? "", /iva reset/u);
  });
});

test("an intent failure below the escalation bar is thrown back for retry", async () => {
  idleSession();
  await withBotApi(botOk, async (calls) => {
    const { deps } = resetDeps(async () => {
      throw Object.assign(new Error("disk"), {
        resetPhase: "intent",
        resetFailures: 1,
      });
    });

    await assert.rejects(
      handleControl(textUpdate(1031, "/new"), deps),
      /disk/u,
    );
    assert.doesNotMatch(edits(calls)[0] ?? "", /iva reset/u);
  });
});

test("a pending reset retry without saved intent holds the offset", async () => {
  idleSession();
  const { resets, replies, deps } = resetDeps(async () => {}, {
    retryPending: true,
    intentPending: false,
  });

  await assert.rejects(
    handleControl(textUpdate(1032, "/new"), deps),
    (error: { resetPhase?: unknown }) => error.resetPhase === "backoff",
  );
  assert.deepEqual(resets, []);
  assert.deepEqual(replies, []);
});

// ── handleAwaitNonText: ветки мимо удачной выгрузки ──

function recordingNonTextIo(download: string | null = "content") {
  const events: Array<string | [string, string]> = [];
  return {
    events,
    io: {
      deleteSecret: async () => {
        events.push("delete");
        return true;
      },
      download: async () => {
        events.push("download");
        return download;
      },
      deliver: async () => {
        events.push("deliver");
      },
      reply: async (_chatId: number | undefined, text: string) => {
        events.push(["reply", text]);
      },
    },
  };
}

const fileAwait = {
  flow: "menu",
  awaitText: { kind: "gws_client_secret", file: true },
};

test("an oversized secret file is deleted and never downloaded", async () => {
  const { events, io } = recordingNonTextIo();
  const consumed = await handleAwaitNonText(
    {
      message_id: 9,
      chat: { id: 42 },
      document: { file_id: "file", file_size: 256 * 1024 + 1 },
    },
    fileAwait,
    io,
  );

  assert.equal(consumed, true);
  assert.equal(events.length, 2);
  assert.equal(events[0], "delete");
  assert.match((events[1] as [string, string])[1], /слишком большой/u);
});

test("an unreadable secret file asks for the contents as text", async () => {
  const { events, io } = recordingNonTextIo(null);
  const consumed = await handleAwaitNonText(
    {
      message_id: 10,
      chat: { id: 42 },
      document: { file_id: "file" },
    },
    fileAwait,
    io,
  );

  assert.equal(consumed, true);
  assert.deepEqual(events.slice(0, 2), ["delete", "download"]);
  assert.match((events[2] as [string, string])[1], /Не смог прочитать/u);
  assert.equal(events.length, 3);
});

test("a photo for a file prompt is deleted with a hint about the json file", async () => {
  const { events, io } = recordingNonTextIo();
  const consumed = await handleAwaitNonText(
    { message_id: 11, chat: { id: 42 }, photo: [{ file_id: "p" }] },
    fileAwait,
    io,
  );

  assert.equal(consumed, true);
  assert.equal(events[0], "delete");
  assert.match((events[1] as [string, string])[1], /client_secret\.json/u);
  assert.equal(events.length, 2);
});

test("a document outside the menu is deleted, not captured", async () => {
  const { events, io } = recordingNonTextIo();
  const consumed = await handleAwaitNonText(
    {
      message_id: 12,
      chat: { id: 42 },
      document: { file_id: "file", file_size: 10 },
    },
    { flow: "model", awaitText: { kind: "apikey", secret: true } },
    io,
  );

  assert.equal(consumed, true);
  assert.equal(events[0], "delete");
  assert.match((events[1] as [string, string])[1], /текстом/u);
  assert.equal(events.length, 2);
});

// ── «Установить» на предложении плагина (iva_plugin:ok:<digest12>) ──
// Граница нового вида колбэка: какие тапы доходят до установщика, а какие гаснут молча.
function pluginTap(
  overrides: { from?: unknown; chat?: unknown; data?: string } = {},
): ControlUpdate {
  return {
    update_id: 90,
    callback_query: {
      id: "cq-plugin",
      from: overrides.from ?? trustedFrom,
      message: { message_id: 3, date: 1, chat: overrides.chat ?? chat },
      data: overrides.data ?? "iva_plugin:ok:0123456789ab",
    },
  };
}

function pluginDeps() {
  const recorded = recordingDeps();
  const taps: Array<{ digest12: string; chatId: number }> = [];
  return {
    ...recorded,
    taps,
    deps: {
      ...recorded.deps,
      pluginTapImpl: async (tap: { digest12: string; chatId: number }) => {
        taps.push(tap);
        return "stale";
      },
    },
  };
}

test("a plugin proposal tap from the owner in a private chat reaches the installer", async () => {
  const { taps, acks, deps } = pluginDeps();
  const update = pluginTap();

  assert.equal(await handleControl(update, deps), true);
  assert.deepEqual(taps, [{ digest12: "0123456789ab", chatId: 7 }]);
  assert.deepEqual(acks, [["cq-plugin", undefined]]);
  assert.equal(update.message, undefined, "the tap is not a model turn");
});

test("a plugin proposal tap from a stranger or from a group installs nothing and says nothing", async () => {
  for (const [label, update] of [
    ["stranger", pluginTap({ from: { id: 999, is_bot: false } })],
    ["group", pluginTap({ chat: { id: -1001, type: "supergroup" } })],
    ["no sender", pluginTap({ from: undefined })],
  ] as const) {
    const { taps, acks, replies, deps } = pluginDeps();
    if (label === "no sender")
      delete (update.callback_query as Record<string, unknown>).from;

    assert.equal(await handleControl(update, deps), true, label);
    assert.deepEqual(taps, [], label);
    assert.deepEqual(acks, [["cq-plugin", undefined]], label);
    assert.deepEqual(replies, [], label);
    assert.equal(update.message, undefined, label);
  }
});

test("a malformed plugin proposal tap never reaches the installer", async () => {
  for (const data of [
    "iva_plugin:ok:../../etc",
    "iva_plugin:ok:0123456789AB",
    "iva_plugin:ok:0123456789abc",
    "iva_plugin:ok:",
    "iva_plugin:no:0123456789ab",
  ]) {
    const { taps, deps } = pluginDeps();
    const update = pluginTap({ data });

    await handleControl(update, deps);
    assert.deepEqual(taps, [], data);
    assert.equal(update.message, undefined, data);
  }
});

test("a failing installer does not crash the bridge and the tap stays consumed", async () => {
  const { deps } = pluginDeps();
  const update = pluginTap();

  assert.equal(
    await handleControl(update, {
      ...deps,
      pluginTapImpl: async () => {
        throw new Error("disk full");
      },
    }),
    true,
  );
});

// ── Отклик кнопки модели: подсказка «✅», правка сообщения, память «уже нажато» ──
// (spec-w2 §2.1 п. 4–5, модель specs/ButtonTap.tla). Память живёт в модуле моста, поэтому
// у каждого теста свои номера сообщений.

const flush = () => new Promise((resolve) => setImmediate(resolve));

function modelTap(
  updateId: number,
  messageId: number,
  data: string,
  message: Record<string, unknown> = {},
): ControlUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: trustedFrom,
      data,
      message: { message_id: messageId, date: 1, chat, ...message },
    },
  };
}

const choiceBlocks = [
  { type: "paragraph", text: "Поставить плагин?" },
  {
    type: "buttons",
    buttons: [
      { text: "Поставить", callback_data: "Поставить" },
      { text: "Не надо", callback_data: "Не надо" },
    ],
  },
];
const richChoice = { rich_message: { blocks: choiceBlocks } };
/** Текст хода по тапу под choiceBlocks: data и текст сообщения с кнопкой. */
const choiceTurn = (data: string) =>
  `${data}\n\n(кнопка под сообщением Ивы: «Поставить плагин?»)`;

function tapDeps() {
  const recorded = recordingDeps();
  const edits: Array<[number, number, unknown]> = [];
  const scheduled: string[] = [];
  const result = { edit: true };
  return {
    ...recorded,
    edits,
    scheduled,
    result,
    deps: {
      ...recorded.deps,
      scheduleImpl: (key: string, task: () => Promise<void>) => {
        scheduled.push(key);
        void task();
        return true;
      },
      editTapImpl: async (chatId: number, messageId: number, edit: unknown) => {
        edits.push([chatId, messageId, edit]);
        return result.edit;
      },
    },
  };
}

test("a model button tap shows ✅ with its label and marks the button in the rich message", async () => {
  const { acks, edits, scheduled, deps } = tapDeps();
  const update = modelTap(301, 501, "Не надо", {
    rich_message: { blocks: choiceBlocks, is_rtl: false },
  });

  assert.equal(await handleControl(update, deps), false, "the tap goes on");
  await flush();

  assert.equal(
    (update.message as { text?: string }).text,
    choiceTurn("Не надо"),
  );
  assert.deepEqual(acks, [["cq-301", "✅ Не надо"]]);
  assert.deepEqual(scheduled, ["tap:7:501:Не надо"]);
  assert.deepEqual(edits, [
    [
      7,
      501,
      {
        rich: {
          blocks: [
            choiceBlocks[0],
            {
              type: "buttons",
              buttons: [
                { text: "Поставить", callback_data: "Поставить" },
                {
                  text: "✅ Не надо",
                  style: "success",
                  callback_data: "Не надо",
                },
              ],
            },
          ],
          is_rtl: false,
        },
      },
    ],
  ]);
});

// Владелец передумал раньше, чем легла первая правка: снимок второго апдейта ещё без «✅».
// Правка второй кнопки несёт и первую отметку, иначе легшая последней правка её стирает.
test("a second button of the same message keeps the first button's mark in its edit", async () => {
  const { edits, deps } = tapDeps();
  assert.equal(
    await handleControl(modelTap(321, 521, "Не надо", richChoice), deps),
    false,
  );
  assert.equal(
    await handleControl(modelTap(322, 521, "Поставить", richChoice), deps),
    false,
  );
  await flush();

  assert.equal(edits.length, 2);
  assert.deepEqual(
    (edits[1][2] as { rich: { blocks: unknown[] } }).rich.blocks[1],
    {
      type: "buttons",
      buttons: [
        { text: "✅ Поставить", style: "success", callback_data: "Поставить" },
        { text: "✅ Не надо", style: "success", callback_data: "Не надо" },
      ],
    },
  );
});

test("a second tap on the same button by another update is «already chosen» and no message", async () => {
  const { acks, edits, deps } = tapDeps();
  assert.equal(
    await handleControl(modelTap(311, 511, "Не надо", richChoice), deps),
    false,
  );
  const second = modelTap(312, 511, "Не надо", richChoice);

  assert.equal(await handleControl(second, deps), true, "the tap is consumed");
  await flush();

  assert.equal(second.message, undefined, "no second message");
  assert.ok(second.callback_query);
  assert.deepEqual(acks, [
    ["cq-311", "✅ Не надо"],
    ["cq-312", "Уже выбрано"],
  ]);
  assert.equal(edits.length, 1);

  // Другие кнопки того же сообщения живые: владелец вправе передумать.
  const other = modelTap(313, 511, "Поставить", richChoice);
  assert.equal(await handleControl(other, deps), false);
  assert.equal(
    (other.message as { text?: string }).text,
    choiceTurn("Поставить"),
  );
});

test("the same update handed out again after write-failed passes as fresh", async () => {
  const { acks, deps } = tapDeps();
  const first = modelTap(321, 521, "Не надо", richChoice);
  const again = modelTap(321, 521, "Не надо", richChoice);

  assert.equal(await handleControl(first, deps), false);
  assert.equal(
    await handleControl(again, deps),
    false,
    "admission gets it again",
  );

  assert.equal(
    (again.message as { text?: string }).text,
    choiceTurn("Не надо"),
  );
  assert.ok(!acks.some(([, text]) => text === "Уже выбрано"));
});

test("a tap that cannot become a message is not marked and not remembered", async () => {
  const { acks, edits, scheduled, deps } = tapDeps();
  // Дробная дата не проходит валидатор очереди: applyTelegramButtonTap отдаёт false.
  const broken = modelTap(331, 531, "Не надо", { ...richChoice, date: 1.5 });

  assert.equal(await handleControl(broken, deps), true);
  await flush();
  assert.deepEqual(acks, [["cq-331", undefined]]);
  assert.deepEqual(scheduled, []);
  assert.deepEqual(edits, []);

  const next = modelTap(332, 531, "Не надо", richChoice);
  assert.equal(await handleControl(next, deps), false, "no key was kept");
  assert.equal((next.message as { text?: string }).text, choiceTurn("Не надо"));
});

test("a failed edit keeps the key: the next tap is still «already chosen»", async () => {
  const { acks, edits, result, deps } = tapDeps();
  result.edit = false;

  assert.equal(
    await handleControl(modelTap(341, 541, "Не надо", richChoice), deps),
    false,
  );
  await flush();
  assert.equal(edits.length, 1);

  const third = modelTap(342, 541, "Не надо", richChoice);
  assert.equal(await handleControl(third, deps), true);
  assert.equal(third.message, undefined);
  assert.deepEqual(acks.at(-1), ["cq-342", "Уже выбрано"]);
});

test("an inaccessible message, one without buttons or with media gets only the hint and still remembers", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["inaccessible", { date: 0 }],
    ["no tree", { text: "Поставить?" }],
    [
      "media",
      {
        rich_message: {
          blocks: [{ type: "photo", photo: [] }, ...choiceBlocks],
        },
      },
    ],
    ["no button", { rich_message: { blocks: [choiceBlocks[0]] } }],
  ];
  let id = 350;
  for (const [label, message] of cases) {
    const { acks, edits, scheduled, deps } = tapDeps();
    id += 2;
    assert.equal(
      await handleControl(modelTap(id, id, "Не надо", message), deps),
      false,
      label,
    );
    await flush();
    assert.deepEqual(acks, [[`cq-${id}`, "✅ Не надо"]], label);
    assert.deepEqual(scheduled, [], label);
    assert.deepEqual(edits, [], label);

    const second = modelTap(id + 1, id, "Не надо", message);
    assert.equal(await handleControl(second, deps), true, label);
    assert.equal(second.message, undefined, label);
  }
});

test("a rejected callback answer does not stop the tap: it is a message and remembered", async () => {
  const { deps } = tapDeps();
  const failingAck = {
    ...deps,
    ackImpl: async () => {
      throw new Error("query is too old");
    },
  };
  const update = modelTap(371, 571, "Не надо", richChoice);

  assert.equal(await handleControl(update, failingAck), false);
  assert.equal(
    (update.message as { text?: string }).text,
    choiceTurn("Не надо"),
  );
  assert.equal(
    await handleControl(modelTap(372, 571, "Не надо", richChoice), failingAck),
    true,
    "the key was kept",
  );
});

test("a stranger's tap and a group tap are neither marked nor remembered", async () => {
  const { acks, edits, scheduled, deps } = tapDeps();
  const stranger = modelTap(381, 581, "Не надо", richChoice);
  (stranger.callback_query as Record<string, unknown>).from = {
    id: 999,
    is_bot: false,
  };
  const group = modelTap(382, 582, "Не надо", {
    ...richChoice,
    chat: { id: -1001, type: "supergroup" },
  });

  assert.equal(await handleControl(stranger, deps), false);
  assert.equal(await handleControl(group, deps), true);
  await flush();

  assert.deepEqual(acks[0], ["cq-381", undefined]);
  assert.match(acks[1][1] ?? "", /личн/u);
  assert.deepEqual(scheduled, []);
  assert.deepEqual(edits, []);
  // Ни один из них не оставил ключа: тап владельца по той же кнопке — свежий.
  const owner = modelTap(383, 581, "Не надо", richChoice);
  assert.equal(await handleControl(owner, deps), false);
});

test("tap memory keeps the first button after 256, 1000 and 3000 other taps", async () => {
  const { deps } = tapDeps();
  assert.equal(await handleControl(modelTap(10_000, 10_000, "x"), deps), false);
  for (let i = 1; i <= 3000; i += 1) {
    assert.equal(
      await handleControl(modelTap(10_000 + i, 10_000 + i, "x"), deps),
      false,
    );
    if (i === 256 || i === 300 || i === 1000 || i === 3000) {
      const again = modelTap(20_000 + i, 10_000, "x");
      assert.equal(
        await handleControl(again, deps),
        true,
        `first key after ${i} other taps`,
      );
      assert.equal(again.message, undefined);
    }
  }
  assert.equal(
    await handleControl(modelTap(10_000, 10_000, "x"), deps),
    false,
    "same failed-admission update remains retryable",
  );
});

test("a tap handed out again while its edit is in flight schedules no second edit", async () => {
  const { deps } = tapDeps();
  let release = () => {};
  const edits: unknown[] = [];
  const slow = {
    ...deps,
    scheduleImpl: undefined,
    editTapImpl: (_chat: number, _message: number, edit: unknown) => {
      edits.push(edit);
      return new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      });
    },
  };

  assert.equal(
    await handleControl(modelTap(391, 591, "Не надо", richChoice), slow),
    false,
  );
  assert.equal(
    await handleControl(modelTap(391, 591, "Не надо", richChoice), slow),
    false,
  );
  assert.equal(edits.length, 1, "the key is still in flight");
  release();
  await flush();
});

// ── «Установить»: пометка только после запуска установщика ──

function proposalTap(
  updateId: number,
  messageId: number,
  message: Record<string, unknown>,
): ControlUpdate {
  return modelTap(updateId, messageId, "iva_plugin:ok:0123456789ab", message);
}

const installRow = [
  { text: "Установить", callback_data: "iva_plugin:ok:0123456789ab" },
];
const classicProposal = { reply_markup: { inline_keyboard: [installRow] } };
const richProposal = {
  rich_message: {
    blocks: [
      { type: "paragraph", text: "Плагин relay" },
      { type: "buttons", buttons: installRow },
    ],
  },
};
const installMarked = {
  text: "✅ Установить",
  style: "success",
  callback_data: "iva_plugin:ok:0123456789ab",
};

function proposalDeps(outcome: string) {
  const recorded = tapDeps();
  const taps: unknown[] = [];
  return {
    ...recorded,
    taps,
    deps: {
      ...recorded.deps,
      pluginTapImpl: async (tap: unknown) => {
        taps.push(tap);
        return outcome;
      },
    },
  };
}

test("«Install» that started marks the button: classic by default, rich too; a second tap is «already chosen»", async () => {
  const expected: Array<[string, Record<string, unknown>, unknown]> = [
    ["classic", classicProposal, { inline_keyboard: [[installMarked]] }],
    [
      "rich",
      richProposal,
      {
        rich: {
          blocks: [
            { type: "paragraph", text: "Плагин relay" },
            { type: "buttons", buttons: [installMarked] },
          ],
        },
      },
    ],
  ];
  let id = 400;
  for (const [label, message, edit] of expected) {
    const { acks, edits, taps, deps } = proposalDeps("started");
    id += 2;
    assert.equal(
      await handleControl(proposalTap(id, id, message), deps),
      true,
      label,
    );
    await flush();
    assert.deepEqual(edits, [[7, id, edit]], label);

    assert.equal(
      await handleControl(proposalTap(id + 1, id, message), deps),
      true,
      label,
    );
    assert.equal(taps.length, 1, `${label}: the installer runs once`);
    assert.deepEqual(acks, [
      [`cq-${id}`, undefined],
      [`cq-${id + 1}`, "Уже выбрано"],
    ]);
  }
});

test("«Install» that did not start or is stale stays live and is not marked", async () => {
  let id = 420;
  for (const outcome of ["not-started", "stale"]) {
    const { edits, scheduled, taps, deps } = proposalDeps(outcome);
    id += 2;
    await handleControl(proposalTap(id, id, classicProposal), deps);
    await handleControl(proposalTap(id + 1, id, classicProposal), deps);
    await flush();
    assert.deepEqual(edits, [], outcome);
    assert.deepEqual(scheduled, [], outcome);
    assert.equal(
      taps.length,
      2,
      `${outcome}: the second tap reaches the installer again`,
    );
  }
});

// Граница с Telegram: какой метод и какое тело уходят на провод, и что считается успехом.
// Правка идёт настоящим путём моста (фон и транспорт), подменён только fetch.
test("the edit goes on the wire as editMessageText with blocks or editMessageReplyMarkup", async () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const calls: Array<[string, Record<string, unknown>]> = [];
  const lines: string[] = [];
  const replies: Array<Record<string, unknown>> = [
    { ok: true, result: {} },
    { ok: true, result: true },
    { ok: false, description: "Bad Request: message is not modified" },
    { ok: false, description: "Bad Request: message can't be edited" },
  ];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    calls.push([url, JSON.parse(init.body) as Record<string, unknown>]);
    return new Response(JSON.stringify(replies[calls.length - 1]));
  }) as typeof fetch;
  console.log = (...parts: unknown[]) => {
    lines.push(parts.slice(1).join(" "));
  };
  const { deps } = recordingDeps();
  const tap = async (id: number, message: Record<string, unknown>) => {
    await handleControl(proposalTap(id, id, message), {
      ...deps,
      pluginTapImpl: async () => "started",
    });
    for (let i = 0; i < 5; i += 1) await flush();
  };
  try {
    await tap(601, {
      rich_message: { ...richProposal.rich_message, is_rtl: true },
    });
    await tap(602, classicProposal);
    await tap(603, classicProposal);
    await tap(604, classicProposal);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }

  assert.equal(calls.length, 4);
  assert.match(calls[0][0], /\/editMessageText$/u);
  assert.deepEqual(calls[0][1], {
    chat_id: 7,
    message_id: 601,
    rich_message: {
      blocks: [
        { type: "paragraph", text: "Плагин relay" },
        { type: "buttons", buttons: [installMarked] },
      ],
      is_rtl: true,
    },
  });
  assert.match(calls[1][0], /\/editMessageReplyMarkup$/u);
  assert.deepEqual(calls[1][1], {
    chat_id: 7,
    message_id: 602,
    reply_markup: { inline_keyboard: [[installMarked]] },
  });
  const verdicts = lines.filter((line) => line.startsWith("tap mark"));
  assert.deepEqual(verdicts, [
    "tap marked 7:601 editMessageText",
    "tap marked 7:602 editMessageReplyMarkup",
    "tap marked 7:603 editMessageReplyMarkup",
    "tap mark failed 7:604 editMessageReplyMarkup",
  ]);
});

// ── «Я в курсе» под пунктом Watch: путь кода в мосте, модель не будится ─────────────────────
const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);
const watchItem = {
  rich_message: {
    blocks: [
      { type: "paragraph", text: "Иван ждёт ответа про договор." },
      {
        type: "buttons",
        buttons: [{ text: "Я в курсе", callback_data: "Я в курсе: Иван" }],
      },
    ],
  },
};

function gotItDeps(result: boolean | Error = true) {
  const { acks, replies, deps } = tapDeps();
  const deletes: Array<[number, number]> = [];
  return {
    acks,
    replies,
    deletes,
    deps: {
      ...deps,
      deleteImpl: async (chatId: number, messageId: number) => {
        deletes.push([chatId, messageId]);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

/** Модель не будится: апдейт не стал сообщением, колбэк остался колбэком. */
function modelNotWoken(update: ControlUpdate): void {
  assert.equal(update.message, undefined, "the tap became a message");
  assert.ok(update.callback_query, "the callback was rewritten");
}

test("«Я в курсе: Иван» deletes the Watch message, shows ✅ and never reaches the model", async () => {
  const { acks, deletes, replies, deps } = gotItDeps();
  const update = modelTap(701, 801, "Я в курсе: Иван", watchItem);

  assert.equal(await handleControl(update, deps), true, "consumed");
  await flush();

  modelNotWoken(update);
  assert.deepEqual(deletes, [[7, 801]]);
  assert.deepEqual(acks, [["cq-701", "✅ Я в курсе"]]);
  assert.deepEqual(replies, [], "no message in the chat");
});

test("a second «Я в курсе» on the deleted message is a hint, no second delete, no model", async () => {
  const { acks, deletes, deps } = gotItDeps();
  await handleControl(modelTap(711, 811, "Я в курсе: Иван", watchItem), deps);
  const again = modelTap(712, 811, "Я в курсе: Иван", watchItem);

  assert.equal(await handleControl(again, deps), true);
  modelNotWoken(again);
  assert.deepEqual(deletes, [[7, 811]]);
  assert.deepEqual(acks.at(-1), ["cq-712", "Уже убрано"]);

  // Память моста пуста (рестарт): Telegram уже не находит сообщение — подсказка, без падения.
  const gone = gotItDeps(false);
  const late = modelTap(713, 812, "Я в курсе: Иван", watchItem);
  assert.equal(await handleControl(late, gone.deps), true);
  modelNotWoken(late);
  assert.deepEqual(gone.acks, [["cq-713", "Не смогла удалить сообщение"]]);
});

test("a refused or failed deleteMessage gives the «could not delete» hint and nothing else", async () => {
  for (const result of [false, new Error("network down")]) {
    const { acks, deletes, replies, deps } = gotItDeps(result);
    const update = modelTap(721, 821, "Я в курсе: Иван", watchItem);

    assert.equal(await handleControl(update, deps), true);
    await flush();

    modelNotWoken(update);
    assert.deepEqual(deletes, [[7, 821]]);
    assert.deepEqual(acks, [["cq-721", "Не смогла удалить сообщение"]]);
    assert.deepEqual(replies, []);
  }
  // Отказ не запомнен: следующий тап снова пробует удалить.
  const { deletes, deps } = gotItDeps(true);
  await handleControl(modelTap(722, 821, "Я в курсе: Иван", watchItem), deps);
  assert.deepEqual(deletes, [[7, 821]]);
});

test("«Я в курсе» from a stranger or from a group deletes nothing and never reaches the model", async () => {
  const stranger = gotItDeps();
  const update = modelTap(731, 831, "Я в курсе: Иван", watchItem);
  (update.callback_query as { from: unknown }).from = { id: 99, is_bot: false };
  assert.equal(await handleControl(update, stranger.deps), true);
  modelNotWoken(update);
  assert.deepEqual(stranger.deletes, []);
  assert.deepEqual(stranger.acks, [["cq-731", undefined]]);

  const group = gotItDeps();
  const inGroup = modelTap(732, 832, "Я в курсе: Иван", {
    ...watchItem,
    chat: { id: -100, type: "supergroup" },
  });
  assert.equal(await handleControl(inGroup, group.deps), true);
  modelNotWoken(inGroup);
  assert.deepEqual(group.deletes, []);
  assert.deepEqual(group.acks, [
    ["cq-732", "Открой личный чат со мной, чтобы использовать это управление."],
  ]);
});

test("the default deleteImpl calls deleteMessage on the wire; a refusal is the hint", async () => {
  const realFetch = globalThis.fetch;
  const calls: Array<[string, Record<string, unknown>]> = [];
  const replies: unknown[] = [
    { ok: true, result: true },
    { ok: false, description: "Bad Request: message can't be deleted" },
  ];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    calls.push([url, JSON.parse(init.body) as Record<string, unknown>]);
    return new Response(JSON.stringify(replies[calls.length - 1]));
  }) as typeof fetch;
  const { acks, deps } = recordingDeps();
  try {
    await handleControl(modelTap(741, 841, "Я в курсе: Иван", watchItem), deps);
    await handleControl(modelTap(742, 842, "Я в курсе: Иван", watchItem), deps);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /\/deleteMessage$/u);
  assert.deepEqual(calls[0][1], { chat_id: 7, message_id: 841 });
  assert.deepEqual(acks, [
    ["cq-741", "✅ Я в курсе"],
    ["cq-742", "Не смогла удалить сообщение"],
  ]);
});

/** Язык владельца на время теста: settings.json и сдвиг часов мимо кэша getLang (2 с). */
async function inLanguage<T>(language: string, work: () => Promise<T>) {
  const realNow = Date.now;
  const settings = join(dataDir, "settings.json");
  const write = (lang: string, shift: number) => {
    writeFileSync(
      settings,
      JSON.stringify({ menuStyle: "rich", language: lang }),
    );
    Date.now = () => realNow() + shift;
  };
  write(language, 10_000);
  try {
    return await work();
  } finally {
    write("ru", 20_000);
    await handleControl(modelTap(1, 1, "iva_noop"), recordingDeps().deps);
    Date.now = realNow;
  }
}

test("an English owner's «Got it: Ivan» is the bridge's; the Russian words then go to the model", async () => {
  await inLanguage("en", async () => {
    const { acks, deletes, deps } = gotItDeps();
    const update = modelTap(751, 851, "Got it: Ivan", watchItem);
    assert.equal(await handleControl(update, deps), true);
    modelNotWoken(update);
    assert.deepEqual(deletes, [[7, 851]]);
    assert.deepEqual(acks, [["cq-751", "✅ Got it"]]);

    const russian = modelTap(752, 852, "Я в курсе: Иван", watchItem);
    assert.equal(await handleControl(russian, deps), false);
    assert.equal(
      (russian.message as { text?: string }).text,
      "Я в курсе: Иван\n\n(button under Iva's message: «Иван ждёт ответа про договор.»)",
    );
    assert.deepEqual(deletes, [[7, 851]]);
  });
});

test(`property: only the exact «Я в курсе: <name>» stays in the bridge; any other data reaches the model (seed ${SEED})`, async () => {
  const PREFIX = "Я в курсе: ";
  const oracle = (data: string) =>
    data.startsWith(PREFIX) && data.slice(PREFIX.length).trim() !== "";
  const name = fc.oneof(
    fc.string({ maxLength: 40 }),
    fc.constantFrom('"Иван"', "«Иван»", "Иван ".repeat(20), " ", "\t", ""),
  );
  const data = fc.oneof(
    name.map((n) => PREFIX + n),
    fc
      .tuple(
        fc.constantFrom(
          "я в курсе: ",
          "Я в курсе:",
          "Я в курсе : ",
          " Я в курсе: ",
          "Я  в курсе: ",
          "Я в курсе ",
          "Got it: ",
          "В задачи: ",
          "Позже: ",
          "«Я в курсе: ",
        ),
        name,
      )
      .map(([p, n]) => p + n),
    fc.string({ maxLength: 60 }),
  );
  let id = 10_000;
  await fc.assert(
    fc.asyncProperty(
      data.filter(
        (d) => d.trim() !== "" && !d.startsWith("iva_") && !d.startsWith("eve"),
      ),
      async (d) => {
        id += 1;
        const { deletes, deps } = gotItDeps();
        const update = modelTap(id, id, d, watchItem);
        const consumed = await handleControl(update, deps);
        if (oracle(d)) {
          assert.equal(consumed, true);
          modelNotWoken(update);
          assert.deepEqual(deletes, [[7, id]]);
          return;
        }
        assert.deepEqual(deletes, [], `deleted for ${JSON.stringify(d)}`);
        assert.equal(
          consumed,
          false,
          `kept from the model: ${JSON.stringify(d)}`,
        );
        assert.equal(
          (update.message as { text?: string }).text,
          `${d}\n\n(кнопка под сообщением Ивы: «Иван ждёт ответа про договор.»)`,
        );
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
});

// ── Тап несёт текст сообщения с кнопкой (дефект 07.10.2026) ─────────────────────────────────
// Обзор с одной кнопкой «Составить ответ»: по нажатию модель получила только data и пошла
// искать, кому и о чём. Теперь ход получает и текст сообщения, под которым стояла кнопка.

const tapText = (update: ControlUpdate) =>
  (update.message as { text?: string }).text;

test("a tap under a plain message carries the message text to the turn", async () => {
  const { deps } = tapDeps();
  const update = modelTap(901, 1901, "Составить ответ", {
    text: "Юрий спрашивает про смету на ремонт. Составить ответ Юрию?",
  });

  assert.equal(await handleControl(update, deps), false);
  assert.equal(
    tapText(update),
    "Составить ответ\n\n(кнопка под сообщением Ивы: «Юрий спрашивает про смету на ремонт. Составить ответ Юрию?»)",
  );
});

test("a tap under a rich message carries paragraphs, lists and tables, not the buttons", async () => {
  const { deps } = tapDeps();
  const update = modelTap(911, 1911, "Ответить: Юрий, смета", {
    rich_message: {
      blocks: [
        { type: "paragraph", text: "Юрий спрашивает про смету." },
        {
          type: "list",
          items: [
            { blocks: [{ type: "paragraph", text: "срок пятница" }] },
            { blocks: [{ type: "paragraph", text: "сумма 120 000" }] },
          ],
        },
        {
          type: "table",
          cells: [
            [{ text: "Кто" }, { text: "Что" }],
            [{ text: "Юрий" }, { text: "смета" }],
          ],
        },
        {
          type: "buttons",
          buttons: [
            {
              text: "Составить ответ",
              callback_data: "Ответить: Юрий, смета",
            },
          ],
        },
      ],
    },
  });

  assert.equal(await handleControl(update, deps), false);
  const text = tapText(update) as string;
  assert.ok(
    text.startsWith("Ответить: Юрий, смета\n\n(кнопка под сообщением Ивы: «"),
  );
  for (const part of [
    "Юрий спрашивает про смету.",
    "срок пятница",
    "сумма 120 000",
    "Юрий",
    "смета",
  ])
    assert.ok(text.includes(part), part);
  assert.ok(!text.includes("Составить ответ"), "button labels stay out");
  assert.ok(text.endsWith("»)"));
});

test("a tap under a message without text is the data alone, as before", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["inaccessible", { date: 0 }],
    ["blank text", { text: "   " }],
    ["buttons only", { rich_message: { blocks: [choiceBlocks[1]] } }],
    ["no blocks", { rich_message: {} }],
    ["garbage blocks", { rich_message: { blocks: [null, 5, "", {}] } }],
  ];
  let id = 920;
  for (const [label, message] of cases) {
    const { deps } = tapDeps();
    id += 1;
    const update = modelTap(id, 1000 + id, "Не надо", message);
    assert.equal(await handleControl(update, deps), false, label);
    assert.equal(tapText(update), "Не надо", label);
  }
});

test("a long message text is cut to the limit with a mark at the end", async () => {
  const { deps } = tapDeps();
  const long = "смета ".repeat(600);
  const update = modelTap(931, 1931, "Составить ответ", { text: long });

  assert.equal(await handleControl(update, deps), false);
  const context = tapContextText({ text: long });
  assert.equal(Array.from(context).length <= TAP_CONTEXT_LIMIT, true);
  assert.ok(context.endsWith(" […обрезано]"), context.slice(-30));
  assert.ok(long.startsWith(context.slice(0, -" […обрезано]".length)));
  assert.equal(
    tapText(update),
    `Составить ответ\n\n(кнопка под сообщением Ивы: «${context}»)`,
  );
  // Ровно на пределе текст не режется.
  const exact = "я".repeat(TAP_CONTEXT_LIMIT);
  assert.equal(tapContextText({ text: exact }), exact);
});

test(`property: the message text for a tap never throws and never exceeds the limit (seed ${SEED})`, () => {
  const leaf = fc.oneof(
    fc.string({ maxLength: 400 }),
    fc.string({ unit: "grapheme", maxLength: 400 }),
    fc.constantFrom(
      "",
      " ",
      "# заголовок",
      "[ссылка](javascript:x)",
      "a".repeat(5000),
    ),
  );
  const block = fc.letrec((tie) => ({
    node: fc.oneof(
      { depthSize: "small" },
      leaf.map((text) => ({ type: "paragraph", text })),
      fc.array(tie("node"), { maxLength: 4 }).map((items) => ({
        type: "list",
        items: items.map((b) => ({ blocks: [b] })),
      })),
      fc
        .array(fc.array(leaf, { maxLength: 4 }), { maxLength: 4 })
        .map((rows) => ({
          type: "table",
          cells: rows.map((row) => row.map((text) => ({ text }))),
        })),
      fc.constant({
        type: "buttons",
        buttons: [{ text: "x", callback_data: "x" }],
      }),
      fc.anything(),
    ),
  })).node;
  const message = fc.oneof(
    fc.record({ text: leaf }),
    fc.record({
      rich_message: fc.record({ blocks: fc.array(block, { maxLength: 8 }) }),
    }),
    fc.record({ rich_message: fc.anything() }),
    fc.dictionary(fc.string(), fc.anything()),
  );
  fc.assert(
    fc.property(message, (m) => {
      const context = tapContextText(m);
      assert.equal(typeof context, "string");
      assert.ok(Array.from(context).length <= TAP_CONTEXT_LIMIT);
    }),
    { seed: SEED, numRuns: 300 },
  );
});

// Первый запрос хода оборвался посреди ответа: в истории сессии вопроса нет, и модель
// узнаёт его только из текста нажатия «Повторить» — сообщение об обрыве цитирует вопрос.
// Цепочка целиком: текст канала → сообщение, как его вернёт Telegram → мост → ход eve с
// пустой историей.
test("a Try again tap after a first-request break brings the question to an empty history", async () => {
  const { telegramFailureMessage } =
    await import("#lib/telegram-failure-notice.ts");
  // Вопрос длиннее цитаты (120 знаков): модель обязана получить его целиком, а не цитату.
  const question = `Сколько стоит *ремонт* кухни в Ташкенте? ${"подробности ".repeat(30)}КОНЕЦ-ВОПРОСА`;
  const { rememberTurnQuestion } = await import("#lib/turn-question.ts");
  rememberTurnQuestion("7:", { text: question, media: false });
  const failure = telegramFailureMessage(
    {
      message: "terminated",
      details: { errorId: "e-1", attempts: 1, answerStarted: true },
      question,
    },
    "claude",
  );
  const [shown = ""] = failure.split("\n\n<tg-button-row>");
  const data = /data="([^"]+)"/u.exec(failure)?.[1] ?? "";
  assert.equal(data, "Повторить");
  // Telegram отдаёт rich-сообщение блоками: абзац уже без экранирования разметки.
  const update = modelTap(931, 1931, data, {
    rich_message: {
      blocks: [
        { type: "paragraph", text: shown.replace(/\\(.)/gu, "$1") },
        { type: "buttons", buttons: [{ text: data, callback_data: data }] },
      ],
    },
  });
  const { deps } = tapDeps();
  assert.equal(await handleControl(update, deps), false);
  const turnText = (update.message as { text?: string }).text ?? "";
  assert.ok(turnText.startsWith("Повторить\n\n(кнопка под сообщением Ивы: «"));

  const { MockLanguageModelV4, convertArrayToReadableStream } =
    await import("ai/test");
  const { createToolLoopHarness } =
    await import("../../node_modules/eve/dist/src/harness/tool-loop.js");
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return Promise.resolve({
        stream: convertArrayToReadableStream([
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "ok" },
          { type: "text-end", id: "t" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ]),
      });
    },
  });
  const step = createToolLoopHarness({
    mode: "conversation",
    tools: new Map(),
    resolveModel: () => Promise.resolve(model),
    handleEvent: () => Promise.resolve(),
  });
  const result = await step(
    {
      agent: { system: "Ты Ива.", tools: [], modelReference: { id: "t/m" } },
      compaction: { threshold: 100_000, recentWindowSize: 100 },
      continuationToken: "t",
      sessionId: "t",
      history: [],
    },
    { message: turnText },
  );
  assert.equal(result.settledTurn?.output, "ok");
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]?.includes(question), prompts[0]);
});

// Своя кнопка модели с той же подписью под другим сообщением вопрос не подставляет: это
// реплика владельца, а не нажатие под сообщением об обрыве.
test("a model's own «Повторить» button under another message brings no stored question", async () => {
  const { rememberTurnQuestion } = await import("#lib/turn-question.ts");
  rememberTurnQuestion("7:", { text: "СКРЫТЫЙ-ВОПРОС", media: false });
  const update = modelTap(932, 1932, "Повторить", {
    text: "Отправить письмо Юрию ещё раз?",
  });
  const { deps } = tapDeps();
  assert.equal(await handleControl(update, deps), false);
  const turnText = (update.message as { text?: string }).text ?? "";
  assert.doesNotMatch(turnText, /СКРЫТЫЙ-ВОПРОС/u);
});

test("native stop is handled before admission and leaves the next turn and compaction alone", async () => {
  runningTurn();
  const { cancels, replies, acks, deps } = recordingDeps();
  assert.equal(await handleControl(nativeStop(), deps), true);
  assert.equal(cancels.length, 1);
  assert.equal(status.getChatStatus("7:")?.wasCancelled, true);
  runningTurn({ turnId: "turn-new", draftId: 42 });
  assert.equal(await handleControl(nativeStop(), deps), true);
  assert.equal(cancels.length, 1);
  assert.equal(status.getChatStatus("7:")?.wasCancelled, undefined);
  runningTurn({ turnId: "turn-compacting", draftId: 41, compacting: true });
  assert.equal(await handleControl(nativeStop(), deps), true);
  assert.equal(cancels.length, 2);
  assert.equal(status.getChatStatus("7:")?.wasCancelled, undefined);
  assert.deepEqual(replies, []);
  assert.deepEqual(acks, []);
});
