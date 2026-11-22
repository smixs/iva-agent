/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Проводка канала: текст шага модели перед вызовом инструментов (finishReason "tool-calls")
// обновляет draft и один раз уходит обычным сообщением; финальный ответ идёт отдельно.
// Ход без промежуточного текста сохраняет прежние вызовы Bot API. Двойник — fetch:
// здесь видно тело запроса таким, каким его получает Telegram.
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const { PROGRESS_MIN_TURN_MS, STATUS_EDIT_MIN_MS, closeTelegramDraftTurn } =
  await import("#lib/telegram-draft.ts");

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
  t.mock.timers.tick(PROGRESS_MIN_TURN_MS + 1);
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
  turnNow += PROGRESS_MIN_TURN_MS + 1_000;
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
  for (now of [
    100_000,
    100_000 + PROGRESS_MIN_TURN_MS - 1,
    100_000 + PROGRESS_MIN_TURN_MS,
  ]) {
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
  now += PROGRESS_MIN_TURN_MS + 1;
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
  now += PROGRESS_MIN_TURN_MS + 1;
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

// ── The status message of a long turn: post, edit, delete (specs/ProgressMessage.tla) ──────
const { TURN_FIELDS_CLEARED, progressMessageOf: progressWord } =
  await import("#lib/run-status.ts");

const STATUS_METHODS = [
  "sendMessage",
  "editMessageText",
  "deleteMessage",
  "sendRichMessage",
];
const wireOf = () =>
  apiCalls
    .filter((c) => STATUS_METHODS.includes(c.method))
    .map((c) =>
      c.method === "editMessageText" || c.method === "deleteMessage"
        ? `${c.method}:${String(c.body?.message_id)}`
        : c.method,
    );
// Rendered to nothing by the HTML converter although the draft text is not empty.
const EMPTY_RENDERING = "```\n```";
const callsOf = (method: string) => apiCalls.filter((c) => c.method === method);
const reject = (status: number, description: string, extra = {}) =>
  Response.json(
    { ok: false, error_code: status, description, ...extra },
    { status },
  );

// Один чат, один ход на Date.now двойника: статус-сообщение получает свои номера с 500.
function statusChat(
  t: { mock: { method: (...args: never[]) => unknown } },
  chatId: string,
  extra: {
    threadId?: number;
    chatType?: string;
    onCall?: (call: ApiCall) => Response | Promise<Response> | null;
  } = {},
) {
  const key = chatKeyOf(chatId, extra.threadId);
  let now = 1_000_000;
  (t.mock.method as (o: object, n: string, f: () => number) => void)(
    Date,
    "now",
    () => now,
  );
  let nextId = 500;
  apiCalls.length = 0;
  telegramReply = (call) =>
    extra.onCall?.(call) ??
    (call.method === "sendMessage"
      ? Response.json({
          ok: true,
          result: { message_id: ++nextId, chat: { id: 1, type: "private" } },
        })
      : null);
  setChatStatus(key, {
    status: "idle",
    ...TURN_FIELDS_CLEARED,
    resetAt: null,
    progressMessageId: null,
  });
  const pair = {
    chatId,
    sessionId: `status-${chatId}`,
    ...(extra.threadId === undefined ? {} : { threadId: extra.threadId }),
    ...(extra.chatType === undefined ? {} : { chatType: extra.chatType }),
  };
  const step = (
    turnId: string,
    message: string,
    stepIndex = 0,
    finishReason = "tool-calls",
  ) =>
    emit(
      "message.completed",
      { turnId, stepIndex, message, finishReason },
      pair,
    );
  return {
    key,
    pair,
    step,
    start: (turnId = "turn_1") => emit("turn.started", { turnId }, pair),
    advance: (ms: number) => {
      now += ms;
    },
    // Ход идёт достаточно долго, чтобы первый статус ушёл.
    age: () => {
      now += PROGRESS_MIN_TURN_MS + 1;
    },
    record: () => getChatStatus(key),
    async end() {
      telegramReply = () => null;
      await closeTelegramDraftTurn(pair.sessionId, undefined, 0, true);
    },
  };
}

test("status: post once, throttled edit, final, then delete, always silent", async (t) => {
  const chat = statusChat(t, "201");
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  await chat.step("turn_1", "Step one.");
  assert.deepEqual(callsOf("sendMessage")[0].body, {
    chat_id: "201",
    text: "Step one.",
    parse_mode: "HTML",
    disable_notification: true,
  });
  assert.equal(chat.record()?.progressMessageId, 501);
  assert.equal(chat.record()?.progressClaimed, true);
  await chat.step("turn_1", "Step two.");
  assert.deepEqual(
    wireOf(),
    ["sendMessage"],
    "throttled: skipped, not deferred",
  );
  chat.advance(STATUS_EDIT_MIN_MS);
  await chat.step("turn_1", "Step two.");
  assert.deepEqual(callsOf("editMessageText")[0].body, {
    chat_id: "201",
    message_id: 501,
    text: "Step two.",
    parse_mode: "HTML",
  });
  await chat.step("turn_1", "Done.", 1, "stop");
  assert.deepEqual(wireOf(), [
    "sendMessage",
    "editMessageText:501",
    "sendMessage",
  ]);
  await emit("turn.completed", { turnId: "turn_1" }, chat.pair);
  assert.deepEqual(wireOf(), [
    "sendMessage",
    "editMessageText:501",
    "sendMessage",
    "deleteMessage:501",
  ]);
  assert.equal(chat.record()?.progressMessageId, undefined);
  assert.equal(chat.record()?.progressClaimed, undefined);
  assert.deepEqual(callsOf("deleteMessage")[0].body, {
    chat_id: "201",
    message_id: 501,
  });
});

test("status: the same text is not edited", async (t) => {
  const chat = statusChat(t, "202");
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  await chat.step("turn_1", "Same.");
  chat.advance(STATUS_EDIT_MIN_MS * 2);
  await chat.step("turn_1", "Same.");
  assert.deepEqual(wireOf(), ["sendMessage"]);
  await emit("turn.cancelled", { turnId: "turn_1" }, chat.pair);
});

test("status: Stop deletes the message", async (t) => {
  const chat = statusChat(t, "203");
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  await chat.step("turn_1", "Working.");
  await emit("turn.cancelled", { turnId: "turn_1" }, chat.pair);
  assert.deepEqual(wireOf(), ["sendMessage", "deleteMessage:501"]);
  assert.equal(chat.record()?.progressMessageId, undefined);
});

test("status: steer, the new turn.started before the old turn.cancelled", async (t) => {
  const chat = statusChat(t, "204");
  t.after(() => chat.end());
  await chat.start("turn_1");
  chat.age();
  await chat.step("turn_1", "Old step.");
  await chat.start("turn_2");
  assert.deepEqual(
    wireOf(),
    ["sendMessage"],
    "the old status is still shown at the top of turn.started",
  );
  assert.equal(progressWord(chat.record()), "stale");
  await emit("turn.cancelled", { turnId: "turn_1" }, chat.pair);
  assert.deepEqual(wireOf(), ["sendMessage", "deleteMessage:501"]);
  chat.age();
  await chat.step("turn_2", "New step.");
  assert.deepEqual(wireOf(), [
    "sendMessage",
    "deleteMessage:501",
    "sendMessage",
  ]);
  assert.equal(chat.record()?.progressMessageId, 502);
  await emit("turn.cancelled", { turnId: "turn_2" }, chat.pair);
  assert.deepEqual(
    callsOf("deleteMessage").map((c) => c.body?.message_id),
    [501, 502],
  );
});

test("status: steer, the old turn.cancelled before the new turn.started", async (t) => {
  const chat = statusChat(t, "205");
  t.after(() => chat.end());
  await chat.start("turn_1");
  chat.age();
  await chat.step("turn_1", "Old step.");
  await emit("turn.cancelled", { turnId: "turn_1" }, chat.pair);
  await chat.start("turn_2");
  assert.deepEqual(
    wireOf(),
    ["sendMessage", "deleteMessage:501"],
    "the second finds none",
  );
  await emit("turn.cancelled", { turnId: "turn_2" }, chat.pair);
  assert.equal(callsOf("deleteMessage").length, 1);
});

test("status: an old post still in flight loses its CAS and deletes its own message", async (t) => {
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const chat = statusChat(t, "206", {
    onCall: (call) => (call.method === "sendMessage" ? held : null),
  });
  t.after(() => chat.end());
  await chat.start("turn_1");
  chat.age();
  const old = chat.step("turn_1", "Slow post.");
  await pause();
  await chat.start("turn_2");
  release(
    Response.json({
      ok: true,
      result: { message_id: 601, chat: { id: 1, type: "private" } },
    }),
  );
  await old;
  await pause();
  assert.deepEqual(wireOf(), ["sendMessage", "deleteMessage:601"]);
  assert.equal(chat.record()?.progressMessageId, undefined);
});

test("status: failed turn and failed session delete the message before the notice", async (t) => {
  for (const event of ["turn.failed", "session.failed"] as const) {
    const chat = statusChat(t, event === "turn.failed" ? "207" : "208");
    await chat.start();
    chat.age();
    await chat.step("turn_1", "Working.");
    await emit(
      event,
      {
        code: "MODEL_CALL_FAILED",
        details: { statusCode: 500 },
        message: "boom",
        sequence: 0,
        turnId: "turn_1",
        sessionId: chat.pair.sessionId,
      },
      chat.pair,
    );
    const wire = wireOf();
    assert.equal(wire[0], "sendMessage");
    assert.equal(wire[1], "deleteMessage:501", event);
    assert.equal(chat.record()?.progressMessageId, undefined);
    await chat.end();
  }
});

test("status: a final that cannot be delivered still removes the status; a failed delete waits for the next turn", async (t) => {
  let down = false;
  const chat = statusChat(t, "209", {
    onCall: (call) => {
      if (!down) return null;
      return call.method === "sendMessage" || call.method === "deleteMessage"
        ? reject(500, "Internal Server Error")
        : null;
    },
  });
  t.after(() => chat.end());
  await chat.start("turn_1");
  chat.age();
  await chat.step("turn_1", "Working.");
  down = true;
  await chat.step("turn_1", "Final that fails.", 1, "stop");
  await emit("turn.completed", { turnId: "turn_1" }, chat.pair);
  assert.equal(
    chat.record()?.progressMessageId,
    501,
    "Telegram is down: the id stays",
  );
  assert.equal(progressWord(chat.record()), "stale");
  down = false;
  const before = wireOf().length;
  await chat.start("turn_2");
  assert.equal(
    wireOf()[before],
    "deleteMessage:501",
    "the next turn.started removes it",
  );
  assert.equal(chat.record()?.progressMessageId, undefined);
});

test("status: an edit refused as gone keeps the id, stops editing, and the end-of-turn delete decides", async (t) => {
  const chat = statusChat(t, "210", {
    onCall: (call) =>
      call.method === "editMessageText"
        ? reject(400, "Bad Request: message is empty")
        : null,
  });
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  await chat.step("turn_1", "One.");
  chat.advance(STATUS_EDIT_MIN_MS);
  await chat.step("turn_1", "Two.");
  assert.equal(
    chat.record()?.progressMessageId,
    501,
    "the message may still exist: the id stays",
  );
  assert.equal(chat.record()?.progressClaimed, true, "never resend this turn");
  chat.advance(STATUS_EDIT_MIN_MS);
  await chat.step("turn_1", "Three.");
  assert.equal(callsOf("editMessageText").length, 1, "no further edits");
  await emit("turn.cancelled", { turnId: "turn_1" }, chat.pair);
  assert.deepEqual(wireOf(), [
    "sendMessage",
    "editMessageText:501",
    "deleteMessage:501",
  ]);
  assert.equal(
    chat.record()?.progressMessageId,
    undefined,
    "the delete's own answer clears it",
  );
});

test("status: after an edit refused as gone, a delete that fails keeps the id for the next turn", async (t) => {
  let limited = true;
  const chat = statusChat(t, "238", {
    onCall: (call) =>
      call.method === "editMessageText"
        ? reject(403, "Forbidden")
        : call.method === "deleteMessage" && limited
          ? reject(500, "Internal Server Error")
          : null,
  });
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  await chat.step("turn_1", "One.");
  chat.advance(STATUS_EDIT_MIN_MS);
  await chat.step("turn_1", "Two.");
  await emit("turn.cancelled", { turnId: "turn_1" }, chat.pair);
  assert.equal(chat.record()?.progressMessageId, 501);
  limited = false;
  await chat.start("turn_2");
  assert.equal(chat.record()?.progressMessageId, undefined);
  assert.equal(callsOf("deleteMessage").length, 2);
});

test("status: a text that renders empty is never sent as an edit", async (t) => {
  const chat = statusChat(t, "239");
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  await chat.step("turn_1", "One.");
  chat.advance(STATUS_EDIT_MIN_MS);
  await chat.step("turn_1", EMPTY_RENDERING);
  assert.equal(callsOf("editMessageText").length, 0);
  assert.equal(chat.record()?.progressMessageId, 501);
  await emit("turn.cancelled", { turnId: "turn_1" }, chat.pair);
});

test("status: an edit refused with 429 pauses edits and never waits", async (t) => {
  const chat = statusChat(t, "211", {
    onCall: (call) =>
      call.method === "editMessageText"
        ? reject(429, "Too Many Requests: retry after 40", {
            parameters: { retry_after: 40 },
          })
        : null,
  });
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  await chat.step("turn_1", "One.");
  chat.advance(STATUS_EDIT_MIN_MS);
  const started = performance.now();
  await chat.step("turn_1", "Two.");
  assert.ok(performance.now() - started < 1000, "no sleeping");
  for (const ms of [
    STATUS_EDIT_MIN_MS,
    STATUS_EDIT_MIN_MS,
    STATUS_EDIT_MIN_MS,
  ]) {
    chat.advance(ms);
    await chat.step("turn_1", `Later ${ms}.`);
  }
  assert.equal(callsOf("editMessageText").length, 1, "paused for 40s");
  chat.advance(STATUS_EDIT_MIN_MS * 2);
  await chat.step("turn_1", "After the pause.");
  assert.equal(callsOf("editMessageText").length, 2);
  assert.equal(
    chat.record()?.progressMessageId,
    501,
    "a 429 never clears the id",
  );
});

test("status: a delete refused with 429 keeps the id, and the next turn deletes it before any new claim", async (t) => {
  let limited = true;
  const chat = statusChat(t, "212", {
    onCall: (call) =>
      call.method === "deleteMessage" && limited
        ? reject(429, "Too Many Requests", { parameters: { retry_after: 3 } })
        : null,
  });
  t.after(() => chat.end());
  await chat.start("turn_1");
  chat.age();
  await chat.step("turn_1", "Working.");
  await emit("turn.completed", { turnId: "turn_1" }, chat.pair);
  assert.equal(chat.record()?.progressMessageId, 501);
  limited = false;
  await chat.start("turn_2");
  chat.age();
  await chat.step("turn_2", "Second turn.");
  assert.deepEqual(wireOf(), [
    "sendMessage",
    "deleteMessage:501",
    "deleteMessage:501",
    "sendMessage",
  ]);
  assert.equal(chat.record()?.progressMessageId, 502);
});

test("status: a delete refused with 400 counts as gone and clears the id", async (t) => {
  const chat = statusChat(t, "213", {
    onCall: (call) =>
      call.method === "deleteMessage"
        ? reject(400, "Bad Request: message can't be deleted")
        : null,
  });
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  await chat.step("turn_1", "Working.");
  await emit("turn.cancelled", { turnId: "turn_1" }, chat.pair);
  assert.equal(chat.record()?.progressMessageId, undefined);
});

test("status: after a restart the recreated stream edits the recorded id and the message is deleted at the end", async (t) => {
  const chat = statusChat(t, "214");
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  await chat.step("turn_1", "Before restart.");
  // A new process forgets every stream; the record stays.
  await closeTelegramDraftTurn(chat.pair.sessionId, undefined, 0, true);
  await emit(
    "message.appended",
    { turnId: "turn_1", stepIndex: 1, messageDelta: "after " },
    chat.pair,
  );
  chat.advance(STATUS_EDIT_MIN_MS);
  await chat.step("turn_1", "After restart.", 1);
  assert.deepEqual(wireOf(), ["sendMessage", "editMessageText:501"]);
  await emit("turn.completed", { turnId: "turn_1" }, chat.pair);
  assert.deepEqual(wireOf().at(-1), "deleteMessage:501");
});

test("status: a record that is claimed without an id sends nothing and deletes nothing", async (t) => {
  const chat = statusChat(t, "215");
  t.after(() => chat.end());
  await chat.start();
  setChatStatus(chat.key, { progressClaimed: true });
  chat.age();
  await chat.step("turn_1", "No id.");
  chat.advance(STATUS_EDIT_MIN_MS);
  await chat.step("turn_1", "Still no id.");
  await emit("turn.completed", { turnId: "turn_1" }, chat.pair);
  assert.deepEqual(wireOf(), []);
});

test("status: a sendMessage reply without message_id gives no edits and no delete", async (t) => {
  const chat = statusChat(t, "216", {
    onCall: (call) =>
      call.method === "sendMessage"
        ? Response.json({ ok: true, result: {} })
        : null,
  });
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  await chat.step("turn_1", "One.");
  chat.advance(STATUS_EDIT_MIN_MS);
  await chat.step("turn_1", "Two.");
  assert.equal(chat.record()?.progressClaimed, true);
  assert.equal(chat.record()?.progressMessageId, undefined);
  await emit("turn.completed", { turnId: "turn_1" }, chat.pair);
  assert.deepEqual(wireOf(), ["sendMessage"]);
});

test("status: a reset or a reap in mid-turn leaves the id, and the next turn.started removes it before a new claim", async (t) => {
  const chat = statusChat(t, "217");
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  await chat.step("turn_1", "Working.");
  // The Bridge frees the chat from another process: the turn fields go, the mark stays.
  setChatStatus(chat.key, {
    status: "idle",
    ...TURN_FIELDS_CLEARED,
    resetAt: Date.now(),
  });
  assert.equal(chat.record()?.progressMessageId, 501);
  assert.equal(progressWord(chat.record()), "stale");
  setChatStatus(chat.key, { resetAt: null });
  await chat.start("turn_2");
  assert.equal(wireOf()[1], "deleteMessage:501");
  assert.equal(chat.record()?.progressMessageId, undefined);
  chat.age();
  await chat.step("turn_2", "New turn.");
  assert.deepEqual(wireOf(), [
    "sendMessage",
    "deleteMessage:501",
    "sendMessage",
  ]);
});

for (const scope of [
  { chatType: "group", chatId: "-218", threadId: undefined },
  { chatType: "supergroup", chatId: "-219", threadId: 5 },
  { chatType: "private", chatId: "220", threadId: 6 },
])
  test(`status: ${scope.chatType}/${scope.threadId ?? ""} has the same lifecycle, with message_thread_id on the post`, async (t) => {
    const chat = statusChat(t, scope.chatId, scope);
    t.after(() => chat.end());
    await chat.start();
    chat.age();
    await chat.step("turn_1", "Working.");
    assert.equal(
      callsOf("sendMessage")[0].body?.message_thread_id,
      scope.threadId,
    );
    assert.equal(callsOf("sendMessage")[0].body?.disable_notification, true);
    assert.equal(draftCalls().length, 0, "the draft stays private-only");
    await emit("turn.completed", { turnId: "turn_1" }, chat.pair);
    assert.deepEqual(wireOf(), ["sendMessage", "deleteMessage:501"]);
  });

test("status: rich text stays one HTML message, never rich, always silent", async (t) => {
  const chat = statusChat(t, "221");
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  await chat.step("turn_1", "| a |\n| - |\n| b |\n\n<tg-button>Go</tg-button>");
  assert.deepEqual(
    apiCalls
      .filter(
        (c) =>
          c.method.startsWith("send") &&
          c.method !== "sendChatAction" &&
          c.method !== "sendRichMessageDraft",
      )
      .map((c) => c.method),
    ["sendMessage"],
  );
  assert.equal(callsOf("sendMessage")[0].body?.parse_mode, "HTML");
  assert.equal(callsOf("sendMessage")[0].body?.disable_notification, true);
  await emit("turn.cancelled", { turnId: "turn_1" }, chat.pair);
});

test("status: a secret in the step text reaches neither the post nor the edit", async (t) => {
  const chat = statusChat(t, "222");
  t.after(() => chat.end());
  const key = "sk-ant-api03-" + "Q".repeat(60);
  await chat.start();
  chat.age();
  await chat.step("turn_1", `first ${key}`);
  chat.advance(STATUS_EDIT_MIN_MS);
  await chat.step("turn_1", `second ${key}`);
  const texts = [...callsOf("sendMessage"), ...callsOf("editMessageText")].map(
    (c) => String(c.body?.text),
  );
  assert.equal(texts.length, 2);
  for (const text of texts) assert.doesNotMatch(text, /sk-ant/u);
  await emit("turn.cancelled", { turnId: "turn_1" }, chat.pair);
});

// ── The Trace: a status call is not the turn's delivery ───────────────────────────────────
const { parseTraceLine, stitchTurns, turnOutcome } =
  await import("./cli/trace.ts");
const { failureCause } = await import("./lib/turn-failures.ts");

function outcomeOf(sessionId: string, turnId: string) {
  const lines = traceEvents()
    .filter((event) => event.session === sessionId)
    .map((event, index) => parseTraceLine(JSON.stringify(event), index))
    .filter((line) => line !== null);
  const turn = stitchTurns(lines).find(
    (candidate) => candidate.turnId === turnId,
  );
  return {
    events: lines,
    outcome: turn ? turnOutcome(turn) : "none",
  };
}

test("status: skipped status calls write no Outbox event, and the turn does not read as delivered", async (t) => {
  const chat = statusChat(t, "240");
  t.after(() => chat.end());
  await chat.start();
  await chat.step("turn_1", "Too early."); // under the threshold
  chat.age();
  await chat.step("turn_1", "One."); // the post
  await chat.step("turn_1", "Two."); // throttled
  chat.advance(STATUS_EDIT_MIN_MS);
  await chat.step("turn_1", "One."); // the same text as the post
  const { events, outcome } = outcomeOf(chat.pair.sessionId, "turn_1");
  assert.deepEqual(
    events.filter((e) => e.kind === "outbox"),
    [],
    "no outbox event for a status call",
  );
  assert.deepEqual(
    events.filter((e) => e.kind === "status").map((e) => e.name),
    ["post"],
    "only the request that was sent is an event",
  );
  assert.equal(outcome, "open", "an unanswered turn is not delivered");
});

for (const [name, answer] of [
  [
    "429",
    () => reject(429, "Too Many Requests", { parameters: { retry_after: 1 } }),
  ],
  ["gone", () => reject(400, "Bad Request: message to edit not found")],
  ["5xx", () => reject(502, "Bad Gateway")],
] as const)
  test(`status: an edit that got ${name} does not fail the turn whose final was delivered`, async (t) => {
    const chat = statusChat(
      t,
      `24${name.length}${name === "429" ? 1 : name === "gone" ? 2 : 3}`,
      {
        onCall: (call) => (call.method === "editMessageText" ? answer() : null),
      },
    );
    t.after(() => chat.end());
    await chat.start();
    chat.age();
    await chat.step("turn_1", "One.");
    chat.advance(STATUS_EDIT_MIN_MS);
    await chat.step("turn_1", "Two.");
    await chat.step("turn_1", "Done.", 1, "stop");
    await emit("turn.completed", { turnId: "turn_1" }, chat.pair);
    const { events, outcome } = outcomeOf(chat.pair.sessionId, "turn_1");
    const edit = events.find((e) => e.kind === "status" && e.name === "edit");
    assert.equal(
      edit?.data.ok,
      false,
      "the failed edit stays visible in the trace",
    );
    assert.equal(outcome, "delivered");
    for (const event of events)
      assert.equal(failureCause(event), null, `${event.kind}.${event.name}`);
  });

test("status: a group's final waits for the flood window of a status edit", async (t) => {
  let refusedAt = 0;
  let finalAt = 0;
  let sends = 0;
  const chat = statusChat(t, "-250", {
    chatType: "group",
    onCall: (call) => {
      if (call.method === "editMessageText") {
        refusedAt = performance.now();
        return reject(429, "Too Many Requests", {
          parameters: { retry_after: 1 },
        });
      }
      if (call.method === "sendMessage" && ++sends === 2)
        finalAt = performance.now();
      return null;
    },
  });
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  await chat.step("turn_1", "One.");
  chat.advance(STATUS_EDIT_MIN_MS);
  await chat.step("turn_1", "Two.");
  assert.ok(refusedAt > 0);
  await chat.step("turn_1", "Done.", 1, "stop");
  assert.ok(finalAt > 0, "the final went out");
  assert.ok(
    finalAt - refusedAt >= 900,
    `the final waited retry_after (${Math.round(finalAt - refusedAt)} ms)`,
  );
  await emit("turn.completed", { turnId: "turn_1" }, chat.pair);
});

test("status: an old post that lost its CAS and could not delete its message leaves the id as a stale mark", async (t) => {
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let deletes = 0;
  const chat = statusChat(t, "251", {
    onCall: (call) =>
      call.method === "sendMessage"
        ? held
        : call.method === "deleteMessage" && ++deletes === 1
          ? reject(429, "Too Many Requests", { parameters: { retry_after: 1 } })
          : null,
  });
  t.after(() => chat.end());
  await chat.start("turn_1");
  chat.age();
  const old = chat.step("turn_1", "Slow post.");
  await pause();
  await chat.start("turn_2");
  release(
    Response.json({
      ok: true,
      result: { message_id: 601, chat: { id: 1, type: "private" } },
    }),
  );
  await old;
  await pause();
  assert.equal(chat.record()?.progressMessageId, 601, "kept for the deleter");
  assert.equal(progressWord(chat.record()), "stale");
  await emit("turn.cancelled", { turnId: "turn_2" }, chat.pair);
  assert.equal(chat.record()?.progressMessageId, undefined);
  assert.deepEqual(
    callsOf("deleteMessage").map((c) => c.body?.message_id),
    [601, 601],
  );
});

test("status: a failed frame delete does not touch a record that already holds another claim", async (t) => {
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const chat = statusChat(t, "252", {
    onCall: (call) =>
      call.method === "sendMessage" && !callsOf("sendMessage").slice(1).length
        ? held
        : call.method === "deleteMessage"
          ? reject(500, "Internal Server Error")
          : null,
  });
  t.after(() => chat.end());
  await chat.start("turn_1");
  chat.age();
  const old = chat.step("turn_1", "Slow post.");
  await pause();
  await chat.start("turn_2");
  chat.age();
  const record = chat.record();
  setChatStatus(chat.key, { progressClaimed: true });
  release(
    Response.json({
      ok: true,
      result: { message_id: 602, chat: { id: 1, type: "private" } },
    }),
  );
  await old;
  await pause();
  assert.equal(record?.progressMessageId, undefined);
  assert.equal(chat.record()?.progressMessageId, undefined, "no place for it");
  assert.equal(chat.record()?.progressClaimed, true, "the claim is untouched");
});

test("status: turn.started gives the retire-at-start delete three seconds and leaves the id stale", async (t) => {
  let hang = false;
  const chat = statusChat(t, "253", {
    onCall: (call) =>
      hang && call.method === "deleteMessage"
        ? new Promise<Response>(() => {})
        : null,
  });
  t.after(() => chat.end());
  await chat.start("turn_1");
  chat.age();
  await chat.step("turn_1", "Working.");
  setChatStatus(chat.key, { status: "idle", ...TURN_FIELDS_CLEARED });
  hang = true;
  const startedAt = performance.now();
  await chat.start("turn_2");
  const took = performance.now() - startedAt;
  assert.ok(
    took >= 2_500 && took < 5_000,
    `bounded at 3 s (${Math.round(took)} ms)`,
  );
  assert.equal(
    progressWord(chat.record()),
    "stale",
    "left for the next terminal event",
  );
  assert.equal(chat.record()?.status, "running");
});

test("status: one edit step holds the handler for one deadline, the plain retry included", async () => {
  const { statusTransport } = (await import(
    telegramTestModule
  )) as typeof import("../agent/channels/telegram.ts");
  const { editStatusThroughOutbox } = await import("#lib/outbox.ts");
  let calls = 0;
  const tg = {
    chatId: "254",
    messageThreadId: undefined,
    request: () => {
      calls++;
      return calls === 1
        ? new Promise<{ ok: boolean; status: number; body: unknown }>(
            (resolve) =>
              setTimeout(
                () =>
                  resolve({
                    ok: false,
                    status: 400,
                    body: {
                      ok: false,
                      error_code: 400,
                      description: "Bad Request: can't parse entities",
                    },
                  }),
                150,
              ),
          )
        : new Promise<{ ok: boolean; status: number; body: unknown }>(() => {});
    },
  };
  const startedAt = performance.now();
  const ack = await editStatusThroughOutbox(
    5,
    "text",
    statusTransport(tg, 300),
  );
  const took = performance.now() - startedAt;
  assert.equal(calls, 2, "the plain retry was made");
  assert.equal(ack.kind, "error");
  assert.ok(
    took < 400,
    `one deadline for both requests (${Math.round(took)} ms)`,
  );
});

test("status: an edit that got a 5xx is not followed by another attempt for 50 s while steps keep arriving", async (t) => {
  const chat = statusChat(t, "260", {
    onCall: (call) =>
      call.method === "editMessageText" ? reject(502, "Bad Gateway") : null,
  });
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  await chat.step("turn_1", "One.");
  chat.advance(STATUS_EDIT_MIN_MS);
  await chat.step("turn_1", "Two.");
  const failed = callsOf("editMessageText").length;
  assert.ok(failed >= 1, "the first edit was attempted");
  for (let i = 1; i <= 4; i++) {
    chat.advance(STATUS_EDIT_MIN_MS);
    await chat.step("turn_1", `Later ${i}.`);
    assert.equal(
      callsOf("editMessageText").length,
      failed,
      `no edit ${(i * STATUS_EDIT_MIN_MS) / 1000} s after the failure`,
    );
  }
  chat.advance(STATUS_EDIT_MIN_MS);
  await chat.step("turn_1", "After the backoff.");
  assert.ok(callsOf("editMessageText").length > failed, "edits resume at 50 s");
});

test("status: a 429 on the status post makes the final wait retry_after", async (t) => {
  let refusedAt = 0;
  let finalAt = 0;
  let sends = 0;
  const chat = statusChat(t, "-261", {
    chatType: "group",
    onCall: (call) => {
      if (call.method !== "sendMessage") return null;
      if (++sends === 1) {
        refusedAt = performance.now();
        return reject(429, "Too Many Requests", {
          parameters: { retry_after: 1 },
        });
      }
      if (sends === 2) finalAt = performance.now();
      return null;
    },
  });
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  await chat.step("turn_1", "One.");
  assert.ok(refusedAt > 0, "the post was refused");
  await chat.step("turn_1", "Done.", 1, "stop");
  assert.ok(finalAt > 0, "the final went out");
  assert.ok(
    finalAt - refusedAt >= 900,
    `the final waited retry_after (${Math.round(finalAt - refusedAt)} ms)`,
  );
  await emit("turn.completed", { turnId: "turn_1" }, chat.pair);
});

test("status: a claimProgress failure writes no status trace event", async (t) => {
  const chat = statusChat(t, "262");
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  const dir = join(dataDir, "run-status.d");
  chmodSync(dir, 0o500); // the lock directory cannot be created: the claim throws
  try {
    await chat.step("turn_1", "One.");
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(callsOf("sendMessage").length, 0, "nothing was sent");
  const { events } = outcomeOf(chat.pair.sessionId, "turn_1");
  assert.deepEqual(
    events.filter((e) => e.kind === "status"),
    [],
    "no event for a call that sent nothing",
  );
});

test("status: closing a chat with a hanging status post waits one deadline, not two", async (t) => {
  let sends = 0;
  const chat = statusChat(t, "-263", {
    chatType: "group",
    onCall: (call) =>
      call.method === "sendMessage" && ++sends === 1
        ? new Promise<Response>(() => {})
        : null,
  });
  t.after(() => chat.end());
  await chat.start();
  chat.age();
  void chat.step("turn_1", "Hangs.");
  await pause();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let done = false;
  const final = chat
    .step("turn_1", "Done.", 1, "stop")
    .then(() => (done = true));
  let ticks = 0;
  while (!done && ticks < 40) {
    t.mock.timers.tick(1_000);
    ticks++;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await final;
  assert.ok(
    ticks >= 9 && ticks <= 12,
    `one 10 s wait (${ticks} s of fake clock)`,
  );
});
