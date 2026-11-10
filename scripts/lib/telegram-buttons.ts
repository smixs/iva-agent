// Rich-кнопки Telegram: кнопка — inline-элемент markdown-текста rich message, а не ряд
// коротких подписей под сообщением (Bot API 24.08.2026, контракт волны — rich-common.md).
// Экран собирает markdown сам и вставляет в него готовые строки отсюда: одно место, где
// живёт синтаксис тега, для моста, меню и визардов.
//
// Контракт: <tg-button type="callback_data" data="…" style="…">подпись</tg-button> стоит
// ПРЯМО в строке рядом с пояснением («кнопка — что она делает»); <tg-button-row> — только
// для равноправных коротких вариантов (да/нет, список). Нажатие приходит обычным
// callback_query с тем же data, поэтому обработчики кнопок не меняются.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataDirSetting } from "../../packages/data-dir/index.ts";

export type RichButtonStyle = "danger" | "success" | "link";

/**
 * Стиль меню (решение владельца 13.09.2026): по умолчанию «classic» — обычное сообщение
 * с inline-клавиатурой под ним, как до 0.4.2; «rich» — кнопки внутри rich message.
 * Переключается в /menu → Обслуживание («✨ Новое меню» / «◀︎ Старое меню»), живёт в
 * settings.json, читается свежим на каждую отрисовку — обоим процессам видно сразу.
 */
export type MenuStyle = "classic" | "rich";

// Читаем settings.json сами (без #lib/settings.ts): этот модуль грузится и в CLI, а CLI
// обязан подниматься без authored tree (см. authored-tree-guard). Ошибка чтения = classic.
export function menuStyle(): MenuStyle {
  try {
    const dir = resolve(dataDirSetting(process.env.ASSISTANT_DATA_DIR));
    const raw = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf8"),
    ) as {
      menuStyle?: unknown;
    };
    return raw.menuStyle === "rich" ? "rich" : "classic";
  } catch {
    return "classic";
  }
}

export type ClassicScreen = {
  text: string;
  reply_markup?: { inline_keyboard: ClassicButton[][] };
};
export type ClassicButton = {
  text: string;
  callback_data?: string;
  url?: string;
  copy_text?: { text: string };
  style?: "danger" | "success" | "primary";
};

/**
 * Один экран в обоих стилях. Экраны пишут rich markdown с кнопками в тексте; для classic
 * тот же текст разбирается на подпись+клавиатуру: строка с кнопкой становится рядом
 * клавиатуры (пояснение после «—» уходит в текст строкой), <tg-button-row> — рядом из
 * нескольких, заголовок теряет «#», таблица становится строками «a — b», экранирование
 * снимается. Так у экранов один источник, а у пользователя выбор.
 */
export function screenPayload(
  markdown: string,
): { rich_message: { markdown: string } } | ClassicScreen {
  return menuStyle() === "rich"
    ? { rich_message: { markdown: blockButtons(markdown) } }
    : classicScreen(markdown);
}

const BUTTON_RE = /<tg-button(?=[\s>])([^>]*)>([\s\S]*?)<\/tg-button>/gi;

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attrs);
  return m
    ? m[1]
        .replaceAll("&quot;", '"')
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&")
    : undefined;
}

function classicButton(attrs: string, label: string): ClassicButton | null {
  const text = label.replace(/<[^>]+>/g, "").trim();
  if (!text) return null;
  const type = attr(attrs, "type");
  const style = attr(attrs, "style");
  const styled: Pick<ClassicButton, "style"> =
    style === "danger" || style === "success" ? { style } : {};
  const data = attr(attrs, "data");
  const url = attr(attrs, "url");
  const copy = attr(attrs, "text");
  if (type === "url" && url) return { text, url, ...styled };
  if (type === "copy_text" && copy)
    return { text, copy_text: { text: copy }, ...styled };
  if (data) return { text, callback_data: data, ...styled };
  return null;
}

function classicLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\\(.)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trimEnd();
}

/** Строка «кнопка — пояснение»: ровно один тег в начале, остальное - пояснение. */
type Item = { tag: string; attrs: string; label: string; rest: string };

const ITEM_RE =
  /^(<tg-button(?=[\s>])([^>]*)>([\s\S]*?)<\/tg-button>)[ \t]*(?:[—–-][ \t]*)?(.*)$/i;

function itemOf(line: string): Item | null {
  const m = ITEM_RE.exec(line);
  if (!m || BUTTON_RE.test(line.slice(m[1].length))) return null;
  BUTTON_RE.lastIndex = 0;
  return { tag: m[1], attrs: m[2], label: m[3], rest: m[4].trim() };
}

/** Кнопка со стилем стоит одна в ряду: «Закрыть» и «Обновить» не соседствуют с разделами. */
const alone = (item: Item): boolean => /\bstyle="/i.test(item.attrs);

/**
 * Раскладка экрана: подряд идущие строки «кнопка — пояснение» собираются по две в ряд, как
 * в меню до 0.4.2 (решение владельца 14.09.2026: «в две строки, не одна длинная»). Пустые
 * строки между такими строками ряд не рвут. Всё остальное - как есть.
 */
function layout(markdown: string): (string | Item[])[] {
  const out: (string | Item[])[] = [];
  let run: Item[] = [];
  let pending: string[] = [];
  const flush = () => {
    for (let i = 0; i < run.length;) {
      if (alone(run[i]) || i + 1 >= run.length || alone(run[i + 1])) {
        out.push([run[i]]);
        i += 1;
      } else {
        out.push([run[i], run[i + 1]]);
        i += 2;
      }
    }
    run = [];
  };
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    const item = line ? itemOf(line) : null;
    if (item) {
      run.push(item);
      pending = [];
      continue;
    }
    if (!line && run.length) {
      pending.push(line);
      continue;
    }
    flush();
    out.push(...pending, line);
    pending = [];
  }
  flush();
  out.push(...pending);
  return out;
}

export function classicScreen(markdown: string): ClassicScreen {
  const rows: ClassicButton[][] = [];
  const text: string[] = [];
  for (const entry of layout(markdown)) {
    if (typeof entry !== "string") {
      const row = entry
        .map((item) => classicButton(item.attrs, item.label))
        .filter((b): b is ClassicButton => b !== null);
      if (row.length) rows.push(row);
      for (const item of entry) {
        const b = classicButton(item.attrs, item.label);
        const rest = classicLine(item.rest);
        if (rest) text.push(b ? `${b.text} — ${rest}` : rest);
      }
      continue;
    }
    const line = entry;
    if (!line) {
      text.push("");
      continue;
    }
    if (/^<tg-button-row\b/i.test(line)) {
      const row = [...line.matchAll(BUTTON_RE)]
        .map((m) => classicButton(m[1], m[2]))
        .filter((b): b is ClassicButton => b !== null);
      if (row.length) rows.push(row);
      continue;
    }
    if (/^<tg-button(?=[\s>])/i.test(line)) {
      // Несколько тегов в одной строке: каждый своим рядом, текст между ними в подпись.
      const buttons = [...line.matchAll(BUTTON_RE)]
        .map((m) => classicButton(m[1], m[2]))
        .filter((b): b is ClassicButton => b !== null);
      for (const b of buttons) rows.push([b]);
      const rest = classicLine(line.replace(BUTTON_RE, ""));
      if (rest) text.push(rest);
      continue;
    }
    if (/^\|.*\|$/.test(line)) {
      if (/^[|\-: \t]+$/.test(line)) continue;
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((c) => classicLine(c.trim()));
      text.push(cells.filter(Boolean).join(" — "));
      continue;
    }
    text.push(classicLine(line));
  }
  const body = text
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return rows.length
    ? { text: body, reply_markup: { inline_keyboard: rows } }
    : { text: body };
}

const STYLES: readonly RichButtonStyle[] = ["danger", "success", "link"];

function isRichButtonStyle(value: unknown): value is RichButtonStyle {
  return STYLES.includes(value as RichButtonStyle);
}

/**
 * Переходный тип: rich-строка (тег кнопки или абзац «кнопка — пояснение»), которая пока
 * обязана проходить и в старый ряд «{text, callback_data}», и в markdown-текст экрана.
 * Ряды снимет D3 — вместе с ними уйдут и richRow/legacyRows, и этот бренд.
 */
export type RichButton = string & {
  text: string;
  callback_data: string;
  style?: RichButtonStyle;
  [key: string]: unknown;
};

/** Старый ряд кнопок: то, что экраны отдают движку до перехода на rich (см. legacyRows). */
export type LegacyButton = {
  text: string;
  callback_data: string;
  style?: RichButtonStyle;
};

/** Что legacyRows принимает в переходный период: старый ряд, готовую rich-строку или
 *  ряд, который экран уже собрал из rich-строк (Row из record'ов — самый частый случай). */
type LegacyRowsInput = ReadonlyArray<
  | ReadonlyArray<LegacyButton | string>
  | string
  | ReadonlyArray<Record<string, unknown>>
>;

/** data — ASCII-энум (грамматика iva_menu://iva_model://iva_think://iva_update:), но кавычка
 *  или угловая скобка сломали бы сам тег: атрибут экранируется, это защита в глубину. */
function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Кнопка rich-сообщения. `style` необязателен: danger | success | link.
 * Возвращаемое значение — markdown-строка; поставь её в текст экрана в строку с пояснением.
 */
export function button(
  text: string,
  callbackData: string,
  style?: RichButtonStyle,
): RichButton {
  const styled = style ? ` style="${style}"` : "";
  return `<tg-button type="callback_data"${styled} data="${attribute(callbackData)}">${text}</tg-button>` as unknown as RichButton;
}

/** Ряд равноправных кнопок (до 8): только там, где у каждой нет своего пояснения. */
export function buttonRow(buttons: readonly string[]): string {
  return `<tg-button-row>${buttons.join("")}</tg-button-row>`;
}

/** Строка «‹ Меню — вернуться в настройки»: одна подпись у всех экранов /menu. */
export function menuBackLine(
  ctx: { readonly tr: (en: string, ru: string) => string },
  parent: string,
): string {
  return `${button(ctx.tr("‹ Menu", "‹ Меню"), `iva_menu:${parent}:o`)} — ${ctx.tr(
    "back to the settings.",
    "вернуться в настройки.",
  )}`;
}

/**
 * Экранирование данных пользователя для rich markdown: путь, имя модели, ключ. Эти
 * символы rich-разметка читает как разметку: `<` ломает ещё и тег, `*`/`_`/`#`/`|` —
 * абзац. Подписи кнопок внутри тега не экранируются — их пишет сам экран.
 */
export function escapeRichText(s: string): string {
  return s.replace(/([*_#|<])/g, "\\$1");
}

/**
 * Кнопка в строке текста (RichTextButton) на Android-клиентах лета 2026 рисуется криво:
 * подпись уезжает под пилюлю (скриншот пользователя 13.09.2026). Ряд-блок
 * (<tg-button-row>, RichBlockButtons) рендерится всеми клиентами одинаково, поэтому перед
 * отправкой строки вида «<tg-button…>Подпись</tg-button> — пояснение» становятся
 * рядами-блоками по две кнопки (компактные пилюли, не на всю ширину) и строками
 * пояснений под рядом. Строки, где кнопка стоит не первой или их несколько, не трогаем.
 * Решения владельца 13.09 и 14.09.2026.
 */
export function blockButtons(markdown: string): string {
  const out: string[] = [];
  for (const entry of layout(markdown)) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    // Ряд из двух коротких кнопок, под ним подписи «кнопка — пояснение» по строке на
    // каждую: пилюли компактные, текст рядом не переносится, Android рисует ряд ровно.
    out.push(buttonRow(entry.map((item) => item.tag)));
    const captions = entry
      .filter((item) => item.rest)
      .map((item) => {
        const label = item.label.replace(/<[^>]+>/g, "").trim();
        return entry.length > 1 && label
          ? `${label} — ${item.rest}`
          : item.rest;
      });
    // Две подписи - две строки одного абзаца (два пробела = перенос в rich markdown),
    // и пустая строка после группы, чтобы следующий ряд не слипся с подписями.
    if (captions.length) out.push(captions.join("  \n"));
    out.push("");
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Переходный помощник для ряда, который уже состоит из готовых rich-строк (тегов кнопок
 * или абзацев «кнопка — пояснение»): старые экраны собирают такие ряды руками.
 * D3 перепишет экраны — помощник уйдёт вместе с рядами.
 */
export function richRow(...fragments: string[]): RichButton[] {
  return fragments as unknown as RichButton[];
}

/**
 * Переходный шим: старый ряд «{text, callback_data}[]» → rich-строки для текста сообщения.
 * Ряд из одного элемента (в т.ч. абзац «кнопка — пояснение» из richRow) встаёт своей
 * строкой, ряд из нескольких — <tg-button-row> (равноправные варианты старой раскладки).
 * Значения проверяются по typeof: в переходный период в ряду рядом со старым объектом
 * лежит готовая rich-строка (RichButton). D3 снимет ряды вместе с этим шимом.
 */
export function legacyRows(rows: LegacyRowsInput | null | undefined): string {
  if (!rows || !Array.isArray(rows)) return "";
  const lines: string[] = [];
  for (const row of rows) {
    if (typeof row === "string") {
      lines.push(row); // готовая строка (richRow), а не ряд
      continue;
    }
    if (!Array.isArray(row)) continue;
    const buttons = row
      .map(toRichButton)
      .filter((value): value is string => value !== null);
    if (buttons.length === 0) continue;
    lines.push(buttons.length === 1 ? buttons[0] : buttonRow(buttons));
  }
  return lines.join("\n");
}

// Блоки с медиа: форма их ввода отличается от формы получения (PhotoSize[] против
// InputMediaPhoto), поэтому такое сообщение обратно не правится — остаётся подсказка.
const MEDIA_BLOCKS: ReadonlySet<unknown> = new Set([
  "photo",
  "video",
  "animation",
  "audio",
  "document",
  "voice_note",
  "collage",
  "slideshow",
  "map",
  "thinking",
]);
const MAX_TAP_DEPTH = 32;

class Unmarkable extends Error {}

/** RichText — строка, массив RichText или сущность с полем text: подпись плоским текстом. */
function plainText(text: unknown): string {
  if (typeof text === "string") return text;
  if (Array.isArray(text)) return text.map(plainText).join("");
  const nested = (text as { text?: unknown } | null)?.text;
  return nested === undefined ? "" : plainText(nested);
}

const TAP_MARK = "✅ ";

// Подпись уже помечена: правка, которая легла раньше, или вторая отметка того же сообщения.
function isMarkedText(text: unknown): boolean {
  if (typeof text === "string") return text.startsWith(TAP_MARK);
  return Array.isArray(text) && text[0] === TAP_MARK;
}

// Нажатая кнопка: «✅» в подписи, success и тот же callback_data — эту форму Telegram принял
// на пробе 06.10.2026. disabled живьём не проверялся, поэтому кнопка остаётся нажимаемой, а
// повторный тап гасит память Bridge. Прочие поля кнопки уходят.
function markedButton(text: unknown, data: string) {
  if (isMarkedText(text))
    return { text, style: "success", callback_data: data };
  const label =
    typeof text === "string" ? `${TAP_MARK}${text}` : [TAP_MARK, text];
  return { text: label, style: "success", callback_data: data };
}

// Подпись плоским текстом без «✅»: она идёт в подсказку «✅ <подпись>».
function unmarkedLabel(text: unknown): string {
  const plain = plainText(text);
  return isMarkedText(text) ? plain.slice(TAP_MARK.length) : plain;
}

function markTree(
  node: unknown,
  depth: number,
  found: string[],
  data: string,
): unknown {
  if (typeof node !== "object" || node === null) return node;
  if (depth >= MAX_TAP_DEPTH) throw new Unmarkable();
  if (Array.isArray(node))
    return node.map((item) => markTree(item, depth + 1, found, data));
  const record = node as Record<string, unknown>;
  if (MEDIA_BLOCKS.has(record.type)) throw new Unmarkable();
  if (record.callback_data === data) {
    found.push(unmarkedLabel(record.text));
    return markedButton(record.text, data);
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      markTree(value, depth + 1, found, data),
    ]),
  );
}

/**
 * Дерево кнопок с отмеченной кнопкой или null: кнопки нет, есть медиа, слишком глубоко.
 * На вход — блоки rich-сообщения или ряды кнопок classic-сообщения; отмечаются все кнопки
 * с этим data, label — подпись первой. Вход не меняется, выход — новые массивы и объекты.
 */
export function markTappedButton(
  tree: unknown,
  data: string,
): { readonly tree: unknown[]; readonly label: string } | null {
  if (!Array.isArray(tree)) return null;
  const found: string[] = [];
  try {
    const marked = markTree(tree, 0, found, data) as unknown[];
    return found.length === 0 ? null : { tree: marked, label: found[0] };
  } catch (error) {
    if (error instanceof Unmarkable) return null;
    throw error;
  }
}

function toRichButton(item: unknown): string | null {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return null;
  const { text, callback_data, style } = item as {
    text?: unknown;
    callback_data?: unknown;
    style?: unknown;
  };
  if (typeof text !== "string" || typeof callback_data !== "string")
    return null;
  return button(
    text,
    callback_data,
    isRichButtonStyle(style) ? style : undefined,
  );
}
