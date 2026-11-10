/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Один обход vault на поиск, индекс ссылок, эмбеддинги и чистку: список пропуска один,
// порядок один. Запуск: node --test scripts/vault-walk.test.ts
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
import { vaultMarkdownFiles } from "../packages/vault-walk/index.ts";
import { vaultLinks } from "../agent/lib/vault-links.ts";

function vault(t: TestContext, files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "iva-vault-walk-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const rel of files) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), "# card\n");
  }
  return root;
}

const seen = (root: string, from = root): string[] =>
  vaultMarkdownFiles(from).map((file) => relative(root, file));

test("служебные каталоги пропущены на любой глубине, остальное — по алфавиту", (t) => {
  const root = vault(t, [
    "cards/b.md",
    "cards/a.md",
    "cards/notes/deep/c.md",
    "cards/notes.txt",
    "cards/archive/old.md",
    "cards/attachments/scan.md",
    "cards/notes/.obsidian/plugin.md",
    ".git/HEAD.md",
    ".graph/x.md",
    ".claude/x.md",
    ".trash/x.md",
    "backup/x.md",
    "__pycache__/x.md",
    "node_modules/pkg/readme.md",
    "MOC.md",
  ]);
  assert.deepEqual(seen(root), [
    "MOC.md",
    "cards/a.md",
    "cards/b.md",
    "cards/notes/deep/c.md",
    "node_modules/pkg/readme.md",
  ]);
});

test("каталог, с которого начат обход, под список пропуска не попадает", (t) => {
  const root = vault(t, ["archive/2025/old.md", "archive/backup/older.md"]);
  assert.deepEqual(seen(root, join(root, "archive")), ["archive/2025/old.md"]);
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
        vaultMarkdownFiles(root, (dir) =>
          reported.push(relative(root, dir)),
        ).map((file) => relative(root, file)),
        ["cards/a.md"],
      );
      assert.deepEqual(reported, ["cards/locked"]);
      assert.throws(
        () =>
          vaultMarkdownFiles(root, (_dir, error) => {
            throw error;
          }),
        { code: "EACCES" },
      );
    } finally {
      chmodSync(locked, 0o700);
    }
  },
);

test("индекс ссылок видит ровно те карточки, что и обход", (t) => {
  const root = vault(t, [
    "cards/a.md",
    "cards/archive/old.md",
    "attachments/scan.md",
    "weekly/2026-W46.md",
  ]);
  assert.deepEqual(
    vaultLinks(root).cards,
    seen(root).map((rel) => rel.slice(0, -3)),
  );
});
