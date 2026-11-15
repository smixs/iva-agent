import { readTelegramMessageText } from "./telegram-rich-message.ts";

export const TELEGRAM_REPLY_TEXT_MAX_CHARS = 8_000;

const AUTHOR_FIELD_MAX_CHARS = 256;
const FILENAME_MAX_CHARS = 512;
const TELEGRAM_CHAT_TYPES = new Set([
  "private",
  "group",
  "supergroup",
  "channel",
]);
const FILE_MEDIA = [
  "animation",
  "audio",
  "document",
  "sticker",
  "video",
  "video_note",
  "voice",
];

type UnknownRecord = Record<string, unknown>;

export interface TelegramReplySanitizeResult {
  text: string;
  blocked: boolean;
  flags: string[];
}

export interface TelegramReplyContextResult {
  item: string;
  flagged: boolean;
}

type SanitizeText = (text: string) => TelegramReplySanitizeResult;
type HasAttackSignal = (result: TelegramReplySanitizeResult) => boolean;

interface BoundedText {
  text: string;
  truncated: boolean;
}

interface SanitizedBoundedText extends BoundedText {
  warned: boolean;
}

interface ReplyAuthor {
  id?: string;
  name?: string;
  username?: string;
  isBot?: boolean;
}

interface SenderChatAuthor {
  id?: string;
  title?: string;
  username?: string;
  type?: string;
}

interface ReadIdentity<T> {
  value: T | null;
  truncated: boolean;
  warned: boolean;
}

interface ReadSenderChat extends ReadIdentity<SenderChatAuthor> {
  validIdentity: boolean;
}

interface MediaIdentity {
  type: string;
  value: UnknownRecord;
}

interface ReplyMedia {
  type: string;
  filename: string | null;
  caption: string;
}

interface ReadMedia {
  value: ReplyMedia;
  truncated: boolean;
  warned: boolean;
}

interface TelegramReplyItem {
  type: "telegram_reply";
  messageId: string;
  author: ReplyAuthor | SenderChatAuthor | null;
  text: string;
  truncated: boolean;
  untrusted: boolean;
  source?: "assistant";
  media?: ReplyMedia;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedTelegramMessageId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  return null;
}

function boundedTelegramUserId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  return null;
}

function boundedTelegramChatId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value !== 0)
    return String(value);
  return null;
}

function truncateCodePoints(value: string, limit: number): BoundedText {
  let text = "";
  let count = 0;
  for (const char of value) {
    if (count === limit) return { text, truncated: true };
    text += char;
    count += 1;
  }
  return { text, truncated: false };
}

function sanitizeBounded(
  value: string,
  limit: number,
  sanitizeText: SanitizeText,
  hasAttackSignal: HasAttackSignal,
): SanitizedBoundedText {
  const boundedInput = truncateCodePoints(value, limit);
  const security = sanitizeText(boundedInput.text);
  const boundedOutput = truncateCodePoints(security.text, limit);
  return {
    text: boundedOutput.text,
    truncated: boundedInput.truncated || boundedOutput.truncated,
    warned: hasAttackSignal(security),
  };
}

function readAuthor(
  value: unknown,
  sanitizeText: SanitizeText,
  hasAttackSignal: HasAttackSignal,
): ReadIdentity<ReplyAuthor> {
  if (!isRecord(value)) return { value: null, truncated: false, warned: false };

  const author: ReplyAuthor = {};
  let truncated = false;
  let warned = false;
  const id = boundedTelegramUserId(value.id);
  if (id !== null) {
    author.id = id;
  }
  const firstName =
    typeof value.first_name === "string" ? value.first_name : "";
  const lastName = typeof value.last_name === "string" ? value.last_name : "";
  const rawName = [firstName, lastName].filter(Boolean).join(" ");
  if (rawName) {
    const result = sanitizeBounded(
      rawName,
      AUTHOR_FIELD_MAX_CHARS,
      sanitizeText,
      hasAttackSignal,
    );
    if (result.text) author.name = result.text;
    truncated ||= result.truncated;
    warned ||= result.warned;
  }
  if (typeof value.username === "string" && value.username.length > 0) {
    const result = sanitizeBounded(
      value.username,
      AUTHOR_FIELD_MAX_CHARS,
      sanitizeText,
      hasAttackSignal,
    );
    if (result.text) author.username = result.text;
    truncated ||= result.truncated;
    warned ||= result.warned;
  }
  if (typeof value.is_bot === "boolean") author.isBot = value.is_bot;

  return {
    value: Object.keys(author).length > 0 ? author : null,
    truncated,
    warned,
  };
}

function readSenderChat(
  value: unknown,
  sanitizeText: SanitizeText,
  hasAttackSignal: HasAttackSignal,
): ReadSenderChat {
  if (!isRecord(value)) {
    return {
      value: null,
      truncated: false,
      warned: false,
      validIdentity: false,
    };
  }

  const author: SenderChatAuthor = {};
  let truncated = false;
  let warned = false;
  const id = boundedTelegramChatId(value.id);
  if (id !== null) author.id = id;
  for (const field of ["title", "username"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) continue;
    const result = sanitizeBounded(
      value[field],
      AUTHOR_FIELD_MAX_CHARS,
      sanitizeText,
      hasAttackSignal,
    );
    if (result.text) author[field] = result.text;
    truncated ||= result.truncated;
    warned ||= result.warned;
  }
  if (typeof value.type === "string" && TELEGRAM_CHAT_TYPES.has(value.type)) {
    author.type = value.type;
  }

  return {
    value: Object.keys(author).length > 0 ? author : null,
    truncated,
    warned,
    validIdentity: id !== null,
  };
}

function findMedia(reply: UnknownRecord): MediaIdentity | null {
  let type: string | null = null;
  let value: UnknownRecord | null = null;

  if (
    Array.isArray(reply.photo) &&
    reply.photo.some(
      (photo) =>
        isRecord(photo) &&
        typeof photo.file_id === "string" &&
        photo.file_id.length > 0,
    )
  ) {
    type = "photo";
    value = {};
  } else {
    for (const key of FILE_MEDIA) {
      const candidate = reply[key];
      if (
        isRecord(candidate) &&
        typeof candidate.file_id === "string" &&
        candidate.file_id.length > 0
      ) {
        type = key;
        value = candidate;
        break;
      }
    }
  }
  return type === null || value === null ? null : { type, value };
}

function readMedia(
  media: MediaIdentity | null,
  caption: string,
  sanitizeText: SanitizeText,
  hasAttackSignal: HasAttackSignal,
): ReadMedia | null {
  if (media === null) return null;
  const { type, value } = media;
  const rawFilename =
    type === "photo"
      ? "photo.jpg"
      : typeof value.file_name === "string" && value.file_name.length > 0
        ? value.file_name
        : null;
  const filename =
    rawFilename === null
      ? { text: null, truncated: false, warned: false }
      : sanitizeBounded(
          rawFilename,
          FILENAME_MAX_CHARS,
          sanitizeText,
          hasAttackSignal,
        );
  const boundedCaption = truncateCodePoints(
    caption,
    TELEGRAM_REPLY_TEXT_MAX_CHARS,
  );
  return {
    value: {
      type,
      filename: filename.text || null,
      caption: boundedCaption.text,
    },
    truncated: filename.truncated || boundedCaption.truncated,
    warned: filename.warned,
  };
}

/**
 * Return one sanitized JSON context item for Telegram's quoted message.
 *
 * Only bounded text and inert metadata cross the boundary. Original messages
 * from this bot are assistant history; foreign and forwarded quotes remain
 * untrusted. File IDs and download URLs are deliberately excluded.
 */
export function buildTelegramReplyContext(
  rawMessage: unknown,
  sanitizeText: SanitizeText,
  hasAttackSignal: HasAttackSignal,
  ownBotId?: string,
): TelegramReplyContextResult | null {
  if (!isRecord(rawMessage) || !isRecord(rawMessage.reply_to_message))
    return null;
  if (typeof sanitizeText !== "function")
    throw new TypeError("sanitizeText must be a function");
  if (typeof hasAttackSignal !== "function") {
    throw new TypeError("hasAttackSignal must be a function");
  }
  const reply = rawMessage.reply_to_message;
  const messageId = boundedTelegramMessageId(reply.message_id);
  if (messageId === null) return null;

  const messageText = readTelegramMessageText(reply);
  const caption = messageText.caption;
  const rawText = messageText.text;
  const mediaIdentity = findMedia(reply);
  if (
    rawText.trim().length === 0 &&
    mediaIdentity === null &&
    !messageText.rich?.truncated
  )
    return null;

  const textSecurity = sanitizeText(rawText);
  const captionSecurity =
    rawText === caption ? textSecurity : sanitizeText(caption);
  const text = truncateCodePoints(
    textSecurity.text,
    TELEGRAM_REPLY_TEXT_MAX_CHARS,
  );
  const media = readMedia(
    mediaIdentity,
    captionSecurity.text,
    sanitizeText,
    hasAttackSignal,
  );

  const fromAuthor = readAuthor(reply.from, sanitizeText, hasAttackSignal);
  const senderChat = readSenderChat(
    reply.sender_chat,
    sanitizeText,
    hasAttackSignal,
  );
  // Telegram may pair sender_chat with the GroupAnonymousBot compatibility
  // placeholder. A validated chat ID identifies the real author; malformed
  // sender_chat metadata cannot replace a valid from identity.
  const author = senderChat.validIdentity ? senderChat : fromAuthor;
  // Telegram supplies the author identity. A username or is_bot alone is not
  // proof: other bots and forwarded content retain the foreign-data boundary.
  const own =
    ownBotId !== undefined &&
    isRecord(reply.from) &&
    reply.from.is_bot === true &&
    boundedTelegramUserId(reply.from.id) === ownBotId &&
    reply.sender_chat === undefined &&
    reply.forward_origin === undefined &&
    reply.forward_from === undefined &&
    reply.forward_from_chat === undefined;
  const item: TelegramReplyItem = {
    type: "telegram_reply",
    messageId,
    author: author.value,
    text: text.text,
    truncated:
      text.truncated ||
      Boolean(messageText.rich?.truncated) ||
      author.truncated ||
      Boolean(media?.truncated),
    untrusted: !own,
    ...(own ? { source: "assistant" as const } : {}),
  };
  if (media !== null) item.media = media.value;
  return {
    item: JSON.stringify(item),
    flagged:
      !own &&
      (hasAttackSignal(textSecurity) ||
        hasAttackSignal(captionSecurity) ||
        author.warned ||
        Boolean(media?.warned)),
  };
}
