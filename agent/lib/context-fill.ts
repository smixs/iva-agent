// Подсказка «нажмите /new»: каждое сообщение чата отправляет модели всю переписку сессии,
// и к вечеру одно «привет» стоит десятки тысяч токенов. Когда вход последнего шага хода
// переходит 50, 75 или 90 % окна модели, канал после ответа шлёт одну служебную строку с
// процентом. Каждый порог — не больше раза за сессию; новая сессия (/new) начинает с нуля.
//
// Порядок событий eve: message.completed уходит в конце стрима шага, а step.completed того
// же шага — позже, из хуков шага. Поэтому канал в message.completed только отмечает, что
// ответ хода дошёл, а подсказку спрашивает в turn.completed, когда вход последнего шага
// уже записан. Состояние живёт в памяти процесса: после рестарта пороги считаются заново.
import { tr } from "./i18n.ts";

export const CONTEXT_FILL_THRESHOLDS = [50, 75, 90] as const;

// Сессий в процессе немного (чаты владельца, фоновые ходы), но карта не должна расти без
// предела: самая давняя по записи сессия уходит первой.
const MAX_SESSIONS = 256;

interface SessionFill {
  contextTokens?: number;
  highest: number;
  deliveredTurn?: string;
}

const sessions = new Map<string, SessionFill>();

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Заполнение окна в целых процентах (не выше 100) или null, если посчитать нечего. */
export function contextFillPercent(
  contextTokens: unknown,
  windowTokens: unknown,
): number | null {
  if (!isCount(contextTokens) || !isCount(windowTokens) || windowTokens === 0)
    return null;
  return Math.min(100, Math.floor((contextTokens / windowTokens) * 100));
}

/**
 * Следующее состояние порогов. highest — старший уже отмеченный порог (0 — ни одного).
 * crossed — старший порог, перейдённый сейчас; несколько порогов за раз дают одну подсказку.
 */
export function nextContextFill(
  highest: number,
  percent: number | null,
): { highest: number; crossed: number | null } {
  if (percent === null) return { highest, crossed: null };
  const crossed = CONTEXT_FILL_THRESHOLDS.filter(
    (threshold) => threshold > highest && percent >= threshold,
  ).at(-1);
  return crossed === undefined
    ? { highest, crossed: null }
    : { highest: crossed, crossed };
}

function sessionFill(sessionId: string): SessionFill {
  const existing = sessions.get(sessionId);
  if (existing) {
    sessions.delete(sessionId);
    sessions.set(sessionId, existing);
    return existing;
  }
  const created: SessionFill = { highest: 0 };
  sessions.set(sessionId, created);
  if (sessions.size > MAX_SESSIONS)
    sessions.delete(sessions.keys().next().value as string);
  return created;
}

/** Вход шага основной сессии: у eve он уже включает прочитанное из кэша. */
export function recordStepContext(
  sessionId: string,
  inputTokens: unknown,
): void {
  if (!sessionId || !isCount(inputTokens)) return;
  sessionFill(sessionId).contextTokens = inputTokens;
}

/** Ответ хода дошёл до чата: только такой ход может закончиться подсказкой. */
export function markReplyDelivered(sessionId: string, turnId: string): void {
  if (!sessionId || !turnId) return;
  sessionFill(sessionId).deliveredTurn = turnId;
}

/**
 * Подсказка после хода: процент и порог до неё (для возврата, если строка не ушла), или
 * null. Ход забирается один раз.
 */
export function takeContextFillHint(
  sessionId: string,
  turnId: string,
  windowTokens: unknown,
): { percent: number; previous: number } | null {
  const fill = sessions.get(sessionId);
  if (!fill || !turnId || fill.deliveredTurn !== turnId) return null;
  fill.deliveredTurn = undefined;
  const percent = contextFillPercent(fill.contextTokens, windowTokens);
  const previous = fill.highest;
  const next = nextContextFill(previous, percent);
  fill.highest = next.highest;
  return next.crossed === null || percent === null
    ? null
    : { percent, previous };
}

/** Подсказка не дошла до чата: порог снова свободен, следующий ход попробует ещё раз. */
export function returnContextFillHint(
  sessionId: string,
  previous: number,
): void {
  const fill = sessions.get(sessionId);
  if (fill) fill.highest = Math.min(fill.highest, previous);
}

export function contextFillHintText(percent: number): string {
  return tr(
    `The context window is ${percent}% full. Tap /new to start a new conversation.`,
    `Окно контекста заполнено на ${percent} %. Нажмите /new, чтобы начать новый разговор.`,
  );
}

export function resetContextFillForTests(): void {
  sessions.clear();
}
