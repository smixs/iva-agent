// Виджет Telegram (Bot API 10.4, sendWidget): самодостаточный HTML с CSS и JS, который
// клиент рисует прямо в пузыре сообщения, без сети, в песочнице Telegram. Модель пишет его
// в ответе блоком
//
//   ```tg-widget Подпись: суть ответа словами
//   <style>…</style><div>…</div><script>…</script>
//   ```
//
// Шов Outbox (agent/lib/outbox.ts) режет ответ на текст и виджеты по этому блоку. Подпись
// уходит caption виджета: её видят список чатов, поиск и клиенты без виджетов. Её же шов
// шлёт текстом, когда виджет не ушёл: транспорт его не умеет, Telegram отказал, HTML не влез.
// Импорты с расширением .ts: модуль грузится и голым node (cron → scripts/lib/telegram-send.ts).
import { deflateSync } from "node:zlib";

// Пределы сервера: HTML до 32768 байт, после zlib уровня 9 до 4096 (PHP gzcompress($html, 9)).
// deflateSync даёт тот же поток RFC 1950, Node жмёт на десяток байт плотнее PHP, отсюда запас.
const MAX_HTML_BYTES = 32768;
const MAX_PACKED_BYTES = 4096 - 64;
const MAX_CAPTION = 1024;

// TELEGRAM_WIDGETS — операторский тумблер, как TELEGRAM_RICH_REPLIES: auto (дефолт) —
// модель пишет виджеты и шов их шлёт; never — модель о виджетах не знает, а блок, если
// всё же пришёл, уходит своей подписью. Чужое значение — отказ на импорте, то есть при старте.
export type WidgetMode = "auto" | "never";

export function widgetMode(raw: string | undefined): WidgetMode {
  if (raw === undefined || raw === "" || raw === "auto") return "auto";
  if (raw === "never") return "never";
  throw new Error(
    `TELEGRAM_WIDGETS must be "auto" or "never", got ${JSON.stringify(raw)}`,
  );
}

export const TELEGRAM_WIDGETS = widgetMode(process.env.TELEGRAM_WIDGETS);

export type ReplyPart =
  | { kind: "text"; text: string }
  | { kind: "widget"; html: string; caption: string };

const OPEN = /^```tg-widget(?:[ \t]+([^\n]*))?[ \t]*$/;
const CLOSE = /^```[ \t]*$/;

function clampCaption(raw: string | undefined): string {
  const caption = (raw ?? "").trim();
  return caption.length <= MAX_CAPTION
    ? caption
    : `${caption.slice(0, MAX_CAPTION - 1)}…`;
}

/**
 * Splits a reply into text and widget parts, in order.
 *
 * A reply without a widget block is one text part, unchanged. A block that never
 * closes (the reply was cut off) becomes a widget with no HTML, so the Outbox sends
 * its caption and the half-written code never reaches the chat as text.
 */
export function splitWidgets(text: string): ReplyPart[] {
  if (!text.includes("```tg-widget")) return [{ kind: "text", text }];
  const lines = text.split("\n");
  const parts: ReplyPart[] = [];
  let prose: string[] = [];
  const flush = () => {
    const joined = prose.join("\n");
    if (joined.trim()) parts.push({ kind: "text", text: joined.trim() });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN.exec(lines[i]);
    if (!open) {
      prose.push(lines[i]);
      continue;
    }
    flush();
    let end = i + 1;
    while (end < lines.length && !CLOSE.test(lines[end])) end++;
    const closed = end < lines.length;
    parts.push({
      kind: "widget",
      html: closed
        ? lines
            .slice(i + 1, end)
            .join("\n")
            .trim()
        : "",
      caption: clampCaption(open[1]),
    });
    i = end;
  }
  flush();
  return parts;
}

/** Why the server would refuse this HTML, or null when it fits. */
export function widgetProblem(html: string): string | null {
  if (!html.trim()) return "widget has no HTML";
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_HTML_BYTES) return `widget HTML ${bytes} B > 32768`;
  if (html.includes("\0")) return "widget HTML has NUL bytes";
  const packed = deflateSync(html, { level: 9 }).byteLength;
  if (packed > MAX_PACKED_BYTES) return `widget ${packed} B after zlib > 4096`;
  return null;
}

/** The reply as the daily file keeps it: a widget is its caption, not its code. */
export function withoutWidgetCode(text: string): string {
  return splitWidgets(text)
    .map((part) =>
      part.kind === "text"
        ? part.text
        : `[widget] ${part.caption || "no caption"}`,
    )
    .join("\n\n");
}
