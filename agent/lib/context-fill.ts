// Подсказка «нажмите /new»: каждое сообщение чата отправляет модели всю переписку сессии.
// Заполнение считается от бюджета — доли окна, на которой eve сжимает историю
// (agent/lib/compaction.ts). После доставленного ответа, когда вход последнего шага прошёл
// 50, 75 или 90 % бюджета, канал шлёт одну тихую строку; уровень запоминается только после
// успешной отправки. Ниже 50 % (история сжата) уровни свободны снова. Запись открывает канал
// на turn.started, поэтому фоновые сессии и субагенты сюда не попадают. Состояние в памяти
// процесса: после рестарта подсказка может прозвучать ещё раз.
import { COMPACTION_THRESHOLD_PERCENT } from "./compaction.ts";
import { tr } from "./i18n.ts";
import type { NoticeSend } from "./outbox.ts";

type Fill = { tokens: number | null; shown: number; delivered: boolean };
const sessions = new Map<string, Fill>();

/** Заполнение бюджета в целых процентах, не выше 100; пустое окно — null. */
export function contextFillPercent(tokens: number, windowTokens: number) {
  const budget = Math.floor(windowTokens * COMPACTION_THRESHOLD_PERCENT);
  return budget > 0 ? Math.min(100, Math.floor((tokens * 100) / budget)) : null;
}

export const contextFillLevel = (pct: number) =>
  pct >= 90 ? 90 : pct >= 75 ? 75 : pct >= 50 ? 50 : 0;

export function openContextFill(sessionId: string): void {
  const fill = sessions.get(sessionId);
  if (fill) Object.assign(fill, { tokens: null, delivered: false });
  else sessions.set(sessionId, { tokens: null, shown: 0, delivered: false });
}

/** Вход последнего шага открытой сессии; null — провайдер вход не назвал. */
export function recordStepContext(id: string, tokens: number | null): void {
  const fill = sessions.get(id);
  if (fill) fill.tokens = tokens;
}

export function markReplyDelivered(sessionId: string): void {
  const fill = sessions.get(sessionId);
  if (fill) fill.delivered = true;
}

export const contextFillHintText = (pct: number) =>
  tr(
    `The context window is ${pct}% full. Tap /new to start a new conversation.`,
    `Окно контекста заполнено на ${pct} %. Нажмите /new, чтобы начать новый разговор.`,
  );

export async function notifyContextFill(
  sessionId: string,
  windowTokens: number,
  send: NoticeSend,
): Promise<void> {
  const fill = sessions.get(sessionId);
  if (!fill?.delivered || fill.tokens === null) return;
  const pct = contextFillPercent(fill.tokens, windowTokens);
  if (pct === null) return;
  if (pct < 50) fill.shown = 0;
  const level = contextFillLevel(pct);
  if (level <= fill.shown) return;
  // Отказ отправки уровень не фиксирует: следующий ход попробует снова.
  const sent = await send(contextFillHintText(pct)).then(
    () => true,
    (error: unknown) => {
      console.error(`[telegram] подсказка про /new не ушла: ${String(error)}`);
      return false;
    },
  );
  if (sent) fill.shown = level;
}
