// Подключение к локальному telegram-userbot прокси (services/telegram-userbot/serve.py):
// личный Telegram-аккаунт владельца через Telethon (userbot). Прокси — единственный
// владелец сессии, живёт как systemd-сервис на 127.0.0.1. Тулы видны модели как
// connection__telegram-userbot__<tool> и находятся через connection_search.
//
// Онбординг (QR-логин) и правила безопасности — в скилле telegram-userbot.
// URL/токен модель НЕ видит: они на стороне рантайма.
import { defineMcpClientConnection } from "eve/connections";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "#lib/data-dir.ts";

const port = process.env.TELEGRAM_MCP_PORT ?? "8724";

// Аргументы инструментов этого подключения, которые несут секрет: пароль двухфакторной
// защиты в qr_login_password. Trace пишет вызов с меткой на месте значения
// (agent/hooks/trace.ts). Сообщение владельца с тем же паролем — его собственный текст,
// и сюда не относится (docs/userbot.md).
export const SECRET_ARGUMENTS: readonly string[] = ["password"];

// Токен пишет `iva userbot setup` в data/telegram-userbot.token (тот же файл читает прокси).
// Читаем при КАЖДОМ вызове (getToken), а не на старте: iva не нужно перезапускать после
// того, как агент поднял прокси и создал токен — Eve и так ретраит соединение.
function proxyToken(): string {
  if (process.env.TELEGRAM_MCP_TOKEN) return process.env.TELEGRAM_MCP_TOKEN;
  try {
    return readFileSync(
      join(dataDir(), "telegram-userbot.token"),
      "utf8",
    ).trim();
  } catch {
    return "";
  }
}

export default defineMcpClientConnection({
  url: `http://127.0.0.1:${port}/mcp`,
  description:
    "Личный Telegram владельца (userbot, НЕ бот-аккаунт): читать диалоги/историю/поиск " +
    "и отправлять сообщения от его имени. Требует подключения аккаунта через QR " +
    "(скилл telegram-userbot). Соблюдай анти-бан правила из скилла.",
  auth: {
    getToken: () => Promise.resolve({ token: proxyToken() }),
  },
});
