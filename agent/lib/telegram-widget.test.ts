// Виджеты в ответе (agent/lib/telegram-widget.ts) и их путь через шов Outbox: блок
// ```tg-widget <подпись> режется в отдельное сообщение sendWidget, остальное идёт прежним путём,
// отказ виджета оставляет подпись текстом, код виджета текстом в чат не уходит никогда.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";

const root = mkdtempSync(join(tmpdir(), "iva-widget-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const { splitWidgets, widgetMode, widgetProblem, withoutWidgetCode } =
  await import("./telegram-widget.ts");
const { sendThroughOutbox } = await import("./outbox.ts");
type OutboxAck = import("./outbox.ts").OutboxAck;
type OutboxTransport = import("./outbox.ts").OutboxTransport;

const HTML = "<div id=a>1</div><script>a.textContent='2'</script>";
const block = (caption: string, html = HTML) =>
  ["```tg-widget " + caption, html, "```"].join("\n");

type Call = { kind: "widget" | "html" | "plain" | "rich"; text: string };

function stub(widget?: (html: string, caption: string) => OutboxAck) {
  const calls: Call[] = [];
  const transport: OutboxTransport = {
    sendHtml: (html) => {
      calls.push({ kind: "html", text: html });
      return Promise.resolve({ ok: true });
    },
    sendPlain: (text) => {
      calls.push({ kind: "plain", text });
      return Promise.resolve({ ok: true });
    },
    ...(widget
      ? {
          sendWidget: (html: string, caption: string) => {
            calls.push({ kind: "widget", text: `${caption}|${html}` });
            return Promise.resolve(widget(html, caption));
          },
        }
      : {}),
  };
  return { calls, transport };
}

await test("a reply without a widget block is one untouched text part", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 400 }), (text) => {
      fc.pre(!text.includes("```tg-widget"));
      assert.deepEqual(splitWidgets(text), [{ kind: "text", text }]);
      assert.equal(withoutWidgetCode(text), text);
    }),
  );
});

// Генератор ответа: куски прозы и виджетов в случайном порядке. Разбор обязан вернуть
// их в том же порядке, а HTML виджета никогда не оказывается в текстовой части.
const prose = fc
  .array(fc.constantFrom("Итог дня.", "| a | b |", "- пункт", "`код`", ""), {
    minLength: 1,
    maxLength: 3,
  })
  .map((lines) => lines.join("\n"))
  .filter((s) => s.trim().length > 0);
const widget = fc.record({
  caption: fc.constantFrom("Неделя: 32", "Сон 7 ч", "", "Расход ₽ 12 400"),
  html: fc.constantFrom(HTML, "<b>x</b>", "<style>b{}</style><b>```</b>"),
});
await test("prose and widgets come back in order, code never in a text part", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          prose.map((text) => ({ text })),
          widget,
        ),
        {
          minLength: 1,
          maxLength: 6,
        },
      ),
      (items) => {
        const reply = items
          .map((it) => ("text" in it ? it.text : block(it.caption, it.html)))
          .join("\n\n");
        const parts = splitWidgets(reply);
        const widgets = parts.filter((p) => p.kind === "widget");
        assert.deepEqual(
          widgets.map((w) => [w.caption, w.html]),
          items
            .filter((it) => !("text" in it))
            .map((it) => [
              (it as { caption: string }).caption,
              (it as { html: string }).html,
            ]),
        );
        for (const part of parts)
          if (part.kind === "text") {
            assert.ok(!part.text.includes("<script>"), part.text);
            assert.ok(!part.text.includes("```tg-widget"), part.text);
          }
        const daily = withoutWidgetCode(reply);
        assert.ok(!daily.includes("<script>") && !daily.includes("<b>x</b>"));
      },
    ),
  );
});

await test("an unclosed block (a cut-off reply) keeps its caption and drops the code", () => {
  const parts = splitWidgets(`Вот:\n\`\`\`tg-widget Сон 7 ч\n<div>обры`);
  assert.deepEqual(parts, [
    { kind: "text", text: "Вот:" },
    { kind: "widget", html: "", caption: "Сон 7 ч" },
  ]);
  assert.equal(widgetProblem(""), "widget has no HTML");
});

await test("a long caption is clamped to Telegram's 1024", () => {
  const [part] = splitWidgets(block("я".repeat(2000)));
  assert.equal(part.kind, "widget");
  assert.equal((part as { caption: string }).caption.length, 1024);
});

await test("size limits follow the server: 32 KB raw, 4 KB after zlib", () => {
  assert.equal(widgetProblem(HTML), null);
  assert.match(widgetProblem("a".repeat(40000)) ?? "", /32768/);
  // Случайный текст почти не жмётся: 8 КБ дают больше 4 КБ после zlib.
  let seed = 1;
  const noise = Array.from({ length: 8000 }, () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return String.fromCharCode(33 + (seed % 90));
  }).join("");
  assert.match(widgetProblem(noise) ?? "", /zlib/);
  assert.match(widgetProblem("a\0b") ?? "", /NUL/);
});

await test("TELEGRAM_WIDGETS takes auto or never, anything else stops the start", () => {
  assert.equal(widgetMode(undefined), "auto");
  assert.equal(widgetMode(""), "auto");
  assert.equal(widgetMode("never"), "never");
  assert.throws(() => widgetMode("off"), /TELEGRAM_WIDGETS/);
});

await test("Outbox: text, widget, text go out in order as three messages", async () => {
  const { calls, transport } = stub(() => ({ ok: true }));
  const result = await sendThroughOutbox(
    `Сводка недели.\n\n${block("Неделя: 32")}\n\nЧто дальше?`,
    transport,
  );
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["html", "widget", "html"],
  );
  assert.equal(calls[1].text, `Неделя: 32|${HTML}`);
  assert.deepEqual(result, {
    ok: true,
    delivered: 3,
    fellBack: false,
    error: "",
  });
});

await test("Outbox: a refused widget becomes its caption, the loss is visible", async () => {
  const { calls, transport } = stub(() => ({
    ok: false,
    error: "sendWidget 400: INPUT_MEDIA_WIDGET_HTML_INVALID",
    retryPlain: false,
  }));
  const result = await sendThroughOutbox(block("Сон 7 ч"), transport);
  assert.deepEqual(
    calls.map((c) => [c.kind, c.kind === "html" ? c.text : ""]),
    [
      ["widget", ""],
      ["html", "Сон 7 ч"],
    ],
  );
  assert.equal(result.ok, true);
  assert.equal(result.fellBack, true);
  assert.match(result.error, /widget dropped: sendWidget 400/);
});

await test("Outbox: an oversized widget is not sent, its caption is", async () => {
  let asked = 0;
  const { calls, transport } = stub(() => {
    asked++;
    return { ok: true };
  });
  const result = await sendThroughOutbox(
    block("Большой", "a".repeat(40000)),
    transport,
  );
  assert.equal(asked, 0);
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["html"],
  );
  assert.match(result.error, /32768/);
});

await test("Outbox: a transport without widgets sends the caption as the normal form", async () => {
  const { calls, transport } = stub();
  const result = await sendThroughOutbox(
    `Итог.\n\n${block("Сон 7 ч")}`,
    transport,
  );
  assert.deepEqual(
    calls.map((c) => c.text),
    ["Итог.", "Сон 7 ч"],
  );
  assert.equal(result.fellBack, false);
  assert.equal(result.delivered, 2);
});

await test("Outbox: a widget refused with stop ends the reply there", async () => {
  const { calls, transport } = stub(() => ({
    ok: false,
    error: "sendWidget 429",
    retryPlain: false,
    stop: true,
  }));
  const result = await sendThroughOutbox(
    `${block("Первый")}\n\nХвост`,
    transport,
  );
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["widget"],
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "sendWidget 429");
});

await test("Outbox: the outbound Gate covers the widget's HTML too", async () => {
  const secret = `sk-${"a".repeat(24)}`;
  const { calls, transport } = stub(() => ({ ok: true }));
  await sendThroughOutbox(block("Ключ", `<b>${secret}</b>`), transport);
  assert.ok(!calls[0].text.includes(secret), calls[0].text);
});

await test("the widgets block reaches chat and scheduled turns, not helpers", async () => {
  const block = (await import("../instructions/06-widgets.ts")).default as {
    events: Record<string, (event: unknown, ctx: unknown) => unknown>;
  };
  const started = block.events["turn.started"];
  const chat = started({}, { session: { auth: null } }) as {
    markdown?: string;
  } | null;
  assert.match(JSON.stringify(chat), /tg-widget/);
  const brief = started(
    {},
    {
      session: {
        auth: {
          initiator: {
            authenticator: "iva-bearer",
            attributes: { iva_turn: "brief" },
          },
        },
      },
    },
  );
  assert.match(JSON.stringify(brief), /widgets/);
  const helper = started(
    {},
    {
      session: {
        auth: {
          current: {
            authenticator: "iva-bearer",
            attributes: { iva_turn: "helper" },
          },
        },
      },
    },
  );
  assert.equal(helper, null);
});
