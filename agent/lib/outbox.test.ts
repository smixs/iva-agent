import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import {
  htmlToPlain,
  richQuoteLine,
  sanitizeTelegramHtml,
} from "./telegram-format.ts";
import {
  noticeSender,
  redactNotice,
  sendThroughOutbox,
  type OutboxAck,
  type OutboxTransport,
} from "./outbox.ts";

// Журнал хода (ADR-0010) пишется и отсюда: вердикт outbound-Gate на каждом вызове гейта и
// исход доставки на каждую отправку. Каталог данных — временный, писатель резолвит его на
// каждой записи, поэтому окружение можно выставить и после импорта шва.
const traceRoot = mkdtempSync(join(tmpdir(), "iva-outbox-trace-"));
process.env.ASSISTANT_DATA_DIR = join(traceRoot, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
const trace = await import("./trace.ts");
// Уборка на выходе процесса, а НЕ через after(): файл регистрирует тесты через
// `await test(...)`, и корневой хук успевает сработать посреди файла.
process.on("exit", () => rmSync(traceRoot, { recursive: true, force: true }));

function traceEvents(): Record<string, unknown>[] {
  try {
    return readFileSync(
      trace.traceFilePath(trace.traceDay(), process.env.ASSISTANT_DATA_DIR),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return []; // журнала ещё нет — событий тоже
  }
}

const SECRET = `sk-${"a".repeat(24)}`;

type Sent = { kind: "rich" | "html" | "plain"; text: string };

type Replies = {
  rich?: (markdown: string) => OutboxAck;
  html?: (html: string, index: number) => OutboxAck;
  plain?: (text: string) => OutboxAck;
};

// Транспорт-заглушка: помнит всё, что шов реально отдал наружу, и отвечает по плану.
// sendRich появляется только когда план его описывает — как у настоящих транспортов.
function stub(replies: Replies = {}) {
  const sent: Sent[] = [];
  let htmlCalls = 0;
  const transport: OutboxTransport = {
    sendHtml(html) {
      sent.push({ kind: "html", text: html });
      return Promise.resolve(replies.html?.(html, htmlCalls++) ?? { ok: true });
    },
    sendPlain(text) {
      sent.push({ kind: "plain", text });
      return Promise.resolve(replies.plain?.(text) ?? { ok: true });
    },
  };
  if (replies.rich) {
    const rich = replies.rich;
    transport.sendRich = (markdown) => {
      sent.push({ kind: "rich", text: markdown });
      return Promise.resolve(rich(markdown));
    };
  }
  return { sent, transport };
}

await test("HTML transport receives intact link addresses from Markdown", async () => {
  const { sent, transport } = stub();
  const result = await sendThroughOutbox(
    "_до_ [название](https://ru.wikipedia.org/wiki/Крауч,_Блейк), [сюжет](https://en.wikipedia.org/wiki/Recursion_(Crouch_novel)). *после*",
    transport,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(sent, [
    {
      kind: "html",
      text: '<i>до</i> <a href="https://ru.wikipedia.org/wiki/Крауч,_Блейк">название</a>, <a href="https://en.wikipedia.org/wiki/Recursion_(Crouch_novel)">сюжет</a>. <i>после</i>',
    },
  ]);
});

// Гейт логирует находки в console.error — ловим лог, не подменяя поведение доставки.
function captureErrors(t: { after: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  t.after(() => {
    console.error = original;
  });
  return lines;
}

await test("Gate редактит утёкший секрет до транспорта и логирует находку", async (t) => {
  const logged = captureErrors(t);
  const { sent, transport } = stub();

  const result = await sendThroughOutbox(`ключ: ${SECRET} — держи`, transport);

  assert.deepEqual(result, {
    ok: true,
    delivered: 1,
    fellBack: false,
    error: "",
  });
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].text.includes(SECRET));
  assert.ok(sent[0].text.includes("[REDACTED]"));
  assert.equal(logged.length, 1);
  assert.ok(logged[0].startsWith("[security] outbound leak redacted:"));
  assert.ok(logged[0].includes("api_key:openai"));
});

await test("чистое сообщение уходит без записи в лог", async (t) => {
  const logged = captureErrors(t);
  const { sent, transport } = stub();

  const result = await sendThroughOutbox("обычный ответ", transport);

  assert.equal(result.ok, true);
  assert.deepEqual(
    sent.map((s) => s.kind),
    ["html"],
  );
  assert.deepEqual(logged, []);
});

await test("секрет не выживает ни на одном маршруте доставки", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub({
    // Таблица уводит в rich, rich отвергнут, HTML тоже — остаётся plain-фолбэк.
    rich: () => ({ ok: false, error: "rich rejected", retryPlain: false }),
    html: () => ({ ok: false, error: "400: bad entities", retryPlain: true }),
  });

  const result = await sendThroughOutbox(
    `| ключ | значение |\n|---|---|\n| api | ${SECRET} |`,
    transport,
  );

  assert.equal(result.ok, true);
  assert.equal(result.fellBack, true);
  assert.deepEqual(
    sent.map((s) => s.kind),
    ["rich", "html", "plain"],
  );
  for (const message of sent) assert.ok(!message.text.includes(SECRET));
});

await test("длинное сообщение режется на чанки в пределах лимита", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub();

  const result = await sendThroughOutbox(
    Array.from({ length: 400 }, (_, i) => `строка ${i} с текстом`).join("\n\n"),
    transport,
  );

  assert.equal(result.ok, true);
  assert.ok(result.delivered > 1);
  assert.equal(sent.length, result.delivered);
  for (const message of sent) {
    assert.equal(message.kind, "html");
    assert.ok(message.text.length <= 4096);
    assert.ok(message.text.length > 0);
  }
  assert.ok(sent.at(-1)?.text.includes("строка 399"));
});

await test("лимит подписи режет мельче стандартного", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub();

  const result = await sendThroughOutbox(
    Array.from({ length: 200 }, (_, i) => `подпись ${i}`).join("\n\n"),
    transport,
    { limit: 1024 },
  );

  assert.equal(result.ok, true);
  assert.ok(sent.length > 1);
  for (const message of sent) assert.ok(message.text.length <= 1024);
});

await test("пустой рендер — провал шва, а не успех с нулём доставок", async (t) => {
  captureErrors(t);
  for (const message of ["", "   ", "\n\t \n"]) {
    const { sent, transport } = stub();
    const result = await sendThroughOutbox(message, transport);
    assert.deepEqual(result, {
      ok: false,
      delivered: 0,
      fellBack: false,
      error: "nothing delivered: empty rendering",
    });
    assert.deepEqual(sent, []);
  }
});

await test("разметка экранируется, а plain-фолбэк её декодирует", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub({
    html: () => ({ ok: false, error: "400: bad entities", retryPlain: true }),
  });

  const result = await sendThroughOutbox(
    "<script>alert(1)</script> & <b>жирный</b>",
    transport,
  );

  assert.equal(result.ok, true);
  assert.equal(result.fellBack, true);
  assert.equal(result.delivered, 1);
  const [html, plain] = sent;
  assert.equal(html.kind, "html");
  assert.ok(html.text.includes("&lt;script&gt;"));
  assert.ok(!html.text.includes("<script>"));
  assert.equal(plain.kind, "plain");
  assert.ok(plain.text.includes("<script>alert(1)</script>"));
  assert.ok(!plain.text.includes("&lt;"));
  assert.ok(!plain.text.includes("&amp;"));
});

const LONG_MESSAGE = Array.from(
  { length: 400 },
  (_, i) => `строка ${i} с текстом`,
).join("\n\n");

// Сколько чанков даёт LONG_MESSAGE — считаем доставкой без единого отказа, чтобы
// тесты ниже говорили «все, кроме одного», а не сверялись с магическим числом.
async function chunkCount(message: string): Promise<number> {
  const { sent, transport } = stub();
  await sendThroughOutbox(message, transport);
  return sent.length;
}

await test("сбой одного чанка не хоронит остальные", async (t) => {
  captureErrors(t);
  const total = await chunkCount(LONG_MESSAGE);
  const { sent, transport } = stub({
    html: (_html, index) =>
      index === 0
        ? { ok: false, error: "429: too many requests", retryPlain: false }
        : { ok: true },
  });

  const result = await sendThroughOutbox(LONG_MESSAGE, transport);

  // Пользователь теряет один кусок ответа, а не весь хвост: остальные чанки ушли.
  assert.deepEqual(result, {
    ok: false,
    delivered: total - 1,
    fellBack: false,
    error: "429: too many requests",
  });
  assert.equal(sent.length, total);
  assert.ok(sent.at(-1)?.text.includes("строка 399"));
});

await test("stop от транспорта обрывает доставку хвоста", async (t) => {
  captureErrors(t);
  const total = await chunkCount(LONG_MESSAGE);
  const { sent, transport } = stub({
    html: (_html, index) =>
      index === 0
        ? {
            ok: false,
            error: "429: flood control",
            retryPlain: false,
            stop: true,
          }
        : { ok: true },
  });

  const result = await sendThroughOutbox(LONG_MESSAGE, transport);

  // Telegram душит бота — шов не долбит его оставшимися 45 запросами.
  assert.ok(total > 1);
  assert.deepEqual(result, {
    ok: false,
    delivered: 0,
    fellBack: false,
    error: "429: flood control",
  });
  assert.equal(sent.length, 1);
});

await test("stop на plain-повторе обрывает доставку хвоста", async (t) => {
  captureErrors(t);
  const total = await chunkCount(LONG_MESSAGE);
  const { sent, transport } = stub({
    html: (_html, index) =>
      index === 0
        ? { ok: false, error: "400: bad entities", retryPlain: true }
        : { ok: true },
    plain: () => ({
      ok: false,
      error: "403: bot was blocked",
      retryPlain: false,
      stop: true,
    }),
  });

  const result = await sendThroughOutbox(LONG_MESSAGE, transport);

  assert.ok(total > 1);
  assert.deepEqual(result, {
    ok: false,
    delivered: 0,
    fellBack: true,
    error: "plain retry 403: bot was blocked",
  });
  assert.deepEqual(
    sent.map((s) => s.kind),
    ["html", "plain"],
  );
});

await test("провал plain-повтора помечает шов, но доставка продолжается", async (t) => {
  captureErrors(t);
  const total = await chunkCount(LONG_MESSAGE);
  const { sent, transport } = stub({
    html: (_html, index) =>
      index === 0
        ? { ok: false, error: "400: bad entities", retryPlain: true }
        : { ok: true },
    plain: () => ({ ok: false, error: "500: server error", retryPlain: false }),
  });

  const result = await sendThroughOutbox(LONG_MESSAGE, transport);

  assert.deepEqual(result, {
    ok: false,
    delivered: total - 1,
    fellBack: true,
    error: "plain retry 500: server error",
  });
  assert.equal(sent.filter((s) => s.kind === "plain").length, 1);
  assert.equal(sent.filter((s) => s.kind === "html").length, total);
});

await test("шов сообщает первую ошибку, даже если упало несколько чанков", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub({
    html: (_html, index) => ({
      ok: false,
      error: `50${index}: server error`,
      retryPlain: false,
    }),
  });

  const result = await sendThroughOutbox(LONG_MESSAGE, transport);

  assert.equal(result.ok, false);
  assert.equal(result.delivered, 0);
  assert.equal(result.error, "500: server error");
  assert.ok(sent.length > 1);
});

await test("единственный чанк, упавший дважды, возвращается с пометкой повтора", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub({
    html: () => ({ ok: false, error: "400: bad entities", retryPlain: true }),
    plain: () => ({ ok: false, error: "500: server error", retryPlain: false }),
  });

  const result = await sendThroughOutbox("ответ", transport);

  assert.deepEqual(result, {
    ok: false,
    delivered: 0,
    fellBack: true,
    error: "plain retry 500: server error",
  });
  assert.deepEqual(
    sent.map((s) => s.kind),
    ["html", "plain"],
  );
});

await test("таблица уходит одним rich-сообщением, обычный текст — нет", async (t) => {
  captureErrors(t);
  const rich = stub({ rich: () => ({ ok: true }) });
  const richResult = await sendThroughOutbox(
    "| a | b |\n|---|---|\n| 1 | 2 |",
    rich.transport,
  );
  assert.deepEqual(richResult, {
    ok: true,
    delivered: 1,
    fellBack: false,
    error: "",
  });
  assert.deepEqual(
    rich.sent.map((s) => s.kind),
    ["rich"],
  );

  const prose = stub({ rich: () => ({ ok: true }) });
  await sendThroughOutbox("просто текст", prose.transport);
  assert.deepEqual(
    prose.sent.map((s) => s.kind),
    ["html"],
  );
});

await test("alwaysRich шлёт rich даже без rich-конструкций в тексте", async (t) => {
  captureErrors(t);
  const post = stub({ rich: () => ({ ok: true }) });

  // Пост из абзаца и картинки — needsRichMessage тут false, но rich выбрал вызывающий
  // (`iva post`), и HTML-путь картинку не отрисует вовсе.
  const result = await sendThroughOutbox(
    "абзац\n\n![](https://example.com/a.jpg)",
    post.transport,
    { alwaysRich: true },
  );

  assert.equal(result.delivered, 1);
  assert.deepEqual(
    post.sent.map((s) => s.kind),
    ["rich"],
  );

  // Гейт стоит до выбора пути: секрет не уедет и rich-сообщением.
  const leaky = stub({ rich: () => ({ ok: true }) });
  await sendThroughOutbox(`токен ${SECRET}`, leaky.transport, {
    alwaysRich: true,
  });
  assert.equal(leaky.sent[0].text.includes(SECRET), false);
});

await test("отказ rich-сообщения проваливается в HTML-путь", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub({
    rich: () => ({
      ok: false,
      error: "400: rich unsupported",
      retryPlain: false,
    }),
  });

  const result = await sendThroughOutbox(
    "| a | b |\n|---|---|\n| 1 | 2 |",
    transport,
  );

  assert.equal(result.ok, true);
  assert.equal(result.delivered, 1);
  // Таблица на HTML-пути — обычное поведение до rich, не потеря: fellBack не ставится.
  assert.equal(result.fellBack, false);
  assert.equal(result.error, "");
  assert.deepEqual(
    sent.map((s) => s.kind),
    ["rich", "html"],
  );
});

await test("rich → HTML preserves escaped quotes and labels in button rows (seed 241024)", async () => {
  const text = fc.string({
    unit: fc.constantFrom(...'ab*_#|`[]()~$&\\<>"', "я", "😀"),
    maxLength: 30,
  });
  await fc.assert(
    fc.asyncProperty(
      text,
      fc.boolean(),
      fc.array(fc.array(text, { minLength: 1, maxLength: 4 }), {
        minLength: 1,
        maxLength: 3,
      }),
      async (question, grouped, rows) => {
        const visible = (value: string) =>
          value.replaceAll("<", "‹").replaceAll(">", "›");
        const quote = `Вопрос:${question}:конец`;
        const labels = rows.map((row) =>
          row.map((label) => `Выбор:${label}:конец`),
        );
        const markdown =
          `> ${richQuoteLine(quote, 120)}\n\n` +
          labels
            .map((row) => {
              const buttons = row.map(
                (label) =>
                  `<tg-button type="callback_data" data="ok">${richQuoteLine(label, 120)}</tg-button>`,
              );
              return grouped
                ? `<tg-button-row>${buttons.join("")}</tg-button-row>`
                : buttons.join("\n");
            })
            .join("\n");
        const { sent, transport } = stub({
          rich: () => ({
            ok: false,
            error: "400: rich unsupported",
            retryPlain: false,
          }),
        });
        const result = await sendThroughOutbox(markdown, transport);
        assert.equal(result.ok, true);
        assert.equal(result.fellBack, true);
        assert.deepEqual(
          sent.map((entry) => entry.kind),
          ["rich", "html"],
        );
        const html = sent[1].text;
        assert.equal(sanitizeTelegramHtml(html), html);
        assert.doesNotMatch(html, /tg-button/u);
        assert.deepEqual(
          [...html.matchAll(/<blockquote>([\s\S]*?)<\/blockquote>/gu)].map(
            (match) => htmlToPlain(match[1]),
          ),
          [visible(quote)],
        );
        assert.deepEqual(
          [...html.matchAll(/<b>([\s\S]*?)<\/b>/gu)].map((match) =>
            htmlToPlain(match[1]),
          ),
          labels.flat().map(visible),
        );
        assert.equal(
          htmlToPlain(html).replace(/\s+/gu, " ").trim(),
          [quote, ...labels.flat()].map(visible).join(" "),
        );
      },
    ),
    { seed: 241024, numRuns: 500 },
  );
});

await test("кнопки, потерянные на HTML-пути, видны в результате и в Trace", async (t) => {
  captureErrors(t);
  const { sent, transport } = stub({
    rich: () => ({
      ok: false,
      error: "sendRichMessage 400: Bad Request: BUTTON_DATA_INVALID",
      retryPlain: false,
    }),
  });
  const text =
    'Готово.\n\n<tg-button type="callback_data" data="Да">Да</tg-button> — подтвердить.';
  const before = traceEvents().length;

  const result = await trace.traceOutbox(
    { turn: "turn_btn", session: "wrun_btn", source: "telegram" },
    text,
    () => sendThroughOutbox(text, transport),
  );

  // Ответ доставлен HTML-путём, но владелец видит, что кнопки потерялись и почему.
  assert.equal(result.ok, true);
  assert.equal(result.delivered, 1);
  assert.equal(result.fellBack, true);
  assert.match(result.error, /^buttons dropped: .*BUTTON_DATA_INVALID/u);
  assert.deepEqual(
    sent.map((s) => s.kind),
    ["rich", "html"],
  );
  const event = traceEvents().slice(before).at(-1) as Record<string, unknown>;
  assert.equal(event.name, "delivered");
  const data = event.data as Record<string, unknown>;
  assert.equal(data.fellBack, true);
  assert.match(String(data.error), /BUTTON_DATA_INVALID/u);
});

await test("длинный data кнопки укорачивается до 64 байт до отправки rich", async (t) => {
  const logged = captureErrors(t);
  const { sent, transport } = stub({ rich: () => ({ ok: true }) });
  const data = "Задачи: закрыть тесты, привычки без срока";

  const result = await sendThroughOutbox(
    `<tg-button type="callback_data" data="${data}">Закрыть</tg-button> — закрою.`,
    transport,
  );

  assert.equal(result.ok, true);
  assert.equal(result.fellBack, false);
  assert.equal(sent.length, 1);
  const sentData = /\sdata="([^"]*)"/u.exec(sent[0].text)?.[1] ?? "";
  assert.ok(Buffer.byteLength(sentData) <= 64);
  assert.ok(data.startsWith(sentData));
  assert.deepEqual(logged, ["[telegram] button data shortened: 75 → 64"]);
});

await test("redactNotice проводит служебное уведомление через тот же Gate", (t) => {
  const logged = captureErrors(t);
  const planted = `api_key=${"z".repeat(24)}`;

  const text = redactNotice(`build failed: ${planted}`);

  assert.equal(text, "build failed: [REDACTED]");
  assert.match(
    logged.join("\n"),
    /outbound leak redacted: api_key:generic_key/u,
  );
});

await test("redactNotice не трогает чистый текст и переживает пустой", (t) => {
  const logged = captureErrors(t);

  assert.equal(redactNotice("Iva обновлена"), "Iva обновлена");
  assert.equal(redactNotice(""), "");
  assert.deepEqual(logged, []);
});

await test("redactNotice чистит многострочное уведомление целиком", (t) => {
  captureErrors(t);
  const planted = `api_key=${"z".repeat(24)}`;

  const text = redactNotice(`line one\nline two ${planted}\nline three`);

  assert.equal(text, "line one\nline two [REDACTED]\nline three");
});

// noticeSender — тот самый шов служебных реплик: гейт приклеен к вызову Bot API,
// а не к месту, где текст собрали.
await test("noticeSender гейтит текст по дороге к транспорту и отдаёт его ответ", async (t) => {
  captureErrors(t);
  const sent: string[] = [];
  const send = noticeSender((text) => {
    sent.push(text);
    return Promise.resolve({ ok: true });
  });

  const ack = await send(`сборка упала: api_key=${"z".repeat(24)}`);

  assert.deepEqual(sent, ["сборка упала: [REDACTED]"]);
  assert.deepEqual(ack, { ok: true });
});

await test("noticeSender переживает пустую и многострочную реплику", async (t) => {
  captureErrors(t);
  const sent: string[] = [];
  const send = noticeSender((text) => {
    sent.push(text);
    return Promise.resolve(null);
  });

  await send("");
  await send(`строка\nвторая api_key=${"z".repeat(24)}\nтретья`);

  assert.deepEqual(sent, ["", "строка\nвторая [REDACTED]\nтретья"]);
});

await test("Trace: вердикт гейта и доставка ложатся в журнал одного хода", async () => {
  const { sent, transport } = stub();
  const before = traceEvents().length;

  const result = await trace.traceOutbox(
    { turn: "turn_5", session: "wrun_2", source: "telegram" },
    "готово",
    () => sendThroughOutbox("готово", transport),
  );

  assert.equal(result.delivered, 1);
  assert.equal(sent.length, 1);
  const added = traceEvents().slice(before);
  assert.deepEqual(
    added.map((event) => `${String(event.kind)}.${String(event.name)}`),
    ["gate.outbound", "outbox.delivered"],
  );
  // Вердикт гейта уезжает с ключом хода, хотя сигнатура redactNotice его не знает.
  assert.equal(added[0].turn, "turn_5");
  assert.equal(added[0].session, "wrun_2");
  assert.deepEqual(added[0].data, {
    clean: true,
    findings: [],
    chars: 6,
    textChars: 6,
    text: "готово",
  });
  const outbox = added[1];
  assert.equal(outbox.turn, "turn_5");
  assert.equal(outbox.session, "wrun_2");
  const data = outbox.data as Record<string, unknown>;
  assert.equal(data.ok, true);
  assert.equal(data.delivered, 1);
  assert.equal(data.chars, 6);
  assert.equal(typeof data.ms, "number");
});

await test("Trace: rich-путь даёт ровно одно событие доставки", async () => {
  const { sent, transport } = stub({ rich: () => ({ ok: true }) });
  const before = traceEvents().length;

  // Таблица уходит нативным rich-сообщением — своим путём, мимо HTML-чанков.
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  const result = await trace.traceOutbox(
    { turn: "turn_7", session: "wrun_3", source: "telegram" },
    table,
    () => sendThroughOutbox(table, transport),
  );

  assert.equal(result.delivered, 1);
  assert.deepEqual(
    sent.map((item) => item.kind),
    ["rich"],
  );
  const added = traceEvents().slice(before);
  assert.deepEqual(
    added.map((event) => `${String(event.kind)}.${String(event.name)}`),
    ["gate.outbound", "outbox.delivered"],
  );
  assert.equal(added[1].turn, "turn_7");
});

await test("Trace: находка гейта и провал доставки видны в журнале", async (t) => {
  captureErrors(t);
  const { transport } = stub({
    html: () => ({ ok: false, error: "flood control", retryPlain: false }),
  });
  const before = traceEvents().length;

  await trace.traceOutbox(
    { turn: "turn_6", session: "wrun_2", source: "telegram" },
    `ключ: ${SECRET}`,
    () => sendThroughOutbox(`ключ: ${SECRET}`, transport),
  );

  const added = traceEvents().slice(before);
  const gate = added[0].data as Record<string, unknown>;
  assert.equal(gate.clean, false);
  // Превью находки в журнал не едет: там кусок самого секрета.
  assert.deepEqual(gate.findings, ["api_key:openai"]);
  assert.equal(gate.chars, 33);
  // В журнал попадает текст ПОСЛЕ редактуры — вымаранный секрет назад не возвращается.
  assert.equal(String(gate.text).includes(SECRET), false);
  assert.ok(String(gate.text).includes("[REDACTED]"));
  assert.equal(added[1].name, "failed");
  const data = added[1].data as Record<string, unknown>;
  assert.equal(data.ok, false);
  assert.equal(data.delivered, 0);
  assert.equal(data.error, "flood control");
  assert.equal(JSON.stringify(added[1]).includes(SECRET), false);
});

await test("Trace: отправка вне хода журнал не трогает", async () => {
  const { transport } = stub();
  const before = traceEvents().length;

  // Ни cron без контекста, ни юнит-тест шва не имеют права писать в журнал: событие
  // без ключа хода читателю бесполезно, а файл растёт.
  await sendThroughOutbox("просто текст", transport);
  redactNotice("служебная реплика");

  assert.equal(traceEvents().length, before);
});

await test("a button the model wrote without type reaches Telegram with the type its attributes mean", async () => {
  // Случай c1: `<tg-button data=…>` без type — Telegram отверг rich message (400), части Watch
  // ушли HTML-путём, и вместо кнопок владелец получил жирные слова.
  const { sent, transport } = stub({ rich: () => ({ ok: true }) });

  await sendThroughOutbox(
    [
      "Кто-то ждёт ответа",
      '<tg-button-row><tg-button data="В задачи: Иван">В задачи</tg-button></tg-button-row>',
      '<tg-button-row><tg-button url="https://iva-agent.com">Сайт</tg-button></tg-button-row>',
      '<tg-button-row><tg-button text="ssh c1">Скопировать</tg-button></tg-button-row>',
      '<tg-button-row><tg-button type="callback_data" style="danger" data="Нет">Нет</tg-button></tg-button-row>',
    ].join("\n"),
    transport,
  );

  assert.deepEqual(
    sent.map((one) => one.kind),
    ["rich"],
  );
  assert.match(
    sent[0].text,
    /<tg-button type="callback_data" data="В задачи: Иван">/u,
  );
  assert.match(
    sent[0].text,
    /<tg-button type="url" url="https:\/\/iva-agent\.com">/u,
  );
  assert.match(sent[0].text, /<tg-button type="copy_text" text="ssh c1">/u);
  assert.match(
    sent[0].text,
    /<tg-button type="callback_data" style="danger" data="Нет">/u,
  );
});
