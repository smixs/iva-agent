/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Ссылка [[…]] в никуда живёт дольше всех: ночной graph.fix её не резолвит, health score
// графа падает, и чинит владелец руками. Здесь проверяется, что запись такой ссылки не
// происходит вовсе — и что законные формы (alias, #якорь, вложение, ещё не созданный
// родитель роллапа) отказом НЕ становятся: ложный отказ хуже пропуска, он глушит запись.
// Запуск: node --test scripts/vault-link-guard.test.ts

import "./lib/ts-esm-hooks.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolContext } from "eve/tools";
import { settled } from "./fixtures/tool-result.ts";
import { unresolvedLinkTargets } from "../agent/lib/vault-links.ts";
import { tempDir } from "./fixtures/temp-dir.ts";
import { buildVaultGraph } from "./memory/graph.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const VAULT = mkdtempSync(join(tmpdir(), "iva-links-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
process.env.ASSISTANT_TIMEZONE = "UTC";
process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

const card = (rel: string, title: string) => {
  const file = join(VAULT, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `---\ntype: note\n---\n\n# ${title}\n\nтекст\n`, "utf8");
};

mkdirSync(join(VAULT, "cards", "contacts"), { recursive: true });
mkdirSync(join(VAULT, "cards", "notes"), { recursive: true });
cpSync(join(REPO, "vault-template", "schema.json"), join(VAULT, "schema.json"));
card("cards/contacts/иванов-иван-иванович.md", "Иванов Иван Иванович");
card("cards/notes/romashka.md", "Romashka");
card("cards/notes/печать.md", "Печать");
// Один stem в двух каталогах — цель неоднозначна, python-резолвер отдаёт None.
card("cards/notes/двойник.md", "Двойник A");
card("cards/projects/двойник.md", "Двойник B");

// Тулы импортируются ПОСЛЕ фикстур вольта.
const { default: writeCard } = await import("../agent/tools/write_card.ts");
const { default: writeFile } = await import("../agent/tools/write_file.ts");

type FileResult = { ok: boolean; error: string; path: string };
type CardResult = { ok: boolean; error: string; file: string };
const callCard = (args: unknown) =>
  (
    writeCard as unknown as { execute: (input: unknown) => Promise<CardResult> }
  ).execute(args);

function toolContext(): ToolContext {
  const unavailable = (): never => {
    throw new Error("not used by this test");
  };
  return {
    abortSignal: new AbortController().signal,
    callId: "vault-link-guard",
    toolName: "write_file",
    session: {
      id: "vault-link-guard",
      auth: { current: null, initiator: null },
      turn: { id: "vault-link-guard", sequence: 0 },
    },
    getSandbox: () => Promise.reject(new Error("not used by this test")),
    getSkill: unavailable,
    getToken: () => Promise.reject(new Error("not used by this test")),
    requireAuth: unavailable,
  };
}

const callFile = async (path: string, content: string) =>
  settled(
    await (
      writeFile as unknown as {
        execute: (
          input: { path: string; content: string },
          context: ToolContext,
        ) => Promise<FileResult>;
      }
    ).execute({ path, content }, toolContext()),
  );

const SUNDAY_W37 = Date.UTC(2026, 8, 13); // воскресенье ISO-недели 2026-W37

// ─── резолв ────────────────────────────────────────────────────────────────

test("законные формы ссылки не считаются битыми", () => {
  assert.deepEqual(
    unresolvedLinkTargets(
      [
        "cards/notes/romashka.md",
        "cards/notes/romashka",
        "contacts/иванов-иван-иванович",
        "печать",
        "vault/cards/notes/romashka",
        "печать#Контакты",
        "Иванов Иван Иванович",
        "attachments/2026-09-13/photo.png",
      ],
      { vaultDir: VAULT, source: "cards/notes/новая", today: SUNDAY_W37 },
    ),
    [],
  );
});

// Правило #229 (graph.py _is_existing_attachment): вложение живое, если ровно этот файл
// лежит внутри vault обычным файлом, расширение любое. Иначе python и этот гвард
// спорили бы: ночь считает ссылку целой, а запись карточки её отвергает.
test("вложение: существующий файл с любым расширением — живая ссылка", () => {
  const dir = join(VAULT, "attachments", "2026-09-22");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.custombin"), "x");
  writeFileSync(join(dir, "contract.docx"), "x");
  assert.deepEqual(
    unresolvedLinkTargets(
      [
        "attachments/2026-09-22/report.custombin",
        "attachments/2026-09-22/contract.docx",
      ],
      { vaultDir: VAULT, source: "cards/notes/новая", today: SUNDAY_W37 },
    ),
    [],
  );
});

test("вложение: отсутствующий файл, выход за корень и симлинк — битые", () => {
  const dir = join(VAULT, "attachments", "2026-09-23");
  mkdirSync(dir, { recursive: true });
  const outside = tempDir("iva-links-out-");
  writeFileSync(join(outside, "secret.custombin"), "x");
  symlinkSync(join(outside, "secret.custombin"), join(dir, "link.custombin"));
  symlinkSync(outside, join(dir, "linked-dir"));
  assert.deepEqual(
    unresolvedLinkTargets(
      [
        "attachments/2026-09-23/missing.custombin",
        "attachments/../../secret.custombin",
        "attachments/2026-09-23/link.custombin",
        "attachments/2026-09-23/linked-dir/secret.custombin",
      ],
      { vaultDir: VAULT, source: "cards/notes/новая", today: SUNDAY_W37 },
    ),
    [
      "attachments/2026-09-23/missing.custombin",
      "attachments/../../secret.custombin",
      "attachments/2026-09-23/link.custombin",
      "attachments/2026-09-23/linked-dir/secret.custombin",
    ],
  );
});

test("опечатка, выдуманная транслитерация и неоднозначный stem — отказ со списком", () => {
  assert.deepEqual(
    unresolvedLinkTargets(
      [
        "печaть",
        "ivanov-ivan-ivanovich",
        "roma-shka",
        "cards/contacts/ооо-василёк",
        "двойник",
      ],
      { vaultDir: VAULT, source: "cards/notes/новая", today: SUNDAY_W37 },
    ),
    [
      "печaть",
      "ivanov-ivan-ivanovich",
      "roma-shka",
      "cards/contacts/ооо-василёк",
      "двойник",
    ],
  );
});

test("ссылка на самого себя разрешена и до, и после появления файла", () => {
  assert.deepEqual(
    unresolvedLinkTargets(["cards/notes/новая"], {
      vaultDir: VAULT,
      source: "cards/notes/новая",
      today: SUNDAY_W37,
    }),
    [],
    "при ADD файла на диске ещё нет",
  );
  assert.deepEqual(
    unresolvedLinkTargets(["romashka"], {
      vaultDir: VAULT,
      source: "cards/notes/romashka",
      today: SUNDAY_W37,
    }),
    [],
    "лежащая карточка не имеет права попасть в индекс дважды и стать неоднозначной",
  );
});

test("родитель роллапа: не просрочен — норма, просрочен — битая ссылка", () => {
  const options = { vaultDir: VAULT, source: "summaries/daily/2026-09-13" };
  assert.deepEqual(
    unresolvedLinkTargets(["weekly/2026-W37"], {
      ...options,
      today: SUNDAY_W37,
    }),
    [],
  );
  assert.deepEqual(
    unresolvedLinkTargets(["weekly/2026-W37"], {
      ...options,
      today: Date.UTC(2026, 8, 15), // день создания (14-е) прошёл
    }),
    ["weekly/2026-W37"],
  );
  assert.deepEqual(
    unresolvedLinkTargets(["weekly/2026-W38"], {
      ...options,
      today: SUNDAY_W37,
    }),
    ["weekly/2026-W38"],
    "чужая неделя родителем не считается",
  );
});

// Запись и ночной граф читают один индекс: ссылка, принятая на записи, в графе не битая, а
// отклонённая — битая. Каждая строка — свой класс входа; до общего индекса шесть из них
// расходились (суффикс пути, двойник stem, регистр, `vault/`, медиа, родитель роллапа).
test("ночной граф и запись выносят ссылке один вердикт", (t) => {
  const vault = mkdtempSync(join(tmpdir(), "iva-links-graph-"));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  const put = (rel: string, text: string) => {
    mkdirSync(join(vault, rel, ".."), { recursive: true });
    writeFileSync(join(vault, rel), text);
  };
  put("a/projects/foo.md", "# Foo Project\n");
  put("x/dup.md", "# Dup one\n");
  put("y/dup.md", "# Dup two\n");
  put("Notes/Case.md", "# Case note\n");
  put("attachments/pic.png", "png");
  put("attachments/doc.docx", "docx");
  const accepted = [
    "projects/foo",
    "Case",
    "vault/Notes/Case",
    "Notes/Case.md",
    "pic.png",
    "attachments/pic.png",
    "attachments/doc.docx",
    "Foo Project",
    "foo project",
    "weekly/2026-W46",
  ];
  const rejected = ["dup", "case", "missing"];
  const source = "summaries/daily/2026-11-10";
  const today = Date.UTC(2026, 10, 10);
  put(
    `${source}.md`,
    `# Day\n\n${[...accepted, ...rejected].map((link) => `[[${link}]]`).join("\n")}\n`,
  );

  assert.deepEqual(
    unresolvedLinkTargets([...accepted, ...rejected], {
      vaultDir: vault,
      source,
      today,
    }),
    rejected,
  );
  const graph = buildVaultGraph(vault, today);
  assert.deepEqual(
    graph.broken,
    rejected.map((target) => ({ source, target })),
  );
  assert.deepEqual(graph.nodes[source].outgoing, [
    "a/projects/foo",
    "Notes/Case",
  ]);
  assert.deepEqual(graph.nodes["Notes/Case"].incoming, [source]);
});

// ─── write_card: битые ссылки — отказ, поиск Card по имени ──────────────────

test("write_card: ссылка в факте в никуда отказывает до записи", async () => {
  const file = join(VAULT, "cards/notes/печать.md");
  const before = readFileSync(file, "utf8");
  const result = await callCard({
    operation: "fact",
    type: "note",
    title: "Печать",
    text: "Обсудили [[romashka]] и [[несуществующая-карточка]]",
    tags: [],
    aliases: [],
  });
  assert.equal(result.ok, false, result.error);
  assert.match(result.error ?? "", /Ссылки ведут в никуда/u);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("write_card: старая битая ссылка в Card не мешает новому факту", async () => {
  writeFileSync(
    join(VAULT, "cards/notes/старая.md"),
    "---\ntype: note\n---\n# Старая\n\n[[нигде]]\n\n## Log\n",
  );
  const result = await callCard({
    operation: "fact",
    type: "note",
    title: "Старая",
    text: "Новый факт",
    tags: [],
    aliases: [],
  });
  assert.equal(result.ok, true, result.error);
  const text = readFileSync(join(VAULT, "cards/notes/старая.md"), "utf8");
  assert.match(text, /Новый факт/u);
  assert.match(text, /\[\[нигде\]\]/u, "старая ссылка владельца цела");
  assert.equal(text.match(/^- \d{4}-\d{2}-\d{2}: /gmu)?.length, 1);
});

test("write_card: имя двух Card — отказ со списком, ни одна не тронута", async () => {
  const result = await callCard({
    operation: "fact",
    type: "note",
    title: "двойник",
    text: "факт",
    tags: [],
    aliases: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /cards\/notes\/двойник/u);
  assert.match(result.error, /cards\/projects\/двойник/u);
});

test("write_card: truth не создаёт Card", async () => {
  const result = await callCard({
    operation: "truth",
    type: "note",
    title: "Нет такой",
    text: "правда",
    description: "правда",
    reason: "проверка",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /не найдена/u);
  assert.equal(existsSync(join(VAULT, "cards/notes/нет-такой.md")), false);
});

// ─── write_file ────────────────────────────────────────────────────────────

test("write_file: markdown в library/ с битой ссылкой отказывает", async () => {
  const file = join(VAULT, "library", "книга", "01.md");
  const result = await callFile(file, "Глава со ссылкой [[никуда]]\n");
  assert.equal(result.ok, false, result.error);
  assert.match(result.error ?? "", /Ссылки ведут в никуда/u);
  assert.equal(existsSync(file), false);
});

test("write_file: weekly/ закрыт — выжимки пишет ночь", async () => {
  const file = join(VAULT, "weekly", "2026-W39.md");
  const result = await callFile(file, "# неделя\n");
  assert.equal(result.ok, false);
  assert.equal(existsSync(file), false);
  assert.match(result.error, /память/u);
});

test("write_file: summaries/ закрыт", async () => {
  const file = join(VAULT, "summaries", "daily", "2026-09-26.md");
  assert.equal((await callFile(file, "# день\n")).ok, false);
  assert.equal(existsSync(file), false);
});

test("write_file: файл вне вольта не проверяется", async () => {
  const outside = join(tempDir("iva-links-out-"), "note.md");
  const result = await callFile(outside, "ссылка [[никуда-не-ведёт]]\n");
  assert.equal(result.ok, true, result.error);
  assert.equal(existsSync(outside), true);
});

test("write_file: не-markdown внутри вольта не проверяется", async () => {
  const path = join(VAULT, "notes.txt");
  const result = await callFile(path, "ссылка [[никуда-не-ведёт]]\n");
  assert.equal(result.ok, true, result.error);
});
