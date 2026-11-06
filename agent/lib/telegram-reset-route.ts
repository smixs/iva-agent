import type { RouteHandlerArgs } from "eve/channels";
import { verifyTelegramRequest } from "eve/channels/telegram";

export type TelegramSessionAddress = {
  chatId: string;
  messageThreadId?: number;
  conversationId?: string;
};

export type ResetTarget =
  | { sessionId: string; address?: never }
  | { sessionId?: never; address: TelegramSessionAddress };

type ResetOperations = Pick<
  RouteHandlerArgs,
  "attachSession" | "resolveSession"
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numericString = (value: unknown, signed: boolean): string | null => {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    value = String(value);
  }
  if (typeof value !== "string" || value.length === 0) return null;
  const pattern = signed ? /^-?\d+$/u : /^\d+$/u;
  return pattern.test(value) ? value : null;
};

function parseAddress(value: unknown): TelegramSessionAddress | null {
  if (!isRecord(value)) return null;
  const chatId = numericString(value.chatId, true);
  if (chatId === null) return null;
  const messageThreadId = value.messageThreadId;
  if (
    messageThreadId !== undefined &&
    (!Number.isSafeInteger(messageThreadId) || (messageThreadId as number) <= 0)
  ) {
    return null;
  }
  const conversationId =
    value.conversationId === undefined
      ? undefined
      : numericString(value.conversationId, false);
  if (conversationId === null) return null;
  return {
    chatId,
    ...(messageThreadId === undefined
      ? {}
      : { messageThreadId: messageThreadId as number }),
    ...(conversationId === undefined ? {} : { conversationId }),
  };
}

function addressKey(address: TelegramSessionAddress): string {
  return `${address.chatId}:${address.messageThreadId ?? ""}:${address.conversationId ?? ""}`;
}

export function parseTelegramResetTarget(value: unknown): ResetTarget | null {
  if (!isRecord(value)) return null;
  const hasSessionId = Object.hasOwn(value, "sessionId");
  const hasAddress = Object.hasOwn(value, "address");
  if (hasSessionId === hasAddress) return null;
  if (hasSessionId) {
    const sessionId = value.sessionId;
    return typeof sessionId === "string" && sessionId.length > 0
      ? { sessionId }
      : null;
  }
  const address = parseAddress(value.address);
  return address === null ? null : { address };
}

/** Authenticated Telegram-owned session reset endpoint. */
export async function handleTelegramResetRequest(
  req: Request,
  operations: ResetOperations,
  secretToken?: string,
): Promise<Response> {
  let raw;
  try {
    raw = await verifyTelegramRequest(req, { secretToken });
  } catch {
    return new Response("unauthorized", { status: 401 });
  }

  let target;
  try {
    target = parseTelegramResetTarget(JSON.parse(raw));
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  if (target === null) {
    return new Response("exactly one valid sessionId or address is required", {
      status: 400,
    });
  }

  const session =
    target.sessionId === undefined
      ? await operations.resolveSession(addressKey(target.address))
      : operations.attachSession(target.sessionId);
  const result = session
    ? await session.reset({ reason: "Telegram recovery command" })
    : { status: "no_active_session" as const };
  return Response.json({ ok: true, ...result });
}
