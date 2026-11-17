/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-turn-policy-"));
process.env.ASSISTANT_DATA_DIR = dataDir;

const loaded: unknown = await import(
  new URL("./turn-policy.ts", import.meta.url).href
);
if (typeof loaded !== "object" || loaded === null || !("default" in loaded))
  throw new Error("turn-policy menu has no default screen");
const screen = loaded.default as Screen;

after(() => rmSync(dataDir, { recursive: true, force: true }));

type View = { text: string };
type MenuState = { page: number };
type MenuContext = {
  tr: (english: string, russian: string) => string;
  show: (state: MenuState, screenId: string) => Promise<void>;
};
type Screen = {
  parent: string;
  render: (state: MenuState, context: MenuContext) => View;
  on: (
    verb: string,
    args: string[],
    state: MenuState,
    context: MenuContext,
  ) => Promise<void>;
};

const settingsPath = join(dataDir, "settings.json");

function makeContext(lang: string, redrawn: string[] = []): MenuContext {
  return {
    tr: (english, russian) => (lang === "ru" ? russian : english),
    show: (_state, screenId) => {
      redrawn.push(screenId);
      return Promise.resolve();
    },
  };
}

// Кнопка — тег в markdown: подпись и data достаём из строки экрана.
function labels(view: View): Array<[string, string]> {
  return [
    ...view.text.matchAll(
      /<tg-button[^>]*data="([^"]+)"[^>]*>([^<]*)<\/tg-button>/g,
    ),
  ].map((match) => [match[2], match[1]] as [string, string]);
}

test("queue is the default and callbacks stay stable in both languages", () => {
  rmSync(settingsPath, { force: true });

  const english = screen.render({ page: 4 }, makeContext("en"));
  assert.deepEqual(labels(english), [
    ["✓ Queue", "iva_menu:turn:set:queue"],
    ["○ Interrupt", "iva_menu:turn:set:steer"],
    ["‹ Menu", "iva_menu:r:o"],
  ]);

  const russian = screen.render({ page: 0 }, makeContext("ru"));
  assert.deepEqual(labels(russian), [
    ["✓ Очередь", "iva_menu:turn:set:queue"],
    ["○ Перебивать", "iva_menu:turn:set:steer"],
    ["‹ Меню", "iva_menu:r:o"],
  ]);
  assert.equal(screen.parent, "r");
});

// Экран — заголовок и кнопки, без пояснений (решение владельца 17.11.2026).
test("the screen holds only the title and the buttons", () => {
  rmSync(settingsPath, { force: true });
  for (const lang of ["en", "ru"] as const) {
    const text = screen.render({ page: 0 }, makeContext(lang)).text;
    const rest = text
      .replace(/<tg-button-row>[\s\S]*?<\/tg-button-row>/g, "")
      .replace(/<tg-button[^>]*>[\s\S]*?<\/tg-button>/g, "")
      .replace(/^# .*$/m, "")
      .trim();
    assert.equal(rest, "", lang);
  }
});

test("steer renders selected and a selection preserves other settings", async () => {
  writeFileSync(
    settingsPath,
    JSON.stringify({ language: "ru", turnPolicy: "steer" }),
  );
  assert.deepEqual(labels(screen.render({ page: 0 }, makeContext("en"))), [
    ["○ Queue", "iva_menu:turn:set:queue"],
    ["✓ Interrupt", "iva_menu:turn:set:steer"],
    ["‹ Menu", "iva_menu:r:o"],
  ]);

  const redrawn: string[] = [];
  await screen.on("set", ["queue"], { page: 2 }, makeContext("en", redrawn));

  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    language: "ru",
    turnPolicy: "queue",
  });
  assert.deepEqual(redrawn, ["turn"]);
});

test("junk callbacks do not mutate settings or redraw", async () => {
  writeFileSync(settingsPath, JSON.stringify({ turnPolicy: "steer" }));
  const before = readFileSync(settingsPath, "utf8");
  const redrawn: string[] = [];
  const context = makeContext("en", redrawn);

  for (const args of [
    [],
    [""],
    ["QUEUE"],
    ["interrupt"],
    ["steer", "again"],
    ["__proto__"],
  ])
    await screen.on("set", args, { page: 0 }, context);
  await screen.on("rf", ["queue"], { page: 0 }, context);

  assert.equal(readFileSync(settingsPath, "utf8"), before);
  assert.deepEqual(redrawn, []);
});

test("corrupt settings render queue but refuse a silent repair", async () => {
  writeFileSync(settingsPath, "{ broken");
  assert.equal(
    labels(screen.render({ page: 0 }, makeContext("en")))[0][0],
    "✓ Queue",
  );
  await assert.rejects(
    screen.on("set", ["steer"], { page: 0 }, makeContext("en")),
    (error: unknown) =>
      (error as { code?: unknown; state?: unknown }).code ===
        "ESETTINGS_WRITE_REFUSED" &&
      (error as { state?: unknown }).state === "corrupt",
  );
  assert.equal(readFileSync(settingsPath, "utf8"), "{ broken");
});
