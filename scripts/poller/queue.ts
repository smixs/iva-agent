import { randomUUID } from "node:crypto";
import { interruptedTurnText, RETRY_LABEL } from "#lib/error-humanizer.ts";
import { join } from "node:path";
import {
  acknowledgeQueueItems,
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
  resetIntentFences,
  resetIntentPhase,
  type ResetIntentPhase,
} from "../lib/telegram-reset-intent.ts";
import {
  requestTelegramReset,
  telegramAddressFromChatKey,
  type TelegramResetTarget,
} from "../lib/telegram-reset.ts";
import {
  chatState,
  getChatStatus,
  listChatStatuses,
  chatKeyOf,
  parseTelegramSessionRetirement,
  QUEUED_STATUS_CLEARED,
  RUN_STALE_MS,
  TURN_FIELDS_CLEARED,
  setChatStatus,
  setChatStatusIf,
  type ChatRecord,
  type ChatRecordExpected,
  type ChatRecordPatch,
} from "#lib/run-status.ts";
import { tr } from "#lib/i18n.ts";
import { appendTrace, type TraceInput } from "#lib/trace.ts";
import { DATA_DIR, SECRET, RESET_ROUTE, TOKEN, log } from "./config.ts";
import { tg } from "./transport.ts";

type ErrorLike = {
  message?: unknown;
  resetPhase?: string;
  resetFailures?: number;
};
type RunStatus = ChatRecord;
type ResetResult = { status?: unknown; [key: string]: unknown };
type ResetRequest = {
  chatKey: string;
  target: TelegramResetTarget;
  // Эпоха намерения на проводе: роут отклоняет вызов, чья эпоха уже упала по
  // этому ключу, — запоздавшее после таймаута исполнение старого remote не
  // сбросит свежий разговор (T341).
  resetEpoch?: number;
};
type ResetRequestImpl = (request: ResetRequest) => Promise<ResetResult>;
type CompleteStateImpl = (
  chatKey: string,
  options: {
    clearQueue?: boolean;
    discardThroughUpdateId?: number;
    resetFence?: number;
  },
) => Promise<void>;
type LogImpl = (...args: unknown[]) => void;
type QueueFileOptions = NonNullable<Parameters<typeof writeQueueFileAtomic>[2]>;
type StatusRecord = { chatKey?: unknown; status?: RunStatus | null };
type StatusImpl = (chatKey: string) => RunStatus | null;
type SetStatusIfImpl = (
  chatKey: string,
  expected: ChatRecordExpected,
  patch: ChatRecordPatch,
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
// Отметка запроса сброса из записанного намерения: главный путь и сверка после
// перезапуска отсекают очередь по одному и тому же времени.
const resetIntentRequestedAt = (intent: unknown): number | undefined =>
  typeof intent === "object" &&
  intent !== null &&
  Number.isSafeInteger((intent as { requestedAt?: unknown }).requestedAt)
    ? (intent as { requestedAt: number }).requestedAt
    : undefined;
const withResetPhase = (error: unknown, resetPhase: string) => {
  (error as ErrorLike).resetPhase = resetPhase;
};
const withResetFailures = (error: unknown, resetFailures: number) => {
  (error as ErrorLike).resetFailures = resetFailures;
};

// ── Durable busy-time FIFO ──────────────────────────────────────────────────
// Each accepted Telegram update is written as a versioned item (including update_id and
// the untouched raw update) before its Telegram offset advances. The Bridge then replays
// one batch (consecutive messages of one author) per idle chat/topic. It removes that batch
// only after Eve accepts it: a crash can duplicate the batch, never lose or reorder it.
const QUEUE_FILE = join(DATA_DIR, "telegram-queue.json");
const RESET_INTENT_DIR = join(DATA_DIR, "telegram-reset-intents");
const queueSettleUntil = new Map<string, number>();
const queueInFlight = new Map<string, QueuePhase>();
// Ids of a delivered batch until its removal is durable: every redelivery carries exactly them.
const queueBatchPins = new Map<string, readonly number[]>();
const queueDrainRotation: { afterKey: string | null } = { afterKey: null };
// Память Bridge об Интенте сброса чата — вход resetIntentPhase вместе с файлом намерения.
// recorded — зеркало файла: ограда доставки очереди чата. requestedAt — эпоха ожидающего
// намерения (его запрос): поступающие элементы помечаются ею, и граница сброса не зависит
// ни от update_id, ни от миллисекундного штампа. retryAt, failures, escalated —
// отсрочка повтора, счёт отказов и доставленная эскалация. Перезапуск их теряет, сверка при
// старте восстанавливает recorded и requestedAt с диска. Remove the backoff and the
// delivery fence when vercel/eve#2876 is fixed in the installed eve.
type ResetIntentMemory = {
  recorded: boolean;
  requestedAt?: number;
  retryAt: number;
  failures: number;
  escalated: boolean;
};
const NO_RESET_INTENT_MEMORY: ResetIntentMemory = {
  recorded: false,
  retryAt: 0,
  failures: 0,
  escalated: false,
};
const resetIntentMemory = new Map<string, ResetIntentMemory>();
// Порядок записи и сверки на диске, не фаза: скан, начатый до записи или снятия намерения,
// не возвращает ему старое зеркало.
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

// Очередь сброса чата в процессе Bridge: главный путь (/new, /restart, отставка сессии) и
// сверка намерения одного чата идут по одной. Без неё запоздалый удалённый сброс сверки
// стирает сессию, в которую главный путь уже доставил следующее сообщение
// (specs/ResetEpoch.tla: поток /new и сверка одного чата идут по одной).
const chatResetTails = new Map<string, Promise<void>>();

async function serializeChatReset<T>(
  chatKey: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = chatResetTails.get(chatKey) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  chatResetTails.set(chatKey, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (chatResetTails.get(chatKey) === current) chatResetTails.delete(chatKey);
  }
}

// Доставка из очереди чата ждёт, пока сброс держит очередь чата.
export const chatResetInFlight = (chatKey: string) =>
  chatResetTails.has(chatKey);

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

function resetMemoryOf(chatKey: string): ResetIntentMemory {
  return resetIntentMemory.get(chatKey) ?? NO_RESET_INTENT_MEMORY;
}

// Эпоха ожидающего намерения чата (requestedAt записанного намерения) или
// undefined — pendingResetFences цепочки сброса.
const pendingResetEpoch = (chatKey: string): number | undefined => {
  const memory = resetIntentMemory.get(chatKey);
  return memory?.recorded === true ? memory.requestedAt : undefined;
};

function rememberResetIntent(
  chatKey: string,
  patch: Partial<ResetIntentMemory>,
): ResetIntentMemory {
  const next = { ...resetMemoryOf(chatKey), ...patch };
  if (
    next.recorded ||
    next.retryAt !== 0 ||
    next.failures !== 0 ||
    next.escalated
  ) {
    resetIntentMemory.set(chatKey, next);
  } else {
    resetIntentMemory.delete(chatKey);
  }
  return next;
}

function resetRetryPending(chatKey: string, now: number): boolean {
  return resetMemoryOf(chatKey).retryAt > now;
}

// Фаза намерения сброса чата по записи и памяти Bridge (specs/ResetEpoch.tla:
// pending-намерение pFence, память поллинга и backoff).
export function privateResetIntentPhase(
  chatKey: string,
  now: () => number = Date.now,
): ResetIntentPhase {
  const memory = resetMemoryOf(chatKey);
  return resetIntentPhase({
    recorded: memory.recorded,
    retryPending: memory.retryAt > now(),
    escalated: memory.escalated,
  });
}

function deferResetRetry(chatKey: string, now: number, retryAfterMs: number) {
  rememberResetIntent(chatKey, { retryAt: now + retryAfterMs });
}

function recordResetFailure(chatKey: string): number {
  return rememberResetIntent(chatKey, {
    failures: resetMemoryOf(chatKey).failures + 1,
  }).failures;
}

function clearResetRetryState(chatKey: string) {
  rememberResetIntent(chatKey, { retryAt: 0, failures: 0, escalated: false });
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
  resetFence?: number,
  {
    clearQueueFileKeyImpl = clearQueueFileKey,
  }: {
    clearQueueFileKeyImpl?: (file: string, chatKey: string) => Promise<unknown>;
  } = {},
) {
  await serializeQueueMutation(async () => {
    // Reset cleanup must fail loudly: completeScopedResetState keeps the old
    // running status until this atomic rewrite succeeds.
    if (discardThroughUpdateId === undefined && resetFence === undefined) {
      await clearQueueFileKeyImpl(QUEUE_FILE, chatKey);
      return;
    }
    const loaded = await loadQueueFile(QUEUE_FILE, { strict: true });
    const current = Object.hasOwn(loaded.document.queues, chatKey)
      ? loaded.document.queues[chatKey]
      : [];
    // Живая эпоха читается внутри мутации: если за ожидание блокировки чат получил
    // новое /new, чистка прежнего намерения работает уже как чистка новой эпохи и
    // не трогает её элементы. Переданная граница — запасной путь для вызовов без
    // назначенной эпохи. update_id Telegram не обязан расти, а миллисекундный штамп
    // не различает «до» и «после» внутри одной отсечки: элемент живёт, если его
    // приняли под живой границей. Пометка новее границы тоже живая: это наследие
    // отменённого намерения, сброс не состоялся, и терять такие сообщения нельзя —
    // то же правило, что в promoteReadyInbox. Запись без пометки эпохи (до появления пометок)
    // доказывает «после» только строго бо́льшим временем постановки: равенство «до»
    // и «после» не отличает, и такая запись уходит. update_id — запасной путь для
    // вызовов без отметки границы.
    const fence =
      resetFence !== undefined
        ? (resetEpochFor(chatKey) ?? resetFence)
        : undefined;
    const retained = current.filter((item) =>
      fence !== undefined
        ? item.resetFence !== undefined
          ? item.resetFence >= fence
          : typeof item.enqueuedAt === "number" && item.enqueuedAt > fence
        : discardThroughUpdateId !== undefined &&
          item.updateId > discardThroughUpdateId,
    );
    if (retained.length === current.length) return;
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
  enqueuedAt?: number,
  {
    resetFence,
    enqueueImpl = enqueueQueueFile,
  }: {
    // Эпоха, которой пометить элемент: явная из durable-inbox записи (или null —
    // записи без пометки), либо текущая эпоха чата при прямой постановке.
    resetFence?: number | null;
    enqueueImpl?: typeof enqueueQueueFile;
  } = {},
) =>
  serializeQueueMutation(() => {
    // resetFence === undefined — прямая постановка: элемент помечается эпохой,
    // действующей на момент записи в очередь.
    const fields = resetFenceFields(
      resetFence === undefined ? resetEpochFor(chatKey) : resetFence,
    );
    return enqueueImpl(QUEUE_FILE, chatKey, update, {
      strict: true,
      ...(enqueuedAt === undefined ? {} : { now: () => enqueuedAt }),
      ...(fields === undefined ? {} : { itemFields: fields }),
    });
  });

export const acknowledgeTelegramQueueItems = (
  chatKey: string,
  updateIds: readonly number[],
) =>
  serializeQueueMutation(() =>
    acknowledgeQueueItems(QUEUE_FILE, chatKey, updateIds),
  );

// resetFence === null — вызывающий явно передал «принято без эпохи» (запись из
// durable inbox до появления пометок); undefined — пометить текущей эпохой чата.
const resetFenceFields = (fence: number | null | undefined) =>
  typeof fence === "number" ? { resetFence: fence } : undefined;

// Граница жива, пока её эпоха — текущая для чата (или эпохи ещё нет: прямой
// вызов вне потока сброса). Новое /new сменяет эпоху — прежняя граница устаревает,
// и её завершение не вправе трогать очередь и статус чужой эпохи.
const resetFenceIsLive = (chatKey: string, resetFence: number) => {
  const live = resetEpochFor(chatKey);
  return live === undefined || live === resetFence;
};

export async function completeScopedResetState(
  chatKey: string,
  {
    clearQueue = false,
    discardThroughUpdateId,
    resetFence,
    clearQueueImpl = clearChatQueue,
    setStatusImpl = setChatStatus,
  }: {
    clearQueue?: boolean;
    discardThroughUpdateId?: number;
    resetFence?: number;
    clearQueueImpl?: (
      chatKey: string,
      discardThroughUpdateId?: number,
      resetFence?: number,
    ) => Promise<void>;
    setStatusImpl?: (chatKey: string, patch: ChatRecordPatch) => unknown;
  } = {},
) {
  // Завершение устаревшего намерения ничего не делает: живую эпоху чистит её
  // собственный сброс, а чужая запись статуса стёрла бы её состояние.
  const fenceWentStale = () =>
    clearQueue &&
    resetFence !== undefined &&
    !resetFenceIsLive(chatKey, resetFence);
  if (fenceWentStale()) return;
  // For private chats the queue belongs to the reset session, so clear it
  // before exposing an idle tombstone. A failed cleanup leaves the old running
  // status in place and lets a repeated /new retry safely.
  if (clearQueue) {
    await clearQueueImpl(chatKey, discardThroughUpdateId, resetFence);
  }
  // За время чистки очереди эпоха могла смениться: статус трогать уже нельзя.
  if (fenceWentStale()) return;

  const previousEpoch = getChatStatus(chatKey)?.resetEpoch;
  setStatusImpl(chatKey, {
    status: "idle",
    ...TURN_FIELDS_CLEARED,
    wasCancelled: null,
    retiredSessionId: null,
    restartRetryData: null,
    restartRetryUpdate: null,
    restartRetryQuestion: null,
    restartRetryMedia: null,
    ...QUEUED_STATUS_CLEARED,
    resetAt: Date.now(),
    // Граница успешного сброса durable и не падает: эпоху ниже уже записанной
    // вернуть нельзя — помеченные ею элементы снова выглядели бы «после». Прежняя
    // эпоха могла остаться выше fence у намерения, записанного до отката часов.
    ...(clearQueue && resetFence !== undefined
      ? {
          resetEpoch: Math.max(
            resetFence,
            Number.isSafeInteger(previousEpoch)
              ? (previousEpoch as number)
              : resetFence,
          ),
        }
      : {}),
  });
}

// Последняя durable эпоха чата: requestedAt ожидающего намерения или resetEpoch,
// оставленный успешным сбросом в статусе. Основание монотонного шага /new.
const lastDurableResetEpoch = (chatKey: string): number => {
  const statusEpoch = getChatStatus(chatKey)?.resetEpoch;
  return Math.max(
    pendingResetEpoch(chatKey) ?? -1,
    Number.isSafeInteger(statusEpoch) ? (statusEpoch as number) : -1,
  );
};

export async function persistPrivateResetIntent(
  chatKey: string,
  discardThroughUpdateId?: number,
  {
    persistImpl = persistTelegramResetIntent,
    now = Date.now,
  }: {
    persistImpl?: typeof persistTelegramResetIntent;
    now?: () => number;
  } = {},
) {
  return serializeResetIntentMutation(chatKey, async () => {
    // Эпоха — монотонный счётчик, а не показание часов: /new в ту же миллисекунду
    // или после отката часов обязан получить эпоху выше последней durable, иначе
    // принятое под прежней эпохой переживёт чистку новой границы.
    const floor = lastDurableResetEpoch(chatKey) + 1;
    const intent = await persistImpl(RESET_INTENT_DIR, chatKey, {
      discardThroughUpdateId,
      now: () => Math.max(now(), floor),
    });
    recordResetIntentMutation(chatKey);
    rememberResetIntent(chatKey, {
      recorded: true,
      requestedAt: intent.requestedAt,
    });
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
    for (const intent of unchangedIntents) {
      rememberResetIntent(intent.chatKey, {
        recorded: true,
        requestedAt: intent.requestedAt,
      });
    }
    for (const [chatKey, memory] of resetIntentMemory) {
      if (
        memory.recorded &&
        !loadedKeys.has(chatKey) &&
        (resetIntentKeyRevision.get(chatKey) ?? 0) <= scan.revision
      ) {
        rememberResetIntent(chatKey, {
          recorded: false,
          requestedAt: undefined,
        });
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
    expectedRequestedAt,
  }: {
    clearImpl?: typeof clearTelegramResetIntent;
    // Снимать только если намерение ещё это: пока завершался сброс, новое /new
    // могло записать своё — чужое намерение удалять нельзя. Проверка внутри
    // сериализованной мутации, гонки с persist у неё нет.
    expectedRequestedAt?: number;
  } = {},
): Promise<boolean> {
  return serializeResetIntentMutation(chatKey, async () => {
    if (
      expectedRequestedAt !== undefined &&
      pendingResetEpoch(chatKey) !== expectedRequestedAt
    ) {
      return false;
    }
    await clearImpl(RESET_INTENT_DIR, chatKey);
    recordResetIntentMutation(chatKey);
    rememberResetIntent(chatKey, NO_RESET_INTENT_MEMORY);
    return true;
  });
}

export const hasPrivateResetIntent = (chatKey: string) =>
  resetIntentFences(privateResetIntentPhase(chatKey));

const clearIntentIfCurrent = (
  chatKey: string,
  expectedRequestedAt?: number,
): Promise<boolean> =>
  clearPrivateResetIntent(chatKey, { expectedRequestedAt });

// Граница сброса, действующая для чата сейчас: пока намерение ожидает, это его
// requestedAt; после успешного /new её хранит resetEpoch в статусе чата. Элемент,
// принятый в другую эпоху, текущему разговору не принадлежит.
export function resetEpochFor(chatKey: string): number | undefined {
  const pending = pendingResetEpoch(chatKey);
  if (pending !== undefined) return pending;
  const epoch = getChatStatus(chatKey)?.resetEpoch;
  return Number.isSafeInteger(epoch) ? (epoch) : undefined;
}

const requestResetFromIntent: ResetRequestImpl = ({
  chatKey,
  target,
  resetEpoch,
}) =>
  requestTelegramReset({
    url: RESET_ROUTE,
    secret: SECRET as string,
    target,
    chatKey,
    resetEpoch,
  });

// Один remote-сброс на чат одновременно: свой /new, сверка намерений и жнец
// протухших ходов делят слот. Второй ждёт конца чужого вызова, а выпускает
// свой, только если remote за его эпоху ещё не падал — дубль не существует, и
// запоздать ему некуда. «Упавший за эпоху» — отметка этого процесса плюс
// durable свидетель: resetEpoch статус пишет уже после падения remote.
const remoteResetSlots = new Map<string, Promise<unknown>>();
const remoteResetLandedEpochs = new Map<string, number>();

const remoteLandedEpoch = (chatKey: string): number => {
  const statusEpoch = getChatStatus(chatKey)?.resetEpoch;
  return Math.max(
    remoteResetLandedEpochs.get(chatKey) ?? -1,
    Number.isSafeInteger(statusEpoch) ? (statusEpoch as number) : -1,
  );
};

async function remoteResetSlot<T>(
  chatKey: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = remoteResetSlots.get(chatKey) ?? Promise.resolve();
  const run = previous.then(work);
  const tail: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  );
  remoteResetSlots.set(chatKey, tail);
  try {
    return await run;
  } finally {
    if (remoteResetSlots.get(chatKey) === tail)
      remoteResetSlots.delete(chatKey);
  }
}

// Выпуск remote внутри слота: вызов уходит, только если remote за эту эпоху ещё
// не падал. Возвращает null, когда выпускать было нечего, — запоздалый вызов
// старого намерения так и не существует.
async function issueRemoteReset(
  chatKey: string,
  resetFence: number | undefined,
  issue: () => Promise<ResetResult>,
): Promise<ResetResult | null> {
  if (resetFence !== undefined && remoteLandedEpoch(chatKey) >= resetFence)
    return null;
  const result = await issue();
  if (resetFence !== undefined)
    remoteResetLandedEpochs.set(
      chatKey,
      Math.max(remoteResetLandedEpochs.get(chatKey) ?? -1, resetFence),
    );
  return result;
}

export async function releaseScopedSession(
  chatKey: string,
  target: TelegramResetTarget,
  {
    requestResetImpl = requestResetFromIntent,
    logImpl = log,
    resetFence,
  }: {
    requestResetImpl?: ResetRequestImpl;
    logImpl?: LogImpl;
    // Эпоха намерения, чей remote выпускаем: уже упавший за неё вызов не
    // дублируем. Без эпохи (жнец протухших ходов) слот всё равно держит порядок.
    resetFence?: number;
  } = {},
) {
  let result;
  try {
    result = (await remoteResetSlot(chatKey, async () =>
      issueRemoteReset(chatKey, resetFence, () =>
        requestResetImpl({
          chatKey,
          target,
          ...(resetFence === undefined ? {} : { resetEpoch: resetFence }),
        }),
      ),
    )) ?? { status: "already_reset" };
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

type ScopedResetOptions = {
  clearQueue?: boolean;
  discardThroughUpdateId?: number;
  persistIntentImpl?: (
    chatKey: string,
    discardThroughUpdateId?: number,
  ) => Promise<unknown>;
  requestResetImpl?: ResetRequestImpl;
  completeStateImpl?: CompleteStateImpl;
  clearIntentImpl?: (
    chatKey: string,
    expectedRequestedAt?: number,
  ) => Promise<unknown>;
  logImpl?: LogImpl;
  now?: () => number;
  retryAfterMs?: number;
  /** Внутреннее: эпоха уже записанного намерения (performScopedReset ставит её до очереди). */
  resetFence?: number;
};

// Главный путь сброса держит очередь чата до снятия намерения: сверка того же чата ждёт,
// а доставка из его очереди стоит, пока сброс идёт (chatResetInFlight). Запись
// намерения идёт до очереди: пока сверка держит её своим remote, новый /new обязан
// перезаписать намерение и встать на слот remote — иначе обе стороны ждали бы друг
// друга (specs/ResetEpoch.tla: NewPersist не ждёт упавший чужой remote).
export async function performScopedReset(
  chatKey: string,
  target: TelegramResetTarget,
  {
    clearQueue = false,
    discardThroughUpdateId,
    persistIntentImpl = persistPrivateResetIntent,
    now = Date.now,
    retryAfterMs = RESET_INTENT_RETRY_MS,
    ...rest
  }: ScopedResetOptions = {},
) {
  let resetFence: number | undefined;
  if (clearQueue) {
    try {
      resetFence = resetIntentRequestedAt(
        await persistIntentImpl(chatKey, discardThroughUpdateId),
      );
    } catch (error) {
      withResetPhase(error, "intent");
      withResetFailures(error, recordResetFailure(chatKey));
      deferResetRetry(chatKey, now(), retryAfterMs);
      throw error;
    }
  }
  return serializeChatReset(chatKey, () =>
    performScopedResetUnderQueue(chatKey, target, {
      clearQueue,
      discardThroughUpdateId,
      persistIntentImpl,
      now,
      retryAfterMs,
      resetFence,
      ...rest,
    }),
  );
}

async function performScopedResetUnderQueue(
  chatKey: string,
  target: TelegramResetTarget,
  {
    clearQueue = false,
    discardThroughUpdateId,
    requestResetImpl = requestResetFromIntent,
    completeStateImpl = completeScopedResetState,
    clearIntentImpl = clearIntentIfCurrent,
    logImpl = log,
    now = Date.now,
    retryAfterMs = RESET_INTENT_RETRY_MS,
    resetFence,
  }: ScopedResetOptions,
) {
  if (clearQueue && resetRetryPending(chatKey, now())) {
    const error = new Error(`reset retry backoff active for ${chatKey}`);
    withResetPhase(error, "backoff");
    throw error;
  }
  try {
    await releaseScopedSession(chatKey, target, {
      requestResetImpl,
      logImpl,
      resetFence,
    });
  } catch (error) {
    if (clearQueue) {
      withResetFailures(error, recordResetFailure(chatKey));
      deferResetRetry(chatKey, now(), retryAfterMs);
    }
    throw error;
  }
  try {
    await completeStateImpl(chatKey, {
      clearQueue,
      discardThroughUpdateId,
      resetFence,
    });
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
      await clearIntentImpl(chatKey, resetFence);
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
  clearIntentImpl = clearIntentIfCurrent,
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
  clearIntentImpl?: (
    chatKey: string,
    expectedRequestedAt?: number,
  ) => Promise<unknown>;
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
    // Очередь сброса чата: сверка и главный путь одного чата не пересекаются.
    const reconciledIntent = await serializeChatReset(
      intent.chatKey,
      async () => {
        // Пока сверка ждала очередь, главный путь мог сбросить сессию по новому /new и
        // снять файл. Сверка исполняет сброс только для намерения, которое всё ещё лежит
        // на диске в том же виде (specs/ResetEpoch.tla: перечитывание намерения
        // внутри слота чата — часть сверок Guards).
        const current = (await loadIntentsImpl()).find(
          (loaded) => loaded.chatKey === intent.chatKey,
        );
        if (
          current === undefined ||
          current.discardThroughUpdateId !== intent.discardThroughUpdateId
        )
          return false;
        // Сверка работает только с живым намерением: пока длился её обход, чат мог
        // получить новое /new, и тогда удалённый сброс и локальная чистка принадлежат
        // уже новой эпохе — устаревшая запись ничего не трогает.
        const intentIsCurrent = () =>
          pendingResetEpoch(intent.chatKey) === intent.requestedAt;
        if (!intentIsCurrent()) return false;
        const attemptedAt = now();
        if (resetRetryPending(intent.chatKey, attemptedAt)) return false;
        const target = { address } as const;
        try {
          // Слот remote-сброса един на чат и делится с /new: пока чужой вызов летит,
          // свой ждёт, а войдя в слот, выпускают только живое намерение без упавшего
          // за эту эпоху remote — запоздалого вызова не существует.
          const result = await remoteResetSlot(intent.chatKey, async () => {
            if (!intentIsCurrent()) return null;
            return issueRemoteReset(intent.chatKey, intent.requestedAt, () =>
              requestResetImpl({
                chatKey: intent.chatKey,
                target,
                resetEpoch: intent.requestedAt,
              }),
            );
          });
          if (result !== null)
            logResetOutcome(logImpl, intent.chatKey, target, result);
          // Remote-вызов ждал: за это время намерение могло уступить новому /new.
          if (!intentIsCurrent()) {
            logImpl(
              `reset intent for ${intent.chatKey} superseded; skipping local cleanup`,
            );
            return false;
          }
          await completeStateImpl(intent.chatKey, {
            clearQueue: true,
            discardThroughUpdateId: intent.discardThroughUpdateId,
            resetFence: intent.requestedAt,
          });
          const cleared = await clearIntentImpl(
            intent.chatKey,
            intent.requestedAt,
          );
          if (cleared === false) return false;
          clearResetRetryState(intent.chatKey);
          return true;
        } catch (error) {
          const failures = recordResetFailure(intent.chatKey);
          deferResetRetry(
            intent.chatKey,
            attemptedAt,
            failures >= escalationAttempts
              ? escalatedRetryAfterMs
              : retryAfterMs,
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
            !resetMemoryOf(intent.chatKey).escalated
          ) {
            try {
              await sendImpl(
                intent.chatKey,
                trImpl(
                  "⚠️ Conversation reset is still blocked. Run iva reset on the server, then try /new again.",
                  "⚠️ Сброс диалога всё ещё заблокирован. Запусти iva reset на сервере, затем повтори /new.",
                ),
              );
              rememberResetIntent(intent.chatKey, { escalated: true });
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
          return false;
        }
      },
    );
    if (reconciledIntent) reconciled += 1;
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

export async function sendInterruptedTurnNotice(chatKey: string, text: string) {
  // Bridge стартует и с повреждённым outbound-Gate; Outbox нужен при отправке.
  const { sendTelegramHtml } = await import("../lib/telegram-send.ts");
  const target = telegramTargetOf(chatKey);
  if (!target) throw new Error(`invalid Telegram chat key: ${chatKey}`);
  const signal = AbortSignal.timeout(30_000);
  const result = await sendTelegramHtml(TOKEN ?? "", target.chat_id, text, {
    rich: true,
    trace: { source: "restart-notice" },
    fetchImpl: (input, init) => fetch(input, { ...init, signal }),
    ...(target.message_thread_id === undefined
      ? {}
      : { threadId: String(target.message_thread_id) }),
  });
  if (!result.ok) throw new Error(result.error);
}

function clearFailedDirectIngress(
  chatKey: string,
  {
    baselineGeneration,
    startedAt,
    statusImpl = getChatStatus,
    setStatusIfImpl = setChatStatusIf,
    now = Date.now,
  }: {
    baselineGeneration: number;
    startedAt: number;
    statusImpl?: StatusImpl;
    setStatusIfImpl?: SetStatusIfImpl;
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
    return Promise.resolve(false);
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
      ...TURN_FIELDS_CLEARED,
      wasCancelled: null,
      ...QUEUED_STATUS_CLEARED,
      resetAt: observedAt,
    },
  );
  if (!cleared) return Promise.resolve(false);

  return Promise.resolve(true);
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
    if (typeof key !== "string" || chatState(status) !== "retiring" || !marker)
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
      !current ||
      chatState(current) !== "retiring" ||
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
  status: RunStatus,
  sendImpl: (chatKey: string, text: string) => Promise<unknown>,
  trImpl: (en: string, ru: string) => string,
  safeLog: (...args: unknown[]) => void,
): Promise<void> {
  if (status.compacting === true) return;
  const text = interruptedTurnText({
    question:
      typeof status.turnQuestion === "string" ? status.turnQuestion : "",
    media: status.turnQuestionMedia === true,
    group: !/^\d+:$/u.test(key),
    data: String(status.restartRetryData),
  });
  try {
    await sendImpl(key, trImpl(text.en, text.ru));
  } catch (error) {
    safeLog(`stale run notification failed for ${key}:`, errorMessage(error));
  }
}

export async function reapStaleRuns({
  listStatusesImpl = listChatStatuses,
  setStatusIfImpl = setChatStatusIf,
  resetImpl = releaseScopedSession,
  sendImpl = sendInterruptedTurnNotice,
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
      !status ||
      chatState(status, now(), staleMs) !== "stale" ||
      inFlight.has(key)
    ) {
      continue;
    }

    let flipped;
    const reapedAt = now();
    const restartRetryData = `${trImpl(RETRY_LABEL.en, RETRY_LABEL.ru)}:${randomUUID()}`;
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
          ...TURN_FIELDS_CLEARED,
          wasCancelled: null,
          ...QUEUED_STATUS_CLEARED,
          resetAt: reapedAt,
          restartRetryData,
          restartRetryUpdate: null,
          restartRetryQuestion: status.turnQuestion,
          restartRetryMedia: status.turnQuestionMedia,
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

    await notifyInterruptedTurn(
      key,
      { ...status, restartRetryData },
      sendImpl,
      trImpl,
      safeLog,
    );
  }
  return reaped;
}

/** Что сказать человеку, чьё сообщение встало в очередь: чат занят ходом или пересказом. */
export function queuedNoticeText(
  count: number,
  status: RunStatus | null | undefined,
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
  queueBatchPins,
  queueDrainRotation,
  statusGeneration,
  sendStaleRunNotice,
  clearFailedDirectIngress,
  acknowledgeQueued,
  QUEUE_DELIVERY_TIMEOUT_MS,
  QUEUE_DRAIN_BUDGET_MS,
};
