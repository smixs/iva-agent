/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Регрессии на находки независимого ревью: SUPERSEDE через
// replace_body, ownership-токен card-лока, symlink-обход write_file, права карантина,
// лок в несуществующем каталоге (свежая установка).
import "./lib/ts-esm-hooks.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "eve/tools";
import { quarantineDir } from "./lib/wf-store.ts";
import { settled } from "./fixtures/tool-result.ts";

// TS — только динамическим импортом: resolve-хук (.js→.ts) не действует на статические
// импорты, слинкованные до его регистрации.
const { acquireLock: cardLock, mergeCard } =
  await import("../agent/lib/card-store.ts");
const { acquireLock: jsonLock, releaseLock: jsonRelease } =
  await import("../agent/lib/json-store.ts");

function testToolContext(toolName: string): ToolContext {
  const unavailable = (): never => {
    throw new Error("not used by this test");
  };
  return {
    abortSignal: new AbortController().signal,
    callId: "review-fixes",
    toolName,
    session: {
      id: "review-fixes",
      auth: { current: null, initiator: null },
      turn: { id: "review-fixes", sequence: 0 },
    },
    getSandbox: () => Promise.reject(new Error("not used by this test")),
    getSkill: unavailable,
    getToken: () => Promise.reject(new Error("not used by this test")),
    requireAuth: unavailable,
  };
}

test("replace_body: SUPERSEDE переписывает body, сохраняя неизвестный frontmatter", () => {
  const existing =
    "---\ntype: contact\nstatus: active\ntier: cold\ncreated: 2026-01-01\n---\n# Иван\n\nCurrent owner: Alice\n";
  const r = mergeCard({
    existing,
    title: "Иван",
    fields: { type: "contact", status: "active" },
    body: "Current owner: Bob\n\n## History\n- 2026-01→07: Alice",
    date: "2026-07-27",
    replaceBody: true,
  });
  assert.equal(r.action, "replaced");
  assert.doesNotMatch(
    r.content.split("## History")[0],
    /Alice/,
    "старая истина не должна остаться текущей",
  );
  assert.match(r.content, /Current owner: Bob/);
  assert.match(
    r.content,
    /tier: cold/,
    "неизвестные поля frontmatter выживают",
  );
  assert.match(r.content, /created: 2026-01-01/, "created не трогается");
});

test("card-лок: запоздавший release вытесненного держателя не снимает лок преемника", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cardlock-"));
  const file = join(dir, "x.md");
  const staleRelease = await cardLock(file);
  // Имитация staleness-отбора: лок «протух», преемник его отобрал и держит свой.
  const past = new Date(Date.now() - 60_000);
  utimesSync(`${file}.lock`, past, past);
  const successorRelease = await cardLock(file); // отобрал протухший, записал СВОЙ токен
  staleRelease(); // no-op: на диске чужой токен
  assert.ok(existsSync(`${file}.lock`), "лок преемника обязан остаться");
  successorRelease();
  assert.ok(!existsSync(`${file}.lock`));
});

test("json-лок работает в ещё не созданном каталоге данных (свежая установка)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fresh-"));
  const lock = join(dir, "data", "tasks.json.lock"); // data/ не существует
  const token = await jsonLock(lock);
  assert.ok(existsSync(lock));
  jsonRelease(lock, token);
});

test("карантин закрывает права старого world-readable стора", () => {
  const root = mkdtempSync(join(tmpdir(), "wfq-"));
  const dir = join(root, ".workflow-data");
  mkdirSync(dir);
  chmodSync(dir, 0o755); // стор из эпохи до UMask-фикса
  const dest = quarantineDir(dir, "2026-01-01");
  assert.ok(dest);
  assert.equal(
    statSync(dest).mode & 0o777,
    0o700,
    "карантин не должен остаться world-readable",
  );
});

test("write_file: симлинк-алиас на cards/ не обходит гард перезаписи", async () => {
  const vault = mkdtempSync(join(tmpdir(), "vault-"));
  const cards = join(vault, "cards", "contacts");
  mkdirSync(cards, { recursive: true });
  writeFileSync(join(cards, "ivan.md"), "ORIGINAL CARD");
  symlinkSync(join(vault, "cards"), join(vault, "card-alias"));
  process.env.ASSISTANT_VAULT_DIR = vault;
  const { default: writeFile } = await import("../agent/tools/write_file.ts");
  const res = settled(
    await writeFile.execute(
      {
        path: join(vault, "card-alias", "contacts", "ivan.md"),
        content: "OVERWRITTEN",
      },
      testToolContext("write_file"),
    ),
  );
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(
    readFileSync(join(cards, "ivan.md"), "utf8"),
    "ORIGINAL CARD",
    "карточка не должна быть затёрта",
  );
});
