import { serviceManager } from "../service-manager.ts";
import { describeLaunchd } from "../launchd.ts";
// Экран кронов: read-only. systemctl --user list-timers (фильтр iva-* + xfeed-daily):
// «имя → следующий запуск», плюс счётчик задач из data/tasks.json, плюс блок расписаний
// внутри самой Ивы (agent/schedules/*.ts — Nitro scheduled tasks, не systemd) из
// data/rollup-status.json (scripts/lib/schedule-runner.ts). Пагинация systemd-списка по 8;
// блок расписаний Ивы всегда ровно 5 строк — не пагинируется. Ниже — блок напоминаний:
// ближайшие строки таблицы напоминаний и свежесть минутного тика диспетчера.
//
// execFile ограничен таймаутом 1.5с и кэшируется на 60с — единственный getUpdates-цикл
// моста нельзя блокировать дольше (список таймеров редко висит, одной ограниченной пробы
// достаточно, async-перерисовка тут не нужна).
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { readEnvValues } from "../env-file.ts";
// Names double as status-file keys — the `name` each schedule passes to runScheduledJob
// (see scripts/lib/schedule-runner.ts), not the bare period. Display order is table order.
import { pendingMemoryNightTime } from "#lib/memory-night-time.ts";
import {
  SCHEDULE_CRON,
  ACTIVE_MEMORY_NIGHT_TIME,
} from "#lib/schedule-table.ts";
import { REMINDER_TICK_STALE_MS, readTickPulse } from "#lib/reminder-tick.ts";
import { list } from "#lib/reminder-store.ts";
import { resolveTimeZone } from "../../../packages/timezone/index.ts";
import { formatZoned } from "#lib/zoned-time.ts";
import { button, buttonRow, escapeRichText } from "../telegram-buttons.ts";

const PER_PAGE = 8;
const CACHE_TTL_MS = 60_000;
const PARENT = "r";
type Timer = { unit: string; next: string };
type Translate = (english: string, russian: string) => string;
type RollupEntry = { lastSuccessAt?: unknown };
type MenuState = { page: number };
type MenuContext = {
  deps: { dataDir: string; envPath?: string };
  tr: Translate;
};
let cache: { at: number; timers: Timer[] | null } = { at: 0, timers: null };

function loadRollupStatus(dataDir: string): Record<string, RollupEntry> {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(dataDir, "rollup-status.json"), "utf8"),
    );
    return typeof raw === "object" && raw !== null
      ? (raw as Record<string, RollupEntry>)
      : {};
  } catch {
    return {};
  }
}

function formatLastSuccess(entry: RollupEntry | undefined, T: Translate) {
  const at = entry?.lastSuccessAt;
  // typeof === "number" alone lets Infinity/-Infinity and other out-of-range values
  // through; new Date(at).toISOString() throws a RangeError on those and would take
  // the whole menu render down with it. Number.isFinite() plus a getTime() NaN check
  // (an out-of-range-but-finite value, e.g. beyond ±8.64e15) both fall back to "never".
  if (typeof at !== "number" || !Number.isFinite(at))
    return T("never", "никогда");
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return T("never", "никогда");
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "Z");
}

async function schedulesBlock(dataDir: string, T: Translate, envPath?: string) {
  const status = loadRollupStatus(dataDir);
  let nightNotice: string | null = null;
  try {
    const requested = envPath
      ? (await readEnvValues(envPath)).MEMORY_NIGHT_TIME
      : process.env.MEMORY_NIGHT_TIME;
    const pending = pendingMemoryNightTime(requested, ACTIVE_MEMORY_NIGHT_TIME);
    if (pending)
      nightNotice = T(
        `Night time ${pending} is pending. Apply with iva update --force, or npm run build and iva restart in a development checkout.`,
        `Время ночи ${pending} ждёт сборки. Примените iva update --force; в чекауте разработчика — npm run build и iva restart.`,
      );
  } catch {
    nightNotice = T(
      "MEMORY_NIGHT_TIME is invalid; use HH:mm. The compiled schedule stays active.",
      "MEMORY_NIGHT_TIME невалидно: нужен HH:mm. Действует время текущей сборки.",
    );
  }
  const lines = Object.entries(SCHEDULE_CRON).map(([name, cron]) => {
    const last = formatLastSuccess(status[name], T);
    return `| ${escapeRichText(name)} | ${escapeRichText(cron)} | ${last} |`;
  });
  return [
    `## ${T("📅 Schedules (inside Iva)", "📅 Расписания (внутри Ивы)")}`,
    [
      `| ${T("Name", "Имя")} | Cron | ${T("Last run", "Последний запуск")} |`,
      "| --- | --- | --- |",
      ...lines,
    ].join("\n"),
    ...(nightNotice ? [nightNotice] : []),
  ].join("\n\n");
}

function shortText(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

// Ближайшие напоминания и свежесть минутного тика (пульс — mtime data/reminders.tick).
// Ошибки чтения не подменяются пустотой: экран говорит, что именно не читается, а причина
// уезжает в журнал — runtime-текст ошибки в чат не несём, экраны идут мимо Outbox
// (agent/lib/outbox.ts).
async function remindersBlock(T: Translate): Promise<string> {
  const head = `## ${T("⏰ Reminders", "⏰ Напоминания")}`;
  const tz = resolveTimeZone(process.env.ASSISTANT_TIMEZONE);
  const stamp = (at: number) => formatZoned(at, tz);
  const pulse = readTickPulse();
  const tick =
    pulse === null
      ? T("dispatcher: no tick yet", "диспетчер: тиков ещё не было")
      : Date.now() - pulse <= REMINDER_TICK_STALE_MS
        ? T(
            `dispatcher: last tick ${stamp(pulse).slice(11)}`,
            `диспетчер: последний тик ${stamp(pulse).slice(11)}`,
          )
        : `⚠️ ${T(
            `dispatcher: no tick since ${stamp(pulse)}`,
            `диспетчер: тиков нет с ${stamp(pulse)}`,
          )}`;

  const parts: string[] = [head, tick];
  let upcoming: Awaited<ReturnType<typeof list>>;
  try {
    upcoming = await list();
  } catch (error) {
    console.error("menu: reminder table unreadable:", error);
    parts.push(
      `⚠️ ${T(
        "reminder table unreadable, see the journal",
        "таблица напоминаний не читается, см. журнал",
      )}`,
    );
    return parts.join("\n\n");
  }
  if (upcoming.length === 0) {
    parts.push(T("none", "нет"));
    return parts.join("\n\n");
  }
  const body = upcoming.slice(0, 5).map((row) => {
    const repeats =
      row.schedule.kind === "cron" ? T("(repeats) ", "(повтор) ") : "";
    const problem = row.error !== null ? "⚠️ " : "";
    const when = escapeRichText(stamp(row.nextRunAtMs));
    const what = escapeRichText(`${repeats}${problem}${shortText(row.text)}`);
    return `| ${when} | ${what} |`;
  });
  parts.push(
    [
      `| ${T("When", "Когда")} | ${T("Reminder", "Напоминание")} |`,
      "| --- | --- |",
      ...body,
    ].join("\n"),
  );
  if (upcoming.length > 5)
    parts.push(T(`${upcoming.length} total`, `всего: ${upcoming.length}`));
  return parts.join("\n\n");
}

function run(cmd: string, args: string[], timeout = 1500): Promise<string> {
  return new Promise((resolve: (stdout: string) => void) => {
    execFile(cmd, args, { timeout, encoding: "utf8" }, (err, stdout = "") =>
      resolve(String(stdout)),
    );
  });
}

// Толерантный парс: колонки list-timers переменной ширины (NEXT/LEFT содержат пробелы),
// поэтому берём только надёжное — имя таймера (*.timer) и ведущую абсолютную дату NEXT.
function parseTimers(stdout: string): Timer[] {
  const out: Timer[] = [];
  for (const line of stdout.split("\n")) {
    if (!/\.timer\b/.test(line)) continue; // пропускаем шапку/подвал/пустые
    const unit = (line.match(/(\S+\.timer)/) || [])[1];
    if (!unit) continue;
    if (!/^iva-/.test(unit) && !/^xfeed-daily/.test(unit)) continue;
    const dm = line.match(
      /^(\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: \S+)?)/,
    );
    out.push({ unit, next: dm ? dm[1] : "—" });
  }
  out.sort((a, b) => a.unit.localeCompare(b.unit));
  return out;
}

async function loadTimers() {
  if (cache.timers && Date.now() - cache.at < CACHE_TTL_MS) return cache.timers;
  if (serviceManager() === "launchd") {
    const timers = describeLaunchd([
      "iva-brain.timer",
      "iva-update-check.timer",
    ]).map((state) => ({ unit: state.unit, next: state.nextRun ?? "—" }));
    cache = { at: Date.now(), timers };
    return timers;
  }
  const stdout = await run("systemctl", [
    "--user",
    "list-timers",
    "--all",
    "--no-pager",
  ]);
  const timers = parseTimers(stdout);
  cache = { at: Date.now(), timers };
  return timers;
}

export function openTaskCount(dataDir: string): number {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(dataDir, "tasks.json"), "utf8"),
    );
    const wrapped =
      typeof raw === "object" && raw !== null
        ? (raw as { tasks?: unknown })
        : null;
    const arr = Array.isArray(raw)
      ? raw
      : Array.isArray(wrapped?.tasks)
        ? wrapped.tasks
        : [];
    return arr.filter(
      (task: unknown) =>
        !(task as { readonly done?: unknown } | null | undefined)?.done,
    ).length;
  } catch {
    return 0;
  }
}

// Таблица таймеров с пагинацией: место в списке — горизонтальная строка, поэтому
// счётчик страниц не занимает отдельную колонку в тексте.
function timersBlock(timers: Timer[], st: MenuState, T: Translate): string {
  const pages = Math.ceil(timers.length / PER_PAGE);
  const page = Math.min(Math.max(st.page || 0, 0), pages - 1);
  st.page = page;
  const body = timers
    .slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE)
    .map(
      (t) =>
        `| ${escapeRichText(t.next)} | ${escapeRichText(t.unit.replace(/\.timer$/, ""))} |`,
    );
  const parts = [
    [
      `| ${T("When", "Когда")} | ${T("What", "Что")} |`,
      "| --- | --- |",
      ...body,
    ].join("\n"),
  ];
  if (pages > 1) {
    parts.push(
      buttonRow([
        button("‹", `iva_menu:cron:pg:${page > 0 ? page - 1 : 0}`),
        button(`${page + 1}/${pages}`, `iva_menu:cron:pg:${page}`),
        button(
          "›",
          `iva_menu:cron:pg:${page < pages - 1 ? page + 1 : pages - 1}`,
        ),
      ]),
    );
  }
  return parts.join("\n\n");
}

export default {
  parent: PARENT,
  async render(st: MenuState, ctx: MenuContext) {
    const T = ctx.tr;
    const timers = await loadTimers();
    const taskCount = openTaskCount(ctx.deps.dataDir);
    const taskLine = T(
      `Tasks in queue: ${taskCount}`,
      `Задач в очереди: ${taskCount}`,
    );
    const schedules = await schedulesBlock(
      ctx.deps.dataDir,
      T,
      ctx.deps.envPath,
    );
    const reminders = await remindersBlock(T);
    const timerBlock =
      timers.length === 0
        ? T("No Iva timers found.", "Таймеров Iva не найдено.")
        : timersBlock(timers, st, T);
    const text = [
      `# ${T("⏰ Timers & tasks", "⏰ Кроны и задачи")}`,
      timerBlock,
      taskLine,
      schedules,
      reminders,
      `${button(T("‹ Menu", "‹ Меню"), `iva_menu:${PARENT}:o`)} — ${T(
        "back to the settings.",
        "вернуться в настройки.",
      )}`,
    ].join("\n\n");
    return { text };
  },
  on() {},
};
