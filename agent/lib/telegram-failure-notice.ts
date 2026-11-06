// Сообщение о падении хода. У terminal-сбоя eve присылает и turn.failed, и
// session.failed — оба несут одну и ту же беду, но пользователь должен увидеть её
// один раз. Заявка на уведомление берётся по сессии и ходу и живёт TTL; не ушедшее
// сообщение освобождает заявку, чтобы следующее событие всё-таки объяснило сбой.
//
// Это служебная реплика канала, а не текст модели, но не мимо гейта: срок сброса лимита и
// путь до поля схемы взяты из ответа провайдера. Отправку модуль поэтому просит брендованную
// (NoticeSend): гейт стоит на вызове Bot API, а не тут (правило в outbox.ts). Реплика с
// кнопкой «Повторить» канал везёт швом Outbox: кнопка живёт только в rich-сообщении.
import { humanizeProviderError } from "./error-humanizer.ts";
import { notificationChat } from "./notification-chat.ts";
import { modelAuthFailure } from "./model-auth.ts";
import {
  dispatchModelAuth,
  type AuthObservation,
} from "./model-auth-dispatch.ts";
import { tr } from "./i18n.ts";
import type { NoticeSend } from "./outbox.ts";

export type TelegramFailureData = {
  message: string;
  chatId?: string | number | undefined;
  details?: unknown;
  /** Последнее принятое сообщение владельца (turn-question.ts): цитата при обрыве. */
  question?: string | undefined;
  /** В том сообщении было вложение: просим прислать его ещё раз вместо кнопки. */
  media?: boolean | undefined;
  /** Групповой чат: цитата не показывается. */
  group?: boolean | undefined;
};

type FailureNotice = { turnId: string | null; notifiedAt: number };

const FAILURE_NOTIFICATION_TTL_MS = 60_000;
const failureNotifications = new Map<string, FailureNotice>();

function pruneFailureNotifications(now: number): void {
  for (const [sessionId, notice] of failureNotifications) {
    if (now - notice.notifiedAt >= FAILURE_NOTIFICATION_TTL_MS) {
      failureNotifications.delete(sessionId);
    }
  }
}

function claimFailureNotification(
  sessionId: string,
  turnId: string | null,
  now: number,
): number | null {
  pruneFailureNotifications(now);
  const previous = failureNotifications.get(sessionId);
  if (
    previous !== undefined &&
    now - previous.notifiedAt < FAILURE_NOTIFICATION_TTL_MS &&
    (previous.turnId === null || turnId === null || turnId === previous.turnId)
  ) {
    return null;
  }
  failureNotifications.set(sessionId, { turnId, notifiedAt: now });
  return now;
}

function releaseFailureNotification(sessionId: string, claim: number): void {
  if (failureNotifications.get(sessionId)?.notifiedAt === claim) {
    failureNotifications.delete(sessionId);
  }
}

// Error id в чат не идёт: владельцу он ничего не говорит. Он остаётся в журнале сервиса
// (eve пишет его в строке сбоя) и в Trace (agent/hooks/trace.ts выносит его из details).
export function telegramFailureMessage(
  data: TelegramFailureData,
  provider: string | undefined = process.env.MODEL_PROVIDER,
): string {
  const text = humanizeProviderError({
    message: data.message,
    details: data.details,
    question: data.question,
    media: data.media,
    group: data.group,
    provider,
  });
  return tr(text.en, text.ru);
}

// Отправляет объяснение сбоя ровно один раз на ход: turn.failed и следующий за ним
// session.failed того же сбоя несут один ход (либо null), а второй упавший ход той же
// сессии получает своё уведомление. Сбой самой отправки глотаем: сообщение об ошибке
// не повод рушить обработчик события.
export async function notifyTelegramFailure(
  sessionId: string,
  turnId: string | null,
  data: TelegramFailureData,
  send: NoticeSend,
  {
    now = Date.now(),
    authDispatch = dispatchModelAuth,
  }: {
    now?: number;
    authDispatch?: (observation: AuthObservation) => Promise<void>;
  } = {},
): Promise<void> {
  const provider = modelAuthFailure(data);
  if (turnId === "") {
    console.error(
      `[telegram] turn.failed без turnId, сессия ${sessionId}: уведомление считаю по сессии`,
    );
  }
  const claim = claimFailureNotification(
    sessionId,
    turnId === "" ? null : turnId,
    now,
  );
  if (claim === null) return;
  const reply = async () => {
    try {
      await send(telegramFailureMessage(data));
    } catch (error) {
      releaseFailureNotification(sessionId, claim);
      throw error;
    }
  };
  if (provider) {
    const owner = notificationChat({
      ...process.env,
      TELEGRAM_DIGEST_CHAT_ID: "",
    });
    void authDispatch({
      provider,
      at: now,
      failed: true,
      answers: true,
      reply,
      ownerReply:
        !data.group && owner !== "" && String(data.chatId ?? "") === owner,
    });
    return;
  }
  try {
    await reply();
  } catch (error) {
    releaseFailureNotification(sessionId, claim);
    console.error(
      `[telegram] не смог отправить уведомление о сбое хода: ${String(error)}`,
    );
  }
}
