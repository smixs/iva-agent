import { TELEGRAM_BUTTON_TAP_FIELD } from "#lib/telegram-parts.ts";
import type {
  TelegramQueueMessage,
  TelegramQueueUpdate,
} from "./telegram-queue.ts";
import { isSafeInteger } from "../../packages/guards/index.ts";

export const COLLECT_QUIET_MS = 800;
export const COLLECT_MEDIA_QUIET_MS = 1500;
export const COLLECT_MAX_PARTS = 20;
export const COLLECT_MAX_CHARS = 50_000;
export const COLLECT_MAX_AGE_MS = 10_000;

export type TelegramCollectMessage = TelegramQueueMessage;
export type TelegramCollectUpdate = TelegramQueueUpdate;

interface CollectorOptions {
  quietMs?: unknown;
  mediaQuietMs?: unknown;
  maxParts?: unknown;
  maxChars?: unknown;
  maxAgeMs?: unknown;
}

interface CollectorEntry {
  updates: TelegramCollectUpdate[];
  chars: number;
  firstAt: number;
  lastAt: number;
}

export interface TelegramCollector {
  entries: Map<string, CollectorEntry>;
  quietMs: number;
  mediaQuietMs: number;
  maxParts: number;
  maxChars: number;
  maxAgeMs: number;
}

export type CollectorOfferResult =
  | { status: "passthrough"; update: TelegramCollectUpdate }
  | { status: "buffered" }
  | { status: "ready"; update: TelegramCollectUpdate };

function finiteNonNegative(value: unknown, fallback: number) {
  return Number.isFinite(value) && (value as number) >= 0
    ? (value as number)
    : fallback;
}

function finitePositiveInteger(value: unknown, fallback: number) {
  return isSafeInteger(value) && value > 0 ? value : fallback;
}

export function createCollector(
  options: CollectorOptions = {},
): TelegramCollector {
  return {
    entries: new Map(),
    quietMs: finiteNonNegative(options.quietMs, COLLECT_QUIET_MS),
    mediaQuietMs: finiteNonNegative(
      options.mediaQuietMs,
      COLLECT_MEDIA_QUIET_MS,
    ),
    maxParts: finitePositiveInteger(options.maxParts, COLLECT_MAX_PARTS),
    maxChars: finitePositiveInteger(options.maxChars, COLLECT_MAX_CHARS),
    maxAgeMs: finiteNonNegative(options.maxAgeMs, COLLECT_MAX_AGE_MS),
  };
}

export function collectorKeyFor(
  update: TelegramCollectUpdate | null | undefined,
) {
  const message = update?.message;
  const chatId = message?.chat?.id;
  const fromId = message?.from?.id;
  if (chatId === undefined || fromId === undefined) return null;
  return `${chatId}:${message!.message_thread_id ?? ""}:${fromId}`;
}

function messageChars(message: TelegramCollectMessage | undefined) {
  return (
    (typeof message?.text === "string" ? message.text.length : 0) +
    (typeof message?.caption === "string" ? message.caption.length : 0)
  );
}

function flatParts(message: TelegramCollectMessage): TelegramCollectMessage[] {
  const { iva_parts: nested, ...self } = message;
  const parts = Array.isArray(nested)
    ? nested
        .filter((part) => typeof part === "object" && part !== null)
        .flatMap(flatParts)
    : [];
  if (parts.length) return parts;
  // Пустые или битые части: часть — само сообщение, без своего iva_parts.
  return Object.hasOwn(message, "iva_parts") ? [self] : [message];
}

/** Части апдейта плоским списком: склейка входа несёт их в iva_parts, одиночное сообщение — само. */
export function updateParts(
  update: TelegramCollectUpdate,
): TelegramCollectMessage[] {
  return update.message ? flatParts(update.message) : [];
}

/** Отдельной доставкой идёт то, чей смысл держится на «первое и единственное» (ADR-0011). */
export function deliveredAlone(update: TelegramCollectUpdate): boolean {
  if (update.message?.from?.id === undefined || update.update_id < 0)
    return true;
  return updateParts(update).some(
    (part) =>
      [part.text, part.caption].some(
        (value) => typeof value === "string" && value.trim().startsWith("/"),
      ) ||
      part.reply_to_message !== undefined ||
      part[TELEGRAM_BUTTON_TAP_FIELD] === true,
  );
}

/** Сколько элементов с головы очереди уходят одной пачкой; 0 — для пустого списка. */
export function queueBatchLength(
  updates: readonly TelegramCollectUpdate[],
  {
    maxParts = COLLECT_MAX_PARTS,
    maxChars = COLLECT_MAX_CHARS,
  }: { maxParts?: number; maxChars?: number } = {},
): number {
  const [head] = updates;
  if (head === undefined) return 0;
  if (deliveredAlone(head)) return 1;
  const author = String(head.message?.from?.id);
  let [parts, chars] = [0, 0];
  // Голова идёт всегда; дальше пропусков нет: первый одиночный, чужой или не влезший кончает пачку.
  const stop = updates.findIndex((next, index) => {
    const nextParts = updateParts(next);
    parts += nextParts.length;
    chars += nextParts.reduce((sum, part) => sum + messageChars(part), 0);
    return (
      index > 0 &&
      (deliveredAlone(next) ||
        String(next.message?.from?.id) !== author ||
        parts > maxParts ||
        chars > maxChars)
    );
  });
  return stop < 0 ? updates.length : stop;
}

/** Склейка без пересортировки: части по порядку списка, носитель — первый, update_id — последний. */
export function joinUpdates(
  updates: readonly TelegramCollectUpdate[],
): TelegramCollectUpdate {
  const [first] = updates;
  if (first === undefined)
    throw new Error("joinUpdates needs at least one update");
  if (updates.length === 1) return first;
  return {
    ...first,
    update_id: updates[updates.length - 1].update_id,
    message: { ...first.message, iva_parts: updates.flatMap(updateParts) },
  };
}

function mergeParts(updates: TelegramCollectUpdate[]): TelegramCollectUpdate {
  if (updates.length === 1) return updates[0];

  const ordered = updates
    .map((update, index) => ({ update, index }))
    .sort((a, b) => {
      const aId = a.update.message?.message_id;
      const bId = b.update.message?.message_id;
      if (isSafeInteger(aId) && isSafeInteger(bId) && aId !== bId) {
        return aId - bId;
      }
      return a.index - b.index;
    })
    .map(({ update }) => update);
  const updateId = ordered.reduce(
    (max, update) =>
      isSafeInteger(update.update_id) ? Math.max(max, update.update_id) : max,
    Number.MIN_SAFE_INTEGER,
  );

  return { ...joinUpdates(ordered), update_id: updateId };
}

function entryQuietMs(collector: TelegramCollector, entry: CollectorEntry) {
  const last = entry.updates.at(-1)?.message;
  return last?.media_group_id === undefined
    ? collector.quietMs
    : collector.mediaQuietMs;
}

export function collectorOffer(
  collector: TelegramCollector,
  update: TelegramCollectUpdate,
  now: number,
): CollectorOfferResult {
  const key = collectorKeyFor(update);
  if (collector.quietMs === 0 || key === null) {
    return { status: "passthrough", update };
  }

  const existing = collector.entries.get(key);
  const entry = existing ?? {
    updates: [],
    chars: 0,
    firstAt: now,
    lastAt: now,
  };
  entry.updates.push(update);
  entry.chars += messageChars(update.message);
  entry.lastAt = now;
  collector.entries.set(key, entry);

  const capped =
    entry.updates.length >= collector.maxParts ||
    entry.chars >= collector.maxChars ||
    now - entry.firstAt >= collector.maxAgeMs;
  if (!capped) return { status: "buffered" };

  collector.entries.delete(key);
  return { status: "ready", update: mergeParts(entry.updates) };
}

export function collectorTakeExpired(
  collector: TelegramCollector,
  now: number,
) {
  const ready: TelegramCollectUpdate[] = [];
  for (const [key, entry] of collector.entries) {
    if (
      now - entry.lastAt < entryQuietMs(collector, entry) &&
      now - entry.firstAt < collector.maxAgeMs
    ) {
      continue;
    }
    collector.entries.delete(key);
    ready.push(mergeParts(entry.updates));
  }
  return ready;
}

export function collectorPending(collector: TelegramCollector) {
  return collector.entries.size;
}
