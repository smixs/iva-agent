import { join } from "node:path";
import {
  acknowledgeQueueHead,
  clearQueueFileKey,
  enqueueQueueFile,
  loadQueueFile,
  TELEGRAM_QUEUE_VERSION,
  writeQueueFileAtomic,
} from "../lib/telegram-queue.ts";
import type {
  TelegramQueueDocument,
  TelegramQueueMessage,
  TelegramQueueUpdate,
} from "../lib/telegram-queue.ts";
import {
  clearTelegramResetIntent,
  loadTelegramResetIntents,
  persistTelegramResetIntent,
} from "../lib/telegram-reset-intent.ts";
import {
  requestTelegramReset,
  telegramAddressFromChatKey,
  type TelegramResetTarget,
} from "../lib/telegram-reset.ts";
import {
  getChatStatus,
  listChatStatuses,
  chatKeyOf,
  parseTelegramSessionRetirement,
  RUN_STALE_MS,
  setChatStatus,
  setChatStatusIf,
} from "#lib/run-status.ts";
import { tr } from "#lib/i18n.ts";
import { appendTrace, type TraceInput } from "#lib/trace.ts";
import { DATA_DIR, SECRET, RESET_ROUTE, log } from "./config.ts";
import { tg } from "./transport.ts";

type ErrorLike = {
  message?: unknown;
  resetPhase?: string;
  resetFailures?: number;
};
type RunStatus = Record<string, unknown> & {
  status?: unknown;
  generation?: unknown;
  updatedAt?: unknown;
  sessionId?: unknown;
  ingressId?: unknown;
  ingressAt?: unknown;
  statusMessageId?: unknown;
};
type ResetResult = { status?: unknown; [key: string]: unknown };
type ResetRequest = { chatKey: string; target: TelegramResetTarget };
type ResetRequestImpl = (request: ResetRequest) => Promise<ResetResult>;
type CompleteStateImpl = (
  chatKey: string,
  options: {
    clearQueue?: boolean;
    discardThroughUpdateId?: number;
    resetRequestedAt?: number;
  },
) => Promise<void>;
type LogImpl = (...args: unknown[]) => void;
type QueueFileOptions = NonNullable<Parameters<typeof writeQueueFileAtomic>[2]>;
type StatusRecord = { chatKey?: unknown; status?: RunStatus | null };
type StatusImpl = (chatKey: string) => RunStatus | null;
type SetStatusIfImpl = (
  chatKey: string,
  expected: Record<string, unknown>,
  patch: Record<string, unknown>,
) => RunStatus | null;
type RetirementResetImpl = (
  chatKey: string,
  target: TelegramResetTarget,
  options?: { clearQueue?: boolean },
) => Promise<unknown>;
export type QueuePhase =
  | { state: "delivering"; baselineGeneration: number }
  | {
      state: "awaiting-running";
      baselineGeneration: number;
      acceptedAt: number;
    }
  | { state: "running"; baselineGeneration: number; generation: number };

const errorMessage = (error: unknown) => (error as ErrorLike).message;
const withResetPhase = (error: unknown, resetPhase: string) => {
  (error as ErrorLike).resetPhase = resetPhase;
};
const withResetFailures = (error: unknown, resetFailures: number) => {
  (error as ErrorLike).resetFailures = resetFailures;
};

// ── Durable busy-time FIFO ──────────────────────────────────────────────────
// Each accepted Telegram update is written as a versioned item (including update_id and
// the untouched raw update) before its Telegram offset advances. The bridge then replays
// one head per idle chat/topic. It removes that head only after Eve accepts the webhook:
// a crash can duplicate the head, but cannot lose it or reorder later items around it.
const QUEUE_FILE = join(DATA_DIR, "telegram-queue.json");
const RESET_INTENT_DIR = join(DATA_DIR, "telegram-reset-intents");
const queueSettleUntil = new Map<string, number>();
const queueInFlight = new Map<string, QueuePhase>();
const queueDrainRotation: { afterKey: string | null } = { afterKey: null };
const undrainableLegacyLogged = new Set<string>();
// Remove this backoff when vercel/eve#2876 is fixed in the installed eve.
const resetIntentRetryAt = new Map<string, number>();
const resetIntentFailureCount = new Map<string, number>();
const resetIntentEscalationDelivered = new Set<string>();
// Remove this delivery fence with the vercel/eve#2876 workaround.
const pendingResetIntentKeys = new Set<string>();
const resetIntentKeyRevision = new Map<string, number>();
const activeResetIntentScans = new Set<{ revision: number }>();
const resetIntentMutationTails = new Map<string, Promise<void>>();
let resetIntentRevision = 0;
const QUEUE_DELIVERY_TIMEOUT_MS = 5_000;
const QUEUE_DRAIN_BUDGET_MS = 5_000;
export const RESET_INTENT_RETRY_MS = 30_000;
const RESET_INTENT_ESCALATED_RETRY_MS = 5 * 60_000;
export const RESET_INTENT_ESCALATION_ATTEMPTS = 10;
let queueMutationTail: Promise<void> = Promise.resolve();

async function serializeQueueMutation<T>(
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = queueMutationTail;
  let release = () => {};
  queueMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await mutation();
  } finally {
    release();
  }
}

async function serializeResetIntentMutation<T>(
  chatKey: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = resetIntentMutationTails.get(chatKey) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  resetIntentMutationTails.set(chatKey, current);
  await previous;
  try {
    return await mutation();
  } finally {
    release();
    if (resetIntentMutationTails.get(chatKey) === current) {
      resetIntentMutationTails.delete(chatKey);
    }
  }
}

function recordResetIntentMutation(chatKey: string) {
  resetIntentRevision += 1;
  if (activeResetIntentScans.size > 0) {
    resetIntentKeyRevision.set(chatKey, resetIntentRevision);
  }
}

function pruneResetIntentRevisions() {
  let oldestActiveRevision = Number.POSITIVE_INFINITY;
  for (const scan of activeResetIntentScans) {
    oldestActiveRevision = Math.min(oldestActiveRevision, scan.revision);
  }
  for (const [chatKey, revision] of resetIntentKeyRevision) {
    if (revision <= oldestActiveRevision)
      resetIntentKeyRevision.delete(chatKey);
  }
}

function resetRetryPending(chatKey: string, now: number): boolean {
  return (resetIntentRetryAt.get(chatKey) ?? 0) > now;
}

export function isPrivateResetRetryPending(
  chatKey: string,
  now: () => number = Date.now,
): boolean {
  return resetRetryPending(chatKey, now());
}

function deferResetRetry(chatKey: string, now: number, retryAfterMs: number) {
  resetIntentRetryAt.set(chatKey, now + retryAfterMs);
}

function recordResetFailure(chatKey: string): number {
  const failures = (resetIntentFailureCount.get(chatKey) ?? 0) + 1;
  resetIntentFailureCount.set(chatKey, failures);
  return failures;
}

function clearResetRetryState(chatKey: string) {
  resetIntentRetryAt.delete(chatKey);
  resetIntentFailureCount.delete(chatKey);
  resetIntentEscalationDelivered.delete(chatKey);
}

function statusGeneration(status: RunStatus | null | undefined): number {
  const generation = status?.generation;
  return Number.isSafeInteger(generation) && (generation as number) >= 0
    ? (generation as number)
    : 0;
}

export async function loadQueue({ strict = false }: { strict?: boolean } = {}) {
  const loaded = await loadQueueFile(QUEUE_FILE, { strict });
  if (loaded.quarantined) {
    log(
      `damaged Telegram queue moved to ${loaded.quarantined}:`,
      errorMessage(loaded.error),
    );
  }
  return loaded.document;
}

export async function writeQueueAtomic(
  queue: TelegramQueueDocument,
  options: QueueFileOptions = {},
) {
  await writeQueueFileAtomic(QUEUE_FILE, queue, options);
}

// A scoped reset intentionally discards only messages queued for this chat/topic.
// Other conversations keep both their queues and their Eve histories.
export async function clearChatQueue(
  chatKey: string,
  discardThroughUpdateId?: number,
  resetRequestedAt?: number,
  {
    clearQueueFileKeyImpl = clearQueueFileKey,
  }: {
    clearQueueFileKeyImpl?: (file: string, chatKey: string) => Promise<unknown>;
  } = {},
) {
  await serializeQueueMutation(async () => {
    // Reset cleanup must fail loudly: completeScopedResetState keeps the old
    // running status until this atomic rewrite succeeds.
    if (
      discardThroughUpdateId === undefined &&
      resetRequestedAt === undefined
    ) {
      await clearQueueFileKeyImpl(QUEUE_FILE, chatKey);
      return;
    }
    const loaded = await loadQueueFile(QUEUE_FILE, { strict: true });
    const current = Object.hasOwn(loaded.document.queues, chatKey)
      ? loaded.document.queues[chatKey]
      : [];
    const retained = current.filter((item) =>
      discardThroughUpdateId !== undefined
        ? item.updateId > discardThroughUpdateId
        : typeof item.enqueuedAt === "number" &&
          item.enqueuedAt >= (resetRequestedAt as number),
    );
    if (retained.length === current.length && !loaded.migrated) return;
    const queues = Object.fromEntries(Object.entries(loaded.document.queues));
    if (retained.length > 0) queues[chatKey] = retained;
    else delete queues[chatKey];
    await writeQueueFileAtomic(QUEUE_FILE, {
      version: TELEGRAM_QUEUE_VERSION,
      queues,
    });
  });
}

export const enqueueTelegramQueueUpdate = (
  chatKey: string,
  update: TelegramQueueUpdate,
  enqueueImpl: typeof enqueueQueueFile = enqueueQueueFile,
) =>
  serializeQueueMutation(() =>
    enqueueImpl(QUEUE_FILE, chatKey, update, { strict: true }),
  );

export const acknowledgeTelegramQueueHead = (
  chatKey: string,
  updateId: number,
) =>
  serializeQueueMutation(() =>
    acknowledgeQueueHead(QUEUE_FILE, chatKey, updateId),
  );

export async function completeScopedResetState(
  chatKey: string,
  {
    clearQueue = false,
    discardThroughUpdateId,
    resetRequestedAt,
    clearQueueImpl = clearChatQueue,
    setStatusImpl = setChatStatus,
    deleteMessageImpl = deleteStaleWorkingMessage,
  }: {
    clearQueue?: boolean;
    discardThroughUpdateId?: number;
    resetRequestedAt?: number;
    clearQueueImpl?: (
      chatKey: string,
      discardThroughUpdateId?: number,
      resetRequestedAt?: number,
    ) => Promise<void>;
    setStatusImpl?: (
      chatKey: string,
      patch: Record<string, unknown>,
    ) => unknown;
    deleteMessageImpl?: (
      chatKey: string,
      messageId: string | number,
    ) => unknown;
  } = {},
) {
  // For private chats the queue belongs to the reset session, so clear it
  // before exposing an idle tombstone. A failed cleanup leaves the old running
  // status in place and lets a repeated /new retry safely.
  if (clearQueue) {
    await clearQueueImpl(chatKey, discardThroughUpdateId, resetRequestedAt);
  }

  // /new clears sessionId before a late terminal event can finish the Working…
  // message, so delete it here from the pre-reset snapshot.
  const current = getChatStatus(chatKey);

  // Delete before clearing state: a crash after delete is harmless (message
  // already gone); a crash before either step still leaves state pointing at
  // the message for the next /new attempt.
  if (
    current?.statusMessageId !== undefined &&
    current.statusMessageId !== null
  ) {
    try {
      await deleteMessageImpl(
        chatKey,
        current.statusMessageId as string | number,
      );
    } catch {
      // Reset working messages are removed best-effort, like stale ones.
    }
  }

  setStatusImpl(chatKey, {
    status: "idle",
    sessionId: null,
    turnId: null,
    statusMessageId: null,
    ingressId: null,
    ingressAt: null,
    statusAt: null,
    turnAt: null,
    firstOutputAt: null,
    latencyLogged: null,
    wasCancelled: null,
    compacting: null,
    retiredSessionId: null,
    resetAt: Date.now(),
  });
}

export async function persistPrivateResetIntent(
  chatKey: string,
  discardThroughUpdateId?: number,
  {
    persistImpl = persistTelegramResetIntent,
  }: { persistImpl?: typeof persistTelegramResetIntent } = {},
) {
  return serializeResetIntentMutation(chatKey, async () => {
    const intent = await persistImpl(RESET_INTENT_DIR, chatKey, {
      discardThroughUpdateId,
    });
    recordResetIntentMutation(chatKey);
    pendingResetIntentKeys.add(chatKey);
    return intent;
  });
}

export async function loadPrivateResetIntents({
  loadImpl = () => loadTelegramResetIntents(RESET_INTENT_DIR),
}: {
  loadImpl?: () => ReturnType<typeof loadTelegramResetIntents>;
} = {}) {
  const scan = { revision: resetIntentRevision };
  activeResetIntentScans.add(scan);
  try {
    const intents = await loadImpl();
    const unchangedIntents = intents.filter(
      (intent) =>
        (resetIntentKeyRevision.get(intent.chatKey) ?? 0) <= scan.revision,
    );
    const loadedKeys = new Set(unchangedIntents.map(({ chatKey }) => chatKey));
    for (const { chatKey } of unchangedIntents) {
      pendingResetIntentKeys.add(chatKey);
    }
    for (const chatKey of pendingResetIntentKeys) {
      if (
        !loadedKeys.has(chatKey) &&
        (resetIntentKeyRevision.get(chatKey) ?? 0) <= scan.revision
      ) {
        pendingResetIntentKeys.delete(chatKey);
      }
    }
    return unchangedIntents;
  } finally {
    activeResetIntentScans.delete(scan);
    pruneResetIntentRevisions();
  }
}

export async function clearPrivateResetIntent(
  chatKey: string,
  {
    clearImpl = clearTelegramResetIntent,
  }: {
    clearImpl?: typeof clearTelegramResetIntent;
  } = {},
) {
  await serializeResetIntentMutation(chatKey, async () => {
    await clearImpl(RESET_INTENT_DIR, chatKey);
    recordResetIntentMutation(chatKey);
    pendingResetIntentKeys.delete(chatKey);
    clearResetRetryState(chatKey);
  });
}

export const hasPrivateResetIntent = (chatKey: string) =>
  pendingResetIntentKeys.has(chatKey);

const requestResetFromIntent: ResetRequestImpl = ({ target }) =>
  requestTelegramReset({
    url: RESET_ROUTE,
    secret: SECRET as string,
    target,
  });

export async function releaseScopedSession(
  chatKey: string,
  target: TelegramResetTarget,
  {
    requestResetImpl = requestResetFromIntent,
    logImpl = log,
  }: {
    requestResetImpl?: ResetRequestImpl;
    logImpl?: LogImpl;
  } = {},
) {
  let result;
  try {
    result = await requestResetImpl({ chatKey, target });
  } catch (error) {
    withResetPhase(error, "remote");
    throw error;
  }
  logResetOutcome(logImpl, chatKey, target, result);
  return result;
}

function logResetOutcome(
  logImpl: LogImpl,
  chatKey: string,
  target: TelegramResetTarget,
  result: ResetResult,
) {
  try {
    logImpl(
      `reset for chat ${chatKey} -> ${(result?.status as string | undefined) ?? "unknown"} (${"sessionId" in target ? target.sessionId : "address"})`,
    );
  } catch {
    // Журналирование не должно ронять сброс.
  }
}

export async function performScopedReset(
  chatKey: string,
  target: TelegramResetTarget,
  {
    clearQueue = false,
    discardThroughUpdateId,
    persistIntentImpl = persistPrivateResetIntent,
    requestResetImpl = requestResetFromIntent,
    completeStateImpl = completeScopedResetState,
    clearIntentImpl = clearPrivateResetIntent,
    logImpl = log,
    now = Date.now,
    retryAfterMs = RESET_INTENT_RETRY_MS,
  }: {
    clearQueue?: boolean;
    discardThroughUpdateId?: number;
    persistIntentImpl?: (
      chatKey: string,
      discardThroughUpdateId?: number,
    ) => Promise<unknown>;
    requestResetImpl?: ResetRequestImpl;
    completeStateImpl?: CompleteStateImpl;
    clearIntentImpl?: (chatKey: string) => Promise<unknown>;
    logImpl?: LogImpl;
    now?: () => number;
    retryAfterMs?: number;
  } = {},
) {
  if (clearQueue && resetRetryPending(chatKey, now())) {
    const error = new Error(`reset retry backoff active for ${chatKey}`);
    withResetPhase(error, "backoff");
    throw error;
  }
  if (clearQueue) {
    try {
      await persistIntentImpl(chatKey, discardThroughUpdateId);
    } catch (error) {
      withResetPhase(error, "intent");
      withResetFailures(error, recordResetFailure(chatKey));
      deferResetRetry(chatKey, now(), retryAfterMs);
      throw error;
    }
  }
  try {
    await releaseScopedSession(chatKey, target, {
      requestResetImpl,
      logImpl,
    });
  } catch (error) {
    if (clearQueue) {
      withResetFailures(error, recordResetFailure(chatKey));
      deferResetRetry(chatKey, now(), retryAfterMs);
    }
    throw error;
  }
  try {
    await completeStateImpl(chatKey, { clearQueue, discardThroughUpdateId });
  } catch (error) {
    withResetPhase(error, "cleanup");
    if (clearQueue) {
      withResetFailures(error, recordResetFailure(chatKey));
      deferResetRetry(chatKey, now(), retryAfterMs);
    }
    throw error;
  }
  if (clearQueue) {
    try {
      await clearIntentImpl(chatKey);
    } catch (error) {
      withResetPhase(error, "intent-cleanup");
      withResetFailures(error, recordResetFailure(chatKey));
      deferResetRetry(chatKey, now(), retryAfterMs);
      throw error;
    }
  }
  clearResetRetryState(chatKey);
}

export async function reconcileScopedResetIntents({
  loadIntentsImpl = loadPrivateResetIntents,
  requestResetImpl = requestResetFromIntent,
  completeStateImpl = completeScopedResetState,
  clearIntentImpl = clearPrivateResetIntent,
  logImpl = log,
  sendImpl = sendStaleRunNotice,
  trImpl = tr,
  now = Date.now,
  retryAfterMs = RESET_INTENT_RETRY_MS,
  escalatedRetryAfterMs = RESET_INTENT_ESCALATED_RETRY_MS,
  escalationAttempts = RESET_INTENT_ESCALATION_ATTEMPTS,
}: {
  loadIntentsImpl?: typeof loadPrivateResetIntents;
  requestResetImpl?: ResetRequestImpl;
  completeStateImpl?: CompleteStateImpl;
  clearIntentImpl?: (chatKey: string) => Promise<unknown>;
  logImpl?: LogImpl;
  sendImpl?: (chatKey: string, text: string) => Promise<unknown>;
  trImpl?: (en: string, ru: string) => string;
  now?: () => number;
  retryAfterMs?: number;
  escalatedRetryAfterMs?: number;
  escalationAttempts?: number;
} = {}) {
  const intents = await loadIntentsImpl();
  let reconciled = 0;
  for (const intent of intents) {
    const address = telegramAddressFromChatKey(intent.chatKey);
    if (address === null) {
      logImpl(`invalid Telegram reset intent chat key: ${intent.chatKey}`);
      continue;
    }
    const attemptedAt = now();
    if (resetRetryPending(intent.chatKey, attemptedAt)) continue;
    const target = { address } as const;
    try {
      const result = await requestResetImpl({
        chatKey: intent.chatKey,
        target,
      });
      logResetOutcome(logImpl, intent.chatKey, target, result);
      await completeStateImpl(intent.chatKey, {
        clearQueue: true,
        discardThroughUpdateId: intent.discardThroughUpdateId,
        resetRequestedAt: intent.requestedAt,
      });
      await clearIntentImpl(intent.chatKey);
      clearResetRetryState(intent.chatKey);
      reconciled += 1;
    } catch (error) {
      const failures = recordResetFailure(intent.chatKey);
      deferResetRetry(
        intent.chatKey,
        attemptedAt,
        failures >= escalationAttempts ? escalatedRetryAfterMs : retryAfterMs,
      );
      try {
        logImpl(
          `reset intent reconciliation failed for ${intent.chatKey}:`,
          errorMessage(error),
        );
      } catch {
        // Reconciliation must never stop the Telegram polling loop.
      }
      if (
        failures >= escalationAttempts &&
        !resetIntentEscalationDelivered.has(intent.chatKey)
      ) {
        try {
          await sendImpl(
            intent.chatKey,
            trImpl(
              "⚠️ Conversation reset is still blocked. Run iva reset on the server, then try /new again.",
              "⚠️ Сброс диалога всё ещё заблокирован. Запусти iva reset на сервере, затем повтори /new.",
            ),
          );
          resetIntentEscalationDelivered.add(intent.chatKey);
        } catch (noticeError) {
          try {
            logImpl(
              `reset intent escalation failed for ${intent.chatKey}:`,
              errorMessage(noticeError),
            );
          } catch {
            // Escalation logging must not stop the Telegram polling loop.
          }
        }
      }
    }
  }
  return reconciled;
}

function telegramTargetOf(
  chatKey: string,
): { chat_id: string; message_thread_id?: number } | null {
  const separator = chatKey.indexOf(":");
  if (separator <= 0) return null;
  const chatId = chatKey.slice(0, separator);
  if (!/^-?\d+$/.test(chatId)) return null;
  const thread = chatKey.slice(separator + 1);
  if (thread === "") return { chat_id: chatId };
  if (!/^\d+$/.test(thread)) return null;
  const messageThreadId = Number(thread);
  if (!Number.isSafeInteger(messageThreadId) || messageThreadId <= 0)
    return null;
  return { chat_id: chatId, message_thread_id: messageThreadId };
}

async function sendStaleRunNotice(chatKey: string, text: string) {
  const target = telegramTargetOf(chatKey);
  if (!target) throw new Error(`invalid Telegram chat key: ${chatKey}`);
  const data = await tg("sendMessage", { ...target, text });
  const response = data as { ok?: unknown; description?: unknown } | null;
  if (!response?.ok)
    throw new Error(
      String(
        (response?.description as string | undefined) || "sendMessage failed",
      ),
    );
}

async function deleteStaleWorkingMessage(
  chatKey: string,
  messageId: string | number,
) {
  const target = telegramTargetOf(chatKey);
  if (!target) return;
  await tg("deleteMessage", {
    chat_id: target.chat_id,
    message_id: messageId,
  });
}

async function clearFailedDirectIngress(
  chatKey: string,
  {
    baselineGeneration,
    startedAt,
    statusImpl = getChatStatus,
    setStatusIfImpl = setChatStatusIf,
    deleteMessageImpl = deleteStaleWorkingMessage,
    now = Date.now,
  }: {
    baselineGeneration: number;
    startedAt: number;
    statusImpl?: StatusImpl;
    setStatusIfImpl?: SetStatusIfImpl;
    deleteMessageImpl?: (
      chatKey: string,
      messageId: string | number,
    ) => unknown;
    now?: () => number;
  },
) {
  const current = statusImpl(chatKey);
  const observedAt = now();
  if (
    current?.status !== "running" ||
    current.sessionId !== undefined ||
    typeof current.ingressId !== "string" ||
    typeof current.ingressAt !== "number" ||
    !Number.isFinite(current.ingressAt) ||
    current.ingressAt < startedAt ||
    current.ingressAt > observedAt ||
    statusGeneration(current) <= baselineGeneration
  ) {
    return false;
  }

  const cleared = setStatusIfImpl(
    chatKey,
    {
      status: "running",
      generation: current.generation,
      updatedAt: current.updatedAt,
      ingressId: current.ingressId,
      sessionId: undefined,
    },
    {
      status: "idle",
      sessionId: null,
      turnId: null,
      statusMessageId: null,
      ingressId: null,
      ingressAt: null,
      statusAt: null,
      turnAt: null,
      firstOutputAt: null,
      latencyLogged: null,
      wasCancelled: null,
      compacting: null,
      resetAt: observedAt,
    },
  );
  if (!cleared) return false;

  if (
    current.statusMessageId !== undefined &&
    current.statusMessageId !== null
  ) {
    try {
      await deleteMessageImpl(
        chatKey,
        current.statusMessageId as string | number,
      );
    } catch {
      // Failed-attempt working messages are removed best-effort, like stale ones.
    }
  }
  return true;
}

function sameRetirement(
  left: ReturnType<typeof parseTelegramSessionRetirement>,
  right: ReturnType<typeof parseTelegramSessionRetirement>,
): boolean {
  return Boolean(
    left &&
    right &&
    left.replayMs === right.replayMs &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId,
  );
}

export async function retireSettledSessions({
  listStatusesImpl = listChatStatuses,
  statusImpl = getChatStatus,
  setStatusIfImpl = setChatStatusIf,
  resetImpl = performScopedReset,
  sendImpl = sendStaleRunNotice,
  traceImpl = appendTrace,
  trImpl = tr,
  logImpl = log,
  inFlight = queueInFlight,
}: {
  listStatusesImpl?: () => StatusRecord[] | Promise<StatusRecord[]>;
  statusImpl?: StatusImpl;
  setStatusIfImpl?: SetStatusIfImpl;
  resetImpl?: RetirementResetImpl;
  sendImpl?: (chatKey: string, text: string) => Promise<unknown>;
  traceImpl?: (event: TraceInput) => void;
  trImpl?: (en: string, ru: string) => string;
  logImpl?: LogImpl;
  inFlight?: ReadonlyMap<string, unknown>;
} = {}): Promise<number> {
  const safeLog = (...args: unknown[]) => {
    try {
      logImpl(...args);
    } catch {
      // Retirement must never stop Telegram's polling loop.
    }
  };
  let records: StatusRecord[];
  try {
    records = await listStatusesImpl();
  } catch (error) {
    safeLog("session retirement scan failed:", errorMessage(error));
    return 0;
  }

  let retired = 0;
  for (const record of records) {
    const key = record.chatKey;
    const status = record.status;
    const marker = parseTelegramSessionRetirement(status?.retireAfterTurn);
    if (typeof key !== "string" || status?.status !== "idle" || !marker)
      continue;

    let current: RunStatus | null;
    try {
      current = statusImpl(key);
    } catch (error) {
      safeLog(
        `session retirement status failed for ${key}:`,
        errorMessage(error),
      );
      continue;
    }
    const currentMarker = parseTelegramSessionRetirement(
      current?.retireAfterTurn,
    );
    if (
      current?.status !== "idle" ||
      !sameRetirement(marker, currentMarker) ||
      inFlight.has(key)
    )
      continue;

    let cleared: RunStatus | null;
    try {
      cleared = setStatusIfImpl(
        key,
        {
          status: "idle",
          generation: current.generation,
          updatedAt: current.updatedAt,
        },
        {
          retireAfterTurn: null,
        },
      );
    } catch (error) {
      safeLog(`session retirement CAS failed for ${key}:`, errorMessage(error));
      continue;
    }
    if (!cleared) continue;

    try {
      await resetImpl(
        key,
        { sessionId: marker.sessionId },
        { clearQueue: false },
      );
    } catch (error) {
      safeLog(
        `session retirement reset failed for ${key}:`,
        errorMessage(error),
      );
      try {
        setStatusIfImpl(
          key,
          {
            status: "idle",
            generation: cleared.generation,
            updatedAt: cleared.updatedAt,
            retireAfterTurn: undefined,
          },
          { retireAfterTurn: marker },
        );
      } catch (statusError) {
        safeLog(
          `session retirement retry state failed for ${key}:`,
          errorMessage(statusError),
        );
      }
      continue;
    }

    try {
      const resetStatus = statusImpl(key);
      if (resetStatus?.status === "idle") {
        setStatusIfImpl(
          key,
          {
            status: "idle",
            generation: resetStatus.generation,
            updatedAt: resetStatus.updatedAt,
            retireAfterTurn: undefined,
          },
          { retiredSessionId: marker.sessionId },
        );
      }
    } catch (statusError) {
      safeLog(
        `session retirement completion state failed for ${key}:`,
        errorMessage(statusError),
      );
    }

    retired++;
    try {
      traceImpl({
        source: "telegram",
        kind: "turn",
        name: "retired",
        turn: marker.turnId,
        session: marker.sessionId,
        data: { replayMs: marker.replayMs },
      });
    } catch (error) {
      safeLog(
        `session retirement trace failed for ${key}:`,
        errorMessage(error),
      );
    }
    try {
      await sendImpl(
        key,
        trImpl(
          "The conversation grew large, so I started a fresh one. Memory is intact.",
          "Диалог разросся, начала новый. Память на месте.",
        ),
      );
    } catch (error) {
      safeLog(
        `session retirement notification failed for ${key}:`,
        errorMessage(error),
      );
    }
  }
  return retired;
}

// Брошенный пересказ между ходами — не оборванный ход: запроса человека в нём не было, его
// сообщения ждут в очереди моста. Сказать «повтори запрос» было бы неправдой.
async function notifyInterruptedTurn(
  key: string,
  status: Record<string, unknown>,
  sendImpl: (chatKey: string, text: string) => Promise<unknown>,
  trImpl: (en: string, ru: string) => string,
  safeLog: (...args: unknown[]) => void,
): Promise<void> {
  if (status.compacting === true) return;
  try {
    await sendImpl(
      key,
      trImpl(
        "The previous turn was interrupted - repeat your request or use /new",
        "Предыдущий ход оборвался - повтори запрос или /new",
      ),
    );
  } catch (error) {
    safeLog(`stale run notification failed for ${key}:`, errorMessage(error));
  }
}

export async function reapStaleRuns({
  listStatusesImpl = listChatStatuses,
  setStatusIfImpl = setChatStatusIf,
  resetImpl = releaseScopedSession,
  sendImpl = sendStaleRunNotice,
  deleteMessageImpl = deleteStaleWorkingMessage,
  now = Date.now,
  inFlight = queueInFlight,
  staleMs = RUN_STALE_MS,
  trImpl = tr,
  logImpl = log,
}: {
  listStatusesImpl?: () => StatusRecord[] | Promise<StatusRecord[]>;
  setStatusIfImpl?: SetStatusIfImpl;
  resetImpl?: (
    chatKey: string,
    target: TelegramResetTarget,
  ) => Promise<unknown>;
  sendImpl?: (chatKey: string, text: string) => Promise<unknown>;
  deleteMessageImpl?: (
    chatKey: string,
    messageId: string | number,
  ) => Promise<unknown>;
  now?: () => number;
  inFlight?: ReadonlyMap<string, unknown>;
  staleMs?: number;
  trImpl?: (en: string, ru: string) => string;
  logImpl?: LogImpl;
} = {}) {
  const safeLog = (...args: unknown[]) => {
    try {
      logImpl(...args);
    } catch {
      // Обслуживание протухших ходов не должно останавливать polling loop.
    }
  };

  let records;
  try {
    records = await listStatusesImpl();
  } catch (error) {
    safeLog("stale run scan failed:", errorMessage(error));
    return 0;
  }

  let reaped = 0;
  for (const record of records) {
    const key = record?.chatKey;
    const status = record?.status;
    if (
      typeof key !== "string" ||
      status?.status !== "running" ||
      now() - ((status.updatedAt as number | null | undefined) ?? 0) <=
        staleMs ||
      inFlight.has(key)
    ) {
      continue;
    }

    let flipped;
    const reapedAt = now();
    try {
      flipped = setStatusIfImpl(
        key,
        {
          status: "running",
          generation: status.generation,
          updatedAt: status.updatedAt,
        },
        {
          status: "idle",
          sessionId: null,
          turnId: null,
          statusMessageId: null,
          ingressId: null,
          ingressAt: null,
          statusAt: null,
          turnAt: null,
          firstOutputAt: null,
          latencyLogged: null,
          wasCancelled: null,
          compacting: null,
          resetAt: reapedAt,
        },
      );
    } catch (error) {
      safeLog(`stale run CAS failed for ${key}:`, errorMessage(error));
      continue;
    }
    if (!flipped) continue;
    reaped++;

    if (typeof status.sessionId === "string" && status.sessionId.length > 0) {
      try {
        await resetImpl(key, { sessionId: status.sessionId });
      } catch (error) {
        safeLog(`stale run reset failed for ${key}:`, errorMessage(error));
      }
    } else {
      safeLog(`stale run ${key} has no session id`);
    }

    await notifyInterruptedTurn(key, status, sendImpl, trImpl, safeLog);

    if (
      status.statusMessageId !== undefined &&
      status.statusMessageId !== null
    ) {
      try {
        await deleteMessageImpl(key, status.statusMessageId as string | number);
      } catch {
        // Старое статус-сообщение удаляется best-effort.
      }
    }
  }
  return reaped;
}

/** Что сказать человеку, чьё сообщение встало в очередь: чат занят ходом или пересказом. */
export function queuedNoticeText(
  count: number,
  status: Record<string, unknown> | null | undefined,
  trImpl: (en: string, ru: string) => string = tr,
): string {
  return status?.status === "running" && status.compacting === true
    ? trImpl(
        "Compacting the conversation, I'll answer in a moment.",
        "Сжимаю разговор, скоро отвечу.",
      )
    : trImpl(
        `Queued (${count}). I'll start it automatically when the current task finishes.`,
        `В очереди: ${count}. Начну автоматически, когда текущая задача завершится.`,
      );
}

async function acknowledgeQueued(update: TelegramQueueUpdate, count: number) {
  const message = update.message as TelegramQueueMessage;
  await tg("setMessageReaction", {
    chat_id: message.chat?.id,
    message_id: message.message_id,
    reaction: [{ type: "emoji", emoji: "👀" }],
  }).catch((error: unknown) => log("reaction failed:", errorMessage(error)));
  await tg("sendMessage", {
    chat_id: message.chat?.id,
    text: queuedNoticeText(
      count,
      getChatStatus(
        chatKeyOf(String(message.chat?.id), message.message_thread_id),
      ),
    ),
    ...(message.message_thread_id === undefined
      ? {}
      : { message_thread_id: message.message_thread_id }),
  }).catch((error: unknown) =>
    log("queue status failed:", errorMessage(error)),
  );
}

export {
  QUEUE_FILE,
  queueSettleUntil,
  queueInFlight,
  queueDrainRotation,
  undrainableLegacyLogged,
  statusGeneration,
  sendStaleRunNotice,
  deleteStaleWorkingMessage,
  clearFailedDirectIngress,
  acknowledgeQueued,
  QUEUE_DELIVERY_TIMEOUT_MS,
  QUEUE_DRAIN_BUDGET_MS,
};
