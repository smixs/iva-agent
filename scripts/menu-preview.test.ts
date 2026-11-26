/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type PreviewButton = {
  text: string;
  callback_data?: string;
};

type PreviewCard = {
  classicText: string;
  classicRows: PreviewButton[][];
  richHtml?: string;
};

type PreviewData = {
  screens: {
    ru: Record<string, PreviewCard>;
    en: Record<string, PreviewCard>;
  };
};

function buildPreview(): PreviewData {
  const out = mkdtempSync(join(tmpdir(), "iva-menu-preview-test-"));
  try {
    execFileSync(process.execPath, ["scripts/menu-preview.ts", "--out", out], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    const html = readFileSync(join(out, "preview.html"), "utf8");
    const match =
      /<script id="menu-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
        html,
      );
    assert.ok(match, "embedded menu-data JSON");
    return JSON.parse(match[1]) as PreviewData;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const preview = buildPreview();

test("model and thinking preview cards are real wizard screens, not hand-written handoffs", () => {
  const model = preview.screens.ru.mdl;
  assert.match(model.classicText, /Провайдер — Модель — Размышления/u);
  assert.match(model.classicText, /claude — claude-fable-5-2 — medium/u);
  assert.doesNotMatch(model.classicText, /Передаёт управление визарду/u);
  assert.deepEqual(
    model.classicRows.flat().map((button) => button.callback_data),
    ["iva_model:helper", "iva_model:chg", "iva_model:keep"],
  );

  const thinking = preview.screens.ru.thk;
  assert.match(
    thinking.classicText,
    /Уровень размышлений для claude-fable-5-2: medium/u,
  );
  assert.deepEqual(
    thinking.classicRows.flat().map((button) => button.callback_data),
    [
      "iva_think:eff:low",
      "iva_think:eff:medium",
      "iva_think:eff:high",
      "iva_think:eff:xhigh",
      "iva_think:eff:max",
      "iva_think:eff:unset",
      "iva_think:keep",
    ],
  );
  assert.doesNotMatch(thinking.classicText, /Передаёт управление визарду/u);
});

test("rich preview rendering keeps every button as a button in every screen", () => {
  for (const [id, card] of Object.entries(preview.screens.ru)) {
    assert.equal(typeof card.richHtml, "string", `${id} richHtml`);
    const richHtml = card.richHtml ?? "";
    assert.equal(
      richHtml.includes("<tg-button"),
      false,
      `${id} leaves button markup as visible text`,
    );
    const richCount = (richHtml.match(/class="tg-btn/g) ?? []).length;
    const classicCount = card.classicRows.flat().length;
    assert.equal(
      richCount,
      classicCount,
      `${id}: rich buttons ${richCount}, classic buttons ${classicCount}`,
    );
  }
});
