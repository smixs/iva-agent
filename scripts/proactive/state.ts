// Состояние Watch — data/proactive.json (ADR-0020). Своей очереди событий нет: непрочитанное
// держат Telegram и Gmail, здесь только что уже видели и сообщили (`seen`) и счётчики дня.
//
// Чтение своё, по образцу readStatus (agent/lib/schedule-runner.ts): нет файла — начальное
// состояние; битый, нечитаемый, чужой формат или версия новее — ошибка без переименования,
// файл остаётся на месте до починки (loadJsonStrict переименовал бы его, а следующий прогон
// принял бы всё непрочитанное за новое). Запись — целым объектом через saveJsonAtomic.
import { readFileSync, unlinkSync } from "node:fs";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";
import { saveJsonAtomic } from "#lib/json-store.ts";
import { zonedParts } from "#lib/zoned-time.ts";

const PROACTIVE_SCHEMA_VERSION = 1;

export type SeenEntry = {
  readonly firstSeenMs: number;
  readonly unread: number;
  readonly reported: boolean;
};

/** Счётчик одного дня; день — дата в зоне владельца, другой день — ноль. */
export type DayCount = { readonly day: string; readonly count: number };

/**
 * Insight (ADR-0022); поля нет — Insight ещё не было, файл старой версии читается. Файл версии с
 * недельной паузой несёт ещё `misses` и `pausedUntilMs`: они читаются и больше ничего не значат.
 */
export type InsightState = {
  readonly day: string; // день заявки в зоне владельца; "" — не было
  readonly draft: string; // имя черновика доставленного инсайта; "?" — имя не годится; "" — QUIET
  /**
   * Отпечаток черновика в минуту отправки (`pluginTreeDigest(...).slice(0, 12)`): по нему
   * неинтерактивный `iva plugin add` ставит ровно тот черновик, что был в сообщении. Нет поля —
   * сверки нет (файл прошлой версии, QUIET, имя «?» или отпечаток не посчитался).
   */
  readonly tree?: string;
};

type WatchSignal = {
  readonly messageIds: readonly number[];
  readonly deliveredAtMs: number;
  readonly status: "delivered" | "closing" | "closed";
  readonly closeText?: string;
};

export type ProactiveState = {
  /** Optional in v1: older versions ignore this field on rollback. */
  readonly signals?: Readonly<Record<string, WatchSignal>>;
  readonly receiptCursor?: number;
  readonly schemaVersion: number;
  readonly seen: Readonly<Record<string, SeenEntry>>;
  readonly wakes: DayCount;
  readonly modelWakes: DayCount;
  readonly briefDone: {
    readonly day: string;
    readonly slots: readonly number[];
  };
  readonly failuresSeenUpToMs: number;
  readonly insight?: InsightState;
};

class ProactiveStateError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Начальное состояние первого прогона: сбои последних суток ещё впереди. */
export function initialState(now: number): ProactiveState {
  return {
    schemaVersion: PROACTIVE_SCHEMA_VERSION,
    seen: {},
    wakes: { day: "", count: 0 },
    modelWakes: { day: "", count: 0 },
    briefDone: { day: "", slots: [] },
    failuresSeenUpToMs: now - DAY_MS,
  };
}

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function isDayCount(value: unknown): value is DayCount {
  const v = value as Partial<DayCount> | null;
  return typeof v?.day === "string" && isCount(v.count);
}

function isSeenEntry(value: unknown): value is SeenEntry {
  const v = value as Partial<SeenEntry> | null;
  return (
    typeof v?.firstSeenMs === "number" &&
    Number.isFinite(v.firstSeenMs) &&
    isCount(v.unread) &&
    typeof v.reported === "boolean"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Поля Insight; `tree` необязателен — файл без него (прошлая версия) годится. */
const isInsightFields = (value: Record<string, unknown>): boolean =>
  typeof value.day === "string" &&
  typeof value.draft === "string" &&
  (value.tree === undefined || typeof value.tree === "string");

/** Поле `insight` необязательно: его нет — годится. */
const isInsight = (value: unknown): boolean =>
  value === undefined || (isObject(value) && isInsightFields(value));

function isBriefDone(value: unknown): boolean {
  const brief = value as Partial<ProactiveState["briefDone"]> | null;
  return (
    typeof brief?.day === "string" &&
    Array.isArray(brief.slots) &&
    brief.slots.every(isCount)
  );
}

function isSignals(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isObject(value)) return false;
  return Object.entries(value).every(([key, entry]) => {
    if (!key.startsWith("tg:") || !isObject(entry)) return false;
    return (
      Array.isArray(entry.messageIds) &&
      entry.messageIds.length > 0 &&
      entry.messageIds.every((id) => isCount(id) && id > 0) &&
      typeof entry.deliveredAtMs === "number" &&
      Number.isFinite(entry.deliveredAtMs) &&
      (entry.closeText === undefined || typeof entry.closeText === "string") &&
      ["delivered", "closing", "closed"].includes(String(entry.status))
    );
  });
}

function isState(value: Record<string, unknown>): boolean {
  return (
    isObject(value.seen) &&
    isSignals(value.signals) &&
    (value.receiptCursor === undefined || isCount(value.receiptCursor)) &&
    isDayCount(value.wakes) &&
    isDayCount(value.modelWakes) &&
    isBriefDone(value.briefDone) &&
    isInsight(value.insight) &&
    typeof value.failuresSeenUpToMs === "number" &&
    Number.isFinite(value.failuresSeenUpToMs)
  );
}

/** Состояние с диска; нет файла — null. Остальное, кроме своего формата, — ошибка с путём. */
export function readProactiveState(path: string): ProactiveState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ProactiveStateError(
      `${path} unreadable or damaged: ${(error as Error).message}`,
    );
  }
  const version = isObject(parsed) ? parsed.schemaVersion : undefined;
  if (typeof version === "number" && version > PROACTIVE_SCHEMA_VERSION)
    throw new ProactiveStateError(
      `${path} has schemaVersion ${version}, newer than ${PROACTIVE_SCHEMA_VERSION}: written by a newer Iva`,
    );
  if (
    version !== PROACTIVE_SCHEMA_VERSION ||
    !isState(parsed as Record<string, unknown>)
  )
    throw new ProactiveStateError(`${path} is not in the proactive state form`);
  const state = parsed as ProactiveState;
  const seen = Object.fromEntries(
    Object.entries(state.seen).filter(([, entry]) => {
      if (isSeenEntry(entry)) return true;
      console.error(`${path}: damaged seen entry removed`);
      return false;
    }),
  );
  return recoverSignalReceipts(path, { ...state, seen });
}

export async function writeProactiveState(
  path: string,
  state: ProactiveState,
): Promise<void> {
  await saveJsonAtomic(path, state, { mode: 0o600 });
  if (state.receiptCursor === undefined) return;
  const receipts = readReceipts(path);
  if (receipts.some((receipt) => receipt.seq > state.receiptCursor!)) return;
  try {
    unlinkSync(`${path}.receipts`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

type Receipt = { seq: number; key: string; id: number; at: number };
function readReceipts(path: string): Receipt[] {
  let text: string;
  try {
    text = readFileSync(`${path}.receipts`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: unknown = JSON.parse(text);
  if (!Array.isArray(records))
    throw new ProactiveStateError(`${path}: invalid receipt journal`);
  return records.map((r: Receipt) => {
    if (
      !isCount(r.seq) ||
      !isCount(r.id) ||
      r.id === 0 ||
      !/^tg:-?\d+$/u.test(r.key) ||
      !Number.isFinite(r.at)
    )
      throw new ProactiveStateError(`${path}: invalid signal receipt`);
    return r;
  });
}

/** Synchronous durable receipt: success is exposed to Outbox only after atomic write+fsync. */
export function recordSignalReceipt(
  path: string,
  key: string,
  id: number,
  at: number,
): void {
  const receipts = readReceipts(path);
  if (receipts.some((receipt) => receipt.key === key && receipt.id === id))
    return;
  const stateCursor = readProactiveState(path)?.receiptCursor ?? 0;
  const seq =
    Math.max(stateCursor, ...receipts.map((receipt) => receipt.seq)) + 1;
  writeFileAtomicSync(
    `${path}.receipts`,
    JSON.stringify([...receipts, { seq, key, id, at }]),
    { mode: 0o600 },
  );
}

/** Replay receipts newer than the durable projection; old receipts never reopen a signal. */
export function recoverSignalReceipts(
  path: string,
  state: ProactiveState,
): ProactiveState {
  let current = state;
  for (const receipt of readReceipts(path)) {
    if (receipt.seq <= (current.receiptCursor ?? 0)) continue;
    const previous = current.signals?.[receipt.key];
    const ids = previous?.status === "delivered" ? previous.messageIds : [];
    current = {
      ...current,
      receiptCursor: receipt.seq,
      signals: {
        ...current.signals,
        [receipt.key]: {
          messageIds: [...new Set([...ids, receipt.id])],
          deliveredAtMs: receipt.at,
          status: "delivered",
        },
      },
    };
  }
  return current;
}

/** День владельца (`YYYY-MM-DD`), час и минута в его зоне. */
export function localDay(now: number, timeZone: string) {
  const { y, m, d, hh, mm } = zonedParts(now, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { day: `${y}-${pad(m)}-${pad(d)}`, hour: hh, minute: mm };
}

/** Сколько насчитано сегодня. */
export function countToday(counter: DayCount, day: string): number {
  return counter.day === day ? counter.count : 0;
}

/** Счётчик дня плюс один. */
export function bump(counter: DayCount, day: string): DayCount {
  return { day, count: countToday(counter, day) + 1 };
}

/**
 * Обновление `seen` (шаг 4): новый ключ — `firstSeenMs = now`, не сообщён; ключа нет в
 * источнике — запись уходит; у сообщённого вырос `unread` — снова не сообщён с `now`; меньше,
 * но больше нуля — новое число, `reported` прежний. `keep` — ключи источников, которые в этот
 * прогон не смотрели (ошибка или выключен): их записи не трогаются.
 */
export function updateSeen(
  seen: Readonly<Record<string, SeenEntry>>,
  observed: ReadonlyArray<{ readonly key: string; readonly unread: number }>,
  keep: (key: string) => boolean,
  now: number,
): Record<string, SeenEntry> {
  const next: Record<string, SeenEntry> = {};
  for (const [key, entry] of Object.entries(seen))
    if (keep(key)) next[key] = entry;
  for (const { key, unread } of observed) {
    const prev = Object.hasOwn(seen, key) ? seen[key] : undefined;
    next[key] =
      prev === undefined || (prev.reported && unread > prev.unread)
        ? { firstSeenMs: now, unread, reported: false }
        : { ...prev, unread };
  }
  return next;
}
