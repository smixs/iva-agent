/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; the Bot API double keeps the async fetch boundary. */
// Подсказка «нажмите /new» на живом шве: канал открывает сессию на turn.started, хук шага
// пишет её вход, канал после доставленного ответа и конца хода шлёт одну тихую строку в тот
// же чат и тему. События идут в порядке eve: message.completed уходит в конце стрима шага,
// step.completed того же шага — после него, затем turn.completed.
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  "turn.started": Handler;
  "message.completed": Handler;
  "turn.completed": Handler;
};

const channelModule = "../agent/channels/telegram.ts?context-fill-test";
const [
  { default: channel },
  { default: usageHook },
  { providerConfig },
  trace,
  { ContextContainer, contextStorage },
  { SessionKey },
] = await Promise.all([
  import(channelModule) as Promise<
    typeof import("../agent/channels/telegram.ts")
  >,
  import("../agent/hooks/usage.ts"),
  import("../agent/provider.ts"),
  import("../agent/lib/trace.ts"),
  import("../node_modules/eve/dist/src/context/container.js"),
  import("../node_modules/eve/dist/src/context/keys.js"),
]);
const adapter = (channel as unknown as { adapter: Adapter }).adapter;
// Бюджет — доля окна, на которой eve сжимает историю (compaction.thresholdPercent).
const BUDGET = Math.floor(providerConfig.contextWindow * 0.7);
const at = (share: number) => Math.ceil(BUDGET * share);
const hookEvents = (
  usageHook as unknown as {
    events: Record<string, (event: unknown, ctx: unknown) => void>;
  }
).events;

let seq = 0;
beforeEach(() => {
  apiCalls.length = 0;
  refuseSends = false;
  refuseHint = false;
});

type StepOwner = { kind?: string; parent?: unknown };
// null — шаг без расхода; "no-input" — расход без inputTokens (провайдер не назвал вход).
type StepTokens = number | null | "no-input";
function step(sessionId: string, tokens: StepTokens, owner: StepOwner = {}) {
  hookEvents["step.completed"](
    {
      data: {
        stepIndex: 0,
        turnId: "turn_x",
        ...(tokens === null
          ? {}
          : tokens === "no-input"
            ? { usage: { outputTokens: 10 } }
            : {
                usage: {
                  inputTokens: tokens,
                  outputTokens: 10,
                  cacheReadTokens: 0,
                },
              }),
      },
    },
    {
      session: { id: sessionId, parent: owner.parent },
      channel: { kind: owner.kind ?? "channel:telegram" },
    },
  );
}

type TurnOptions = {
  message?: string | null;
  thread?: number;
  started?: boolean;
  earlier?: number;
  owner?: StepOwner;
};

/** Один ход в порядке eve; возвращает число подсказок до turn.completed. */
async function turn(
  sessionId: string,
  tokens: StepTokens,
  {
    message = "ответ",
    thread,
    started = true,
    earlier,
    owner,
  }: TurnOptions = {},
): Promise<number> {
  const turnId = `turn_${++seq}`;
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
      continuation: { token: "telegram:42::", rekey() {} },
    },
    state: {
      ...adapter.state,
      chatId: "42",
      chatType: "private",
      messageThreadId: thread ?? null,
    },
  });
  let beforeTurnEnd = 0;
  await contextStorage.run(ctx, async () => {
    if (started)
      await adapter["turn.started"]({ sequence: seq, turnId }, context);
    if (earlier !== undefined) step(sessionId, earlier);
    await adapter["message.completed"](
      { finishReason: "stop", message, sequence: seq, stepIndex: 1, turnId },
      context,
    );
    step(sessionId, tokens, owner);
    beforeTurnEnd = hints().length;
    await adapter["turn.completed"]({ sequence: seq, turnId }, context);
  });
  return beforeTurnEnd;
}

const hints = () =>
  apiCalls.filter(
    (call) =>
      call.method === "sendMessage" &&
      typeof call.body?.text === "string" &&
      call.body.text.includes("/new"),
  );

test("ход за порогом 50 % заканчивается одной тихой подсказкой с процентом: одношаговый 45 % → 55 %, не раньше turn.completed", async () => {
  await turn("s-one-step", at(0.45));
  assert.equal(hints().length, 0);
  const beforeTurnEnd = await turn("s-one-step", at(0.55), { thread: 7 });
  assert.equal(beforeTurnEnd, 0, "message.completed подсказку не шлёт");
  const [hint, ...rest] = hints();
  assert.equal(rest.length, 0);
  assert.equal(hint?.body?.chat_id, "42");
  assert.equal(hint?.body?.message_thread_id, 7);
  assert.equal(hint?.body?.disable_notification, true);
  assert.equal(
    hint?.body?.text,
    "The context window is 55% full. Tap /new to start a new conversation.",
  );
});

test("подсказка уходит до уборки статуса хода", async () => {
  await turn("s-order", at(0.6));
  const hintAt = apiCalls.findIndex(
    (call) => call.method === "sendMessage" && call === hints()[0],
  );
  const cleanupAt = apiCalls.findIndex(
    (call) => call.method === "deleteMessage",
  );
  assert.ok(hintAt >= 0 && cleanupAt >= 0, JSON.stringify(apiCalls));
  assert.ok(hintAt < cleanupAt, "подсказка раньше, чем чат снова свободен");
});

test("тот же порог второй раз молчит, следующий срабатывает, спад ниже 50 % взводит заново", async () => {
  await turn("s-next", at(0.55));
  await turn("s-next", at(0.7));
  assert.equal(hints().length, 1);
  await turn("s-next", at(0.76));
  assert.equal(hints().length, 2);
  await turn("s-next", at(0.3));
  await turn("s-next", at(0.52));
  assert.equal(hints().length, 3);
});

test("ниже порога, без ответа и при недоставленном ответе подсказки нет", async () => {
  await turn("s-low", Math.floor(BUDGET * 0.49));
  await turn("s-silent", at(0.8), { message: null });
  refuseSends = true;
  await turn("s-refused", at(0.8));
  refuseSends = false;
  assert.equal(hints().length, 0);
});

test("отказ Telegram на подсказку не фиксирует порог: следующий ход скажет снова", async () => {
  refuseHint = true;
  await turn("s-retry", at(0.6));
  refuseHint = false;
  await turn("s-retry", at(0.6));
  await turn("s-retry", at(0.6));
  assert.equal(
    hints().length,
    2,
    "первая отвергнута, вторая ушла, третьей нет",
  );
});

test("последний шаг без расхода: контекст неизвестен, подсказки нет", async () => {
  await turn("s-unknown", null, { earlier: at(0.8) });
  assert.equal(hints().length, 0);
  // «Неизвестно» — не ноль: пороги не взводятся заново, 50 после него не повторяется.
  await turn("s-unknown", at(0.6));
  await turn("s-unknown", null);
  await turn("s-unknown", "no-input");
  await turn("s-unknown", at(0.6));
  assert.equal(hints().length, 1);
});

test("сессия без turn.started (фон, дайджест) в карту не попадает", async () => {
  await turn("s-background", at(0.9), { started: false });
  assert.equal(hints().length, 0);
});

test("шаг ребёнка встроенного agent идёт под своей сессией и родителя не двигает", async () => {
  await turn("s-parent", at(0.3));
  step("s-child", at(0.95), {
    kind: "subagent",
    parent: { sessionId: "s-parent", turn: { id: "turn_1", sequence: 1 } },
  });
  hookEvents["subagent.event"](
    {
      data: {
        subagentName: "planner",
        event: {
          type: "step.completed",
          data: {
            stepIndex: 0,
            turnId: "turn_0",
            usage: { inputTokens: at(0.95), outputTokens: 1 },
          },
        },
      },
    },
    {
      session: { id: "s-parent", turn: { id: "turn_9", sequence: 9 } },
      channel: { kind: "channel:telegram" },
    },
  );
  await turn("s-parent", at(0.3));
  assert.equal(hints().length, 0);
});

function gateEvents(): Record<string, unknown>[] {
  try {
    return readFileSync(trace.traceFilePath(trace.traceDay(), dataDir), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.kind === "gate");
  } catch {
    return []; // журнала ещё нет — событий тоже
  }
}

test("подсказка проходит outbound-гейт, вердикт в журнале с ключом хода", async () => {
  await turn("s-gate", at(0.6));
  const hintGate = gateEvents().find(
    (event) =>
      event.session === "s-gate" &&
      String((event.data as { text?: unknown } | undefined)?.text).includes(
        "/new",
      ),
  );
  assert.ok(hintGate, "у подсказки нет вердикта гейта в журнале");
  assert.equal(hintGate.turn, `turn_${seq}`);
});

test("фоновая сессия и после двух ходов без turn.started подсказку не получает", async () => {
  await turn("s-background-2", at(0.9), { started: false });
  await turn("s-background-2", at(0.9), { started: false });
  assert.equal(hints().length, 0);
});
