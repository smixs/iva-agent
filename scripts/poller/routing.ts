import {
  isReplyToBot,
  materializeQueueItem,
  queueCount,
  queueHead,
  queueKeys,
  shouldQueueBusyUpdate,
  TELEGRAM_QUEUE_FATAL_DURABILITY,
} from "../lib/telegram-queue.ts";
import type {
  TelegramQueueDocument,
  TelegramQueueMessage,
  TelegramQueueUpdate,
} from "../lib/telegram-queue.ts";
import {
  getChatStatus,
  isCompacting,
  isRunning,
  RUN_STALE_MS,
  setChatStatusIf,
} from "#lib/run-status.ts";
import { tr } from "#lib/i18n.ts";
import {
  TELEGRAM_CLOSED_SESSION_KIND,
  telegramTurnPolicy,
} from "#lib/telegram-acceptance.ts";
import {
  ACCEPTANCE_ROUTE,
  ALLOWED,
  BOT_USERNAME,
  DATA_DIR,
  DIRECT_ACCEPTANCE_TIMEOUT_MS,
  SETTLE_MS,
  log,
} from "./config.ts";
import { chatKey } from "./offset.ts";
import { pacedDeliver, type DeliverOptions } from "./deliver.ts";
import {
  acknowledgeTelegramQueueHead,
  acknowledgeQueued,
  clearFailedDirectIngress,
  deleteStaleWorkingMessage,
  enqueueTelegramQueueUpdate,
  hasPrivateResetIntent,
  loadQueue,
  QUEUE_DELIVERY_TIMEOUT_MS,
  QUEUE_DRAIN_BUDGET_MS,
  queueDrainRotation,
  queueInFlight,
  queueSettleUntil,
  sendStaleRunNotice,
  statusGeneration,
  undrainableLegacyLogged,
} from "./queue.ts";
import type { QueuePhase } from "./queue.ts";
import { alertOnce, alertResolved } from "../lib/notice-policy.ts";

type MaybePromise<T> = T | Promise<T>;
type ErrorLike = { code?: unknown; message?: unknown };
type Status = Record<string, unknown>;
type DeliveryResult = Awaited<ReturnType<typeof pacedDeliver>>;
type DeliverImpl = (
  update: TelegramQueueUpdate,
  options?: DeliverOptions,
) => MaybePromise<DeliveryResult>;
type StatusImpl = (key: string) => Status | null;
type SetStatusIfImpl = (
  key: string,
  expected: Status,
  patch: Status,
) => Status | null;
const errorMessage = (error: unknown) => (error as ErrorLike).message;
const errorCode = (error: unknown) =>
  (error as ErrorLike | null | undefined)?.code;
const pacedDelivery: DeliverImpl = pacedDeliver;
// Приёмка падает часто при живой поломке — ждать неделю бессмысленно.
const TELEGRAM_ACCEPTANCE_ALERT_REPEAT_MS = 10 * 60 * 1000;

type DirectDeliveryOptions = {
  key?: string | null;
  deliverImpl?: DeliverImpl;
  statusImpl?: StatusImpl;
  setStatusIfImpl?: SetStatusIfImpl;
  sendFailureImpl?: (key: string, text: string) => MaybePromise<unknown>;
  alertImpl?: typeof alertOnce;
  alertResolvedImpl?: typeof alertResolved;
  alertDataDir?: string;
  deleteMessageImpl?: (
    key: string,
    messageId: string | number,
  ) => MaybePromise<unknown>;
  now?: () => number;
  trImpl?: (en: string, ru: string) => string;
  logImpl?: (...parts: unknown[]) => void;
};

async function deliverDirectUpdate(
  update: TelegramQueueUpdate,
  {
    key = chatKey(update),
    deliverImpl = pacedDelivery,
    statusImpl = getChatStatus,
    setStatusIfImpl = setChatStatusIf,
    sendFailureImpl = sendStaleRunNotice,
    alertImpl = alertOnce,
    alertResolvedImpl = alertResolved,
    alertDataDir = DATA_DIR,
    deleteMessageImpl = deleteStaleWorkingMessage,
    now = Date.now,
    trImpl = tr,
    logImpl = log,
  }: DirectDeliveryOptions = {},
) {
  // The acceptance wrapper does not cover callback_query dispatch. Keeping this
  // call option-free also preserves the old webhook path for real callbacks and
  // the synthetic /stop callback.
  if (!update.message || key === null) {
    const accepted = await deliverImpl(update);
    if (accepted === TELEGRAM_CLOSED_SESSION_KIND) {
      logImpl(
        `dropped update ${update.update_id} for ${key ?? "unknown chat"} — the target session is closed`,
      );
      return "terminal-drop";
    }
    return accepted ? "delivered" : "rejected";
  }

  const startedAt = now();
  const baselineGeneration = statusGeneration(statusImpl(key));
  let acceptanceFailureReported = false;
  let failureNotified = false;
  const onAcceptanceFailure = async () => {
    acceptanceFailureReported = true;
    try {
      await clearFailedDirectIngress(key, {
        baselineGeneration,
        startedAt,
        statusImpl,
        setStatusIfImpl,
        deleteMessageImpl,
        now,
      });
    } catch (error) {
      logImpl(
        `direct delivery status cleanup failed for ${key}:`,
        errorMessage(error),
      );
    }

    if (failureNotified) return;
    failureNotified = true;
    try {
      await alertImpl(
        alertDataDir,
        `telegram-acceptance:${key}`,
        "message acceptance failed",
        async () => {
          await sendFailureImpl(
            key,
            trImpl(
              "Couldn't process the message - repeat it or use /new",
              "Не получилось обработать сообщение - повтори или /new",
            ),
          );
          return true;
        },
        TELEGRAM_ACCEPTANCE_ALERT_REPEAT_MS,
      );
    } catch (error) {
      logImpl(
        `direct delivery notification failed for ${key}:`,
        errorMessage(error),
      );
    }
  };

  const accepted = await deliverImpl(update, {
    onAcceptanceFailure,
    timeoutMs: DIRECT_ACCEPTANCE_TIMEOUT_MS,
    retryAcceptanceTimeout: false,
    // The durable inbox retries this path; inline retries only cover a brief startup race.
    // Before issue #212, 30 attempts could block the single-threaded loop for minutes.
    boundedAttempts: 3,
  });
  // Reply на сообщение бота, чья сессия закрыта: eve не смогла ни продолжить её, ни
  // начать новый ход. Апдейт умирает здесь — владелец снимет его с хранения, иначе
  // мост вечно перечитывает одну и ту же голову (issue #203).
  if (accepted === TELEGRAM_CLOSED_SESSION_KIND) {
    logImpl(
      `dropped update ${update.update_id} for ${key} — the target session is closed`,
    );
    if (!acceptanceFailureReported) await onAcceptanceFailure();
    return "terminal-drop";
  }
  // Defensive fallback for injected/custom deliverers and for a pacing deadline
  // that expires before fetch starts.
  if (!accepted && !acceptanceFailureReported) await onAcceptanceFailure();
  if (accepted) {
    alertResolvedImpl(alertDataDir, `telegram-acceptance:${key}`);
  }
  return accepted ? "delivered" : "rejected";
}

export type RouteMessageResult =
  | "delivered"
  | "rejected"
  | "dropped"
  | "enqueue-failed"
  | "queued"
  | "terminal-drop";

export async function routeMessageUpdate(
  update: TelegramQueueUpdate,
  {
    chatKeyImpl = chatKey,
    loadQueueImpl = () => loadQueue({ strict: true }),
    runningImpl = isRunning,
    turnPolicyImpl = telegramTurnPolicy,
    inFlight = queueInFlight,
    queueCountImpl = queueCount,
    replyToBotImpl = isReplyToBot,
    shouldQueueImpl = shouldQueueBusyUpdate,
    enqueueImpl = enqueueTelegramQueueUpdate,
    acknowledgeImpl = acknowledgeQueued,
    deliverImpl = pacedDelivery,
    statusImpl = getChatStatus,
    setStatusIfImpl = setChatStatusIf,
    sendFailureImpl = sendStaleRunNotice,
    alertImpl = alertOnce,
    alertResolvedImpl = alertResolved,
    alertDataDir = DATA_DIR,
    deleteMessageImpl = deleteStaleWorkingMessage,
    now = Date.now,
    trImpl = tr,
    allowedUserIds = ALLOWED,
    botUsername = BOT_USERNAME,
    logImpl = log,
    resetPendingImpl = hasPrivateResetIntent,
    compactingImpl = isCompacting,
  }: {
    chatKeyImpl?: (update: TelegramQueueUpdate) => string | null;
    loadQueueImpl?: () => MaybePromise<TelegramQueueDocument>;
    runningImpl?: (key: string) => boolean;
    turnPolicyImpl?: typeof telegramTurnPolicy;
    inFlight?: Map<string, QueuePhase>;
    queueCountImpl?: (queue: TelegramQueueDocument, key?: string) => number;
    replyToBotImpl?: (message: TelegramQueueMessage) => boolean;
    shouldQueueImpl?: (
      update: TelegramQueueUpdate,
      options: {
        allowedUserIds: ReadonlySet<string>;
        botUsername: unknown;
      },
    ) => boolean;
    enqueueImpl?: (
      key: string,
      candidate: TelegramQueueUpdate,
    ) => MaybePromise<{ count: number }>;
    acknowledgeImpl?: (
      update: TelegramQueueUpdate,
      count: number,
    ) => MaybePromise<unknown>;
    deliverImpl?: DeliverImpl;
    statusImpl?: StatusImpl;
    setStatusIfImpl?: SetStatusIfImpl;
    sendFailureImpl?: (key: string, text: string) => MaybePromise<unknown>;
    alertImpl?: typeof alertOnce;
    alertResolvedImpl?: typeof alertResolved;
    alertDataDir?: string;
    deleteMessageImpl?: (
      key: string,
      messageId: string | number,
    ) => MaybePromise<unknown>;
    now?: () => number;
    trImpl?: (en: string, ru: string) => string;
    allowedUserIds?: ReadonlySet<string>;
    botUsername?: unknown;
    logImpl?: (...parts: unknown[]) => void;
    resetPendingImpl?: (chatKey: string) => boolean;
    compactingImpl?: (chatKey: string) => boolean;
  } = {},
): Promise<RouteMessageResult> {
  const key = chatKeyImpl(update);
  const turnPolicy = turnPolicyImpl();
  // Remove this fence when vercel/eve#2876 is fixed in the installed eve.
  const resetPending = key !== null && resetPendingImpl(key);
  // Ответ на сообщение бота идёт мимо очереди. Пока чат занят свёрткой между ходами, и он
  // встаёт в очередь: вход сессии eve не переживает перезапуск посреди свёртки.
  if (
    update.message &&
    key !== null &&
    (resetPending || !replyToBotImpl(update.message) || compactingImpl(key))
  ) {
    const queue = await loadQueueImpl();
    const mustQueue =
      resetPending ||
      inFlight.has(key) ||
      (turnPolicy === "queue" &&
        (runningImpl(key) || queueCountImpl(queue, key) > 0));
    if (mustQueue) {
      if (!shouldQueueImpl(update, { allowedUserIds, botUsername })) {
        return "dropped";
      }
      let queued;
      try {
        queued = await enqueueImpl(key, update);
      } catch (error) {
        logImpl(
          `queue enqueue failed for update ${update.update_id}:`,
          errorMessage(error),
        );
        return "enqueue-failed";
      }
      await acknowledgeImpl(update, queued.count);
      return "queued";
    }
  }

  return deliverDirectUpdate(update, {
    key,
    deliverImpl,
    statusImpl,
    setStatusIfImpl,
    sendFailureImpl,
    alertImpl,
    alertResolvedImpl,
    alertDataDir,
    deleteMessageImpl,
    now,
    trImpl,
    logImpl,
  });
}

export async function drainReadyQueueHeads({
  loadImpl = loadQueue,
  runningImpl = isRunning,
  statusImpl = getChatStatus,
  deliverImpl = (
    update: TelegramQueueUpdate,
    { timeoutMs }: DeliverOptions = {},
  ) =>
    pacedDelivery(update, {
      route: ACCEPTANCE_ROUTE,
      acceptedStatus: 204,
      queueReceipt: true,
      retry: false,
      timeoutMs,
    }),
  acknowledgeImpl = acknowledgeTelegramQueueHead,
  legacyAllowedUserIds = ALLOWED,
  now = Date.now,
  settleUntil = queueSettleUntil,
  inFlight = queueInFlight,
  rotationState = queueDrainRotation,
  passBudgetMs = QUEUE_DRAIN_BUDGET_MS,
  deliveryTimeoutMs = QUEUE_DELIVERY_TIMEOUT_MS,
  gateWaitMs = RUN_STALE_MS,
  resetPendingImpl = hasPrivateResetIntent,
}: {
  loadImpl?: () => MaybePromise<TelegramQueueDocument>;
  runningImpl?: (key: string) => boolean;
  statusImpl?: StatusImpl;
  deliverImpl?: DeliverImpl;
  acknowledgeImpl?: (key: string, updateId: number) => MaybePromise<unknown>;
  legacyAllowedUserIds?: ReadonlySet<string>;
  now?: () => number;
  settleUntil?: Map<string, number>;
  inFlight?: Map<string, QueuePhase>;
  rotationState?: { afterKey: string | null };
  passBudgetMs?: number;
  deliveryTimeoutMs?: number;
  gateWaitMs?: number;
  resetPendingImpl?: (chatKey: string) => boolean;
} = {}) {
  const snapshot = await loadImpl();
  const keys = [...new Set([...queueKeys(snapshot), ...inFlight.keys()])];
  const previousIndex =
    rotationState.afterKey === null ? -1 : keys.indexOf(rotationState.afterKey);
  const orderedKeys =
    previousIndex < 0
      ? keys
      : [...keys.slice(previousIndex + 1), ...keys.slice(0, previousIndex + 1)];
  const deadline = now() + passBudgetMs;
  let exhausted = false;
  let lastAttempted = null;

  for (const key of orderedKeys) {
    if (now() >= deadline) {
      exhausted = true;
      break;
    }
    // Remove this fence when vercel/eve#2876 is fixed in the installed eve.
    if (resetPendingImpl(key)) continue;
    const currentStatus = statusImpl(key);
    const currentGeneration = statusGeneration(currentStatus);
    const running = runningImpl(key);
    const phase = inFlight.get(key);
    if (phase?.state === "delivering") continue;
    if (phase?.state === "awaiting-running") {
      if (running) {
        inFlight.set(key, {
          ...phase,
          state: "running",
          generation: currentGeneration,
        });
        continue;
      }
      const generationAdvanced = currentGeneration > phase.baselineGeneration;
      const waitExpired = now() - phase.acceptedAt >= gateWaitMs;
      if (!generationAdvanced && !waitExpired) continue;
      inFlight.delete(key);
    }
    if (phase?.state === "running") {
      if (running) continue;
      inFlight.delete(key);
    }
    const item = queueHead(snapshot, key);
    if (!item) continue;
    if (running || (settleUntil.get(key) ?? 0) > now()) continue;
    const update = materializeQueueItem(key, item, { legacyAllowedUserIds });
    if (!update) {
      if (!undrainableLegacyLogged.has(key)) {
        log(
          `queued legacy messages for ${key} cannot be replayed because their author is not verifiable`,
        );
        undrainableLegacyLogged.add(key);
      }
      continue;
    }
    const timeoutMs = Math.max(
      1,
      Math.min(deliveryTimeoutMs, deadline - now()),
    );
    lastAttempted = key;
    const baselineGeneration = currentGeneration;
    inFlight.set(key, { state: "delivering", baselineGeneration });
    let accepted: DeliveryResult = false;
    try {
      accepted = await deliverImpl(update, { timeoutMs });
    } catch (error) {
      log(
        `queued update ${item.updateId} delivery failed:`,
        errorMessage(error),
      );
    }
    if (!accepted) {
      inFlight.delete(key);
      continue;
    }
    if (accepted === TELEGRAM_CLOSED_SESSION_KIND) {
      // Ход не начнётся никогда: голову снимаем тем же ack, что и обработанную,
      // иначе очередь этого чата встаёт на ней навсегда (issue #203).
      log(
        `dropped queued update ${item.updateId} for ${key} — the target session is closed`,
      );
      inFlight.delete(key);
    } else if (accepted === "handled") {
      inFlight.delete(key);
    } else {
      const acceptedStatus = statusImpl(key);
      const acceptedGeneration = statusGeneration(acceptedStatus);
      if (runningImpl(key)) {
        inFlight.set(key, {
          state: "running",
          baselineGeneration,
          generation: acceptedGeneration,
        });
      } else if (acceptedGeneration > baselineGeneration) {
        // A complete running -> idle cycle happened while acceptance was pending.
        inFlight.delete(key);
      } else {
        inFlight.set(key, {
          state: "awaiting-running",
          baselineGeneration,
          acceptedAt: now(),
        });
      }
    }
    // Keep a just-accepted head until its removal is itself durable. If this write
    // fails, the next pass deliberately replays the same head (at-least-once).
    try {
      await acknowledgeImpl(key, item.updateId);
      settleUntil.set(key, now() + Math.max(SETTLE_MS, 0));
    } catch (error) {
      if (errorCode(error) === TELEGRAM_QUEUE_FATAL_DURABILITY) {
        inFlight.delete(key);
        rotationState.afterKey = null;
        throw error;
      }
      log(
        `queued update ${item.updateId} ack failed; head retained or restored:`,
        errorMessage(error),
      );
    }
  }
  rotationState.afterKey = exhausted ? lastAttempted : null;
  return queueCount(await loadImpl());
}

export { deliverDirectUpdate };
