// Оценка memory_search на живом vault: hit@3 по набору запросов.
// Запуск: ASSISTANT_VAULT_DIR=<vault> node scripts/memory-search-eval.ts [набор.json]
// Набор — JSON [{ "query": "...", "expect": "cards/....md" }], по умолчанию
// scripts/fixtures/memory-eval.json. Код выхода 0 всегда: это замер, а не проверка.
import "./lib/ts-esm-hooks.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type EvalCase = { query: string; expect: string };

const DEFAULT_SET = fileURLToPath(
  new URL("./fixtures/memory-eval.json", import.meta.url),
);

function readCases(file: string): EvalCase[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as EvalCase).query === "string" &&
        typeof (item as EvalCase).expect === "string",
    )
  )
    throw new Error(`${file}: нужен массив { query, expect }`);
  return parsed as EvalCase[];
}

const cases = readCases(process.argv[2] ?? DEFAULT_SET);
const { searchMemory } = await import("../agent/tools/memory_search.ts");
let hits = 0;
for (const { query, expect } of cases) {
  const found = (await searchMemory({ query, limit: 3 })).hits.map(
    (hit) => hit.file,
  );
  const ok = found.includes(expect);
  if (ok) hits++;
  console.log(
    `${ok ? "HIT " : "MISS"} ${query} → ${expect}${ok ? "" : ` (топ-3: ${found.join(", ") || "пусто"})`}`,
  );
}
console.log(`hit@3: ${hits}/${cases.length}`);
