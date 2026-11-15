// «Незакрытые провалы» — то, что агент видит каждым ходом (agent/instructions/40-open-failures.ts)
// и утренний Brief называет первым. Два источника: таблица фактов расписаний и таблица
// напоминаний. T20 напоминания не трогает, но общий источник обязан видеть и их провалы:
// сработавшая за сутки строка напоминания с причиной (error) считается открытой.
//
// Провал расписания закрыт, когда есть более поздний успешный запуск того же имени или
// владелец/агент закрыл его через `iva jobs ack <name>`. Суточного окна у него нет: непочиненный
// сбой называется каждый день до починки (ADR-0020), пока строка жива в jobs.json (ротация 7
// дней). Повторам в коде здесь места нет: открытый провал — это состояние, а не событие.
import { dataDir } from "./data-dir.ts";
import { jobFactsFile, readFactsSync, type JobFact } from "./job-facts.ts";
import { jobState } from "./job-state.ts";
import { list, owesAlert, type Reminder } from "./reminder-store.ts";
import { isLiveSchedule } from "./schedule-table.ts";

/** Окно провала напоминания: строку разовой напоминалки уборка снимает через сутки. */
export const OPEN_FAILURES_WINDOW_MS = 24 * 60 * 60 * 1000;

export type OpenFailure = {
  readonly source: "job" | "reminder";
  readonly name: string;
  readonly at: number;
  readonly reason: string;
};

function byTime(left: OpenFailure, right: OpenFailure): number {
  return left.at - right.at;
}

export function openJobFailures(facts: readonly JobFact[]): OpenFailure[] {
  const names = [...new Set(facts.map((fact) => fact.name))].filter(
    isLiveSchedule,
  );
  const failures: OpenFailure[] = [];
  for (const name of names) {
    const latest = jobState(name, { facts }).last;
    if (!latest || latest.ok || latest.acked) continue;
    failures.push({
      source: "job",
      name,
      at: latest.finishedAt,
      reason: latest.error ?? "провал без причины",
    });
  }
  return failures.sort(byTime);
}

export function openReminderFailures(
  reminders: readonly Reminder[],
  now: number,
): OpenFailure[] {
  // Та же мера провала, что у раздела напоминаний в `iva doctor`: строка сработала и
  // назвала причину (не доехала или ход пробуждения упал). Закрывать её нечем: следующее
  // срабатывание перезапишет error, а разовую строку уборка снимет через сутки.
  const failures: OpenFailure[] = [];
  for (const row of reminders) {
    // Провал напоминания — именно недоставка (спека T20 п.3): ход пробуждения мог упасть и
    // ПОСЛЕ того, как текст ушёл владельцу, и такая строка несёт причину при delivered=true
    // — висеть открытым провалом каждый ход ей не за что (проверка T20, раунд 3). Брошенное
    // срабатывание, закрытое тиком, — тоже: дошёл ли текст, неизвестно.
    if (row.delivered !== false && !owesAlert(row)) continue;
    if (row.error === null || row.error.length === 0) continue;
    if (row.firedAt === null) continue;
    if (now - row.firedAt > OPEN_FAILURES_WINDOW_MS) continue;
    failures.push({
      source: "reminder",
      name: `reminder-${row.id}`,
      at: row.firedAt,
      reason: row.error,
    });
  }
  return failures.sort(byTime);
}

export function openFailuresFrom(
  facts: readonly JobFact[],
  reminders: readonly Reminder[],
  now: number,
): OpenFailure[] {
  return [
    ...openJobFailures(facts),
    ...openReminderFailures(reminders, now),
  ].sort(byTime);
}

/** Чтение для хода: факты обязательны (битый файл — явная ошибка), напоминания рядом. */
export async function openFailures({
  dir = dataDir(),
  now = Date.now(),
  readReminders = list,
}: {
  readonly dir?: string;
  readonly now?: number;
  readonly readReminders?: () => Promise<readonly Reminder[]>;
} = {}): Promise<OpenFailure[]> {
  const facts = readFactsSync(jobFactsFile(dir));
  const reminders = await readReminders();
  return openFailuresFrom(facts, reminders, now);
}

/** Потолки блока для промпта: сотни провалов по 100k знаков раздували ход (T30 №7). */
const MAX_FAILURE_LINES = 20;
const MAX_FAILURE_FIELD = 200;

function capped(value: string): string {
  return value.length > MAX_FAILURE_FIELD
    ? `${value.slice(0, MAX_FAILURE_FIELD)}…`
    : value;
}

function line(failure: OpenFailure): string {
  const when = new Date(failure.at).toISOString();
  if (failure.source === "reminder")
    return `- Напоминание ${failure.name}: ${when}, ${failure.reason}`;
  return `- Расписание ${failure.name}: ${when}, ${failure.reason} (закрыть: iva jobs ack ${failure.name})`;
}

/**
 * Источник провалов не читается: битую таблицу агент получает текстом, а не исключением
 * в ход. Он умеет bash и write_file, поэтому чинить её — его работа; хода, который
 * молча падает из-за одной испорченной строки JSON, в этой схеме быть не должно.
 */
export function brokenFailureSourceMarkdown(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return [
    "## Незакрытые провалы",
    `- Источник провалов не читается: ${reason}. Почини сам (прочитать файл, вернуть массив строк), потом скажи владельцу, что было сломано.`,
  ].join("\n");
}

/** Блок для промпта; провалов нет — пустая строка (инструкция тогда пустая). */
export function openFailuresMarkdown(failures: readonly OpenFailure[]): string {
  if (failures.length === 0) return "";
  const shown = failures.slice(0, MAX_FAILURE_LINES).map((failure) =>
    line({
      ...failure,
      name: capped(failure.name),
      reason: capped(failure.reason),
    }),
  );
  if (failures.length > MAX_FAILURE_LINES)
    shown.push(
      `- … и ещё ${failures.length - MAX_FAILURE_LINES} провалов (полный список: последняя строка по имени в data/jobs.json с ok false и acked false)`,
    );
  return ["## Незакрытые провалы", ...shown].join("\n");
}
