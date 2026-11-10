import { defineHook, type HookContext } from "eve/hooks";
import {
  markTelegramSessionForRetirement,
  updateTelegramPendingInputRequests,
} from "../lib/run-status.js";
import {
  appendTrace,
  capTraceTail,
  TRACE_CONTENT_LIMIT,
  TRACE_TRUNCATION_MARKER,
} from "../lib/trace.js";
import { parentTurnId, subagentTurnId } from "../lib/usage.js";
import { isRecord } from "../../packages/guards/index.ts";
import { REDACTED } from "../../packages/secret-redaction/index.ts";
import { SECRET_ARGUMENTS as USERBOT_SECRET_ARGUMENTS } from "../connections/telegram-userbot.ts";

// Журнал хода, часть eve: ОДИН хук на подстановочное событие `*` пишет каждый шаг модели,
// каждый вызов тула и каждый терминальный исход в data/trace/YYYY-MM-DD.jsonl (ADR-0010).
// Швы самой Ивы (Bridge, Inbound pipeline, Gate, Outbox, Стоп) пишут туда же из
// agent/lib/trace.ts — вместе получается цепочка одного хода.
//
// ВАЖНО: в отличие от transcript.ts раунды tool-calls НЕ фильтруются — в журнале обязан
// быть КАЖДЫЙ шаг. Зато отброшены дельта-события (`message.appended`, `reasoning.appended`,
// `action.partial`, `action.input.appended`): это промежуточный поток из сотен событий за
// ход, поэтому журнал рос бы без пользы — итог приходит в `*.completed`.
//
// Шаги инлайн-субагента (planner) приходят завёрнутыми в `subagent.event`: разворачиваем и
// пишем внутреннее событие ключом хода РОДИТЕЛЯ с суффиксом (тот же subagentTurnId, что у
// usage.jsonl), поэтому ход субагента виден вложенным и сходится с учётом расхода.
const DELTA_EVENTS = new Set([
  "message.appended",
  "reasoning.appended",
  "action.partial",
  "action.input.appended",
]);

// Короткие поля события: имена, индексы, коды, статусы. Пишутся всегда.
const SCALAR_FIELDS = [
  "sequence",
  "stepIndex",
  "finishReason",
  "status",
  "code",
  "callId",
  "childSessionId",
  "sessionId",
  "subagentName",
  "toolName",
  "name",
  "isError",
] as const;

// Содержимое: текст модели, аргументы и результаты тулов. Пишется под тумблером
// captureContent и всегда с потолком на поле (agent/lib/trace.ts).
const CONTENT_FIELDS = [
  "message",
  "reasoning",
  "output",
  "result",
  "input",
  "details",
] as const;

// Аргументы, которые инструмент сам назвал секретом рядом со своим описанием. Вызов
// пишется с меткой на месте значения при любом тумблере: имя аргумента и факт вызова
// остаются, значение на диск не идёт.
const SECRET_ARGUMENTS: ReadonlySet<string> = new Set(USERBOT_SECRET_ARGUMENTS);

function withoutSecrets(input: unknown): unknown {
  if (!isRecord(input)) return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      SECRET_ARGUMENTS.has(key) ? REDACTED : value,
    ]),
  );
}

type StreamEvent = { readonly type: string; readonly data?: unknown };
type ReplayContext = {
  readonly session?: { readonly id?: unknown };
  readonly channel?: { readonly kind?: unknown };
};
type MarkRetirement = (
  sessionId: string,
  turnId: string,
  replayMs: number,
) => boolean;
type UpdatePendingInputs = typeof updateTelegramPendingInputRequests;

function replayRetireThreshold(raw: string | undefined): number {
  if (raw === undefined) return 30_000;
  const value = Number(raw);
  if (raw.trim().length === 0 || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `TELEGRAM_REPLAY_RETIRE_THRESHOLD_MS must be a positive number, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

// Workaround for the 240 s replay ceiling; remove when vercel/eve#2876 is resolved upstream.
export const TELEGRAM_REPLAY_RETIRE_THRESHOLD_MS = replayRetireThreshold(
  process.env.TELEGRAM_REPLAY_RETIRE_THRESHOLD_MS,
);
// Session startup is baseline cost, not replay growth worth retiring for.
const TELEGRAM_REPLAY_RETIRE_BASELINE_MULTIPLIER = 2;
const MAX_TRACKED_REPLAY_TURNS = 128;

// Eve derives every authored channel kind from its file name with this prefix.
const authoredChannelKind = (name: string) => `channel:${name}`;
const TELEGRAM_CHANNEL_KIND = authoredChannelKind("telegram");

function isScalar(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function createTelegramReplayRetirementObserver({
  now = Date.now,
  markImpl = markTelegramSessionForRetirement,
}: {
  now?: () => number;
  markImpl?: MarkRetirement;
} = {}) {
  const turns = new Map<
    string,
    { startedAt: number; settled: boolean; marked: boolean }
  >();
  const baselines = new Map<string, number>();
  const remember = (
    key: string,
    value: { startedAt: number; settled: boolean; marked: boolean },
  ) => {
    turns.set(key, value);
    while (turns.size > MAX_TRACKED_REPLAY_TURNS) {
      const oldest = turns.keys().next().value;
      if (oldest === undefined) break;
      turns.delete(oldest);
    }
  };
  const rememberBaseline = (sessionId: string, replayMs: number) => {
    baselines.set(sessionId, replayMs);
    while (baselines.size > MAX_TRACKED_REPLAY_TURNS) {
      const oldest = baselines.keys().next().value;
      if (oldest === undefined) break;
      baselines.delete(oldest);
    }
  };

  return (event: StreamEvent, ctx: ReplayContext): void => {
    if (ctx.channel?.kind !== TELEGRAM_CHANNEL_KIND) return;
    const sessionId = text(ctx.session?.id);
    const data = isRecord(event.data) ? event.data : {};
    const turnId = text(data.turnId);
    if (sessionId.length === 0 || turnId.length === 0) return;
    const key = `${sessionId}\u0000${turnId}`;
    const current = turns.get(key);

    if (event.type === "turn.started") {
      if (current) return;
      remember(key, { startedAt: now(), settled: false, marked: false });
      return;
    }

    if (
      event.type === "turn.completed" ||
      event.type === "turn.cancelled" ||
      event.type === "turn.failed"
    ) {
      if (current) current.settled = true;
      else remember(key, { startedAt: now(), settled: true, marked: false });
      return;
    }

    if (
      event.type !== "message.received" ||
      !current ||
      current.settled ||
      current.marked
    ) {
      return;
    }

    // replayMs = hook time at message.received - hook time at first turn.started.
    // The cut points span durable replay until the current turn is ready.
    const replayMs = now() - current.startedAt;
    if (!Number.isFinite(replayMs)) return;
    const baselineMs = baselines.get(sessionId);
    if (data.sequence === 0) {
      if (baselineMs === undefined) rememberBaseline(sessionId, replayMs);
      return;
    }
    if (
      replayMs > TELEGRAM_REPLAY_RETIRE_THRESHOLD_MS &&
      (baselineMs === undefined ||
        replayMs > baselineMs * TELEGRAM_REPLAY_RETIRE_BASELINE_MULTIPLIER) &&
      markImpl(sessionId, turnId, replayMs)
    ) {
      current.marked = true;
    }
  };
}

const requestIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((entry) =>
        isRecord(entry) && typeof entry.requestId === "string"
          ? [entry.requestId]
          : [],
      )
    : [];

export function createTelegramPendingInputObserver({
  updateImpl = updateTelegramPendingInputRequests,
}: { updateImpl?: UpdatePendingInputs } = {}) {
  return (event: StreamEvent, ctx: ReplayContext): void => {
    if (ctx.channel?.kind !== TELEGRAM_CHANNEL_KIND) return;
    const sessionId = text(ctx.session?.id);
    const data = isRecord(event.data) ? event.data : {};
    const requested =
      event.type === "input.requested" ? requestIds(data.requests) : [];
    const resolved =
      event.type === "input.resolved" ? requestIds(data.resolutions) : [];
    if (
      sessionId.length === 0 ||
      (requested.length === 0 && resolved.length === 0)
    )
      return;
    updateImpl(sessionId, { requested, resolved });
  };
}

const observeTelegramReplay = createTelegramReplayRetirementObserver();
const observeTelegramPendingInput = createTelegramPendingInputObserver();

// Одна запрошенная моделью операция: что это и как называется. Аргументы остаются в
// содержимом целиком — в data едет только имя.
function actionSummary(action: unknown): Record<string, unknown> {
  if (!isRecord(action)) return {};
  const out: Record<string, unknown> = {};
  for (const key of ["kind", "callId", "toolName", "name", "subagentName"]) {
    if (isScalar(action[key])) out[key] = action[key];
  }
  return out;
}

// Ключи ответа, по которым читатель видит сбой: они идут первыми, поэтому обрезка строки с
// конца (agent/lib/trace.ts) их не теряет.
const LEAD_KEYS = [
  "ok",
  "error",
  "message",
  "isError",
  "code",
  "exitCode",
] as const;
// Ответ bash (agent/tools/bash.ts) в порядке чтения: код и stderr до длинного stdout.
const BASH_KEYS = [
  "exitCode",
  "timedOut",
  "cancelled",
  "truncated",
  "stderr",
  "stdout",
  "cwd",
] as const;
const BASH_STDERR_CHARS = 1000;

type BashOutput = Record<string, unknown> & { stdout: string; stderr: string };

const isBash = (output: unknown): output is BashOutput =>
  isRecord(output) &&
  typeof output.stdout === "string" &&
  typeof output.stderr === "string";

// Тот же признак ошибки, что у сторожа повторов (agent/lib/repeat-guard.ts `nonempty`).
function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// `exit N` — только с непустым stderr: grep, test и diff с кодом 1 — обычная разведка.
const exitFailure = (output: Record<string, unknown>): string | undefined =>
  Number.isInteger(output.exitCode) &&
  output.exitCode !== 0 &&
  output.cancelled !== true &&
  typeof output.stderr === "string" &&
  output.stderr.trim() !== ""
    ? `exit ${String(output.exitCode)}`
    : undefined;

// Класс сбоя вызова, без текста (docs/trace.md, `failure`). Порядок — правило eve:
// `isError` всегда даёт `failed`, без него `failed` значит «ответ назвал свои code и message».
// Ответ как объект. Строку с JSON-объектом eve (`readActionResultOutputError`) и сторож
// повторов (agent/lib/repeat-guard.ts) тоже читают как объект: признаки сбоя в ней те же.
function answerOf(output: unknown): Record<string, unknown> {
  if (isRecord(output)) return output;
  if (typeof output !== "string" || !output.trimStart().startsWith("{"))
    return {};
  try {
    const parsed: unknown = JSON.parse(output);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function failureOf(
  status: unknown,
  result: Record<string, unknown>,
  output: unknown,
): string | undefined {
  const answer = answerOf(output);
  if (status === "rejected") return undefined; // отказ на подтверждении — ни успех, ни сбой
  if (result.isError === true || answer.isError === true) return "isError";
  if (status === "failed") return "status:failed";
  if (answer.ok === false) return "ok:false";
  if (nonEmpty(answer.error)) return "error";
  if (answer.timedOut === true) return "timeout";
  return exitFailure(answer);
}

// Конец строки, который в JSON занимает не больше `budget` знаков, с пометкой обрезки.
// Мерить надо JSON: `\n` и управляющие знаки там стоят 2–6 знаков, и срез по сырой длине
// выбросил бы почти весь вывод `seq` или оставил бы поле длиннее размера.
// Последний знак перед `end`: пара суррогатов — один знак из двух code units.
function lastChar(value: string, end: number): string {
  const low = value.charCodeAt(end - 1);
  const high = value.charCodeAt(end - 2);
  const pair =
    low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  return value.slice(end - (pair ? 2 : 1), end);
}

function jsonTail(value: string, budget: number): string {
  // Пустой поток оставляем пустым: пометка без среза солгала бы, что что-то срезано.
  if (value === "" || JSON.stringify(value).length - 2 <= budget) return value;
  let size = TRACE_TRUNCATION_MARKER.length;
  let count = 0;
  while (count < value.length) {
    // Пара суррогатов в JSON — два знака, одинокая половина — шесть (`\udXXX`).
    const char = lastChar(value, value.length - count);
    size += JSON.stringify(char).length - 2;
    if (size > budget) break;
    count += char.length;
  }
  // Срез всегда короче строки, иначе capTraceTail вернул бы её целиком, без пометки.
  const keep = Math.min(
    count,
    value.length - TRACE_TRUNCATION_MARKER.length - 1,
  );
  return capTraceTail(value, keep + TRACE_TRUNCATION_MARKER.length);
}

// bash: конец stdout и stderr, где стоит ошибка. Влезает в поле — пишется целиком; нет —
// stderr режется до конца в 1000 знаков, stdout получает всё, что осталось от поля; не
// влезло и так (огромный cwd) — строку дорежет писатель с конца.
function bashResult(output: BashOutput): string {
  const shaped: Record<string, unknown> = {};
  for (const key of BASH_KEYS)
    if (output[key] !== undefined) shaped[key] = output[key];
  const whole = JSON.stringify(shaped);
  if (whole.length <= TRACE_CONTENT_LIMIT) return whole;
  shaped.stderr = jsonTail(output.stderr, BASH_STDERR_CHARS);
  const rest = JSON.stringify({ ...shaped, stdout: "" }).length;
  shaped.stdout = jsonTail(output.stdout, TRACE_CONTENT_LIMIT - rest);
  return JSON.stringify(shaped);
}

function resultText(output: unknown, json: string): string {
  if (typeof output === "string") return output;
  if (isBash(output)) return bashResult(output);
  if (!isRecord(output)) return json;
  const lead = LEAD_KEYS.filter((key) => Object.hasOwn(output, key));
  return JSON.stringify(
    Object.fromEntries([
      ...lead.map((key) => [key, output[key]]),
      ...Object.entries(output),
    ]),
  );
}

function resultFacts(
  status: unknown,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const output = result.output;
  const failure = failureOf(status, result, output);
  return {
    ...(isRecord(output) && typeof output.exitCode === "number"
      ? { exitCode: output.exitCode }
      : {}),
    ...(failure ? { failure } : {}),
  };
}

// Сам ответ — одной строкой JSON в содержимое, его полный размер — в data.
function projectAnswer(
  output: unknown,
  out: Record<string, unknown>,
  content: Record<string, unknown>,
): void {
  const json: string | undefined =
    typeof output === "string" ? output : JSON.stringify(output);
  if (json === undefined) {
    content.result = output;
    return;
  }
  content.result = resultText(output, json);
  out.outChars = json.length;
  // eve кладёт в error.message сам ответ — второй копией он не нужен.
  if (content.error === content.result || content.error === json)
    delete content.error;
}

// Результат тула: имя, признак сбоя и размер ответа — в data (нужны и без содержимого).
// Ответ не сериализуется — прежний путь через обрезку объекта у писателя.
function projectResult(
  data: Record<string, unknown>,
  out: Record<string, unknown>,
  content: Record<string, unknown>,
): void {
  if (!isRecord(data.result)) return;
  const result = data.result;
  // `name` — скилл `load_skill`, `subagentName` — субагент: у их ответов нет `toolName`.
  for (const key of ["toolName", "callId", "isError", "name", "subagentName"])
    if (out[key] === undefined && isScalar(result[key])) out[key] = result[key];
  try {
    Object.assign(out, resultFacts(data.status, result));
    projectAnswer(result.output, out, content);
  } catch {
    content.result = result.output;
  }
}

// Сбой хода: Error id и число запросов к модели — в data, без тумблера содержимого. В чат
// Error id больше не идёт (agent/lib/telegram-failure-notice.ts), найти сбой по нему
// можно здесь и в журнале сервиса.
function projectFailure(details: unknown, out: Record<string, unknown>): void {
  if (!isRecord(details)) return;
  if (typeof details.errorId === "string") out.errorId = details.errorId;
  if (typeof details.attempts === "number") out.attempts = details.attempts;
  if (details.answerStarted === true) out.answerStarted = true;
}

function project(data: Record<string, unknown>): {
  data: Record<string, unknown>;
  content: Record<string, unknown>;
} {
  const out: Record<string, unknown> = {};
  const content: Record<string, unknown> = {};

  for (const key of SCALAR_FIELDS)
    if (isScalar(data[key])) out[key] = data[key];

  if (isRecord(data.usage)) {
    const usage = data.usage;
    out.usage = {
      in: usage.inputTokens ?? 0,
      out: usage.outputTokens ?? 0,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
      ...(typeof usage.costUsd === "number" ? { costUsd: usage.costUsd } : {}),
    };
  }
  if (Array.isArray(data.actions)) {
    // Имена операций — в data, аргументы — в содержимое, ПОЗИЦИЯ В ПОЗИЦИЮ: один ключ не
    // может значить «сводка» при выключенном тумблере и «всё целиком» при включённом.
    out.actions = data.actions.map(actionSummary);
    content.args = data.actions.map((action: unknown) =>
      isRecord(action) ? withoutSecrets(action.input) : action,
    );
  }
  if (Array.isArray(data.parts)) out.parts = data.parts.length;
  // Ошибка тула: код — в data (по нему видно класс отказа), текст — в содержимое.
  if (isRecord(data.error)) {
    if (isScalar(data.error.code)) out.errorCode = data.error.code;
    content.error = data.error.message;
  }
  projectResult(data, out, content);
  projectFailure(data.details, out);
  for (const key of CONTENT_FIELDS) {
    if (data[key] !== undefined && content[key] === undefined)
      content[key] = data[key];
  }
  return { data: out, content };
}

function record(
  event: StreamEvent,
  ctx: HookContext,
  subagent?: { name: string; callId: unknown },
): void {
  if (DELTA_EVENTS.has(event.type)) return;
  const data = isRecord(event.data) ? event.data : {};
  const projected = project(data);
  appendTrace({
    kind: "eve",
    name: event.type,
    turn: subagent
      ? subagentTurnId(ctx.session.turn, subagent.name, text(data.turnId))
      : text(data.turnId) || parentTurnId(ctx.session.turn),
    session: ctx.session.id,
    source: ctx.channel?.kind ?? "unknown",
    data: subagent
      ? {
          ...projected.data,
          subagent: subagent.name,
          parentCallId: subagent.callId,
        }
      : projected.data,
    content: projected.content,
  });
}

export default defineHook({
  events: {
    // `*` ловит каждое принятое событие рантайма — отдельная подписка на конкретный тип
    // здесь запрещена: она пришла бы вместе с подстановочной и удвоила строку.
    "*": (event, ctx) => {
      try {
        observeTelegramPendingInput(event, ctx);
      } catch (error) {
        console.error("[telegram] pending input state was not updated:", error);
      }
      try {
        observeTelegramReplay(event, ctx);
      } catch (error) {
        console.error("[telegram] replay retirement was not marked:", error);
      }
      // Один try на весь обработчик: журнал не имеет права уронить ход НИ НА ЧЁМ —
      // ни на чужом геттере в payload, ни на обрезанном subagent.event, ни на
      // контексте без канала. Писатель внутри тоже глотает свои ошибки, но событие
      // ещё надо собрать, а собирается оно из чужих данных.
      try {
        if (event.type === "subagent.event") {
          record(event.data.event, ctx, {
            name: event.data.subagentName,
            callId: event.data.callId,
          });
          return;
        }
        record(event, ctx);
      } catch (error) {
        console.error("[trace] событие eve не записано:", error);
      }
    },
  },
});
