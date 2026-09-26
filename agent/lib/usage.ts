// Контракт записи расхода токенов: форма строки usage.jsonl, путь лога и дозапись.
// Живёт в authored tree, потому что пишет его хук agent/hooks/usage.ts, а eve пересобирает
// дерево при старте — специфайер в scripts/ утащил бы операционный код в бандл (issue #176).
//
// Отчётность по тому же логу (чтение, окна, формат) осталась в scripts/lib/usage.ts: её
// грузит `iva usage` на установке, где authored tree отсутствует или недописан (ADR-0003),
// поэтому обратный импорт оттуда сюда невозможен. Общего кода у половин нет — общий у них
// сам файл, и это пинует round-trip тест в scripts/lib/usage.test.ts.
//
// Лог живёт в data/usage.jsonl (ASSISTANT_DATA_DIR, дефолт ./data) — рядом с tasks.json,
// gitignored, НЕ в vault (иначе ночной brain коммитил бы растущий лог в репо памяти).
// Одна строка JSONL на шаг модели; ход (turn) = несколько шагов, группируем по turnId.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./data-dir.ts";

export interface UsageRecord {
  ts: string;
  source: string;
  provider: string;
  model: string;
  sessionId: string;
  turnId: string;
  step: number;
  subagent?: string;
  // Строка ребёнка, запущенного встроенным `agent`: чей ход его породил. eve отдаёт это в
  // ctx.session.parent; у строк основной сессии полей нет, JSON.stringify их опускает.
  parentSessionId?: string;
  parentTurnId?: string;
  parentCallId?: string;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

interface TurnLike {
  readonly id?: string;
  readonly sequence?: number;
}

/** Родитель сессии в форме eve (`ctx.session.parent`): вызов, сессия и ход родителя. */
export interface ParentLike {
  readonly callId?: string;
  readonly sessionId?: string;
  readonly turn?: TurnLike;
}

/** Расход одного вызова модели в том виде, в каком его пишет лог. */
export interface UsageTokens {
  readonly in: number;
  readonly out: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Всё о вызове, кроме расхода: кто, где, в каком ходе. */
export type UsageMeta = Omit<
  UsageRecord,
  "ts" | "in" | "out" | "cacheRead" | "cacheWrite" | "total"
>;

const defaultDir = dataDir;

export function usageFilePath(dataDir = defaultDir()): string {
  return join(dataDir, "usage.jsonl");
}

// Потолок лога и сколько от него остаётся после подрезки. Лог — операционный счётчик, а
// не память пользователя: САМЫЕ СТАРЫЕ строки при переполнении теряются НАМЕРЕННО, и
// инвариант «данные не теряются» (ADR-0002) на них не распространяется — он про vault.
//
// Сколько это шагов, по замеру реальной записи (269 байт без субагента, 298 с ним):
// сразу после подрезки в логе ~7 000–7 800 шагов модели, к следующей подрезке — вдвое
// больше. У активного пользователя месяц — того же порядка, поэтому НИ ОДНО окно нельзя
// объявить «заведомо целым»: и month, и week после подрезки могут считать не с начала
// окна. Врать об этом нельзя, поэтому scripts/lib/usage.ts печатает в отчёте дату, с
// которой он реально посчитал, как только лог до начала окна не достаёт (то же и у
// lifetime-окон by-model/by-source, у которых начала нет вовсе).
// Без подрезки файл рос бы вечно, а читает его /usage целиком на слабом хосте.
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_BYTES = 2 * 1024 * 1024;

// Подрезка через tmp+rename: оборванная запись не оставит вместо лога полфайла. Писатель
// у лога один (процесс агента), поэтому гонки «дописали, пока подрезали» тут нет.
function trim(file: string): void {
  try {
    const raw = readFileSync(file);
    if (raw.length <= MAX_BYTES) return;
    // Режем по границе строки — половина JSON никому не нужна.
    const newline = raw.indexOf(0x0a, raw.length - KEEP_BYTES);
    if (newline === -1) return;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, raw.subarray(newline + 1));
    renameSync(tmp, file);
  } catch {
    /* подрезка — не повод потерять записанный ход */
  }
}

// Sync append (как transcript.ts) — короткая дозапись против латентности модели, без
// interleave от конкурентных асинхронных записей.
export function appendUsage(record: UsageRecord, dataDir = defaultDir()): void {
  const file = usageFilePath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  // Один statSync на шаг модели — против сетевого вызова к модели это ничто, а лог
  // перестаёт расти без границы.
  try {
    if (statSync(file).size > MAX_BYTES) trim(file);
  } catch {
    /* нет файла — нечего подрезать */
  }
}

/**
 * Ключ хода для записи инлайн-субагента: ход РОДИТЕЛЯ плюс суффикс с именем субагента.
 * Живёт рядом с записью, а не в хуке, чтобы правило и его чтение не разъезжались.
 *
 * Фолбэки повторяют канон самого eve (`turnId.length > 0 ? turnId : turn_<sequence>`):
 * `ctx.session.turn.id` бывает ПУСТОЙ строкой между ходами, поэтому `??` тут не годится —
 * пустая строка дала бы ключ "#planner" и склеила бы разные ходы в один.
 */
export function subagentTurnId(
  turn: TurnLike | undefined,
  subagentName: string | undefined,
  childTurnId?: string,
): string {
  return `${parentTurnId(turn, childTurnId)}#${subagentName || "subagent"}`;
}

/**
 * Ключ хода родителя по канону самого eve. Отдельная функция, потому что тот же ключ
 * нужен журналу хода (agent/hooks/trace.ts): два разных вывода одного ключа разошлись бы
 * на первой же правке фолбэков.
 */
export function parentTurnId(
  turn: TurnLike | undefined,
  childTurnId?: string,
): string {
  const bySequence =
    typeof turn?.sequence === "number" ? `turn_${turn.sequence}` : "";
  return turn?.id || bySequence || childTurnId || "";
}

/**
 * Одно число расхода: конечное неотрицательное целое. Отсутствующее значение — ноль;
 * всё остальное (1e308, отрицательное, «12», NaN) — `null`, то есть мусор провайдера.
 * Такая строка в лог не пишется: сумма такого числа теряет конечность, `JSON.stringify`
 * пишет Infinity как null, а /usage печатает «0 tokens (in Infinity/out Infinity)» —
 * и лечится это только у источника (PBT-DS1-P F1).
 */
function usageTokens(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Вход шага для подсказки «нажмите /new»: то же правило, что у строки расхода, но только это
 * поле. Нет поля, 0 или мусор — null: контекст неизвестен, а не пуст.
 */
export function stepInputTokens(
  usage: { readonly inputTokens?: unknown } | undefined,
): number | null {
  const tokens = usageTokens(usage?.inputTokens);
  return tokens !== null && tokens > 0 ? tokens : null;
}

/**
 * Расход как его прислал провайдер → числа лога, либо `null`, если хоть одно число мусор.
 * Одно правило на всех, кто пишет в лог: шаг хода, компактация, зрение.
 */
export function readUsageTokens(raw: {
  readonly in: unknown;
  readonly out: unknown;
  readonly cacheRead: unknown;
  readonly cacheWrite: unknown;
}): UsageTokens | null {
  const tokens = {
    in: usageTokens(raw.in),
    out: usageTokens(raw.out),
    cacheRead: usageTokens(raw.cacheRead),
    cacheWrite: usageTokens(raw.cacheWrite),
  };
  const valid = Object.values(tokens).every((value) => value !== null);
  return valid ? (tokens as UsageTokens) : null;
}

/** Строка лога из метаданных и расхода. Нулевой расход строкой не становится. */
export function usageRecord(
  meta: UsageMeta,
  tokens: UsageTokens,
): UsageRecord | null {
  const { in: inT, out, cacheRead, cacheWrite } = tokens;
  if (inT + out + cacheRead + cacheWrite === 0) return null;
  return {
    ts: new Date().toISOString(),
    ...meta,
    in: inT,
    out,
    cacheRead,
    cacheWrite,
    total: inT + out,
  };
}

/**
 * Поля связи ребёнка с родителем. Пусто для сессии без родителя, поэтому строки основной
 * сессии остаются прежними байт в байт.
 */
export function parentFields(
  parent: ParentLike | undefined,
): Pick<UsageRecord, "parentSessionId" | "parentTurnId" | "parentCallId"> {
  if (!parent) return {};
  const turn = parentTurnId(parent.turn);
  return {
    ...(parent.sessionId ? { parentSessionId: parent.sessionId } : {}),
    ...(turn ? { parentTurnId: turn } : {}),
    ...(parent.callId ? { parentCallId: parent.callId } : {}),
  };
}
