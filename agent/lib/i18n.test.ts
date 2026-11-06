/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// getLang() читает env/файл на импорте и кэширует язык на ~2с, поэтому каждый сценарий
// гоняем в СВЕЖЕМ процессе: чистый модуль, чистое окно кэша, свои env/settings.json.
const I18N_URL = pathToFileURL(join(import.meta.dirname, "i18n.ts")).href;

type ProbeOptions = {
  language?: string;
  agentLanguage?: string;
  corrupt?: string;
};
type ProbeResult = {
  lang: string;
  word: string;
  help: string;
  start: string;
  commands: string[];
  botEn: Array<{ command: string; description: string }>;
  botRu: Array<{ command: string; description: string }>;
};

const PROBE = `
const m = await import(process.env.__I18N_URL);
process.stdout.write(JSON.stringify({
  lang: m.getLang(),
  word: m.tr("EN", "RU"),
  help: m.helpText(),
  start: m.startText(),
  commands: m.COMMANDS.map((c) => c.command),
  botEn: m.botCommands("en"),
  botRu: m.botCommands("ru"),
}));
`;

// language: строка → пишем settings.json {language}; corrupt: строка → пишем как есть.
function probe({
  language,
  agentLanguage,
  corrupt,
}: ProbeOptions = {}): ProbeResult {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-i18n-"));
  if (corrupt !== undefined)
    writeFileSync(join(dataDir, "settings.json"), corrupt);
  else if (language !== undefined)
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ language }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    __I18N_URL: I18N_URL,
    ASSISTANT_DATA_DIR: dataDir,
  };
  delete env.AGENT_LANGUAGE;
  if (agentLanguage !== undefined) env.AGENT_LANGUAGE = agentLanguage;
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", PROBE],
    { env, encoding: "utf8" },
  );
  return JSON.parse(out) as ProbeResult;
}

test("default language is ru without settings or env", () => {
  const r = probe();
  assert.equal(r.lang, "ru");
  assert.equal(r.word, "RU");
});

test("the bot command menu describes /stop through the native draft control", () => {
  const r = probe();
  assert.equal(
    r.botEn.find((command) => command.command === "stop")?.description,
    "interrupt the current turn (same as ■ in the draft)",
  );
  assert.equal(
    r.botRu.find((command) => command.command === "stop")?.description,
    "прервать текущий ход (как ■ в черновике)",
  );
});

test("AGENT_LANGUAGE=en selects English when settings are absent", () => {
  const r = probe({ agentLanguage: "en" });
  assert.equal(r.lang, "en");
  assert.equal(r.word, "EN");
});

test("settings.language overrides the environment both ways", () => {
  assert.equal(probe({ language: "en", agentLanguage: "ru" }).lang, "en");
  assert.equal(probe({ language: "ru", agentLanguage: "en" }).lang, "ru");
});

test("corrupt settings.json falls back to the environment", () => {
  assert.equal(
    probe({ corrupt: "{ not json", agentLanguage: "en" }).lang,
    "en",
  );
});

test("unknown settings.language falls through to env then default", () => {
  assert.equal(probe({ language: "de", agentLanguage: "en" }).lang, "en");
  assert.equal(probe({ language: "de" }).lang, "ru");
});

test("COMMANDS is the single source: menu first, advertised commands present", () => {
  const { commands } = probe();
  assert.equal(commands[0], "menu");
  const expected = [
    "menu",
    "help",
    "start",
    "stop",
    "new",
    "restart",
    "update",
    "model",
    "think",
    "usage",
    "task",
    "tasks",
    "digest",
  ];
  assert.deepEqual(commands, expected);
});

test("helpText renders /menu and respects the language", () => {
  const en = probe({ agentLanguage: "en" }).help;
  assert.match(en, /^Iva commands:/);
  assert.match(en, /\/menu — settings menu/);
  assert.match(en, /\/help — this list/);
  const ru = probe({ language: "ru" }).help;
  assert.match(ru, /^Команды Iva:/);
  assert.match(ru, /\/menu — меню настроек/);
  assert.match(ru, /\/help — этот список/);
  assert.doesNotMatch(ru, /\/compact/);
  assert.doesNotMatch(en, /\/compact/);
});

test("helpText keeps the argument hints from the original help", () => {
  const en = probe({ agentLanguage: "en" }).help;
  assert.match(
    en,
    /\/usage \[today\|week\|month\|by-model\|by-source\] — token usage/,
  );
  assert.match(en, /\/task <text> — add a task/);
  const ru = probe({ language: "ru" }).help;
  assert.match(ru, /\/task <текст> — добавить задачу/);
});

test("botCommands returns Telegram command objects per language", () => {
  const { botEn, botRu } = probe();
  assert.equal(botEn.length, 13);
  assert.equal(botEn[0].command, "menu");
  assert.equal(botEn[0].description, "settings menu");
  assert.equal(botRu[0].description, "меню настроек");
  for (const c of botEn) {
    assert.doesNotMatch(c.command, /\//); // имя команды без ведущего слэша
    assert.ok(c.description.length >= 1 && c.description.length <= 256);
  }
});

test("startText greets in both languages and points at /help", () => {
  // Кнопку Start новый пользователь жмёт до любой настройки: ответ обязан быть
  // готовым в обеих локалях и вести дальше, а не уходить ходом в модель.
  const en = probe({ agentLanguage: "en" }).start;
  assert.match(en, /^Hi, I'm Iva/u);
  assert.match(en, /\/help/u);
  assert.match(en, /\/menu/u);
  const ru = probe({ language: "ru" }).start;
  assert.match(ru, /^Привет, я Iva/u);
  assert.match(ru, /\/help/u);
  assert.match(ru, /\/menu/u);
});

test("/start is in the command table, so /help and the blue menu both show it", () => {
  const { commands, botEn, botRu } = probe();
  assert.ok(commands.includes("start"));
  assert.equal(
    botEn.find((c) => c.command === "start")?.description,
    "greeting and first steps",
  );
  assert.equal(
    botRu.find((c) => c.command === "start")?.description,
    "приветствие и первые шаги",
  );
  assert.match(probe({ language: "ru" }).help, /\/start — приветствие/u);
});
