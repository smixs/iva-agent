import { serviceManager } from "../lib/service-manager.ts";
import { logHint, logTail } from "../lib/systemd-control.ts";
// `iva diagnose` — one package of evidence for a bug report: a GitHub issue or the
// support chat (agent/skills/report-problem). A thin collector: it takes what the machine
// already knows and cuts secrets BEFORE the file is written. What broke is the model's
// question, not this command's. `--turn <session>/<turn>` adds the skeleton of that one turn
// right after the versions and prints a ready `issue-url:` built from the package after cutting.
//
// Only `scripts/` is imported statically: the CLI has to start on an installation whose
// `agent/` is missing (ADR-0003, scripts/authored-tree-guard.test.ts). The turn journal is
// therefore read where it lies — `data/trace/*.jsonl`, the contract of docs/trace.md — and
// the reminders table as `data/reminders.json`; its rows are parsed by the store's own
// reader, imported at run time, so a missing authored tree costs only that section.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { Reminder } from "../../agent/lib/reminder-store.ts";
import {
  cutText,
  diagnoseFailureLines,
  failureCause,
  failureReason,
  listTurnFailures,
  readTrace,
} from "../lib/turn-failures.ts";
import { parseTurnRef } from "../lib/turn-ref.ts";
import {
  redact,
  secretValuesFromEnv,
} from "../../packages/secret-redaction/index.ts";
import {
  authoredTreeMissing,
  createDoctorCommand,
  errorCode,
  reminderIdHash,
  scheduleFactsReport,
} from "./doctor.ts";
import type { createCliRuntime } from "./runtime.ts";
import type { createCliSystemd } from "./systemd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SystemdLifecycle = ReturnType<typeof createCliSystemd>;

type DiagnoseDependencies = {
  readonly now?: () => Date;
};

// Правило вырезания секретов — одно на установку и лежит в пакете, который видят и
// `scripts/`, и authored tree (packages/secret-redaction/index.ts): пакет улик и хвост
// журнала расписания режут одинаково. Реэкспорт держит прежний вход тестов-якорей
// scripts/cli/diagnose-redact.test.ts.
export {
  REDACTED,
  redact,
  secretValuesFromEnv,
} from "../../packages/secret-redaction/index.ts";
const JOURNAL_LINES = 200;
/** Потолок списка на раздел: пакет должен читаться, а не весить мегабайт. */
const SECTION_ITEM_LIMIT = 100;

/** Размер раздела `## Turn`: скелет одного хода, а не его текст. */
const TURN_SECTION_CHARS = 3000;
/** Адрес issue целиком, после процентного кодирования: столько прошло кнопкой Telegram на c1. */
export const ISSUE_URL_BYTES = 5500;
const ISSUE_NEW = "https://github.com/smixs/iva-agent/issues/new";
const ERROR_CHARS = 300;
const VALUE_CHARS = 60;
const FRAME_CHARS = 200;
const FRAMES = 5;
/** Ключи `data`, которые попадают в раздел хода: классы, коды, числа — без текста. */
const TURN_KEYS = [
  "toolName",
  "status",
  "failure",
  "exitCode",
  "errorCode",
  "code",
  "finishReason",
  "stepIndex",
  "outChars",
  "resultChars",
  "ms",
] as const;
const USAGE = "usage: iva diagnose [--turn <session>/<turn>]";
const DAY_MS = 24 * 60 * 60 * 1000;
const NO_COLOR = { g: "", y: "", r: "", c: "", b: "", d: "", x: "" };

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function tailLines(text: string, limit: number): string {
  const lines = text.split("\n");
  return lines.length <= limit ? text : lines.slice(-limit).join("\n");
}

/** Сколько элементов списка попало в пакет и сколько осталось за потолком. */
function capped(items: readonly string[]): { shown: string[]; rest: number } {
  return {
    shown: items.slice(0, SECTION_ITEM_LIMIT),
    rest: Math.max(0, items.length - SECTION_ITEM_LIMIT),
  };
}

function listOrNone(items: readonly string[]): string {
  if (items.length === 0) return "- (none)";
  const { shown, rest } = capped(items);
  const lines = shown.map((item) => `- ${item}`);
  if (rest > 0)
    lines.push(`- … ${rest} more (list cut at ${SECTION_ITEM_LIMIT})`);
  return lines.join("\n");
}

function versionsSection(root: string, gitHead: string): string {
  const manifest = readJsonObject(join(root, "package.json"));
  const iva =
    typeof manifest?.version === "string"
      ? manifest.version
      : "unknown (package.json unreadable)";
  const dependencies = manifest?.dependencies;
  const eve =
    typeof dependencies === "object" &&
    dependencies !== null &&
    typeof (dependencies as Record<string, unknown>).eve === "string"
      ? String((dependencies as Record<string, unknown>).eve)
      : "unknown (eve is not in package.json)";
  const commit = gitHead.length > 0 ? ` (git ${gitHead})` : "";
  return `- iva: ${iva}${commit}\n- eve: ${eve}`;
}

function hostSection(): string {
  return [
    `- os: ${os.platform()} ${os.release()} ${os.arch()} (${os.type()})`,
    `- node: ${process.version}`,
  ].join("\n");
}

/**
 * Факты строк напоминаний. Разбор тела отдан стору (`parseReminderTable`): схема строки —
 * его собственность, второй копии полей здесь нет; разбор подгружается на исполнении, потому
 * что CLI грузится и без authored tree (ADR-0003). В пакет едут хеш id и код ошибки, не текст:
 * текст ошибки несёт тело ответа Telegram, а его слова — владельца.
 */
async function remindersSection(
  dataDir: string,
  nowMs: number,
): Promise<string> {
  const file = join(dataDir, "reminders.json");
  if (!existsSync(file)) return "- no reminders.json on this install";
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return "- reminders.json is not valid JSON";
  }
  let parseReminderTable: (
    file: string,
    raw: unknown,
    nowMs: number,
  ) => Reminder[];
  try {
    parseReminderTable = (await import("../../agent/lib/reminder-store.ts"))
      .parseReminderTable;
  } catch {
    return "- reminders.json present, but the authored tree that reads it is missing";
  }
  let rows: Reminder[];
  try {
    rows = parseReminderTable(file, raw, nowMs);
  } catch (error) {
    // Причина отказа несёт JSON строки: в пакет идёт только класс ошибки.
    const name = error instanceof Error ? error.constructor.name : "unknown";
    return `- reminders.json unreadable (${name})`;
  }
  const facts: string[] = [];
  for (const row of rows) {
    const last = row.firedAt;
    const due = row.nextRunAtMs;
    // Факт за сутки — то, что сработало за последние сутки, и то, что висит просроченным
    // прямо сейчас: молчащий диспетчер виден именно по второму.
    const recent = last !== null && nowMs - last <= DAY_MS;
    const overdue = due <= nowMs;
    if (!recent && !overdue) continue;
    const status =
      row.delivered === true ? "yes" : row.delivered === false ? "no" : "never";
    const error =
      row.error !== null && row.error.length > 0
        ? errorCode(row.error)
        : "none";
    facts.push(
      `${reminderIdHash(row.id)} · due ${new Date(due).toISOString()} · ` +
        `last ${last === null ? "-" : new Date(last).toISOString()} · delivered ${status} · ` +
        `error ${error}`,
    );
  }
  const { shown, rest } = capped(facts);
  const lines = shown.map((fact) => `- ${fact}`);
  if (rest > 0)
    lines.push(`- … ${rest} more (list cut at ${SECTION_ITEM_LIMIT})`);
  return lines.length > 0
    ? lines.join("\n")
    : "- no reminder facts in the last day";
}

/**
 * Таблица фактов расписаний (T20 §5): последний запуск каждого имени и незакрытые провалы
 * (до починки, ADR-0020). Разбор не дублируем: отчёт собирает doctor.scheduleFactsReport теми же
 * authored-функциями, что и раздел доктора; хвост уже вырезан при записи, а пакет
 * целиком проходит общее вырезание секретов ниже.
 */
async function schedulesSection(dataDir: string): Promise<string> {
  let report;
  try {
    report = await scheduleFactsReport(dataDir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return authoredTreeMissing(error)
      ? "- schedule facts unavailable: the authored tree is missing"
      : `- job facts unreadable: ${reason}`;
  }
  const lines = report.lastRuns.map((line) => `- ${line}`);
  for (const failure of report.openFailures) {
    lines.push(
      `- незакрытый провал: ${failure.name} (${failure.reason}) — закрыть: iva jobs ack ${failure.name}`,
    );
    const row = report.facts.find(
      (fact) => fact.name === failure.name && fact.finishedAt === failure.at,
    );
    if (row?.tail)
      lines.push(...row.tail.split("\n").map((line) => `  ${line}`));
  }
  return lines.length > 0
    ? lines.join("\n")
    : "- no schedule runs in the facts table";
}

/**
 * Сбои суток тем же читателем, что у Insight: класс и ход без текста причины — это ходы,
 * которых владелец не выбирал (scripts/lib/turn-failures.ts).
 */
function failuresSection(dataDir: string, nowMs: number): string {
  let found;
  try {
    found = listTurnFailures(dataDir, nowMs);
  } catch (error) {
    return `- the turn journal is unreadable (${(error as NodeJS.ErrnoException).code ?? "error"})`;
  }
  const { shown, rest } = capped(diagnoseFailureLines(found.causes));
  if (rest > 0)
    shown.push(`- … ${rest} more (list cut at ${SECTION_ITEM_LIMIT})`);
  if (found.unreadable > 0)
    shown.push(`- ${found.unreadable} unreadable journal lines skipped`);
  return shown.length > 0 ? shown.join("\n") : "- no failures in the last day";
}

type Clean = (text: string) => string;
type TurnEvent = {
  readonly lines: readonly string[];
  readonly failed: boolean;
};
type TraceLine = Record<string, unknown>;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const fact = (key: string, value: unknown): string[] =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"
    ? [`${key}=${cutText(String(value).replace(/\s+/gu, " "), VALUE_CHARS)}`]
    : [];

/** Пары `ключ=значение` только из `TURN_KEYS`: ни `args`, ни `result`, ни `message`, ни `chatId`. */
function factsOf(data: Record<string, unknown>): string[] {
  const usage = record(data.usage);
  const tools = Array.isArray(data.actions)
    ? data.actions.flatMap((action) => fact("tool", record(action).toolName))
    : [];
  return [
    ...TURN_KEYS.flatMap((key) => fact(key, data[key])),
    ...fact("usage.in", usage.in),
    ...fact("usage.out", usage.out),
    ...tools,
  ];
}

const isFailed = (line: TraceLine): boolean =>
  (typeof record(line.data).failure === "string" &&
    record(line.data).failure !== "") ||
  (line.kind === "eve" &&
    (line.name === "turn.failed" || line.name === "step.failed"));

/** Кадры стека из `details`: строки `at …`, не больше пяти; тело ошибки провайдера не берётся. */
function stackFrames(details: unknown): string[] {
  const stack = typeof details === "string" ? details : record(details).stack;
  return (typeof stack === "string" ? stack : "")
    .split("\n")
    .filter((line) => /^\s+at /u.test(line))
    .slice(0, FRAMES);
}

/** Событие хода: время, имя, ключи `TURN_KEYS`; у упавшего — строка ошибки и кадры стека. */
function turnEvent(line: TraceLine, clean: Clean): TurnEvent {
  const ts = typeof line.ts === "string" ? line.ts.slice(11, 23) : "";
  const head = [`${ts} ${String(line.kind)}.${String(line.name)}`];
  const lines = [[...head, ...factsOf(record(line.data))].join(" ")];
  const failed = isFailed(line);
  if (!failed) return { lines, failed };
  // Секрет вырезается до обрезки: срез посреди значения `redact()` уже не узнал бы.
  const reason = cutText(clean(failureReason(line)), ERROR_CHARS);
  if (reason !== "") lines.push(`  error: ${reason}`);
  for (const frame of stackFrames(record(line.data).details))
    lines.push(`  ${cutText(clean(frame.trim()), FRAME_CHARS)}`);
  return { lines, failed };
}

/** Выбранные события подряд; пропуски — строкой `… N events`. */
function renderKept(
  events: readonly TurnEvent[],
  keep: readonly number[],
): string {
  const out: string[] = [];
  let previous = -1;
  for (const index of [...keep, events.length]) {
    if (index - previous > 1) out.push(`… ${index - previous - 1} events`);
    out.push(...(events[index]?.lines ?? []));
    previous = index;
  }
  return out.join("\n");
}

/** Убрать из середины одно событие: сперва то, что не упало. */
function dropMiddle(
  keep: readonly number[],
  events: readonly TurnEvent[],
): number[] {
  const inner = keep.slice(1, -1);
  const quiet = inner.filter((index) => events[index]?.failed !== true);
  const pool = quiet.length > 0 ? quiet : inner;
  const middle = keep[Math.floor(keep.length / 2)] ?? 0;
  const drop = pool.reduce((best, index) =>
    Math.abs(index - middle) < Math.abs(best - middle) ? index : best,
  );
  return keep.filter((index) => index !== drop);
}

/**
 * Раздел не длиннее `budget`: не влез — первое и последнее событие, упавшие и по три перед
 * каждым; всё ещё длинно — события уходят из середины, сперва не упавшие.
 */
function fitTurn(events: readonly TurnEvent[], budget: number): string {
  const all = events.map((_, index) => index);
  const full = renderKept(events, all);
  if (full.length <= budget) return full;
  let keep = all.filter(
    (index) =>
      index === 0 ||
      index === events.length - 1 ||
      events.slice(index, index + 4).some((event) => event.failed),
  );
  let text = renderKept(events, keep);
  while (text.length > budget && keep.length > 2) {
    keep = dropMiddle(keep, events);
    text = renderKept(events, keep);
  }
  return cutText(text, budget);
}

/** Строки одного хода: сессия совпала, `turn` — сам ход или его субагент; по времени. */
function turnLines(
  dataDir: string,
  ref: { readonly session: string; readonly turn: string },
): TraceLine[] {
  let lines: TraceLine[];
  try {
    lines = readTrace(dataDir).lines;
  } catch {
    return [];
  }
  return lines
    .filter(
      (line) =>
        line.session === ref.session &&
        (line.turn === ref.turn ||
          String(line.turn).startsWith(`${ref.turn}#`)),
    )
    .sort((a, b) =>
      String(a.ts) < String(b.ts) ? -1 : String(a.ts) > String(b.ts) ? 1 : 0,
    );
}

/** `os.homedir()` → `~`, только целым сегментом пути: имя пользователя не уходит в issue. */
function homeToTilde(): Clean {
  const home = os.homedir().replace(/\/+$/u, "");
  if (home.length < 2) return (text) => text;
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`${escaped}(?![\\w.-])`, "gu");
  return (text) => text.replace(pattern, "~");
}

/** Одинокая половина суррогатной пары — U+FFFD: иначе encodeURIComponent бросает. */
const wellFormed = (text: string): string =>
  text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,
    "\uFFFD",
  );

const issueUrl = (title: string, body: string): string =>
  `${ISSUE_NEW}?title=${encodeURIComponent(wellFormed(title))}&body=${encodeURIComponent(wellFormed(body))}`;

/** Тело issue: пакет до `## Host` (шапка, версии, ход) и строка о полном пакете. */
function issueBody(text: string, fullLine: string): string {
  const host = text.indexOf("\n## Host\n");
  const head = (host === -1 ? text : text.slice(0, host)).trimEnd();
  return `${head}\n\n${fullLine}`;
}

/** Заголовок issue по первому сбою хода; сбоя нет — по самому ходу. */
function issueTitle(lines: readonly TraceLine[], ref: string, version: string) {
  const first = lines.find(isFailed);
  const cause = first === undefined ? null : failureCause(first);
  return cause === null
    ? `[iva] turn ${ref} (${version})`
    : `[iva] ${cause.where}: ${cause.kind} (${version})`;
}

/**
 * Пакет и адрес issue: раздел хода ужимается той же процедурой, пока адрес после кодирования
 * не уложится в ISSUE_URL_BYTES; тогда тело issue — префикс записанного пакета.
 */
function fitIssue(
  build: (budget: number) => string,
  title: string,
  fullLine: string,
): { readonly text: string; readonly url: string } {
  let budget = TURN_SECTION_CHARS;
  let text = build(budget);
  let url = issueUrl(title, issueBody(text, fullLine));
  while (url.length > ISSUE_URL_BYTES && budget > 0) {
    budget = Math.floor(budget * Math.min(0.9, ISSUE_URL_BYTES / url.length));
    text = build(budget);
    url = issueUrl(title, issueBody(text, fullLine));
  }
  let head = issueBody(text, fullLine).slice(0, -fullLine.length - 2);
  while (url.length > ISSUE_URL_BYTES && head.length > 0) {
    head = cutText(head, Math.floor(head.length * 0.9));
    url = issueUrl(title, `${head}\n\n${fullLine}`);
  }
  // Тело уже пусто, а адрес длинный — значит, длинный заголовок (селектор не из журнала).
  let short = title;
  while (url.length > ISSUE_URL_BYTES && short.length > 0) {
    short = cutText(short, Math.floor(short.length * 0.9));
    url = issueUrl(short, `${head}\n\n${fullLine}`);
  }
  return { text, url };
}

/** Имена файлов своего слоя, без содержимого: что владелец правил — видно, что там — нет. */
function customLayerSection(dataDir: string): string {
  const root = join(dataDir, "custom", "agent");
  const names: string[] = [];
  const visit = (relative: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path =
        relative.length > 0 ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) names.push(path);
    }
  };
  visit("");
  names.sort();
  return listOrNone(names);
}

/** Новейший файл журнала из data/logs: у self-host это единственный лог, который есть. */
function newestLogFile(
  dataDir: string,
  prefix = "",
): { name: string; text: string } | null {
  const directory = join(dataDir, "logs");
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => name.endsWith(".log") && name.startsWith(prefix))
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      return {
        name,
        text: tailLines(
          readFileSync(join(directory, name), "utf8"),
          JOURNAL_LINES,
        ),
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** Хвост последнего лога обновлятора: без него «не удалось собрать» в чате не разобрать. */
function updateLogSection(dataDir: string): string {
  const latest = newestLogFile(dataDir, "update-");
  return latest
    ? `data/logs/${latest.name}\n\n${latest.text}`
    : "- no data/logs/update-*.log — no update has run on this install yet";
}

/**
 * Последние строки журнала сервиса: journalctl по службам Ивы; нет journalctl — говорим
 * об этом честно и отдаём новейший файл журнала, если он есть.
 */
function journalSection(
  cap: CliRuntime["cap"],
  dataDir: string,
  units: readonly string[],
): string {
  if (serviceManager() === "launchd")
    return (
      units
        .map((unit) => logTail(unit, JOURNAL_LINES))
        .filter(Boolean)
        .join("\n") || "логов пока нет"
    );
  const args = [
    "--user",
    ...units.flatMap((unit) => ["-u", unit]),
    "-n",
    String(JOURNAL_LINES),
    "--no-pager",
  ];
  const result = cap("journalctl", args);
  if (result.code === 0 && result.out.trim().length > 0) return result.out;
  const fallback = newestLogFile(dataDir);
  if (fallback) {
    return (
      `journalctl did not return the unit journal (${result.err || "no output"}); ` +
      `newest log file data/logs/${fallback.name}\n\n${fallback.text}`
    );
  }
  return (
    `journalctl unavailable (${result.err || "no journalctl on this host"}) — ` +
    `read the service journal where the service logs: ${logHint("iva.service", { lines: 200 })}, ` +
    "or the terminal that started it"
  );
}

/**
 * Строка о том, ЧЕМ вырезано. Без неё пакет с пустым списком секретов выглядел бы так же,
 * как пакет с полным (слепая приёмка T21): владелец и модель обязаны видеть, что `.env`
 * не нашли и работают только шаблонные правила.
 */
function redactionLine(
  envFound: boolean,
  secretCount: number,
  pluginCount = 0,
): string {
  if (!envFound)
    return (
      "- redaction: .env not found — only the pattern rules were applied " +
      "(bot token, keys of known formats, telegram ids, e-mail); values of keys are NOT in the cut list"
    );
  const plugins =
    pluginCount > 0 ? ` and ${pluginCount} from plugin .env files` : "";
  return `- redaction: ${secretCount} values from .env${plugins}, pattern rules always on`;
}

/**
 * Значения ключей плагинов (`data/custom/plugins/<name>.env`, docs/plugins.md): их сервер
 * или скрипт может упасть с ключом в строке ошибки, а та идёт в раздел хода и в issue.
 * Тот же разбор, что у `--env-file` и у самого плагина (`parseEnv`); нечитаемое — мимо.
 */
function pluginSecrets(dataDir: string): string[] {
  const directory = join(dataDir, "custom", "plugins");
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".env"));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const values = parseEnv(readFileSync(join(directory, name), "utf8"));
      return secretValuesFromEnv(
        Object.fromEntries(
          Object.entries(values).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      );
    } catch {
      return [];
    }
  });
}

function packageMarkdown(input: {
  readonly root: string;
  readonly dataDir: string;
  readonly gitHead: string;
  readonly now: Date;
  readonly doctor: string;
  readonly journal: string;
  readonly updateLog: string;
  readonly redaction: string;
  readonly schedules: string;
  readonly reminders: string;
  /** `--turn`: раздел сразу после версий — так он попадает в адрес issue. */
  readonly turn: { readonly ref: string; readonly section: string } | null;
}): string {
  return [
    "# Iva diagnose package",
    "",
    `- collected: ${input.now.toISOString()}`,
    `- data dir: ${input.dataDir}`,
    input.redaction,
    "",
    "## Versions",
    versionsSection(input.root, input.gitHead),
    "",
    ...(input.turn === null
      ? []
      : [`## Turn ${input.turn.ref}`, input.turn.section, ""]),
    "## Host",
    hostSection(),
    "",
    "## iva doctor",
    "```",
    input.doctor.trimEnd(),
    "```",
    "",
    `## Last update log (data/logs/update-*.log, last ${JOURNAL_LINES} lines)`,
    "",
    input.updateLog.trimEnd(),
    "",
    `## Service journal (last ${JOURNAL_LINES} lines)`,
    "```",
    input.journal.trimEnd(),
    "```",
    "",
    "## Reminders (last 24h and overdue; id = sha256/8)",
    input.reminders,
    "",
    "## Failures (last 24h)",
    failuresSection(input.dataDir, input.now.getTime()),
    "",
    "## Schedules (facts table, last run per name; open failures of the last day)",
    input.schedules,
    "",
    "## Custom layer (file names only)",
    customLayerSection(input.dataDir),
    "",
  ].join("\n");
}

/**
 * Доктор — половина улик, поэтому зовётся настоящий: его строки уходят в пакет, а не в
 * терминал (сборщик без цвета и с выходом, который не завершает этот процесс). Пакет
 * собирают и из хода (скилл report-problem): доктор тут только читает.
 */
async function readOnlyDoctor(
  runtime: CliRuntime,
  systemdLifecycle: SystemdLifecycle,
): Promise<string> {
  const doctorLines: string[] = ["read-only: nothing was repaired"];
  const doctorRuntime: CliRuntime = {
    ...runtime,
    C: NO_COLOR,
    ok: (message: string) => void doctorLines.push(`✓ ${message}`),
    warn: (message: string) => void doctorLines.push(`! ${message}`),
    bad: (message: string) => void doctorLines.push(`✗ ${message}`),
  };
  await createDoctorCommand(doctorRuntime, systemdLifecycle, {
    log: (...args: unknown[]) => {
      doctorLines.push(args.map((arg) => String(arg)).join(" "));
    },
    exit: () => undefined,
    readOnly: true,
  })();
  return doctorLines.join("\n");
}

/** `--turn <session>/<turn>`: нет флага — null; нет значения или не пара — ошибка до сборки. */
function turnArgument(argv: readonly string[]) {
  const at = argv.indexOf("--turn");
  if (at === -1) return null;
  const name = argv[at + 1] ?? "";
  const ref = parseTurnRef(name);
  if (ref === null) throw new Error(USAGE);
  return { ...ref, name };
}

/** Пакет целиком; с `--turn` — ещё раздел хода и адрес issue, ужатые вместе. */
function finishPackage(
  sections: Omit<Parameters<typeof packageMarkdown>[0], "turn">,
  ref: ReturnType<typeof turnArgument>,
  clean: Clean,
  name: string,
): { readonly text: string; readonly url: string | null } {
  if (ref === null)
    return {
      text: clean(packageMarkdown({ ...sections, turn: null })),
      url: null,
    };
  const lines = turnLines(sections.dataDir, ref);
  const events = lines.map((line) => turnEvent(line, clean));
  const section = (budget: number) =>
    events.length > 0
      ? fitTurn(events, budget)
      : `- no turn ${ref.name} in the journal`;
  return fitIssue(
    (budget) =>
      clean(
        packageMarkdown({
          ...sections,
          turn: { ref: ref.name, section: section(budget) },
        }),
      ),
    clean(issueTitle(lines, ref.name, packageVersion(sections.root))),
    `Full package: data/diagnose/${name} on the owner's machine`,
  );
}

function packageVersion(root: string): string {
  const version = readJsonObject(join(root, "package.json"))?.version;
  return typeof version === "string" ? version : "unknown";
}

/**
 * `iva diagnose`: собрать пакет, вырезать секреты, записать в data/diagnose/<дата-время>.md
 * и напечатать путь. Доктор зовётся НАСТОЯЩИЙ — он и есть половина улик, — но со сборщиком
 * без цвета и с выходом, который не завершает этот процесс.
 */
export function createDiagnoseCommand(
  runtime: CliRuntime,
  systemdLifecycle: SystemdLifecycle,
  dependencies: DiagnoseDependencies = {},
) {
  const {
    ROOT,
    ENV_PATH,
    ok,
    warn,
    readEnv,
    dataDirAbs,
    cap,
    gitHead,
    SERVICES,
    BRAIN_SERVICE,
    SVC_USERBOT,
  } = runtime;
  const now = dependencies.now ?? (() => new Date());
  const units = [...SERVICES, BRAIN_SERVICE, SVC_USERBOT];

  return async function cmdDiagnose(
    argv: readonly string[] = [],
  ): Promise<void> {
    const ref = turnArgument(argv);
    const env = readEnv();
    const envFound = existsSync(ENV_PATH);
    if (!envFound)
      warn(
        "No .env — redaction applies only the pattern rules (bot token, keys of known formats, telegram ids, e-mail); the package says so in its header",
      );
    const dataDirectory = dataDirAbs(env);
    const collectedAt = now();
    const doctor = await readOnlyDoctor(runtime, systemdLifecycle);
    // Список секретов читается и после прогона (T21): доктор только читает, но .env мог
    // поменять кто-то другой, пока пакет собирался.
    const own = new Set([
      ...secretValuesFromEnv(env),
      ...secretValuesFromEnv(readEnv()),
    ]);
    const plugins = [...new Set(pluginSecrets(dataDirectory))].filter(
      (value) => !own.has(value),
    );
    const secrets = [...own, ...plugins];
    const tilde = homeToTilde();
    const clean = (text: string) => redact(tilde(text), secrets);
    const name = `${collectedAt.toISOString().replace(/[:.]/gu, "-")}.md`;
    const sections = {
      root: ROOT,
      dataDir: dataDirectory,
      gitHead: gitHead(),
      now: collectedAt,
      doctor,
      journal: journalSection(cap, dataDirectory, units),
      updateLog: updateLogSection(dataDirectory),
      redaction: redactionLine(envFound, own.size, plugins.length),
      schedules: await schedulesSection(dataDirectory),
      reminders: await remindersSection(dataDirectory, collectedAt.getTime()),
    };
    const { text, url } = finishPackage(sections, ref, clean, name);
    const file = join(dataDirectory, "diagnose", name);
    mkdirSync(join(dataDirectory, "diagnose"), { recursive: true });
    writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
    ok(`Diagnose package: ${file}`);
    if (url === null) return;
    writeFileSync(file.replace(/\.md$/u, ".issue-url"), url, {
      encoding: "utf8",
      mode: 0o600,
    });
    ok(`issue-url: ${url}`);
  };
}
