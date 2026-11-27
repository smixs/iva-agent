// Проводные константы и лёгкие хелперы приёмки Telegram, нужные процессу Bridge
// (`scripts/poller/*`) без импорта серверного канала, `colleague-assignments.ts` и `outbox.ts`.
import { randomBytes } from "node:crypto";
import type { TurnPolicy } from "eve/channels";
import { readSettings } from "./settings.ts";
import { TELEGRAM_QUEUE_RECEIPT_FIELD } from "./telegram-parts.ts";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const TELEGRAM_ACCEPTANCE_ROUTE = "/eve/v1/telegram/accepted";
export const TELEGRAM_ACCEPTANCE_KIND_HEADER = "x-iva-telegram-acceptance";
// Ответ на сообщение закрытой сессии нельзя доставить как input response.
// Bridge узнаёт этот класс по заголовку и хоронит апдейт вместо ретрая.
export const TELEGRAM_CLOSED_SESSION_KIND = "closed-session";

const RECEIPT_PATTERN = /^[a-f0-9]{32}$/u;

export function validReceipt(value: unknown): value is string {
  return typeof value === "string" && RECEIPT_PATTERN.test(value);
}

export function telegramTurnPolicy(
  settings: Record<string, unknown> = readSettings(),
): TurnPolicy {
  return settings.turnPolicy === "steer" ? "steer" : "queue";
}

export function addTelegramQueueReceipt<T extends Record<string, unknown>>(
  update: T,
  receipt = randomBytes(16).toString("hex"),
): T {
  if (
    !isObjectRecord(update) ||
    !isObjectRecord(update.message) ||
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
