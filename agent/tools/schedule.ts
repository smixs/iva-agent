import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { defineTool } from "eve/tools";
import { z } from "zod";
import remind from "./remind.ts";
import {
  add,
  list,
  remove,
  reschedule,
  commandFile,
  reminderFile,
  commandLog,
  clearCommandAlert,
  scheduleRunning,
  type Reminder,
} from "../lib/reminder-store.ts";
import { ownerTimeZone } from "../lib/reminder-time.ts";
import { planSchedule } from "../lib/reminder-refusal.ts";
import {
  describeReminder,
  schedulerStatus,
  toolFailure,
} from "../lib/reminder-tool.ts";

function scheduleView(row: Reminder, tz: string, command: boolean) {
  const status =
    row.firedAt === null
      ? null
      : row.error !== null
        ? "error"
        : row.delivered === null
          ? "unknown"
          : row.delivered
            ? "ok"
            : "error";
  return {
    ...describeReminder(row, tz),
    action_kind: command ? "command" : "prompt",
    last_status: scheduleRunning(row, Date.now(), command) ? "running" : status,
    ...(command
      ? { log: commandLog(row.id), timeout_minutes: row.timeout_minutes ?? 2 }
      : {}),
  };
}

function plannedSchedule(
  input: { at?: string; cron?: string },
  nowMs: number,
  tz: string,
  command = false,
) {
  if ((input.at === undefined) === (input.cron === undefined))
    throw new Error("Give exactly one of at or cron; e.g. at: in 30m");
  const planned = planSchedule(input, nowMs, tz, command);
  if ("refusal" in planned) throw new Error(planned.refusal);
  return planned;
}

export default defineTool({
  description:
    "Расписание: add, move, remove, list, run_now. Читай скилл scheduling. Текст будит Иву; command выполняется без модели. Время считает код, сообщи next_run_at.",
  inputSchema: z.object({
    action: z.enum(["add", "move", "remove", "list", "run_now"]),
    text: z.string().min(1).max(2000).optional(),
    command: z.string().min(1).max(2000).optional(),
    timeout_minutes: z.number().optional(),
    at: z
      .string()
      .min(1)
      .optional()
      .describe('Разовое: "in 30m", "14:30", дата или ISO в зоне владельца'),
    cron: z
      .string()
      .min(1)
      .optional()
      .describe("Повтор: 5 полей cron в зоне владельца"),
    id: z.string().min(1).optional(),
  }),
  async execute(input, ctx) {
    try {
      const nowMs = Date.now();
      const tz = ownerTimeZone();
      if (input.action === "list") {
        const prompts = await list();
        const commands = await list(commandFile());
        return {
          ok: true,
          schedules: [
            ...prompts.map((row) => scheduleView(row, tz, false)),
            ...commands.map((row) => scheduleView(row, tz, true)),
          ],
          scheduler: schedulerStatus(nowMs, tz),
        };
      }
      if (input.action === "add" && input.command === undefined) {
        if (input.timeout_minutes !== undefined)
          throw new Error("timeout_minutes requires command");
        return await remind.execute({ ...input, action: "add" }, ctx);
      }
      if (input.action === "add") {
        if (input.text !== undefined || !input.command?.trim())
          throw new Error("Give text OR command");
        const planned = plannedSchedule(input, nowMs, tz, true);
        const row = await add(
          {
            id: `c-${randomBytes(6).toString("hex")}`,
            text: input.command,
            timeout_minutes: input.timeout_minutes,
            ...planned,
          },
          { file: commandFile() },
        );
        return {
          ok: true,
          schedule: scheduleView(row, tz, true),
          next_run_at: scheduleView(row, tz, true).next_run_at,
          scheduler: schedulerStatus(nowMs, tz),
        };
      }
      if (!input.id) throw new Error("Give id from schedule list");
      const command = input.id.startsWith("c-");
      const file = command ? commandFile() : reminderFile();
      if (input.action === "remove") {
        const row = await remove(input.id, file);
        if (command) {
          rmSync(commandLog(row.id), { force: true });
          await clearCommandAlert(row.id);
        }
        return { ok: true, removed: { id: row.id, text: row.text } };
      }
      const planned =
        input.action === "move"
          ? plannedSchedule(input, nowMs, tz, command)
          : {};
      const row = await reschedule(
        input.id,
        { ...planned, nowMs, timeout_minutes: input.timeout_minutes },
        file,
      );
      return {
        ok: true,
        schedule: scheduleView(row, tz, command),
        next_run_at: scheduleView(row, tz, command).next_run_at,
        message: scheduleRunning(row, nowMs, command)
          ? "Задача сейчас выполняется, перенос применится после завершения."
          : undefined,
      };
    } catch (error) {
      return toolFailure(error);
    }
  },
});
