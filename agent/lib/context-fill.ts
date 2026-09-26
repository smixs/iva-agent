// Подсказка «нажмите /new»: каждое сообщение чата отправляет модели всю переписку сессии,
// и к вечеру одно «привет» стоит десятки тысяч токенов. Заполнение считается от бюджета —
// доли окна, на которой eve сжимает историю (agent/lib/compaction.ts): выше неё контекст не
// растёт. Когда вход последнего шага хода переходит 50, 75 или 90 % бюджета, канал после
// ответа шлёт одну тихую строку с процентом. Каждый порог — раз за цикл заполнения: падение
// ниже 50 % (история сжата) взводит пороги заново. Новая сессия (/new) начинает с нуля.
//
// Порядок событий eve: message.completed уходит в конце стрима шага, а step.completed того
// же шага — позже, из хуков шага. Поэтому канал в message.completed только отмечает, что
// ответ хода дошёл, а подсказку шлёт в turn.completed, когда вход последнего шага записан.
//
// В карте только сессии Telegram-чата: запись открывает канал на turn.started, хук шага лишь
// обновляет открытую. Состояние живёт в памяти процесса: после рестарта порог может
// прозвучать ещё раз.
import { COMPACTION_THRESHOLD_PERCENT } from "./compaction.ts";
import { tr } from "./i18n.ts";
import type { NoticeSend } from "./outbox.ts";

const CONTEXT_FILL_THRESHOLDS = [50, 75, 90] as const;
const REARM_BELOW = CONTEXT_FILL_THRESHOLDS[0];
// Страховка от роста карты в долгоживущем процессе: самая давняя сессия уходит первой.
const MAX_SESSIONS = 256;

interface SessionFill {
  contextTokens: number | null;
  highest: number;
  deliveredTurn: string | null;
}

const sessions = new Map<string, SessionFill>();

/** Бюджет контекста: доля окна, на которой eve сжимает историю. */
export function contextBudget(windowTokens: number): number {
  return Math.floor(windowTokens * COMPACTION_THRESHOLD_PERCENT);
}

/** Заполнение бюджета в целых процентах (не выше 100); пустой бюджет — null. */
export function contextFillPercent(
  contextTokens: number,
  budgetTokens: number,
): number | null {
  if (budgetTokens <= 0) return null;
  return Math.min(100, Math.floor((contextTokens * 100) / budgetTokens));
}

/**
 * Следующее состояние порогов. highest — старший отмеченный порог (0 — ни одного).
 * crossed — старший порог, перейдённый сейчас; несколько порогов за раз дают одну подсказку.
 * Ниже 50 % пороги взводятся заново.
 */
export function nextContextFill(
  highest: number,
  percent: number | null,
): { highest: number; crossed: number | null } {
  if (percent === null) return { highest, crossed: null };
  if (percent < REARM_BELOW) return { highest: 0, crossed: null };
  const crossed = CONTEXT_FILL_THRESHOLDS.filter(
    (threshold) => threshold > highest && percent >= threshold,
  ).at(-1);
  return crossed === undefined
    ? { highest, crossed: null }
    : { highest: crossed, crossed };
}

/** Канал открывает сессию своего чата на старте хода; уже открытая остаётся как есть. */
export function openContextFill(sessionId: string): void {
  const existing = sessions.get(sessionId);
  sessions.delete(sessionId);
  sessions.set(
    sessionId,
    existing ?? { contextTokens: null, highest: 0, deliveredTurn: null },
  );
  if (sessions.size > MAX_SESSIONS)
    sessions.delete(sessions.keys().next().value as string);
}

/**
 * Вход шага открытой сессии (у eve он уже включает прочитанное из кэша); null — шаг без
 * расхода, контекст неизвестен. Чужую сессию не создаёт.
 */
export function recordStepContext(
  sessionId: string,
  inputTokens: number | null,
): void {
  const fill = sessions.get(sessionId);
  if (fill) fill.contextTokens = inputTokens;
}

/** Ответ хода дошёл до чата: только такой ход может закончиться подсказкой. */
export function markReplyDelivered(sessionId: string, turnId: string): void {
  const fill = sessions.get(sessionId);
  if (fill && turnId) fill.deliveredTurn = turnId;
}

export function contextFillHintText(percent: number): string {
  return tr(
    `The context window is ${percent}% full. Tap /new to start a new conversation.`,
    `Окно контекста заполнено на ${percent} %. Нажмите /new, чтобы начать новый разговор.`,
  );
}

/**
 * После хода: если ответ этого хода дошёл и контекст перешёл порог, одна строка через send.
 * Порог заявляется до отправки (второй вызов того же хода его уже не возьмёт) и
 * освобождается, если строка не ушла: следующий ход скажет снова.
 */
export async function notifyContextFill(
  sessionId: string,
  turnId: string,
  windowTokens: number,
  send: NoticeSend,
): Promise<void> {
  const fill = sessions.get(sessionId);
  if (!fill || !turnId || fill.deliveredTurn !== turnId) return;
  fill.deliveredTurn = null;
  const before = fill.highest;
  const percent =
    fill.contextTokens === null
      ? null
      : contextFillPercent(fill.contextTokens, contextBudget(windowTokens));
  const next = nextContextFill(before, percent);
  fill.highest = next.highest;
  if (next.crossed === null || percent === null) return;
  try {
    await send(contextFillHintText(percent));
  } catch (error) {
    if (fill.highest === next.highest) fill.highest = before;
    console.error(
      `[telegram] подсказка про /new не отправилась, порог ${next.crossed} свободен: ${String(error)}`,
    );
  }
}
