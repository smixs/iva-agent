/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Гвард «существующую карточку не перезаписывать» (agent/tools/write_file.ts) решает по
// РЕАЛЬНЫМ путям. Пока любая осечка резолва читалась как «не карточка», гвард открывался
// наружу и молчал: карточка со всеми полями и старым текстом уходила целиком, а модель
// получала ok:true. Здесь проверяется именно направление отказа — «не знаю, где вольт»
// обязано быть отказом, а не разрешением.

import "./lib/ts-esm-hooks.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "eve/tools";
import { settled } from "./fixtures/tool-result.ts";
import { tempDir } from "./fixtures/temp-dir.ts";

const { default: writeFile } = await import("../agent/tools/write_file.ts");

function toolContext(): ToolContext {
  const unavailable = (): never => {
    throw new Error("not used by this test");
  };
  return {
    abortSignal: new AbortController().signal,
    callId: "write-file-card-guard",
    toolName: "write_file",
    session: {
      id: "write-file-card-guard",
      auth: { current: null, initiator: null },
      turn: { id: "write-file-card-guard", sequence: 0 },
    },
    getSandbox: () => Promise.reject(new Error("not used by this test")),
    getSkill: unavailable,
    getToken: () => Promise.reject(new Error("not used by this test")),
    requireAuth: unavailable,
  };
}

const CARD_BODY = "---\nname: Botir\ntier: 1\n---\n\nдва года переписки\n";

function scaffoldVault({ withCards = true } = {}): {
  vault: string;
  card: string;
} {
  const vault = tempDir("iva-card-guard-vault-");
  if (withCards) mkdirSync(join(vault, "cards"), { recursive: true });
  const card = join(withCards ? join(vault, "cards") : vault, "botir.md");
  writeFileSync(card, CARD_BODY, "utf8");
  return { vault, card };
}

/** Запоминает журнал за время вызова: молчаливый отказ — такой же дефект, как разрешение. */
async function withCapturedJournal<T>(
  run: () => Promise<T>,
): Promise<{ value: T; journal: string[] }> {
  const journal: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => {
    journal.push(args.map(String).join(" "));
  };
  try {
    return { value: await run(), journal };
  } finally {
    console.error = real;
  }
}

function useCwd(dir: string): () => void {
  const previous = process.cwd();
  process.chdir(dir);
  return () => process.chdir(previous);
}

test("вольт не резолвится (относительный путь по умолчанию + чужой cwd): отказ, карточка цела, причина в журнале", async (t) => {
  const { card } = scaffoldVault();
  const vaultDir = process.env.ASSISTANT_VAULT_DIR;
  delete process.env.ASSISTANT_VAULT_DIR;
  const restoreCwd = useCwd(tempDir("iva-card-guard-cwd-"));
  t.after(() => {
    restoreCwd();
    if (vaultDir === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = vaultDir;
  });

  const { value, journal } = await withCapturedJournal(async () =>
    settled(
      await writeFile.execute(
        { path: card, content: "затёрто" },
        toolContext(),
      ),
    ),
  );
  const res = value;

  assert.equal(
    res.ok,
    false,
    "гвард, который не смог проверить, обязан отказать",
  );
  assert.equal(readFileSync(card, "utf8"), CARD_BODY, "файл не тронут");
  assert.ok(
    journal.some((line) => line.includes("vault")),
    "отказ обязан оставить причину в журнале, а не молчать",
  );
});

test("вольт не резолвится: причина попадает в ответ модели, а не только в журнал", async (t) => {
  const { card } = scaffoldVault();
  const vaultDir = process.env.ASSISTANT_VAULT_DIR;
  delete process.env.ASSISTANT_VAULT_DIR;
  const restoreCwd = useCwd(tempDir("iva-card-guard-cwd-"));
  t.after(() => {
    restoreCwd();
    if (vaultDir === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = vaultDir;
  });

  const res = settled(
    await writeFile.execute({ path: card, content: "затёрто" }, toolContext()),
  );
  if (typeof res.error !== "string") assert.fail("ожидался текст ошибки");
  assert.match(res.error, /не могу проверить/);
});

// Вольт на месте, а cards/ внутри него посмотреть нельзя. Именно здесь «нет» и
// «не смог посмотреть» расходятся: первое разрешает запись, второе обязано её запретить.
test("cards/ нечитаем (петля симлинков) при живом вольте: отказ, а не тихое разрешение", async (t) => {
  const { card } = scaffoldVault();
  const vault = tempDir("iva-card-guard-loop-");
  const loop = join(vault, "cards");
  symlinkSync(loop, loop);
  const vaultDir = process.env.ASSISTANT_VAULT_DIR;
  process.env.ASSISTANT_VAULT_DIR = vault;
  t.after(() => {
    if (vaultDir === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = vaultDir;
  });

  const res = settled(
    await writeFile.execute({ path: card, content: "затёрто" }, toolContext()),
  );
  assert.equal(res.ok, false);
  assert.equal(readFileSync(card, "utf8"), CARD_BODY, "файл не тронут");
});

test("вольт есть, cards/ ещё нет: защищать нечего, запись проходит как раньше", async (t) => {
  const { vault, card } = scaffoldVault({ withCards: false });
  const vaultDir = process.env.ASSISTANT_VAULT_DIR;
  process.env.ASSISTANT_VAULT_DIR = vault;
  t.after(() => {
    if (vaultDir === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = vaultDir;
  });

  const res = settled(
    await writeFile.execute({ path: card, content: "новое" }, toolContext()),
  );
  assert.equal(
    res.ok,
    true,
    "отсутствие cards/ не повод перестать писать файлы",
  );
  assert.equal(readFileSync(card, "utf8"), "новое");
});
