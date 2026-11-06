export const DAYS_PER_NIGHT = 3;
export const PART_SIZE = 48_000;
export const RELATED_MAX = 30;
export const NIGHT_CEILING = { calls: 40, inputTokens: 300_000 } as const;
export const CACHE_DAYS = 14;
export const CARDS_PER_TRUTH_CALL = 8;
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import { readSettingsState, updateSettings } from "./settings.ts";

export const NIGHT_DEFAULTS = {
  ...NIGHT_CEILING,
  gitTimeoutMs: 12_000,
  maxCalls: 160,
  maxInputTokens: 1_200_000,
  maxGitTimeoutMs: 120_000,
  raisesPerNight: 3,
} as const;
export type NightKey = keyof typeof NIGHT_DEFAULTS;
export type NightSettings = { [K in NightKey]: number };
export const NIGHT_KEYS = Object.keys(NIGHT_DEFAULTS) as NightKey[];
export const NIGHT_MAX = {
  calls: "maxCalls",
  inputTokens: "maxInputTokens",
  gitTimeoutMs: "maxGitTimeoutMs",
} as const;
export type NightLimit = keyof typeof NIGHT_MAX;
export type NightNotice = readonly [english: string, russian: string];

export const nightSettingsFile = () => join(dataDir(), "settings.json");
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const valid = (key: NightKey, value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  (key === "raisesPerNight" ? value >= 0 : value > 0);

/** Неизвестные поля сохраняются при записи: старый выпуск просто игнорирует night. */
export function parseNightSettings(settings: Record<string, unknown>) {
  const values: NightSettings = { ...NIGHT_DEFAULTS };
  const invalid: string[] = [];
  const raw = object(settings.night);
  if (settings.night !== undefined && raw !== settings.night)
    invalid.push("night");
  for (const key of NIGHT_KEYS) {
    if (raw[key] === undefined) continue;
    if (valid(key, raw[key])) values[key] = raw[key];
    else invalid.push(`night.${key}`);
  }
  for (const key of Object.keys(NIGHT_MAX) as NightLimit[]) {
    const max = NIGHT_MAX[key];
    if (values[key] <= values[max]) continue;
    invalid.push(`night.${key} > night.${max}`);
    values[key] = Math.min(NIGHT_DEFAULTS[key], values[max]);
  }
  return { values, invalid };
}

export function readNightSettings(file = nightSettingsFile()) {
  const state = readSettingsState(file);
  const parsed = parseNightSettings(
    state.state === "valid" ? state.settings : {},
  );
  if (state.state !== "valid")
    parsed.invalid.push(`settings.json: ${state.state}`);
  return parsed;
}

/** Проверка и patch одного поля под существующим замком, включая соседние поля night. */
export function setNightSetting(
  key: NightKey,
  value: number,
  file = nightSettingsFile(),
) {
  updateSettings((current) => {
    if (!NIGHT_KEYS.includes(key) || !valid(key, value))
      throw new Error("night value");
    const next = {
      ...current,
      night: { ...object(current.night), [key]: value },
    };
    const values = parseNightSettings(current).values;
    values[key] = value;
    for (const soft of Object.keys(NIGHT_MAX) as NightLimit[])
      if (values[soft] > values[NIGHT_MAX[soft]])
        throw new Error("night ceiling");
    return next;
  }, file);
}

export function nightRaised(
  key: NightLimit,
  before: number,
  after: number,
): NightNotice {
  const [en, ru] = nightLimitName(key);
  return [
    `Night memory reached ${en} = ${before}; raised it to ${after}.`,
    `Ночь памяти достигла предела ${ru} = ${before}; подняла до ${after}.`,
  ];
}

export function nightSaveFailed(key: NightLimit): NightNotice {
  const [en, ru] = nightLimitName(key);
  return [
    `The raised limit for ${en} applies until this process ends; settings could not be saved.`,
    `Поднятый предел ${ru} действует до конца процесса; сохранить настройки пока не удалось.`,
  ];
}

export const nightLimitName = (key: NightLimit): NightNotice =>
  (
    ({
      calls: ["model calls", "вызовов модели"],
      inputTokens: ["input tokens", "входных токенов"],
      gitTimeoutMs: [
        "git wait in milliseconds",
        "ожидания git в миллисекундах",
      ],
    }) as const
  )[key];
