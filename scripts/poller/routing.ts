import {
  isReplyToBot,
  materializeQueueItem,
  queueCount,
  queueHead,
  queueKeys,
  quarantineQueueRecords,
  type DamagedQueueRecord,
  shouldQueueBusyUpdate,
  TELEGRAM_QUEUE_FATAL_DURABILITY,
} from "../lib/telegram-queue.ts";
import type {
  TelegramQueueDocument,
  TelegramQueueMessage,
  TelegramQueueUpdate,
} from "../lib/telegram-queue.ts";
import { join } from "node:path";
import { joinUpdates, queueBatchLength } from "../lib/telegram-collect.ts";
import {
  chatBusy,
  chatHeld,
  chatState,
  getChatStatus,
  isRunning,
  listChatStatuses,
  RUN_STALE_MS,
  setChatStatusIf,
  type ChatRecord,
  type ChatRecordExpected,
  type ChatRecordPatch,
} from "#lib/run-status.ts";
import { isColleaguesEnabled } from "#lib/colleagues.ts";
import {
  botIdFromUpdate,
  configuredTelegramBotIds,
  groupCoordKeyOf,
  resolveTelegramBot,
} from "../../packages/telegram-bots/index.ts";
import { tr } from "#lib/i18n.ts";
import { traceBridgeQueued } from "#lib/trace.ts";
import {
  TELEGRAM_CLOSED_SESSION_KIND,
  telegramTurnPolicy,
} from "#lib/telegram-acceptance-wire.ts";
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
  acknowledgeTelegramQueueItems,
  acknowledgeQueued,
  chatResetInFlight,
  clearFailedDirectIngress,
  enqueueTelegramQueueUpdate,
  hasPrivateResetIntent,
  loadQueue,
  QUEUE_DELIVERY_TIMEOUT_MS,
  QUEUE_DRAIN_BUDGET_MS,
  queueBatchPins,
  queueDrainRotation,
  queueInFlight,
  queueSettleUntil,
  sendStaleRunNotice,
  statusGeneration,
} from "./queue.ts";
import type { QueuePhase } from "./queue.ts";
import { alertOnce, alertResolved } from "../lib/notice-policy.ts";

type MaybePromise<T> = T | Promise<T>;
type ErrorLike = { code?: unknown; message?: unknown };
type Status = ChatRecord;
type DeliveryResult = Awaited<ReturnType<typeof pacedDeliver>>;
type DeliverImpl = (
  update: TelegramQueueUpdate,
  options?: DeliverOptions,
) => MaybePromise<DeliveryResult>;
type StatusImpl = (key: string) => Status | null;
type ListStatusesImpl = () => ReadonlyArray<{
  readonly chatKey: string;
  readonly status: Status;
}>;

/**
 * Проверяет, держит ли сейчас другой бот активный ход или доставку в той же группе
 * (`specs/GroupAndAssignments.tla`: SingleActiveGroupBot).
 * Личные чаты (`groupCoordKeyOf(key) === null`) между ботами никогда не пересекаются.
 */
export function isOtherBotGroupBusy(
  key: string,
  inFlight: ReadonlyMap<string, QueuePhase>,
  listStatusesImpl: ListStatusesImpl = listChatStatuses,
): boolean {
  const groupKey = groupCoordKeyOf(key);
  if (groupKey === null) return false;
  for (const activeKey of inFlight.keys()) {
    if (activeKey !== key && groupCoordKeyOf(activeKey) === groupKey) {
      return true;
    }
  }
  for (const record of listStatusesImpl()) {
    if (
      record.chatKey !== key &&
      groupCoordKeyOf(record.chatKey) === groupKey &&
      chatHeld(chatState(record.status))
    ) {
      return true;
    }
  }
  return false;
}
type SetStatusIfImpl = (
  key: string,
  expected: ChatRecordExpected,
  patch: ChatRecordPatch,
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

// Дубль после обрыва уже в очереди: время постановки не переписываем, сбой Trace молчит.
// Причина — словом: чем занят чат (состояние записи) или что стоит перед сообщением.
function traceQueued(
  update: TelegramQueueUpdate,
  queued: { count: number; added?: boolean },
  reason: string,
  logImpl: (...parts: unknown[]) => void,
  traceImpl: (
    update: TelegramQueueUpdate,
    count: number,
    reason: string,
  ) => void = traceBridgeQueued,
) {
  if (queued.added === false) return;
  logImpl(`queued update ${update.update_id}: ${reason}`);
  try {
    traceImpl(update, queued.count, reason);
  } catch (error) {
    logImpl(`queue trace failed for ${update.update_id}:`, errorMessage(error));
  }
}

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
    enqueueImpl = (
      key: string,
      candidate: TelegramQueueUpdate,
      enqueuedAt?: number,
      resetFence?: number | null,
    ) => enqueueTelegramQueueUpdate(key, candidate, enqueuedAt, { resetFence }),
    arrivedAt,
    resetFence,
    acknowledgeImpl = acknowledgeQueued,
    traceQueuedImpl,
    deliverImpl = pacedDelivery,
    statusImpl = getChatStatus,
    listStatusesImpl = listChatStatuses,
    setStatusIfImpl = setChatStatusIf,
    sendFailureImpl = sendStaleRunNotice,
    alertImpl = alertOnce,
    alertResolvedImpl = alertResolved,
    alertDataDir = DATA_DIR,
    now = Date.now,
    trImpl = tr,
    allowedUserIds = ALLOWED,
    botUsername = BOT_USERNAME,
    colleaguesEnabledImpl = () =>
      isColleaguesEnabled(join(DATA_DIR, "settings.json")),
    peerBotIdsImpl = () => configuredTelegramBotIds(),
    logImpl = log,
    resetPendingImpl = hasPrivateResetIntent,
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
        colleaguesEnabled?: boolean;
        peerBotIds?: ReadonlySet<string>;
        receiverBotId?: string | null;
      },
    ) => boolean;
    enqueueImpl?: (
      key: string,
      candidate: TelegramQueueUpdate,
      enqueuedAt?: number,
      resetFence?: number | null,
    ) => MaybePromise<{ count: number; added?: boolean }>;
    // Время постановки во входящие inbox: элемент очереди хранит прибытие, а не
    // промоут, чтобы отсечка сброса по времени видела сообщения до /new.
    arrivedAt?: number;
    // Эпоха сброса durable-inbox записи (null — записи без пометки): очередь
    // хранит эпоху приёма, а не эпоху на момент промоута.
    resetFence?: number | null;
    acknowledgeImpl?: (
      update: TelegramQueueUpdate,
      count: number,
    ) => MaybePromise<unknown>;
    traceQueuedImpl?: (
      update: TelegramQueueUpdate,
      count: number,
      reason: string,
    ) => void;
    deliverImpl?: DeliverImpl;
    statusImpl?: StatusImpl;
    listStatusesImpl?: ListStatusesImpl;
    setStatusIfImpl?: SetStatusIfImpl;
    sendFailureImpl?: (key: string, text: string) => MaybePromise<unknown>;
    alertImpl?: typeof alertOnce;
    alertResolvedImpl?: typeof alertResolved;
    alertDataDir?: string;
    now?: () => number;
    trImpl?: (en: string, ru: string) => string;
    allowedUserIds?: ReadonlySet<string>;
    botUsername?: unknown;
    colleaguesEnabledImpl?: () => boolean;
    peerBotIdsImpl?: () => ReadonlySet<string>;
    logImpl?: (...parts: unknown[]) => void;
    resetPendingImpl?: (chatKey: string) => boolean;
  } = {},
): Promise<RouteMessageResult> {
  const key = chatKeyImpl(update);
  const turnPolicy = turnPolicyImpl();
  const colleaguesEnabled = colleaguesEnabledImpl();
  // Remove this fence when vercel/eve#2876 is fixed in the installed eve.
  const resetPending = key !== null && resetPendingImpl(key);
  const otherBotGroupBusy =
    key !== null && isOtherBotGroupBusy(key, inFlight, listStatusesImpl);
  // Ответ на сообщение бота идёт мимо очереди, кроме ожидания сброса или занятой группы.
  if (
    update.message &&
    key !== null &&
    (resetPending || otherBotGroupBusy || !replyToBotImpl(update.message))
  ) {
    const queue = await loadQueueImpl();
    // Прямая доставка не обгоняет очередь чата (specs/QueueDrain.tla, свидетель -switch)
    // и не стартует второй бот в той же группе одновременно (specs/GroupAndAssignments.tla).
    const mustQueue =
      resetPending ||
      otherBotGroupBusy ||
      inFlight.has(key) ||
      queueCountImpl(queue, key) > 0 ||
      (turnPolicy === "queue" && runningImpl(key));
    if (mustQueue) {
      const receiverBotId =
        botIdFromUpdate(update) ?? resolveTelegramBot(null)?.botId ?? null;
      const shouldQueueOptions = colleaguesEnabled
        ? {
            allowedUserIds,
            botUsername,
            colleaguesEnabled: true,
            peerBotIds: peerBotIdsImpl(),
            receiverBotId,
          }
        : { allowedUserIds, botUsername };
      if (!shouldQueueImpl(update, shouldQueueOptions)) {
        return "dropped";
      }
      let queued;
      try {
        queued = await enqueueImpl(key, update, arrivedAt, resetFence);
      } catch (error) {
        logImpl(
          `queue enqueue failed for update ${update.update_id}:`,
          errorMessage(error),
        );
        return "enqueue-failed";
      }
      const state = chatState(statusImpl(key));
      traceQueued(
        update,
        queued,
        resetPending
          ? "reset pending"
          : otherBotGroupBusy
            ? "group busy: another bot"
            : chatBusy(state)
              ? `chat busy: ${state}`
              : "earlier messages wait",
        logImpl,
        traceQueuedImpl,
      );
      // В группе при ожидании хода другого бота (или при включённых коллегах, где бот
      // может решить промолчать) не шлём шумное «В очереди: N» в общий чат.
      const silentGroupQueue =
        otherBotGroupBusy ||
        (colleaguesEnabled && groupCoordKeyOf(key) !== null);
      if (!silentGroupQueue) {
        await acknowledgeImpl(update, queued.count);
      }
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
    now,
    trImpl,
    logImpl,
  });
}

// Пачка с головы очереди: закреп (queueBatchPins), пока его id с головы, иначе queueBatchLength.
// Закреп — одна доставка: остаток, который сброс /new оставил от неё (id не обязаны
// расти), идёт под её же update_id, и ledger eve ответит handled, а не вторым ходом.
function queueBatch(
  snapshot: TelegramQueueDocument,
  key: string,
  head: TelegramQueueUpdate,
  pins: Map<string, readonly number[]>,
) {
  const items = snapshot.queues[key];
  const end = items.findIndex((item, index) => index > 0 && !item.update);
  const replayable = end < 0 ? items : items.slice(0, end);
  let pin = pins.get(key) ?? [];
  let count = replayable.findIndex((item) => !pin.includes(item.updateId));
  if (count < 0) count = replayable.length;
  if (count === 0) {
    const rest = replayable.slice(1).flatMap((item) => item.update ?? []);
    count = queueBatchLength([head, ...rest]);
    pin = replayable.slice(0, count).map((item) => item.updateId);
    pins.set(key, pin);
  }
  const batch = replayable.slice(0, count);
  const copies = batch
    .slice(1)
    .flatMap((item) => materializeQueueItem(key, item) ?? []);
  const update = joinUpdates([head, ...copies]);
  const updateId = pin[pin.length - 1];
  return {
    updateIds: batch.map((item) => item.updateId),
    update:
      update.update_id === updateId
        ? update
        : { ...update, update_id: updateId },
  };
}

export async function drainReadyQueueHeads({
  loadImpl = loadQueue,
  runningImpl = isRunning,
  statusImpl = getChatStatus,
  listStatusesImpl = listChatStatuses,
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
  acknowledgeImpl = acknowledgeTelegramQueueItems,
  legacyAllowedUserIds = ALLOWED,
  now = Date.now,
  settleUntil = queueSettleUntil,
  inFlight = queueInFlight,
  pins = queueBatchPins,
  rotationState = queueDrainRotation,
  passBudgetMs = QUEUE_DRAIN_BUDGET_MS,
  deliveryTimeoutMs = QUEUE_DELIVERY_TIMEOUT_MS,
  gateWaitMs = RUN_STALE_MS,
  resetPendingImpl = hasPrivateResetIntent,
  quarantineImpl = (records: readonly DamagedQueueRecord[]) =>
    quarantineQueueRecords(join(DATA_DIR, "telegram-queue.json"), records, {
      logImpl: log,
    }),
  resetBusyImpl = chatResetInFlight,
}: {
  loadImpl?: () => MaybePromise<TelegramQueueDocument>;
  runningImpl?: (key: string) => boolean;
  statusImpl?: StatusImpl;
  listStatusesImpl?: ListStatusesImpl;
  deliverImpl?: DeliverImpl;
  acknowledgeImpl?: (
    key: string,
    updateIds: readonly number[],
  ) => MaybePromise<unknown>;
  legacyAllowedUserIds?: ReadonlySet<string>;
  now?: () => number;
  settleUntil?: Map<string, number>;
  inFlight?: Map<string, QueuePhase>;
  pins?: Map<string, readonly number[]>;
  rotationState?: { afterKey: string | null };
  passBudgetMs?: number;
  deliveryTimeoutMs?: number;
  gateWaitMs?: number;
  resetPendingImpl?: (chatKey: string) => boolean;
  quarantineImpl?: (
    records: readonly DamagedQueueRecord[],
  ) => MaybePromise<unknown>;
  resetBusyImpl?: (chatKey: string) => boolean;
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
    // Сброс чата держит его очередь сброса: доставка ждёт своей следующей пачки.
    if (resetPendingImpl(key) || resetBusyImpl(key)) continue;
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
    if (
      running ||
      (settleUntil.get(key) ?? 0) > now() ||
      isOtherBotGroupBusy(key, inFlight, listStatusesImpl)
    ) {
      continue;
    }
    const head = materializeQueueItem(key, item, { legacyAllowedUserIds });
    if (!head) {
      try {
        await quarantineImpl([
          {
            chatKey: key,
            index: 0,
            reason: "unreplayable queue head",
            record: item,
          },
        ]);
      } catch (error) {
        log("queue head quarantine failed:", key, errorCode(error));
        continue;
      }
      await acknowledgeImpl(key, [item.updateId]);
      pins.delete(key);
      continue;
    }
    const { updateIds, update } = queueBatch(snapshot, key, head, pins);
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
        `queued updates ${updateIds.join(",")} delivery failed:`,
        errorMessage(error),
      );
    }
    if (!accepted) {
      inFlight.delete(key);
      continue;
    }
    if (accepted === TELEGRAM_CLOSED_SESSION_KIND) {
      // Ход не начнётся никогда: пачку (ответ боту всегда один в ней) снимаем тем же
      // ack, что и обработанную, иначе очередь чата встаёт на ней навсегда (issue #203).
      log(
        `dropped queued updates ${updateIds.join(",")} for ${key} — the target session is closed`,
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
    // Keep a just-accepted batch pinned until its removal is itself durable. If this
    // write fails, the next pass deliberately replays the same batch (at-least-once).
    try {
      await acknowledgeImpl(key, updateIds);
      pins.delete(key);
      settleUntil.set(key, now() + Math.max(SETTLE_MS, 0));
    } catch (error) {
      if (errorCode(error) === TELEGRAM_QUEUE_FATAL_DURABILITY) {
        inFlight.delete(key);
        pins.delete(key);
        rotationState.afterKey = null;
        throw error;
      }
      log(
        `queued updates ${updateIds.join(",")} ack failed; batch retained or restored:`,
        errorMessage(error),
      );
    }
  }
  rotationState.afterKey = exhausted ? lastAttempted : null;
  return queueCount(await loadImpl());
}

export { deliverDirectUpdate };
