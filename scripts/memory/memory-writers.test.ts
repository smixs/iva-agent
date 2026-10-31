import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ToolContext } from "eve/tools";
import fc from "fast-check";
import { asSchema } from "ai";
import { toInputSchema } from "../../node_modules/eve/dist/src/tools/schema.js";
import "../lib/ts-esm-hooks.ts";

const writeCard = (await import("../../agent/tools/write_card.ts")).default;
const writeFile = (await import("../../agent/tools/write_file.ts")).default;
const { writeCore } = await import("../../agent/lib/core-write.ts");
const context = {} as ToolContext;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(t: TestContext): { vault: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "iva-memory-writers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  mkdirSync(vault);
  writeFileSync(
    join(vault, "CORE.md"),
    "# CORE\n\n## Пользователь\n\n## Предпочтения\n\n## Активные цели\n",
  );
  git(vault, "init", "-q");
  git(vault, "config", "user.email", "memory-writer@example.invalid");
  git(vault, "config", "user.name", "Memory Writer Test");
  git(vault, "add", ".");
  git(vault, "commit", "-qm", "initial");
  process.env.ASSISTANT_VAULT_DIR = vault;
  process.env.ASSISTANT_TIMEZONE = "UTC";
  return { vault, outside: join(root, "outside.md") };
}

void test("write_card fact сохраняет чужие поля и дедуплицирует хвост источника", async (t) => {
  const fx = fixture(t);
  const file = join(fx.vault, "cards/projects/аврора.md");
  mkdirSync(join(fx.vault, "cards/projects"), { recursive: true });
  writeFileSync(
    file,
    [
      "---",
      'type: "project"',
      'description: "Старое"',
      'x_owner: "keep"',
      "---",
      "# Аврора",
      "",
      "Правда",
      "",
      "## Log",
      "",
      "## Related",
      "",
      "## History",
      "",
    ].join("\n"),
  );
  git(fx.vault, "add", ".");
  git(fx.vault, "commit", "-qm", "card");
  const input = {
    operation: "fact" as const,
    type: "project" as const,
    title: "Аврора",
    text: "Срок в пятницу",
    source: "[[daily/2026-09-27]] 10:00",
    tags: [],
    aliases: [],
  };
  const first = await writeCard.execute(input, context);
  assert.equal((first as { ok?: boolean }).ok, true, JSON.stringify(first));
  const once = readFileSync(file, "utf8");
  assert.match(once, /x_owner: "keep"/u);
  assert.match(
    once,
    /- \d{4}-\d{2}-\d{2}: Срок в пятницу · \[\[daily\/2026-09-27\]\] 10:00/u,
  );
  const second = await writeCard.execute(input, context);
  assert.equal((second as { ok?: boolean }).ok, true, JSON.stringify(second));
  assert.equal(readFileSync(file, "utf8"), once);
});

void test("write_card fact находит уточнённое имя, сливает поля и не правит старый Log", async (t) => {
  const fx = fixture(t);
  const dir = join(fx.vault, "cards/contacts");
  const file = join(dir, "shima.md");
  mkdirSync(dir, { recursive: true });
  const oldLog = [
    "- 2026-08-17:",
    "  Первый абзац",
    "  ",
    "  Второй абзац",
    "  ```",
    "  код:",
    "",
    "  строка",
    "  ```",
  ].join("\n");
  writeFileSync(
    file,
    [
      "---",
      'type: "contact"',
      'description: "коллега"',
      'tags: ["work"]',
      'aliases: ["Ivan Petrov"]',
      "---",
      "# Иван Петров (Ваня из Enji)",
      "",
      "Старая правда",
      "",
      "## Log",
      "",
      oldLog,
      "",
      "## Related",
      "",
      "## History",
      "",
    ].join("\n"),
  );
  git(fx.vault, "add", ".");
  git(fx.vault, "commit", "-qm", "card");

  const first = await writeCard.execute(
    {
      operation: "fact",
      type: "contact",
      title: "Иван Петров",
      text: "Переехал в Алматы",
      aliases: ["Ваня"],
      description: "коллега из Алматы",
      tags: ["almaty"],
    },
    context,
  );
  assert.equal((first as { ok?: boolean }).ok, true, JSON.stringify(first));
  assert.equal(existsSync(join(dir, "иван-петров.md")), false);
  const changed = readFileSync(file, "utf8");
  assert.match(changed, /aliases: \["Ivan Petrov","Ваня"\]/u);
  assert.match(changed, /tags: \["work","almaty"\]/u);
  assert.match(changed, /description: "коллега из Алматы"/u);
  assert.ok(changed.includes(oldLog), changed);

  const byAlias = await writeCard.execute(
    {
      operation: "fact",
      type: "contact",
      title: "Ваня",
      text: "Ведёт продажи",
      aliases: [],
      tags: [],
    },
    context,
  );
  assert.equal((byAlias as { ok?: boolean }).ok, true, JSON.stringify(byAlias));
  assert.equal(existsSync(join(dir, "ваня.md")), false);
});

void test("write_card truth архивирует вытеснённую правду, merge требует подтверждение", async (t) => {
  const fx = fixture(t);
  const dir = join(fx.vault, "cards/notes");
  mkdirSync(dir, { recursive: true });
  const card = (name: string, truth: string) =>
    [
      "---",
      'type: "note"',
      `description: "${name}"`,
      'custom: "alive"',
      "---",
      `# ${name}`,
      "",
      truth,
      "",
      "## Log",
      "",
      "## Related",
      "",
      "## History",
      "",
    ].join("\n");
  writeFileSync(join(dir, "главная.md"), card("Главная", "Старая правда"));
  writeFileSync(
    join(dir, "дубль.md"),
    card("Дубль", "Другая правда\n\n## Роли\n\n- Роль дубля"),
  );
  git(fx.vault, "add", ".");
  git(fx.vault, "commit", "-qm", "cards");

  const truth = await writeCard.execute(
    {
      operation: "truth",
      type: "note",
      title: "Главная",
      text: "Новая правда",
      description: "Новая правда",
      reason: "владелец уточнил",
      source: "[[daily/2026-09-27]]",
    },
    context,
  );
  assert.equal((truth as { ok?: boolean }).ok, true, JSON.stringify(truth));
  const changed = readFileSync(join(dir, "главная.md"), "utf8");
  assert.match(changed, /Новая правда/u);
  assert.match(changed, /Старая правда \(владелец уточнил/u);
  assert.match(changed, /description: "Новая правда"/u);
  assert.match(changed, /- \d{4}-\d{2}-\d{2}: Главная/u);
  assert.match(changed, /custom: "alive"/u);

  const refused = await writeCard.execute(
    {
      operation: "merge",
      target: "Главная",
      duplicate: "Дубль",
      confirmed_by_owner: false,
    } as never,
    context,
  );
  assert.equal((refused as { ok?: boolean }).ok, false);
  assert.match(
    (refused as { error?: string }).error ?? "",
    /confirmed_by_owner/u,
  );
  const merged = await writeCard.execute(
    {
      operation: "merge",
      target: "Главная",
      duplicate: "Дубль",
      confirmed_by_owner: true,
    },
    context,
  );
  assert.equal((merged as { ok?: boolean }).ok, true, JSON.stringify(merged));
  assert.match(
    readFileSync(join(dir, "дубль.md"), "utf8"),
    /status: "superseded"/u,
  );
  const target = readFileSync(join(dir, "главная.md"), "utf8");
  assert.match(target, /Другая правда/u);
  assert.match(target, /Роль дубля/u);
});

void test("truth отказывает структурной разметке и выводит короткий description", async (t) => {
  const fx = fixture(t);
  const dir = join(fx.vault, "cards/notes");
  const file = join(dir, "правда.md");
  mkdirSync(dir, { recursive: true });
  const before =
    '---\ntype: "note"\ndescription: "Старая"\n---\n# Правда\n\nСтарая\n\n## Log\n\n## Related\n\n## History\n';
  writeFileSync(file, before);
  git(fx.vault, "add", ".");
  git(fx.vault, "commit", "-qm", "card");
  for (const text of ["# H1", "## Log\n\nподделка", "Правда\n```\ncode"]) {
    const result = await writeCard.execute(
      {
        operation: "truth",
        type: "note",
        title: "Правда",
        text,
        description: "Новая",
        reason: "r",
      },
      context,
    );
    assert.equal((result as { ok?: boolean }).ok, false, text);
    assert.equal(readFileSync(file, "utf8"), before);
  }
  const missing = await writeCard.execute(
    {
      operation: "truth",
      type: "note",
      title: "Правда",
      text: "Первая фраза. Вторая фраза остаётся только в правде.",
      reason: "r",
    },
    context,
  );
  assert.equal((missing as { ok?: boolean }).ok, true, JSON.stringify(missing));
  const changed = readFileSync(file, "utf8");
  assert.match(changed, /description: "Первая фраза\."/u);
  assert.doesNotMatch(changed.split("---", 2)[1] ?? "", /Вторая фраза/u);
  const explicit = await writeCard.execute(
    {
      operation: "truth",
      type: "note",
      title: "Правда",
      text: "Следующая правда",
      description: "# Сводка",
      reason: "r",
    },
    context,
  );
  assert.equal(
    (explicit as { ok?: boolean }).ok,
    true,
    JSON.stringify(explicit),
  );
  assert.match(readFileSync(file, "utf8"), /description: "# Сводка"/u);
});

void test("truth с H2 в закрытом фенсе переживает следующую truth и fact", async (t) => {
  const fx = fixture(t);
  const dir = join(fx.vault, "cards/notes");
  const file = join(dir, "фенсовая.md");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    '---\ntype: "note"\n---\n# Фенсовая\n\nСтарая\n\n## Log\n\n## Related\n\n## History\n',
  );
  git(fx.vault, "add", ".");
  git(fx.vault, "commit", "-qm", "card");
  const truth = (text: string) =>
    writeCard.execute(
      {
        operation: "truth",
        type: "note",
        title: "Фенсовая",
        text,
        reason: "r",
      },
      context,
    );
  assert.equal(
    (
      (await truth("Новая\n\n```md\n## внутри кода\n```\nхвост")) as {
        ok?: boolean;
      }
    ).ok,
    true,
  );
  assert.equal(((await truth("Совсем новая")) as { ok?: boolean }).ok, true);
  const fact = await writeCard.execute(
    {
      operation: "fact",
      type: "note",
      title: "Фенсовая",
      text: "следующий факт",
      aliases: [],
      tags: [],
    },
    context,
  );
  assert.equal((fact as { ok?: boolean }).ok, true, JSON.stringify(fact));
  const changed = readFileSync(file, "utf8");
  assert.doesNotMatch(changed.split("\n## Log\n", 1)[0], /внутри кода|хвост/u);
  assert.equal((changed.match(/^## History$/gmu) ?? []).length, 1);
});

void test("повтор fact сливает поля, а alias сверх потолка назван в ответе", async (t) => {
  const fx = fixture(t);
  const dir = join(fx.vault, "cards/notes");
  const file = join(dir, "mm.md");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    [
      "---",
      'type: "note"',
      'description: "Старое"',
      `aliases: ${JSON.stringify(Array.from({ length: 8 }, (_, i) => `a${i}`))}`,
      "---",
      "# MM",
      "",
      "Правда",
      "",
      "## Log",
      "",
      "- 2026-09-28: факт · [[daily/2026-09-28]]",
      "",
      "## Related",
      "",
      "## History",
      "",
    ].join("\n"),
  );
  git(fx.vault, "add", ".");
  git(fx.vault, "commit", "-qm", "card");
  const result = (await writeCard.execute(
    {
      operation: "fact",
      type: "note",
      title: "MM",
      text: "факт",
      aliases: ["девятый"],
      tags: ["new"],
      description: "Новое",
    },
    context,
  )) as { ok?: boolean; note?: string };
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.note ?? "", /девятый/u);
  const text = readFileSync(file, "utf8");
  assert.match(text, /description: "Новое"/u);
  assert.match(text, /tags: \["new"\]/u);
  assert.doesNotMatch(text, /девятый/u);
  assert.equal((text.match(/: факт ·/gu) ?? []).length, 1);
});

void test("merge сохраняет байты многострочных Log и History цели", async (t) => {
  const fx = fixture(t);
  const dir = join(fx.vault, "cards/notes");
  mkdirSync(dir, { recursive: true });
  const target = [
    "---",
    'type: "note"',
    "---",
    "# Target",
    "",
    "Правда",
    "",
    "## Log",
    "",
    "- 2026-08-17:",
    "  ```",
    "  npm test",
    "",
    "  npm run build",
    "  ```",
    "- 2026-08-18: абзац один",
    "",
    "  абзац два",
    "",
    "## Related",
    "",
    "## History",
    "",
    "- 2026-08-01: старое",
    "",
    "  второй абзац",
    "",
  ].join("\n");
  const duplicate = [
    "---",
    'type: "note"',
    "---",
    "# Dup",
    "",
    "Другая правда",
    "",
    "## Log",
    "",
    "- 2026-08-19: новое",
    "",
    "## Related",
    "",
    "## History",
    "",
    "- 2026-08-02: другое",
    "",
  ].join("\n");
  writeFileSync(join(dir, "target.md"), target);
  writeFileSync(join(dir, "dup.md"), duplicate);
  git(fx.vault, "add", ".");
  git(fx.vault, "commit", "-qm", "cards");
  const result = await writeCard.execute(
    {
      operation: "merge",
      target: "Target",
      duplicate: "Dup",
      confirmed_by_owner: true,
    },
    context,
  );
  assert.equal((result as { ok?: boolean }).ok, true, JSON.stringify(result));
  const changed = readFileSync(join(dir, "target.md"), "utf8");
  assert.ok(
    changed.includes(
      "- 2026-08-17:\n  ```\n  npm test\n\n  npm run build\n  ```\n- 2026-08-18: абзац один\n\n  абзац два",
    ),
    changed,
  );
  assert.ok(
    changed.includes("- 2026-08-01: старое\n\n  второй абзац"),
    changed,
  );
  assert.equal((changed.match(/^## Log$/gmu) ?? []).length, 1);
  assert.equal((changed.match(/^## History$/gmu) ?? []).length, 1);
});

void test("merge убирает отступивший H1 дубля и сохраняет прозу History", async (t) => {
  const fx = fixture(t);
  const dir = join(fx.vault, "cards/notes");
  mkdirSync(dir, { recursive: true });
  const card = (title: string, tail: string) =>
    `---\ntype: "note"\n---\n# ${title}\n\nПравда\n\n## Log\n\n## Related\n\n## History\n\n${tail}\n`;
  writeFileSync(join(dir, "цель.md"), card("Цель", "- 2026-08-01: старое"));
  writeFileSync(
    join(dir, "дубль.md"),
    card("Дубль", "Проза без буллета\n\n- 2026-08-02: другое").replace(
      "# Дубль",
      "\n# Дубль",
    ),
  );
  git(fx.vault, "add", ".");
  git(fx.vault, "commit", "-qm", "cards");
  const result = await writeCard.execute(
    {
      operation: "merge",
      target: "Цель",
      duplicate: "Дубль",
      confirmed_by_owner: true,
    },
    context,
  );
  assert.equal((result as { ok?: boolean }).ok, true, JSON.stringify(result));
  const changed = readFileSync(join(dir, "цель.md"), "utf8");
  assert.equal((changed.match(/^# /gmu) ?? []).length, 1);
  assert.match(changed, /Проза без буллета/u);
});

void test("write_file пишет снаружи и в library/, отказывает памяти vault и держит CORE cap", async (t) => {
  const fx = fixture(t);
  const external = await writeFile.execute(
    { path: fx.outside, content: "ok\n" },
    context,
  );
  assert.equal(
    (external as { ok?: boolean }).ok,
    true,
    JSON.stringify(external),
  );
  assert.equal(readFileSync(fx.outside, "utf8"), "ok\n");

  for (const path of [
    "daily/2026-09-27.md",
    "summaries/daily/2026-09-27.md",
    "weekly/2026-W39.md",
    "cards/notes/new.md",
  ]) {
    const refused = await writeFile.execute(
      { path: join(fx.vault, path), content: "raw" },
      context,
    );
    assert.equal((refused as { ok?: boolean }).ok, false, path);
    assert.equal(existsSync(join(fx.vault, path)), false, path);
  }
  const library = join(fx.vault, "library/book/01.md");
  const imported = await writeFile.execute(
    { path: library, content: "# Глава\n" },
    context,
  );
  assert.equal(
    (imported as { ok?: boolean }).ok,
    true,
    JSON.stringify(imported),
  );
  assert.equal(readFileSync(library, "utf8"), "# Глава\n");
  assert.equal(
    git(fx.vault, "log", "-1", "--format=%s"),
    "file library/book/01.md: write",
  );
  const oversized = await writeFile.execute(
    { path: join(fx.vault, "CORE.md"), content: "x".repeat(10_000) },
    context,
  );
  assert.equal((oversized as { ok?: boolean }).ok, false);
  assert.match(String((oversized as { error?: string }).error), /длиннее/u);
});

void test("ночь может только сокращать уже раздутый CORE, дневной шов отказывает", async (t) => {
  const fx = fixture(t);
  const file = join(fx.vault, "CORE.md");
  const oversized = `# CORE\n\n## Пользователь\n\n- ${"д".repeat(9_000)}\n`;
  writeFileSync(file, oversized);
  git(fx.vault, "add", ".");
  git(fx.vault, "commit", "-qm", "oversized core");
  const shorter = oversized.slice(0, -100);
  const day = await writeCore({
    vault: fx.vault,
    next: shorter,
    reason: "day",
    date: "2026-09-27",
    mode: "day",
  });
  assert.equal(day.ok, false);
  const night = await writeCore({
    vault: fx.vault,
    next: shorter,
    reason: "free space",
    date: "2026-09-27",
    mode: "night",
  });
  assert.equal(night.ok, true, night.error);
  const longer = await writeCore({
    vault: fx.vault,
    next: `${shorter}x`,
    reason: "grow",
    date: "2026-09-27",
    mode: "night",
  });
  assert.equal(longer.ok, false);
});

void test("write_card без полей операции отвечает текстом и ничего не пишет", async (t) => {
  const fx = fixture(t);
  const before = git(fx.vault, "rev-parse", "HEAD");
  const result = (await writeCard.execute(
    { operation: "fact", type: "note", text: "факт без имени" },
    context,
  )) as { ok?: boolean; error?: string };
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /^write_card fact: .*title/u);
  assert.match(result.error ?? "", /Пример формы fact.*"title"/u);
  assert.equal(git(fx.vault, "rev-parse", "HEAD"), before);
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
});

void test("write_card описывает валидные формы вызова до execute, сохраняя типы", async () => {
  const schema = asSchema(toInputSchema(writeCard.inputSchema));
  const examples = [
    ...writeCard.description.matchAll(
      /Пример формы (fact|truth|merge)[^\n]*?: (\{[^\n]+\})/gu,
    ),
  ];
  assert.deepEqual(
    examples.map((match) => match[1]),
    ["fact", "truth", "merge"],
  );
  for (const match of examples) {
    const example = JSON.parse(match[2]) as Record<string, unknown>;
    assert.equal((await schema.validate!(example)).success, true);
    assert.equal(example.operation, match[1]);
  }
  assert.match(writeCard.description, /пример не является подтверждением/u);
  assert.equal(
    (await schema.validate!({ operation: "fact", title: null })).success,
    false,
  );
  assert.equal(
    (await schema.validate!({ operation: "merge", confirmed_by_owner: "true" }))
      .success,
    false,
  );
});

void test("write_card: отказ для пропущенного поля содержит форму той же операции без записи (seed 255)", async (t) => {
  const fx = fixture(t);
  const before = git(fx.vault, "rev-parse", "HEAD");
  const examples = [
    ...writeCard.description.matchAll(
      /Пример формы (fact|truth|merge)[^\n]*?: (\{[^\n]+\})/gu,
    ),
  ].map((match) => JSON.parse(match[2]) as Record<string, unknown>);
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...examples),
      fc.nat(),
      async (example, position) => {
        const required = Object.keys(example).filter(
          (key) => key !== "operation",
        );
        const missing = required[position % required.length];
        const raw = { ...example };
        delete raw[missing];
        const result = (await writeCard.execute(
          raw as Parameters<typeof writeCard.execute>[0],
          context,
        )) as { ok: boolean; error: string };
        assert.equal(result.ok, false);
        assert.match(result.error, new RegExp(`${missing}:`, "u"));
        const hint = result.error.match(
          /Пример формы (fact|truth|merge)[^\n]*?: (\{[^\n]+\})/u,
        );
        assert.ok(hint);
        assert.equal(hint[1], example.operation);
        assert.deepEqual(JSON.parse(hint[2]), example);
        assert.match(result.error, /пример не является подтверждением/u);
      },
    ),
    { seed: 255, numRuns: 30 },
  );
  assert.equal(git(fx.vault, "rev-parse", "HEAD"), before);
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
});

void test("write_card не затирает нечитаемый файл на месте новой Card (ДЕФ-4 днём)", async (t) => {
  const fx = fixture(t);
  const file = join(fx.vault, "cards/contacts/борис.md");
  mkdirSync(join(fx.vault, "cards/contacts"), { recursive: true });
  const broken =
    '---\ndescription: "битая кавычка\n---\n# Борис\n\nТекст владельца\n';
  writeFileSync(file, broken);
  const result = await writeCard.execute(
    {
      operation: "fact",
      type: "contact",
      title: "Борис",
      text: "Новый факт",
      tags: [],
      aliases: [],
    },
    context,
  );
  assert.equal((result as { ok?: boolean }).ok, false);
  assert.equal(readFileSync(file, "utf8"), broken);
});

void test("отметка ночи в сыром дне видна старому isDayDone: откат не переразбирает день", () => {
  // Литералы старой ночи (b2cabffb scripts/lib/rollup-days.ts): отметка конца в служебном хвосте.
  const DONE = /^<!-- processed: .*-->$/u;
  const SERVICE =
    /^(?:|<!-- processed[:-].*-->|---|(?:processed|cards|summary): .*)$/u;
  const oldIsDayDone = (raw: string) => {
    const lines = raw.split(/\r?\n/u).map((line) => line.trimEnd());
    let start = lines.length;
    while (start > 0 && SERVICE.test(lines[start - 1])) start--;
    return lines.slice(start).some((line) => DONE.test(line));
  };
  const raw = "## 10:00 [text]\nФакт\n";
  const marked = `${raw}\n<!-- processed: memory-night 2026-09-26 -->\n`;
  assert.equal(oldIsDayDone(raw), false);
  assert.equal(oldIsDayDone(marked), true);
});

void test("поля ночи truth_date и truth_pending живы после старого write_card (откат на прошлую версию)", async () => {
  // mergeCard — движок write_card прошлой версии: откат пишет Card им.
  const { mergeCard } = await import("../../agent/lib/card-store.ts");
  const existing = [
    "---",
    'type: "note"',
    'description: "Проект"',
    'truth_date: "2026-09-26"',
    'truth_pending: "2026-09-25"',
    "---",
    "# Аврора",
    "",
    "Правда",
    "",
    "## Log",
    "",
  ].join("\n");
  const { content } = mergeCard({
    operation: "UPDATE",
    title: "Аврора",
    fields: { description: "Проект" },
    body: "Новый факт",
    date: "2026-09-27",
    existing,
  });
  assert.match(content, /truth_date: "2026-09-26"/u);
  assert.match(content, /truth_pending: "2026-09-25"/u);
});

void test("незакрытый фенс: fact, truth и merge отказывают до записи, байты Card целы (#14)", async (t) => {
  const fx = fixture(t);
  const dir = join(fx.vault, "cards/notes");
  mkdirSync(dir, { recursive: true });
  const fenced = [
    "---",
    'type: "note"',
    "---",
    "# Фенс",
    "",
    "```",
    "## History",
    "код",
    "",
    "## Log",
    "",
    "## Related",
    "",
    "## History",
    "",
  ].join("\n");
  const clean = fenced
    .replace("```\n## History\nкод\n", "")
    .replace("# Фенс", "# Чистая");
  writeFileSync(join(dir, "фенс.md"), fenced);
  writeFileSync(join(dir, "чистая.md"), clean);
  git(fx.vault, "add", ".");
  git(fx.vault, "commit", "-qm", "cards");
  const calls = [
    { operation: "fact", type: "note", title: "Фенс", text: "факт" },
    {
      operation: "truth",
      type: "note",
      title: "Фенс",
      text: "Правда",
      description: "Правда",
      reason: "r",
    },
    {
      operation: "merge",
      target: "Фенс",
      duplicate: "Чистая",
      confirmed_by_owner: true,
    },
    {
      operation: "merge",
      target: "Чистая",
      duplicate: "Фенс",
      confirmed_by_owner: true,
    },
  ];
  for (const input of calls) {
    const result = (await writeCard.execute(input as never, context)) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.match(result.error ?? "", /блок кода/u);
    assert.equal(readFileSync(join(dir, "фенс.md"), "utf8"), fenced);
    assert.equal(readFileSync(join(dir, "чистая.md"), "utf8"), clean);
  }
});

void test("CORE: замок дневных писателей держит и CORE, файл пишется раньше History, указатель в History не уходит (#1, #9, Н-4)", async (t) => {
  const fx = fixture(t);
  const { acquireLock } = await import("../../agent/lib/card-store.ts");
  const file = join(fx.vault, "CORE.md");
  const before = readFileSync(file, "utf8");
  mkdirSync(join(fx.vault, "cards"), { recursive: true });
  const release = await acquireLock(join(fx.vault, "cards", ".write_card"));
  const busy = await writeCore({
    vault: fx.vault,
    next: `${before}- занято\n`,
    reason: "day",
    date: "2026-09-27",
    mode: "day",
  }).catch((error: unknown) => ({ ok: false, error: String(error) }));
  release();
  assert.equal(busy.ok, false);
  assert.match(busy.error ?? "", /занята/u);
  assert.equal(readFileSync(file, "utf8"), before);

  const pointed = (day: string) =>
    `${before}\n## Указатели\n\n- Последний день: summaries/daily/${day}\n`;
  for (const day of ["2026-09-25", "2026-09-26"]) {
    const result = await writeCore({
      vault: fx.vault,
      next: pointed(day),
      reason: `night ${day}`,
      date: day,
      mode: "night",
    });
    assert.equal(result.ok, true, result.error);
  }
  assert.equal(existsSync(join(fx.vault, "CORE.history.md")), false);

  mkdirSync(join(fx.vault, "CORE.history.md"));
  const next = pointed("2026-09-26").replace(
    "## Пользователь\n",
    "## Пользователь\n\n- новое\n",
  );
  await writeCore({
    vault: fx.vault,
    next: next.replace("## Предпочтения\n", ""),
    reason: "night",
    date: "2026-09-27",
    mode: "night",
  }).catch(() => undefined);
  assert.match(readFileSync(file, "utf8"), /- новое/u);
});

// ── Статус Card днём (решение владельца 28.09.2026) ─────────────────────────────────
type Reply = { ok?: boolean; error?: string; file?: string };
const run = async (input: Record<string, unknown>) =>
  (await writeCard.execute(input as never, context)) as Reply;
const statusOf = (text: string) => /^status: "?([^"\n]+)"?$/mu.exec(text)?.[1];
const statusDateOf = (text: string) =>
  /^status_date: "?([^"\n]+)"?$/mu.exec(text)?.[1];
const fact = (parts: Record<string, unknown>) => ({
  operation: "fact",
  type: "project",
  title: "Аврора",
  text: "Проект закрыт",
  tags: ["проект"],
  aliases: [],
  ...parts,
});

void test("write_card fact со status: новая и существующая Card получают статус и дату статуса", async (t) => {
  const fx = fixture(t);
  const created = await run(fact({ status: "done" }));
  assert.equal(created.ok, true, JSON.stringify(created));
  const file = join(fx.vault, "cards/projects/аврора.md");
  assert.equal(statusOf(readFileSync(file, "utf8")), "done");
  assert.match(
    statusDateOf(readFileSync(file, "utf8")) ?? "",
    /^\d{4}-\d{2}-\d{2}$/u,
  );
  const paused = await run(fact({ text: "Проект на паузе", status: "paused" }));
  assert.equal(paused.ok, true, JSON.stringify(paused));
  assert.equal(statusOf(readFileSync(file, "utf8")), "paused");
  // Без status факт статус не трогает.
  const plain = await run(fact({ text: "Ещё факт" }));
  assert.equal(plain.ok, true, JSON.stringify(plain));
  assert.equal(statusOf(readFileSync(file, "utf8")), "paused");
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
});

void test("write_card truth со status меняет статус вместе с правдой", async (t) => {
  const fx = fixture(t);
  const made = await run(
    fact({ type: "decision", title: "Переезд", text: "Решили переезжать" }),
  );
  assert.equal(made.ok, true, JSON.stringify(made));
  const truth = await run({
    operation: "truth",
    type: "decision",
    title: "Переезд",
    text: "Переезд отменён.",
    reason: "владелец передумал",
    status: "reverted",
  });
  assert.equal(truth.ok, true, JSON.stringify(truth));
  const text = readFileSync(
    join(fx.vault, "cards/decisions/переезд.md"),
    "utf8",
  );
  assert.equal(statusOf(text), "reverted");
  assert.ok(statusDateOf(text));
});

void test("write_card: status не по типу Card и status у merge — отказ текстом, Card байт в байт", async (t) => {
  const fx = fixture(t);
  assert.equal(
    (await run(fact({ type: "contact", title: "Анна", text: "Коллега" }))).ok,
    true,
  );
  const file = join(fx.vault, "cards/contacts/анна.md");
  const before = readFileSync(file, "utf8");
  const head = git(fx.vault, "rev-parse", "HEAD");
  const wrong = await run(
    fact({ type: "contact", title: "Анна", text: "Уволилась", status: "done" }),
  );
  assert.equal(wrong.ok, false);
  assert.match(wrong.error ?? "", /done.*contact.*active, inactive/u);
  const merge = await run({
    operation: "merge",
    target: "Анна",
    duplicate: "Анна",
    confirmed_by_owner: true,
    status: "inactive",
  });
  assert.equal(merge.ok, false);
  assert.match(merge.error ?? "", /merge.*status/u);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(git(fx.vault, "rev-parse", "HEAD"), head);
});

void test("write_card: допустимые статусы берутся из schema.json vault", async (t) => {
  const fx = fixture(t);
  writeFileSync(
    join(fx.vault, "schema.json"),
    JSON.stringify({ node_types: { project: { status: ["active", "done"] } } }),
  );
  const paused = await run(fact({ status: "paused" }));
  assert.equal(paused.ok, false);
  assert.match(paused.error ?? "", /active, done/u);
  assert.equal(existsSync(join(fx.vault, "cards/projects/аврора.md")), false);
  assert.equal((await run(fact({ status: "done" }))).ok, true);
});

// Статус из schema.json vault, которого нет в шаблоне, представим на проводе: провод берёт
// строку, а допустимые для типа Card проверяет execute и называет их в отказе.
void test("write_card: свой статус из schema.json проходит провод и ставится, чужой — отказ с допустимыми", async (t) => {
  const fx = fixture(t);
  writeFileSync(
    join(fx.vault, "schema.json"),
    JSON.stringify({
      node_types: { project: { status: ["active", "blocked", "done"] } },
    }),
  );
  // Провод — тот же Standard Schema контракт, который eve проверяет до execute.
  const schema = asSchema(toInputSchema(writeCard.inputSchema));
  const wire = async (value: unknown) =>
    (await schema.validate!(value)).success;
  assert.equal(await wire(fact({ status: "blocked" })), true);
  const blocked = await run(fact({ status: "blocked" }));
  assert.equal(blocked.ok, true, JSON.stringify(blocked));
  const file = join(fx.vault, "cards/projects/аврора.md");
  assert.equal(statusOf(readFileSync(file, "utf8")), "blocked");
  const before = readFileSync(file, "utf8");
  for (const status of [
    "paused",
    "Done",
    "done\nx: 1",
    "x".repeat(10_000),
    "",
  ]) {
    assert.equal(await wire(fact({ status })), true);
    const reply = await run(fact({ text: "Ещё факт", status }));
    assert.equal(reply.ok, false, JSON.stringify(reply).slice(0, 200));
    assert.match(
      reply.error ?? "",
      /project\. Допустимы: active, blocked, done/u,
    );
    assert.equal(readFileSync(file, "utf8"), before);
  }
});

// merge статус не меняет: любое переданное поле status — отказ, включая пустую строку и
// пробел (провод берёт строку, поэтому проверяется наличие поля, а не его истинность).
void test("write_card merge с любым status — отказ текстом, склейки нет", async (t) => {
  const fx = fixture(t);
  for (const title of ["Аврора", "Аврора 2"])
    assert.equal((await run(fact({ title, text: "Факт" }))).ok, true);
  const files = ["аврора", "аврора-2"].map((name) =>
    join(fx.vault, `cards/projects/${name}.md`),
  );
  const before = files.map((file) => readFileSync(file, "utf8"));
  const head = git(fx.vault, "rev-parse", "HEAD");
  for (const status of ["", " ", "done"]) {
    const merge = await run({
      operation: "merge",
      target: "Аврора",
      duplicate: "Аврора 2",
      confirmed_by_owner: true,
      status,
    });
    assert.equal(merge.ok, false, JSON.stringify({ status, merge }));
    assert.match(merge.error ?? "", /merge: status не меняется склейкой/u);
    assert.deepEqual(
      files.map((file) => readFileSync(file, "utf8")),
      before,
    );
    assert.equal(git(fx.vault, "rev-parse", "HEAD"), head);
  }
});

// Property: любая последовательность fact/truth со status или без. Статус Card всегда из
// допустимых для её типа; принятый status — последний принятый, иначе active; отказ не
// меняет байты Card. Провал печатает seed; повтор: IVA_CARD_STATUS_SEED=<seed>.
const STATUS_SEED = Number(process.env.IVA_CARD_STATUS_SEED ?? 20_260_928);
const ALLOWED: Record<string, string[]> = {
  project: ["active", "done", "paused", "cancelled", "draft", "superseded"],
  contact: ["active", "inactive", "superseded"],
};
const STATUS_VALUES = [
  "active",
  "inactive",
  "done",
  "paused",
  "cancelled",
  "draft",
  "explored",
  "archived",
  "reverted",
  "superseded",
];

void test(`write_card status: последовательности операций держат инвариант (seed ${STATUS_SEED})`, async (t) => {
  const op = fc.record({
    operation: fc.constantFrom("fact", "truth"),
    status: fc.option(fc.constantFrom(...STATUS_VALUES), { nil: undefined }),
  });
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("project", "contact"),
      fc.array(op, { minLength: 1, maxLength: 5 }),
      async (type, ops) => {
        const fx = fixture(t);
        writeFileSync(
          join(fx.vault, "schema.json"),
          JSON.stringify({
            node_types: Object.fromEntries(
              Object.entries(ALLOWED).map(([k, v]) => [k, { status: v }]),
            ),
          }),
        );
        const dir = type === "project" ? "projects" : "contacts";
        const file = join(fx.vault, "cards", dir, "аврора.md");
        let expected: string | undefined;
        for (const [index, item] of ops.entries()) {
          const before = existsSync(file) ? readFileSync(file, "utf8") : null;
          const input =
            item.operation === "fact"
              ? fact({ type, text: `Факт ${index}`, status: item.status })
              : {
                  operation: "truth",
                  type,
                  title: "Аврора",
                  text: `Правда ${index}.`,
                  reason: "новое",
                  status: item.status,
                };
          const reply = await run(input);
          const allowed = !item.status || ALLOWED[type].includes(item.status);
          const cardExists = before !== null || item.operation === "fact";
          if (!allowed || !cardExists) {
            assert.equal(reply.ok, false, JSON.stringify(reply));
            assert.equal(
              existsSync(file) ? readFileSync(file, "utf8") : null,
              before,
            );
            continue;
          }
          assert.equal(reply.ok, true, JSON.stringify(reply));
          if (item.status) expected = item.status;
          const status = statusOf(readFileSync(file, "utf8"));
          assert.equal(status, expected ?? "active");
          assert.ok(ALLOWED[type].includes(status ?? ""));
        }
      },
    ),
    { seed: STATUS_SEED, numRuns: 25 },
  );
});

void test("write_card: новая Card без tags — отказ без записи, с tags создаётся, существующей tags не нужны", async (t) => {
  const fx = fixture(t);
  const before = git(fx.vault, "rev-parse", "HEAD");
  const bare = await run(
    fact({ type: "contact", title: "Иванов Иван", tags: [] }),
  );
  assert.equal(bare.ok, false);
  assert.match(bare.error ?? "", /нужны tags/u);
  assert.match(bare.error ?? "", /Пример формы fact.*"tags"/u);
  assert.equal(
    existsSync(join(fx.vault, "cards/contacts/иванов-иван.md")),
    false,
  );
  assert.equal(git(fx.vault, "rev-parse", "HEAD"), before);
  const tagged = await run(
    fact({
      type: "contact",
      title: "Иванов Иван",
      tags: ["клиент", "ромашка"],
    }),
  );
  assert.equal(tagged.ok, true, JSON.stringify(tagged));
  const file = join(fx.vault, "cards/contacts/иванов-иван.md");
  assert.match(readFileSync(file, "utf8"), /tags: \["клиент","ромашка"\]/u);
  const more = await run(
    fact({ type: "contact", title: "Иванов Иван", text: "Ещё факт", tags: [] }),
  );
  assert.equal(more.ok, true, JSON.stringify(more));
  assert.match(readFileSync(file, "utf8"), /Ещё факт/u);
});
