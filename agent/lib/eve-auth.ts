import { createHash, timingSafeEqual } from "node:crypto";
import {
  extractBearerToken,
  UnauthenticatedError,
  localDev,
  placeholderAuth,
  vercelOidc,
  type AuthFn,
} from "eve/channels/auth";
import {
  botIdFromToken,
  TELEGRAM_BOT_ID_HEADER,
  validTelegramBotId,
} from "../../packages/telegram-bots/index.ts";

const SERVICE_AUTH = {
  attributes: {},
  authenticator: "iva-bearer",
  principalId: "iva-internal-client",
  principalType: "service",
} as const;

/**
 * Виды хода, которые ход Ивы называет заголовком `x-iva-turn`. Слой agent/ не импортирует
 * scripts/, поэтому это копия `REMINDER_TURN_KINDS` (scripts/lib/reminder-turn.ts); их
 * совпадение держит scripts/lib/reminder-turn.test.ts.
 */
const TURN_MAX_STEPS: Readonly<Record<string, number>> = Object.freeze({
  watch: 40,
  brief: 60,
  insight: 40,
  reminder: 40,
  signal: 40,
  alert: 40,
  helper: 80,
});
const TURN_MAX_INPUT_TOKENS = 4_000_000;
export const TURN_KINDS: ReadonlySet<string> = new Set(
  Object.keys(TURN_MAX_STEPS),
);

export function isHelperTurn(
  ctx?: {
    session?: {
      auth?: {
        initiator?: {
          authenticator: string;
          attributes?: Readonly<Record<string, unknown>> | null;
        } | null;
        current?: {
          authenticator: string;
          attributes?: Readonly<Record<string, unknown>> | null;
        } | null;
      } | null;
    } | null;
  } | null,
): boolean {
  return [ctx?.session?.auth?.initiator, ctx?.session?.auth?.current].some(
    (auth) =>
      auth?.authenticator === "iva-bearer" &&
      auth.attributes?.iva_turn === "helper",
  );
}

const HELPER_MODEL_TURNS = new Set<unknown>([
  "helper",
  "watch",
  "brief",
  "insight",
]);

/** Model selection is shared with isolated background turns; helper rights stay separate. */
export function usesHelperModel(
  ctx: Parameters<typeof isHelperTurn>[0],
): boolean {
  return [ctx?.session?.auth?.initiator, ctx?.session?.auth?.current].some(
    (auth) =>
      auth?.authenticator === "iva-bearer" &&
      HELPER_MODEL_TURNS.has(auth.attributes?.iva_turn),
  );
}

/**
 * Числовой botId коллеги для текущего хода (Telegram-ход коллеги или его Reminder-ход),
 * либо null для основного бота Ивы.
 */
export function colleagueBotIdOfTurn(
  ctx: Parameters<typeof isHelperTurn>[0],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const primaryBotId = botIdFromToken(env.TELEGRAM_BOT_TOKEN);
  for (const auth of [
    ctx?.session?.auth?.current,
    ctx?.session?.auth?.initiator,
  ]) {
    if (
      auth?.authenticator !== "telegram-webhook" &&
      auth?.authenticator !== "iva-bearer"
    ) {
      continue;
    }
    const raw = auth.attributes?.bot_id;
    if (!validTelegramBotId(raw)) continue;
    if (primaryBotId !== null && raw === primaryBotId) continue;
    return raw;
  }
  return null;
}

/** Service attributes are accepted only after bearer authentication. */
function serviceAuth(
  request: Request,
): NonNullable<Awaited<ReturnType<AuthFn<Request>>>> {
  const turn = request.headers.get("x-iva-turn");
  if (turn === null || !TURN_KINDS.has(turn)) return SERVICE_AUTH;
  const rawBotId = request.headers.get(TELEGRAM_BOT_ID_HEADER)?.trim();
  const primaryBotId = botIdFromToken(process.env.TELEGRAM_BOT_TOKEN);
  const colleagueBotId =
    validTelegramBotId(rawBotId) && rawBotId !== primaryBotId
      ? rawBotId
      : undefined;
  const attributes: Record<string, string> = {
    iva_turn: turn,
    iva_max_steps: String(TURN_MAX_STEPS[turn]),
    iva_max_input_tokens: String(TURN_MAX_INPUT_TOKENS),
    ...(colleagueBotId === undefined ? {} : { bot_id: colleagueBotId }),
  };
  if (turn !== "helper") return { ...SERVICE_AUTH, attributes };
  const id = request.headers.get("x-iva-helper");
  if (id === null || !/^h-[0-9a-f]{6}$/.test(id))
    throw new UnauthenticatedError();
  return {
    ...SERVICE_AUTH,
    attributes: { ...attributes, iva_helper: id },
  };
}

function equalSecret(left: string, right: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

/** Authenticate Iva's internal Eve clients with the shared bearer from `.env`. */
export function assistantBearerAuth(expectedToken?: string): AuthFn<Request> {
  const expected = expectedToken?.trim();
  return (request) => {
    if (request.headers.get("x-iva-turn") === "helper") serviceAuth(request);
    if (!expected) return null;
    const received = extractBearerToken(request.headers.get("authorization"));
    return received && equalSecret(received, expected)
      ? serviceAuth(request)
      : null;
  };
}

type EveAuthEnvironment = {
  readonly ASSISTANT_BEARER?: string;
  readonly EVE_DEV?: string;
};

export function createEveAuth(env: EveAuthEnvironment = process.env) {
  return [
    assistantBearerAuth(env.ASSISTANT_BEARER),
    vercelOidc(),
    // Eve sets EVE_DEV=1 itself. Production never trusts the request Host as authentication.
    ...(env.EVE_DEV === "1" ? [localDev()] : []),
    placeholderAuth(),
  ];
}
