// Контракт срабатывания: в срок идёт один ход агента с текстом напоминания как промптом,
// и код отправляет его финальный текст туда, где напоминание попросили. Ход упал или
// промолчал — код шлёт текст напоминания как есть и называет причину в строке. Оба шва
// Ход — двойник; доставка проверяется и двойником, и настоящим Outbox с подменённым fetch.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";

const root = mkdtempSync(join(tmpdir(), "iva-reminder-fire-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });

const { add, fireDue, list } = await import("#lib/reminder-store.ts");
const { runReminderFire } = await import("./fire.ts");
const { runReminderTurn } = await import("../lib/reminder-turn.ts");
const { chatKeyOf, getChatStatus, isRunning, setChatStatus, setChatStatusIf } =
  await import("#lib/run-status.ts");
import type { CreateClient } from "../lib/reminder-turn.ts";

let caseDir = "";
beforeEach(() => {
  caseDir = mkdtempSync(join(root, "case-"));
  process.env.ASSISTANT_DATA_DIR = caseDir;
});
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const NOW = 1_800_000_000_000;

const BUTTON_REPLY =
  'Продолжить?\n\n<tg-button-row><tg-button type="callback_data" data="Да">Да</tg-button></tg-button-row>';

function wireSend(rejectRich = false) {
  const requests: { method: string; body: unknown }[] = [];
  const send: typeof import("../lib/telegram-send.ts").sendTelegramHtml =
    async (bot, chat, text, options) => {
      const { sendTelegramHtml } = await import("../lib/telegram-send.ts");
      return sendTelegramHtml(bot, chat, text, {
        ...options,
        fetchImpl: (url, init) => {
          const address =
            typeof url === "string"
              ? url
              : url instanceof URL
                ? url.href
                : url.url;
          const method = address.split("/").at(-1)!;
          assert.equal(typeof init?.body, "string");
          const body = init?.body;
          assert.ok(typeof body === "string");
          requests.push({ method, body: JSON.parse(body) });
          return Promise.resolve(
            new Response("", {
              status: rejectRich && method === "sendRichMessage" ? 400 : 200,
            }),
          );
        },
      });
    };
  return { requests, send };
}

void test("Reminder buttons reach sendRichMessage with the model reply and topic", async () => {
  await firedRow({ id: "-100123", threadId: "42" });
  const { send, requests } = wireSend();
  const { runTurn } = turn("completed", BUTTON_REPLY);
  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);
  assert.deepEqual(requests, [
    {
      method: "sendRichMessage",
      body: {
        chat_id: "-100123",
        message_thread_id: "42",
        rich_message: { markdown: BUTTON_REPLY },
      },
    },
  ]);
  assert.equal((await list())[0]?.delivered, true);
});

void test("Reminder text without rich constructs keeps the HTML sendMessage body", async () => {
  await firedRow();
  const { send, requests } = wireSend();
  const { runTurn } = turn("completed", "**Готово**");
  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);
  assert.deepEqual(requests, [
    {
      method: "sendMessage",
      body: { chat_id: "555", text: "<b>Готово</b>", parse_mode: "HTML" },
    },
  ]);
});

void test("Reminder rich rejection falls back to HTML with button labels", async () => {
  await firedRow();
  const { send, requests } = wireSend(true);
  const { runTurn } = turn("completed", BUTTON_REPLY);
  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);
  assert.deepEqual(requests, [
    {
      method: "sendRichMessage",
      body: { chat_id: "555", rich_message: { markdown: BUTTON_REPLY } },
    },
    {
      method: "sendMessage",
      body: {
        chat_id: "555",
        text: "Продолжить?\n\n <b>Да</b>",
        parse_mode: "HTML",
      },
    },
  ]);
  assert.equal((await list())[0]?.delivered, true);
});

void test("long Reminder text keeps every character across HTML chunks", async () => {
  await firedRow();
  const text = "я".repeat(9000);
  const { send, requests } = wireSend();
  const { runTurn } = turn("completed", text);
  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);
  assert.equal(requests.length, 3);
  const parts = requests.map(({ method, body }) => {
    assert.equal(method, "sendMessage");
    assert.ok(body !== null && typeof body === "object" && "text" in body);
    assert.equal(typeof body.text, "string");
    const part = String(body.text);
    assert.ok(part.length <= 4096);
    assert.deepEqual(body, { chat_id: "555", text: part, parse_mode: "HTML" });
    return part;
  });
  assert.equal(parts.join(""), text);
});

void test("long Reminder with buttons falls back to bounded HTML chunks after rich rejection", async () => {
  await firedRow();
  const prefix = "я".repeat(9000);
  const text = `${prefix}\n\n${BUTTON_REPLY}`;
  const { send, requests } = wireSend(true);
  const { runTurn } = turn("completed", text);
  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);
  assert.deepEqual(requests[0], {
    method: "sendRichMessage",
    body: { chat_id: "555", rich_message: { markdown: text } },
  });
  const parts = requests.slice(1).map(({ method, body }) => {
    assert.equal(method, "sendMessage");
    assert.ok(body !== null && typeof body === "object" && "text" in body);
    const part = String(body.text);
    assert.ok(part.length <= 4096);
    assert.deepEqual(body, { chat_id: "555", text: part, parse_mode: "HTML" });
    return part;
  });
  assert.equal(parts.length, 3);
  assert.equal(parts.join(""), `${prefix}\n\nПродолжить?\n\n <b>Да</b>`);
  assert.equal((await list())[0]?.delivered, true);
});

void test("turn.failed after empty responses delivers the reminder and records failure", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  const cause = "The model did not return a response";
  const runTurn = realTurn(
    [
      { type: "turn.failed", data: { message: cause } },
      { type: "session.waiting" },
    ],
    { sessionId: "empty-response" },
  );
  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);
  assert.deepEqual(
    calls.map((c) => c.text),
    ["позвонить в клинику"],
  );
  const [row] = await list();
  assert.equal(row?.delivered, true);
  assert.equal(row?.error, `agent turn failed: ${cause}`);
});

/**
 * Свой чат на тест: записи run-status общие на весь файл (DATA_DIR фиксируется на загрузке),
 * и остаток от прошлого теста не должен решать, возьмёт ли напоминание чат.
 */
let chatSeq = 0;
const freshChat = () => ({
  id: `-100${(chatSeq += 1)}`,
  threadId: `835${chatSeq}`,
});

/**
 * Протухшая запись чата: setChatStatus всегда двигает updatedAt, поэтому пишем файл прямо —
 * другого способа показать чужой ход, умерший полчаса назад, у теста нет.
 */
function seedStaleStatus(
  chatKey: string,
  record: Record<string, unknown>,
): void {
  const dir = join(root, "data", "run-status.d");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${Buffer.from(chatKey, "utf8").toString("base64url")}.json`),
    JSON.stringify({
      ...record,
      generation: 1,
      updatedAt: Date.now() - 40 * 60_000,
    }),
  );
}

/** Строка уже сработала: тик перевёл её в fired и запустил ребёнка. */
async function firedRow(chat?: {
  id: string;
  threadId: string | null;
}): Promise<void> {
  await add({
    id: "r1",
    text: "позвонить в клинику",
    ...(chat === undefined ? {} : { chat }),
    schedule: { kind: "at", atMs: NOW },
  });
  await fireDue(NOW, 10);
}

type SendCall = {
  readonly bot: string;
  readonly chat: string;
  readonly text: string;
  readonly threadId?: string;
};
type SendAck = { ok: boolean; fellBack: boolean; error: string };

function makeSend(script: readonly SendAck[] = []) {
  const calls: SendCall[] = [];
  const send = (
    bot: string,
    chat: string,
    md: unknown,
    options?: { readonly threadId?: string },
  ): Promise<SendAck> => {
    calls.push({ bot, chat, text: String(md), threadId: options?.threadId });
    return Promise.resolve(
      script[calls.length - 1] ?? { ok: true, fellBack: false, error: "" },
    );
  };
  return { calls, send };
}

const turn = (
  status: "completed" | "failed" | "waiting",
  message?: string,
  cancelled = false,
) => {
  const prompts: string[] = [];
  const runTurn = (prompt: string) => {
    prompts.push(prompt);
    return Promise.resolve({
      status,
      ...(message === undefined ? {} : { message }),
      ...(cancelled ? { cancelled: true } : {}),
      feedback: () => Promise.resolve(undefined),
    });
  };
  return { prompts, runTurn };
};

const deps = (over: Record<string, unknown> = {}) => ({
  env: {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_DIGEST_CHAT_ID: "555",
    ASSISTANT_BEARER: "test-bearer",
  } as NodeJS.ProcessEnv,
  chat: () => "555",
  translator: () => Promise.resolve((english: string) => english),
  log: () => {},
  ...over,
});

type StreamEvent = { readonly type: string; readonly data?: unknown };

/**
 * Настоящий ход поверх двойника eve: стрим и сессия — от теста, всё остальное — боевой код,
 * включая запись в run-status, которую тесты здесь и проверяют.
 */
function realTurn(
  events: readonly StreamEvent[],
  {
    sessionId,
    before,
    fail,
    onCancel,
  }: {
    readonly sessionId: string;
    readonly before?: () => void;
    /** Остановка хода через сессию: её зовёт ход, вставший на лимит сессии eve. */
    readonly onCancel?: (options: { readonly tasks: boolean }) => void;
    /** Обрыв стрима после этих событий: так eve теряет связь на середине хода. */
    readonly fail?: string;
  },
): typeof runReminderTurn {
  const response = Object.assign(
    (async function* () {
      before?.();
      await Promise.resolve();
      for (const event of events) yield event;
      if (fail !== undefined) throw new Error(fail);
    })(),
    { cancel: () => Promise.resolve(), sessionId },
  );
  const createClient: CreateClient = () =>
    Promise.resolve({
      sessions: {
        create: () =>
          Promise.resolve({
            response,
            session: {
              send: () => Promise.resolve(),
              cancel: (options) => {
                onCancel?.(options);
                return Promise.resolve({ status: "no_active_turn" });
              },
              reset: () => Promise.resolve(),
            },
          }),
      },
    });
  return (prompt, options, turnDeps) =>
    runReminderTurn(prompt, options, { ...turnDeps, createClient });
}

const completed = [
  { type: "message.completed", data: { message: "готово" } },
  { type: "session.completed" },
] as const;

void test("ход выполнил напоминание: его ответ уходит в чат и тему строки", async () => {
  const chat = freshChat();
  await firedRow(chat);
  const { calls, send } = makeSend();
  const { prompts, runTurn } = turn("completed", "Новости Австралии: …");

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(prompts.length, 1, "ход ровно один");
  assert.match(prompts[0], /r1/u);
  assert.match(prompts[0], /позвонить в клинику/u);
  assert.match(prompts[0], /final text of this turn/u);
  assert.match(prompts[0], /background-check skill/u);
  assert.match(prompts[0], /instead of waiting for the job to finish/u);
  assert.equal(calls.length, 1, "отправка ровно одна");
  assert.equal(calls[0].chat, chat.id);
  assert.equal(calls[0].threadId, chat.threadId);
  assert.equal(calls[0].text, "Новости Австралии: …");
  const [row] = await list();
  assert.equal(row?.delivered, true);
  assert.equal(row?.error, null);
  assert.equal(row?.status, "fired");
});

void test("строка без чата идёт в чат владельца, а waiting — нормальный конец хода", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  const { runTurn } = turn("waiting", "напоминаю: позвонить в клинику");

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].chat, "555");
  assert.equal(calls[0].text, "напоминаю: позвонить в клинику");
  const [row] = await list();
  assert.equal(row?.delivered, true);
  assert.equal(row?.error, null);
});

void test("ход упал: код шлёт текст напоминания как есть и называет причину", async () => {
  await firedRow();
  const { calls, send } = makeSend();

  assert.equal(
    await runReminderFire(
      "r1",
      deps({
        send,
        runTurn: () => Promise.reject(new Error("no activity for 30000ms")),
      }),
    ),
    0,
  );

  assert.equal(calls.length, 1, "страховка шлёт один раз");
  assert.equal(calls[0].text, "позвонить в клинику");
  const [row] = await list();
  assert.equal(row?.delivered, true, "текст дошёл, хоть ход и упал");
  assert.match(
    String(row?.error),
    /agent turn failed: no activity for 30000ms/u,
  );
});

void test("ход вернул пустой текст: уходит текст напоминания, причина в строке", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  const { runTurn } = turn("completed", "   ");

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "позвонить в клинику");
  const [row] = await list();
  assert.equal(row?.delivered, true);
  assert.match(String(row?.error), /no text/u);
});

void test("status failed: текст напоминания и причина провала хода", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  const { runTurn } = turn("failed", "turn timed out");

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(calls[0].text, "позвонить в клинику");
  const [row] = await list();
  assert.match(String(row?.error), /agent turn failed: turn timed out/u);
});

void test("владелец остановил ход: дословный текст не уходит, в строке факт отмены", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  const { runTurn } = turn("waiting", "напоминаю: позвонить в клинику", true);

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(calls.length, 0, "отменённый ход ничего не отправляет");
  const [row] = await list();
  assert.equal(row?.delivered, false);
  assert.match(String(row?.error), /cancelled by owner/u);
  assert.deepEqual(
    await fireDue(NOW + 60_000, 10),
    [],
    "повторного срабатывания нет",
  );
});

void test("ход идёт от имени чата строки: стоп из него находит сессию хода", async () => {
  const chat = freshChat();
  await firedRow(chat);
  const { calls, send } = makeSend();
  const key = chatKeyOf(chat.id, chat.threadId);
  const seen: Array<{ running: boolean; sessionId: unknown }> = [];
  const runTurn = realTurn(completed, {
    sessionId: "sess-fire",
    before: () =>
      seen.push({
        running: isRunning(key),
        sessionId: getChatStatus(key)?.sessionId,
      }),
  });

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.deepEqual(seen, [{ running: true, sessionId: "sess-fire" }]);
  assert.equal(isRunning(key), false, "после хода запись снята");
  assert.equal(calls[0].text, "готово");
});

void test("занятый чат: живой ход владельца остаётся побайтно тем же", async () => {
  const chat = freshChat();
  await firedRow(chat);
  const { calls, send } = makeSend();
  const key = chatKeyOf(chat.id, chat.threadId);
  const owner = setChatStatus(key, {
    status: "running",
    sessionId: "owner-sess",
    turnId: "owner-turn",
    ingressId: "ing-1",
    draftId: 42,
  });
  const during: unknown[] = [];
  const runTurn = realTurn(completed, {
    sessionId: "reminder-sess",
    before: () => during.push(getChatStatus(key)),
  });

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.deepEqual(during, [owner], "чужую запись не трогаем и во время хода");
  assert.deepEqual(getChatStatus(key), owner, "и не снимаем после");
  assert.equal(
    isRunning(key),
    true,
    "стоп владельца по-прежнему видит его ход",
  );
  assert.equal(calls[0].text, "готово", "ответ владельцу всё равно доехал");
});

void test("ход владельца поверх напоминания: снятие напоминания его не трогает", async () => {
  const chat = freshChat();
  await firedRow(chat);
  const { calls, send } = makeSend();
  const key = chatKeyOf(chat.id, chat.threadId);
  const runTurn = realTurn(completed, {
    sessionId: "reminder-sess",
    // Владелец пишет в чат, пока ход напоминания идёт: его ход забирает запись.
    before: () => {
      const current = getChatStatus(key);
      assert.equal(
        current?.sessionId,
        "reminder-sess",
        "до хода владельца запись была за напоминанием",
      );
      setChatStatusIf(
        key,
        { generation: current?.generation },
        { status: "running", sessionId: "owner-sess", turnId: "owner-turn" },
      );
    },
  });

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  const after = getChatStatus(key);
  assert.equal(after?.sessionId, "owner-sess");
  assert.equal(after?.turnId, "owner-turn");
  assert.equal(isRunning(key), true, "ход владельца остался виден");
  assert.equal(calls[0].text, "готово");
});

void test("отмена без границы сессии: текст не уходит, в строке факт отмены", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  // Ход погасили снаружи, а границы сессии eve так и не прислал: признак отмены обязан
  // доехать до кода, иначе владелец получит дословный текст, которого не просил.
  const runTurn = realTurn([{ type: "turn.cancelled" }], {
    sessionId: "sess-cut",
  });

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(calls.length, 0, "отменённый ход ничего не отправляет");
  const [row] = await list();
  assert.equal(row?.delivered, false);
  assert.match(String(row?.error), /cancelled by owner/u);
});

void test("отмена, а потом обрыв стрима: текст не уходит, в строке факт отмены", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  // Боевой путь /stop: eve успел сказать turn.cancelled, session.* не прислал, и стрим
  // оборвался — признак отмены обязан пережить обрыв.
  const runTurn = realTurn([{ type: "turn.cancelled" }], {
    sessionId: "sess-cut",
    fail: "stream reset by peer",
  });

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(calls.length, 0, "отменённый ход ничего не отправляет");
  const [row] = await list();
  assert.equal(row?.delivered, false);
  assert.match(String(row?.error), /cancelled by owner/u);
});

void test("ход упёрся в лимит сессии eve: владелец узнаёт, что не выполнено, а не получает текст шага", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  const cancels: boolean[] = [];
  // Ровно это eve шлёт фоновому ходу на лимите сессии: промежуточный текст шага, вопрос
  // «Approve/Stop», который в фоне некому показать, и парковку сессии.
  const runTurn = realTurn(
    [
      { type: "message.completed", data: { message: "промежуточный текст" } },
      {
        type: "input.requested",
        data: {
          requests: [
            { kind: "session-limit", requestId: "s:limit:input:40064924" },
          ],
        },
      },
      { type: "turn.completed" },
      { type: "session.waiting" },
    ],
    { sessionId: "sess-limit", onCancel: ({ tasks }) => cancels.push(tasks) },
  );

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(calls.length, 1, "владелец получает одно короткое сообщение");
  assert.match(calls[0].text, /позвонить в клинику/u);
  assert.match(calls[0].text, /Not done: .*session token limit/u);
  assert.doesNotMatch(calls[0].text, /промежуточный текст/u);
  assert.deepEqual(cancels, [true], "ход погашен вместе с задачами");
  const [row] = await list();
  assert.match(String(row?.error), /agent turn failed: .*session token limit/u);
});

void test("протухшая запись владельца: напоминание забирает чат и называет осиротевший индикатор", async () => {
  const chat = freshChat();
  await firedRow(chat);
  const key = chatKeyOf(chat.id, chat.threadId);
  // Ход владельца умер полчаса назад, не убрав за собой «Работаю…».
  seedStaleStatus(key, {
    status: "running",
    sessionId: "owner-sess",
    turnId: "owner-turn",
    draftId: 42,
    retireAfterTurn: {
      replayMs: 1,
      sessionId: "owner-sess",
      turnId: "owner-turn",
    },
  });
  const { calls, send } = makeSend();
  const lines: string[] = [];
  const during: Array<Record<string, unknown> | null> = [];
  const runTurn = realTurn(completed, {
    sessionId: "reminder-sess",
    before: () => during.push(getChatStatus(key)),
  });

  assert.equal(
    await runReminderFire(
      "r1",
      deps({
        send,
        runTurn,
        log: (...args: unknown[]) => lines.push(args.join(" ")),
      }),
    ),
    0,
  );

  assert.equal(
    during[0]?.sessionId,
    "reminder-sess",
    "протухшую запись напоминание забирает себе",
  );
  assert.equal(
    during[0]?.draftId,
    undefined,
    "осиротевший индикатор с записи снят: после захвата его больше никто не найдёт",
  );
  assert.equal(isRunning(key), false, "после хода запись снята");
  assert.equal(calls[0].text, "готово", "ответ владельцу всё равно доехал");
});

void test("отправка упала: delivered=false с ответом Telegram", async () => {
  await firedRow();
  const { calls, send } = makeSend([
    { ok: false, fellBack: false, error: "400 chat not found" },
  ]);
  const { runTurn } = turn("completed", "готово: новости отправлены");

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(calls.length, 1, "повторов нет");
  const [row] = await list();
  assert.equal(row?.delivered, false);
  assert.equal(row?.error, "400 chat not found");
});

void test("оба шва сломаны: в строке причина хода и отказ Telegram", async () => {
  await firedRow();
  const { calls, send } = makeSend([
    { ok: false, fellBack: false, error: "400 chat not found" },
  ]);
  const { runTurn } = turn("failed", "turn timed out");
  const lines: string[] = [];

  assert.equal(
    await runReminderFire(
      "r1",
      deps({
        send,
        runTurn,
        log: (...args: unknown[]) => lines.push(args.join(" ")),
      }),
    ),
    0,
  );

  assert.equal(calls[0].text, "позвонить в клинику");
  const [row] = await list();
  assert.equal(row?.delivered, false);
  assert.match(String(row?.error), /agent turn failed: turn timed out/u);
  assert.match(String(row?.error), /400 chat not found/u);
  assert.ok(
    lines.some((line) => /r1 agent turn failed: turn timed out/u.test(line)),
    lines.join("\n"),
  );
});

void test("запись факта упала: отправка состоялась, сбой виден в журнале", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  const { runTurn } = turn("completed", "готово: новости отправлены");
  const lines: string[] = [];

  assert.equal(
    await runReminderFire(
      "r1",
      deps({
        send,
        runTurn,
        recordDelivery: () => Promise.reject(new Error("store is locked")),
        log: (...args: unknown[]) => lines.push(args.join(" ")),
      }),
    ),
    0,
  );

  assert.equal(calls.length, 1, "отправка состоялась");
  assert.ok(
    lines.some((line) =>
      /r1 delivery fact not recorded: store is locked/u.test(line),
    ),
    lines.join("\n"),
  );
  const [row] = await list();
  assert.equal(row?.delivered, null, "факт в строку не лёг");
});

void test("таблица не читается: ребёнок выходит с кодом 1", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    assert.equal(
      await runReminderFire(
        "r1",
        deps({
          send,
          list: () => Promise.reject(new Error("table is broken")),
        }),
      ),
      1,
    );
  } finally {
    console.error = original;
  }

  assert.equal(calls.length, 0, "без строки отправлять нечего");
  assert.match(errors.join("\n"), /r1: table is broken/u);
});

void test("без токена или чата ход не запускается, а причина оседает в строке", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  const { prompts, runTurn } = turn("completed", "ответ");

  assert.equal(
    await runReminderFire(
      "r1",
      deps({
        send,
        runTurn,
        env: { ASSISTANT_BEARER: "test-bearer" },
        chat: () => null,
      }),
    ),
    0,
  );

  assert.deepEqual(prompts, [], "ход не жжёт токены без адресата");
  assert.equal(calls.length, 0);
  let [row] = await list();
  assert.equal(row?.delivered, false);
  assert.match(String(row?.error), /TELEGRAM_BOT_TOKEN is missing/u);

  // Токен есть, а чата нет: строка старой схемы при пустых настройках владельца.
  assert.equal(
    await runReminderFire("r1", deps({ send, runTurn, chat: () => null })),
    0,
  );
  assert.deepEqual(prompts, []);
  assert.equal(calls.length, 0);
  [row] = await list();
  assert.match(String(row?.error), /no owner chat/u);
});

void test("вызов без id и с чужим id — отказ без записи", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  assert.equal(await runReminderFire("", deps({ send })), 2);
  assert.equal(await runReminderFire("nope", deps({ send })), 2);
  assert.equal(calls.length, 0);
  const [row] = await list();
  assert.equal(row?.delivered, null, "чужой вызов не тронул строку");
});

for (const id of ["r1", "signal-r339"])
  for (const english of [false, true])
    void test(`r339 ${id} step ceiling reaches the owner, English=${english}`, async () => {
      const { failedModelEvents } =
        await import("../fixtures/reminder-events.test-fixture.ts");
      await add({
        id,
        text: "исходный текст",
        schedule: { kind: "at", atMs: NOW },
      });
      await fireDue(NOW, 10);
      const { calls, send } = makeSend();
      const runTurn = realTurn(failedModelEvents(), { sessionId: "ceiling" });
      const translator = () =>
        Promise.resolve((en: string, ru: string) => (english ? en : ru));
      assert.equal(
        await runReminderFire(id, deps({ send, runTurn, translator })),
        0,
      );
      assert.deepEqual(
        calls.map((c) => c.text),
        [
          english
            ? "исходный текст\nStopped after 40 steps without a final summary."
            : "исходный текст\nОстановилась на 40 шагах и не успела подвести итог.",
        ],
      );
      const [row] = await list();
      assert.equal(row?.delivered, true);
      assert.equal(row?.error, "agent turn failed: upstream failure");
    });
