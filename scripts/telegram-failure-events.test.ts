/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "iva-telegram-failures-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_ALLOWED_USER_IDS = "9";
process.env.TELEGRAM_BOT_TOKEN = "failure-test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "failure-test-secret";
process.env.IVA_PORT = "8723";
delete process.env.ASSISTANT_HOST; // адрес самовызова cancel-роута должен быть предсказуем

type ApiBody = Record<string, unknown> & {
  chat_id?: unknown;
  message_id?: unknown;
  text?: unknown;
};
type ApiCall = { method: string | undefined; body: ApiBody | undefined };
type HeldSend = {
  chatId: string;
  release: Promise<void>;
  startedResolve: () => void;
};
type EventOptions = {
  chatId: string;
  sessionId: string;
  chatType?: string;
};
type ChannelEventHandler = (
  data: Record<string, unknown>,
  context: unknown,
) => void | Promise<void>;
type FailureAdapter = {
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
  "turn.failed": (
    data: Record<string, unknown>,
    context: unknown,
  ) => void | Promise<void>;
  "session.failed": (
    data: Record<string, unknown>,
    context: unknown,
  ) => void | Promise<void>;
  "session.waiting": (
    data: Record<string, unknown>,
    context: unknown,
  ) => void | Promise<void>;
  "turn.started": ChannelEventHandler;
  "input.resolved": ChannelEventHandler;
  "actions.requested": ChannelEventHandler;
  "action.partial": ChannelEventHandler;
  "action.result": ChannelEventHandler;
  "message.appended": ChannelEventHandler;
  "message.completed": ChannelEventHandler;
};

const apiCalls: ApiCall[] = [];
let heldSend: HeldSend | undefined;
// Ответ cancel-роута для следующего теста: обычно ход действительно отменяется.
const cancelRouteStatus: "accepted" | "no_active_turn" = "accepted";
globalThis.fetch = async (url, init = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve the original mock's exact String coercion.
  const requestUrl = String(url);
  const method = new URL(requestUrl).pathname.split("/").at(-1);
  const body: ApiBody | undefined = init.body
    ? (JSON.parse(
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve the original mock's exact String coercion.
        String(init.body),
      ) as ApiBody)
    : undefined;
  apiCalls.push({ method, body });
  // Самовызов cancel-роута каналом (кнопка ⏹ Стоп в webhook-режиме) — не Bot API.
  if (requestUrl.endsWith("/eve/v1/telegram/cancel")) {
    const status = cancelRouteStatus;
    return Response.json({ ok: true, status });
  }
  const hold = heldSend;
  if (method === "sendMessage" && hold?.chatId === String(body?.chat_id)) {
    hold.startedResolve();
    await hold.release;
    if (heldSend === hold) heldSend = undefined;
  }
  return Response.json({
    ok: true,
    result: {
      message_id: 1000 + apiCalls.length,
      chat: { id: body?.chat_id ?? 7, type: "private" },
    },
  });
};

const telegramTestModule = "../agent/channels/telegram.ts?failure-events-test";
const [
  { default: channel, rememberAccepted },
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

const adapter = (channel as unknown as { adapter: FailureAdapter }).adapter;

// Журнал хода (ADR-0010): «Стоп» пишет свой исход из ЕДИНОЙ политики остановки, поэтому
// одинаково виден и в webhook-режиме, и через мост.

after(() => rmSync(dataDir, { recursive: true, force: true }));

function eventContext({
  chatId,
  sessionId,
  chatType = "private",
}: EventOptions) {
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId,
    turn: { id: "turn_0", sequence: 0 },
  });
  const session = {
    id: sessionId,
    auth: { current: null, initiator: null } as const,
    continuation: {
      token: `telegram:${chatId}::`,
      rekey() {},
    },
  };
  const state = {
    ...adapter.state,
    chatId: String(chatId),
    chatType,
    messageThreadId: null,
  };
  return {
    ctx,
    value: adapter.createAdapterContext({ ctx, session, state }),
  };
}

async function emitTurnFailed(
  data: Record<string, unknown>,
  options: EventOptions,
) {
  const context = eventContext(options);
  await contextStorage.run(context.ctx, () =>
    adapter["turn.failed"](data, context.value),
  );
}

async function emitSessionFailed(
  data: Record<string, unknown>,
  options: EventOptions,
) {
  const context = eventContext(options);
  await adapter["session.failed"](data, context.value);
}

async function emitSessionWaiting(options: EventOptions) {
  const context = eventContext(options);
  await contextStorage.run(context.ctx, () =>
    adapter["session.waiting"]({}, context.value),
  );
}

function callsSince(index: number, method: string) {
  return apiCalls.slice(index).filter((call) => call.method === method);
}

function holdSend(chatId: string) {
  let startedResolve!: () => void;
  let releaseResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  heldSend = {
    chatId: String(chatId),
    release,
    startedResolve,
  };
  return { release: releaseResolve, started };
}

test("turn.failed posts a humanized error without error id even when finishStatus CAS misses", async () => {
  const chatId = "701";
  const sessionId = "failed-session-cas-miss";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId: "newer-session",
    turnId: "turn_newer",
  });
  const before = apiCalls.length;
  const turnData = {
    code: "MODEL_CALL_FAILED",
    details: {
      errorId: "err-limit-701",
      statusCode: 429,
      upstreamMessage: "5-hour usage limit reached. Resets in 3hr 59min.",
    },
    message: "Request rejected",
    sequence: 0,
    turnId: "turn_0",
  };

  await emitTurnFailed(turnData, { chatId, sessionId });

  const sends = callsSince(before, "sendMessage");
  assert.equal(sends.length, 1);
  assert.equal(
    sends[0].body!.text,
    "Provider limit exhausted - resets in 3hr 59min; wait or switch models: /model",
  );
  assert.equal(getChatStatus(key)!.sessionId, "newer-session");

  await emitSessionFailed(
    {
      code: turnData.code,
      details: turnData.details,
      message: turnData.message,
      sessionId,
    },
    { chatId, sessionId },
  );

  assert.equal(callsSince(before, "sendMessage").length, 1);
});

test("session.failed clears its run-status and deduplicates repeated delivery", async () => {
  const chatId = "702";
  const sessionId = "terminal-session-cleanup";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId,
    turnId: "turn_0",
    draftId: 55,
  });
  const before = apiCalls.length;
  const data = {
    code: "MODEL_CALL_FAILED",
    details: { errorId: "err-billing-702", statusCode: 402 },
    message: "Request rejected",
    sessionId,
  };

  await emitSessionFailed(data, { chatId, sessionId });

  const status = getChatStatus(key);
  assert.equal(status!.status, "idle");
  assert.equal(status!.sessionId, undefined);
  assert.equal(status!.turnId, undefined);
  assert.equal(callsSince(before, "deleteMessage").length, 0);
  assert.equal(callsSince(before, "sendMessage").length, 1);
  assert.equal(
    callsSince(before, "sendMessage")[0].body!.text,
    "Provider balance/plan exhausted - top up or switch models: /model",
  );

  await emitSessionFailed(data, { chatId, sessionId });
  assert.equal(callsSince(before, "sendMessage").length, 1);
});

// session.waiting — страховка при потерянном terminal-событии (краш хода): парковка
// сессии обязана не только снять busy-флаг, но и удалить осиротевший «Работаю…/Стоп»,
// иначе индикатор висит в чате до ручной уборки.
test("session.waiting after a lost terminal event deletes the orphan working indicator", async () => {
  const chatId = "704";
  const sessionId = "parked-session-lost-terminal";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId,
    turnId: "turn_0",
    draftId: 66,
    ingressId: "ingress-704",
  });
  const before = apiCalls.length;

  await emitSessionWaiting({ chatId, sessionId });

  const status = getChatStatus(key);
  assert.equal(status!.status, "idle");
  assert.equal(status!.sessionId, undefined);
  assert.equal(status!.turnId, undefined);
  assert.equal(status!.draftId, undefined);
  assert.equal(status!.ingressId, undefined);
  const deletes = callsSince(before, "deleteMessage");
  assert.equal(deletes.length, 0);
});

test("session.waiting after normal cleanup or for a stale session is a no-op", async () => {
  const chatId = "705";
  const key = chatKeyOf(chatId);
  // Обычный финал: turn.completed уже прибрал статус — парковка ничего не трогает.
  setChatStatus(key, {
    status: "idle",
    sessionId: null,
    draftId: null,
  });
  const before = apiCalls.length;
  await emitSessionWaiting({ chatId, sessionId: "already-cleaned" });
  assert.equal(callsSince(before, "deleteMessage").length, 0);
  assert.equal(getChatStatus(key)!.status, "idle");

  // Запоздавший session.waiting старой сессии не должен убить бегущий новый ход.
  setChatStatus(key, {
    status: "running",
    sessionId: "newer-session",
    turnId: "turn_1",
    draftId: 90,
  });
  await emitSessionWaiting({ chatId, sessionId: "stale-session" });
  const status = getChatStatus(key);
  assert.equal(status!.status, "running");
  assert.equal(status!.sessionId, "newer-session");
  assert.equal(status!.draftId, 90);
  assert.equal(callsSince(before, "deleteMessage").length, 0);
});

test("turn.failed claims notification before an overlapping session.failed can post", async () => {
  const chatId = "703";
  const sessionId = "terminal-session-overlap";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId,
    turnId: "turn_0",
  });
  const before = apiCalls.length;
  const details = { errorId: "err-upstream-703" };
  const hold = holdSend(chatId);
  const turn = emitTurnFailed(
    {
      code: "MODEL_CALL_FAILED",
      details,
      message: "Upstream request failed",
      sequence: 0,
      turnId: "turn_0",
    },
    { chatId, sessionId },
  );
  await hold.started;

  await emitSessionFailed(
    {
      code: "MODEL_CALL_FAILED",
      details,
      message: "Upstream request failed",
      sessionId,
    },
    { chatId, sessionId },
  );

  assert.equal(callsSince(before, "sendMessage").length, 1);
  hold.release();
  await turn;
  assert.equal(callsSince(before, "sendMessage").length, 1);
});

test("two failed turns of one session within a minute both post", async () => {
  const chatId = "707";
  const sessionId = "two-turns-session";
  setChatStatus(chatKeyOf(chatId), {
    status: "running",
    sessionId,
    turnId: "turn_0",
  });
  const before = apiCalls.length;

  await emitTurnFailed(
    {
      code: "MODEL_CALL_FAILED",
      details: { errorId: "err-1" },
      message: "Upstream request failed",
      sequence: 0,
      turnId: "turn_0",
    },
    { chatId, sessionId },
  );
  await emitTurnFailed(
    {
      code: "MODEL_CALL_FAILED",
      details: { errorId: "err-2" },
      message: "Upstream request failed",
      sequence: 1,
      turnId: "turn_1",
    },
    { chatId, sessionId },
  );

  assert.equal(callsSince(before, "sendMessage").length, 2);
});

// Уведомление о сбое собирается из runtime-контента (текст провайдера, errorId), и до
// Bot API оно доходит через шов канала (noticeSender). Планты — под generic_key и под
// формат телеграм-токена; проверяем то, что реально ушло в теле запроса.
const PLANTED_KEY = `api_key=${"z".repeat(24)}`;
const PLANTED_BOT_TOKEN = `1234567890:${"A".repeat(35)}`;

function mutedConsole() {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}

test("turn.failed redacts a provider key before it reaches Bot API", async () => {
  const chatId = "706";
  const restore = mutedConsole();
  const before = apiCalls.length;
  try {
    await emitTurnFailed(
      {
        code: "MODEL_CALL_FAILED",
        details: { errorId: "err-key-706" },
        message: `Incorrect API key provided: ${PLANTED_KEY}`,
        sequence: 0,
        turnId: "turn_0",
      },
      { chatId, sessionId: "failed-session-key" },
    );
  } finally {
    restore();
  }

  const sends = callsSince(before, "sendMessage");
  assert.equal(sends.length, 1);
  const text = String(sends[0].body!.text);
  assert.equal(text.includes("zzzz"), false);
  assert.equal(text.includes("err-key-706"), false);
});

// errorId никто не чистит по дороге: если шов канала снять, ключ уедет в чат целым.
test("turn.failed redacts a secret carried by errorId itself", async () => {
  const chatId = "707";
  const restore = mutedConsole();
  const before = apiCalls.length;
  try {
    await emitTurnFailed(
      {
        code: "MODEL_CALL_FAILED",
        details: { errorId: PLANTED_KEY },
        message: "Provider returned a strange response",
        sequence: 0,
        turnId: "turn_0",
      },
      { chatId, sessionId: "failed-session-error-id" },
    );
  } finally {
    restore();
  }

  const sends = callsSince(before, "sendMessage");
  assert.equal(sends.length, 1);
  const text = String(sends[0].body!.text);
  assert.equal(text.includes("zzzz"), false);
  assert.equal(text.includes("Error id"), false);
});

// Худший вход разом: пусто в message, многострочный стек и оба секрета в одной ошибке.
test("session.failed survives an empty error and redacts a multi-line one", async () => {
  const restore = mutedConsole();
  const emptyBefore = apiCalls.length;
  try {
    await emitSessionFailed(
      { code: "MODEL_CALL_FAILED", message: "", sessionId: "failed-empty" },
      { chatId: "708", sessionId: "failed-empty" },
    );
    const empty = callsSince(emptyBefore, "sendMessage");
    assert.equal(empty.length, 1);
    assert.match(String(empty[0].body!.text), /^I could not answer: /u);

    const before = apiCalls.length;
    await emitSessionFailed(
      {
        code: "MODEL_CALL_FAILED",
        details: { errorId: "err-hostile-709" },
        message: `bot ${PLANTED_BOT_TOKEN} rejected the call: ${PLANTED_KEY}\nat stack ${PLANTED_KEY}`,
        sessionId: "failed-hostile",
      },
      { chatId: "709", sessionId: "failed-hostile" },
    );
    const sends = callsSince(before, "sendMessage");
    assert.equal(sends.length, 1);
    const text = String(sends[0].body!.text);
    assert.equal(text.includes("zzzz"), false);
    assert.equal(text.includes("AAAA"), false);
    assert.equal(text.includes("at stack"), false);
    assert.equal(text.includes("err-hostile-709"), false);
  } finally {
    restore();
  }
});

// Обрыв посреди ответа (c1, 07.10.2026): eve закрыла ход, не повторяя его. Владелец получает
// вопрос и кнопку «Повторить» — кнопка живёт только в rich-сообщении, поэтому реплика идёт
// sendRichMessage, а не голым sendMessage. Error id остаётся в журнале.
test("a stream broken mid-answer posts one Try again button through a rich message", async () => {
  const chatId = "720";
  const sessionId = "failed-mid-answer";
  const previous = process.env.MODEL_PROVIDER;
  process.env.MODEL_PROVIDER = "claude";
  const before = apiCalls.length;
  try {
    await emitTurnFailed(
      {
        code: "MODEL_CALL_FAILED",
        details: { errorId: "err-mid-720", attempts: 1, answerStarted: true },
        message:
          "api.anthropic.com did not finish the response (the stream broke off before message_stop)",
        sequence: 0,
        turnId: "turn_0",
      },
      { chatId, sessionId },
    );
  } finally {
    if (previous === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = previous;
  }
  assert.equal(callsSince(before, "sendMessage").length, 0);
  const rich = callsSince(before, "sendRichMessage");
  assert.equal(rich.length, 1);
  const markdown = String(
    (rich[0].body!.rich_message as { markdown?: unknown }).markdown,
  );
  assert.match(
    markdown,
    /The connection to Anthropic broke off in the middle/u,
  );
  assert.match(
    markdown,
    /<tg-button type="callback_data" data="Try again">Try again<\/tg-button>/u,
  );
  assert.equal(markdown.includes("err-mid-720"), false);
  assert.equal(String(rich[0].body!.chat_id), chatId);
});

// Первый запрос хода оборвался — вопроса в истории сессии нет. Канал помнит текст
// последнего принятого сообщения чата и цитирует его; «Повторить» в тексте нажатия
// приносит модели и цитату.
test("a mid-answer break quotes the last accepted message of the chat", async () => {
  const chatId = "721";
  const { rememberTurnQuestion } = await import("#lib/turn-question.ts");
  rememberTurnQuestion(chatKeyOf(chatId), {
    text: "Сколько <b>стоит</b> *ремонт*?",
    media: false,
  });
  const before = apiCalls.length;
  await emitTurnFailed(
    {
      code: "MODEL_CALL_FAILED",
      details: { errorId: "err-mid-721", attempts: 1, answerStarted: true },
      message: "terminated",
      sequence: 0,
      turnId: "turn_0",
    },
    { chatId, sessionId: "failed-mid-answer-quote" },
  );
  const rich = callsSince(before, "sendRichMessage");
  assert.equal(rich.length, 1);
  const markdown = String(
    (rich[0].body!.rich_message as { markdown?: unknown }).markdown,
  );
  assert.match(
    markdown,
    /in the middle of the answer to «Сколько ‹b›стоит‹\/b› \\\*ремонт\\\*\?»\. Try again\?/u,
  );
  assert.equal((markdown.match(/<tg-button[\s>]/gu) ?? []).length, 1);
});

async function midAnswerNotice(
  chatId: string,
  question: { text: string; media: boolean },
  chatType = "private",
): Promise<{ rich: string | null; plain: string | null }> {
  const { rememberTurnQuestion } = await import("#lib/turn-question.ts");
  rememberTurnQuestion(chatKeyOf(chatId), question);
  const before = apiCalls.length;
  await emitTurnFailed(
    {
      code: "MODEL_CALL_FAILED",
      details: { errorId: `err-${chatId}`, attempts: 1, answerStarted: true },
      message: "terminated",
      sequence: 0,
      turnId: "turn_0",
    },
    { chatId, sessionId: `mid-answer-${chatId}`, chatType },
  );
  const rich = callsSince(before, "sendRichMessage")[0];
  const plain = callsSince(before, "sendMessage")[0];
  return {
    rich: rich
      ? String((rich.body!.rich_message as { markdown?: unknown }).markdown)
      : null,
    plain: plain ? String(plain.body!.text) : null,
  };
}

test("in a group the break notice names «your message» and never quotes it", async () => {
  const { rich } = await midAnswerNotice(
    "-1001722",
    { text: "личное про зарплату", media: false },
    "supergroup",
  );
  assert.ok(rich !== null);
  assert.match(
    rich,
    /in the middle of the answer to your message\. Try again\?/u,
  );
  assert.doesNotMatch(rich, /зарплат/u);
});

test("a message with an attachment is asked again, without a button", async () => {
  const { rich, plain } = await midAnswerNotice("723", {
    text: "",
    media: true,
  });
  assert.equal(rich, null);
  assert.equal(
    plain,
    "The connection to the provider broke off in the middle of the answer to your message with an attachment. Send it again.",
  );
});

// Провод канала, а не только модуль вопроса: принятое голосовое или фото без подписи
// стирает прежний вопрос и метит вложение, и после обрыва кнопки нет — Ива просит прислать
// сообщение ещё раз (мутант «media: false» в канале обязан краснеть здесь).
test("a voice or a photo without a caption, then a mid-answer break: no button, send it again", async () => {
  const { rememberTurnQuestion } = await import("#lib/turn-question.ts");
  for (const [chatId, raw] of [
    ["724", { voice: { file_id: "voice-1", duration: 3 } }],
    ["725", { photo: [{ file_id: "photo-1", width: 1, height: 1 }] }],
  ] as const) {
    rememberTurnQuestion(chatKeyOf(chatId), {
      text: "прежний вопрос",
      media: false,
    });
    await rememberAccepted(
      chatKeyOf(chatId),
      {
        attachments: [],
        caption: "",
        chat: { id: chatId, type: "private" },
        messageId: "1",
        raw,
        text: "",
      },
      Promise.resolve({ auth: null }),
    );
    const before = apiCalls.length;
    await emitTurnFailed(
      {
        code: "MODEL_CALL_FAILED",
        details: { errorId: `err-${chatId}`, attempts: 3, answerStarted: true },
        message: "terminated",
        sequence: 0,
        turnId: "turn_0",
      },
      { chatId, sessionId: `media-${chatId}` },
    );
    assert.equal(callsSince(before, "sendRichMessage").length, 0);
    const sends = callsSince(before, "sendMessage");
    assert.equal(sends.length, 1);
    const text = String(sends[0].body!.text);
    assert.match(text, /to your message with an attachment/u);
    assert.match(text, /Send it again\.$/u);
    assert.doesNotMatch(text, /tg-button|прежний вопрос/u);
  }
});

// --- Проводка пульса живого хода ---
//
// Пульс держится на ЧЕТЫРЁХ обработчиках событий канала (agent/channels/telegram.ts).
// Сама функция markTelegramTurnAlive проверена в agent/lib/telegram-turn-start.test.ts,
// но её вызов из обработчика — отдельный провод: убрать его, и жнец снова начнёт снимать
// живой молчаливый ход, а все юнит-тесты останутся зелёными. Здесь дёргается настоящий
// адаптер канала, а результат читается из настоящего run-status.
const HEARTBEAT_EVENTS = [
  ["actions.requested", { actions: [], sequence: 0, turnId: "turn_0" }],
  [
    "action.partial",
    { result: {}, sequence: 1, stepIndex: 0, turnId: "turn_0" },
  ],
  [
    "action.result",
    { result: {}, sequence: 2, stepIndex: 0, turnId: "turn_0" },
  ],
  ["message.appended", { message: {}, sequence: 3 }],
] as const;

async function emitChannelEvent(
  name: (typeof HEARTBEAT_EVENTS)[number][0],
  data: Record<string, unknown>,
  options: EventOptions,
) {
  const context = eventContext(options);
  await contextStorage.run(context.ctx, () =>
    adapter[name](data, context.value),
  );
}

test("every live-turn event refreshes run-status, and actions.requested keeps Eve's typing default", async () => {
  let chatIdSeed = 710;
  for (const [name, data] of HEARTBEAT_EVENTS) {
    // Свой чат на событие: пульс дросселирован одной записью в минуту на чат.
    const chatId = String(chatIdSeed++);
    const sessionId = `alive-${name}`;
    const key = chatKeyOf(chatId);
    // firstOutputAt проставлен заранее: иначе отметка первого вывода в message.appended
    // сама сделала бы запись и замаскировала отсутствие пульса.
    setChatStatus(key, {
      status: "running",
      sessionId,
      turnId: "turn_0",
      firstOutputAt: 1,
    });
    const { telegramDraftTurn } = await import("#lib/telegram-draft.ts");
    telegramDraftTurn(
      { chatId, request: () => Promise.resolve({ ok: true, body: {} }) },
      sessionId,
      "turn_0",
      false,
    );
    const before = getChatStatus(key)!;
    const apiBefore = apiCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 5)); // Date.now() ходит по миллисекундам

    await emitChannelEvent(name, { ...data }, { chatId, sessionId });

    const after = getChatStatus(key)!;
    assert.equal(
      after.generation,
      (before.generation as number) + 1,
      `${name}: пульс не дошёл до run-status`,
    );
    assert.ok(
      (after.updatedAt as number) > (before.updatedAt as number),
      `${name}: updatedAt не двинулся, жнец снимет живой ход`,
    );
    assert.equal(after.status, "running", `${name}: пульс сменил статус`);
    assert.equal(after.sessionId, sessionId, `${name}: пульс сменил сессию`);

    // Дефолт eve на actions.requested — обновить «печатает…». Переопределяя событие,
    // канал обязан сохранить это сам.
    assert.equal(
      callsSince(apiBefore, "sendChatAction").length,
      0,
      `${name}: индикатор набора`,
    );
  }
});

test("a heartbeat from a finished or foreign turn is refused by the same wiring", async () => {
  const chatId = "719";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId: "live-session",
    turnId: "turn_0",
    firstOutputAt: 1,
  });
  const before = getChatStatus(key)!;

  // Опоздавшее событие уже сброшенного хода: CAS по sessionId не совпал.
  await emitChannelEvent(
    "action.result",
    { result: {}, sequence: 9, stepIndex: 0, turnId: "turn_old" },
    { chatId, sessionId: "old-session" },
  );

  const after = getChatStatus(key)!;
  assert.equal(after.generation, before.generation);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.sessionId, "live-session");
});

// Знак очереди под сообщением, которое ждёт своего хода (agent/lib/telegram-turn-start.ts).
const queuedSign = (sessionId: string, messageId: number) => ({
  queuedIngressId: `ingress-${messageId}`,
  queuedIngressAt: 1_000,
  queuedSessionId: sessionId,
});
const signCleared = {
  queuedIngressId: null,
  queuedIngressAt: null,
  queuedSessionId: null,
};

test("session.failed deletes only the queued sign of its own session", async () => {
  const chatId = "760";
  const key = chatKeyOf(chatId);
  const data = { code: "X", message: "dead", sessionId: "s-dead" };

  // Знак сообщения, вставшего за ходом чужой (живой) сессии, упавшая сессия не трогает.
  setChatStatus(key, { status: "idle", ...queuedSign("s-live", 961) });
  let before = apiCalls.length;
  await emitSessionFailed(data, { chatId, sessionId: "s-dead" });
  assert.equal(getChatStatus(key)?.queuedIngressId, "ingress-961");
  assert.equal(
    callsSince(before, "deleteMessage").some(
      (call) => call.body?.message_id === 961,
    ),
    false,
  );

  // Свой знак уходит: буфер входа умершей сессии хода уже не начнёт.
  setChatStatus(key, { ...signCleared, ...queuedSign("s-dead", 962) });
  before = apiCalls.length;
  await emitSessionFailed(
    { ...data, message: "dead again" },
    { chatId, sessionId: "s-dead" },
  );
  assert.equal(getChatStatus(key)?.queuedIngressId, undefined);
  assert.deepEqual(
    callsSince(before, "deleteMessage").map((call) => call.body?.message_id),
    [],
  );
});

test("a turn resumed by an answer to a question takes the sign without the queued message's ingressAt", async () => {
  const chatId = "761";
  const sessionId = "s-hitl";
  const key = chatKeyOf(chatId);
  setChatStatus(key, { status: "idle", ...queuedSign(sessionId, 963) });
  const context = eventContext({ chatId, sessionId });

  // eve шлёт input.resolved до turn.started хода, который продолжит ответ на вопрос.
  await contextStorage.run(context.ctx, async () => {
    await adapter["input.resolved"](
      {
        resolutions: [
          { kind: "question", outcome: "answered", requestId: "req-1" },
        ],
      },
      context.value,
    );
    await adapter["turn.started"]({ turnId: "turn_hitl" }, context.value);
  });

  const status = getChatStatus(key);
  assert.equal(typeof status?.draftId, "number");
  assert.equal(status?.ingressAt, undefined);
  assert.equal(status?.statusAt, undefined);
  assert.equal(status?.queuedIngressId, undefined);
});

test("REPAIR1: real Telegram failure returns while its same-chat auth reply is in flight", async (t) => {
  const { dispatchModelAuth } = await import("#lib/model-auth-dispatch.ts");
  const beforeProvider = process.env.MODEL_PROVIDER;
  process.env.MODEL_PROVIDER = "claude";
  t.after(() => {
    if (beforeProvider === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = beforeProvider;
  });
  const chatId = "9";
  const before = apiCalls.length;
  const hold = holdSend(chatId);
  const turn = emitTurnFailed(
    { message: "OAuth session expired", turnId: "repair-auth" },
    { chatId, sessionId: "repair-auth" },
  );
  try {
    const result = await Promise.race([
      turn.then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    assert.equal(result, "returned");
    await hold.started;
    const replies = callsSince(before, "sendMessage");
    assert.equal(replies.length, 1);
    assert.equal(String(replies[0].body?.chat_id), chatId);
    assert.match(String(replies[0].body?.text), /claude auth login/u);
  } finally {
    hold.release();
    await turn;
    await dispatchModelAuth();
  }
});
