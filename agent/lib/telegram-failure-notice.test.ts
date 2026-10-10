import test from "node:test";
import assert from "node:assert/strict";
import { noticeSender } from "./outbox.ts";
import {
  notifyTelegramFailure,
  telegramFailureMessage,
} from "./telegram-failure-notice.ts";

// Собираем ровно то, что увидел бы Bot API: отправку модуль принимает только
// брендованную, поэтому коллектор оборачивается тем же швом, что и канал.
function collector() {
  const sent: string[] = [];
  return {
    sent,
    send: noticeSender((text: string) => {
      sent.push(text);
      return Promise.resolve(null);
    }),
  };
}

await test("turn.failed и session.failed об одной сессии объясняют сбой один раз", async () => {
  const { sent, send } = collector();
  const data = { message: "provider exploded" };

  await notifyTelegramFailure("s-1", "turn_0", data, send, { now: 1_000 });
  await notifyTelegramFailure("s-1", null, data, send, { now: 1_050 });

  assert.equal(sent.length, 1);
});

await test("два упавших хода одной сессии внутри минуты объясняются оба, один ход - один раз", async () => {
  const { sent, send } = collector();
  const data = { message: "provider exploded" };

  await notifyTelegramFailure("s-turns", "turn_0", data, send, { now: 1_000 });
  await notifyTelegramFailure("s-turns", "turn_1", data, send, { now: 1_050 });
  assert.equal(sent.length, 2);

  await notifyTelegramFailure("s-turns", "turn_1", data, send, { now: 1_100 });
  assert.equal(sent.length, 2);

  await notifyTelegramFailure("s-turns", null, data, send, { now: 1_150 });
  assert.equal(sent.length, 2);

  // Обратный порядок того же сбоя: заявку первым взял session.failed (null),
  // поэтому названный ход в окне молчит, а не объясняет ту же беду второй раз.
  await notifyTelegramFailure("s-null-first", null, data, send, { now: 2_000 });
  await notifyTelegramFailure("s-null-first", "turn_9", data, send, {
    now: 2_050,
  });
  assert.equal(sent.length, 3);
});

await test("ход без имени считается по сессии и говорит об этом в журнал", async (t) => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.error = original;
  });
  const { sent, send } = collector();
  const data = { message: "provider exploded" };

  await notifyTelegramFailure("s-noname", "", data, send, { now: 1_000 });
  await notifyTelegramFailure("s-noname", "", data, send, { now: 1_050 });

  assert.equal(sent.length, 1);
  assert.ok(
    logged.some((line) => line.includes("turnId")),
    `ожидалась строка про turnId в журнале, получено: ${JSON.stringify(logged)}`,
  );
});

await test("другая сессия и повтор после TTL получают своё объяснение", async () => {
  const { sent, send } = collector();
  const data = { message: "provider exploded" };

  await notifyTelegramFailure("s-2", "turn_0", data, send, { now: 1_000 });
  await notifyTelegramFailure("s-3", "turn_0", data, send, { now: 1_000 });
  await notifyTelegramFailure("s-2", "turn_0", data, send, { now: 61_001 });

  assert.equal(sent.length, 3);
});

await test("несостоявшаяся отправка возвращает заявку следующему событию", async () => {
  const { sent, send } = collector();
  const data = { message: "provider exploded" };

  await notifyTelegramFailure(
    "s-4",
    "turn_0",
    data,
    noticeSender(() => Promise.reject(new Error("Telegram 502"))),
    { now: 1_000 },
  );
  await notifyTelegramFailure("s-4", "turn_0", data, send, { now: 1_100 });

  assert.equal(sent.length, 1);
});

// Error id владельцу ничего не говорит: он остаётся в журнале и Trace, в чат не идёт.
await test("errorId не идёт в чат, мусорные details текст не ломают", () => {
  for (const details of [
    { errorId: "err-77" },
    null,
    "err",
    ["err-77"],
    { errorId: 7 },
    undefined,
  ]) {
    const text = telegramFailureMessage({ message: "boom", details });
    assert.doesNotMatch(text, /Error id|err-77/u);
    assert.ok(text.length > 0);
  }
});

await test("обрыв посреди ответа: в чат идёт вопрос и кнопка «Повторить» на языке владельца", () => {
  const text = telegramFailureMessage(
    {
      message:
        "api.anthropic.com did not finish the response (the stream broke off before message_stop)",
      details: { errorId: "err-78", attempts: 1, answerStarted: true },
    },
    "claude",
  );
  assert.match(text, /Anthropic/u);
  assert.match(
    text,
    /<tg-button type="callback_data" data="(Повторить|Try again)">/u,
  );
  assert.doesNotMatch(text, /err-78|Error id/u);
});

// #284: молчание модели повторяется в длинном разговоре — в чат доезжает подсказка про /new,
// и Gate её не режет. Ошибка дословно из provider.ts.
await test("молчание модели: в чат доезжает подсказка про /new без кнопки", async () => {
  const { sent, send } = collector();

  await notifyTelegramFailure(
    "s-silent",
    "turn_14",
    {
      message: "Model produced no output for 90s",
      details: { code: "MODEL_FIRST_CHUNK_TIMEOUT", attempts: 3 },
    },
    send,
    { now: 1_000 },
  );

  assert.equal(sent.length, 1);
  assert.match(
    sent[0],
    /(Если в этом разговоре так уже было, \/new начнёт заново: длинный разговор мог стать модели не по силам\.|If this already happened in this conversation, \/new starts over: a long conversation may have become too much for the model\.)$/u,
  );
  assert.doesNotMatch(sent[0], /tg-button/u);
});

// Служебная реплика канала не идёт через Outbox, но текст провайдера в ней —
// такой же runtime-контент: Gate обязан вычистить его до транспорта.
function muteErrors(t: { after: (fn: () => void) => void }): void {
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
}

const PLANTED_KEY = `api_key=${"z".repeat(24)}`;
const PLANTED_BOT_TOKEN = `1234567890:${"A".repeat(35)}`;

await test("ключ из ошибки провайдера доезжает до чата отредактированным", async (t) => {
  muteErrors(t);
  const { sent, send } = collector();

  await notifyTelegramFailure(
    "s-key",
    "turn_0",
    { message: `Incorrect API key provided: ${PLANTED_KEY}` },
    send,
    { now: 1_000 },
  );

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /zzzz/u);
});

await test("пустая ошибка остаётся объяснимой, а не пустым сообщением", (t) => {
  muteErrors(t);

  assert.match(telegramFailureMessage({ message: "" }, "codex"), /OpenAI/u);
});

// errorId приходит из eve нетронутым и в чат не идёт вовсе.
await test("секрет в errorId не доезжает до чата", async (t) => {
  muteErrors(t);
  const { sent, send } = collector();

  await notifyTelegramFailure(
    "s-error-id",
    "turn_0",
    {
      message: "Provider returned a strange response",
      details: { errorId: PLANTED_KEY },
    },
    send,
    { now: 1_000 },
  );

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /zzzz|Error id/u);
});

await test("многострочная ошибка: в чат уходит первая строка, и та без секрета", async (t) => {
  muteErrors(t);
  const { sent, send } = collector();

  await notifyTelegramFailure(
    "s-multiline",
    "turn_0",
    {
      message: `Provider returned a strange response ${PLANTED_KEY}\nstack line ${PLANTED_KEY}`,
      details: { errorId: "err-9" },
    },
    send,
    { now: 1_000 },
  );

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /zzzz/u);
  assert.doesNotMatch(sent[0], /stack line|err-9/u);
});

await test("телеграм-токен и ключ в одной ошибке редактятся оба", async (t) => {
  muteErrors(t);
  const { sent, send } = collector();

  await notifyTelegramFailure(
    "s-both",
    "turn_0",
    { message: `bot ${PLANTED_BOT_TOKEN} rejected: ${PLANTED_KEY}` },
    send,
    { now: 1_000 },
  );

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /zzzz/u);
  assert.doesNotMatch(sent[0], /AAAA/u);
});

// Живой формат ключа, а не удобный планту: ключ OpenRouter из .env этой инсталляции
// в ошибке, которую humanizeProviderError ни к одной категории не относит.
const OPENROUTER_KEY = `sk-or-v1-${"4f9c1e77ab3d5602".repeat(4)}`;

await test("ключ провайдера настоящего формата не переживает уведомление о сбое", async (t) => {
  muteErrors(t);
  const { sent, send } = collector();

  await notifyTelegramFailure(
    "s-openrouter",
    "turn_0",
    { message: `Provider rejected the request for key ${OPENROUTER_KEY}` },
    send,
    { now: 1_000 },
  );

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /sk-or-v1|4f9c1e77/u);
});
