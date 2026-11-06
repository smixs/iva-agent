// Сбои последних суток из Trace без модели: ход Insight получает их короткий список в начале
// промпта (scripts/proactive/tick.ts), пакет `iva diagnose` — тот же список без текста причины
// (ADR-0022, docs/trace.md). Только `node:fs`, `node:path` и `turn-ref.ts`: `iva diagnose`
// стартует без `agent/` (scripts/cli/diagnose.ts), тик ради чтения его тоже не тянет.
//
// Читаются два последних дневных файла: имя дня — в поясе владельца, `ts` — UTC, поэтому сутки
// лежат в двух файлах. Сбой — `eve.turn.failed`/`step.failed`, `eve.action.result` с
// `failure`, `outbox.failed`, `stop.failed` и `guard.repeat_stop`. Не сбой: `gate.*`,
// `bridge.dropped`, Стоп владельца, `tool.rejected` (тот же вызов уже есть строкой
// `action.result` с ходом) и всё в сессиях самого Insight — иначе его же ошибка завтра стала бы
// причиной в списке.
import { closeSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { turnRef } from "./turn-ref.ts";
export { turnRef } from "./turn-ref.ts";

export type TurnFailure = {
  /** Имя инструмента, "turn", "outbox", "stop". */
  readonly where: string;
  /** Класс без текста: failure, code, "failed", "repeat ×N". */
  readonly kind: string;
  /** Первая строка причины, до 120 знаков; "" при captureContent:false. */
  readonly reason: string;
  /** turnRef(session, turn) новейшего хода; "" — ход неизвестен. */
  readonly ref: string;
  /** Миллисекунды новейшего события. */
  readonly at: number;
  /** Разные ходы; событие без хода — каждое как ход. */
  readonly count: number;
};

type Line = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/u;
const LABEL_CHARS = 60;
const REASON_CHARS = 120;
const KEY_REASON_CHARS = 80;
const LINE_CHARS = 200;
// Промпт Insight начинается с `Insight:`; если строку сбоя пометил Gate, перед ним стоит
// предупреждение одной строкой и пустая строка (scripts/proactive/tick.ts, `insightPrompt`).
const INSIGHT_PROMPT = /^(?:[^\n]*\n\n)?Insight:/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const scalar = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const dataOf = (line: Line): Line => (isRecord(line.data) ? line.data : {});

/** Не длиннее `limit` знаков, без одинокой половины суррогатной пары на срезе. */
export function cutText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const cut = value.slice(0, Math.max(0, limit));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const oneLine = (value: string): string =>
  (value.split("\n").find((line) => line.trim() !== "") ?? "")
    .replace(/\s+/gu, " ")
    .trim();

const label = (value: string): string =>
  cutText(value.replace(/\s+/gu, " ").trim(), LABEL_CHARS);

const lastLine = (value: string): string =>
  value
    .split("\n")
    .filter((line) => line.trim() !== "")
    .at(-1) ?? "";

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Причина из ответа-объекта: `error` (строка или его `message`), конец `stderr`, `message`. */
function recordReason(answer: Record<string, unknown>): string {
  const error = answer.error;
  if (typeof error === "string" && error.trim() !== "") return error;
  if (isRecord(error) && typeof error.message === "string")
    return error.message;
  return lastLine(text(answer.stderr)) || text(answer.message);
}

// Ключи-скаляры подряд от начала объекта, каждый с запятой после себя: у строки, обрезанной с
// конца, это ровно те, что уцелели целиком. Хук ставит `ok`, `error`, `message` (у bash —
// `exitCode` и `stderr`) первыми.
const LEADING_SCALARS =
  /^\{(?:"(?:[^"\\]|\\.)*":(?:"(?:[^"\\]|\\.)*"|[-+.\w]+),)*/u;

/** Ведущие ключи обрезанного ответа; всё после них — содержимое, оно в причину не идёт. */
function leadingFields(raw: string): Record<string, unknown> {
  const head = LEADING_SCALARS.exec(raw)?.[0] ?? "{";
  const parsed = parseJson(`${head.slice(0, -1) || "{"}}`);
  return isRecord(parsed) ? parsed : {};
}

/**
 * Причина из `result` — строки JSON, которую хук пишет вместо объекта ответа. Не JSON — сама
 * строка (ответ-текст), но если это объект, обрезанный писателем с конца, — только его ведущие
 * ключи: сырая голова несла бы содержимое ответа (карточку, страницу) в промпт и в issue.
 */
function resultReason(result: unknown): string {
  const raw = text(result);
  const parsed = parseJson(raw);
  if (isRecord(parsed)) return recordReason(parsed);
  if (parsed === undefined && raw.trimStart().startsWith("{"))
    return recordReason(leadingFields(raw.trimStart()));
  return raw;
}

function reasonText(kind: string, name: string, data: Line): string {
  if (kind === "guard") return text(data.errorHead);
  if (kind === "eve" && name === "action.result")
    return text(data.error) || resultReason(data.result);
  if (kind === "eve") return text(data.message);
  return text(data.error);
}

/**
 * Одна строка причины из события: у шага — `message`, у вызова — `error`, иначе из `result`
 * (`error`, последняя строка `stderr`, `message`), у доставки и Стопа — `error`, у сторожа —
 * `errorHead`. Пробелы схлопнуты, длина не ограничена: режет тот, кто печатает.
 */
export function failureReason(line: Record<string, unknown>): string {
  return oneLine(reasonText(text(line.kind), text(line.name), dataOf(line)));
}

type Cause = { readonly where: string; readonly kind: string };

const turnCause = (data: Line): Cause => ({
  where: "turn",
  kind: label(scalar(data.code) || "failed"),
});

/** Чей вызов: инструмент, иначе субагент или скилл `load_skill` — у их ответов нет `toolName`. */
function callWhere(data: Line): string {
  if (text(data.toolName) !== "") return text(data.toolName);
  if (text(data.subagentName) !== "")
    return `subagent ${text(data.subagentName)}`;
  if (text(data.name) !== "") return `skill ${text(data.name)}`;
  return "tool";
}

/** Сбои по `kind.name` (таблица 3.2.1 спеки); вызов без `failure` — не сбой. */
const CAUSES: Readonly<Record<string, (data: Line) => Cause | null>> = {
  "eve.turn.failed": turnCause,
  "eve.step.failed": turnCause,
  "eve.action.result": (data) =>
    text(data.failure) === ""
      ? null
      : { where: label(callWhere(data)), kind: label(text(data.failure)) },
  "outbox.failed": () => ({ where: "outbox", kind: "failed" }),
  "stop.failed": () => ({ where: "stop", kind: "failed" }),
  "guard.repeat_stop": (data) => ({
    where: label(text(data.tool) || "tool"),
    kind: typeof data.count === "number" ? `repeat ×${data.count}` : "repeat",
  }),
};

/** Где и какой сбой; не сбой — null. */
export function failureCause(line: Record<string, unknown>): Cause | null {
  const event = `${text(line.kind)}.${text(line.name)}`;
  return Object.hasOwn(CAUSES, event) ? CAUSES[event](dataOf(line)) : null;
}

/** Полная пара `<session>/<turn>` без суффикса субагента; чего-то нет — "". */
function refOf(line: Line): string {
  if (text(line.kind) === "guard") return "";
  const session = text(line.session);
  const turn = text(line.turn).split("#")[0] ?? "";
  // Голый `turn_N` назвал бы чужой ход: `iva trace show turn_3` открывает новейший из всех сессий.
  if (!/^\S+$/u.test(session) || !/^[^\s/]+$/u.test(turn)) return "";
  return turnRef(session, turn);
}

/** Строка журнала, которую можно читать: объект с `kind`, `name`, `data` и датой в `ts`. */
function parseLine(raw: string): Line | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.kind !== "string" ||
    typeof parsed.name !== "string" ||
    !isRecord(parsed.data) ||
    !Number.isFinite(Date.parse(text(parsed.ts)))
  )
    return null;
  return parsed;
}

/**
 * Строки последних `days` дневных файлов журнала (все — без числа), годные к разбору. Нет
 * каталога — пусто; другой отказ `readdir` бросает.
 */
export function readTrace(
  dataDir: string,
  days = Number.POSITIVE_INFINITY,
  maxBytesPerFile = Number.POSITIVE_INFINITY,
): {
  readonly lines: Line[];
  unreadable: number;
} {
  const directory = join(dataDir, "trace");
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { lines: [], unreadable: 0 };
    throw error;
  }
  const out = { lines: [] as Line[], unreadable: 0 };
  for (const day of names
    .filter((name) => DAY_FILE.test(name))
    .sort()
    .slice(-days))
    readDay(join(directory, day), out, maxBytesPerFile);
  return out;
}

function readDay(
  file: string,
  out: { readonly lines: Line[]; unreadable: number },
  maxBytes: number,
): void {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    let position = Math.max(0, size - maxBytes);
    const marker = Buffer.alloc(1);
    if (position > 0) readSync(fd, marker, 0, 1, position - 1);
    let skip = position > 0 && marker[0] !== 10;
    const accept = (raw: string) => {
      if (skip) {
        skip = false;
        return;
      }
      if (raw.trim() === "") return;
      const line = parseLine(raw);
      if (line === null) out.unreadable += 1;
      else out.lines.push(line);
    };
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    while (position < size) {
      const bytes = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position,
      );
      if (bytes === 0) break;
      position += bytes;
      const parts = (pending + decoder.write(buffer.subarray(0, bytes))).split(
        "\n",
      );
      pending = parts.pop() ?? "";
      for (const raw of parts) accept(raw);
    }
    accept(pending + decoder.end());
  } catch {
    out.unreadable += 1;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Сессии Insight (промпт с `Insight:`, в том числе после предупреждения Gate): их сбои в список не идут. */
function insightSessions(lines: readonly Line[]): Set<string> {
  const sessions = new Set<string>();
  for (const line of lines) {
    const session = text(line.session);
    if (
      session !== "" &&
      line.kind === "eve" &&
      line.name === "message.received" &&
      INSIGHT_PROMPT.test(text(dataOf(line).message))
    )
      sessions.add(session);
  }
  return sessions;
}

type Fold = {
  where: string;
  kind: string;
  reason: string;
  ref: string;
  at: number;
  readonly key: string;
  readonly refs: Set<string>;
  anonymous: number;
};

const foldKey = (where: string, kind: string, reason: string): string =>
  `${where}\n${kind}\n${reason.toLowerCase().replace(/\d+/gu, "#").slice(0, KEY_REASON_CHARS)}`;

/** Новее — больше `at`; при равном — больше `ref`, затем `reason`: порядок строк не важен. */
const newer = (
  a: { at: number; ref: string; reason: string },
  b: { at: number; ref: string; reason: string },
): boolean =>
  a.at !== b.at
    ? a.at > b.at
    : a.ref !== b.ref
      ? a.ref > b.ref
      : a.reason > b.reason;

function addEvent(folds: Map<string, Fold>, line: Line, at: number): void {
  const cause = failureCause(line);
  if (cause === null) return;
  const reason = cutText(failureReason(line), REASON_CHARS);
  const ref = refOf(line);
  const event = { ...cause, reason, ref, at };
  const key = foldKey(cause.where, cause.kind, reason);
  const fold = folds.get(key) ?? {
    ...event,
    key,
    refs: new Set<string>(),
    anonymous: 0,
  };
  folds.set(key, fold);
  if (newer(event, fold)) Object.assign(fold, event);
  if (ref === "") fold.anonymous += 1;
  else fold.refs.add(ref);
}

const countOf = (fold: Fold): number => fold.refs.size + fold.anonymous;

const byWeight = (a: Fold, b: Fold): number =>
  countOf(b) - countOf(a) ||
  b.at - a.at ||
  (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Сбои последних 24 часов от `nowMs`, свёрнутые по причине: где, класс, первая строка причины
 * (число в ключе свёртки — `#`). `count` — разные ходы, порядок — по `count`, потом по
 * свежести. Нет каталога — пусто; битая строка — `unreadable`.
 */
export function listTurnFailures(
  dataDir: string,
  nowMs: number,
): { readonly causes: readonly TurnFailure[]; readonly unreadable: number } {
  const { lines, unreadable } = readTrace(dataDir, 2);
  const skip = insightSessions(lines);
  const folds = new Map<string, Fold>();
  for (const line of lines) {
    const at = Date.parse(text(line.ts));
    if (at < nowMs - DAY_MS || at > nowMs || skip.has(text(line.session)))
      continue;
    addEvent(folds, line, at);
  }
  const causes = [...folds.values()].sort(byWeight).map((fold) => ({
    where: fold.where,
    kind: fold.kind,
    reason: fold.reason,
    ref: fold.ref,
    at: fold.at,
    count: countOf(fold),
  }));
  return { causes, unreadable };
}

/** Строка для промпта Insight: до 200 знаков за счёт причины, `ref` не режется никогда. */
export function insightLine(cause: TurnFailure, maxChars = LINE_CHARS): string {
  const head = `${cause.count}× ${cause.where} · ${cause.kind}`;
  const open = cause.ref
    ? `iva trace show ${cause.ref}`
    : "no turn in the Trace";
  const tail = ` · last ${new Date(cause.at).toISOString().slice(11, 16)} UTC · ${open}`;
  const room = maxChars - head.length - tail.length - " · ".length;
  const reason = room > 0 ? cutText(cause.reason, room).trimEnd() : "";
  return reason ? `${head} · ${reason}${tail}` : `${head}${tail}`;
}

/** Первые `limit` причин строками без ведущего `- ` и строка о прочих; пусто — []. */
export function insightFailureLines(
  causes: readonly TurnFailure[],
  limit = 10,
): string[] {
  const lines = causes.slice(0, limit).map((cause) => insightLine(cause));
  if (causes.length > limit)
    lines.push(`… and ${causes.length - limit} more causes`);
  return lines;
}

/**
 * Строки раздела `## Failures` пакета diagnose: класс и ход без текста причины — это ходы,
 * которых владелец не выбирал, а причина может нести его сообщение.
 */
export function diagnoseFailureLines(causes: readonly TurnFailure[]): string[] {
  return causes.map(
    (cause) =>
      `- ${cause.count}× ${cause.where} · ${cause.kind} · last ${new Date(cause.at).toISOString()} · ${cause.ref || "-"}`,
  );
}
