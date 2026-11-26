// Вход /compact из моста: роут ставит сессии пометку свёртки — саму свёртку делает eve
// перед следующим шагом модели. Канал историю не пересказывает и чат под неё не занимает.
import type { RouteHandlerArgs } from "eve/channels";
import { verifyTelegramRequest } from "eve/channels/telegram";
import {
  parseTelegramResetTarget,
  type ResetTarget,
} from "./telegram-reset-route.ts";
import { getChatStatus } from "./run-status.ts";
import { tr } from "./i18n.ts";

export const TELEGRAM_COMPACT_ROUTE = "/eve/v1/telegram/compact";

async function readCompactRequest(req: Request, secretToken?: string) {
  let raw;
  try {
    raw = await verifyTelegramRequest(req, { secretToken });
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  let body: { chatKey?: unknown; target?: unknown } | null;
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  const key = body?.chatKey;
  const target = parseTelegramResetTarget(body?.target);
  if (
    typeof key !== "string" ||
    !/^(?:bot:[1-9]\d*:)?-?\d+:\d*$/u.test(key) ||
    !target
  )
    return new Response("chatKey and target are required", { status: 400 });
  return { key, target };
}

type CompactOperations = Pick<
  RouteHandlerArgs,
  "attachSession" | "resolveSession"
>;
function resolveCompactSession(
  target: ResetTarget,
  operations: CompactOperations,
) {
  if (target.sessionId !== undefined)
    return operations.attachSession(target.sessionId);
  const address = target.address;
  return operations.resolveSession(
    `${address.chatId}:${address.messageThreadId ?? ""}:${address.conversationId ?? ""}`,
  );
}

export async function handleTelegramCompactRequest(
  req: Request,
  operations: CompactOperations,
  mark: (sessionId: string) => Promise<boolean>,
  secretToken?: string,
): Promise<Response> {
  const parsed = await readCompactRequest(req, secretToken);
  if (parsed instanceof Response) return parsed;
  const { key, target } = parsed;
  const session = await resolveCompactSession(target, operations);
  if (!session || getChatStatus(key)?.resetAt !== undefined)
    return Response.json({
      text: tr(
        "There's nothing to compress yet: the conversation has just been cleared.",
        "Пока сжимать нечего: разговор только что очищен.",
      ),
    });
  // Исход просьбы может быть неизвестен (таймаут, сбой диспетчера): тот же честный ответ.
  const accepted = await mark(session.id).catch(() => false);
  return Response.json({
    text: accepted
      ? tr(
          "I'll compress the conversation before the next answer.",
          "Сожму разговор перед следующим ответом.",
        )
      : tr(
          "Compression couldn't be confirmed. Try /compact again.",
          "Подтверждение сжатия пока отсутствует. Повтори /compact.",
        ),
  });
}
