// Общее состояние «идёт ли сейчас ход» per chatKey — мост (telegram-poll.mjs) и
// канал (agent/channels/telegram.ts) читают/пишут файлы data/run-status.d/*.json.
//
// Зачем: мост решает, доставлять сообщение в eve или буферизовать (агент занят),
// пишет сюда пульс живого хода, чтобы жнец моста не снял его как протухший.
// Отдельный файл на chatKey не даёт параллельной записи одного чата потерять статус
// другого. Запись одного ключа защищена O_EXCL-локом и атомарна (unique tmp+rename).
// ЛЮБАЯ успешная запись двигает generation и updatedAt — на updatedAt держится и
// жнец, и пульс (agent/lib/telegram-turn-start.ts). Одно исключение — запись входа очереди
// (setChatStatusIf с touch: false): она не продлевает жизнь чужому ходу.
//
// chatKey = `${chatId}:${threadId ?? ""}` — тот же ключ, что chatKey() Bridge.

import { readFileSync, readdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  acquireFileLockSync,
  releaseFileLock,
  writeFileAtomicSync,
  type FileLock,
} from "./fs-atomic.ts";
import { dataDir } from "./data-dir.ts";

// ── Запись чата: одно объединение состояний (specs/ChatRecord.tla) ────────────────────────
// Формат файла прежний: плоский JSON с теми же именами полей. Незнакомое поле остаётся
// в файле как есть — его могла записать другая версия. Схема без внешних пакетов:
// восстановление перед стартом сервиса грузит этот файл раньше всего остального.
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number =>
  typeof v === "number" && !Number.isNaN(v);
const mark = (v: unknown): v is true => v === true;
const bool = (v: unknown): v is boolean => typeof v === "boolean";
const legacy = (v: unknown): v is unknown => v !== null;

export type TelegramSessionRetirement = {
  replayMs: number;
  sessionId: string;
  turnId: string;
};
const retirement = (v: unknown): v is TelegramSessionRetirement =>
  parseTelegramSessionRetirement(v) !== null;

/** Поля хода: заполнены, только пока чат держит ход, принятый вход или свёртка. */
const turnFields = {
  ingressId: text,
  ingressAt: num,
  sessionId: text,
  turnId: text,
  draftId: num,
  turnAt: num,
  firstOutputAt: num,
  latencyLogged: mark,
  progressClaimed: mark,
  compacting: mark,
};
/** Отметки: переживают конец хода и не говорят, занят ли чат. */
const markFields = {
  status: (v: unknown): v is "idle" | "running" =>
    v === "idle" || v === "running",
  generation: (v: unknown): v is number =>
    Number.isSafeInteger(v) && Number(v) >= 0,
  updatedAt: num,
  wasCancelled: mark,
  resetAt: num,
  turnQuestion: str,
  turnQuestionMedia: bool,
  queuedIngressId: text,
  queuedIngressAt: num,
  queuedSessionId: text,
  pendingInputRequestIds: (v: unknown): v is string[] =>
    Array.isArray(v) && v.length > 0 && v.every(text),
  pendingInputSessionId: text,
  retireAfterTurn: retirement,
  retiredSessionId: text,
  restartRetryData: str,
  restartRetryUpdate: num,
  restartRetryQuestion: str,
  restartRetryMedia: bool,
  // Следы индикаторов версий до 0.5.0: уходят, когда меняется пара хода.
  statusMessageId: legacy,
  statusAt: legacy,
  queuedStatusMessageId: legacy,
  queuedStatusAt: legacy,
};
const fieldChecks: Record<string, (v: unknown) => boolean> = {
  ...turnFields,
  ...markFields,
};
type Checked<T> = {
  [K in keyof T]: T[K] extends (v: unknown) => v is infer U ? U : never;
};
type TurnFields = Checked<typeof turnFields>;
type TurnField = keyof TurnFields;
type Marks = Partial<Omit<Checked<typeof markFields>, "status">>;
type Running<Own extends TurnField, Absent extends TurnField> = Marks & {
  status: "running";
} & Pick<TurnFields, Own> &
  Partial<Omit<TurnFields, Own | Absent>> & { [K in Absent]?: undefined };

// Инварианты строки (TurnFieldsOnlyWhenBusy): какие поля хода состояние обязано нести и
// каких нести не может. Свободный чат не несёт ни одного; у принятого входа есть ingressId
// и ещё нет сессии, а значит нет ни хода, ни свёртки; свёртка идёт под сессией и без хода.
const turnFieldNames = Object.keys(turnFields) as TurnField[];
const rowRules: Record<
  "free" | "accepted" | "turn" | "compacting",
  { own: readonly TurnField[]; absent: readonly TurnField[] }
> = {
  free: { own: [], absent: turnFieldNames },
  accepted: { own: ["ingressId"], absent: ["turnId", "compacting"] },
  turn: { own: ["sessionId"], absent: ["compacting"] },
  compacting: { own: ["sessionId", "compacting"], absent: ["turnId"] },
};
export type ChatRecord =
  | (Marks & { status?: "idle" } & { [K in TurnField]?: undefined })
  | Running<"ingressId", "sessionId" | "turnId" | "compacting">
  | Running<"sessionId", "compacting">
  | Running<"sessionId" | "compacting", "turnId">;
type ChatRecordFields = Partial<Checked<typeof markFields> & TurnFields>;
/** Ожидание CAS: поле сравнивается с записью; `undefined` значит «поля нет». */
export type ChatRecordExpected = ChatRecordFields;
/** Частичная запись: `null` убирает поле. */
export type ChatRecordPatch = {
  [K in keyof ChatRecordFields]?: ChatRecordFields[K] | null;
};

/** Состояние чата. Занят: accepted, turn, compacting. Остальные Bridge считает свободными. */
export type ChatState =
  | "free"
  | "awaiting-owner"
  | "retry-offered"
  | "retiring"
  | "accepted"
  | "turn"
  | "compacting"
  | "stale";

type RawRecord = Record<string, unknown>;
const rowOf = (raw: RawRecord): keyof typeof rowRules =>
  raw.status !== "running"
    ? "free"
    : raw.compacting !== undefined
      ? "compacting"
      : raw.sessionId !== undefined
        ? "turn"
        : "accepted";

/** Что в записи нарушает схему: `поле: причина`. Пусто — запись верна. */
export function chatRecordViolations(raw: RawRecord): string[] {
  const row = rowOf(raw);
  const { own, absent } = rowRules[row];
  return [
    ...Object.keys(fieldChecks)
      .filter(
        (field) => raw[field] !== undefined && !fieldChecks[field](raw[field]),
      )
      .map((field) => `${field}: wrong type`),
    ...absent
      .filter((field) => raw[field] !== undefined)
      .map((field) => `${field}: not allowed on a ${row} chat`),
    ...own
      .filter((field) => raw[field] === undefined)
      .map((field) => `${field}: required on a ${row} chat`),
  ];
}

// Запись без нарушающих полей. Чего не исправить удалением поля (running без владельца),
// остаётся как есть: такую запись снимет жнец.
function repairedRecord(raw: RawRecord): ChatRecord {
  let record = raw;
  for (let pass = 0; pass < 3; pass++) {
    const violations = chatRecordViolations(record);
    if (violations.length === 0) break;
    record = { ...record };
    for (const violation of violations) delete record[violation.split(":")[0]];
  }
  return record;
}

// Писатель, нарушивший инвариант строки: в тесте (node --test) — ошибка на записи; в живом
// процессе запись уходит без нарушающих полей, а нарушение названо в журнале сервиса.
const STRICT_RECORDS = process.env.NODE_TEST_CONTEXT !== undefined;
function enforcedRecord(chatKey: string, next: RawRecord): ChatRecord {
  const violations = chatRecordViolations(next);
  if (violations.length === 0) return next;
  const message = `chat record ${chatKey} breaks TurnFieldsOnlyWhenBusy (specs/ChatRecord.tla): ${violations.join("; ")}`;
  if (STRICT_RECORDS) throw new Error(message);
  console.error(`[run-status] ${message}; the fields are dropped`);
  return repairedRecord(next);
}

const errorCode = (error: unknown): string | undefined =>
  error !== null && typeof error === "object" && "code" in error
    ? typeof error.code === "string"
      ? error.code
      : undefined
    : undefined;

// Путь от cwd, как в usage.ts, а НЕ от import.meta.url: канал инлайнится в кэш
// authored-modules eve, откуда «две папки вверх» указывают в node_modules/.cache.
const DATA_DIR = dataDir();
const STATUS_DIR = join(DATA_DIR, "run-status.d");
const positiveMs = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const LOCK_STALE_MS = positiveMs(
  process.env.IVA_RUN_STATUS_LOCK_STALE_MS,
  30_000,
);
const LOCK_TIMEOUT_MS = positiveMs(
  process.env.IVA_RUN_STATUS_LOCK_TIMEOUT_MS,
  5_000,
);
const LOCK_RETRY_MS = 10;

// Вход очереди хранит время и сессию сообщения, ожидающего живой ход.
// Следующий ход забирает свой вход; reset и захват очищают поля одним патчем.
export const QUEUED_STATUS_CLEARED = {
  queuedIngressId: null,
  queuedIngressAt: null,
  queuedSessionId: null,
} as const;

// Освобождение чата снимает все поля хода одним патчем (TurnFieldsOnlyWhenBusy,
// specs/ChatRecord.tla): писатель, перечисляющий поля сам, забывает одно из них.
export const TURN_FIELDS_CLEARED = {
  ingressId: null,
  ingressAt: null,
  sessionId: null,
  turnId: null,
  draftId: null,
  turnAt: null,
  firstOutputAt: null,
  latencyLogged: null,
  progressClaimed: null,
  compacting: null,
} as const satisfies Record<TurnField, null>;

// Ход длиннее этого считаем зависшим/осиротевшим (упал без terminal-события):
// мост перестаёт буферизовать, чтобы сообщения не копились вечно.
export const RUN_STALE_MS = Number(
  process.env.IVA_RUN_STALE_MS ?? 30 * 60 * 1000,
);

export function chatKeyOf(
  chatId: string | number,
  threadId?: string | number | null,
): string {
  return `${chatId}:${threadId ?? ""}`;
}

function statusFileOf(chatKey: string): string {
  return join(
    STATUS_DIR,
    `${Buffer.from(chatKey, "utf8").toString("base64url")}.json`,
  );
}

function readObject(file: string): RawRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      const error = new Error(`${file} does not contain a JSON object`);
      Object.assign(error, { code: "ERR_RUN_STATUS_SCHEMA" });
      throw error;
    }
    return parsed as RawRecord;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function isCorruptStatus(error: unknown): boolean {
  return (
    error instanceof SyntaxError || errorCode(error) === "ERR_RUN_STATUS_SCHEMA"
  );
}

function readPerChat(chatKey: string): ChatRecord | null {
  const file = statusFileOf(chatKey);
  try {
    const raw = readObject(file);
    return raw === null ? null : repairedRecord(raw);
  } catch (error) {
    if (!isCorruptStatus(error)) throw error;
    const backup = `${file}.corrupt-${Date.now()}-${randomUUID()}`;
    try {
      renameSync(file, backup);
    } catch (error) {
      // Another process may have quarantined the same file after our read.
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return null;
  }
}

// Статус хода — не публичные данные: и лок, и сам файл создаются под 0600.
export function acquireChatLock(
  file: string,
  staleMs = LOCK_STALE_MS,
): FileLock {
  const lock = `${file}.lock`;
  const held = acquireFileLockSync(lock, {
    timeoutMs: LOCK_TIMEOUT_MS,
    staleMs,
    retryMs: LOCK_RETRY_MS,
    mode: 0o600,
  });
  if (held === null) throw new Error(`run-status lock timeout: ${lock}`);
  return held;
}

function writeCurrent(file: string, value: ChatRecord): void {
  writeFileAtomicSync(file, JSON.stringify(value), { mode: 0o600 });
}

export function getChatStatus(chatKey: string): ChatRecord | null {
  return readPerChat(chatKey);
}

// Снимок всех per-chat записей для фонового обслуживания мостом.
// Служебные lock/tmp/corrupt файлы и legacy whole-map сюда не попадают.
export function listChatStatuses(): Array<{
  chatKey: string;
  status: ChatRecord;
}> {
  let names: string[];
  try {
    names = readdirSync(STATUS_DIR);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }

  const records: Array<{ chatKey: string; status: ChatRecord }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const encoded = name.slice(0, -".json".length);
    if (encoded.length === 0) continue;
    const chatKey = Buffer.from(encoded, "base64url").toString("utf8");
    if (statusFileOf(chatKey) !== join(STATUS_DIR, name)) continue;
    const value = readPerChat(chatKey);
    if (value) records.push({ chatKey, status: value });
  }
  return records;
}

const pendingInputIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (requestId): requestId is string =>
          typeof requestId === "string" && requestId.length > 0,
      )
    : [];

export function hasTelegramPendingInputRequests(
  chatKey: string,
  sessionId: string,
): boolean {
  const status = getChatStatus(chatKey);
  return (
    status?.pendingInputSessionId === sessionId &&
    pendingInputIds(status.pendingInputRequestIds).length > 0
  );
}

export function updateTelegramPendingInputRequests(
  sessionId: string,
  {
    requested = [],
    resolved = [],
  }: { requested?: readonly string[]; resolved?: readonly string[] },
): boolean {
  let failedChatKey: string | null = null;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const records = listChatStatuses();
      for (const { chatKey, status } of records) {
        const ownsSession = status.sessionId === sessionId;
        const ownsPending = status.pendingInputSessionId === sessionId;
        if (
          (!ownsSession && !ownsPending) ||
          (resolved.length > 0 && !ownsPending)
        )
          continue;
        failedChatKey = chatKey;

        const pending = new Set(
          ownsPending ? pendingInputIds(status.pendingInputRequestIds) : [],
        );
        for (const requestId of requested) {
          if (requestId.length > 0) pending.add(requestId);
        }
        for (const requestId of resolved) pending.delete(requestId);
        const next = [...pending];
        const updated = setChatStatusIf(
          chatKey,
          { generation: status.generation },
          {
            pendingInputRequestIds: next.length > 0 ? next : null,
            pendingInputSessionId: next.length > 0 ? sessionId : null,
          },
        );
        if (updated) return true;
        break;
      }
    }
  } catch (error) {
    console.error(
      `[telegram] pending input state update failed for chatKey ${failedChatKey ?? "not-found"}, session ${sessionId}:`,
      error,
    );
    return false;
  }
  console.error(
    `[telegram] pending input state update failed for chatKey ${failedChatKey ?? "not-found"}, session ${sessionId}`,
  );
  return false;
}

/**
 * Состояние чата по записи — единственное место, где оно выводится из полей. Занятый чат
 * (ход, принятый вход, свёртка) с записью старше срока — `stale`: его снимет жнец Bridge.
 * У свободного чата отметки читаются по старшинству: покой сессии, предложенный повтор,
 * открытый вопрос владельцу.
 */
export function chatState(
  record: ChatRecord | null | undefined,
  now = Date.now(),
  staleMs = RUN_STALE_MS,
): ChatState {
  if (record?.status === "running") {
    if (
      typeof record.updatedAt !== "number" ||
      now - record.updatedAt >= staleMs
    )
      return "stale";
    if (record.compacting === true) return "compacting";
    return record.sessionId === undefined ? "accepted" : "turn";
  }
  if (!record) return "free";
  if (record.retireAfterTurn !== undefined) return "retiring";
  if (record.restartRetryData !== undefined) return "retry-offered";
  return record.pendingInputSessionId !== undefined &&
    pendingInputIds(record.pendingInputRequestIds).length > 0
    ? "awaiting-owner"
    : "free";
}

/** Чат занят: Bridge держит новые сообщения в очереди. */
export const chatBusy = (state: ChatState): boolean =>
  state === "turn" || state === "accepted" || state === "compacting";

/** Запись держит чат: занят либо завис и ждёт жнеца. */
export const chatHeld = (state: ChatState): boolean =>
  chatBusy(state) || state === "stale";

// true, когда по chatKey реально идёт ход или свёртка между ходами (running и не протух).
export function isRunning(chatKey: string, now = Date.now()): boolean {
  return chatBusy(chatState(getChatStatus(chatKey), now));
}

// true, когда чат занят свёрткой между ходами (agent/lib/idle-compaction.ts): запись
// running несёт compacting: true. Срок у неё тот же, что у хода.
export function isCompacting(chatKey: string, now = Date.now()): boolean {
  return chatState(getChatStatus(chatKey), now) === "compacting";
}

// Чем запись метит updatedAt: обычная — временем записи, запись знака очереди — прежним.
type Stamp = (prev: ChatRecord) => number | undefined;
const stampNow: Stamp = () => Date.now();
const keepStamp: Stamp = (prev) => prev.updatedAt;

function updateChatStatus(
  chatKey: string,
  patch: ChatRecordPatch,
  expected: ChatRecordExpected | null,
  stamp: Stamp,
): ChatRecord | null {
  const file = statusFileOf(chatKey);
  const lock = acquireChatLock(file);
  try {
    // Запись читается из своего per-chat файла; общий `run-status.json` выпусков ниже
    // границы сюда не попадает: его переводит в per-chat записи ступенька обновления
    // (`repair.sh:step_converts`), до того как эта версия начнёт работать.
    const prev: RawRecord = readPerChat(chatKey) ?? {};
    if (
      expected &&
      Object.entries(expected).some(
        ([key, value]) => !Object.is(prev[key], value),
      )
    ) {
      return null;
    }
    const previousGeneration =
      typeof prev.generation === "number" &&
      Number.isSafeInteger(prev.generation) &&
      prev.generation >= 0
        ? prev.generation
        : 0;
    const next: RawRecord = {
      ...prev,
      ...patch,
      generation: previousGeneration + 1,
      updatedAt: stamp(prev),
    };
    // Keep inherited message IDs through heartbeats until the bridge can delete
    // them. A terminal record or a different pair must retire the old Stop key.
    if (
      next.status !== "running" ||
      next.sessionId !== prev.sessionId ||
      next.turnId !== prev.turnId
    )
      for (const field of [
        "statusMessageId",
        "statusAt",
        "queuedStatusMessageId",
        "queuedStatusAt",
      ])
        delete next[field];
    for (const key of Object.keys(next))
      if (next[key] === null) delete next[key];
    const record = enforcedRecord(chatKey, next);
    writeCurrent(file, record);
    return record;
  } finally {
    releaseFileLock(lock);
  }
}

// Частичное обновление записи chatKey; null-поля в patch удаляют ключ.
export function setChatStatus(
  chatKey: string,
  patch: ChatRecordPatch,
): ChatRecord {
  return updateChatStatus(chatKey, patch, null, stampNow) as ChatRecord;
}

// Atomic compare-and-set для terminal Eve events: reset может успеть удалить
// sessionId между ранним read и записью позднего события. touch: false — запись, которая не
// говорит «ход жив» (вход очереди), updatedAt не двигает: иначе запись мёртвого хода
// прожила бы ещё RUN_STALE_MS. generation растёт всегда — на нём держатся CAS.
export function setChatStatusIf(
  chatKey: string,
  expected: ChatRecordExpected,
  patch: ChatRecordPatch,
  options?: { touch?: boolean },
): ChatRecord | null {
  return updateChatStatus(
    chatKey,
    patch,
    expected,
    options?.touch === false ? keepStamp : stampNow,
  );
}

export function parseTelegramSessionRetirement(
  value: unknown,
): TelegramSessionRetirement | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const { replayMs, sessionId, turnId } = value as RawRecord;
  if (
    typeof replayMs !== "number" ||
    !Number.isFinite(replayMs) ||
    replayMs < 0 ||
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    typeof turnId !== "string" ||
    turnId.length === 0
  ) {
    return null;
  }
  return { replayMs, sessionId, turnId };
}

// Хук знает sessionId, а Bridge адресует reset по chatKey. Единственный мост между
// ними - уже существующий run-status.d, где running-сессия привязана к chatKey.
export function markTelegramSessionForRetirement(
  sessionId: string,
  turnId: string,
  replayMs: number,
  {
    listStatusesImpl = listChatStatuses,
    setStatusIfImpl = setChatStatusIf,
  }: {
    listStatusesImpl?: typeof listChatStatuses;
    setStatusIfImpl?: typeof setChatStatusIf;
  } = {},
): boolean {
  for (const { chatKey, status } of listStatusesImpl()) {
    if (
      status.status !== "running" ||
      status.sessionId !== sessionId ||
      status.turnId !== turnId ||
      status.retiredSessionId === sessionId ||
      status.retireAfterTurn !== undefined
    ) {
      continue;
    }
    const updated = setStatusIfImpl(
      chatKey,
      {
        status: "running",
        generation: status.generation,
        updatedAt: status.updatedAt,
        sessionId,
        turnId,
        retireAfterTurn: undefined,
      },
      { retireAfterTurn: { replayMs, sessionId, turnId } },
    );
    if (updated) return true;
  }
  return false;
}
