// Отказы тула remind: что пришло, что ждали, и один вызов-образец, исправляющий именно
// этот случай. Живой провал 0.4.2: на «give exactly one of at or cron» модель 135 раз
// подряд перебирала заглушки в cron и id, не понимая, какое поле мешает. Модуль только
// пишет текст: что считать ошибкой, решает тул.
import {
  nextCronRunMs,
  ReminderTimeError,
  resolveAt,
} from "./reminder-time.ts";
import {
  normalizeSchedule,
  ReminderStoreError,
  type ReminderSchedule,
} from "./reminder-store.ts";

/** Поля add в том виде, в каком их прислала модель. */
export interface AddFields {
  readonly text?: string;
  readonly at?: string;
  readonly cron?: string;
  readonly id?: string;
}

/** Расписание, готовое к записи: срок повторяющегося считает код, а не модель. */
export type PlannedSchedule =
  | { readonly schedule: ReminderSchedule; readonly nextRunAtMs?: number }
  | { readonly refusal: string };

const AT_EXAMPLE = "in 30m";
const CRON_EXAMPLE = "0 9 * * 1-5";
const REMOVE_EXAMPLE = '{"action":"remove","id":"r-1a2b3c"}';
const LIST_CALL = '{"action":"list"}';
/** Пришедшее значение показываем целиком до этого размера: длинное - только началом. */
const SHOWN_CHARS = 60;

function shown(value: string): string {
  return JSON.stringify(
    value.length > SHOWN_CHARS ? `${value.slice(0, SHOWN_CHARS)}…` : value,
  );
}

/** Что пришло, по именам: значения at/cron/id, у text - только факт присутствия. */
function receivedFields(fields: AddFields): string {
  const parts = fields.text === undefined ? [] : ["text"];
  for (const key of ["at", "cron", "id"] as const) {
    const value = fields[key];
    if (value !== undefined) parts.push(`${key}=${shown(value)}`);
  }
  return parts.length ? parts.join(", ") : "only action";
}

/** Короткий text повторяем в образце как есть: заглушку модель могла бы скопировать. */
const ECHOED_TEXT_CHARS = 200;

/** Образец add: пришедший text как есть, длинный - только упоминанием. */
function addExample(
  kind: "at" | "cron",
  value: string,
  text: string | undefined,
): string {
  const sample =
    text === undefined
      ? "<what to do at the due time>"
      : text.length <= ECHOED_TEXT_CHARS
        ? text
        : "<the same text>";
  return `Example: ${JSON.stringify({ action: "add", text: sample, [kind]: value })}`;
}

/** at, который не читается: образец даёт форму, время - пользователя. Формы перечисляет
 * уже сама ошибка неизвестной формы; остальным (прошлое, дальше года) их дописываем. */
function atNote(problem: string): string {
  return problem.includes("unsupported form")
    ? "Put the user's own time in one of these forms."
    : 'at takes the user\'s own time as "in 30m", "14:30", "2026-09-14 09:00" or an ISO instant.';
}

/** Почему at не читается, или null. */
function atProblem(at: string, nowMs: number, tz: string): string | null {
  try {
    resolveAt(at, nowMs, tz);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Почему cron не читается, или null. */
function cronProblem(cron: string, nowMs: number, tz: string): string | null {
  try {
    const schedule = normalizeSchedule({ kind: "cron", expr: cron, tz });
    if (schedule.kind === "cron") nextCronRunMs(schedule.expr, tz, nowMs);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Пришли оба: оставить стоит то, что читается; at словами не читается, а cron - да. */
function bothRefusal(
  fields: AddFields & { at: string; cron: string },
  nowMs: number,
  tz: string,
): string {
  const head =
    `add takes exactly one of at or cron, got both (${receivedFields(fields)}). ` +
    "Leave the other field out of the call entirely: no empty string or placeholder.";
  const atIssue = atProblem(fields.at, nowMs, tz);
  if (atIssue !== null && cronProblem(fields.cron, nowMs, tz) === null)
    return `${head} Keep cron for a repeating reminder. ${addExample("cron", fields.cron, fields.text)}`;
  const reason = atIssue === null ? "" : ` ${atIssue}. ${atNote(atIssue)}`;
  const value = atIssue === null ? fields.at : AT_EXAMPLE;
  return `${head} Keep at for a one-time reminder.${reason} ${addExample("at", value, fields.text)}`;
}

/** Нет text: образец берёт пришедший срок, чтобы исправить ровно одно поле. */
function missingTextRefusal(fields: AddFields): string {
  const [kind, value] =
    fields.at === undefined && fields.cron !== undefined
      ? (["cron", fields.cron] as const)
      : (["at", fields.at ?? AT_EXAMPLE] as const);
  return `add needs text: the instruction to yourself for the due time; got ${receivedFields(fields)}. ${addExample(kind, value, undefined)}`;
}

/** Отказ add до записи: нет text, нет расписания или пришли оба. null - поля годятся. */
export function addFieldsRefusal(
  fields: AddFields,
  nowMs: number,
  tz: string,
): string | null {
  const { at, cron, text } = fields;
  if (text === undefined) return missingTextRefusal(fields);
  if (at !== undefined && cron !== undefined)
    return bothRefusal({ ...fields, at, cron }, nowMs, tz);
  if (at === undefined && cron === undefined)
    return `add needs a schedule: at (one-time) or cron (repeating, 5 fields like "${CRON_EXAMPLE}"); got ${receivedFields(fields)}. ${addExample("at", AT_EXAMPLE, text)}`;
  return null;
}

/** Текст отказа по сроку: ошибка уже называет поле (at:/cron:), дописываем образец. */
function scheduleRefusal(
  kind: "at" | "cron",
  error: Error,
  fields: AddFields,
): string {
  if (kind === "at")
    return `${error.message}. ${atNote(error.message)} ${addExample("at", AT_EXAMPLE, fields.text)}`;
  const reason = error.message.replace(/^(?:schedule|cron): /u, "");
  return `cron ${shown(fields.cron ?? "")}: ${reason}; it takes 5 fields (minute hour day month weekday) in the user's zone, for a one-time reminder send at instead. ${addExample("cron", CRON_EXAMPLE, fields.text)}`;
}

/**
 * Срок из ровно одного поля at/cron (addFieldsRefusal уже пройден). Негодный срок - отказ
 * с образцом, а не исключение; чужие сбои летят дальше как были.
 */
export function planSchedule(
  fields: AddFields,
  nowMs: number,
  tz: string,
  allowFrequent = false,
): PlannedSchedule {
  const kind = fields.at === undefined ? "cron" : "at";
  try {
    if (fields.at !== undefined)
      return {
        schedule: { kind: "at", atMs: resolveAt(fields.at, nowMs, tz) },
      };
    const schedule = normalizeSchedule({ kind: "cron", expr: fields.cron, tz });
    if (schedule.kind !== "cron")
      throw new ReminderStoreError("schedule: not a cron expression");
    return {
      schedule,
      nextRunAtMs: nextCronRunMs(schedule.expr, tz, nowMs, allowFrequent),
    };
  } catch (error) {
    if (
      !(error instanceof ReminderTimeError) &&
      !(error instanceof ReminderStoreError)
    )
      throw error;
    return { refusal: scheduleRefusal(kind, error, fields) };
  }
}

/** remove без id. */
export function removeFieldsRefusal(fields: AddFields): string {
  return `remove needs id, got ${receivedFields(fields)}; ids come from ${LIST_CALL}. Example: ${REMOVE_EXAMPLE}`;
}

/** remove с id, которого нет в таблице. */
export function unknownIdRefusal(id: string): string {
  return `id ${shown(id)}: no such reminder; take the id from ${LIST_CALL}. Example: ${REMOVE_EXAMPLE}`;
}
