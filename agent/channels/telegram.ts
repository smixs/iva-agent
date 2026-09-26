import {
  telegramChannel,
  type TelegramChannelState,
  type TelegramHandle,
  type TelegramMessageBody,
} from "eve/channels/telegram";
import { POST } from "eve/channels";
// Outbox — ЕДИНЫЙ шов наружу (тот же, через который уходят ночные отчёты cron):
// внутри него outbound-Gate, выбор rich/HTML, нарезка на чанки и plain-фолбэк.
import {
  noticeSender,
  sendThroughOutbox,
  type OutboxAck,
  type OutboxTransport,
} from "../lib/outbox.js";
import { hasRichButtons } from "../lib/telegram-format.js";
import { parseTelegramDelivery } from "../lib/telegram-delivery.js";
import {
  TELEGRAM_RICH_REPLIES,
  type RichReplies,
} from "../lib/telegram-rich-replies.js";
// Inbound-пайплайн — единственный вход внутрь: allowlist, решение о диспатче,
// запись в Vault, медиа со зрением и транскрипцией, inbound-Gate и контекст хода.
// Канал приносит ему эффекты и сам про разбор входящего ничего не знает.
import { runTelegramInbound } from "../lib/telegram-inbound.js";
import { traceOutbox } from "../lib/trace.js";
import { chatModelSeesImages, describeImage } from "../vision.js";
import { providerConfig } from "../provider.js";
import {
  contextFillHintText,
  markReplyDelivered,
  returnContextFillHint,
  takeContextFillHint,
} from "../lib/context-fill.js";
import { transcribe } from "../transcribe.js";
// Статус-сообщение хода («Работаю…», кнопка Стоп, уборка в терминале) и служебное
// объяснение сбоя — UI канала, обе реплики идут мимо Outbox. Мимо Outbox — не мимо
// гейта: всё, во что подставлен runtime-контент, уходит через noticeSender.
import {
  enableWorkingStatusStop,
  finishTelegramStatus,
  sendWorkingStatus,
  TELEGRAM_STOP_CALLBACK,
} from "../lib/telegram-status-message.js";
import { notifyTelegramFailure } from "../lib/telegram-failure-notice.js";
// Состояние «идёт ли ход» — per-chat файлы data/run-status.d с мостом telegram-poll.mjs:
// мост по ним буферизует входящие, канал хранит sessionId/turnId для отмены.
import {
  chatKeyOf,
  getChatStatus,
  RUN_STALE_MS,
  setChatStatus,
  setChatStatusIf,
} from "../lib/run-status.js";
import { handleTelegramResetRequest } from "../lib/telegram-reset-route.js";
// Отмена хода: публичный cancel eve отдаётся только роутам, поэтому «Стоп» — свой
// POST-роут, а мост зовёт его тем же секретом, что и reset.
import {
  handleTelegramCancelRequest,
  TELEGRAM_CANCEL_ROUTE,
} from "../lib/telegram-cancel-route.js";
import { handleTelegramStopCallback } from "../lib/telegram-stop.js";
import {
  handleAcceptedTelegramWebhook,
  TELEGRAM_ACCEPTANCE_ROUTE,
  wrapTelegramQueueOnMessage,
} from "../lib/telegram-acceptance.js";
import {
  abandonTelegramEarlyStatus,
  emitTelegramTurnLatency,
  markTelegramFirstOutput,
  markTelegramTurnAlive,
  publishTelegramEarlyStatus,
  publishTelegramTurnStarted,
} from "../lib/telegram-turn-start.js";

// Токен (TELEGRAM_BOT_TOKEN) и секрет вебхука (TELEGRAM_WEBHOOK_SECRET_TOKEN)
// читаются из окружения автоматически.

// Подсказка «нажмите /new» (agent/lib/context-fill.ts): одна строка после хода, ответ
// которого дошёл, когда вход последнего шага перешёл порог окна. Строка статическая, с
// одним процентом, поэтому гейт не проходит — как «Работаю…». Тихая: ответ уже прозвенел.
async function sendContextFillHint(
  tg: Pick<TelegramHandle, "chatId" | "messageThreadId" | "request">,
  sessionId: string,
  turnId: string,
): Promise<void> {
  const hint = takeContextFillHint(
    sessionId,
    turnId,
    providerConfig.contextWindow,
  );
  if (hint === null) return;
  let failure: unknown = null;
  try {
    const res = await tg.request("sendMessage", {
      chat_id: tg.chatId,
      text: contextFillHintText(hint.percent),
      disable_notification: true,
      ...(tg.messageThreadId !== undefined
        ? { message_thread_id: tg.messageThreadId }
        : {}),
    });
    if (!res.ok) failure = JSON.stringify(res.body).slice(0, 300);
  } catch (error) {
    failure = error;
  }
  if (failure === null) return;
  // Строка не дошла — порог не считается отмеченным, следующий ход скажет снова.
  returnContextFillHint(sessionId, hint.previous);
  console.error("[telegram] подсказка про /new не отправилась:", failure);
}

// --- ESC-остановка хода (аналог ESC в Claude Code) ---
//
// turn.started шлёт «Работаю…» с кнопкой [⏹ Стоп] (agent/lib/telegram-status-message.ts)
// и пишет running+sessionId+turnId в run-status. Нажатие кнопки (и /stop) ловит
// МОСТ: он читает статус и зовёт POST /eve/v1/telegram/cancel, а тот — публичный cancel
// eve из RouteHandlerArgs (agent/lib/eve-cancel.ts). Дальше eve абортит ход и присылает
// turn.cancelled, который правит статус-сообщение.

/**
 * Creates an Outbox transport that delivers a Telegram reply through Eve.
 *
 * The Outbox seam selects the rendered form; this transport performs Bot API calls,
 * records delivery failures, and preserves the requested quiet-delivery mode.
 */
// Что и в каком виде отдавать, решает шов (agent/lib/outbox.ts).
// stop канал не выставляет намеренно: ответ в диалоге короткий, и упавший кусок
// не повод молчать остальными. Обрыв хвоста — про ночные отчёты, не про разговор.
// При TELEGRAM_RICH_REPLIES=never ключа sendRich в транспорте нет вовсе, и шов
// (agent/lib/outbox.ts) сам уходит HTML-путём.
export function outboxTransport(
  tg: Pick<TelegramHandle, "chatId" | "messageThreadId" | "request" | "post">,
  richReplies: RichReplies,
  silent = false,
): OutboxTransport {
  const transport: OutboxTransport = {
    async sendHtml(html) {
      try {
        // eve's TelegramMessageBody type omits parse_mode, но рантайм
        // (normalizeTelegramMessageBody) спредит тело прямо в sendMessage —
        // поле доходит до Telegram, и от него зависит наш HTML-рендер. Расширяем тип локально.
        await tg.post({
          text: html,
          parse_mode: "HTML",
          ...(silent ? { disable_notification: true } : {}),
        } as TelegramMessageBody & { parse_mode: "HTML" });
        return { ok: true };
      } catch (err) {
        console.error(
          "[telegram] HTML отвергнут, шлю plain:",
          err,
          "| HTML:",
          html.slice(0, 300),
        );
        return { ok: false, error: String(err), retryPlain: true };
      }
    },
    async sendPlain(text) {
      try {
        await tg.post(silent ? { text, disable_notification: true } : text);
        return { ok: true };
      } catch (e2) {
        console.error("[telegram] plain-фолбэк тоже упал:", e2);
        return { ok: false, error: String(e2), retryPlain: false };
      }
    },
  };
  // Rich message (sendRichMessage, Bot API 10.1): таблицы/таск-листы/<details>/формулы/
  // кнопки рендерятся нативно — HTML-путь так не умеет. Любая ошибка (старый Bot API,
  // парс, лимит 32768, RICH_MESSAGE_*) уводит шов в HTML-путь, то есть в поведение до
  // rich. request() = raw Bot API call, транспорт JSON, поэтому rich_message шлём объектом.
  const sendRich = async (markdown: string): Promise<OutboxAck> => {
    try {
      const res = await tg.request("sendRichMessage", {
        chat_id: tg.chatId,
        rich_message: { markdown },
        ...(tg.messageThreadId !== undefined
          ? { message_thread_id: tg.messageThreadId }
          : {}),
        ...(silent ? { disable_notification: true } : {}),
      });
      if (res.ok) return { ok: true };
      console.error(
        "[telegram] sendRichMessage отвергнут, фолбэк HTML:",
        res.status,
        JSON.stringify(res.body).slice(0, 300),
      );
      return {
        ok: false,
        error: `sendRichMessage ${res.status}`,
        retryPlain: false,
      };
    } catch (err) {
      console.error("[telegram] sendRichMessage упал, фолбэк HTML:", err);
      return { ok: false, error: String(err), retryPlain: false };
    }
  };
  // TELEGRAM_RICH_REPLIES=never держит таблицы и прочее на HTML-пути, но кнопка живёт
  // только в rich-сообщении (ADR-0015): ответ с <tg-button> уходит rich в любом режиме,
  // иначе тег доехал бы до чата текстом.
  transport.sendRich =
    richReplies === "auto"
      ? sendRich
      : async (markdown) =>
          hasRichButtons(markdown)
            ? sendRich(markdown)
            : {
                ok: false,
                error: "TELEGRAM_RICH_REPLIES=never",
                retryPlain: false,
              };
  return transport;
}

// Пульс живого хода в run-status: без него жнец моста снимал молчаливый длинный ход
// как протухший (agent/lib/telegram-turn-start.ts).
function keepTurnAlive(
  channel: { telegram: Pick<TelegramHandle, "chatId" | "messageThreadId"> },
  ctx: { session: { id: string } },
): void {
  markTelegramTurnAlive({
    chatKey: chatKeyOf(
      channel.telegram.chatId,
      channel.telegram.messageThreadId,
    ),
    sessionId: ctx.session.id,
    getStatusImpl: getChatStatus,
    setStatusIfImpl: setChatStatusIf,
  });
}

const telegram = telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME ?? "my_bot",
  // Картинку/файл НЕ суём в запрос к модели (это и ломалось: octet-stream → reject, потом
  // инлайн → Bad Request от провайдера, плюс привязка к конкретному vision-API). "disabled" →
  // eve не качает и не инлайнит вложения вовсе; запрос к модели всегда чистый текст и не
  // ломается ни на каком провайдере. Файлы качает и сохраняет inbound-пайплайн, а модели отдаёт
  // ПУТЬ — посмотреть/прочитать она решает сама своими инструментами; не умеет — честно скажет.
  uploadPolicy: "disabled",
  // Кнопка ⏹ Стоп, пришедшая прямо в канал. В long-poll мост съедает колбэк раньше
  // (scripts/poller/main.ts зовёт handleControl до любой доставки), и этот путь не
  // срабатывает; он существует для webhook-режима, где моста нет вовсе. Отмена идёт
  // тем же публичным маршрутом — POST на собственный cancel-роут.
  // ВАЖНО: наличие этого хука закрывает дефолтную ветку eve НАВСЕГДА — «Unsupported
  // action.» на не-HITL колбэки больше не отправляется. Поэтому чужой колбэк гасим
  // сами пустым answerCallbackQuery: иначе у нажавшего вечный спиннер на кнопке.
  //
  // Кнопки, написанные моделью, в long-poll до этого хука не доходят вовсе: мост
  // превращает тап в обычное сообщение (scripts/poller/control.ts) и отдаёт его
  // inbound pipeline — подать сообщение в сессию каналу нечем, у него только Bot API,
  // а inbound pipeline читает сообщения. В webhook-режиме (моста нет) такой тап
  // остаётся без доставки: здесь он только гаснет.
  onCallbackQuery: async (ctx, query) => {
    const ack = async (text?: string) => {
      try {
        await ctx.telegram.request("answerCallbackQuery", {
          callback_query_id: query.id,
          ...(text === undefined ? {} : { text }),
        });
      } catch {
        /* протухший callback_query_id Telegram отвергает штатно */
      }
    };
    if (query.data !== TELEGRAM_STOP_CALLBACK) {
      await ack();
      return;
    }
    // Моста в этом режиме нет, поэтому о неостановленном ходе канал говорит сам: текст
    // уходит уже после ответа на колбэк. Кнопки рестарта тут нет — рестарт делает мост.
    const chatId = query.message?.chat?.id;
    await handleTelegramStopCallback(query, {
      ackImpl: ack,
      notifyImpl: async (text) => {
        if (chatId === undefined) return;
        await ctx.telegram.request("sendMessage", { chat_id: chatId, text });
      },
    });
  },
  events: {
    // Начало хода: сначала публикуем running, затем отправляем медленное статус-сообщение.
    // FIFO-мост не должен успеть принять следующую голову, пока Bot API отвечает.
    async "turn.started"(data, channel, ctx) {
      const tg = channel.telegram;
      await publishTelegramTurnStarted({
        chatKey: chatKeyOf(tg.chatId, tg.messageThreadId),
        sessionId: ctx.session.id,
        turnId: data.turnId,
        getStatusImpl: getChatStatus,
        setStatusIfImpl: setChatStatusIf,
        sendWorkingStatusImpl: (options) => sendWorkingStatus(tg, options),
        enableWorkingStatusStopImpl: (messageId) =>
          enableWorkingStatusStop(tg, messageId),
        removeWorkingStatusImpl: (messageId) =>
          tg.request("deleteMessage", {
            chat_id: tg.chatId,
            message_id: messageId,
          }),
        onWorkingStatusError: (error) =>
          console.error("[telegram] статус-сообщение не отправилось:", error),
      });
    },
    async "turn.completed"(data, channel, ctx) {
      await finishTelegramStatus(channel, ctx.session.id, "completed");
      await sendContextFillHint(channel.telegram, ctx.session.id, data.turnId);
    },
    async "turn.cancelled"(_data, channel, ctx) {
      await finishTelegramStatus(channel, ctx.session.id, "cancelled");
    },
    // Страховка: если терминальное turn-событие потерялось (краш), парковка сессии
    // снимает busy-флаг И удаляет осиротевший «Работаю…» — та же уборка, что у
    // turn.completed. После обычного финала CAS по sessionId не совпадает — no-op.
    async "session.waiting"(_data, channel, ctx) {
      await finishTelegramStatus(channel, ctx.session.id, "completed");
    },
    "message.appended"(_data, channel, ctx) {
      markTelegramFirstOutput({
        chatKey: chatKeyOf(
          channel.telegram.chatId,
          channel.telegram.messageThreadId,
        ),
        sessionId: ctx.session.id,
        getStatusImpl: getChatStatus,
        setStatusIfImpl: setChatStatusIf,
      });
      keepTurnAlive(channel, ctx);
    },
    // Пульс хода: тулзы — самый частый признак жизни длинного молчаливого хода.
    // action.partial (промежуточный снимок стримящего тула) держит пульс и внутри
    // ОДНОГО долгого вызова. Запись в run-status дросселирована внутри
    // markTelegramTurnAlive, поэтому на частоте событий это ничего не стоит.
    // Дефолт eve на этом событии — обновить «печатает…»; переопределяя его, обязаны
    // сохранить это сами, иначе индикатор набора умрёт между вызовами тулзов.
    async "actions.requested"(_data, channel, ctx) {
      keepTurnAlive(channel, ctx);
      await channel.telegram.startTyping();
    },
    "action.partial"(_data, channel, ctx) {
      keepTurnAlive(channel, ctx);
    },
    "action.result"(_data, channel, ctx) {
      keepTurnAlive(channel, ctx);
    },
    // Ответ модели уходит через Outbox — он же переопределяет дефолтную plain-доставку
    // eve. Промежуточный текст перед tool-calls не шлём (зеркалим дефолт). Повторного
    // хода модели на сбой доставки нет — ход уже закрыт, реформат произойдёт на следующем
    // сообщении (ошибка видна в логе/vault). Латентность засчитываем, только если ни одно
    // сообщение не потерялось: пустой рендер шов отдаёт с ok=false, поэтому проверки
    // delivered у вызывающего больше нет.
    async "message.completed"(data, channel, ctx) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      const { text: message, silent } = parseTelegramDelivery(data.message);
      const recordDelivery = (delivered: boolean) =>
        emitTelegramTurnLatency({
          chatKey: chatKeyOf(
            channel.telegram.chatId,
            channel.telegram.messageThreadId,
          ),
          sessionId: ctx.session.id,
          deliveryAt: Date.now(),
          delivered,
          getStatusImpl: getChatStatus,
          setStatusIfImpl: setChatStatusIf,
        });
      // Trace: одна отправка — одно событие журнала, каким бы путём шов её ни увёз
      // (rich, HTML, plain-фолбэк). Обёртка же ставит контекст хода, поэтому вердикт
      // outbound-Gate внутри шва уезжает с тем же ключом (ADR-0010).
      const result = await traceOutbox(
        {
          turn: data.turnId,
          session: ctx.session.id,
          source: "telegram",
        },
        message,
        () =>
          sendThroughOutbox(
            message,
            outboxTransport(channel.telegram, TELEGRAM_RICH_REPLIES, silent),
          ),
      );
      if (!result.ok) return;
      recordDelivery(true);
      markReplyDelivered(ctx.session.id, data.turnId);
    },
    // Ход упал: статус прибираем по CAS, но сообщение об ошибке от него не гейтим —
    // позднее terminal-событие всё равно должно объяснить пользователю, что произошло.
    async "turn.failed"(data, channel, ctx) {
      try {
        await finishTelegramStatus(channel, ctx.session.id, "failed");
      } catch {
        /* run-status не прибрался — сообщение об ошибке всё равно отправляем */
      }
      await notifyTelegramFailure(
        ctx.session.id,
        data.turnId,
        data,
        noticeSender((text) => channel.telegram.sendMessage(text)),
      );
    },
    // У terminal-сбоя eve следом за turn.failed шлёт session.failed без ctx.
    // Повторно прибираем run-status по sessionId из payload и не дублируем уведомление.
    async "session.failed"(data, channel) {
      if (channel.telegram.chatId) {
        try {
          await finishTelegramStatus(channel, data.sessionId, "failed");
        } catch {
          /* best-effort: отсутствие chat-state не должно ломать уведомление */
        }
      }
      await notifyTelegramFailure(
        data.sessionId,
        null,
        data,
        noticeSender((text) => channel.telegram.sendMessage(text)),
      );
    },
  },
  // Вход: канал только подаёт эффекты, разбор апдейта живёт в пайплайне.
  onMessage: wrapTelegramQueueOnMessage((ctx, message) => {
    const tg = ctx.telegram;
    const chatKey = chatKeyOf(message.chat.id, message.messageThreadId);
    let earlyIngressId: string | null = null;
    return runTelegramInbound(message, {
      botUsername: tg.botUsername,
      request: (method, body) => tg.request(method, body),
      sendMessage: noticeSender((text) => tg.sendMessage(text)),
      startTyping: () => tg.startTyping(),
      describeImage,
      chatModelSeesImages,
      transcribe,
      onAccepted: async () => {
        earlyIngressId = await publishTelegramEarlyStatus({
          chatKey,
          staleMs: RUN_STALE_MS,
          getStatusImpl: getChatStatus,
          setStatusIfImpl: setChatStatusIf,
          sendWorkingStatusImpl: (options) => sendWorkingStatus(tg, options),
          removeWorkingStatusImpl: (messageId) =>
            tg.request("deleteMessage", {
              chat_id: tg.chatId,
              message_id: messageId,
            }),
          onWorkingStatusError: (error) =>
            console.error(
              "[telegram] раннее статус-сообщение не отправилось:",
              error,
            ),
        });
      },
      onAbandoned: async () => {
        if (earlyIngressId === null) return;
        await abandonTelegramEarlyStatus({
          chatKey,
          ingressId: earlyIngressId,
          getStatusImpl: getChatStatus,
          setStatusIfImpl: setChatStatusIf,
          removeWorkingStatusImpl: (messageId) =>
            tg.request("deleteMessage", {
              chat_id: tg.chatId,
              message_id: messageId,
            }),
          onWorkingStatusError: (error) =>
            console.error(
              "[telegram] раннее статус-сообщение не удалилось:",
              error,
            ),
        });
      },
      consumeCancelledMark: () => {
        if (!getChatStatus(chatKey)?.wasCancelled) return false;
        setChatStatus(chatKey, { wasCancelled: null });
        return true;
      },
    });
  }),
});

const telegramWebhookRoute = telegram.routes.find(
  (route) =>
    route.transport !== "websocket" &&
    route.method === "POST" &&
    route.path === "/eve/v1/telegram",
);
if (!telegramWebhookRoute || telegramWebhookRoute.transport === "websocket") {
  throw new Error("telegramChannel did not expose its expected webhook route");
}

export default {
  ...telegram,
  routes: [
    ...telegram.routes,
    POST<TelegramChannelState>(TELEGRAM_ACCEPTANCE_ROUTE, (request, args) =>
      handleAcceptedTelegramWebhook(
        telegramWebhookRoute.handler,
        request,
        args,
      ),
    ),
    POST("/eve/v1/telegram/reset", (req, args) =>
      handleTelegramResetRequest(
        req,
        args,
        process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      ),
    ),
    POST(TELEGRAM_CANCEL_ROUTE, (req, { attachSession }) =>
      handleTelegramCancelRequest(
        req,
        attachSession,
        process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      ),
    ),
  ],
};
