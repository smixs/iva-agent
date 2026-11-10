// Отчётность по расходу токенов: чтение usage.jsonl, окна и сводки для Telegram-моста
// (/usage) и CLI (`iva usage`). Запись лога живёт в authored tree (agent/lib/usage.ts) —
// её делает хук, а eve пересобирает дерево при старте. Обратный импорт оттуда сюда
// невозможен: `iva usage` обязан грузиться на установке без authored tree (ADR-0003),
// поэтому путь лога знают обе половины, а совпадение пинует round-trip тест в usage.test.ts.
// Чистый ESM (только node-builtins) — работает в bare-node, как agent/lib/telegram-format.ts.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { UsageRecord } from "#lib/usage.ts";
import { resolveDataDir } from "../../packages/data-dir/index.ts";
import { REMINDER_TURN_KINDS } from "./reminder-turn.ts";
import { resolveTimeZone } from "../../packages/timezone/index.ts";

export type { UsageRecord };

type UsageWindow =
  "last" | "today" | "week" | "month" | "by-model" | "by-source";
type AggregateWindow = Exclude<UsageWindow, "last" | "by-model" | "by-source">;

interface Totals {
  readonly in: number;
  readonly out: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
  readonly steps: number;
  readonly turns: number;
}

interface UsageRow extends Totals {
  readonly key: string;
}

interface LastTurn extends Totals {
  readonly model: string;
  readonly source: string;
  readonly subagent: string | null;
  readonly when: string;
  readonly contextFromSubagent: boolean;
}

interface LastSummary {
  readonly window: "last";
  readonly last: LastTurn | null;
}

interface ByModelSummary {
  readonly window: "by-model";
  readonly rows: UsageRow[];
  readonly totals: Totals;
  // Дата самой старой записи в логе. У этих двух окон границы нет — они считают всё, что
  // в логе лежит, а лог подрезается по размеру (agent/lib/usage.ts). «За всё время» без
  // этой даты было бы враньём после первой подрезки.
  readonly since: string | null;
}

interface BySourceSummary {
  readonly window: "by-source";
  readonly rows: UsageRow[];
  readonly totals: Totals;
  readonly since: string | null;
}

interface WindowSummary {
  readonly window: AggregateWindow;
  readonly totals: Totals;
  readonly bySource: UsageRow[];
  readonly byModel: UsageRow[];
  // Дата, с которой окно реально посчитано, ЕСЛИ лог не достаёт до его начала. Хвост
  // лога (agent/lib/usage.ts) — порядка десяти тысяч шагов, а месяц активного
  // пользователя того же порядка, так что «This month» после подрезки может считать
  // не весь месяц. null — лог покрывает окно целиком, и говорить не о чем.
  readonly since: string | null;
}

type UsageSummary =
  LastSummary | ByModelSummary | BySourceSummary | WindowSummary;

interface SummarizeOptions {
  readonly window?: UsageWindow;
  readonly now?: number;
  readonly tz?: string;
}

interface LegacySummarizeOptions {
  readonly window?: string;
  readonly now?: number;
  readonly tz?: string;
}

interface Accumulator {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  steps: number;
  readonly turns: Set<string>;
}

const defaultDir = (): string => resolveDataDir(process.cwd());

const usageFilePath = (dataDir: string): string => join(dataDir, "usage.jsonl");

// Сколько байт лога читать. Это ровно тот потолок, до которого лог растёт на стороне
// записи (agent/lib/usage.ts), поэтому в норме читается ВЕСЬ файл; лимит нужен на случай
// лога, накопленного прежней версией без подрезки: /usage разбирает его в обработчике
// моста, и мегабайты JSON.parse там встают поперёк цикла моста.
const TAIL_BYTES = 4 * 1024 * 1024;

// Толерантный парсер: нет файла → пусто; битую строку (обрыв при падении на середине
// append) — молча пропускаем. Читаем хвост, а не файл целиком: свежие записи в конце,
// и именно они нужны всем окнам отчёта.
export function readEntries(dataDir = defaultDir()): UsageRecord[] {
  let raw: string;
  try {
    const fd = openSync(usageFilePath(dataDir), "r");
    try {
      const size = fstatSync(fd).size;
      const from = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.allocUnsafe(size - from);
      // Дочитываем в цикле: одно readSync вправе вернуть меньше запрошенного, а
      // недобранными оказались бы САМЫЕ СВЕЖИЕ записи — те, ради которых и читаем.
      // Взять при этом можно только реально заполненную часть буфера: allocUnsafe.
      let filled = 0;
      while (filled < buffer.length) {
        const read = readSync(
          fd,
          buffer,
          filled,
          buffer.length - filled,
          from + filled,
        );
        if (read <= 0) break; // файл укоротили под нами — берём что есть
        filled += read;
      }
      raw = buffer.subarray(0, filled).toString("utf8");
      // Обрезанную с начала строку (и разрубленный по границе символ) выбрасываем целиком.
      if (from > 0) raw = raw.slice(raw.indexOf("\n") + 1);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  raw.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value === "object" && value !== null && !Array.isArray(value))
        out.push(value as UsageRecord);
    } catch {
      /* битая/частичная строка — пропускаем */
    }
  });
  return out;
}

// Нормализуем аргумент команды → допустимое окно (дефолт last).
export function parseWindow(arg?: string): UsageWindow {
  const normalized = (arg || "")
    .trim()
    .toLowerCase()
    .replace(/^by[ -]/, "by-");
  const windows: readonly UsageWindow[] = [
    "last",
    "today",
    "week",
    "month",
    "by-model",
    "by-source",
  ];
  return windows.includes(normalized as UsageWindow)
    ? (normalized as UsageWindow)
    : "last";
}

// Локальная дата YYYY-MM-DD в TZ пользователя (как transcript.ts/telegram.ts) — строковое
// сравнение, не ловит naive-UTC-midnight баг.
function localDate(ts: string | number, tz: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(tz),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
}

function inWindow(
  entry: UsageRecord,
  window: string,
  now: number,
  tz: string | undefined,
): boolean {
  const time = Date.parse(entry.ts);
  if (Number.isNaN(time)) return false;
  if (window === "today") return localDate(entry.ts, tz) === localDate(now, tz);
  if (window === "month")
    return (
      localDate(entry.ts, tz).slice(0, 7) === localDate(now, tz).slice(0, 7)
    );
  if (window === "week") return time >= now - 7 * 86400000;
  return true; // lifetime — by-model/by-source
}

// Ход субагента пишется как "<ход родителя>#<субагент>" (agent/hooks/usage.ts): ключ
// уникален, но принадлежит ходу родителя — для группировки берём часть до "#".
const baseTurnId = (turnId: string | undefined): string =>
  String(turnId ?? "").split("#")[0];
const turnKey = (entry: UsageRecord): string =>
  `${entry.sessionId}:${baseTurnId(entry.turnId)}`;

// Строки вызовов мимо шага хода (agent/lib/usage-tap.ts): компактация eve и зрение. Их
// вход — пересказываемый транскрипт или картинка, а не окно контекста сессии.
const TAP_SOURCES: ReadonlySet<unknown> = new Set(["compaction", "vision"]);
const isTapRow = (entry: UsageRecord): boolean => TAP_SOURCES.has(entry.source);

// У строки нет хода, если часть ключа до "#" пуста: зрение идёт в канале до хода, а
// компактация planner — вне шага (turnId "#vision"/"#compaction", sessionId ""). Такой
// расход входит в итог окна, но ходом не считается: иначе все такие строки за жизнь лога
// склеились бы в один ложный ход с ключом ":".
const hasTurn = (entry: UsageRecord): boolean =>
  baseTurnId(entry.turnId) !== "";

// Последний ход — ход последнего шага модели. Строка компактации или зрения в конце лога
// ход не открывает: компактация нового хода войдёт в него, когда дойдёт его первый шаг.
function lastStep(entries: UsageRecord[]): UsageRecord | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (hasTurn(entry) && !isTapRow(entry)) return entry;
  }
  return undefined;
}

const blank = (): Accumulator => ({
  in: 0,
  out: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  steps: 0,
  turns: new Set<string>(),
});

/**
 * Слагаемое отчёта: число из лога, а не что угодно. Лог мог быть записан прежней версией,
 * где мусор провайдера уезжал в файл (`null` вместо переполненного double) — такая строка
 * считается нулём, а сумма не имеет права стать бесконечной: /usage не печатает Infinity
 * (PBT-DS1-P F1). Потолок тот же, что у писателя (`agent/hooks/usage.ts`: `usageTokens`):
 * расход — безопасное целое >= 0, всё прочее (одиночное `1e308`, дробное, отрицательное)
 * из старого лога считается нулём, а не числом. Переполнение суммы упирается в потолок
 * безопасного целого.
 */
function sum(current: number, value: unknown): number {
  const part =
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : 0;
  const next = current + part;
  return Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER;
}

function add(accumulator: Accumulator, entry: UsageRecord): void {
  accumulator.in = sum(accumulator.in, entry.in);
  accumulator.out = sum(accumulator.out, entry.out);
  accumulator.cacheRead = sum(accumulator.cacheRead, entry.cacheRead);
  accumulator.cacheWrite = sum(accumulator.cacheWrite, entry.cacheWrite);
  accumulator.total = sum(accumulator.total, entry.total);
  accumulator.steps += 1;
  if (hasTurn(entry)) accumulator.turns.add(turnKey(entry));
}

const finalize = (accumulator: Accumulator): Totals => ({
  in: accumulator.in,
  out: accumulator.out,
  cacheRead: accumulator.cacheRead,
  cacheWrite: accumulator.cacheWrite,
  total: accumulator.total,
  steps: accumulator.steps,
  turns: accumulator.turns.size,
});

function rowsOf(map: Map<string, Accumulator>): UsageRow[] {
  return [...map]
    .map(([key, accumulator]) => ({ key, ...finalize(accumulator) }))
    .sort((left, right) => right.total - left.total);
}

export function summarize(
  entries: UsageRecord[],
  options: SummarizeOptions & { readonly window: "last" },
): LastSummary;
export function summarize(
  entries: UsageRecord[],
  options: SummarizeOptions & { readonly window: "by-model" | "by-source" },
): ByModelSummary | BySourceSummary;
export function summarize(
  entries: UsageRecord[],
  options: SummarizeOptions & { readonly window: AggregateWindow },
): WindowSummary;
export function summarize(
  entries: UsageRecord[],
  options?: SummarizeOptions,
): UsageSummary;
export function summarize(
  entries: UsageRecord[],
  options?: LegacySummarizeOptions,
): Record<string, unknown>;
export function summarize(
  entries: UsageRecord[],
  { window = "last", now = Date.now(), tz }: LegacySummarizeOptions = {},
): UsageSummary | Record<string, unknown> {
  if (window === "last") return summarizeLast(entries);
  if (window === "by-model" || window === "by-source")
    return summarizeLifetime(entries, window, tz);
  return summarizeWindow(entries, window, now, tz);
}

interface TurnRows {
  readonly accumulator: Accumulator;
  readonly model: string;
  readonly subagent: string | null;
  readonly mainContext: number | undefined;
  readonly anyContext: number | undefined;
}

// Вход по шагам хода складывать нельзя: каждый шаг заново отправляет весь контекст,
// и сумма (104 632 + 105 537 = 210 169) выглядит как «контекст вырос вдвое». Решение
// «пора ли /new» принимают по актуальному размеру контекста — это вход ПОСЛЕДНЕГО
// шага основной сессии. Выход суммируется честно: эти токены сгенерированы все.
//
// Инвариант ключа (agent/hooks/usage.ts): запись субагента несёт turnId вида
// "<ход родителя>#<субагент>". Поэтому ход собирается по части до "#" (расход субагента
// входит в итог хода), а контекст берётся из записи БЕЗ суффикса — это шаг основной
// сессии. Поле subagent проверяем заодно, но лечит оно не всё: довинвариантная запись
// субагента несла turnId ребёнка, и если ИМЕННО она оказалась последней, ход определится
// по её номеру — то есть, возможно, по давнему одноимённому ходу родителя. Поле спасает
// только когда шаг основной сессии попал в ту же группу. В проде таких записей нет.
// Строка компактации того же хода входит в итог, но контекстом не бывает никогда.
//
// Оговорка про кэш: у провайдеров с anthropic-семантикой cacheRead не входит в inputTokens,
// и тогда context занижен на величину cacheRead. Оба живых провайдера ивы включают кэш в in,
// надёжно отличить одну семантику от другой по логу нельзя — не усложняем.
function collectTurn(
  entries: UsageRecord[],
  key: string,
  model: string,
): TurnRows {
  const turn = {
    accumulator: blank(),
    model,
    subagent: null as string | null,
    mainContext: undefined as number | undefined,
    anyContext: undefined as number | undefined,
  };
  for (const entry of entries) {
    if (turnKey(entry) !== key) continue;
    add(turn.accumulator, entry);
    if (isTapRow(entry)) continue;
    turn.model = entry.model;
    turn.anyContext = entry.in || 0;
    if (entry.subagent || String(entry.turnId ?? "").includes("#"))
      turn.subagent = entry.subagent ?? turn.subagent;
    else turn.mainContext = entry.in || 0;
  }
  return turn;
}

function summarizeLast(entries: UsageRecord[]): LastSummary {
  const lastEntry = lastStep(entries);
  if (!lastEntry) return { window: "last", last: null };
  const turn = collectTurn(entries, turnKey(lastEntry), lastEntry.model);
  const { mainContext, anyContext } = turn;
  // Ход целиком из субагентских записей (шаг основной сессии не дошёл до лога) — показываем
  // что есть, но помечаем: это не размер контекста основной сессии.
  return {
    window: "last",
    last: {
      ...finalize(turn.accumulator),
      in: mainContext ?? anyContext ?? 0,
      contextFromSubagent:
        mainContext === undefined && anyContext !== undefined,
      model: turn.model,
      source: lastEntry.source,
      subagent: turn.subagent,
      when: lastEntry.ts,
    },
  };
}

function summarizeLifetime(
  entries: UsageRecord[],
  window: "by-model" | "by-source",
  tz: string | undefined,
): ByModelSummary | BySourceSummary {
  const keyOf =
    window === "by-model"
      ? (entry: UsageRecord): string => entry.model || "?"
      : (entry: UsageRecord): string => entry.source || "?";
  const groups = new Map<string, Accumulator>();
  const total = blank();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!groups.has(key)) groups.set(key, blank());
    const group = groups.get(key);
    if (group) add(group, entry);
    add(total, entry);
  }
  // Записи ложатся в лог по времени, так что первая разбираемая ts — самая старая.
  const oldest = entries.find((entry) => !Number.isNaN(Date.parse(entry.ts)));
  return {
    window,
    rows: rowsOf(groups),
    totals: finalize(total),
    since: oldest ? localDate(oldest.ts, tz) : null,
  };
}

function addTo(
  groups: Map<string, Accumulator>,
  key: string,
  entry: UsageRecord,
): void {
  const group = groups.get(key) ?? blank();
  groups.set(key, group);
  add(group, entry);
}

// today / week / month — итог + разбивка по источникам и моделям
function summarizeWindow(
  entries: UsageRecord[],
  window: string,
  now: number,
  tz: string | undefined,
): WindowSummary {
  const matching = entries.filter((entry) => inWindow(entry, window, now, tz));
  const total = blank();
  const bySource = new Map<string, Accumulator>();
  const byModel = new Map<string, Accumulator>();
  for (const entry of matching) {
    add(total, entry);
    addTo(bySource, entry.source || "?", entry);
    addTo(byModel, entry.model || "?", entry);
  }
  // Лог не достаёт до начала окна — значит всё, что было раньше, подрезано, и отчёт
  // обязан назвать дату, с которой посчитал. Сравниваем ДАТЫ, а не мгновения: отчёт
  // говорит датами, и «Today since сегодня» было бы шумом, а не предупреждением.
  const oldest = entries.find((entry) => !Number.isNaN(Date.parse(entry.ts)));
  const startsOn =
    window === "today"
      ? localDate(now, tz)
      : window === "week"
        ? localDate(now - 7 * 86400000, tz)
        : `${localDate(now, tz).slice(0, 7)}-01`;
  const oldestDate = oldest ? localDate(oldest.ts, tz) : null;
  return {
    window: window as AggregateWindow,
    totals: finalize(total),
    bySource: rowsOf(bySource),
    byModel: rowsOf(byModel),
    since: oldestDate && oldestDate > startsOn ? oldestDate : null,
  };
}

const WINDOW_LABEL: Record<UsageWindow, string> = {
  last: "Last turn",
  today: "Today",
  week: "Last 7 days",
  month: "This month",
  "by-model": "By model",
  "by-source": "By source",
};
const SOURCE_LABEL: Record<string, string> = {
  telegram: "chat",
  http: "background",
  unknown: "other",
  // Ход Ивы называет свой вид (заголовок x-iva-turn): строка — его вид словом глоссария.
  ...Object.fromEntries(REMINDER_TURN_KINDS.map((kind) => [kind, kind])),
};
// channel.kind приходит как "channel:telegram" (канал) или "http" (eve/client) — нормализуем.
const sourceLabel = (key: unknown): string => {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Preserve the declaration-era formatter's permissive String coercion.
  const normalized = String(key ?? "").replace(/^channel:/, "");
  return SOURCE_LABEL[normalized] || normalized || "other";
};
const num = (value: number | undefined): string =>
  String(value ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const plural = (value: number, word: string): string =>
  `${num(value)} ${word}${value === 1 ? "" : "s"}`;

export function formatUsageReport(aggregate: UsageSummary): string;
export function formatUsageReport(aggregate: Record<string, unknown>): string;
export function formatUsageReport(
  aggregate: UsageSummary | Record<string, unknown>,
): string {
  const summary = aggregate as UsageSummary;
  if (summary.window === "last") {
    if (!summary.last) return "No usage logged yet.";
    const last = summary.last;
    const subagent = last.subagent ? ` (+subagent ${last.subagent})` : "";
    return [
      `Last turn: ${num(last.total)} tokens${subagent}`,
      `context ${last.contextFromSubagent ? "~" : ""}${num(last.in)}${last.contextFromSubagent ? " (subagent step)" : ""}` +
        ` · out ${num(last.out)}${last.cacheRead ? ` · cached ${num(last.cacheRead)}` : ""}`,
      `${plural(last.steps, "step")} · ${last.model} · ${sourceLabel(last.source)}`,
    ].join("\n");
  }
  if (summary.window === "by-model" || summary.window === "by-source") {
    if (!summary.rows.length) return "No usage logged yet.";
    const lines = summary.rows.map(
      (row) =>
        `• ${summary.window === "by-source" ? sourceLabel(row.key) : row.key}: ${num(row.total)} tokens (${plural(row.turns, "turn")})`,
    );
    // «since» — не украшение: лог подрезается по размеру, и без даты «total» читался бы
    // как «за всё время», хотя это итог по тому, что в логе уцелело.
    const since = summary.since ? ` since ${summary.since}` : "";
    return [
      `${WINDOW_LABEL[summary.window]}${since} (total ${num(summary.totals.total)} tokens):`,
      ...lines,
    ].join("\n");
  }
  const total = summary.totals;
  if (!total.steps) return `${WINDOW_LABEL[summary.window]}: no usage.`;
  // Та же пометка, что и у lifetime-окон: лог подрезается по размеру, и «This month»
  // без даты читался бы как «весь месяц», хотя старых строк уже нет.
  const from = summary.since ? ` since ${summary.since}` : "";
  const output = [
    `${WINDOW_LABEL[summary.window]}${from}: ${num(total.total)} tokens (in ${num(total.in)} / out ${num(total.out)}) · ${plural(total.turns, "turn")}`,
  ];
  if (summary.bySource.length > 1) {
    output.push("Sources:");
    for (const row of summary.bySource)
      output.push(`• ${sourceLabel(row.key)}: ${num(row.total)}`);
  }
  if (summary.byModel.length > 1) {
    output.push("Models:");
    for (const row of summary.byModel)
      output.push(`• ${row.key}: ${num(row.total)}`);
  }
  return output.join("\n");
}
