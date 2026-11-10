// Шумовые свойства приёма моста: апдейт, который приём навсегда не может опознать
// (нет from, служебный тип, callback без сообщения), не имеет права заклинить offset.
// Сегодняшний Bot API под allowed_updates: ["message","callback_query"] таких апдейтов
// не шлёт (анонимным админам подставляется from=1087968824, автофорвардам 777000, а
// служебные типы отфильтрованы) — тест держит контракт на случай нового типа апдейта,
// релея или смены фильтра: цена ошибки — полная глухота бота до ручного вмешательства.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import fc from "fast-check";
import { tempDir } from "../fixtures/temp-dir.ts";

const root = tempDir("iva-ingress-pbt-");
process.env.ASSISTANT_DATA_DIR = join(root, "data");
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_BOT_TOKEN = "1:test-token";

const { processTelegramUpdate } = await import("./main.ts");

const OFFSET = 100;

type Update = Parameters<typeof processTelegramUpdate>[0];

const owner = { id: 42, is_bot: false, first_name: "Owner" };

function messageUpdate(
  updateId: number,
  message: Record<string, unknown>,
): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 1, type: "private" },
      from: owner,
      text: "привет",
      ...message,
    },
  };
}

/**
 * Результат обработки: сместился ли offset, был ли заблокирован вход и какие строки
 * ушли в журнал.
 */
async function run(
  update: Update,
  offsets: number[] = [],
  lines: string[] = [],
): Promise<{ offset: number; ingressBlocked: boolean }> {
  return processTelegramUpdate(update, OFFSET, {
    handleControlImpl: () => Promise.resolve(false),
    saveOffsetImpl: (nextOffset) => {
      offsets.push(nextOffset);
      return Promise.resolve();
    },
    logImpl: (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    },
  });
}

// Вектор: message без from (sender_chat есть, отправителя нет). Входа в очередь
// у такого апдейта быть не может, значит и задерживать его нельзя.
const anonymousAdmin = messageUpdate(101, {
  chat: { id: -100, type: "supergroup" },
  from: undefined,
  sender_chat: { id: -100, type: "supergroup", title: "Team" },
  text: "@my_bot помоги",
});

await test("апдейт без опознаваемого отправителя не клинит offset (seed 20260920)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("sender_chat", "no_from_private", "from_without_id"),
      async (variant) => {
        const update =
          variant === "sender_chat"
            ? anonymousAdmin
            : variant === "no_from_private"
              ? messageUpdate(102, { from: undefined, text: "@my_bot помоги" })
              : messageUpdate(103, {
                  from: { is_bot: false, first_name: "Owner" },
                });
        const result = await run(update);
        assert.equal(
          result.ingressBlocked,
          false,
          `апдейт без опознаваемого отправителя (${variant}) заблокировал вход навсегда`,
        );
        assert.equal(
          result.offset,
          update.update_id + 1,
          "offset обязан сдвинуться мимо неопознаваемого апдейта",
        );
      },
    ),
    { seed: 20_260_920, numRuns: 1 },
  );
});

// Контракт починки: апдейт, который приём навсегда не может опознать, подтверждается
// и оставляет в журнале одну строку с update_id и причиной - молча ничего не пропадает.
await test("НАХОДКА H2: неподтверждаемый апдейт оставляет строку в журнале", async () => {
  const lines: string[] = [];
  const result = await run(anonymousAdmin, [], lines);
  assert.equal(result.ingressBlocked, false);
  assert.ok(
    lines.some(
      (line) =>
        line.includes(String(anonymousAdmin.update_id)) &&
        line.includes("no durable ingress key"),
    ),
    `журнал не назвал апдейт: ${JSON.stringify(lines)}`,
  );
});

await test("служебный тип апдейта не клинит offset (страховка на будущие типы)", async () => {
  const types: Record<string, Update> = {
    edited_message: {
      update_id: 201,
      edited_message: messageUpdate(201, {}).message,
    },
    channel_post: {
      update_id: 202,
      channel_post: messageUpdate(202, {}).message,
    },
    chat_member: {
      update_id: 203,
      chat_member: { chat: { id: -100 } },
    },
    my_chat_member: {
      update_id: 204,
      my_chat_member: { chat: { id: 1 } },
    },
    message_reaction: {
      update_id: 205,
      message_reaction: { chat: { id: 1 } },
    },
    callback_without_message: {
      update_id: 206,
      callback_query: { id: "cb-206", from: owner, data: "menu" },
    },
  };
  for (const [name, update] of Object.entries(types)) {
    const result = await run(update);
    assert.equal(
      result.ingressBlocked,
      false,
      `служебный апдейт ${name} заблокировал вход навсегда`,
    );
  }
});

await test("неопознаваемый апдейт в голове пачки не задерживает следующее живое сообщение", async () => {
  const offsets: number[] = [];
  const first = await run(anonymousAdmin, offsets);
  assert.equal(
    first.ingressBlocked,
    false,
    "неопознаваемый апдейт заблокировал пачку — живое сообщение за ним не доедет",
  );
  const second = await run(
    messageUpdate(102, { text: "обычное сообщение" }),
    offsets,
  );
  assert.equal(second.ingressBlocked, false);
  assert.deepEqual(offsets, [102, 103], "оба апдейта обязаны подтвердиться");
});

await test("контроль: гигантский callback_query владеем и не блокирует вход", async () => {
  const result = await run({
    update_id: 501,
    callback_query: {
      id: "cb-501",
      from: owner,
      data: "y".repeat(100_000),
      message: {
        message_id: 501,
        date: 1,
        chat: { id: 1, type: "private" },
        from: owner,
      },
    },
  });
  assert.equal(result.ingressBlocked, false);
});

await test("контроль: обычное сообщение владельца принимается и двигает offset", async () => {
  const offsets: number[] = [];
  const result = await run(
    messageUpdate(301, { text: "обычное сообщение" }),
    offsets,
  );
  assert.deepEqual(result, { offset: 302, ingressBlocked: false });
  assert.deepEqual(offsets, [302]);
});

await test("контроль: отказ записи (ENOSPC) по-прежнему ждёт и не теряет апдейт", async () => {
  const result = await processTelegramUpdate(
    messageUpdate(401, { text: "не записалось" }),
    OFFSET,
    {
      handleControlImpl: () => Promise.resolve(false),
      admitImpl: () => Promise.resolve("write-failed"),
      saveOffsetImpl: () => Promise.resolve(),
      logImpl: () => {},
    },
  );
  assert.deepEqual(
    result,
    { offset: OFFSET, ingressBlocked: true },
    "транзиентный отказ записи обязан ждать следующего тика, а не терять апдейт",
  );
});
