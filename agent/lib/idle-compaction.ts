// Свёртка между ходами: история сессии пересказывается, пока человек ничего не ждёт.
//
// Порядок: хук шага пишет вход каждого шага; на turn.completed канал решает, пора ли; на
// следующем session.waiting (ход запаркован) занимает чат записью running + compacting и
// зовёт штатный роут свёртки eve, дожидаясь ответа: eve ждёт обработчик события, поэтому
// просьба встаёт в её очередь раньше, чем она выберет следующее действие. Конец пересказа —
// успех, сбой или обрыв — eve тоже отмечает session.waiting, и тот же обработчик канала
// освобождает чат.
//
// Чат занят на время пересказа по трём причинам. Мост при порядке queue держит пришедшие
// сообщения в своей очереди на диске и отвечает «Сжимаю разговор, скоро отвечу.»
// (scripts/poller/queue.ts). Перезапуск посреди пересказа виден восстановлению так же, как
// оборванный ход (scripts/recover-interrupted-turns.ts): без этого сессия eve остаётся с
// занятым входом команд и зависает (c1, 05.10.2026). И вторая просьба не встаёт в очередь
// eve, пока первая не кончилась.
//
// Здесь только решение и счёт, в памяти процесса: после рестарта свёртка ждёт следующего
// хода, а выключение (off) забыто — цена один лишний пересказ на рестарт.
import { idleCompactionLimit } from "./compaction.ts";

type Turn = {
  /** Между turn.started и концом хода: пересказ в это время — страховка eve, не наш. */
  open: boolean;
  /** Первый известный и последний вход шага текущего хода; null — провайдер не назвал. */
  first: number | null;
  last: number | null;
  /** Законченный ход дошёл до порога: на session.waiting пора просить пересказ. */
  due: boolean;
  /** После прошлого хода пересказ просили; compacted — eve довела его до конца. */
  asked: boolean;
  compacted: boolean;
  /** Законченный пересказ не увёл вход под порог: больше между ходами не сворачиваем. */
  off: boolean;
  /**
   * Просьба ушла, а начала пересказа eve ещё не объявила: чем занять чат, когда объявит.
   * Пока она есть (и не старше ASK_FORGOTTEN_MS), второй просьбы нет.
   */
  reclaim: (() => unknown) | null;
  reclaimAt: number;
};
const turns = new Map<string, Turn>();
// Сессия живёт не дольше суток, а процесс — до обновления: давно молчащие вытесняются.
const TURNS_KEPT = 200;
// Просьба без ответа, о которой eve так и не объявила: через этот срок считаем, что она
// до eve не дошла, и свёртка между ходами снова доступна.
export const ASK_FORGOTTEN_MS = 30 * 60_000;

/** turn.started: открыть счёт хода. */
export function openIdleCompactionTurn(sessionId: string): void {
  const turn = turns.get(sessionId) ?? {
    open: true,
    first: null,
    last: null,
    due: false,
    asked: false,
    compacted: false,
    off: false,
    reclaim: null,
    reclaimAt: 0,
  };
  Object.assign(turn, { open: true, first: null, last: null, due: false });
  // Свежая сессия — в конец: вытесняется та, что молчит дольше всех.
  turns.delete(sessionId);
  turns.set(sessionId, turn);
  for (const [stale, kept] of turns) {
    if (turns.size <= TURNS_KEPT) break;
    // Идущий ход, решение и открытая просьба живы: такой счёт не вытесняется.
    if (kept.open || kept.due || kept.reclaim) continue;
    turns.delete(stale);
  }
}

/** Вход шага открытой сессии; null — провайдер вход не назвал. */
export function recordStepInput(sessionId: string, tokens: number | null) {
  const turn = turns.get(sessionId);
  if (!turn) return;
  turn.first ??= tokens;
  turn.last = tokens;
}

/**
 * compaction.requested: eve начинает пересказ. Между ходами и после нашей просьбы — занять
 * чат ещё раз. Обычно он уже занят, и это ничего не меняет. Но если ответ на просьбу
 * опоздал (исход был неизвестен), eve могла сначала провести ход по пришедшему сообщению, и
 * к началу пересказа чат снова свободен: без записи перезапуск посреди такого пересказа
 * повесил бы сессию. Никогда не бросает.
 */
export async function beginIdleCompaction(
  sessionId: string,
  logImpl: (...parts: unknown[]) => void = console.error,
): Promise<void> {
  const turn = turns.get(sessionId);
  if (!turn || turn.open || !turn.reclaim) return;
  const reclaim = turn.reclaim;
  turn.reclaim = null;
  // Ход между просьбой и её запоздалым началом закрыл замер: пересказ снова свой.
  turn.asked = true;
  try {
    // false — обычный случай: чат уже занят этим же пересказом.
    await reclaim();
  } catch (error) {
    logImpl("[telegram] чат под начавшуюся свёртку не занят:", error);
  }
}

/**
 * compaction.completed. Пересказ внутри хода — страховка eve, она шлёт то же событие:
 * своим считаем только пересказ, который кончился, пока ход сессии закрыт.
 */
export function completeIdleCompaction(sessionId: string): void {
  const turn = turns.get(sessionId);
  if (!turn || turn.open) return;
  if (turn.asked) turn.compacted = true;
  turn.reclaim = null;
}

/** Парковка сняла запись пересказа: он кончился (успех, сбой, обрыв) — просьба закрыта. */
export function endIdleCompaction(sessionId: string): void {
  const turn = turns.get(sessionId);
  if (turn) turn.reclaim = null;
}

/**
 * turn.completed: решить, пора ли сворачивать после этого хода. Пересказ, который дошёл до
 * конца и не увёл первый известный вход следующего хода под порог, выключает себя: иначе
 * каждый ход платил бы за пересказ, который ничего не освобождает. Оборванный пересказ
 * (сообщение при порядке steer, сбой провайдера) не выключает ничего.
 */
export function closeIdleCompactionTurn(
  sessionId: string,
  windowTokens: number,
): void {
  const turn = turns.get(sessionId);
  if (!turn) return;
  turn.open = false;
  const limit = idleCompactionLimit(windowTokens);
  if (turn.asked) {
    if (turn.compacted && turn.first !== null && turn.first >= limit)
      turn.off = true;
    turn.asked = false;
    turn.compacted = false;
  }
  turn.due = !turn.off && limit > 0 && turn.last !== null && turn.last >= limit;
}

/**
 * turn.failed, turn.cancelled: ход кончился без ответа — после него не сворачиваем. Замер
 * пользы прошлого пересказа на нём тоже кончается: иначе его унаследовал бы следующий ход,
 * чей вход вырос уже за два хода, и полезный пересказ выключил бы свёртку.
 */
export function dropIdleCompactionTurn(sessionId: string): void {
  const turn = turns.get(sessionId);
  if (turn)
    Object.assign(turn, {
      open: false,
      due: false,
      asked: false,
      compacted: false,
    });
}

/**
 * session.waiting: если законченный ход дошёл до порога — занять чат и попросить eve
 * пересказать историю. Никогда не бросает: ход уже закончен, отказ оставляет историю как
 * была, следующий ход решит заново, страховка внутри хода остаётся.
 *
 * claimImpl занимает чат под пересказ; false — чат уже занят (пришло сообщение), сессия
 * сброшена или просить нечем, тогда просьбы нет. requestImpl: true — eve приняла просьбу;
 * false — отказала, и releaseImpl освобождает чат. Исключение requestImpl значит, что
 * исход неизвестен: eve могла принять просьбу, поэтому чат остаётся занят до парковки
 * сессии (или срока записи), а завершение такого пересказа засчитывается как своё.
 */
export async function startIdleCompaction({
  sessionId,
  claimImpl,
  requestImpl,
  releaseImpl,
  now = Date.now,
  logImpl = console.error,
}: {
  sessionId: string;
  claimImpl: () => boolean | Promise<boolean>;
  requestImpl: (sessionId: string) => Promise<boolean>;
  releaseImpl: () => unknown;
  now?: () => number;
  logImpl?: (...parts: unknown[]) => void;
}): Promise<boolean> {
  const turn = turns.get(sessionId);
  if (!turn?.due) return false;
  turn.due = false;
  // Прошлая просьба ещё может стоять в очереди eve: вторую не шлём.
  if (turn.reclaim && now() - turn.reclaimAt < ASK_FORGOTTEN_MS) return false;
  try {
    if (!(await claimImpl())) return false;
  } catch (error) {
    logImpl("[telegram] чат под свёртку между ходами не занят:", error);
    return false;
  }
  // До ответа: начало и конец пересказа могут прийти раньше, чем разобран ответ роута.
  turn.asked = true;
  turn.reclaim = claimImpl;
  turn.reclaimAt = now();
  let accepted;
  try {
    accepted = await requestImpl(sessionId);
  } catch (error) {
    logImpl(
      "[telegram] свёртка между ходами: исход просьбы неизвестен:",
      error,
    );
    return false;
  }
  if (accepted) return true;
  turn.asked = false;
  turn.reclaim = null;
  await releaseRefused(releaseImpl, logImpl);
  return false;
}

async function releaseRefused(
  releaseImpl: () => unknown,
  logImpl: (...parts: unknown[]) => void,
): Promise<void> {
  try {
    await releaseImpl();
  } catch (error) {
    logImpl("[telegram] чат после отказа свёртки не освобождён:", error);
  }
}
