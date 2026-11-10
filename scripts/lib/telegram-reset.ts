/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- conversion keeps the injectable fetch boundary source-compatible. */

type Status = Record<string, unknown> | null | undefined;
export type TelegramSessionAddress = {
  chatId: string;
  messageThreadId?: number;
  conversationId?: string;
};
export type TelegramResetTarget =
  | { sessionId: string; address?: never; chatKey?: string }
  | { sessionId?: never; address: TelegramSessionAddress };

type TelegramMessage = {
  chat?: { id?: unknown; type?: unknown };
  message_id?: unknown;
  message_thread_id?: unknown;
  reply_to_message?: {
    from?: { is_bot?: unknown; id?: unknown };
    message_id?: unknown;
  };
};
type Update = {
  message?: TelegramMessage;
  callback_query?: { message?: TelegramMessage; [key: string]: unknown };
};
type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};
type FetchImpl = (url: string, init: RequestInit) => Promise<FetchResponse>;

function storedSession(status: Status): { sessionId: string } | null {
  const sessionId = status?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0
    ? { sessionId }
    : null;
}

function numericId(value: unknown, signed: boolean): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    value = String(value);
  }
  if (typeof value !== "string" || value.length === 0) return null;
  const pattern = signed ? /^-?\d+$/u : /^\d+$/u;
  return pattern.test(value) ? value : null;
}

function threadId(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

function addressForMessage(
  message: TelegramMessage,
  conversationId?: unknown,
): TelegramSessionAddress | null {
  const chatId = numericId(message.chat?.id, true);
  const messageThreadId = threadId(message.message_thread_id);
  const parsedConversationId =
    conversationId === undefined ? undefined : numericId(conversationId, false);
  if (
    chatId === null ||
    messageThreadId === null ||
    parsedConversationId === null
  ) {
    return null;
  }
  return {
    chatId,
    ...(messageThreadId === undefined ? {} : { messageThreadId }),
    ...(parsedConversationId === undefined
      ? {}
      : { conversationId: parsedConversationId }),
  };
}

/** Builds the exact reset target selected by a Telegram control update. */
export function resetTargetForControl(
  update: Update,
  status: Status,
  botUserId?: string | number,
): TelegramResetTarget | null {
  const message = update.message ?? update.callback_query?.message;
  if (!message) return storedSession(status);

  const reply = message.reply_to_message;
  if (message.chat?.type !== "private" && reply !== undefined) {
    if (
      reply.from?.is_bot === true &&
      String(reply.from.id) === String(botUserId) &&
      reply.message_id !== undefined
    ) {
      const address = addressForMessage(message, reply.message_id);
      return address ? { address } : null;
    }
    return null;
  }

  const stored = storedSession(status);
  if (stored) {
    const address = addressForMessage(message);
    return address
      ? {
          ...stored,
          chatKey: `${address.chatId}:${address.messageThreadId ?? ""}`,
        }
      : stored;
  }
  if (message.chat?.type !== "private") return null;
  const address = addressForMessage(message);
  return address ? { address } : null;
}

/** Reconstructs the private-chat or topic address stored by a reset intent. */
export function telegramAddressFromChatKey(
  chatKey: string,
): TelegramSessionAddress | null {
  const separator = chatKey.indexOf(":");
  if (separator <= 0) return null;
  const chatId = numericId(chatKey.slice(0, separator), true);
  if (chatId === null) return null;
  const rawThreadId = chatKey.slice(separator + 1);
  if (rawThreadId === "") return { chatId };
  const parsedThreadId = Number(rawThreadId);
  if (
    !/^\d+$/u.test(rawThreadId) ||
    !Number.isSafeInteger(parsedThreadId) ||
    parsedThreadId <= 0
  ) {
    return null;
  }
  return { chatId, messageThreadId: parsedThreadId };
}

/** Calls Iva's Telegram-owned reset route. Both outcomes are successful. */
export async function requestTelegramReset({
  url,
  secret,
  target,
  fetchImpl = fetch as unknown as FetchImpl,
  timeoutMs = 15_000,
}: {
  url: string;
  secret: string;
  target: TelegramResetTarget;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body: JSON.stringify(target),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(`Eve reset route returned HTTP ${response.status}`);

  const body = (await response.json()) as { ok?: unknown; status?: unknown };
  if (
    body?.ok !== true ||
    (body.status !== "reset" && body.status !== "no_active_session")
  ) {
    throw new Error("Eve reset route returned an invalid response");
  }
  return body;
}
