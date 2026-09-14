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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolContext } from "eve/tools";
import { settled } from "./fixtures/tool-result.ts";
import { unresolvedLinkTargets } from "../agent/lib/vault-links.ts";

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

// Оба тула импортируются ПОСЛЕ фикстур: write_card читает схему вольта на импорте.
const { default: writeCard } = await import("../agent/tools/write_card.ts");
const { default: writeFile } = await import("../agent/tools/write_file.ts");

type CardResult = { ok: boolean; error: string; file: string };
type FileResult = { ok: boolean; error: string; path: string };
const cardTool = writeCard as unknown as {
  execute: (input: unknown) => Promise<CardResult>;
  inputSchema: { parse: (value: unknown) => unknown };
};
const callCard = (args: unknown) =>
  cardTool.execute(cardTool.inputSchema.parse(args));

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

// ─── write_card ────────────────────────────────────────────────────────────

test("write_card: рабочие ссылки в теле и related записываются", async () => {
  const result = await callCard({
    operation: "ADD",
    type: "note",
    title: "Заметка со ссылками",
    description: "проверка живых ссылок",
    tags: ["test"],
    body: "Разговор с [[иванов-иван-иванович|Иваном]] про [[romashka]].",
    related: ["cards/notes/печать"],
  });
  assert.equal(result.ok, true, result.error);
});

test("write_card: опечатка в ссылке — отказ, карточки на диске нет", async () => {
  const result = await callCard({
    operation: "ADD",
    type: "note",
    title: "Заметка с опечаткой",
    description: "ссылка ведёт в никуда",
    tags: ["test"],
    body: "Смотри [[печaть]] и [[ivanov-ivan-ivanovich]].",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /печaть/);
  assert.match(result.error, /ivanov-ivan-ivanovich/);
  assert.equal(
    existsSync(join(VAULT, "cards", "notes", "заметка-с-опечаткой.md")),
    false,
    "отказ обязан не оставлять файла",
  );
});

test("write_card: битая связь в related — отказ", async () => {
  const result = await callCard({
    operation: "ADD",
    type: "note",
    title: "Заметка с битым related",
    description: "связь на несуществующую карточку",
    tags: ["test"],
    body: "текст без ссылок",
    related: ["cards/contacts/ооо-василёк"],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ооо-василёк/);
});

// ─── write_file ────────────────────────────────────────────────────────────

test("write_file: markdown вольта с битой ссылкой — отказ, файл не создан", async () => {
  const path = join(VAULT, "summaries", "daily", "2020-01-01.md");
  mkdirSync(join(VAULT, "summaries", "daily"), { recursive: true });
  const result = await callFile(path, "# День\n\nписал [[roma-shka]].\n");
  assert.equal(result.ok, false);
  assert.match(result.error, /roma-shka/);
  assert.equal(existsSync(path), false);
});

test("write_file: просроченный родитель роллапа — тоже битая ссылка", async () => {
  const path = join(VAULT, "summaries", "daily", "2020-01-02.md");
  const result = await callFile(path, "Итог недели: [[weekly/2020-W01]].\n");
  assert.equal(result.ok, false);
  assert.match(result.error, /weekly\/2020-W01/);
});

test("write_file: ещё не созданный weekly текущего дня записывается", async () => {
  const today = new Date();
  const stamp = today.toISOString().slice(0, 10);
  const monday = new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() - ((today.getUTCDay() + 6) % 7),
    ),
  );
  const thursday = new Date(monday.getTime() + 3 * 86_400_000);
  const week = Math.floor(
    (thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) /
      (7 * 86_400_000) +
      1,
  );
  const label = `weekly/${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  const path = join(VAULT, "summaries", "daily", `${stamp}.md`);
  const result = await callFile(path, `Родитель: [[${label}]].\n`);
  assert.equal(result.ok, true, result.error);
  assert.match(readFileSync(path, "utf8"), /Родитель/);
});

test("write_file: файл вне вольта не проверяется", async () => {
  const outside = join(
    mkdtempSync(join(tmpdir(), "iva-links-out-")),
    "note.md",
  );
  const result = await callFile(outside, "ссылка [[никуда-не-ведёт]]\n");
  assert.equal(result.ok, true, result.error);
  assert.equal(existsSync(outside), true);
});

test("write_file: не-markdown внутри вольта не проверяется", async () => {
  const path = join(VAULT, "notes.txt");
  const result = await callFile(path, "ссылка [[никуда-не-ведёт]]\n");
  assert.equal(result.ok, true, result.error);
});
