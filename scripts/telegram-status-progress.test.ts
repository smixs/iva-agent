/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Проводка канала: текст шага модели перед вызовом инструментов (finishReason "tool-calls")
// обновляет draft и один раз уходит обычным сообщением; финальный ответ идёт отдельно.
// Ход без промежуточного текста сохраняет прежние вызовы Bot API. Двойник — fetch:
// здесь видно тело запроса таким, каким его получает Telegram.
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "iva-status-progress-wire-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_ALLOWED_USER_IDS = "9";
process.env.TELEGRAM_BOT_TOKEN = "status-progress-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "status-progress-secret";
process.env.TELEGRAM_RICH_REPLIES = "auto";

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
const telegramTestModule = "../agent/channels/telegram.ts?status-progress-test";
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
const trace = await import("#lib/trace.ts");

function traceEvents(): Record<string, unknown>[] {
  try {
    return readFileSync(trace.traceFilePath(trace.traceDay(), dataDir), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return []; // журнала ещё нет — событий тоже
  }
}

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
    | "turn.completed",
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

test("a cancelled in-flight draft drains before the next session's final in the same chat", async (t) => {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 200_000,
  });
  const chatId = "91";
  const oldSession = "repair-old";
  const newSession = "repair-new";
  const { closeTelegramDraftTurn } = await import("#lib/telegram-draft.ts");
  const applied: string[] = [];
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let first = true;
  apiCalls.length = 0;
  setChatStatus(chatKeyOf(chatId), {
    status: "idle",
    sessionId: null,
    turnId: null,
    draftId: null,
    resetAt: null,
  });
  telegramReply = async (call) => {
    if (call.method === "sendRichMessageDraft" && first) {
      first = false;
      const response = await held;
      applied.push(call.method);
      return response;
    }
    applied.push(call.method);
    return Response.json({
      ok: true,
      result: { message_id: 1, chat: { id: 91, type: "private" } },
    });
  };
  t.after(async () => {
    release(Response.json({ ok: true, result: true }));
    await closeTelegramDraftTurn(oldSession, undefined, 0, true);
    await closeTelegramDraftTurn(newSession, undefined, 0, true);
    telegramReply = () => null;
    t.mock.timers.reset();
  });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  await emit(
    "turn.started",
    { turnId: "old" },
    { chatId, sessionId: oldSession },
  );
  t.mock.timers.tick(0);
  await flush();
  const cancel = emit(
    "turn.cancelled",
    { turnId: "old" },
    { chatId, sessionId: oldSession },
  );
  await flush();
  t.mock.timers.tick(1_999);
  await flush();
  t.mock.timers.tick(1);
  await flush();
  await cancel;
  assert.equal(
    Date.now(),
    202_000,
    "cancellation still releases the chat within two seconds",
  );
  await emit(
    "turn.started",
    { turnId: "new" },
    { chatId, sessionId: newSession },
  );
  const final = emit(
    "message.completed",
    { turnId: "new", stepIndex: 0, message: "new final", finishReason: "stop" },
    { chatId, sessionId: newSession },
  );
  await flush();
  const beforeDrain = applied.filter((method) => method !== "sendChatAction");
  t.mock.timers.tick(1_000);
  await flush();
  release(Response.json({ ok: true, result: true }));
  await flush();
  await final;
  await emit(
    "turn.completed",
    { turnId: "new" },
    { chatId, sessionId: newSession },
  );
  assert.deepEqual(
    beforeDrain,
    [],
    "final waits for the previous cancelled draft request",
  );
  assert.deepEqual(
    applied.filter((method) => method !== "sendChatAction"),
    ["sendRichMessageDraft", "sendMessage"],
  );
});

test("a refused turn claim keeps typing every 4.5 seconds and closes at the terminal event or takeover", async (t) => {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 300_000,
  });
  const chatId = "92";
  const sessionId = "repair-refused";
  const { closeTelegramDraftTurn } = await import("#lib/telegram-draft.ts");
  t.after(async () => {
    await closeTelegramDraftTurn(sessionId, undefined, 0, true);
    t.mock.timers.reset();
  });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  apiCalls.length = 0;
  setChatStatus(chatKeyOf(chatId), {
    status: "idle",
    sessionId: null,
    turnId: null,
    draftId: null,
    resetAt: 1,
  });
  await emit("turn.started", { turnId: "refused" }, { chatId, sessionId });
  t.mock.timers.tick(4_500);
  await flush();
  t.mock.timers.tick(4_500);
  await flush();
  const count = apiCalls.filter(
    (call) => call.method === "sendChatAction",
  ).length;
  assert.equal(
    apiCalls.filter((call) => call.method === "sendRichMessageDraft").length,
    0,
  );
  await emit("turn.completed", { turnId: "refused" }, { chatId, sessionId });
  t.mock.timers.tick(9_000);
  await flush();
  assert.equal(
    apiCalls.filter((call) => call.method === "sendChatAction").length,
    count,
  );
  assert.equal(count, 3);
  await emit(
    "turn.started",
    { turnId: "refused-again" },
    { chatId, sessionId },
  );
  setChatStatus(chatKeyOf(chatId), {
    status: "running",
    sessionId: "takeover",
    turnId: "takeover",
  });
  const beforeTakeover = apiCalls.length;
  t.mock.timers.tick(9_000);
  await flush();
  assert.equal(apiCalls.length, beforeTakeover);
});

test("сломанный модуль гейта не мешает мосту стартовать, а статус без гейта не грузится", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const childData = mkdtempSync(join(tmpdir(), "iva-status-progress-bridge-"));
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
registerHooks({
  load: (url, context, next) =>
    url.includes("/agent/lib/security-gate.ts")
      ? { format: "module", source: "throw new Error('gate module broken')", shortCircuit: true }
      : next(url, context),
});
const at = (path) => import(pathToFileURL(join(process.env.IVA_ROOT, path)).href);
const control = await at("scripts/poller/control.ts");
const stop = await at("agent/lib/telegram-stop.ts");
const status = await at("agent/lib/telegram-draft.ts").then(
  () => ({ loaded: true }),
  (error) => ({ loaded: false, reason: String(error?.message ?? error) }),
);
console.log(JSON.stringify({ bridge: typeof control.handleControl, stop: typeof stop.handleTelegramDraftStop, status }));
`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          IVA_ROOT: root,
          ASSISTANT_DATA_DIR: childData,
          AGENT_LANGUAGE: "en",
        },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const seen = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "") as {
      bridge: string;
      stop: string;
      status: { loaded: boolean; reason?: string };
    };
    assert.equal(seen.bridge, "function");
    assert.equal(seen.stop, "function");
    assert.equal(seen.status.loaded, false);
    // Статус не загрузился именно из-за гейта, а не по другой причине.
    assert.match(seen.status.reason ?? "", /security-gate/u);
  } finally {
    rmSync(childData, { recursive: true, force: true });
  }
});

const pause = (ms = 20) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const draftCalls = () =>
  apiCalls.filter((call) => call.method === "sendRichMessageDraft");
const richText = (call: ApiCall) =>
  String((call.body?.rich_message as { markdown?: unknown })?.markdown);

test("question answers resume typing and a fresh stoppable draft in the same turn", async (t) => {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 300_000,
  });
  apiCalls.length = 0;
  const pair = {
    chatId: "92",
    sessionId: "question-resume",
    state: {
      ...adapter.state,
      chatId: "92",
      chatType: "private",
      messageThreadId: null,
    },
  };
  setChatStatus("92:", {
    status: "idle",
    sessionId: null,
    turnId: null,
    draftId: null,
    resetAt: null,
  });
  await emit("turn.started", { turnId: "turn_1" }, pair);
  t.mock.timers.tick(10_001);
  try {
    for (let stepIndex = 0; stepIndex < 2; stepIndex++) {
      await emit(
        "message.completed",
        {
          turnId: "turn_1",
          stepIndex,
          message: "Checking.",
          finishReason: "tool-calls",
        },
        pair,
      );
      assert.equal(
        apiCalls.filter(
          (c) => c.method === "sendMessage" && c.body?.text === "Checking.",
        ).length,
        1,
      );

      const previousDraftId = getChatStatus("92:")?.draftId;
      const requestId = `q-${stepIndex}`;
      await emit(
        "input.requested",
        {
          turnId: "turn_1",
          stepIndex,
          requests: [
            {
              requestId,
              kind: "question",
              prompt: "Continue?",
              action: {
                callId: requestId,
                kind: "tool-call",
                toolName: "ask_question",
                input: {},
              },
              options: [{ id: "yes", label: "Yes" }],
            },
          ],
        },
        pair,
      );
      const waiting = apiCalls.length;
      t.mock.timers.tick(4_500);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(apiCalls.length, waiting);
      await emit(
        "input.resolved",
        {
          turnId: "turn_1",
          stepIndex,
          sequence: stepIndex + 1,
          resolutions: [
            {
              requestId,
              kind: "question",
              outcome: "answered",
              response: { optionId: "yes" },
            },
          ],
        },
        pair,
      );
      assert.ok(
        apiCalls
          .slice(waiting)
          .some(
            (call) =>
              call.method === "editMessageText" &&
              richText(call).includes("Selected: Yes"),
          ),
        JSON.stringify(apiCalls.slice(waiting)),
      );
      const resumed = apiCalls.length;
      await emit(
        "actions.requested",
        {
          turnId: "turn_1",
          stepIndex: stepIndex + 1,
          actions: [
            {
              callId: `tool-${stepIndex}`,
              kind: "tool-call",
              toolName: "bash",
              input: { command: "sleep 10" },
            },
          ],
        },
        pair,
      );
      t.mock.timers.tick(1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const after = apiCalls.slice(resumed);
      assert.ok(
        after.some(
          (call) =>
            call.method === "sendChatAction" && call.body?.action === "typing",
        ),
      );
      const frame = after.find(
        (call) => call.method === "sendRichMessageDraft",
      );
      assert.ok(frame, "continued turn must send a new draft after the answer");
      assert.equal(frame.body?.can_stop, true);
      assert.equal(frame.body?.draft_id, getChatStatus("92:")?.draftId);
      assert.notEqual(frame.body?.draft_id, previousDraftId);
      assert.equal(getChatStatus("92:")?.turnId, "turn_1");
      const typing = apiCalls.filter(
        (call) => call.method === "sendChatAction",
      ).length;
      t.mock.timers.tick(4_500);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(
        apiCalls.filter((call) => call.method === "sendChatAction").length >
          typing,
      );
    }
    await emit(
      "message.completed",
      { turnId: "turn_1", stepIndex: 3, message: "Done", finishReason: "stop" },
      pair,
    );
    const completed = apiCalls.length;
    t.mock.timers.tick(9_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(apiCalls.length, completed);
  } finally {
    await emit("turn.cancelled", { turnId: "turn_1" }, pair);
  }
});

function startTurn(chatId: string, sessionId: string) {
  setChatStatus(chatKeyOf(chatId), {
    status: "running",
    sessionId,
    turnId: "turn_1",
    draftId: 41,
  });
}

test("channel wire redacts draft and one progress message, closes before separate Outbox reply", async (t) => {
  apiCalls.length = 0;
  telegramReply = () => null;
  setChatStatus("9:", {
    status: "idle",
    sessionId: null,
    turnId: null,
    resetAt: null,
  });
  let turnNow = Date.now();
  t.mock.method(Date, "now", () => turnNow);
  const pair = { chatId: "9", sessionId: "wire-1" };
  await emit("turn.started", { turnId: "turn_1" }, pair);
  await pause();
  assert.ok(draftCalls()[0].signal instanceof AbortSignal);
  assert.ok(
    apiCalls.find((call) => call.method === "sendChatAction")?.signal instanceof
      AbortSignal,
  );
  const draftId = getChatStatus("9:")?.draftId;
  assert.equal(typeof draftId, "number");
  assert.ok(Number(draftId) > 0);
  assert.deepEqual(draftCalls()[0].body, {
    chat_id: "9",
    draft_id: draftId,
    rich_message: { markdown: "<tg-thinking>Thinking…</tg-thinking>" },
    can_stop: true,
  });
  const key = "sk-ant-api03-" + "T".repeat(60);
  await emit(
    "message.appended",
    { turnId: "turn_1", stepIndex: 0, messageDelta: "hello " + key },
    pair,
  );
  await pause(1000);
  assert.doesNotMatch(draftCalls().map(richText).join(""), /sk-ant/u);
  turnNow += 11_000;
  await emit(
    "message.completed",
    {
      turnId: "turn_1",
      stepIndex: 0,
      message: "hello " + key,
      finishReason: "tool-calls",
    },
    pair,
  );
  const progressCalls = () =>
    apiCalls.filter((call) => call.method === "sendMessage");
  assert.equal(progressCalls().length, 1);
  assert.match(String(progressCalls()[0].body?.text), /hello.*REDACTED/u);
  assert.doesNotMatch(String(progressCalls()[0].body?.text), /sk-ant/u);
  await emit(
    "message.completed",
    {
      turnId: "turn_1",
      stepIndex: 0,
      message: "Repeated progress " + key,
      finishReason: "tool-calls",
    },
    pair,
  );
  assert.equal(progressCalls().length, 1);
  await emit(
    "actions.requested",
    {
      turnId: "turn_1",
      stepIndex: 0,
      actions: [
        {
          callId: "a",
          kind: "tool-call",
          toolName: "bash",
          input: { command: key + " <script>`" },
        },
      ],
    },
    pair,
  );
  await pause(1000);
  assert.match(richText(draftCalls().at(-1)!), /REDACTED/u);
  assert.doesNotMatch(richText(draftCalls().at(-1)!), /sk-ant/u);
  const gates = traceEvents().filter(
    (e) =>
      e.kind === "gate" &&
      e.name === "outbound" &&
      e.turn === "turn_1" &&
      e.session === "wire-1",
  );
  assert.equal(
    gates.length,
    2,
    "one flagged draft event and one clean Outbox delivery",
  );
  assert.equal(
    gates.filter((event) => (event.data as { clean: boolean }).clean === false)
      .length,
    1,
  );
  await emit(
    "action.result",
    { turnId: "turn_1", stepIndex: 0, result: { callId: "a" } },
    pair,
  );
  await emit(
    "message.completed",
    {
      turnId: "turn_1",
      stepIndex: 1,
      message: `| Done |
| --- |
| Yes |`,
      finishReason: "stop",
    },
    pair,
  );
  assert.equal(apiCalls.at(-1)?.method, "sendRichMessage");
  assert.equal(
    richText(apiCalls.at(-1)!),
    `| Done |
| --- |
| Yes |`,
  );
  const count = apiCalls.length;
  await pause(1050);
  assert.equal(apiCalls.length, count);
  await emit("turn.cancelled", { turnId: "turn_1" }, pair);
  assert.equal(getChatStatus("9:")?.draftId, undefined);
});

test("progress threshold is measured from turn start; quick tools keep one final reply", async (t) => {
  apiCalls.length = 0;
  const pair = { chatId: "93", sessionId: "quiet-tools" };
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  await emit("turn.started", { turnId: "turn_1" }, pair);
  for (now of [100_000, 109_999, 110_000]) {
    await emit(
      "message.completed",
      {
        turnId: "turn_1",
        stepIndex: 0,
        message: "Fast tool.",
        finishReason: "tool-calls",
      },
      pair,
    );
  }
  assert.equal(apiCalls.filter((c) => c.method === "sendMessage").length, 0);
  assert.equal(getChatStatus("93:")?.progressClaimed, undefined);
  await emit(
    "message.completed",
    {
      turnId: "turn_1",
      stepIndex: 1,
      message: "Fast final.",
      finishReason: "stop",
    },
    pair,
  );
  assert.deepEqual(
    apiCalls.filter((c) => c.method === "sendMessage").map((c) => c.body?.text),
    ["Fast final."],
  );
  await emit("turn.completed", { turnId: "turn_1" }, pair);
  await emit("turn.started", { turnId: "turn_2" }, pair);
  now += 10_001;
  await emit(
    "message.completed",
    {
      turnId: "turn_2",
      stepIndex: 0,
      message: "Slow tool.",
      finishReason: "tool-calls",
    },
    pair,
  );
  assert.equal(getChatStatus("93:")?.progressClaimed, true);
  await emit("turn.completed", { turnId: "turn_2" }, pair);
  assert.equal(getChatStatus("93:")?.progressClaimed, undefined);
  await emit("turn.started", { turnId: "turn_3" }, pair);
  now += 10_001;
  await emit(
    "message.completed",
    {
      turnId: "turn_3",
      stepIndex: 0,
      message: "Another slow tool.",
      finishReason: "tool-calls",
    },
    pair,
  );
  assert.deepEqual(
    apiCalls.filter((c) => c.method === "sendMessage").map((c) => c.body?.text),
    ["Fast final.", "Slow tool.", "Another slow tool."],
  );
  await emit("turn.cancelled", { turnId: "turn_3" }, pair);
});

for (const scope of [
  { chatType: "group", chatId: "-9" },
  { chatType: "supergroup", chatId: "-10", threadId: 3 },
  { chatType: "private", chatId: "9", threadId: 4 },
])
  test(`wire scope ${scope.chatType}/${scope.threadId ?? ""} uses typing only`, async () => {
    apiCalls.length = 0;
    const pair = {
      ...scope,
      sessionId: `scope-${scope.chatId}-${scope.threadId ?? ""}`,
    };
    setChatStatus(chatKeyOf(scope.chatId, scope.threadId), {
      status: "idle",
      sessionId: null,
      turnId: null,
      resetAt: null,
    });
    await emit("turn.started", { turnId: "turn_1" }, pair);
    await emit(
      "message.appended",
      { turnId: "turn_1", stepIndex: 0, messageDelta: "working " },
      pair,
    );
    await pause();
    assert.equal(draftCalls().length, 0);
    assert.equal(
      apiCalls.filter((c) =>
        ["sendMessage", "editMessageText", "sendRichMessage"].includes(
          c.method,
        ),
      ).length,
      0,
    );
    const typing = apiCalls.find((c) => c.method === "sendChatAction");
    assert.ok(typing);
    assert.equal(typing.body?.message_thread_id, scope.threadId);
    await emit("turn.cancelled", { turnId: "turn_1" }, pair);
  });

for (const code of [400, 403, 404])
  test(`wire ${code} on initial draft keeps the final answer`, async () => {
    apiCalls.length = 0;
    telegramReply = (c) =>
      c.method === "sendRichMessageDraft"
        ? Response.json({ ok: false, error_code: code }, { status: code })
        : null;
    setChatStatus("9:", {
      status: "idle",
      sessionId: null,
      turnId: null,
      resetAt: null,
    });
    const pair = { chatId: "9", sessionId: `refused-${code}` };
    await emit("turn.started", { turnId: "turn_1" }, pair);
    await pause();
    await emit(
      "message.completed",
      {
        turnId: "turn_1",
        stepIndex: 0,
        message: `| Answer |
| --- |
| Yes |`,
        finishReason: "stop",
      },
      pair,
    );
    assert.equal(draftCalls().length, 1);
    assert.equal(apiCalls.at(-1)?.method, "sendRichMessage");
    assert.equal(apiCalls.filter((c) => c.method === "sendMessage").length, 0);
    await emit("turn.cancelled", { turnId: "turn_1" }, pair);
    telegramReply = () => null;
  });

test("mounted webhook native stop verifies the secret and pins the cancel request to the draft pair", async () => {
  apiCalls.length = 0;
  telegramReply = () => null;
  startTurn("9", "webhook-native");
  const route = channel.routes.find(
    (r) => r.transport !== "websocket" && r.path === "/eve/v1/telegram",
  );
  assert.ok(route && route.transport !== "websocket");
  const req = (secret: string, id = 41) =>
    new Request("http://localhost/eve/v1/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify({
        update_id: 101,
        stopped_message_generation: {
          chat: { id: 9, type: "private" },
          draft_id: id,
        },
      }),
    });
  assert.equal((await route.handler(req("wrong"), {} as never)).status, 401);
  assert.equal(apiCalls.length, 0);
  assert.equal(
    (await route.handler(req("status-progress-secret"), {} as never)).status,
    200,
  );
  assert.deepEqual(apiCalls[0].body, {
    sessionId: "webhook-native",
    turnId: "turn_1",
  });
  assert.equal(apiCalls[0].method, "cancel");
  setChatStatus("9:", { turnId: "turn-new", draftId: 42 });
  await route.handler(req("status-progress-secret"), {} as never);
  assert.equal(apiCalls.length, 1);
  setChatStatus("9:", {
    status: "idle",
    sessionId: null,
    turnId: null,
    draftId: null,
  });
});

test("resumed workflow creates a fresh CAS draft id lazily from its first event", async () => {
  apiCalls.length = 0;
  startTurn("9", "resumed");
  await emit(
    "message.appended",
    { turnId: "turn_1", stepIndex: 3, messageDelta: "resumed " },
    { chatId: "9", sessionId: "resumed" },
  );
  await pause();
  assert.equal(draftCalls().length, 1);
  assert.ok(Number(draftCalls()[0].body?.draft_id) > 0);
  assert.equal(draftCalls()[0].body?.draft_id, getChatStatus("9:")?.draftId);
  assert.equal(richText(draftCalls()[0]), "resumed");
  await emit(
    "turn.cancelled",
    { turnId: "turn_1" },
    { chatId: "9", sessionId: "resumed" },
  );
});

test("wire final waits for draft retry_after before Outbox", async () => {
  apiCalls.length = 0;
  let refusedAt = 0;
  telegramReply = (c) => {
    if (c.method === "sendRichMessageDraft") {
      refusedAt = Date.now();
      return Response.json(
        { ok: false, error_code: 429, parameters: { retry_after: 1 } },
        { status: 429 },
      );
    }
    return null;
  };
  setChatStatus("9:", {
    status: "idle",
    sessionId: null,
    turnId: null,
    resetAt: null,
  });
  const pair = { chatId: "9", sessionId: "wire-429" };
  await emit("turn.started", { turnId: "turn_1" }, pair);
  await pause();
  assert.ok(refusedAt > 0);
  await emit(
    "message.completed",
    { turnId: "turn_1", stepIndex: 0, message: "final", finishReason: "stop" },
    pair,
  );
  assert.ok(Date.now() >= refusedAt + 1000);
  assert.equal(apiCalls.at(-1)?.method, "sendMessage");
  await emit("turn.completed", { turnId: "turn_1" }, pair);
  telegramReply = () => null;
});

test("wire final waits for in-flight draft; its late success schedules no later frame", async () => {
  apiCalls.length = 0;
  let release!: (res: Response) => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  telegramReply = (c) => (c.method === "sendRichMessageDraft" ? held : null);
  setChatStatus("9:", {
    status: "idle",
    sessionId: null,
    turnId: null,
    resetAt: null,
  });
  const pair = { chatId: "9", sessionId: "wire-held" };
  await emit("turn.started", { turnId: "turn_1" }, pair);
  await pause();
  const final = emit(
    "message.completed",
    { turnId: "turn_1", stepIndex: 0, message: "final", finishReason: "stop" },
    pair,
  );
  await pause();
  assert.equal(apiCalls.filter((c) => c.method === "sendMessage").length, 0);
  release(Response.json({ ok: true, result: true }));
  await final;
  const count = apiCalls.length;
  await pause(1050);
  assert.equal(apiCalls.length, count);
  await emit("turn.completed", { turnId: "turn_1" }, pair);
  telegramReply = () => null;
});

test("a reset-refused turn.started sends typing with zero draft or temporary messages", async () => {
  apiCalls.length = 0;
  setChatStatus("9:", {
    status: "idle",
    sessionId: null,
    turnId: null,
    resetAt: 1,
  });
  await emit(
    "turn.started",
    { turnId: "turn_1" },
    { chatId: "9", sessionId: "reset-refused" },
  );
  await pause();
  assert.equal(draftCalls().length, 0);
  assert.deepEqual(
    apiCalls.map((c) => c.method),
    ["sendChatAction"],
  );
  setChatStatus("9:", { resetAt: null });
});

test("a silent final closes the stream even when Outbox has no text", async () => {
  apiCalls.length = 0;
  setChatStatus("9:", {
    status: "idle",
    sessionId: null,
    turnId: null,
    resetAt: null,
  });
  const pair = { chatId: "9", sessionId: "wire-silent" };
  await emit("turn.started", { turnId: "turn_1" }, pair);
  await pause();
  await emit(
    "message.completed",
    {
      turnId: "turn_1",
      stepIndex: 0,
      message: "<!-- iva:silent -->\n",
      finishReason: "stop",
    },
    pair,
  );
  const count = apiCalls.length;
  await pause(1050);
  assert.equal(apiCalls.length, count);
  assert.equal(apiCalls.filter((c) => c.method === "sendMessage").length, 0);
  await emit("turn.completed", { turnId: "turn_1" }, pair);
});
