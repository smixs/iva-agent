/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; the Bot API double keeps the async fetch boundary. */
// Подсказка «нажмите /new» на живом шве: хук шага пишет вход основной сессии, канал после
// доставленного ответа и конца хода шлёт одну служебную строку в тот же чат и тему.
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "iva-context-fill-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_ALLOWED_USER_IDS = "9";
process.env.TELEGRAM_BOT_TOKEN = "context-fill-test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "context-fill-test-secret";
after(() => rmSync(dataDir, { recursive: true, force: true }));

type ApiCall = { method: string; body: Record<string, unknown> | undefined };
const apiCalls: ApiCall[] = [];
let refuseSends = false;
let refuseHint = false;
globalThis.fetch = async (url, init = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the double reads whatever eve passes.
  const method = new URL(String(url)).pathname.split("/").at(-1) ?? "";
  const body = init.body
    ? // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the double reads whatever eve passes.
      (JSON.parse(String(init.body)) as Record<string, unknown>)
    : undefined;
  apiCalls.push({ method, body });
  const isHint = typeof body?.text === "string" && body.text.includes("/new");
  if ((refuseSends && /^send/.test(method)) || (refuseHint && isHint))
    return Response.json(
      { ok: false, error_code: 400, description: "Bad Request: refused" },
      { status: 400 },
    );
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
  "message.completed": Handler;
  "turn.completed": Handler;
};

const channelModule = "../agent/channels/telegram.ts?context-fill-test";
const [
  { default: channel },
  { default: usageHook },
  fill,
  { providerConfig },
  { ContextContainer, contextStorage },
  { SessionKey },
] = await Promise.all([
  import(channelModule) as Promise<
    typeof import("../agent/channels/telegram.ts")
  >,
  import("../agent/hooks/usage.ts"),
  import("../agent/lib/context-fill.ts"),
  import("../agent/provider.ts"),
  import("../node_modules/eve/dist/src/context/container.js"),
  import("../node_modules/eve/dist/src/context/keys.js"),
]);
const adapter = (channel as unknown as { adapter: Adapter }).adapter;
const WINDOW = providerConfig.contextWindow;
const stepCompleted = (
  usageHook as unknown as {
    events: Record<string, (event: unknown, ctx: unknown) => void>;
  }
).events["step.completed"];

beforeEach(() => {
  fill.resetContextFillForTests();
  apiCalls.length = 0;
  refuseSends = false;
  refuseHint = false;
});

function step(
  sessionId: string,
  inputTokens: number,
  owner: { kind?: string; parent?: unknown } = {},
) {
  stepCompleted(
    {
      data: {
        stepIndex: 0,
        turnId: "turn_1",
        usage: { inputTokens, outputTokens: 10, cacheReadTokens: 0 },
      },
    },
    {
      session: { id: sessionId, parent: owner.parent },
      channel: { kind: owner.kind ?? "channel:telegram" },
    },
  );
}

async function turn(
  sessionId: string,
  turnId: string,
  {
    message = "ответ",
    thread,
  }: { message?: string | null; thread?: number } = {},
) {
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId,
    turn: { id: turnId, sequence: 1 },
  });
  const context = adapter.createAdapterContext({
    ctx,
    session: {
      id: sessionId,
      auth: { current: null, initiator: null },
      continuation: { token: "telegram:42::", rekey() {} },
    },
    state: {
      ...adapter.state,
      chatId: "42",
      chatType: "private",
      messageThreadId: thread ?? null,
    },
  });
  await contextStorage.run(ctx, async () => {
    await adapter["message.completed"](
      { finishReason: "stop", message, sequence: 1, stepIndex: 0, turnId },
      context,
    );
    await adapter["turn.completed"]({ sequence: 1, turnId }, context);
  });
}

const hints = () =>
  apiCalls.filter(
    (call) =>
      call.method === "sendMessage" && String(call.body?.text).includes("/new"),
  );

test("ход за порогом 50 % заканчивается одной тихой подсказкой с процентом", async () => {
  step("s-50", Math.ceil(WINDOW * 0.6));
  await turn("s-50", "turn_1", { thread: 7 });
  const [hint, ...rest] = hints();
  assert.equal(rest.length, 0);
  assert.equal(hint?.body?.chat_id, "42");
  assert.equal(hint?.body?.message_thread_id, 7);
  assert.equal(hint?.body?.disable_notification, true);
  assert.equal(
    hint?.body?.text,
    "The context window is 60% full. Tap /new to start a new conversation.",
  );
});

test("тот же порог второй раз молчит, следующий срабатывает", async () => {
  step("s-next", Math.ceil(WINDOW * 0.55));
  await turn("s-next", "turn_1");
  step("s-next", Math.ceil(WINDOW * 0.7));
  await turn("s-next", "turn_2");
  assert.equal(hints().length, 1);
  step("s-next", Math.ceil(WINDOW * 0.76));
  await turn("s-next", "turn_3");
  assert.equal(hints().length, 2);
  assert.match(String(hints()[1]?.body?.text), /76%/);
});

test("ниже порога, без ответа и при недоставленном ответе подсказки нет", async () => {
  step("s-low", Math.floor(WINDOW * 0.49));
  await turn("s-low", "turn_1");
  step("s-silent", Math.ceil(WINDOW * 0.8));
  await turn("s-silent", "turn_1", { message: null });
  step("s-refused", Math.ceil(WINDOW * 0.8));
  refuseSends = true;
  await turn("s-refused", "turn_1");
  refuseSends = false;
  assert.equal(hints().length, 0);
});

test("шаги субагента контекст основной сессии не двигают", async () => {
  step("s-sub", Math.ceil(WINDOW * 0.8), { kind: "subagent" });
  step("s-sub", Math.ceil(WINDOW * 0.8), {
    parent: { sessionId: "root", turn: { id: "turn_1", sequence: 1 } },
  });
  await turn("s-sub", "turn_1");
  assert.equal(hints().length, 0);
  step("s-sub", Math.ceil(WINDOW * 0.8));
  await turn("s-sub", "turn_2");
  assert.equal(hints().length, 1);
});

test("отвергнутая подсказка повторяется после следующего хода", async () => {
  step("s-retry", Math.ceil(WINDOW * 0.6));
  refuseHint = true;
  await turn("s-retry", "turn_1");
  refuseHint = false;
  await turn("s-retry", "turn_2");
  assert.equal(hints().length, 2, "первая отвергнута, вторая ушла");
  await turn("s-retry", "turn_3");
  assert.equal(hints().length, 2, "дошедшая больше не повторяется");
});
