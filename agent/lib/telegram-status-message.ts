// Статус-сообщение хода: «Работаю…» с кнопкой [⏹ Стоп] и его уборка в терминале.
// Это UI самого канала, не текст модели, поэтому мимо Outbox.
//
// Статус — rich message (sendRichMessage): лоадер и кнопка <tg-button>
// стоят в одной строке текста. Стиль меню на статус не влияет.
//
// turn.started шлёт статус и пишет running+sessionId+turnId в run-status.
// Нажатие кнопки (и /stop) ловит Bridge: он берёт sessionId и зовёт cancel-роут
// канала, а terminal-событие приводит статус в порядок: обычный финал удаляет
// сообщение, отмена переписывает его на «Остановлено».
//
// Про eve модуль не знает: канал передаёт хендл Bot API структурно.
import { tr } from "./i18n.ts";
import { chatKeyOf, getChatStatus, setChatStatusIf } from "./run-status.ts";
import { isPrivateTelegramChatHandle } from "./telegram-private-chat.ts";

// В callback_data кладём только константу: лимит 64 байта не вмещает sessionId,
// он и так лежит в run-status.
export const TELEGRAM_STOP_CALLBACK = "iva_cancel";

export type TelegramStatusHandle = {
  readonly chatId: string;
  readonly chatType?: string;
  readonly messageThreadId?: number;
  request(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<{ ok: boolean; body: unknown }>;
};

// Функция, а не const: перевод выбирается в момент вызова (правило репо — module-level
// const не должна захватывать tr(), иначе язык замерзает до рестарта).
// Экспорт нужен мосту: сообщение «ход не остановился» переписывается тем же текстом, когда
// подтверждение всё-таки приходит.
export function stoppedText(): string {
  return tr(
    "⏹ Stopped. I'll hold new messages and handle them together with the next one.",
    "⏹ Остановлено. Новые сообщения накоплю и обработаю вместе со следующим.",
  );
}

// Анимированный лоадер статуса — тот же набор, что у /update
// (t.me/addemoji/iconemoji1), печатающие точки, чтобы «Работаю…» визуально
// отличался от обновления. Без Premium у владельца бота Telegram вернёт 400 на
// custom_emoji — тогда анимация выключается навсегда, а текст падает на обычные ⏳.
const WORK_LOADER = {
  alt: "💬",
  customEmojiId: "5818797194127346654",
  fallback: "⏳",
};
const FALLBACK_STATUS_SUFFIX = " …";
let workLoaderSupported = true;
// Рич-путь целиком: старый Bot API не знает sendRichMessage. Один отказ — и статус
// уходит обычным текстом, как до rich; повторять отказ на каждом ходу незачем.
let richStatusSupported = true;

// Строка статуса. Лоадер падает на ⏳, когда Telegram отверг custom emoji.
function workingMarkdown({
  withStop = true,
}: { withStop?: boolean } = {}): string {
  const loader = workLoaderSupported
    ? `<tg-emoji emoji-id="${WORK_LOADER.customEmojiId}">${WORK_LOADER.alt}</tg-emoji>`
    : WORK_LOADER.fallback;
  return withStop
    ? `${loader} <tg-button type="callback_data" style="danger" data="${TELEGRAM_STOP_CALLBACK}">⏹</tg-button>`
    : loader;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageIdFromResponse(response: { body: unknown }): number | null {
  const body = asRecord(response.body);
  const result = asRecord(body?.result);
  return typeof result?.message_id === "number" ? result.message_id : null;
}

/** Builds the shared Telegram request body for a quiet temporary status message. */
function statusBody(tg: TelegramStatusHandle): Record<string, unknown> {
  return {
    chat_id: tg.chatId,
    disable_notification: true,
    ...(tg.messageThreadId !== undefined
      ? { message_thread_id: tg.messageThreadId }
      : {}),
  };
}

/**
 * Одна тихая служебная строка в чат и тему хода (подсказка «нажмите /new»). Отказ Bot API —
 * исключение: вызывающий по нему решает, считать ли строку отправленной.
 */
export async function sendQuietLine(
  tg: TelegramStatusHandle,
  text: string,
): Promise<void> {
  const res = await tg.request("sendMessage", { ...statusBody(tg), text });
  if (!res.ok)
    throw new Error(
      `sendMessage refused: ${JSON.stringify(res.body).slice(0, 300)}`,
    );
}

export async function sendWorkingStatus(
  tg: TelegramStatusHandle,
  { canStop = true } = {},
): Promise<number | null> {
  // Кнопку показываем только в личке, где Bridge примет её callback.
  const withStop = canStop && isPrivateTelegramChatHandle(tg);
  const base = statusBody(tg);
  if (richStatusSupported) {
    const res = await tg.request("sendRichMessage", {
      ...base,
      rich_message: { markdown: workingMarkdown({ withStop }) },
    });
    if (res.ok) return messageIdFromResponse(res);
    // 400 на custom_emoji: кнопка остаётся (она в тексте), а анимация — нет.
    if (workLoaderSupported) {
      workLoaderSupported = false;
      const withoutEmoji = await tg.request("sendRichMessage", {
        ...base,
        rich_message: { markdown: workingMarkdown({ withStop }) },
      });
      if (withoutEmoji.ok) return messageIdFromResponse(withoutEmoji);
    }
    richStatusSupported = false;
    console.error(
      "[telegram] sendRichMessage для статуса отвергнут, шлю обычный текст:",
      JSON.stringify(res.body).slice(0, 300),
    );
  }
  // Статус обязан быть виден даже там, где rich не приняли: без кнопки и анимации,
  // но «Работаю…» в чате есть.
  const fallback = await tg.request("sendMessage", {
    ...base,
    text: WORK_LOADER.fallback + FALLBACK_STATUS_SUFFIX,
  });
  return fallback.ok ? messageIdFromResponse(fallback) : null;
}

// Ранний статус уходит без кнопки: ход ещё не начался, отменять нечего. Начался — кнопку
// дорисовываем в то же сообщение и по тому же правилу личного чата.
export async function enableWorkingStatusStop(
  tg: TelegramStatusHandle,
  messageId: number,
): Promise<void> {
  if (!isPrivateTelegramChatHandle(tg)) return;
  if (!richStatusSupported) return;
  await tg.request("editMessageText", {
    chat_id: tg.chatId,
    message_id: messageId,
    rich_message: { markdown: workingMarkdown({ withStop: true }) },
  });
}

// Терминал хода: state → idle (+wasCancelled), статус-сообщение удалить (обычный финал)
// или переписать на «Остановлено» (отмена). Сбои уборки не критичны — глотаем.
export async function finishTelegramStatus(
  channel: {
    telegram: TelegramStatusHandle;
  },
  sessionId: string,
  mode: "completed" | "cancelled" | "failed",
): Promise<boolean> {
  const tg = channel.telegram;
  const key = chatKeyOf(tg.chatId, tg.messageThreadId);
  const st = getChatStatus(key);
  // Compare and update happen under one per-chat lock. A reset can remove
  // sessionId after this read; a late terminal event then becomes a no-op.
  const casOk = setChatStatusIf(
    key,
    { sessionId },
    {
      status: "idle",
      sessionId: null,
      turnId: null,
      statusMessageId: null,
      ingressId: null,
      ingressAt: null,
      statusAt: null,
      turnAt: null,
      firstOutputAt: null,
      latencyLogged: null,
      ...(mode === "cancelled" ? { wasCancelled: true } : {}),
    },
  );
  // Only touch Telegram when the pre-CAS snapshot was OUR session. A late
  // terminal event from an old finished session must not delete another
  // live session's Working… message in the same chat.
  if (st?.sessionId === sessionId) {
    const msgId = st.statusMessageId;
    if (typeof msgId === "number") {
      try {
        if (mode === "cancelled") {
          await tg.request("editMessageText", {
            chat_id: tg.chatId,
            message_id: msgId,
            rich_message: { markdown: stoppedText() },
          });
        } else {
          await tg.request("deleteMessage", {
            chat_id: tg.chatId,
            message_id: msgId,
          });
        }
      } catch {
        /* статус-сообщение не убралось — не критично */
      }
    }
  }
  return Boolean(casOk);
}
