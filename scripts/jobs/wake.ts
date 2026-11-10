// Точка входа пробуждения после запуска расписания:
// `node --env-file-if-exists=.env scripts/jobs/wake.ts <name> <startedAt>`.
// Запускает её schedule-runner (agent/lib/schedule-runner.ts) после каждого запуска.
// Ход агента идёт через тот же шлюз, что у напоминаний (scripts/lib/reminder-turn.ts),
// а ответ уходит владельцу кодом только если он непустой — в личный чат: в нём кнопка
// «Починить», а тап кнопки принимается только в личном чате.
import { join } from "node:path";
import { dataDir } from "#lib/data-dir.ts";
import { jobFactsFile } from "#lib/job-facts.ts";
import { failureWaitsForBrief, parseProactive } from "#lib/proactive-config.ts";
import { readSettings } from "#lib/settings.ts";
import { zonedParts } from "#lib/zoned-time.ts";
import { resolveTimeZone } from "../lib/timezone.ts";
import { ownerChat } from "../../packages/notification-chat/index.ts";
import { noticeTranslator } from "../lib/notice-policy.ts";
import { runJobWake, type JobWakeDeps } from "../lib/job-wake.ts";
import {
  reminderClientOptions,
  runReminderTurn,
} from "../lib/reminder-turn.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";
import { isEntrypoint } from "../lib/version-layout.ts";

const stamped = (...args: unknown[]) =>
  console.log(new Date().toISOString(), ...args);

/** Швы для теста: ход, отправка, часы, журнал. */
export type WakeMainDeps = {
  readonly runTurn?: JobWakeDeps["runTurn"];
  readonly sendHtml?: typeof sendTelegramHtml;
  readonly now?: () => number;
  readonly log?: (...args: unknown[]) => void;
};

/** Ход, отправка в личный чат владельца и «тихо ли сейчас» для runJobWake. */
async function wakeDeps(
  env: NodeJS.ProcessEnv,
  deps: WakeMainDeps,
): Promise<Omit<JobWakeDeps, "factsFile">> {
  const log = deps.log ?? stamped;
  const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chat = ownerChat(env);
  const config = parseProactive(readSettings(join(dataDir(), "settings.json")));
  const timeZone = resolveTimeZone(env.ASSISTANT_TIMEZONE);
  const sendHtml = deps.sendHtml ?? sendTelegramHtml;
  const runTurn: JobWakeDeps["runTurn"] = (prompt) =>
    runReminderTurn(prompt, reminderClientOptions(env, "alert"), { log });
  return {
    quiet: (now) => failureWaitsForBrief(config, zonedParts(now, timeZone).hh),
    tr: await noticeTranslator(env),
    runTurn: deps.runTurn ?? runTurn,
    send: async (text) => {
      if (!token || !chat)
        throw new Error(
          "TELEGRAM_BOT_TOKEN or TELEGRAM_ALLOWED_USER_IDS is missing — run: iva doctor",
        );
      // rich: кнопка «Починить» доходит кнопкой, а не текстом (без неё sendTelegramHtml шлёт HTML).
      const result = await sendHtml(token, chat, text, { rich: true });
      return result.ok;
    },
    ...(deps.now ? { now: deps.now } : {}),
    log,
  };
}

/** Один прогон; возвращает код выхода: 1 — ход не состоялся, 2 — неверные аргументы. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: WakeMainDeps = {},
): Promise<number> {
  const name = (argv[0] ?? "").trim();
  const startedAt = Number.parseInt(argv[1] ?? "", 10);
  if (name === "" || !Number.isSafeInteger(startedAt)) {
    console.error("usage: wake.ts <name> <startedAt>");
    return 2;
  }
  const status = await runJobWake(name, startedAt, {
    factsFile: jobFactsFile(dataDir()),
    ...(await wakeDeps(env, deps)),
  });
  console.log(`wake: ${name} ${status}`);
  return status === "failed" ? 1 : 0;
}

if (isEntrypoint(import.meta.url))
  process.exit(
    await main().catch((error: unknown) => {
      console.error(
        `wake: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }),
  );
