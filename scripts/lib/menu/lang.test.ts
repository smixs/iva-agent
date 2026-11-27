/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-lang-data-"));
process.env.ASSISTANT_DATA_DIR = dataDir;

const languageModule: unknown = await import(
  new URL("./lang.ts", import.meta.url).href
);

after(() => rmSync(dataDir, { recursive: true, force: true }));

interface MenuView {
  text: string;
}

// Кнопка — тег в markdown: подпись и data достаём из строки.
const buttonsOf = (text: string): Array<[string, string]> =>
  [
    ...text.matchAll(
      /<tg-button[^>]*data="([^"]+)"[^>]*>([^<]*)<\/tg-button>/g,
    ),
  ].map((match) => [match[2], match[1]] as [string, string]);

interface MenuState {
  page: number;
}

interface MenuContext {
  lang: string;
  deps: { envPath: string };
  getLang: () => string;
  tr: (english: string, russian: string) => string;
  show: (state: MenuState, screenId: string) => Promise<void>;
}

interface LanguageScreen {
  parent: string;
  render: (state: MenuState, context: MenuContext) => MenuView;
  on: (
    verb: string,
    args: string[],
    state: MenuState,
    context: MenuContext,
  ) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function languageScreen(module: unknown): LanguageScreen {
  if (!isRecord(module) || !isRecord(module.default)) {
    throw new Error("language menu has no default screen");
  }
  const screen = module.default;
  if (
    typeof screen.parent !== "string" ||
    typeof screen.render !== "function" ||
    typeof screen.on !== "function"
  ) {
    throw new Error("language menu screen contract is invalid");
  }
  return {
    parent: screen.parent,
    render: screen.render as LanguageScreen["render"],
    on: screen.on as LanguageScreen["on"],
  };
}

const language = languageScreen(languageModule);

function settingsPath(): string {
  return join(dataDir, "settings.json");
}

function makeContext(
  lang: string,
  envPath: string,
  onShow: () => void = () => {},
): MenuContext {
  return {
    lang,
    deps: { envPath },
    getLang: () => lang,
    tr: (english, russian) => (lang === "ru" ? russian : english),
    show: (_state, screenId) => {
      assert.equal(screenId, "r");
      onShow();
      return Promise.resolve();
    },
  };
}

test("language menu renders current-language checkmarks with stable callbacks", () => {
  for (const [current, expectedHeading, expectedButtons, expectedBack] of [
    [
      "ru",
      "🌐 Язык интерфейса",
      [
        ["Русский ✓", "iva_menu:lang:set:ru"],
        ["English", "iva_menu:lang:set:en"],
      ],
      "‹ Назад",
    ],
    [
      "en",
      "🌐 Interface language",
      [
        ["Русский", "iva_menu:lang:set:ru"],
        ["English ✓", "iva_menu:lang:set:en"],
      ],
      "‹ Back",
    ],
  ] as const) {
    const context = makeContext(current, join(dataDir, `${current}.env`));
    const view = language.render({ page: 4 }, context);

    assert.match(view.text, new RegExp(`^# ${expectedHeading}$`, "m"));
    assert.deepEqual(buttonsOf(view.text).slice(0, 2), expectedButtons);
    // Языки — равноправный ряд, «назад» — отдельной строкой с возвратом в «Общение».
    assert.deepEqual(buttonsOf(view.text).at(-1), [
      expectedBack,
      "iva_menu:gc:o",
    ]);
  }
  assert.equal(language.parent, "gc");
});

test("language selection persists settings and env before redrawing root", async () => {
  const caseDir = mkdtempSync(join(tmpdir(), "iva-menu-lang-success-"));
  const envPath = join(caseDir, ".env");
  writeFileSync(envPath, "UNRELATED=value\nAGENT_LANGUAGE=ru\n", "utf8");
  rmSync(settingsPath(), { force: true });
  const state = { page: 9 };
  let rootRedraws = 0;
  const languagesAtRedraw = ["en", "ru"];
  const context = makeContext("ru", envPath, () => {
    const selected = languagesAtRedraw[rootRedraws];
    rootRedraws += 1;
    assert.equal(
      readFileSync(settingsPath(), "utf8"),
      JSON.stringify({ language: selected }),
    );
    assert.equal(
      readFileSync(envPath, "utf8"),
      `UNRELATED=value\nAGENT_LANGUAGE=${selected}\n`,
    );
  });

  await language.on("set", ["en"], state, context);

  assert.equal(rootRedraws, 1);
  assert.equal(context.lang, "en");
  assert.equal(state.page, 0);

  await language.on("set", ["anything-else"], state, context);
  assert.equal(readFileSync(settingsPath(), "utf8"), '{"language":"ru"}');
  assert.equal(
    readFileSync(envPath, "utf8"),
    "UNRELATED=value\nAGENT_LANGUAGE=ru\n",
  );
  assert.equal(context.lang, "ru");
  assert.equal(rootRedraws, 2);

  rmSync(caseDir, { recursive: true, force: true });
});

test("language selection remains live when the env mirror cannot be written", async () => {
  const caseDir = mkdtempSync(join(tmpdir(), "iva-menu-lang-failure-"));
  const missingEnvPath = join(caseDir, "missing", ".env");
  rmSync(settingsPath(), { force: true });
  const state = { page: 3 };
  let rootRedraws = 0;
  const context = makeContext("ru", missingEnvPath, () => {
    rootRedraws += 1;
    assert.equal(readFileSync(settingsPath(), "utf8"), '{"language":"en"}');
  });

  await language.on("set", ["en"], state, context);

  assert.equal(rootRedraws, 1);
  assert.equal(context.lang, "en");
  assert.equal(state.page, 0);
  assert.throws(() => readFileSync(missingEnvPath, "utf8"), { code: "ENOENT" });

  rmSync(caseDir, { recursive: true, force: true });
});

test("non-selection verbs leave the menu state untouched", async () => {
  const caseDir = mkdtempSync(join(tmpdir(), "iva-menu-lang-noop-"));
  const envPath = join(caseDir, ".env");
  const state = { page: 7 };
  let rootRedraws = 0;
  const context = makeContext("ru", envPath, () => {
    rootRedraws += 1;
  });

  await language.on("ignored", ["en"], state, context);

  assert.equal(rootRedraws, 0);
  assert.equal(context.lang, "ru");
  assert.equal(state.page, 7);
  assert.throws(() => readFileSync(envPath, "utf8"), { code: "ENOENT" });

  rmSync(caseDir, { recursive: true, force: true });
});
