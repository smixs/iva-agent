// Двуязычие моста и канала. Один источник языка (getLang) и одна таблица команд
// (COMMANDS) кормят и /help, и синее командное меню Telegram (setMyCommands).
//
// ЖЁСТКОЕ ПРАВИЛО репо: ни одна module-level const нигде не должна захватывать
// переведённую строку — иначе язык замерзает до рестарта процесса. Поэтому tr —
// функция, а helpText() генерит текст на каждый вызов. Захватывать можно только
// САМИ пары {en, ru} (COMMANDS), выбор из них делается в момент вызова.

import { statSync } from "node:fs";
import { join } from "node:path";
import { readSettings } from "./settings.ts";
import { dataDir } from "./data-dir.ts";

// Тот же путь, что в settings.ts (от cwd, не от import.meta.url — см. там про
// authored-modules-кэш eve). Нужен для statSync-дросселя ниже.
const DATA_DIR = dataDir();
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

// settings.json меняется кнопкой в /menu и должен подхватываться на лету. Но statSync
// на КАЖДЫЙ tr() (а их сотни за ход) — лишний сисколл, поэтому проверку файла
// дросселируем до ~2с: между проверками отдаём закэшированный язык, ошибки stat глотаем.
const CHECK_INTERVAL_MS = 2000;
type Language = "ru" | "en";
type Command = {
  readonly command: string;
  readonly en: string;
  readonly ru: string;
  readonly args?: { readonly en: string; readonly ru: string };
};

const cache: { lang: Language | null; mtimeMs: number; checkedAt: number } = {
  lang: null,
  mtimeMs: -1,
  checkedAt: 0,
};

// settings.language ("ru"|"en") → env AGENT_LANGUAGE → "ru". Незнакомые значения
// в settings проваливаются к env, незнакомый env — к дефолту "ru".
function resolveLang(): Language {
  const fromSettings = readSettings().language;
  if (fromSettings === "ru" || fromSettings === "en") return fromSettings;
  return process.env.AGENT_LANGUAGE === "en" ? "en" : "ru";
}

export function getLang(): Language {
  const now = Date.now();
  if (cache.lang !== null && now - cache.checkedAt < CHECK_INTERVAL_MS)
    return cache.lang;
  cache.checkedAt = now;
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(SETTINGS_FILE).mtimeMs;
  } catch {
    // файла нет / нет доступа — mtimeMs=-1, язык возьмётся из env-фолбэка
  }
  if (cache.lang !== null && mtimeMs === cache.mtimeMs) return cache.lang;
  cache.mtimeMs = mtimeMs;
  cache.lang = resolveLang();
  return cache.lang;
}

// Идиома репо: выбор перевода двумя литералами на месте вызова (не словари по ключам).
export const tr = (en: string, ru: string): string =>
  getLang() === "ru" ? ru : en;

// ЕДИНЫЙ список команд для helpText() и setMyCommands. Порядок = порядок в /help и
// в синем меню. args (опц.) — подсказка аргументов: попадает только в /help, не в
// описание команды Telegram (там аргументов быть не должно).
export const COMMANDS: ReadonlyArray<Command> = [
  { command: "menu", en: "settings menu", ru: "меню настроек" },
  { command: "help", en: "this list", ru: "этот список" },
  {
    command: "start",
    en: "greeting and first steps",
    ru: "приветствие и первые шаги",
  },
  {
    command: "stop",
    en: "interrupt the current turn (same as ■ in the draft)",
    ru: "прервать текущий ход (как ■ в черновике)",
  },
  {
    command: "new",
    en: "start over (reset the current conversation)",
    ru: "начать диалог заново",
  },
  {
    command: "restart",
    en: "restart the agent if it's stuck",
    ru: "перезапустить зависшего агента",
  },
  {
    command: "update",
    en: "check for a new version and install it",
    ru: "проверить и установить обновление",
  },
  {
    command: "model",
    en: "switch AI provider/model/thinking effort",
    ru: "сменить провайдера, модель и размышления",
  },
  {
    command: "think",
    en: "set thinking effort",
    ru: "настроить уровень размышлений",
  },
  {
    command: "usage",
    en: "token usage",
    ru: "расход токенов",
    args: {
      en: "[today|week|month|by-model|by-source]",
      ru: "[today|week|month|by-model|by-source]",
    },
  },
  {
    command: "task",
    en: "add a task",
    ru: "добавить задачу",
    args: { en: "<text>", ru: "<текст>" },
  },
  { command: "tasks", en: "show tasks", ru: "показать задачи" },
  { command: "digest", en: "daily brief", ru: "обзор дня" },
];

// Текст /help на текущем языке. Генерится на каждый вызов (язык мог смениться).
export function helpText(): string {
  const isRu = getLang() === "ru";
  const pick = (en: string, ru: string): string => (isRu ? ru : en);
  const lines = COMMANDS.map((c) => {
    const hint = c.args ? ` ${pick(c.args.en, c.args.ru)}` : "";
    return `/${c.command}${hint} — ${pick(c.en, c.ru)}`;
  });
  return [pick("Iva commands:", "Команды Iva:"), ...lines].join("\n");
}

// Ответ на /start: кнопку Start жмут ровно один раз, и до модели она доходить не должна.
// Генерится на каждый вызов — по тому же правилу, что helpText().
export function startText(): string {
  const isRu = getLang() === "ru";
  return isRu
    ? [
        "Привет, я Iva — твой личный ассистент.",
        "Просто напиши, что нужно: текстом, голосом или файлом.",
        "Список команд — /help, настройки — /menu.",
      ].join("\n")
    : [
        "Hi, I'm Iva — your personal assistant.",
        "Just tell me what you need: text, voice, or a file.",
        "Commands are in /help, settings in /menu.",
      ].join("\n");
}

// Массив для setMyCommands на конкретном языке (мост зовёт дважды: default=en и
// language_code:"ru"), поэтому язык здесь явный, а не через getLang(). Описания без
// подсказок аргументов — Telegram показывает только имя команды и описание.
export function botCommands(
  lang: string,
): Array<{ command: string; description: string }> {
  const isRu = lang === "ru";
  return COMMANDS.map((c) => ({
    command: c.command,
    description: isRu ? c.ru : c.en,
  }));
}
