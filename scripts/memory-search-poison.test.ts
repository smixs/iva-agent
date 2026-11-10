/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Сторона пользователя для находки «одна битая карточка выключает память»
// (pbt-opus №1, независимо подтверждено Muse F6/F6b).
//
// Свойство: здоровые карточки продолжают находиться и записываться, что бы ни лежало
// в соседнем файле. До починки одна карточка, где владелец написал
// `company: 'Sayyora's Splendor'`, роняла ВЕСЬ memory_search и весь write_card:
// Ива отвечала ошибкой на любой поиск по памяти и на любую запись, пока файл не
// находили и не правили руками.
import "./lib/ts-esm-hooks.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "eve/tools";
import { settled } from "./fixtures/tool-result.ts";
import { tempDir } from "./fixtures/temp-dir.ts";

const vault = tempDir("pbt-opus-vault-");
mkdirSync(join(vault, "cards"), { recursive: true });
process.env.ASSISTANT_VAULT_DIR = vault;
process.env.ASSISTANT_DATA_DIR = tempDir("pbt-opus-data-");

const { default: memorySearch } =
  await import("../agent/tools/memory_search.ts");

function toolContext(): ToolContext {
  const unavailable = (): never => {
    throw new Error("not used by this test");
  };
  return {
    abortSignal: new AbortController().signal,
    callId: "pbt-opus",
    toolName: "memory_search",
    session: {
      id: "pbt-opus",
      auth: { current: null, initiator: null },
      turn: { id: "pbt-opus", sequence: 0 },
    },
    getSandbox: () => Promise.reject(new Error("not used by this test")),
    getSkill: unavailable,
    getToken: () => Promise.reject(new Error("not used by this test")),
    requireAuth: unavailable,
  };
}

async function hits(): Promise<number> {
  const result = settled(
    await memorySearch.execute({ query: "бюджет" }, toolContext()),
  );
  const list = (result as { hits?: unknown[] }).hits;
  return Array.isArray(list) ? list.length : 0;
}

for (let index = 0; index < 40; index++)
  writeFileSync(
    join(vault, "cards", `ok-${index}.md`),
    `---\nname: Контакт ${index}\ncompany: Majento\n---\n\nвстреча про бюджет ${index}\n`,
  );

test("здоровые карточки находятся", async () => {
  assert.ok(await hits(), "поиск по сорока здоровым карточкам что-то находит");
});

test("одна карточка с апострофом во frontmatter не отменяет поиск по остальным", async () => {
  const healthy = await hits();
  writeFileSync(
    join(vault, "cards", "sayyora.md"),
    `---\nname: Сайёра\ncompany: 'Sayyora's Splendor'\n---\n\nбюджет на квартал\n`,
  );
  const after = await hits().catch((error: unknown) => {
    assert.fail(
      `поиск по памяти упал целиком из-за одной карточки: ${String(error)}`,
    );
  });
  assert.ok(
    after >= healthy,
    `было ${healthy} находок, стало ${after}: соседняя карточка не должна уменьшать выдачу`,
  );
});

// Тот же корень, вторая зона поражения: agent/lib/card-store.ts:145 разбирает
// frontmatter соседних карточек, чтобы понять, не про эту ли сущность пишут. Один
// файл с кавычкой в той же папке — и Ива больше не может записать в память ничего.
test("одна карточка с апострофом не отменяет запись новых карточек", async () => {
  const { default: writeCard } = await import("../agent/tools/write_card.ts");
  const card = (title: string) => ({
    operation: "fact" as const,
    type: "contact",
    title,
    text: "новая встреча про бюджет",
    description: "новый контакт по бюджету",
    tags: ["budget", "contact"],
    aliases: [],
  });
  const context = { ...toolContext(), toolName: "write_card" };

  const before = settled(
    await writeCard.execute(card("Первый Контакт"), context),
  );
  assert.equal(
    (before as { ok?: boolean }).ok,
    true,
    "здоровый вольт принимает запись",
  );

  mkdirSync(join(vault, "cards", "contacts"), { recursive: true });
  writeFileSync(
    join(vault, "cards", "contacts", "sayyora.md"),
    `---\nname: Сайёра\ncompany: 'Sayyora's Splendor'\n---\n\nтело\n`,
  );

  let after: unknown;
  try {
    after = await writeCard.execute(card("Второй Контакт"), context);
  } catch (error) {
    assert.fail(
      `запись в память упала целиком из-за соседней карточки: ${String(error)}`,
    );
  }
  assert.equal((settled(after) as { ok?: boolean }).ok, true);
});

// Пин Muse F6 (.scratch/work/reviews/pbt-muse-2026-09-12.md), перенесён в утверждении
// «как должно быть»: сломана frontmatter САМОЙ карточки, в которую пишут. Тул отвечает
// отказом значением и не затирает файл, а не роняет ход исключением.
test("факт в Card с битой кавычкой отвечает отказом, а не роняет ход", async () => {
  const { default: writeCard } = await import("../agent/tools/write_card.ts");
  const context = { ...toolContext(), toolName: "write_card" };
  const title = "Битая Кавычка";
  const note = (text: string) => ({
    operation: "fact" as const,
    type: "note",
    title,
    text,
    description: "заметка про кавычку",
    tags: ["note", "quote"],
    aliases: [],
  });
  const created = settled(await writeCard.execute(note("тело"), context));
  const file = (created as { file?: string }).file;
  assert.equal(typeof file, "string", "карточка создана");
  const abs = join(vault, ...`${String(file)}.md`.split("/"));
  writeFileSync(
    abs,
    readFileSync(abs, "utf8").replace('status: "active"', 'status: "oops'),
  );

  const broken = readFileSync(abs, "utf8");
  let answer: unknown;
  try {
    answer = await writeCard.execute(note("второй факт"), context);
  } catch (error) {
    assert.fail(`запись уронила ход исключением: ${String(error)}`);
  }
  assert.equal((settled(answer) as { ok?: boolean }).ok, false);
  assert.equal(readFileSync(abs, "utf8"), broken, "битая Card не затёрта");
});
