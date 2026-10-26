import { TELEGRAM_COMPACT_ROUTE } from "#lib/telegram-compact-route.ts";
import { localChannelUrl } from "#lib/telegram-cancel-route.ts";
import { botCommands, helpText, startText, tr } from "#lib/i18n.ts";
import {
  resetTargetForControl,
  type TelegramResetTarget,
} from "../lib/telegram-reset.ts";
import {
  handleTelegramDraftStop,
  isPendingStopOutcome,
  replyOutcomeOf,
  requestTurnCancel,
  stopOutcomeText,
  type StopCancelRequest,
  type StopCancelResult,
  type StopOutcome,
} from "#lib/telegram-stop.ts";
import {
  isTelegramQueueUpdate,
  type TelegramCallbackQuery,
  type TelegramDocument,
  type TelegramQueueMessage as TelegramMessage,
  type TelegramQueueUpdate as TelegramUpdate,
} from "../lib/telegram-queue.ts";
import type { TelegramFlowState } from "../lib/tg-flow.ts";
import { getChatStatus } from "#lib/run-status.ts";
import {
  TELEGRAM_BUTTON_TAP_FIELD,
  TELEGRAM_BUTTON_TAP_DAILY_TEXT_FIELD,
} from "#lib/telegram-parts.ts";
import {
  isBreakNotice,
  isRetryTap,
  isInterruptedTap,
} from "#lib/error-humanizer.ts";
import { claimInterruptedTap, turnQuestion } from "#lib/turn-question.ts";
import { readEnvFresh } from "../lib/env-file.ts";
import {
  formatUsageReport,
  parseWindow,
  readEntries,
  summarize,
} from "../lib/usage.ts";
import {
  ALLOWED,
  BOT_USER_ID,
  CANCEL_ROUTE,
  DATA_DIR,
  ENV_PATH,
  ROOT,
  SECRET,
  log,
} from "./config.ts";
import { downloadTelegramFile, edit, reply, sc, tg } from "./transport.ts";
import { chatKey } from "./offset.ts";
import {
  hasPrivateResetIntent,
  isPrivateResetRetryPending,
  performScopedReset,
  RESET_INTENT_ESCALATION_ATTEMPTS,
} from "./queue.ts";
import { deliverDirectUpdate } from "./routing.ts";
import { parseUpdateCallbackData } from "./update-callback.ts";
import { handleUpdateCallback, handleUpdateCheck } from "./update-flow.ts";
import {
  endWizard,
  flows,
  getWizard,
  handleWizardText,
  handleModelCmd,
  handleThinkCmd,
  handleWizardCallback,
  resetMessageCopy,
} from "./wizards.ts";
import { createMenu } from "../lib/menu/index.ts";
import { admitTelegramUpdate } from "./inbox.ts";
import { isPrivateTelegramChat } from "#lib/telegram-private-chat.ts";
import { readTelegramMessageText } from "#lib/telegram-rich-message.ts";
import { scheduleBridgeTask } from "./background.ts";
import { parseProposalCallback } from "../lib/plugin-proposal.ts";
import { isGotItData, watchButtons } from "../lib/notice-policy.ts";
import { markTappedButton } from "../lib/telegram-buttons.ts";
import {
  handlePluginProposalTap,
  type PluginTap,
  type PluginTapOutcome,
} from "./plugin-proposal-tap.ts";

type ControlCallbackQuery = TelegramCallbackQuery & { data: string };
type PendingFlow = {
  flow: unknown;
  awaitText?: unknown;
  [key: string]: unknown;
};
type AwaitText = { file?: boolean; kind?: string; secret?: boolean };
type TelegramResult = { ok?: boolean; result?: unknown };
type SentMessage = { message_id: number };
type ErrorDetails = {
  message?: unknown;
  resetPhase?: unknown;
  resetFailures?: unknown;
};
type NonTextIo = {
  deleteSecret: (
    chatId: number | undefined,
    messageId: number | undefined,
  ) => Promise<boolean>;
  reply: (chatId: number | undefined, text: string) => Promise<unknown>;
  download: (fileId: string, maxBytes: number) => Promise<string | null>;
  deliver: (
    text: string,
    message: TelegramMessage,
    state: PendingFlow,
  ) => Promise<unknown>;
};
type ControlTransport = (
  method: string,
  body: Record<string, unknown>,
) => Promise<TelegramResult>;
type StatusImpl = (chatKey: string) => Record<string, unknown> | null;
type CancelImpl = (input: StopCancelRequest) => Promise<StopCancelResult>;
type PerformResetImpl = typeof performScopedReset;
// Правка нажатой кнопки: блоки rich-сообщения или ряды кнопок classic-сообщения.
type TapEdit =
  | { rich: { blocks: unknown[]; is_rtl?: boolean } }
  | { inline_keyboard: unknown[] };
// Точки ввода-вывода handleControl, которые подменяются в тестах: ответ в чат,
// подтверждение нажатия и вызов cancel-роута. Всё остальное остаётся дефолтным.
export type ControlDeps = {
  replyImpl?: (
    chatId: number | undefined,
    text: string,
  ) => Promise<SentMessage | null>;
  ackImpl?: (callbackQueryId: string, text?: string) => Promise<unknown>;
  cancelImpl?: CancelImpl;
  // Куда уходит работа после ответа циклу: фон моста (по умолчанию) или двойник в тесте.
  scheduleImpl?: (key: string, task: () => Promise<void>) => boolean;
  performResetImpl?: PerformResetImpl;
  resetRetryPendingImpl?: (chatKey: string) => boolean;
  resetIntentPendingImpl?: (chatKey: string) => boolean;
  // «Установить» на предложении плагина: забрать копию и запустить установщик.
  pluginTapImpl?: (tap: PluginTap) => Promise<PluginTapOutcome>;
  // «Я в курсе» под пунктом Watch: удалить сообщение с кнопкой; true — удалено.
  deleteImpl?: (chatId: number, messageId: number) => Promise<boolean>;
  // Правка нажатой кнопки в сообщении: true — кнопка помечена (или уже была).
  editTapImpl?: (
    chatId: number,
    messageId: number,
    edit: TapEdit,
  ) => Promise<boolean>;
};

const controlTg = tg as unknown as ControlTransport;

function errorDetails(error: unknown): ErrorDetails {
  return typeof error === "object" && error !== null ? error : {};
}

function errorMessage(error: unknown): string {
  const message = errorDetails(error).message;
  if (typeof message === "string") return message;
  if (message === undefined) return "undefined";
  if (message === null) return "null";
  if (
    typeof message === "number" ||
    typeof message === "boolean" ||
    typeof message === "bigint"
  )
    return `${message}`;
  return Object.prototype.toString.call(message);
}

function isAwaitText(value: unknown): value is AwaitText {
  return typeof value === "object" && value !== null;
}

function hasCallbackData(
  callback: TelegramCallbackQuery,
): callback is ControlCallbackQuery {
  return typeof callback.data === "string";
}

function replySucceeded(value: SentMessage | null | undefined): boolean {
  return typeof value?.message_id === "number";
}

function isFlowId(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number";
}

function hasMessageId(value: PendingFlow): boolean {
  return value.msgId === null || typeof value.msgId === "number";
}

function hasFlowData(value: PendingFlow): boolean {
  return typeof value.data === "object" && value.data !== null;
}

// Поля, без которых состояние не годится экрану меню; каждое проверяется отдельно.
const FLOW_STATE_FIELDS: ReadonlyArray<(value: PendingFlow) => boolean> = [
  (value) => typeof value.flow === "string",
  (value) => isFlowId(value.chatId),
  (value) => isFlowId(value.userId),
  (value) => typeof value.createdAt === "number",
  hasMessageId,
  (value) => typeof value.page === "number",
  hasFlowData,
];

export function isTelegramFlowState(
  value: PendingFlow,
): value is TelegramFlowState {
  return FLOW_STATE_FIELDS.every((field) => field(value));
}

const replyTo = (chatId: number | undefined, text: string) =>
  reply(chatId as number, text) as Promise<SentMessage | null>;

const editMessage = (
  chatId: number | undefined,
  messageId: number,
  text: string,
) => edit(chatId as number, messageId, text);

// Команды, которые исполняет САМ мост: они обязаны работать, даже когда агент занят
// или завис, поэтому в eve не уходят. Порядок здесь ни на что не влияет — /help и синее
// меню Telegram кормит таблица COMMANDS (agent/lib/i18n.ts).
export const OUT_OF_BAND_COMMANDS = [
  "/menu",
  "/help",
  "/start",
  "/stop",
  "/usage",
  "/restart",
  "/new",
  "/compact",
  "/update",
  "/model",
  "/think",
] as const;

// Подтверждение нажатия: гасит спиннер кнопки и показывает всплывающую подсказку.
// Ошибки глотаем — сама отмена уже отправлена, а протухший callback_query_id Telegram
// отвергает штатно.
const answerCallback = (callbackQueryId: string, text?: string) =>
  controlTg("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text === undefined ? {} : { text }),
  }).catch((e: unknown) => {
    log("answerCallbackQuery failed:", errorMessage(e));
    return { ok: false };
  });

const privateChatOnlyText = () =>
  tr(
    "Open a private chat with me to use this control.",
    "Открой личный чат со мной, чтобы использовать это управление.",
  );

// Колбэки САМОГО eve — не наши: подтверждения HITL и кнопки входа в подключения
// разбирает канал (dispatchCallbackQuery), и подмена их сообщением молча потеряла бы
// подтверждение или вход. Оба префикса — значения eve (`TELEGRAM_HITL_CALLBACK_PREFIX`
// и `TELEGRAM_AUTHORIZATION_CALLBACK_PREFIX`); в публичный экспорт входит только
// первый, поэтому оба лежат здесь копией: тест рядом пинит первый к eve, второй —
// к поведению. Смена префикса в eve обязана правиться здесь тем же коммитом.
export const TELEGRAM_EVE_CALLBACK_PREFIXES = ["eve:", "eve_auth:"] as const;

function isEveCallbackData(data: string): boolean {
  return TELEGRAM_EVE_CALLBACK_PREFIXES.some((prefix) =>
    data.startsWith(prefix),
  );
}

// Кнопка, написанная моделью: её data — это реплика пользователя, а не команда моста,
// поэтому тап уходит дальше обычным сообщением: у колбэка нет ни тишины-окна
// коллектора, ни групповой политики, ни admission-ключа сообщения. Конверт подменяется
// НА МЕСТЕ: следующий шаг моста (admission и очередь) читает тот же объект. Чат и тред
// берём у колбэка — тап отвечает в тот же чат, где стоит кнопка, а message_id остаётся
// за сообщением с кнопкой: в группе eve якорит сессию как раз на него. Собранный апдейт
// проверяем тем же валидатором, что читает очередь: битый конверт обязан отсечься
// здесь, иначе запись в inbox упадёт и очередь встанет на повторе (write-failed).
export function applyTelegramButtonTap(
  update: TelegramUpdate,
  callback: ControlCallbackQuery,
  acceptedQuestion?: string,
): boolean {
  const message = callback.message;
  const chat = message?.chat;
  const from = callback.from;
  if (message === undefined || chat === undefined || from === undefined)
    return false;
  const data = isInterruptedTap(callback.data)
    ? callback.data.split(":", 1)[0]
    : callback.data;
  const context = tapContextText(message);
  const tap: TelegramUpdate = {
    update_id: update.update_id,
    message: {
      message_id: message.message_id,
      chat: { ...chat },
      from: { ...from, is_bot: false },
      text: tapTurnText(data, context, chatKey(update), acceptedQuestion),
      ...(message.date === undefined ? {} : { date: message.date }),
      ...(message.message_thread_id === undefined
        ? {}
        : { message_thread_id: message.message_thread_id }),
      [TELEGRAM_BUTTON_TAP_FIELD]: true,
      [TELEGRAM_BUTTON_TAP_DAILY_TEXT_FIELD]: tapText(
        data,
        dailyTapContext(context),
      ),
    },
  };
  if (!isTelegramQueueUpdate(tap)) return false;
  update.message = tap.message;
  delete update.callback_query;
  return true;
}

// Тап по кнопке модели несёт ходу и текст сообщения, под которым она стояла: одно `data`
// («Составить ответ») теряет, кому и о чём, и модель ищет это заново. Текст сообщения —
// данные, не команда: он уходит ходу тем же входящим текстом и проходит inbound-Gate.
export const TAP_CONTEXT_LIMIT = 1500;
const TAP_DAILY_CONTEXT_LIMIT = 200;

function dailyTapContext(context: string): string {
  const firstLine = context.split(/\r\n|[\n\r\u0085\u2028\u2029]/u, 1)[0];
  const chars = Array.from(firstLine);
  if (firstLine === context && chars.length <= TAP_DAILY_CONTEXT_LIMIT)
    return context;
  return `${chars
    .slice(0, TAP_DAILY_CONTEXT_LIMIT - 1)
    .join("")
    .trimEnd()}…`;
}

function tapText(data: string, context: string): string {
  if (context === "") return data;
  const label = tr("button under Iva's message", "кнопка под сообщением Ивы");
  return `${data}\n\n(${label}: «${context}»)`;
}

// Текст берётся тем же чтением, что и у входящего rich-сообщения: text или caption, иначе
// блоки rich_message (абзацы, списки, таблицы). Блок кнопок текста не несёт и не читается.
/** Текст сообщения с кнопкой, не длиннее TAP_CONTEXT_LIMIT; пусто — текста нет. */
export function tapContextText(message: TelegramMessage | undefined): string {
  if (message === undefined) return "";
  return clipTapContext(readTelegramMessageText(message).text.trim());
}

function clipTapContext(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= TAP_CONTEXT_LIMIT) return text;
  const mark = tr(" […cut]", " […обрезано]");
  const kept = TAP_CONTEXT_LIMIT - Array.from(mark).length;
  return `${chars.slice(0, kept).join("").trimEnd()}${mark}`;
}

/** Текст хода по тапу: `data`, а следом в скобках текст сообщения с кнопкой, если он есть. */
function tapTurnText(
  data: string,
  context: string,
  key: string | null,
  acceptedQuestion?: string,
): string {
  if (context === "") return data;
  return `${tapText(data, context)}${fullQuestion(data, context, key, acceptedQuestion)}`;
}

/**
 * «Повторить» под сообщением об обрыве посреди ответа: в сообщении вопрос стоит цитатой до
 * 120 знаков, а модели нужен целиком — eve могла не сохранить его в сессии, если оборвался
 * первый запрос хода. Полный текст канал положил в запись чата run-status
 * (agent/lib/turn-question.ts). Своя кнопка модели с той же подписью его не получает.
 */
function fullQuestion(
  data: string,
  context: string,
  key: string | null,
  acceptedQuestion?: string,
): string {
  if (key === null || !isRetryTap(data) || !isBreakNotice(context)) return "";
  const question = acceptedQuestion ?? turnQuestion(key)?.text ?? "";
  if (question === "") return "";
  const label = tr("the question in full", "вопрос целиком");
  return `\n\n(${label}: «${question}»)`;
}

const PRIVATE_ONLY_COMMANDS = new Set(["/menu", "/model", "/think"]);

// Мост ловит /stop и ■ до доставки в eve, поэтому отмена доходит до занятого агента.
// Проверка пары и POST общие с webhook, в agent/lib/telegram-stop.ts.
async function requestTurnStop(
  update: TelegramUpdate,
  {
    keyImpl = chatKey,
    cancelImpl,
    ...cancelDeps
  }: {
    keyImpl?: (update: TelegramUpdate) => string | null;
    cancelImpl?: CancelImpl;
    getStatusImpl?: StatusImpl;
    logImpl?: (...parts: unknown[]) => void;
  } = {},
): Promise<StopOutcome> {
  return requestTurnCancel(keyImpl(update), {
    url: CANCEL_ROUTE,
    secret: SECRET,
    logImpl: log,
    ...(cancelImpl === undefined ? {} : { cancelImpl }),
    ...cancelDeps,
  });
}

// Движок /menu: делит session-store (flows) с визардами /model//think. deps — мост отдаёт
// экранам всё нужное (пути, systemctl, доставку в eve, allowlist, хендофф в визарды).
const menu = createMenu({
  flows,
  tg,
  deps: {
    envPath: ENV_PATH,
    dataDir: DATA_DIR,
    root: ROOT,
    sc,
    reply,
    // Синтетическая дистилляция делит acceptance, пейсинг и уборку failed-ingress
    // с обычной прямой доставкой, но намеренно не проходит busy-time FIFO.
    deliver: (update) =>
      deliverDirectUpdate(update).then((result) => result === "delivered"),
    admitSynthetic: (update) =>
      admitTelegramUpdate(update, { trustedLocal: true }).then(
        (result) => result === "owned",
      ),
    log,
    allowed: ALLOWED,
    handleModelCmd,
    handleThinkCmd,
    handleUpdateCheck,
  },
});

// setMyCommands: синее командное меню Telegram из общей таблицы COMMANDS (default=en +
// language_code:"ru"). Идемпотентно, зовётся на каждом старте моста; ошибки нефатальны.
async function registerBotCommands() {
  try {
    await tg("setMyCommands", { commands: botCommands("en") });
    await tg("setMyCommands", {
      commands: botCommands("ru"),
      language_code: "ru",
    });
  } catch (e: unknown) {
    log("setMyCommands failed:", errorDetails(e).message);
  }
}

// Delete a message carrying a secret, warning the user if Telegram won't let us — a rejected secret
// must never silently linger in the chat (mirrors the delete-first path in menu.onText).
async function deleteSecretMessage(
  chatId: number | undefined,
  messageId: number | undefined,
) {
  const del = await controlTg("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  }).catch(() => ({ ok: false }));
  if (!del?.ok) {
    await replyTo(
      chatId,
      tr(
        "Couldn't delete your message — please delete it manually.",
        "Не смог удалить сообщение — удали его вручную.",
      ),
    ).catch(() => {});
  }
  return del?.ok === true;
}

// Default I/O for handleAwaitNonText — injectable so the delete→download ordering and the
// "never reaches eve" contract can be unit-tested with mocks.
const nonTextIo: NonTextIo = {
  deleteSecret: (chatId: number | undefined, id: number | undefined) =>
    deleteSecretMessage(chatId, id),
  reply: (chatId: number | undefined, text: string) => replyTo(chatId, text),
  download: (fileId: string, max: number) => downloadTelegramFile(fileId, max),
  // Run the screen's own text handler on downloaded content WITHOUT re-deleting (already deleted).
  deliver: async (text: string, msg: TelegramMessage, st: PendingFlow) => {
    if (!isTelegramFlowState(st)) return true;
    return menu.onText({ ...msg, text }, st, { skipDelete: true });
  },
};

const MAX_SECRET_FILE_BYTES = 256 * 1024;

function chatIdOf(msg: TelegramMessage): number | undefined {
  return msg.chat?.id;
}

function awaitedInput(pending: PendingFlow): AwaitText | null {
  return isAwaitText(pending.awaitText) ? pending.awaitText : null;
}

// Файл принимает только экран меню, чей промпт умеет файл (client_secret gws).
function acceptsSecretFile(
  pending: PendingFlow,
  awaited: AwaitText | null,
): boolean {
  return Boolean(awaited?.file) && pending.flow === "menu";
}

function capturableDocument(
  msg: TelegramMessage,
  pending: PendingFlow,
  awaited: AwaitText | null,
): TelegramDocument | undefined {
  return acceptsSecretFile(pending, awaited) ? msg.document : undefined;
}

function isOversizedSecretFile(document: TelegramDocument): boolean {
  return (document.file_size ?? 0) > MAX_SECRET_FILE_BYTES;
}

// A non-text message arrived while a menu/wizard awaits a SECRET (the caller gates this to
// secret/file-capable states — a non-secret interview attachment falls through to eve untouched).
// It must never reach eve. For a file-capable prompt (gws client_secret) a document is captured;
// crucially the message is DELETED FIRST, before the download, so the secret doesn't linger in the
// chat for the download's duration. Anything else is deleted with a clear ack telling the user how
// to send it. Always returns true (the update is consumed, not delivered).
export async function handleAwaitNonText(
  msg: TelegramMessage,
  pending: PendingFlow,
  io: NonTextIo = nonTextIo,
) {
  const awaited = awaitedInput(pending);
  const document = capturableDocument(msg, pending, awaited);
  if (document) return captureSecretFile(msg, document, pending, io);
  return rejectAttachment(msg, awaited, io);
}

async function captureSecretFile(
  msg: TelegramMessage,
  document: TelegramDocument,
  pending: PendingFlow,
  io: NonTextIo,
) {
  if (isOversizedSecretFile(document)) return rejectOversizedFile(msg, io);
  return deliverDeletedFile(msg, document, pending, io);
}

async function rejectOversizedFile(msg: TelegramMessage, io: NonTextIo) {
  const chatId = chatIdOf(msg);
  await io.deleteSecret(chatId, msg.message_id);
  await io.reply(
    chatId,
    tr(
      "That file is too large — paste the contents as text instead.",
      "Файл слишком большой — вставь содержимое текстом.",
    ),
  );
  return true;
}

// Delete FIRST, and only proceed once the secret has actually left the chat. If Telegram
// refused the deletion, deleteSecret already told the user to remove it manually — we must NOT
// download or deliver a secret that is still visible in the conversation. Consume it either way
// so it never reaches eve.
async function deliverDeletedFile(
  msg: TelegramMessage,
  document: TelegramDocument,
  pending: PendingFlow,
  io: NonTextIo,
) {
  const chatId = chatIdOf(msg);
  if (!(await io.deleteSecret(chatId, msg.message_id))) return true;
  const content = await io.download(document.file_id, MAX_SECRET_FILE_BYTES);
  if (content == null) {
    await io.reply(
      chatId,
      tr(
        "Couldn't read that file — paste the contents as text instead.",
        "Не смог прочитать файл — вставь содержимое текстом.",
      ),
    );
    return true;
  }
  await io.deliver(content, msg, pending); // skipDelete is safe now — the message is confirmed gone
  return true;
}

// Secret prompt, but not a capturable file (a photo, or a text-only secret) — delete it so it can't
// reach eve, and tell the user how to send it instead of dropping it silently.
async function rejectAttachment(
  msg: TelegramMessage,
  awaited: AwaitText | null,
  io: NonTextIo,
) {
  const chatId = chatIdOf(msg);
  await io.deleteSecret(chatId, msg.message_id);
  await io.reply(chatId, attachmentHint(awaited));
  return true;
}

function attachmentHint(awaited: AwaitText | null): string {
  return awaited?.file
    ? tr(
        "Send client_secret.json as text or attach the .json file — not a photo.",
        "Пришли client_secret.json текстом или прикрепи .json-файл — не фото.",
      )
    : tr("Send it as text, please.", "Пришли это, пожалуйста, текстом.");
}

// ── handleControl ──
// Control commands are handled by the BRIDGE (out-of-band) — they work even if the agent is stuck.
// Trusted IDs only. Returns true if the command was handled (we do NOT deliver it to eve).
// Два входа: колбэк (кнопка) и сообщение. Каждый входит в таблицу «вид → обработчик»,
// поэтому новая кнопка или команда — одна строка в таблице и одна функция.

type ControlIo = Required<Omit<ControlDeps, "cancelImpl">> &
  Pick<ControlDeps, "cancelImpl">;

const DEFAULT_CONTROL_IO: Omit<ControlIo, "cancelImpl"> = {
  replyImpl: replyTo,
  ackImpl: answerCallback,
  performResetImpl: performScopedReset,
  resetRetryPendingImpl: isPrivateResetRetryPending,
  resetIntentPendingImpl: hasPrivateResetIntent,
  scheduleImpl: scheduleBridgeTask,
  pluginTapImpl: (tap) => handlePluginProposalTap(tap),
  deleteImpl: deleteGotItMessage,
  editTapImpl: editTappedMessage,
};

// Переданный undefined значит «по умолчанию» — как у деструктуризации с дефолтами.
function controlIo(deps: ControlDeps): ControlIo {
  const given = Object.entries(deps).filter(([, impl]) => impl !== undefined);
  return {
    ...DEFAULT_CONTROL_IO,
    ...(Object.fromEntries(given) as ControlDeps),
  };
}

// Ошибка обработчика не должна уронить мост: пишем её в журнал и отдаём исход по умолчанию.
function settleLogged<T>(
  work: Promise<T>,
  label: string,
  fallback: T,
): Promise<T> {
  return work.catch((e: unknown) => {
    log(label, errorDetails(e).message);
    return fallback;
  });
}

function senderId(from: TelegramCallbackQuery["from"]): string {
  return String(from?.id ?? "");
}

function isAllowlisted(id: string): boolean {
  return ALLOWED.size > 0 && ALLOWED.has(id);
}

function isTrustedSender(from: TelegramCallbackQuery["from"]): boolean {
  return isAllowlisted(senderId(from));
}

function isGroupChat(chat: TelegramMessage["chat"]): boolean {
  return chat !== undefined && !isPrivateTelegramChat(chat);
}

const retryScheduledText = () =>
  tr(
    "⚠️ A reset retry is already scheduled.",
    "⚠️ Повтор сброса уже запланирован.",
  );

// Исход обработчика уходит вызывающему как есть: экран меню вправе ответить "retry".
type ControlResult = boolean | Awaited<ReturnType<typeof menu.onCallback>>;
// Вход не забрал апдейт — решает следующий вход (колбэк → сообщение → команда).
const UNCLAIMED = Symbol("unclaimed");
type Claim = Promise<ControlResult | typeof UNCLAIMED>;

async function handleControl(
  update: TelegramUpdate,
  deps: ControlDeps = {},
): Promise<ControlResult> {
  const io = controlIo(deps);
  const callback = update.callback_query;
  const legacyTarget =
    callback?.data === "iva_cancel" ? ownerPrivateMessage(callback) : null;
  if (callback && legacyTarget) {
    const key = chatKey(update);
    const status = key === null ? null : getChatStatus(key);
    await io.ackImpl(callback.id).catch(() => {});
    if (
      status?.status === "running" &&
      status.statusMessageId === legacyTarget.messageId &&
      typeof status?.turnId === "string" &&
      status.turnId.length > 0
    ) {
      await requestTurnStop(update, {
        cancelImpl: io.cancelImpl,
        getStatusImpl: () => status,
      });
    } else {
      await io
        .deleteImpl(legacyTarget.chatId, legacyTarget.messageId)
        .catch(() => false);
    }
    return true;
  }
  if (update.stopped_message_generation) {
    await handleTelegramDraftStop(update.stopped_message_generation, {
      allowedImpl: () => ALLOWED,
      urlImpl: () => CANCEL_ROUTE,
      secret: SECRET,
      cancelImpl: io.cancelImpl,
      logImpl: log,
    });
    return true;
  }
  const claimed = await handleCallback(update, io);
  return claimed === UNCLAIMED ? handleMessage(update, io) : claimed;
}

// ── Колбэки ──
type CallbackContext = {
  update: TelegramUpdate;
  callback: ControlCallbackQuery;
  io: ControlIo;
};
type CallbackKind =
  "update" | "wizard" | "menu" | "plugin" | "gotIt" | "passthrough" | "tap";

// Порядок важен: первое совпадение решает. Всё, что не совпало, — кнопка модели.
const CALLBACK_KINDS: ReadonlyArray<
  readonly [CallbackKind, (data: string) => boolean]
> = [
  ["update", (data) => parseUpdateCallbackData(data) !== null],
  ["wizard", isWizardCallbackData],
  ["menu", (data) => data.startsWith("iva_menu:")],
  ["plugin", (data) => parseProposalCallback(data) !== null],
  ["gotIt", (data) => isGotItData(data, tr)],
  ["passthrough", isUnclaimedCallbackData],
];

const BRIDGE_CALLBACK_KINDS = new Set<CallbackKind>([
  "update",
  "wizard",
  "menu",
]);

const CALLBACK_HANDLERS: Record<
  CallbackKind,
  (context: CallbackContext) => Claim
> = {
  update: ({ callback }) => handleUpdateCallback(callback),
  // Wizard errors must not escape and crash the bridge. A failed handler returns
  // false so the callback enters durable inbox ownership before offset advances.
  wizard: ({ callback }) =>
    settleLogged(
      handleWizardCallback(callback),
      "wizard callback error:",
      false,
    ),
  // /menu: тот же принцип consume-on-error — тап меню всегда проглатывается (в eve не уходит).
  menu: ({ update, callback }) =>
    settleLogged(
      menu.onCallback(callback, update.update_id),
      "menu callback error:",
      true,
    ),
  plugin: handlePluginTap,
  gotIt: handleGotItTap,
  // Колбэк eve или незнакомый iva_*: не наш, решает путь сообщения.
  passthrough: () => Promise.resolve(UNCLAIMED),
  tap: handleButtonTap,
};

function isWizardCallbackData(data: string): boolean {
  return data.startsWith("iva_model:") || data.startsWith("iva_think:");
}

// eve владеет своими префиксами, а пространство iva_* — мосту, даже без экрана.
function isUnclaimedCallbackData(data: string): boolean {
  return data.startsWith("iva_") || isEveCallbackData(data);
}

function callbackKind(data: string): CallbackKind {
  return CALLBACK_KINDS.find(([, matches]) => matches(data))?.[0] ?? "tap";
}

function callbackChat(
  callback: TelegramCallbackQuery,
): TelegramMessage["chat"] {
  return callback.message?.chat;
}

function trustedTapOutsidePrivateChat(
  callback: TelegramCallbackQuery,
): boolean {
  return (
    isTrustedSender(callback.from) &&
    !isPrivateTelegramChat(callbackChat(callback))
  );
}

async function handleCallback(update: TelegramUpdate, io: ControlIo): Claim {
  const callback = update.callback_query;
  if (!callback || !hasCallbackData(callback)) return UNCLAIMED;
  return dispatchCallback({ update, callback, io });
}

function dispatchCallback(context: CallbackContext): Claim {
  const kind = callbackKind(context.callback.data);
  if (
    BRIDGE_CALLBACK_KINDS.has(kind) &&
    trustedTapOutsidePrivateChat(context.callback)
  )
    return declineGroupCallback(context);
  return CALLBACK_HANDLERS[kind](context);
}

// «Установить» на предложении плагина (ADR-0009). Ставит только Allowlist в личном чате;
// чужой тап и тап из группы гаснут молча, строкой в журнале. Тап никогда не становится
// ходом модели: установку ведёт Bridge, вне хода.
async function handlePluginTap(context: CallbackContext) {
  const { callback, io } = context;
  if (
    isTrustedSender(callback.from) &&
    isPrivateTelegramChat(callbackChat(callback))
  )
    return handleOwnerPluginTap(context);
  await io.ackImpl(callback.id).catch(() => {});
  log(
    "plugin proposal tap ignored: not the owner in a private chat",
    senderId(callback.from),
  );
  return true;
}

// Кнопка помечается только после запуска установщика: при not-started копия возвращена
// и тап можно повторить (ADR-0009), при stale помечать нечего.
async function handleOwnerPluginTap({ update, callback, io }: CallbackContext) {
  if (isRepeatTap(tapKey(callback), update.update_id)) {
    await io.ackImpl(callback.id, alreadyChosenText()).catch(() => {});
    return true;
  }
  const snapshot = tapTree(callback.message);
  await io.ackImpl(callback.id).catch(() => {});
  const outcome = await settleLogged(
    io.pluginTapImpl({
      digest12: parseProposalCallback(callback.data) as string,
      chatId: callbackChat(callback)?.id as number,
    }),
    "plugin proposal tap error:",
    "not-started",
  );
  if (outcome === "started")
    settleTap(io, update, callback, tapEdit(snapshot, callback).edit);
  return true;
}

async function declineGroupCallback({ callback, io }: CallbackContext) {
  await io.ackImpl(callback.id, privateChatOnlyText()).catch(() => {});
  return true;
}

// «Я в курсе» под пунктом Watch (ADR-0020): владелец знает, пункт погашен, сообщение уходит из
// чата. Ход модели не нужен — тап никогда не становится сообщением и в очередь не идёт. Второй тап по
// уже удалённому сообщению и отказ удаления (старше 48 часов, нет прав) — подсказка, и только.
// Пункт снова придёт, только когда в чате или письме появится новое: это решает `seen` тика.
async function handleGotItTap({ update, callback, io }: CallbackContext) {
  const target = ownerPrivateMessage(callback);
  if (target === null) {
    const trusted = isTrustedSender(callback.from);
    await io
      .ackImpl(callback.id, tapGroupHint(trusted, callbackChat(callback)))
      .catch(() => {});
    log(
      "got-it tap ignored: not the owner in a private chat",
      senderId(callback.from),
    );
    return true;
  }
  const key = tapKey(callback) as string;
  if (isRepeatTap(key, update.update_id)) {
    await io.ackImpl(callback.id, alreadyRemovedText()).catch(() => {});
    return true;
  }
  const deleted = await io
    .deleteImpl(target.chatId, target.messageId)
    .catch(() => false);
  if (deleted) rememberTap(key, update.update_id);
  const hint = deleted
    ? tappedText(watchButtons(tr)[2].label)
    : notRemovedText();
  await io.ackImpl(callback.id, hint).catch(() => {});
  return true;
}

/** Сообщение с кнопкой, нажатой владельцем в личном чате; иначе null. */
function ownerPrivateMessage(
  callback: TelegramCallbackQuery,
): { chatId: number; messageId: number } | null {
  const chat = callbackChat(callback);
  const messageId = callback.message?.message_id;
  if (!isTrustedSender(callback.from) || !isPrivateTelegramChat(chat))
    return null;
  if (chat?.id === undefined || messageId === undefined) return null;
  return { chatId: chat.id, messageId };
}

const alreadyRemovedText = () => tr("Already removed", "Уже убрано");
const notRemovedText = () =>
  tr("Couldn't delete the message", "Не смогла удалить сообщение");

// Удаление сообщения Watch: true — Telegram подтвердил. Отказ и сбой сети — false.
async function deleteGotItMessage(
  chatId: number,
  messageId: number,
): Promise<boolean> {
  const result = await controlTg("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  }).catch((e: unknown) => {
    log("got-it delete failed:", errorMessage(e));
    return { ok: false };
  });
  return result?.ok === true;
}

// Сброс разговора и рестарт юнита — тем же performScopedReset, что у /new и /restart, и тем же
function tapGroupHint(
  trusted: boolean,
  chat: TelegramMessage["chat"],
): string | undefined {
  return trusted && isGroupChat(chat) ? privateChatOnlyText() : undefined;
}

// Кнопка, написанная моделью: её data — это реплика пользователя. Спиннер гасим
// сами и сразу: дальше тап едет сообщением, колбэком его уже никто не увидит
// (сессию наполняет только inbound pipeline, а он читает сообщения). Чужому —
// пустой ack без подсказок, контрол ему знать нечего. В группе тап сообщением не
// станет: там текст принимается лишь как упоминание, команда или reply боту, а
// нажатие кнопки — ни то, ни другое, поэтому говорим про личку прямо.
async function handleButtonTap(context: CallbackContext) {
  const { callback, io } = context;
  const trusted = isTrustedSender(callback.from);
  const groupHint = tapGroupHint(trusted, callbackChat(callback));
  if (trusted && groupHint === undefined) return handleOwnerTap(context);
  await io.ackImpl(callback.id, groupHint).catch(() => {});
  // Чужой тап дальше снимет admission по allowlist — со строкой в журнале.
  return trusted;
}

// Тап владельца в личке. Повтор той же кнопки другим апдейтом поглощается подсказкой
// «Уже выбрано»; тот же апдейт после write-failed проходит как свежий (specs/ButtonTap.tla).
// Дерево снимается до applyTelegramButtonTap: он удаляет callback_query из апдейта.
async function handleOwnerTap({ update, callback, io }: CallbackContext) {
  const restartTap = isInterruptedTap(callback.data);
  const key = chatKey(update);
  const accepted =
    restartTap && key !== null
      ? claimInterruptedTap(key, callback.data, update.update_id)
      : null;
  if (restartTap && accepted === null) {
    await io.ackImpl(callback.id, alreadyChosenText()).catch(() => {});
    return true;
  }
  if (isRepeatTap(tapKey(callback), update.update_id)) {
    await io.ackImpl(callback.id, alreadyChosenText()).catch(() => {});
    return true;
  }
  const snapshot = tapTree(callback.message);
  // Неполный конверт (нет чата, отправителя или номера сообщения) сообщением
  // стать не может: гасим тап здесь, дальше ему делать нечего.
  if (!applyTelegramButtonTap(update, callback, accepted?.text)) {
    await io.ackImpl(callback.id).catch(() => {});
    return true;
  }
  const { edit, label } = tapEdit(snapshot, callback);
  await io
    .ackImpl(callback.id, tappedText(label || callback.data))
    .catch(() => {});
  settleTap(io, update, callback, edit);
  return false;
}

// ── Отклик кнопки: подсказка, память «уже нажато», правка сообщения ──
// Память живёт до завершения процесса Bridge, без вытеснения другими кнопками.
// После рестарта она пуста (ADR-0015, specs/ButtonTap.tla: OnePerProcess).
const tappedButtons = new Map<string, number>();

const alreadyChosenText = () => tr("Already chosen", "Уже выбрано");

// answerCallbackQuery принимает до 200 знаков.
const tappedText = (label: string) =>
  Array.from(`✅ ${label}`).slice(0, 200).join("");

/** chat:message:data; без чата или номера сообщения ключа нет. */
function tapKey(callback: ControlCallbackQuery): string | null {
  const chatId = callbackChat(callback)?.id;
  const messageId = callback.message?.message_id;
  if (chatId === undefined || messageId === undefined) return null;
  return `${chatId}:${messageId}:${callback.data}`;
}

/** Повтор: эта кнопка уже стала сообщением ДРУГОГО апдейта. */
function isRepeatTap(key: string | null, updateId: number): boolean {
  const seen = key === null ? undefined : tappedButtons.get(key);
  return seen !== undefined && seen !== updateId;
}

function rememberTap(key: string, updateId: number): void {
  tappedButtons.set(key, updateId);
}

type TapTree = { tree: unknown; rich: boolean; isRtl?: unknown };

/** Кнопки полученного сообщения: блоки rich или ряды кнопок classic. */
function tapTree(message: TelegramMessage | undefined): TapTree | null {
  const rich = message?.rich_message as
    { blocks?: unknown; is_rtl?: unknown } | undefined;
  if (rich?.blocks !== undefined)
    return { tree: rich.blocks, rich: true, isRtl: rich.is_rtl };
  const markup = message?.reply_markup as
    { inline_keyboard?: unknown } | undefined;
  if (markup?.inline_keyboard === undefined) return null;
  return { tree: markup.inline_keyboard, rich: false };
}

/** data кнопок этого сообщения, которые уже стали сообщением (память процесса). */
function tappedOf(callback: ControlCallbackQuery): string[] {
  const key = tapKey(callback);
  if (key === null) return [];
  const prefix = key.slice(0, key.length - callback.data.length);
  return [...tappedButtons.keys()]
    .filter((seen) => seen.startsWith(prefix))
    .map((seen) => seen.slice(prefix.length));
}

// Снимок апдейта может быть старше правки, которая ещё в полёте: прежние нажатия этого
// сообщения отмечаются заново, чтобы правка, легшая последней, их не стёрла.
function tapEdit(
  snapshot: TapTree | null,
  callback: ControlCallbackQuery,
): { edit: TapEdit | null; label: string | null } {
  const marked = snapshot && markTappedButton(snapshot.tree, callback.data);
  if (!snapshot || !marked) return { edit: null, label: null };
  const tree = tappedOf(callback).reduce(
    (current, data) => markTappedButton(current, data)?.tree ?? current,
    marked.tree,
  );
  if (!snapshot.rich)
    return { edit: { inline_keyboard: tree }, label: marked.label };
  const rtl =
    typeof snapshot.isRtl === "boolean" ? { is_rtl: snapshot.isRtl } : {};
  return { edit: { rich: { blocks: tree, ...rtl } }, label: marked.label };
}

const tapMethod = (edit: TapEdit) =>
  "rich" in edit ? "editMessageText" : "editMessageReplyMarkup";

// Ключ в память всегда: тап уже стал сообщением, второй тап — второе сообщение. Правка
// уходит фоном, её исход ключа не снимает.
function settleTap(
  io: ControlIo,
  update: TelegramUpdate,
  callback: ControlCallbackQuery,
  edit: TapEdit | null,
): void {
  const key = tapKey(callback);
  if (key === null) return;
  rememberTap(key, update.update_id);
  if (edit === null) return;
  const chatId = callbackChat(callback)?.id as number;
  const messageId = callback.message?.message_id as number;
  io.scheduleImpl(`tap:${key}`, async () => {
    const marked = await io.editTapImpl(chatId, messageId, edit);
    log(
      marked ? "tap marked" : "tap mark failed",
      `${chatId}:${messageId}`,
      tapMethod(edit),
    );
  });
}

async function editTappedMessage(
  chatId: number,
  messageId: number,
  edit: TapEdit,
): Promise<boolean> {
  const method = tapMethod(edit);
  const body =
    "rich" in edit
      ? { rich_message: edit.rich }
      : { reply_markup: { inline_keyboard: edit.inline_keyboard } };
  const response = (await controlTg(method, {
    chat_id: chatId,
    message_id: messageId,
    ...body,
  }).catch((error: unknown) => ({
    ok: false,
    description: errorMessage(error),
  }))) as { ok?: unknown; description?: unknown };
  const description =
    typeof response.description === "string" ? response.description : "";
  // «message is not modified» — кнопка уже помечена: это успех, не сбой.
  if (response.ok === true || /message is not modified/i.test(description))
    return true;
  log("tap edit failed:", method, description);
  return false;
}

// ── Сообщения ──

async function handleMessage(
  update: TelegramUpdate,
  io: ControlIo,
): Promise<ControlResult> {
  const msg = update.message;
  if (!msg) return false;
  const text = messageText(msg);
  const captured = await capturePendingInput(msg, text);
  return captured === UNCLAIMED
    ? handleCommand(update, msg, text, io)
    : captured;
}

function messageText(msg: TelegramMessage): string {
  return (msg.text || "").trim();
}

// A pending flow (menu screen or /model wizard) awaiting input claims this user's next message
// (a key must never reach eve); a command aborts the wait — a silently still-visible prompt would
// invite pasting the key later, when nothing intercepts it. This runs BEFORE the busy-buffer gate
// (below), so a capture works even mid-turn. Non-text is intercepted only while awaiting a SECRET
// (or a file-capable secret): a document/photo could be the secret itself and must not reach eve.
// A non-secret await (e.g. the memory interview) lets a non-text message fall through unchanged.
type WizardPending = NonNullable<ReturnType<typeof getWizard>>;
type PendingInput = {
  msg: TelegramMessage;
  text: string;
  pending: WizardPending;
  awaited: AwaitText;
};
type PendingInputRule = readonly [
  (input: PendingInput) => boolean,
  (input: PendingInput) => Claim,
];

// Порядок важен: первое совпадение решает, не совпало ничего — сообщение идёт дальше.
const PENDING_INPUT_RULES: readonly PendingInputRule[] = [
  [(input) => input.text.startsWith("/"), abandonPendingInput],
  [isMenuText, captureMenuText],
  [(input) => input.text !== "", captureWizardText],
  [isAwaitedSecret, captureSecretAttachment],
];

function isMenuText(input: PendingInput): boolean {
  return input.text !== "" && input.pending.flow === "menu";
}

function isAwaitedSecret(input: PendingInput): boolean {
  return Boolean(input.awaited.secret || input.awaited.file);
}

// Ожидание есть, но сообщение ему не подходит (не-текст при не-секретном вопросе).
const PASS_PENDING_INPUT: PendingInputRule = [
  () => true,
  () => Promise.resolve(UNCLAIMED),
];

async function capturePendingInput(msg: TelegramMessage, text: string): Claim {
  const input = pendingInput(msg, text);
  if (input === null) return UNCLAIMED;
  const [, capture] =
    PENDING_INPUT_RULES.find(([matches]) => matches(input)) ??
    PASS_PENDING_INPUT;
  return capture(input);
}

function pendingInput(msg: TelegramMessage, text: string): PendingInput | null {
  const pending = privatePending(msg);
  if (pending === null) return null;
  return isAwaitText(pending.awaitText)
    ? { msg, text, pending, awaited: pending.awaitText }
    : null;
}

function privatePending(msg: TelegramMessage): WizardPending | null {
  if (!msg.from || !isPrivateTelegramChat(msg.chat)) return null;
  return getWizard(chatIdOf(msg), String(msg.from.id));
}

// Команда снимает ожидание и идёт дальше как команда.
async function abandonPendingInput({ pending }: PendingInput) {
  await endWizard(
    pending,
    tr(
      "Cancelled — no longer waiting for input.",
      "Отменено — ожидание ввода снято.",
    ),
  ).catch(() => {});
  return UNCLAIMED;
}

// Menu screens own their capture (interview / key intake / gws JSON / ubcred).
// e.message never contains a secret value.
function captureMenuText({ msg, pending }: PendingInput) {
  return settleLogged(menu.onText(msg, pending), "menu capture error:", true);
}

// /model wizard text intake (key, endpoint address, model id) — consume the update
// even on failure (a key must never be re-polled into eve). handleWizardText stays
// the wizard's own handler; e.message never contains the key value.
function captureWizardText({ msg, pending }: PendingInput) {
  return settleLogged(
    handleWizardText(
      msg as { chat: { id: number }; message_id: number; text: string },
      pending,
    ),
    "wizard key error:",
    true,
  );
}

// Non-text while awaiting a secret — never let it reach eve (delete-first inside).
function captureSecretAttachment({ msg, pending }: PendingInput) {
  return settleLogged(
    handleAwaitNonText(msg, pending),
    "menu attachment capture error:",
    true,
  );
}

// ── Команды ──

type OutOfBandCommand = (typeof OUT_OF_BAND_COMMANDS)[number];
type ControlCommand = {
  update: TelegramUpdate;
  msg: TelegramMessage;
  text: string;
  cmd: OutOfBandCommand;
  from: string;
  chatId: number;
  io: ControlIo;
};
type CommandHandler = (command: ControlCommand) => Promise<boolean>;

const COMMAND_HANDLERS: Record<OutOfBandCommand, CommandHandler> = {
  "/menu": openMenu,
  "/help": ({ io, chatId }) => replyConfirmed(io, chatId, helpText()),
  // /start — кнопка Start у нового пользователя. Без этой ветки приветствие уходило
  // обычным ходом в модель: платный запрос ради «привет». Отвечает мост, out-of-band.
  "/start": ({ io, chatId }) => replyConfirmed(io, chatId, startText()),
  "/stop": stopCommand,
  "/usage": reportUsage,
  "/restart": resetConversation,
  "/new": resetConversation,
  "/compact": compactConversation,
  // /update — check upstream; if newer, offer inline Update/Skip buttons. Out-of-band.
  "/update": ({ chatId, text }) =>
    handleUpdateCheck(chatId, { force: text.split(/\s+/).includes("--force") }),
  // /model, /think — provider/model/effort wizard (writes .env; applied on restart).
  "/model": ({ chatId, from }) =>
    settleLogged(handleModelCmd(chatId, from), "wizard /model error:", false),
  "/think": ({ chatId, from }) =>
    settleLogged(handleThinkCmd(chatId, from), "wizard /think error:", false),
};

function isOutOfBandCommand(cmd: string): cmd is OutOfBandCommand {
  return (OUT_OF_BAND_COMMANDS as readonly string[]).includes(cmd);
}

function commandName(text: string): OutOfBandCommand | null {
  if (!text.startsWith("/")) return null;
  const cmd = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();
  return isOutOfBandCommand(cmd) ? cmd : null;
}

async function handleCommand(
  update: TelegramUpdate,
  msg: TelegramMessage,
  text: string,
  io: ControlIo,
): Promise<boolean> {
  const cmd = commandName(text);
  if (cmd === null) return false;
  const command = trustedCommand({ update, msg, text, cmd, io });
  if (command === null) return false; // untrusted — let eve drop it
  return runCommand(command);
}

function trustedCommand(
  base: Omit<ControlCommand, "from" | "chatId">,
): ControlCommand | null {
  const from = senderId(base.msg.from);
  const chatId = chatIdOf(base.msg);
  return isAllowlisted(from) && chatId !== undefined
    ? { ...base, from, chatId }
    : null;
}

function runCommand(command: ControlCommand): Promise<boolean> {
  if (needsPrivateChat(command)) return declineGroupCommand(command);
  return COMMAND_HANDLERS[command.cmd](command);
}

function needsPrivateChat({ cmd, msg }: ControlCommand): boolean {
  return PRIVATE_ONLY_COMMANDS.has(cmd) && !isPrivateTelegramChat(msg.chat);
}

async function declineGroupCommand({ io, chatId }: ControlCommand) {
  await io
    .replyImpl(chatId, privateChatOnlyText())
    .catch((e: unknown) =>
      log("private-chat rejection failed:", errorMessage(e)),
    );
  return true;
}

async function replyConfirmed(io: ControlIo, chatId: number, text: string) {
  return replySucceeded(await io.replyImpl(chatId, text));
}

// /menu — open the nested settings menu (out-of-band; errors consumed, never reach eve).
async function openMenu({ chatId, from }: ControlCommand) {
  await menu
    .open(chatId, from)
    .catch((e: unknown) => log("menu error:", errorDetails(e).message));
  return true;
}

// Out-of-band so it reaches a busy agent (an ordinary message would be queued by
// the gate below and never processed).
async function stopCommand({ update, io, chatId }: ControlCommand) {
  const status = getChatStatus(chatKey(update) ?? "");
  const outcome = await requestTurnStop(update, {
    cancelImpl: io.cancelImpl,
    getStatusImpl: () => status,
  });
  // Принятая отмена завершается событиями хода; /stop отвечает только при отказе или idle.
  if (isPendingStopOutcome(outcome)) return true;
  return replyConfirmed(io, chatId, stopOutcomeText(replyOutcomeOf(outcome)));
}

// /usage — token spend from data/usage.jsonl. Out-of-band and FREE (we don't call the model).
async function reportUsage({ text, chatId }: ControlCommand) {
  return replySucceeded(await replyTo(chatId, usageReportText(text)));
}

function usageReportText(text: string): string {
  try {
    const agg = summarize(readEntries(), {
      window: parseWindow(text.split(/\s+/).slice(1).join(" ")),
      now: Date.now(),
      tz: process.env.ASSISTANT_TIMEZONE,
    });
    return formatUsageReport(agg);
  } catch (e: unknown) {
    return "Couldn't read the usage log: " + errorMessage(e);
  }
}

// Та же адресация, что /new, включая ответ на сообщение бота в группе.
async function compactConversation(command: ControlCommand) {
  const key = chatKey(command.update);
  const target = resetTargetFor(command.update, key);
  if (!key || !target)
    return replyConfirmed(
      command.io,
      command.chatId,
      tr(
        "Reply to my message to select a conversation, then use /compact.",
        "Ответь на моё сообщение командой /compact, чтобы выбрать разговор.",
      ),
    );
  try {
    const response = await fetch(localChannelUrl(TELEGRAM_COMPACT_ROUTE), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": SECRET ?? "",
      },
      body: JSON.stringify({ chatKey: key, target }),
      signal: AbortSignal.timeout(10_000),
    });
    const result: unknown = await response.json();
    if (
      !response.ok ||
      typeof result !== "object" ||
      result === null ||
      !("text" in result) ||
      typeof result.text !== "string"
    )
      throw new Error("compact response missing text");
    return replyConfirmed(command.io, command.chatId, result.text);
  } catch (error) {
    log("compact command failed:", errorMessage(error));
    return replyConfirmed(
      command.io,
      command.chatId,
      tr(
        "Compression couldn't be confirmed. Try /compact after the chat is free.",
        "Подтверждение сжатия пока отсутствует. Повтори /compact, когда чат освободится.",
      ),
    );
  }
}

// ── /new и /restart ──
// /new retires only this exact Telegram session. /restart does the same first,
// then restarts the agent process; histories and queues of other chats survive.

type ResetRun = ControlCommand & {
  key: string | null;
  target: TelegramResetTarget | null;
  clearsPrivateQueue: boolean;
};
type ActiveReset = ResetRun & {
  key: string;
  target: TelegramResetTarget;
  status: SentMessage | null;
  copy: ReturnType<typeof resetMessageCopy>;
};
type ResetFailure = { phase: string; message: unknown; escalated: boolean };

async function resetConversation(command: ControlCommand) {
  const run = resetRun(command);
  return (await holdForPendingRetry(run)) ?? startReset(run);
}

function resetRun(command: ControlCommand): ResetRun {
  const key = chatKey(command.update);
  return {
    ...command,
    key,
    target: resetTargetFor(command.update, key),
    clearsPrivateQueue: command.msg.chat?.type === "private",
  };
}

function resetTargetFor(
  update: TelegramUpdate,
  key: string | null,
): TelegramResetTarget | null {
  return key
    ? resetTargetForControl(
        update,
        getChatStatus(key),
        BOT_USER_ID ?? undefined,
      )
    : null;
}

function privateResetKey(run: ResetRun): string | null {
  return run.clearsPrivateQueue && run.key ? run.key : null;
}

async function holdForPendingRetry(run: ResetRun): Promise<true | undefined> {
  const key = privateResetKey(run);
  if (key === null || !run.io.resetRetryPendingImpl(key)) return undefined;
  return answerPendingRetry(run, key);
}

async function answerPendingRetry(run: ResetRun, key: string): Promise<true> {
  // Telegram owns one global ordered offset. Advancing it without durable intent loses /new.
  if (!run.io.resetIntentPendingImpl(key))
    throw Object.assign(new Error(`reset retry backoff active for ${key}`), {
      resetPhase: "backoff",
    });
  await run.io.replyImpl(run.chatId, retryScheduledText());
  return true;
}

async function startReset(run: ResetRun) {
  const copy = resetMessageCopy(run.cmd, await readEnvFresh(ENV_PATH));
  const status = await run.io.replyImpl(run.chatId, copy.pending);
  if (!run.target || !run.key) return reportUnidentified(run, status);
  return performReset({
    ...run,
    key: run.key,
    target: run.target,
    status,
    copy,
  });
}

async function editStatus(
  chatId: number,
  status: SentMessage | null,
  text: string,
) {
  if (status) await editMessage(chatId, status.message_id, text);
}

async function reportUnidentified(run: ResetRun, status: SentMessage | null) {
  await editStatus(
    run.chatId,
    status,
    tr(
      "⚠️ I couldn't identify this conversation. In a group, reply /new to Iva's latest message.",
      "⚠️ Не удалось определить этот диалог. В группе ответьте /new на последнее сообщение Iva.",
    ),
  );
  return replySucceeded(status);
}

async function performReset(reset: ActiveReset) {
  try {
    await reset.io.performResetImpl(
      reset.key,
      reset.target,
      resetQueueScope(reset),
    );
  } catch (e: unknown) {
    return resetFailed(reset, e);
  }
  return finishReset(reset);
}

// Group/forum queues are keyed only by chat/topic while Eve sessions also
// include conversationId. Clearing the shared queue here would lose
// messages belonging to other group conversation anchors.
function resetQueueScope(run: ResetRun) {
  return {
    clearQueue: run.clearsPrivateQueue,
    discardThroughUpdateId: run.clearsPrivateQueue
      ? run.update.update_id
      : undefined,
  };
}

async function resetFailed(reset: ActiveReset, e: unknown) {
  const failure = resetFailure(e);
  log(
    `scoped reset ${failure.phase} failed for ${reset.key}:`,
    failure.message,
  );
  await editStatus(reset.chatId, reset.status, resetFailureText(failure));
  if (resetFailureSettled(reset, failure)) return true;
  // Other private failures may precede durable intent or cleanup, so retain the
  // Telegram update for the polling-loop boundary to retry.
  if (reset.clearsPrivateQueue) throw e;
  return true;
}

function resetFailure(e: unknown): ResetFailure {
  const error = errorDetails(e);
  const phase =
    typeof error.resetPhase === "string" ? error.resetPhase : "unknown";
  return {
    phase,
    message: error.message,
    escalated: intentEscalated(phase, error.resetFailures),
  };
}

function intentEscalated(phase: string, failures: unknown): boolean {
  return (
    phase === "intent" &&
    typeof failures === "number" &&
    failures >= RESET_INTENT_ESCALATION_ATTEMPTS
  );
}

const RESET_FAILURE_TEXTS = new Map<string, () => string>([
  [
    "remote",
    () =>
      tr(
        "⚠️ Couldn't confirm this conversation reset. Recovery will retry automatically.",
        "⚠️ Не удалось подтвердить сброс диалога. Восстановление повторит его автоматически.",
      ),
  ],
  ["backoff", retryScheduledText],
]);

const resetIncompleteText = () =>
  tr(
    "⚠️ Conversation reset recovery is incomplete. Iva will retry it before accepting queued work.",
    "⚠️ Восстановление после сброса не завершено. Iva повторит его до приёма задач из очереди.",
  );

function resetFailureText(failure: ResetFailure): string {
  if (failure.escalated)
    return tr(
      "⚠️ Conversation reset cannot be saved. Run iva reset on the server, then try /new again.",
      "⚠️ Не удалось сохранить сброс диалога. Запусти iva reset на сервере, затем повтори /new.",
    );
  return (RESET_FAILURE_TEXTS.get(failure.phase) ?? resetIncompleteText)();
}

function resetFailureSettled(reset: ActiveReset, failure: ResetFailure) {
  return (
    failure.escalated ||
    failure.phase === "remote" ||
    backoffIntentSaved(reset, failure)
  );
}

function backoffIntentSaved(reset: ActiveReset, failure: ResetFailure) {
  return (
    failure.phase === "backoff" && reset.io.resetIntentPendingImpl(reset.key)
  );
}

async function finishReset(reset: ActiveReset) {
  const text = (await restartFailed(reset.cmd))
    ? tr(
        "⚠️ Conversation reset, but Iva couldn't restart.",
        "⚠️ Диалог сброшен, но перезапустить Iva не удалось.",
      )
    : reset.copy.complete;
  await editStatus(reset.chatId, reset.status, text);
  return true;
}

async function restartFailed(cmd: OutOfBandCommand): Promise<boolean> {
  return cmd === "/restart" && !(await restartService());
}

// с дедлайном: systemd сам отказывает по TimeoutStartSec (по умолчанию 90 с), поэтому ждать
// дольше — значит ждать зависший вызов. Отказ виден вызывающему как false, как и любой другой.
const SERVICE_RESTART_TIMEOUT_MS = 120_000;

async function restartService(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      sc("restart", "iva.service"),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), SERVICE_RESTART_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export { registerBotCommands, handleControl };
