/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Интеграционные тесты T911 (шаг 4/6: общая группа и поручения между ботами):
//   п.2 — в группе без @ каждый бот сам решает ответить или промолчать (`<!-- iva:none -->`
//         без отправки сообщения; лимита и счётчика кругов ботов нет);
//   п.3 — поручение одного бота другому идёт личным сообщением бота (Bot API DM),
//         видимая строка о поручении уходит владельцу в чат коллеги (на заглушке Bot API),
//         повтор после обрыва не дублирует ход и строку владельцу;
//   п.4 — боты, добавленные владельцем в группу, принимают её сообщения (и не пересекаются
//         по времени благодаря сериализации очереди группы).
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";
import type { RouteHandlerArgs, Session } from "eve/channels";
import type { TelegramChannelState } from "eve/channels/telegram";
import {
  TELEGRAM_BOT_ID_HEADER,
  TELEGRAM_PEER_BOT_FROM_FIELD,
  type TelegramBotConfig,
} from "../packages/telegram-bots/index.ts";

const root = mkdtempSync(join(tmpdir(), "iva-t911-group-assign-"));
const dataPath = join(root, "data");
const vaultPath = join(root, "vault");
mkdirSync(dataPath, { recursive: true });
mkdirSync(vaultPath, { recursive: true });

const IVA_BOT_ID = "111111111";
const IVA_TOKEN = `${IVA_BOT_ID}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
const CRITIC_BOT_ID = "222222222";
const CRITIC_TOKEN = `${CRITIC_BOT_ID}:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`;
const CODER_BOT_ID = "333333333";
const CODER_TOKEN = `${CODER_BOT_ID}:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC`;
const OWNER_ID = 42;
const WEBHOOK_SECRET = "t911-webhook-secret";

// Локальная заглушка Telegram Bot API: фиксирует каждый вызов с токеном бота, методом и телом.
interface StubBotApiCall {
  readonly token: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}
interface StubBotApiControlResult {
  readonly status?: number;
  readonly payload?: Record<string, unknown>;
}
type StubBotApiControl = (
  call: StubBotApiCall,
) => StubBotApiControlResult | null | Promise<StubBotApiControlResult | null>;
const botApiCalls: StubBotApiCall[] = [];
let botApiControl: StubBotApiControl | null = null;
let stubMessageId = 500;

const botApiServer = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => {
    raw += chunk.toString("utf8");
  });
  req.on("end", () => {
    void (async () => {
      const match = /^\/bot([^/]+)\/([A-Za-z0-9_]+)$/u.exec(req.url ?? "");
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      if (!match) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, description: "not found" }));
        return;
      }
      const call = { token: match[1], method: match[2], body };
      botApiCalls.push(call);
      let controlled: StubBotApiControlResult | null = null;
      try {
        controlled = (await botApiControl?.(call)) ?? null;
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            description: error instanceof Error ? error.message : String(error),
          }),
        );
        return;
      }
      stubMessageId += 1;
      res.writeHead(controlled?.status ?? 200, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify(
          controlled?.payload ?? {
            ok: true,
            result: {
              message_id: stubMessageId,
              chat: {
                id: body.chat_id ?? OWNER_ID,
                type: Number(body.chat_id) < 0 ? "supergroup" : "private",
              },
              text: body.text ?? "",
            },
          },
        ),
      );
    })();
  });
});
await new Promise<void>((resolve) =>
  botApiServer.listen(0, "127.0.0.1", resolve),
);
botApiServer.unref();
after(() => {
  botApiServer.close();
});
afterEach(() => {
  botApiControl = null;
});
const botApiPort = (botApiServer.address() as AddressInfo).port;
const botApiBaseUrl = `http://127.0.0.1:${botApiPort}`;

process.env.ASSISTANT_DATA_DIR = dataPath;
process.env.ASSISTANT_VAULT_DIR = vaultPath;
process.env.ASSISTANT_TIMEZONE = "UTC";
process.env.AGENT_LANGUAGE = "ru";
process.env.TELEGRAM_ALLOWED_USER_IDS = String(OWNER_ID);
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = WEBHOOK_SECRET;
process.env.TELEGRAM_BOT_TOKEN = IVA_TOKEN;
process.env.TELEGRAM_BOT_USERNAME = "iva_main_bot";
process.env.TELEGRAM_COLLEAGUE_BOT_TOKENS = [
  `critic_bot=${CRITIC_TOKEN}`,
  `coder_bot=${CODER_TOKEN}`,
].join(",");
process.env.TELEGRAM_API_BASE_URL = botApiBaseUrl;
process.env.TELEGRAM_RICH_REPLIES = "never";
process.env.TELEGRAM_WIDGETS = "never";

process.on("exit", () => {
  botApiServer.close();
  rmSync(root, { recursive: true, force: true });
});

const [
  { withColleague, withColleaguesEnabled },
  { colleagueExecuteAsync },
  { listColleagueAssignments },
  { createTelegramChannel },
  { addTelegramQueueReceipt, TELEGRAM_ACCEPTANCE_ROUTE },
  teamInstructionModule,
  { admitTelegramUpdate, inboxKeyFor, promoteReadyInbox },
  { drainReadyQueueHeads, routeMessageUpdate },
  { emptyQueueDocument, enqueueItem, createQueueItem, removeQueueItems },
  { joinUpdates },
  { chatKeyOf, getChatStatus, setChatStatus },
  { ContextContainer, contextStorage },
  { SessionKey },
] = await Promise.all([
  import("#lib/colleagues.ts"),
  import("#lib/colleague-tool.ts"),
  import("#lib/colleague-assignments.ts"),
  import("../agent/channels/telegram.ts"),
  import("#lib/telegram-acceptance.ts"),
  import("../agent/instructions/02-colleague-team.ts"),
  import("./poller/inbox.ts"),
  import("./poller/routing.ts"),
  import("./lib/telegram-queue.ts"),
  import("./lib/telegram-collect.ts"),
  import("#lib/run-status.ts"),
  import("../node_modules/eve/dist/src/context/container.js"),
  import("../node_modules/eve/dist/src/context/keys.js"),
]);

const settingsFile = join(dataPath, "settings.json");

function writeTeamSettings(enabled: boolean): void {
  const cfg = withColleague(
    withColleague(withColleaguesEnabled({}, enabled), {
      botId: CRITIC_BOT_ID,
      role: "critic",
      provider: "ollama",
      model: "deepseek-v4-pro",
      name: "Критик",
      username: "critic_bot",
    }),
    {
      botId: CODER_BOT_ID,
      role: "programmer",
      provider: "codex",
      model: "gpt-5.5",
      name: "Программист",
      username: "coder_bot",
    },
  );
  writeFileSync(settingsFile, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

function makeHarness() {
  const channel = createTelegramChannel({
    api: { apiBaseUrl: botApiBaseUrl },
  });
  const acceptanceRoute = channel.routes.find(
    (route) =>
      route.transport !== "websocket" &&
      route.method === "POST" &&
      route.path === TELEGRAM_ACCEPTANCE_ROUTE,
  );
  assert.ok(acceptanceRoute && acceptanceRoute.transport !== "websocket");

  const sentTurns: Array<{
    readonly address: string;
    readonly message: unknown;
    readonly state: TelegramChannelState | undefined;
    readonly auth: unknown;
    readonly context: readonly string[] | undefined;
  }> = [];
  const sessions = new Map<
    string,
    { id: string; state: TelegramChannelState }
  >();
  let seq = 0;

  const args = {
    attachSession: (id: string) => ({ id }) as Session,
    from: (address: string) => ({
      cancel: () => Promise.resolve({ status: "not-found" as const }),
      clear: () => Promise.resolve({ status: "not-found" as const }),
      compact: () => Promise.resolve({ status: "not-found" as const }),
      reset: () => Promise.resolve({ status: "not-found" as const }),
      respond: () => Promise.resolve({ id: "resp" } as Session),
      send: (
        message: unknown,
        options?: {
          state?: TelegramChannelState;
          auth?: unknown;
          context?: readonly string[];
        },
      ) => {
        seq += 1;
        const id = `sess_${seq}`;
        const state = options?.state as TelegramChannelState;
        sessions.set(address, { id, state });
        sentTurns.push({
          address,
          message,
          state,
          auth: options?.auth,
          context: options?.context,
        });
        return Promise.resolve({ id } as Session);
      },
    }),
    resolveSession: (address: string) => {
      const found = sessions.get(address);
      if (!found) return Promise.resolve(undefined);
      return Promise.resolve({
        id: found.id,
        respond: () =>
          Promise.resolve({
            status: "accepted" as const,
            sessionId: found.id,
          }),
      });
    },
    waitUntil: () => undefined,
  } as unknown as RouteHandlerArgs<TelegramChannelState>;

  const compiledAdapter = (
    channel as unknown as {
      adapter: {
        createAdapterContext: (base: {
          state: TelegramChannelState;
          session: {
            id: string;
            continuation: { token: string; rekey: (t: string) => void };
          };
          ctx: Record<string, unknown>;
        }) => {
          state: TelegramChannelState;
          telegram: unknown;
          session: unknown;
        };
        "turn.started": (
          data: { turnId: string },
          adapterCtx: unknown,
        ) => Promise<void>;
        "message.completed": (
          data: {
            turnId: string;
            stepIndex?: number;
            finishReason: string;
            message: string;
          },
          adapterCtx: unknown,
        ) => Promise<void>;
        "turn.completed": (
          data: { turnId: string },
          adapterCtx: unknown,
        ) => Promise<void>;
      };
    }
  ).adapter;

  async function postUpdate(
    update: Record<string, unknown>,
    botId?: string,
  ): Promise<Response> {
    const res = await acceptanceRoute!.handler(
      new Request(`http://localhost${TELEGRAM_ACCEPTANCE_ROUTE}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
          ...(botId ? { [TELEGRAM_BOT_ID_HEADER]: botId } : {}),
        },
        body: JSON.stringify(update),
      }),
      args,
    );
    return res as Response;
  }

  async function completeTurn(
    state: TelegramChannelState,
    sessionId: string,
    turnId: string,
    replyText: string,
    options?: {
      readonly toolCallProgress?: {
        readonly ageMs: number;
        readonly text: string;
        readonly chatKey: string;
      };
    },
  ): Promise<void> {
    const container = new ContextContainer();
    container.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId,
      turn: { id: turnId, sequence: 0 },
    });
    const session = {
      id: sessionId,
      auth: { current: null, initiator: null },
      continuation: { token: "tok", rekey: () => undefined },
    };
    await contextStorage.run(container, async () => {
      const adapterCtx = compiledAdapter.createAdapterContext({
        state,
        session,
        ctx: container as unknown as Record<string, unknown>,
      });
      await compiledAdapter["turn.started"]({ turnId }, adapterCtx);
      if (options?.toolCallProgress) {
        setChatStatus(options.toolCallProgress.chatKey, {
          turnAt: Date.now() - options.toolCallProgress.ageMs,
        });
        await compiledAdapter["message.completed"](
          {
            turnId,
            stepIndex: 0,
            finishReason: "tool-calls",
            message: options.toolCallProgress.text,
          },
          adapterCtx,
        );
      }
      await compiledAdapter["message.completed"](
        {
          turnId,
          stepIndex: options?.toolCallProgress ? 1 : 0,
          finishReason: "stop",
          message: replyText,
        },
        adapterCtx,
      );
      await compiledAdapter["turn.completed"]({ turnId }, adapterCtx);
    });
  }

  return { sentTurns, postUpdate, completeTurn };
}

const ivaBot: TelegramBotConfig = {
  botId: IVA_BOT_ID,
  token: IVA_TOKEN,
  username: "iva_main_bot",
  isPrimary: true,
};
const criticBot: TelegramBotConfig = {
  botId: CRITIC_BOT_ID,
  token: CRITIC_TOKEN,
  username: "critic_bot",
  isPrimary: false,
};
const coderBot: TelegramBotConfig = {
  botId: CODER_BOT_ID,
  token: CODER_TOKEN,
  username: "coder_bot",
  isPrimary: false,
};

// --- Пункт 2: в группе без @ каждый бот сам решает, ответить или промолчать; без лимита кругов ---
test("п.2: group without @ lets each bot decide reply vs silence (iva:none sends nothing), with no round limit", async () => {
  writeTeamSettings(true);
  botApiCalls.length = 0;
  const harness = makeHarness();

  const groupMsgFromOwner = {
    message_id: 10,
    date: 1700000000,
    chat: { id: -100777, type: "supergroup", title: "Team Iva" },
    from: { id: OWNER_ID, is_bot: false, username: "owner" },
    text: "Ребята, оцените идею без упоминаний",
  };

  // Both Iva and Critic accept the group message without @mention.
  const ivaResp = await harness.postUpdate({
    update_id: 1001,
    message: groupMsgFromOwner,
  });
  assert.equal(ivaResp.status, 204);
  assert.equal(ivaResp.headers.get("x-iva-telegram-acceptance"), "turn");

  const criticResp = await harness.postUpdate(
    { update_id: 2001, message: groupMsgFromOwner },
    CRITIC_BOT_ID,
  );
  assert.equal(criticResp.status, 204);
  assert.equal(criticResp.headers.get("x-iva-telegram-acceptance"), "turn");
  assert.equal(harness.sentTurns.length, 2);

  // Unaddressed group turns must NOT flash noisy typing indicators before deciding.
  assert.equal(
    botApiCalls.filter((c) => c.method === "sendChatAction").length,
    0,
    "unaddressed group turn should not send typing before deciding",
  );

  // Outcome A: Critic chooses to reply in the group -> sent with Critic's token.
  const criticTurn = harness.sentTurns[1];
  await harness.completeTurn(
    criticTurn.state!,
    "sess_critic_g1",
    "turn_critic_g1",
    "Есть узкое место в миграции данных.",
  );
  const criticSends = botApiCalls.filter(
    (c) => c.token === CRITIC_TOKEN && c.method === "sendMessage",
  );
  assert.equal(criticSends.length, 1);
  assert.equal(criticSends[0]?.body.chat_id, "-100777");
  assert.match(String(criticSends[0]?.body.text), /миграции данных/u);

  // Outcome B: Iva chooses silence (`<!-- iva:none -->`) -> ZERO messages sent to Telegram, status idle.
  const ivaTurn = harness.sentTurns[0];
  await harness.completeTurn(
    ivaTurn.state!,
    "sess_iva_g1",
    "turn_iva_g1",
    "<!-- iva:none -->\nКритик уже дал точный разбор.",
  );
  const ivaSends = botApiCalls.filter(
    (c) => c.token === IVA_TOKEN && c.method === "sendMessage",
  );
  assert.equal(
    ivaSends.length,
    0,
    "silent group outcome (iva:none) must send no message",
  );
  assert.equal(getChatStatus(chatKeyOf("-100777"))?.status, "idle");

  // No round limit / counter: 5 consecutive bot-to-bot peer messages in the group are all accepted.
  const beforePeerCount = harness.sentTurns.length;
  for (let round = 1; round <= 5; round += 1) {
    const senderIsIva = round % 2 === 1;
    const fromId = senderIsIva ? Number(IVA_BOT_ID) : Number(CRITIC_BOT_ID);
    const receiverId = senderIsIva ? CRITIC_BOT_ID : undefined;
    const res = await harness.postUpdate(
      {
        update_id: 3000 + round,
        message: {
          message_id: 20 + round,
          date: 1700000000 + round,
          chat: { id: -100777, type: "supergroup", title: "Team Iva" },
          from: {
            id: fromId,
            is_bot: true,
            username: senderIsIva ? "iva_main_bot" : "critic_bot",
          },
          text: `Раунд обсуждения #${round}`,
        },
      },
      receiverId,
    );
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("x-iva-telegram-acceptance"),
      "turn",
      `round ${round} must be accepted without any round limit`,
    );
  }
  assert.equal(harness.sentTurns.length, beforePeerCount + 5);

  // Self-echo and foreign bot are always rejected.
  const selfRes = await harness.postUpdate({
    update_id: 3100,
    message: {
      message_id: 50,
      date: 1700000050,
      chat: { id: -100777, type: "supergroup" },
      from: { id: Number(IVA_BOT_ID), is_bot: true, username: "iva_main_bot" },
      text: "Своё собственное сообщение",
    },
  });
  assert.equal(selfRes.status, 503);

  const foreignRes = await harness.postUpdate({
    update_id: 3101,
    message: {
      message_id: 51,
      date: 1700000051,
      chat: { id: -100777, type: "supergroup" },
      from: { id: 999999999, is_bot: true, username: "stranger_bot" },
      text: "Чужой бот",
    },
  });
  assert.equal(foreignRes.status, 503);

  // Team instruction injects group silence & no-limit rules when enabled, null when disabled.
  const teamHandler = (
    teamInstructionModule.default as unknown as {
      events: {
        "turn.started": (
          e: unknown,
          ctx: unknown,
        ) => { markdown?: string } | null;
      };
    }
  ).events["turn.started"];
  const enabledMd = teamHandler({}, { session: { auth: {} } })?.markdown ?? "";
  assert.ok(enabledMd.includes("<!-- iva:none -->"));
  assert.ok(enabledMd.includes("no round limit"));

  // Private owner chat never suppresses `<!-- iva:none -->`.
  await harness.completeTurn(
    {
      botUsername: "iva_main_bot",
      chatId: String(OWNER_ID),
      chatType: "private",
      conversationId: null,
      hitlCallbacks: {},
      messageThreadId: null,
      nextHitlCallbackId: 0,
      pendingAuthMessageIds: {},
      pendingFreeformReplies: {},
      triggeringUserId: String(OWNER_ID),
    },
    "sess_private_none",
    "turn_private_none",
    "<!-- iva:none -->\nВ личке это должно дойти.",
  );
  assert.equal(
    botApiCalls.filter(
      (c) =>
        c.token === IVA_TOKEN &&
        c.method === "sendMessage" &&
        c.body.chat_id === String(OWNER_ID),
    ).length,
    1,
    "private owner chat must not suppress iva:none",
  );
});

// --- Пункт 3: поручение одного бота другому идёт личным сообщением бота, строка видна владельцу в чате коллеги ---
test("п.3: bot-to-bot assignment goes via Bot API DM and posts one visible owner line in colleague chat, deduplicated on replay", async () => {
  writeTeamSettings(true);
  botApiCalls.length = 0;
  const harness = makeHarness();

  const ivaOwnerCtx = {
    session: {
      auth: {
        initiator: {
          authenticator: "telegram-webhook",
          principalType: "user",
          attributes: { chat_type: "private", user_id: String(OWNER_ID) },
        },
        current: {
          authenticator: "telegram-webhook",
          principalType: "user",
          attributes: { chat_type: "private", user_id: String(OWNER_ID) },
        },
      },
    },
  };

  // Iva delegates a task to Critic via the colleague tool against the stub Bot API.
  const delegated = await colleagueExecuteAsync(
    {
      action: "delegate",
      bot_id: CRITIC_BOT_ID,
      task: "Проверь план релиза на риски отката",
    },
    ivaOwnerCtx,
    { apiBaseUrl: botApiBaseUrl },
  );
  assert.equal(delegated.ok, true);
  assert.ok(delegated.assignment);
  const assignment = delegated.assignment;

  // Verify the two Bot API calls:
  // (1) private DM from Iva to Critic's bot_id
  // (2) visible assignment line from Critic to owner's chat
  assert.equal(botApiCalls.length, 2);
  const dmCall = botApiCalls[0];
  const ownerNoticeCall = botApiCalls[1];

  assert.equal(dmCall.token, IVA_TOKEN);
  assert.equal(dmCall.method, "sendMessage");
  assert.equal(dmCall.body.chat_id, Number(CRITIC_BOT_ID));
  const dmText = String(dmCall.body.text);
  assert.ok(dmText.includes(assignment.id));
  assert.ok(dmText.includes("Проверь план релиза на риски отката"));

  assert.equal(ownerNoticeCall.token, CRITIC_TOKEN);
  assert.equal(ownerNoticeCall.method, "sendMessage");
  assert.equal(ownerNoticeCall.body.chat_id, String(OWNER_ID));
  assert.match(
    String(ownerNoticeCall.body.text),
    /Поручение \(Ива \(@iva_main_bot\) → Критик.*Проверь план релиза на риски отката/u,
  );

  // Deliver the Bot API DM update to Critic via Bridge admission + Channel acceptance.
  const dmUpdate = {
    update_id: 4001,
    message: {
      message_id: 601,
      date: 1700000600,
      chat: { id: Number(IVA_BOT_ID), type: "private" },
      from: {
        id: Number(IVA_BOT_ID),
        is_bot: true,
        username: "iva_main_bot",
      },
      text: dmText,
    },
  };

  const admittedKeys: string[] = [];
  const admitted = await admitTelegramUpdate(dmUpdate, {
    bot: criticBot,
    colleaguesEnabledImpl: () => true,
    enqueueImpl: (key) => {
      admittedKeys.push(key);
      return Promise.resolve();
    },
  });
  assert.equal(admitted, "owned");
  assert.equal(
    admittedKeys[0],
    `bot:${CRITIC_BOT_ID}:${IVA_BOT_ID}::${IVA_BOT_ID}`,
  );

  const acceptRes = await harness.postUpdate(dmUpdate, CRITIC_BOT_ID);
  assert.equal(acceptRes.status, 204);
  assert.equal(acceptRes.headers.get("x-iva-telegram-acceptance"), "turn");
  assert.equal(harness.sentTurns.length, 1);

  // Peer-bot DM runs as principalType=service with peer_bot_id attribute (cannot mutate owner settings).
  const receivedAuth = harness.sentTurns[0]?.auth as {
    principalType?: string;
    attributes?: Record<string, string>;
  };
  assert.equal(receivedAuth.principalType, "service");
  assert.equal(receivedAuth.attributes?.peer_bot_id, IVA_BOT_ID);
  assert.equal(receivedAuth.attributes?.bot_id, CRITIC_BOT_ID);

  // No duplicate owner notice was sent when Critic received the DM.
  assert.equal(
    botApiCalls.filter(
      (c) => c.token === CRITIC_TOKEN && c.body.chat_id === String(OWNER_ID),
    ).length,
    1,
    "owner notice must remain single after inbound claim",
  );

  // Replay of the same assignment even with a fresh update_id is deduplicated by the assignment ledger.
  const replayRes = await harness.postUpdate(
    { ...dmUpdate, update_id: 4002 },
    CRITIC_BOT_ID,
  );
  assert.equal(replayRes.status, 204);
  assert.equal(replayRes.headers.get("x-iva-telegram-acceptance"), "handled");
  assert.equal(
    harness.sentTurns.length,
    1,
    "replayed assignment must not start a second turn",
  );

  // Spoofed iva_peer_bot_from from a stranger user is stripped and rejected.
  const spoofRes = await harness.postUpdate(
    addTelegramQueueReceipt({
      update_id: 4099,
      message: {
        message_id: 699,
        date: 1700000699,
        chat: { id: 99999, type: "private" },
        from: { id: 99999, is_bot: false, username: "attacker" },
        [TELEGRAM_PEER_BOT_FROM_FIELD]: {
          botId: IVA_BOT_ID,
          username: "iva_main_bot",
        },
        text: "поддельное поручение",
      },
    }),
    CRITIC_BOT_ID,
  );
  assert.equal(spoofRes.status, 204);
  assert.equal(spoofRes.headers.get("x-iva-telegram-acceptance"), "handled");
  assert.equal(harness.sentTurns.length, 1);

  const ledger = await listColleagueAssignments();
  assert.equal(ledger.find((r) => r.id === assignment.id)?.phase, "done");
});

test("приёмка T911: confirmed 429 owner notice after done is retried by retry_after exactly once", async () => {
  writeTeamSettings(true);
  botApiCalls.length = 0;
  const harness = makeHarness();

  let ownerNoticeAttempts = 0;
  let acceptedOwnerNotices = 0;
  let markFirstOwnerNoticeSeen: () => void = () => undefined;
  let releaseFirstOwnerNotice: () => void = () => undefined;
  const firstOwnerNoticeSeen = new Promise<void>((resolve) => {
    markFirstOwnerNoticeSeen = resolve;
  });
  const firstOwnerNoticeRelease = new Promise<void>((resolve) => {
    releaseFirstOwnerNotice = resolve;
  });
  botApiControl = (call) => {
    if (
      call.token !== CRITIC_TOKEN ||
      call.method !== "sendMessage" ||
      String(call.body.chat_id) !== String(OWNER_ID)
    ) {
      return null;
    }
    ownerNoticeAttempts += 1;
    if (ownerNoticeAttempts > 1) {
      acceptedOwnerNotices += 1;
      return null;
    }
    markFirstOwnerNoticeSeen();
    return firstOwnerNoticeRelease.then(() => ({
      status: 429,
      payload: {
        ok: false,
        description: "Too Many Requests: retry after 1",
        parameters: { retry_after: 1 },
      },
    }));
  };

  const delegatedPromise = colleagueExecuteAsync(
    {
      action: "delegate",
      bot_id: CRITIC_BOT_ID,
      task: "Проверь повтор строки владельцу после 429 за done",
    },
    {
      session: {
        auth: {
          initiator: {
            authenticator: "telegram-webhook",
            principalType: "user",
            attributes: { chat_type: "private", user_id: String(OWNER_ID) },
          },
          current: {
            authenticator: "telegram-webhook",
            principalType: "user",
            attributes: { chat_type: "private", user_id: String(OWNER_ID) },
          },
        },
      },
    },
    { apiBaseUrl: botApiBaseUrl },
  );

  try {
    await firstOwnerNoticeSeen;
    const dmCall = botApiCalls.find(
      (call) =>
        call.token === IVA_TOKEN &&
        call.method === "sendMessage" &&
        call.body.chat_id === Number(CRITIC_BOT_ID),
    );
    assert.ok(dmCall, "stub Bot API must accept the bot-to-bot DM first");
    const dmText = String(dmCall.body.text);
    const assignmentId = /\[(asg_[a-f0-9]{12})\]/u.exec(dmText)?.[1];
    assert.ok(assignmentId, `assignment id must be present in DM: ${dmText}`);

    const dmUpdate = {
      update_id: 9101,
      iva_bot_id: CRITIC_BOT_ID,
      message: {
        message_id: 9101,
        date: 1700009101,
        chat: { id: Number(IVA_BOT_ID), type: "private" },
        from: {
          id: Number(IVA_BOT_ID),
          is_bot: true,
          username: "iva_main_bot",
        },
        text: dmText,
        iva_bot_id: CRITIC_BOT_ID,
      },
    };
    const key = inboxKeyFor(dmUpdate);
    assert.ok(key);
    let inboxDoc = emptyQueueDocument();
    inboxDoc = enqueueItem(
      inboxDoc,
      key,
      createQueueItem(dmUpdate, 1_000),
    ).document;
    const ackedBatches: number[][] = [];
    const remaining = await promoteReadyInbox({
      now: () => 5_000,
      loadImpl: () => Promise.resolve(inboxDoc),
      acknowledgeImpl: (ackKey, ids) => {
        ackedBatches.push([...ids]);
        inboxDoc = removeQueueItems(inboxDoc, ackKey, ids).document;
        return Promise.resolve();
      },
      routeImpl: (candidate) =>
        routeMessageUpdate(candidate, {
          loadQueueImpl: () => emptyQueueDocument(),
          runningImpl: () => false,
          colleaguesEnabledImpl: () => true,
          deliverImpl: async (deliveredUpdate) => {
            const res = await harness.postUpdate(
              deliveredUpdate,
              CRITIC_BOT_ID,
            );
            const kind = res.headers.get("x-iva-telegram-acceptance");
            if (res.status !== 204) return false;
            return kind === "handled" ? "handled" : true;
          },
        }),
    });

    assert.equal(remaining, 0);
    assert.deepEqual(ackedBatches, [[9101]]);
    assert.equal(harness.sentTurns.length, 1);
    assert.equal(
      (await listColleagueAssignments()).find((row) => row.id === assignmentId)
        ?.phase,
      "done",
    );
    assert.equal(ownerNoticeAttempts, 1);

    releaseFirstOwnerNotice();
    const delegated = await delegatedPromise;
    assert.equal(delegated.ok, true);

    const deadline = Date.now() + 2_200;
    while (acceptedOwnerNotices === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(
      acceptedOwnerNotices,
      1,
      "confirmed 429 after done must be retried once by retry_after",
    );
    assert.equal(ownerNoticeAttempts, 2);
    const row = (await listColleagueAssignments()).find(
      (entry) => entry.id === assignmentId,
    );
    assert.equal(row?.ownerNotified, true);
  } finally {
    releaseFirstOwnerNotice();
  }
});

// --- Пункт 4: боты, добавленные владельцем в группу, принимают её сообщения и соблюдают очерёдность ---
test("п.4: bots added by owner to a group accept its messages and serialize turns per group without blocking private chats", async () => {
  writeTeamSettings(true);
  botApiCalls.length = 0;

  const groupUpdateFor = (
    updateId: number,
    text: string,
    fromId = OWNER_ID,
  ) => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1700001000 + updateId,
      chat: { id: -100888, type: "supergroup", title: "Owner Team" },
      from: { id: fromId, is_bot: false },
      text,
    },
  });

  // All 3 bots (Iva, Critic, Programmer) added by the owner to group -100888 admit its messages without @.
  const ownedKeys: string[] = [];
  for (const [idx, bot] of [ivaBot, criticBot, coderBot].entries()) {
    const res = await admitTelegramUpdate(
      groupUpdateFor(5001 + idx, "План на неделю без упоминаний"),
      {
        bot,
        colleaguesEnabledImpl: () => true,
        enqueueImpl: (key) => {
          ownedKeys.push(key);
          return Promise.resolve();
        },
      },
    );
    assert.equal(res, "owned");
  }
  assert.deepEqual(ownedKeys, [
    `-100888::${OWNER_ID}`,
    `bot:${CRITIC_BOT_ID}:-100888::${OWNER_ID}`,
    `bot:${CODER_BOT_ID}:-100888::${OWNER_ID}`,
  ]);

  // Stranger in the same group is strictly dropped even with colleagues enabled.
  const strangerRes = await admitTelegramUpdate(
    groupUpdateFor(5099, "Чужой участник", 777777),
    {
      bot: criticBot,
      colleaguesEnabledImpl: () => true,
      enqueueImpl: () => Promise.resolve(),
    },
  );
  assert.equal(strangerRes, "terminal-drop");

  // With colleagues disabled, unaddressed group message for Iva is dropped (backward compatibility).
  writeTeamSettings(false);
  const offRes = await admitTelegramUpdate(
    groupUpdateFor(5100, "Без упоминания при выключенных коллегах"),
    {
      bot: ivaBot,
      colleaguesEnabledImpl: () => false,
      enqueueImpl: () => Promise.resolve(),
    },
  );
  assert.equal(offRes, "terminal-drop");

  // Per-group turn serialization: Iva is running in -100888; Critic's group update queues silently
  // without starting concurrently, while Critic's private chat delivers immediately!
  writeTeamSettings(true);
  const ivaGroupKey = chatKeyOf("-100888");
  const criticGroupKey = chatKeyOf("-100888", undefined, CRITIC_BOT_ID);
  setChatStatus(ivaGroupKey, {
    status: "running",
    sessionId: "sess_iva_busy",
    turnId: "turn_iva_busy",
    updatedAt: Date.now(),
  });

  let queueDoc = emptyQueueDocument();
  const ackedInGroup: number[] = [];
  const deliveredKeys: string[] = [];

  const criticGroupUpdate = {
    ...groupUpdateFor(5201, "Общий вопрос команде"),
    iva_bot_id: CRITIC_BOT_ID,
    message: {
      ...groupUpdateFor(5201, "Общий вопрос команде").message,
      iva_bot_id: CRITIC_BOT_ID,
    },
  };

  const routedCriticGroup = await routeMessageUpdate(criticGroupUpdate, {
    loadQueueImpl: () => queueDoc,
    enqueueImpl: (key, candidate) => {
      const next = enqueueItem(queueDoc, key, createQueueItem(candidate));
      queueDoc = next.document;
      return { count: next.count, added: next.added };
    },
    acknowledgeImpl: (u) => {
      ackedInGroup.push(u.update_id);
    },
    deliverImpl: (u) => {
      deliveredKeys.push(String(u.update_id));
      return true;
    },
    colleaguesEnabledImpl: () => true,
  });
  assert.equal(routedCriticGroup, "queued");
  assert.equal(
    ackedInGroup.length,
    0,
    "group wait behind another bot must not spam queued acks",
  );
  assert.equal(deliveredKeys.length, 0);

  // Critic's private chat with owner is NOT blocked by Iva's active turn in the group.
  const criticPrivateUpdate = {
    update_id: 5202,
    iva_bot_id: CRITIC_BOT_ID,
    message: {
      message_id: 5202,
      date: 1700001202,
      chat: { id: OWNER_ID, type: "private" },
      from: { id: OWNER_ID, is_bot: false },
      text: "Личный вопрос Критику",
      iva_bot_id: CRITIC_BOT_ID,
    },
  };
  const routedPrivate = await routeMessageUpdate(criticPrivateUpdate, {
    loadQueueImpl: () => queueDoc,
    deliverImpl: (u) => {
      deliveredKeys.push(`private:${u.update_id}`);
      return true;
    },
    colleaguesEnabledImpl: () => true,
  });
  assert.equal(routedPrivate, "delivered");
  assert.deepEqual(deliveredKeys, ["private:5202"]);

  // While Iva is still running in -100888, drainReadyQueueHeads keeps Critic's group head waiting.
  const inFlight = new Map();
  const settleUntil = new Map<string, number>();
  const pins = new Map<string, readonly number[]>();
  const rotationState = { afterKey: null as string | null };
  await drainReadyQueueHeads({
    loadImpl: () => queueDoc,
    deliverImpl: (u) => {
      deliveredKeys.push(`group:${u.update_id}`);
      return true;
    },
    acknowledgeImpl: (key) => {
      delete queueDoc.queues[key];
    },
    inFlight,
    settleUntil,
    pins,
    rotationState,
  });
  assert.deepEqual(
    deliveredKeys,
    ["private:5202"],
    "Critic must not run while Iva holds the group slot",
  );

  // Once Iva finishes in -100888, drainReadyQueueHeads immediately delivers Critic's queued group message!
  setChatStatus(ivaGroupKey, {
    status: "idle",
    sessionId: null,
    turnId: null,
    updatedAt: Date.now(),
  });
  await drainReadyQueueHeads({
    loadImpl: () => queueDoc,
    deliverImpl: (u) => {
      deliveredKeys.push(`group:${u.update_id}`);
      return true;
    },
    acknowledgeImpl: (key) => {
      delete queueDoc.queues[key];
    },
    inFlight,
    settleUntil,
    pins,
    rotationState,
  });
  assert.deepEqual(deliveredKeys, ["private:5202", "group:5201"]);
  assert.equal(queueDoc.queues[criticGroupKey], undefined);
});

// --- Возврат п.2: длинный ход с инструментом в группе, завершившийся <!-- iva:none --> ---
test("п.2 (длинный ход с инструментом): group turn >60s with tool-calls ending in iva:none sends zero messages and zero deletes", async () => {
  writeTeamSettings(true);
  botApiCalls.length = 0;
  const harness = makeHarness();

  const groupUpdate = {
    update_id: 7101,
    message: {
      message_id: 7101,
      date: 1700007101,
      chat: { id: -100779, type: "supergroup", title: "Long Quiet Group" },
      from: { id: OWNER_ID, is_bot: false, username: "owner" },
      text: "Кто может подхватить проверку релиза?",
    },
  };
  const resp = await harness.postUpdate(groupUpdate);
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get("x-iva-telegram-acceptance"), "turn");
  const ivaTurn = harness.sentTurns[0];
  assert.ok(ivaTurn?.state);

  const beforeCalls = botApiCalls.length;
  await harness.completeTurn(
    ivaTurn.state,
    "sess_iva_long_quiet",
    "turn_iva_long_quiet",
    "<!-- iva:none -->\nПроверил заметки — добавлять нечего.",
    {
      toolCallProgress: {
        ageMs: 61_000,
        text: "Проверяю заметки и статус задач…",
        chatKey: chatKeyOf("-100779"),
      },
    },
  );
  const turnMessageCalls = botApiCalls
    .slice(beforeCalls)
    .filter((c) =>
      ["sendMessage", "editMessageText", "deleteMessage"].includes(c.method),
    );
  assert.deepEqual(
    turnMessageCalls,
    [],
    "long group turn ending in iva:none must send zero status/reply/delete messages",
  );
  assert.equal(getChatStatus(chatKeyOf("-100779"))?.status, "idle");
});

// --- Возврат п.3б: пачка inbox с повтором 8201 рядом с новым поручением 8203 ---
test("п.3 (пачка с повтором и новым поручением): promoteReadyInbox delivers fresh 8203 alongside replayed 8201", async () => {
  writeTeamSettings(true);
  botApiCalls.length = 0;
  const harness = makeHarness();

  const makeDmUpdate = (
    updateId: number,
    assignmentId: string,
    body: string,
  ) => ({
    update_id: updateId,
    iva_bot_id: CRITIC_BOT_ID,
    message: {
      message_id: updateId,
      date: 1700008000 + updateId,
      chat: { id: Number(IVA_BOT_ID), type: "private" },
      from: {
        id: Number(IVA_BOT_ID),
        is_bot: true,
        username: "iva_main_bot",
      },
      text: `Поручение от Ива (@iva_main_bot) [${assignmentId}]:\n${body}`,
      iva_bot_id: CRITIC_BOT_ID,
    },
  });

  const firstId = "asg_820100000001";
  const secondId = "asg_820300000002";
  const firstUpdate = makeDmUpdate(8201, firstId, "Первое поручение 8201");
  const secondUpdate = makeDmUpdate(
    8203,
    secondId,
    "Второе новое поручение 8203",
  );

  // 1. First assignment 8201 is accepted and marked done.
  const firstRes = await harness.postUpdate(firstUpdate, CRITIC_BOT_ID);
  assert.equal(firstRes.status, 204);
  assert.equal(firstRes.headers.get("x-iva-telegram-acceptance"), "turn");
  assert.equal(harness.sentTurns.length, 1);

  // 2. Replay of 8201 arrives in the durable inbox together with fresh 8203 from the same bot.
  const key = inboxKeyFor(firstUpdate);
  assert.ok(key);
  let inboxDoc = emptyQueueDocument();
  inboxDoc = enqueueItem(
    inboxDoc,
    key,
    createQueueItem(firstUpdate, 1_000),
  ).document;
  inboxDoc = enqueueItem(
    inboxDoc,
    key,
    createQueueItem(secondUpdate, 1_100),
  ).document;
  const ackedBatches: number[][] = [];
  const acceptanceKinds: Array<string | null> = [];

  const remaining = await promoteReadyInbox({
    now: () => 5_000,
    loadImpl: () => Promise.resolve(inboxDoc),
    acknowledgeImpl: (ackKey, ids) => {
      ackedBatches.push([...ids]);
      inboxDoc = removeQueueItems(inboxDoc, ackKey, ids).document;
      return Promise.resolve();
    },
    routeImpl: (candidate) =>
      routeMessageUpdate(candidate, {
        loadQueueImpl: () => emptyQueueDocument(),
        runningImpl: () => false,
        colleaguesEnabledImpl: () => true,
        deliverImpl: async (deliveredUpdate) => {
          const res = await harness.postUpdate(deliveredUpdate, CRITIC_BOT_ID);
          const kind = res.headers.get("x-iva-telegram-acceptance");
          acceptanceKinds.push(kind);
          if (res.status !== 204) return false;
          return kind === "handled" ? "handled" : true;
        },
      }),
  });

  assert.equal(remaining, 0);
  assert.deepEqual(ackedBatches, [[8201, 8203]]);
  assert.deepEqual(
    acceptanceKinds,
    ["turn"],
    "batch with replayed 8201 + fresh 8203 must start a turn, not return handled",
  );
  assert.equal(
    harness.sentTurns.length,
    2,
    "fresh assignment 8203 alongside replayed 8201 must trigger a second turn",
  );
  const turnMessageText = (msg: unknown): string =>
    typeof msg === "string" ? msg : JSON.stringify(msg ?? "");
  const secondTurnText = turnMessageText(harness.sentTurns[1]?.message);
  assert.ok(
    secondTurnText.includes("Второе новое поручение 8203"),
    `second turn must carry fresh 8203, got: ${secondTurnText}`,
  );
  assert.ok(
    !secondTurnText.includes("Первое поручение 8201"),
    "replayed 8201 must be stripped from the second turn payload",
  );

  const ledger = await listColleagueAssignments();
  assert.equal(ledger.find((r) => r.id === firstId)?.phase, "done");
  assert.equal(ledger.find((r) => r.id === secondId)?.phase, "done");

  const ownerNotices = botApiCalls.filter(
    (c) =>
      c.token === CRITIC_TOKEN &&
      c.method === "sendMessage" &&
      c.body.chat_id === String(OWNER_ID),
  );
  assert.equal(
    ownerNotices.length,
    2,
    "each distinct assignment (8201 and 8203) must send exactly one owner notice",
  );

  // 3. Direct batch with [fresh3, replay2] (reverse order) and [fresh4, fresh5] (two fresh + full replay).
  const thirdId = "asg_820500000003";
  const thirdUpdate = makeDmUpdate(8205, thirdId, "Третье поручение 8205");
  const mixedReverse = joinUpdates([thirdUpdate, secondUpdate]);
  const reverseRes = await harness.postUpdate(mixedReverse, CRITIC_BOT_ID);
  assert.equal(reverseRes.status, 204);
  assert.equal(reverseRes.headers.get("x-iva-telegram-acceptance"), "turn");
  assert.equal(harness.sentTurns.length, 3);
  const thirdTurnText = turnMessageText(harness.sentTurns[2]?.message);
  assert.ok(thirdTurnText.includes("Третье поручение 8205"));
  assert.ok(!thirdTurnText.includes("Второе новое поручение 8203"));
  assert.equal(
    (await listColleagueAssignments()).find((r) => r.id === thirdId)?.phase,
    "done",
  );

  const fourthId = "asg_820700000004";
  const fifthId = "asg_820900000005";
  const twoFreshBatch = joinUpdates([
    makeDmUpdate(8207, fourthId, "Четвёртое поручение 8207"),
    makeDmUpdate(8209, fifthId, "Пятое поручение 8209"),
  ]);
  const twoFreshRes = await harness.postUpdate(twoFreshBatch, CRITIC_BOT_ID);
  assert.equal(twoFreshRes.status, 204);
  assert.equal(twoFreshRes.headers.get("x-iva-telegram-acceptance"), "turn");
  assert.equal(harness.sentTurns.length, 4);
  const allAfterTwoFresh = await listColleagueAssignments();
  assert.equal(allAfterTwoFresh.find((r) => r.id === fourthId)?.phase, "done");
  assert.equal(allAfterTwoFresh.find((r) => r.id === fifthId)?.phase, "done");

  const replayedTwoRes = await harness.postUpdate(twoFreshBatch, CRITIC_BOT_ID);
  assert.equal(replayedTwoRes.status, 204);
  assert.equal(
    replayedTwoRes.headers.get("x-iva-telegram-acceptance"),
    "handled",
  );
  assert.equal(harness.sentTurns.length, 4);
});
