// Транспорт Outbox для cron-пути: ночные отчёты (rollup), Watch и Brief уходят прямым
// fetch к Bot API, без запущенного eve. Разметка, гейт и фолбэки живут в самом шве
// (agent/lib/outbox.ts) — здесь остаются только HTTP-вызов и трактовка ответа Telegram.
//
// Контракт sendTelegramHtml:
//   • model-markdown → валидный Telegram-HTML, режется на чанки ≤4096 (≤1024 для подписи);
//   • каждый чанк шлётся с parse_mode=HTML;
//   • если Telegram вернул 400 (не распарсил сущности) — ОДНА повторная попытка тем же
//     чанком, но без тегов и без parse_mode (так 400 по сущностям невозможен), fellBack=true;
//   • любой другой отказ обрывает отчёт: ok=false с первой ошибкой роняет cron-скрипт
//     ненулевым кодом, а оставшиеся чанки Telegram не получает;
//   • retryTransient=true даёт каждому HTML/plain-вызову до трёх попыток при сети,
//     5xx, 408, 425 и 429; по умолчанию повторов нет;
//   • пустой отчёт — тоже ok=false: слать нечего, и молчать об этом нельзя;
//   • НИКОГДА не бросает — на любую ошибку возвращает { ok:false, error }.
// Возвращает { ok, fellBack, error } — вызывающий cron-скрипт по fellBack даёт агенту
// обратную связь в ту же сессию, чтобы он переформатировал следующий отчёт.
import {
  redactNotice,
  sendThroughOutbox,
  type OutboxAck,
  type OutboxTransport,
} from "../../agent/lib/outbox.ts";
import { traceOutbox, type TraceScope } from "../../agent/lib/trace.ts";
import { parseTelegramDelivery } from "../../agent/lib/telegram-delivery.ts";
import { classifyDeliverStatus } from "./deliver-policy.ts";
import { screenPayload } from "./telegram-buttons.ts";

type TelegramRequest = Record<string, unknown>;
type FetchImpl = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

type PostAck = OutboxAck & {
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
};

export type TelegramSendOptions = {
  readonly caption?: boolean;
  readonly retryTransient?: boolean;
  /** Тема форума (message_thread_id), когда сообщение идёт в тему группы. */
  readonly threadId?: string;
  readonly sleep?: Sleep;
  readonly fetchImpl?: FetchImpl;
  /**
   * Чей это ход — для журнала (ADR-0010). Ночной отчёт уходит тем же швом, что и ответ
   * в диалоге, и без своего имени вьюер прочитал бы rollup как разговор в Telegram.
   * Сессию знает вызывающий скрипт (`response.sessionId` клиента eve), сам шов — нет.
   */
  readonly trace?: TraceScope;
  /**
   * Поднимать до rich message, когда разметка его требует (`<tg-button>`, таблица): так
   * плановые ходы доносят кнопки. Отказ rich-пути — обычный HTML-путь (Outbox).
   * По умолчанию выключено: ночные отчёты идут прежним HTML-путём.
   */
  readonly rich?: boolean;
};

// Rich-пост (`iva post`): те же гейт и фолбэки, плюс два поля Bot API, которых у
// ночного отчёта нет — беззвучная отправка и тема форума.
export type TelegramRichOptions = Omit<TelegramSendOptions, "caption"> & {
  readonly silent?: boolean;
  readonly threadId?: string;
};

const MAX_ATTEMPTS = 3;
const MAX_RETRY_MS = 30_000;

const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Сообщение брошенной ошибки: у fetch-сбоя оно информативнее, чем String(error).
function errorMessage(e: unknown): string {
  return String(
    e !== null &&
      (typeof e === "object" || typeof e === "function") &&
      "message" in e
      ? (e.message ?? e)
      : e,
  );
}

function telegramRetryAfterMs(text: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    const value = (parsed as { parameters?: { retry_after?: unknown } } | null)
      ?.parameters?.retry_after;
    if (
      (typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !value.trim())
    )
      return undefined;
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return Math.min(MAX_RETRY_MS, seconds * 1000);
  } catch {
    return undefined;
  }
}

async function post(
  bot: string,
  method: string,
  body: TelegramRequest,
  fetchImpl: FetchImpl,
): Promise<PostAck> {
  try {
    const res = await fetchImpl(
      `https://api.telegram.org/bot${bot}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (res.ok) return { ok: true };
    const text = await res.text();
    // 400 = Telegram не распарсил HTML: единственный статус, где повтор без тегов помогает.
    return {
      ok: false,
      error: `${res.status}: ${text}`,
      retryPlain: res.status === 400,
      retryable: classifyDeliverStatus(res.status) === "retry",
      ...(res.status === 429
        ? { retryAfterMs: telegramRetryAfterMs(text) }
        : {}),
    };
  } catch (e) {
    return {
      ok: false,
      error: errorMessage(e),
      retryPlain: false,
      retryable: true,
    };
  }
}

async function postWithTransientRetry(
  bot: string,
  method: string,
  body: TelegramRequest,
  fetchImpl: FetchImpl,
  sleep: Sleep,
): Promise<PostAck> {
  for (let attempt = 1; ; attempt++) {
    const ack = await post(bot, method, body, fetchImpl);
    if (ack.ok || !ack.retryable || attempt >= MAX_ATTEMPTS) return ack;
    const retryMs =
      ack.retryAfterMs ?? Math.min(MAX_RETRY_MS, 1000 * 2 ** (attempt - 1));
    await sleep(retryMs);
  }
}

// Один вызов Bot API для всех методов шва: sendMessage у HTML-пути, sendRichMessage
// у rich-поста. Повторы транзиентных отказов включает вызывающий.
type SendPost = (method: string, body: TelegramRequest) => Promise<PostAck>;

function poster(
  bot: string,
  retryTransient: boolean,
  fetchImpl: FetchImpl,
  sleep: Sleep,
): SendPost {
  return retryTransient
    ? (method, body) =>
        postWithTransientRetry(bot, method, body, fetchImpl, sleep)
    : (method, body) => post(bot, method, body, fetchImpl);
}

// Ночной отчёт — цельный документ, а не диалог: если Telegram отказал не по разметке
// (flood control, 5xx, бот заблокирован), остаток слать некуда и незачем — добитый
// 429 продлевает throttle на весь токен, общий с интерактивным каналом. Помечаем
// такой отказ как stop, и шов бросает хвост — ровно как cron-путь делал до шва.
function messageTransport(
  chat: string,
  sendPost: SendPost,
  extra: TelegramRequest,
  rich: boolean | undefined,
): OutboxTransport {
  return {
    ...(rich
      ? {
          sendRich: (markdown: string) =>
            sendPost("sendRichMessage", {
              chat_id: chat,
              rich_message: { markdown },
              ...extra,
            }),
        }
      : {}),
    sendHtml: async (html) => {
      const ack = await sendPost("sendMessage", {
        chat_id: chat,
        text: html,
        parse_mode: "HTML",
        ...extra,
      });
      return ack.ok || ack.retryPlain ? ack : { ...ack, stop: true };
    },
    // Повтор без разметки — последний шанс этого чанка. Не вышел и он: дальше по
    // отчёту идти не с чем, каким бы кодом Telegram ни ответил.
    sendPlain: async (text) => {
      const ack = await sendPost("sendMessage", {
        chat_id: chat,
        text,
        ...extra,
      });
      return ack.ok ? ack : { ...ack, stop: true };
    },
  };
}

/**
 * Delivers a scheduled model result through Telegram, retaining its delivery choice.
 *
 * A leading IVA quiet-delivery marker is removed before formatting and enables
 * Telegram's soundless notification mode for every delivery fallback.
 */
export async function sendTelegramHtml(
  bot: string,
  chat: string,
  md: unknown,
  {
    caption = false,
    retryTransient = false,
    threadId,
    sleep = realSleep,
    fetchImpl = fetch,
    trace,
    rich,
  }: TelegramSendOptions = {},
): Promise<{ ok: boolean; fellBack: boolean; error: string }> {
  const { text, silent } =
    typeof md === "string"
      ? parseTelegramDelivery(md)
      : { text: md, silent: false };
  const transport = messageTransport(
    chat,
    poster(bot, retryTransient, fetchImpl, sleep),
    {
      ...(silent ? { disable_notification: true } : {}),
      ...(threadId ? { message_thread_id: threadId } : {}),
    },
    rich,
  );
  try {
    const { ok, fellBack, error } = await traceOutbox(
      { source: "cron", ...trace },
      String(text),
      () =>
        sendThroughOutbox(text as string, transport, {
          limit: caption ? 1024 : 4096,
        }),
    );
    // Пустой рендер шов сам вернул провалом (nothing delivered): ночной скрипт падает
    // ненулевым кодом, как падал на 400 «message text is empty».
    return { ok, fellBack, error };
  } catch (e) {
    // Шов бросает только на нестроковом md (гейт работает по строке) — контракт
    // «никогда не бросает» держим здесь, у самой границы cron-скриптов.
    return { ok: false, fellBack: false, error: errorMessage(e) };
  }
}

/**
 * Rich-пост в чат: `iva post` и всё, что шлёт готовый markdown одним сообщением.
 *
 * Отличий от sendTelegramHtml два. Первое — метод: rich_message.markdown уходит в
 * sendRichMessage, где Telegram сам рендерит картинки между абзацами, таблицы и
 * <details>. Второе — rich-путь выбран вызывающим (alwaysRich), а не разметкой:
 * пост из текста и картинок никаких rich-конструкций не содержит, но HTML-путь
 * картинки не рендерит.
 *
 * Фолбэка тут нет намеренно. Отказ Bot API — ошибка отправки: ok=false с текстом
 * ошибки, и наружу не уходит ничего. У канала фолбэк на месте (ответ в диалоге
 * лучше отдать хоть как-то), но пост в ЧУЖОЙ чат владелец просил именно постом:
 * молча выдать вместо него HTML-куски без картинок и отчитаться об успехе —
 * потеря, которую никто не заметит. HTML/plain-транспорт поэтому оставлен как
 * заглушка со stop: шов доходит до неё, только если rich отвергли, и сразу
 * возвращает тот же отказ, не трогая Bot API второй раз.
 */
export async function sendTelegramRich(
  bot: string,
  chat: string,
  markdown: unknown,
  {
    silent = false,
    threadId,
    retryTransient = false,
    sleep = realSleep,
    fetchImpl = fetch,
    trace,
  }: TelegramRichOptions = {},
): Promise<{ ok: boolean; fellBack: boolean; error: string }> {
  const sendPost = poster(bot, retryTransient, fetchImpl, sleep);
  const extra: TelegramRequest = {
    ...(silent ? { disable_notification: true } : {}),
    ...(threadId ? { message_thread_id: threadId } : {}),
  };
  // Отказ rich-пути, чтобы вернуть его вызывающему как ошибку отправки: шов
  // спрашивает транспорт, а не наоборот, и другого места запомнить причину нет.
  let refusal = "";
  const refuse = (): Promise<OutboxAck> =>
    Promise.resolve({
      ok: false,
      error: refusal || "sendRichMessage was not attempted",
      retryPlain: false,
      stop: true,
    });
  const transport: OutboxTransport = {
    sendRich: async (text) => {
      const ack = await sendPost("sendRichMessage", {
        chat_id: chat,
        rich_message: { markdown: text },
        ...extra,
      });
      if (!ack.ok) {
        refusal = ack.error;
        console.error(
          "[telegram] sendRichMessage отвергнут, пост не отправлен:",
          ack.error.slice(0, 300),
        );
      }
      return ack;
    },
    // Ни одного вызова Bot API: пост либо ушёл rich-сообщением, либо не ушёл.
    sendHtml: refuse,
    sendPlain: refuse,
  };
  try {
    const { ok, fellBack, error } = await traceOutbox(
      { source: "cron", ...trace },
      String(markdown),
      () =>
        sendThroughOutbox(markdown as string, transport, { alwaysRich: true }),
    );
    // Пустой рендер шов сам вернул провалом (nothing delivered): iva post не отчитается
    // успехом за пост, который никуда не уехал.
    return { ok, fellBack, error };
  } catch (e) {
    return { ok: false, fellBack: false, error: errorMessage(e) };
  }
}

/**
 * Сообщение с кнопкой, собранное кодом (предложение плагина): в стиле меню владельца — rich
 * message или текст с клавиатурой, как предложение обновления (ADR-0015), — через
 * outbound-Gate. Фолбэка без кнопки нет: без неё сообщение теряет смысл, и вызывающий
 * получает отказ, а не «успех» текстом.
 */
export async function sendTelegramScreen(
  bot: string,
  chat: string,
  markdown: string,
  {
    sleep = realSleep,
    fetchImpl = fetch,
  }: Pick<TelegramSendOptions, "sleep" | "fetchImpl"> = {},
): Promise<{ ok: boolean; error: string }> {
  const payload = screenPayload(redactNotice(markdown));
  const method = "rich_message" in payload ? "sendRichMessage" : "sendMessage";
  const ack = await postWithTransientRetry(
    bot,
    method,
    { chat_id: chat, ...payload },
    fetchImpl,
    sleep,
  );
  return { ok: ack.ok, error: ack.ok ? "" : ack.error };
}
