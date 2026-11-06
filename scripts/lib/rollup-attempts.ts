// Попытки дня: ответ A после повтора не по форме или незавершённая запись дня.
// Обрез пределом ночи, временный сбой, срок, сигнал и падение сохраняют попытки;
// старые cut читаются для отката и пропускаются при подсчёте. Три отказа — день
// ждёт человека (`iva jobs skip`), успешный разбор стирает попытки дня.
// data/rollup-attempts.json: `{ "<date>": [{ "at": "<ISO>", "reason": "<причина>" }, …] }`.
import { readFileSync } from "node:fs";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";

export type AttemptReason = "no-report" | "day-unfinished";
type Attempt = { readonly at: string; readonly reason: AttemptReason | "cut" };
export type Attempts = Readonly<Record<string, readonly Attempt[]>>;

export const MAX_FAILED_ATTEMPTS = 3;
/** Ключ дросселя alert об отложенных днях (scripts/lib/notice-policy.ts, alertOnce). */
export const DAY_PAUSED_ALERT_KEY = "rollup-day-paused";
const REASONS = new Set<string>(["cut", "no-report", "day-unfinished"]);

const isAttempt = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const { at, reason } = value as Record<string, unknown>;
  return (
    Number.isFinite(Date.parse(String(at))) &&
    typeof reason === "string" &&
    REASONS.has(reason)
  );
};

function isAttempts(value: unknown): value is Attempts {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  return Object.values(value).every(
    (list) => Array.isArray(list) && list.every(isAttempt),
  );
}

/** Нет файла — попыток не было. Битый файл — ошибка: иначе предел молча снялся бы. */
export function readAttempts(file: string): Attempts {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!isAttempts(parsed))
    throw new Error(`${file} is not a rollup attempts map`);
  return parsed;
}

/** Отказ дня наблюдён. */
export function addAttempt(
  file: string,
  date: string,
  reason: AttemptReason,
  at: string,
): void {
  const attempts = readAttempts(file);
  write(file, {
    ...attempts,
    [date]: [...(attempts[date] ?? []), { at, reason }],
  });
}

/** День сделан или закрыт владельцем: его попытки больше не считаются. */
export function clearDay(file: string, date: string): void {
  const attempts = readAttempts(file);
  if (!(date in attempts)) return;
  const rest = { ...attempts };
  delete rest[date];
  write(file, rest);
}

function write(file: string, attempts: Attempts): void {
  writeFileAtomicSync(file, `${JSON.stringify(attempts, null, 2)}\n`);
}

/** День исчерпал попытки: три наблюдённых отказа. */
export const isExhausted = (
  attempts: readonly Attempt[] | undefined,
): boolean =>
  (attempts?.filter(({ reason }) => reason !== "cut").length ?? 0) >=
  MAX_FAILED_ATTEMPTS;

const REASON_TEXT: Readonly<Record<AttemptReason, readonly [string, string]>> =
  {
    "no-report": ["the turn ended without a report", "ход кончился без отчёта"],
    "day-unfinished": [
      "the report came, the day stayed unfinished",
      "отчёт пришёл, а день не закрыт",
    ],
  };

/** Alert владельцу (ADR-0007): что случилось, последняя причина и что делать. */
export function dayPausedAlert(
  tr: (english: string, russian: string) => string,
  dates: readonly string[],
  attempts: Attempts,
): string {
  const lines = dates
    .map((date) => {
      const last = attempts[date]
        ?.map(({ reason }) => reason)
        .filter((reason) => reason !== "cut")
        .at(-1);
      const cause = last ? `${tr(...REASON_TEXT[last])}\n` : "";
      return `${date}: ${cause}iva jobs skip memory-night ${date}`;
    })
    .join("\n");
  return tr(
    `Night memory: these days failed ${MAX_FAILED_ATTEMPTS} times in a row, so I set them aside until you decide. The last cause and the command that closes the day without processing it:\n${lines}`,
    `Ночная память: эти дни не разобрались ${MAX_FAILED_ATTEMPTS} раза подряд, я перестала их пробовать, пока ты не решишь. Последняя причина и команда, которая закрывает день без разбора:\n${lines}`,
  );
}
