// Таблица напоминаний в data/reminders.json: строка = срок, текст и факт срабатывания.
//
// Взятие строки — один атомарный переход pending → fired: повторное срабатывание
// невозможно по построению, аренды и счётчиков попыток нет. Всё, что происходит после
// перехода, — один ход ребёнка scripts/reminders/fire.ts (агент выполняет текст напоминания,
// код отправляет его ответ); он только дописывает факт в ту же строку. Повторяющаяся строка тем
// же переходом получает следующий срок от croner и остаётся pending — факт последнего
// срабатывания при ней.
//
// Файл, записанный более новой версией Ивы, читается как явная ошибка: читать его наугад
// значит молча испортить данные следующей записью. Файл версии 1 (режимы verbatim/agent,
// аренда, счётчики провалов) переводится построчно: срок и текст сохраняются, режим и все
// политики повторов отброшены владельцем 12.09.
import { join } from "node:path";
import { z } from "zod";
import { createHash } from "node:crypto";
import { dataDir } from "./data-dir.ts";
import { quarantineDamagedRecord } from "./damaged-record.ts";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "./json-store.ts";
import { nextCronRunMs } from "./reminder-time.ts";
import { listChatStatuses, RUN_STALE_MS } from "./run-status.ts";

export const REMINDER_SCHEMA_VERSION = 2;
/** Сколько держим сработавшую разовую строку: столько владелец видит факт в remind list. */
export const REMINDER_FIRED_KEEP_MS = 24 * 60 * 60_000;

export class ReminderStoreError extends Error {}
/** remove по id, которого в таблице нет: тул отвечает на это подсказкой, а не сбоем таблицы. */
export class ReminderNotFoundError extends ReminderStoreError {}

export type ReminderStatus = "pending" | "fired";
/** `at` — один точный срок; `cron` — повторяющееся расписание (cron-выражение пользователя). */
export type ReminderSchedule =
  { kind: "at"; atMs: number } | { kind: "cron"; expr: string; tz: string };
/** Куда возвращается напоминание: чат и тема, где его попросили. */
export interface ReminderChat {
  id: string;
  threadId: string | null;
}

export interface Reminder {
  id: string;
  text: string;
  /** null - строка старой схемы или запрос не из Telegram: тогда чат владельца из настроек. */
  chat: ReminderChat | null;
  schedule: ReminderSchedule;
  nextRunAtMs: number;
  createdAt: number;
  /** pending — ждёт своего срока; fired — разовая уже сработала и ждёт уборки через сутки. */
  status: ReminderStatus;
  /** Когда строка сработала в последний раз; null — ещё ни разу. */
  firedAt: number | null;
  /** Дошёл ли текст до чата владельца; null — ребёнок ещё не сказал. */
  delivered: boolean | null;
  /** Причина последнего сбоя — отправки или хода агента. */
  error: string | null;
  /**
   * Сессия идущего хода: её пишет ребёнок перед ходом, читает тик. Убитый ребёнок (SIGKILL)
   * свой `finally` не отработает, и запись чата снимет тик — по этой самой сессии.
   * null — в этом срабатывании хода ещё не было; строки, записанные до появления поля,
   * его не несут вовсе.
   */
  sessionId?: string | null;
  timeout_minutes?: number;
  running_timeout_minutes?: number;
}
export type ReminderInput = {
  id: string;
  text: string;
  chat?: ReminderChat | null;
  timeout_minutes?: number;
  schedule: unknown;
  /** Обязателен для kind "cron", запрещён для kind "at". */
  nextRunAtMs?: number;
};

const ROW_KEYS = [
  "id",
  "text",
  "chat",
  "schedule",
  "nextRunAtMs",
  "createdAt",
  "status",
  "firedAt",
  "delivered",
  "error",
  "sessionId",
  "timeout_minutes",
  "running_timeout_minutes",
] as const;

function fail(file: string, message: string): never {
  throw new ReminderStoreError(`${file}: ${message}`);
}

function badReminder(file: string, idLabel: string, message: string): never {
  fail(file, `reminder ${idLabel}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

/**
 * Форма расписания, а не его смысл: арифметика следующего запуска для повторяющегося
 * расписания живёт выше этого модуля. Идемпотентна: нормализованное расписание
 * нормализуется в себя.
 */
export function normalizeSchedule(input: unknown): ReminderSchedule {
  if (!isPlainObject(input))
    throw new ReminderStoreError(
      `schedule must be an object, got ${JSON.stringify(input)}`,
    );

  if (input.kind === "at") {
    if (!hasExactKeys(input, ["kind", "atMs"]))
      throw new ReminderStoreError(
        `schedule: kind "at" takes exactly kind and atMs, got ${JSON.stringify(input)}`,
      );
    if (!isSafeInt(input.atMs) || input.atMs < 0)
      throw new ReminderStoreError(
        `schedule: atMs must be a safe integer >= 0, got ${JSON.stringify(input.atMs)}`,
      );
    return { kind: "at", atMs: input.atMs };
  }

  if (input.kind === "cron") {
    if (!hasExactKeys(input, ["kind", "expr", "tz"]))
      throw new ReminderStoreError(
        `schedule: kind "cron" takes exactly kind, expr and tz, got ${JSON.stringify(input)}`,
      );
    if (typeof input.expr !== "string")
      throw new ReminderStoreError(
        `schedule: expr must be a string, got ${JSON.stringify(input.expr)}`,
      );
    const expr = input.expr.trim().replace(/\s+/gu, " ");
    const fields = expr.split(" ");
    if (fields.length !== 5)
      throw new ReminderStoreError(
        `schedule: expr must have exactly 5 fields, got ${fields.length}: ${JSON.stringify(input.expr)}`,
      );
    for (const field of fields) {
      if (!/^[0-9*,/-]+$/u.test(field))
        throw new ReminderStoreError(
          `schedule: expr field ${JSON.stringify(field)} is not a cron field`,
        );
    }
    if (typeof input.tz !== "string" || input.tz.length === 0)
      throw new ReminderStoreError(
        `schedule: tz must be a non-empty string, got ${JSON.stringify(input.tz)}`,
      );
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input.tz });
    } catch {
      throw new ReminderStoreError(
        `schedule: tz ${JSON.stringify(input.tz)} is not a known IANA time zone`,
      );
    }
    return { kind: "cron", expr, tz: input.tz };
  }

  throw new ReminderStoreError(
    `schedule: kind must be "at" or "cron", got ${JSON.stringify(input.kind)}`,
  );
}

/** Одна проверка формы строки и для add, и для загрузки файла. */
/** Чат строки: null или {id, threadId}; чужая форма - ошибка строки, не тихий null. */
function assertChat(
  file: string,
  idLabel: string,
  value: unknown,
): ReminderChat | null {
  if (value === null || value === undefined) return null;
  if (
    !isPlainObject(value) ||
    typeof value.id !== "string" ||
    value.id.trim() === "" ||
    (value.threadId !== null && typeof value.threadId !== "string")
  )
    badReminder(
      file,
      idLabel,
      `chat must be null or {id, threadId}, got ${JSON.stringify(value)}`,
    );
  return { id: value.id, threadId: value.threadId };
}

/** id строки: без него строка не адресуется и не находится в remind list. */
function assertId(file: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value)
    fail(
      file,
      `id must be a non-empty string without surrounding whitespace, got ${JSON.stringify(value)}`,
    );
  return value;
}

/** Число-срок: безопасное целое не меньше нуля. */
function assertTime(
  file: string,
  idLabel: string,
  name: string,
  value: unknown,
): number {
  if (!isSafeInt(value) || value < 0)
    badReminder(
      file,
      idLabel,
      `${name} must be a safe integer >= 0, got ${JSON.stringify(value)}`,
    );
  return value;
}

/** Расписание строки: форма проверяется там же, где и при добавлении. */
function assertSchedule(
  file: string,
  idLabel: string,
  value: unknown,
): ReminderSchedule {
  try {
    return normalizeSchedule(value);
  } catch (error) {
    badReminder(file, idLabel, (error as Error).message);
  }
}

/** Статус и срок срабатывания: у сработавшей строки срок обязан быть. */
function assertStatus(
  file: string,
  idLabel: string,
  value: Record<string, unknown>,
): { readonly status: ReminderStatus; readonly firedAt: number | null } {
  const status = value.status;
  if (status !== "pending" && status !== "fired")
    badReminder(
      file,
      idLabel,
      `status must be "pending" or "fired", got ${JSON.stringify(status)}`,
    );
  const firedAt = value.firedAt;
  if (firedAt !== null && (!isSafeInt(firedAt) || firedAt < 0))
    badReminder(
      file,
      idLabel,
      `firedAt must be null or a safe integer >= 0, got ${JSON.stringify(firedAt)}`,
    );
  if (status === "fired" && firedAt === null)
    badReminder(file, idLabel, "fired row has no firedAt");
  return { status, firedAt };
}

/**
 * Сессия идущего хода. Строки, записанные до появления поля, читаются как «ход не начинался»:
 * тик снимает запись чата только по ней.
 */
function assertSessionId(
  file: string,
  idLabel: string,
  value: unknown,
): string | null {
  if (
    value !== null &&
    value !== undefined &&
    (typeof value !== "string" || value.length === 0)
  )
    badReminder(
      file,
      idLabel,
      `sessionId must be null or a non-empty string, got ${JSON.stringify(value)}`,
    );
  return value ?? null;
}

const minutes = z.number().int().min(1).max(60).optional();
const commandTimes = z.object({
  timeout_minutes: minutes,
  running_timeout_minutes: minutes,
});
function assertReminder(file: string, value: unknown): Reminder {
  if (!isPlainObject(value))
    fail(file, `reminder row must be an object, got ${JSON.stringify(value)}`);

  const idLabel = JSON.stringify(value.id);

  // Чужой ключ — строка чужой версии: читать её наугад значит молча испортить данные
  // следующей записью.
  for (const key of Object.keys(value)) {
    if (
      !(ROW_KEYS as readonly string[]).includes(key) ||
      (file !== commandFile() && key.endsWith("_minutes"))
    )
      badReminder(file, idLabel, `unknown key ${JSON.stringify(key)}`);
  }

  const times = commandTimes.safeParse(value);
  if (!times.success)
    badReminder(file, idLabel, "timeout_minutes: integer 1–60");
  const id = assertId(file, value.id);
  if (typeof value.text !== "string" || value.text.trim().length === 0)
    badReminder(file, idLabel, "text must be a non-empty string");
  const { status, firedAt } = assertStatus(file, idLabel, value);

  const delivered = value.delivered;
  if (delivered !== null && typeof delivered !== "boolean")
    badReminder(
      file,
      idLabel,
      `delivered must be null, true or false, got ${JSON.stringify(delivered)}`,
    );

  const error = value.error;
  if (error !== null && typeof error !== "string")
    badReminder(
      file,
      idLabel,
      `error must be null or a string, got ${JSON.stringify(error)}`,
    );

  return {
    id,
    text: value.text,
    // Строки до этого поля чата не несут: им остаётся чат владельца из настроек.
    chat: assertChat(file, idLabel, value.chat),
    schedule: assertSchedule(file, idLabel, value.schedule),
    nextRunAtMs: assertTime(file, idLabel, "nextRunAtMs", value.nextRunAtMs),
    createdAt: assertTime(file, idLabel, "createdAt", value.createdAt),
    status,
    firedAt,
    delivered,
    error,
    sessionId: assertSessionId(file, idLabel, value.sessionId),
    ...times.data,
  };
}

/**
 * Строка версии 1: режим доставки, аренда и счётчики провалов отброшены, срок, текст и факт
 * последней попытки сохранены. Разовой строке, которая уже пыталась сработать, ставится
 * fired — иначе она сработала бы второй раз; повторяющаяся остаётся pending на свой срок.
 */
function migrateV1Row(
  file: string,
  value: unknown,
  nowMs: number,
): Record<string, unknown> {
  if (!isPlainObject(value))
    fail(file, `reminder row must be an object, got ${JSON.stringify(value)}`);

  let schedule: ReminderSchedule;
  try {
    schedule = normalizeSchedule(value.schedule);
  } catch (error) {
    badReminder(file, JSON.stringify(value.id), (error as Error).message);
  }
  const firedAt =
    typeof value.lastRunAtMs === "number" &&
    Number.isSafeInteger(value.lastRunAtMs)
      ? value.lastRunAtMs
      : null;
  const alreadyRan = firedAt !== null;
  return {
    id: value.id,
    text: value.text,
    chat: null,
    schedule,
    nextRunAtMs: value.nextRunAtMs,
    createdAt: nowMs,
    status: schedule.kind === "at" && alreadyRan ? "fired" : "pending",
    firedAt,
    delivered: alreadyRan ? value.lastStatus === "ok" : null,
    error: typeof value.lastError === "string" ? value.lastError : null,
    sessionId: null,
  };
}

/** Путь считается на каждом вызове: тесты меняют ASSISTANT_DATA_DIR между кейсами. */
export function reminderFile(): string {
  return join(dataDir(), "reminders.json");
}

async function loadTable(file: string): Promise<Reminder[]> {
  const raw = await loadJsonStrict<unknown>(file, {
    schemaVersion: REMINDER_SCHEMA_VERSION,
    rows: [],
  });
  const damaged: DamagedRow[] = [];
  const rows = parseReminderTable(file, raw, Date.now(), { damaged });
  for (const entry of damaged) quarantineDamagedRecord(file, entry);
  return rows;
}

type DamagedRow = Parameters<typeof quarantineDamagedRecord>[1];

/**
 * Разбор таблицы для клиентов без права на побочный эффект (doctor, diagnose).
 * Стор отдельно собирает плохие строки и копирует их перед возвратом исправных.
 */
export function parseReminderTable(
  file: string,
  raw: unknown,
  nowMs: number,
  { damaged }: { damaged?: DamagedRow[] } = {},
): Reminder[] {
  if (!isPlainObject(raw) || typeof raw.schemaVersion !== "number")
    fail(file, "no schemaVersion");
  const version = raw.schemaVersion;
  if (!Number.isInteger(version))
    fail(file, `unsupported schemaVersion ${JSON.stringify(version)}`);
  if (version > REMINDER_SCHEMA_VERSION)
    fail(
      file,
      `schemaVersion ${version} is newer than this Iva (${REMINDER_SCHEMA_VERSION}); update Iva or restore the file`,
    );
  if (version < 1) fail(file, `unsupported schemaVersion ${version}`);

  if (!Array.isArray(raw.rows))
    fail(file, `rows must be an array, got ${JSON.stringify(raw.rows)}`);

  const seen = new Set<string>();
  const rows: Reminder[] = [];
  raw.rows.forEach((value) => {
    let reminder: Reminder;
    try {
      reminder =
        version === 1
          ? assertReminder(file, migrateV1Row(file, value, nowMs))
          : assertReminder(file, value);
      if (seen.has(reminder.id)) throw new ReminderStoreError("duplicate id");
    } catch (error) {
      if (!(error instanceof ReminderStoreError)) throw error;
      if (!damaged) throw error;
      damaged.push({
        reason: "invalid or duplicate reminder row",
        record: value,
        label: "reminder",
      });
      return;
    }
    seen.add(reminder.id);
    rows.push(reminder);
  });
  return rows;
}

async function saveTable(file: string, rows: Reminder[]): Promise<void> {
  await saveJsonAtomic(
    file,
    { schemaVersion: REMINDER_SCHEMA_VERSION, rows },
    { mode: 0o600 },
  );
}

/** Мутации — под локом: тик и живой чат ходят в один файл из одного процесса. */
async function mutate<T>(
  file: string,
  run: () => Promise<T>,
  lock = `${file}.lock`,
): Promise<T> {
  const token = await acquireLock(lock);
  try {
    return await run();
  } finally {
    releaseLock(lock, token);
  }
}

function byDeadline(a: Reminder, b: Reminder): number {
  if (a.nextRunAtMs !== b.nextRunAtMs) return a.nextRunAtMs - b.nextRunAtMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Первый срок: у разовой строки он и есть её срок, у повторяющейся его считает croner выше
 * и передаёт вызовом — забытый nextRunAtMs оставил бы строку без срока вовсе.
 */
function assertFirstRun(
  file: string,
  idLabel: string,
  schedule: ReminderSchedule,
  nextRunAtMs: number | undefined,
): number {
  if (schedule.kind === "at") {
    if (nextRunAtMs !== undefined)
      badReminder(file, idLabel, 'nextRunAtMs is not allowed for kind "at"');
    return schedule.atMs;
  }
  if (nextRunAtMs === undefined)
    badReminder(file, idLabel, 'nextRunAtMs is required for kind "cron"');
  return assertTime(file, idLabel, "nextRunAtMs", nextRunAtMs);
}

function buildReminder(
  file: string,
  input: ReminderInput,
): Record<string, unknown> {
  const idLabel = JSON.stringify(input.id);

  // Чужой ключ во входе — ошибка, а не тихо отброшенное поле: старый вызов с mode или
  // deliver (схема версии 1) должен упасть, а не записать напоминание без того, что просили.
  for (const key of Object.keys(input)) {
    if (
      key !== "id" &&
      key !== "text" &&
      key !== "chat" &&
      key !== "schedule" &&
      key !== "nextRunAtMs" &&
      key !== "timeout_minutes"
    )
      badReminder(file, idLabel, `unknown input key ${JSON.stringify(key)}`);
  }

  const schedule = assertSchedule(file, idLabel, input.schedule);
  return {
    id: input.id,
    text: input.text,
    chat: assertChat(file, idLabel, input.chat ?? null),
    schedule,
    nextRunAtMs: assertFirstRun(file, idLabel, schedule, input.nextRunAtMs),
    createdAt: Date.now(),
    status: "pending",
    firedAt: null,
    delivered: null,
    error: null,
    sessionId: null,
    ...(input.timeout_minutes === undefined
      ? {}
      : { timeout_minutes: input.timeout_minutes }),
  };
}

/**
 * Добавить строку. `refuse` — проверка таблицы под тем же замком, что и добавление: строка
 * причины — отказ (Error с ней), строка не добавляется. Так предел вида «не больше N ждущих»
 * не обходят два параллельных писателя.
 */
export async function add(
  input: ReminderInput,
  {
    refuse,
    file = reminderFile(),
  }: {
    readonly refuse?: (rows: readonly Reminder[]) => string | null;
    readonly file?: string;
  } = {},
): Promise<Reminder> {
  const row = buildReminder(file, input);
  return mutate(file, async () => {
    const rows = await loadTable(file);
    const reason = refuse?.(rows) ?? null;
    if (reason !== null) throw new Error(reason);
    if (rows.some((candidate) => candidate.id === row.id))
      fail(file, `duplicate reminder id ${JSON.stringify(row.id)}`);
    const reminder = assertReminder(file, row);
    rows.push(reminder);
    await saveTable(file, rows);
    return structuredClone(reminder);
  });
}

export async function list(file = reminderFile()): Promise<Reminder[]> {
  const rows = await loadTable(file);
  return rows.sort(byDeadline).map((row) => structuredClone(row));
}

export async function remove(
  id: string,
  file = reminderFile(),
): Promise<Reminder> {
  return mutate(file, async () => {
    const rows = await loadTable(file);
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1)
      throw new ReminderNotFoundError(
        `${file}: reminder ${JSON.stringify(id)} not found`,
      );
    const [removed] = rows.splice(index, 1);
    await saveTable(file, rows);
    return structuredClone(removed);
  });
}

/**
 * Срабатывание: pending-строки со сроком не позже nowMs переходят в fired и получают
 * firedAt — один атомарный переход под локом, поэтому два тика не могут взять одну строку.
 * Повторяющаяся строка тем же переходом пересчитывается на следующий срок и остаётся
 * pending: её факт срабатывания (firedAt) уже проставлен, а доставку допишет ребёнок.
 *
 * Расписание, которое croner отвергает (в файл могло попасть что угодно), не роняет тик и
 * не крутит строку: она уходит в fired с ошибкой в поле error — владелец увидит её в
 * remind list и iva doctor, а сама строка больше не сработает.
 */
export async function fireDue(
  nowMs: number,
  limit: number,
  file = reminderFile(),
): Promise<Reminder[]> {
  if (!isSafeInt(nowMs) || nowMs < 0)
    fail(
      file,
      `nowMs must be a safe integer >= 0, got ${JSON.stringify(nowMs)}`,
    );
  if (!isSafeInt(limit) || limit < 1)
    fail(
      file,
      `limit must be a safe integer >= 1, got ${JSON.stringify(limit)}`,
    );

  return mutate(file, async () => {
    const rows = await loadTable(file);
    const due = rows
      .filter(
        (row) =>
          row.status === "pending" &&
          row.nextRunAtMs <= nowMs &&
          !scheduleRunning(row, nowMs, file === commandFile()),
      )
      .sort(byDeadline)
      .slice(0, limit);
    if (due.length === 0) return [];

    for (const row of due) {
      if (file === commandFile())
        row.running_timeout_minutes = row.timeout_minutes ?? 2;
      row.firedAt = nowMs;
      row.delivered = null;
      row.error = null;
      row.sessionId = null;
      if (row.schedule.kind === "cron") {
        try {
          row.nextRunAtMs = nextCronRunMs(
            row.schedule.expr,
            row.schedule.tz,
            nowMs,
            file === commandFile(),
          );
        } catch (error) {
          row.status = "fired";
          row.error = `cron: ${(error as Error).message}`;
          row.delivered = false;
        }
      } else {
        row.status = "fired";
      }
    }
    await saveTable(file, rows);
    return due.map((row) => structuredClone(row));
  });
}

/**
 * Правка строки срабатывания под локом. Результат принимается только за своё срабатывание:
 * запоздалый ответ старого срока иначе переписал бы факт нового — такой ответ уходит в журнал
 * и отбрасывается. Успех не стирает уже записанную причину: её называют сами обновления.
 */
async function updateFiringRow(
  id: string,
  firing: {
    readonly firedAt: number | null;
    /** Что именно пишут — только ради строки журнала об отброшенном результате. */
    readonly what: string;
  },
  options: ReminderRecordOptions,
  update: (row: Reminder) => void,
): Promise<Reminder> {
  const { firedAt, what } = firing;
  const file = options.file ?? reminderFile();
  return mutate(file, async () => {
    const rows = await loadTable(file);
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined)
      throw new ReminderNotFoundError(
        `${file}: reminder ${JSON.stringify(id)} not found`,
      );
    if (row.firedAt !== firedAt) {
      recordLog(options)(
        `reminders: ${id} ${what} for firedAt=${firedAt} ignored: current firedAt=${row.firedAt}`,
      );
      return structuredClone(row);
    }
    update(row);
    options.onRecord?.();
    await saveTable(file, rows);
    return structuredClone(row);
  });
}

/**
 * Факт отправки: провал отправки называет свою причину (она и есть главная для владельца),
 * `delivered: null` — факта нет (текст мог уйти, а запись не состояться): строка остаётся
 * без факта, `error` называет причину.
 */
export async function recordDelivery(
  id: string,
  outcome: {
    readonly firedAt: number | null;
    readonly delivered: boolean | null;
    readonly error: string | null;
  },
  options: ReminderRecordOptions = {},
): Promise<Reminder> {
  return updateFiringRow(
    id,
    { firedAt: outcome.firedAt, what: "delivery result" },
    options,
    (row) => {
      row.delivered = outcome.delivered;
      if (outcome.error !== null) row.error = outcome.error;
    },
  );
}

/**
 * Сессия идущего хода. Пишется до клейма чата: тик снимает запись убитого ребёнка только
 * по ней, и запись без сессии он бы не нашёл.
 */
export async function recordTurnSession(
  id: string,
  session: {
    readonly firedAt: number | null;
    readonly sessionId: string;
  },
  options: ReminderRecordOptions = {},
): Promise<Reminder> {
  return updateFiringRow(
    id,
    { firedAt: session.firedAt, what: "turn session" },
    options,
    (row) => {
      row.sessionId = session.sessionId;
    },
  );
}

/** Журнал отброшенного результата: по умолчанию в stdout, как у планировщика. */
export interface ReminderRecordOptions {
  readonly onRecord?: () => void;
  readonly file?: string;
  readonly log?: (...args: unknown[]) => void;
}

function recordLog(
  options: ReminderRecordOptions,
): (...args: unknown[]) => void {
  return (
    options.log ??
    ((...args: unknown[]) => console.log(new Date().toISOString(), ...args))
  );
}

/** Уборка: сработавшие разовые строки живут сутки — столько владелец видит факт. */
export async function sweepFired(
  nowMs: number,
  keepMs: number = REMINDER_FIRED_KEEP_MS,
  file = reminderFile(),
): Promise<number> {
  return mutate(file, async () => {
    const rows = await loadTable(file);
    const kept = rows.filter(
      (row) =>
        !(
          row.status === "fired" &&
          row.firedAt !== null &&
          row.firedAt <= nowMs - keepMs
        ),
    );
    const swept = rows.length - kept.length;
    if (swept > 0) await saveTable(file, kept);
    return swept;
  });
}

/** Commands use the same table engine in a file older releases never open. */
export const commandFile = (): string =>
  join(dataDir(), "schedule-commands.json");

/** Move and run_now share the claim lock. Prior firing facts stay visible. */
export async function reschedule(
  id: string,
  input: Partial<ReminderInput> & { nowMs: number },
  file = reminderFile(),
): Promise<Reminder> {
  return mutate(file, async () => {
    const rows = await loadTable(file);
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new ReminderNotFoundError(`schedule ${id} not found`);
    if (input.schedule !== undefined) {
      const schedule = normalizeSchedule(input.schedule);
      row.nextRunAtMs = assertFirstRun(file, id, schedule, input.nextRunAtMs);
      row.schedule = schedule;
    } else row.nextRunAtMs = assertTime(file, id, "nowMs", input.nowMs);
    if (input.timeout_minutes !== undefined)
      row.timeout_minutes = input.timeout_minutes;
    assertReminder(file, row);
    row.status = "pending";
    await saveTable(file, rows);
    return structuredClone(row);
  });
}

export const commandLog = (id: string): string =>
  join(
    dataDir(),
    `schedule-${createHash("sha256").update(id).digest("hex").slice(0, 16)}.log`,
  );

export const COMMAND_TIMEOUT_MS = 120_000;
export const commandTimeoutMs = (row: Reminder) =>
  (row.running_timeout_minutes ?? row.timeout_minutes ?? 2) * 60_000;
export const scheduleRunning = (
  row: Reminder,
  now = Date.now(),
  command = false,
): boolean => {
  const pulse =
    !command &&
    row.sessionId &&
    listChatStatuses().find(
      ({ status }) =>
        status.sessionId === row.sessionId && status.status === "running",
    )?.status.updatedAt;
  const span = command ? commandTimeoutMs(row) + 10_000 : RUN_STALE_MS;
  return (
    row.firedAt !== null &&
    row.delivered === null &&
    now < (pulse || row.firedAt) + span
  );
};

export async function clearCommandAlert(id: string): Promise<void> {
  const file = join(dataDir(), "alert-state.json");
  await mutate(
    file,
    async () => {
      const state = await loadJsonStrict<unknown>(file, {});
      if (!isPlainObject(state) || !Object.hasOwn(state, `schedule-${id}`))
        return;
      delete state[`schedule-${id}`];
      await saveJsonAtomic(file, state, { mode: 0o600 });
    },
    join(dataDir(), "alert-state.lock"),
  );
}
