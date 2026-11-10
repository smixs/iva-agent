// Формат data/telegram-offset.json: { offset } — курсор getUpdates. Повторы после падения
// между доставкой и записью курсора держат входящие Bridge. Поле delivered, которое писали
// выпуски до 0.3.24, читатель пропускает.
export type OffsetState = { offset: number | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOffsetFile(raw: string): { offset: number } {
  const j: unknown = JSON.parse(raw);
  if (
    !isRecord(j) ||
    typeof j.offset !== "number" ||
    !Number.isSafeInteger(j.offset) ||
    j.offset < 0
  ) {
    throw new Error("Telegram offset file has invalid schema");
  }
  return { offset: j.offset };
}

export function serializeOffsetFile(offset: number): string {
  return JSON.stringify({ offset });
}
