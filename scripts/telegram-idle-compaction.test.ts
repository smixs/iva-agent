/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; the fetch double keeps the async boundary. */
// Свёртка между ходами на живом шве канала: хук шага пишет вход, канал на turn.completed
// решает, на session.waiting занимает чат (running + compacting) и зовёт штатный роут eve
// POST /eve/v1/session/:id/compact с общим токеном. Конец пересказа (снова session.waiting)
// освобождает чат. Двойник стоит только на внешних границах: Bot API, роут и сессия eve;
// статус чата — настоящий файл, маршрутизация моста настоящая.
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import type { ChannelSource, Session } from "eve/channels";
import type { TelegramChannelState } from "eve/channels/telegram";

const dataDir = mkdtempSync(join(tmpdir(), "iva-idle-compaction-"));
const vault = mkdtempSync(join(tmpdir(), "iva-idle-compaction-vault-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.ASSISTANT_VAULT_DIR = vault;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_ALLOWED_USER_IDS = "9";
process.env.TELEGRAM_BOT_TOKEN = "12345:idle-compaction-test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "idle-compaction-test-secret";
process.env.TELEGRAM_BOT_USERNAME = "my_bot";
process.env.ASSISTANT_BEARER = "idle-compaction-test-bearer";
delete process.env.ASSISTANT_HOST;
delete process.env.IVA_PORT;
after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
});

type ApiCall = { method: string; body: Record<string, unknown> | undefined };
const apiCalls: ApiCall[] = [];
const compactCalls: { sessionId: string; auth: string | null }[] = [];
// Что отвечает eve на просьбу: приняла, сессии нет, отказала, либо ответа нет вовсе.
let manualSessionId: string | null = null;
const manualRequests: { body: unknown; auth: string | null }[] = [];
let compactStatus:
  "accepted" | "no_active_session" | "refused" | "broken" | "silent" =
  "accepted";
// Что успевает случиться, пока просьба летит к eve.
let whileAsking: (() => Promise<void>) | null = null;

const COMPACT_URL =
  /^http:\/\/127\.0\.0\.1:8723\/eve\/v1\/session\/([^/]+)\/compact$/u;
globalThis.fetch = async (url, init = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the double reads whatever the caller passes.
  const href = String(url);
  if (href === `http://127.0.0.1:8723${TELEGRAM_COMPACT_ROUTE}`) {
    const request = new Request(href, init);
    manualRequests.push({
      body: await request.clone().json(),
      auth: request.headers.get("x-telegram-bot-api-secret-token"),
    });
    return route(TELEGRAM_COMPACT_ROUTE).handler(request, {
      attachSession: (id) => ({ id }) as Session,
      resolveSession: async () =>
        manualSessionId ? ({ id: manualSessionId } as Session) : undefined,
      from: unused,
      to: unused,
      params: {},
      waitUntil: unused,
      requestIp: "127.0.0.1",
    });
  }
  const compact = COMPACT_URL.exec(href);
  if (compact) {
    const sessionId = decodeURIComponent(compact[1] ?? "");
    compactCalls.push({
      sessionId,
      auth: new Headers(init.headers).get("authorization"),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    await whileAsking?.();
    if (compactStatus === "silent") throw new Error("request timed out");
    if (compactStatus === "refused")
      return new Response("unauthorized", { status: 401 });
    if (compactStatus === "broken")
      return new Response("dispatcher failed", { status: 500 });
    return compactStatus === "accepted"
      ? Response.json(
          { ok: true, sessionId, status: "accepted" },
          { status: 202 },
        )
      : Response.json({ ok: true, status: "no_active_session" });
  }
  const method = new URL(href).pathname.split("/").at(-1) ?? "";
  const body = init.body
    ? // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the double reads whatever eve passes.
      (JSON.parse(String(init.body)) as Record<string, unknown>)
    : undefined;
  apiCalls.push({ method, body });
  return Response.json({
    ok: true,
    result: { message_id: 500 + apiCalls.length, chat: { id: 1 } },
  });
};

type Handler = (data: Record<string, unknown>, context: unknown) => unknown;
type Adapter = {
  state: Record<string, unknown>;
  createAdapterContext: (base: {
    ctx: unknown;
    session: unknown;
    state: Record<string, unknown>;
  }) => unknown;
  "turn.started": Handler;
  "turn.completed": Handler;
  "turn.cancelled": Handler;
  "turn.failed": Handler;
  "session.waiting": Handler;
};

const channelModule = "../agent/channels/telegram.ts?idle-compaction-test";
const [
  { default: channel },
  { TELEGRAM_COMPACT_ROUTE },
  { default: usageHook },
  { providerConfig },
  { idleCompactionLimit },
  runStatus,
  { queuedNoticeText },
  routing,
  { ContextContainer, contextStorage },
  { SessionKey },
] = await Promise.all([
  import(channelModule) as Promise<
    typeof import("../agent/channels/telegram.ts")
  >,
  import("../agent/lib/telegram-compact-route.ts"),
  import("../agent/hooks/usage.ts"),
  import("../agent/provider.ts"),
  import("../agent/lib/compaction.ts"),
  import("../agent/lib/run-status.ts"),
  import("./poller/queue.ts"),
  import("./poller/routing.ts"),
  import("../node_modules/eve/dist/src/context/container.js"),
  import("../node_modules/eve/dist/src/context/keys.js"),
]);
const adapter = (channel as unknown as { adapter: Adapter }).adapter;
const route = (path: string) => {
  const found = channel.routes.find((candidate) => candidate.path === path);
  if (!found || found.transport === "websocket")
    throw new Error(`Telegram channel did not expose ${path}`);
  return found;
};
const webhook = route("/eve/v1/telegram");
const unused = () => {
  throw new Error("not used by this path");
};

const LIMIT = idleCompactionLimit(providerConfig.contextWindow);
const hookEvents = (
  usageHook as unknown as {
    events: Record<string, (event: unknown, ctx: unknown) => unknown>;
  }
).events;
// Просьба о свёртке уходит без ожидания: даём её промису дойти до конца.
const settle = async () => {
  for (let i = 0; i < 20; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};
const statusOf = (chatId: number) => runStatus.getChatStatus(`${chatId}:`);
const settings = join(dataDir, "settings.json");

let seq = 0;
beforeEach(() => {
  apiCalls.length = 0;
  manualRequests.length = 0;
  manualSessionId = null;
  compactCalls.length = 0;
  compactStatus = "accepted";
  whileAsking = null;
  rmSync(settings, { force: true });
});

function step(sessionId: string, tokens: number) {
  hookEvents["step.completed"](
    {
      data: {
        stepIndex: 0,
        turnId: "turn_x",
        usage: { inputTokens: tokens, outputTokens: 10, cacheReadTokens: 0 },
      },
    },
    { session: { id: sessionId }, channel: { kind: "channel:telegram" } },
  );
}

/** События одной сессии в одном чате, в порядке eve. */
function session(sessionId: string, chatId: number) {
  const emit = async (
    name:
      | "turn.started"
      | "turn.completed"
      | "turn.cancelled"
      | "turn.failed"
      | "session.waiting",
    turnId: string,
    settled = true,
  ) => {
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId,
      turn: { id: turnId, sequence: seq },
    });
    const context = adapter.createAdapterContext({
      ctx,
      session: {
        id: sessionId,
        auth: { current: null, initiator: null },
        continuation: { token: `telegram:${chatId}::`, rekey() {} },
      },
      state: {
        ...adapter.state,
        chatId: String(chatId),
        chatType: "private",
        messageThreadId: null,
      },
    });
    await contextStorage.run(ctx, async () => {
      await adapter[name](
        { sequence: seq, turnId, code: "TEST", message: "turn failed" },
        context,
      );
    });
    if (settled) await settle();
  };
  return {
    /** Ход: turn.started → шаги → turn.completed; парковку шлёт вызывающий. */
    async turn(steps: number[]) {
      const turnId = `turn_${++seq}`;
      await emit("turn.started", turnId);
      for (const tokens of steps) step(sessionId, tokens);
      await emit("turn.completed", turnId);
    },
    started: () => emit("turn.started", `turn_${++seq}`),
    /** Незаконченный ход: turn.started и шаги, конец шлёт вызывающий. */
    async running(steps: number[]) {
      await emit("turn.started", `turn_${++seq}`);
      for (const tokens of steps) step(sessionId, tokens);
    },
    waiting: () => emit("session.waiting", `turn_${seq}`),
    /** Парковка без паузы после обработчика: видно, что он сам дождался ответа eve. */
    waitingOnly: () => emit("session.waiting", `turn_${seq}`, false),
    cancelled: () => emit("turn.cancelled", `turn_${seq}`),
    failed: () => emit("turn.failed", `turn_${seq}`),
    compacted: () =>
      hookEvents["compaction.completed"](
        { data: {} },
        { session: { id: sessionId } },
      ),
    /** eve объявила начало пересказа (хук). */
    async compacting() {
      await hookEvents["compaction.requested"](
        { data: {} },
        { session: { id: sessionId } },
      );
      await settle();
    },
  };
}

/** Сообщение владельца через настоящий вебхук канала; возвращает число доставок в eve. */
const incomingContexts: unknown[] = [];
async function incoming(
  chatId: number,
  sessionId: string,
  updateId = ++seq,
  accepted = false,
): Promise<number> {
  let sends = 0;
  const pending: Promise<unknown>[] = [];
  const target = { id: sessionId } as Session;
  const source = {
    send: async (...input: unknown[]) => {
      incomingContexts.push(input);
      sends += 1;
      return target;
    },
    respond: async () => target,
    cancel: unused,
    compact: unused,
    clear: unused,
    reset: unused,
  } as unknown as ChannelSource<TelegramChannelState>;
  const deliveryRoute = accepted ? route("/eve/v1/telegram/accepted") : webhook;
  const response = await deliveryRoute.handler(
    new Request("http://local/eve/v1/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "idle-compaction-test-secret",
      },
      body: JSON.stringify({
        update_id: updateId,
        message: {
          message_id: 100 + seq,
          chat: { id: chatId, type: "private" },
          from: { id: 9, is_bot: false, username: "owner" },
          text: "ещё вопрос",
        },
      }),
    }),
    {
      attachSession: () => target,
      from: () => source,
      resolveSession: async () => target,
      to: unused,
      params: {},
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      requestIp: "127.0.0.1",
    },
  );
  assert.ok(response.status === 200 || (accepted && response.status === 204));
  await Promise.all(pending);
  return sends;
}

const sentStatuses = () =>
  apiCalls.filter((call) => call.method === "sendRichMessage").length;

test("ход под порогом чат не занимает; ход на пороге на парковке занимает чат и просит пересказ у своей сессии с общим токеном", async () => {
  const low = session("s-low", 41);
  await low.turn([LIMIT - 1]);
  await low.waiting();
  assert.deepEqual(compactCalls, []);
  assert.equal(statusOf(41)?.status, "idle");

  const over = session("s-over", 42);
  await over.turn([1_000, LIMIT]);
  assert.deepEqual(compactCalls, [], "до парковки просьбы нет");
  assert.equal(
    statusOf(42)?.status,
    "running",
    "до парковки сохраняется резерв свёртки",
  );
  assert.equal(
    await (await import("./lib/deferred-command.ts")).activityBusy(dataDir),
    true,
  );
  await over.waiting();
  assert.deepEqual(compactCalls, [
    { sessionId: "s-over", auth: "Bearer idle-compaction-test-bearer" },
  ]);
  const busy = statusOf(42);
  assert.equal(busy?.status, "running");
  assert.equal(busy?.sessionId, "s-over");
  assert.equal(busy?.compacting, true);
  assert.equal(busy?.draftId, undefined, "своего «Работаю…» у пересказа нет");
  assert.equal(runStatus.isRunning("42:"), true);
});

test("обработчик парковки сам дожидается ответа eve: когда он вернулся, просьба уже принята и чат занят", async () => {
  const s = session("s-await", 54);
  await s.turn([LIMIT]);
  await s.waitingOnly();
  assert.equal(compactCalls.length, 1);
  assert.equal(statusOf(54)?.compacting, true);
  await s.waiting();
});

test("срок записи пересказа тот же, что у хода", async () => {
  const s = session("s-stale", 58);
  await s.turn([LIMIT]);
  await s.waiting();
  assert.equal(runStatus.isCompacting("58:"), true);
  assert.equal(
    runStatus.isCompacting("58:", Date.now() + runStatus.RUN_STALE_MS - 5_000),
    true,
  );
  assert.equal(
    runStatus.isRunning("58:", Date.now() + runStatus.RUN_STALE_MS + 5_000),
    false,
  );
  await s.waiting();
  assert.equal(runStatus.isCompacting("58:"), false);
});

test("конец пересказа — следующая парковка — освобождает чат, и второй просьбы на тот же ход нет", async () => {
  const s = session("s-done", 43);
  await s.turn([LIMIT]);
  await s.waiting();
  s.compacted();
  await s.waiting();
  assert.equal(statusOf(43)?.status, "idle");
  assert.equal(statusOf(43)?.compacting, undefined);
  assert.equal(compactCalls.length, 1);
  await s.waiting();
  assert.equal(compactCalls.length, 1);
});

test("порядок queue: сообщение во время пересказа мост ставит в свою очередь и отвечает «Сжимаю разговор»", async () => {
  const s = session("s-queue", 44);
  await s.turn([LIMIT]);
  await s.waiting();
  const acks: string[] = [];
  const queued: unknown[] = [];
  const update = {
    update_id: 9001,
    message: {
      message_id: 9001,
      chat: { id: 44, type: "private" },
      from: { id: 9, is_bot: false, username: "owner" },
      text: "ещё вопрос",
    },
  };
  const result = await routing.routeMessageUpdate(update, {
    loadQueueImpl: () => ({ version: 1, queues: {} }),
    enqueueImpl: (_key, candidate) => {
      queued.push(candidate);
      return { count: 1 };
    },
    acknowledgeImpl: (_update, count) => {
      acks.push(queuedNoticeText(count, statusOf(44)));
    },
    deliverImpl: () => assert.fail("занятый чат: в eve не доставляем"),
    resetPendingImpl: () => false,
  });
  assert.equal(result, "queued");
  assert.equal(queued.length, 1);
  assert.deepEqual(acks, [
    "Compacting the conversation, I'll answer in a moment.",
  ]);
  // Ответ на сообщение бота обычно идёт мимо очереди; пока чат занят пересказом — в очередь.
  const reply = {
    ...update,
    update_id: 9002,
    message: { ...update.message, message_id: 9002 },
  };
  const replyDeps = {
    loadQueueImpl: () => ({ version: 1 as const, queues: {} }),
    replyToBotImpl: () => true,
    resetPendingImpl: () => false,
    acknowledgeImpl: () => {},
  };
  assert.equal(
    await routing.routeMessageUpdate(reply, {
      ...replyDeps,
      enqueueImpl: () => ({ count: 2 }),
      deliverImpl: () =>
        assert.fail("пересказ идёт: ответ ждёт в очереди моста"),
    }),
    "queued",
  );
  s.compacted();
  await s.waiting();
  let delivered = 0;
  assert.equal(
    await routing.routeMessageUpdate(reply, {
      ...replyDeps,
      enqueueImpl: () => assert.fail("чат свободен: ответ идёт напрямую"),
      deliverImpl: async () => {
        delivered += 1;
        return true;
      },
    }),
    "delivered",
  );
  assert.equal(delivered, 1);
  // Вне пересказа текст очереди прежний.
  assert.equal(
    queuedNoticeText(2, { status: "running", sessionId: "x" }),
    "Queued (2). I'll start it automatically when the current task finishes.",
  );
  assert.equal(
    queuedNoticeText(1, { status: "idle", compacting: true }),
    "Queued (1). I'll start it automatically when the current task finishes.",
  );
});

test("порядок steer: сообщение уходит в eve и сразу видит знак, чужой записи не трогая; обрыв пересказа освобождает чат, ход забирает знак", async () => {
  writeFileSync(settings, JSON.stringify({ turnPolicy: "steer" }));
  const s = session("s-steer", 45);
  await s.turn([LIMIT]);
  await s.waiting();
  assert.equal(compactCalls.length, 1, "пересказ просим при любом порядке");
  apiCalls.length = 0;
  manualRequests.length = 0;
  manualSessionId = null;
  assert.equal(await incoming(45, "s-steer"), 1, "сообщение доставлено в eve");
  // Чат занят пересказом: раннего статуса нет, запись пересказа не тронута, но под
  // сообщением сразу знак очереди — без него минута пересказа выглядит как тишина.
  assert.equal(sentStatuses(), 0, "временных сообщений нет");
  assert.equal(statusOf(45)?.compacting, true);
  assert.equal(statusOf(45)?.ingressId, undefined);
  const sign = statusOf(45)?.queuedIngressId;
  assert.equal(typeof sign, "string");

  await s.waiting(); // eve оборвала пересказ и запарковала сессию
  assert.equal(statusOf(45)?.status, "idle");
  await s.started(); // и начала ход по сообщению
  const running = statusOf(45);
  assert.equal(running?.status, "running");
  assert.equal(running?.sessionId, "s-steer");
  assert.equal(running?.compacting, undefined);
  assert.equal(sentStatuses(), 0, "ход представлен черновиком");
  assert.equal(typeof running?.draftId, "number");
  assert.equal(running?.queuedIngressId, undefined);
  assert.equal(typeof running?.ingressAt, "number");
  assert.equal(compactCalls.length, 1, "оборванный ход ничего не просил");
});

test("ход, начавшийся поверх записи пересказа (парковка опоздала), не наследует признак пересказа", async () => {
  const s = session("s-late", 46);
  await s.turn([LIMIT]);
  await s.waiting();
  await s.started();
  assert.equal(statusOf(46)?.status, "running");
  assert.equal(statusOf(46)?.compacting, undefined);
  assert.equal(typeof statusOf(46)?.turnId, "string");
});

test("eve отказала (сессии уже нет, запрос отвергнут): чат снова свободен, следующий ход просит заново", async () => {
  for (const [status, chatId] of [
    ["no_active_session", 47],
    ["refused", 48],
  ] as const) {
    compactStatus = status;
    const s = session(`s-${status}`, chatId);
    await s.turn([LIMIT]);
    await s.waiting();
    assert.equal(statusOf(chatId)?.status, "idle", status);
    assert.equal(statusOf(chatId)?.compacting, undefined, status);
    compactStatus = "accepted";
    compactCalls.length = 0;
    await s.turn([LIMIT]);
    await s.waiting();
    assert.equal(compactCalls.length, 1);
    await s.waiting();
  }
});

test("исход просьбы неизвестен (ответа нет, сбой диспетчера eve): чат остаётся занят до парковки, второй просьбы нет", async () => {
  for (const [status, chatId] of [
    ["silent", 56],
    ["broken", 59],
  ] as const) {
    compactStatus = status;
    compactCalls.length = 0;
    const s = session(`s-${status}`, chatId);
    await s.turn([LIMIT]);
    await s.waiting();
    assert.equal(compactCalls.length, 1, status);
    assert.equal(statusOf(chatId)?.status, "running", status);
    assert.equal(statusOf(chatId)?.compacting, true, status);
    await s.waiting(); // eve всё же пересказала (или нет) и запарковала сессию
    assert.equal(statusOf(chatId)?.status, "idle", status);
    assert.equal(compactCalls.length, 1, status);
    // Парковка закрыла просьбу: следующий ход на пороге просит снова, не ждёт полчаса.
    await s.turn([LIMIT]);
    await s.waiting();
    assert.equal(compactCalls.length, 2, status);
    await s.waiting();
  }
});

test("запоздалая просьба: eve приняла её после таймаута и начала пересказ после следующего хода — чат занят заново", async () => {
  compactStatus = "silent";
  const s = session("s-late-accept", 62);
  await s.turn([LIMIT]);
  await s.waiting(); // ответа нет: исход неизвестен, чат занят
  compactStatus = "accepted";
  await s.turn([LIMIT, LIMIT]); // eve сначала провела ход по пришедшему сообщению
  assert.equal(
    statusOf(62)?.status,
    "running",
    "неизвестный исход сохраняет резерв до события свёртки",
  );
  await s.waiting();
  assert.equal(
    compactCalls.length,
    1,
    "вторую просьбу не шлём: первая может быть у eve",
  );
  assert.equal(
    statusOf(62)?.status,
    "running",
    "неизвестный исход сохраняет резерв до события свёртки",
  );
  await s.compacting(); // eve начала отложенный пересказ
  assert.equal(statusOf(62)?.status, "running");
  assert.equal(statusOf(62)?.compacting, true);
  assert.equal(statusOf(62)?.sessionId, "s-late-accept");
  s.compacted();
  await s.waiting();
  assert.equal(statusOf(62)?.status, "idle");
});

test("начало пересказа страховки внутри хода запись хода не трогает", async () => {
  const s = session("s-inturn", 63);
  await s.turn([LIMIT]);
  await s.waiting();
  await s.compacting();
  s.compacted();
  await s.waiting();
  await s.running([LIMIT]);
  const before = statusOf(63);
  await s.compacting();
  assert.deepEqual(statusOf(63), before);
});

test("отказ eve не снимает запись хода, который успел начаться поверх записи пересказа", async () => {
  compactStatus = "refused";
  const s = session("s-overrun", 60);
  await s.turn([LIMIT]);
  whileAsking = async () => {
    whileAsking = null;
    await s.started();
  };
  await s.waiting();
  const turnRecord = statusOf(60);
  assert.equal(turnRecord?.status, "running", "ход идёт");
  assert.equal(typeof turnRecord?.turnId, "string");
  assert.equal(turnRecord?.compacting, undefined);
});

test("нет общего токена: чат не занимаем, просьбы нет", async () => {
  const bearer = process.env.ASSISTANT_BEARER;
  delete process.env.ASSISTANT_BEARER;
  try {
    const s = session("s-nobearer", 57);
    await s.turn([LIMIT]);
    await s.waiting();
    assert.deepEqual(compactCalls, []);
    assert.equal(statusOf(57)?.status, "idle");
    process.env.ASSISTANT_BEARER = bearer;
    await s.waiting();
    assert.deepEqual(compactCalls, [], "решение этого хода уже снято");
  } finally {
    process.env.ASSISTANT_BEARER = bearer;
  }
});

test("упавший ход пересказа не просит", async () => {
  const s = session("s-failed", 61);
  await s.running([LIMIT * 2]);
  await s.failed();
  await s.waiting();
  assert.deepEqual(compactCalls, []);
  assert.equal(statusOf(61)?.status, "idle");
});

test("сообщение успело занять чат до парковки: пересказа нет, запись сообщения цела", async () => {
  const s = session("s-raced", 49);
  await s.turn([LIMIT]);
  // An external cancellation can release the reservation before new input claims it.
  runStatus.setChatStatus("49:", {
    status: "idle",
    sessionId: null,
    compacting: null,
  });
  assert.equal(await incoming(49, "s-raced"), 1);
  const ingress = statusOf(49);
  assert.equal(typeof ingress?.ingressId, "string");
  await s.waiting();
  assert.deepEqual(compactCalls, []);
  assert.equal(statusOf(49)?.ingressId, ingress?.ingressId);
  assert.equal(statusOf(49)?.compacting, undefined);
});

test("сессию сбросили (/new оставил resetAt): пересказа нет", async () => {
  const s = session("s-reset", 50);
  await s.turn([LIMIT]);
  runStatus.setChatStatus("50:", { status: "idle", resetAt: Date.now() });
  await s.waiting();
  assert.deepEqual(compactCalls, []);
  assert.equal(statusOf(50)?.status, "idle");
});

test("/new между чтением записи и её захватом: отметка сброса цела, чат под пересказ не занят", async () => {
  const { takeOverTelegramChat, chatTakeOverPatch } =
    await import("../agent/lib/telegram-turn-start.ts");
  const key = "70:";
  runStatus.setChatStatus(key, { status: "idle" });
  let raced = false;
  const taken = await takeOverTelegramChat({
    chatKey: key,
    patch: chatTakeOverPatch({ sessionId: "s-old", compacting: true }),
    staleMs: runStatus.RUN_STALE_MS,
    getStatusImpl: runStatus.getChatStatus,
    // Мост (другой процесс) пишет /new после чтения записи и до её замены.
    setStatusIfImpl: (chatKey, expected, patch) => {
      if (!raced)
        runStatus.setChatStatus(chatKey, {
          status: "idle",
          sessionId: null,
          resetAt: 1,
        });
      raced = true;
      return runStatus.setChatStatusIf(chatKey, expected, patch);
    },
    refuseImpl: (status) => status?.resetAt !== undefined,
  });
  assert.equal(taken, false);
  assert.equal(statusOf(70)?.status, "idle");
  assert.equal(statusOf(70)?.resetAt, 1);
});

test("отмена пересказа (turn.cancelled, как после /stop): чат свободен, отметки «ход отменён» следующему сообщению нет", async () => {
  const s = session("s-stop", 51);
  await s.turn([LIMIT]);
  await s.waiting();
  await s.cancelled();
  assert.equal(statusOf(51)?.status, "idle");
  assert.equal(statusOf(51)?.wasCancelled, undefined);
  assert.equal(statusOf(51)?.stopPressed, undefined);
  // Без нажатия Стоп отмена настоящего хода тоже не ставит отметку.
  const real = session("s-stop-turn", 52);
  await real.started();
  await real.cancelled();
  assert.equal(statusOf(52)?.wasCancelled, undefined);
  assert.equal(statusOf(52)?.stopPressed, undefined);
});

test("законченный пересказ, который не помог, больше не повторяется", async () => {
  const s = session("s-stuck", 53);
  await s.turn([LIMIT]);
  await s.waiting();
  s.compacted();
  await s.waiting();
  compactCalls.length = 0;
  await s.turn([LIMIT, LIMIT + 1]);
  await s.waiting();
  await s.turn([LIMIT * 2]);
  await s.waiting();
  assert.deepEqual(compactCalls, []);
  assert.equal(statusOf(53)?.status, "idle");
});

for (const language of ["ru", "en"] as const) {
  test(`steer note on the channel wire, ${language}: running, idle, queue, legacy Stop`, async (t) => {
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.now() + (language === "ru" ? 100_000 : 200_000),
    });
    const neutral =
      language === "ru" ? "Это сообщение пришло" : "This message arrived";
    const stop =
      language === "ru"
        ? "Предыдущий ход был прерван"
        : "The previous turn was interrupted";
    for (const [index, state] of [
      "running",
      "idle",
      "queue",
      "legacy",
      "pressed",
      "compacting",
    ].entries()) {
      const chatId = 800 + index;
      writeFileSync(
        settings,
        JSON.stringify({
          language,
          turnPolicy: state === "queue" ? "queue" : "steer",
        }),
      );
      t.mock.timers.tick(3000);
      runStatus.setChatStatus(`${chatId}:`, {
        status: state === "idle" || state === "legacy" ? "idle" : "running",
        sessionId: `s-note-${index}`,
        turnId: "old",
        compacting: state === "compacting" ? true : null,
        wasCancelled: state === "legacy" || state === "pressed" ? true : null,
      });
      incomingContexts.length = 0;
      assert.equal(await incoming(chatId, `s-note-${index}`), 1);
      const wire = JSON.stringify(incomingContexts);
      if (state === "legacy" || state === "pressed") {
        assert.ok(wire.includes(stop), wire);
        assert.ok(!wire.includes(neutral), wire);
        assert.equal(statusOf(chatId)?.stopPressed, undefined);
        assert.equal(statusOf(chatId)?.wasCancelled, undefined);
      } else if (state === "running") {
        assert.ok(wire.includes(neutral), wire);
        assert.ok(!wire.includes(stop), wire);
      } else {
        assert.ok(!wire.includes(neutral), wire);
        assert.ok(!wire.includes(stop), wire);
      }
    }
  });
}

test("explicit native Stop is kept through terminal cancellation and consumed once", async () => {
  const { handleTelegramDraftStop } =
    await import("../agent/lib/telegram-stop.ts");
  const s = session("s-explicit-stop", 9);
  await s.started();
  runStatus.setChatStatus("9:", { draftId: 999 });
  const before = statusOf(9);
  assert.equal(
    await handleTelegramDraftStop(
      {
        chat: { id: 9, type: "private" },
        draft_id: 999,
      },
      { cancelImpl: async () => ({ status: "accepted" }) },
    ),
    "requested",
  );
  assert.equal(statusOf(9)?.wasCancelled, true);
  assert.equal(statusOf(9)?.updatedAt, before?.updatedAt);
  await s.cancelled();
  assert.equal(statusOf(9)?.wasCancelled, true);
  incomingContexts.length = 0;
  await incoming(9, "s-explicit-stop");
  assert.match(JSON.stringify(incomingContexts), /«Stop»|«Стоп»/u);
  assert.equal(statusOf(9)?.wasCancelled, undefined);
  incomingContexts.length = 0;
  await incoming(9, "s-explicit-stop");
  assert.doesNotMatch(JSON.stringify(incomingContexts), /«Stop»|«Стоп»/u);
});

test("a repeated older accepted update neither dispatches nor consumes a fresh Stop", async () => {
  const chatId = 910;
  runStatus.setChatStatus(`${chatId}:`, { status: "idle" });
  assert.equal(await incoming(chatId, "s-repeat-note", 90001, true), 1);
  assert.equal(await incoming(chatId, "s-repeat-note", 90002, true), 1);
  runStatus.setChatStatus(`${chatId}:`, { wasCancelled: true });
  assert.equal(await incoming(chatId, "s-repeat-note", 90001, true), 0);
  assert.equal(statusOf(chatId)?.wasCancelled, true);
  incomingContexts.length = 0;
  assert.equal(await incoming(chatId, "s-repeat-note", 90003, true), 1);
  assert.match(JSON.stringify(incomingContexts), /«Stop»|«Стоп»/u);
  assert.equal(statusOf(chatId)?.wasCancelled, undefined);
});

test("a reminder turn after Stop clears the fact before the next owner message", async () => {
  const chatId = 911;
  const reminder = session("s-reminder-after-stop", chatId);
  runStatus.setChatStatus(`${chatId}:`, { status: "idle", wasCancelled: true });
  await reminder.turn([100]);
  assert.equal(statusOf(chatId)?.wasCancelled, undefined);
  incomingContexts.length = 0;
  await incoming(chatId, "s-owner-after-reminder");
  assert.doesNotMatch(JSON.stringify(incomingContexts), /«Stop»|«Стоп»/u);
});

const { handleControl, registerBotCommands } =
  await import("./poller/control.ts");
function compactUpdate(chatId: number, text = "/compact", type = "private") {
  return {
    update_id: ++seq,
    message: {
      message_id: ++seq,
      chat: { id: chatId, type },
      from: { id: 9, is_bot: false },
      text,
    },
  };
}
const sentText = () =>
  apiCalls
    .filter((call) => call.method === "sendMessage")
    .map((call) => String(call.body?.text))
    .join("\n");

test("/compact на проводе: команда моста, общий POST eve, занятость до парковки, честный размер первого шага", async () => {
  const s = session("s-manual-wire", 701);
  manualSessionId = "s-manual-wire";
  await s.turn([40_000]);
  await s.waiting();
  assert.equal(await handleControl(compactUpdate(701)), true);
  assert.deepEqual(manualRequests, [
    {
      body: { chatKey: "701:", target: { address: { chatId: "701" } } },
      auth: "idle-compaction-test-secret",
    },
  ]);
  assert.deepEqual(compactCalls, [
    { sessionId: "s-manual-wire", auth: "Bearer idle-compaction-test-bearer" },
  ]);
  assert.equal(statusOf(701)?.compacting, true);
  assert.match(sentText(), /Compressing the conversation/);
  await handleControl(compactUpdate(701));
  assert.equal(compactCalls.length, 1);
  assert.match(
    sentText(),
    /The conversation is already being compressed\. Please wait for the reply\.$/,
  );
  s.compacted();
  await s.waiting();
  assert.equal(statusOf(701)?.status, "idle");
  assert.match(sentText(), /it was ≈40k tokens/);
  await s.turn([25_000, 27_000]);
  await s.waiting();
  assert.match(sentText(), /≈40k → ≈25k tokens/);
  assert.equal(compactCalls.length, 1);
});

test("/compact при малом входе, после /stop, /new и перезапуска: без POST и без занятия чата", async () => {
  for (const mode of ["small", "stop", "new", "restart"] as const) {
    const chatId = 710 + seq++;
    const id = `s-manual-${mode}`;
    const s = session(id, chatId);
    manualSessionId = id;
    if (mode === "small") {
      await s.turn([23_000]);
      await s.waiting();
    }
    if (mode === "stop") {
      await s.running([80_000]);
      await s.cancelled();
      await s.waiting();
    }
    // /new and process restart have no in-memory step input for the selected session.
    assert.equal(await handleControl(compactUpdate(chatId)), true);
    assert.notEqual(statusOf(chatId)?.compacting, true);
  }
  assert.deepEqual(compactCalls, []);
  assert.match(sentText(), /nothing to compress/);
});

test("/compact во время ответа оставляет ход, отказ и прерывание свёртки видны владельцу", async () => {
  const s = session("s-manual-fail", 702);
  manualSessionId = "s-manual-fail";
  await s.running([80_000]);
  await handleControl(compactUpdate(702));
  assert.deepEqual(compactCalls, []);
  await s.cancelled();
  await s.waiting();
  await s.turn([40_000]);
  await s.waiting();
  compactStatus = "refused";
  await handleControl(compactUpdate(702));
  assert.equal(statusOf(702)?.status, "idle");
  assert.match(sentText(), /couldn't be confirmed/);
  compactStatus = "accepted";
  await handleControl(compactUpdate(702));
  await s.waiting();
  assert.match(sentText(), /Compression was interrupted/);
  assert.equal(statusOf(702)?.status, "idle");
});

test("/compact в группах адресуется как /new; посторонний отправитель командой не управляет", async () => {
  await handleControl(compactUpdate(-703, "/compact", "group"));
  assert.equal(manualRequests.length, 0);
  assert.match(sentText(), /Reply to my message/);
  const update = compactUpdate(704);
  update.message.from.id = 999;
  assert.equal(await handleControl(update), false);
  assert.equal(manualRequests.length, 0);
});

test("/compact скрыта в /help и синем меню на проводе setMyCommands", async () => {
  await handleControl(compactUpdate(705, "/help"));
  assert.doesNotMatch(sentText(), /\/compact/);
  await registerBotCommands();
  const menus = apiCalls.filter((call) => call.method === "setMyCommands");
  assert.equal(menus.length, 2);
  for (const menu of menus)
    assert.doesNotMatch(JSON.stringify(menu.body), /"command":"compact"/);
});

test("роут /compact проверяет секрет и формат до захвата чата", async () => {
  const handler = route("/eve/v1/telegram/compact").handler;
  const args = {
    attachSession: unused,
    resolveSession: unused,
    from: unused,
    to: unused,
    params: {},
    waitUntil: unused,
    requestIp: "127.0.0.1",
  };
  for (const [body, secret, status] of [
    ["{}", "wrong", 401],
    ["{", "idle-compaction-test-secret", 400],
    ["{}", "idle-compaction-test-secret", 400],
  ] as const) {
    const response = await handler(
      new Request("http://local/eve/v1/telegram/compact", {
        method: "POST",
        body,
        headers: { "x-telegram-bot-api-secret-token": secret },
      }),
      args,
    );
    assert.equal(response.status, status);
  }
  assert.deepEqual(compactCalls, []);
});

test("/compact в ответ на сообщение бота в группе выбирает ту же адресацию, что /new", async () => {
  const s = session("s-manual-group", -706);
  manualSessionId = "s-manual-group";
  await s.turn([40_000]);
  await s.waiting();
  const base = compactUpdate(-706, "/compact", "group");
  const update = {
    ...base,
    message: {
      ...base.message,
      reply_to_message: { message_id: 88, from: { id: 12345, is_bot: true } },
    },
  };
  assert.equal(await handleControl(update), true);
  assert.deepEqual(manualRequests.at(-1)?.body, {
    chatKey: "-706:",
    target: { address: { chatId: "-706", conversationId: "88" } },
  });
  assert.deepEqual(compactCalls, [
    { sessionId: "s-manual-group", auth: "Bearer idle-compaction-test-bearer" },
  ]);
  s.compacted();
  await s.waiting();
});

test("property: произвольный неверный ключ /compact отвергается до разрешения сессии", async () => {
  const handler = route("/eve/v1/telegram/compact").handler;
  const args = {
    attachSession: unused,
    resolveSession: unused,
    from: unused,
    to: unused,
    params: {},
    waitUntil: unused,
    requestIp: "127.0.0.1",
  };
  await fc.assert(
    fc.asyncProperty(
      fc.string({ maxLength: 100 }).filter((key) => !/^-?\d+:\d*$/u.test(key)),
      fc.jsonValue(),
      async (chatKey, target) => {
        const response = await handler(
          new Request("http://local/eve/v1/telegram/compact", {
            method: "POST",
            headers: {
              "x-telegram-bot-api-secret-token": "idle-compaction-test-secret",
            },
            body: JSON.stringify({ chatKey, target }),
          }),
          args,
        );
        assert.equal(response.status, 400);
      },
    ),
    { numRuns: 100 },
  );
  assert.deepEqual(compactCalls, []);
});

test("/compact между turn.completed и session.waiting ждёт парковки того же хода", async () => {
  const s = session("s-manual-window-r1", 720);
  manualSessionId = "s-manual-window-r1";
  await s.turn([40_000]);
  assert.equal(statusOf(720)?.status, "idle");
  await handleControl(compactUpdate(720));
  assert.deepEqual(compactCalls, [], "до парковки ручной POST запрещён");
  assert.match(sentText(), /Try \/compact after I finish/);
  await s.waiting();
  assert.doesNotMatch(sentText(), /Compression was interrupted/);
  await handleControl(compactUpdate(720));
  assert.equal(compactCalls.length, 1);
  await s.compacting();
  assert.equal(statusOf(720)?.compacting, true, "пересказ держит чат");
  s.compacted();
  await s.waiting();
  assert.match(sentText(), /it was ≈40k tokens/);
  assert.equal(statusOf(720)?.status, "idle");
});

test("/compact сразу после автосвёртки сохраняет один POST", async () => {
  const s = session("s-manual-after-auto-r1", 721);
  manualSessionId = "s-manual-after-auto-r1";
  await s.turn([LIMIT]);
  await s.waiting();
  assert.equal(compactCalls.length, 1);
  s.compacted();
  await s.waiting();
  await handleControl(compactUpdate(721));
  assert.equal(
    compactCalls.length,
    1,
    "повторного пересказа устаревшего входа нет",
  );
  assert.match(sentText(), /nothing to compress/);
});

test("/compact во время автосвёртки сообщает о пересказе", async () => {
  const s = session("s-manual-during-auto-r1", 722);
  manualSessionId = "s-manual-during-auto-r1";
  await s.turn([LIMIT]);
  await s.waiting();
  await handleControl(compactUpdate(722));
  assert.equal(compactCalls.length, 1);
  assert.equal(
    sentText(),
    "The conversation is already being compressed. Please wait for the reply.",
  );
  assert.doesNotMatch(sentText(), /I'm answering now/);
  s.compacted();
  await s.waiting();
});

test("ручная свёртка предупреждает о повторе после перезапуска; восстановление освобождает чат", async () => {
  const s = session("s-manual-restart-r1", 723);
  manualSessionId = "s-manual-restart-r1";
  await s.turn([40_000]);
  await s.waiting();
  await handleControl(compactUpdate(723));
  assert.match(sentText(), /After a restart, repeat \/compact/);
  const { rewriteRunStatusesForUpdate } = await import("./lib/wf-store.ts");
  assert.ok(rewriteRunStatusesForUpdate(dataDir, true) >= 1);
  assert.equal(statusOf(723)?.status, "idle");
  assert.equal(statusOf(723)?.compacting, undefined);
  assert.equal(typeof statusOf(723)?.resetAt, "number");
  apiCalls.length = 0;
  await handleControl(compactUpdate(723));
  assert.equal(compactCalls.length, 1);
  assert.match(sentText(), /nothing to compress/);
});
