// Когда история сессии пересказывается (компактация eve). Два порога, одно правило.
//
// Между ходами — основной путь: канал после законченного хода сам просит eve пересказать
// историю, пока человек ничего не ждёт (agent/lib/idle-compaction.ts). Порог — 60 % окна
// модели, но не больше 275 тыс. токенов: у моделей с окном в миллион доля окна одна не
// сработала бы никогда (владелец, 05.10.2026).
// Внутри хода — страховка: eve пересказывает историю перед шагом модели, и ход ждёт. Её
// порог на четверть выше, иначе до свёртки между ходами дело не доходит.
export const IDLE_COMPACTION_PERCENT = 0.6;
export const IDLE_COMPACTION_MAX_TOKENS = 275_000;
const IN_TURN_HEADROOM = 1.25;

/** Вход шага в токенах, с которого история сворачивается между ходами. */
export function idleCompactionLimit(windowTokens: number): number {
  return Math.min(
    Math.floor(windowTokens * IDLE_COMPACTION_PERCENT),
    IDLE_COMPACTION_MAX_TOKENS,
  );
}

/** Доля окна для страховки внутри хода (compaction.thresholdPercent у eve). */
export function compactionThresholdPercent(windowTokens: number): number {
  return (idleCompactionLimit(windowTokens) * IN_TURN_HEADROOM) / windowTokens;
}
