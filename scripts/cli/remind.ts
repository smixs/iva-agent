// One Reminder, judged by an eve turn and delivered by the CLI. The command keeps every
// authored-tree import lazy so repair and doctor still load on a partial installation.
import { readEnvFresh } from "../lib/env-file.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import {
  reminderClientOptions,
  reminderPrompt,
  runReminderTurn,
} from "../lib/reminder-turn.ts";
import type {
  CreateClient,
  ReminderClientOptions,
  ReminderTurn,
} from "../lib/reminder-turn.ts";
import type { createCliRuntime } from "./runtime.ts";

export type {
  ReminderClientOptions,
  ReminderTurn,
} from "../lib/reminder-turn.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SendTelegramHtml =
  typeof import("../lib/telegram-send.ts").sendTelegramHtml;

type RunAgentTurn = (prompt: string) => Promise<ReminderTurn>;

export type RemindDependencies = {
  readonly createClient?: CreateClient;
  readonly readEnv?: typeof readEnvFresh;
  readonly send?: SendTelegramHtml;
  readonly runAgentTurn?: RunAgentTurn;
};

/** Куда отправлять: токен и чат владельца; без них напоминание некуда девать. */
function targetOf(env: NodeJS.ProcessEnv): {
  readonly token: string;
  readonly chat: string;
} {
  const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!token)
    throw new Error("TELEGRAM_BOT_TOKEN is missing — run: iva config");
  const chat = notificationChat(env);
  if (!chat)
    throw new Error(
      "No target chat — set TELEGRAM_DIGEST_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS in .env",
    );
  return { token, chat };
}

/** Причина, по которой от хода не пришло текста. */
function noTextCause(turn: ReminderTurn | undefined): string {
  if (turn?.status !== "failed") return `no text (status "${turn?.status}")`;
  return `status "failed"${turn.message ? `: ${turn.message}` : ""}`;
}

/**
 * Один ход агента по тексту разового напоминания. Провал хода не бросает наружу: код всё
 * равно отправит текст владельцу, а причину назовёт в журнале.
 */
async function runAgent(
  text: string,
  client: ReminderClientOptions,
  dependencies: RemindDependencies,
): Promise<{ readonly turn?: ReminderTurn; readonly message?: string }> {
  try {
    const { tr } = await import("#lib/i18n.ts");
    const prompt = reminderPrompt({ text }, tr);
    const runner =
      dependencies.runAgentTurn ??
      ((prompt: string) =>
        runReminderTurn(prompt, client, {
          createClient: dependencies.createClient,
        }));
    // Срока у хода нет (решение владельца 21.09.2026): он идёт, сколько нужно работе,
    // а кончают его тишина внутри хода или стоп из чата.
    const turn = await runner(prompt);
    if (turn.status !== "failed" && turn.message)
      return { turn, message: turn.message };
    console.error(`remind: agent turn failed: ${noTextCause(turn)}`);
    return { turn };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    console.error(`remind: agent turn failed: ${failure}`);
    return {};
  }
}

/** Итог подсказки: неудача — причина, а не молчание: вызывающий скажет о ней в журнале. */
type HintOutcome =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly error: string };

/** Подсказка о форматировании; её провал не валит уже доставленное напоминание. */
async function hintFormatting(
  turn: ReminderTurn | undefined,
  error: string,
): Promise<HintOutcome> {
  if (!turn?.feedback)
    return { delivered: false, error: "the turn has no session left" };
  try {
    await turn.feedback(
      `The last reminder failed Telegram parse_mode=HTML (${error}) and was sent as plain text — ` +
        "format more simply next time: **bold**, `code`, lists, no raw HTML.",
    );
    return { delivered: true };
  } catch (hintError) {
    return {
      delivered: false,
      error: hintError instanceof Error ? hintError.message : String(hintError),
    };
  }
}

/** Create the remind command without reading .env or touching eve at import time. */
export function createRemindCommand(
  runtime: CliRuntime,
  dependencies: RemindDependencies = {},
) {
  const { ENV_PATH, ok } = runtime;
  const readEnv = dependencies.readEnv ?? readEnvFresh;

  return async function cmdRemind(args: readonly string[] = []): Promise<void> {
    const text = args.join(" ").trim();
    if (!text) throw new Error("Nothing to send — usage: iva remind <text>");
    const env = await readEnv(ENV_PATH);
    const target = targetOf(env);

    const { turn, message: agentMessage } = await runAgent(
      text,
      reminderClientOptions(env, "reminder"),
      dependencies,
    );
    const message = agentMessage ?? `⏰ ${text}`;
    const send =
      dependencies.send ??
      (await import("../lib/telegram-send.ts")).sendTelegramHtml;
    const result = await send(target.token, target.chat, message, {
      retryTransient: true,
      rich: true,
    });
    if (!result.ok)
      throw new Error(`Reminder Telegram send failed: ${result.error}`);
    if (agentMessage !== undefined && result.fellBack) {
      const hint = await hintFormatting(turn, result.error);
      // Напоминание доставлено; не дошедшая подсказка видна в журнале и исход не меняет.
      if (!hint.delivered)
        console.error(`remind: formatting hint not delivered: ${hint.error}`);
    }
    ok("Reminder sent to Telegram");
  };
}
