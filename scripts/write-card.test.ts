/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Тесты write_card: слияние вместо перезаписи, идентичность по H1 (легаси-слаги),
// алиасы типов, безопасный YAML, конфликт кандидатов.
// Запуск: node --test scripts/write-card.test.ts  (TS импортируется напрямую — Node 24
// стрипает типы; отдельная сборка не нужна).

import "./lib/ts-esm-hooks.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { parseFrontmatter } from "../agent/lib/frontmatter.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const VAULT = mkdtempSync(join(tmpdir(), "iva-card-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
process.env.ASSISTANT_TIMEZONE = "UTC";
mkdirSync(join(VAULT, "cards", "contacts"), { recursive: true });
mkdirSync(join(VAULT, "cards", "notes"), { recursive: true });
cpSync(join(REPO, "vault-template", "schema.json"), join(VAULT, "schema.json"));

process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

// Модуль читает схему на импорте — env выставлен выше.
const writeCardModule = (await import(
  join(REPO, "agent", "tools", "write_card.ts")
)) as typeof import("../agent/tools/write_card.ts");
const writeCard = writeCardModule.default;
type WriteCardInput = Parameters<typeof writeCard.execute>[0];
type WriteCardResult = {
  action: string;
  candidates: unknown[];
  error: string;
  file: string;
  matchedBy: string;
  ok: boolean;
  status: string;
  type: string;
};
type ParseSchema<T> = { parse: (value: unknown) => T };
const inputSchema =
  writeCard.inputSchema as unknown as ParseSchema<WriteCardInput>;
const testTool = writeCard as unknown as {
  execute: (input: WriteCardInput) => Promise<WriteCardResult>;
};
const call = (args: unknown) => testTool.execute(inputSchema.parse(args));

const waitForExit = (child: ReturnType<typeof spawn>) =>
  new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

const read = (rel: string) => readFileSync(join(VAULT, rel), "utf8");

test("invalid timezone falls back without losing a new Card", async (t) => {
  const previous = process.env.ASSISTANT_TIMEZONE;
  process.env.ASSISTANT_TIMEZONE = "Mars/Olympus";
  t.after(() => {
    if (previous === undefined) delete process.env.ASSISTANT_TIMEZONE;
    else process.env.ASSISTANT_TIMEZONE = previous;
  });

  const result = await call({
    type: "note",
    title: "Timezone fallback",
    description: "invalid timezone uses UTC",
    tags: ["timezone"],
    body: "The Card write must complete.",
  });

  assert.equal(result.ok, true);
  assert.equal(existsSync(join(VAULT, result.file)), true);
});

// Реальная карточка: без title во frontmatter, свёрнутый скаляр description, латинский
// легаси-слаг при кириллическом H1, поля вне схемы тула (tier/relevance/phone/…).
const LEGACY = `---
type: contact
description: >-
  Ясмин — AI-контент криейтор, фрилансер. Связалась через Telegram с предложением услуг.
tags: [contact, freelancer]
status: active
created: 2026-06-29
source: daily/2026-06-29.md
relevance: 0.55
tier: cold
domain: work
last_accessed: 2026-06-27
access_count: 1
phone: "+998 90 000 00 00"
---

# Ясмин (AI Content Creator)

Связалась через личный Telegram Шимы 29.06.2026 с холодным предложением услуг.

## Портфолио
https://drive.google.com/drive/folders/abc
`;

test("повторный write_card сливает карточку: поля вне схемы, created и старый body живы", async () => {
  writeFileSync(join(VAULT, "cards/contacts/yasmin.md"), LEGACY, "utf8");

  const res = await call({
    type: "contact",
    title: "Ясмин",
    description: "AI-контент криейтор, прислала новую смету",
    tags: ["contact", "ai-content"],
    body: "Прислала смету на видеоролик: 400 USD за 30 секунд.",
  });

  assert.equal(res.ok, true);
  // Найден легаси-файл, а не создан дубль «ясмин.md».
  assert.equal(res.file, "cards/contacts/yasmin.md");
  assert.equal(res.matchedBy, "title");
  assert.equal(res.action, "merged");

  const out = read("cards/contacts/yasmin.md");
  for (const kept of [
    "relevance: 0.55",
    "tier: cold",
    "last_accessed: 2026-06-27",
    "access_count: 1",
    "created: 2026-06-29",
    "source: daily/2026-06-29.md",
  ]) {
    assert.ok(out.includes(kept), `потеряно поле: ${kept}`);
  }
  assert.ok(out.includes('phone: "+998 90 000 00 00"'), "потерян phone");
  assert.ok(out.includes("Портфолио"), "потерян старый body");
  assert.ok(
    out.includes("холодным предложением услуг"),
    "потерян старый текст",
  );
  assert.ok(out.includes("400 USD"), "новый текст не дописан");
  // description обновлён и не задвоен (исторический баг свёрнутых скаляров).
  assert.equal(out.match(/^description:/gm)!.length, 1);
  assert.ok(
    !out.includes("Связалась через Telegram с предложением услуг."),
    "старый description остался",
  );
  // Теги слиты, а не заменены.
  const tags = /^tags: \[(.*)\]$/m.exec(out)![1];
  assert.ok(tags.includes("freelancer") && tags.includes("ai-content"));
  // Один frontmatter, один H1.
  assert.equal(out.match(/^---$/gm)!.length, 2);
  assert.equal(out.match(/^# /gm)!.length, 1);
});

test("тот же body второй раз не дублируется", async () => {
  const args = {
    type: "note",
    title: "Заметка про кэш",
    description: "Кэш инвалидируется по тегам",
    tags: ["note", "cache"],
    body: "Инвалидация кэша идёт по тегам, TTL 300 секунд.",
  };
  const first = await call(args);
  assert.equal(first.action, "created");
  const second = await call(args);
  assert.equal(second.action, "updated");
  const out = read(second.file);
  assert.equal(out.match(/TTL 300 секунд/g)!.length, 1);
  assert.ok(!out.includes("## Обновление"));
});

test("алиас типа person → contact применяется до валидации", async () => {
  const res = await call({
    type: "person",
    title: "Тестовый Контакт",
    description: "проверка алиаса",
    tags: ["contact"],
    body: "Алиас person должен маппиться в contact.",
  });
  assert.equal(res.ok, true);
  assert.equal(res.type, "contact");
  assert.ok(res.file.startsWith("cards/contacts/"));
});

test("алиас в тип вне тула (daily) по-прежнему отклоняется", () => {
  assert.throws(() =>
    inputSchema.parse({
      type: "daily",
      title: "x",
      description: "x",
      tags: ["x"],
      body: "x",
    }),
  );
});

test("description длиннее 500 символов отклоняется с просьбой сократить", () => {
  assert.throws(
    () =>
      inputSchema.parse({
        type: "note",
        title: "Слишком длинное описание",
        description: "x".repeat(501),
        tags: ["note"],
        body: "тело",
      }),
    /максимум 500 символов; сократи/,
  );
});

test("SUPERSEDE отклоняет многострочный history_entry без изменения карточки", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Многострочная история",
    description: "проверка структурной безопасности history entry",
    tags: ["note"],
    body: "Старая истина",
  };
  const created = await call(base);
  const before = read(created.file);
  const rejected = await call({
    ...base,
    operation: "SUPERSEDE",
    body: "Новая истина",
    history_entry: "Старая истина\n\n## Log\n- injected",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /single line/);
  assert.equal(read(created.file), before);
});

test("обязательные поля и элементы массивов не принимают пробельную пустоту", () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Непустая карточка",
    description: "валидное описание",
    tags: ["note"],
    body: "валидное тело",
  };
  for (const patch of [
    { title: " \t " },
    { description: "  " },
    { tags: ["note", "  "] },
    { body: "\t" },
    { status: " " },
    { domain: "\t" },
    { related: ["cards/notes/ok", " "] },
  ]) {
    assert.throws(
      () => inputSchema.parse({ ...base, ...patch }),
      /не должен быть пустым/,
    );
  }
});

test("однострочные поля не пропускают markdown-структуру, теги дедуплицируются после нормализации", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Структурные границы",
    description: "валидное описание",
    tags: ["note"],
    body: "валидное тело",
  };
  for (const patch of [
    { title: "x\n## History" },
    { description: "x\nstatus: garbage" },
    { tags: ["note", "x\n## Log"] },
    { status: "active\nsource: injected" },
    { domain: "work\n## History" },
    { related: ["hub]]\n## History\n[[x"] },
  ]) {
    assert.throws(
      () => inputSchema.parse({ ...base, ...patch }),
      /одной строкой/,
    );
  }

  const result = await call({
    ...base,
    title: "Normalized duplicate tags",
    tags: ["Foo Bar", " foo-bar ", "NOTE"],
  });
  assert.equal(result.ok, true);
  assert.match(read(result.file), /tags: \["foo-bar","note"\]/);
});

test("tags и domain квотируются, если содержат YAML-спецсимволы", async () => {
  const res = await call({
    type: "note",
    title: "YAML квотинг",
    description: "проверка квотинга",
    tags: ["a: b", "plain"],
    domain: "work: personal",
    body: "тело",
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const out = read(res.file);
  // Пробелы в теге схлопываются в дефис, но двоеточие остаётся — элемент обязан быть в кавычках.
  assert.ok(out.includes('tags: ["a:-b","plain"]'), out);
  assert.ok(out.includes('domain: "work: personal"'), out);
});

test("несколько кандидатов по заголовку → отказ без записи", async () => {
  const dir = join(VAULT, "cards", "notes");
  const card = (h1: string) =>
    `---\ntype: note\nstatus: active\n---\n\n# ${h1}\n\nтекст\n`;
  writeFileSync(join(dir, "dup-a.md"), card("Дубль Тема"), "utf8");
  writeFileSync(join(dir, "dup-b.md"), card("Дубль Тема (второй)"), "utf8");

  const res = await call({
    type: "note",
    title: "Дубль Тема",
    description: "конфликт",
    tags: ["note"],
    body: "новый текст",
  });
  assert.equal(res.ok, false);
  assert.equal(res.candidates.length, 2);
  assert.ok(
    !readFileSync(join(dir, "dup-a.md"), "utf8").includes("новый текст"),
  );
  assert.ok(
    !readFileSync(join(dir, "dup-b.md"), "utf8").includes("новый текст"),
  );
});

test("related дописываются в существующую секцию без дублей", async () => {
  const base = {
    type: "note",
    title: "Связи",
    description: "проверка related",
    tags: ["note"],
    body: "первичный текст",
    related: ["majento"],
  };
  const first = await call(base);
  await call({
    ...base,
    body: "второй текст",
    related: ["majento", "aimasters"],
  });
  const out = read(first.file);
  assert.equal(out.match(/^## Related$/gm)!.length, 1);
  assert.equal(out.match(/\[\[majento\]\]/g)!.length, 1);
  assert.ok(out.includes("[[aimasters]]"));
});

test("явные UPDATE складываются в единственный Log без датированных H2", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Единый журнал",
    description: "проверка единственного журнала",
    tags: ["note", "log"],
    body: "Текущая выжимка.",
    related: ["cards/notes/hub"],
  };
  const created = await call(base);
  assert.equal(created.ok, true);
  await call({
    ...base,
    operation: "UPDATE",
    body: "Добавлен первый непротиворечивый факт.",
  });
  await call({
    ...base,
    operation: "UPDATE",
    body: "Добавлен второй непротиворечивый факт.",
  });
  const out = read(created.file);
  assert.equal(out.match(/^## Log$/gm)!.length, 1);
  assert.equal(out.match(/^## (?:Обновление|Update) /gm), null);
  assert.match(out, /^- \d{4}-\d{2}-\d{2}: Добавлен первый/m);
  assert.match(out, /^- \d{4}-\d{2}-\d{2}: Добавлен второй/m);

  const before = out;
  for (let replay = 0; replay < 100; replay++) {
    const repeated = await call({
      ...base,
      operation: "UPDATE",
      body: "Добавлен второй непротиворечивый факт.",
    });
    assert.equal(repeated.action, "updated");
  }
  assert.equal(
    read(created.file),
    before,
    "повтор факта должен быть byte-stable",
  );
});

test("rejected ADD с history noise не переписывает legacy folded frontmatter", async () => {
  const title = "Legacy folded ADD guard";
  const file = join(VAULT, "cards", "notes", `${slugify(title)}.md`);
  const legacy = [
    "---",
    "type: note",
    "description: >-",
    " one paragraph: with colon",
    "",
    " # comment inside folded value",
    " second paragraph must never resurrect",
    "status: active",
    "custom_empty:",
    "custom_unknown: keep-me",
    "---",
    `# ${title}`,
    "",
    "Original body stays byte-identical.",
    "",
  ].join("\n");
  writeFileSync(file, legacy);
  const warnings: string[] = [];
  const previousWarn = console.warn;
  console.warn = (...parts: unknown[]) => warnings.push(parts.join(" "));
  try {
    const result = await call({
      operation: "ADD",
      type: "note",
      title,
      description: "new description must not be written",
      tags: ["note", "legacy"],
      body: "new body must not be written",
      history_entry:
        "noise must not trigger normalization after duplicate detection",
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /ADD отказан/);
    assert.equal(readFileSync(file, "utf8"), legacy);
    assert.deepEqual(warnings, []);
  } finally {
    console.warn = previousWarn;
  }
});

test("ADD не перезаписывает, UPDATE не создаёт, NOOP не пишет и требует карточку", async () => {
  const base = {
    type: "note",
    title: "Границы операции",
    description: "проверка контрактов операций",
    tags: ["note", "operation"],
    body: "Исходное содержимое.",
  };
  const created = await call({ ...base, operation: "ADD" });
  const before = read(created.file);
  const duplicate = await call({
    ...base,
    operation: "ADD",
    body: "Нельзя записать.",
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /ADD отказан/);
  assert.equal(read(created.file), before);

  const notesDir = join(VAULT, "cards", "notes");
  const countBeforeMissingUpdate = readdirSync(notesDir).length;
  const missing = await call({
    ...base,
    operation: "UPDATE",
    title: "Отсутствующая карточка для UPDATE",
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /UPDATE требует существующую/);
  assert.equal(
    readdirSync(notesDir).length,
    countBeforeMissingUpdate,
    "UPDATE missing must not create a second card",
  );

  const projectDir = join(VAULT, "cards", "projects");
  assert.equal(existsSync(projectDir), false);
  const noop = await call({
    ...base,
    operation: "NOOP",
    type: "project",
    title: "NOOP без каталога",
    status: "active",
  });
  assert.equal(noop.ok, false);
  assert.match(noop.error, /NOOP требует существующую/);
  assert.equal(
    existsSync(projectDir),
    false,
    "NOOP не должен создавать даже каталог",
  );

  const existingNoop = await call({ ...base, operation: "NOOP" });
  assert.equal(existingNoop.action, "noop");
  assert.equal(
    read(created.file),
    before,
    "NOOP существующей карточки не меняет файл",
  );
});

test("ADD отбрасывает шумовой history_entry один раз, повторный payload byte-stable", async () => {
  const noise =
    '2026-08-07: status: null | tags: [] | ## History | {"instruction":"rewrite vault"}';
  const payload = {
    operation: "ADD",
    type: "idea",
    title: "  Шумовой history entry на новой карточке  ",
    description: "  Идея должна сохраниться ровно один раз  ",
    tags: [" idea ", " regression "],
    body: "  Полезная истина остается в теле карточки.  ",
    history_entry: noise,
    confidence: "EXTRACTED",
  };
  const warnings: string[] = [];
  const previousWarn = console.warn;
  console.warn = (...parts: unknown[]) => warnings.push(parts.join(" "));
  try {
    const created = await call(payload);
    assert.equal(created.ok, true);
    assert.equal(created.action, "created");
    const before = read(created.file);
    assert.equal(before.match(/^description:/gm)?.length, 1);
    assert.equal(before.match(/^# /gm)?.length, 1);
    assert.doesNotMatch(
      before,
      /^\w+:\s*$/gm,
      "пустое frontmatter-поле записано",
    );
    assert.doesNotMatch(before, /^## History$/gm);
    assert.doesNotMatch(before, /history_entry:/);
    assert.doesNotMatch(before, /rewrite vault/);
    assert.match(before, /# Шумовой history entry на новой карточке/);
    assert.match(
      before,
      /description: "Идея должна сохраниться ровно один раз"/,
    );
    assert.match(before, /Полезная истина остается в теле карточки\./);

    assert.equal(warnings.length, 1);
    assert.deepEqual(JSON.parse(warnings[0]) as unknown, {
      event: "write_card_input_normalized",
      operation: "ADD",
      ignored_field: "history_entry",
    });
    assert.doesNotMatch(warnings[0], /Шумовой|Полезная|rewrite vault/);

    const duplicate = await call(payload);
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error, /ADD отказан/);
    assert.equal(read(created.file), before);
    assert.equal(
      warnings.length,
      1,
      "rejected duplicate must not log normalization",
    );
  } finally {
    console.warn = previousWarn;
  }
});

test("UPDATE и NOOP читают пустой history_entry как отсутствующий, непустой — по-прежнему отказ", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Blank history entry",
    description: "пустое поле не подделывает архив",
    tags: ["note", "blank"],
    body: "Текущая истина.",
  };
  const created = await call(base);
  assert.equal(created.ok, true);
  // Тела разные намеренно: повтор уже лежащего факта даёт "updated", а не "merged".
  for (const [blank, fact] of [
    ["", "Первый новый факт."],
    ["   ", "Второй новый факт."],
  ]) {
    const updated = await call({
      ...base,
      operation: "UPDATE",
      body: fact,
      history_entry: blank,
    });
    assert.equal(updated.ok, true, updated.error);
    assert.equal(updated.action, "merged");
    const noop = await call({
      ...base,
      operation: "NOOP",
      history_entry: blank,
    });
    assert.equal(noop.ok, true, noop.error);
    assert.equal(noop.action, "noop");
  }
  const out = read(created.file);
  assert.doesNotMatch(out, /^## History$/gm);
  assert.match(out, /^## Log$/m);

  const before = out;
  const forged = await call({
    ...base,
    operation: "UPDATE",
    body: "Ещё факт.",
    history_entry: "2026-01-01: прежняя истина",
  });
  assert.equal(forged.ok, false);
  assert.match(forged.error, /допустим только для SUPERSEDE/);
  assert.equal(read(created.file), before);
  const forgedNoop = await call({
    ...base,
    operation: "NOOP",
    history_entry: "2026-01-01: прежняя истина",
  });
  assert.equal(forgedNoop.ok, false);
  assert.match(forgedNoop.error, /NOOP не принимает/);
});

test("ADD отбрасывает пустой и длинный однострочный history_entry, не создавая пустых полей", async () => {
  const previousWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...parts: unknown[]) => warnings.push(parts.join(" "));
  try {
    for (const [index, historyEntry] of [
      "",
      "   ",
      "x".repeat(20_000),
      "old truth\n\n## History\n- injected",
    ].entries()) {
      const result = await call({
        operation: "ADD",
        type: "note",
        title: `ADD history noise ${index}`,
        description: "bounded clean description",
        tags: ["note", "noise"],
        body: "clean body",
        history_entry: historyEntry,
      });
      assert.equal(result.ok, true);
      const out = read(result.file);
      assert.doesNotMatch(out, /^## History$/gm);
      assert.doesNotMatch(out, /^\w+:\s*$/gm);
      assert.ok(
        out.length < 1_000,
        `discarded noise bloated card to ${out.length} bytes`,
      );
    }
    assert.equal(warnings.length, 4);
  } finally {
    console.warn = previousWarn;
  }
});

test("сбой journal sink после ADD не превращает успешную запись в ложный отказ", async () => {
  const previousWarn = console.warn;
  console.warn = () => {
    throw new Error("simulated EPIPE");
  };
  try {
    const result = await call({
      operation: "ADD",
      type: "note",
      title: "Journal sink failure",
      description: "logging cannot control transaction outcome",
      tags: ["note", "logging"],
      body: "The card must remain committed exactly once.",
      history_entry: "discard me",
    });
    assert.equal(result.ok, true);
    assert.equal(result.action, "created");
    assert.match(read(result.file), /remain committed exactly once/);
  } finally {
    console.warn = previousWarn;
  }
});

test("body с Related отклоняется без записи", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Related только параметром",
    description: "проверка запрета Related в body",
    tags: ["note", "related"],
    body: "Исходная истина.",
  };
  const created = await call(base);
  const before = read(created.file);
  const rejected = await call({
    ...base,
    operation: "UPDATE",
    body: "Новый факт.\n\n## Related\n- [[wrong-place]]",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /pass links through related/);
  assert.equal(read(created.file), before);
});

test("UPDATE отклоняет H1/H2 и существующие legacy dated-секции без записи", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Fail closed update",
    description: "проверка структурных границ update",
    tags: ["note", "update"],
    body: "Текущая истина.",
  };
  const created = await call(base);
  const before = read(created.file);
  const heading = await call({
    ...base,
    operation: "UPDATE",
    body: "Новый факт.\n\n## Next steps\nнеструктурированный хвост",
  });
  assert.equal(heading.ok, false);
  assert.match(heading.error, /without H1\/H2 headings/);
  assert.equal(read(created.file), before);

  const legacy = `${before.trimEnd()}\n\n## Обновление 2026-08-01\nСтарый факт.\n`;
  writeFileSync(join(VAULT, created.file), legacy);
  const dated = await call({
    ...base,
    operation: "UPDATE",
    body: "Ещё один факт.",
  });
  assert.equal(dated.ok, false);
  assert.match(dated.error, /run semantic cleanup before UPDATE/);
  assert.equal(read(created.file), legacy);
});

test("fenced структурные заголовки остаются кодом", async () => {
  const fenced = [
    "Пример формата:",
    "```markdown",
    "## Related",
    "## Log",
    "## Update 2026-08-05",
    "```",
  ].join("\n");
  const created = await call({
    operation: "ADD",
    type: "note",
    title: "Пример fenced headings",
    description: "структурные заголовки внутри code fence",
    tags: ["note", "fence"],
    body: fenced,
    related: ["cards/notes/hub"],
  });
  assert.equal(created.ok, true);
  const out = read(created.file);
  assert.ok(out.includes(fenced), "code example must remain byte-identical");
  assert.equal(
    out.match(/^## Related$/gm)!.length,
    2,
    "one fenced example plus one real section",
  );

  await call({
    operation: "UPDATE",
    type: "note",
    title: "Пример fenced headings",
    description: "структурные заголовки внутри code fence",
    tags: ["note", "fence"],
    body: "Совместимый новый факт.",
    related: ["cards/notes/hub#part|Hub"],
  });
  const updated = read(created.file);
  assert.ok(updated.includes(fenced));
  assert.equal(
    updated.match(/^## Log$/gm)!.length,
    2,
    "one fenced example plus one real section",
  );
  assert.match(updated, /^- \d{4}-\d{2}-\d{2}: Совместимый новый факт\.$/m);
});

test("незакрытый фенс отклоняется на ADD, UPDATE и SUPERSEDE", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Незакрытый фенс",
    description: "фенс без закрытия прячет структурные заголовки",
    tags: ["note", "fence"],
    body: "Текущая истина.",
  };
  const smuggled = "Новый факт.\n\n```text\n## History\n- 2020: подделка";

  const rejectedAdd = await call({ ...base, body: smuggled });
  assert.equal(rejectedAdd.ok, false);
  assert.match(rejectedAdd.error, /must close every code fence/);
  assert.equal(
    existsSync(join(VAULT, "cards", "notes", "незакрытый-фенс.md")),
    false,
    "отклонённый ADD не создаёт карточку",
  );

  const created = await call(base);
  assert.equal(created.ok, true);
  assert.equal(
    created.file,
    "cards/notes/незакрытый-фенс.md",
    "проверка отсутствия смотрела на тот же путь",
  );
  const before = read(created.file);

  const rejectedUpdate = await call({
    ...base,
    operation: "UPDATE",
    body: smuggled,
  });
  assert.equal(rejectedUpdate.ok, false);
  assert.match(rejectedUpdate.error, /must close every code fence/);
  assert.equal(read(created.file), before);

  const rejectedTilde = await call({
    ...base,
    operation: "UPDATE",
    body: "Новый факт.\n\n~~~\n## Log\n- 2020: подделка",
  });
  assert.equal(rejectedTilde.ok, false);
  assert.match(rejectedTilde.error, /must close every code fence/);
  assert.equal(read(created.file), before);

  const rejectedSupersede = await call({
    ...base,
    operation: "SUPERSEDE",
    body: smuggled,
    history_entry: "2026-08: Текущая истина",
  });
  assert.equal(rejectedSupersede.ok, false);
  assert.match(rejectedSupersede.error, /must close every code fence/);
  assert.equal(read(created.file), before);

  // Тот же пример с закрытым фенсом остаётся кодом и проходит: проверка ловит именно
  // незакрытый фенс, а не заголовки внутри примера.
  const closed = await call({
    ...base,
    operation: "UPDATE",
    body: `${smuggled}\n\`\`\``,
  });
  assert.equal(closed.ok, true);
  const out = read(created.file);
  assert.equal(out.match(/^## Log$/gm)!.length, 1, "реальная секция одна");
  assert.equal(
    out.match(/^## History$/gm),
    null,
    "пример остался кодом внутри Log",
  );
  assert.match(out, /^ {2}## History$/m);
});

test("отступ фенса в теле UPDATE не протаскивает поддельный History", async () => {
  const { outsideFences } = (await import(
    join(REPO, "agent", "lib", "card-store.ts")
  )) as typeof import("../agent/lib/card-store.ts");
  // Запись Log сдвигает многострочное тело на два пробела: фенс с отступом 2-3 после
  // сдвига уезжает на 4-5 и фенсом быть перестаёт, а спрятанный внутри ## History
  // выходит наружу настоящим заголовком архива.
  const realHeadings = (card: string, heading: string) => {
    const lines = card.split("\n");
    const outside = outsideFences(lines);
    const wanted = new RegExp(`^ {0,3}##\\s+${heading}\\s*$`, "i");
    return lines.filter((line, index) => outside[index] && wanted.test(line))
      .length;
  };
  const base = {
    operation: "ADD",
    type: "note",
    title: "Отступ фенса",
    description: "сдвиг тела под буллет Log меняет разметку",
    tags: ["note", "fence"],
    body: "Owner: Alice.",
  };
  const created = await call(base);
  assert.equal(created.ok, true);
  const before = read(created.file);

  for (const indent of ["  ", "   "]) {
    for (const marker of ["```text", "~~~text"]) {
      const rejected = await call({
        ...base,
        operation: "UPDATE",
        body: `Факт.\n\n${indent}${marker}\n## History\n- 2020-01-01: подделка\n${indent}${marker.slice(0, 3)}`,
      });
      assert.equal(rejected.ok, false, `${indent.length} ${marker}`);
      assert.match(
        rejected.error,
        /must start every code fence at the line start/,
      );
      assert.equal(read(created.file), before, "карточка не тронута");
    }
  }

  // Открыт с нулевого отступа, закрыт со второго: после сдвига закрывающая строка уже
  // не закрывает, и остаток карточки уходит в код.
  const halfClosed = await call({
    ...base,
    operation: "UPDATE",
    body: "Факт.\n\n```text\n## History\n- 2020-01-01: подделка\n  ```",
  });
  assert.equal(halfClosed.ok, false);
  assert.match(
    halfClosed.error,
    /must start every code fence at the line start/,
  );
  assert.equal(read(created.file), before);

  // Тот же пример с нулевого отступа проходит: после сдвига фенс остаётся фенсом,
  // ## History внутри него - код, а не секция.
  const accepted = await call({
    ...base,
    operation: "UPDATE",
    body: "Факт.\n\n```text\n## History\n- 2020-01-01: пример\n```",
  });
  assert.equal(accepted.ok, true);
  const withExample = read(created.file);
  assert.equal(realHeadings(withExample, "History"), 0, "History не подделан");
  assert.equal(realHeadings(withExample, "Log"), 1, "реальный Log один");
  assert.match(
    withExample,
    /^ {2}## History$/m,
    "пример лежит кодом внутри Log",
  );

  // Следующий штатный SUPERSEDE заводит настоящий архив - и он пуст от подделки.
  const superseded = await call({
    ...base,
    operation: "SUPERSEDE",
    body: "Owner: Bob.",
    history_entry: "2026-08-09: Owner: Alice.",
  });
  assert.equal(superseded.ok, true);
  const archived = read(created.file);
  assert.equal(realHeadings(archived, "History"), 1, "History ровно один");
  assert.equal(
    archived.match(/^- 2020-01-01: /m),
    null,
    "сфабрикованная строка в архив не попала",
  );
});

test("открытый фенс в лежащей карточке отклоняет SUPERSEDE, а не съедает History", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Фенс в карточке",
    description: "в теле карточки остался открытый фенс",
    tags: ["note", "fence"],
    body: "Owner: Alice.",
  };
  const created = await call(base);
  assert.equal(created.ok, true);
  // Карточка с опечаткой: фенс открыт выше ## History, поэтому весь архив читается как
  // код. Замена Compiled Truth без проверки стёрла бы обе записи молча.
  const poisoned =
    `${read(created.file).trimEnd()}\n\n` +
    "```yaml\nowner: Alice\n\n" +
    "## History\n\n- 2026-01-01: Owner Alice\n- 2026-03-01: Owner Zed\n";
  writeFileSync(join(VAULT, created.file), poisoned);

  const rejected = await call({
    ...base,
    operation: "SUPERSEDE",
    body: "Owner: Carol.",
    history_entry: "2026-08-01: Owner: Bob.",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /existing card body leaves a code fence open/);
  assert.equal(read(created.file), poisoned);

  const rejectedLegacy = await call({
    ...base,
    operation: undefined,
    replace_body: true,
    body: "Owner: Carol.",
    history_entry: "2026-08-01: Owner: Bob.",
  });
  assert.equal(rejectedLegacy.ok, false);
  assert.match(
    rejectedLegacy.error,
    /existing card body leaves a code fence open/,
  );
  assert.equal(read(created.file), poisoned);
});

test("легаси replace_body не сажает открытый фенс в карточку", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Легаси фенс",
    description: "легаси-путь с незакрытым фенсом",
    tags: ["note", "fence"],
    body: "Owner: Alice.",
  };
  const created = await call(base);
  writeFileSync(
    join(VAULT, created.file),
    `${read(created.file).trimEnd()}\n\n## History\n\n- 2026-01-01: Owner Zed\n`,
  );
  const before = read(created.file);

  const rejected = await call({
    ...base,
    operation: undefined,
    replace_body: true,
    body: "Owner: Mallory.\n\n```text\n## History\n- 1999-01-01: подделка",
    history_entry: "2026-08-01: Owner: Alice.",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /must close every code fence/);
  assert.equal(read(created.file), before);

  // Тот же легаси-вызов с закрытым фенсом и корректным History-префиксом проходит,
  // и в карточке не остаётся открытого фенса для следующего SUPERSEDE.
  const replaced = await call({
    ...base,
    operation: undefined,
    replace_body: true,
    body:
      "Owner: Mallory.\n\n```text\nпример\n```\n\n" +
      "## History\n\n- 2026-01-01: Owner Zed\n- 2026-08-01: Owner: Alice.",
  });
  assert.equal(replaced.action, "replaced");
  const out = read(created.file);
  assert.equal(out.match(/```/g)!.length, 2, "фенс в карточке закрыт");

  const next = await call({
    ...base,
    operation: "SUPERSEDE",
    body: "Owner: Bob.",
    history_entry: "2026-08-02: Owner: Mallory.",
  });
  assert.equal(next.action, "replaced");
  const after = read(created.file);
  assert.match(after, /- 2026-01-01: Owner Zed/);
  assert.match(after, /- 2026-08-01: Owner: Alice\./);
  assert.match(after, /- 2026-08-02: Owner: Mallory\./);
});

test("Related дедуплицирует target по alias/anchor и не считает ссылку в prose", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Нормализация Related",
    description: "проверка идентичности ссылок",
    tags: ["note", "related"],
    body: "В тексте уже упомянут [[cards/notes/hub]], но это не секция связей.",
    related: ["cards/notes/hub#top|Hub"],
  };
  const created = await call(base);
  await call({
    ...base,
    operation: "UPDATE",
    body: "Ещё один факт.",
    related: ["cards/notes/hub#other|Other", "cards/notes/sibling"],
  });
  const out = read(created.file);
  assert.equal(out.match(/^## Related$/gm)!.length, 1);
  assert.equal(out.match(/\[\[cards\/notes\/hub#/g)!.length, 1);
  assert.equal(
    out.match(/\[\[cards\/notes\/hub\]\]/g)!.length,
    1,
    "prose link remains separate",
  );
  assert.equal(out.match(/\[\[cards\/notes\/sibling\]\]/g)!.length, 1);
});

test("SUPERSEDE требует history_entry, заменяет truth и сохраняет History", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Смена владельца",
    description: "текущий владелец Alice",
    tags: ["note", "owner"],
    body: "Current owner: Alice",
    related: ["cards/contacts/alice"],
  };
  const created = await call(base);
  // Секции карточки принадлежат write_card, а не модели: ADD не принимает H2 в body,
  // поэтому исходное состояние с Evidence/Log/History кладём на диск напрямую.
  writeFileSync(
    join(VAULT, created.file),
    `${read(created.file).trimEnd()}\n\n` +
      "## Evidence\n\n```text\nowner: Alice\n```\n\n" +
      "## Log\n- 2026-07-01: Ownership confirmed\n\n" +
      "## History\n\n- 2025: Initial owner Carol\n  Continued detail\n",
  );
  const before = read(created.file);
  const rejected = await call({
    ...base,
    operation: "SUPERSEDE",
    description: "текущий владелец Bob",
    body: "Current owner: Bob",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /требует history_entry/);
  assert.equal(read(created.file), before);

  const fencedLegacy = await call({
    ...base,
    operation: undefined,
    replace_body: true,
    body: "Current owner: Bob\n\n```markdown\n## History\n- example only\n```",
  });
  assert.equal(fencedLegacy.ok, false);
  assert.match(
    fencedLegacy.error,
    /legacy replace_body должен содержать ## History/,
  );
  assert.equal(read(created.file), before);

  const replaced = await call({
    ...base,
    operation: "SUPERSEDE",
    description: "текущий владелец Bob",
    body: "Current owner: Bob",
    history_entry: "2026-01→08: Current owner Alice",
    related: ["cards/contacts/bob"],
  });
  assert.equal(replaced.action, "replaced");
  const out = read(created.file);
  const current = out.split("## History")[0];
  assert.match(current, /Current owner: Bob/);
  assert.doesNotMatch(current, /Current owner: Alice/);
  assert.equal(out.match(/^## History$/gm)!.length, 1);
  assert.equal(out.match(/^## Log$/gm)!.length, 1);
  assert.equal(out.match(/^## Related$/gm)!.length, 1);
  assert.match(out, /Initial owner Carol/);
  assert.ok(
    out.includes(
      "## History\n\n- 2025: Initial owner Carol\n  Continued detail\n",
    ),
    "existing History must remain byte-for-byte before the appended entry",
  );
  assert.match(out, /Current owner Alice/);
  assert.match(out, /Ownership confirmed/);
  assert.match(out, /## Evidence\n\n```text\nowner: Alice\n```/);
  assert.match(out, /\[\[cards\/contacts\/alice\]\]/);
  assert.match(out, /\[\[cards\/contacts\/bob\]\]/);

  const replayed = await call({
    ...base,
    operation: "SUPERSEDE",
    description: "текущий владелец Bob",
    body: "Current owner: Bob",
    history_entry: "2026-01→08: Current owner Alice",
    related: ["cards/contacts/bob"],
  });
  assert.equal(replayed.action, "noop");
  assert.equal(read(created.file), out);
  assert.equal(out.match(/2026-01→08: Current owner Alice/g)?.length, 1);
});

test("SUPERSEDE заменяет явно названную custom-секцию и сохраняет остальные", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Явная замена секции",
    description: "проверка preserve replace semantics",
    tags: ["note", "supersede"],
    body: "Truth v1",
  };
  const created = await call(base);
  writeFileSync(
    join(VAULT, created.file),
    `${read(created.file).trimEnd()}\n\n## Evidence\nold evidence\n\n## Notes\nkeep me\n`,
  );
  const result = await call({
    ...base,
    operation: "SUPERSEDE",
    body: "Truth v2\n\n## Evidence\nnew evidence",
    history_entry: "Truth v1",
  });
  assert.equal(result.action, "replaced");
  const out = read(created.file);
  assert.match(out, /Truth v2/);
  assert.doesNotMatch(out, /old evidence/);
  assert.match(out, /## Evidence\nnew evidence/);
  assert.match(out, /## Notes\nkeep me/);
});

test("legacy replace_body требует непустой History prefix и добавляет только suffix", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Legacy History prefix",
    description: "проверка безопасной совместимости replace body",
    tags: ["note", "legacy"],
    body: "Truth v1",
  };
  const created = await call(base);
  writeFileSync(
    join(VAULT, created.file),
    `${read(created.file).trimEnd()}\n\n## History\n\n- 2025-01-01: Truth v0\n`,
  );
  const before = read(created.file);

  for (const body of [
    "Truth v2\n\n## History\n",
    "Truth v2\n\n## History\n\n- 2025-01-01: Different history\n- 2026-08-05: Truth v1",
    "Truth v2\n\n## History\n\n- 2025-01-01: Truth v0",
  ]) {
    const rejected = await call({
      ...base,
      operation: undefined,
      replace_body: true,
      body,
    });
    assert.equal(rejected.ok, false);
    assert.equal(read(created.file), before);
  }

  const replaced = await call({
    ...base,
    operation: undefined,
    replace_body: true,
    body: "Truth v2\n\n## History\n\n- 2025-01-01: Truth v0\n- 2026-08-05: Truth v1",
  });
  assert.equal(replaced.action, "replaced");
  const out = read(created.file);
  assert.equal(out.match(/2025-01-01: Truth v0/g)!.length, 1);
  assert.equal(out.match(/2026-08-05: Truth v1/g)!.length, 1);
  assert.match(out, /Truth v2/);
});

// ─── лок и атомарная запись ────────────────────────────────────────────────
const {
  HISTORY_ENTRY_CAP,
  acquireLock,
  atomicWrite,
  bodyContains,
  mergeCard,
  slugify,
} = (await import(
  join(REPO, "agent", "lib", "card-store.ts")
)) as typeof import("../agent/lib/card-store.ts");

test("D5: substring не подавляет отдельный факт, exact structural record подавляет", () => {
  const existing = [
    "# D5",
    "",
    "A discarded quote said: Alice owns ACME.",
    "",
    "## Log",
    "",
    "- 2026-08-15: Bob owns Globex.",
    "",
  ].join("\n");

  assert.equal(bodyContains(existing, "Alice owns ACME."), false);
  assert.equal(
    bodyContains(existing, "A discarded quote said: Alice owns ACME."),
    true,
  );
  assert.equal(bodyContains(existing, "Bob owns Globex."), true);
  assert.equal(
    bodyContains(
      "# D5\n\nCurrent truth.\n\n## Log\n\nlegacy prose: Bob owns Globex.\n",
      "Bob owns Globex.",
    ),
    false,
    "неоднозначный Log не должен подавлять новый факт",
  );
});

test("D5 property: разные normalized facts никогда не подавляются", () => {
  fc.assert(
    fc.property(
      fc
        .string({ minLength: 1, maxLength: 80 })
        .filter((fact) => fact.trim().length > 0),
      fc.string({ minLength: 1, maxLength: 30 }),
      fc.string({ minLength: 1, maxLength: 30 }),
      (fact, prefix, suffix) => {
        const wrapped = `${prefix} ${fact} ${suffix}`;
        fc.pre(
          wrapped.replace(/\s+/g, " ").trim().toLowerCase() !==
            fact.replace(/\s+/g, " ").trim().toLowerCase(),
        );
        assert.equal(
          bodyContains(`# Card\n\n${wrapped}\n`, fact),
          false,
          `substring was suppressed: ${JSON.stringify({ fact, wrapped })}`,
        );
      },
    ),
    { seed: 18_705, numRuns: 200 },
  );
});

test("M12: omitted UPDATE/SUPERSEDE metadata сохраняется, explicit меняет только своё поле", async () => {
  const title = "Tri-state metadata contract";
  const rel = `cards/projects/${slugify(title)}.md`;
  const file = join(VAULT, rel);
  mkdirSync(join(VAULT, "cards", "projects"), { recursive: true });
  writeFileSync(
    file,
    [
      "---",
      "type: project",
      "description: old",
      "tags: [old]",
      "status: paused",
      "confidence: INFERRED",
      'future_meta: "keep, [exactly]"',
      "---",
      `# ${title}`,
      "",
      "Current truth.",
      "",
    ].join("\n"),
  );

  const update = await call({
    operation: "UPDATE",
    type: "project",
    title,
    description: "new description",
    tags: ["new"],
    body: "Compatible fact.",
  });
  assert.equal(update.ok, true, update.error);
  assert.equal(update.status, "paused");
  let fields = parseFrontmatter(read(rel)).fields;
  assert.ok(fields);
  assert.equal(fields.status, "paused");
  assert.equal(fields.confidence, "INFERRED");
  assert.equal(fields.future_meta, "keep, [exactly]");

  const supersede = await call({
    operation: "SUPERSEDE",
    type: "project",
    title,
    description: "replacement",
    tags: ["new"],
    body: "Replacement truth.",
    history_entry: "Current truth.",
  });
  assert.equal(supersede.ok, true, supersede.error);
  assert.equal(supersede.status, "paused");
  fields = parseFrontmatter(read(rel)).fields;
  assert.ok(fields);
  assert.equal(fields.status, "paused");
  assert.equal(fields.confidence, "INFERRED");
  assert.equal(fields.future_meta, "keep, [exactly]");

  const explicitStatus = await call({
    operation: "UPDATE",
    type: "project",
    title,
    description: "replacement",
    tags: ["new"],
    status: "done",
    body: "Status changed explicitly.",
  });
  assert.equal(explicitStatus.ok, true, explicitStatus.error);
  assert.equal(explicitStatus.status, "done");
  fields = parseFrontmatter(read(rel)).fields;
  assert.ok(fields);
  assert.equal(fields.status, "done");
  assert.equal(fields.confidence, "INFERRED");
  assert.equal(fields.future_meta, "keep, [exactly]");

  const explicitConfidence = await call({
    operation: "UPDATE",
    type: "project",
    title,
    description: "replacement",
    tags: ["new"],
    confidence: "AMBIGUOUS",
    body: "Confidence changed explicitly.",
  });
  assert.equal(explicitConfidence.ok, true, explicitConfidence.error);
  assert.equal(explicitConfidence.status, "done");
  fields = parseFrontmatter(read(rel)).fields;
  assert.ok(fields);
  assert.equal(fields.status, "done");
  assert.equal(fields.confidence, "AMBIGUOUS");
  assert.equal(fields.future_meta, "keep, [exactly]");

  const beforeInvalid = read(rel);
  const invalidStatus = await call({
    operation: "UPDATE",
    type: "project",
    title,
    description: "replacement",
    tags: ["new"],
    status: "invented",
    body: "Invalid metadata must not write.",
  });
  assert.equal(invalidStatus.ok, false);
  assert.match(invalidStatus.error, /Недопустимый status/);
  assert.equal(read(rel), beforeInvalid);
});

test("M12 property: metadata patch сохраняет absent и меняет только explicit", async () => {
  let counter = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("active", "paused", "done", "draft"),
      fc.constantFrom("EXTRACTED", "INFERRED", "AMBIGUOUS"),
      fc.string({ maxLength: 60 }),
      async (status, confidence, futureMeta) => {
        const title = `M12 property ${counter++}`;
        const rel = `cards/projects/${slugify(title)}.md`;
        writeFileSync(
          join(VAULT, rel),
          [
            "---",
            "type: project",
            'description: "old"',
            'tags: ["old"]',
            `status: ${JSON.stringify(status)}`,
            `confidence: ${JSON.stringify(confidence)}`,
            `future_meta: ${JSON.stringify(futureMeta)}`,
            "---",
            `# ${title}`,
            "",
            "Current truth.",
            "",
          ].join("\n"),
        );

        const omitted = await call({
          operation: "UPDATE",
          type: "project",
          title,
          description: "new",
          tags: ["new"],
          body: "Omitted metadata update.",
        });
        assert.equal(omitted.ok, true, omitted.error);
        let fields = parseFrontmatter(read(rel)).fields;
        assert.ok(fields);
        assert.equal(fields.status, status);
        assert.equal(fields.confidence, confidence);
        assert.equal(fields.future_meta, futureMeta);

        const nextStatus = status === "done" ? "paused" : "done";
        const explicit = await call({
          operation: "UPDATE",
          type: "project",
          title,
          description: "new",
          tags: ["new"],
          status: nextStatus,
          body: "Explicit status update.",
        });
        assert.equal(explicit.ok, true, explicit.error);
        fields = parseFrontmatter(read(rel)).fields;
        assert.ok(fields);
        assert.equal(fields.status, nextStatus);
        assert.equal(fields.confidence, confidence);
        assert.equal(fields.future_meta, futureMeta);
      },
    ),
    { seed: 18_712, numRuns: 50 },
  );
});

test("card-store держит полную матрицу historyEntry как единый источник истины", () => {
  const base = {
    title: "Store contract",
    fields: {
      type: "note",
      description: "store-level contract",
      tags: ["note"],
      status: "active",
    },
    initialFields: { created: "2026-08-07", source: "daily/2026-08-07.md" },
    body: "Current truth",
    date: "2026-08-07",
  };
  const clean = mergeCard({ ...base, operation: "ADD" });
  const noisy = mergeCard({
    ...base,
    operation: "ADD",
    historyEntry: "x".repeat(20_000) + "\n## injected",
  });
  assert.equal(noisy.content, clean.content);
  assert.equal(noisy.ignoredHistoryEntry, true);
  assert.doesNotMatch(noisy.content, /History|injected/);

  assert.throws(
    () =>
      mergeCard({
        ...base,
        existing: clean.content,
        operation: "UPDATE",
        historyEntry: "",
      }),
    /only for SUPERSEDE/,
  );
  assert.throws(
    () => mergeCard({ ...base, operation: "NOOP", historyEntry: "noise" }),
    /only for SUPERSEDE/,
  );
  assert.throws(
    () => mergeCard({ ...base, operation: "NOOP" }),
    /requires an existing card/,
  );
  assert.throws(
    () =>
      mergeCard({
        ...base,
        existing: clean.content,
        operation: "SUPERSEDE",
        body: "New truth",
      }),
    /requires historyEntry/,
  );
  assert.throws(
    () =>
      mergeCard({
        ...base,
        existing: clean.content,
        operation: "SUPERSEDE",
        body: "New truth\n\n## History\n- fabricated archive",
      }),
    /requires historyEntry/,
  );
  const legacy = mergeCard({
    ...base,
    existing: clean.content,
    operation: undefined,
    replaceBody: true,
    body: "New truth\n\n## History\n- 2026-08-07: Current truth",
  });
  assert.equal(legacy.action, "replaced");
  assert.match(legacy.content, /## History\n+\n- 2026-08-07: Current truth/);
  for (const forged of [
    "New truth\n\n## History\n- 1999-01-01: fabricated archive",
    "New truth\n\n## Log\n- 1998-05-05: fabricated log",
    "New truth\n\n# Second title",
  ]) {
    assert.throws(
      () =>
        mergeCard({
          ...base,
          existing: clean.content,
          operation: "SUPERSEDE",
          body: forged,
          historyEntry: "2026-08-08: Current truth",
        }),
      /SUPERSEDE body must be a fact/,
      forged,
    );
  }
  assert.throws(
    () =>
      mergeCard({
        ...base,
        existing: clean.content,
        operation: "SUPERSEDE",
        body: "New truth",
        historyEntry: "x".repeat(HISTORY_ENTRY_CAP + 1),
      }),
    /must not exceed/,
  );
});

test("ADD отклоняет структурные секции в body, не создавая карточку", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Выдуманный архив",
    description: "проверка структурных границ add",
    tags: ["note", "add"],
  };
  for (const body of [
    "Текущая истина.\n\n## History\n\n- 2020-01-01: сидел в тюрьме",
    "Текущая истина.\n\n## Log\n- 2020-01-01: подделанная запись",
    "Текущая истина.\n\n# Второй заголовок",
  ]) {
    const rejected = await call({ ...base, body });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /without H1\/H2 headings/);
  }
  assert.equal(
    existsSync(join(VAULT, "cards", "notes", `${slugify(base.title)}.md`)),
    false,
  );
});

test("реплей SUPERSEDE через полночь остаётся noop, а не переставляет updated", () => {
  const base = {
    title: "Cross midnight replay",
    fields: {
      type: "note",
      description: "проверка реплея на следующие сутки",
      tags: ["note"],
      status: "active",
    },
    initialFields: { created: "2026-08-07", source: "daily/2026-08-07.md" },
    body: "Truth v1",
    date: "2026-08-07",
  };
  const created = mergeCard({ ...base, operation: "ADD" });
  const supersede = {
    ...base,
    existing: created.content,
    operation: "SUPERSEDE" as const,
    body: "Truth v2",
    historyEntry: "2026-08-07: Truth v1",
  };
  const replaced = mergeCard(supersede);
  assert.equal(replaced.action, "replaced");
  assert.match(replaced.content, /^updated: "2026-08-07"$/m);

  // Тот же вызов, повторённый на следующие сутки: единственное отличие - сегодняшний
  // `updated:`, и переписывать ради него карточку нельзя.
  const replayed = mergeCard({
    ...supersede,
    existing: replaced.content,
    date: "2026-08-08",
  });
  assert.equal(replayed.action, "noop");
  assert.equal(replayed.content, replaced.content);
});

test("лок сериализует запись: второй захват ждёт и падает по таймауту", () => {
  const file = join(VAULT, "cards", "notes", "lock-probe.md");
  const release = acquireLock(file);
  assert.throws(() => acquireLock(file, 100), /занята другим процессом/);
  release();
  acquireLock(file, 100)(); // после освобождения — снова доступно
});

test("write_card пережидает краткий внешний lock и пишет одну чистую карточку", async (t) => {
  const title = "Transient external lock";
  const file = join(VAULT, "cards", "notes", `${slugify(title)}.md`);
  const lock = `${file}.lock`;
  const holder = spawn(
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');const lock=process.argv[1];fs.writeFileSync(lock,'external-holder');process.stdout.write('ready\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);fs.rmSync(lock,{force:true});",
      lock,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => holder.kill());
  assert.ok(holder.stdout);
  const exited = waitForExit(holder);
  await once(holder.stdout, "data");

  const started = Date.now();
  const result = await call({
    operation: "ADD",
    type: "note",
    title,
    description: "wait for a real cross-process lock",
    tags: ["note", "lock"],
    body: "one committed body",
    history_entry: "discarded under delayed contention",
  });
  const elapsed = Date.now() - started;
  const code = await exited;
  assert.equal(code, 0);
  assert.equal(result.ok, true);
  assert.equal(result.action, "created");
  assert.ok(elapsed >= 100, `lock wait was not exercised: ${elapsed}ms`);
  const out = read(result.file);
  assert.equal(out.match(/one committed body/g)?.length, 1);
  assert.doesNotMatch(out, /History|delayed contention/);
});

test("fan-out процессов с одинаковым ADD дает одного писателя и один sanitized log", async (t) => {
  const payload = JSON.stringify({
    operation: "ADD",
    type: "note",
    title: "Cross process fanout",
    description: "only one process may create this card",
    tags: ["note", "fanout"],
    body: "single winner body",
    history_entry: "noise from every competing agent",
  });
  const childSource = [
    "process.env.ASSISTANT_VAULT_DIR=process.argv[1]",
    "await import('./scripts/lib/ts-esm-hooks.ts')",
    "const tool=(await import('./agent/tools/write_card.ts')).default",
    "const input=tool.inputSchema.parse(JSON.parse(process.argv[2]))",
    "console.log(JSON.stringify(await tool.execute(input)))",
  ].join(";");
  const children = Array.from({ length: 6 }, () =>
    spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        childSource,
        VAULT,
        payload,
      ],
      { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  t.after(() => children.forEach((child) => child.kill()));
  const completed = await Promise.all(
    children.map(async (child) => {
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const code = await waitForExit(child);
      return { code, stdout, stderr };
    }),
  );
  assert.ok(
    completed.every(({ code }) => code === 0),
    JSON.stringify(completed),
  );
  const results = completed.map(
    ({ stdout }) => JSON.parse(stdout) as WriteCardResult,
  );
  assert.equal(results.filter(({ ok }) => ok).length, 1);
  assert.equal(results.filter(({ action }) => action === "created").length, 1);
  assert.equal(
    results.filter(({ error }) => /ADD отказан/.test(error)).length,
    5,
  );
  const events = completed.flatMap(({ stderr }) =>
    stderr
      .split("\n")
      .filter((line) => line.includes('"event":"write_card_input_normalized"')),
  );
  assert.equal(events.length, 1);
  assert.doesNotMatch(events[0], /Cross process|single winner|competing agent/);

  const file = results.find(({ ok }) => ok)?.file;
  assert.ok(file);
  const out = read(file);
  assert.equal(out.match(/single winner body/g)?.length, 1);
  assert.doesNotMatch(out, /History|competing agent/);
  const cardDir = join(VAULT, "cards", "notes");
  assert.deepEqual(
    readdirSync(cardDir).filter(
      (name) => name.includes("fanout") || name.includes(".tmp-"),
    ),
    [`${slugify("Cross process fanout")}.md`],
  );
  assert.equal(existsSync(`${join(VAULT, file)}.lock`), false);
});

test("устаревший history_entry на новом теле отклоняется, а точный реплей остаётся noop", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Устаревший history_entry",
    description: "владелец Alice",
    tags: ["note", "owner"],
    body: "Owner: Alice.",
  };
  const created = await call(base);
  assert.equal(created.ok, true);

  const supersede = {
    ...base,
    operation: "SUPERSEDE",
    description: "владелец Bob",
    body: "Owner: Bob.",
    history_entry: "2026-01-01: Owner: Alice.",
  };
  assert.equal((await call(supersede)).action, "replaced");
  const archived = read(created.file);
  assert.equal(archived.match(/- 2026-01-01: Owner: Alice\./g)!.length, 1);

  // Тело меняется, а history_entry всё тот же: вытесняется уже Bob, но модель прислала
  // строку про Alice. Дописать её нельзя (дубль), проглотить нельзя (Bob пропал бы) -
  // отказ, карточка не тронута.
  for (const history_entry of ["2026-01-01: Owner: Alice.", "Owner: Alice."]) {
    const stale = await call({
      ...supersede,
      description: "владелец Carol",
      body: "Owner: Carol.",
      history_entry,
    });
    assert.equal(stale.ok, false, history_entry);
    assert.match(stale.error, /still changes the card/);
    assert.equal(read(created.file), archived, "карточка не тронута");
  }

  // Тот же вызов целиком - настоящий реплей: строка архива уже на месте, файл не переписан.
  const replayed = await call(supersede);
  assert.equal(replayed.action, "noop");
  assert.equal(read(created.file), archived);
  assert.equal(archived.match(/^## History$/gm)!.length, 1);
});

test("SUPERSEDE, доставленный не по порядку, не откатывает truth на архивный факт", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Не по порядку",
    description: "владелец Алиса",
    tags: ["note", "owner"],
    body: "Владелец Алиса.",
  };
  const created = await call(base);
  assert.equal(created.ok, true);

  const toBob = {
    ...base,
    operation: "SUPERSEDE",
    description: "владелец Боб",
    body: "Владелец Боб.",
    history_entry: "2026-08-09: Владелец Алиса.",
  };
  assert.equal((await call(toBob)).action, "replaced");
  const toCarol = {
    ...base,
    operation: "SUPERSEDE",
    description: "владелец Кэрол",
    body: "Владелец Кэрол.",
    history_entry: "2026-08-09: Владелец Боб.",
  };
  assert.equal((await call(toCarol)).action, "replaced");
  const archived = read(created.file);

  // Повторная доставка ПРЕДЫДУЩЕГО SUPERSEDE: его строка архива давно не хвост, но факт
  // уже вытеснен. Пропустить вызов - откатить truth на Боба, потеряв Кэрол молча, и
  // положить в append-only архив второго Алису. Отказ, карточка не тронута.
  for (const history_entry of [
    "2026-08-09: Владелец Алиса.",
    "Владелец Алиса.",
  ]) {
    const stale = await call({ ...toBob, history_entry });
    assert.equal(stale.ok, false, history_entry);
    assert.match(stale.error, /still changes the card/);
    assert.equal(read(created.file), archived, "карточка не тронута");
  }
  assert.match(archived.split("## History")[0], /Владелец Кэрол\./);
  assert.equal(archived.match(/Владелец Алиса\./g)!.length, 1);

  // Реплей ПОСЛЕДНЕГО вызова остаётся noop - архив уже содержит ровно его строку.
  assert.equal((await call(toCarol)).action, "noop");
  assert.equal(read(created.file), archived);

  // Факт, которого в архиве ещё нет, по-прежнему вытесняет truth штатно.
  assert.equal(
    (
      await call({
        ...base,
        operation: "SUPERSEDE",
        description: "владелец Дмитрий",
        body: "Владелец Дмитрий.",
        history_entry: "2026-08-10: Владелец Кэрол.",
      })
    ).action,
    "replaced",
  );
  const out = read(created.file);
  assert.equal(out.match(/^## History$/gm)!.length, 1);
  assert.deepEqual(
    out
      .slice(out.indexOf("## History"))
      .split("\n")
      .filter((line) => line.startsWith("- ")),
    [
      "- 2026-08-09: Владелец Алиса.",
      "- 2026-08-09: Владелец Боб.",
      "- 2026-08-10: Владелец Кэрол.",
    ],
  );
});

test("вытесняемый факт сверяется с нынешней истиной, а не только с архивом", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Сверка вытесняемого факта",
    description: "владелец Алиса",
    tags: ["note", "owner"],
    body: "Владелец Алиса.",
  };
  const created = await call(base);
  assert.equal(created.ok, true);

  const toBob = {
    ...base,
    operation: "SUPERSEDE",
    description: "владелец Боб",
    body: "Владелец Боб.",
    history_entry: "2026-08-09: Владелец Алиса.",
  };
  assert.equal((await call(toBob)).action, "replaced");
  const toCarol = {
    ...base,
    operation: "SUPERSEDE",
    description: "владелец Кэрол",
    body: "Владелец Кэрол.",
    history_entry: "2026-08-09: Владелец Боб.",
  };
  assert.equal((await call(toCarol)).action, "replaced");
  const archived = read(created.file);

  // Повторная доставка ВТОРОГО вызова: тело про Боба, вытесняемый факт про Алису, хотя
  // карточка держит уже Кэрол. Под своей датой строка ловится сверкой с архивом, а под
  // новой архив её не узнаёт - и без сверки с истиной вызов прошёл бы: Кэрол пропала бы
  // молча, а в append-only архив легла бы вторая Алиса.
  for (const [history_entry, expected] of [
    ["2026-08-09: Владелец Алиса.", /still changes the card/],
    ["Владелец Алиса.", /still changes the card/],
    ["2026-08-10: Владелец Алиса.", /Compiled Truth this SUPERSEDE displaces/],
    ["2026-08-11: Владелец Алиса", /Compiled Truth this SUPERSEDE displaces/],
  ] as const) {
    const stale = await call({ ...toBob, history_entry });
    assert.equal(stale.ok, false, history_entry);
    assert.match(stale.error, expected, history_entry);
    assert.equal(read(created.file), archived, history_entry);
  }
  assert.match(archived.split("## History")[0], /Владелец Кэрол\./);
  assert.equal(archived.match(/Владелец Алиса\./g)!.length, 1);
  assert.deepEqual(
    archived
      .slice(archived.indexOf("## History"))
      .split("\n")
      .filter((line) => line.startsWith("- ")),
    ["- 2026-08-09: Владелец Алиса.", "- 2026-08-09: Владелец Боб."],
  );

  // Настоящий реплей ПОСЛЕДНЕГО вызова после нескольких замен остаётся noop: сверка
  // с истиной идёт после проверки реплея и не отказывает повтору, который ничего не меняет.
  const replayed = await call(toCarol);
  assert.equal(replayed.action, "noop");
  assert.equal(read(created.file), archived);
});

test("открытый фенс в лежащей карточке отклоняет и UPDATE, а не прячет факт в код", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Фенс в карточке до UPDATE",
    description: "в теле карточки остался открытый фенс",
    tags: ["note", "fence"],
    body: "Owner: Alice.",
  };
  const created = await call(base);
  assert.equal(created.ok, true);
  // Опечатка человека: фенс открыт выше ## Log, поэтому секции не видно и новая запись
  // уехала бы внутрь кода - в карточке она есть, а для читателя её нет.
  const poisoned =
    `${read(created.file).trimEnd()}\n\n` +
    "```yaml\nowner: Alice\n\n" +
    "## Log\n\n- 2026-01-01: Ownership confirmed\n";
  writeFileSync(join(VAULT, created.file), poisoned);

  const rejected = await call({
    ...base,
    operation: "UPDATE",
    body: "Новый факт.",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /existing card body leaves a code fence open/);
  assert.match(rejected.error, /close it before UPDATE/);
  assert.equal(read(created.file), poisoned);

  // Тот же UPDATE проходит, как только фенс закрыт человеком.
  writeFileSync(
    join(VAULT, created.file),
    poisoned.replace("owner: Alice\n", "owner: Alice\n```\n"),
  );
  const accepted = await call({
    ...base,
    operation: "UPDATE",
    body: "Новый факт.",
  });
  assert.equal(accepted.ok, true);
  assert.match(read(created.file), /^- \d{4}-\d{2}-\d{2}: Новый факт\.$/m);
});

test("проверка заголовков судит тело в форме хранения: ADD хранит как есть, UPDATE со сдвигом", async () => {
  const { outsideFences } = (await import(
    join(REPO, "agent", "lib", "card-store.ts")
  )) as typeof import("../agent/lib/card-store.ts");
  const realHeadings = (card: string, heading: string) => {
    const lines = card.split("\n");
    const outside = outsideFences(lines);
    const wanted = new RegExp(`^ {0,3}##\\s+${heading}\\s*$`, "i");
    return lines.filter((line, index) => outside[index] && wanted.test(line))
      .length;
  };
  // Один и тот же фенс с отступом 2: ADD кладёт тело в карточку байт в байт, поэтому
  // фенс остаётся фенсом и ## History внутри него - код. UPDATE сдвигает тело на два
  // пробела под буллет Log, фенс уезжает на 4 и фенсом быть перестаёт.
  const smuggled =
    "Факт.\n\n  ```text\n## History\n- 2020-01-01: подделка\n  ```";
  const base = {
    operation: "ADD",
    type: "note",
    title: "Форма хранения тела",
    description: "проверка судит то, что ляжет в карточку",
    tags: ["note", "fence"],
    body: smuggled,
  };
  const created = await call(base);
  assert.equal(created.ok, true);
  const stored = read(created.file);
  assert.ok(stored.includes(smuggled), "тело ADD хранится байт в байт");
  assert.equal(realHeadings(stored, "History"), 0, "пример остался кодом");

  const rejected = await call({ ...base, operation: "UPDATE", body: smuggled });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /must start every code fence at the line start/);
  assert.equal(read(created.file), stored, "карточка не тронута");
});

test("следующий UPDATE не правит ранее сохранённую запись Log ни на байт", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Пустая строка внутри записи Log",
    description: "конфиг с секциями лежит в Log",
    tags: ["note", "fence"],
    body: "Seed.",
  };
  const created = await call(base);
  assert.equal(created.ok, true);

  // Пустая строка между секциями конфига несёт смысл: склеить `port: 8080` с `client:`
  // значит задним числом переписать сохранённое свидетельство.
  const config =
    "Deploy config:\n\n```yaml\nserver:\n  port: 8080\n\nclient:\n  retries: 3\n```";
  assert.equal(
    (await call({ ...base, operation: "UPDATE", body: config })).ok,
    true,
  );
  const stored = read(created.file);
  const savedLog = stored.slice(stored.indexOf("## Log")).trimEnd();
  assert.match(
    savedLog,
    /port: 8080\n\s*\n\s*client:/,
    "пустая строка сохранена",
  );

  // Второй UPDATE к первой записи не относится вообще - и не имеет права её трогать.
  const later = await call({
    ...base,
    operation: "UPDATE",
    body: "Unrelated later fact.",
  });
  assert.equal(later.ok, true);
  const after = read(created.file);
  assert.ok(after.includes(savedLog), "прежняя запись Log уцелела байт в байт");
  assert.match(after, /^- \d{4}-\d{2}-\d{2}: Unrelated later fact\.$/m);

  // И третий: форма секции устойчива, пустые строки не копятся и не исчезают.
  assert.equal(
    (await call({ ...base, operation: "UPDATE", body: "Third fact." })).ok,
    true,
  );
  const third = read(created.file);
  assert.ok(
    third.includes(savedLog),
    "запись Log уцелела и после третьего UPDATE",
  );
  assert.equal(third.match(/port: 8080/g)!.length, 1);
});

test("atomicWrite не оставляет временных файлов и пишет целиком", () => {
  const dir = join(VAULT, "cards", "notes");
  const file = join(dir, "atomic-probe.md");
  atomicWrite(file, "содержимое\n");
  assert.equal(readFileSync(file, "utf8"), "содержимое\n");
  assert.equal(readdirSync(dir).filter((n) => n.includes(".tmp-")).length, 0);
});
