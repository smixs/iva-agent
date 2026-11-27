const SILENT_MARKER = /^<!-- iva:silent -->(?:\r?\n|$)/u;
const NONE_MARKER = /^<!-- iva:none -->(?:\r?\n|$)/u;

/** Extract the delivery choice from a model reply before it reaches the Outbox. */
export function parseTelegramDelivery(message: string): {
  text: string;
  silent: boolean;
} {
  const marker = SILENT_MARKER.exec(message)?.[0];
  return marker
    ? { text: message.slice(marker.length), silent: true }
    : { text: message, silent: false };
}

/**
 * Распознаёт явный исход «промолчать без сообщения» (`<!-- iva:none -->` первой строкой).
 * Применяется в общей группе коллег (и в межоботовой личке), где молчание — нормальный
 * исход хода без отправки сообщения в Telegram (ADR-0030, T911).
 */
export function parseTelegramQuiet(message: string): {
  readonly quiet: boolean;
  readonly note: string;
} {
  const trimmed = message.trimStart();
  const match = NONE_MARKER.exec(trimmed)?.[0];
  if (!match) return { quiet: false, note: "" };
  return { quiet: true, note: trimmed.slice(match.length).trim() };
}
