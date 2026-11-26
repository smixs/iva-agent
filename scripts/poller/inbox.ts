import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  acknowledgeQueueItems,
  enqueueQueueFile,
  isTelegramQueueUpdate,
  loadQueueFile,
  quarantineQueueRecords,
  queueCount,
  queueKeys,
  shouldQueueBusyUpdate,
  type DamagedQueueRecord,
  type TelegramQueueItem,
  type TelegramQueueUpdate,
} from "../lib/telegram-queue.ts";
import {
  collectorKeyFor,
  collectorOffer,
  collectorTakeExpired,
  createCollector,
} from "../lib/telegram-collect.ts";
import { traceBridgeAdmission } from "#lib/trace.ts";
import { ALLOWED, BOT_USERNAME, DATA_DIR, log } from "./config.ts";
import {
  tagUpdateWithBot,
  type TelegramBotConfig,
} from "../../packages/telegram-bots/index.ts";
import { chatKey } from "./offset.ts";
import { resetEpochFor } from "./queue.ts";
import { routeMessageUpdate, type RouteMessageResult } from "./routing.ts";

export const TELEGRAM_INBOX_FILE = join(DATA_DIR, "telegram-inbox.json");

type InboxPromotionBackoff = {
  failures: number;
  nextAttemptAt: number;
};

const inboxPromotionBackoff = new Map<string, InboxPromotionBackoff>();

export type InboxCollectorOptions = {
  quietMs?: unknown;
  mediaQuietMs?: unknown;
  maxParts?: unknown;
  maxChars?: unknown;
  maxAgeMs?: unknown;
};

export type ReadyInboxBatch = {
  update: TelegramQueueUpdate;
  updateIds: number[];
  // Время постановки головы пачки во входящие: в очередь чата пачка встаёт с ним,
  // иначе отсечка сброса отпустит сообщение, пришедшее до /new, но промотированное позже.
  arrivedAt: number;
  // Эпоха сброса головы пачки (null — запись без пометки): элемент очереди хранит
  // эпоху приёма, а не момент промоута, иначе старое пометилось бы новой границей.
  resetFence: number | null;
};

export type InboxAdmissionResult =
  "owned" | "terminal-drop" | "unownable" | "write-failed";

type InboxSender = { id?: string | number; is_bot?: boolean };

export function inboxKeyFor(
  update: TelegramQueueUpdate | null | undefined,
): string | null {
  const hasMessage = update?.message !== undefined;
  const hasCallback = update?.callback_query !== undefined;
  if (hasMessage === hasCallback) return null;
  if (hasMessage) return collectorKeyFor(update);
  const callback = update?.callback_query;
  const key = chatKey(update ?? {});
  if (key !== null) return `callback:${key}`;
  if (
    callback?.message !== undefined ||
    typeof callback?.inline_message_id !== "string" ||
    callback.inline_message_id.length === 0 ||
    callback.from?.id === undefined
  ) {
    return null;
  }
  const sender = createHash("sha256")
    .update("iva-telegram-inline-callback/v1\0")
    .update(String(callback.from.id))
    .digest("hex");
  return `callback:inline:${sender}`;
}

// Отброшенный апдейт обязан объяснить себя одной строкой: без имён полей «terminal
// ingress policy» одинаково выглядит и на чужом сообщении, и на новом поле Bot API,
// которое конверт ещё не знает. В журнале только имена: `iva logs poll` не несёт текста
// сообщения (CONTRIBUTING.md).
const LOG_FIELD_NAME = /^[a-z0-9_]+$/u;
const LOG_FIELD_LIMIT = 12;

export function terminalDropLine(update: TelegramQueueUpdate): string {
  const line = `drop update ${update.update_id} — terminal ingress policy`;
  const message: unknown = update.message;
  if (typeof message !== "object" || message === null || Array.isArray(message))
    return line;
  const keys = Object.keys(message)
    .filter((key) => LOG_FIELD_NAME.test(key))
    .sort()
    .slice(0, LOG_FIELD_LIMIT);
  return `${line}; message keys: ${JSON.stringify(keys)}`;
}

function senderPolicy(
  sender: InboxSender | undefined,
  allowedUserIds: ReadonlySet<string>,
): "allowed" | "terminal-drop" | "unownable" {
  if (sender?.id === undefined) return "unownable";
  if (allowedUserIds.size === 0 || sender.is_bot === true) {
    return "terminal-drop";
  }
  return allowedUserIds.has(String(sender.id)) ? "allowed" : "terminal-drop";
}

function admissionPolicy(
  update: TelegramQueueUpdate,
  allowedUserIds: ReadonlySet<string>,
  botUsername: unknown,
): { action: "own"; key: string } | { action: "terminal-drop" | "unownable" } {
  const hasMessage = update.message !== undefined;
  const hasCallback = update.callback_query !== undefined;
  if (hasMessage === hasCallback) return { action: "unownable" };
  if (
    hasCallback &&
    (typeof update.callback_query?.id !== "string" ||
      update.callback_query.id.length === 0)
  ) {
    return { action: "unownable" };
  }

  const sender = hasMessage
    ? update.message?.from
    : update.callback_query?.from;
  const senderDecision = senderPolicy(sender, allowedUserIds);
  if (senderDecision !== "allowed") return { action: senderDecision };

  const key = inboxKeyFor(update);
  if (key === null) return { action: "unownable" };
  if (
    hasMessage &&
    !shouldQueueBusyUpdate(update, { allowedUserIds, botUsername })
  ) {
    return { action: "terminal-drop" };
  }
  return { action: "own", key };
}

function isReadyInboxItem(
  key: string,
  item: TelegramQueueItem,
): item is TelegramQueueItem & {
  update: TelegramQueueUpdate;
  enqueuedAt: number;
} {
  return (
    isTelegramQueueUpdate(item.update) &&
    inboxKeyFor(item.update) === key &&
    typeof item.enqueuedAt === "number" &&
    Number.isFinite(item.enqueuedAt) &&
    item.enqueuedAt >= 0
  );
}

export function selectReadyInboxBatch(
  key: string,
  items: readonly TelegramQueueItem[],
  now: number,
  collectorOptions: InboxCollectorOptions = {},
): ReadyInboxBatch | null {
  const collector = createCollector(collectorOptions);
  const updateIds: number[] = [];
  let arrivedAt = 0;
  let resetFence: number | null = null;
  for (const item of items) {
    if (!isReadyInboxItem(key, item)) {
      throw new Error(`invalid durable Telegram inbox item ${item.updateId}`);
    }
    const update = item.update;
    if (updateIds.length === 0) {
      arrivedAt = item.enqueuedAt;
      resetFence = typeof item.resetFence === "number" ? item.resetFence : null;
    }
    updateIds.push(item.updateId);
    const offered = collectorOffer(collector, update, item.enqueuedAt);
    if (offered.status === "passthrough" || offered.status === "ready") {
      return {
        update: offered.update,
        updateIds: [...updateIds],
        arrivedAt,
        resetFence,
      };
    }
  }
  const [expired] = collectorTakeExpired(collector, now);
  return expired ? { update: expired, updateIds, arrivedAt, resetFence } : null;
}

// Пометка эпохи сброса при постановке: запись, принятая до durable-намерения
// /new, после успешного сброса не выживает — промоут отбрасывает чужую эпоху.
const admitFenceFields = (candidate: TelegramQueueUpdate) => {
  const key = chatKey(candidate);
  const epoch = key === null ? undefined : resetEpochFor(key);
  return epoch === undefined ? {} : { itemFields: { resetFence: epoch } };
};

export async function admitTelegramUpdate(
  update: TelegramQueueUpdate,
  {
    allowedUserIds = ALLOWED,
    botUsername = BOT_USERNAME,
    bot,
    trustedLocal = false,
    enqueueImpl = (key: string, candidate: TelegramQueueUpdate) =>
      enqueueQueueFile(TELEGRAM_INBOX_FILE, key, candidate, {
        strict: true,
        ...admitFenceFields(candidate),
      }),
    logImpl = log,
  }: {
    allowedUserIds?: ReadonlySet<string>;
    botUsername?: unknown;
    /** Бот, получивший апдейт; для коллеги вешает метку iva_bot_id и задаёт его username. */
    bot?: Pick<TelegramBotConfig, "botId" | "username" | "isPrimary">;
    /** Already-authorized local payload; bypasses external sender/group policy, never key validation. */
    trustedLocal?: boolean;
    enqueueImpl?: (
      key: string,
      candidate: TelegramQueueUpdate,
    ) => Promise<unknown>;
    logImpl?: (...parts: unknown[]) => void;
  } = {},
): Promise<InboxAdmissionResult> {
  const tagged = bot ? tagUpdateWithBot(update, bot) : update;
  const effectiveBotUsername = bot?.username ?? botUsername;
  const trustedKey = trustedLocal ? inboxKeyFor(tagged) : null;
  const decision = trustedLocal
    ? trustedKey === null
      ? { action: "unownable" as const }
      : { action: "own" as const, key: trustedKey }
    : admissionPolicy(tagged, allowedUserIds, effectiveBotUsername);
  // Trace: мост принял апдейт или отбросил его своей политикой — первое звено цепочки
  // хода, и пишется оно из ПРОЦЕССА МОСТА в тот же дневной файл (ADR-0010).
  if (decision.action !== "own") {
    traceBridgeAdmission(tagged, decision.action);
    return decision.action;
  }
  try {
    await enqueueImpl(decision.key, tagged);
    traceBridgeAdmission(tagged, "owned");
    return "owned";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logImpl(`inbox write failed for update ${tagged.update_id}:`, message);
    traceBridgeAdmission(tagged, "write-failed");
    return "write-failed";
  }
}

// inbox-ключ → ключ чата: «chat:thread:from» → «chat:thread»,
// «callback:chat:thread» → «chat:thread». У inline-колбэков чата нет, эпоха для
// них не определена — записи без пометки считаются свежими.
const inboxChatKey = (key: string) =>
  key.startsWith("callback:")
    ? key.slice("callback:".length)
    : key.slice(0, key.lastIndexOf(":"));

export async function promoteReadyInbox({
  now = Date.now,
  collectorOptions = {},
  loadImpl = async () =>
    (await loadQueueFile(TELEGRAM_INBOX_FILE, { strict: true })).document,
  routeImpl = routeMessageUpdate,
  acknowledgeImpl = (key: string, ids: readonly number[]) =>
    acknowledgeQueueItems(TELEGRAM_INBOX_FILE, key, ids, { strict: true }),
  quarantineImpl = (records: readonly DamagedQueueRecord[]) =>
    quarantineQueueRecords(TELEGRAM_INBOX_FILE, records, { logImpl: log }),
  backoff = inboxPromotionBackoff,
  resetEpochImpl = resetEpochFor,
}: {
  now?: () => number;
  collectorOptions?: InboxCollectorOptions;
  loadImpl?: () => Promise<
    Awaited<ReturnType<typeof loadQueueFile>>["document"]
  >;
  routeImpl?: (
    update: TelegramQueueUpdate,
    options?: { arrivedAt?: number; resetFence?: number | null },
  ) => Promise<RouteMessageResult>;
  acknowledgeImpl?: (key: string, ids: readonly number[]) => Promise<unknown>;
  quarantineImpl?: (records: readonly DamagedQueueRecord[]) => Promise<unknown>;
  backoff?: Map<string, InboxPromotionBackoff>;
  resetEpochImpl?: (chatKey: string) => number | undefined;
} = {}): Promise<number> {
  const snapshot = await loadImpl();
  for (const key of queueKeys(snapshot)) {
    const attemptAt = now();
    if (attemptAt < (backoff.get(key)?.nextAttemptAt ?? 0)) continue;
    // Запись, которую входящие не могут доставить, уходит в карантин и снимается, а не
    // роняет мост: падение здесь повторялось на каждом старте (16.10.2026).
    const items = snapshot.queues[key];
    const damaged = items.filter((item) => !isReadyInboxItem(key, item));
    if (damaged.length > 0) {
      await quarantineImpl(
        damaged.map((record) => ({
          chatKey: key,
          index: items.indexOf(record),
          reason: `invalid durable Telegram inbox item ${record.updateId}`,
          record,
        })),
      );
      await acknowledgeImpl(
        key,
        damaged.map((record) => record.updateId),
      );
    }
    const undamaged = items.filter((item) => !damaged.includes(item));
    // Записи до границы последнего /new мертвы: durable-владение снимает их до
    // склейки коллектора — в новый разговор ни пачкой, ни напрямую не попадают.
    // Пометка новее эпохи тоже живая: это наследие отменённого намерения, сброс
    // не состоялся, и терять такие сообщения нельзя. Запись без пометки доказывает
    // «после» только строго бо́льшим временем постановки: совпавшая миллисекунда
    // «до» и «после» не различает.
    const epoch = resetEpochImpl(inboxChatKey(key));
    const fresh = (item: TelegramQueueItem) =>
      epoch === undefined ||
      (item.resetFence !== undefined
        ? item.resetFence >= epoch
        : typeof item.enqueuedAt === "number" && item.enqueuedAt > epoch);
    const firstFresh = undamaged.findIndex(fresh);
    const droppable = undamaged.slice(
      0,
      firstFresh < 0 ? undamaged.length : firstFresh,
    );
    if (droppable.length > 0) {
      await acknowledgeImpl(
        key,
        droppable.map((item) => item.updateId),
      );
    }
    const batch = selectReadyInboxBatch(
      key,
      undamaged.filter(fresh),
      attemptAt,
      collectorOptions,
    );
    if (!batch) continue;
    const routed = await routeImpl(batch.update, {
      arrivedAt: batch.arrivedAt,
      resetFence: batch.resetFence,
    });
    // terminal-drop — исход, после которого повторять доставку нечем и незачем:
    // владение снимается ровно так же, как после принятого хода (issue #203).
    if (!["queued", "delivered", "terminal-drop", "dropped"].includes(routed)) {
      const failures = (backoff.get(key)?.failures ?? 0) + 1;
      backoff.set(key, {
        failures,
        nextAttemptAt: now() + Math.min(15_000 * 2 ** (failures - 1), 300_000),
      });
      continue;
    }
    backoff.delete(key);
    // Одна запись: остаток пачки после обрыва несёт её update_id и закрыл бы её целиком.
    await acknowledgeImpl(key, batch.updateIds);
  }
  const remaining = await loadImpl();
  return queueKeys(remaining).reduce(
    (count, key) =>
      now() < (backoff.get(key)?.nextAttemptAt ?? 0)
        ? count
        : count + queueCount(remaining, key),
    0,
  );
}
