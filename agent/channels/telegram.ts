import {
  noteHelperReply,
  finishHelperOutcomes,
  discardHelperOutcomes,
} from "../lib/helper-outcome.ts";
import { randomInt, randomUUID } from "node:crypto";
import {
  telegramChannel,
  type TelegramApiOptions,
  type TelegramChannel,
  type TelegramChannelState,
  type TelegramHandle,
  type TelegramMessageBody,
} from "eve/channels/telegram";
import { POST, type ChannelSource, type RouteHandlerArgs } from "eve/channels";
import {
  botIdFromUpdate,
  botScopedKey,
  configuredTelegramBotIds,
  isConfiguredPeerBot,
  resolveTelegramBot,
  TELEGRAM_BOT_ID_HEADER,
  validTelegramBotId,
  type TelegramBotConfig,
} from "../../packages/telegram-bots/index.ts";
import { completeInboundPeerAssignment } from "../lib/colleague-assignments.ts";
import {
  activeTelegramBot,
  activeTelegramBotToken,
  botFromChannelState,
  colleagueBotIdOf,
  withTelegramBot,
} from "../lib/telegram-bot-context.ts";
import { isColleaguesEnabled } from "../lib/colleagues.ts";
import {
  flushSettledTelegramQuestions,
  postTelegramQuestion,
  settleTelegramQuestions,
  transport as boundedRequest,
} from "../lib/telegram-question.ts";
// Outbox — ЕДИНЫЙ шов наружу (тот же, через который уходят ночные отчёты cron):
// внутри него outbound-Gate, выбор rich/HTML, нарезка на чанки и plain-фолбэк.
import {
  noticeSender,
  redactNotice,
  sendThroughOutbox,
  type NoticeSend,
  type OutboxAck,
  type OutboxTransport,
  type StatusReply,
  type StatusTransport,
} from "../lib/outbox.js";
import { hasRichButtons } from "../lib/telegram-format.js";
import {
  parseTelegramDelivery,
  parseTelegramQuiet,
} from "../lib/telegram-delivery.js";
import {
  TELEGRAM_RICH_REPLIES,
  type RichReplies,
} from "../lib/telegram-rich-replies.js";
import { TELEGRAM_WIDGETS } from "../lib/telegram-widget.ts";
// Inbound-пайплайн — единственный вход внутрь: allowlist, решение о диспатче,
// запись в Vault, медиа со зрением и транскрипцией, inbound-Gate и контекст хода.
// Канал приносит ему эффекты и сам про разбор входящего ничего не знает.
import {
  isExplicitlyAddressedInGroup,
  runTelegramInbound,
  type TelegramInboundMessage,
} from "../lib/telegram-inbound.js";
import { mediaFromRaw } from "../lib/telegram-parts.js";
import { traceOutbox, traceStatus } from "../lib/trace.js";
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
  draftText,
  retireProgressMessage,
} from "../lib/telegram-draft.ts";
import { notifyTelegramFailure } from "../lib/telegram-failure-notice.js";
import { rememberTurnQuestion, turnQuestion } from "../lib/turn-question.js";
// Состояние «идёт ли ход» — per-chat файлы data/run-status.d с мостом telegram-poll.mjs:
// мост по ним буферизует входящие, канал хранит sessionId/turnId для отмены.
import {
  chatKeyOf,
  chatState,
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
// Свёртка идёт один раз — в самой eve перед шагом модели. /compact ставит ей пометку через
// штатный роут eve-канала; канал сам историю не пересказывает.
import {
  localSessionCompactUrl,
  requestSessionCompact,
} from "../lib/eve-compact.js";
import {
  handleTelegramCompactRequest,
  TELEGRAM_COMPACT_ROUTE,
} from "../lib/telegram-compact-route.ts";
import {
  handleAcceptedTelegramWebhook,
  preparePeerBotWebhookRequest,
  TELEGRAM_ACCEPTANCE_ROUTE,
  wrapTelegramQueueOnMessage,
  telegramTurnPolicy,
} from "../lib/telegram-acceptance.js";
import {
  abandonTelegramEarlyStatus,
  detachQueuedSignTime,
  dropQueuedStatus,
  emitTelegramTurnLatency,
  markTelegramFirstOutput,
  markTelegramTurnAlive,
  publishTelegramEarlyStatus,
  publishTelegramTurnStarted,
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
  botToken?: string,
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
  const token =
    botToken ?? activeTelegramBot()?.token ?? process.env.TELEGRAM_BOT_TOKEN;
  if (TELEGRAM_WIDGETS === "auto" && token)
    transport.sendWidget = (html, caption) =>
      sendWidget(token, tg, html, caption, silent);
  return transport;
}

// Сообщение-статус долгого хода: сырые sendMessage, editMessageText и deleteMessage. Всегда
// parse_mode HTML (plain — повтор шва при отказе по разметке) и всегда без звука; rich и
// виджет сюда не заходят, TELEGRAM_RICH_REPLIES не читается. Правка и удаление идут со сроком
// (по умолчанию 10 с) на весь транспорт, считая повтор без тегов: один шаг держит обработчик не
// дольше срока. Пост без срока: ответ на принятый запрос терять нельзя, иначе id потерян, а
// сообщение в чате. Транспорт создаётся на один шаг; срок начинается с первого запроса с ним.
const STATUS_REQUEST_TIMEOUT_MS = 10_000;
// Снятие сообщения прошлого хода в turn.started держит публикацию нового хода: срок короче.
const STATUS_RETIRE_TIMEOUT_MS = 3_000;
export function statusTransport(
  tg: Pick<TelegramHandle, "chatId" | "messageThreadId" | "request">,
  timeoutMs = STATUS_REQUEST_TIMEOUT_MS,
): StatusTransport {
  let deadline: number | undefined;
  const call = (
    method: string,
    body: Record<string, unknown>,
    bounded: boolean,
  ) => {
    if (bounded) deadline ??= performance.now() + timeoutMs;
    return boundedRequest(tg, bounded ? deadline : undefined)(
      method,
      body,
    ) as Promise<StatusReply>;
  };
  const markup = (mode: "html" | "plain") =>
    mode === "html" ? { parse_mode: "HTML" } : {};
  return {
    send: (text, mode) =>
      call(
        "sendMessage",
        {
          chat_id: tg.chatId,
          text,
          ...markup(mode),
          disable_notification: true,
          ...(tg.messageThreadId === undefined
            ? {}
            : { message_thread_id: tg.messageThreadId }),
        },
        false,
      ),
    edit: (id, text, mode) =>
      call(
        "editMessageText",
        { chat_id: tg.chatId, message_id: id, text, ...markup(mode) },
        true,
      ),
    remove: (id) =>
      call("deleteMessage", { chat_id: tg.chatId, message_id: id }, true),
  };
}

type ScopedTelegramHandle = TelegramHandle & { readonly botId?: string | null };

function wrapTelegramHandle(
  tg: TelegramHandle,
  bot: TelegramBotConfig,
): ScopedTelegramHandle {
  const botId = colleagueBotIdOf(bot);
  return {
    botId,
    botUsername: bot.username ?? tg.botUsername,
    chatId: tg.chatId,
    chatType: tg.chatType,
    conversationId: tg.conversationId,
    messageThreadId: tg.messageThreadId,
    request: (method, body) =>
      withTelegramBot(bot, () => tg.request(method, body)),
    post: (message) => withTelegramBot(bot, () => tg.post(message)),
    postEphemeral: (userId, message, options) =>
      withTelegramBot(bot, () => tg.postEphemeral(userId, message, options)),
    sendMessage: (message) =>
      withTelegramBot(bot, () => tg.sendMessage(message)),
    startTyping: (action) => withTelegramBot(bot, () => tg.startTyping(action)),
    answerCallbackQuery: (input) =>
      withTelegramBot(bot, () => tg.answerCallbackQuery(input)),
    editMessageReplyMarkup: (input) =>
      withTelegramBot(bot, () => tg.editMessageReplyMarkup(input)),
    editMessageText: (input) =>
      withTelegramBot(bot, () => tg.editMessageText(input)),
  };
}

// finishTelegramStatus удаляет сообщение-статус после своей записи и берёт для этого транспорт канала.
const withStatusTransport = (channel: {
  telegram: Pick<
    ScopedTelegramHandle,
    "chatId" | "messageThreadId" | "request" | "botId"
  >;
}) => ({
  telegram: channel.telegram,
  statusTransport: statusTransport(channel.telegram),
});

// sendWidget (Bot API 10.4) идёт своим вызовом, как send_file. Отказ — подпись текстом
// (шов Outbox).
async function sendWidget(
  token: string,
  tg: Pick<TelegramHandle, "chatId" | "messageThreadId">,
  html: string,
  caption: string,
  silent: boolean,
): Promise<OutboxAck> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendWidget`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: tg.chatId,
        html,
        ...(caption ? { caption } : {}),
        ...(tg.messageThreadId !== undefined
          ? { message_thread_id: tg.messageThreadId }
          : {}),
        ...(silent ? { disable_notification: true } : {}),
      }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as {
      description?: unknown;
    } | null;
    const reason =
      typeof body?.description === "string" ? `: ${body.description}` : "";
    console.error(
      "[telegram] sendWidget отвергнут, шлю подпись:",
      res.status,
      reason,
    );
    return {
      ok: false,
      error: `sendWidget ${res.status}${reason}`,
      retryPlain: false,
    };
  } catch (err) {
    const text = (err instanceof Error ? err.message : String(err)).replaceAll(
      token,
      "***",
    );
    console.error("[telegram] sendWidget упал, шлю подпись:", text);
    return { ok: false, error: `sendWidget: ${text}`, retryPlain: false };
  }
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
function chatQuestion(
  channel: {
    telegram: Pick<TelegramHandle, "chatId" | "messageThreadId">;
    state: Pick<TelegramChannelState, "chatType">;
  },
  botId: string | null = null,
): {
  question?: string;
  media?: boolean;
  group: boolean;
  chatId: string | number | undefined;
} {
  const tg = channel.telegram;
  const group = channel.state.chatType !== "private";
  const asked = tg.chatId
    ? turnQuestion(chatKeyOf(tg.chatId, tg.messageThreadId, botId))
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
  botToken?: string,
): NoticeSend {
  return noticeSender(async (text) => {
    if (!hasRichButtons(text)) return tg.sendMessage(text);
    const sent = await sendThroughOutbox(
      text,
      outboxTransport(tg, TELEGRAM_RICH_REPLIES, false, botToken),
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
  botId: string | null = null,
): void {
  markTelegramTurnAlive({
    chatKey: chatKeyOf(
      channel.telegram.chatId,
      channel.telegram.messageThreadId,
      botId,
    ),
    sessionId: ctx.session.id,
    getStatusImpl: getChatStatus,
    setStatusIfImpl: setChatStatusIf,
  });
}

let bearerMissingLogged = false;

// Поставить сессии пометку свёртки: eve возьмёт её в той же свёртке перед следующим шагом
// модели. Без общего токена роут недоступен — причину один раз пишем в журнал.
async function compactTelegramSession(sessionId: string): Promise<boolean> {
  const bearer = process.env.ASSISTANT_BEARER?.trim();
  if (!bearer) {
    if (!bearerMissingLogged)
      console.error(
        "[telegram] свёртка выключена: нет ASSISTANT_BEARER — run: iva doctor",
      );
    bearerMissingLogged = true;
    return false;
  }
  return requestSessionCompact({
    url: localSessionCompactUrl(sessionId),
    bearer,
  });
}

async function botIdFromWebhookRequest(
  request: Request,
): Promise<string | null> {
  const header = request.headers.get(TELEGRAM_BOT_ID_HEADER)?.trim();
  if (validTelegramBotId(header)) return header;
  try {
    return botIdFromUpdate(await request.clone().json());
  } catch {
    return null;
  }
}

function scopeWebhookArgs(
  args: RouteHandlerArgs<TelegramChannelState>,
  bot: TelegramBotConfig | null,
): RouteHandlerArgs<TelegramChannelState> {
  const colleagueId = colleagueBotIdOf(bot);
  if (colleagueId === null) return args;
  const scoped = (address: string) => botScopedKey(address, colleagueId);
  const attachBotState = (
    state: TelegramChannelState | undefined,
  ): TelegramChannelState | undefined =>
    state === undefined
      ? state
      : ({
          ...state,
          botId: colleagueId,
          ...(bot?.username ? { botUsername: bot.username } : {}),
        } as TelegramChannelState);
  return {
    ...args,
    resolveSession: (address) => args.resolveSession(scoped(address)),
    from: (address) => {
      const source = args.from(scoped(address));
      const send: ChannelSource<TelegramChannelState>["send"] = (
        message,
        options,
      ) =>
        source.send(message, {
          ...options,
          ...(options?.state === undefined
            ? {}
            : { state: attachBotState(options.state) }),
        });
      return {
        cancel: source.cancel.bind(source),
        clear: source.clear.bind(source),
        compact: source.compact.bind(source),
        reset: source.reset.bind(source),
        respond: source.respond.bind(source),
        send,
      };
    },
  };
}

type RuntimeChannelAdapter = {
  createAdapterContext?: (base: {
    state: TelegramChannelState;
    session: { continuation?: { rekey: (token: string) => void } };
    ctx: unknown;
  }) => { telegram?: TelegramHandle; [key: string]: unknown };
  [key: string]: unknown;
};

export function createTelegramChannel(
  options: {
    readonly api?: Omit<TelegramApiOptions, "credentials">;
    readonly env?: () => NodeJS.ProcessEnv;
  } = {},
): TelegramChannel {
  const getEnv = options.env ?? (() => process.env);
  const runWithState = <T>(
    state: TelegramChannelState,
    telegramHandle: TelegramHandle,
    fn: (
      bot: TelegramBotConfig | null,
      colleagueId: string | null,
      tg: ScopedTelegramHandle,
    ) => T,
  ): T => {
    const bot = botFromChannelState(state, getEnv());
    const colleagueId = colleagueBotIdOf(bot);
    const tg = bot ? wrapTelegramHandle(telegramHandle, bot) : telegramHandle;
    return bot
      ? withTelegramBot(bot, () => fn(bot, colleagueId, tg))
      : fn(null, null, tg);
  };

  const telegram = telegramChannel({
    botUsername: getEnv().TELEGRAM_BOT_USERNAME ?? "my_bot",
    // Картинку/файл НЕ суём в запрос к модели (это и ломалось: octet-stream → reject, потом
    // инлайн → Bad Request от провайдера, плюс привязка к конкретному vision-API). "disabled" →
    // eve не качает и не инлайнит вложения вовсе; запрос к модели всегда чистый текст и не
    // ломается ни на каком провайдере. Файлы качает и сохраняет inbound-пайплайн, а модели отдаёт
    // ПУТЬ — посмотреть/прочитать она решает сама своими инструментами; не умеет — честно скажет.
    uploadPolicy: "disabled",
    credentials: {
      botToken: () => activeTelegramBotToken(getEnv()),
    },
    api: { ...options.api, fetch: telegramDraftFetch(options.api?.fetch) },
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
        await runWithState(
          channel.state,
          channel.telegram,
          async (_bot, _colleagueId, tg) => {
            await closeTelegramDraftTurn(
              ctx.session.id,
              data.turnId,
              undefined,
              true,
            );
            for (const request of data.requests)
              await postTelegramQuestion(request, channel.state, tg, {
                rich: TELEGRAM_RICH_REPLIES === "auto",
                continuation: channel.continuation,
              });
          },
        );
      },
      async "input.resolved"(data, channel) {
        await runWithState(
          channel.state,
          channel.telegram,
          async (_bot, colleagueId, tg) => {
            try {
              detachQueuedSignTime({
                chatKey: chatKeyOf(tg.chatId, tg.messageThreadId, colleagueId),
                getStatusImpl: getChatStatus,
                setStatusIfImpl: setChatStatusIf,
              });
            } catch (error) {
              console.error(
                "[telegram] знак очереди не отвязан от ответа:",
                error,
              );
            }
            await settleTelegramQuestions(data.resolutions, channel.state, tg);
          },
        );
      },
      async "turn.started"(data, channel, ctx) {
        await runWithState(
          channel.state,
          channel.telegram,
          async (_bot, colleagueId, tg) => {
            const key = chatKeyOf(tg.chatId, tg.messageThreadId, colleagueId);
            // Сообщение-статус прошлого хода, не снятое его концом (сброс, жнец, обрыв связи), уходит до нового.
            await retireProgressMessage(
              key,
              statusTransport(tg, STATUS_RETIRE_TIMEOUT_MS),
            );
            const draftId = randomInt(1, 2 ** 31);
            const published = await publishTelegramTurnStarted({
              chatKey: key,
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
            await flushSettledTelegramQuestions(channel.state, tg);
          },
        );
      },
      async "turn.completed"(_data, channel, ctx) {
        if (!ctx?.session) return;
        await runWithState(
          channel.state,
          channel.telegram,
          async (_bot, _colleagueId, tg) => {
            await finishHelperOutcomes(
              { sessionId: ctx.session.id, turnId: _data.turnId },
              Date.now(),
            );
            try {
              await flushSettledTelegramQuestions(channel.state, tg);
            } finally {
              await finishTelegramStatus(
                withStatusTransport({ telegram: tg }),
                ctx.session.id,
                "completed",
                _data.turnId,
              );
            }
          },
        );
      },
      async "turn.cancelled"(_data, channel, ctx) {
        if (!ctx?.session) return;
        await runWithState(
          channel.state,
          channel.telegram,
          async (_bot, _colleagueId, tg) => {
            discardHelperOutcomes(ctx.session.id, _data.turnId);
            await finishTelegramStatus(
              withStatusTransport({ telegram: tg }),
              ctx.session.id,
              "cancelled",
              _data.turnId,
            );
          },
        );
      },
      async "session.waiting"(_data, channel, ctx) {
        await runWithState(
          channel.state,
          channel.telegram,
          async (_bot, _colleagueId, tg) => {
            await finishTelegramStatus(
              withStatusTransport({ telegram: tg }),
              ctx.session.id,
              "completed",
              undefined,
            );
            await flushSettledTelegramQuestions(channel.state, tg);
          },
        );
      },
      "message.appended"(_data, channel, ctx) {
        runWithState(
          channel.state,
          channel.telegram,
          (_bot, colleagueId, tg) => {
            telegramDraftTurn(
              tg,
              ctx.session.id,
              _data.turnId,
              channel.state.chatType === "private" &&
                tg.messageThreadId === undefined,
            )?.append(_data.stepIndex, _data.messageDelta);
            markTelegramFirstOutput({
              chatKey: chatKeyOf(tg.chatId, tg.messageThreadId, colleagueId),
              sessionId: ctx.session.id,
              getStatusImpl: getChatStatus,
              setStatusIfImpl: setChatStatusIf,
            });
            keepTurnAlive({ telegram: tg }, ctx, colleagueId);
          },
        );
      },
      "actions.requested"(_data, channel, ctx) {
        runWithState(
          channel.state,
          channel.telegram,
          (_bot, colleagueId, tg) => {
            keepTurnAlive({ telegram: tg }, ctx, colleagueId);
            telegramDraftTurn(
              tg,
              ctx.session.id,
              _data.turnId,
              channel.state.chatType === "private" &&
                tg.messageThreadId === undefined,
            )?.requested(_data.stepIndex, _data.actions);
          },
        );
      },
      "action.partial"(_data, channel, ctx) {
        runWithState(
          channel.state,
          channel.telegram,
          (_bot, colleagueId, tg) => {
            telegramDraftTurn(
              tg,
              ctx.session.id,
              _data.turnId,
              channel.state.chatType === "private" &&
                tg.messageThreadId === undefined,
            );
            keepTurnAlive({ telegram: tg }, ctx, colleagueId);
          },
        );
      },
      "action.result"(_data, channel, ctx) {
        runWithState(
          channel.state,
          channel.telegram,
          (_bot, colleagueId, tg) => {
            telegramDraftTurn(
              tg,
              ctx.session.id,
              _data.turnId,
              channel.state.chatType === "private" &&
                tg.messageThreadId === undefined,
            )?.result(_data.result.callId);
            keepTurnAlive({ telegram: tg }, ctx, colleagueId);
          },
        );
      },
      async "message.completed"(data, channel, ctx) {
        if (!ctx?.session) return;
        await runWithState(
          channel.state,
          channel.telegram,
          async (bot, colleagueId, tg) => {
            if (data.finishReason === "tool-calls") {
              const stream = telegramDraftTurn(
                tg,
                ctx.session.id,
                data.turnId,
                channel.state.chatType === "private" &&
                  tg.messageThreadId === undefined,
              );
              const { text } = parseTelegramDelivery(data.message ?? "");
              // Redact the complete text before the draft renderer cuts its tail.
              const progress = draftText(redactNotice(text), true);
              stream?.completeStep(data.stepIndex, data.message ?? "");
              if (stream && progress)
                await traceStatus(
                  {
                    turn: data.turnId,
                    session: ctx.session.id,
                    source: "telegram",
                  },
                  progress,
                  () =>
                    stream.status(
                      data.stepIndex,
                      progress,
                      statusTransport(tg),
                    ),
                );
              return;
            }
            await closeTelegramDraftChat(tg, ctx.session.id, data.turnId);
            if (!data.message) return;
            // В общей группе коллег (и в межоботовой личке) молчание `<!-- iva:none -->` —
            // нормальный исход хода без отправки сообщения в Telegram (ADR-0030, T911).
            const isGroupOrPeerChat =
              channel.state.chatType === "group" ||
              channel.state.chatType === "supergroup" ||
              (channel.state.chatType === "private" &&
                isConfiguredPeerBot(
                  channel.state.chatId,
                  bot?.botId,
                  getEnv(),
                ) !== null);
            if (
              isGroupOrPeerChat &&
              isColleaguesEnabled() &&
              parseTelegramQuiet(data.message).quiet
            ) {
              return;
            }
            const { text: message, silent } = parseTelegramDelivery(
              data.message,
            );
            const recordDelivery = (delivered: boolean) =>
              emitTelegramTurnLatency({
                chatKey: chatKeyOf(tg.chatId, tg.messageThreadId, colleagueId),
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
                  outboxTransport(
                    tg,
                    TELEGRAM_RICH_REPLIES,
                    silent,
                    bot?.token,
                  ),
                ),
            );
            if (!result.ok) return;
            recordDelivery(true);
            noteHelperReply(
              { sessionId: ctx.session.id, turnId: data.turnId },
              message,
            );
          },
        );
      },
      async "turn.failed"(data, channel, ctx) {
        if (!ctx?.session) return;
        await runWithState(
          channel.state,
          channel.telegram,
          async (bot, colleagueId, tg) => {
            discardHelperOutcomes(ctx.session.id, data.turnId);
            try {
              await finishTelegramStatus(
                withStatusTransport({ telegram: tg }),
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
              { ...data, ...chatQuestion(channel, colleagueId) },
              failureSender(tg, bot?.token),
            );
          },
        );
      },
      async "session.failed"(data, channel) {
        await runWithState(
          channel.state,
          channel.telegram,
          async (bot, colleagueId, tg) => {
            discardHelperOutcomes(data.sessionId);
            if (tg.chatId) {
              try {
                await finishTelegramStatus(
                  withStatusTransport({ telegram: tg }),
                  data.sessionId,
                  "failed",
                );
                await dropQueuedStatus({
                  chatKey: chatKeyOf(
                    tg.chatId,
                    tg.messageThreadId,
                    colleagueId,
                  ),
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
              { ...data, ...chatQuestion(channel, colleagueId) },
              failureSender(tg, bot?.token),
            );
          },
        );
      },
    },
    // Вход: канал только подаёт эффекты, разбор апдейта живёт в пайплайне.
    onMessage: wrapTelegramQueueOnMessage((ctx, message) => {
      const env = getEnv();
      const bot = activeTelegramBot(env);
      const colleagueId = colleagueBotIdOf(bot);
      const colleaguesActive = isColleaguesEnabled();
      if (colleagueId !== null && !colleaguesActive) {
        return null;
      }
      const tg = bot ? wrapTelegramHandle(ctx.telegram, bot) : ctx.telegram;
      const chatKey = chatKeyOf(
        message.chat.id,
        message.messageThreadId,
        colleagueId,
      );
      const ingressId = randomUUID();
      const receivedState = chatState(getChatStatus(chatKey));
      const receivedDuringTurn =
        telegramTurnPolicy() === "steer" &&
        (receivedState === "turn" || receivedState === "accepted");
      const botUsername = bot?.username ?? tg.botUsername;
      const unaddressedGroup =
        colleaguesActive &&
        (message.chat.type === "group" || message.chat.type === "supergroup") &&
        !isExplicitlyAddressedInGroup(message, botUsername);
      return rememberAccepted(
        chatKey,
        message,
        runTelegramInbound(message, {
          ...(colleagueId !== null ? { botId: colleagueId } : {}),
          ...(bot?.botId ? { selfBotId: bot.botId } : {}),
          ...(bot?.token ? { botToken: bot.token } : {}),
          botUsername,
          colleaguesEnabled: colleaguesActive,
          ...(colleaguesActive
            ? { peerBotIds: configuredTelegramBotIds(env) }
            : {}),
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
            if (claimed && !unaddressedGroup) {
              startTelegramAcceptedTyping(tg, claimed);
            }
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

  // Оборачиваем createAdapterContext на скомпилированном адаптере eve:
  // 1) привязываем rekey() в группах к префиксу bot:<botId>: у коллег;
  // 2) оборачиваем telegram handle, чтобы даже встроенные события eve
  //    (authorization.required / authorization.completed) слали токеном коллеги.
  const compiledAdapter = (
    telegram as unknown as { adapter?: RuntimeChannelAdapter }
  ).adapter;
  if (compiledAdapter?.createAdapterContext) {
    const originalCreate =
      compiledAdapter.createAdapterContext.bind(compiledAdapter);
    compiledAdapter.createAdapterContext = (base) => {
      const bot = botFromChannelState(base.state, getEnv());
      const colleagueId = colleagueBotIdOf(bot);
      const continuation = base.session?.continuation;
      const scopedSession =
        colleagueId !== null && continuation
          ? {
              ...base.session,
              continuation: {
                ...continuation,
                rekey: (token: string) =>
                  continuation.rekey(botScopedKey(token, colleagueId)),
              },
            }
          : base.session;
      const built = originalCreate({ ...base, session: scopedSession });
      if (bot && built.telegram) {
        built.telegram = wrapTelegramHandle(built.telegram, bot);
      }
      return built;
    };
  }

  const telegramWebhookRoute = telegram.routes.find(
    (route) =>
      route.transport !== "websocket" &&
      route.method === "POST" &&
      route.path === "/eve/v1/telegram",
  );
  if (!telegramWebhookRoute || telegramWebhookRoute.transport === "websocket") {
    throw new Error(
      "telegramChannel did not expose its expected webhook route",
    );
  }

  const dispatchWithBot = async (
    request: Request,
    args: RouteHandlerArgs<TelegramChannelState>,
  ): Promise<Response> => {
    const env = getEnv();
    const requestedBotId = await botIdFromWebhookRequest(request);
    const bot = resolveTelegramBot(requestedBotId, env);
    if (requestedBotId !== null && bot === null) {
      return new Response(`unknown Telegram bot ${requestedBotId}`, {
        status: 404,
      });
    }
    if (colleagueBotIdOf(bot) !== null && !isColleaguesEnabled()) {
      return new Response(null, { status: 204 });
    }
    const prepared = await preparePeerBotWebhookRequest(request, {
      resolvedBot: bot,
      env,
      apiBaseUrl: options.api?.apiBaseUrl,
      fetchImpl: options.api?.fetch,
    });
    if (prepared.duplicateAssignment) {
      return new Response(null, { status: 204 });
    }
    const scopedArgs = scopeWebhookArgs(args, bot);
    const response = await (bot
      ? withTelegramBot(bot, () =>
          telegramWebhookRoute.handler(prepared.request, scopedArgs),
        )
      : telegramWebhookRoute.handler(prepared.request, scopedArgs));
    if (response.ok && prepared.assignmentId !== null) {
      try {
        await completeInboundPeerAssignment(prepared.assignmentId);
      } catch (error) {
        console.error("[telegram] не смог завершить запись поручения:", error);
      }
    }
    return response;
  };

  return {
    ...telegram,
    routes: [
      ...telegram.routes.map((route) =>
        route === telegramWebhookRoute
          ? {
              ...route,
              handler: (
                request: Request,
                args: RouteHandlerArgs<TelegramChannelState>,
              ) =>
                handleTelegramDraftStopRequest(
                  request,
                  (req) => dispatchWithBot(req, args),
                  getEnv().TELEGRAM_WEBHOOK_SECRET_TOKEN,
                ),
            }
          : route,
      ),
      POST<TelegramChannelState>(TELEGRAM_ACCEPTANCE_ROUTE, (request, args) =>
        handleAcceptedTelegramWebhook(
          telegramWebhookRoute.handler,
          request,
          args,
          {
            env: getEnv(),
            apiBaseUrl: options.api?.apiBaseUrl,
            fetchImpl: options.api?.fetch,
          },
        ),
      ),
      POST(TELEGRAM_COMPACT_ROUTE, (req, args) =>
        handleTelegramCompactRequest(
          req,
          args,
          (id) => compactTelegramSession(id),
          getEnv().TELEGRAM_WEBHOOK_SECRET_TOKEN,
        ),
      ),
      POST("/eve/v1/telegram/reset", (req, args) =>
        handleTelegramResetRequest(
          req,
          args,
          getEnv().TELEGRAM_WEBHOOK_SECRET_TOKEN,
        ),
      ),
      POST(TELEGRAM_CANCEL_ROUTE, (req, { attachSession }) =>
        handleTelegramCancelRequest(
          req,
          attachSession,
          getEnv().TELEGRAM_WEBHOOK_SECRET_TOKEN,
        ),
      ),
    ],
  };
}

export default createTelegramChannel();
