import {
  mkdir,
  link,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";

import {
  TELEGRAM_MESSAGE_ENVELOPE_KEYS,
  TELEGRAM_MESSAGE_TEXT_KEYS,
} from "#lib/telegram-parts.ts";

export type TelegramId = string | number;

export type TelegramPeer = {
  id?: TelegramId;
  is_bot?: boolean;
  type?: string;
  [key: string]: unknown;
};

export type TelegramChat = TelegramPeer & { id: number };

export type TelegramDocument = {
  file_id: string;
  file_size?: number;
  [key: string]: unknown;
};

export type TelegramQueueMessage = {
  from?: TelegramPeer;
  chat?: TelegramChat;
  reply_to_message?: TelegramQueueMessage;
  document?: TelegramDocument;
  message_id?: number;
  message_thread_id?: number;
  date?: number;
  text?: string;
  caption?: string;
  entities?: unknown;
  caption_entities?: unknown;
  iva_parts?: TelegramQueueMessage[];
  [key: string]: unknown;
};

export type TelegramCallbackQuery = {
  id: string;
  data?: string;
  from?: TelegramPeer;
  message?: TelegramQueueMessage;
  [key: string]: unknown;
};

export type TelegramQueueUpdate = {
  update_id: number;
  message?: TelegramQueueMessage;
  callback_query?: TelegramCallbackQuery;
  stopped_message_generation?: import("#lib/telegram-stop.ts").TelegramDraftStop;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalField(
  value: Record<string, unknown>,
  key: string,
  predicate: (candidate: unknown) => boolean,
): boolean {
  return !(key in value) || value[key] === undefined || predicate(value[key]);
}

function isTelegramPeer(value: unknown): value is TelegramPeer {
  return (
    isRecord(value) &&
    optionalField(
      value,
      "id",
      (id) => typeof id === "string" || typeof id === "number",
    ) &&
    optionalField(value, "is_bot", (isBot) => typeof isBot === "boolean") &&
    optionalField(value, "type", (type) => typeof type === "string")
  );
}

function isTelegramChat(value: unknown): value is TelegramChat {
  return isTelegramPeer(value) && typeof value.id === "number";
}

function isTelegramDocument(value: unknown): value is TelegramDocument {
  return (
    isRecord(value) &&
    typeof value.file_id === "string" &&
    optionalField(value, "file_size", (size) => typeof size === "number")
  );
}

function isTelegramQueueMessageAtDepth(
  value: unknown,
  depth: number,
): value is TelegramQueueMessage {
  if (!isRecord(value) || depth > 4) return false;
  const nextMessage = (candidate: unknown) =>
    isTelegramQueueMessageAtDepth(candidate, depth + 1);
  return (
    optionalField(value, "from", isTelegramPeer) &&
    optionalField(value, "chat", isTelegramChat) &&
    optionalField(value, "reply_to_message", nextMessage) &&
    optionalField(value, "document", isTelegramDocument) &&
    optionalField(value, "message_id", Number.isSafeInteger) &&
    optionalField(value, "message_thread_id", Number.isSafeInteger) &&
    optionalField(value, "date", Number.isSafeInteger) &&
    optionalField(value, "text", (text) => typeof text === "string") &&
    optionalField(value, "caption", (caption) => typeof caption === "string") &&
    optionalField(
      value,
      "iva_parts",
      (parts) => Array.isArray(parts) && parts.every(nextMessage),
    )
  );
}

export function isTelegramQueueMessage(
  value: unknown,
): value is TelegramQueueMessage {
  return isTelegramQueueMessageAtDepth(value, 0);
}

function isTelegramCallbackQuery(
  value: unknown,
): value is TelegramCallbackQuery {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    optionalField(value, "data", (data) => typeof data === "string") &&
    optionalField(value, "from", isTelegramPeer) &&
    optionalField(value, "message", isTelegramQueueMessage)
  );
}

export function isTelegramQueueUpdate(
  value: unknown,
): value is TelegramQueueUpdate {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "update_id" in value &&
    Number.isSafeInteger(value.update_id) &&
    optionalField(value, "message", isTelegramQueueMessage) &&
    optionalField(value, "callback_query", isTelegramCallbackQuery) &&
    // Поля «стопа» сверяет handleTelegramDraftStop и непонятный стоп игнорирует. Здесь —
    // только объект: 16.10.2026 живой стоп не прошёл строгую проверку по документации
    // Bot API, и вход стоял, пока апдейт не подтвердили руками.
    optionalField(value, "stopped_message_generation", isRecord)
  );
}

export type TelegramUpdateBatchItem =
  | { update: TelegramQueueUpdate }
  | { skipped: InvalidTelegramUpdatesDiagnostic; updateId: number | null };

// Пачка разбирается по элементу: апдейт, который не прошёл проверку, пропускается со
// сдвигом offset, остальные идут дальше. null — только когда result не массив.
export function parseTelegramUpdates(
  value: unknown,
): TelegramUpdateBatchItem[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item: unknown, index) => {
    if (isTelegramQueueUpdate(item)) return { update: item };
    const updateId = isRecord(item) ? item.update_id : null;
    return {
      skipped: invalidItemDiagnostic(item, index),
      updateId: Number.isSafeInteger(updateId) ? (updateId as number) : null,
    };
  });
}

export type InvalidTelegramUpdatesDiagnostic = {
  index: number | null;
  updateId: string | number | null;
  item: {
    type: string;
    keys?: string[];
    // Вложенные объекты: имя поля и тип каждого ключа, без значений.
    fields?: Record<string, string[]>;
  };
};

function typeLabel(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function invalidItemDiagnostic(
  item: unknown,
  index: number,
): InvalidTelegramUpdatesDiagnostic {
  if (!isRecord(item))
    return { index, updateId: null, item: { type: typeLabel(item) } };
  const rawUpdateId = item.update_id;
  const updateId =
    typeof rawUpdateId === "string" || typeof rawUpdateId === "number"
      ? rawUpdateId
      : null;
  const fields: Record<string, string[]> = {};
  for (const [key, nested] of Object.entries(item)) {
    if (!isRecord(nested)) continue;
    fields[key] = Object.entries(nested)
      .map(([name, field]) => `${name}:${typeLabel(field)}`)
      .sort();
  }
  return {
    index,
    updateId,
    item: { type: "object", keys: Object.keys(item).sort(), fields },
  };
}

export function invalidTelegramUpdatesDiagnostic(
  value: unknown,
): InvalidTelegramUpdatesDiagnostic | null {
  if (!Array.isArray(value))
    return { index: null, updateId: null, item: { type: typeLabel(value) } };
  const index = value.findIndex((item) => !isTelegramQueueUpdate(item));
  return index < 0 ? null : invalidItemDiagnostic(value[index], index);
}

export type TelegramQueueItem = {
  version: number;
  updateId: number;
  enqueuedAt?: number;
  update?: TelegramQueueUpdate;
  legacyText?: string;
  migratedFrom?: string;
  [key: string]: unknown;
};

export type TelegramQueueDocument = {
  version: number;
  queues: Record<string, TelegramQueueItem[]>;
};

type SyncHandle = {
  sync: () => Promise<void>;
  close: () => Promise<void>;
};

type QueueFileOptions = {
  strict?: boolean;
  readFileImpl?: (file: string, encoding: "utf8") => Promise<string>;
  writeFileImpl?: (
    file: string,
    data: string,
    options: {
      encoding: "utf8";
      flag: "wx";
      mode: number;
    },
  ) => Promise<void>;
  mkdirImpl?: (
    path: string,
    options: { recursive: true },
  ) => Promise<string | undefined>;
  renameImpl?: (source: string, target: string) => Promise<void>;
  linkImpl?: (source: string, target: string) => Promise<void>;
  rmImpl?: (path: string, options: { force: true }) => Promise<void>;
  openImpl?: (path: string, flags: string) => Promise<SyncHandle>;
  nonce?: string | (() => string);
  replace?: boolean;
  quarantineNow?: () => number;
  quarantineNonce?: () => string;
  onLegacyQuarantine?: (path: string) => void;
  now?: () => number;
  logImpl?: (...parts: unknown[]) => void;
};

type TelegramEntity = {
  type?: unknown;
  offset: number;
  length: number;
  [key: string]: unknown;
};

type SplitChatKey = {
  chatId: number | string;
  threadId: number | null;
};

export const TELEGRAM_QUEUE_VERSION = 1;
export const TELEGRAM_QUEUE_ITEM_VERSION = 1;
export const TELEGRAM_QUEUE_DURABILITY = "ETELEGRAM_QUEUE_DURABILITY";
export const TELEGRAM_QUEUE_ACK_ROLLED_BACK = "ETELEGRAM_QUEUE_ACK_ROLLED_BACK";
export const TELEGRAM_QUEUE_FATAL_DURABILITY =
  "ETELEGRAM_QUEUE_FATAL_DURABILITY";
export const TELEGRAM_QUEUE_ACK_PENDING_SUFFIX = ".ack-pending";

class NewerQueueVersionError extends Error {
  constructor(version: number, supported: number) {
    super(
      `Telegram queue: записано более новой Ивой (версия ${version}, эта Ива понимает ${supported}): обновите Иву или верните файл`,
    );
  }
}

export function emptyQueueDocument(): TelegramQueueDocument {
  return { version: TELEGRAM_QUEUE_VERSION, queues: Object.fromEntries([]) };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function legacyUpdateId(chatKey: string, index: number, text: string): number {
  const digest = createHash("sha256")
    .update(`${chatKey}\0${index}\0${text}`)
    .digest();
  return -(digest.readUInt32BE(0) || 1);
}

function normalizeItem(
  item: unknown,
  chatKey: string,
  index: number,
): TelegramQueueItem {
  if (typeof item === "string") {
    return {
      version: TELEGRAM_QUEUE_ITEM_VERSION,
      updateId: legacyUpdateId(chatKey, index, item),
      legacyText: item,
      migratedFrom: "string",
    };
  }
  const candidate = item as Record<string, unknown>;
  if (
    typeof candidate?.version === "number" &&
    candidate.version > TELEGRAM_QUEUE_ITEM_VERSION
  )
    throw new NewerQueueVersionError(
      candidate.version,
      TELEGRAM_QUEUE_ITEM_VERSION,
    );
  if (
    typeof item !== "object" ||
    item === null ||
    Array.isArray(item) ||
    candidate.version !== TELEGRAM_QUEUE_ITEM_VERSION ||
    !Number.isSafeInteger(candidate.updateId)
  ) {
    throw new Error(`invalid Telegram queue item for ${chatKey}[${index}]`);
  }
  const hasUpdate =
    typeof candidate.update === "object" &&
    candidate.update !== null &&
    !Array.isArray(candidate.update) &&
    (candidate.update as Record<string, unknown>).update_id ===
      candidate.updateId;
  const hasLegacyText = typeof candidate.legacyText === "string";
  if (!hasUpdate && !hasLegacyText) {
    throw new Error(
      `Telegram queue item ${chatKey}[${index}] has no replayable payload`,
    );
  }
  return cloneJson(candidate) as TelegramQueueItem;
}

// Запись, которую загрузка не приняла: целиком уходит в файл карантина, остальные идут дальше.
export type DamagedQueueRecord = {
  chatKey: string;
  index: number | null;
  reason: string;
  record: unknown;
};

function normalizeQueues(
  queues: unknown,
  {
    legacy = false,
    damaged,
  }: { legacy?: boolean; damaged?: DamagedQueueRecord[] } = {},
): { document: TelegramQueueDocument; migrated: boolean } {
  if (typeof queues !== "object" || queues === null || Array.isArray(queues)) {
    throw new Error("Telegram queue does not contain a queues object");
  }
  // Без damaged любая плохая запись — ошибка (запись файла); с ним — пропуск записи.
  const reject = (record: DamagedQueueRecord) => {
    if (!damaged) throw new Error(record.reason);
    damaged.push(record);
  };
  const entries: [string, TelegramQueueItem[]][] = [];
  for (const [chatKey, items] of Object.entries(queues)) {
    if (!Array.isArray(items)) {
      reject({
        chatKey,
        index: null,
        reason: `Telegram queue ${chatKey} is not an array`,
        record: items,
      });
      continue;
    }
    const next: TelegramQueueItem[] = [];
    items.forEach((item: unknown, index) => {
      try {
        next.push(normalizeItem(item, chatKey, index));
      } catch (error) {
        reject({
          chatKey,
          index,
          reason: (error as Error).message,
          record: item,
        });
      }
    });
    if (next.length) entries.push([chatKey, next]);
  }
  return {
    // Object.fromEntries defines "__proto__" as an ordinary own data property.
    document: {
      version: TELEGRAM_QUEUE_VERSION,
      queues: Object.fromEntries(entries),
    },
    migrated: legacy,
  };
}

export function normalizeQueueDocument(
  value: unknown,
  { damaged }: { damaged?: DamagedQueueRecord[] } = {},
): {
  document: TelegramQueueDocument;
  migrated: boolean;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Telegram queue does not contain an object");
  }
  const version = (value as Record<string, unknown>).version;
  if (typeof version === "number" && version > TELEGRAM_QUEUE_VERSION)
    throw new NewerQueueVersionError(version, TELEGRAM_QUEUE_VERSION);
  if (
    (value as Record<string, unknown>).version === TELEGRAM_QUEUE_VERSION &&
    Object.hasOwn(value, "queues")
  ) {
    return normalizeQueues((value as Record<string, unknown>).queues, {
      damaged,
    });
  }
  // Pre-IVA-008 format: { "<chat>:<topic>": ["text", ...] }.
  // Convert every string to a versioned item with a stable synthetic update id.
  // The text stays byte-for-byte present until Eve accepts the migrated head.
  return normalizeQueues(value, { legacy: true, damaged });
}

export function createQueueItem(
  update: unknown,
  now = Date.now(),
): TelegramQueueItem {
  if (!isTelegramQueueUpdate(update)) {
    throw new Error(
      "queued Telegram update must have a safe integer update_id",
    );
  }
  return {
    version: TELEGRAM_QUEUE_ITEM_VERSION,
    updateId: update.update_id,
    enqueuedAt: now,
    update: cloneJson(update),
  };
}

export function queueCount(
  document: TelegramQueueDocument,
  chatKey?: string,
): number {
  if (chatKey !== undefined) {
    return Object.hasOwn(document.queues, chatKey)
      ? document.queues[chatKey].length
      : 0;
  }
  return Object.values(document.queues).reduce(
    (sum, items) => sum + items.length,
    0,
  );
}

export function queueKeys(document: TelegramQueueDocument): string[] {
  return Object.keys(document.queues).filter(
    (key) => document.queues[key]?.length,
  );
}

export function queueHead(
  document: TelegramQueueDocument,
  chatKey: string,
): TelegramQueueItem | null {
  return Object.hasOwn(document.queues, chatKey)
    ? (document.queues[chatKey][0] ?? null)
    : null;
}

function cloneQueueMap(
  queues: Record<string, TelegramQueueItem[]>,
): Record<string, TelegramQueueItem[]> {
  return Object.fromEntries(Object.entries(queues));
}

function defineQueue(
  queues: Record<string, TelegramQueueItem[]>,
  chatKey: string,
  items: TelegramQueueItem[],
): void {
  Object.defineProperty(queues, chatKey, {
    value: items,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function enqueueItem(
  document: TelegramQueueDocument,
  chatKey: string,
  item: TelegramQueueItem,
): { document: TelegramQueueDocument; added: boolean; count: number } {
  const queues = cloneQueueMap(document.queues);
  const current = Object.hasOwn(queues, chatKey) ? queues[chatKey] : [];
  const duplicate = current.some(
    (candidate) => candidate.updateId === item.updateId,
  );
  if (duplicate) {
    return { document, added: false, count: current.length };
  }
  defineQueue(queues, chatKey, [...current, item]);
  return {
    document: { version: TELEGRAM_QUEUE_VERSION, queues },
    added: true,
    count: queues[chatKey].length,
  };
}

// Снятие доставленной пачки: элементы после снимка остаются, id, убранные сбросом,
// пропускаются; присутствующие id не с головы — очередь не та, снимать нечего.
export function removeQueueItems(
  document: TelegramQueueDocument,
  chatKey: string,
  updateIds: readonly number[],
): { document: TelegramQueueDocument; removed: number } {
  if (updateIds.length === 0) throw new Error("Telegram queue batch is empty");
  const current = Object.hasOwn(document.queues, chatKey)
    ? document.queues[chatKey]
    : [];
  const batch = new Set(updateIds);
  const present = current.filter((item) => batch.has(item.updateId));
  if (present.length === 0) return { document, removed: 0 };
  if (present.some((item, index) => current[index] !== item)) {
    throw new Error(
      `Telegram queue batch changed for ${chatKey}; expected updates ${updateIds.join(",")}`,
    );
  }
  const queues = cloneQueueMap(document.queues);
  const rest = current.slice(present.length);
  if (rest.length === 0) delete queues[chatKey];
  else defineQueue(queues, chatKey, rest);
  return {
    document: { version: TELEGRAM_QUEUE_VERSION, queues },
    removed: present.length,
  };
}

export function clearQueueKey(
  document: TelegramQueueDocument,
  chatKey: string,
): {
  document: TelegramQueueDocument;
  changed: boolean;
} {
  if (!Object.hasOwn(document.queues, chatKey))
    return { document, changed: false };
  const queues = cloneQueueMap(document.queues);
  delete queues[chatKey];
  return {
    document: { version: TELEGRAM_QUEUE_VERSION, queues },
    changed: true,
  };
}

function splitChatKey(chatKey: string): SplitChatKey | null {
  const colon = chatKey.lastIndexOf(":");
  if (colon < 0) return null;
  const chat = chatKey.slice(0, colon);
  const thread = chatKey.slice(colon + 1);
  if (!chat.length) return null;
  const chatNumber = Number(chat);
  const threadNumber = thread === "" ? null : Number(thread);
  return {
    chatId: Number.isSafeInteger(chatNumber) ? chatNumber : chat,
    threadId: Number.isSafeInteger(threadNumber) ? threadNumber : null,
  };
}

export function materializeQueueItem(
  chatKey: string,
  item: TelegramQueueItem,
  {
    legacyAllowedUserIds,
  }: {
    legacyAllowedUserIds?: ReadonlySet<string> | Iterable<unknown> | null;
  } = {},
): TelegramQueueUpdate | null {
  if (item.update) return cloneJson(item.update);
  const route = splitChatKey(chatKey);
  const allowed =
    legacyAllowedUserIds instanceof Set
      ? legacyAllowedUserIds
      : new Set(legacyAllowedUserIds ?? []);
  // The old string[] format did not retain a sender. A private Telegram chat id
  // is also its participant's user id, so an allowlisted private route is the
  // only legacy item whose author can be reconstructed. A group/topic key says
  // nothing about which member wrote the text and must stay undelivered.
  if (
    !route ||
    typeof route.chatId !== "number" ||
    route.chatId <= 0 ||
    !allowed.has(String(route.chatId))
  ) {
    return null;
  }
  const ownerId = route.chatId;
  const messageId = Math.max(1, Math.abs(item.updateId));
  return {
    update_id: item.updateId,
    message: {
      message_id: messageId,
      date: 0,
      chat: {
        id: route.chatId,
        type: "private",
      },
      from: { id: ownerId, is_bot: false, first_name: "Owner" },
      text: item.legacyText,
      ...(route.threadId === null ? {} : { message_thread_id: route.threadId }),
    },
  };
}

const TELEGRAM_USERNAME = /^[A-Za-z0-9_]{5,32}$/u;
const TOKEN_NEIGHBOR = /[\p{L}\p{N}_]/u;

function normalizeBotUsername(botUsername: unknown): string {
  if (typeof botUsername !== "string") return "";
  const username = botUsername.replace(/^@/, "");
  return TELEGRAM_USERNAME.test(username) ? username : "";
}

function validEntityRange(
  text: string,
  entity: unknown,
): entity is TelegramEntity {
  const candidate = entity as Record<string, unknown>;
  return (
    typeof entity === "object" &&
    entity !== null &&
    Number.isSafeInteger(candidate.offset) &&
    Number.isSafeInteger(candidate.length) &&
    (candidate.offset as number) >= 0 &&
    (candidate.length as number) > 0 &&
    (candidate.offset as number) + (candidate.length as number) <= text.length
  );
}

function codePointBefore(text: string, index: number): string {
  return Array.from(text.slice(0, index)).at(-1) ?? "";
}

function codePointAfter(text: string, index: number): string {
  return Array.from(text.slice(index))[0] ?? "";
}

function hasTokenBoundaries(text: string, start: number, end: number): boolean {
  return (
    !TOKEN_NEIGHBOR.test(codePointBefore(text, start)) &&
    !TOKEN_NEIGHBOR.test(codePointAfter(text, end))
  );
}

function mentionAt(
  text: string,
  start: number,
  end: number,
  username: string,
): boolean {
  return (
    text.slice(start, end).toLowerCase() === `@${username.toLowerCase()}` &&
    hasTokenBoundaries(text, start, end)
  );
}

function hasExactMention(
  text: string,
  entities: unknown,
  username: string,
): boolean {
  if (!username) return false;
  if (entities !== undefined) {
    if (!Array.isArray(entities)) return false;
    return entities.some((entity: unknown) => {
      const candidate = entity as { type?: unknown } | null | undefined;
      return (
        candidate?.type === "mention" &&
        validEntityRange(text, entity) &&
        mentionAt(text, entity.offset, entity.offset + entity.length, username)
      );
    });
  }

  const needleLength = username.length + 1;
  let start = text.indexOf("@");
  while (start >= 0) {
    if (mentionAt(text, start, start + needleLength, username)) return true;
    start = text.indexOf("@", start + 1);
  }
  return false;
}

function commandTokenTargetsBot(
  token: string,
  botUsername: string,
): boolean | string {
  const match = /^\/[A-Za-z0-9_]+(?:@(?<target>[A-Za-z0-9_]+))?$/u.exec(token);
  if (!match) return false;
  const target = match.groups?.target;
  return (
    target === undefined ||
    (botUsername && target.toLowerCase() === botUsername.toLowerCase())
  );
}

function isBotCommand(
  text: string,
  botUsername: string,
  entities: unknown,
): boolean {
  if (entities !== undefined) {
    if (!Array.isArray(entities)) return false;
    return entities.some((entity: unknown) => {
      const candidate = entity as Record<string, unknown> | null;
      if (
        candidate?.type !== "bot_command" ||
        candidate?.offset !== 0 ||
        !validEntityRange(text, entity)
      ) {
        return false;
      }
      const end = entity.offset + entity.length;
      return (
        commandTokenTargetsBot(text.slice(entity.offset, end), botUsername) &&
        (end === text.length || /\s/u.test(codePointAfter(text, end)))
      );
    });
  }
  const match = /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?=\s|$)/u.exec(text);
  return Boolean(match && commandTokenTargetsBot(match[0], botUsername));
}

function messageTextAndEntities(message: TelegramQueueMessage): {
  text: string;
  entities: unknown;
} {
  if (typeof message.text === "string") {
    return { text: message.text, entities: message.entities };
  }
  if (typeof message.caption === "string") {
    return { text: message.caption, entities: message.caption_entities };
  }
  return { text: "", entities: undefined };
}

// Мост судит конверт, содержимое судит inbound pipeline. Сообщение несёт содержимое,
// когда у него есть хотя бы один собственный ключ вне конверта Bot API
// (`TELEGRAM_MESSAGE_ENVELOPE_KEYS`): перечислять виды содержимого мост не умеет и не
// должен. Поэтому новое поле Bot API доезжает до агента само, а судит его единственный
// читатель — `agent/lib/telegram-rich-message.ts`. Незнакомое сообщение из одних
// метаданных стоит одного HTTP-раунда и Notice, но не потерянного сообщения (ADR-0002).
function hasMessagePayload(message: TelegramQueueMessage): boolean {
  const { text } = messageTextAndEntities(message);
  if (text.trim()) return true;
  return Object.keys(message).some(
    (key) =>
      message[key] !== undefined &&
      !TELEGRAM_MESSAGE_ENVELOPE_KEYS.has(key) &&
      !TELEGRAM_MESSAGE_TEXT_KEYS.has(key),
  );
}

export function isReplyToBot(message: TelegramQueueMessage): boolean {
  return message.reply_to_message?.from?.is_bot === true;
}

export function shouldQueueBusyUpdate(
  update: TelegramQueueUpdate | null | undefined,
  {
    allowedUserIds,
    botUsername,
  }: {
    allowedUserIds?: ReadonlySet<string> | Iterable<unknown> | null;
    botUsername?: unknown;
  },
): boolean {
  const message = update?.message;
  const parts = Array.isArray(message?.iva_parts)
    ? message.iva_parts
    : [message];
  if (
    !message ||
    message.from?.is_bot === true ||
    !parts.some((part: unknown) => isRecord(part) && hasMessagePayload(part))
  ) {
    return false;
  }
  const allowed =
    allowedUserIds instanceof Set
      ? allowedUserIds
      : new Set(allowedUserIds ?? []);
  const from = String(message.from?.id ?? "");
  if (!allowed.size || !allowed.has(from)) return false;
  if (message.chat?.type === "private") return true;
  if (message.chat?.type === "channel") return false;
  if (isReplyToBot(message)) return true;
  const username = normalizeBotUsername(botUsername);
  return parts.some((part: unknown) => {
    if (!part || typeof part !== "object") return false;
    const { text, entities } = messageTextAndEntities(
      part as TelegramQueueMessage,
    );
    return (
      isBotCommand(text, username, entities) ||
      hasExactMention(text, entities, username)
    );
  });
}

export async function loadQueueFile(
  file: string,
  options: QueueFileOptions = {},
) {
  const {
    strict = false,
    readFileImpl = readFile,
    renameImpl = rename,
  } = options;
  const quarantineNonce =
    typeof options.nonce === "function"
      ? options.nonce
      : () => randomBytes(8).toString("hex");
  const pendingFile = `${file}${TELEGRAM_QUEUE_ACK_PENDING_SUFFIX}`;
  let pendingRaw: string | undefined;
  try {
    pendingRaw = await readFileImpl(pendingFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT")
      throw error;
  }
  if (pendingRaw !== undefined) {
    // A pending document is the last fully durable pre-ack state. Restore it
    // before any caller can observe the possibly published removal.
    const damaged: DamagedQueueRecord[] = [];
    let recovered: TelegramQueueDocument | undefined;
    try {
      recovered = normalizeQueueDocument(JSON.parse(pendingRaw), {
        damaged,
      }).document;
    } catch (error) {
      if (strict || error instanceof NewerQueueVersionError) throw error;
      const backup = `${pendingFile}.corrupt-${Date.now()}-${quarantineNonce()}`;
      await renameImpl(pendingFile, backup);
      (options.logImpl ?? console.error)(
        `corrupt Telegram queue pending file moved to ${backup}`,
      );
    }
    if (recovered) {
      // Pending recovery must also preserve a newer main document.
      try {
        normalizeQueueDocument(JSON.parse(await readFileImpl(file, "utf8")));
      } catch (error) {
        if (error instanceof NewerQueueVersionError) throw error;
      }
      await quarantineQueueRecords(file, damaged, options);
      const recoveryOptions = { ...options };
      if (typeof recoveryOptions.nonce === "function")
        delete recoveryOptions.nonce;
      await writeQueueFileAtomic(file, recovered, recoveryOptions);
      await removeFileDurable(pendingFile, options);
      return {
        document: recovered,
        migrated: false,
        quarantined: null,
        recoveredPendingAcknowledgement: true,
      };
    }
  }

  let raw: string;
  try {
    raw = await readFileImpl(file, "utf8");
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT"
    ) {
      return {
        document: emptyQueueDocument(),
        migrated: false,
        quarantined: null,
      };
    }
    throw error;
  }
  // Плохая запись не роняет файл: она копируется в карантин, остальные возвращаются.
  // Из самого файла её убирает следующая запись этого файла (16.10.2026: одна такая
  // запись входящих гоняла приём по кругу падений, а в очереди уносила весь файл).
  const damaged: DamagedQueueRecord[] = [];
  let normalized: ReturnType<typeof normalizeQueueDocument>;
  try {
    normalized = normalizeQueueDocument(JSON.parse(raw), { damaged });
  } catch (error) {
    if (strict || error instanceof NewerQueueVersionError) throw error;
    const backup = `${file}.corrupt-${Date.now()}-${quarantineNonce()}`;
    await renameImpl(file, backup);
    return {
      document: emptyQueueDocument(),
      migrated: false,
      quarantined: backup,
      error,
    };
  }
  await quarantineQueueRecords(file, damaged, options);
  return { ...normalized, quarantined: null };
}

// Копия записи рядом с файлом: имя от содержимого, поэтому повторная загрузка той же
// записи не плодит копий и не пишет журнал заново. Копия надёжна до того, как запись
// исчезнет из файла (ADR-0002). В журнале — ключи и типы полей, без значений.
export async function quarantineQueueRecords(
  file: string,
  damaged: readonly DamagedQueueRecord[],
  options: QueueFileOptions = {},
): Promise<string[]> {
  const logImpl = options.logImpl ?? console.error;
  const paths: string[] = [];
  for (const entry of damaged) {
    const text = JSON.stringify(entry);
    const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const path = `${file}.damaged-${digest}.json`;
    paths.push(path);
    try {
      await writeFileDurable(path, text, { ...options, replace: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST") continue;
      throw error;
    }
    logImpl(
      `damaged Telegram queue record ${entry.chatKey}[${entry.index ?? "*"}] moved to ${path}: ${entry.reason}`,
      JSON.stringify(
        invalidItemDiagnostic(entry.record, entry.index ?? -1).item,
      ),
    );
  }
  return paths;
}

async function removeFileDurable(
  file: string,
  { rmImpl = rm, openImpl = open }: QueueFileOptions = {},
): Promise<void> {
  await rmImpl(file, { force: true });
  const directory = await openImpl(dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function writeQueueFileAtomic(
  file: string,
  document: unknown,
  options: QueueFileOptions = {},
): Promise<void> {
  const normalized = normalizeQueueDocument(document).document;
  await writeFileDurable(file, JSON.stringify(normalized), options);
}

async function writeFileDurable(
  file: string,
  text: string,
  {
    mkdirImpl = mkdir,
    writeFileImpl = writeFile,
    renameImpl = rename,
    linkImpl = link,
    rmImpl = rm,
    openImpl = open,
    nonce = randomBytes(8).toString("hex"),
    replace = true,
  }: QueueFileOptions = {},
): Promise<void> {
  const parent = dirname(file);
  await mkdirImpl(parent, { recursive: true });
  const nonceValue = typeof nonce === "function" ? nonce() : nonce;
  const tmp = `${file}.tmp-${process.pid}-${nonceValue}`;
  let replaced = false;
  try {
    await writeFileImpl(tmp, text, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const staged = await openImpl(tmp, "r+");
    try {
      await staged.sync();
    } finally {
      await staged.close();
    }
    if (replace) await renameImpl(tmp, file);
    else await linkImpl(tmp, file);
    replaced = true;
    const directory = await openImpl(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (cause) {
    if (replaced) {
      const error = new Error(
        `Telegram queue file was published, but durability could not be confirmed: ${(cause as Error).message}`,
        { cause },
      ) as Error & { code: string };
      error.code = TELEGRAM_QUEUE_DURABILITY;
      throw error;
    }
    throw cause;
  } finally {
    await rmImpl(tmp, { force: true }).catch(() => {});
  }
}

async function writeLegacyQuarantine(
  file: string,
  document: TelegramQueueDocument,
  options: QueueFileOptions,
): Promise<string> {
  const now = options.quarantineNow?.() ?? Date.now();
  const nonce = options.quarantineNonce?.() ?? randomBytes(8).toString("hex");
  const stem = `${file}.legacy-unattributed-${now}-${nonce}`;

  for (let attempt = 0; attempt < 1000; attempt++) {
    const path = attempt === 0 ? stem : `${stem}-${attempt}`;
    try {
      // A hard link publishes the fully fsynced staging inode and fails with
      // EEXIST instead of replacing an earlier migration's evidence.
      await writeQueueFileAtomic(path, document, {
        ...options,
        replace: false,
      });
      return path;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException | null | undefined)?.code !== "EEXIST"
      )
        throw error;
    }
  }
  throw new Error(
    `could not reserve a unique legacy Telegram quarantine path for ${file}`,
  );
}

export async function migrateQueueFile(
  file: string,
  options: QueueFileOptions = {},
): Promise<TelegramQueueDocument> {
  const loaded = await loadQueueFile(file, options);
  if (loaded.migrated) {
    const activeEntries: [string, TelegramQueueItem[]][] = [];
    const unattributedEntries: [string, TelegramQueueItem[]][] = [];
    for (const [chatKey, items] of Object.entries(loaded.document.queues)) {
      const route = splitChatKey(chatKey);
      const target =
        route && typeof route.chatId === "number" && route.chatId > 0
          ? activeEntries
          : unattributedEntries;
      target.push([chatKey, items]);
    }
    const active = {
      version: TELEGRAM_QUEUE_VERSION,
      queues: Object.fromEntries(activeEntries),
    };
    if (unattributedEntries.length) {
      // Preserve old group/topic text outside the active FIFO before removing it
      // from automatic replay. The old format has no sender identity, so those
      // entries cannot be delivered faithfully. Writing this sidecar first means
      // every crash order leaves either the original queue or its durable copy.
      const quarantine = await writeLegacyQuarantine(
        file,
        {
          version: TELEGRAM_QUEUE_VERSION,
          queues: Object.fromEntries(unattributedEntries),
        },
        options,
      );
      options.onLegacyQuarantine?.(quarantine);
    }
    await writeQueueFileAtomic(file, active, options);
    return active;
  }
  return loaded.document;
}

export async function enqueueQueueFile(
  file: string,
  chatKey: string,
  update: unknown,
  options: QueueFileOptions = {},
) {
  const loaded = await loadQueueFile(file, options);
  const result = enqueueItem(
    loaded.document,
    chatKey,
    createQueueItem(update, options.now?.() ?? Date.now()),
  );
  // A previous rename can be visible even when its parent-directory fsync failed.
  // Rewrite duplicate retries too, so offset advancement always follows a write
  // whose file and directory durability were both confirmed in this attempt.
  await writeQueueFileAtomic(file, result.document, options);
  return {
    ...result,
    document: result.document,
    quarantined: loaded.quarantined,
  };
}

export async function acknowledgeQueueItems(
  file: string,
  chatKey: string,
  updateIds: readonly number[],
  options: QueueFileOptions = {},
): Promise<TelegramQueueDocument> {
  const loaded = await loadQueueFile(file, { ...options, strict: true });
  const removal = removeQueueItems(loaded.document, chatKey, updateIds);
  if (removal.removed === 0) return loaded.document; // acknowledged before a break: no write
  const { document } = removal;
  const pendingFile = `${file}${TELEGRAM_QUEUE_ACK_PENDING_SUFFIX}`;

  // Publish the original queue durably before making batch removal visible.
  // If SIGKILL lands anywhere after this point, loadQueueFile restores it and
  // intentionally permits one at-least-once duplicate.
  await writeQueueFileAtomic(pendingFile, loaded.document, options);
  try {
    await writeQueueFileAtomic(file, document, options);
    await removeFileDurable(pendingFile, options);
  } catch (error) {
    try {
      await writeQueueFileAtomic(file, loaded.document, options);
      await removeFileDurable(pendingFile, options);
    } catch (rollbackError) {
      const fatal = new Error(
        `Telegram queue acknowledgement and rollback durability are unknown: ${(rollbackError as Error).message}`,
        { cause: rollbackError },
      ) as Error & { code: string; acknowledgementError: unknown };
      fatal.code = TELEGRAM_QUEUE_FATAL_DURABILITY;
      fatal.acknowledgementError = error;
      throw fatal;
    }
    const rolledBack = new Error(
      `Telegram queue acknowledgement was not durable; original batch ${updateIds.join(",")} was restored`,
      { cause: error },
    ) as Error & { code: string };
    rolledBack.code = TELEGRAM_QUEUE_ACK_ROLLED_BACK;
    throw rolledBack;
  }
  return document;
}

export async function clearQueueFileKey(
  file: string,
  chatKey: string,
  options: QueueFileOptions = {},
): Promise<TelegramQueueDocument> {
  const loaded = await loadQueueFile(file, { ...options, strict: true });
  const result = clearQueueKey(loaded.document, chatKey);
  if (result.changed || loaded.migrated) {
    await writeQueueFileAtomic(file, result.document, options);
  }
  return result.document;
}
