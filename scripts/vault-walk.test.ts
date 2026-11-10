/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Один обход vault на поиск, индекс ссылок, эмбеддинги и чистку: технические каталоги
// пропускают все, каталог человека — только тот, кто его назвал.
// Запуск: node --test scripts/vault-walk.test.ts
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import {
  vaultMarkdownFiles,
  type VaultWalkOptions,
} from "../packages/vault-walk/index.ts";
import { unresolvedLinkTargets, vaultLinks } from "../agent/lib/vault-links.ts";
import { cleanupVault } from "./lib/vault-cleanup.ts";

const TECHNICAL = [
  ".git",
  ".obsidian",
  ".claude",
  ".trash",
  ".graph",
  ".index",
  ".cache",
  ".next",
  "dist",
  "node_modules",
  "__pycache__",
];
const HUMAN = ["archive", "backup", "attachments"];
// Раздутое описание: чистка считает такую карточку своей работой.
const UNIT = "Sales lead for the Q3 pipeline review";
const CARD = `---\ndescription: "${UNIT} ${UNIT} ${UNIT} ${UNIT}"\n---\n# card\n\nзелёный чайник\n`;

function vault(t: TestContext, files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "iva-vault-walk-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const rel of files) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), CARD);
  }
  return root;
}

const seen = (
  root: string,
  from = root,
  options?: VaultWalkOptions,
): string[] =>
  vaultMarkdownFiles(from, options).map((file) => relative(root, file));

test("технические каталоги пропущены на любой глубине, каталоги человека видны, порядок — по алфавиту", (t) => {
  const root = vault(t, [
    "cards/b.md",
    "cards/a.md",
    "cards/notes/deep/c.md",
    "cards/notes.txt",
    "MOC.md",
    ...HUMAN.map((dir) => `cards/${dir}/x.md`),
    ...TECHNICAL.flatMap((dir) => [`${dir}/x.md`, `cards/notes/${dir}/x.md`]),
  ]);
  assert.deepEqual(seen(root), [
    "MOC.md",
    "cards/a.md",
    "cards/archive/x.md",
    "cards/attachments/x.md",
    "cards/b.md",
    "cards/backup/x.md",
    "cards/notes/deep/c.md",
  ]);
});

test("названный каталог человека пропущен на любой глубине, остальные видны", (t) => {
  const root = vault(t, [
    "cards/a.md",
    "archive/x.md",
    "cards/archive/x.md",
    "cards/backup/x.md",
  ]);
  assert.deepEqual(seen(root, root, { skip: ["archive"] }), [
    "cards/a.md",
    "cards/backup/x.md",
  ]);
});

test("каталог, с которого начат обход, под пропуск не попадает", (t) => {
  const root = vault(t, ["dist/2025/old.md", "dist/archive/older.md"]);
  assert.deepEqual(
    seen(root, join(root, "dist"), { skip: ["dist", "archive"] }),
    ["dist/2025/old.md"],
  );
});

test("ссылка на файл и на каталог карточкой не считается", (t) => {
  const root = vault(t, ["cards/a.md", "outside/b.md"]);
  symlinkSync(join(root, "cards/a.md"), join(root, "cards/link.md"));
  symlinkSync(join(root, "outside"), join(root, "cards/dir"));
  assert.deepEqual(seen(root, join(root, "cards")), ["cards/a.md"]);
});

test(
  "нечитаемый каталог пропущен, вызывающий о нём узнаёт и может остановить обход",
  { skip: process.getuid?.() === 0 && "root читает любой каталог" },
  (t) => {
    const root = vault(t, ["cards/a.md", "cards/locked/b.md"]);
    const locked = join(root, "cards/locked");
    chmodSync(locked, 0o000);
    try {
      const reported: string[] = [];
      assert.deepEqual(
        vaultMarkdownFiles(root, {
          onUnreadable: (dir) => reported.push(relative(root, dir)),
        }).map((file) => relative(root, file)),
        ["cards/a.md"],
      );
      assert.deepEqual(reported, ["cards/locked"]);
      assert.throws(
        () =>
          vaultMarkdownFiles(root, {
            onUnreadable: (_dir, error) => {
              throw error;
            },
          }),
        { code: "EACCES" },
      );
    } finally {
      chmodSync(locked, 0o700);
    }
  },
);

// Кто что видит в одном vault. Поиск не теряет ничего, что находил до общего обходчика:
// архив, бэкап и вложения — содержимое человека. Ссылка на архивную карточку принимается.
test("поиск видит каталоги человека, индекс ссылок — кроме attachments, чистка в них не заходит", async (t) => {
  const cards = ["live", ...HUMAN.map((dir) => `${dir}/x`)];
  const technical = TECHNICAL.map((dir) => `${dir}/x`);
  const root = vault(
    t,
    [...cards, ...technical].map((card) => `cards/${card}.md`),
  );
  const env = { ...process.env };
  t.after(() => {
    process.env = env;
  });
  process.env.ASSISTANT_VAULT_DIR = root;
  process.env.ASSISTANT_GRAPH_PATH = join(root, "no-graph.json");
  delete process.env.MEMORY_SEARCH_MODE;
  const { searchMemory } = await import("../agent/tools/memory_search.ts");

  const found = await searchMemory({ query: "зелёный чайник", limit: 50 });
  assert.deepEqual(found.hits.map((hit) => hit.file).sort(), [
    "cards/archive/x.md",
    "cards/attachments/x.md",
    "cards/backup/x.md",
    "cards/live.md",
  ]);

  const links = [...cards, ...technical].map((card) => `cards/${card}`);
  assert.deepEqual(
    unresolvedLinkTargets(links, {
      vaultDir: root,
      source: "cards/new",
      today: Date.UTC(2026, 10, 10),
    }),
    ["cards/attachments/x", ...technical.map((card) => `cards/${card}`)],
  );

  assert.equal(cleanupVault(root, false).cleaned, 1);
});

test("индекс ссылок видит ровно те карточки, что и обход без attachments", (t) => {
  const root = vault(t, [
    "cards/a.md",
    "cards/archive/old.md",
    "backup/old-copy.md",
    "attachments/scan.md",
    "weekly/2026-W46.md",
  ]);
  assert.deepEqual(vaultLinks(root).cards, [
    "backup/old-copy",
    "cards/a",
    "cards/archive/old",
    "weekly/2026-W46",
  ]);
  assert.deepEqual(
    vaultLinks(root).cards,
    seen(root, root, { skip: ["attachments"] }).map((rel) => rel.slice(0, -3)),
  );
});
