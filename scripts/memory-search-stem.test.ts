/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// memory_search: формы слов, ё/е, раздел History и отменённые карточки.
// Живой промах 18.10.2026: «Ильёй встреча» не находило карточку Ильи — запрос искал
// слово «ильёй» по началу, а в карточке «Илья».
import "./lib/ts-esm-hooks.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";

const VAULT = mkdtempSync(join(tmpdir(), "iva-memsearch-stem-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
process.env.ASSISTANT_GRAPH_PATH = join(VAULT, "no-graph.json");
process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

function card(path: string, front: string, body: string): void {
  const file = join(VAULT, "cards", path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\n${front}\n---\n\n${body}\n`);
}

card(
  "contacts/илья-турецкий.md",
  "type: contact\nname: Илья Турецкий\nstatus: active",
  "# Илья Турецкий\n\nПартнёр по продажам.",
);
card(
  "contacts/семён-аксёнов.md",
  "type: contact\nname: Семён Аксёнов\nstatus: active",
  "# Семён Аксёнов\n\nМенеджер доставки.",
);
card(
  "projects/alpha.md",
  "type: project\nname: Альфа\nstatus: active",
  "# Альфа\n\nСейчас пишем на Kotlin.\n\n## History\n\n- 2025: писали на Фортране\n\n## Связи\n\n- Квазарный модуль",
);
card(
  "projects/old.md",
  "type: project\nname: Зеброид\nstatus: superseded",
  "# Зеброид\n\nЗаменён Альфой.",
);
card(
  "projects/paused.md",
  "type: project\nname: Пауза\nstatus: inactive",
  "# Пауза\n\nЛамантин спит.",
);

const { searchMemory, splitHistory, stemRussian } =
  await import("../agent/tools/memory_search.ts");

const files = async (query: string, history?: boolean): Promise<string[]> =>
  (await searchMemory({ query, limit: 5, history })).hits.map((h) => h.file);

test("падежи имени находят именительный: Ильёй, Илье, Ильи, Турецкого", async () => {
  for (const query of ["Ильёй встреча", "Илье", "Ильи", "Турецкого созвон"])
    assert.equal(
      (await files(query))[0],
      "cards/contacts/илья-турецкий.md",
      query,
    );
});

test("ё и е взаимозаменяемы в запросе и в карточке", async () => {
  for (const query of ["Аксенов", "Аксёнову", "Семену"])
    assert.equal(
      (await files(query))[0],
      "cards/contacts/семён-аксёнов.md",
      query,
    );
});

test("раздел History не ищется без флага, следующий раздел ищется", async () => {
  assert.ok(!(await files("Фортран")).includes("cards/projects/alpha.md"));
  assert.ok((await files("Квазарный")).includes("cards/projects/alpha.md"));
  assert.ok((await files("Фортран", true)).includes("cards/projects/alpha.md"));
});

test("слово о прошлом в запросе само включает History", async () => {
  for (const query of ["раньше Фортран", "на чём было до Фортрана"])
    assert.ok((await files(query)).includes("cards/projects/alpha.md"), query);
  assert.ok((await files("Зеброид история")).includes("cards/projects/old.md"));
});

test("superseded скрыт из обычной выдачи и виден с history", async () => {
  assert.deepEqual(await files("Зеброид"), []);
  assert.deepEqual(await files("Зеброид", true), ["cards/projects/old.md"]);
  assert.deepEqual(await files("Ламантин"), ["cards/projects/paused.md"]);
});

test("splitHistory вырезает раздел до следующего заголовка второго уровня", () => {
  assert.deepEqual(splitHistory("а\n## History\nб\n## Next\nв"), {
    body: "а\n## Next\nв",
    history: "\nб\n",
  });
  assert.deepEqual(splitHistory("а\n### History\nб"), {
    body: "а\n### History\nб",
    history: "",
  });
});

test("стеммер: падежи сводятся к одной основе", () => {
  for (const word of ["илья", "ильей", "илье", "ильи", "илью"])
    assert.equal(stemRussian(word), "иль", word);
  assert.equal(stemRussian("турецкого"), "турецк");
  assert.equal(stemRussian("ивы"), "ив");
  assert.equal(stemRussian("turetsky"), "turetsky");
});

const SEED = Number(process.env.FC_SEED ?? 20261018);
test(`стеммер: основа — начало слова, не короче двух букв, латиница не меняется (seed ${SEED})`, () => {
  const ru = fc.stringMatching(/^[а-я]{1,14}$/);
  const other = fc.stringMatching(/^[a-z0-9а-я]{1,14}$/);
  fc.assert(
    fc.property(fc.oneof(ru, other), (word) => {
      const stem = stemRussian(word);
      assert.ok(word.startsWith(stem));
      assert.ok(stem.length >= Math.min(word.length, 2));
      if (!/^[а-я]+$/.test(word)) assert.equal(stem, word);
    }),
    { seed: SEED, numRuns: 500 },
  );
});

test("скрипт оценки печатает hit@3 по каждому запросу и итог", () => {
  const set = join(VAULT, "eval.json");
  writeFileSync(
    set,
    JSON.stringify([
      { query: "Ильёй", expect: "cards/contacts/илья-турецкий.md" },
      { query: "Зеброид", expect: "cards/projects/old.md" },
    ]),
  );
  const script = fileURLToPath(
    new URL("./memory-search-eval.ts", import.meta.url),
  );
  const run = spawnSync(process.execPath, [script, set], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^HIT {2}Ильёй/m);
  assert.match(run.stdout, /^MISS Зеброид/m);
  assert.match(run.stdout, /^hit@3: 1\/2$/m);
});
