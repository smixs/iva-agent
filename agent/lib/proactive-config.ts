// Настройки Watch, Brief и Insight — ключ `proactive` в data/settings.json (ADR-0020). Один файл на
// константы, разбор и правку: тик (scripts/proactive/tick.ts), `iva proactive` и тумблер
// «Сама пишет» в /menu → Уведомления читают и пишут через него, второй копии правил нет.
//
// Нет ключа или поля — значение по умолчанию: установка без `proactive` работает как
// включённая. Мусор в поле — значение по умолчанию и строка в журнале, остальные поля живут.
// Ключ digestSchedule прежних версий читать перестаём (Brief заменил дайджест), из файла не удаляем.

/** Предел `list_chats` для личных чатов и для групп: `limit` прокси режет до фильтров. */
export const TELEGRAM_USERS_LIMIT = 500;
export const TELEGRAM_GROUPS_LIMIT = 200;
/** Сколько писем проверка почты смотрит за прогон. */
export const MAIL_LIMIT = 20;
/** Окно Brief и сроки напоминаний Watch о днях рождения Google Контактов. */
export const BIRTHDAY_LOOKAHEAD_DAYS = 7;
export const BIRTHDAY_NOTICE_DAYS = 3;
export const BIRTHDAY_MORNING_END_HOUR = 12;
export const BIRTHDAY_TIMEOUT_MS = 20_000;

export type ProactiveConfig = {
  readonly enabled: boolean;
  readonly quietFromHour: number;
  readonly quietToHour: number;
  readonly staleMinutes: number;
  readonly watchCapPerDay: number;
  readonly modelWakesPerDay: number;
  /** Ceiling дня: токены ходов Watch, Brief и Insight за день владельца; 0 — выключен. */
  readonly ceilingTokensPerDay: number;
  readonly briefTimes: readonly string[];
  readonly insightTimes: readonly string[];
  readonly urgentSenders: readonly string[];
};

export const PROACTIVE_DEFAULTS: ProactiveConfig = {
  enabled: true,
  quietFromHour: 23,
  quietToHour: 8,
  staleMinutes: 60,
  watchCapPerDay: 5,
  modelWakesPerDay: 15,
  ceilingTokensPerDay: 0,
  briefTimes: ["08:30", "14:00"],
  insightTimes: [],
  urgentSenders: [],
};

/** Варианты кнопок Insight и время включения; действующее время — только в settings.json. */
export const INSIGHT_TIME_PRESETS = ["09:30", "11:30", "17:30"] as const;
export const INSIGHT_ENABLE_TIME = INSIGHT_TIME_PRESETS[1];

export type ProactiveKey = keyof ProactiveConfig;

const BRIEF_TIME = /^(?:[01]\d|2[0-3]):(?:00|30)$/u;

function integerIn(min: number, max: number) {
  return (value: unknown): value is number =>
    Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max;
}

/** Список без повторов не длиннее `max`, каждый элемент проходит `item`. */
function listOf(max: number, item: (value: unknown) => boolean) {
  return (value: unknown): boolean =>
    Array.isArray(value) &&
    value.length <= max &&
    new Set(value).size === value.length &&
    value.every(item);
}

/** Правило каждого поля: что допустимо. Одно место для разбора и для `iva proactive set`. */
const VALID: { readonly [K in ProactiveKey]: (value: unknown) => boolean } = {
  enabled: (value) => typeof value === "boolean",
  quietFromHour: integerIn(0, 23),
  quietToHour: integerIn(0, 23),
  staleMinutes: integerIn(0, 24 * 60),
  watchCapPerDay: integerIn(0, 100),
  modelWakesPerDay: integerIn(0, 100),
  ceilingTokensPerDay: integerIn(0, 100_000_000),
  // Не больше двух Brief в сутки (спека §9); пустой список — Brief выключен.
  briefTimes: listOf(
    2,
    (time) => typeof time === "string" && BRIEF_TIME.test(time),
  ),
  // Insight — один слот в день (ADR-0022); пустой список — Insight выключен, так по умолчанию.
  insightTimes: listOf(
    1,
    (time) => typeof time === "string" && BRIEF_TIME.test(time),
  ),
  urgentSenders: listOf(
    50,
    (name) =>
      typeof name === "string" &&
      name !== "" &&
      name.trim() === name &&
      name.length <= 100,
  ),
};

export const PROACTIVE_KEYS = Object.keys(VALID) as ProactiveKey[];

/** Сырой объект `proactive` из настроек; не объект — пусто. */
function rawProactive(settings: unknown): Record<string, unknown> {
  const raw = (settings as { proactive?: unknown } | null)?.proactive;
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** Действующие настройки: поле за полем, мусор — значение по умолчанию и строка в журнал. */
export function parseProactive(
  settings: unknown,
  log: (line: string) => void = console.error,
): ProactiveConfig {
  const raw = rawProactive(settings);
  const config: Record<string, unknown> = { ...PROACTIVE_DEFAULTS };
  for (const key of PROACTIVE_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    if (VALID[key](raw[key])) config[key] = raw[key];
    else log(`proactive: settings field ${key} is not valid, using default`);
  }
  return config as ProactiveConfig;
}

function parseList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function parseValue(key: ProactiveKey, text: string): unknown {
  if (key === "enabled")
    return { true: true, on: true, false: false, off: false }[text];
  if (Array.isArray(PROACTIVE_DEFAULTS[key])) return parseList(text);
  return /^\d+$/u.test(text) ? Number(text) : undefined;
}

/**
 * Значение `iva proactive set <ключ> <значение>`: строка → значение поля или причина отказа.
 * Списки — через запятую и заменяют прежний.
 */
export function proactiveValue(
  key: string,
  text: string,
): { readonly value: unknown } | { readonly error: string } {
  if (!Object.hasOwn(VALID, key))
    return {
      error: `unknown key ${key}; keys: ${PROACTIVE_KEYS.join(", ")}`,
    };
  const value = parseValue(key as ProactiveKey, text.trim());
  if (!VALID[key as ProactiveKey](value))
    return { error: `${key}: ${JSON.stringify(text)} is not a valid value` };
  return { value };
}

/** Настройки с одним изменённым полем: объект `proactive` пишется целиком, соседи на месте. */
export function withProactive(
  settings: Record<string, unknown>,
  key: ProactiveKey,
  value: unknown,
): Record<string, unknown> {
  return {
    ...settings,
    proactive: { ...rawProactive(settings), [key]: value },
  };
}

/** Тихий ли час: интервал через полночь (23 → 8) и обычный (1 → 6); равные границы — тишины нет. */
export function isQuietHour(config: ProactiveConfig, hour: number): boolean {
  const { quietFromHour: from, quietToHour: to } = config;
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * Ждёт ли провал задания Ивы утреннего Brief: только при включённом тумблере, со слотами Brief и в
 * тихий час. Тумблер выключен или слотов нет — Brief не придёт, и wake-ход сообщает о провале сразу
 * (сбой — Alert, ADR-0020).
 */
export function failureWaitsForBrief(
  config: ProactiveConfig,
  hour: number,
): boolean {
  return (
    config.enabled && config.briefTimes.length > 0 && isQuietHour(config, hour)
  );
}

/** Что известно об отправителе пункта: имя пользователя, имя или название чата, адрес почты. */
export type Sender = {
  readonly username?: string;
  readonly name?: string;
  readonly email?: string;
};

/** Срочный ли отправитель: точное совпадение без регистра с любым из его имён. */
export function isUrgentSender(
  config: ProactiveConfig,
  sender: Sender,
): boolean {
  const names = [
    sender.username?.replace(/^@/u, ""),
    sender.name?.trim(),
    sender.email?.trim(),
  ]
    .filter((name): name is string => typeof name === "string" && name !== "")
    .map((name) => name.toLowerCase());
  return config.urgentSenders.some((urgent) =>
    names.includes(urgent.replace(/^@/u, "").toLowerCase()),
  );
}
