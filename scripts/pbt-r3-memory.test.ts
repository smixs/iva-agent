// Хаос-прогон memory_search: мусорные запросы к FTS, спецсимволы, гигантские запросы.
// Найдено 2026-09-13 маршрутом pbt/deepseek-4-3 (раунд 3).
//
// КРАСНЫЙ тест здесь - находка; продакшн-код не менялся, починка описана в отчёте
// `.scratch/work/reviews/pbt-deepseek-4-3-2026-09-12.md`. Вход у находки детерминированный
// (размер запроса), поэтому seed не нужен: повтор даёт тот же запрос.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Хук резолвинга идёт первым: тул тянет соседей NodeNext-спецификаторами.
import "./lib/ts-esm-hooks.ts";
import { tempDir } from "./fixtures/temp-dir.ts";

// Vault — подкаталог: файл «вне вольта» ложится рядом с ним, а не в общий tmp.
const vault = join(tempDir("pbt-r3-memory-"), "vault");
process.env.ASSISTANT_VAULT_DIR = vault;
mkdirSync(join(vault, "cards"), { recursive: true });
for (let index = 0; index < 40; index++) {
  const body = Array.from(
    { length: 30 },
    (_, line) => `word${index}_${line} lorem ipsum dolor sit amet consectetur`,
  ).join("\n");
  writeFileSync(
    join(vault, "cards", `card${index}.md`),
    `---\nname: Card ${index}\ndescription: тестовая карточка\n---\n\n${body}\n`,
  );
}
// Файл вне вольта: обход не должен его читать даже при мусорном scope.
writeFileSync(join(vault, "..", "pbt-r3-secret.md"), "секрет вне вольта\n");

const { default: memoryTool } = await import("../agent/tools/memory_search.ts");

type Answer = {
  count?: number;
  engine?: string;
  note?: string;
  hits?: Array<{ file: string; score: number; snippet: string }>;
};

const search = async (input: {
  query: string;
  limit?: number;
  scope?: string[];
}): Promise<Answer> => (await memoryTool.execute(input, {} as never)) as Answer;

// Прогрев: индекс FTS собирается один раз на набор файлов, в замер он входить не должен.
await search({ query: "word0" });

// НАХОДКА R3-5. У запроса нет потолка: contentTokens режет текст на все уникальные
// слова, дальше каждый токен проходит по всем карточкам (naiveSearch, IDF, coverage).
// Сто тысяч уникальных токенов - это ~16 секунд работы в одном вызове инструмента:
// ход упирается в свой дедлайн и пользователь не получает ответа. Достаточно было
// 20 тысяч (4,3 с), а предела у zod-схемы нет.
await test("НАХОДКА R3-5: гигантский запрос не вешает поиск по памяти", async () => {
  const query = Array.from({ length: 100_000 }, (_, index) => `t${index}`).join(
    " ",
  );
  const started = performance.now();
  const answer = await search({ query });
  const elapsed = performance.now() - started;
  assert.ok(
    elapsed < 3_000,
    `поиск занял ${Math.round(elapsed)} мс на запросе в ${query.length} знаков`,
  );
  assert.equal(answer.count, 0);
  assert.match(answer.note ?? "", /слишком длинный/u, JSON.stringify(answer));
});

// Потолок не должен резать живые запросы: 60 уникальных слов проходят как раньше.
await test("зелёное: длинный, но живой запрос ищется, а не отбивается", async () => {
  const query = Array.from(
    { length: 60 },
    (_, index) => `word${index % 40}`,
  ).join(" ");
  const answer = await search({ query });
  assert.equal(typeof answer.count, "number");
  assert.equal(answer.note, undefined, JSON.stringify(answer));
});

// Зелёные controls: спецсимволы не инжектятся в FTS, гигантский один токен дешёв,
// мусорный scope не выходит за вольт, обычный запрос находит карточку.
await test("зелёное: спецсимволы запроса не ломают FTS и не инжектятся", async () => {
  for (const query of [
    '" OR 1=1 -- NEAR( a*',
    '(((("*',
    "word0 OR word1 NOT word2",
    "word0*",
  ]) {
    const answer = await search({ query });
    assert.ok(
      typeof answer.count === "number",
      `${query} -> ${JSON.stringify(answer)}`,
    );
  }
});

await test("зелёное: гигантское слово отбивается отказом, а не перебором", async () => {
  const started = performance.now();
  const answer = await search({ query: "a".repeat(1_000_000) });
  const elapsed = performance.now() - started;
  assert.equal(answer.count, 0);
  assert.match(answer.note ?? "", /слишком длинный/u, JSON.stringify(answer));
  assert.ok(elapsed < 5_000, `${Math.round(elapsed)} мс на одном слове`);
});

await test("зелёное: мусорный scope не читает файлы вне вольта", async () => {
  for (const scope of [[".."], ["../.."], ["/etc"], ["cards/../.."]]) {
    const answer = await search({ query: "секрет", scope });
    assert.equal(
      answer.hits?.some((hit) => hit.file.includes("secret")) ?? false,
      false,
      `${JSON.stringify(scope)} -> ${JSON.stringify(answer.hits)}`,
    );
  }
});

await test("зелёное: обычный запрос находит карточку и отдаёт короткий сниппет", async () => {
  const answer = await search({ query: "word7_3" });
  assert.ok((answer.count ?? 0) > 0);
  const top = answer.hits?.[0];
  assert.ok(top);
  assert.match(top.file, /cards\/card7\.md/u);
  assert.ok(top.snippet.length <= 240);
});
