/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import colleagues from "./colleagues.ts";
import { classicScreen } from "../telegram-buttons.ts";

const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-colleagues-"));
after(() => rmSync(dataDir, { recursive: true, force: true }));

const settingsPath = join(dataDir, "settings.json");

type MenuState = { page?: number };
type MenuContext = {
  deps: { dataDir: string };
  tr: (english: string, russian: string) => string;
  show: (state: MenuState, screenId: string) => Promise<void>;
};

function makeContext(lang: "en" | "ru", redrawn: string[] = []): MenuContext {
  return {
    deps: { dataDir },
    tr: (english, russian) => (lang === "ru" ? russian : english),
    show: (_state, screenId) => {
      redrawn.push(screenId);
      return Promise.resolve();
    },
  };
}

function buttonsOf(text: string): Array<[string, string]> {
  return [
    ...text.matchAll(
      /<tg-button[^>]*data="([^"]+)"[^>]*>([^<]*)<\/tg-button>/g,
    ),
  ].map((match) => [match[2], match[1]] as [string, string]);
}

test("colleagues defaults to off and points back to Connections (gcon)", () => {
  rmSync(settingsPath, { force: true });

  assert.equal(colleagues.parent, "gcon");

  const ru = colleagues.render({ page: 0 }, makeContext("ru"));
  assert.match(ru.text, /^# 🤝 Коллеги$/m);
  assert.match(ru.text, /Коллеги: выкл \(по умолчанию\)/u);
  assert.deepEqual(buttonsOf(ru.text), [
    ["○ Вкл", "iva_menu:col:set:1"],
    ["✓ Выкл", "iva_menu:col:set:0"],
    ["‹ Назад", "iva_menu:gcon:o"],
  ]);

  const en = colleagues.render({ page: 0 }, makeContext("en"));
  assert.match(en.text, /^# 🤝 Colleagues$/m);
  assert.match(en.text, /Colleagues: off \(default\)/u);
  assert.deepEqual(buttonsOf(en.text), [
    ["○ On", "iva_menu:col:set:1"],
    ["✓ Off", "iva_menu:col:set:0"],
    ["‹ Back", "iva_menu:gcon:o"],
  ]);

  // Classic rendering produces clean rows and every callback fits 64 bytes.
  const classic = classicScreen(ru.text);
  assert.deepEqual(
    classic.reply_markup?.inline_keyboard.map((row) =>
      row.map((b) => [b.text, b.callback_data]),
    ),
    [
      [
        ["○ Вкл", "iva_menu:col:set:1"],
        ["✓ Выкл", "iva_menu:col:set:0"],
      ],
      [["‹ Назад", "iva_menu:gcon:o"]],
    ],
  );
});

test("colleagues switches on and off, preserving sibling settings and configured bots", async () => {
  writeFileSync(
    settingsPath,
    JSON.stringify({
      language: "ru",
      colleagues: {
        enabled: false,
        items: {
          "7001": {
            botId: "7001",
            role: "critic",
            provider: "claude",
            model: "claude-fable-5-2",
            name: "Crit*ic",
          },
        },
      },
    }),
  );

  // Off with configured colleague mentions paused count.
  const offView = colleagues.render({ page: 0 }, makeContext("ru"));
  assert.match(offView.text, /Настроено: 1 \(на паузе, пока выключено\)/u);

  const redrawn: string[] = [];
  await colleagues.on("set", ["1"], { page: 0 }, makeContext("ru", redrawn));
  assert.deepEqual(redrawn, ["col"]);
  const afterOn = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    language: string;
    colleagues: { enabled: boolean; items: Record<string, unknown> };
  };
  assert.equal(afterOn.language, "ru");
  assert.equal(afterOn.colleagues.enabled, true);
  assert.ok(afterOn.colleagues.items["7001"]);

  // On view lists the colleague with escaped markdown chars and ticked On button.
  const onView = colleagues.render({ page: 0 }, makeContext("ru"));
  assert.match(onView.text, /Коллеги: вкл\./u);
  assert.match(
    onView.text,
    /Crit\\\*ic \(Критик\) — claude\/claude-fable-5-2/u,
  );
  assert.deepEqual(buttonsOf(onView.text), [
    ["✓ Вкл", "iva_menu:col:set:1"],
    ["○ Выкл", "iva_menu:col:set:0"],
    ["‹ Назад", "iva_menu:gcon:o"],
  ]);

  // Idempotent second tap on set:1 stays on.
  await colleagues.on("set", ["1"], { page: 0 }, makeContext("ru", redrawn));
  assert.equal(
    (
      JSON.parse(readFileSync(settingsPath, "utf8")) as {
        colleagues: { enabled: boolean };
      }
    ).colleagues.enabled,
    true,
  );

  // Turning off persists enabled: false and keeps configured colleague.
  await colleagues.on("set", ["0"], { page: 0 }, makeContext("ru", redrawn));
  const afterOff = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    language: string;
    colleagues: { enabled: boolean; items: Record<string, unknown> };
  };
  assert.equal(afterOff.language, "ru");
  assert.equal(afterOff.colleagues.enabled, false);
  assert.ok(afterOff.colleagues.items["7001"]);
});

test("junk callbacks leave colleagues settings untouched", async () => {
  writeFileSync(
    settingsPath,
    JSON.stringify({ colleagues: { enabled: false, items: {} } }),
  );
  const before = readFileSync(settingsPath, "utf8");
  const redrawn: string[] = [];
  const ctx = makeContext("en", redrawn);

  for (const args of [[], [""], ["true"], ["on"], ["1", "0"], ["__proto__"]]) {
    await colleagues.on("set", args, { page: 0 }, ctx);
  }
  await colleagues.on("rf", ["1"], { page: 0 }, ctx);

  assert.equal(readFileSync(settingsPath, "utf8"), before);
  assert.deepEqual(redrawn, []);
});

test("corrupt settings render off and refuse silent overwrite", async () => {
  writeFileSync(settingsPath, "{ broken");
  const view = colleagues.render({ page: 0 }, makeContext("en"));
  assert.deepEqual(buttonsOf(view.text).slice(0, 2), [
    ["○ On", "iva_menu:col:set:1"],
    ["✓ Off", "iva_menu:col:set:0"],
  ]);

  await assert.rejects(
    colleagues.on("set", ["1"], { page: 0 }, makeContext("en")),
    (error: unknown) =>
      (error as { code?: unknown; state?: unknown }).code ===
        "ESETTINGS_WRITE_REFUSED" &&
      (error as { state?: unknown }).state === "corrupt",
  );
  assert.equal(readFileSync(settingsPath, "utf8"), "{ broken");
});
