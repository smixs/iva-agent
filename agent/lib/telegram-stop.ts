// Общая отмена хода для моста и webhook. Нативная ■ сверяет draftId и пару хода,
// /stop в мосте использует текущую пару. Оба пути зовут cancel-роут канала.
// Принятую отмену подтверждает терминальное событие хода в run-status.

import { requestTelegramCancel } from "./telegram-cancel-client.ts";
import { verifyTelegramRequest } from "eve/channels/telegram";
import { localCancelUrl } from "./telegram-cancel-route.ts";
import { allowedTelegramUsers } from "./telegram-allowlist.ts";
import { chatKeyOf, getChatStatus, setChatStatusIf } from "./run-status.ts";
import { tr } from "./i18n.ts";
import { isPrivateTelegramChat } from "./telegram-private-chat.ts";
import { traceStop } from "./trace.ts";

// Исходы не смешиваются: «отмену запросили, ждём факта», «отменять нечего» и «отменить не
// вышло из-за конфига» — разные факты с разным следующим шагом. Ответил ли роут и пришло ли
// подтверждение — тоже разные вещи: первое видно здесь, второе только по записи.
export type StopOutcome = "requested" | "unresponsive" | "idle" | "failed";
// Текст ответа описывает запрос отмены, состояние idle или отказ.
export type StopReplyOutcome = Exclude<StopOutcome, "unresponsive">;
export type StopStatus = Record<string, unknown> | null;
export type StopCancelResult = { readonly status?: unknown };
export type StopCancelRequest = {
  url: string;
  secret: string;
  sessionId: string;
  turnId?: string;
};
// Ответ на попытку отмены: у «отмены в пути» (роут ответил или промолчал) он один.
export function isPendingStopOutcome(outcome: StopOutcome): boolean {
  return outcome === "requested" || outcome === "unresponsive";
}

export function replyOutcomeOf(outcome: StopOutcome): StopReplyOutcome {
  return outcome === "unresponsive" ? "requested" : outcome;
}

// Функция, а не const: перевод выбирается в момент вызова (правило репо).
export function stopOutcomeText(outcome: StopReplyOutcome): string {
  if (outcome === "requested") return tr("Stopping…", "Останавливаю…");
  if (outcome === "idle")
    return tr("Nothing is running right now.", "Сейчас ничего не выполняется.");
  return tr("Couldn't stop the turn.", "Не удалось остановить ход.");
}

// Отменять можно ровно тогда, когда запись помнит непустой sessionId: свежесть
// записи для этого решения значения не имеет.
export function cancellableSessionId(status: StopStatus): string | null {
  const sessionId = status?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0
    ? sessionId
    : null;
}

function hasCancelSecret(secret: string | undefined): secret is string {
  return secret !== undefined && secret.length > 0;
}

// Гард от запоздалого нажатия: несовпавший turnId eve глотает как no-op, но пустая
// строка ушла бы как значение — поле остаётся только при настоящем идентификаторе.
function cancelRequestBody({
  url,
  secret,
  sessionId,
  turnId,
}: {
  url: string;
  secret: string;
  sessionId: string;
  turnId: unknown;
}): StopCancelRequest {
  return {
    url,
    secret,
    sessionId,
    ...(typeof turnId === "string" && turnId.length > 0 ? { turnId } : {}),
  };
}

type TurnCancelImpl = (input: StopCancelRequest) => Promise<StopCancelResult>;
type TurnCancelStatusReader = (chatKey: string) => StopStatus;
type TurnCancelLog = (...parts: unknown[]) => void;

// Подставленные дефолты политики остановки: дальше шаги получают готовые значения.
type TurnCancelRuntime = {
  readonly url: string;
  readonly secret: string | undefined;
  readonly cancelImpl: TurnCancelImpl;
  readonly getStatusImpl: TurnCancelStatusReader;
  readonly logImpl: TurnCancelLog;
};

// Одна попытка отмены: запись уже назвала сессию, секрет роута уже проверен.
type TurnCancelAttempt = TurnCancelRuntime & {
  readonly secret: string;
  readonly sessionId: string;
  readonly turnId: unknown;
};

// Trace: одна точка исхода на обе двери «Стопа» — журнал не может разойтись с политикой
// остановки, потому что смотрит на её же результат (ADR-0010).
function traceStopOutcome(
  chatKey: string | null,
  status: StopStatus,
  outcome: StopOutcome,
): StopOutcome {
  traceStop(chatKey ?? "", status ?? null, outcome);
  return outcome;
}

/**
 * ЕДИНАЯ политика остановки для обеих дверей: и мост, и канал ходят сюда, поэтому
 * «что считается живым ходом» не может разъехаться между режимами.
 *
 * Отменять или нет решает ЗАПИСЬ, а не её свежесть: протухшая (старше RUN_STALE_MS)
 * или снятая жнецом запись всё ещё помнит sessionId, а ход в eve может быть жив.
 * Свежесть здесь спрашивать нельзя — молчаливое «ничего не выполняется» на живой ход
 * и есть та ложь, которую чинит этот путь. Отвечает ли ход на самом деле, выясняет
 * роут: `no_active_turn` — серверное подтверждение, что отменять нечего.
 */
export async function requestTurnCancel(
  chatKey: string | null,
  {
    url,
    secret,
    cancelImpl = requestTelegramCancel,
    getStatusImpl = getChatStatus,
    logImpl = console.error,
  }: {
    url: string;
    secret?: string;
    cancelImpl?: TurnCancelImpl;
    getStatusImpl?: TurnCancelStatusReader;
    logImpl?: TurnCancelLog;
  },
): Promise<StopOutcome> {
  if (chatKey === null || chatKey.length === 0)
    return traceStopOutcome(chatKey, null, "idle");
  return cancelTurnAndConfirm(chatKey, getStatusImpl(chatKey), {
    url,
    secret,
    cancelImpl,
    getStatusImpl,
    logImpl,
  });
}

// Что решает запись: отменять нечего — idle, конфиг без секрета — failed. Исход в
// журнал идёт вместе ИСХОДНОЙ записью: она ещё помнит, чей ход останавливали.
async function cancelTurnAndConfirm(
  chatKey: string,
  status: StopStatus,
  runtime: TurnCancelRuntime,
): Promise<StopOutcome> {
  const sessionId = cancellableSessionId(status);
  if (sessionId === null) return traceStopOutcome(chatKey, status, "idle");
  const secret = runtime.secret;
  // Без секрета вебхука роут ответит 401 — молчать об этом хуже, чем сказать «не вышло»,
  // но и эскалация тут не поможет: это не зависший агент, а неполный конфиг.
  if (!hasCancelSecret(secret)) {
    runtime.logImpl("turn cancel failed: no TELEGRAM_WEBHOOK_SECRET_TOKEN");
    return traceStopOutcome(chatKey, status, "failed");
  }
  // Факт явного Стопа, до POST: terminal-событие может прийти раньше ответа.
  if (status?.compacting !== true)
    setChatStatusIf(
      chatKey,
      { sessionId, turnId: status?.turnId },
      { wasCancelled: true },
      { touch: false },
    );
  const outcome = await sendTurnCancel({
    ...runtime,
    secret,
    sessionId,
    turnId: status?.turnId,
  });
  if (outcome === "idle")
    setChatStatusIf(
      chatKey,
      { sessionId, turnId: status?.turnId },
      { wasCancelled: null },
      { touch: false },
    );
  return traceStopOutcome(chatKey, status, outcome);
}

// POST на cancel-роут: синхронная часть пути «Стоп». Что роут ответил — journal, а не
// истина: «принято» лишь значит, что сигнал отмены взят, поэтому наружу уходит
// «отмена в пути», а факт остановки приходит терминальным событием хода.
async function sendTurnCancel(
  attempt: TurnCancelAttempt,
): Promise<StopOutcome> {
  let result: StopCancelResult;
  try {
    result = await attempt.cancelImpl(
      cancelRequestBody({
        url: attempt.url,
        secret: attempt.secret,
        sessionId: attempt.sessionId,
        turnId: attempt.turnId,
      }),
    );
  } catch (error) {
    // Молчащий роут, отказ соединения, 5xx: отменять было что, ответа на отмену нет.
    // Ход при этом мог остаться живым; повторная /stop отправит новую отмену.
    attempt.logImpl("turn cancel failed:", error);
    return "unresponsive";
  }
  // no_active_turn — сервер сам подтвердил, что отменять уже нечего.
  return result?.status === "no_active_turn" ? "idle" : "requested";
}

export type TelegramDraftStop = {
  readonly chat: { readonly id: string | number; readonly type?: string };
  readonly message_thread_id?: number;
  readonly draft_id: number;
};

// Поля стопа для журнала: какой стоп пришёл и почему не сработал. Текста сообщений тут нет.
function stopFacts(event: Partial<TelegramDraftStop> | undefined): string {
  return JSON.stringify({
    chatId: event?.chat?.id ?? null,
    chatType: event?.chat?.type ?? null,
    draftId: event?.draft_id ?? null,
    threadId: event?.message_thread_id ?? null,
  });
}

export async function handleTelegramDraftStop(
  event: TelegramDraftStop,
  {
    allowedImpl = allowedTelegramUsers,
    urlImpl = localCancelUrl,
    secret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
    getStatusImpl = getChatStatus,
    logImpl = console.error,
    cancelImpl,
  }: {
    allowedImpl?: () => ReadonlySet<string>;
    urlImpl?: () => string;
    secret?: string;
    getStatusImpl?: TurnCancelStatusReader;
    logImpl?: TurnCancelLog;
    cancelImpl?: TurnCancelImpl;
  } = {},
): Promise<StopOutcome | "ignored"> {
  if (
    !Number.isSafeInteger(event?.draft_id) ||
    event.draft_id <= 0 ||
    !isPrivateTelegramChat(event?.chat) ||
    !allowedImpl().has(String(event.chat.id))
  ) {
    logImpl(
      "draft stop ignored: not an allowed private chat",
      stopFacts(event),
    );
    return "ignored";
  }
  const key = chatKeyOf(event.chat.id, event.message_thread_id);
  const snapshot = getStatusImpl(key);
  if (
    snapshot?.draftId !== event.draft_id ||
    typeof snapshot.turnId !== "string" ||
    !snapshot.turnId
  ) {
    logImpl(
      "draft stop ignored: no running turn with this draft",
      stopFacts(event),
    );
    return "ignored";
  }
  return requestTurnCancel(key, {
    url: urlImpl(),
    secret,
    cancelImpl,
    logImpl,
    getStatusImpl: () => snapshot,
  });
}

export async function handleTelegramDraftStopRequest(
  request: Request,
  original: (request: Request) => Promise<Response>,
  secretToken?: string,
): Promise<Response> {
  let raw: string;
  try {
    raw = await verifyTelegramRequest(request.clone(), { secretToken });
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  let update: { stopped_message_generation?: TelegramDraftStop };
  try {
    update = JSON.parse(raw) as typeof update;
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  if (!update?.stopped_message_generation) return original(request);
  await handleTelegramDraftStop(update.stopped_message_generation, {
    secret: secretToken,
  });
  return new Response("ok");
}
