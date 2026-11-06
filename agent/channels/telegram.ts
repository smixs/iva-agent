import {
  noteHelperReply,
  finishHelperOutcomes,
  discardHelperOutcomes,
} from "../lib/helper-outcome.ts";
import { randomInt, randomUUID } from "node:crypto";
import {
  telegramChannel,
  type TelegramChannelState,
  type TelegramHandle,
  type TelegramMessageBody,
} from "eve/channels/telegram";
import { POST } from "eve/channels";
import {
  flushSettledTelegramQuestions,
  postTelegramQuestion,
  settleTelegramQuestions,
} from "../lib/telegram-question.ts";
// Outbox — ЕДИНЫЙ шов наружу (тот же, через который уходят ночные отчёты cron):
// внутри него outbound-Gate, выбор rich/HTML, нарезка на чанки и plain-фолбэк.
import {
  noticeSender,
  sendThroughOutbox,
  type NoticeSend,
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
import {
  runTelegramInbound,
  type TelegramInboundMessage,
} from "../lib/telegram-inbound.js";
import { mediaFromRaw } from "../lib/telegram-parts.js";
import { traceOutbox } from "../lib/trace.js";
import { chatModelSeesImages, describeImage } from "../vision.js";
import { transcribe } from "../transcribe.js";
import {
  finishTelegramStatus,
  telegramDraftFetch,
  telegramDraftTurn,
  closeTelegramDraftTurn,
  closeTelegramDraftChat,
  startTelegramAcceptedTyping,
  closeTelegramAcceptedTyping,
} from "../lib/telegram-draft.ts";
import { notifyTelegramFailure } from "../lib/telegram-failure-notice.js";
import { rememberTurnQuestion, turnQuestion } from "../lib/turn-question.js";
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
import { handleTelegramDraftStopRequest } from "../lib/telegram-stop.ts";
// Свёртка между ходами: история пересказывается, пока человек ничего не ждёт, а чат на
// это время занят записью running + compacting (agent/lib/idle-compaction.ts).
import {
  localSessionCompactUrl,
  requestSessionCompact,
} from "../lib/eve-compact.js";
import {
  closeIdleCompactionTurn,
  dropIdleCompactionTurn,
  endIdleCompaction,
  openIdleCompactionTurn,
  parkIdleCompactionTurn,
  startIdleCompaction,
  idleCompactionDue,
  takeManualCompactionReport,
} from "../lib/idle-compaction.js";
import {
  handleTelegramCompactRequest,
  TELEGRAM_COMPACT_ROUTE,
  compactThousands,
} from "../lib/telegram-compact-route.ts";
import { tr } from "../lib/i18n.ts";
import { providerConfig } from "../provider.js";
import {
  handleAcceptedTelegramWebhook,
  TELEGRAM_ACCEPTANCE_ROUTE,
  wrapTelegramQueueOnMessage,
  telegramTurnPolicy,
} from "../lib/telegram-acceptance.js";
import {
  abandonTelegramEarlyStatus,
  chatTakeOverPatch,
  detachQueuedSignTime,
  dropQueuedStatus,
  emitTelegramTurnLatency,
  markTelegramFirstOutput,
  markTelegramTurnAlive,
  publishTelegramEarlyStatus,
  publishTelegramTurnStarted,
  takeOverTelegramChat,
} from "../lib/telegram-turn-start.js";

// Токен (TELEGRAM_BOT_TOKEN) и секрет вебхука (TELEGRAM_WEBHOOK_SECRET_TOKEN)
// читаются из окружения автоматически.

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
      const reason = (res.body as { description?: unknown } | null)
        ?.description;
      return {
        ok: false,
        error: `sendRichMessage ${res.status}${typeof reason === "string" ? `: ${reason}` : ""}`,
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

// Вопрос хода для сообщения об обрыве (turn-question.ts): текст принятого сообщения чата и
// метка вложения. Голос и фото без подписи стирают прежний вопрос.
export async function rememberAccepted<T>(
  chatKey: string,
  message: TelegramInboundMessage,
  turn: Promise<T | null>,
): Promise<T | null> {
  const accepted = await turn;
  if (accepted !== null)
    rememberTurnQuestion(chatKey, {
      text: message.text || message.caption,
      media:
        message.attachments.length > 0 || mediaFromRaw(message.raw) !== null,
    });
  return accepted;
}

// Что сообщение об обрыве знает о вопросе. Чат не личный или тип неизвестен — цитаты нет:
// её увидели бы все участники.
function chatQuestion(channel: {
  telegram: Pick<TelegramHandle, "chatId" | "messageThreadId">;
  state: Pick<TelegramChannelState, "chatType">;
}): {
  question?: string;
  media?: boolean;
  group: boolean;
  chatId: string | number | undefined;
} {
  const tg = channel.telegram;
  const group = channel.state.chatType !== "private";
  const asked = tg.chatId
    ? turnQuestion(chatKeyOf(tg.chatId, tg.messageThreadId))
    : undefined;
  return asked === undefined
    ? { group, chatId: tg.chatId }
    : { question: asked.text, media: asked.media, group, chatId: tg.chatId };
}

// Сообщение о сбое хода. Простой текст уходит одним sendMessage, как раньше; текст с кнопкой
// «Повторить» (обрыв посреди ответа) — швом Outbox, потому что кнопка живёт только в
// rich-сообщении (ADR-0015). Гейт стоит на обоих путях: noticeSender и сам шов.
function failureSender(
  tg: Pick<
    TelegramHandle,
    "chatId" | "messageThreadId" | "request" | "post" | "sendMessage"
  >,
): NoticeSend {
  return noticeSender(async (text) => {
    if (!hasRichButtons(text)) return tg.sendMessage(text);
    const sent = await sendThroughOutbox(
      text,
      outboxTransport(tg, TELEGRAM_RICH_REPLIES),
    );
    if (!sent.ok) throw new Error(sent.error);
    return sent;
  });
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

async function notifyManualCompaction(
  telegram: Pick<TelegramHandle, "sendMessage">,
  manual: ReturnType<typeof endIdleCompaction>,
) {
  if (!manual) return;
  await noticeSender((text) => telegram.sendMessage(text))(
    manual.completed
      ? tr(
          `Compressed the conversation: it was ≈${compactThousands(manual.before)}k tokens. I'll measure the new size with the next answer.`,
          `Сжала разговор: было ≈${compactThousands(manual.before)} тыс. Новый размер измерю со следующим ответом.`,
        )
      : tr(
          "Compression was interrupted. Try /compact again.",
          "Сжатие прервалось. Повтори /compact.",
        ),
  );
}

function compactTelegramSession(
  chatKey: string,
  sessionId: string,
  manual = false,
) {
  const bearer = process.env.ASSISTANT_BEARER?.trim();
  return startIdleCompaction({
    sessionId,
    manual,
    claimImpl: () => claimChatForCompaction(chatKey, sessionId, bearer),
    requestImpl: (id) =>
      requestSessionCompact({
        url: localSessionCompactUrl(id),
        bearer: bearer ?? "",
      }),
    releaseImpl: () => releaseCompactionClaim(chatKey, sessionId),
  });
}

let bearerMissingLogged = false;

// Занять свободный чат под пересказ между ходами — тем же захватом, что ход и напоминание.
// Живой чужой ход (успело прийти сообщение) и сброшенную сессию (/new оставляет resetAt) не
// трогаем: пересказа не будет. Без общего токена eve откажет: чат не занимаем, а причину
// один раз пишем в журнал.
async function claimChatForCompaction(
  chatKey: string,
  sessionId: string,
  bearer: string | undefined,
): Promise<boolean> {
  if (!bearer) {
    if (!bearerMissingLogged)
      console.error(
        "[telegram] свёртка между ходами выключена: нет ASSISTANT_BEARER — run: iva doctor",
      );
    bearerMissingLogged = true;
    return false;
  }
  const own = getChatStatus(chatKey);
  if (
    own?.resetAt === undefined &&
    own?.sessionId === sessionId &&
    own.compacting === true
  )
    return true;
  return takeOverTelegramChat({
    chatKey,
    patch: chatTakeOverPatch({ sessionId, compacting: true }),
    staleMs: RUN_STALE_MS,
    getStatusImpl: getChatStatus,
    setStatusIfImpl: setChatStatusIf,
    refuseImpl: (status) => status?.resetAt !== undefined,
    onWorkingStatusError: (error) =>
      console.error("[telegram] чат под свёртку между ходами не занят:", error),
  });
}

// Освободить чат после отказа eve: только свою запись пересказа, не запись начавшегося хода.
const releaseCompactionClaim = (chatKey: string, sessionId: string) =>
  setChatStatusIf(
    chatKey,
    { sessionId, compacting: true },
    { status: "idle", sessionId: null, compacting: null },
  );

const telegram = telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME ?? "my_bot",
  // Картинку/файл НЕ суём в запрос к модели (это и ломалось: octet-stream → reject, потом
  // инлайн → Bad Request от провайдера, плюс привязка к конкретному vision-API). "disabled" →
  // eve не качает и не инлайнит вложения вовсе; запрос к модели всегда чистый текст и не
  // ломается ни на каком провайдере. Файлы качает и сохраняет inbound-пайплайн, а модели отдаёт
  // ПУТЬ — посмотреть/прочитать она решает сама своими инструментами; не умеет — честно скажет.
  uploadPolicy: "disabled",
  api: { fetch: telegramDraftFetch() },
  // Unknown callbacks receive a quiet acknowledgement.
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
    await ack();
  },
  events: {
    async "input.requested"(data, channel, ctx) {
      await closeTelegramDraftTurn(
        ctx.session.id,
        data.turnId,
        undefined,
        true,
      );
      for (const request of data.requests)
        await postTelegramQuestion(request, channel.state, channel.telegram, {
          rich: TELEGRAM_RICH_REPLIES === "auto",
          continuation: channel.continuation,
        });
    },
    async "input.resolved"(data, channel) {
      try {
        detachQueuedSignTime({
          chatKey: chatKeyOf(
            channel.telegram.chatId,
            channel.telegram.messageThreadId,
          ),
          getStatusImpl: getChatStatus,
          setStatusIfImpl: setChatStatusIf,
        });
      } catch (error) {
        console.error("[telegram] знак очереди не отвязан от ответа:", error);
      }
      await settleTelegramQuestions(
        data.resolutions,
        channel.state,
        channel.telegram,
      );
    },
    async "turn.started"(data, channel, ctx) {
      const tg = channel.telegram;
      openIdleCompactionTurn(ctx.session.id);
      const draftId = randomInt(1, 2 ** 31);
      const published = await publishTelegramTurnStarted({
        chatKey: chatKeyOf(tg.chatId, tg.messageThreadId),
        sessionId: ctx.session.id,
        turnId: data.turnId,
        draftId,
        getStatusImpl: getChatStatus,
        setStatusIfImpl: setChatStatusIf,
        onWorkingStatusError: (error) =>
          console.error("[telegram] turn claim failed:", error),
      });
      telegramDraftTurn(
        tg,
        ctx.session.id,
        data.turnId,
        published &&
          channel.state.chatType === "private" &&
          tg.messageThreadId === undefined,
        { sessionId: ctx.session.id, turnId: data.turnId, draftId },
        published,
      );
      await flushSettledTelegramQuestions(channel.state, channel.telegram);
    },
    async "turn.completed"(_data, channel, ctx) {
      if (!ctx?.session) return;
      await finishHelperOutcomes(
        { sessionId: ctx.session.id, turnId: _data.turnId },
        Date.now(),
      );
      try {
        await flushSettledTelegramQuestions(channel.state, channel.telegram);
      } finally {
        const report = takeManualCompactionReport(ctx.session.id);
        closeIdleCompactionTurn(ctx.session.id, providerConfig.contextWindow);
        await finishTelegramStatus(
          channel,
          ctx.session.id,
          "completed",
          _data.turnId,
          Boolean(
            process.env.ASSISTANT_BEARER?.trim() &&
            idleCompactionDue(ctx.session.id),
          ),
        );
        if (report)
          await noticeSender((text) => channel.telegram.sendMessage(text))(
            tr(
              `Compressed the conversation: ≈${compactThousands(report.before)}k → ≈${compactThousands(report.after)}k tokens.`,
              `Сжала разговор: было ≈${compactThousands(report.before)} тыс. → стало ≈${compactThousands(report.after)} тыс.`,
            ),
          );
      }
    },
    async "turn.cancelled"(_data, channel, ctx) {
      if (!ctx?.session) return;
      discardHelperOutcomes(ctx.session.id, _data.turnId);
      const tg = channel.telegram;
      const status = getChatStatus(chatKeyOf(tg.chatId, tg.messageThreadId));
      const compacting =
        status?.status === "running" && status.compacting === true;
      try {
        await finishTelegramStatus(
          channel,
          ctx.session.id,
          compacting ? "completed" : "cancelled",
          compacting ? undefined : _data.turnId,
        );
      } finally {
        dropIdleCompactionTurn(ctx.session.id);
      }
    },
    async "session.waiting"(_data, channel, ctx) {
      const sessionId = ctx.session.id;
      const chatKey = chatKeyOf(
        channel.telegram.chatId,
        channel.telegram.messageThreadId,
      );
      const bearer = process.env.ASSISTANT_BEARER?.trim();
      let manual: ReturnType<typeof endIdleCompaction> = null;
      try {
        const parked = getChatStatus(chatKey);
        // Парковка застала запись пересказа этой сессии: он кончился.
        if (
          parked?.sessionId === sessionId &&
          parked.compacting === true &&
          !idleCompactionDue(sessionId)
        ) {
          manual = endIdleCompaction(sessionId);
        }
        await finishTelegramStatus(
          channel,
          sessionId,
          "completed",
          undefined,
          Boolean(
            bearer &&
            parked?.resetAt === undefined &&
            idleCompactionDue(sessionId),
          ),
        );
        await notifyManualCompaction(channel.telegram, manual);
      } finally {
        // Ждём ответа eve: она ждёт этот обработчик, поэтому просьба встаёт в её очередь
        // раньше, чем она возьмёт следующее сообщение, и пересказ идёт под записью.
        parkIdleCompactionTurn(sessionId);
        await compactTelegramSession(chatKey, sessionId);
      }
      await flushSettledTelegramQuestions(channel.state, channel.telegram);
    },
    "message.appended"(_data, channel, ctx) {
      telegramDraftTurn(
        channel.telegram,
        ctx.session.id,
        _data.turnId,
        channel.state.chatType === "private" &&
          channel.telegram.messageThreadId === undefined,
      )?.append(_data.stepIndex, _data.messageDelta);
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
    "actions.requested"(_data, channel, ctx) {
      keepTurnAlive(channel, ctx);
      telegramDraftTurn(
        channel.telegram,
        ctx.session.id,
        _data.turnId,
        channel.state.chatType === "private" &&
          channel.telegram.messageThreadId === undefined,
      )?.requested(_data.stepIndex, _data.actions);
    },
    "action.partial"(_data, channel, ctx) {
      telegramDraftTurn(
        channel.telegram,
        ctx.session.id,
        _data.turnId,
        channel.state.chatType === "private" &&
          channel.telegram.messageThreadId === undefined,
      );
      keepTurnAlive(channel, ctx);
    },
    "action.result"(_data, channel, ctx) {
      telegramDraftTurn(
        channel.telegram,
        ctx.session.id,
        _data.turnId,
        channel.state.chatType === "private" &&
          channel.telegram.messageThreadId === undefined,
      )?.result(_data.result.callId);
      keepTurnAlive(channel, ctx);
    },
    async "message.completed"(data, channel, ctx) {
      if (!ctx?.session) return;
      if (data.finishReason === "tool-calls") {
        telegramDraftTurn(
          channel.telegram,
          ctx.session.id,
          data.turnId,
          channel.state.chatType === "private" &&
            channel.telegram.messageThreadId === undefined,
        )?.completeStep(data.stepIndex, data.message ?? "");
        return;
      }
      await closeTelegramDraftChat(
        channel.telegram,
        ctx.session.id,
        data.turnId,
      );
      if (!data.message) return;
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
      noteHelperReply(
        { sessionId: ctx.session.id, turnId: data.turnId },
        message,
      );
    },
    async "turn.failed"(data, channel, ctx) {
      if (!ctx?.session) return;
      discardHelperOutcomes(ctx.session.id, data.turnId);
      dropIdleCompactionTurn(ctx.session.id);
      try {
        await finishTelegramStatus(
          channel,
          ctx.session.id,
          "failed",
          data.turnId,
        );
      } catch {
        /* run-status не прибрался — сообщение об ошибке всё равно отправляем */
      }
      await notifyTelegramFailure(
        ctx.session.id,
        data.turnId,
        { ...data, ...chatQuestion(channel) },
        failureSender(channel.telegram),
      );
    },
    async "session.failed"(data, channel) {
      discardHelperOutcomes(data.sessionId);
      const tg = channel.telegram;
      if (tg.chatId) {
        try {
          await finishTelegramStatus(channel, data.sessionId, "failed");
          await dropQueuedStatus({
            chatKey: chatKeyOf(tg.chatId, tg.messageThreadId),
            sessionId: data.sessionId,
            getStatusImpl: getChatStatus,
            setStatusIfImpl: setChatStatusIf,
          });
        } catch {
          /* best-effort: отсутствие chat-state не должно ломать уведомление */
        }
      }
      await notifyTelegramFailure(
        data.sessionId,
        null,
        { ...data, ...chatQuestion(channel) },
        failureSender(channel.telegram),
      );
    },
  },
  // Вход: канал только подаёт эффекты, разбор апдейта живёт в пайплайне.
  onMessage: wrapTelegramQueueOnMessage((ctx, message) => {
    const tg = ctx.telegram;
    const chatKey = chatKeyOf(message.chat.id, message.messageThreadId);
    const ingressId = randomUUID();
    const receivedStatus = getChatStatus(chatKey);
    const receivedDuringTurn =
      telegramTurnPolicy() === "steer" &&
      receivedStatus?.status === "running" &&
      receivedStatus.compacting !== true &&
      Date.now() - (receivedStatus.updatedAt ?? 0) < RUN_STALE_MS;
    return rememberAccepted(
      chatKey,
      message,
      runTelegramInbound(message, {
        botUsername: tg.botUsername,
        request: (method, body) => tg.request(method, body),
        sendMessage: noticeSender((text) => tg.sendMessage(text)),
        startTyping: () => tg.startTyping(),
        describeImage,
        chatModelSeesImages,
        transcribe,
        onAccepted: async () => {
          const claimed = await publishTelegramEarlyStatus({
            chatKey,
            ingressId,
            staleMs: RUN_STALE_MS,
            getStatusImpl: getChatStatus,
            setStatusIfImpl: setChatStatusIf,
          });
          if (claimed) startTelegramAcceptedTyping(tg, claimed);
        },
        onAbandoned: async () => {
          closeTelegramAcceptedTyping(tg, ingressId);
          await abandonTelegramEarlyStatus({
            chatKey,
            ingressId,
            getStatusImpl: getChatStatus,
            setStatusIfImpl: setChatStatusIf,
          });
        },
        receivedDuringTurn,
        consumeCancelledMark: () => {
          if (!getChatStatus(chatKey)?.wasCancelled) return false;
          setChatStatus(chatKey, { wasCancelled: null });
          return true;
        },
      }),
    );
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
    ...telegram.routes.map((route) =>
      route === telegramWebhookRoute
        ? {
            ...route,
            handler: (
              request: Request,
              args: Parameters<typeof telegramWebhookRoute.handler>[1],
            ) =>
              handleTelegramDraftStopRequest(
                request,
                (req) => telegramWebhookRoute.handler(req, args),
                process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
              ),
          }
        : route,
    ),
    POST<TelegramChannelState>(TELEGRAM_ACCEPTANCE_ROUTE, (request, args) =>
      handleAcceptedTelegramWebhook(
        telegramWebhookRoute.handler,
        request,
        args,
      ),
    ),
    POST(TELEGRAM_COMPACT_ROUTE, (req, args) =>
      handleTelegramCompactRequest(
        req,
        args,
        (key, id) => compactTelegramSession(key, id, true),
        process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
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
