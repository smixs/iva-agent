import type { RouteHandlerArgs } from "eve/channels";
import { verifyTelegramRequest } from "eve/channels/telegram";
import { isRecord } from "../../packages/guards/index.ts";

export type TelegramSessionAddress = {
  chatId: string;
  messageThreadId?: number;
  conversationId?: string;
};

export type ResetTarget =
  | { sessionId: string; address?: never; chatKey?: string }
  | { sessionId?: never; address: TelegramSessionAddress };

export type TelegramResetRequest = {
  target: ResetTarget;
  chatKey?: string;
  resetEpoch?: number;
};

type ResetOperations = Pick<
  RouteHandlerArgs,
  "attachSession" | "resolveSession"
>;

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

// Ключ чата в конверте сброса: «chatId» или «chatId:thread» — обе части
// целые безопасные числа, thread без ведущего нуля.
const CHAT_KEY_PATTERN = /^-?\d+:(?:[1-9]\d*)?$/u;

function isChatKey(value: string): boolean {
  if (!CHAT_KEY_PATTERN.test(value)) return false;
  const [chatId, thread] = value.split(":");
  return (
    Number.isSafeInteger(Number(chatId)) &&
    (thread === undefined || Number.isSafeInteger(Number(thread)))
  );
}

export function parseTelegramResetTarget(value: unknown): ResetTarget | null {
  if (!isRecord(value)) return null;
  const hasSessionId = Object.hasOwn(value, "sessionId");
  const hasAddress = Object.hasOwn(value, "address");
  if (hasSessionId === hasAddress) return null;
  if (hasSessionId) {
    const sessionId = value.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    if (!Object.hasOwn(value, "chatKey")) return { sessionId };
    if (typeof value.chatKey !== "string" || !isChatKey(value.chatKey))
      return null;
    const [chatId, thread] = value.chatKey.split(":");
    const address = parseAddress({
      chatId,
      ...(thread ? { messageThreadId: Number(thread) } : {}),
    });
    return address ? { sessionId, chatKey: value.chatKey } : null;
  }
  if (Object.hasOwn(value, "chatKey")) return null;
  const address = parseAddress(value.address);
  return address === null ? null : { address };
}

// Конверт запроса сброса: цель плюс необязательные chatKey (ключ серверной
// очереди и журнала эпох) и resetEpoch (эпоха намерения на проводе, T341).
export function parseTelegramResetRequest(
  value: unknown,
): TelegramResetRequest | null {
  if (!isRecord(value)) return null;
  const chatKey = value.chatKey;
  const resetEpoch = value.resetEpoch;
  if (
    chatKey !== undefined &&
    (typeof chatKey !== "string" || !isChatKey(chatKey))
  )
    return null;
  if (
    resetEpoch !== undefined &&
    (!Number.isSafeInteger(resetEpoch) || (resetEpoch as number) < 0)
  )
    return null;
  // chatKey и resetEpoch — поля конверта; цель разбирается без них: address
  // в связке с chatKey допустим (сверка зовёт роут адресом и ключом).
  const targetValue = { ...value };
  delete targetValue.chatKey;
  delete targetValue.resetEpoch;
  const target = parseTelegramResetTarget(targetValue);
  if (target === null) return null;
  return {
    target,
    ...(chatKey === undefined ? {} : { chatKey: chatKey }),
    ...(resetEpoch === undefined ? {} : { resetEpoch: resetEpoch as number }),
  };
}

// Один remote-сброс на чат действует и на сервере: вызовы одного ключа
// исполняются по одному в порядке приёма, а вызов, чья эпоха уже упала,
// отклоняется — клиентский таймаут не доказывает, что запрос до сервера не
// дошёл, и запоздавшее исполнение старого намерения не должно трогать свежий
// разговор (specs/ResetEpoch.tla, SrvLand; T341).
const resetRouteSlots = new Map<string, Promise<unknown>>();
const resetLandedEpochs = new Map<string, number>();

// Запрос агента переживает смерть Bridge: поздний resolveSession может вернуть сессию
// с сообщением после отсечки. Номер завершённого сброса того же чата ограждает её
// от старых запросов (AgentStale). Восстановление при этом
// может закончиться, пока прежний запрос ещё ждёт разрешения адреса.
const resetCompletedByChat = new Map<string, number>();
let resetAcceptedSeq = 0;

function resetRouteKey(request: TelegramResetRequest): string {
  if (request.chatKey !== undefined) return `chat:${request.chatKey}`;
  const { target } = request;
  return target.sessionId === undefined
    ? `address:${addressKey(target.address)}`
    : `session:${target.sessionId}`;
}

async function enqueueResetRoute<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = resetRouteSlots.get(key) ?? Promise.resolve();
  const run = previous.then(work);
  const tail: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  );
  resetRouteSlots.set(key, tail);
  try {
    return await run;
  } finally {
    if (resetRouteSlots.get(key) === tail) resetRouteSlots.delete(key);
  }
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

  let request;
  try {
    request = parseTelegramResetRequest(JSON.parse(raw));
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  if (request === null) {
    return new Response(
      "exactly one valid sessionId or address is required (chatKey and resetEpoch optional)",
      { status: 400 },
    );
  }

  const { target, resetEpoch } = request;
  const accepted = ++resetAcceptedSeq;
  const key = resetRouteKey(request);
  // Ключ журнала завершений — как до введения эпох: chatKey либо адресные
  // «chatId:thread»; без ключа (голый sessionId) записи нет.
  const completionKey =
    request.chatKey ??
    (target.sessionId === undefined
      ? `${target.address.chatId}:${target.address.messageThreadId ?? ""}`
      : target.chatKey);
  if (
    resetEpoch !== undefined &&
    resetEpoch <= (resetLandedEpochs.get(key) ?? -1)
  ) {
    return Response.json({ ok: true, status: "superseded" });
  }
  // Сессию разрешают без слота: поздний resolveSession старого запроса обязан
  // войти, пока новый сброс того же чата ещё исполняется — guard по номеру
  // приёма отсечёт его после разрешения (AgentStale). Слот держит только сам
  // сброс и журнал эпох: вызовы одного ключа исполняются по одному.
  const session =
    target.sessionId !== undefined
      ? operations.attachSession(target.sessionId)
      : await operations.resolveSession(addressKey(target.address));
  const work = async () => {
    if (
      resetEpoch !== undefined &&
      resetEpoch <= (resetLandedEpochs.get(key) ?? -1)
    ) {
      return Response.json({ ok: true, status: "superseded" });
    }
    const resetSinceAccepted =
      target.sessionId === undefined &&
      completionKey !== undefined &&
      (resetCompletedByChat.get(completionKey) ?? 0) > accepted;
    const result =
      session && !resetSinceAccepted
        ? await session.reset({ reason: "Telegram recovery command" })
        : { status: "no_active_session" as const };
    if (completionKey !== undefined && !resetSinceAccepted) {
      // Пока reset() ждал, более новый запрос мог уже закончиться (AgentDone: doneSeq).
      resetCompletedByChat.set(
        completionKey,
        Math.max(resetCompletedByChat.get(completionKey) ?? 0, accepted),
      );
      // Эпоха считается упавшей и при no_active_session: запрос исполнен.
      if (resetEpoch !== undefined) {
        resetLandedEpochs.set(
          key,
          Math.max(resetLandedEpochs.get(key) ?? -1, resetEpoch),
        );
      }
    }
    return Response.json({ ok: true, ...result });
  };
  // Слот — только у вызовов с эпохой (wire-протокол намерений): их исполнение
  // идёт по одному в порядке приёма на ключ. Вызовы без эпохи — старый
  // протокол: их параллельное исполнение ограждает accept-seq журнал.
  return resetEpoch === undefined ? work() : enqueueResetRoute(key, work);
}
