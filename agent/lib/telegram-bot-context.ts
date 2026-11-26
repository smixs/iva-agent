// Контекст активного Telegram-бота в процессе Channel (ADR-0030):
// позволяет одному процессу eve отвечать от имени того бота, которому пришло сообщение,
// без правки eve/ (credentials.botToken в eve принимает динамическую функцию).
import { AsyncLocalStorage } from "node:async_hooks";
import {
  resolveTelegramBot,
  validTelegramBotId,
  type TelegramBotConfig,
} from "../../packages/telegram-bots/index.ts";

const botContext = new AsyncLocalStorage<TelegramBotConfig>();

/** Выполняет функцию с активным ботом в AsyncLocalStorage (пробрасывается в Promise и таймеры). */
export function withTelegramBot<T>(bot: TelegramBotConfig, fn: () => T): T {
  return botContext.run(bot, fn);
}

/** Текущий активный бот из контекста хода/вебхука, либо основной бот Ивы из окружения. */
export function activeTelegramBot(
  env: NodeJS.ProcessEnv = process.env,
): TelegramBotConfig | null {
  return botContext.getStore() ?? resolveTelegramBot(null, env);
}

/** Токен активного бота для вызовов Bot API; бросает, если токен не задан (контракт eve). */
export function activeTelegramBotToken(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const token = activeTelegramBot(env)?.token;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required.");
  return token;
}

/** Числовой id бота-коллеги, либо null для основного бота Ивы (его ключи не префиксуются). */
export function colleagueBotIdOf(
  bot: TelegramBotConfig | null | undefined,
): string | null {
  return bot && !bot.isPrimary && validTelegramBotId(bot.botId)
    ? bot.botId
    : null;
}

/** Восстанавливает конфиг бота из персистентного состояния сессии eve (`channel.state`). */
export function botFromChannelState(
  state: unknown,
  env: NodeJS.ProcessEnv = process.env,
): TelegramBotConfig | null {
  const rawBotId =
    typeof state === "object" && state !== null && "botId" in state
      ? (state as { botId?: unknown }).botId
      : undefined;
  if (validTelegramBotId(rawBotId)) {
    return resolveTelegramBot(rawBotId, env);
  }
  return resolveTelegramBot(null, env);
}

/** Числовой id коллеги из `channel.state`, либо null для основного бота Ивы. */
export function colleagueBotIdFromState(
  state: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return colleagueBotIdOf(botFromChannelState(state, env));
}
