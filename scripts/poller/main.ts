import { createHelperOutcomeScan } from "./helper-outcomes.ts";
import { fileURLToPath } from "node:url";

import { COLLECT_QUIET_MS } from "../lib/telegram-collect.ts";
import { alreadyDelivered } from "../lib/offset-store.ts";
import {
  invalidTelegramUpdatesDiagnostic,
  migrateQueueFile,
  parseTelegramUpdates,
  type TelegramQueueUpdate,
  type TelegramUpdateBatchItem,
} from "../lib/telegram-queue.ts";
import { alertOnce, alertResolved } from "../lib/notice-policy.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import { tr } from "#lib/i18n.ts";
import {
  ACCEPTANCE_ROUTE,
  DATA_DIR,
  ROUTE,
  SECRET,
  TOKEN,
  log,
  sleep,
} from "./config.ts";
import { tg } from "./transport.ts";
import { noteDroppedBridgeTasks, scheduleBridgeTask } from "./background.ts";
import { fastForwardOffset, saveOffset } from "./offset.ts";
import {
  admitTelegramUpdate,
  promoteReadyInbox,
  TELEGRAM_INBOX_FILE,
  terminalDropLine,
} from "./inbox.ts";
import {
  acquireTelegramProcessLock,
  assertTelegramProcessLease,
} from "./process-lock.ts";
import { prepareTelegramStartup } from "./startup-state.ts";
import * as queue from "./queue.ts";
import * as routing from "./routing.ts";
import * as updateFlow from "./update-flow.ts";
import * as control from "./control.ts";
import * as wizards from "./wizards.ts";

/** Sleep/alert policy for consecutive getUpdates Conflict responses. Pure, no I/O. */
export function conflictBackoff(consecutiveConflicts: number): {
  sleepMs: number;
  shouldAlert: boolean;
} {
  const sleepMs = Math.min(
    60_000,
    3_000 * 2 ** Math.max(0, consecutiveConflicts - 1),
  );
  return { sleepMs, shouldAlert: consecutiveConflicts >= 10 };
}

type ErrorLike = { message?: unknown; resetPhase?: unknown };
type TelegramResponse = {
  ok?: unknown;
  description?: string;
  result?: unknown;
};
const {
  QUEUE_FILE,
  reapStaleRuns,
  reconcileScopedResetIntents,
  retireSettledSessions,
} = queue;
const { drainReadyQueueHeads, routeMessageUpdate } = routing;
const { launchSelfUpdate, reconcileUpdateJobs, removeStaleUpdateJobs } =
  updateFlow;
const { handleControl, registerBotCommands } = control;

export { readCappedStream } from "./transport.ts";
export const loadQueue = queue.loadQueue;
export const writeQueueAtomic = queue.writeQueueAtomic;
export const completeScopedResetState = queue.completeScopedResetState;
export const persistPrivateResetIntent = queue.persistPrivateResetIntent;
export const loadPrivateResetIntents = queue.loadPrivateResetIntents;
export const clearPrivateResetIntent = queue.clearPrivateResetIntent;
export const hasPrivateResetIntent = queue.hasPrivateResetIntent;
export const releaseScopedSession = queue.releaseScopedSession;
export const performScopedReset = queue.performScopedReset;
export { reconcileScopedResetIntents, reapStaleRuns, retireSettledSessions };
export { routeMessageUpdate, drainReadyQueueHeads };
export const handleUpdateCheck = updateFlow.handleUpdateCheck;
export const handleUpdateCallback = updateFlow.handleUpdateCallback;
export const runWizardRequest = wizards.runWizardRequest;
export const isStaleWizard = wizards.isStaleWizard;
export const wizardActionAllowed = wizards.wizardActionAllowed;
export const selectWizardModel = wizards.selectWizardModel;
export const selectWizardEffort = wizards.selectWizardEffort;
export const selectableWizardOptions = wizards.selectableWizardOptions;
export const resolveThinkCatalogLoad = wizards.resolveThinkCatalogLoad;
export const validateAndSaveWizard = wizards.validateAndSaveWizard;
export const resetMessageCopy = wizards.resetMessageCopy;
export const handleAwaitNonText = control.handleAwaitNonText;

const errorMessage = (error: unknown) => (error as ErrorLike).message;
let ordinaryControlFailure:
  { updateId: number; attempts: number; released: boolean } | undefined;

export async function handleControlSafely(
  update: Parameters<typeof handleControl>[0],
  {
    handleControlImpl = handleControl,
    logImpl = log,
  }: {
    handleControlImpl?: typeof handleControl;
    logImpl?: (...args: unknown[]) => void;
  } = {},
): Promise<Awaited<ReturnType<typeof handleControl>> | "retry"> {
  try {
    const result = await handleControlImpl(update);
    if (ordinaryControlFailure?.updateId === update.update_id) {
      ordinaryControlFailure = undefined;
    }
    return result;
  } catch (error) {
    const phase = (error as ErrorLike).resetPhase;
    if (typeof phase !== "string") {
      if (ordinaryControlFailure?.updateId !== update.update_id) {
        ordinaryControlFailure = {
          updateId: update.update_id,
          attempts: 0,
          released: false,
        };
      }
      ordinaryControlFailure.attempts += 1;
      if (ordinaryControlFailure.released) return true;
      if (
        ordinaryControlFailure.attempts < queue.RESET_INTENT_ESCALATION_ATTEMPTS
      ) {
        return "retry";
      }
      ordinaryControlFailure.released = true;
      try {
        logImpl(
          `control failed ${ordinaryControlFailure.attempts} times; releasing update ${update.update_id}:`,
          errorMessage(error),
        );
      } catch {
        // Control failures must never stop the Telegram polling loop.
      }
      return true;
    }
    if (ordinaryControlFailure?.updateId === update.update_id) {
      ordinaryControlFailure = undefined;
    }
    try {
      logImpl(
        `control ${phase} failed for update ${update.update_id}:`,
        errorMessage(error),
      );
    } catch {
      // Control failures must never stop the Telegram polling loop.
    }
    return "retry";
  }
}

export async function processTelegramUpdate(
  update: Parameters<typeof handleControl>[0],
  offset: number,
  delivered: number | null,
  {
    handleControlImpl = handleControl,
    admitImpl = admitTelegramUpdate,
    saveOffsetImpl = saveOffset,
    logImpl = log,
  }: {
    handleControlImpl?: typeof handleControl;
    admitImpl?: typeof admitTelegramUpdate;
    saveOffsetImpl?: (
      offset: number,
      delivered: number | null,
    ) => Promise<void>;
    logImpl?: (...args: unknown[]) => void;
  } = {},
): Promise<{ offset: number; ingressBlocked: boolean }> {
  if (alreadyDelivered(update.update_id, delivered)) {
    logImpl(
      `skip update ${update.update_id} — already delivered before restart`,
    );
    const nextOffset = update.update_id + 1;
    await saveOffsetImpl(nextOffset, delivered);
    return { offset: nextOffset, ingressBlocked: false };
  }
  const controlResult = await handleControlSafely(update, {
    handleControlImpl,
    logImpl,
  });
  if (controlResult === "retry") {
    return { offset, ingressBlocked: true };
  }
  if (controlResult) {
    const nextOffset = update.update_id + 1;
    await saveOffsetImpl(nextOffset, delivered);
    return { offset: nextOffset, ingressBlocked: false };
  }
  const admitted = await admitImpl(update);
  // write-failed транзиентен: диск может ожить, повтор обязателен и вход ждёт.
  if (admitted === "write-failed") {
    return { offset, ingressBlocked: true };
  }
  // unownable структурен и постоянен: повтор не сделает апдейт опознаваемым, а
  // задержанный offset крутит один и тот же батч вечно. Подтверждаем и идём дальше;
  // строка в журнале называет update_id и причину.
  if (admitted === "unownable") {
    logImpl(`update ${update.update_id} has no durable ingress key`);
  }
  const nextOffset = update.update_id + 1;
  if (admitted === "terminal-drop") {
    logImpl(terminalDropLine(update));
  }
  await saveOffsetImpl(nextOffset, delivered);
  return { offset: nextOffset, ingressBlocked: false };
}

// Пачка getUpdates по порядку. Апдейт, не прошедший проверку, подтверждается сдвигом offset
// и одной строкой журнала: повтор не сделает его понятным, а задержанный offset держит весь
// вход (16.10.2026, c1: стоп черновика крутил пачку три минуты). Без update_id сдвигать
// нечего — offset сдвинут следующие апдейты пачки.
export async function processTelegramBatch(
  items: readonly TelegramUpdateBatchItem[],
  offset: number,
  delivered: number | null,
  {
    processImpl = processTelegramUpdate,
    saveOffsetImpl = saveOffset,
    logImpl = log,
  }: {
    processImpl?: (
      update: TelegramQueueUpdate,
      offset: number,
      delivered: number | null,
    ) => Promise<{ offset: number; ingressBlocked: boolean }>;
    saveOffsetImpl?: (
      offset: number,
      delivered: number | null,
    ) => Promise<void>;
    logImpl?: (...args: unknown[]) => void;
  } = {},
): Promise<{ offset: number; ingressBlocked: boolean }> {
  let current = offset;
  for (const item of items) {
    if ("update" in item) {
      const processed = await processImpl(item.update, current, delivered);
      current = processed.offset;
      if (processed.ingressBlocked)
        return { offset: current, ingressBlocked: true };
      continue;
    }
    logImpl("getUpdates: skipped invalid update", JSON.stringify(item.skipped));
    if (item.updateId === null || item.updateId < current) continue;
    current = item.updateId + 1;
    await saveOffsetImpl(current, delivered);
  }
  return { offset: current, ingressBlocked: false };
}

async function reconcileResetIntentsSafely(): Promise<number> {
  try {
    return await reconcileScopedResetIntents();
  } catch (error) {
    try {
      log("reset intent scan failed:", errorMessage(error));
    } catch {
      // Reconciliation failures must never stop the Telegram polling loop.
    }
    return 0;
  }
}

// Сверка интентов сброса — фоновая задача моста из общего слота (background.ts): приём один
// на всех, второй такой же ключ во время работы получает false.
export function scheduleResetIntentReconciliation({
  reconcileImpl = reconcileResetIntentsSafely,
  logImpl = log,
}: {
  reconcileImpl?: () => Promise<number>;
  logImpl?: (...args: unknown[]) => void;
} = {}): boolean {
  return scheduleBridgeTask(
    "reset-intents",
    async () => {
      const count = await reconcileImpl();
      if (count > 0) {
        logImpl(`reconciled ${count} durable private Telegram reset intent(s)`);
      }
    },
    { logImpl },
  );
}

async function deleteWebhookOrThrow(
  dropPendingUpdates: boolean,
): Promise<void> {
  const response = (await tg("deleteWebhook", {
    drop_pending_updates: dropPendingUpdates,
  })) as TelegramResponse;
  if (response.ok !== true) {
    throw new Error(
      `deleteWebhook failed: ${response.description ?? "Telegram returned ok:false"}`,
    );
  }
  log("deleteWebhook:", `ok (drop_pending=${dropPendingUpdates})`);
}

const rawCollectQuietMs = Number(
  process.env.TELEGRAM_COLLECT_QUIET_MS ?? COLLECT_QUIET_MS,
);
const configuredCollectQuietMs =
  Number.isFinite(rawCollectQuietMs) && rawCollectQuietMs >= 0
    ? rawCollectQuietMs
    : COLLECT_QUIET_MS;

export async function main({
  acquireProcessLockImpl = acquireTelegramProcessLock,
}: {
  /** Test seam; the production entrypoint always uses the uid-global lease. */
  acquireProcessLockImpl?: typeof acquireTelegramProcessLock;
} = {}) {
  if (!TOKEN)
    throw new Error("no TELEGRAM_BOT_TOKEN in .env — nothing to poll");
  if (!SECRET)
    throw new Error(
      "no TELEGRAM_WEBHOOK_SECRET_TOKEN — the channel won't accept updates",
    );
  // The kernel-held lease is the first startup side effect. Reconciliation below
  // can call Bot API, so no weaker in-process flag can guard this boundary.
  const processLease = await acquireProcessLockImpl();
  const startup = await prepareTelegramStartup(processLease);
  log(`telegram-poll start → messages ${ACCEPTANCE_ROUTE}; callbacks ${ROUTE}`);
  await removeStaleUpdateJobs();
  // The update that restarted this bridge left its final screen to us: its own
  // process died with the restart. Delivered before the first poll; the jobs with
  // nothing to say yet are watched beside it.
  const watched = await reconcileUpdateJobs({ launchImpl: launchSelfUpdate });
  if (watched.length > 0)
    log(`watching ${watched.length} unfinished update job(s)`);
  // Upgrade the old {chatKey: string[]} queue atomically before polling. A failed
  // migration stops the bridge, so Telegram retains new updates until the old bytes
  // are safely represented as versioned FIFO items.
  await migrateQueueFile(QUEUE_FILE, {
    strict: true,
    onLegacyQuarantine: (path) =>
      log(
        `legacy Telegram group messages moved to ${path}; sender identity was unavailable`,
      ),
  });
  await migrateQueueFile(TELEGRAM_INBOX_FILE, { strict: true });
  const reconciledResets = await reconcileResetIntentsSafely();
  if (reconciledResets > 0) {
    log(
      `reconciled ${reconciledResets} durable private Telegram reset intent(s)`,
    );
  }
  // Читаем offset ДО любого destructive Telegram-вызова: EACCES/EIO/битый JSON
  // останавливают мост, пока backlog ещё цел. Только подтверждённый ENOENT означает
  // first run и разрешает drop_pending=true.
  let offset = startup.offset ?? 0;
  const { delivered } = startup;
  // First run (no offset file) — drop the accumulated install backlog (drop_pending=true),
  // so old messages don't replay in a batch → parallel sessions on one chat (HookConflict).
  // On subsequent starts we do NOT drop the backlog (don't lose messages that arrived while the bridge was down).
  const firstRun = startup.firstRun;
  await deleteWebhookOrThrow(firstRun);
  await registerBotCommands();

  if (firstRun) {
    offset = await fastForwardOffset();
    log("first run — offset past the tail of the queue:", offset);
    await saveOffset(offset);
  } else {
    log("starting offset:", offset);
  }

  const scanHelperOutcomes = createHelperOutcomeScan();
  let consecutiveConflicts = 0;
  for (;;) {
    assertTelegramProcessLease(processLease);
    // One batch per idle chat/topic per pass. While any queue remains, use a short
    // Telegram long-poll so terminal/stale run-status changes trigger drain quickly.
    scheduleResetIntentReconciliation();
    try {
      await scanHelperOutcomes();
    } catch (error) {
      log("helper outcome:", errorMessage(error));
    }
    try {
      await retireSettledSessions();
    } catch (error) {
      log("session retirement failed:", errorMessage(error));
    }
    try {
      await reapStaleRuns();
    } catch (error) {
      log("stale run reaper failed:", errorMessage(error));
    }
    const pendingInboxCount = await promoteReadyInbox({
      collectorOptions: { quietMs: configuredCollectQuietMs },
    });
    const pendingQueueCount = await drainReadyQueueHeads();
    const pollSeconds = pendingQueueCount > 0 || pendingInboxCount > 0 ? 1 : 30;
    let data: TelegramResponse;
    try {
      data = (await tg(
        "getUpdates",
        {
          offset,
          timeout: pollSeconds,
          allowed_updates: [
            "message",
            "callback_query",
            "stopped_message_generation",
          ],
        },
        { timeoutMs: pollSeconds > 1 ? 40_000 : 10_000 },
      )) as TelegramResponse;
    } catch (error) {
      log("getUpdates network:", errorMessage(error));
      consecutiveConflicts = 0;
      await sleep(3000);
      continue;
    }
    if (!data.ok) {
      log("getUpdates:", data.description);
      // 409/conflict — a webhook is left somewhere; remove it and try again.
      if (/409|conflict|webhook/i.test(String(data.description || ""))) {
        consecutiveConflicts += 1;
        const { sleepMs, shouldAlert } = conflictBackoff(consecutiveConflicts);
        await deleteWebhookOrThrow(false);
        if (shouldAlert) {
          try {
            await alertOnce(
              DATA_DIR,
              "getupdates-conflict",
              "telegram getUpdates conflict",
              async () => {
                const chat = notificationChat();
                if (!chat) return false;
                const res = (await tg("sendMessage", {
                  chat_id: chat,
                  text: tr(
                    "Receiving messages has stopped: another bot instance is holding this token. Stop the other instance.",
                    "Приём сообщений остановлен: другой инстанс бота держит этот токен — останови его.",
                  ),
                })) as TelegramResponse;
                return Boolean(res.ok);
              },
            );
          } catch (error) {
            log("getUpdates conflict alert:", errorMessage(error));
          }
        }
        await sleep(sleepMs);
        continue;
      }
      consecutiveConflicts = 0;
      await sleep(3000);
      continue;
    }
    if (consecutiveConflicts > 0) {
      consecutiveConflicts = 0;
      alertResolved(DATA_DIR, "getupdates-conflict");
    }
    const items = parseTelegramUpdates(data.result);
    if (items === null) {
      log(
        "getUpdates: invalid result",
        JSON.stringify(invalidTelegramUpdatesDiagnostic(data.result)),
      );
      await sleep(3000);
      continue;
    }
    const batch = await processTelegramBatch(items, offset, delivered);
    offset = batch.offset;
    if (batch.ingressBlocked) await sleep(3000);
  }
}

export function runEntrypoint(
  moduleUrl: string,
  executedPath: string | undefined = process.argv[1],
): void {
  if (fileURLToPath(moduleUrl) !== executedPath) return;
  // У остановки моста нет своего пути завершения: задачи в полёте умирают вместе с процессом.
  // Скажем об этом в журнал и пропустим сигнал дальше — обработчик снят, и повторный SIGTERM
  // убивает процесс как раньше, иначе systemd ждал бы нас до SIGKILL.
  process.once("SIGTERM", () => {
    noteDroppedBridgeTasks({ logImpl: log });
    process.kill(process.pid, "SIGTERM");
  });
  void main().catch((error: unknown) => {
    console.error("telegram-poll fatal:", error);
    process.exit(1);
  });
}
