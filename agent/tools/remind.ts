import { randomBytes } from "node:crypto";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { notificationChat } from "../lib/notification-chat.ts";
import { ownerTimeZone } from "../lib/reminder-time.ts";
import {
  add,
  list,
  remove,
  ReminderNotFoundError,
  type ReminderChat,
} from "../lib/reminder-store.ts";
import {
  addFieldsRefusal,
  planSchedule,
  removeFieldsRefusal,
  unknownIdRefusal,
} from "../lib/reminder-refusal.ts";
import {
  chatOfTurn,
  describeReminder,
  schedulerStatus,
  toolFailure,
  type ReminderView,
  type SchedulerStatus,
} from "../lib/reminder-tool.ts";
import { formatZoned } from "../lib/zoned-time.ts";

export type RemindAdded = {
  readonly ok: true;
  readonly reminder: ReminderView;
  readonly now: string;
  readonly scheduler: SchedulerStatus;
};

export type RemindListed = {
  readonly ok: true;
  readonly count: number;
  readonly now: string;
  readonly timezone: string;
  readonly reminders: readonly ReminderView[];
  readonly scheduler: SchedulerStatus;
};

export type RemindRemoved = {
  readonly ok: true;
  readonly removed: { readonly id: string; readonly text: string };
};

export type RemindFailure = { readonly ok: false; readonly error: string };

export type RemindAnswer =
  RemindAdded | RemindListed | RemindRemoved | RemindFailure;

type Input = {
  readonly action: "add" | "list" | "remove";
  readonly text?: string;
  readonly at?: string;
  readonly cron?: string;
  readonly id?: string;
};

async function addReminder(
  input: Input,
  tz: string,
  nowMs: number,
  chat: ReminderChat | null,
): Promise<RemindAdded | RemindFailure> {
  const refusal = addFieldsRefusal(input, nowMs, tz);
  if (refusal !== null) return { ok: false as const, error: refusal };
  // Напоминание возвращается туда, где его попросили (чат и тема хода). Без Telegram-хода
  // остаётся чат владельца из настроек - и тогда он обязан быть.
  if (chat === null && !notificationChat(process.env))
    return {
      ok: false as const,
      error:
        "no owner chat: set TELEGRAM_DIGEST_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS",
    };
  const planned = planSchedule(input, nowMs, tz);
  if ("refusal" in planned)
    return { ok: false as const, error: planned.refusal };
  const row = await add({
    id: `r-${randomBytes(3).toString("hex")}`,
    // addFieldsRefusal пропускает только вызов с text.
    text: input.text ?? "",
    chat,
    ...planned,
  });
  return {
    ok: true as const,
    reminder: describeReminder(row, tz),
    now: formatZoned(nowMs, tz),
    scheduler: schedulerStatus(nowMs, tz),
  };
}

async function listReminders(tz: string, nowMs: number): Promise<RemindListed> {
  const rows = await list();
  return {
    ok: true as const,
    count: rows.length,
    now: formatZoned(nowMs, tz),
    timezone: tz,
    reminders: rows.map((row) => describeReminder(row, tz)),
    scheduler: schedulerStatus(nowMs, tz),
  };
}

async function removeReminder(
  input: Input,
): Promise<RemindRemoved | RemindFailure> {
  if (input.id === undefined)
    return { ok: false as const, error: removeFieldsRefusal(input) };
  try {
    const row = await remove(input.id);
    return { ok: true as const, removed: { id: row.id, text: row.text } };
  } catch (error) {
    if (!(error instanceof ReminderNotFoundError)) throw error;
    return { ok: false as const, error: unknownIdRefusal(input.id) };
  }
}

export default defineTool({
  description:
    "Текстовые напоминания: add (text, at или cron), list, remove (id). " +
    "Совместимый вход к schedule. Для переноса, run_now и команд используй schedule. " +
    "Читай скилл scheduling; время считает код, сообщи next_run_at.",
  inputSchema: z.object({
    action: z
      .enum(["add", "list", "remove"])
      .describe("Что сделать: поставить, показать список, снять"),
    text: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        "add: инструкция самой себе на срок словами пользователя - что сделать и о чём напомнить, самодостаточно",
      ),
    at: z
      .string()
      .min(1)
      .optional()
      .describe(
        'add, разовое: "in 30m", "in 1h 30m", "14:30", "2026-09-14 09:00" (в зоне пользователя) или ISO-момент со смещением',
      ),
    cron: z
      .string()
      .min(1)
      .optional()
      .describe(
        'add, повторяющееся: cron-выражение из 5 полей в зоне пользователя, например "0 9 * * 1-5"',
      ),
    id: z.string().min(1).optional().describe("remove: id из списка"),
  }),
  async execute(input, ctx): Promise<RemindAnswer> {
    const tz = ownerTimeZone();
    const nowMs = Date.now();
    try {
      switch (input.action) {
        case "add":
          return await addReminder(input, tz, nowMs, chatOfTurn(ctx));
        case "list":
          return await listReminders(tz, nowMs);
        case "remove":
          return await removeReminder(input);
      }
    } catch (error) {
      return toolFailure(error);
    }
  },
});
