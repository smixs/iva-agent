// Обработка события `managed_bot` (Telegram Bot API 9.6) и отложенный повтор аватарки коллеги.
// Поток найма (ADR-0030):
// 1. Владелец подтверждает создание управляемого бота по ссылке `t.me/newbot/<бот Ивы>/<имя>bot?name=…`.
// 2. Telegram шлёт Иве апдейт `managed_bot { user, bot }`.
// 3. Мост проверяет Allowlist (`user.id`), забирает токен через `getManagedBotToken`,
//    атомарно сохраняет его в `.env` (`TELEGRAM_COLLEAGUE_BOT_TOKENS`, 0600) рядом с токеном Ивы,
//    записывает роль/модель/имя коллеги в `data/settings.json` и включает опцию коллег,
//    ставит имя и описание роли (`setMyName`, `setMyDescription`, `setMyShortDescription`),
//    ставит случайный талисман ip-as-logo (JPG 640×640, `setMyProfilePhoto`; при сбое —
//    бот работает без фото, фаза `avatarPhase: "retry"`, повтор позже) и сразу запускает
//    опрос нового коллеги в текущем процессе Bridge.
import { join } from "node:path";
import { isRecord } from "../../packages/guards/index.ts";
import { redactSecretValues } from "../../packages/secret-redaction/index.ts";
import {
  botIdFromToken,
  configuredTelegramBots,
  upsertColleagueBotToken,
  validTelegramBotId,
  type TelegramBotConfig,
} from "../../packages/telegram-bots/index.ts";
import {
  COLLEAGUE_ROLE_SPECS,
  colleagueAvatarPhase,
  colleagueAvatarRetryDelayMs,
  colleagueProfileCopy,
  consumeColleagueHireProposal,
  inferColleagueRoleFromBot,
  parseColleaguesConfig,
  suggestColleagueModel,
  withColleague,
  withColleagueAvatarState,
  withColleaguesEnabled,
  type ColleagueEntry,
  type ColleagueRole,
} from "#lib/colleagues.ts";
import { getLang, tr } from "#lib/i18n.ts";
import { readSettings, updateSettings } from "#lib/settings.ts";
import {
  applyRandomColleagueAvatar,
  type ColleagueAvatarDeps,
  type ColleagueAvatarOutcome,
} from "../lib/colleague-avatar.ts";
import {
  envValueRejection,
  readEnvValues,
  upsertEnv,
} from "../lib/env-file.ts";
import type { TelegramQueueUpdate } from "../lib/telegram-queue.ts";
import {
  ALLOWED,
  BOT_USER_ID,
  DATA_DIR,
  ENV_PATH,
  TOKEN,
  log,
} from "./config.ts";
import { reply, tg } from "./transport.ts";

export interface ManagedBotEvent {
  readonly ownerUserId: string;
  readonly botId: string;
  readonly botNumericId: number;
  readonly botUsername?: string;
  readonly botFirstName?: string;
}

export type ManagedBotOutcome =
  | {
      readonly status: "hired";
      readonly bot: TelegramBotConfig;
      readonly colleague: ColleagueEntry;
      readonly avatarSet: boolean;
    }
  | {
      readonly status: "ignored";
      readonly reason: string;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
    };

export type ManagedBotApiCall = (
  method: string,
  body: Record<string, unknown>,
  options?: { timeoutMs?: number; token?: string },
) => Promise<unknown>;

export interface ManagedBotHandlerDeps {
  readonly allowedUserIds?: ReadonlySet<string>;
  readonly primaryBotId?: string | null;
  readonly primaryBotToken?: string;
  readonly envPath?: string;
  readonly settingsFile?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly tgImpl?: ManagedBotApiCall;
  readonly replyImpl?: (
    chatId: number | string,
    text: string,
  ) => Promise<unknown>;
  readonly applyAvatarImpl?: (
    botToken: string,
    deps?: ColleagueAvatarDeps,
  ) => Promise<ColleagueAvatarOutcome>;
  readonly avatarDeps?: ColleagueAvatarDeps;
  readonly onColleagueHired?: (bot: TelegramBotConfig) => void;
  readonly now?: () => number;
  readonly lang?: () => "ru" | "en";
  readonly logImpl?: (...args: unknown[]) => void;
}

type TelegramApiEnvelope = {
  ok?: unknown;
  description?: unknown;
  result?: unknown;
};

const VALID_USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/u;

function safeId(value: unknown): { str: string; num: number } | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return { str: String(value), num: value };
  }
  if (typeof value === "string" && validTelegramBotId(value)) {
    const num = Number(value);
    if (Number.isSafeInteger(num) && num > 0) return { str: value, num };
  }
  return null;
}

/** Разбирает поле `managed_bot` апдейта Telegram Bot API 9.6 (`ManagedBotUpdated`). */
export function parseManagedBotUpdate(
  update: TelegramQueueUpdate,
): ManagedBotEvent | null {
  const raw = update.managed_bot;
  if (!isRecord(raw)) return null;
  const user = isRecord(raw.user) ? raw.user : null;
  const bot = isRecord(raw.bot) ? raw.bot : null;
  if (!user || !bot) return null;
  if (user.is_bot === true || bot.is_bot === false) return null;
  const ownerId = safeId(user.id);
  const botId = safeId(bot.id);
  if (!ownerId || !botId) return null;
  const rawUsername =
    typeof bot.username === "string"
      ? bot.username.trim().replace(/^@/u, "")
      : "";
  const botUsername = VALID_USERNAME_RE.test(rawUsername)
    ? rawUsername
    : undefined;
  const rawFirstName =
    typeof bot.first_name === "string" ? bot.first_name.trim() : "";
  const botFirstName = rawFirstName.length > 0 ? rawFirstName : undefined;
  return {
    ownerUserId: ownerId.str,
    botId: botId.str,
    botNumericId: botId.num,
    ...(botUsername ? { botUsername } : {}),
    ...(botFirstName ? { botFirstName } : {}),
  };
}

function redactError(error: unknown, secrets: readonly string[]): string {
  const raw = error instanceof Error ? error.message : String(error);
  const filtered = secrets.filter((s) => s.length > 0);
  return filtered.length > 0 ? redactSecretValues(raw, filtered) : raw;
}

function extractTokenFromResult(result: unknown): string | null {
  if (typeof result === "string" && result.trim().length > 0) {
    return result.trim();
  }
  if (
    isRecord(result) &&
    typeof result.token === "string" &&
    result.token.trim().length > 0
  ) {
    return result.token.trim();
  }
  return null;
}

async function applyProfileCopyBestEffort(options: {
  readonly botId: string;
  readonly botToken: string;
  readonly copy: {
    name: string;
    description: string;
    shortDescription: string;
  };
  readonly tgImpl: ManagedBotApiCall;
  readonly secrets: readonly string[];
  readonly logImpl: (...args: unknown[]) => void;
}): Promise<void> {
  const calls: ReadonlyArray<
    readonly [method: string, body: Record<string, unknown>]
  > = [
    ["setMyName", { name: options.copy.name }],
    ["setMyDescription", { description: options.copy.description }],
    [
      "setMyShortDescription",
      { short_description: options.copy.shortDescription },
    ],
  ];
  for (const [method, body] of calls) {
    try {
      const response = (await options.tgImpl(method, body, {
        token: options.botToken,
      })) as TelegramApiEnvelope | null;
      if (response?.ok !== true) {
        const desc =
          typeof response?.description === "string"
            ? response.description
            : "ok:false";
        options.logImpl(
          `managed_bot ${options.botId}: ${method} failed:`,
          redactError(desc, options.secrets),
        );
      }
    } catch (error) {
      options.logImpl(
        `managed_bot ${options.botId}: ${method} failed:`,
        redactError(error, options.secrets),
      );
    }
  }
}

/**
 * Обрабатывает входящее событие `managed_bot`:
 * проверяет Allowlist, получает токен коллеги (`getManagedBotToken`), сохраняет его в `.env`,
 * записывает роль/модель в `data/settings.json`, ставит имя/описание и случайный талисман,
 * запускает опрос коллеги в текущем процессе и сообщает владельцу.
 */
export async function handleManagedBotUpdate(
  update: TelegramQueueUpdate,
  deps: ManagedBotHandlerDeps = {},
): Promise<ManagedBotOutcome> {
  const logImpl = deps.logImpl ?? log;
  const event = parseManagedBotUpdate(update);
  if (event === null) {
    logImpl(`managed_bot update ${update.update_id}: invalid payload, ignored`);
    return { status: "ignored", reason: "invalid payload" };
  }

  const allowedUserIds = deps.allowedUserIds ?? ALLOWED;
  if (allowedUserIds.size === 0 || !allowedUserIds.has(event.ownerUserId)) {
    logImpl(
      `managed_bot update ${update.update_id}: owner not in allowlist, ignored`,
    );
    return { status: "ignored", reason: "owner not allowlisted" };
  }

  const env = deps.env ?? process.env;
  const primaryToken =
    deps.primaryBotToken ?? env.TELEGRAM_BOT_TOKEN ?? TOKEN ?? "";
  const primaryBotId =
    deps.primaryBotId ?? botIdFromToken(primaryToken) ?? BOT_USER_ID;
  if (primaryBotId && event.botId === primaryBotId) {
    logImpl(
      `managed_bot update ${update.update_id}: bot matches primary Iva bot, ignored`,
    );
    return { status: "ignored", reason: "matches primary bot" };
  }

  const tgImpl = deps.tgImpl ?? tg;
  const replyImpl = deps.replyImpl ?? reply;
  const envPath = deps.envPath ?? ENV_PATH;
  const settingsFile = deps.settingsFile ?? join(DATA_DIR, "settings.json");
  const now = deps.now ?? Date.now;
  const lang = (deps.lang ?? getLang)();
  const secrets: string[] = primaryToken ? [primaryToken] : [];

  let tokenResponse: TelegramApiEnvelope | null;
  try {
    tokenResponse = (await tgImpl(
      "getManagedBotToken",
      { user_id: event.botNumericId },
      primaryToken ? { token: primaryToken } : undefined,
    )) as TelegramApiEnvelope | null;
  } catch (error) {
    const reason = redactError(error, secrets);
    logImpl(`managed_bot ${event.botId}: getManagedBotToken failed:`, reason);
    return { status: "failed", reason };
  }

  const token =
    tokenResponse?.ok === true
      ? extractTokenFromResult(tokenResponse.result)
      : null;
  if (!token) {
    const detail =
      typeof tokenResponse?.description === "string"
        ? tokenResponse.description
        : "getManagedBotToken returned no token";
    const reason = redactError(detail, secrets);
    logImpl(`managed_bot ${event.botId}: getManagedBotToken rejected:`, reason);
    return { status: "failed", reason };
  }
  secrets.push(token);

  if (
    botIdFromToken(token) !== event.botId ||
    envValueRejection(token) !== null
  ) {
    logImpl(
      `managed_bot ${event.botId}: returned token failed botId/env validation`,
    );
    return { status: "failed", reason: "invalid managed bot token" };
  }

  // Сохраняем токен коллеги рядом с токеном Ивы в `.env` (0600, атомарно) и обновляем env процесса.
  let nextTokensLine: string;
  try {
    const existingEnv = await readEnvValues(envPath);
    const baseTokens =
      existingEnv.TELEGRAM_COLLEAGUE_BOT_TOKENS ??
      env.TELEGRAM_COLLEAGUE_BOT_TOKENS;
    nextTokensLine = upsertColleagueBotToken(
      baseTokens,
      { token, username: event.botUsername },
      primaryBotId,
    );
    await upsertEnv(envPath, {
      TELEGRAM_COLLEAGUE_BOT_TOKENS: nextTokensLine,
    });
    env.TELEGRAM_COLLEAGUE_BOT_TOKENS = nextTokensLine;
  } catch (error) {
    const reason = redactError(error, secrets);
    logImpl(
      `managed_bot ${event.botId}: failed to store token in .env:`,
      reason,
    );
    return { status: "failed", reason };
  }

  // Привязываем роль/модель из открытого предложения найма (или выводим по имени/нику) и включаем опцию коллег.
  let storedColleague: ColleagueEntry | null;
  try {
    const currentNow = now();
    const updated = updateSettings((current) => {
      const existingEntry = parseColleaguesConfig(current, () => {}).items[
        event.botId
      ];
      const consumed = consumeColleagueHireProposal(
        current,
        { username: event.botUsername, firstName: event.botFirstName },
        currentNow,
      );
      const proposal = consumed.proposal;
      const role: ColleagueRole =
        proposal?.role ??
        existingEntry?.role ??
        inferColleagueRoleFromBot({
          firstName: event.botFirstName,
          username: event.botUsername,
        }) ??
        "secretary";
      const suggestion = suggestColleagueModel(role, env);
      const provider =
        proposal?.provider ?? existingEntry?.provider ?? suggestion.provider;
      const model = proposal?.model ?? existingEntry?.model ?? suggestion.model;
      const displayName =
        proposal?.name ??
        event.botFirstName ??
        existingEntry?.name ??
        (lang === "en"
          ? COLLEAGUE_ROLE_SPECS[role].labelEn
          : COLLEAGUE_ROLE_SPECS[role].labelRu);
      const nextSettings = withColleaguesEnabled(consumed.settings, true);
      return withColleague(nextSettings, {
        botId: event.botId,
        role,
        provider,
        model,
        name: displayName,
        ...(event.botUsername
          ? { username: event.botUsername }
          : existingEntry?.username
            ? { username: existingEntry.username }
            : {}),
        avatarPhase:
          colleagueAvatarPhase(existingEntry) === "set" ? "set" : "pending",
        ...(existingEntry?.avatarLogoId !== undefined
          ? { avatarLogoId: existingEntry.avatarLogoId }
          : {}),
        ...(existingEntry?.avatarName !== undefined
          ? { avatarName: existingEntry.avatarName }
          : {}),
      });
    }, settingsFile);
    storedColleague =
      parseColleaguesConfig(updated, () => {}).items[event.botId] ?? null;
  } catch (error) {
    const reason = redactError(error, secrets);
    logImpl(`managed_bot ${event.botId}: failed to save settings:`, reason);
    return { status: "failed", reason };
  }

  if (!storedColleague) {
    return {
      status: "failed",
      reason: "colleague missing after settings update",
    };
  }

  const profileCopy = colleagueProfileCopy(
    storedColleague.role,
    lang,
    storedColleague.name,
  );
  await applyProfileCopyBestEffort({
    botId: event.botId,
    botToken: token,
    copy: profileCopy,
    tgImpl,
    secrets,
    logImpl,
  });

  // Ставим случайный талисман ip-as-logo (JPG 640×640). При сбое — бот без фото, повтор позже.
  let avatarSet = colleagueAvatarPhase(storedColleague) === "set";
  if (!avatarSet) {
    const applyAvatar = deps.applyAvatarImpl ?? applyRandomColleagueAvatar;
    const avatarOutcome = await applyAvatar(token, deps.avatarDeps);
    const attemptAt = now();
    if (avatarOutcome.ok) {
      avatarSet = true;
      const next = updateSettings(
        (current) =>
          withColleagueAvatarState(current, event.botId, {
            phase: "set",
            logoId: avatarOutcome.logo.id,
            logoName: avatarOutcome.logo.name,
          }),
        settingsFile,
      );
      storedColleague =
        parseColleaguesConfig(next, () => {}).items[event.botId] ??
        storedColleague;
    } else {
      const safeAvatarErr = redactError(avatarOutcome.error, secrets);
      logImpl(
        `managed_bot ${event.botId}: avatar unavailable, scheduled retry:`,
        safeAvatarErr,
      );
      const next = updateSettings(
        (current) =>
          withColleagueAvatarState(current, event.botId, {
            phase: "retry",
            attempts: 1,
            nextRetryAt: attemptAt + colleagueAvatarRetryDelayMs(1),
            error: safeAvatarErr,
          }),
        settingsFile,
      );
      storedColleague =
        parseColleaguesConfig(next, () => {}).items[event.botId] ??
        storedColleague;
    }
  }

  const botConfig: TelegramBotConfig = {
    botId: event.botId,
    token,
    ...(storedColleague.username ? { username: storedColleague.username } : {}),
    isPrimary: false,
  };
  deps.onColleagueHired?.(botConfig);

  const handle = storedColleague.username
    ? ` (@${storedColleague.username})`
    : "";
  const label = storedColleague.name ?? profileCopy.name;
  const notice = avatarSet
    ? tr(
        `Hired colleague ${label}${handle} — ${storedColleague.provider}/${storedColleague.model}. Ready for messages.`,
        `Наняла коллегу ${label}${handle} — ${storedColleague.provider}/${storedColleague.model}. Можно писать ему.`,
      )
    : tr(
        `Hired colleague ${label}${handle} — ${storedColleague.provider}/${storedColleague.model}. Avatar couldn't be fetched yet — running without photo, will retry later.`,
        `Наняла коллегу ${label}${handle} — ${storedColleague.provider}/${storedColleague.model}. Аватарку пока не удалось загрузить — бот без фото, повторю позже.`,
      );
  await replyImpl(event.ownerUserId, notice).catch((error: unknown) => {
    logImpl(
      `managed_bot ${event.botId}: owner confirmation reply failed:`,
      redactError(error, secrets),
    );
  });

  logImpl(
    `managed_bot ${event.botId}: hired role=${storedColleague.role} model=${storedColleague.provider}/${storedColleague.model} avatar=${avatarSet ? "set" : "retry"}`,
  );
  return {
    status: "hired",
    bot: botConfig,
    colleague: storedColleague,
    avatarSet,
  };
}

export interface AvatarReconcileDeps {
  readonly settingsFile?: string;
  readonly envPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly applyAvatarImpl?: (
    botToken: string,
    deps?: ColleagueAvatarDeps,
  ) => Promise<ColleagueAvatarOutcome>;
  readonly avatarDeps?: ColleagueAvatarDeps;
  readonly now?: () => number;
  readonly logImpl?: (...args: unknown[]) => void;
}

/**
 * Повторно ставит случайный талисман коллегам, у которых при найме библиотека ip-as-logo
 * была недоступна (`avatarPhase === "retry"` или `"pending"` и срок повтора наступил).
 */
export async function reconcilePendingColleagueAvatars(
  deps: AvatarReconcileDeps = {},
): Promise<{ readonly attempted: number; readonly succeeded: number }> {
  const settingsFile = deps.settingsFile ?? join(DATA_DIR, "settings.json");
  const envPath = deps.envPath ?? ENV_PATH;
  const baseEnv = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const logImpl = deps.logImpl ?? log;
  const applyAvatar = deps.applyAvatarImpl ?? applyRandomColleagueAvatar;

  const config = parseColleaguesConfig(readSettings(settingsFile), () => {});
  const currentNow = now();
  const due = Object.values(config.items).filter((entry) => {
    const phase = colleagueAvatarPhase(entry);
    if (phase !== "retry" && phase !== "pending") return false;
    return (entry.avatarNextRetryAt ?? 0) <= currentNow;
  });
  if (due.length === 0) return { attempted: 0, succeeded: 0 };

  let freshEnv: NodeJS.ProcessEnv = baseEnv;
  try {
    const fromFile = await readEnvValues(envPath);
    if (fromFile.TELEGRAM_COLLEAGUE_BOT_TOKENS) {
      freshEnv = {
        ...baseEnv,
        TELEGRAM_COLLEAGUE_BOT_TOKENS: fromFile.TELEGRAM_COLLEAGUE_BOT_TOKENS,
      };
    }
  } catch {
    // Missing or unreadable .env falls back to process env.
  }

  const botsById = new Map(
    configuredTelegramBots(freshEnv)
      .filter((b) => !b.isPrimary && b.botId !== null)
      .map((b) => [b.botId as string, b]),
  );

  let attempted = 0;
  let succeeded = 0;
  for (const entry of due) {
    const bot = botsById.get(entry.botId);
    if (!bot) continue;
    attempted += 1;
    const outcome = await applyAvatar(bot.token, deps.avatarDeps);
    const attemptAt = now();
    if (outcome.ok) {
      succeeded += 1;
      updateSettings(
        (current) =>
          withColleagueAvatarState(current, entry.botId, {
            phase: "set",
            logoId: outcome.logo.id,
            logoName: outcome.logo.name,
          }),
        settingsFile,
      );
      logImpl(
        `colleague ${entry.botId}: retry set random avatar (${outcome.logo.name})`,
      );
    } else {
      const nextAttempts = (entry.avatarAttempts ?? 0) + 1;
      const safeErr = redactError(outcome.error, [bot.token]);
      updateSettings(
        (current) =>
          withColleagueAvatarState(current, entry.botId, {
            phase: "retry",
            attempts: nextAttempts,
            nextRetryAt: attemptAt + colleagueAvatarRetryDelayMs(nextAttempts),
            error: safeErr,
          }),
        settingsFile,
      );
      logImpl(
        `colleague ${entry.botId}: avatar retry #${nextAttempts} failed:`,
        safeErr,
      );
    }
  }
  return { attempted, succeeded };
}
