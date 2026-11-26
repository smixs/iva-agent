import { reconcileDeferred } from "../lib/deferred-command.ts";
import { chatHeld, chatState, listChatStatuses } from "#lib/run-status.ts";
import { launchIvaCommand } from "./update-flow.ts";
import { real } from "../lib/version-layout.ts";
import { createHelperOutcomeScan } from "./helper-outcomes.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isColleaguesEnabled } from "#lib/colleagues.ts";

import { COLLECT_QUIET_MS } from "../lib/telegram-collect.ts";
import {
  invalidTelegramUpdatesDiagnostic,
  loadQueueFile,
  parseTelegramUpdates,
  type TelegramQueueUpdate,
  type TelegramUpdateBatchItem,
} from "../lib/telegram-queue.ts";
import { alertOnce, alertResolved } from "../lib/notice-policy.ts";
import { notificationChat } from "../../packages/notification-chat/index.ts";
import { redactSecretValues } from "../../packages/secret-redaction/index.ts";
import { tr } from "#lib/i18n.ts";
import {
  ACCEPTANCE_ROUTE,
  BOTS,
  DATA_DIR,
  ENV_PATH,
  ROUTE,
  SECRET,
  TOKEN,
  botOffsetFile,
  log,
  sleep,
} from "./config.ts";
import { tg, reply } from "./transport.ts";
import { noteDroppedBridgeTasks, scheduleBridgeTask } from "./background.ts";
import { fastForwardOffset, loadOffset, saveOffset } from "./offset.ts";
import {
  admitTelegramUpdate,
  promoteReadyInbox,
  TELEGRAM_INBOX_FILE,
  terminalDropLine,
} from "./inbox.ts";
import {
  acquireTelegramProcessLock,
  assertTelegramProcessLease,
  type TelegramProcessLease,
} from "./process-lock.ts";
import {
  configuredTelegramBots,
  liveTelegramEnv,
  tagUpdateWithBot,
  type TelegramBotConfig,
} from "../../packages/telegram-bots/index.ts";
import { prepareTelegramStartup } from "./startup-state.ts";
import {
  handleManagedBotUpdate,
  reconcilePendingColleagueAvatars,
} from "./managed-bot.ts";
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
export const clearChatQueue = queue.clearChatQueue;
export const persistPrivateResetIntent = queue.persistPrivateResetIntent;
export const loadPrivateResetIntents = queue.loadPrivateResetIntents;
export const clearPrivateResetIntent = queue.clearPrivateResetIntent;
export const hasPrivateResetIntent = queue.hasPrivateResetIntent;
export const resetEpochFor = queue.resetEpochFor;
export const privateResetIntentPhase = queue.privateResetIntentPhase;
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

function redactBotLogText(text: unknown, bot: TelegramBotConfig): string {
  const secrets = new Set(
    configuredTelegramBots(
      liveTelegramEnv(
        process.env,
        process.env.IVA_ENV_FILE?.trim() || ENV_PATH,
      ),
    ).map(
      (configured) => configured.token,
    ),
  );
  secrets.add(bot.token);
  const raw = typeof text === "string" ? text : "";
  return redactSecretValues(raw, [...secrets]);
}

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
  {
    handleControlImpl = handleControl,
    admitImpl = admitTelegramUpdate,
    saveOffsetImpl = saveOffset,
    logImpl = log,
  }: {
    handleControlImpl?: typeof handleControl;
    admitImpl?: typeof admitTelegramUpdate;
    saveOffsetImpl?: (offset: number) => Promise<void>;
    logImpl?: (...args: unknown[]) => void;
  } = {},
): Promise<{ offset: number; ingressBlocked: boolean }> {
  const controlResult = await handleControlSafely(update, {
    handleControlImpl,
    logImpl,
  });
  if (controlResult === "retry") {
    return { offset, ingressBlocked: true };
  }
  if (controlResult) {
    const nextOffset = update.update_id + 1;
    await saveOffsetImpl(nextOffset);
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
  await saveOffsetImpl(nextOffset);
  return { offset: nextOffset, ingressBlocked: false };
}

// Пачка getUpdates по порядку. Апдейт, не прошедший проверку, подтверждается сдвигом offset
// и одной строкой журнала: повтор не сделает его понятным, а задержанный offset держит весь
// вход (16.10.2026, c1: стоп черновика крутил пачку три минуты). Без update_id сдвигать
// нечего — offset сдвинут следующие апдейты пачки.
export async function processTelegramBatch(
  items: readonly TelegramUpdateBatchItem[],
  offset: number,
  {
    processImpl = processTelegramUpdate,
    saveOffsetImpl = saveOffset,
    logImpl = log,
  }: {
    processImpl?: (
      update: TelegramQueueUpdate,
      offset: number,
    ) => Promise<{ offset: number; ingressBlocked: boolean }>;
    saveOffsetImpl?: (offset: number) => Promise<void>;
    logImpl?: (...args: unknown[]) => void;
  } = {},
): Promise<{ offset: number; ingressBlocked: boolean }> {
  let current = offset;
  for (const item of items) {
    if ("update" in item) {
      const processed = await processImpl(item.update, current);
      current = processed.offset;
      if (processed.ingressBlocked)
        return { offset: current, ingressBlocked: true };
      continue;
    }
    logImpl("getUpdates: skipped invalid update", JSON.stringify(item.skipped));
    if (item.updateId === null || item.updateId < current) continue;
    current = item.updateId + 1;
    await saveOffsetImpl(current);
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
  {
    token,
    tgImpl,
    logImpl = log,
  }: {
    token?: string;
    tgImpl?: (
      method: string,
      body: unknown,
      options?: { timeoutMs?: number; token?: string },
    ) => Promise<unknown>;
    logImpl?: (...args: unknown[]) => void;
  } = {},
): Promise<void> {
  const call = tgImpl ?? tg;
  const response = (await call(
    "deleteWebhook",
    { drop_pending_updates: dropPendingUpdates },
    token ? { token } : undefined,
  )) as TelegramResponse;
  if (response.ok !== true) {
    throw new Error(
      `deleteWebhook failed: ${response.description ?? "Telegram returned ok:false"}`,
    );
  }
  logImpl("deleteWebhook:", `ok (drop_pending=${dropPendingUpdates})`);
}

const COLLEAGUE_ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "stopped_message_generation",
] as const;

const PRIMARY_ALLOWED_UPDATES = [
  ...COLLEAGUE_ALLOWED_UPDATES,
  "managed_bot",
] as const;

export type BotPollLoopOptions = {
  readonly bot: TelegramBotConfig;
  readonly initialOffset: number;
  readonly assertLease: () => void;
  readonly tgImpl?: (
    method: string,
    body: unknown,
    options?: { timeoutMs?: number; token?: string },
  ) => Promise<unknown>;
  readonly pollTimeoutSeconds?: () => number;
  readonly processUpdateImpl?: (
    update: TelegramQueueUpdate,
    offset: number,
  ) => Promise<{ offset: number; ingressBlocked: boolean }>;
  readonly handleControlImpl?: typeof handleControl;
  readonly saveOffsetImpl?: (offset: number) => Promise<void>;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly onUpdates?: () => void;
  readonly onConflictAlert?: (bot: TelegramBotConfig) => Promise<boolean>;
  readonly alertResolvedImpl?: (bot: TelegramBotConfig) => void;
  readonly colleaguesEnabledImpl?: () => boolean;
  /** Lazy per-bot startup for colleagues: runs only after the option is enabled, never while it is off. */
  readonly initializeOffsetImpl?: () => Promise<number>;
  readonly shouldContinue?: () => boolean;
  readonly logImpl?: (...args: unknown[]) => void;
};

/**
 * Независимый цикл long-polling для одного бота внутри общего процесса Bridge (ADR-0030).
 * Каждый бот держит собственный offset и backoff: зависание или 409-конфликт одного бота
 * не задерживают опрос и приём обновлений другого.
 */
export async function runBotPollLoop({
  bot,
  initialOffset,
  assertLease,
  tgImpl = tg,
  pollTimeoutSeconds = () => 30,
  processUpdateImpl,
  handleControlImpl = handleControl,
  saveOffsetImpl,
  sleepImpl = sleep,
  onUpdates,
  onConflictAlert,
  alertResolvedImpl,
  colleaguesEnabledImpl = () =>
    isColleaguesEnabled(join(DATA_DIR, "settings.json")),
  initializeOffsetImpl,
  shouldContinue = () => true,
  logImpl = log,
}: BotPollLoopOptions): Promise<{ offset: number }> {
  const label = bot.isPrimary ? "iva" : `bot:${bot.botId ?? "unknown"}`;
  const offsetFile = botOffsetFile(bot);
  const persistOffset =
    saveOffsetImpl ??
    ((nextOffset: number) => saveOffset(nextOffset, { file: offsetFile }));
  const processOne =
    processUpdateImpl ??
    ((update: TelegramQueueUpdate, currentOffset: number) => {
      const tagged = tagUpdateWithBot(update, bot);
      return processTelegramUpdate(tagged, currentOffset, {
        handleControlImpl: bot.isPrimary
          ? handleControlImpl
          : () => Promise.resolve(false),
        admitImpl: (candidate) =>
          admitTelegramUpdate(candidate, { bot, colleaguesEnabledImpl }),
        saveOffsetImpl: persistOffset,
        logImpl,
      });
    });

  let offset = initialOffset;
  let initializeOffset = initializeOffsetImpl;
  let consecutiveConflicts = 0;

  while (shouldContinue()) {
    assertLease();
    if (!bot.isPrimary && !colleaguesEnabledImpl()) {
      await sleepImpl(3000);
      continue;
    }
    if (initializeOffset !== undefined) {
      try {
        offset = await initializeOffset();
        initializeOffset = undefined;
      } catch (error) {
        // A lost lease is fatal for the whole bridge; a bad or unreachable colleague
        // token must only retry this colleague and must not stop Iva's own polling.
        assertLease();
        logImpl(`[${label}] offset init:`, errorMessage(error));
        await sleepImpl(3000);
        continue;
      }
      // Initialization awaits webhook/offset I/O. The lease may have closed in that
      // window, so the first getUpdates needs a fresh lease check after the await.
      assertLease();
      // The owner may have switched the option back off while webhook/offset
      // initialization was in flight; the gate is checked again before the first poll.
      if (!bot.isPrimary && !colleaguesEnabledImpl()) continue;
    }
    const pollSeconds = pollTimeoutSeconds();
    let data: TelegramResponse;
    try {
      data = (await tgImpl(
        "getUpdates",
        {
          offset,
          timeout: pollSeconds,
          allowed_updates: bot.isPrimary
            ? PRIMARY_ALLOWED_UPDATES
            : COLLEAGUE_ALLOWED_UPDATES,
        },
        {
          timeoutMs: pollSeconds > 1 ? 40_000 : 10_000,
          token: bot.token,
        },
      )) as TelegramResponse;
    } catch (error) {
      logImpl(
        `[${label}] getUpdates network:`,
        redactBotLogText(errorMessage(error), bot),
      );
      consecutiveConflicts = 0;
      await sleepImpl(3000);
      continue;
    }
    if (!data.ok) {
      logImpl(
        `[${label}] getUpdates:`,
        redactBotLogText(data.description, bot),
      );
      if (/409|conflict|webhook/i.test(String(data.description || ""))) {
        consecutiveConflicts += 1;
        const { sleepMs, shouldAlert } = conflictBackoff(consecutiveConflicts);
        try {
          await deleteWebhookOrThrow(false, {
            token: bot.token,
            tgImpl,
            logImpl,
          });
        } catch (error) {
          logImpl(
            `[${label}] deleteWebhook:`,
            redactBotLogText(errorMessage(error), bot),
          );
        }
        if (shouldAlert && onConflictAlert) {
          try {
            await onConflictAlert(bot);
          } catch (error) {
            logImpl(
              `[${label}] getUpdates conflict alert:`,
              redactBotLogText(errorMessage(error), bot),
            );
          }
        }
        await sleepImpl(sleepMs);
        continue;
      }
      consecutiveConflicts = 0;
      await sleepImpl(3000);
      continue;
    }
    if (consecutiveConflicts > 0) {
      consecutiveConflicts = 0;
      alertResolvedImpl?.(bot);
    }
    const items = parseTelegramUpdates(data.result);
    if (items === null) {
      logImpl(
        `[${label}] getUpdates: invalid result`,
        JSON.stringify(invalidTelegramUpdatesDiagnostic(data.result)),
      );
      await sleepImpl(3000);
      continue;
    }
    if (items.length === 0) continue;
    const batch = await processTelegramBatch(items, offset, {
      processImpl: processOne,
      saveOffsetImpl: persistOffset,
      logImpl,
    });
    offset = batch.offset;
    onUpdates?.();
    if (batch.ingressBlocked) await sleepImpl(3000);
  }
  return { offset };
}

function createWakeSignal(): {
  wake: () => void;
  wait: (maxMs: number) => Promise<void>;
} {
  let pending = false;
  let notify: (() => void) | null = null;
  return {
    wake() {
      if (notify) {
        const resolve = notify;
        notify = null;
        resolve();
      } else {
        pending = true;
      }
    },
    wait(maxMs: number) {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (notify === done) notify = null;
          resolve();
        }, maxMs);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        notify = done;
      });
    },
  };
}

async function initColleagueBotOffset(
  bot: TelegramBotConfig,
  processLease: TelegramProcessLease,
): Promise<number> {
  const offsetFile = botOffsetFile(bot);
  assertTelegramProcessLease(processLease);
  // Unlike Iva's install first run, a colleague's first activation must not drop
  // or fast-forward the Telegram backlog: those updates are owner messages sent
  // while the option was off. Read any existing cursor before the webhook call,
  // delete a stale webhook without dropping pending updates, and start at 0 when
  // there is no cursor yet.
  const stored = await loadOffset({ file: offsetFile });
  assertTelegramProcessLease(processLease);
  await deleteWebhookOrThrow(false, { token: bot.token });
  assertTelegramProcessLease(processLease);
  if (stored.offset === null) {
    await saveOffset(0, { file: offsetFile });
    assertTelegramProcessLease(processLease);
    log(
      `bot:${bot.botId} first activation — pending queue preserved; starting offset:`,
      0,
    );
    return 0;
  }
  log(`bot:${bot.botId} starting offset:`, stored.offset);
  return stored.offset;
}

const rawCollectQuietMs = Number(
  process.env.TELEGRAM_COLLECT_QUIET_MS ?? COLLECT_QUIET_MS,
);
const configuredCollectQuietMs =
  Number.isFinite(rawCollectQuietMs) && rawCollectQuietMs >= 0
    ? rawCollectQuietMs
    : COLLECT_QUIET_MS;

const turnsRunning = () =>
  listChatStatuses().some(({ status }) => chatHeld(chatState(status)));
const pollTimeout = (queued: number, collected: number) =>
  queued > 0 || collected > 0 || turnsRunning() ? 1 : 30;

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
  // Both files are read before polling. One that cannot be read stops the bridge, so
  // Telegram retains new updates and the bytes on disk stay as they are.
  await loadQueueFile(QUEUE_FILE, { strict: true });
  await loadQueueFile(TELEGRAM_INBOX_FILE, { strict: true });
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
  // Configured colleague loops exist even while the option is off: their poll loop
  // sleeps before touching Telegram and wakes up on `iva colleague on` without a
  // bridge restart. Offset/webhook initialization is lazy for the same reason.
  // Primary and colleague bots share one dynamic poll launcher so a newly hired
  // colleague from `managed_bot` starts polling immediately in the same process.
  const initialBots = configuredTelegramBots(process.env);
  const bots = initialBots.length > 0 ? initialBots : BOTS;
  const primaryBot = bots[0];
  const wakeSignal = createWakeSignal();
  const fatalBotState: { error: Error | null } = { error: null };
  const activeColleagueTokens = new Map<string, string>();
  let pendingInboxCount = 0;
  let pendingQueueCount = 0;

  const launchBotLoop = (
    bot: TelegramBotConfig,
    initialBotOffset: number,
    initializeOffset?: () => Promise<number>,
    primaryControlImpl?: typeof handleControl,
    shouldContinue?: () => boolean,
  ) => {
    const conflictKey = bot.isPrimary
      ? "getupdates-conflict"
      : `getupdates-conflict:${bot.botId}`;
    void runBotPollLoop({
      bot,
      initialOffset: initialBotOffset,
      initializeOffsetImpl: initializeOffset,
      handleControlImpl: primaryControlImpl,
      shouldContinue,
      pollTimeoutSeconds: () =>
        pollTimeout(pendingQueueCount, pendingInboxCount),
      assertLease: () => assertTelegramProcessLease(processLease),
      onUpdates: () => wakeSignal.wake(),
      onConflictAlert: async () => {
        const outcome = await alertOnce(
          DATA_DIR,
          conflictKey,
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
        return outcome === "sent";
      },
      alertResolvedImpl: () => alertResolved(DATA_DIR, conflictKey),
    }).catch((error: unknown) => {
      fatalBotState.error =
        error instanceof Error ? error : new Error(String(error));
      wakeSignal.wake();
    });
  };

  const ensureColleaguePollLoop = (colleague: TelegramBotConfig) => {
    if (colleague.isPrimary || !colleague.botId) return;
    if (activeColleagueTokens.get(colleague.botId) === colleague.token) return;
    activeColleagueTokens.set(colleague.botId, colleague.token);
    log(`starting colleague poll loop: bot:${colleague.botId}`);
    launchBotLoop(
      colleague,
      0,
      () => initColleagueBotOffset(colleague, processLease),
      undefined,
      () => activeColleagueTokens.get(colleague.botId!) === colleague.token,
    );
  };

  const primaryControl: typeof handleControl = (update, deps) =>
    handleControl(update, {
      ...deps,
      managedBotImpl:
        deps?.managedBotImpl ??
        ((managedUpdate) =>
          handleManagedBotUpdate(managedUpdate, {
            onColleagueHired: ensureColleaguePollLoop,
          })),
    });

  launchBotLoop(primaryBot, offset, undefined, primaryControl);
  for (const colleague of bots.slice(1)) {
    ensureColleaguePollLoop(colleague);
  }
  if (bots.length > 1) {
    log(
      `multi-bot polling active: ${bots.map((bot) => (bot.isPrimary ? "iva" : `bot:${bot.botId}`)).join(", ")}`,
    );
  }

  for (;;) {
    assertTelegramProcessLease(processLease);
    if (fatalBotState.error !== null) throw fatalBotState.error;
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
    scheduleBridgeTask("deferred-command", async () => {
      await reconcileDeferred(DATA_DIR, {
        busy: turnsRunning,
        launch: (argv) => launchIvaCommand("iva-deferred", argv),
        report: async (text) => {
          const chat = notificationChat();
          if (!chat || !(await reply(chat, text)))
            throw new Error("Deferred command report failed");
        },
        log,
      });
    });
    scheduleBridgeTask("colleague-avatars", async () => {
      await reconcilePendingColleagueAvatars();
    });
    pendingInboxCount = await promoteReadyInbox({
      collectorOptions: { quietMs: configuredCollectQuietMs },
    });
    pendingQueueCount = await drainReadyQueueHeads();
    const pollSeconds = pollTimeout(pendingQueueCount, pendingInboxCount);
    await wakeSignal.wait(pollSeconds * 1_000);
  }
}

export function runEntrypoint(
  moduleUrl: string,
  executedPath: string | undefined = process.argv[1],
): void {
  if (!executedPath || real(fileURLToPath(moduleUrl)) !== real(executedPath))
    return;
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
