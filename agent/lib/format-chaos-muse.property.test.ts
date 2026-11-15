/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Хаос криворукого пользователя в разметке Telegram (прогон muse).
// Контракт из шапки telegram-format.ts: NEVER throws на ЛЮБОЙ строке.
// Проверяем: 50к знаков, одиночные суррогаты, подделка PUA-метки code-span,
// незакрытые фенсы, прогоны труб (ReDoS-зонд), вложенная разметка, эмодзи.
// Плюс граница чанков: каждый кусок toTelegramHtmlChunks обязан влезть в лимит.
//
// КАК ВОСПРОИЗВЕСТИ: seed в имени теста; при провале подставь и path:
// fc.assert(prop, { seed, path }).
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  chunkMarkdown,
  escHtml,
  htmlToPlain,
  mdToTelegramHtml,
  needsRichMessage,
  sanitizeTelegramHtml,
  toTelegramHtmlChunks,
} from "./telegram-format.ts";

const SEED = 20_260_915;

const chunkArb = fc.constantFrom(
  "**жирный",
  "жирный**",
  "**",
  "*курсив",
  "_",
  "~~зачёрк",
  "||спойлер",
  "`код",
  "```",
  "```js\nкод\n",
  "[текст](https://example.com/ооо)",
  "[текст](javascript:alert(1))",
  "||a|b||",
  "|||",
  "|---|---|",
  "# Заголовок",
  "> цитата",
  "- [ ] задача",
  "<b>голый html</b>",
  "<script>alert(1)</script>",
  "&amp; &lt; &gt; &quot;",
  "\uE0000\uE001",
  "подделка \uE000 метки \uE001",
  "lone surrogate \ud800 и \udc00",
  "\u0000\u0007\u200b",
  "📅⏰🎉".repeat(20),
  "a".repeat(5000),
  "|".repeat(500),
  "*".repeat(500),
  "_".repeat(500),
  "`".repeat(200),
  "[",
  "](",
  "http://",
  "\r\n",
  "\t",
);

const mdArb = fc
  .array(chunkArb, { maxLength: 12 })
  .map((parts) => parts.join("\n"));

test(`mdToTelegramHtml: никогда не бросает, метка не течет (seed ${SEED})`, () => {
  fc.assert(
    fc.property(mdArb, (md) => {
      const html = mdToTelegramHtml(md);
      assert.equal(typeof html, "string");
      // PUA-метка code-span не имеет права ни появиться из ничего, ни проехать
      // наружу из чужого текста (fenced-путь чинится в convert).
      const hadMarkers = /[\uE000\uE001]/.test(md);
      if (!hadMarkers) {
        assert.ok(!/[\uE000\uE001]/.test(html), "метка родилась из ничего");
      }
      assert.equal(mdToTelegramHtml(md), html);
    }),
    { seed: SEED, numRuns: 300 },
  );
});

test(`htmlToPlain: никогда не бросает, детерминирован (seed ${SEED})`, () => {
  fc.assert(
    fc.property(mdArb, (md) => {
      const plain = htmlToPlain(mdToTelegramHtml(md));
      assert.equal(typeof plain, "string");
      assert.equal(htmlToPlain(mdToTelegramHtml(md)), plain);
    }),
    { seed: SEED, numRuns: 300 },
  );
});

test(`sanitize+esc: никогда не бросают на любом юникоде (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary", maxLength: 2000 }), (s) => {
      assert.equal(typeof escHtml(s), "string");
      assert.equal(typeof sanitizeTelegramHtml(s), "string");
      assert.equal(typeof needsRichMessage(s), "boolean");
    }),
    { seed: SEED, numRuns: 300 },
  );
});

test(`chunks: каждый кусок влезает в реалистичный лимит (seed ${SEED})`, () => {
  fc.assert(
    fc.property(mdArb, fc.constantFrom(1024, 4096), (md, limit) => {
      for (const chunk of toTelegramHtmlChunks(md, limit)) {
        assert.ok(
          chunk.length <= limit,
          `кусок ${chunk.length} при лимите ${limit}: ${chunk.slice(0, 80)}`,
        );
      }
      for (const chunk of chunkMarkdown(md, limit)) {
        assert.ok(chunk.length <= limit);
      }
    }),
    { seed: SEED, numRuns: 200 },
  );
});

// --- Примеры тупого пользователя: фиксированные входы ---

test("PUA-метка извне не проезжает через кодовый фенс (F4)", () => {
  // Шапка модуля обещает: пришедшие извне \uE000/\uE001 срезаются первым же
  // шагом. Фенсный путь это нарушал: метка уезжала в отправленное сообщение
  // и при повторной обработке HTML могла быть принята за настоящий code-span.
  const html = mdToTelegramHtml("```\nподделка \uE0007\uE001 ок\n```");
  assert.ok(
    !/[\uE000\uE001]/.test(html),
    "PUA-метка не должна доезжать до отправки",
  );
  assert.ok(html.includes("подделка"));
  assert.ok(html.includes("7"));
});

test("пример: подделка метки code-span срезается, чужой код не рождается", () => {
  const html = mdToTelegramHtml("подделка \uE0007\uE001 ок");
  assert.ok(!/[\uE000\uE001]/.test(html));
  assert.ok(!html.includes("<code>"), "из PUA-мусора код не рождается");
  assert.ok(html.includes("подделка"));
});

test("пример: одиночные суррогаты не роняют конвейер", () => {
  const html = mdToTelegramHtml("lone \ud800 surrogate \udc00 хвост");
  assert.equal(typeof html, "string");
  assert.equal(typeof htmlToPlain(html), "string");
});

test("пример: текст 50к эмодзи - конвейер быстрый", () => {
  const md = "📅⏰".repeat(25_000);
  const started = Date.now();
  const chunks = toTelegramHtmlChunks(md, 4096);
  assert.ok(chunks.length > 1, "простыня обязана резаться");
  for (const chunk of chunks) assert.ok(chunk.length <= 4096);
  assert.ok(Date.now() - started < 5000, "простыня обязана резаться быстро");
});

test("пример: прогон труб 2000 знаков - без зависания спойлера", () => {
  const md = `||${"|".repeat(2000)}`;
  const started = Date.now();
  const html = mdToTelegramHtml(md);
  assert.equal(typeof html, "string");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `подозрение на ReDoS: ${elapsed}мс`);
});

test("пример: прогон звездочек 5000 знаков - без зависания курсива", () => {
  const md = `*${"a*".repeat(2500)}`;
  const started = Date.now();
  assert.equal(typeof mdToTelegramHtml(md), "string");
  assert.ok(Date.now() - started < 5000, "курсив обязан завершаться быстро");
});

test("пример: незакрытый фенс 10к строк - один кусок кода, не взрыв", () => {
  const md = `начало\n\`\`\`js\n${"код\n".repeat(10_000)}`;
  const started = Date.now();
  const html = mdToTelegramHtml(md);
  assert.ok(html.includes("<pre>"));
  assert.ok(Date.now() - started < 5000);
});

test(`folds in any arrangement never leave literal tags or unbalanced quotes (seed ${SEED})`, () => {
  const piece = fc.constantFrom(
    "<details>",
    "</details>",
    "<summary>",
    "</summary>",
    "<details open>",
    "<summary>Итог</summary>",
    "текст",
    "\n",
    "\n\n",
    "> цитата\n",
    "**b**",
    "<",
    "&",
    "\n```\n",
    "```js\n",
    "```",
    "*_`",
  );
  fc.assert(
    fc.property(
      fc.array(piece, { maxLength: 40 }).map((a) => a.join("")),
      fc.integer({ min: 100, max: 400 }),
      (text, limit) => {
        for (const chunk of toTelegramHtmlChunks(text, limit)) {
          assert.ok(chunk.length <= limit);
          // Литерал в коде легитимен, а длинный <pre> режется по атомам HTML:
          // буквы тега проверяем только там, где кода нет.
          if (!text.includes("```"))
            assert.doesNotMatch(chunk, /&lt;\/?(?:details|summary)/);
          assert.equal(
            (chunk.match(/<pre>/g) ?? []).length,
            (chunk.match(/<\/pre>/g) ?? []).length,
          );
          assert.equal(
            (chunk.match(/<blockquote[ >]/g) ?? []).length,
            (chunk.match(/<\/blockquote>/g) ?? []).length,
          );
        }
      },
    ),
    { seed: SEED, numRuns: 500 },
  );
});
