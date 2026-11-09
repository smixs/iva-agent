// Виджет на cron-пути (Watch, Brief, Insight → scripts/lib/telegram-send.ts): sendWidget идёт в
// beta Bot API, отказ по самому виджету оставляет подпись обычным sendMessage, а сеть или 429
// обрывают отчёт, как у HTML-пути. Проверяется на проводе: адрес, метод и тело запроса.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "iva-send-widget-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
delete process.env.TELEGRAM_WIDGETS;

const { sendTelegramHtml } = await import("./telegram-send.ts");

const REPLY = [
  "Доброе утро.",
  "",
  "```tg-widget День: 4 встречи, первая в 10:00",
  "<div>timeline</div>",
  "```",
].join("\n");

type Wire = { url: string; body: Record<string, unknown> };

function fakeFetch(answer: (url: string) => [number, unknown]) {
  const wire: Wire[] = [];
  const fetchImpl = ((url: string, init: { body: string }) => {
    wire.push({
      url,
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    const [status, body] = answer(url);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;
  return { wire, fetchImpl };
}

await test("a widget goes to the beta Bot API with its caption", async () => {
  const { wire, fetchImpl } = fakeFetch(() => [200, { ok: true }]);
  const sent = await sendTelegramHtml("T", "42", REPLY, {
    fetchImpl,
    threadId: "7",
  });
  assert.deepEqual(sent, { ok: true, fellBack: false, error: "" });
  assert.deepEqual(
    wire.map((w) => w.url),
    [
      "https://api.telegram.org/botT/sendMessage",
      "https://api.telegram.org/beta/botT/sendWidget",
    ],
  );
  assert.deepEqual(wire[1].body, {
    chat_id: "42",
    html: "<div>timeline</div>",
    caption: "День: 4 встречи, первая в 10:00",
    message_thread_id: "7",
  });
});

await test("a widget Telegram refuses leaves its caption as a message", async () => {
  const { wire, fetchImpl } = fakeFetch((url) =>
    url.endsWith("/sendWidget")
      ? [
          400,
          {
            ok: false,
            description: "Bad Request: INPUT_MEDIA_WIDGET_TOO_LARGE",
          },
        ]
      : [200, { ok: true }],
  );
  const sent = await sendTelegramHtml("T", "42", REPLY, { fetchImpl });
  assert.equal(sent.ok, true);
  assert.equal(sent.fellBack, true);
  assert.deepEqual(
    wire.map((w) => [w.url.split("/").pop(), w.body.text ?? ""]),
    [
      ["sendMessage", "Доброе утро."],
      ["sendWidget", ""],
      ["sendMessage", "День: 4 встречи, первая в 10:00"],
    ],
  );
});

await test("flood control on the widget ends the report, the caption is not pushed", async () => {
  const { wire, fetchImpl } = fakeFetch((url) =>
    url.endsWith("/sendWidget")
      ? [429, { ok: false, parameters: { retry_after: 3 } }]
      : [200, { ok: true }],
  );
  const sent = await sendTelegramHtml("T", "42", REPLY, { fetchImpl });
  assert.equal(sent.ok, false);
  assert.equal(wire.length, 2);
});
