import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkMarkdown,
  escHtml,
  htmlToPlain,
  mdToTelegramHtml,
  hasRichButtons,
  needsRichMessage,
  sanitizeTelegramHtml,
  toTelegramHtmlChunks,
} from "./telegram-format.ts";

await test("escaping and plain fallback preserve the existing entity order", () => {
  assert.equal(escHtml("<&>"), "&lt;&amp;&gt;");
  assert.equal(
    htmlToPlain("<b>a &amp;lt; &quot;quoted&quot;</b>"),
    'a &lt; "quoted"',
  );
});

await test("sanitizer repairs crossings and neutralizes unsupported markup", () => {
  assert.equal(
    sanitizeTelegramHtml("<b><i>x</b>y</i><script>x</script>&"),
    "<b><i>x</i></b><i>y</i>&lt;script&gt;x&lt;/script&gt;&amp;",
  );
  assert.equal(
    sanitizeTelegramHtml("<pre><b>x</b></pre>"),
    "<pre>&lt;b&gt;x&lt;/b&gt;</pre>",
  );
});

await test("markdown conversion retains current Telegram HTML fixtures", () => {
  const markdown =
    "# Title\n\n**bold** [link](https://x.test/?a=1&b=2)\n\n```js\nx < y\n```";

  assert.equal(
    mdToTelegramHtml(markdown),
    '<b>Title</b>\n\n<b>bold</b> <a href="https://x.test/?a=1&amp;b=2">link</a>\n\n<pre><code class="language-js">x &lt; y</code></pre>',
  );
});

await test("Markdown links preserve plain and escaped query separators", () => {
  for (const markdown of [
    "[link](https://example.org/?q=hello&page=2)",
    "[link](https://example.org/?q=hello\\&page=2)",
  ]) {
    const html = toTelegramHtmlChunks(markdown).join("\n");
    assert.equal(
      html,
      '<a href="https://example.org/?q=hello&amp;page=2">link</a>',
    );
    assert.doesNotMatch(html, /[\uE000\uE001]/u);
    const link = html.match(/href="([^"]+)"/u);
    assert.ok(link);
    assert.equal(new URL(htmlToPlain(link[1])).searchParams.get("page"), "2");
  }
  assert.deepEqual(toTelegramHtmlChunks("[link](https://example.org/path)"), [
    '<a href="https://example.org/path">link</a>',
  ]);
});

await test("HTML fallback retains escaped quotes and button labels beside a query link", () => {
  const markdown =
    "> Вопрос: \\*\\*так\\*\\* \\`код\\` \\& ответ?\n\n" +
    "[link](https://example.org/?q=hello\\&page=2)\n\n" +
    '<tg-button-row><tg-button type="callback_data" data="retry">Повторить & проверить</tg-button><tg-button type="url" url="https://example.org">Сайт</tg-button></tg-button-row>';
  assert.deepEqual(toTelegramHtmlChunks(markdown), [
    '<blockquote>Вопрос: **так** `код` &amp; ответ?</blockquote>\n\n<a href="https://example.org/?q=hello&amp;page=2">link</a>\n\n <b>Повторить &amp; проверить</b> <a href="https://example.org">Сайт</a>',
  ]);
});

await test("Wikipedia links retain underscores and balanced parentheses", () => {
  assert.equal(
    mdToTelegramHtml(
      "Источники: [название](https://ru.wikipedia.org/wiki/Крауч,_Блейк), [сюжет](https://en.wikipedia.org/wiki/Recursion_(Crouch_novel)).",
    ),
    'Источники: <a href="https://ru.wikipedia.org/wiki/Крауч,_Блейк">название</a>, <a href="https://en.wikipedia.org/wiki/Recursion_(Crouch_novel)">сюжет</a>.',
  );
  assert.equal(
    mdToTelegramHtml(
      "_до_ [**имя** `код`](https://x.test/a_(b_(c))_*_~~) *после*",
    ),
    '<i>до</i> <a href="https://x.test/a_(b_(c))_*_~~"><b>имя</b> <code>код</code></a> <i>после</i>',
  );
});

await test("link parsing keeps the first closing parenthesis when the URL is unbalanced", () => {
  assert.equal(
    mdToTelegramHtml("(see [docs](https://a.com))"),
    '(see <a href="https://a.com">docs</a>)',
  );
  assert.equal(
    mdToTelegramHtml("[q](https://e.com/search?q=(foo)"),
    '<a href="https://e.com/search?q=(foo">q</a>',
  );
  assert.equal(
    mdToTelegramHtml("[x](https://x.test/(open)"),
    '<a href="https://x.test/(open">x</a>',
  );
  assert.equal(
    mdToTelegramHtml("[a](https://a.com/(x) tail) more"),
    '<a href="https://a.com/(x">a</a> tail) more',
  );
});

await test("link parsing retains its label and URL work bounds", () => {
  const url = `https://${"a".repeat(2048)}`;
  assert.equal(mdToTelegramHtml(`[x](${url})`), `<a href="${url}">x</a>`);
  for (const markdown of [
    `[x](${url}a)`,
    `[${"x".repeat(201)}](https://x.test)`,
    `[x](https://${"(".repeat(100_000)})`,
    "[".repeat(100_000),
  ]) {
    assert.equal(mdToTelegramHtml(markdown), markdown);
  }
});

await test("prose that looks like a code placeholder survives intact", () => {
  // Regression: the inline-code placeholder used to be "two spaces, index, two
  // spaces", so ordinary prose with the same shape reached the chat mangled —
  // the text vanished or was replaced by an unrelated code span.
  assert.equal(
    mdToTelegramHtml("the price is  50  dollars"),
    "the price is  50  dollars",
  );
  assert.equal(
    mdToTelegramHtml("run `ls` then  0  items"),
    "run <code>ls</code> then  0  items",
  );
  assert.equal(mdToTelegramHtml("| a  |  1  |  2  |"), "| a  |  1  |  2  |");
});

await test("an inbound placeholder cannot forge a code span", () => {
  // U+E000/U+E001 are stripped on entry, so a "placeholder" sent from outside stays
  // ordinary text while the real code span is restored exactly once.
  assert.equal(
    mdToTelegramHtml("\uE0000\uE001 forged and `real`"),
    "0 forged and <code>real</code>",
  );
});

await test("chunking and rich routing keep their current boundaries", () => {
  assert.deepEqual(chunkMarkdown("a\n\nb\n\nc", 3), ["a", "b", "c"]);
  assert.deepEqual(toTelegramHtmlChunks("", 10), [""]);

  const chunks = toTelegramHtmlChunks(`**${"x".repeat(200)}**`, 40);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 40);
    assert.equal(sanitizeTelegramHtml(chunk), chunk);
  }

  assert.equal(needsRichMessage("- [ ] todo"), true);
  assert.equal(needsRichMessage("**bold** and `code`"), false);
  assert.equal(
    needsRichMessage('<tg-button data="Отложи на час">На час</tg-button>'),
    true,
  );
  assert.equal(
    needsRichMessage("<tg-collage>\n![](https://h/a.jpg)\n</tg-collage>"),
    true,
  );
  assert.equal(needsRichMessage('![](https://h/a.jpg "подпись")'), true);
  assert.equal(needsRichMessage("текст[^1]\n[^1]: сноска"), true);
  assert.equal(needsRichMessage("<tg-spoiler>секрет</tg-spoiler>"), false);
  assert.equal(
    hasRichButtons(
      '<tg-button type="url" url="https://t.me">Открыть</tg-button>',
    ),
    true,
  );
  assert.equal(hasRichButtons("| a | b |\n|---|---|"), false);
});

void test("HTML path never shows button tags: url becomes a link, the rest their label", () => {
  const html = toTelegramHtmlChunks(
    'Готово.\n\n<tg-button-row><tg-button type="callback_data" data="Да">Да</tg-button><tg-button type="url" url="https://iva-agent.com">Сайт</tg-button></tg-button-row>',
  ).join("\n");
  assert.doesNotMatch(html, /tg-button/);
  assert.match(html, /<b>Да<\/b>/);
  assert.match(html, /<a href="https:\/\/iva-agent\.com">Сайт<\/a>/);
});

await test("HTML path renders a fold as an expandable quote with a bold title", () => {
  assert.deepEqual(
    toTelegramHtmlChunks(
      "Итог.\n\n<details><summary>Детали</summary>\n\n- шаг **один**\n> цитата\n\n`код`\n</details>",
    ),
    [
      "Итог.\n\n<blockquote expandable><b>Детали</b>\n• шаг <b>один</b>\nцитата\n\n<code>код</code></blockquote>",
    ],
  );
  assert.deepEqual(toTelegramHtmlChunks("<details>тело</details>"), [
    "<blockquote expandable>тело</blockquote>",
  ]);
});

await test("malformed folds degrade to balanced text without literal tags", () => {
  assert.deepEqual(toTelegramHtmlChunks("<details>a"), [
    "<blockquote expandable>a</blockquote>",
  ]);
  assert.deepEqual(toTelegramHtmlChunks("x</details>y"), ["xy"]);
  assert.deepEqual(
    toTelegramHtmlChunks("<details><details>a</details>b</details>"),
    ["<blockquote expandable>ab</blockquote>"],
  );
  assert.deepEqual(toTelegramHtmlChunks("```\n<details>код</details>\n```"), [
    "<pre>&lt;details&gt;код&lt;/details&gt;</pre>",
  ]);
});

await test("a long fold is cut into self-contained expandable quotes within the limit", () => {
  const body = Array.from({ length: 60 }, (_, i) => `строка ${i}`).join("\n");
  const chunks = toTelegramHtmlChunks(
    `<details><summary>S</summary>${body}</details>`,
    300,
  );
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 300);
    assert.match(c, /^<blockquote expandable>/);
    assert.match(c, /<\/blockquote>$/);
  }
});

await test("a fenced log inside a fold renders as code, with no markdown applied to its lines", () => {
  assert.deepEqual(
    toTelegramHtmlChunks(
      "<details><summary>Лог</summary>\n\n```\na *b* _c_ `d`\n- x <y>\n```\nпосле **текст**\n</details>",
    ),
    [
      "<blockquote expandable><b>Лог</b><pre>a *b* _c_ `d`\n- x &lt;y&gt;</pre>после <b>текст</b></blockquote>",
    ],
  );
});

await test("a long fold with a fenced log stays code in every chunk", () => {
  const log = Array.from({ length: 40 }, (_, i) => `*n${i}* \`x\``).join("\n");
  const chunks = toTelegramHtmlChunks(
    `<details><summary>S</summary>\n\n\`\`\`\n${log}\n\`\`\`\n</details>`,
    300,
  );
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 300);
    assert.doesNotMatch(c, /```|<b>n|<code>/);
    assert.match(c, /^<blockquote expandable>/);
  }
});

await test("a literal <details> in a fence does not erase the marks of a real fold in other chunks", () => {
  const filler = Array.from({ length: 60 }, (_, i) => `строка ${i}`).join("\n");
  const chunks = toTelegramHtmlChunks(
    `\`\`\`\n<details>литерал</details>\n\`\`\`\n\n<details><summary>Д</summary>${filler}</details>`,
    300,
  );
  assert.ok(chunks.length > 2);
  assert.match(chunks[0], /^<pre>&lt;details&gt;/);
  for (const c of chunks.slice(1)) assert.match(c, /^<blockquote expandable>/);
});

await test("a quote line right before a fold does not swallow it", () => {
  assert.deepEqual(toTelegramHtmlChunks("> цитата\n<details>тело</details>"), [
    "<blockquote>цитата</blockquote>\n<blockquote expandable>тело</blockquote>",
  ]);
  assert.deepEqual(toTelegramHtmlChunks("<details>тело</details>\n> цитата"), [
    "<blockquote expandable>тело</blockquote>\n\n<blockquote>цитата</blockquote>",
  ]);
});
