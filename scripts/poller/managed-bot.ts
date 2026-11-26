// Обработка события `managed_bot` (Telegram Bot API 9.6) и отложенный повтор аватарки коллеги.
// Поток найма (ADR-0030):
// 1. Владелец подтверждает создание управляемого бота по ссылке `t.me/newbot/<бот Ивы>/<имя>bot?name=…`.
// 2. Telegram шлёт Иве апдейт `managed_bot { user, bot }`.
// 3. Мост проверяет Allowlist (`user.id`), сохраняет durable решение найма в
//    `colleague-hires.d`, забирает токен через `getManagedBotToken`,
//    атомарно сохраняет его в `.env` (`TELEGRAM_COLLEAGUE_BOT_TOKENS`, 0600) рядом с токеном Ивы,
//    записывает роль/модель/имя коллеги в `data/settings.json` и включает опцию коллег,
//    ставит имя и описание роли (`setMyName`, `setMyDescription`, `setMyShortDescription`),
//    ставит случайный талисман ip-as-logo (JPG 640×640, `setMyProfilePhoto`; при сбое —
//    бот работает без фото, фаза `avatarPhase: "retry"`, повтор позже) и сразу запускает
//    опрос нового коллеги в текущем процессе Bridge.
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../packages/guards/index.ts";
import { redactSecretValues } from "../../packages/secret-redaction/index.ts";
import {
  allTelegramBotTokens,
  botIdFromToken,
  configuredTelegramBots,
  liveTelegramEnv,
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
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";
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
      /** true — событие нельзя подтверждать: вход держит offset и повторит его после восстановления среды/API. */
      readonly retry: boolean;
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
  readonly hireStateDir?: string;
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
  error_code?: unknown;
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

function failedOutcome(reason: string, retry = true): ManagedBotOutcome {
  return { status: "failed", reason, retry };
}

function telegramErrorCode(
  response: TelegramApiEnvelope | null,
): number | null {
  const code = response?.error_code;
  return typeof code === "number" && Number.isFinite(code) ? code : null;
}

/** Сетевые ошибки, 429 и 5xx временны; 4xx Bot API — окончательный отказ этого события. */
function temporaryTelegramFailure(
  response: TelegramApiEnvelope | null,
): boolean {
  const code = telegramErrorCode(response);
  if (code === null) return true;
  return code === 429 || code >= 500;
}

function terminalManagedFailure(
  update: TelegramQueueUpdate,
  botId: string,
  reason: string,
  logImpl: (...args: unknown[]) => void,
): ManagedBotOutcome {
  logImpl(
    `managed_bot update_id=${update.update_id} bot ${botId}: terminal failure acknowledged:`,
    reason,
  );
  return failedOutcome(reason, false);
}

/** Известные токены установки до вызова Bot API: рядом с новым могут лежать уже нанятые коллеги. */
function knownTelegramSecrets(options: {
  readonly primaryToken: string;
  readonly env: NodeJS.ProcessEnv;
  readonly envPath: string;
}): string[] {
  const baseEnv = {
    ...options.env,
    TELEGRAM_BOT_TOKEN: options.primaryToken,
  };
  const liveEnv = liveTelegramEnv(baseEnv, options.envPath);
  const tokens = new Set(allTelegramBotTokens(liveEnv));
  if (options.primaryToken.length > 0) tokens.add(options.primaryToken);
  return [...tokens].filter((token) => token.length > 0);
}

const colleagueAvatarInFlight = new Map<
  string,
  Promise<ColleagueAvatarOutcome>
>();

/** Один исполнитель загрузки талисмана на коллегу: повторная сверка ждёт тот же прогон. */
function applyColleagueAvatarOnce(options: {
  readonly botId: string;
  readonly botToken: string;
  readonly applyAvatar: (
    botToken: string,
    deps?: ColleagueAvatarDeps,
  ) => Promise<ColleagueAvatarOutcome>;
  readonly avatarDeps?: ColleagueAvatarDeps;
}): Promise<ColleagueAvatarOutcome> {
  const running = colleagueAvatarInFlight.get(options.botId);
  if (running) return running;
  const task = Promise.resolve().then(() =>
    options.applyAvatar(options.botToken, options.avatarDeps),
  );
  const tracked = task.finally(() => {
    if (colleagueAvatarInFlight.get(options.botId) === tracked) {
      colleagueAvatarInFlight.delete(options.botId);
    }
  });
  colleagueAvatarInFlight.set(options.botId, tracked);
  return tracked;
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

type ColleagueHireDecision = {
  readonly role: ColleagueRole;
  readonly provider: ColleagueEntry["provider"];
  readonly model: string;
  readonly name: string;
  readonly username?: string;
  readonly firstName?: string;
};

type ColleagueHireState = ColleagueHireDecision & {
  readonly version: 1;
  readonly phase: "token" | "profile" | "settings" | "completed";
  readonly botId: string;
  readonly ownerUserId: string;
  readonly updateId?: number;
  readonly attempts: number;
  readonly nextRetryAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastError?: string;
};

const COLLEAGUE_HIRE_RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
] as const;
const COLLEAGUE_HIRE_EVENT_RETRY_LIMIT = 3;

function colleagueHireRetryDelayMs(attempts: number): number {
  return COLLEAGUE_HIRE_RETRY_DELAYS_MS[
    Math.min(
      Math.max(attempts - 1, 0),
      COLLEAGUE_HIRE_RETRY_DELAYS_MS.length - 1,
    )
  ];
}

function hireStateFile(hireStateDir: string, botId: string): string {
  return join(hireStateDir, `${botId}.json`);
}

function parseHireState(raw: unknown): ColleagueHireState | null {
  if (!isRecord(raw) || raw.version !== 1) return null;
  if (
    typeof raw.botId !== "string" ||
    typeof raw.ownerUserId !== "string" ||
    (raw.phase !== "token" &&
      raw.phase !== "profile" &&
      raw.phase !== "settings" &&
      raw.phase !== "completed") ||
    typeof raw.role !== "string" ||
    typeof raw.provider !== "string" ||
    typeof raw.model !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.attempts !== "number" ||
    typeof raw.nextRetryAt !== "number" ||
    typeof raw.createdAt !== "number" ||
    typeof raw.updatedAt !== "number"
  ) {
    return null;
  }
  return raw as unknown as ColleagueHireState;
}

function readHireState(
  hireStateDir: string,
  botId: string,
): ColleagueHireState | null {
  try {
    return parseHireState(
      JSON.parse(readFileSync(hireStateFile(hireStateDir, botId), "utf8")),
    );
  } catch {
    return null;
  }
}

function writeHireState(hireStateDir: string, state: ColleagueHireState): void {
  mkdirSync(hireStateDir, { recursive: true, mode: 0o700 });
  writeFileAtomicSync(
    hireStateFile(hireStateDir, state.botId),
    JSON.stringify(state, null, 2),
    { mode: 0o600 },
  );
}

function deleteHireState(hireStateDir: string, botId: string): void {
  rmSync(hireStateFile(hireStateDir, botId), { force: true });
}

/** Для completed поле nextRetryAt не используется: отметка хранится до следующего события этого бота. */
function completedHireState(
  state: ColleagueHireState,
  now: () => number,
): ColleagueHireState {
  const completedAt = now();
  return {
    ...state,
    phase: "completed",
    nextRetryAt: completedAt,
    updatedAt: completedAt,
  };
}

/**
 * Атомарно в пределах однопроцессного Bridge занимает завершение найма: проверка
 * completed-маркера и его запись синхронны, поэтому handler и фоновая сверка не могут
 * пройти побочные эффекты одного update_id одновременно.
 */
function claimHireCompletion(
  hireStateDir: string,
  state: ColleagueHireState,
  now: () => number,
): boolean {
  const current = readHireState(hireStateDir, state.botId);
  if (current?.phase === "completed" && current.updateId === state.updateId) {
    return false;
  }
  writeHireState(hireStateDir, completedHireState(state, now));
  return true;
}

function deferredManagedHire(
  update: TelegramQueueUpdate,
  botId: string,
  reason: string,
  logImpl: (...args: unknown[]) => void,
): ManagedBotOutcome {
  logImpl(
    `managed_bot update_id=${update.update_id} bot ${botId}: event acknowledged, durable hire retry pending:`,
    reason,
  );
  return failedOutcome(reason, false);
}

function recordManagedEventFailure(options: {
  readonly update: TelegramQueueUpdate;
  readonly botId: string;
  readonly hireStateDir: string;
  readonly state: ColleagueHireState;
  readonly reason: string;
  readonly now: () => number;
  readonly logImpl: (...args: unknown[]) => void;
}): ManagedBotOutcome {
  const attempts = options.state.attempts + 1;
  const failedState: ColleagueHireState = {
    ...options.state,
    attempts,
    nextRetryAt: options.now() + colleagueHireRetryDelayMs(attempts),
    updatedAt: options.now(),
    lastError: options.reason,
  };
  try {
    writeHireState(options.hireStateDir, failedState);
  } catch (error) {
    const stateReason = redactError(error, []);
    options.logImpl(
      `managed_bot ${options.botId}: failed to update durable hire state:`,
      stateReason,
    );
    return failedOutcome(stateReason);
  }
  if (attempts < COLLEAGUE_HIRE_EVENT_RETRY_LIMIT) {
    return failedOutcome(options.reason);
  }
  return deferredManagedHire(
    options.update,
    options.botId,
    options.reason,
    options.logImpl,
  );
}

function clearTerminalHireState(
  hireStateDir: string,
  botId: string,
  logImpl: (...args: unknown[]) => void,
): void {
  try {
    deleteHireState(hireStateDir, botId);
  } catch (error) {
    logImpl(
      `managed_bot ${botId}: failed to clear terminal durable hire state:`,
      redactError(error, []),
    );
  }
}

function buildHiredColleagueSettings(options: {
  readonly current: Record<string, unknown>;
  readonly botId: string;
  readonly decision: ColleagueHireDecision;
  readonly currentNow: number;
  readonly env: NodeJS.ProcessEnv;
  readonly lang: "ru" | "en";
}): Record<string, unknown> {
  const currentConfig = parseColleaguesConfig(options.current, () => {});
  const existingEntry = currentConfig.items[options.botId];
  const consumed = existingEntry
    ? { settings: options.current, proposal: null }
    : consumeColleagueHireProposal(
        options.current,
        {
          username: options.decision.username,
          firstName: options.decision.firstName,
        },
        options.currentNow,
      );
  const proposal = consumed.proposal;
  const role: ColleagueRole =
    existingEntry?.role ??
    options.decision.role ??
    proposal?.role ??
    inferColleagueRoleFromBot({
      firstName: options.decision.firstName,
      username: options.decision.username,
    }) ??
    "secretary";
  const suggestion = suggestColleagueModel(role, options.env);
  const provider =
    existingEntry?.provider ??
    options.decision.provider ??
    proposal?.provider ??
    suggestion.provider;
  const model =
    existingEntry?.model ??
    options.decision.model ??
    proposal?.model ??
    suggestion.model;
  const displayName =
    existingEntry?.name ??
    options.decision.name ??
    proposal?.name ??
    (options.lang === "en"
      ? COLLEAGUE_ROLE_SPECS[role].labelEn
      : COLLEAGUE_ROLE_SPECS[role].labelRu);
  const nextSettings = withColleaguesEnabled(
    consumed.settings,
    existingEntry ? currentConfig.enabled : true,
  );
  return withColleague(nextSettings, {
    botId: options.botId,
    role,
    provider,
    model,
    name: displayName,
    ...(options.decision.username
      ? { username: options.decision.username }
      : existingEntry?.username
        ? { username: existingEntry.username }
        : {}),
    avatarPhase: colleagueAvatarPhase(existingEntry) ?? "pending",
    ...(existingEntry?.avatarAttempts !== undefined
      ? { avatarAttempts: existingEntry.avatarAttempts }
      : {}),
    ...(existingEntry?.avatarNextRetryAt !== undefined
      ? { avatarNextRetryAt: existingEntry.avatarNextRetryAt }
      : {}),
    ...(existingEntry?.avatarLogoId !== undefined
      ? { avatarLogoId: existingEntry.avatarLogoId }
      : {}),
    ...(existingEntry?.avatarName !== undefined
      ? { avatarName: existingEntry.avatarName }
      : {}),
    ...(existingEntry?.avatarError !== undefined
      ? { avatarError: existingEntry.avatarError }
      : {}),
  });
}

/**
 * Записывает профиль коллеги целиком. Все три вызова идемпотентны, поэтому после
 * частичного сбоя следующий повтор того же события просто доводит запись до конца.
 * Возвращает первую замаскированную ошибку либо null, когда все три записи приняты.
 */
async function applyProfileCopy(options: {
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
}): Promise<string | null> {
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
  let firstError: string | null = null;
  for (const [method, body] of calls) {
    let failure: string | null = null;
    try {
      const response = (await options.tgImpl(method, body, {
        token: options.botToken,
      })) as TelegramApiEnvelope | null;
      if (response?.ok !== true) {
        const desc =
          typeof response?.description === "string"
            ? response.description
            : "ok:false";
        failure = redactError(desc, options.secrets);
      }
    } catch (error) {
      failure = redactError(error, options.secrets);
    }
    if (failure !== null) {
      options.logImpl(
        `managed_bot ${options.botId}: ${method} failed:`,
        failure,
      );
      firstError ??= `${method}: ${failure}`;
    }
  }
  return firstError;
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
  const secrets = knownTelegramSecrets({ primaryToken, env, envPath });

  // Решение о найме сохраняется отдельно от settings.json до записи токена и внешних
  // вызовов Bot API: даже обрыв между `.env` и профилем оставляет восстановимую стадию.
  // Незавершённый токен в .env не превращается в опрос коллеги без роли.
  const hireStateDir = deps.hireStateDir ?? join(DATA_DIR, "colleague-hires.d");
  const settingsBefore = readSettings(settingsFile);
  const configBefore = parseColleaguesConfig(settingsBefore, () => {});
  const existingBefore = configBefore.items[event.botId];
  const currentNow = now();
  const exactProposal = existingBefore
    ? null
    : consumeColleagueHireProposal(
        settingsBefore,
        { username: event.botUsername, firstName: event.botFirstName },
        currentNow,
      ).proposal;
  const initialRole: ColleagueRole =
    existingBefore?.role ??
    exactProposal?.role ??
    inferColleagueRoleFromBot({
      firstName: event.botFirstName,
      username: event.botUsername,
    }) ??
    "secretary";
  const initialName =
    existingBefore?.name ??
    exactProposal?.name ??
    event.botFirstName ??
    (lang === "en"
      ? COLLEAGUE_ROLE_SPECS[initialRole].labelEn
      : COLLEAGUE_ROLE_SPECS[initialRole].labelRu);
  const initialSuggestion = suggestColleagueModel(initialRole, env);
  const priorState = readHireState(hireStateDir, event.botId);
  if (
    priorState?.phase === "completed" &&
    priorState.updateId === update.update_id
  ) {
    logImpl(
      `managed_bot update_id=${update.update_id} bot ${event.botId}: duplicate of completed event acknowledged`,
    );
    return { status: "ignored", reason: "managed event already completed" };
  }
  // Отметка completed относится только к своему update_id: новое событие того же бота
  // начинает новый дurable найм/ротацию и не наследует прошлое решение.
  const resumableState = priorState?.phase === "completed" ? null : priorState;
  // Журнал найма старше повторной доставки: после первой записи решение не переигрывается
  // по эвристике или по уже изменившемуся proposal, а доводится в первоначальном виде.
  const decision: ColleagueHireDecision = resumableState
    ? {
        role: resumableState.role,
        provider: resumableState.provider,
        model: resumableState.model,
        name: resumableState.name,
        ...(resumableState.username
          ? { username: resumableState.username }
          : {}),
        ...(resumableState.firstName
          ? { firstName: resumableState.firstName }
          : {}),
      }
    : {
        role: initialRole,
        provider:
          existingBefore?.provider ??
          exactProposal?.provider ??
          initialSuggestion.provider,
        model:
          existingBefore?.model ??
          exactProposal?.model ??
          initialSuggestion.model,
        name: initialName,
        ...(event.botUsername ? { username: event.botUsername } : {}),
        ...(event.botFirstName ? { firstName: event.botFirstName } : {}),
      };
  const baseAttempts = resumableState?.attempts ?? 0;
  const baseState: ColleagueHireState = {
    version: 1,
    phase: resumableState?.phase ?? "token",
    botId: event.botId,
    ownerUserId: event.ownerUserId,
    updateId: update.update_id,
    ...decision,
    attempts: baseAttempts,
    nextRetryAt: currentNow + colleagueHireRetryDelayMs(baseAttempts + 1),
    createdAt: resumableState?.createdAt ?? currentNow,
    updatedAt: currentNow,
    ...(resumableState?.lastError
      ? { lastError: resumableState.lastError }
      : {}),
  };
  try {
    writeHireState(hireStateDir, baseState);
  } catch (error) {
    const reason = redactError(error, secrets);
    logImpl(
      `managed_bot ${event.botId}: failed to save durable hire state:`,
      reason,
    );
    return failedOutcome(reason);
  }

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
    return recordManagedEventFailure({
      update,
      botId: event.botId,
      hireStateDir,
      state: baseState,
      reason,
      now,
      logImpl,
    });
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
    // ok:true без токена — повреждённый/пустой ответ API, а не временный сетевой сбой.
    if (
      tokenResponse?.ok === true ||
      !temporaryTelegramFailure(tokenResponse)
    ) {
      clearTerminalHireState(hireStateDir, event.botId, logImpl);
      return terminalManagedFailure(update, event.botId, reason, logImpl);
    }
    return recordManagedEventFailure({
      update,
      botId: event.botId,
      hireStateDir,
      state: baseState,
      reason,
      now,
      logImpl,
    });
  }
  secrets.push(token);

  if (
    botIdFromToken(token) !== event.botId ||
    envValueRejection(token) !== null
  ) {
    logImpl(
      `managed_bot ${event.botId}: returned token failed botId/env validation`,
    );
    clearTerminalHireState(hireStateDir, event.botId, logImpl);
    return terminalManagedFailure(
      update,
      event.botId,
      "invalid managed bot token",
      logImpl,
    );
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
    return recordManagedEventFailure({
      update,
      botId: event.botId,
      hireStateDir,
      state: baseState,
      reason,
      now,
      logImpl,
    });
  }

  const profileCopy = colleagueProfileCopy(initialRole, lang, initialName);
  const profileError = await applyProfileCopy({
    botId: event.botId,
    botToken: token,
    copy: profileCopy,
    tgImpl,
    secrets,
    logImpl,
  });
  if (profileError !== null) {
    const attempts = baseAttempts + 1;
    const failedState: ColleagueHireState = {
      ...baseState,
      phase: "profile",
      attempts,
      nextRetryAt: now() + colleagueHireRetryDelayMs(attempts),
      updatedAt: now(),
      lastError: profileError,
    };
    try {
      writeHireState(hireStateDir, failedState);
    } catch (error) {
      const stateReason = redactError(error, secrets);
      logImpl(
        `managed_bot ${event.botId}: failed to update durable hire state:`,
        stateReason,
      );
      return failedOutcome(stateReason);
    }
    const reason = `profile write failed: ${profileError}`;
    if (attempts < COLLEAGUE_HIRE_EVENT_RETRY_LIMIT) {
      return failedOutcome(reason);
    }
    return deferredManagedHire(update, event.botId, reason, logImpl);
  }

  const settingsStageState: ColleagueHireState = {
    ...baseState,
    phase: "settings",
    updatedAt: now(),
  };
  try {
    writeHireState(hireStateDir, settingsStageState);
  } catch (error) {
    const reason = redactError(error, secrets);
    logImpl(
      `managed_bot ${event.botId}: failed to advance durable hire state:`,
      reason,
    );
    return failedOutcome(reason);
  }

  // Привязываем роль/модель из своего точного предложения найма. Повтор события
  // обновляет токен и ник, но сохраняет уже выбранные роль, модель, имя и опцию.
  let storedColleague: ColleagueEntry | null;
  try {
    const updated = updateSettings(
      (current) =>
        buildHiredColleagueSettings({
          current,
          botId: event.botId,
          decision,
          currentNow,
          env,
          lang,
        }),
      settingsFile,
    );
    storedColleague =
      parseColleaguesConfig(updated, () => {}).items[event.botId] ?? null;
  } catch (error) {
    const reason = redactError(error, secrets);
    const attempts = baseAttempts + 1;
    try {
      writeHireState(hireStateDir, {
        ...settingsStageState,
        attempts,
        nextRetryAt: now() + colleagueHireRetryDelayMs(attempts),
        updatedAt: now(),
        lastError: reason,
      });
    } catch (stateError) {
      const stateReason = redactError(stateError, secrets);
      logImpl(
        `managed_bot ${event.botId}: failed to update durable hire state:`,
        stateReason,
      );
      return failedOutcome(stateReason);
    }
    logImpl(`managed_bot ${event.botId}: failed to save settings:`, reason);
    const busy =
      typeof error === "object" &&
      error !== null &&
      "state" in error &&
      error.state === "busy";
    if (busy && attempts < COLLEAGUE_HIRE_EVENT_RETRY_LIMIT) {
      return failedOutcome(reason);
    }
    return deferredManagedHire(update, event.botId, reason, logImpl);
  }

  if (!storedColleague) {
    return failedOutcome("colleague missing after settings update");
  }
  // Завершение фиксируется до побочных эффектов (аватарка, запуск опроса, ответ
  // владельцу): повторная доставка того же update_id после фоновой сверки или гонки
  // acknowledgement обязана быть no-op, а не вторым наймом.
  try {
    const claimed = claimHireCompletion(hireStateDir, settingsStageState, now);
    if (!claimed) {
      logImpl(
        `managed_bot update_id=${update.update_id} bot ${event.botId}: completion already claimed, duplicate acknowledged`,
      );
      return { status: "ignored", reason: "managed event already completed" };
    }
  } catch (error) {
    const reason = redactError(error, secrets);
    logImpl(
      `managed_bot ${event.botId}: failed to record durable hire completion:`,
      reason,
    );
    return failedOutcome(reason);
  }

  // Ставим случайный талисман ip-as-logo (JPG 640×640). При сбое — бот без фото, повтор позже.
  let avatarSet = colleagueAvatarPhase(storedColleague) === "set";
  if (!avatarSet) {
    const applyAvatar = deps.applyAvatarImpl ?? applyRandomColleagueAvatar;
    const avatarOutcome = await applyColleagueAvatarOnce({
      botId: event.botId,
      botToken: token,
      applyAvatar,
      avatarDeps: deps.avatarDeps,
    });
    const attemptAt = now();
    if (avatarOutcome.ok) {
      avatarSet = true;
      try {
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
      } catch (error) {
        logImpl(
          `managed_bot ${event.botId}: failed to save avatar state, background retry remains available:`,
          redactError(error, secrets),
        );
      }
    } else {
      const safeAvatarErr = redactError(avatarOutcome.error, secrets);
      logImpl(
        `managed_bot ${event.botId}: avatar unavailable, scheduled retry:`,
        safeAvatarErr,
      );
      try {
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
      } catch (error) {
        logImpl(
          `managed_bot ${event.botId}: failed to save avatar retry state, pending retry remains available:`,
          redactError(error, secrets),
        );
      }
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

export interface HireReconcileDeps {
  readonly settingsFile?: string;
  readonly envPath?: string;
  readonly hireStateDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly tgImpl?: ManagedBotApiCall;
  readonly replyImpl?: (
    chatId: number | string,
    text: string,
  ) => Promise<unknown>;
  readonly onColleagueHired?: (bot: TelegramBotConfig) => void;
  readonly now?: () => number;
  readonly lang?: () => "ru" | "en";
  readonly logImpl?: (...args: unknown[]) => void;
}

function retryHireState(
  hireStateDir: string,
  state: ColleagueHireState,
  reason: string,
  now: () => number,
): void {
  const attempts = state.attempts + 1;
  writeHireState(hireStateDir, {
    ...state,
    attempts,
    nextRetryAt: now() + colleagueHireRetryDelayMs(attempts),
    updatedAt: now(),
    lastError: reason,
  });
}

/**
 * Доводит найм, прерванный после сохранения токена, но до записи роли в settings.json.
 * Это фоновая часть acknowledgement-границы: апдейт Telegram может быть подтверждён,
 * потому что решение и стадия найма уже пережили перезапуск в `colleague-hires.d`.
 */
export async function reconcilePendingColleagueHires(
  deps: HireReconcileDeps = {},
): Promise<{ readonly attempted: number; readonly completed: number }> {
  const settingsFile = deps.settingsFile ?? join(DATA_DIR, "settings.json");
  const envPath = deps.envPath ?? ENV_PATH;
  const hireStateDir = deps.hireStateDir ?? join(DATA_DIR, "colleague-hires.d");
  const baseEnv = deps.env ?? process.env;
  const tgImpl = deps.tgImpl ?? tg;
  const replyImpl = deps.replyImpl ?? reply;
  const now = deps.now ?? Date.now;
  const lang = (deps.lang ?? getLang)();
  const logImpl = deps.logImpl ?? log;

  let names: string[];
  try {
    names = readdirSync(hireStateDir).filter((name) => name.endsWith(".json"));
  } catch {
    return { attempted: 0, completed: 0 };
  }
  if (names.length === 0) return { attempted: 0, completed: 0 };

  // liveTelegramEnv заменяет и удаляет коллегские токены по текущему `.env`:
  // удалённый владельцем токен не должен воскресать из памяти процесса.
  let envForBots = liveTelegramEnv(baseEnv, envPath);
  const botsById = new Map(
    configuredTelegramBots(envForBots)
      .filter((bot) => !bot.isPrimary)
      .map((bot) => [bot.botId, bot] as const),
  );
  const currentNow = now();
  let attempted = 0;
  let completed = 0;

  for (const name of names.sort()) {
    let state: ColleagueHireState | null;
    try {
      state = parseHireState(
        JSON.parse(readFileSync(join(hireStateDir, name), "utf8")),
      );
    } catch (error) {
      logImpl(
        `managed_bot hire state ${name}: unreadable, waiting for repair:`,
        redactError(error, []),
      );
      continue;
    }
    if (!state) continue;
    if (state.phase === "completed") continue;
    if (state.nextRetryAt > currentNow) continue;
    attempted += 1;
    const primaryToken = baseEnv.TELEGRAM_BOT_TOKEN ?? TOKEN ?? "";
    const secrets = knownTelegramSecrets({
      primaryToken,
      env: envForBots,
      envPath,
    });
    let working = state;
    let configuredBot = botsById.get(state.botId);

    if (working.phase === "token") {
      let tokenResponse: TelegramApiEnvelope | null;
      let tokenError: string | null = null;
      try {
        tokenResponse = (await tgImpl(
          "getManagedBotToken",
          { user_id: Number(working.botId) },
          primaryToken ? { token: primaryToken } : undefined,
        )) as TelegramApiEnvelope | null;
      } catch (error) {
        tokenResponse = null;
        tokenError = redactError(error, secrets);
      }
      const token =
        tokenResponse?.ok === true
          ? extractTokenFromResult(tokenResponse.result)
          : null;
      if (tokenError !== null || !token) {
        const reason =
          tokenError ??
          redactError(
            typeof tokenResponse?.description === "string"
              ? tokenResponse.description
              : "getManagedBotToken returned no token",
            secrets,
          );
        logImpl(
          `managed_bot ${working.botId}: durable hire getManagedBotToken failed:`,
          reason,
        );
        const terminal =
          tokenError === null &&
          (tokenResponse?.ok === true ||
            !temporaryTelegramFailure(tokenResponse));
        if (terminal) {
          deleteHireState(hireStateDir, working.botId);
        } else {
          try {
            retryHireState(hireStateDir, working, reason, now);
          } catch (error) {
            logImpl(
              `managed_bot ${working.botId}: failed to update durable hire state:`,
              redactError(error, secrets),
            );
          }
        }
        continue;
      }
      secrets.push(token);
      if (
        botIdFromToken(token) !== working.botId ||
        envValueRejection(token) !== null
      ) {
        logImpl(
          `managed_bot ${working.botId}: durable hire token failed botId/env validation`,
        );
        deleteHireState(hireStateDir, working.botId);
        continue;
      }
      let nextTokensLine: string;
      try {
        const existingEnv = await readEnvValues(envPath);
        const baseTokens =
          existingEnv.TELEGRAM_COLLEAGUE_BOT_TOKENS ??
          baseEnv.TELEGRAM_COLLEAGUE_BOT_TOKENS;
        nextTokensLine = upsertColleagueBotToken(
          baseTokens,
          {
            token,
            ...(working.username ? { username: working.username } : {}),
          },
          botIdFromToken(primaryToken) ?? BOT_USER_ID,
        );
        await upsertEnv(envPath, {
          TELEGRAM_COLLEAGUE_BOT_TOKENS: nextTokensLine,
        });
        baseEnv.TELEGRAM_COLLEAGUE_BOT_TOKENS = nextTokensLine;
        envForBots = {
          ...envForBots,
          TELEGRAM_COLLEAGUE_BOT_TOKENS: nextTokensLine,
        };
      } catch (error) {
        const reason = redactError(error, secrets);
        logImpl(
          `managed_bot ${working.botId}: durable hire failed to store token in .env:`,
          reason,
        );
        try {
          retryHireState(hireStateDir, working, reason, now);
        } catch (stateError) {
          logImpl(
            `managed_bot ${working.botId}: failed to update durable hire state:`,
            redactError(stateError, secrets),
          );
        }
        continue;
      }
      configuredBot = {
        botId: working.botId,
        token,
        ...(working.username ? { username: working.username } : {}),
        isPrimary: false,
      };
      botsById.set(working.botId, configuredBot);
      working = {
        ...working,
        phase: "profile",
        updatedAt: now(),
      };
      try {
        writeHireState(hireStateDir, working);
      } catch (error) {
        logImpl(
          `managed_bot ${working.botId}: failed to advance durable hire state:`,
          redactError(error, secrets),
        );
        continue;
      }
    }

    if (!configuredBot) {
      // Удалённый коллега не должен воскресать из старого журнала найма.
      deleteHireState(hireStateDir, state.botId);
      continue;
    }
    secrets.push(configuredBot.token);

    if (working.phase === "profile") {
      const copy = colleagueProfileCopy(working.role, lang, working.name);
      const profileError = await applyProfileCopy({
        botId: working.botId,
        botToken: configuredBot.token,
        copy,
        tgImpl,
        secrets,
        logImpl,
      });
      if (profileError !== null) {
        try {
          retryHireState(
            hireStateDir,
            working,
            `profile write failed: ${profileError}`,
            now,
          );
        } catch (error) {
          logImpl(
            `managed_bot ${working.botId}: failed to update durable hire state:`,
            redactError(error, secrets),
          );
        }
        continue;
      }
      working = {
        ...working,
        phase: "settings",
        updatedAt: now(),
      };
      try {
        writeHireState(hireStateDir, working);
      } catch (error) {
        logImpl(
          `managed_bot ${working.botId}: failed to advance durable hire state:`,
          redactError(error, secrets),
        );
        continue;
      }
    }

    if (working.phase !== "settings") continue;
    let updatedSettings: Record<string, unknown>;
    try {
      updatedSettings = updateSettings(
        (current) =>
          buildHiredColleagueSettings({
            current,
            botId: working.botId,
            decision: working,
            currentNow: now(),
            env: envForBots,
            lang,
          }),
        settingsFile,
      );
    } catch (error) {
      const reason = redactError(error, secrets);
      try {
        retryHireState(hireStateDir, working, reason, now);
      } catch (stateError) {
        logImpl(
          `managed_bot ${working.botId}: failed to update durable hire state:`,
          redactError(stateError, secrets),
        );
      }
      continue;
    }

    const entry = parseColleaguesConfig(updatedSettings, () => {}).items[
      working.botId
    ];
    if (!entry) {
      try {
        retryHireState(
          hireStateDir,
          working,
          "colleague missing after settings update",
          now,
        );
      } catch {
        // Следующая сверка увидит первоначальную стадию.
      }
      continue;
    }
    try {
      if (!claimHireCompletion(hireStateDir, working, now)) continue;
    } catch (error) {
      logImpl(
        `managed_bot ${working.botId}: failed to record durable hire completion:`,
        redactError(error, secrets),
      );
      continue;
    }
    completed += 1;
    const botConfig: TelegramBotConfig = {
      botId: working.botId,
      token: configuredBot.token,
      ...(entry.username ? { username: entry.username } : {}),
      isPrimary: false,
    };
    deps.onColleagueHired?.(botConfig);
    const label = entry.name ?? working.name;
    const handle = entry.username ? ` (@${entry.username})` : "";
    await replyImpl(
      working.ownerUserId,
      tr(
        `Hired colleague ${label}${handle} — ${entry.provider}/${entry.model}. Ready for messages.`,
        `Наняла коллегу ${label}${handle} — ${entry.provider}/${entry.model}. Можно писать ему.`,
      ),
    ).catch((error: unknown) => {
      logImpl(
        `managed_bot ${working.botId}: owner confirmation reply failed:`,
        redactError(error, secrets),
      );
    });
    logImpl(
      `managed_bot ${working.botId}: durable hire completed role=${entry.role} model=${entry.provider}/${entry.model}`,
    );
  }

  return { attempted, completed };
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
    const outcome = await applyColleagueAvatarOnce({
      botId: entry.botId,
      botToken: bot.token,
      applyAvatar,
      avatarDeps: deps.avatarDeps,
    });
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
