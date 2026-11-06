// Время напоминаний в зоне владельца. Следующий запуск повторяющегося расписания с
// зоной и переходами на летнее время считает croner - тот же движок, которым eve
// стреляет своими расписаниями; своя арифметика cron-выражений - ровно тот путь, что дал
// ошибку на пять часов в инциденте 24.08 (R3 ресёрча).
import { Cron } from "croner";
import { resolveTimeZone } from "./timezone.ts";
import {
  addDaysToDate,
  formatZoned,
  zonedParts,
  zonedToUtcMs,
} from "./zoned-time.ts";

export class ReminderTimeError extends Error {}

/** Чаще, чем раз в 10 минут, - это уже не напоминание, а спам. */
export const REMINDER_MIN_CRON_INTERVAL_MS = 10 * 60_000;
/** Горизонт разового напоминания: дальше года вперёд не планируем. */
export const REMINDER_MAX_HORIZON_MS = 366 * 24 * 60 * 60_000;

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 } as const;
const RELATIVE = /^in\s+(?:\d+\s*[dhms])(?:\s*\d+\s*[dhms])*$/iu;
const TIME_OF_DAY = /^(\d{1,2}):(\d{2})$/u;
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/u;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/u;

function unsupported(input: string): ReminderTimeError {
  return new ReminderTimeError(
    `at: unsupported form ${JSON.stringify(input)}; use "in 30m", "14:30", "2026-09-14 09:00" or an ISO instant`,
  );
}

/** Зона владельца: канон IANA из `.env`, иначе UTC - как везде в процессе. */
export function ownerTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  return resolveTimeZone(env.ASSISTANT_TIMEZONE);
}

/** Стена владельца -> UTC; несуществующее время (31 февраля, пропущенный час) - ошибка. */
function wallClockMs(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  tz: string,
): number {
  const result = zonedToUtcMs(y, m, d, hh, mm, tz);
  const seen = zonedParts(result, tz);
  if (
    seen.y !== y ||
    seen.m !== m ||
    seen.d !== d ||
    seen.hh !== hh ||
    seen.mm !== mm
  )
    throw new ReminderTimeError(`at: no such wall-clock time in ${tz}`);
  return result;
}

/** Разовое время: `in 30m`, `14:30`, `2026-09-14 09:00` или ISO-момент со смещением. */
export function resolveAt(input: string, nowMs: number, tz: string): number {
  const value = input.trim();
  try {
    return resolveAtValue(value, nowMs, tz);
  } catch (error) {
    if (error instanceof ReminderTimeError) throw error;
    // Битый ASSISTANT_TIMEZONE: Intl бросает сырой RangeError, а контракт модуля —
    // один тип ошибки на любой негодный вход; иначе форма «14:30» падает иначе,
    // чем остальной мусор дат.
    throw new ReminderTimeError(`at: unknown time zone ${JSON.stringify(tz)}`, {
      cause: error,
    });
  }
}

function resolveAtValue(value: string, nowMs: number, tz: string): number {
  let result: number;

  if (RELATIVE.test(value)) {
    let sum = 0;
    for (const match of value.matchAll(/(\d+)\s*([dhms])/giu)) {
      const unit = String(match[2]).toLowerCase() as keyof typeof UNIT_MS;
      sum += Number(match[1]) * UNIT_MS[unit];
    }
    if (sum === 0) throw new ReminderTimeError("at: duration must be positive");
    result = nowMs + sum;
  } else {
    const timeOfDay = TIME_OF_DAY.exec(value);
    const wallClock = WALL_CLOCK.exec(value);
    if (timeOfDay) {
      const { y, m, d } = zonedParts(nowMs, tz);
      const hh = Number(timeOfDay[1]);
      const mm = Number(timeOfDay[2]);
      const today = wallClockMs(y, m, d, hh, mm, tz);
      if (today > nowMs) {
        result = today;
      } else {
        const next = addDaysToDate(y, m, d, 1);
        result = wallClockMs(next.y, next.m, next.d, hh, mm, tz);
      }
    } else if (wallClock) {
      result = wallClockMs(
        Number(wallClock[1]),
        Number(wallClock[2]),
        Number(wallClock[3]),
        Number(wallClock[4]),
        Number(wallClock[5]),
        tz,
      );
    } else if (ISO_INSTANT.test(value)) {
      const parsed = Date.parse(value);
      if (Number.isNaN(parsed)) throw unsupported(value);
      result = parsed;
    } else {
      throw unsupported(value);
    }
  }

  if (result <= nowMs)
    throw new ReminderTimeError(
      `at: ${formatZoned(result, tz)} is in the past`,
    );
  if (result > nowMs + REMINDER_MAX_HORIZON_MS)
    throw new ReminderTimeError("at: more than a year ahead");
  return result;
}

/** Следующий запуск cron-выражения в зоне владельца, строго после `afterMs`. */
export function nextCronRunMs(
  expr: string,
  tz: string,
  afterMs: number,
  allowFrequent = false,
): number {
  try {
    const cron = new Cron(expr, { timezone: tz, paused: true });
    const next = cron.nextRun(new Date(afterMs));
    if (next === null) throw new ReminderTimeError("cron: never fires");
    const second = cron.nextRun(next);
    if (
      !allowFrequent &&
      second !== null &&
      second.getTime() - next.getTime() < REMINDER_MIN_CRON_INTERVAL_MS
    )
      throw new ReminderTimeError(
        "cron: fires more often than every 10 minutes",
      );
    return next.getTime();
  } catch (error) {
    if (error instanceof ReminderTimeError) throw error;
    const text = error instanceof Error ? error.message : String(error);
    // croner отвергает шаг с числовым префиксом («0/7»); подсказываем форму, которую он берёт.
    const step = /stepping with numeric prefix \('\d+\/(\d+)'\)/u.exec(text);
    throw new ReminderTimeError(
      `cron: ${text}${step === null ? "" : `; write the step as "*/${step[1]}"`}`,
    );
  }
}
