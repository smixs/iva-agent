// Trace — журнал хода (ADR-0010). Одна строка JSONL на событие: от приёма апдейта
// Bridge до доставки ответа через Outbox, включая события eve (хук agent/hooks/trace.ts)
// и швы Ивы. Файл дня — data/trace/YYYY-MM-DD.jsonl, append-only. Читают вьюер плагина
// `trace` и `iva trace`, поэтому схема события фиксирована и мала:
//   { ts, turn, session, source, kind, name, data }
// `kind` — группа шва (bridge, inbound, gate, turn, eve, outbox, stop, tool, guard), `name` — конкретное
// событие внутри группы. Всё остальное живёт в `data`, у полей содержимого свой потолок.
//
// Три правила, из которых всё остальное следует:
//  1. Журнал НИКОГДА не ломает и не тормозит ход: любая ошибка записи глотается в
//     console.error. Диагностика не имеет права стоить пользователю сообщения.
//  2. Ход до появления eve-turn связывается ключом апдейта: события Bridge, inbound и
//     inbound-Gate несут `turn = tg:<chat>:<message>`, а шов старта хода пишет
//     `turn.bound` — там ключ апдейта и turnId лежат в одной строке (см. traceBindUpdate).
//  3. Чистка — по дате В ИМЕНИ файла, никогда не по mtime (ADR-0002, philosophy §5):
//     mtime врёт после копирования и восстановления, а платят за это данными.
//
// Модуль живёт в authored tree, потому что пишут журнал и агент, и мост
// (scripts/poller/* через алиас `#lib/trace.ts`) — как у agent/lib/usage.ts.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import { readSettings } from "./settings.ts";
import { parentTurnId } from "./usage.ts";
import { allowedTelegramUsers } from "./telegram-allowlist.ts";
import { resolveTimeZone } from "../../packages/timezone/index.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type TraceEvent = {
  ts: string;
  turn: string;
  session: string;
  source: string;
  kind: string;
  name: string;
  data: Record<string, unknown>;
};

// Вход писателя. `data` пишется всегда (имена, тайминги, размеры); `content` — только
// при captureContent, но его РАЗМЕРЫ (`<ключ>Chars`) остаются в `data` в любом случае:
// выключенное содержимое не должно превращать ход в набор безымянных точек.
export type TraceInput = {
  kind: string;
  name: string;
  turn?: string;
  session?: string;
  source?: string;
  data?: Record<string, unknown>;
  content?: Record<string, unknown>;
};

export type TraceOptions = {
  /** Каталог данных. По умолчанию dataDir() — резолвится на каждой записи. */
  dir?: string;
  now?: Date;
  /** Явное значение тумблера; по умолчанию читается из data/settings.json. */
  captureContent?: boolean;
};

// Потолок на поле содержимого — идея CONTENT_ATTRIBUTE_LIMIT из трейсинга eve, но своя
// реализация: чужие внутренности не парсим (philosophy §5). 4096 знаков — сообщение Telegram
// целиком; ответ длиннее — читаемый кусок, а не файл целиком.
export const TRACE_CONTENT_LIMIT = 4096;
// Прежний размер поля: вторая попытка для строки, не влезшей в TRACE_LINE_LIMIT при 4096.
// С ним событие теряет не больше, чем до поля 4096 (ADR-0010, пересмотр 06.10.2026).
export const TRACE_CONTENT_FALLBACK = 2000;
// Короткие поля-идентификаторы: ход, сессия, источник, группа, имя события.
export const TRACE_ID_LIMIT = 200;
// Потолок строки В БАЙТАХ UTF-8 — считать надо ровно то, что уйдёт в write(2). Одна
// запись = один write в O_APPEND, поэтому строка обязана быть заведомо маленькой: так
// параллельные писатели (агент и мост) не рвут строки друг другу. Кириллица и эмодзи
// стоят 2-4 байта на знак, поэтому лимит по code units врал бы втрое.
export const TRACE_LINE_LIMIT = 16 * 1024;
// Сколько дней журнала держим: сегодняшний файл и 29 предыдущих.
export const TRACE_RETENTION_DAYS = 30;
export const TRACE_TRUNCATION_MARKER = "…[truncated]";
export const TRACE_DEPTH_MARKER = "…[deep]";
// Ключ-пометка обрезанного объекта: сколько полей было на самом деле.
export const TRACE_TRUNCATED_KEY = "…[keys]";
// Значение, которое не удалось прочитать (геттер бросил, прокси отказал).
export const TRACE_UNREADABLE_MARKER = "…[unreadable]";

const MAX_DEPTH = 4;
const MAX_ITEMS = 20;
const MAX_KEYS = 30;
const TRACE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/u;

export function traceDir(dir: string = dataDir()): string {
  return join(dir, "trace");
}

export function traceFilePath(day: string, dir: string = dataDir()): string {
  return join(traceDir(dir), `${day}.jsonl`);
}

// День в часовом поясе установки — тот же, что у дневных файлов Vault
// (agent/lib/vault-daily.ts): один ход не должен попадать в два разных «сегодня».
//
// Пояс можно передать явно, и второму читателю журнала это обязательно: `iva` запускается
// БЕЗ --env-file, поэтому ASSISTANT_TIMEZONE в его process.env не приходит вовсе — CLI
// читает .env сам (scripts/cli/runtime.ts) и передаёт пояс сюда. Иначе `iva trace tail`
// следил бы за файлом чужого дня.
export function traceDay(
  now: Date = new Date(),
  timeZone: string | undefined = process.env.ASSISTANT_TIMEZONE,
): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Тумблер содержимого. Настройки читаются по ТОМУ ЖЕ каталогу данных, что и журнал:
 * `settings.ts` фиксирует свой путь на импорте, а писатель резолвит каталог на каждой
 * записи (агент, мост и тесты живут в разных каталогах) — иначе тумблер и журнал
 * разъехались бы по разным установкам.
 */
export function captureContentEnabled(dir: string = dataDir()): boolean {
  return readSettings(join(dir, "settings.json")).captureContent !== false;
}

// Обрезка строки по потолку с явной пометкой. Пара суррогатов пополам не режется:
// иначе в журнале осталась бы одинокая половина символа.
export function capTraceString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let keep = Math.max(0, limit - TRACE_TRUNCATION_MARKER.length);
  const last = keep > 0 ? value.charCodeAt(keep - 1) : 0;
  if (last >= 0xd800 && last <= 0xdbff) keep -= 1;
  return value.slice(0, keep) + TRACE_TRUNCATION_MARKER;
}

// Обрезка с другой стороны: остаётся КОНЕЦ, пометка в начале. Для вывода bash, где ошибка
// стоит последней. Низкая половина пары без своей высокой в начале среза отбрасывается.
export function capTraceTail(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let from = value.length - Math.max(0, limit - TRACE_TRUNCATION_MARKER.length);
  const first = value.charCodeAt(from);
  if (first >= 0xdc00 && first <= 0xdfff) from += 1;
  return TRACE_TRUNCATION_MARKER + value.slice(from);
}

// Значения, которые в чужом payload встречаются, а в JSON не ложатся: их разбираем
// ЯВНО и по-своему. Иначе Object.entries обходит 5-мегабайтный Buffer поэлементно
// (замер: 2.9 с в горячем пути хода), Date превращается в {}, а Error — в пустой объект.
function capForeign(value: object, limit: number): unknown {
  if (ArrayBuffer.isView(value)) return { bytes: value.byteLength };
  if (value instanceof ArrayBuffer) return { bytes: value.byteLength };
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof Error)
    return capTraceString(`${value.name}: ${value.message}`, limit);
  return undefined; // Map и Set разбирает capValue: у них есть своё содержимое.
}

// Любое значение → JSON-безопасное и ограниченное: строки по потолку, массивы и объекты
// по числу элементов, вложенность по глубине. Циклы обрываются той же глубиной, поэтому
// JSON.stringify ниже не может уйти в бесконечность.
function capValue(value: unknown, depth: number, limit: number): unknown {
  if (typeof value === "string") return capTraceString(value, limit);
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return value;
  if (typeof value === "bigint") return capTraceString(value.toString(), limit);
  if (Array.isArray(value)) return capList(value, depth, limit);
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return TRACE_DEPTH_MARKER;
    const foreign = capForeign(value, limit);
    if (foreign !== undefined) return foreign;
    if (value instanceof Map)
      return capList([...value.entries()], depth, limit);
    if (value instanceof Set) return capList([...value], depth, limit);
    // Чужой объект умеет кусаться: геттер с исключением, прокси, отравленный toJSON.
    // Читателю журнала это не интересно — поле помечается и едет дальше.
    let entries: [string, unknown][];
    try {
      entries = Object.entries(value);
    } catch {
      return TRACE_UNREADABLE_MARKER;
    }
    // Object.create(null), а не {}: ключ "__proto__" в чужих аргументах тула присвоением
    // в обычный объект МЕНЯЕТ ПРОТОТИП вместо поля — значение молча исчезает из журнала,
    // а на его месте оказывается прототип. У объекта без прототипа такой ловушки нет.
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of entries.slice(0, MAX_KEYS)) {
      const capped = capValue(item, depth + 1, limit);
      if (capped !== undefined)
        out[capTraceString(key, TRACE_ID_LIMIT)] = capped;
    }
    // Обрезанный объект помечаем так же, как обрезанный массив: читатель обязан видеть,
    // что полей было больше, а не гадать.
    if (entries.length > MAX_KEYS) out[TRACE_TRUNCATED_KEY] = entries.length;
    return out;
  }
  return undefined; // undefined, функция, symbol — в JSON им места нет
}

function capList(
  value: readonly unknown[],
  depth: number,
  limit: number,
): unknown {
  if (depth >= MAX_DEPTH) return TRACE_DEPTH_MARKER;
  const items: unknown[] = value
    .slice(0, MAX_ITEMS)
    .map((item) => capValue(item, depth + 1, limit) ?? null);
  if (value.length > MAX_ITEMS) items.push(TRACE_TRUNCATION_MARKER);
  return items;
}

function header(input: TraceInput, now: Date) {
  return {
    ts: now.toISOString(),
    turn: capTraceString(String(input.turn ?? ""), TRACE_ID_LIMIT),
    session: capTraceString(String(input.session ?? ""), TRACE_ID_LIMIT),
    source: capTraceString(String(input.source ?? ""), TRACE_ID_LIMIT),
    kind: capTraceString(String(input.kind), TRACE_ID_LIMIT),
    name: capTraceString(String(input.name), TRACE_ID_LIMIT),
  };
}

/** Влезает ли строка в потолок. Считается в БАЙТАХ: именно они уходят в write(2). */
function fits(line: string): boolean {
  return Buffer.byteLength(line, "utf8") <= TRACE_LINE_LIMIT;
}

// Сериализация одного варианта строки. Всё, что могло сломаться на чужих данных, уже
// сломалось в capValue и помечено; здесь остаётся последний предохранитель, чтобы
// событие всегда становилось строкой, а не исключением посреди хода.
function stringify(
  head: ReturnType<typeof header>,
  data: Record<string, unknown>,
  limit: number,
): string {
  try {
    return JSON.stringify({
      ...head,
      data: capValue(data, 1, limit) as Record<string, unknown>,
    });
  } catch {
    return JSON.stringify({ ...head, data: { traceUnreadable: true } });
  }
}

/**
 * Событие → одна строка JSONL (без перевода строки). Чистая функция: writer вызывает
 * её, а тесты проверяют схему и потолки без файловой системы.
 *
 * Гарантии: результат — валидный JSON без переводов строк внутри, длиной не больше
 * TRACE_LINE_LIMIT. Строка, не влезшая с содержимым, пересобирается с полями по
 * TRACE_CONTENT_FALLBACK, потом без содержимого с меткой `data.traceTrimmed`, поэтому
 * «слишком большое событие» становится маленьким событием, а не потерянным.
 */
export function traceLine(
  input: TraceInput,
  options: TraceOptions = {},
): string {
  const now = options.now ?? new Date();
  const capture =
    options.captureContent ?? captureContentEnabled(options.dir ?? dataDir());
  const content = input.content ?? {};
  const sizes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) {
    if (typeof value === "string") sizes[`${key}Chars`] = value.length;
  }
  // Порядок ключей — это и порядок выживания: сначала data, потом размеры, и только
  // потом само содержимое. Обрезка по числу ключей и падение в ветку без содержимого
  // отнимают ХВОСТ, поэтому имена, тайминги и размеры остаются в любом случае.
  const base = { ...(input.data ?? {}), ...sizes };
  const full = capture ? { ...base, ...content } : base;

  const head = header(input, now);
  // Попытки по убыванию: всё по 4096, всё по 2000, без содержимого, и последней — без
  // `data`: имена ушли, но размеры содержимого остаются — контракт (docs/trace.md)
  // обещает их при любой обрезке.
  const attempts: [Record<string, unknown>, number][] = [
    [full, TRACE_CONTENT_LIMIT],
    [full, TRACE_CONTENT_FALLBACK],
    [{ ...base, traceTrimmed: true }, TRACE_CONTENT_FALLBACK],
    [{ ...sizes, traceTrimmed: true }, TRACE_CONTENT_FALLBACK],
  ];
  for (const [data, limit] of attempts) {
    const line = stringify(head, data, limit);
    if (fits(line)) return line;
  }
  return JSON.stringify({ ...head, data: { traceTrimmed: true } });
}

// Каталог журнала создаём внутри УЖЕ существующего каталога данных и один раз на процесс.
// Сам data/ писатель не создаёт: журнал не имеет права материализовать установку там, где
// её нет (тест, CLI из чужого cwd) — он всего лишь диагностика.
let ensuredTraceDir = "";
function ensureTraceDir(dir: string): boolean {
  const target = traceDir(dir);
  if (ensuredTraceDir === target) return true;
  if (!existsSync(dir)) return false;
  mkdirSync(target, { recursive: true });
  ensuredTraceDir = target;
  return true;
}

let prunedFor = "";
function pruneOnNewDay(dir: string, day: string): void {
  const marker = `${dir}\0${day}`;
  if (prunedFor === marker) return;
  prunedFor = marker;
  pruneTrace(dir, day);
}

/**
 * Чистка журнала по дате В ИМЕНИ файла. Имена не по шаблону не трогаем вовсе: чужой файл
 * в каталоге — не повод его удалять. Возвращает удалённые имена (для теста и CLI).
 */
export function pruneTrace(
  dir: string = dataDir(),
  today: string = traceDay(),
  days: number = TRACE_RETENTION_DAYS,
): string[] {
  const cutoff = shiftDay(today, -(days - 1));
  if (cutoff === null) return []; // непонятное «сегодня» — ничего не удаляем
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(traceDir(dir));
  } catch {
    return removed; // каталога журнала ещё нет
  }
  for (const name of names) {
    if (!TRACE_FILE_RE.test(name)) continue;
    if (name.slice(0, 10) >= cutoff) continue;
    rmSync(join(traceDir(dir), name), { force: true });
    removed.push(name);
  }
  return removed;
}

function shiftDay(day: string, delta: number): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (!parts) return null;
  const at = new Date(
    Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]) + delta),
  );
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
}

/**
 * Дозапись одного события. Одна строка одним appendFileSync в O_APPEND — параллельные
 * писатели (процесс агента и мост) не перемешивают половины строк.
 */
export function appendTrace(
  input: TraceInput,
  options: TraceOptions = {},
): void {
  try {
    const dir = options.dir ?? dataDir();
    const now = options.now ?? new Date();
    const day = traceDay(now);
    if (!ensureTraceDir(dir)) return;
    appendFileSync(
      traceFilePath(day, dir),
      `${traceLine(input, { ...options, now })}\n`,
      "utf8",
    );
    pruneOnNewDay(dir, day);
  } catch (error) {
    reportTraceFailure(error);
  }
}

// Диск кончился — про это надо сказать один раз, а не залить journal службы строкой на
// каждое событие хода. Одна жалоба в минуту плюс счётчик пропущенных.
const FAILURE_LOG_INTERVAL_MS = 60_000;
let lastFailureLoggedAt = 0;
let suppressedFailures = 0;
function reportTraceFailure(error: unknown): void {
  const at = Date.now();
  if (at - lastFailureLoggedAt < FAILURE_LOG_INTERVAL_MS) {
    suppressedFailures += 1;
    return;
  }
  const skipped = suppressedFailures;
  lastFailureLoggedAt = at;
  suppressedFailures = 0;
  console.error(
    `[trace] событие не записано${skipped > 0 ? ` (ещё ${skipped} за минуту)` : ""}:`,
    error,
  );
}

// Швы зовут журнал одной строкой, поэтому сборка события тоже обязана быть безопасной:
// упавший геттер в чужом payload не имеет права уронить ход.
function emit(build: () => TraceInput): void {
  try {
    appendTrace(build());
  } catch (error) {
    console.error("[trace] событие не собрано:", error);
  }
}

/**
 * Событие, которое без ключа хода бессмысленно: ключ берётся из контекста, а вне хода
 * запись НЕ ИДЁТ вовсе — вердикт не к чему прицепить, а диск чистый примитив трогать не
 * должен (docs/trace.md, «Gate verdicts outside a turn»).
 */
function emitInScope(build: (scope: TraceScope) => TraceInput): void {
  const scope = activeScope();
  if (!scope) return;
  emit(() => build(scope));
}

// --- Корреляция: ключ апдейта ↔ ход ---

// В журнал попадает только то, что имеет текстовый вид: чужой объект в поле id даёт
// пустую часть ключа, а не "[object Object]".
function scalarText(value: unknown): string {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
    ? String(value)
    : "";
}

/** Ключ апдейта: минимальное, что знают обе стороны — мост и ядро. */
function traceUpdateKey(chatId: unknown, messageId: unknown): string {
  return `tg:${scalarText(chatId)}:${scalarText(messageId)}`;
}

type TelegramUpdateLike = {
  stopped_message_generation?: {
    chat?: { id?: unknown };
    draft_id?: unknown;
  } | null;
  update_id?: unknown;
  message?: {
    message_id?: unknown;
    chat?: { id?: unknown };
    iva_parts?: unknown;
  } | null;
  callback_query?: {
    id?: unknown;
    message?: { chat?: { id?: unknown } } | null;
  } | null;
};

// Разбор сырого апдейта Telegram живёт в одном месте: и мост, и ядро должны получать
// ОДИН И ТОТ ЖЕ ключ, иначе цепочка хода рвётся ровно посередине.
function updateFacts(update: TelegramUpdateLike): {
  updateId: unknown;
  chatId: unknown;
  messageId: string;
  kind: string;
} {
  const message = update.message ?? undefined;
  const callback = update.callback_query ?? undefined;
  const stop = update.stopped_message_generation;
  const chatId =
    message?.chat?.id ?? callback?.message?.chat?.id ?? stop?.chat?.id;
  return {
    updateId: typeof update.update_id === "number" ? update.update_id : null,
    chatId: chatId ?? null,
    messageId: message
      ? scalarText(message.message_id)
      : stop
        ? `stop:${scalarText(update.update_id)}`
        : `cb:${scalarText(callback?.id)}`,
    kind: message
      ? "message"
      : callback
        ? "callback"
        : stop
          ? "stopped_message_generation"
          : "unknown",
  };
}

// Ключ апдейта, с которого начался ход этого чата. Живёт в памяти процесса агента ровно
// между приёмом апдейта и turn.started — оба события в одном процессе. Карта ограничена:
// журнал не имеет права расти вместе с числом чатов.
const MAX_BINDINGS = 64;
const bindings = new Map<string, string>();

export function traceBindUpdate(chatKey: string, updateKey: string): void {
  if (!chatKey) return;
  bindings.delete(chatKey);
  bindings.set(chatKey, updateKey);
  for (const key of bindings.keys()) {
    if (bindings.size <= MAX_BINDINGS) break;
    bindings.delete(key);
  }
}

export function traceBoundUpdate(chatKey: string): string {
  return bindings.get(chatKey) ?? "";
}

// --- Контекст хода в процессе ---

/**
 * Кто сейчас «в ходе». Нужен местам, которые сами про ход ничего не знают, а событие
 * без ключа хода бесполезно: санитайзер входа (agent/lib/security-gate.ts) и
 * outbound-Gate внутри Outbox зовутся из глубины и получают только текст.
 *
 * Контекста нет — событие НЕ ПИШЕТСЯ вовсе. Это же правило убирает побочный эффект из
 * чистых примитивов: юнит-тест гейта и любой сторонний скрипт ничего на диск не кладут.
 */
export type TraceScope = {
  readonly turn?: string;
  readonly session?: string;
  readonly source?: string;
  /** Когда метку поставили через enterWith. См. TRACE_SCOPE_TTL_MS. */
  readonly enteredAt?: number;
};

// Сколько живёт метка, поставленная enterWith. Она остаётся в асинхронном контексте и
// ПОСЛЕ того, как шов отработал: если из того же контекста позже позовут гейт, вердикт
// уехал бы с чужим, давно закрытым ходом. Пустой ключ хода честнее вранья, а все
// настоящие вызовы гейта случаются в секундах от метки, не в минутах.
export const TRACE_SCOPE_TTL_MS = 60_000;

const scopeStore = new AsyncLocalStorage<TraceScope>();

function activeScope(): TraceScope | undefined {
  const scope = scopeStore.getStore();
  if (scope?.enteredAt === undefined) return scope; // traceWithScope — область точная
  return Date.now() - scope.enteredAt > TRACE_SCOPE_TTL_MS ? undefined : scope;
}

/**
 * Пометить текущий асинхронный контекст ходом. `enterWith`, потому что вызывающий шов
 * обёртку вокруг себя поставить не может (одна строка в inbound-пайплайне, одна в туле).
 * Область — текущий асинхронный контекст и всё, что из него порождается.
 */
export function traceEnterScope(scope: TraceScope): void {
  scopeStore.enterWith({ ...scope, enteredAt: Date.now() });
}

/**
 * Метка хода из контекста тула eve. Отдельная функция, потому что ctx приходит из чужих
 * рук: у теста тула его может не быть вовсе, а журнал не имеет права ронять инструмент.
 */
export function traceEnterToolScope(ctx: unknown, source: string): void {
  try {
    const session = isRecord(ctx) ? ctx.session : undefined;
    const turnValue = isRecord(session) ? session.turn : undefined;
    const turn = parentTurnId(isRecord(turnValue) ? turnValue : undefined);
    const sessionId = scalarText(isRecord(session) ? session.id : undefined);
    // Ни хода, ни сессии — приписывать событие нечему, и метку ставить незачем.
    if (!turn && !sessionId) return;
    traceEnterScope({ turn, session: sessionId, source });
  } catch (error) {
    console.error("[trace] контекст тула не прочитан:", error);
  }
}

/** То же, но с честной областью: блок кода, который мы держим в руках. */
export function traceWithScope<T>(scope: TraceScope, run: () => T): T {
  return scopeStore.run(scope, run);
}

/** Ошибки инструмента и остановка повторов на границе модели. */
export function traceRepeatGuard(
  event: "tool.rejected" | "guard.repeat_stop",
  data: { tool: string; errorHead: string; count?: number },
): void {
  const scope = activeScope();
  appendTrace({
    kind: event === "tool.rejected" ? "tool" : "guard",
    name: event === "tool.rejected" ? "rejected" : "repeat_stop",
    turn: scope?.turn,
    session: scope?.session,
    source: scope?.source ?? "agent",
    data: {
      tool: data.tool,
      errorHead: data.errorHead.slice(0, 160),
      ...(data.count === undefined ? {} : { count: data.count }),
    },
  });
}

// --- Швы Ивы ---

type InboundMessageLike = {
  readonly chat: { readonly id: string; readonly type: string };
  readonly from?: { readonly id: string } | undefined;
  readonly messageId: string;
  readonly text: string;
  readonly caption: string;
};

/**
 * Шов Inbound pipeline: апдейт вошёл внутрь. Вердикт allowlist читается из того же
 * источника, что и сам барьер (`allowedTelegramUsers`), поэтому в журнале не может
 * появиться «пропущен» там, где пайплайн отказал.
 */
export function traceInboundReceived(message: InboundMessageLike): void {
  emit(() => {
    const userId = message.from?.id ?? "";
    const text = message.text || message.caption || "";
    const turn = traceUpdateKey(message.chat.id, message.messageId);
    // С этого момента и до конца разбора апдейта известно, чей это ход: вердикт
    // inbound-Gate поедет с тем же ключом, хотя сам гейт про апдейты ничего не знает.
    traceEnterScope({ turn, source: "telegram" });
    return {
      kind: "inbound",
      name: "received",
      turn,
      source: "telegram",
      data: {
        chatId: message.chat.id,
        chatType: message.chat.type,
        messageId: message.messageId,
        userId,
        allowlisted: allowedTelegramUsers().has(userId),
      },
      content: { text },
    };
  });
}

/**
 * Шов Inbound pipeline: чем кончился разбор апдейта. Ход поехал — пишем состав контекста,
 * который Ива собрала сама (цитата, медиа, буфер занятости, пометки Gate); апдейт отброшен —
 * пишем это отдельным событием, иначе цепочка обрывается без объяснения.
 */
export function traceInboundOutcome(
  message: InboundMessageLike,
  chatKey: string,
  context: readonly string[] | undefined,
  accepted: boolean,
): void {
  emit(() => {
    const updateKey = traceUpdateKey(message.chat.id, message.messageId);
    // Ход вот-вот начнётся: запоминаем, каким апдейтом он вызван, чтобы turn.started
    // мог связать его с turnId. Отброшенный апдейт хода не порождает и ничего не метит.
    if (accepted) traceBindUpdate(chatKey, updateKey);
    return {
      kind: "inbound",
      name: accepted ? "accepted" : "dropped",
      turn: updateKey,
      source: "telegram",
      data: {
        chatId: message.chat.id,
        chatKey,
        parts: context?.length ?? 0,
        partChars: (context ?? []).map((part) => part.length),
      },
      content: { context: context ?? [] },
    };
  });
}

/**
 * Шов inbound-Gate: вердикт санитайзера входа. Пишется ТОЛЬКО внутри хода (emitInScope),
 * потому что сам гейт про ходы ничего не знает.
 *
 * Имя события следует поверхности: телеграм — `gate.inbound`, веб — `gate.web`.
 */
export function traceInboundGate(
  surface: string,
  verdict: {
    readonly blocked: boolean;
    readonly reason: string;
    readonly flags: readonly string[];
    readonly truncatedChars: number;
  },
  chars: number,
): void {
  emitInScope((scope) => ({
    kind: "gate",
    name: surface === "web" ? "web" : "inbound",
    turn: scope.turn,
    session: scope.session,
    source: surface,
    data: {
      surface,
      blocked: verdict.blocked,
      reason: verdict.reason,
      flags: [...verdict.flags],
      truncatedChars: verdict.truncatedChars,
      chars,
    },
  }));
}

/**
 * Состав контекста хода: сколько байт памяти уехало в системный промпт.
 *
 * ПРИБЛИЖЕНИЕ, и это важно знать читателю. CORE, PERSONA и время инжектят динамические
 * инструкции eve (`agent/instructions/*.ts`), а им authored-модули проекта недоступны
 * (гоча eve 0.11.4: зависеть можно только от eve, `@iva/*` и node), поэтому изнутри они
 * отчитаться не могут. Здесь снимается РАЗМЕР ТЕХ ЖЕ ФАЙЛОВ на диске в момент старта
 * хода — то, что инструкция прочитает мгновением позже. Расхождение возможно, только
 * если файл переписали между этими двумя мгновениями (ночной Rollup в момент хода).
 */
export function traceContextParts(
  turnId: string,
  sessionId: string,
  vaultDir: string,
  day: string,
): void {
  emit(() => {
    const parts: Record<string, unknown> = {};
    for (const [name, path] of [
      ["core", join(vaultDir, "CORE.md")],
      ["persona", join(vaultDir, "PERSONA.md")],
      ["moc", join(vaultDir, "MOC.md")],
      ["daily", join(vaultDir, "daily", `${day}.md`)],
    ] as const) {
      try {
        parts[name] = statSync(path).size;
      } catch {
        parts[name] = 0; // файла нет — в промпт ничего и не уедет
      }
    }
    return {
      kind: "context",
      name: "parts",
      turn: turnId,
      session: sessionId,
      source: "telegram",
      data: { ...parts, unit: "bytes", approximate: true },
    };
  });
}

/**
 * Шов старта хода: ключ апдейта и turnId в одной строке. Это единственное место, где
 * события «до хода» сшиваются с событиями eve, поэтому оно пишется даже когда ключа нет
 * (проактивный ход, callback) — тогда `updateKey` пустой.
 */
export function traceTurnBound(
  chatKey: string,
  sessionId: string,
  turnId: string,
): void {
  emit(() => ({
    kind: "turn",
    name: "bound",
    turn: turnId,
    session: sessionId,
    source: "telegram",
    data: { chatKey, updateKey: traceBoundUpdate(chatKey) },
  }));
}

/**
 * Шов outbound-Gate: что нашёл сканер в тексте, уходящем в чат. Ключ хода — из контекста
 * (его ставит traceOutbox вокруг отправки), поэтому сигнатура redactNotice не меняется.
 * Превью находки НЕ пишем: там кусок самого секрета.
 */
export function traceOutboundGate(
  clean: boolean,
  findings: readonly { readonly type: string; readonly name: string }[],
  chars: number,
  redacted: string,
): void {
  emitInScope((scope) => ({
    kind: "gate",
    name: "outbound",
    turn: scope.turn,
    session: scope.session,
    source: scope.source,
    data: {
      clean,
      findings: findings.map((finding) => `${finding.type}:${finding.name}`),
      chars,
    },
    // Текст берём ПОСЛЕ редактуры: журнал не имеет права хранить то, что гейт только что
    // вымарал по дороге в чат. Это же единственное место, где виден текст «как ушёл».
    content: { text: redacted },
  }));
}

type OutboxResultLike = {
  readonly ok: boolean;
  readonly delivered: number;
  readonly fellBack: boolean;
  readonly error: string;
};

/**
 * Шов Outbox: одна отправка — одно событие. Обёртка вокруг вызова шва, а не строчки
 * внутри него: у Outbox три пути наружу (rich, HTML, plain-фолбэк), и событие обязано
 * быть одно на любой из них. Заодно ставит контекст хода — вердикт outbound-Gate внутри
 * шва уезжает с тем же ключом.
 *
 * `source` НЕ зашит: ночной ход (rollup) и части Watch и Brief (watch, brief) уходят тем же
 * швом и обязаны называться своим именем, иначе вьюер считает их разговором в Telegram.
 */
export async function traceOutbox<T extends OutboxResultLike>(
  scope: TraceScope,
  text: string,
  send: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const result = await traceWithScope(scope, send);
  emit(() => ({
    kind: "outbox",
    name: result.ok ? "delivered" : "failed",
    turn: scope.turn,
    session: scope.session,
    source: scope.source,
    // Сам текст здесь НЕ пишем: сюда он приходит до outbound-Gate, а хранить вымаранный
    // секрет обратно в журнале — ровно та утечка, которую гейт и закрывает. Текст «как
    // ушёл» лежит в gate.outbound, текст модели — в eve.message.completed.
    data: {
      ok: result.ok,
      delivered: result.delivered,
      fellBack: result.fellBack,
      error: result.error,
      chars: text.length,
      ms: Date.now() - startedAt,
    },
  }));
  return result;
}

/** Шов «Стоп»: чем кончилась просьба остановить ход. */
export function traceStop(
  chatKey: string,
  status: { readonly turnId?: unknown; readonly sessionId?: unknown } | null,
  outcome: string,
): void {
  emit(() => ({
    kind: "stop",
    name: outcome,
    turn: scalarText(status?.turnId),
    session: scalarText(status?.sessionId),
    source: "telegram",
    data: { chatKey, outcome },
  }));
}

/**
 * Исход приёма апдейта мостом — ровно словарь scripts/poller/inbox.ts
 * (`InboxAdmissionResult`), без синонимов: одно решение — одно слово в журнале.
 */
export type TraceBridgeDecision =
  "owned" | "terminal-drop" | "unownable" | "write-failed";

// Оба события моста — один апдейт, разобранный одинаково: имя следует исходу.
function emitBridge(
  update: TelegramUpdateLike,
  name: string,
  extra: Record<string, unknown>,
): void {
  emit(() => {
    const facts = updateFacts(update);
    return {
      kind: "bridge",
      name,
      turn: traceUpdateKey(facts.chatId, facts.messageId),
      source: "bridge",
      data: { ...facts, ...extra },
    };
  });
}

/** Шов Bridge: апдейт принят мостом или отброшен. Имя события следует исходу. */
export function traceBridgeAdmission(
  update: TelegramUpdateLike,
  decision: TraceBridgeDecision,
): void {
  emitBridge(update, decision === "owned" ? "admitted" : "dropped", {
    decision,
  });
}

function updatePartCount(update: TelegramUpdateLike): number {
  const parts = update.message?.iva_parts;
  return Array.isArray(parts) && parts.length > 0 ? parts.length : 1;
}

/** Шов Bridge: апдейт отдан агенту (или не принят им). */
export function traceBridgeDelivery(
  update: TelegramUpdateLike,
  accepted: unknown,
  ms: number,
): void {
  // "closed-session" — отказ, а не доставка: ход не начался и уже не начнётся.
  const terminal = accepted === "closed-session";
  emitBridge(update, accepted && !terminal ? "delivered" : "rejected", {
    accepted: accepted === "handled" || terminal ? accepted : Boolean(accepted),
    ms,
    parts: updatePartCount(update),
  });
}

/** Шов Bridge: сообщение встало в очередь чата; count — сколько теперь ждёт, reason — почему. */
export function traceBridgeQueued(
  update: TelegramUpdateLike,
  count: number,
  reason?: string,
): void {
  emitBridge(update, "queued", {
    count,
    parts: updatePartCount(update),
    ...(reason === undefined ? {} : { reason }),
  });
}

export type HelperTraceEvent =
  "refused" | "finished" | "store_broken" | "goal_due" | "goal_paused";

export function traceHelper(
  event: HelperTraceEvent,
  id: string | null,
  fields: Omit<TraceInput, "kind" | "name">,
  options?: TraceOptions,
): void {
  appendTrace(
    {
      ...fields,
      source: "helper",
      kind: "helper",
      name: event,
      data: { ...fields.data, helper: id },
    },
    options,
  );
}
