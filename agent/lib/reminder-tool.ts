// Общее для действий тула напоминаний: строка напоминания для модели и признак того, что
// диспетчер жив. Читает таблицу и пульс тика, ничего не решает сам.
import {
  reminderPhase,
  type Reminder,
  type ReminderChat,
  type ReminderPhase,
} from "./reminder-store.ts";
import { readTickPulse, REMINDER_TICK_STALE_MS } from "./reminder-tick.ts";
import { formatZoned } from "./zoned-time.ts";

export interface ReminderView {
  readonly id: string;
  readonly text: string;
  readonly kind: "at" | "cron";
  readonly cron?: string;
  readonly next_run_at: string;
  readonly timezone: string;
  /** Фаза последнего срабатывания словом; следующий срок — в next_run_at. */
  readonly phase: ReminderPhase;
  /** Когда сработало в последний раз; null — ещё не срабатывало. */
  readonly fired_at: string | null;
  /** Дошёл ли текст до чата: true/false, null — факта ещё нет. */
  readonly delivered: boolean | null;
  readonly error: string | null;
}

/**
 * Чат и тема текущего хода из auth-контекста eve: мост Telegram кладёт их в атрибуты
 * (`chat_id`, `message_thread_id`, agent/lib/telegram-inbound.ts). Ход не из Telegram
 * (CLI, расписание) - null: тогда напоминание идёт в чат владельца из настроек.
 */
export function chatOfTurn(ctx: {
  readonly session?: {
    readonly auth?: {
      readonly current?: { readonly attributes?: unknown } | null;
    };
  };
}): ReminderChat | null {
  const attributes = ctx.session?.auth?.current?.attributes;
  if (attributes === null || typeof attributes !== "object") return null;
  const { chat_id: id, message_thread_id: thread } = attributes as Record<
    string,
    unknown
  >;
  if (typeof id !== "string" || id.trim() === "") return null;
  return {
    id,
    threadId: typeof thread === "string" && thread !== "" ? thread : null,
  };
}

export function describeReminder(
  row: Reminder,
  tz: string,
  command = false,
): ReminderView {
  return {
    id: row.id,
    text: row.text,
    kind: row.schedule.kind,
    ...(row.schedule.kind === "cron" ? { cron: row.schedule.expr } : {}),
    next_run_at: formatZoned(row.nextRunAtMs, tz),
    timezone: tz,
    phase: reminderPhase(row, Date.now(), command),
    fired_at: row.firedAt === null ? null : formatZoned(row.firedAt, tz),
    delivered: row.delivered,
    error: row.error,
  };
}

export interface SchedulerStatus {
  readonly alive: boolean;
  readonly last_tick_at: string | null;
  readonly warning?: string;
}

/**
 * Жив ли минутный диспетчер по пульсу (mtime data/reminders.tick). Пульса нет — диспетчер
 * ещё не проходил; пульс старше трёх минут — не бьётся. Это не повод не ставить
 * напоминание, но и не повод молчать: наружу идёт warning, а не исключение.
 */
export function schedulerStatus(nowMs: number, tz: string): SchedulerStatus {
  const pulse = readTickPulse();
  if (pulse === null)
    return {
      alive: false,
      last_tick_at: null,
      warning:
        "the reminders dispatcher has not ticked yet on this server; the reminder is stored and fires once it runs - tell the user",
    };
  const lastTickAt = formatZoned(pulse, tz);
  if (nowMs - pulse <= REMINDER_TICK_STALE_MS)
    return { alive: true, last_tick_at: lastTickAt };
  return {
    alive: false,
    last_tick_at: lastTickAt,
    warning: `the reminders dispatcher has not ticked since ${lastTickAt}; the reminder is stored but will not fire until Iva restarts - tell the user`,
  };
}

/** Ошибка тула: модель читает `error`, ход не падает. */
export function toolFailure(error: unknown): {
  readonly ok: false;
  readonly error: string;
} {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
