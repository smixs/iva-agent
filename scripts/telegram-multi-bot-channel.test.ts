import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RouteHandlerArgs, Session } from "eve/channels";
import type { TelegramChannelState } from "eve/channels/telegram";
import {
  TELEGRAM_BOT_ID_FIELD,
  TELEGRAM_BOT_ID_HEADER,
} from "../packages/telegram-bots/index.ts";

// Isolated runtime dirs before importing channel modules (settings/run-status read env at load).
const root = mkdtempSync(join(tmpdir(), "iva-multi-bot-channel-"));
const dataPath = join(root, "data");
const vaultPath = join(root, "vault");
mkdirSync(dataPath, { recursive: true });
mkdirSync(vaultPath, { recursive: true });
// Multi-bot channel tests verify active colleague routing with the option enabled.
writeFileSync(
  join(dataPath, "settings.json"),
  JSON.stringify({ colleagues: { enabled: true, items: {} } }),
);
process.env.ASSISTANT_DATA_DIR = dataPath;
process.env.ASSISTANT_VAULT_DIR = vaultPath;
process.env.ASSISTANT_TIMEZONE = "UTC";
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "multi-bot-webhook-secret";

const IVA_BOT_ID = "111111111";
const IVA_TOKEN = `${IVA_BOT_ID}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
const COLLEAGUE_BOT_ID = "222222222";
const COLLEAGUE_TOKEN = `${COLLEAGUE_BOT_ID}:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`;
const WEBHOOK_SECRET = "multi-bot-webhook-secret";

process.env.TELEGRAM_BOT_TOKEN = IVA_TOKEN;
process.env.TELEGRAM_BOT_USERNAME = "iva_main_bot";
process.env.TELEGRAM_COLLEAGUE_BOT_TOKENS = `critic_bot=${COLLEAGUE_TOKEN}`;

process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const [
  { createTelegramChannel, outboxTransport },
  { sendFile },
  { TELEGRAM_ACCEPTANCE_ROUTE },
  { getChatStatus },
  { ContextContainer, contextStorage },
  { SessionKey },
] = await Promise.all([
  import("../agent/channels/telegram.ts"),
  import("../agent/tools/send_file.ts"),
  import("#lib/telegram-acceptance.ts"),
  import("#lib/run-status.ts"),
  import("../node_modules/eve/dist/src/context/container.js"),
  import("../node_modules/eve/dist/src/context/keys.js"),
]);

function runChannelEvent(
  adapter: RuntimeAdapter,
  event: "message.completed" | "turn.failed",
  sessionId: string,
  state: TelegramChannelState,
  data: Record<string, unknown>,
  rekey?: (token: string) => void,
): Promise<void> {
  const container = new ContextContainer();
  container.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId,
    turn: {
      id: typeof data.turnId === "string" ? data.turnId : "turn-0",
      sequence: 0,
    },
  });
  const session = {
    id: sessionId,
    auth: { current: null, initiator: null },
    continuation: {
      token: "telegram:42::",
      rekey: rekey ?? (() => {}),
    },
  } as unknown as Session;
  return contextStorage.run(container, () => {
    const adapterCtx = adapter.createAdapterContext({
      state,
      session,
      ctx: container as unknown as Record<string, unknown>,
    });
    return adapter[event](data, adapterCtx);
  });
}

type RecordedCall = {
  readonly token: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
};

function createStubBotApi() {
  const calls: RecordedCall[] = [];
  let nextMessageId = 100;

  const stubFetch: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const match = /\/bot([^/]+)\/([^/?]+)/u.exec(url);
    assert.ok(match, `unexpected Bot API URL: ${url}`);
    const [, token, method] = match;
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as Record<string, unknown>;
    }
    calls.push({ token, method, body });
    const messageId = ++nextMessageId;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: messageId,
            chat: { id: body.chat_id ?? 42, type: "private" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };

  return { calls, stubFetch };
}

type CapturedSession = {
  readonly id: string;
  readonly address: string;
  readonly auth: unknown;
  readonly state: TelegramChannelState;
  readonly rekeyed: string[];
};

function createRouteHarness() {
  const sessions = new Map<string, CapturedSession>();
  const byAddress = new Map<string, CapturedSession>();
  let seq = 0;

  const makeSessionHandle = (entry: CapturedSession) =>
    ({
      id: entry.id,
      continuation: {
        rekey: (token: string) => {
          entry.rekeyed.push(token);
        },
      },
    }) as unknown as Session;

  const args = {
    from: (address: string) => ({
      send: (
        _message: unknown,
        options?: { auth?: unknown; state?: TelegramChannelState },
      ) => {
        const existing = byAddress.get(address);
        if (existing) return Promise.resolve(makeSessionHandle(existing));
        const entry: CapturedSession = {
          id: `sess-${++seq}`,
          address,
          auth: options?.auth,
          state: options?.state
            ? { ...options.state }
            : ({} as TelegramChannelState),
          rekeyed: [],
        };
        sessions.set(entry.id, entry);
        byAddress.set(address, entry);
        return Promise.resolve(makeSessionHandle(entry));
      },
      respond: () => Promise.reject(new Error("unexpected respond")),
      cancel: () => Promise.resolve({ status: "no_active_turn" as const }),
      clear: () => Promise.resolve({ status: "cleared" as const }),
      compact: () => Promise.resolve({ status: "compacted" as const }),
      reset: () => Promise.resolve({ status: "reset" as const }),
    }),
    resolveSession: (address: string) => {
      const entry = byAddress.get(address);
      return Promise.resolve(entry ? makeSessionHandle(entry) : undefined);
    },
    attachSession: (sessionId: string) => {
      const entry = sessions.get(sessionId);
      assert.ok(entry, `unknown session ${sessionId}`);
      return makeSessionHandle(entry);
    },
    waitUntil: () => {},
  } as unknown as RouteHandlerArgs<TelegramChannelState>;

  return { args, sessions, byAddress };
}

function webhookRequest(
  path: string,
  payload: Record<string, unknown>,
  botId?: string,
): Request {
  return new Request(`http://127.0.0.1:8723${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
      ...(botId ? { [TELEGRAM_BOT_ID_HEADER]: botId } : {}),
    },
    body: JSON.stringify(payload),
  });
}

type RuntimeAdapter = {
  createAdapterContext: (base: {
    state: TelegramChannelState;
    session: Session;
    ctx: Record<string, unknown>;
  }) => { state: TelegramChannelState; telegram: unknown; session: Session };
  "message.completed": (
    data: Record<string, unknown>,
    adapterCtx: unknown,
  ) => Promise<void>;
  "turn.failed": (
    data: Record<string, unknown>,
    adapterCtx: unknown,
  ) => Promise<void>;
};

void test("replies go out from the exact bot token that received each message (two tokens on stub Bot API)", async () => {
  const { calls, stubFetch } = createStubBotApi();
  const channel = createTelegramChannel({
    api: { fetch: stubFetch },
    env: () => process.env,
  });
  const acceptedRoute = channel.routes.find(
    (r) =>
      r.transport !== "websocket" &&
      r.method === "POST" &&
      r.path === TELEGRAM_ACCEPTANCE_ROUTE,
  );
  assert.ok(acceptedRoute && acceptedRoute.transport !== "websocket");

  const harness = createRouteHarness();

  // Same owner (chat_id = 42) AND same update_id (500) sent to BOTH bots!
  const ivaRes = await acceptedRoute.handler(
    webhookRequest(TELEGRAM_ACCEPTANCE_ROUTE, {
      update_id: 500,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Owner" },
        text: "hello iva",
      },
    }),
    harness.args,
  );
  assert.equal(ivaRes.status, 204);

  const colleagueRes = await acceptedRoute.handler(
    webhookRequest(
      TELEGRAM_ACCEPTANCE_ROUTE,
      {
        update_id: 500,
        [TELEGRAM_BOT_ID_FIELD]: COLLEAGUE_BOT_ID,
        message: {
          message_id: 11,
          date: 1_700_000_001,
          chat: { id: 42, type: "private" },
          from: { id: 42, is_bot: false, first_name: "Owner" },
          text: "hello critic",
          [TELEGRAM_BOT_ID_FIELD]: COLLEAGUE_BOT_ID,
        },
      },
      COLLEAGUE_BOT_ID,
    ),
    harness.args,
  );
  assert.equal(colleagueRes.status, 204);

  // Separate sessions and separate ChatRecords for the same chat_id = 42.
  const ivaSession = harness.byAddress.get("42::");
  const colleagueSession = harness.byAddress.get(
    `bot:${COLLEAGUE_BOT_ID}:42::`,
  );
  assert.ok(ivaSession, "primary bot session must keep legacy address 42::");
  assert.ok(
    colleagueSession,
    "colleague bot session must be isolated under bot:<id>:42::",
  );
  assert.notEqual(ivaSession.id, colleagueSession.id);
  assert.equal(
    (colleagueSession.state as { botId?: string }).botId,
    COLLEAGUE_BOT_ID,
  );
  assert.equal(
    (colleagueSession.auth as { attributes?: Record<string, string> })
      ?.attributes?.bot_id,
    COLLEAGUE_BOT_ID,
  );
  assert.ok(getChatStatus("42:"));
  assert.ok(getChatStatus(`bot:${COLLEAGUE_BOT_ID}:42:`));

  // Inbound typing indicators already went to each bot's own token.
  const typingTokens = calls
    .filter((c) => c.method === "sendChatAction")
    .map((c) => c.token);
  assert.ok(typingTokens.includes(IVA_TOKEN));
  assert.ok(typingTokens.includes(COLLEAGUE_TOKEN));

  // Now simulate outbound replies on BOTH sessions via the real channel adapter!
  calls.length = 0;
  const adapter = (channel as unknown as { adapter: RuntimeAdapter }).adapter;

  await runChannelEvent(
    adapter,
    "message.completed",
    ivaSession.id,
    ivaSession.state,
    {
      turnId: "turn-iva-1",
      stepIndex: 0,
      finishReason: "stop",
      message: "Answer from Iva",
    },
  );
  await runChannelEvent(
    adapter,
    "message.completed",
    colleagueSession.id,
    colleagueSession.state,
    {
      turnId: "turn-colleague-1",
      stepIndex: 0,
      finishReason: "stop",
      message: "Answer from Critic",
    },
  );

  const sentMessages = calls.filter((c) => c.method === "sendMessage");
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0]?.token, IVA_TOKEN);
  assert.match(String(sentMessages[0]?.body.text), /Answer from Iva/u);
  assert.equal(sentMessages[1]?.token, COLLEAGUE_TOKEN);
  assert.match(String(sentMessages[1]?.body.text), /Answer from Critic/u);

  // Failure notice on colleague session also goes out from colleague's token!
  calls.length = 0;
  await runChannelEvent(
    adapter,
    "turn.failed",
    colleagueSession.id,
    colleagueSession.state,
    {
      turnId: "turn-colleague-2",
      message: "provider timeout",
    },
  );
  const failureCalls = calls.filter((c) => c.method === "sendMessage");
  assert.ok(failureCalls.length >= 1);
  assert.ok(failureCalls.every((c) => c.token === COLLEAGUE_TOKEN));
});

void test("unknown colleague botId is rejected fail-closed with 404 and never falls back to Iva", async () => {
  const { calls, stubFetch } = createStubBotApi();
  const channel = createTelegramChannel({
    api: { fetch: stubFetch },
    env: () => process.env,
  });
  const acceptedRoute = channel.routes.find(
    (r) =>
      r.transport !== "websocket" &&
      r.method === "POST" &&
      r.path === TELEGRAM_ACCEPTANCE_ROUTE,
  );
  assert.ok(acceptedRoute && acceptedRoute.transport !== "websocket");

  const harness = createRouteHarness();
  const res = await acceptedRoute.handler(
    webhookRequest(
      TELEGRAM_ACCEPTANCE_ROUTE,
      {
        update_id: 999,
        [TELEGRAM_BOT_ID_FIELD]: "999999999",
        message: {
          message_id: 99,
          date: 1_700_000_000,
          chat: { id: 42, type: "private" },
          from: { id: 42, is_bot: false, first_name: "Owner" },
          text: "should be rejected",
          [TELEGRAM_BOT_ID_FIELD]: "999999999",
        },
      },
      "999999999",
    ),
    harness.args,
  );
  assert.equal(res.status, 404);
  assert.equal(harness.sessions.size, 0);
  assert.equal(calls.length, 0);
});

void test("group anchor rekeying preserves bot:<botId>: prefix for colleague sessions", async () => {
  const { stubFetch } = createStubBotApi();
  const channel = createTelegramChannel({
    api: { fetch: stubFetch },
    env: () => process.env,
  });
  const adapter = (channel as unknown as { adapter: RuntimeAdapter }).adapter;
  const rekeyed: string[] = [];

  await runChannelEvent(
    adapter,
    "message.completed",
    "sess-group-colleague",
    {
      botId: COLLEAGUE_BOT_ID,
      botUsername: "critic_colleague_bot",
      chatId: "-100555",
      chatType: "supergroup",
      conversationId: "70",
      hitlCallbacks: {},
      messageThreadId: null,
      nextHitlCallbackId: 0,
      pendingAuthMessageIds: {},
      pendingFreeformReplies: {},
      triggeringUserId: "42",
    } as TelegramChannelState,
    {
      turnId: "turn-group-1",
      stepIndex: 0,
      finishReason: "stop",
      message: "Group reply from Critic",
    },
    (token) => {
      rekeyed.push(token);
    },
  );
  assert.equal(rekeyed.length, 1);
  assert.ok(
    rekeyed[0]?.startsWith(`bot:${COLLEAGUE_BOT_ID}:-100555:`),
    `expected bot-scoped rekey, got ${rekeyed[0]}`,
  );
});

void test("send_file and outboxTransport sendWidget use the recipient colleague bot token", async () => {
  const savedFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (input: string | URL | Request) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  try {
    const filePath = join(vaultPath, "report.txt");
    writeFileSync(filePath, "hello from colleague");

    const fileRes = await sendFile(
      { path: "report.txt" },
      { id: "42", threadId: null },
      { botId: COLLEAGUE_BOT_ID },
    );
    assert.equal(fileRes.ok, true);
    assert.ok(
      urls.some((u) => u.includes(`/bot${COLLEAGUE_TOKEN}/sendDocument`)),
      `expected colleague token in sendDocument, saw: ${urls.join(", ")}`,
    );

    const transport = outboxTransport(
      {
        chatId: "42",
        messageThreadId: undefined,
        request: () =>
          Promise.resolve({ ok: true, status: 200, body: { ok: true } }),
        post: () => Promise.resolve({ id: "1", raw: {} }),
      },
      "auto",
      false,
      COLLEAGUE_TOKEN,
    );
    assert.ok(transport.sendWidget);
    const widgetAck = await transport.sendWidget("<div>hi</div>", "caption");
    assert.equal(widgetAck.ok, true);
    assert.ok(
      urls.some((u) => u.includes(`/bot${COLLEAGUE_TOKEN}/sendWidget`)),
      `expected colleague token in sendWidget, saw: ${urls.join(", ")}`,
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});
