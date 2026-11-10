import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import {
  blockButtons,
  button,
  buttonRow,
  classicScreen,
  escapeRichText,
  markTappedButton,
  screenPayload,
} from "./telegram-buttons.ts";
import { tempDir } from "../fixtures/temp-dir.ts";

void test("classic: a button line becomes one keyboard row and its explanation stays in the text", () => {
  const md = [
    "# Заголовок",
    `${button("Обновить", "iva_update:go", "success")} — поставить новую версию.`,
    buttonRow([button("Да", "y"), button("Нет", "n", "danger")]),
  ].join("\n");
  const screen = classicScreen(md);
  assert.equal(screen.text.split("\n")[0], "Заголовок");
  assert.match(screen.text, /поставить новую версию\./);
  assert.deepEqual(screen.reply_markup, {
    inline_keyboard: [
      [{ text: "Обновить", callback_data: "iva_update:go", style: "success" }],
      [
        { text: "Да", callback_data: "y" },
        { text: "Нет", callback_data: "n", style: "danger" },
      ],
    ],
  });
});

void test("classic: a tag without data or label yields no keyboard, text survives", () => {
  const screen = classicScreen(
    '<tg-button type="callback_data"></tg-button>\nтекст',
  );
  assert.equal(screen.reply_markup, undefined);
  assert.match(screen.text, /текст/);
});

void test("blockButtons: a lone «button — explanation» becomes a row over its paragraph; an explicit row is left alone", () => {
  const one = `${button("A", "a")} — что делает.`;
  assert.equal(
    blockButtons(one),
    `${buttonRow([button("A", "a")])}\nчто делает.`,
  );
  const two = buttonRow([button("A", "a"), button("B", "b")]);
  assert.equal(blockButtons(two), two);
});

void test("two per row: consecutive button lines pair up in both renders, a styled button stays alone", () => {
  const md = [
    "# Меню",
    "",
    `${button("🧠 Модель", "m")} — провайдер и ключ.`,
    "",
    `${button("🩺 Доктор", "d")} — проверить установку.`,
    "",
    `${button("💾 Память", "p")} — что помнит.`,
    "",
    `${button("✖ Закрыть", "x", "danger")} — убрать меню.`,
  ].join("\n");
  const classic = classicScreen(md);
  assert.deepEqual(
    classic.reply_markup?.inline_keyboard.map((row) => row.map((b) => b.text)),
    [["🧠 Модель", "🩺 Доктор"], ["💾 Память"], ["✖ Закрыть"]],
  );
  assert.match(
    classic.text,
    /🧠 Модель — провайдер и ключ\.\n🩺 Доктор — проверить установку\./,
  );
  const rich = blockButtons(md);
  assert.equal(
    rich.split("\n").filter((l) => l.startsWith("<tg-button-row")).length,
    3,
  );
  assert.match(
    rich,
    /<tg-button-row>.*data="m".*data="d".*<\/tg-button-row>\n🧠 Модель — провайдер и ключ\. {2}\n🩺 Доктор — проверить установку\.\n\n<tg-button-row>/,
  );
  // Одиночная кнопка в ряду: подпись без повтора её имени, как раньше.
  assert.match(
    rich,
    /<tg-button-row>.*data="p".*<\/tg-button-row>\nчто помнит\./,
  );
});

void test("screenPayload: rich only when settings.json says so, classic otherwise", () => {
  const saved = process.env.ASSISTANT_DATA_DIR;
  const dir = tempDir("iva-buttons-");
  try {
    process.env.ASSISTANT_DATA_DIR = dir;
    const md = `${button("A", "a")} — пояснение`;
    assert.ok("text" in screenPayload(md)); // no settings.json → classic
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ menuStyle: "rich" }),
    );
    const rich = screenPayload(md);
    assert.ok("rich_message" in rich);
    assert.equal(rich.rich_message.markdown, blockButtons(md));
  } finally {
    if (saved === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = saved;
  }
});

// Парсер classic-экрана: roundtrip кнопки и «не падает на мусоре». Seed печатает fast-check.
void test("property: button(text, data) survives the classic parse; any markdown parses without throwing", () => {
  const label = fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((s) => !/[<>]/.test(s) && s.trim() !== "");
  const data = fc
    .string({ minLength: 1, maxLength: 40 })
    .filter((s) => !/["<>&]/.test(s));
  fc.assert(
    fc.property(label, data, (text, callback) => {
      const screen = classicScreen(`${button(text, callback)} — пояснение`);
      const rows = screen.reply_markup?.inline_keyboard ?? [];
      assert.equal(rows.length, 1);
      assert.equal(rows[0][0].callback_data, callback);
      assert.equal(rows[0][0].text, text.trim());
    }),
    { numRuns: 200 },
  );
  fc.assert(
    fc.property(fc.string({ maxLength: 300 }), (md) => {
      const screen = classicScreen(md);
      assert.equal(typeof screen.text, "string");
      assert.equal(typeof blockButtons(md), "string");
      assert.equal(typeof escapeRichText(md), "string");
    }),
    { numRuns: 300 },
  );
});

// ── markTappedButton: нажатая кнопка в полученном сообщении (spec-w2 §3.1.4) ──

// Форма, которую Telegram принял на шаге 0 (06.10.2026): подпись, success и тот же
// callback_data. Поле disabled живьём не проверялось, повторный тап держит память Bridge.
const tapped = { text: "✅ Да", style: "success", callback_data: "yes" };

void test("mark: a button in a buttons block is marked, the rest of the blocks stay byte for byte", () => {
  const blocks = [
    { type: "paragraph", text: "Поставить?" },
    {
      type: "buttons",
      buttons: [
        { text: "Да", callback_data: "yes" },
        { text: "Нет", callback_data: "no", style: "danger" },
      ],
    },
  ];
  assert.deepEqual(markTappedButton(blocks, "yes"), {
    tree: [
      { type: "paragraph", text: "Поставить?" },
      {
        type: "buttons",
        buttons: [
          tapped,
          { text: "Нет", callback_data: "no", style: "danger" },
        ],
      },
    ],
    label: "Да",
  });
});

void test("mark: a button inside a paragraph (RichTextButton) and a RichText label array", () => {
  const blocks = [
    {
      type: "paragraph",
      text: [
        "Выбор: ",
        { type: "button", button: { text: "Да", callback_data: "yes" } },
        {
          type: "button",
          button: {
            text: ["Не ", { type: "bold", text: "надо" }],
            callback_data: "no",
          },
        },
      ],
    },
  ];
  assert.deepEqual(markTappedButton(blocks, "yes")?.tree, [
    {
      type: "paragraph",
      text: [
        "Выбор: ",
        { type: "button", button: tapped },
        {
          type: "button",
          button: {
            text: ["Не ", { type: "bold", text: "надо" }],
            callback_data: "no",
          },
        },
      ],
    },
  ]);
  const array = markTappedButton(blocks, "no");
  assert.equal(array?.label, "Не надо");
  assert.deepEqual(
    (array?.tree[0] as { text: Array<{ button?: unknown }> }).text[2].button,
    {
      text: ["✅ ", ["Не ", { type: "bold", text: "надо" }]],
      style: "success",
      callback_data: "no",
    },
  );
});

void test("mark: every button with the data is marked and the label is the first one's", () => {
  const blocks = [
    { type: "buttons", buttons: [{ text: "Первая", callback_data: "x" }] },
    { type: "buttons", buttons: [{ text: "Вторая", callback_data: "x" }] },
  ];
  const marked = markTappedButton(blocks, "x");
  assert.equal(marked?.label, "Первая");
  assert.deepEqual(marked?.tree, [
    {
      type: "buttons",
      buttons: [{ text: "✅ Первая", style: "success", callback_data: "x" }],
    },
    {
      type: "buttons",
      buttons: [{ text: "✅ Вторая", style: "success", callback_data: "x" }],
    },
  ]);
});

void test("mark: no match, a media block, a non-array or a tree deeper than 32 gives null", () => {
  const buttons = {
    type: "buttons",
    buttons: [{ text: "Да", callback_data: "yes" }],
  };
  assert.equal(markTappedButton([buttons], "no"), null);
  assert.equal(
    markTappedButton([{ type: "photo", photo: [] }, buttons], "yes"),
    null,
  );
  assert.equal(markTappedButton({ blocks: [buttons] }, "yes"), null);
  assert.equal(markTappedButton(undefined, "yes"), null);
  // Глубина — число вложенных массивов и объектов, считая саму кнопку.
  const nest = (levels: number): unknown => {
    let node: unknown = { text: "Да", callback_data: "yes" };
    for (let i = 1; i < levels; i += 1) node = [node];
    return node;
  };
  assert.notEqual(
    markTappedButton(nest(32), "yes"),
    null,
    "32 levels are fine",
  );
  assert.equal(markTappedButton(nest(33), "yes"), null, "33 levels are not");
});

void test("mark: a classic inline_keyboard of two rows", () => {
  const keyboard = [
    [{ text: "Установить", callback_data: "iva_plugin:ok:0123456789ab" }],
    [{ text: "Сайт", url: "https://example.com" }],
  ];
  assert.deepEqual(markTappedButton(keyboard, "iva_plugin:ok:0123456789ab"), {
    tree: [
      [
        {
          text: "✅ Установить",
          style: "success",
          callback_data: "iva_plugin:ok:0123456789ab",
        },
      ],
      [{ text: "Сайт", url: "https://example.com" }],
    ],
    label: "Установить",
  });
});

// Генератор деревьев блоков: текстовые блоки, RichText с сущностями, ряды кнопок и кнопки в
// тексте со случайными data. Seed провала печатает fast-check.
const tapData = fc.constantFrom("a", "b", "c", "Да");
const richText = fc.letrec((tie) => ({
  text: fc.oneof(
    { depthSize: "small" },
    fc.string({ maxLength: 8 }),
    fc.array(tie("text"), { maxLength: 3 }),
    fc.record({ type: fc.constantFrom("bold", "italic"), text: tie("text") }),
  ),
})).text;
const richButton = fc.record(
  {
    text: richText,
    callback_data: tapData,
    style: fc.constantFrom("danger", "link", "primary"),
  },
  { requiredKeys: ["text", "callback_data"] },
);
const block = fc.oneof(
  fc.record({
    type: fc.constant("paragraph"),
    text: fc.array(
      fc.oneof(
        richText,
        fc.record({ type: fc.constant("button"), button: richButton }),
      ),
      { maxLength: 4 },
    ),
  }),
  fc.record({
    type: fc.constant("buttons"),
    buttons: fc.array(richButton, { minLength: 1, maxLength: 4 }),
  }),
  fc.record({ type: fc.constantFrom("heading", "pre"), text: richText }),
);
// Через JSON, как приходит от Telegram: у объектов обычный прототип.
const blocks = fc
  .array(block, { maxLength: 5 })
  .map((tree) => JSON.parse(JSON.stringify(tree)) as unknown[]);

// Кнопки с этим data заменены одной меткой: так вход и выход сравниваются без них.
function withoutButtons(
  node: unknown,
  isButton: (record: Record<string, unknown>) => boolean,
): unknown {
  if (Array.isArray(node))
    return node.map((item) => withoutButtons(item, isButton));
  if (typeof node !== "object" || node === null) return node;
  const record = node as Record<string, unknown>;
  if (isButton(record)) return "BUTTON";
  return Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k, withoutButtons(v, isButton)]),
  );
}

function objects(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(objects);
  if (typeof node !== "object" || node === null) return [];
  return [
    node as Record<string, unknown>,
    ...Object.values(node).flatMap(objects),
  ];
}

// Помеченная кнопка: подпись с «✅», success, тот же data и больше ничего.
const isMarked = (o: Record<string, unknown>, data: string) =>
  o.callback_data === data &&
  o.style === "success" &&
  Object.keys(o).sort().join() === "callback_data,style,text";

void test("property: the input never changes, only the tapped buttons do, and they are marked", () => {
  fc.assert(
    fc.property(blocks, tapData, (tree, data) => {
      const before = structuredClone(tree);
      const result = markTappedButton(tree, data);
      assert.deepEqual(tree, before, "the input is untouched");
      const matches = objects(tree).filter((o) => o.callback_data === data);
      if (matches.length === 0) {
        assert.equal(result, null);
        return;
      }
      assert.ok(result);
      const out = objects(result.tree).filter((o) => o.callback_data === data);
      assert.equal(out.length, matches.length);
      for (const button of out) assert.ok(isMarked(button, data));
      assert.deepEqual(
        withoutButtons(result.tree, (o) => o.callback_data === data),
        withoutButtons(tree, (o) => o.callback_data === data),
      );
    }),
    { numRuns: 300 },
  );
});

void test("property: marking a marked tree again changes nothing and the label has no mark", () => {
  fc.assert(
    fc.property(blocks, tapData, (tree, data) => {
      const once = markTappedButton(tree, data);
      if (once === null) return;
      const twice = markTappedButton(once.tree, data);
      assert.deepEqual(twice?.tree, once.tree);
      assert.equal(twice?.label, once.label);
      assert.ok(!once.label.startsWith("✅"), once.label);
    }),
    { numRuns: 300 },
  );
});

void test("property: a media block anywhere means no edit", () => {
  const media = fc.constantFrom(
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
  );
  fc.assert(
    fc.property(
      blocks,
      tapData,
      media,
      fc.nat(),
      fc.boolean(),
      (tree, data, type, at, nested) => {
        const item = nested
          ? { type: "blockquote", blocks: [{ type, caption: "x" }] }
          : { type, caption: "x" };
        const index = tree.length === 0 ? 0 : at % (tree.length + 1);
        const withMedia = [
          ...tree.slice(0, index),
          item,
          ...tree.slice(index),
          { type: "buttons", buttons: [{ text: "Да", callback_data: data }] },
        ];
        assert.equal(markTappedButton(withMedia, data), null);
      },
    ),
    { numRuns: 200 },
  );
});
