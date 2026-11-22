// Одна свёртка — та, что встроена в eve: перед шагом модели eve пересказывает историю,
// и ход ждёт. Свёртки между ходами больше нет (владелец, 24.10.2026: «отдай Иве свод
// судьи», ~/.agents/decisions/2026-10-24-iva-compaction-one-path.md).
//
// Порог T = min(300 000, ⌊0,8·W⌋): 300 тыс. предложил владелец, 0,8·W — поправка для
// окон меньше миллиона (Codex 272 тыс., остальные провайдеры 131 тыс., старые Claude —
// 200 тыс.). Если замер на c1 покажет шаг на 250–300 тыс. медленнее шага на
// 100–150 тыс. больше чем в 1,5 раза, потолок в формуле меняется на 200 000.
const COMPACTION_PERCENT = 0.8;
const COMPACTION_MAX_TOKENS = 300_000;

/** Вход шага в токенах, с которого eve сворачивает историю перед шагом. */
export function compactionThreshold(windowTokens: number): number {
  return Math.min(
    Math.floor(windowTokens * COMPACTION_PERCENT),
    COMPACTION_MAX_TOKENS,
  );
}

/** Доля окна для compaction.thresholdPercent у eve: порог считает сама eve от окна модели. */
export function compactionThresholdPercent(windowTokens: number): number {
  return compactionThreshold(windowTokens) / windowTokens;
}
