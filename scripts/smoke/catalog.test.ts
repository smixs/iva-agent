import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

void test("smoke scenario ids match the testing table in both directions", async (t) => {
  const docs = await readFile(
    new URL("../../docs/testing.md", import.meta.url),
    "utf8",
  );
  const documented = [...docs.matchAll(/^\|\s*([SP]-[\w-]+)\s*\|/gmu)].map(
    (m) => m[1],
  );
  const implemented: string[] = [];
  let todos = 0;
  for (const name of await readdir(new URL("./", import.meta.url))) {
    if (!name.endsWith(".smoke.ts")) continue;
    const source = await readFile(new URL(name, import.meta.url), "utf8");
    for (const match of source.matchAll(
      /\btest(\.todo)?\(\s*["']([SP]-[\w-]+):/gu,
    )) {
      implemented.push(match[2]);
      if (match[1]) todos++;
    }
  }
  assert.equal(
    new Set(documented).size,
    documented.length,
    "duplicate table id",
  );
  assert.equal(
    new Set(implemented).size,
    implemented.length,
    "duplicate test id",
  );
  assert.equal(documented.length, 10);
  assert.deepEqual(implemented.sort(), documented.sort());
  t.diagnostic(`smoke scenarios: ${implemented.length}; todo: ${todos}`);
});
