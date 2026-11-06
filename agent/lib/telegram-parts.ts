export type TelegramRawMessage = Record<string, unknown>;

function isTelegramRawMessage(value: unknown): value is TelegramRawMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Наши пометки на сыром Telegram Message. Квитанцию durable-очереди вешает и снимает
// канал (telegram-acceptance.ts); имя стоит здесь, рядом с остальными пометками,
// потому что конверт ниже обязан знать их все.
export const TELEGRAM_QUEUE_RECEIPT_FIELD = "iva_durable_queue_receipt";
// Тап по кнопке модели: слив очереди Bridge отдаёт его отдельным ходом (scripts/poller/control.ts).
export const TELEGRAM_BUTTON_TAP_FIELD = "iva_button_tap";
// Архивная проекция тапа; text сохраняет полный контекст для хода модели.
export const TELEGRAM_BUTTON_TAP_DAILY_TEXT_FIELD = "iva_button_tap_daily_text";

// Конверт Bot API `Message`: поля маршрутизации, авторства, времени, ответа и
// оформления — те, что никогда не несут пользовательского содержимого, — плюс наши
// собственные пометки. Всё остальное в сообщении считается содержимым.
//
// Инвариант, ради которого список перечисляет метаданные, а не виды содержимого:
// новое поле Bot API доезжает до агента само. Содержимое судит один читатель —
// `telegram-rich-message.ts`, а незнакомое сообщение из одних метаданных стоит
// одного HTTP-раунда и Notice, но не потерянного сообщения (ADR-0002).
export const TELEGRAM_MESSAGE_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "message_id",
  "message_thread_id",
  "from",
  "sender_chat",
  "sender_boost_count",
  "sender_business_bot",
  "date",
  "business_connection_id",
  "chat",
  "forward_origin",
  "is_topic_message",
  "is_automatic_forward",
  "reply_to_message",
  "external_reply",
  "quote",
  "reply_to_story",
  "via_bot",
  "edit_date",
  "has_protected_content",
  "is_from_offline",
  "media_group_id",
  "author_signature",
  "paid_star_count",
  "effect_id",
  "link_preview_options",
  "reply_markup",
  "show_caption_above_media",
  "has_media_spoiler",
  // Служебные события личного чата: пользователь закрепил сообщение или сменил
  // таймер автоудаления — это не обращение к боту, ответа не ждут.
  "pinned_message",
  "message_auto_delete_timer_changed",
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden",
  "iva_parts",
  "iva_buffered",
  TELEGRAM_QUEUE_RECEIPT_FIELD,
  TELEGRAM_BUTTON_TAP_FIELD,
  TELEGRAM_BUTTON_TAP_DAILY_TEXT_FIELD,
]);

// Текстовая проекция Message. Конверт её не судит: содержательность текста решает
// чтение — текст из одних пробелов содержимым не считается, — а назвать такое поле
// непрочитанным значило бы соврать.
export const TELEGRAM_MESSAGE_TEXT_KEYS: ReadonlySet<string> = new Set([
  "text",
  "entities",
  "caption",
  "caption_entities",
]);

// Имя поля уезжает пользователю в текст и в журнал моста, поэтому печатаются только
// имена вида Bot API: ключ с юникодом или пробелом не печатается вовсе.
const FIELD_NAME_PATTERN = /^[a-z0-9_]+$/u;

/** Поля вне конверта: сообщение их принесло, а прочитать их не удалось. */
export function contentKeyNames(
  parts: readonly TelegramRawMessage[],
): string[] {
  const names = new Set<string>();
  for (const part of parts) {
    if (!isTelegramRawMessage(part)) continue;
    for (const key of Object.keys(part)) {
      if (
        part[key] !== undefined &&
        !TELEGRAM_MESSAGE_ENVELOPE_KEYS.has(key) &&
        !TELEGRAM_MESSAGE_TEXT_KEYS.has(key) &&
        FIELD_NAME_PATTERN.test(key)
      ) {
        names.add(key);
      }
    }
  }
  return [...names].sort();
}

export type TelegramRawMedia = {
  fileId: string;
  fileUniqueId?: string;
  tag: string;
  transcribe: boolean;
  mimeType?: string;
  fileName?: string;
};

const RAW_MEDIA: ReadonlyArray<{
  key: string;
  tag: string;
  transcribe: boolean;
}> = [
  { key: "voice", tag: "voice", transcribe: true },
  { key: "audio", tag: "audio", transcribe: true },
  { key: "video", tag: "video", transcribe: true },
  { key: "video_note", tag: "video", transcribe: true },
  { key: "animation", tag: "animation", transcribe: false },
  { key: "sticker", tag: "sticker", transcribe: false },
  { key: "document", tag: "document", transcribe: false },
];

export function mediaFromRaw(raw: TelegramRawMessage): TelegramRawMedia | null {
  if (Array.isArray(raw.photo) && raw.photo.length > 0) {
    const photos = raw.photo as unknown[];
    const photo = photos[photos.length - 1];
    if (
      typeof photo === "object" &&
      photo !== null &&
      !Array.isArray(photo) &&
      typeof (photo as Record<string, unknown>).file_id === "string" &&
      ((photo as Record<string, unknown>).file_id as string).length > 0
    ) {
      const photoRecord = photo as Record<string, unknown>;
      return {
        fileId: photoRecord.file_id as string,
        ...(typeof photoRecord.file_unique_id === "string"
          ? { fileUniqueId: photoRecord.file_unique_id }
          : {}),
        tag: "photo",
        transcribe: false,
      };
    }
  }
  for (const media of RAW_MEDIA) {
    const item = raw[media.key] as
      | {
          file_id?: string;
          file_unique_id?: string;
          mime_type?: string;
          file_name?: string;
        }
      | undefined;
    if (item && typeof item.file_id === "string" && item.file_id.length > 0) {
      return {
        fileId: item.file_id,
        ...(typeof item.file_unique_id === "string"
          ? { fileUniqueId: item.file_unique_id }
          : {}),
        tag: media.tag,
        transcribe: media.transcribe,
        mimeType: item.mime_type,
        fileName: item.file_name,
      };
    }
  }
  return null;
}

export function messageParts(raw: TelegramRawMessage): TelegramRawMessage[] {
  return Array.isArray(raw.iva_parts)
    ? raw.iva_parts.filter(isTelegramRawMessage)
    : [raw];
}
