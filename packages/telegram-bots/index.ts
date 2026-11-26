// Общий реестр Telegram-ботов установки (основной бот Ивы + боты коллег, ADR-0030).
// Один источник правды для Authored tree (`agent/`) и Bridge (`scripts/poller/`), поэтому
// живёт в `packages/` (RUNTIME_SOURCE_TREES в scripts/lib/custom-layer.ts).
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/** Поле конверта Telegram-апдейта и сообщения, несущее числовой id бота-коллеги. */
export const TELEGRAM_BOT_ID_FIELD = "iva_bot_id";

/**
 * Доверенное внутреннее поле конверта сообщения, которым Channel помечает входящее
 * сообщение от другого бота этой же установки (can_communicate_with_bots, ADR-0030).
 * Любое внешнее значение этого поля сбрасывается на входе до проверки отправителя.
 */
export const TELEGRAM_PEER_BOT_FROM_FIELD = "iva_peer_bot_from";

export interface PeerBotOrigin {
  readonly botId: string;
  readonly username?: string;
}

/** HTTP-заголовок между Bridge и Channel с числовым id бота-адресата. */
export const TELEGRAM_BOT_ID_HEADER = "x-iva-telegram-bot-id";

export interface TelegramBotConfig {
  /** Числовой id бота из префикса токена (`<id>:<secret>`), либо null для нестандартного тестового токена. */
  readonly botId: string | null;
  readonly token: string;
  readonly username?: string;
  readonly isPrimary: boolean;
}

const BOT_TOKEN_PATTERN = /^(?<id>[1-9]\d*):(?<secret>\S+)$/u;
const VALID_BOT_ID_PATTERN = /^[1-9]\d*$/u;
const VALID_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/u;
const BOT_SCOPED_KEY_PATTERN = /^bot:(?<botId>[1-9]\d*):(?<key>.*)$/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Проверяет, что значение — допустимый числовой id Telegram-бота. */
export function validTelegramBotId(value: unknown): value is string {
  return typeof value === "string" && VALID_BOT_ID_PATTERN.test(value);
}

/** Извлекает числовой id бота из токена Bot API `<id>:<secret>`, либо null. */
export function botIdFromToken(token: string | undefined): string | null {
  if (typeof token !== "string") return null;
  return BOT_TOKEN_PATTERN.exec(token.trim())?.groups?.id ?? null;
}

function normalizeUsername(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.trim().replace(/^@/u, "");
  return VALID_USERNAME_PATTERN.test(cleaned) ? cleaned : undefined;
}

/**
 * Разбирает `TELEGRAM_COLLEAGUE_BOT_TOKENS`: записи через запятую или пробел,
 * каждая — `<token>` или `<username>=<token>`. Повторы id и битые записи отбрасываются
 * без падения основного бота.
 */
export function parseColleagueBotTokens(
  raw: string | undefined,
  primaryBotId: string | null = null,
): TelegramBotConfig[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  const seen = new Set<string>(primaryBotId ? [primaryBotId] : []);
  const bots: TelegramBotConfig[] = [];

  for (const part of raw.split(/[,\s]+/u)) {
    const entry = part.trim();
    if (entry.length === 0) continue;
    const eq = entry.indexOf("=");
    const rawUsername = eq > 0 ? entry.slice(0, eq) : undefined;
    const token = (eq >= 0 ? entry.slice(eq + 1) : entry).trim();
    const botId = botIdFromToken(token);
    if (botId === null || seen.has(botId)) continue;
    seen.add(botId);
    const username = normalizeUsername(rawUsername);
    bots.push({
      botId,
      token,
      ...(username === undefined ? {} : { username }),
      isPrimary: false,
    });
  }
  return bots;
}

/** Все настроенные боты установки: первым идёт основной бот Ивы, затем уникальные коллеги. */
export function configuredTelegramBots(
  env: NodeJS.ProcessEnv = process.env,
): TelegramBotConfig[] {
  const primaryToken = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const bots: TelegramBotConfig[] = [];
  let primaryBotId: string | null = null;

  if (primaryToken.length > 0) {
    primaryBotId = botIdFromToken(primaryToken);
    const username = normalizeUsername(env.TELEGRAM_BOT_USERNAME);
    bots.push({
      botId: primaryBotId,
      token: primaryToken,
      ...(username === undefined ? {} : { username }),
      isPrimary: true,
    });
  }

  bots.push(
    ...parseColleagueBotTokens(env.TELEGRAM_COLLEAGUE_BOT_TOKENS, primaryBotId),
  );
  return bots;
}

/**
 * Разрешает бота по числовому id. Пустой `botId` возвращает основного бота Ивы;
 * явно переданный неизвестный или невалидный `botId` возвращает null (fail-closed).
 */
export function resolveTelegramBot(
  botId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TelegramBotConfig | null {
  const bots = configuredTelegramBots(env);
  if (botId === null || botId === undefined || botId === "") {
    return bots.find((bot) => bot.isPrimary) ?? null;
  }
  if (!validTelegramBotId(botId)) return null;
  return bots.find((bot) => bot.botId === botId) ?? null;
}

/** Уникальные токены всех настроенных ботов — для outbound-Gate и проверки вложений. */
export function allTelegramBotTokens(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [...new Set(configuredTelegramBots(env).map((bot) => bot.token))];
}

/** Множество числовых id всех настроенных ботов этой установки (Ива + коллеги). */
export function configuredTelegramBotIds(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const bot of configuredTelegramBots(env)) {
    if (bot.botId !== null) ids.add(bot.botId);
  }
  return ids;
}

/**
 * Проверяет, что отправитель — другой настроенный бот этой же установки (не чужой бот
 * и не сам получатель). Возвращает конфиг бота-отправителя или null.
 */
export function isConfiguredPeerBot(
  senderId: string | number | null | undefined,
  receiverBotId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TelegramBotConfig | null {
  if (senderId === null || senderId === undefined) return null;
  const normalized = String(senderId).trim();
  if (!validTelegramBotId(normalized)) return null;
  if (validTelegramBotId(receiverBotId) && normalized === receiverBotId) {
    return null;
  }
  return (
    configuredTelegramBots(env).find((bot) => bot.botId === normalized) ?? null
  );
}

/** Разбирает внутреннюю пометку отправителя-бота из `iva_peer_bot_from`. */
export function parsePeerBotOrigin(value: unknown): PeerBotOrigin | null {
  if (!isPlainRecord(value) || !validTelegramBotId(value.botId)) return null;
  const username = normalizeUsername(
    typeof value.username === "string" ? value.username : undefined,
  );
  return username === undefined
    ? { botId: value.botId }
    : { botId: value.botId, username };
}

/**
 * Общий ключ координации очереди ответов разных ботов в одной группе/супергруппе
 * (`specs/GroupAndAssignments.tla`: в группе одновременно идёт ход не более одного бота).
 * Для личных чатов (`chatId > 0`) возвращает null — лички ботов друг друга не блокируют.
 */
export function groupCoordKeyOf(chatKey: string): string | null {
  const { key } = parseBotScopedKey(chatKey);
  const colon = key.indexOf(":");
  if (colon <= 0) return null;
  const chatId = key.slice(0, colon);
  if (!/^-\d+$/u.test(chatId)) return null;
  const threadId = key.slice(colon + 1);
  if (threadId !== "" && !/^\d+$/u.test(threadId)) return null;
  return `group:${chatId}:${threadId}`;
}

/**
 * Добавляет префикс `bot:<id>:` к ключу чата/сессии коллеги.
 * Для основного бота ключ не меняется, сохраняя полную совместимость без коллег.
 */
export function botScopedKey(
  key: string,
  botId: string | null | undefined,
  primaryBotId: string | null = null,
): string {
  if (!validTelegramBotId(botId) || (primaryBotId && botId === primaryBotId)) {
    return key;
  }
  if (BOT_SCOPED_KEY_PATTERN.test(key)) return key;
  return `bot:${botId}:${key}`;
}

/** Снимает префикс `bot:<id>:` с ключа, возвращая `{ botId, key }`. */
export function parseBotScopedKey(scopedKey: string): {
  readonly botId: string | null;
  readonly key: string;
} {
  const match = BOT_SCOPED_KEY_PATTERN.exec(scopedKey);
  if (!match?.groups) return { botId: null, key: scopedKey };
  return { botId: match.groups.botId, key: match.groups.key };
}

/** Читает пометку `iva_bot_id` с апдейта или его вложенного сообщения. */
export function botIdFromUpdate(update: unknown): string | null {
  if (!isPlainRecord(update)) return null;
  const direct = update[TELEGRAM_BOT_ID_FIELD];
  if (validTelegramBotId(direct)) return direct;
  if (isPlainRecord(update.message)) {
    const fromMessage = update.message[TELEGRAM_BOT_ID_FIELD];
    if (validTelegramBotId(fromMessage)) return fromMessage;
  }
  if (
    isPlainRecord(update.callback_query) &&
    isPlainRecord(update.callback_query.message)
  ) {
    const fromCallback = update.callback_query.message[TELEGRAM_BOT_ID_FIELD];
    if (validTelegramBotId(fromCallback)) return fromCallback;
  }
  if (isPlainRecord(update.stopped_message_generation)) {
    const fromStop = update.stopped_message_generation[TELEGRAM_BOT_ID_FIELD];
    if (validTelegramBotId(fromStop)) return fromStop;
  }
  return null;
}

/**
 * Помечает апдейт числовым id бота-коллеги (на верхнем уровне и на вложенном сообщении,
 * чтобы пометка переживала durable-очередь Bridge и доходила до `message.raw` в Channel).
 * Основной бот возвращается без изменений.
 */
export function tagUpdateWithBot<T extends Record<string, unknown>>(
  update: T,
  bot: Pick<TelegramBotConfig, "botId" | "isPrimary">,
): T {
  if (bot.isPrimary || !validTelegramBotId(bot.botId)) return update;
  const botId = bot.botId;
  const tagged: Record<string, unknown> = {
    ...update,
    [TELEGRAM_BOT_ID_FIELD]: botId,
  };
  if (isPlainRecord(update.message)) {
    tagged.message = { ...update.message, [TELEGRAM_BOT_ID_FIELD]: botId };
  }
  if (isPlainRecord(update.callback_query)) {
    const cb = update.callback_query;
    tagged.callback_query = isPlainRecord(cb.message)
      ? {
          ...cb,
          message: { ...cb.message, [TELEGRAM_BOT_ID_FIELD]: botId },
        }
      : { ...cb };
  }
  if (isPlainRecord(update.stopped_message_generation)) {
    tagged.stopped_message_generation = {
      ...update.stopped_message_generation,
      [TELEGRAM_BOT_ID_FIELD]: botId,
    };
  }
  return tagged as T;
}

const MANAGED_BOT_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{4,31}$/u;
const MANAGED_BOT_SUFFIX_PATTERN = /bot$/iu;
const SAFE_ENV_TOKEN_PATTERN = /^[1-9]\d*:[A-Za-z0-9_-]{8,128}$/u;

/** Проверяет, подходит ли имя пользователя как Telegram-ник бота (5..32, латиница/цифры/_, оканчивается на bot). */
export function isManagedBotUsername(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return (
    MANAGED_BOT_USERNAME_PATTERN.test(value) &&
    !value.includes("__") &&
    !value.endsWith("_") &&
    MANAGED_BOT_SUFFIX_PATTERN.test(value)
  );
}

/**
 * Нормализует предложенный ник бота-коллеги: снимает `@`, при отсутствии суффикса `bot`
 * дописывает `_bot` и сверяет правила Telegram. Недопустимая строка → null.
 */
export function normalizeManagedBotUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const stripped = raw.trim().replace(/^@/u, "");
  if (stripped.length === 0) return null;
  if (isManagedBotUsername(stripped)) return stripped;
  if (/^[A-Za-z][A-Za-z0-9_]*$/u.test(stripped) && !stripped.includes("__")) {
    const base = stripped.replace(/_+$/u, "");
    if (base.length === 0) return null;
    const candidate = MANAGED_BOT_SUFFIX_PATTERN.test(base)
      ? base
      : `${base}_bot`;
    return isManagedBotUsername(candidate) ? candidate : null;
  }
  return null;
}

/** Собирает валидный ник коллеги по нику основного бота Ивы и короткому ключу роли. */
export function suggestColleagueBotUsername(
  managerBotUsername: string,
  roleSlug: string,
): string {
  const cleanManager = managerBotUsername
    .trim()
    .replace(/^@/u, "")
    .replace(/_?bot$/iu, "")
    .replace(/[^A-Za-z0-9_]/gu, "_")
    .replace(/__+/gu, "_")
    .replace(/^[^A-Za-z]+/u, "")
    .replace(/_+$/u, "");
  const cleanRole = roleSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
  const rolePart = cleanRole.length > 0 ? cleanRole : "helper";
  const suffix = `_${rolePart}_bot`;
  const maxBase = Math.max(1, 32 - suffix.length);
  const rawBase = (cleanManager || "iva").slice(0, maxBase).replace(/_+$/u, "");
  const base =
    rawBase.length > 0 && /^[A-Za-z]/u.test(rawBase) ? rawBase : "iva";
  const candidate = `${base}${suffix}`;
  if (isManagedBotUsername(candidate)) return candidate;
  const fallback = `iva_${rolePart.slice(0, 20)}_bot`;
  return isManagedBotUsername(fallback) ? fallback : "iva_colleague_bot";
}

export interface ManagedBotHireUrlInput {
  readonly managerBotUsername: string;
  readonly botUsername: string;
  readonly displayName: string;
}

/**
 * Собирает ссылку найма управляемого бота (Bot API 9.6):
 * `https://t.me/newbot/<бот Ивы>/<имя>bot?name=…`.
 */
export function buildManagedBotHireUrl(input: ManagedBotHireUrlInput): string {
  const manager = input.managerBotUsername.trim().replace(/^@/u, "");
  if (!isManagedBotUsername(manager)) {
    throw new Error(
      `Invalid manager bot username: ${JSON.stringify(input.managerBotUsername)}`,
    );
  }
  const botUsername = normalizeManagedBotUsername(input.botUsername);
  if (!botUsername) {
    throw new Error(
      `Invalid colleague bot username: ${JSON.stringify(input.botUsername)}`,
    );
  }
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 64) {
    throw new Error("Colleague display name must be 1..64 characters");
  }
  return `https://t.me/newbot/${manager}/${botUsername}?name=${encodeURIComponent(displayName)}`;
}

/** Сериализует список коллег в безопасное для `.env` значение `TELEGRAM_COLLEAGUE_BOT_TOKENS`. */
export function serializeColleagueBotTokens(
  bots: readonly Pick<TelegramBotConfig, "botId" | "token" | "username">[],
  primaryBotId: string | null = null,
): string {
  const seen = new Set<string>(primaryBotId ? [primaryBotId] : []);
  const parts: string[] = [];
  for (const bot of bots) {
    const token = bot.token.trim();
    const botId = bot.botId ?? botIdFromToken(token);
    if (!botId || seen.has(botId) || !SAFE_ENV_TOKEN_PATTERN.test(token)) {
      continue;
    }
    seen.add(botId);
    const username = normalizeUsername(bot.username);
    parts.push(username ? `${username}=${token}` : token);
  }
  return parts.join(",");
}

/** Добавляет или обновляет токен коллеги в строке `TELEGRAM_COLLEAGUE_BOT_TOKENS`. */
export function upsertColleagueBotToken(
  raw: string | undefined,
  bot: { readonly token: string; readonly username?: string },
  primaryBotId: string | null = null,
): string {
  const token = bot.token.trim();
  const botId = botIdFromToken(token);
  if (!botId || !SAFE_ENV_TOKEN_PATTERN.test(token)) {
    throw new Error("Invalid colleague bot token format");
  }
  if (primaryBotId && botId === primaryBotId) {
    throw new Error("Colleague bot token matches primary Iva bot");
  }
  const existing = parseColleagueBotTokens(raw, primaryBotId);
  const username = normalizeUsername(bot.username);
  const next: TelegramBotConfig[] = [];
  let replaced = false;
  for (const entry of existing) {
    if (entry.botId === botId) {
      next.push({
        botId,
        token,
        ...((username ?? entry.username)
          ? { username: username ?? entry.username }
          : {}),
        isPrimary: false,
      });
      replaced = true;
    } else {
      next.push(entry);
    }
  }
  if (!replaced) {
    next.push({
      botId,
      token,
      ...(username ? { username } : {}),
      isPrimary: false,
    });
  }
  return serializeColleagueBotTokens(next, primaryBotId);
}

/** Удаляет токен коллеги по `botId` из строки `TELEGRAM_COLLEAGUE_BOT_TOKENS`. */
export function removeColleagueBotToken(
  raw: string | undefined,
  botId: string,
  primaryBotId: string | null = null,
): string {
  if (!validTelegramBotId(botId)) {
    return serializeColleagueBotTokens(
      parseColleagueBotTokens(raw, primaryBotId),
      primaryBotId,
    );
  }
  const remaining = parseColleagueBotTokens(raw, primaryBotId).filter(
    (entry) => entry.botId !== botId,
  );
  return serializeColleagueBotTokens(remaining, primaryBotId);
}

type CachedEnvTokens = {
  readonly path: string;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
  readonly primaryToken: string | undefined;
  readonly colleagueTokens: string | undefined;
};

let cachedEnvTokens: CachedEnvTokens | null = null;

function readEnvFileTokensSync(
  envFile: string,
): { primaryToken?: string; colleagueTokens?: string } | null {
  try {
    const stats = statSync(envFile);
    if (
      cachedEnvTokens !== null &&
      cachedEnvTokens.path === envFile &&
      cachedEnvTokens.ino === stats.ino &&
      cachedEnvTokens.mtimeMs === stats.mtimeMs &&
      cachedEnvTokens.size === stats.size
    ) {
      return {
        primaryToken: cachedEnvTokens.primaryToken,
        colleagueTokens: cachedEnvTokens.colleagueTokens,
      };
    }
    const parsed = parseEnv(readFileSync(envFile, "utf8"));
    const primaryToken = parsed.TELEGRAM_BOT_TOKEN?.trim() || undefined;
    const colleagueTokens =
      parsed.TELEGRAM_COLLEAGUE_BOT_TOKENS?.trim() || undefined;
    cachedEnvTokens = {
      path: envFile,
      ino: stats.ino,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      primaryToken,
      colleagueTokens,
    };
    return { primaryToken, colleagueTokens };
  } catch {
    return null;
  }
}

/**
 * Возвращает env-снимок с актуальным `TELEGRAM_COLLEAGUE_BOT_TOKENS` из `.env`,
 * чтобы процесс eve видел коллегу, нанятого мостом по `managed_bot`, без рестарта.
 * Читает `.env` только если в нём тот же `TELEGRAM_BOT_TOKEN`, что и у процесса —
 * изолированные тесты с синтетическими токенами не подхватывают чужой `.env`.
 */
export function liveTelegramEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  envFile: string = baseEnv.IVA_ENV_FILE?.trim() || join(process.cwd(), ".env"),
): NodeJS.ProcessEnv {
  const basePrimary = baseEnv.TELEGRAM_BOT_TOKEN?.trim();
  if (!basePrimary) return baseEnv;
  const fromFile = readEnvFileTokensSync(envFile);
  if (!fromFile || fromFile.primaryToken !== basePrimary) return baseEnv;
  const fileValue = fromFile.colleagueTokens ?? "";
  if (fileValue === (baseEnv.TELEGRAM_COLLEAGUE_BOT_TOKENS ?? "").trim()) {
    return baseEnv;
  }
  return {
    ...baseEnv,
    TELEGRAM_COLLEAGUE_BOT_TOKENS: fileValue,
  };
}
