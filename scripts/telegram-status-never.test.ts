/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// TELEGRAM_RICH_REPLIES=never: статус-сообщение хода идёт тем же проводом, что при auto
// (scripts/telegram-status-progress.test.ts): статус не читает этот режим вовсе.
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "iva-status-never-wire-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_ALLOWED_USER_IDS = "9";
process.env.TELEGRAM_BOT_TOKEN = "status-never-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "status-never-secret";
process.env.TELEGRAM_RICH_REPLIES = "never";

type ApiCall = {
  signal?: AbortSignal | null;
  method: string;
  body: Record<string, unknown> | undefined;
};
type Handler = (data: Record<string, unknown>, context: unknown) => unknown;
type Adapter = {
  state?: Record<string, unknown>;
  createAdapterContext: (base: {
    ctx: unknown;
    session: {
      id: string;
      auth: { current: null; initiator: null };
      continuation: { token: string; rekey: (token: string) => void };
    };
    state: Record<string, unknown>;
  }) => unknown;
  "message.completed": Handler;
  "turn.cancelled": Handler;
  [event: string]: unknown;
};

const apiCalls: ApiCall[] = [];
// Ответ Telegram на вызов; null — обычный успех. Тест лимита ставит свой.
let telegramReply: (
  call: ApiCall,
) => Response | Promise<Response> | null = () => null;
globalThis.fetch = (url, init = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the double reads whatever eve passes.
  const method = new URL(String(url)).pathname.split("/").at(-1) ?? "";
  const call = {
    signal: init.signal,
    method,
    body: init.body
      ? (JSON.parse(
          // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the double reads whatever eve passes.
          String(init.body),
        ) as Record<string, unknown>)
      : undefined,
  };
  apiCalls.push(call);
  return Promise.resolve(
    telegramReply(call) ??
      Response.json({
        ok: true,
        result: { message_id: 1, chat: { id: 1, type: "private" } },
      }),
  );
};

// Спецификатор в переменной — как в scripts/telegram-failure-events.test.ts: свой экземпляр
// канала на файл.
const telegramTestModule = "../agent/channels/telegram.ts?status-never-test";
const [
  { default: channel },
  { chatKeyOf, getChatStatus, setChatStatus },
  { ContextContainer, contextStorage },
  { SessionKey },
] = await Promise.all([
  import(telegramTestModule) as Promise<
    typeof import("../agent/channels/telegram.ts")
  >,
  import("#lib/run-status.ts"),
  import("../node_modules/eve/dist/src/context/container.js"),
  import("../node_modules/eve/dist/src/context/keys.js"),
]);
const adapter = (channel as unknown as { adapter: Adapter }).adapter;

after(() => rmSync(dataDir, { recursive: true, force: true }));

async function emit(
  event:
    | "message.completed"
    | "turn.cancelled"
    | "turn.started"
    | "message.appended"
    | "actions.requested"
    | "action.result"
    | "input.requested"
    | "input.resolved"
    | "turn.completed"
    | "turn.failed"
    | "session.failed",
  data: Record<string, unknown>,
  {
    chatId,
    sessionId,
    chatType = "private",
    threadId,
    state,
  }: {
    chatId: string;
    sessionId: string;
    chatType?: string;
    threadId?: number;
    state?: Record<string, unknown>;
  },
) {
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId,
    turn: { id: "turn_1", sequence: 0 },
  });
  const context = adapter.createAdapterContext({
    ctx,
    session: {
      id: sessionId,
      auth: { current: null, initiator: null },
      continuation: { token: `telegram:${chatId}::`, rekey() {} },
    },
    state: state ?? {
      ...adapter.state,
      chatId,
      chatType,
      messageThreadId: threadId ?? null,
    },
  });
  await contextStorage.run(ctx, () =>
    (adapter[event] as Handler)(data, context),
  );
  // Правку статуса шаг не ждёт: запрос уходит следом, и тест смотрит на провод после него.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const { PROGRESS_MIN_TURN_MS, STATUS_EDIT_MIN_MS } =
  await import("#lib/telegram-draft.ts");

test("rich replies never: the status message has the same wire, silent HTML, edited and deleted", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  apiCalls.length = 0;
  let nextId = 700;
  telegramReply = (call) =>
    call.method === "sendMessage"
      ? Response.json({
          ok: true,
          result: { message_id: ++nextId, chat: { id: 1, type: "private" } },
        })
      : null;
  const pair = { chatId: "301", sessionId: "never-1" };
  setChatStatus(chatKeyOf("301"), {
    status: "idle",
    sessionId: null,
    turnId: null,
    resetAt: null,
  });
  await emit("turn.started", { turnId: "turn_1" }, pair);
  now += PROGRESS_MIN_TURN_MS + 1;
  const table = "| a |\n| - |\n| b |";
  const step = (message: string, stepIndex: number, finishReason: string) =>
    emit(
      "message.completed",
      { turnId: "turn_1", stepIndex, message, finishReason },
      pair,
    );
  await step(table, 0, "tool-calls");
  now += STATUS_EDIT_MIN_MS;
  await step("Second.", 1, "tool-calls");
  await step("Final.", 2, "stop");
  await emit("turn.completed", { turnId: "turn_1" }, pair);
  const wire = apiCalls
    .filter((c) =>
      [
        "sendMessage",
        "editMessageText",
        "deleteMessage",
        "sendRichMessage",
      ].includes(c.method),
    )
    .map((c) => c.method);
  assert.deepEqual(wire, [
    "sendMessage",
    "editMessageText",
    "sendMessage",
    "deleteMessage",
  ]);
  const [post, final] = apiCalls.filter((c) => c.method === "sendMessage");
  assert.equal(post.body?.parse_mode, "HTML");
  assert.equal(post.body?.disable_notification, true);
  assert.equal(final.body?.disable_notification, undefined);
  assert.equal(
    apiCalls.find((c) => c.method === "editMessageText")?.body?.message_id,
    701,
  );
  assert.equal(
    apiCalls.find((c) => c.method === "deleteMessage")?.body?.message_id,
    701,
  );
  assert.equal(getChatStatus("301:")?.progressMessageId, undefined);
  telegramReply = () => null;
});
