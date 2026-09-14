import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { childLinkRule, childSummaries } from "./rollup-children.ts";

// Список дочерних сводок решает исход ссылки вниз: сводки нет — ссылка ведёт в никуда,
// и её уже никто не резолвит. Здесь держится именно эта граница: перечисляем только то,
// что лежит на диске, а пустой период говорит об этом прямо.
function vaultWith(paths: readonly string[]): string {
  const vault = mkdtempSync(join(tmpdir(), "iva-rollup-children-"));
  for (const path of paths) {
    const file = join(vault, `${path}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "# summary\n", "utf8");
  }
  return vault;
}

void test("weekly lists the daily-summaries that exist, in calendar order", (t) => {
  const vault = vaultWith([
    "summaries/daily/2026-09-07",
    "summaries/daily/2026-09-10",
    "summaries/daily/2026-09-13",
    "summaries/daily/2026-09-14", // за границей недели: следующий понедельник
  ]);
  t.after(() => rmSync(vault, { recursive: true, force: true }));

  assert.deepEqual(childSummaries("weekly", "2026-09-13", vault), [
    "summaries/daily/2026-09-07",
    "summaries/daily/2026-09-10",
    "summaries/daily/2026-09-13",
  ]);
  assert.equal(
    childLinkRule("weekly", "2026-09-13", vault),
    "Link exactly these files: [[summaries/daily/2026-09-07]], " +
      "[[summaries/daily/2026-09-10]], [[summaries/daily/2026-09-13]]. " +
      "A day whose daily-summary is missing is named in plain text, never as a link. ",
  );
});

void test("a week without a single daily-summary says so instead of listing", (t) => {
  const vault = vaultWith([]);
  t.after(() => rmSync(vault, { recursive: true, force: true }));

  assert.deepEqual(childSummaries("weekly", "2026-09-13", vault), []);
  assert.equal(
    childLinkRule("weekly", "2026-09-13", vault),
    "No daily-summary of those days exists: name the days in plain text " +
      "and link none of them. ",
  );
});

void test("monthly takes the weeks whose Thursday falls in the month", (t) => {
  // 2026-W36 (Thu 2026-09-03) и 2026-W40 (Thu 2026-10-01) обрамляют сентябрь:
  // первая принадлежит ему, вторая — уже октябрю, хотя и начинается в сентябре.
  const vault = vaultWith([
    "weekly/2026-W36",
    "weekly/2026-W37",
    "weekly/2026-W40",
  ]);
  t.after(() => rmSync(vault, { recursive: true, force: true }));

  assert.deepEqual(childSummaries("monthly", "2026-09", vault), [
    "weekly/2026-W36",
    "weekly/2026-W37",
  ]);
});

void test("yearly lists the monthly-summaries of the year and nothing else", (t) => {
  const vault = vaultWith([
    "monthly/2026-07",
    "monthly/2026-08",
    "monthly/2025-12",
  ]);
  t.after(() => rmSync(vault, { recursive: true, force: true }));

  assert.deepEqual(childSummaries("yearly", "2026", vault), [
    "monthly/2026-07",
    "monthly/2026-08",
  ]);
  assert.match(
    childLinkRule("yearly", "2026", vault),
    /Link exactly these files: \[\[monthly\/2026-07\]\], \[\[monthly\/2026-08\]\]\./,
  );
});
