// Шумовые свойства входа Telegram: непредсказуемый пользователь пишет в группе,
// присылает мусор в апдейте, повторяет доставку.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fc from "fast-check";
import { tempDir } from "../../scripts/fixtures/temp-dir.ts";

const root = tempDir("iva-telegram-inbound-pbt-");
process.env.ASSISTANT_DATA_DIR = join(root, "data");
process.env.ASSISTANT_VAULT_DIR = join(root, "vault");
process.env.ASSISTANT_TIMEZONE = "UTC";
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.TELEGRAM_BOT_TOKEN = "1:test-token";
const modulePath = fileURLToPath(
  new URL("./telegram-inbound.ts", import.meta.url),
);
const inbound = (await import(
  pathToFileURL(modulePath).href
)) as typeof import("./telegram-inbound.ts");
const { noticeSender } = await import("./outbox.ts");

type Message = Parameters<typeof inbound.runTelegramInbound>[0];
type Effects = Parameters<typeof inbound.runTelegramInbound>[1];

const BOT = "iva_bot";

function harness(overrides: Partial<Effects> = {}) {
  const calls = { accepted: 0, sent: [] as string[] };
  const effects: Effects = {
    botUsername: BOT,
    request: () => Promise.resolve({ body: {} }),
    sendMessage: noticeSender((text) => {
      calls.sent.push(text);
      return Promise.resolve(null);
    }),
    startTyping: () => Promise.resolve(),
    describeImage: () => Promise.resolve(""),
    chatModelSeesImages: () => Promise.resolve(false),
    transcribe: () => Promise.resolve(""),
    onAccepted: () => {
      calls.accepted += 1;
      return Promise.resolve();
    },
    onAbandoned: () => Promise.resolve(),
    consumeCancelledMark: () => false,
    ...overrides,
  };
  return { calls, effects };
}

/** Групповое сообщение от allowlisted-пользователя 42 с готовым текстом. */
function groupText(text: string, extra: Record<string, unknown> = {}) {
  return {
    attachments: [],
    caption: "",
    chat: { id: "-100500", type: "supergroup" },
    from: { id: "42", isBot: false },
    messageId: "5",
    raw: {
      message_id: 5,
      chat: { id: -100500, type: "supergroup" },
      from: { id: 42, is_bot: false },
      text,
      ...extra,
    },
    text,
  } satisfies Message;
}

// Продолжение ника после имени бота: буквы/цифры/подчёркивание — то, чем Telegram
// продолжает юзернейм. Реальное упоминание бота всегда стоит на границе ника.
const handleTail = fc
  .array(fc.constantFrom(..."abcXYZ019_"), { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join(""));

await test("упоминание чужого ника с именем бота в начале не будит бота в группе", async () => {
  // Минимальный контрпример, который находит и генератор: @iva_bota при боте iva_bot.
  const minimal = harness();
  assert.equal(
    await inbound.runTelegramInbound(
      groupText("@iva_bota посмотри, пожалуйста"),
      minimal.effects,
    ),
    null,
  );
  assert.equal(minimal.calls.accepted, 0);

  await fc.assert(
    fc.asyncProperty(handleTail, async (tail) => {
      const { calls, effects } = harness();
      await inbound.runTelegramInbound(
        groupText(`@iva_bot${tail} привет`),
        effects,
      );
      assert.equal(
        calls.accepted,
        0,
        `групповое сообщение @iva_bot${tail} — упоминание чужого ника, не бота`,
      );
    }),
    { seed: 20_260_912, numRuns: 100 },
  );
});

await test("короткое имя бота не ловит чужие ники с тем же началом", async () => {
  // Живой случай: бот @iva, в группе пишут @ivan или @ivanna.
  const { calls, effects } = harness({ botUsername: "iva" });
  assert.equal(
    await inbound.runTelegramInbound(
      groupText("@ivan привет, ты сегодня свободен?"),
      effects,
    ),
    null,
  );
  assert.equal(calls.accepted, 0);
});

await test("точное упоминание бота в группе доезжает (положительный контроль)", async () => {
  const { calls, effects } = harness();
  await inbound.runTelegramInbound(groupText(`@${BOT} привет`), effects);
  assert.equal(calls.accepted, 1);
});

await test("произвольный мусор в апдейте не бросает исключение", async () => {
  const junk = fc.jsonValue({ maxDepth: 4 });
  await fc.assert(
    fc.asyncProperty(junk, async (value) => {
      const raw =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : { value };
      const message: Message = {
        attachments: [],
        caption: "",
        chat: { id: "77", type: "private" },
        from: { id: "42", isBot: false },
        messageId: "5",
        raw: {
          message_id: 5,
          chat: { id: 77, type: "private" },
          from: { id: 42, is_bot: false },
          text: "мусор",
          ...raw,
        },
        text: "мусор",
      };
      const { effects } = harness();
      const turn = await inbound.runTelegramInbound(message, effects);
      if (turn !== null) {
        const modelText = [message.text, ...(turn.context ?? [])];
        assert.equal(modelText[0], "мусор");
        assert.equal(turn.auth?.principalId, "telegram:42");
        for (const line of modelText) assert.equal(typeof line, "string");
      }
    }),
    { seed: 20_260_913, numRuns: 300 },
  );
});
