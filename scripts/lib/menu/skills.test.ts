/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import skills from "./skills.ts";
import { tempDir } from "../../fixtures/temp-dir.ts";

function makeRoot() {
  return tempDir("iva-menu-skills-");
}

function writeSummary(root: string, value: string) {
  const summaryDir = join(root, ".eve");
  mkdirSync(summaryDir, { recursive: true });
  writeFileSync(join(summaryDir, "agent-summary.json"), value);
}

function makeCtx(root: string, lang = "en") {
  return {
    deps: { root },
    tr: (en: string, ru: string) => (lang === "ru" ? ru : en),
  };
}

// Кнопка — тег в markdown: подпись и data достаём из строки.
const buttonsOf = (text: string): Array<[string, string]> =>
  [
    ...text.matchAll(
      /<tg-button[^>]*data="([^"]+)"[^>]*>([^<]*)<\/tg-button>/g,
    ),
  ].map((match) => [match[2], match[1]] as [string, string]);

function skillList(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    name: `skill-${index + 1}`,
    description: `description-${index + 1}`,
  }));
}

test("skills reports an unavailable summary for missing and corrupt files", () => {
  for (const fixture of ["missing", "corrupt"]) {
    const root = makeRoot();
    if (fixture === "corrupt") writeSummary(root, "{not-json");

    const view = skills.render({ page: 0 }, makeCtx(root));

    assert.match(view.text, /Skill list is unavailable/);
    assert.match(view.text, /agent-summary\.json not found/);
    assert.deepEqual(buttonsOf(view.text), [["‹ Menu", "iva_menu:r:o"]]);
  }
});

test("skills distinguishes an empty registered list from an unavailable summary", () => {
  const root = makeRoot();
  writeSummary(root, JSON.stringify({ skills: [] }));

  const view = skills.render({ page: 0 }, makeCtx(root, "ru"));

  assert.match(view.text, /^# 🧩 Скиллы$/m);
  assert.match(view.text, /Скиллов не зарегистрировано\./);
  assert.deepEqual(buttonsOf(view.text), [["‹ Меню", "iva_menu:r:o"]]);
});

test("skills adds paging only after eight entries and keeps paging callbacks bounded", () => {
  const eightRoot = makeRoot();
  writeSummary(eightRoot, JSON.stringify({ skills: skillList(8) }));
  const eight = skills.render({ page: 0 }, makeCtx(eightRoot));

  assert.match(eight.text, /^# 🧩 Skills \(8\)$/m);
  assert.equal(eight.text.match(/^• /gm)?.length, 8);
  assert.deepEqual(buttonsOf(eight.text), [["‹ Menu", "iva_menu:r:o"]]);

  const nineRoot = makeRoot();
  writeSummary(nineRoot, JSON.stringify({ skills: skillList(9) }));
  const first = skills.render({ page: 0 }, makeCtx(nineRoot));
  const second = skills.render({ page: 1 }, makeCtx(nineRoot));

  assert.equal(first.text.match(/^• /gm)?.length, 8);
  assert.equal(second.text.match(/^• /gm)?.length, 1);
  assert.match(second.text, /• skill-9 — description-9$/m);
  assert.deepEqual(buttonsOf(first.text), [
    ["‹", "iva_menu:sk:pg:0"],
    ["1/2", "iva_menu:sk:pg:0"],
    ["›", "iva_menu:sk:pg:1"],
    ["‹ Menu", "iva_menu:r:o"],
  ]);
  assert.deepEqual(buttonsOf(second.text), [
    ["‹", "iva_menu:sk:pg:0"],
    ["2/2", "iva_menu:sk:pg:1"],
    ["›", "iva_menu:sk:pg:1"],
    ["‹ Menu", "iva_menu:r:o"],
  ]);
});

test("skills normalizes whitespace, truncates descriptions, and tolerates missing fields", () => {
  const root = makeRoot();
  const normalized = `alpha beta ${"x".repeat(80)}`;
  writeSummary(
    root,
    JSON.stringify({
      skills: [
        { name: "demo", description: `  alpha\n\t beta   ${"x".repeat(80)}  ` },
        {},
      ],
    }),
  );

  const view = skills.render({ page: 0 }, makeCtx(root));

  assert.match(view.text, new RegExp(`• demo — ${normalized.slice(0, 60)}\\n`));
  assert.match(view.text, /\n• \?$/m);
  assert.ok(!view.text.includes(normalized.slice(0, 61)));
});

test("skills clamps the requested page and writes the effective page to state", () => {
  const root = makeRoot();
  writeSummary(root, JSON.stringify({ skills: skillList(9) }));

  const below = { page: -7 };
  const above = { page: 99 };
  const belowView = skills.render(below, makeCtx(root));
  const aboveView = skills.render(above, makeCtx(root));

  assert.equal(below.page, 0);
  assert.equal(above.page, 1);
  assert.match(belowView.text, /• skill-1 — description-1/);
  assert.match(aboveView.text, /• skill-9 — description-9$/m);
  const pageButton = (text: string) =>
    buttonsOf(text).find(([label]) => label.includes("/"));
  assert.deepEqual(pageButton(belowView.text), ["1/2", "iva_menu:sk:pg:0"]);
  assert.deepEqual(pageButton(aboveView.text), ["2/2", "iva_menu:sk:pg:1"]);
});
