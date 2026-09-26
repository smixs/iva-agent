// Подсказка «нажмите /new»: после доставленного ответа, когда вход последнего шага прошёл 50,
// 75 или 90 % бюджета (доля окна, на которой eve сжимает историю), канал шлёт одну тихую
// строку. Уровень запоминается после успешной отправки и освобождается сжатием истории.
// Запись открывает канал на turn.started; состояние в памяти процесса.
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

const patch = (sessionId: string, change: Partial<Fill>) => {
  const fill = sessions.get(sessionId);
  if (fill) Object.assign(fill, change);
};

export function openContextFill(sessionId: string): void {
  if (sessions.has(sessionId))
    patch(sessionId, { tokens: null, delivered: false });
  else sessions.set(sessionId, { tokens: null, shown: 0, delivered: false });
}

/** Вход последнего шага открытой сессии; null — провайдер вход не назвал. */
export const recordStepContext = (id: string, tokens: number | null) =>
  patch(id, { tokens });
/** eve сжал историю сессии (compaction.completed): уровни свободны снова. */
export const rearmContextFill = (id: string) => patch(id, { shown: 0 });
export const markReplyDelivered = (id: string) =>
  patch(id, { delivered: true });

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
  const level = pct === null ? 0 : contextFillLevel(pct);
  if (pct === null || level <= fill.shown) return;
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
