// Чтение Telegram `Message.rich_message`: дерево RichBlock/RichText превращается в
// markdown-текст и список медиа. Схема взята из таблиц полей Bot API, а не из головы.
// Обещания: ничего не теряем (ADR-0002), никогда не бросаем, всегда ограничены.
//
// Политика листьев (написана явно, чтобы свойство было опровержимым): строка → сама
// строка; RichText с полем `text` → листья вложенного `text`; custom_emoji →
// `alternative_text`; mathematical_expression → `expression`; mention → листья `text`
// и следом `@username`; anchor, anchor_link, reference и reference_link → листья
// `text` и следом `#имя` (`name`, `anchor_name`, `reference_name`); divider → текста
// нет, рисуется как `---`; RichBlockCaption → листья `text`, затем `credit`; map →
// только подпись, координаты не текст.
//
// Разметка одна — лёгкий markdown для daily-файла и для модели. Живой ссылкой
// становится только `http`/`https`; другая схема (`tg:`, `javascript:`, `data:`,
// `file:`, `mailto:`) печатается текстом `метка (адрес)`: адрес цел, ссылки нет.
// Экран листа снимается удалением `\`. Внутри забора кода байты не трогаются —
// исключение одно: забор внутри метки ссылки, где чужая скобка закрыла бы метку.
import {
  mediaFromRaw,
  type TelegramRawMedia,
  type TelegramRawMessage,
} from "./telegram-parts.ts";
import { isRecord } from "../../packages/guards/index.ts";

export interface RichMessageReading {
  /** Markdown в исходном порядке; пусто, когда текста нет. Листья экранированы. */
  readonly text: string;
  /** Медиа любой вложенности в исходном порядке; фото — самый крупный размер. */
  readonly media: readonly TelegramRawMedia[];
  /** true, когда потолок узлов или символов обрезал обход; прочитанное сохранено. */
  readonly truncated: boolean;
}

export interface TelegramMessageTextReading {
  /** Текст сообщения: обычный text/caption или rich-fallback. */
  readonly text: string;
  /** Обычная подпись нужна медиа-шагу отдельно от текста сообщения. */
  readonly caption: string;
  /** Результат rich-reader есть только когда обычного текста нет. */
  readonly rich: RichMessageReading | null;
}

// Узлы ограничивают всю работу: и разбор узла, и шаг курсора по детям, поэтому счёт
// идёт в шагах, а не в узлах схемы — абзац со строкой стоит трёх шагов. Глубина
// ограничивает кадры: без неё сто тысяч вложенных цитат стоили бы квадрат от длины
// текста, а за потолком глубины теряется оформление, но не данные — `truncated` он не
// поднимает. Пустой ответ из-за потолка сам по себе потеря, поэтому его не бывает.
export const MAX_RICH_MESSAGE_NODES = 50_000;
export const MAX_RICH_MESSAGE_CHARS = 400_000;
export const MAX_RICH_MESSAGE_DEPTH = 64;

const BLOCK_SEP = "\n\n";

/** Собирает содержимое кадра целиком: заголовок, отступ, забор, префикс цитаты. */
type Wrap = (inner: string) => string;

/** `text` — обычный markdown, `label` — метка ссылки (вложенная ссылка не оживает),
 *  `code` — содержимое забора, где байты не трогаются. */
type Mode = "text" | "label" | "code";

/** Разворачивает одного ребёнка курсора в задачи. */
type Make = (node: unknown) => Task[];

type Task =
  | { readonly kind: "block"; readonly node: unknown }
  | { readonly kind: "text"; readonly node: unknown; readonly mode: Mode }
  | { readonly kind: "emit"; readonly value: string }
  | { readonly kind: "open"; readonly sep: string; readonly wrap: Wrap }
  | { readonly kind: "close" }
  | { kind: "each"; list: object; make: Make; at: number };

const CLOSE: Task = { kind: "close" };
const blockOf: Make = (node) => [{ kind: "block", node }];

function textTask(node: unknown, mode: Mode): Task {
  return { kind: "text", node, mode };
}

// Ловушка в геттере или Proxy — это потерянное поле, а не повод бросить. Счётчик
// общий на модуль, но обход синхронный и не вложенный: один проход читает только свою
// разницу и по ней честно поднимает `truncated`.
let traps = 0;

// Чтение поля не имеет права уронить обход: геттер и Proxy вправе бросить.
function field(node: object, name: string | number): unknown {
  try {
    return (node as Record<string, unknown>)[name];
  } catch {
    traps += 1;
    return undefined;
  }
}

function width(value: unknown): number {
  const size = Array.isArray(value) ? field(value, "length") : 0;
  return typeof size === "number" ? size : 0;
}

// Курсор по детям: массив не копируется в стек задач, а его шаг стоит один узел
// потолка. Поэтому цикл, общий массив и длина в миллиард стоят линейной памяти.
function each(value: unknown, make: Make): Task[] {
  if (width(value) === 0) return [];
  return [{ kind: "each", list: value as object, make, at: 0 }];
}

export function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function flatten(value: string): string {
  return value.replace(/[\r\n]+/gu, " ");
}

// Чужой лист не имеет права стать разметкой. Внутри строки экранируются `\`, `[`, `]`,
// `` ` `` и `<`: без них не открыть метку ссылки, не сцепиться с нашим забором кода и
// не пронести сырой HTML. В начале строки экранируется знак блока — заголовок, цитата,
// список, черта, таблица, подчёркнутый заголовок; `!` перед ссылкой — в `append`.
// `ordered` оставляет `1.` живым маркером: открыть нумерованный список — работа метки
// пункта, а не листа. Экранируется точка: слэш перед цифрой markdown оставил бы видимым.
function escapeLeaf(value: string, ordered = false): string {
  const safe = value
    .replace(/[\\[\]<`]/gu, "\\$&")
    .replace(/(^|\n)([ \t]*)([#>\-+*=_~|])/gu, "$1$2\\$3");
  return ordered
    ? safe
    : safe.replace(/(^|\n)([ \t]*)(\d{1,9})([.)])/gu, "$1$2$3\\$4");
}

// Адрес внутри `(...)`: скобки и слэш экранируются, пробелы, управляющие символы и
// обратная кавычка кодируются процентами — иначе CommonMark обрывает адрес на первом
// пробеле, а кавычка утаскивает половину абзаца в забор кода. `%60` и `` ` `` — один
// и тот же байт, поэтому адрес не меняется.
function escapeUrl(value: string): string {
  return value
    .replace(/[\\()]/gu, "\\$&")
    .replace(/[\s`\p{Cc}]/gu, (char) => encodeURIComponent(char));
}

function isWebUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

// Забор длиннее любой цепочки обратных кавычек внутри: содержимое из него не выйдет.
function backticks(value: string): number {
  let best = 0;
  for (const run of value.match(/`+/gu) ?? [])
    best = Math.max(best, run.length);
  return best;
}

function fenced(inner: string, tag: string): string {
  const bar = "`".repeat(Math.max(3, backticks(inner) + 1));
  return `${bar}${tag}\n${inner}\n${bar}`;
}

/** Площадь, file_size, file_id: полный порядок, не зависящий от порядка размеров. */
type Rank = readonly [number, number, string];

function outranks(a: Rank, b: Rank | null): boolean {
  if (b === null || a[0] !== b[0]) return b === null || a[0] > b[0];
  return a[1] !== b[1] ? a[1] > b[1] : a[2] < b[2];
}

// Нечисло и бесконечность становятся -1 и никогда не выигрывают у настоящего размера.
function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

function largestPhoto(value: unknown): TelegramRawMedia | null {
  let best: Rank | null = null;
  let uniqueId: unknown;
  const sizes = Array.isArray(value) ? (value as readonly unknown[]) : [];
  for (const size of sizes) {
    if (!isRecord(size)) continue;
    const fileId = field(size, "file_id");
    if (typeof fileId !== "string" || fileId === "") continue;
    const w = field(size, "width");
    const h = field(size, "height");
    const area = typeof w === "number" && typeof h === "number" ? w * h : -1;
    const rank: Rank = [finite(area), finite(field(size, "file_size")), fileId];
    if (!outranks(rank, best)) continue;
    best = rank;
    uniqueId = field(size, "file_unique_id");
  }
  if (best === null) return null;
  return {
    fileId: best[2],
    ...(typeof uniqueId === "string" ? { fileUniqueId: uniqueId } : {}),
    tag: "photo",
    transcribe: false,
  };
}

// Медиа ищется по полям, а не по типу блока: новый тип из будущей версии Bot API всё
// равно отдаст свой файл. voice_note подставляется в telegram-parts под именем voice.
function blockMedia(node: Record<string, unknown>): TelegramRawMedia | null {
  try {
    const photo = largestPhoto(field(node, "photo"));
    if (photo !== null) return photo;
    const voice = field(node, "voice_note");
    return mediaFromRaw(isRecord(voice) ? { ...node, voice } : node);
  } catch {
    return null;
  }
}

// Хвост: адрес у url, `@username` у mention, `#имя` у якоря и сноски. Он виден даже
// при пустой метке, поэтому цель не теряется. Свой `#` экранирован: в начале строки
// он стал бы заголовком.
function tailText(node: Record<string, unknown>, url: string): string {
  if (url !== "") return escapeLeaf(url);
  const user = asText(field(node, "username"));
  if (user !== "") return escapeLeaf(user.startsWith("@") ? user : `@${user}`);
  const name =
    asText(field(node, "name")) ||
    asText(field(node, "anchor_name")) ||
    asText(field(node, "reference_name"));
  return name === "" ? "" : `\\#${escapeLeaf(name)}`;
}

const plainWrap: Wrap = (inner) => inner;

const quoteWrap: Wrap = (inner) =>
  inner === ""
    ? ""
    : inner.replace(/^.*$/gmu, (line) => (line === "" ? ">" : `> ${line}`));

const summaryWrap: Wrap = (inner) =>
  inner === "" ? "" : `**${flatten(inner)}**`;

const rowWrap: Wrap = (inner) => (inner === "" ? "" : `| ${inner} |`);

/** Пустая ячейка обязана занять место, иначе колонки съезжают. */
const cellWrap: Wrap = (inner) => flatten(inner).replaceAll("|", "\\|") || " ";

/** Перевод строки в короткий забор не поместится, поэтому берётся длинный. */
const codeWrap: Wrap = (inner) => {
  if (inner === "") return "";
  if (inner.includes("\n")) return fenced(inner, "");
  const bar = "`".repeat(backticks(inner) + 1);
  const pad = /^[` ]|[` ]$/u.test(inner) ? " " : "";
  return `${bar}${pad}${inner}${pad}${bar}`;
};

// Разметка живёт внутри одной строки и не липнет к своему же знаку: одинокая `*` на
// строке — уже пункт списка, `~~` внутри `~~` — забор кода, а пробел по краям markdown
// и так не оформит. Тогда строка остаётся без знаков: текст цел, блок не открывается.
function markWrap(mark: string): Wrap {
  return (inner) =>
    inner.replace(/^.*$/gmu, (line) =>
      line === "" || line !== line.trim() || line.startsWith(mark)
        ? line
        : `${mark}${line}${mark}`,
    );
}

// H1 и H2 в daily-файл не идут: там свой заголовок. Ниже третьего уровня сохраняется
// относительный размер из `size` (1 — самый крупный, 6 — самый мелкий).
function headingWrap(size: unknown): Wrap {
  const level =
    typeof size === "number" && size >= 4 ? Math.min(6, Math.trunc(size)) : 3;
  const hashes = "#".repeat(level);
  return (inner) => (inner === "" ? "" : `${hashes} ${flatten(inner)}`);
}

function preWrap(language: unknown): Wrap {
  const tag = asText(language).replace(/[^\w+#.-]/gu, "");
  return (inner) => (inner === "" ? "" : fenced(inner, tag));
}

/** Своя метка пункта (`1.`, `a)`) заменяет дефис: два маркера подряд — не список. */
function itemWrap(marker: string, label: string): Wrap {
  const head =
    label === "" ? marker : `${marker === "- " ? "" : marker}${label} `;
  // Продолжение пункта живёт под его меткой: строка за переводом получает отступ.
  return (inner) =>
    inner === ""
      ? label === ""
        ? ""
        : head.trimEnd()
      : head + inner.replace(/\n(?=.)/gu, "\n  ");
}

// Живой ссылкой хвост становится только у http/https и только когда метка не пуста и
// не разорвана пустой строкой: такую метку CommonMark обратно в ссылку не собирает.
function tailWrap(tail: string, live: string): Wrap {
  return (inner) =>
    live !== "" && inner !== "" && !/\n[ \t]*\n/u.test(inner)
      ? `[${inner}](${escapeUrl(live)})`
      : inner === ""
        ? tail
        : `${inner} (${tail})`;
}

/** Разметка одного текста внутри строки; прочие подтипы аналога не имеют. */
const INLINE_MARKS: Record<string, string> = {
  bold: "**",
  italic: "*",
  strikethrough: "~~",
};

export function readRichMessage(value: unknown): RichMessageReading {
  const media: TelegramRawMedia[] = [];
  const frames: { parts: string[]; sep: string; wrap: Wrap }[] = [
    { parts: [], sep: BLOCK_SEP, wrap: plainWrap },
  ];
  const stack: Task[] = [];
  const seenTraps = traps;
  let nodes = 0;
  let chars = 0;
  let truncated = false;

  function append(value: string): void {
    if (value === "") return;
    const { parts, sep } = frames[frames.length - 1];
    const last = parts[parts.length - 1];
    if (parts.length > 0 && sep !== "") parts.push(sep);
    else if (last !== undefined) {
      // Два забора кода не имеют права слипнуться: цепочка кавычек на стыке закрыла
      // бы не тот забор. `!` вплотную к нашей ссылке сделал бы из неё картинку, и
      // markdown пошёл бы за чужим адресом; знак экранируется, текст цел.
      if (last.endsWith("`") && value.startsWith("`")) parts.push(" ");
      else if (last.endsWith("!") && value.startsWith("["))
        parts[parts.length - 1] = `${last.slice(0, -1)}\\!`;
    }
    parts.push(value);
  }

  function emit(value: string): void {
    chars += value.length;
    append(value);
  }

  function run(seq: readonly Task[]): void {
    for (let i = seq.length - 1; i >= 0; i -= 1) stack.push(seq[i]);
  }

  // Кадр с оформлением. За потолком глубины оформление уступает место запасному
  // тексту `head`/`tail`: адрес ссылки, @username и метка пункта остаются на местах,
  // а кадры не растут — иначе склейка стоила бы квадрат от длины текста.
  function framed(wrap: Wrap, sep: string, kids: Task[], head = "", tail = "") {
    if (frames.length <= MAX_RICH_MESSAGE_DEPTH)
      return [{ kind: "open", sep, wrap } as Task, ...kids, CLOSE];
    const open: Task[] = head === "" ? [] : [{ kind: "emit", value: head }];
    const shut: Task[] = tail === "" ? [] : [{ kind: "emit", value: tail }];
    return [...open, ...kids, ...shut];
  }

  /** Один текст как отдельный кусок блока. */
  function lineSeq(node: unknown, wrap: Wrap = plainWrap, mode: Mode = "text") {
    return framed(wrap, "", [textTask(node, mode)]);
  }

  // `pre` не теряет забор за потолком глубины: иначе его байты снова становятся
  // markdown, и запрещённая схема внутри кода может ожить как ссылка.
  function preSeq(node: unknown, language: unknown): Task[] {
    return [
      { kind: "open", sep: "", wrap: preWrap(language) },
      textTask(node, "code"),
      CLOSE,
    ];
  }

  /** Поле-текст, которого может не быть: отсутствие не стоит узла. */
  function fieldSeq(value: unknown, wrap?: Wrap): Task[] {
    return value === undefined ? [] : lineSeq(value, wrap);
  }

  // RichBlockCaption — это `{ text, credit }`, а не RichText: у RichText всегда есть
  // строковый `type`, у подписи его нет. Обе формы читаются одним местом.
  function captionSeq(value: unknown): Task[] {
    if (value === undefined || value === null) return [];
    if (!isRecord(value) || typeof field(value, "type") === "string")
      return lineSeq(value);
    const credit = field(value, "credit");
    return [...fieldSeq(field(value, "text")), ...fieldSeq(credit)];
  }

  // Общая форма блока: текст, summary, формула, имя якоря, вложенные блоки, credit,
  // подпись. Так читаются paragraph, footer, thinking, math, anchor, details, collage,
  // slideshow, map, все медиа-блоки — и любой ещё не известный нам тип: он теряет
  // разметку, но не содержание. Формула идёт как код: LaTeX остаётся байт в байт.
  function blockSeq(node: Record<string, unknown>): Task[] {
    const expression = asText(field(node, "expression"));
    const name = asText(field(node, "name"));
    const mark = (value: string): Task[] =>
      value === "" ? [] : [{ kind: "emit", value }];
    return [
      ...fieldSeq(field(node, "text")),
      ...fieldSeq(field(node, "summary"), summaryWrap),
      ...mark(codeWrap(expression)),
      ...mark(name === "" ? "" : `\\#${escapeLeaf(name)}`),
      ...each(field(node, "blocks"), blockOf),
      ...fieldSeq(field(node, "credit")),
      ...captionSeq(field(node, "caption")),
    ];
  }

  const itemOf: Make = (node) => {
    const item = isRecord(node) ? node : null;
    const label = escapeLeaf(asText(item && field(item, "label")), true);
    const box = item !== null && field(item, "has_checkbox") === true;
    const checked = item !== null && field(item, "is_checked") === true;
    const marker = !box ? "- " : checked ? "- [x] " : "- [ ] ";
    chars += label.length;
    const blocks = item && field(item, "blocks");
    const kids =
      item === null ? [textTask(node, "text")] : each(blocks, blockOf);
    return framed(itemWrap(marker, label), BLOCK_SEP, kids, label);
  };

  const cellOf: Make = (cell) =>
    lineSeq(isRecord(cell) ? field(cell, "text") : cell, cellWrap);

  function tableSeq(node: Record<string, unknown>): Task[] {
    const rows = field(node, "cells");
    // Линейка меряется по самой широкой строке: с шириной первой у рваной таблицы
    // пропали бы лишние ячейки. Осмотр строк стоит узлов, поэтому длина в миллиард
    // обрывается потолком, а не съедает память.
    const budget = Math.max(0, MAX_RICH_MESSAGE_NODES - nodes);
    const seen = Math.min(width(rows), budget);
    let cols = 0;
    for (let i = 0; i < seen; i += 1)
      cols = Math.max(cols, width(field(rows as object, i)));
    cols = Math.min(cols, budget);
    nodes += seen;
    let first = true;
    const rowOf: Make = (row) => {
      if (!first || cols === 0)
        return framed(rowWrap, " | ", each(row, cellOf));
      // Линейка после первой строки: без неё markdown не считает таблицу таблицей.
      // Шапка добивается до её ширины: при разном числе ячеек таблицы не будет вовсе.
      first = false;
      const gap = Math.max(0, cols - width(row));
      const pad = new Array<Task>(gap).fill({ kind: "emit", value: " " });
      const ruler = new Array(cols).fill("---").join(" | ");
      return [
        ...framed(rowWrap, " | ", [...each(row, cellOf), ...pad]),
        { kind: "emit", value: `| ${ruler} |` },
      ];
    };
    return [
      ...framed(plainWrap, "\n", each(rows, rowOf)),
      ...captionSeq(field(node, "caption")),
    ];
  }

  function handleBlock(node: unknown): void {
    if (typeof node === "string") return run(lineSeq(node));
    // Массив вместо блока схемой не предусмотрен, но разворачивается как список
    // блоков: терять текст из-за лишней пары скобок не за что.
    if (Array.isArray(node)) return run(each(node, blockOf));
    if (!isRecord(node)) return;
    const found = blockMedia(node);
    if (found !== null) media.push(found);
    const type = field(node, "type");
    const body = field(node, "text");
    if (type === "divider") return emit("---");
    if (type === "heading")
      return run(lineSeq(body, headingWrap(field(node, "size"))));
    if (type === "pre") return run(preSeq(body, field(node, "language")));
    if (type === "list")
      return run(framed(plainWrap, "\n", each(field(node, "items"), itemOf)));
    if (type === "table") return run(tableSeq(node));
    if (type === "blockquote" || type === "pullquote")
      return run(framed(quoteWrap, BLOCK_SEP, blockSeq(node)));
    return run(blockSeq(node));
  }

  function handleText(node: unknown, mode: Mode): void {
    if (typeof node === "string")
      return emit(mode === "code" ? node : escapeLeaf(node));
    if (Array.isArray(node))
      return run(each(node, (child) => [textTask(child, mode)]));
    if (!isRecord(node)) return;
    const type = field(node, "type");
    if (type === "code") {
      // Внутри метки ссылки экранируется даже код: метка целиком наша, чужая скобка
      // в неё не попадает, и структура ссылки не зависит от старшинства разметки.
      const inner: Mode = mode === "label" ? "label" : "code";
      return run(lineSeq(field(node, "text"), codeWrap, inner));
    }
    const url = type === "url" ? asText(field(node, "url")) : "";
    const tail = tailText(node, url);
    if (tail !== "") {
      const live = mode === "text" && isWebUrl(url) ? url : "";
      chars += tail.length;
      const label = textTask(field(node, "text"), live === "" ? mode : "label");
      return run(framed(tailWrap(tail, live), "", [label], "", ` (${tail})`));
    }
    const mark = typeof type === "string" ? INLINE_MARKS[type] : undefined;
    if (mark !== undefined)
      return run(lineSeq(field(node, "text"), markWrap(mark), mode));
    // Всё остальное, включая незнакомые типы: `text` у двадцати подтипов,
    // `alternative_text` у custom_emoji, `expression` — у формулы.
    const body = field(node, "text");
    if (body !== undefined) return run([textTask(body, mode)]);
    const alternative = field(node, "alternative_text");
    if (typeof alternative === "string")
      return emit(mode === "code" ? alternative : escapeLeaf(alternative));
    const expression = field(node, "expression");
    if (typeof expression === "string")
      return emit(mode === "code" ? expression : codeWrap(expression));
  }

  function closeFrame(): void {
    if (frames.length < 2) return;
    const frame = frames[frames.length - 1];
    frames.pop();
    append(frame.wrap(frame.parts.join("")));
  }

  try {
    // Верхний уровень так же осторожен: сообщение — это `{ blocks }`, но одинокий
    // блок и голая строка тоже не теряются.
    const inner = isRecord(value) ? field(value, "blocks") : undefined;
    const source = inner === undefined ? value : inner;
    if (Array.isArray(source)) run(each(source, blockOf));
    else if (source !== undefined && source !== null) run(blockOf(source));

    // Потолки проверяются на задаче с содержимым, а не на закрытии кадра: иначе
    // truncated врал бы про сообщение, которое дочитано до конца. Готовый текст
    // выпускается раньше потолка узлов, чтобы хвост ссылки не пропал на самом краю.
    while (stack.length > 0) {
      const task = stack.pop();
      if (task === undefined) continue;
      else if (task.kind === "close") closeFrame();
      else if (task.kind === "open")
        frames.push({ parts: [], sep: task.sep, wrap: task.wrap });
      else if (chars > MAX_RICH_MESSAGE_CHARS) truncated = true;
      else if (task.kind === "emit") emit(task.value);
      else if (nodes >= MAX_RICH_MESSAGE_NODES) truncated = true;
      else {
        nodes += 1;
        if (task.kind === "block") handleBlock(task.node);
        else if (task.kind === "text") handleText(task.node, task.mode);
        else {
          // Курсор возвращается в стек под своих детей: следующий ребёнок читается
          // после того, как текущий дочитан до конца.
          const child = field(task.list, task.at);
          task.at += 1;
          if (task.at < width(task.list)) stack.push(task);
          run(task.make(child));
        }
      }
      // Сработал потолок — обход останавливается, прочитанное остаётся на месте.
      if (truncated) break;
    }
  } catch {
    // Ловушка последней надежды: прочитанное уже лежит в кадрах и в media.
    truncated = true;
  }

  while (frames.length > 1) closeFrame();
  // Ловушка съела поле — прочитанное неполно, и `truncated` обязан это сказать.
  const text = frames[0].parts.join("");
  return { text, media, truncated: truncated || traps !== seenTraps };
}

// Единая точка чтения текста сырого Telegram Message. Обычный text/caption всегда
// побеждает: rich_message нужен только как fallback для пустой проекции Bot API.
export function readTelegramMessageText(
  raw: TelegramRawMessage,
  text = asText(field(raw, "text")),
  caption = asText(field(raw, "caption")),
): TelegramMessageTextReading {
  const plain = text.trim() ? text : caption;
  if (plain.trim()) return { text: plain, caption, rich: null };
  const value = field(raw, "rich_message");
  if (value === undefined || value === null)
    return { text: "", caption, rich: null };
  const rich = readRichMessage(value);
  return rich.text.trim() || rich.media.length || rich.truncated
    ? { text: rich.text, caption, rich }
    : { text: "", caption, rich: null };
}
