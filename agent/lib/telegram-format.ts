// Markdown → Telegram HTML (parse_mode=HTML) — HARDENED, standalone, zero imports.
//
// Bulletproof contract:
//   • NEVER throws on ANY string input.
//   • ALWAYS emits HTML that Telegram parse_mode=HTML accepts: only & < > escaped,
//     only whitelisted tags, every tag balanced (LIFO), no crossing, no illegal
//     nesting inside <pre>/<code>, attribute values safe.
//   • Length-safe: chunk on a tag-safe boundary to <=4096 (text) / caption limit.
//
// ЕДИНЫЙ ИСТОЧНИК ПРАВДЫ для разметки Telegram. Единственный потребитель —
// Outbox (./outbox.ts), через который наружу идут и ответы канала, и ночные отчёты
// cron-скриптов. Pure string ops, ноль импортов — поэтому одинаково и бандлится
// rolldown'ом в eve-бандл, и исполняется голым node на cron-пути.

// ── escaping ──────────────────────────────────────────────────────────────────
const HTML_ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};
export const escHtml = (s: unknown): string =>
  String(s).replace(/[&<>]/g, (c) => HTML_ESC[c]);

// Attribute escaping, IDEMPOTENT: never double-escapes an existing entity.
const ENTITY = "#[0-9]+|#x[0-9a-fA-F]+|amp|lt|gt|quot";
const escAttr = (s: unknown): string =>
  String(s)
    .replace(new RegExp(`&(?!(?:${ENTITY});)`, "g"), "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// HTML → читаемый plain-текст для send-фолбэков. Шлётся БЕЗ parse_mode, поэтому
// сущности ДЕКОДИРУЕМ обратно (&amp;→&, &lt;→< и т.д.) — иначе в чат уйдут литеральные
// &amp;/&lt;. amp декодируем ПОСЛЕДНИМ, чтобы не разэкранировать дважды (&amp;lt; → &lt;).
// NB: это НЕ sanitizeTelegramHtml — тот отдаёт безопасный HTML; здесь голый текст.
export function htmlToPlain(html: unknown): string {
  return String(html)
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

// ── inline markdown → html ──────────────────────────────────────────────────────
// Protect escaped punctuation and inline code, escape the rest, then overlay tags.
// Метка code-span — индекс между U+E000 и U+E001 (Unicode Private Use Area).
// Прежняя метка «два пробела, индекс, два пробела» встречается в обычной прозе:
// «the price is  50  dollars» и строки таблиц уезжали в чат покалеченными — текст
// пропадал или подменялся чужим code-span. В тексте Telegram PUA не значит ничего,
// escHtml их не трогает, а пришедшие извне срезаются первым же шагом — поэтому
// подделать метку не может ни модель, ни пользователь.
function inlineHtml(text: unknown): string {
  const spans: string[] = [];
  const restoreSpans = (value: string) =>
    value.replace(/\uE000(\d+)\uE001/g, (_m, i) => spans[Number(i)] ?? "");
  let s = String(text)
    .replace(/[\uE000\uE001]/g, "")
    .replace(
      /\\([\\*_#|`[\]()~$&])|`([^`]+)`/g,
      (_m, escaped: string | undefined, code: string | undefined) => {
        spans.push(
          escaped === undefined
            ? `<code>${escHtml(code)}</code>`
            : escHtml(escaped),
        );
        return `\uE000${spans.length - 1}\uE001`;
      },
    );
  s = escHtml(s);
  // links [t](http(s)://url)
  // Границы квантификаторов обязательны: на строке из одних `[` жадный `[^\]]+`
  // пробегает хвост на каждой позиции и вешает однопоточный мост (200k знаков - 41 с).
  // Подпись длиннее 200 знаков и URL длиннее 2048 в сообщение Telegram не поместятся,
  // так что отсечение живого текста не теряет.
  const link = /\[([^\]\n]{1,200})\]\((https?:\/\/)/g;
  let linked = "",
    cursor = 0,
    match;
  while ((match = link.exec(s))) {
    let end = link.lastIndex,
      depth = 0,
      firstClose = -1;
    for (; end < s.length && end < link.lastIndex + 2048; end++) {
      const char = s[end];
      if (/\s/.test(char) || (char === ")" && depth === 0)) break;
      if (char === "(") depth++;
      if (char === ")") {
        if (firstClose < 0) firstClose = end;
        depth--;
      }
    }
    if (s[end] !== ")" || depth !== 0) end = firstClose;
    if (end <= link.lastIndex) continue;
    // Открывающий тег хранится в spans, подпись проходит правила разметки.
    spans.push(
      `<a href="${escAttr(restoreSpans(match[2] + s.slice(link.lastIndex, end)))}">`,
    );
    linked +=
      s.slice(cursor, match.index) +
      `\uE000${spans.length - 1}\uE001${match[1]}</a>`;
    cursor = link.lastIndex = end + 1;
  }
  s = linked + s.slice(cursor);
  // bold
  s = s
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_]+)__/g, "<b>$1</b>");
  // strikethrough
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  // spoiler ||text||
  s = s.replace(
    /\|\|([^|]+(?:\|(?!\|)[^|]*)*)\|\|/g,
    "<tg-spoiler>$1</tg-spoiler>",
  );
  // italic (single * or _), not touching the ** / __ already consumed
  s = s
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>")
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<i>$1</i>");
  // restore protected spans
  return restoreSpans(s);
}

// GFM table separator: |---|:--:|---|
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
const tableCells = (line: string): string[] =>
  line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());

// ── block + inline converter ────────────────────────────────────────────────────
function convert(md: unknown): string {
  // PUA-метка code-span извне срезается до разбора фенсов: иначе она проезжает
  // через fenced-путь (escHtml тела) и уходит в отправленное сообщение.
  const lines = String(md)
    .replace(/\r\n/g, "\n")
    .replace(/[\uE000\uE001]/g, "")
    .split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // fenced code, optionally with language → <pre><code class="language-x">
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]))
        body.push(lines[i++]);
      i++; // closing ``` (no-op if half-open / EOF)
      const inner = escHtml(body.join("\n"));
      // Пустой забор ничего не показывает: пустое сообщение пользователю не нужно.
      if (inner)
        out.push(
          lang
            ? `<pre><code class="language-${lang}">${inner}</code></pre>`
            : `<pre>${inner}</pre>`,
        );
      continue;
    }
    // table: header row + separator → header bold, body rows joined with ·
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      TABLE_SEP_RE.test(lines[i + 1])
    ) {
      out.push(`<b>${tableCells(line).map(inlineHtml).join("  ·  ")}</b>`);
      i += 2;
      while (
        i < lines.length &&
        lines[i].includes("|") &&
        lines[i].trim() !== ""
      ) {
        out.push(tableCells(lines[i]).map(inlineHtml).join("  ·  "));
        i++;
      }
      continue;
    }
    // ATX heading → bold
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      out.push(`<b>${inlineHtml(h[1].trim())}</b>`);
      i++;
      continue;
    }
    // blockquote (grouped, multi-line); leading "!" on first line → expandable
    if (/^>\s?/.test(line)) {
      const ql = [];
      while (i < lines.length) {
        const mm = /^>\s?(.*)$/.exec(lines[i]);
        if (!mm) break;
        ql.push(mm[1]);
        i++;
      }
      let expandable = false;
      if (ql[0] && /^!\s?/.test(ql[0])) {
        expandable = true;
        ql[0] = ql[0].replace(/^!\s?/, "");
      }
      const inner = ql.map(inlineHtml).join("\n");
      out.push(
        expandable
          ? `<blockquote expandable>${inner}</blockquote>`
          : `<blockquote>${inner}</blockquote>`,
      );
      continue;
    }
    // unordered list
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      out.push(`• ${inlineHtml(ul[1])}`);
      i++;
      continue;
    }
    // ordered list
    const ol = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (ol) {
      out.push(`${ol[1]}. ${inlineHtml(ol[2])}`);
      i++;
      continue;
    }
    // horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push("—");
      i++;
      continue;
    }
    out.push(line.trim() === "" ? "" : inlineHtml(line));
    i++;
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── tag whitelist / tokenizer for the safety pass ───────────────────────────────
const CLOSE_RE =
  /^<\/(b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|span|a|tg-spoiler|tg-emoji|tg-time)>/;
const ENTITY_RE = new RegExp(`^&(?:${ENTITY});`);

type OpenTag = { kind: "open"; len: number; name: string; html: string };
type CloseTag = { kind: "close"; len: number; name: string };
type Tag = OpenTag | CloseTag;

// Returns { kind:'open'|'close', len, name, html } or null if not a valid tag.
function matchTagAt(s: string): Tag | null {
  let m = CLOSE_RE.exec(s);
  if (m) return { kind: "close", len: m[0].length, name: m[1] };
  m =
    /^<(b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|tg-spoiler)>/.exec(
      s,
    );
  if (m) return { kind: "open", len: m[0].length, name: m[1], html: m[0] };
  m = /^<blockquote expandable>/.exec(s);
  if (m)
    return {
      kind: "open",
      len: m[0].length,
      name: "blockquote",
      html: "<blockquote expandable>",
    };
  m = /^<a\s+href="([^"<>]*)">/.exec(s);
  if (m)
    return {
      kind: "open",
      len: m[0].length,
      name: "a",
      html: `<a href="${escAttr(m[1])}">`,
    };
  m = /^<span class="tg-spoiler">/.exec(s);
  if (m) return { kind: "open", len: m[0].length, name: "span", html: m[0] };
  m = /^<code class="language-([A-Za-z0-9+#._-]*)">/.exec(s);
  if (m)
    return {
      kind: "open",
      len: m[0].length,
      name: "code",
      html: `<code class="language-${m[1]}">`,
    };
  m = /^<tg-emoji emoji-id="([0-9]+)">/.exec(s);
  if (m)
    return {
      kind: "open",
      len: m[0].length,
      name: "tg-emoji",
      html: `<tg-emoji emoji-id="${m[1]}">`,
    };
  m = /^<tg-time unix="([0-9]+)"(?:\s+format="([a-zA-Z]*)")?>/.exec(s);
  if (m)
    return {
      kind: "open",
      len: m[0].length,
      name: "tg-time",
      html:
        m[2] != null
          ? `<tg-time unix="${m[1]}" format="${m[2]}">`
          : `<tg-time unix="${m[1]}">`,
    };
  return null;
}

// ── FINAL SAFETY PASS ────────────────────────────────────────────────────────────
// Walks the string; emits only whitelisted/balanced tags; neutralizes every stray
// < > & so Telegram's parser can never 400. Repairs crossing via close+reopen,
// forbids tags inside <code> and any non-<code> tag inside <pre>, balances at EOF.
// NEVER throws.
export function sanitizeTelegramHtml(input: unknown): string {
  try {
    const s = String(input);
    const out = [];
    const stack: Array<{ name: string; html: string }> = [];
    const n = s.length;
    let i = 0;
    while (i < n) {
      const ch = s[i];
      if (ch === "&") {
        const m = ENTITY_RE.exec(s.slice(i));
        if (m) {
          out.push(m[0]);
          i += m[0].length;
        } else {
          out.push("&amp;");
          i++;
        }
        continue;
      }
      if (ch === ">") {
        out.push("&gt;");
        i++;
        continue;
      }
      if (ch !== "<") {
        out.push(ch);
        i++;
        continue;
      }

      const t = matchTagAt(s.slice(i));
      const top = stack[stack.length - 1];

      // verbatim contexts: nothing may nest inside <code>; only a <code> child or
      // </pre> may appear directly inside <pre>.
      if (top && top.name === "code") {
        if (t && t.kind === "close" && t.name === "code") {
          out.push("</code>");
          stack.pop();
          i += t.len;
        } else {
          out.push("&lt;");
          i++;
        }
        continue;
      }
      if (top && top.name === "pre") {
        if (t && t.kind === "close" && t.name === "pre") {
          out.push("</pre>");
          stack.pop();
          i += t.len;
        } else if (t && t.kind === "open" && t.name === "code") {
          out.push(t.html);
          stack.push({ name: "code", html: t.html });
          i += t.len;
        } else {
          out.push("&lt;");
          i++;
        }
        continue;
      }

      if (!t) {
        out.push("&lt;");
        i++;
        continue;
      }

      if (t.kind === "open") {
        // blockquote cannot nest inside blockquote → drop the redundant tag (keep text).
        if (
          t.name === "blockquote" &&
          stack.some((e) => e.name === "blockquote")
        ) {
          i += t.len;
          continue;
        }
        out.push(t.html);
        stack.push({ name: t.name, html: t.html });
        i += t.len;
        continue;
      }

      // close tag
      let idx = -1;
      for (let k = stack.length - 1; k >= 0; k--)
        if (stack[k].name === t.name) {
          idx = k;
          break;
        }
      if (idx === -1) {
        i += t.len;
        continue;
      } // stray close → drop
      const reopened: Array<{ name: string; html: string }> = [];
      for (let k = stack.length - 1; k > idx; k--) {
        out.push(`</${stack[k].name}>`);
        reopened.push(stack[k]);
      }
      out.push(`</${t.name}>`);
      stack.length = idx;
      for (let k = reopened.length - 1; k >= 0; k--) {
        out.push(reopened[k].html);
        stack.push(reopened[k]);
      }
      i += t.len;
    }
    for (let k = stack.length - 1; k >= 0; k--) out.push(`</${stack[k].name}>`);
    return out.join("");
  } catch {
    // Absolute last resort: strip everything to plain escaped text.
    try {
      return String(input)
        .replace(/<[^>]*>/g, "")
        .replace(/[&<>]/g, (c) => HTML_ESC[c]);
    } catch (error) {
      console.error(
        `[telegram] форматтер упал, и запасное экранирование тоже: ${String(error)}`,
      );
      return "";
    }
  }
}

// ── public converter ──────────────────────────────────────────────────────────────
export function mdToTelegramHtml(md: unknown): string {
  try {
    return sanitizeTelegramHtml(convert(md));
  } catch {
    try {
      return escHtml(md);
    } catch (error) {
      console.error(
        `[telegram] md→HTML не удался, и запасное экранирование тоже: ${String(error)}`,
      );
      return "";
    }
  }
}

// ── chunking ────────────────────────────────────────────────────────────────────
// Split RAW markdown on blank lines so each chunk's markup stays self-contained.
// Long paragraphs/lines are hard-split so no source chunk exceeds `limit`
// (JS string .length already counts UTF-16 code units, matching Telegram).
export function chunkMarkdown(md: unknown, limit = 3500): string[] {
  const text = String(md);
  if (text.length <= limit) return [text];
  // Кусок несёт свой разделитель: "\n\n" между абзацами, "\n" между строками одного
  // абзаца, "" внутри разрезанной строки. Раньше строки абзаца склеивались заново
  // пустой строкой, и длинный блок кода приезжал с пустой строкой между каждой строкой.
  const pieces: { text: string; sep: string }[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    if (paragraph.length <= limit) {
      pieces.push({ text: paragraph, sep: "\n\n" });
      continue;
    }
    let firstLine = true;
    for (const line of paragraph.split("\n")) {
      const sep = firstLine ? "\n\n" : "\n";
      firstLine = false;
      if (line.length <= limit) {
        pieces.push({ text: line, sep });
        continue;
      }
      for (let j = 0; j < line.length;) {
        let end = Math.min(line.length, j + limit);
        // Не разрывать суррогатную пару: Telegram покажет «�» на стыке сообщений.
        if (
          end < line.length &&
          /[\uD800-\uDBFF]/.test(line[end - 1]) &&
          /[\uDC00-\uDFFF]/.test(line[end])
        )
          end -= 1;
        if (end <= j) end = j + limit;
        pieces.push({ text: line.slice(j, end), sep: j === 0 ? sep : "" });
        j = end;
      }
    }
  }
  const chunks: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    const sep = cur === "" ? "" : piece.sep;
    if (cur && cur.length + sep.length + piece.text.length > limit) {
      chunks.push(cur);
      cur = piece.text;
      continue;
    }
    cur = cur ? `${cur}${sep}${piece.text}` : piece.text;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Tokenize HTML into indivisible atoms (a whole tag, a whole entity, or one char)
// so a hard split never lands inside a tag or entity.
function htmlAtoms(s: string): string[] {
  const atoms: string[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    if (s[i] === "<") {
      const t = matchTagAt(s.slice(i));
      if (t) {
        atoms.push(s.slice(i, i + t.len));
        i += t.len;
        continue;
      }
    }
    if (s[i] === "&") {
      const m = ENTITY_RE.exec(s.slice(i));
      if (m) {
        atoms.push(m[0]);
        i += m[0].length;
        continue;
      }
    }
    atoms.push(s[i]);
    i++;
  }
  return atoms;
}

// Hard-split already-converted HTML to <=limit, on atom boundaries, re-balancing
// each piece via the safety pass. Reserve headroom for auto-inserted close tags.
function splitHtmlHard(html: string, limit: number): string[] {
  if (html.length <= limit) return [sanitizeTelegramHtml(html)];
  const reserve = Math.min(200, Math.floor(limit / 4));
  const budget = Math.max(1, limit - reserve);
  const pieces: string[] = [];
  let buf = "";
  for (const a of htmlAtoms(html)) {
    if (buf && buf.length + a.length > budget) {
      pieces.push(sanitizeTelegramHtml(buf));
      buf = "";
    }
    buf += a;
  }
  if (buf) pieces.push(sanitizeTelegramHtml(buf));
  // Final guarantee: nothing exceeds the hard limit even after re-balancing.
  const safe: string[] = [];
  for (const p of pieces) {
    if (p.length <= limit) {
      safe.push(p);
      continue;
    }
    for (let j = 0; j < p.length; j += limit)
      safe.push(sanitizeTelegramHtml(p.slice(j, j + limit)));
  }
  return safe;
}

// One-call helper: markdown → array of send-ready, balanced HTML chunks, each
// guaranteed <= limit. (text=4096, caption=1024). NEVER throws.
// Кнопка живёт только в rich-сообщении. Когда rich отвергнут (BUTTON_DATA_INVALID,
// старый Bot API) и текст идёт HTML-путём, тег не должен доехать до чата буквами:
// url-кнопка становится ссылкой, остальные — своей подписью, ряд — строкой подписей.
export function stripRichButtons(md: string): string {
  return md
    .replace(
      /<tg-button(?=[\s>])([^>]*)>([\s\S]*?)<\/tg-button>/gi,
      (_m, attrs: string, label: string) => {
        const url = /\btype="url"/i.test(attrs)
          ? /\burl="([^"]*)"/i.exec(attrs)?.[1]
          : undefined;
        const text = label.trim();
        return (url ? `[${text}](${url})` : `**${text}**`) + " ";
      },
    )
    .replace(/<\/?tg-button-row\b[^>]*>/gi, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +$/gm, "");
}

export function toTelegramHtmlChunks(md: unknown, limit = 4096): string[] {
  try {
    const cap = Math.max(1, limit);
    const srcLimit = Math.min(3500, Math.floor(cap * 0.85));
    const result: string[] = [];
    for (const src of chunkMarkdown(stripRichButtons(String(md)), srcLimit)) {
      const html = mdToTelegramHtml(src);
      if (html.length <= cap) {
        // Кусок, из которого ничего не отрендерилось (пустой забор, пробелы),
        // не отправляем: пустое сообщение в чате - шум.
        if (html) result.push(html);
      } else for (const piece of splitHtmlHard(html, cap)) result.push(piece);
    }
    return result.length ? result : [""];
  } catch {
    try {
      return [escHtml(md)];
    } catch (error) {
      console.error(
        `[telegram] нарезка ответа не удалась, текст потерян: ${String(error)}`,
      );
      return [""];
    }
  }
}

// ── rich-message routing ────────────────────────────────────────────────────────
// True when the text has a construct that Telegram's rich messages
// (sendRichMessage, Bot API 10.1) render natively but parse_mode=HTML CANNOT:
// GFM tables, task lists, <details>, block math, footnotes, media blocks, <tg-*>
// tags (buttons, collage, slideshow, map, time), pull quotes. Headings/quotes/bold
// render fine in HTML, so — like hermes-agent — we do NOT route on those: normal
// replies stay on the proven HTML path. Conservative by design: a false negative
// is just today's behavior; a false positive falls back on API rejection anyway.
/**
 * Кнопка без `type`: Telegram отвергает весь rich message (400 BUTTON_URL_INVALID), и ответ
 * уходит HTML-путём уже без кнопок. Модель забывает атрибут — по остальным видно, что она
 * имела в виду: `data` → callback_data, `url` → url, `text` → copy_text. Ничего из них —
 * кнопка остаётся как есть.
 */
export function withButtonTypes(md: string): string {
  return md.replace(/<tg-button(?=[\s>])([^>]*)>/gi, (tag, attrs: string) => {
    if (/\stype\s*=/i.test(attrs)) return tag;
    const type = /\sdata\s*=/i.test(attrs)
      ? "callback_data"
      : /\surl\s*=/i.test(attrs)
        ? "url"
        : /\stext\s*=/i.test(attrs)
          ? "copy_text"
          : null;
    return type === null ? tag : `<tg-button type="${type}"${attrs}>`;
  });
}

/** Предел callback_data у Telegram: 64 байта UTF-8. Длиннее — 400 BUTTON_DATA_INVALID. */
export const BUTTON_DATA_MAX_BYTES = 64;

// Атом значения атрибута: HTML-сущность целиком или один символ (кодовая точка, флаг u).
const ATTRIBUTE_ATOM_RE = /&(?:#\d+|#x[\da-f]+|[a-z]+);|[\s\S]/giu;

/**
 * Начало `data` в пределах 64 байт UTF-8: режется по границе символа и не посреди
 * HTML-сущности. Байты считаются по сырому значению атрибута — так предел держится,
 * разворачивает Telegram сущности или нет.
 */
export function shortenButtonData(
  data: string,
  maxBytes = BUTTON_DATA_MAX_BYTES,
): string {
  if (Buffer.byteLength(data) <= maxBytes) return data;
  let out = "";
  let bytes = 0;
  for (const [atom] of data.matchAll(ATTRIBUTE_ATOM_RE)) {
    bytes += Buffer.byteLength(atom);
    if (bytes > maxBytes) break;
    out += atom;
  }
  return out;
}

/**
 * Укороченный `data`, совпавший с `data` кнопки выше в том же сообщении, получает хвост
 * «#2», «#3»… в пределах 64 байт: Bridge узнаёт нажатие по chat:message:data
 * (scripts/poller/control.ts, tapKey), и две одинаковые кнопки стали бы одной.
 */
function distinctData(data: string, seen: ReadonlySet<string>): string {
  let short = shortenButtonData(data);
  for (let n = 2; short !== data && seen.has(short); n++) {
    const suffix = `#${n}`;
    short =
      shortenButtonData(
        data,
        BUTTON_DATA_MAX_BYTES - Buffer.byteLength(suffix),
      ) + suffix;
  }
  return short;
}

const BUTTON_DATA_RE = /(<tg-button(?=[\s>])[^>]*?\sdata=")([^"]*)(")/gi;

/**
 * Модель пишет в `data` целую фразу, а одна длинная кнопка роняет всё rich-сообщение:
 * Telegram отвергает его целиком, и ответ уходит HTML-путём уже без кнопок. Длинный
 * `data` укорачивается до предела; тап приходит модели этим началом фразы, а совпавшие
 * после укорачивания кнопки различаются хвостом «#N».
 */
export function shortenButtonsData(md: string): string {
  const seen = new Set<string>();
  return md.replace(
    BUTTON_DATA_RE,
    (_tag, head: string, data: string, tail: string) => {
      const short = distinctData(data, seen);
      seen.add(short);
      if (short !== data)
        console.error(
          `[telegram] button data shortened: ${Buffer.byteLength(data)} → ${BUTTON_DATA_MAX_BYTES}`,
        );
      return head + short + tail;
    },
  );
}

export function hasRichButtons(md: unknown): boolean {
  return /<tg-button[\s>]/i.test(String(md));
}

// Чужой текст одной строкой внутри rich-сообщения: цитата вопроса владельца в сообщении о
// сбое, фраза модели в статусе хода. Пробелы и переводы строк схлопнуты, длина — не больше
// maxChars знаков, на обрезе «…». Разметкой текст стать не может: `<` и `>` заменены
// угловыми кавычками (тег не откроется), знаки разметки `*_#|` экранированы, как в
// escapeRichText (scripts/lib/telegram-buttons.ts), а с ними `` ` ``, `[`, `]`, `(`, `)`,
// `~`, `$` и обратная косая: иначе `\*` из текста стал бы экранированной косой и голой
// звёздочкой. Экранирован и `&`: из `&lt;tg-button…&gt;` разборщик, который сначала
// разворачивает сущности, собрал бы настоящую кнопку, а `\&lt;` при любом порядке разбора
// остаётся текстом. Обрезанный ключ гейт уже не узнаёт: текст, который гейт ещё не видел,
// идёт через него до этой функции.
export function richQuoteLine(text: string, maxChars: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  const chars = Array.from(line);
  const cut =
    chars.length <= maxChars
      ? line
      : `${chars
          .slice(0, maxChars - 1)
          .join("")
          .trimEnd()}…`;
  return cut
    .replace(/</gu, "‹")
    .replace(/>/gu, "›")
    .replace(/([\\*_#|`[\]()~$&])/gu, "\\$1");
}

export function needsRichMessage(md: unknown): boolean {
  const s = String(md);
  // GFM table delimiter row: a line of only pipes/dashes/colons/space with a dash run.
  // Plain prose effectively never produces such a line, so this alone is a safe signal.
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t.includes("|") && /-{2,}/.test(t) && /^[|\-: \t]+$/.test(t))
      return true;
  }
  if (/^[ \t]*[-*][ \t]+\[[ xX]\][ \t]+/m.test(s)) return true; // task list
  if (/<details[\s>]/i.test(s)) return true; // collapsible
  if (/<aside[\s>]/i.test(s)) return true; // pull quote
  if (/\$\$[\s\S]+?\$\$/.test(s)) return true; // block math
  if (/^\[\^[^\]]+\]:/m.test(s)) return true; // footnote definition
  if (/^!\[[^\]]*\]\(https?:\/\//m.test(s)) return true; // media block by public URL
  // <tg-button>, <tg-collage>, <tg-slideshow>, <tg-map>, <tg-time>, <tg-emoji>:
  // rich-only tags; <tg-spoiler> is also plain-HTML syntax and stays on that path.
  if (/<tg-(?!spoiler)[a-z-]+[\s>/]/i.test(s)) return true;
  return false;
}
