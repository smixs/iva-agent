// Поручения между ботами Ивы и коллег личными сообщениями (Bot API DM, ADR-0030, T911).
// Один durable-журнал с явной машиной состояний (docs/philosophy.md §10) и замком файла,
// соответствующий модели specs/GroupAndAssignments.tla:
//   - бот никогда не поручает задачу сам себе (NoSelfAssignment);
//   - поручение уходит личным сообщением бота-отправителя боту-получателю через Bot API;
//   - видимая строка о поручении уходит владельцу в чат коллеги ровно один раз (AtMostOneOwnerNotice);
//   - повтор доставки того же поручения после обрыва не запускает второй ход (NoDuplicateAssignment).
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { isRecord } from "../../packages/guards/index.ts";
import { notificationChat } from "../../packages/notification-chat/index.ts";
import {
  configuredTelegramBots,
  resolveTelegramBot,
  validTelegramBotId,
  type TelegramBotConfig,
} from "../../packages/telegram-bots/index.ts";
import {
  COLLEAGUE_ROLE_SPECS,
  currentSettingsFile,
  isColleaguesEnabled,
  readColleague,
} from "./colleagues.ts";
import { dataDir } from "./data-dir.ts";
import { tr } from "./i18n.ts";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "./json-store.ts";
import { redactNotice } from "./outbox.ts";

export const COLLEAGUE_ASSIGNMENT_PHASES = [
  "pending",
  "delivered",
  "done",
  "failed",
] as const;

export type ColleagueAssignmentPhase =
  (typeof COLLEAGUE_ASSIGNMENT_PHASES)[number];

export interface ColleagueAssignmentRecord {
  readonly id: string;
  readonly fromBotId: string;
  readonly toBotId: string;
  readonly task: string;
  readonly phase: ColleagueAssignmentPhase;
  readonly ownerNotified: boolean;
  readonly dmMessageId?: number;
  readonly ownerMessageId?: number;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

type AssignmentLedgerDocument = {
  readonly version: 1;
  readonly records: Record<string, ColleagueAssignmentRecord>;
};

const LEDGER_VERSION = 1 as const;
const MAX_LEDGER_RECORDS = 500;
const MAX_TASK_LENGTH = 3_500;
const OWNER_PREVIEW_LIMIT = 400;
const ASSIGNMENT_ID_PATTERN = /\[(?<id>asg_[a-f0-9]{12})\]/u;
const VALID_PHASE_SET = new Set<string>(COLLEAGUE_ASSIGNMENT_PHASES);
const DEFAULT_API_BASE_URL = "https://api.telegram.org";

export function currentAssignmentsFile(): string {
  return join(dataDir(), "colleague-assignments.json");
}

/** Единственная функция состояния поручения по записи (docs/philosophy.md §10). */
export function assignmentPhase(
  record: ColleagueAssignmentRecord,
): ColleagueAssignmentPhase {
  return record.phase;
}

function assertConsistentRecord(record: ColleagueAssignmentRecord): void {
  if (!record.id || record.id.length > 120) {
    throw new Error("inconsistent assignment row: invalid id");
  }
  if (!validTelegramBotId(record.fromBotId)) {
    throw new Error("inconsistent assignment row: invalid fromBotId");
  }
  if (!validTelegramBotId(record.toBotId)) {
    throw new Error("inconsistent assignment row: invalid toBotId");
  }
  if (record.fromBotId === record.toBotId) {
    throw new Error("inconsistent assignment row: self-assignment");
  }
  if (!VALID_PHASE_SET.has(record.phase)) {
    throw new Error(
      `inconsistent assignment row: invalid phase ${record.phase}`,
    );
  }
  if (typeof record.ownerNotified !== "boolean") {
    throw new Error(
      "inconsistent assignment row: ownerNotified must be boolean",
    );
  }
}

function parseAssignmentRecord(
  value: unknown,
): ColleagueAssignmentRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    !validTelegramBotId(value.fromBotId) ||
    !validTelegramBotId(value.toBotId) ||
    value.fromBotId === value.toBotId ||
    typeof value.task !== "string" ||
    typeof value.phase !== "string" ||
    !VALID_PHASE_SET.has(value.phase) ||
    typeof value.ownerNotified !== "boolean" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number"
  ) {
    return null;
  }
  return {
    id: value.id,
    fromBotId: value.fromBotId,
    toBotId: value.toBotId,
    task: value.task,
    phase: value.phase as ColleagueAssignmentPhase,
    ownerNotified: value.ownerNotified,
    ...(typeof value.dmMessageId === "number"
      ? { dmMessageId: value.dmMessageId }
      : {}),
    ...(typeof value.ownerMessageId === "number"
      ? { ownerMessageId: value.ownerMessageId }
      : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

async function loadLedger(file: string): Promise<AssignmentLedgerDocument> {
  const empty: AssignmentLedgerDocument = {
    version: LEDGER_VERSION,
    records: {},
  };
  let raw: unknown;
  try {
    raw = await loadJsonStrict(file, empty);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("damaged (invalid JSON)")) throw error;
    console.error(`[colleagues] ledger поручений пересоздан: ${message}`);
    return empty;
  }
  if (!isRecord(raw) || !isRecord(raw.records)) return empty;
  const records: Record<string, ColleagueAssignmentRecord> = {};
  for (const [id, entry] of Object.entries(raw.records)) {
    const parsed = parseAssignmentRecord(entry);
    if (parsed !== null && parsed.id === id) records[id] = parsed;
  }
  return { version: LEDGER_VERSION, records };
}

function pruneRecords(
  records: Record<string, ColleagueAssignmentRecord>,
): Record<string, ColleagueAssignmentRecord> {
  const entries = Object.entries(records);
  if (entries.length <= MAX_LEDGER_RECORDS) return records;
  const kept = entries
    .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
    .slice(-MAX_LEDGER_RECORDS);
  return Object.fromEntries(kept);
}

async function withLedger<T>(
  file: string,
  fn: (
    ledger: AssignmentLedgerDocument,
    save: (next: AssignmentLedgerDocument) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const lock = `${file}.lock`;
  const token = await acquireLock(lock);
  try {
    const ledger = await loadLedger(file);
    const save = async (next: AssignmentLedgerDocument) => {
      for (const rec of Object.values(next.records)) {
        assertConsistentRecord(rec);
      }
      await saveJsonAtomic(file, {
        version: LEDGER_VERSION,
        records: pruneRecords(next.records),
      });
    };
    return await fn(ledger, save);
  } finally {
    releaseLock(lock, token);
  }
}

/** Извлекает идентификатор поручения вида `asg_<12 hex>` из текста личного сообщения бота. */
export function parseAssignmentId(text: string | undefined): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  return ASSIGNMENT_ID_PATTERN.exec(text)?.groups?.id ?? null;
}

/** Читаемое имя бота (Ива или имя/роль коллеги) для текста поручения и строки владельцу. */
export function botDisplayLabel(
  botId: string,
  env: NodeJS.ProcessEnv = process.env,
  settingsFile: string = currentSettingsFile(),
): string {
  const bot = resolveTelegramBot(botId, env);
  if (bot?.isPrimary) {
    return bot.username ? `Ива (@${bot.username})` : "Ива";
  }
  const entry = readColleague(botId, settingsFile);
  const baseName =
    entry?.name ??
    (entry ? COLLEAGUE_ROLE_SPECS[entry.role].labelRu : null) ??
    bot?.username ??
    `bot:${botId}`;
  const username = entry?.username ?? bot?.username;
  return username && !baseName.includes(`@${username}`)
    ? `${baseName} (@${username})`
    : baseName;
}

/** Текст личного сообщения бота-отправителя боту-получателю. */
export function formatAssignmentDmText(
  assignmentId: string,
  fromLabel: string,
  task: string,
): string {
  return tr(
    `Assignment from ${fromLabel} [${assignmentId}]:\n${task}`,
    `Поручение от ${fromLabel} [${assignmentId}]:\n${task}`,
  );
}

/**
 * Короткая видимая строка о поручении для владельца в чате коллеги.
 * Всегда прогоняется через outbound-Gate перед отправкой.
 */
export function formatOwnerAssignmentNotice(
  fromLabel: string,
  toLabel: string,
  task: string,
): string {
  const singleLine = task.replace(/\s+/gu, " ").trim();
  const preview =
    singleLine.length > OWNER_PREVIEW_LIMIT
      ? `${singleLine.slice(0, OWNER_PREVIEW_LIMIT - 1)}…`
      : singleLine;
  return tr(
    `📩 Assignment (${fromLabel} → ${toLabel}): ${preview}`,
    `📩 Поручение (${fromLabel} → ${toLabel}): ${preview}`,
  );
}

type TelegramSendResult =
  | { readonly ok: true; readonly messageId?: number }
  | { readonly ok: false; readonly error: string };

async function postBotMessage(
  bot: TelegramBotConfig,
  chatId: string | number,
  text: string,
  {
    apiBaseUrl = DEFAULT_API_BASE_URL,
    fetchImpl = fetch,
  }: {
    readonly apiBaseUrl?: string;
    readonly fetchImpl?: typeof fetch;
  } = {},
): Promise<TelegramSendResult> {
  const gatedText = redactNotice(text);
  const base = apiBaseUrl.replace(/\/+$/u, "");
  try {
    const response = await fetchImpl(`${base}/bot${bot.token}/sendMessage`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: gatedText,
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: unknown;
      description?: unknown;
      result?: { message_id?: unknown };
    } | null;
    if (response.ok && body?.ok === true) {
      const id = body.result?.message_id;
      return typeof id === "number" && Number.isSafeInteger(id)
        ? { ok: true, messageId: id }
        : { ok: true };
    }
    const reason =
      typeof body?.description === "string"
        ? body.description
        : `HTTP ${response.status}`;
    return { ok: false, error: reason };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: rawMessage.replaceAll(bot.token, "***"),
    };
  }
}

/** Чей чат с владельцем показывает строку о поручении: всегда чат коллеги. */
function ownerNoticeBotFor(
  fromBot: TelegramBotConfig,
  toBot: TelegramBotConfig,
): TelegramBotConfig {
  return toBot.isPrimary ? fromBot : toBot;
}

export interface SendColleagueAssignmentInput {
  readonly fromBotId: string;
  readonly toBotId: string;
  readonly task: string;
  readonly ownerChatId?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly settingsFile?: string;
  readonly storeFile?: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export type SendColleagueAssignmentResult =
  | {
      readonly ok: true;
      readonly assignment: ColleagueAssignmentRecord;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly assignment?: ColleagueAssignmentRecord;
    };

/**
 * Отправляет поручение одного бота другому личным сообщением Bot API и публикует
 * видимую строку о поручении владельцу в чате коллеги (не более одного раза на поручение).
 */
export async function sendColleagueAssignment(
  input: SendColleagueAssignmentInput,
): Promise<SendColleagueAssignmentResult> {
  const env = input.env ?? process.env;
  const settingsFile = input.settingsFile ?? currentSettingsFile();
  const storeFile = input.storeFile ?? currentAssignmentsFile();
  const now = input.now ?? Date.now;
  const apiBaseUrl =
    input.apiBaseUrl ?? env.TELEGRAM_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const fetchImpl = input.fetchImpl ?? fetch;

  if (!isColleaguesEnabled(settingsFile)) {
    return { ok: false, error: "Colleagues option is disabled." };
  }
  const fromBotId = input.fromBotId.trim();
  const toBotId = input.toBotId.trim();
  if (!validTelegramBotId(fromBotId) || !validTelegramBotId(toBotId)) {
    return {
      ok: false,
      error:
        "Both fromBotId and toBotId must be valid numeric Telegram bot IDs.",
    };
  }
  if (fromBotId === toBotId) {
    return { ok: false, error: "A bot cannot assign a task to itself." };
  }
  const bots = configuredTelegramBots(env);
  const fromBot = bots.find((bot) => bot.botId === fromBotId) ?? null;
  const toBot = bots.find((bot) => bot.botId === toBotId) ?? null;
  if (!fromBot) {
    return {
      ok: false,
      error: `Sender bot ${fromBotId} is not configured in this installation.`,
    };
  }
  if (!toBot) {
    return {
      ok: false,
      error: `Target bot ${toBotId} is not configured in this installation.`,
    };
  }
  const rawTask = input.task.trim();
  if (rawTask.length === 0) {
    return { ok: false, error: "Assignment task must be non-empty." };
  }
  const task = redactNotice(rawTask.slice(0, MAX_TASK_LENGTH));
  const id = `asg_${randomBytes(6).toString("hex")}`;
  const createdAt = now();
  const initialRecord: ColleagueAssignmentRecord = {
    id,
    fromBotId,
    toBotId,
    task,
    phase: "pending",
    ownerNotified: false,
    createdAt,
    updatedAt: createdAt,
  };

  await withLedger(storeFile, async (ledger, save) => {
    await save({
      version: LEDGER_VERSION,
      records: { ...ledger.records, [id]: initialRecord },
    });
  });

  const fromLabel = botDisplayLabel(fromBotId, env, settingsFile);
  const toLabel = botDisplayLabel(toBotId, env, settingsFile);
  const dmText = formatAssignmentDmText(id, fromLabel, task);
  const dmSent = await postBotMessage(fromBot, Number(toBotId), dmText, {
    apiBaseUrl,
    fetchImpl,
  });

  if (!dmSent.ok) {
    const failedRecord: ColleagueAssignmentRecord = {
      ...initialRecord,
      phase: "failed",
      error: dmSent.error,
      updatedAt: now(),
    };
    await withLedger(storeFile, async (ledger, save) => {
      await save({
        version: LEDGER_VERSION,
        records: { ...ledger.records, [id]: failedRecord },
      });
    });
    return {
      ok: false,
      error: `Failed to send bot-to-bot DM to ${toBotId}: ${dmSent.error}`,
      assignment: failedRecord,
    };
  }

  let deliveredRecord: ColleagueAssignmentRecord = {
    ...initialRecord,
    phase: "delivered",
    ...(dmSent.messageId === undefined
      ? {}
      : { dmMessageId: dmSent.messageId }),
    updatedAt: now(),
  };

  const ownerChat = input.ownerChatId?.trim() || notificationChat(env) || null;
  if (ownerChat) {
    const noticeBot = ownerNoticeBotFor(fromBot, toBot);
    const noticeText = formatOwnerAssignmentNotice(fromLabel, toLabel, task);
    const noticeSent = await postBotMessage(noticeBot, ownerChat, noticeText, {
      apiBaseUrl,
      fetchImpl,
    });
    if (noticeSent.ok) {
      deliveredRecord = {
        ...deliveredRecord,
        ownerNotified: true,
        ...(noticeSent.messageId === undefined
          ? {}
          : { ownerMessageId: noticeSent.messageId }),
        updatedAt: now(),
      };
    } else {
      console.error(
        `[colleagues] не смог отправить строку о поручении ${id} владельцу: ${noticeSent.error}`,
      );
    }
  }

  await withLedger(storeFile, async (ledger, save) => {
    const existing = ledger.records[id];
    const merged: ColleagueAssignmentRecord = existing
      ? {
          ...deliveredRecord,
          phase: existing.phase === "done" ? "done" : deliveredRecord.phase,
          ownerNotified:
            existing.ownerNotified || deliveredRecord.ownerNotified,
          ownerMessageId:
            existing.ownerMessageId ?? deliveredRecord.ownerMessageId,
          updatedAt: now(),
        }
      : deliveredRecord;
    await save({
      version: LEDGER_VERSION,
      records: { ...ledger.records, [id]: merged },
    });
    deliveredRecord = merged;
  });

  return { ok: true, assignment: deliveredRecord };
}

export interface ClaimInboundPeerAssignmentInput {
  readonly fromBotId: string;
  readonly toBotId: string;
  readonly messageId: string | number;
  readonly text: string;
  readonly ownerChatId?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly settingsFile?: string;
  readonly storeFile?: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export type ClaimInboundPeerAssignmentResult =
  | {
      readonly duplicate: true;
      readonly assignmentId: string;
      readonly record: ColleagueAssignmentRecord;
    }
  | {
      readonly duplicate: false;
      readonly assignmentId: string;
      readonly record: ColleagueAssignmentRecord;
    };

/**
 * Регистрирует входящее личное сообщение от другого бота-коллеги (поручение):
 *   - если поручение уже имеет фазу `done`, возвращает `duplicate: true` (повторный ход не идёт);
 *   - если владелец ещё не получил строку о поручении в чате коллеги, отправляет её один раз
 *     и фиксирует `ownerNotified: true` под замком.
 */
export async function claimInboundPeerAssignment(
  input: ClaimInboundPeerAssignmentInput,
): Promise<ClaimInboundPeerAssignmentResult> {
  const env = input.env ?? process.env;
  const settingsFile = input.settingsFile ?? currentSettingsFile();
  const storeFile = input.storeFile ?? currentAssignmentsFile();
  const now = input.now ?? Date.now;
  const apiBaseUrl =
    input.apiBaseUrl ?? env.TELEGRAM_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const fetchImpl = input.fetchImpl ?? fetch;

  const assignmentId =
    parseAssignmentId(input.text) ??
    `dm:${input.fromBotId}:${input.toBotId}:${String(input.messageId)}`;
  const ownerChat = input.ownerChatId?.trim() || notificationChat(env) || null;
  const fromBot = resolveTelegramBot(input.fromBotId, env);
  const toBot = resolveTelegramBot(input.toBotId, env);

  return withLedger(storeFile, async (ledger, save) => {
    const existing = ledger.records[assignmentId];
    if (existing && assignmentPhase(existing) === "done") {
      return { duplicate: true, assignmentId, record: existing };
    }
    const timestamp = now();
    let record: ColleagueAssignmentRecord = existing ?? {
      id: assignmentId,
      fromBotId: input.fromBotId,
      toBotId: input.toBotId,
      task: redactNotice(input.text.trim().slice(0, MAX_TASK_LENGTH)),
      phase: "delivered",
      ownerNotified: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    if (!record.ownerNotified && ownerChat && fromBot && toBot) {
      const fromLabel = botDisplayLabel(input.fromBotId, env, settingsFile);
      const toLabel = botDisplayLabel(input.toBotId, env, settingsFile);
      const noticeBot = ownerNoticeBotFor(fromBot, toBot);
      const noticeText = formatOwnerAssignmentNotice(
        fromLabel,
        toLabel,
        record.task,
      );
      const sent = await postBotMessage(noticeBot, ownerChat, noticeText, {
        apiBaseUrl,
        fetchImpl,
      });
      if (sent.ok) {
        record = {
          ...record,
          ownerNotified: true,
          ...(sent.messageId === undefined
            ? {}
            : { ownerMessageId: sent.messageId }),
          updatedAt: now(),
        };
      }
    }

    await save({
      version: LEDGER_VERSION,
      records: { ...ledger.records, [assignmentId]: record },
    });
    return { duplicate: false, assignmentId, record };
  });
}

/** Помечает входящее поручение исполненным (`done`) после принятия хода Channel. */
export async function completeInboundPeerAssignment(
  assignmentId: string,
  {
    storeFile = currentAssignmentsFile(),
    now = Date.now,
  }: {
    readonly storeFile?: string;
    readonly now?: () => number;
  } = {},
): Promise<void> {
  await withLedger(storeFile, async (ledger, save) => {
    const existing = ledger.records[assignmentId];
    if (!existing || existing.phase === "done") return;
    await save({
      version: LEDGER_VERSION,
      records: {
        ...ledger.records,
        [assignmentId]: {
          ...existing,
          phase: "done",
          updatedAt: now(),
        },
      },
    });
  });
}

/** Читает текущий список поручений из ledger (для диагностики и тестов). */
export async function listColleagueAssignments(
  storeFile: string = currentAssignmentsFile(),
): Promise<ColleagueAssignmentRecord[]> {
  const ledger = await loadLedger(storeFile);
  return Object.values(ledger.records).sort(
    (a, b) => a.createdAt - b.createdAt,
  );
}
