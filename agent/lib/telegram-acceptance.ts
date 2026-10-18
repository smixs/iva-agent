import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type {
  TelegramChannelState,
  TelegramContext,
  TelegramInboundResultOrPromise,
  TelegramMessage,
} from "eve/channels/telegram";
import { parseTelegramUpdate } from "eve/channels/telegram";
import type { ChannelSource, RouteHandlerArgs, TurnPolicy } from "eve/channels";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "./json-store.ts";
import { dataDir } from "./data-dir.ts";
import { quarantineDamagedRecord } from "./damaged-record.ts";
import {
  chatKeyOf,
  getChatStatus,
  hasTelegramPendingInputRequests,
  setChatStatusIf,
} from "./run-status.ts";
import { steerTurnContext } from "./i18n.ts";
import { traceInboundOutcome } from "./trace.ts";
import { TELEGRAM_QUEUE_RECEIPT_FIELD } from "./telegram-parts.ts";
import { readSettings } from "./settings.ts";

export const TELEGRAM_ACCEPTANCE_ROUTE = "/eve/v1/telegram/accepted";
export const TELEGRAM_ACCEPTANCE_KIND_HEADER = "x-iva-telegram-acceptance";
// Ответ на сообщение закрытой сессии нельзя доставить как input response.
// Bridge узнаёт этот класс по заголовку и хоронит апдейт вместо ретрая.
export const TELEGRAM_CLOSED_SESSION_KIND = "closed-session";

type ReceiptContext = { receipt: string | null; handled: boolean };
type CompletedLedger = { botId: string; updates: number[] };
type AcceptedWebhookOptions = { completedUpdatesFile?: string };
type AcceptedWebhookHandler<TState> = (
  request: Request,
  args: RouteHandlerArgs<TState>,
) => Promise<Response>;
type TelegramReroute = {
  message: string;
  state: TelegramChannelState & { chatId: string };
};
type RequestMetadata = {
  receipt: string | null;
  reroute: TelegramReroute | null;
  updateId: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const receiptContext = new AsyncLocalStorage<ReceiptContext>();
const RECEIPT_PATTERN = /^[a-f0-9]{32}$/u;
const BOT_ID_PATTERN = /^(?<id>[1-9]\d*):/u;
const COMPLETED_UPDATES_LIMIT = 200;
// Process-local fence for bridge retries while one acceptance is still running.
// Remove with vercel/eve#2876, when replay can no longer outlive the 90 s acceptance window.
const inFlightUpdates = new Map<string, Promise<Response>>();
let missingWebhookSecretReported = false;

function validReceipt(value: unknown): value is string {
  return typeof value === "string" && RECEIPT_PATTERN.test(value);
}

export function telegramTurnPolicy(
  settings: Record<string, unknown> = readSettings(),
): TurnPolicy {
  return settings.turnPolicy === "steer" ? "steer" : "queue";
}

function telegramReroute(body: unknown): TelegramReroute | null {
  const update = parseTelegramUpdate(body);
  if (update?.kind !== "message") return null;
  const message = update.message;
  if (message.replyToMessage?.from?.isBot !== true) return null;
  const text = message.text || message.caption;
  if (text.trim().length === 0 && message.attachments.length === 0) return null;
  const privateChat = message.chat.type === "private";
  return {
    message: text,
    state: {
      botUsername: null,
      chatId: message.chat.id,
      chatType: message.chat.type,
      conversationId: privateChat ? null : message.replyToMessage.messageId,
      hitlCallbacks: {},
      messageThreadId: message.messageThreadId ?? null,
      nextHitlCallbackId: 0,
      pendingAuthMessageIds: {},
      pendingFreeformReplies: {},
      triggeringUserId: message.from?.id ?? null,
    },
  };
}

function hasValidWebhookSecret(request: Request): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  if (!expected) {
    if (!missingWebhookSecretReported) {
      console.error(
        "[telegram] TELEGRAM_WEBHOOK_SECRET_TOKEN не задан: durable deduplication отключена",
      );
      missingWebhookSecretReported = true;
    }
    return false;
  }
  const supplied = request.headers.get("x-telegram-bot-api-secret-token");
  if (!supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function configuredBotId(): string | null {
  return (
    BOT_ID_PATTERN.exec(process.env.TELEGRAM_BOT_TOKEN ?? "")?.groups?.id ??
    null
  );
}

export function addTelegramQueueReceipt<T extends Record<string, unknown>>(
  update: T,
  receipt = randomBytes(16).toString("hex"),
): T {
  if (
    !isRecord(update) ||
    !isRecord(update.message) ||
    !validReceipt(receipt)
  ) {
    throw new Error(
      "Telegram queue receipt requires a message update and a 128-bit hex id",
    );
  }
  return {
    ...update,
    message: {
      ...update.message,
      [TELEGRAM_QUEUE_RECEIPT_FIELD]: receipt,
    },
  };
}

export function wrapTelegramQueueOnMessage(
  onMessage: (
    context: TelegramContext,
    message: TelegramMessage,
  ) => TelegramInboundResultOrPromise,
): (
  context: TelegramContext,
  message: TelegramMessage,
) => Promise<Awaited<TelegramInboundResultOrPromise>> {
  return async (context, message) => {
    const raw = message?.raw;
    const receipt =
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      validReceipt(raw[TELEGRAM_QUEUE_RECEIPT_FIELD])
        ? raw[TELEGRAM_QUEUE_RECEIPT_FIELD]
        : null;
    if (typeof raw === "object" && raw !== null) {
      Reflect.deleteProperty(raw, TELEGRAM_QUEUE_RECEIPT_FIELD);
    }

    const result = await onMessage(context, message);
    // Trace: чем кончился inbound-пайплайн и каким апдейтом вызван начинающийся ход.
    // Место выбрано снаружи пайплайна: только здесь видны и сообщение, и его результат,
    // а сам пайплайн остаётся с одной точкой журнала (ADR-0010).
    traceInboundOutcome(
      message,
      chatKeyOf(message.chat.id, message.messageThreadId),
      result?.context,
      result !== null && result !== undefined,
    );
    const active = receiptContext.getStore();
    if (result === null && receipt !== null && active?.receipt === receipt) {
      active.handled = true;
    }
    return result;
  };
}

async function metadataFromRequest(request: Request): Promise<RequestMetadata> {
  try {
    const body: unknown = await request.clone().json();
    const receipt =
      isRecord(body) && isRecord(body.message)
        ? body.message[TELEGRAM_QUEUE_RECEIPT_FIELD]
        : undefined;
    return {
      receipt: validReceipt(receipt) ? receipt : null,
      reroute: telegramReroute(body),
      updateId:
        isRecord(body) &&
        typeof body.update_id === "number" &&
        Number.isSafeInteger(body.update_id) &&
        body.update_id >= 0
          ? body.update_id
          : null,
    };
  } catch (error) {
    console.error(
      `[telegram] не разобрал тело входящего запроса, dedup по update_id выключен: ${String(error)}`,
    );
    return { receipt: null, reroute: null, updateId: null };
  }
}

function validCompletedLedger(value: unknown): CompletedLedger {
  if (
    !isRecord(value) ||
    typeof value.botId !== "string" ||
    !Array.isArray(value.updates)
  ) {
    throw new Error("completed Telegram update ledger has invalid schema");
  }
  return value as CompletedLedger;
}

async function loadCompletedLedger(
  file: string,
  botId: string,
): Promise<{ ledger: CompletedLedger; recovered: boolean }> {
  try {
    const ledger = validCompletedLedger(
      await loadJsonStrict(file, { botId, updates: [] }),
    );
    const updates = ledger.updates.filter((id) => {
      if (Number.isSafeInteger(id) && id >= 0) return true;
      quarantineDamagedRecord(file, {
        reason: "invalid update id",
        record: id,
        label: "completed updates",
      });
      return false;
    });
    const recovered = updates.length !== ledger.updates.length;
    return { ledger: { ...ledger, updates }, recovered };
  } catch (error) {
    const message =
      error !== null && typeof error === "object" && "message" in error
        ? String(error.message)
        : String(error);
    if (
      !message.includes("damaged (invalid JSON)") &&
      !message.includes("ledger has invalid schema")
    ) {
      throw error;
    }
    console.error(
      `[telegram] ledger завершённых update пересоздан: ${message}`,
    );
    return { ledger: { botId, updates: [] }, recovered: true };
  }
}

async function withCompletedLedger<T>(
  file: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = `${file}.lock`;
  const token = await acquireLock(lock);
  try {
    return await fn();
  } finally {
    releaseLock(lock, token);
  }
}

async function hasCompletedUpdate(
  file: string,
  botId: string,
  updateId: number,
): Promise<boolean> {
  return withCompletedLedger(file, async () => {
    const { ledger, recovered } = await loadCompletedLedger(file, botId);
    if (recovered) await saveJsonAtomic(file, ledger);
    return ledger.botId === botId && ledger.updates.includes(updateId);
  });
}

async function recordCompletedUpdate(
  file: string,
  botId: string,
  updateId: number,
): Promise<void> {
  return withCompletedLedger(file, async () => {
    const { ledger, recovered } = await loadCompletedLedger(file, botId);
    const current = ledger.botId === botId ? ledger.updates : [];
    const updates = current.includes(updateId)
      ? current
      : [...current, updateId].slice(-COMPLETED_UPDATES_LIMIT);
    if (recovered || ledger.botId !== botId || updates !== current) {
      await saveJsonAtomic(file, { botId, updates });
    }
  });
}

// telegramChannel acknowledges webhooks before its waitUntil dispatch has called
// send(). The polling bridge needs a stronger receipt for durable FIFO replay:
// this wrapper runs the authored channel handler unchanged, but waits until its
// real Eve send has resolved before returning success.
export async function handleAcceptedTelegramWebhook<TState>(
  handler: AcceptedWebhookHandler<TState>,
  request: Request,
  args: RouteHandlerArgs<TState>,
  options: AcceptedWebhookOptions = {},
): Promise<Response> {
  const { receipt, reroute, updateId } = await metadataFromRequest(request);
  const authenticated = hasValidWebhookSecret(request);
  const botId = configuredBotId();
  const completedFile =
    options.completedUpdatesFile ?? join(dataDir(), "completed-updates.json");
  // Старые/нестандартные payload без update_id сохраняют прежний путь обработки.
  if (
    updateId !== null &&
    authenticated &&
    botId !== null &&
    (await hasCompletedUpdate(completedFile, botId, updateId))
  ) {
    return new Response(null, {
      status: 204,
      headers: { [TELEGRAM_ACCEPTANCE_KIND_HEADER]: "handled" },
    });
  }
  const inFlightKey =
    updateId !== null && authenticated && botId !== null
      ? `${botId}:${updateId}`
      : null;
  const existing =
    inFlightKey === null ? undefined : inFlightUpdates.get(inFlightKey);
  if (existing) return (await existing).clone();

  const processing = receiptContext.run(
    { receipt, handled: false },
    async () => {
      const background: Promise<unknown>[] = [];
      let accepted = false;
      let closedSession = false;
      const updateLabel = updateId === null ? "unknown" : String(updateId);

      const wrappedFrom: RouteHandlerArgs<TState>["from"] = (address) => {
        const source = args.from(address);
        const send: ChannelSource<TState>["send"] = async (
          message,
          options,
        ) => {
          const turnPolicy = telegramTurnPolicy();
          const state = (
            "state" in options ? options.state : {}
          ) as TelegramChannelState;
          const key = chatKeyOf(state.chatId ?? "", state.messageThreadId);
          const running = getChatStatus(key);
          const expected = { generation: running?.generation };
          const context = [...(options.context ?? [])];
          if (
            turnPolicy === "steer" &&
            running?.status === "running" &&
            typeof running.turnId === "string" &&
            !running.compacting &&
            setChatStatusIf(key, expected, { wasCancelled: "steer" })
          )
            context.push(steerTurnContext());
          const active = await source.send(message, {
            ...options,
            turnPolicy,
            context,
          });
          accepted = true;
          return active;
        };
        const respond: ChannelSource<TState>["respond"] = async (
          inputResponses,
          options,
        ) => {
          const active = await args.resolveSession(address);
          if (active !== undefined) {
            if (reroute !== null) {
              const scanStartedAt = Date.now();
              let pendingInput = false;
              let scanError: unknown;
              try {
                pendingInput = hasTelegramPendingInputRequests(
                  chatKeyOf(
                    reroute.state.chatId,
                    reroute.state.messageThreadId,
                  ),
                  active.id,
                );
              } catch (error) {
                scanError = error;
              }
              const scanElapsedMs = Date.now() - scanStartedAt;
              if (!pendingInput) {
                if (scanError === undefined) {
                  console.error(
                    `[telegram] reply has no pending input after ${scanElapsedMs}ms; delivering as a new message (update ${updateLabel})`,
                  );
                } else {
                  const reason =
                    scanError instanceof Error
                      ? scanError.message
                      : typeof scanError === "string"
                        ? scanError
                        : "unknown error";
                  console.error(
                    `[telegram] pending input scan failed after ${scanElapsedMs}ms; delivering reply as a new message (update ${updateLabel}): ${reason}`,
                  );
                }
                return send(reroute.message, {
                  ...options,
                  state: reroute.state as TState,
                } as Parameters<ChannelSource<TState>["send"]>[1]);
              }
            }

            let result;
            try {
              result = await active.respond(inputResponses, {
                auth: options.auth,
                ...(options.context === undefined
                  ? {}
                  : { context: options.context }),
                ...(options.outputSchema === undefined
                  ? {}
                  : { outputSchema: options.outputSchema }),
              });
            } catch (error) {
              if (reroute === null) throw error;
              const reason =
                error instanceof Error ? error.message : String(error);
              console.error(
                `[telegram] reply response failed; delivering as a new message (update ${updateLabel}): ${reason}`,
              );
              return send(reroute.message, {
                ...options,
                state: reroute.state as TState,
              } as Parameters<ChannelSource<TState>["send"]>[1]);
            }
            if (result.status === "accepted") {
              accepted = true;
              return args.attachSession(result.sessionId);
            }
          }

          if (reroute === null) {
            closedSession = true;
            throw new Error("Telegram response targeted an inactive session");
          }
          console.error(
            `[telegram] reply to a closed session; delivering as a new message (update ${updateLabel})`,
          );
          return send(reroute.message, {
            ...options,
            state: reroute.state as TState,
          } as Parameters<ChannelSource<TState>["send"]>[1]);
        };
        return {
          cancel: source.cancel.bind(source),
          clear: source.clear.bind(source),
          compact: source.compact.bind(source),
          reset: source.reset.bind(source),
          respond,
          send,
        };
      };

      const wrappedArgs: RouteHandlerArgs<TState> = {
        ...args,
        from: wrappedFrom,
        waitUntil: (task: Promise<unknown>) => {
          background.push(Promise.resolve(task));
        },
      };
      const response = await handler(request, wrappedArgs);

      if (!response.ok) return response;
      await Promise.allSettled(background);
      const handled = receiptContext.getStore()?.handled === true;
      if (accepted || handled) {
        if (updateId !== null && authenticated && botId !== null) {
          try {
            await recordCompletedUpdate(completedFile, botId, updateId);
          } catch (error) {
            // Ход уже принят: ошибка ledger не должна вернуть 5xx и запустить тот же ход снова.
            console.error(
              "[telegram] не смог записать завершённый update:",
              error,
            );
          }
        }
        return new Response(null, {
          status: 204,
          headers: {
            [TELEGRAM_ACCEPTANCE_KIND_HEADER]: accepted ? "turn" : "handled",
          },
        });
      }
      if (closedSession) {
        return new Response("Telegram reply targeted a closed session", {
          status: 409,
          headers: {
            [TELEGRAM_ACCEPTANCE_KIND_HEADER]: TELEGRAM_CLOSED_SESSION_KIND,
          },
        });
      }
      return new Response("Telegram update was not accepted by Eve", {
        status: 503,
      });
    },
  );
  if (inFlightKey !== null) inFlightUpdates.set(inFlightKey, processing);
  try {
    return await processing;
  } finally {
    if (inFlightKey !== null && inFlightUpdates.get(inFlightKey) === processing)
      inFlightUpdates.delete(inFlightKey);
  }
}
