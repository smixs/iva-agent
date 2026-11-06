/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Снапшот индексируемого вида карточки — на ОБЕ половины поиска: колонки FTS
// (title/meta/tags/body) с отбраковкой по status/confidence и текст dense-эмбеддинга
// сайдкар-индекса (scripts/memory/embed-index.ts). В режиме hybrid половины обязаны
// видеть один текст: разъехавшись, они ранжируют разные карточки. Фиксирует контракт
// разбора frontmatter для поиска — карточки со свёрнутыми скалярами, блочными и
// flow-списками, CRLF, ключами в верхнем регистре, неизвестными полями, без
// frontmatter и с незакрытым frontmatter.
import "./lib/ts-esm-hooks.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { embedText } from "../agent/lib/card-index.ts";

const VAULT = mkdtempSync(join(tmpdir(), "iva-memsearch-fm-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
mkdirSync(join(VAULT, "cards"), { recursive: true });
process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

const CARDS: Record<string, string> = {
  // Обычная карточка: скаляры и flow-список тегов.
  "plain.md": `---
type: contact
name: Иван Петров
company: Кинолаб
tags: [contact, video]
status: active
confidence: verified
source: telegram
---

# Иван Петров

Подрядчик по монтажу.
`,
  // Свёрнутый скаляр: смысл карточки живёт в description, в теле его нет.
  "folded.md": `---
name: Rushana
description: >-
  Продюсер студии,
  ведёт монтаж
status: Active
---
Тело.
`,
  // Литеральный блок плюс собственный title карточки.
  "literal.md": `---
title: План запуска
description: |-
  строка один
  строка два
---
Тело.
`,
  // Блочные списки: алиасы и теги.
  "block-list.md": `---
name: Проект Альфа
aliases:
  - alpha
  - альфа
tags:
  - project
  - archive
status: superseded
---
Тело.
`,
  // CRLF: карточка, приехавшая из Windows-редактора.
  "crlf.md": [
    "---",
    "name: CRLF Карточка",
    "status: active",
    "---",
    "Тело.",
    "",
  ].join("\r\n"),
  // Ключи в верхнем регистре: поиск не зависит от регистра ключа.
  "upper-keys.md": `---
Name: Верхний Регистр
Status: Superseded
Confidence: inferred
---
Тело.
`,
  // Неизвестные поля не протекают в индекс и не ломают известные.
  "unknown-fields.md": `---
tier: 1
last_accessed: 2026-01-01
last-accessed: 2026-01-02
name: Икс
---
Тело.
`,
  // Пустое значение известного поля.
  "empty-value.md": `---
name:
status: active
---
Тело.
`,
  // Кавычки: двоеточие внутри значения, одинарные кавычки, собака в хендле.
  "quoted.md": `---
name: "Пётр: главный"
role: 'CTO'
handle: "@petr"
---
Тело.
`,
  // Без frontmatter — весь файл идёт в тело.
  "no-frontmatter.md": `# Заметка

Без frontmatter.
`,
  // Незакрытый frontmatter — тоже целиком тело, полей нет.
  "unclosed.md": `---
name: Обрыв
status: active

Тело без закрытия.
`,
};

for (const [name, text] of Object.entries(CARDS))
  writeFileSync(join(VAULT, "cards", name), text, "utf8");

const EXPECTED = [
  {
    path: "cards/block-list.md",
    title: "block-list",
    meta: "Проект Альфа alpha альфа",
    body: "Тело.\n",
    history: "",
    tags: "project archive",
    status: "superseded",
    confidence: "",
    source: "",
  },
  {
    path: "cards/crlf.md",
    title: "crlf",
    meta: "CRLF Карточка",
    body: "Тело.\n",
    history: "",
    tags: "",
    status: "active",
    confidence: "",
    source: "",
  },
  {
    path: "cards/empty-value.md",
    title: "empty-value",
    meta: "",
    body: "Тело.\n",
    history: "",
    tags: "",
    status: "active",
    confidence: "",
    source: "",
  },
  {
    path: "cards/folded.md",
    title: "folded",
    meta: "Rushana Продюсер студии, ведёт монтаж",
    body: "Тело.\n",
    history: "",
    tags: "",
    status: "active",
    confidence: "",
    source: "",
  },
  {
    path: "cards/literal.md",
    title: "literal",
    meta: "строка один\nстрока два План запуска",
    body: "Тело.\n",
    history: "",
    tags: "",
    status: "",
    confidence: "",
    source: "",
  },
  {
    path: "cards/no-frontmatter.md",
    title: "no-frontmatter",
    meta: "",
    body: "# Заметка\n\nБез frontmatter.\n",
    history: "",
    tags: "",
    status: "",
    confidence: "",
    source: "",
  },
  {
    path: "cards/plain.md",
    title: "plain",
    meta: "Иван Петров Кинолаб",
    body: "\n# Иван Петров\n\nПодрядчик по монтажу.\n",
    history: "",
    tags: "contact video",
    status: "active",
    confidence: "VERIFIED",
    source: "telegram",
  },
  {
    path: "cards/quoted.md",
    title: "quoted",
    meta: "Пётр: главный CTO @petr",
    body: "Тело.\n",
    history: "",
    tags: "",
    status: "",
    confidence: "",
    source: "",
  },
  {
    path: "cards/unclosed.md",
    title: "unclosed",
    meta: "",
    body: "---\nname: Обрыв\nstatus: active\n\nТело без закрытия.\n",
    history: "",
    tags: "",
    status: "",
    confidence: "",
    source: "",
  },
  {
    path: "cards/unknown-fields.md",
    title: "unknown-fields",
    meta: "Икс",
    body: "Тело.\n",
    history: "",
    tags: "",
    status: "",
    confidence: "",
    source: "",
  },
  {
    path: "cards/upper-keys.md",
    title: "upper-keys",
    meta: "Верхний Регистр",
    body: "Тело.\n",
    history: "",
    tags: "",
    status: "superseded",
    confidence: "INFERRED",
    source: "",
  },
];

const { loadDocs, searchMemory } =
  await import("../agent/tools/memory_search.ts");

test("индексируемые поля карточек совпадают со снапшотом", async () => {
  const docs = (await loadDocs(["cards"])).docs.sort((a, b) =>
    a.path < b.path ? -1 : 1,
  );
  assert.deepEqual(docs, EXPECTED);
});

test("слово из свёрнутого description находится поиском", async () => {
  const { hits } = await searchMemory({ query: "продюсер", limit: 5 });
  assert.ok(
    hits.some((hit) => hit.file === "cards/folded.md"),
    `свёрнутый description обязан попадать в индекс: ${JSON.stringify(hits)}`,
  );
});

// Текст, уезжающий в dense-эмбеддинг: непустые колонки BM25 через пробел —
// `<title> <meta> <tags> <body>`.
const EXPECTED_EMBED: Record<string, string> = {
  "plain.md":
    "plain Иван Петров Кинолаб contact video \n# Иван Петров\n\nПодрядчик по монтажу.\n",
  "folded.md": "folded Rushana Продюсер студии, ведёт монтаж Тело.\n",
  "literal.md": "literal строка один\nстрока два План запуска Тело.\n",
  "block-list.md":
    "block-list Проект Альфа alpha альфа project archive Тело.\n",
  "crlf.md": "crlf CRLF Карточка Тело.\n",
  "upper-keys.md": "upper-keys Верхний Регистр Тело.\n",
  "unknown-fields.md": "unknown-fields Икс Тело.\n",
  "empty-value.md": "empty-value Тело.\n",
  "quoted.md": "quoted Пётр: главный CTO @petr Тело.\n",
  "no-frontmatter.md": "no-frontmatter # Заметка\n\nБез frontmatter.\n",
  "unclosed.md":
    "unclosed ---\nname: Обрыв\nstatus: active\n\nТело без закрытия.\n",
};

function embedTexts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(CARDS)) {
    const file = join(VAULT, "cards", name);
    const text = embedText(file, readFileSync(file, "utf8"));
    // Ни одна карточка фикстуры не должна пропускаться: null здесь значит, что
    // снапшот ниже сравнивал бы дырку, а не текст.
    assert.ok(text !== null, `${name}: карточка фикстуры не разобралась`);
    out[name] = text;
  }
  return out;
}

test("текст dense-эмбеддинга совпадает со снапшотом", () => {
  assert.deepEqual(embedTexts(), EXPECTED_EMBED);
});

// Каждая индексируемая колонка BM25 обязана целиком лежать и в dense-тексте: иначе
// половины ранжируют разный текст одной карточки. Карточки фикстуры короче обрезки в
// 2000 символов, так что тело сравнивается целиком.
test("dense-половина индексирует те же колонки, что BM25", async () => {
  const dense = embedTexts();
  for (const doc of (await loadDocs(["cards"])).docs) {
    const name = doc.path.replace("cards/", "");
    for (const column of [doc.title, doc.meta, doc.tags, doc.body])
      if (column)
        assert.ok(
          dense[name].includes(column),
          `половины поиска разошлись на ${name}: колонки BM25 нет в dense-тексте «${dense[name]}» — «${column}»`,
        );
  }
});

// Ночной doctor запускает embed-index голым `node`, без хука, который в тестах
// переписывает "./x.js" в "./x.ts". Спавн ловит специфкатор, живущий только под хуком:
// цепочка card-index → frontmatter → card-text обязана резолвиться как есть.
test("embed-index грузится голым node", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/memory/embed-index.ts")],
    {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
      timeout: 30_000,
    },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /^embed-index: no JINA_API_KEY/u);
});
