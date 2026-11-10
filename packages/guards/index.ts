// Проверки формы значения, общие для authored-дерева и операционных скриптов.

/** Объект с ключами: не null и не массив. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
