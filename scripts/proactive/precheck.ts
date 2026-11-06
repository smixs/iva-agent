// Проверка перед ходом Watch (ADR-0020): источники без модели. Каждый источник отдаёт
// `{ items, error }`: не подключён — пусто без ошибки; подключён, но проверка не удалась —
// `error`, и тик заводит пункт `check:<источник>`. Никому не шлёт; пишет только сбои — снимает
// дроссель Alert с юнита, который больше не упал (alertResolved).
//
// Telegram — инструмент `list_chats` прокси юзербота (telegram-mcp f1a2d8e,
// telegram_mcp/tools/chats.py:449-578): `{"results":[…]}`, пусто — строка `No chats found…`.
// Почта — `gws`: список непрочитанных входящих без категорий, затем заголовки каждого письма;
// рассылка (`List-Unsubscribe`) пунктом не становится.
// Сбои (T3) — `systemctl --user`: таймерные сервисы пользователя и сервисы плагинов; идут и при
// выключенном тумблере.
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { serviceManager } from "../lib/service-manager.ts";
import { describeLaunchd } from "../lib/launchd.ts";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  MAIL_LIMIT,
  TELEGRAM_GROUPS_LIMIT,
  TELEGRAM_USERS_LIMIT,
  type Sender,
} from "#lib/proactive-config.ts";
import { openFailures } from "#lib/open-failures.ts";
import { childEnv, gwsBin } from "../lib/menu/gws-auth.ts";
import { alertDue, alertResolved } from "../lib/notice-policy.ts";

/** ДР Google Контактов: общие поля источника и metadata пункта Watch. */
export type Birthday = {
  readonly key: string;
  readonly name: string;
  readonly date: string;
  readonly daysUntil: number;
};

/** Пункт Watch: ключ в `seen`, счётчик, кто прислал; у `check:` и сбоя — что сломалось (строка промпта). */
export type WatchItem = {
  readonly key: string;
  readonly unread: number;
  readonly from: Sender;
  readonly note?: string;
  /** Поля ДР до обработки промпта; в seen не сохраняются. */
  readonly birthday?: Birthday;
  readonly message_id?: number;
  readonly topic_id?: number;
  /**
   * Сбой регулярной задачи (T3): пределы и тумблер его не держат. `essence` — существо для
   * дросселя Alert, `at` — время выхода (сдвигает `failuresSeenUpToMs` в заявке).
   */
  readonly failure?: { readonly essence: string; readonly at: number };
};

export type SourceResult = {
  readonly items: readonly WatchItem[];
  readonly error: string | null;
  /** Ошибка только в журнал, без пункта `check:<источник>`; ключи всё равно не трогаются. */
  readonly silent?: boolean;
};

export type Source = {
  readonly name: string;
  /** Префикс ключей источника в `seen`. */
  readonly prefix: string;
  /** Идёт и при выключенном тумблере «Сама пишет» (сбои). */
  readonly always?: boolean;
  readonly check: (since?: {
    readonly now: number;
    readonly failuresSeenUpToMs: number;
  }) => Promise<SourceResult>;
};

const TELEGRAM_TIMEOUT_MS = 10_000;
const MAIL_TIMEOUT_MS = 20_000;
const NOT_CONNECTED: SourceResult = { items: [], error: null };

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** JSON или undefined: что делать с не-JSON, решает вызывающий. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// ── Telegram ─────────────────────────────────────────────────────────────────────────────

type ChatRecord = Readonly<Record<string, unknown>>;

export type CallTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

/** Ответ `list_chats`: записи или ошибка; строка `No chats found…` — пусто. */
export function parseChats(text: string): ChatRecord[] {
  if (text.startsWith("No chats found")) return [];
  const results = (parseJson(text) as { results?: unknown } | null)?.results;
  if (!Array.isArray(results))
    throw new Error(
      `list_chats answered not {"results":[…]}: ${text.slice(0, 200)}`,
    );
  return results.filter(
    (row): row is ChatRecord => typeof row === "object" && row !== null,
  );
}

const count = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** Запись → пункт: личный чат по `unread` (+1 за `unread_mark`), группа — по упоминаниям. */
function chatItem(row: ChatRecord, botId: string): WatchItem | null {
  const id = row.chat_id;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    String(id) === botId
  )
    return null;
  // Боты — не люди, которые ждут ответа: у бота имя пользователя в Telegram всегда кончается
  // на `bot`, у человека так кончаться не может (отдельного признака `list_chats` не отдаёт).
  if (row.type === "User" && /bot$/iu.test(text(row.username) ?? ""))
    return null;
  const unread =
    row.type === "User"
      ? count(row.unread) + (row.unread_mark === true ? 1 : 0)
      : count(row.unread_mentions);
  const from = {
    username: text(row.username),
    name: text(row.name ?? row.title),
  };
  return unread === 0 ? null : { key: `tg:${id}`, unread, from };
}

/** Вызов инструмента прокси по streamable-http с bearer; срок на соединение и на вызов. */
export function proxyCallTool(
  url: string,
  token: string,
  timeoutMs = TELEGRAM_TIMEOUT_MS,
): CallTool {
  return async (name, args) => {
    const client = new Client({ name: "iva-watch", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const timeout = { timeout: timeoutMs };
    try {
      await client.connect(transport, timeout);
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        timeout,
      );
      const parts = Array.isArray(result.content) ? result.content : [];
      const first = (parts as Array<{ text?: unknown }>).find(
        (part) => typeof part.text === "string",
      );
      if (typeof first?.text !== "string")
        throw new Error(`${name} answered without text`);
      return first.text;
    } finally {
      await client.close().catch(() => undefined);
    }
  };
}

function proxyToken(env: NodeJS.ProcessEnv, dataDir: string): string {
  if (env.TELEGRAM_MCP_TOKEN) return env.TELEGRAM_MCP_TOKEN;
  try {
    return readFileSync(join(dataDir, "telegram-userbot.token"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Оба вызова `list_chats` (личные, группы) → пункты без повторов. */
async function listChats(
  call: CallTool,
  botId: string,
  log: (line: string) => void,
): Promise<WatchItem[]> {
  const items = new Map<string, WatchItem>();
  for (const [chatType, limit] of [
    ["user", TELEGRAM_USERS_LIMIT],
    ["group", TELEGRAM_GROUPS_LIMIT],
  ] as const) {
    const rows = parseChats(
      await call("list_chats", {
        chat_type: chatType,
        unread_only: true,
        unmuted_only: true,
        archived: false,
        limit,
      }),
    );
    if (rows.length >= limit)
      log(`proactive: telegram ${chatType} chats hit the limit ${limit}`);
    for (const item of rows.map((row) => chatItem(row, botId))) {
      if (!item) continue;
      const metadata =
        chatType === "group" ? await groupMessage(call, item, log) : {};
      items.set(item.key, { ...item, ...metadata });
    }
  }
  return [...items.values()];
}

/** Последнее сообщение группы; тему берём из канонической ссылки, обычный reply_to ей не является. */
async function groupMessage(
  call: CallTool,
  item: WatchItem,
  log: (line: string) => void,
) {
  let message_id: number | undefined;
  try {
    const chat_id = Number(item.key.slice(3));
    const result = parseJson(
      await call("list_messages", { chat_id, limit: 1 }),
    ) as { results?: Array<{ id?: unknown }> } | undefined;
    message_id = count(result?.results?.[0]?.id) || undefined;
    if (message_id === undefined) return {};
    const link = await call("get_message_link", { chat_id, message_id });
    const topic_id = topicOfLink(link, item, message_id);
    return { message_id, ...(topic_id === undefined ? {} : { topic_id }) };
  } catch {
    log(`proactive: telegram message metadata unavailable for ${item.key}`);
    return message_id === undefined ? {} : { message_id };
  }
}

/** ExportMessageLink возвращает маршрут темы. Сверяем чат и сообщение перед передачей id. */
function topicOfLink(link: string, item: WatchItem, message_id: number) {
  const exported = /^Link: (https:\/\/t\.me\/\S+)(?:\n|$)/u.exec(link)?.[1];
  if (!exported) return undefined;
  const url = new URL(exported);
  const path = url.pathname.slice(1).split("/");
  const peer = path.shift();
  const matches =
    peer === "c"
      ? `-100${path.shift()}` === item.key.slice(3)
      : peer === item.from.username;
  if (!matches || path.length > 2 || Number(path.at(-1)) !== message_id)
    return undefined;
  const topic = path.length === 2 ? path[0] : url.searchParams.get("thread");
  return count(Number(topic)) || undefined;
}

/** Личные чаты и группы с упоминаниями; нет токена прокси — не подключён. */
export function telegramSource(
  env: NodeJS.ProcessEnv,
  dataDir: string,
  callTool?: CallTool,
  log: (line: string) => void = console.log,
): Source {
  const check = async (): Promise<SourceResult> => {
    // Свой адрес присмотра: у владельца может быть отдельный прокси того же telegram-mcp, которым
    // он пользуется сам. Watch только читает список чатов, а Connection юзербота (отправка от
    // имени владельца) этим адресом не включается.
    const watchUrl = (env.TELEGRAM_WATCH_URL ?? "").trim();
    const token =
      watchUrl === ""
        ? proxyToken(env, dataDir)
        : (env.TELEGRAM_WATCH_TOKEN ?? "").trim();
    if (token === "" && callTool === undefined) return NOT_CONNECTED;
    const port = env.TELEGRAM_MCP_PORT || "8724";
    const call =
      callTool ??
      proxyCallTool(watchUrl || `http://127.0.0.1:${port}/mcp`, token);
    // Чат самого бота Ивы — не пропущенное: id бота стоит в начале его токена.
    const botId = String(env.TELEGRAM_BOT_TOKEN ?? "").split(":")[0] ?? "";
    try {
      return { items: await listChats(call, botId, log), error: null };
    } catch (error) {
      return { items: [], error: message(error) };
    }
  };
  return { name: "telegram", prefix: "tg:", check };
}

// ── Почта ────────────────────────────────────────────────────────────────────────────────

export const MAIL_QUERY =
  "is:unread in:inbox -category:promotions -category:social -category:forums -category:updates";

/** Исход `gws`: код выхода (2 — не авторизован), нет бинаря или срок вышел; и stdout. */
export type GwsRun = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<{
  code: number | "missing" | "timeout";
  stdout: string;
  stderr?: string;
}>;

function exitCode(
  error: (Error & { code?: unknown; killed?: boolean }) | null,
) {
  if (error === null) return 0;
  if (error.code === "ENOENT") return "missing";
  if (error.killed === true) return "timeout";
  return typeof error.code === "number" ? error.code : 1;
}

export const runGws: GwsRun = (args, timeoutMs) =>
  new Promise((resolve) => {
    const options = { timeout: timeoutMs, env: childEnv(), maxBuffer: 4 << 20 };
    execFile(gwsBin(), [...args], options, (error, stdout, stderr) =>
      resolve({
        code: exitCode(error),
        stdout: String(stdout),
        stderr: String(stderr),
      }),
    );
  });

/** Один вызов `gws gmail users messages …` с JSON-ответом; не подключён — null. */
async function gwsJson(
  run: GwsRun,
  params: Record<string, unknown>,
  deadline: number,
): Promise<Record<string, unknown> | null> {
  const method = "id" in params ? "get" : "list";
  const { code, stdout } = await run(
    ["gmail", "users", "messages", method, "--params", JSON.stringify(params)],
    Math.max(1, deadline - Date.now()),
  );
  if (code === "missing" || code === 2) return null;
  if (code === "timeout")
    throw new Error(`gws timed out after ${MAIL_TIMEOUT_MS} ms`);
  if (code !== 0) throw new Error(`gws ${method} exited ${code}`);
  const parsed = parseJson(stdout);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`gws ${method} answered not a JSON object`);
  return parsed as Record<string, unknown>;
}

/** `Имя <адрес>` → имя и адрес из скобок; голый адрес — он сам. */
export function senderOf(from: string): Sender {
  // Голый адрес — без пробелов и угловых скобок, как адрес в скобках (обломок `>@x` — не адрес).
  const bare = /^[^\s<>]+@[^\s<>]+$/u.test(from.trim())
    ? from.trim()
    : undefined;
  const email = /<([^<>\s]+@[^<>\s]+)>/u.exec(from)?.[1] ?? bare;
  const name = text(
    from
      .replace(/<[^<>]*>/u, "")
      .replace(/"/gu, "")
      .trim(),
  );
  return { email, name: name === bare ? undefined : name };
}

function header(message: Record<string, unknown> | null, wanted: string) {
  const headers = (message?.payload as { headers?: unknown } | undefined)
    ?.headers;
  const found = (Array.isArray(headers) ? headers : []).find(
    (h: { name?: unknown }) =>
      typeof h.name === "string" &&
      h.name.toLowerCase() === wanted.toLowerCase(),
  ) as { value?: unknown } | undefined;
  return typeof found?.value === "string" ? found.value : null;
}

/** Непрочитанные входящие без категорий и рассылок, не больше MAIL_LIMIT; срок 20 с на всё. */
export function mailSource(run: GwsRun = runGws): Source {
  const check = async (): Promise<SourceResult> => {
    const deadline = Date.now() + MAIL_TIMEOUT_MS;
    try {
      const list = await gwsJson(
        run,
        { userId: "me", q: MAIL_QUERY, maxResults: MAIL_LIMIT },
        deadline,
      );
      if (list === null) return NOT_CONNECTED;
      const ids = (Array.isArray(list.messages) ? list.messages : [])
        .map((m: { id?: unknown }) => m.id)
        .filter(
          (id): id is string => typeof id === "string" && /^[\w-]+$/u.test(id),
        )
        .slice(0, MAIL_LIMIT);
      const headers = ["From", "List-Unsubscribe"];
      const metadata = { format: "metadata", metadataHeaders: headers };
      const messages = await Promise.all(
        ids.map((id) =>
          gwsJson(run, { userId: "me", id, ...metadata }, deadline),
        ),
      );
      const items: WatchItem[] = [];
      for (const [index, id] of ids.entries()) {
        const m = messages[index] ?? null;
        const from = senderOf(header(m, "From") ?? "");
        if (m !== null && header(m, "List-Unsubscribe") === null)
          items.push({ key: `mail:${id}`, unread: 1, from });
      }
      return { items, error: null };
    } catch (error) {
      return { items: [], error: message(error) };
    }
  };
  return { name: "mail", prefix: "mail:", check };
}

// ── Сбои ─────────────────────────────────────────────────────────────────────────────────

/** `systemctl --user …`: код выхода, нет бинаря (macOS) или срок вышел; и stdout. */
export type Systemctl = (args: readonly string[]) => ReturnType<GwsRun>;

// TZ=UTC: время выхода systemd печатает в зоне процесса, и без зоны вроде MSK или CEST, которую не
// разобрать, оно всегда кончается на «UTC» — на любой версии, без `--timestamp=unix` (только с 251).
const runSystemctl: Systemctl = (args) =>
  new Promise((resolve) => {
    const env = { ...process.env, TZ: "UTC" };
    const options = { timeout: 10_000, maxBuffer: 4 << 20, env };
    execFile("systemctl", ["--user", ...args], options, (error, stdout) =>
      resolve({ code: exitCode(error), stdout: String(stdout) }),
    );
  });

const PLUGIN_UNITS =
  "list-units --all --plain --no-legend iva-plugin-* iva-mcp-* iva-telegram-userbot.service";
const SHOW =
  "show -p Id -p Result -p ExecMainStatus -p ExecMainExitTimestamp --";

/**
 * systemctl не ответил или его нет (macOS): источник пуст, ошибка только в журнал, без пункта
 * `check:timers` (таблица отказов T3).
 */
class SystemctlFailed extends Error {}
class SystemctlMissing extends SystemctlFailed {}

/** Вывод команды; отказ, срок или нет бинаря — SystemctlFailed. */
async function systemctl(run: Systemctl, ...args: string[]) {
  const { code, stdout } = await run(args);
  if (code === "missing") throw new SystemctlMissing("systemctl not found");
  if (code !== 0)
    throw new SystemctlFailed(
      `systemctl ${args[0]} ${code === "timeout" ? "timed out after 10 s" : `exited ${code}`}`,
    );
  return stdout;
}

const tokens = (out: string) =>
  out
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter((row) => row[0] !== "");

/**
 * Время выхода из `systemctl show`: обычный формат «Sat 2026-10-04 03:30:47 UTC» / «… +05» (вызов
 * идёт с TZ=UTC) или `@<секунды>` (`--timestamp=unix`; до systemd 251 значения нет и systemctl
 * отвергает флаг, поэтому вызов его не передаёт). Пусто или n/a — не выходил. Иное — ошибка: источник
 * `error`, пункт `check:timers`.
 */
export function exitTime(value: string): number | null {
  if (value === "" || value === "n/a") return null;
  const unix = /^@(\d{1,12})$/u.exec(value);
  if (unix) return Number(unix[1]) * 1000;
  const m =
    /^(?:[A-Z][a-z]{2} )?(\S+) (\S+) (?:(UTC|GMT)|([+-]\d\d)(?::?(\d\d))?)$/u.exec(
      value,
    );
  const zone = m?.[3] ? "Z" : `${m?.[4]}:${m?.[5] ?? "00"}`;
  const ms = m ? Date.parse(`${m[1]}T${m[2]}${zone}`) : Number.NaN;
  if (!Number.isFinite(ms))
    throw new Error(`exit time not understood: ${value.slice(0, 80)}`);
  return ms;
}

/**
 * Таймерные сервисы пользователя (кроме юнитов Ивы `iva*`) и сервисы плагинов и юзербота.
 * Таймер упал — последний `ExecMainStatus` не 0; сервис — `failed` в `list-units` или `Result`
 * последнего запуска не `success` (цикл перезапусков).
 */
async function unitStates(run: Systemctl) {
  if (run === runSystemctl && serviceManager() === "launchd") {
    const dir = join(homedir(), "Library/LaunchAgents");
    const names = existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => /^app\.iva\..+\.plist$/u.test(name))
          .map((name) => `${name.slice(8, -6)}.service`)
      : [];
    return {
      units: describeLaunchd(names).map((state) => ({
        unit: state.unit,
        timer: state.nextRun !== null,
        failing: state.lastExit !== null && state.lastExit !== 0 && !state.pid,
        essence: String(state.lastExit ?? ""),
        at: Date.now(),
        note: `a regular job failed: ${state.unit}: exit status ${state.lastExit}`,
      })),
      error: null,
    };
  }
  const listed = await systemctl(run, "list-timers", "--all", "--no-legend");
  // Колонки `next left last passed unit activates`: сервисы — после имени таймера.
  const timers = new Set(
    tokens(listed).flatMap((row) =>
      row
        .slice(row.findIndex((t) => t.endsWith(".timer")) + 1 || row.length)
        .map((t) => t.replace(/,$/u, ""))
        .filter((t) => t.endsWith(".service") && !t.startsWith("iva")),
    ),
  );
  const plugins = tokens(await systemctl(run, ...PLUGIN_UNITS.split(" ")));
  const names = [...new Set([...timers, ...plugins.map((row) => row[0])])];
  if (names.length === 0) return { units: [], error: null };
  const shown = await systemctl(run, ...SHOW.split(" "), ...names);
  // Блоки `show` разделены пустой строкой, свойство — `Имя=значение`.
  const blocks = new Map(
    shown.split(/\n\s*\n/u).map((block) => {
      const p = Object.fromEntries(
        block.split("\n").map((line) => line.trim().split(/=(.*)/su, 2)),
      ) as Record<string, string | undefined>;
      return [p.Id, p];
    }),
  );
  const errors: string[] = [];
  const units = names.flatMap((unit) => {
    const p = blocks.get(unit) ?? {};
    const timer = timers.has(unit);
    const [status = "", result = ""] = [p.ExecMainStatus, p.Result];
    const failed = (row: string[]) => row[0] === unit && row[2] === "failed";
    // Сервис с Restart= падает по кругу в «activating auto-restart» и до `failed` не доходит:
    // упавшим его делает и Result последнего запуска.
    const crashed = result !== "" && result !== "success";
    let note;
    try {
      note = exitNote(unit, status, result, p.ExecMainExitTimestamp);
    } catch (error) {
      errors.push(message(error));
      return [];
    }
    return [
      {
        unit,
        timer,
        failing: timer
          ? !["", "0"].includes(status)
          : plugins.some(failed) || crashed,
        essence: timer ? status : result,
        ...note,
      },
    ];
  });
  return { units, error: errors.join("; ") || null };
}

/** Время выхода и строка пункта: что упало, код, Result, когда. */
function exitNote(unit: string, status: string, result: string, exited = "") {
  const at = exitTime(exited);
  const when = at === null ? "" : `, exited ${new Date(at).toISOString()}`;
  const what = `exit status ${status || "n/a"}, result ${result || "n/a"}`;
  return { at: at ?? 0, note: `a regular job failed: ${unit}: ${what}${when}` };
}

/**
 * Новые сбои: таймер — выход позже `failuresSeenUpToMs`; сервис плагина — упал; оба — если
 * дроссель Alert (`failure:<юнит>`, существо — статус или Result) пропускает. Не упавший юнит
 * снимает свою запись дросселя: рецидив заговорит сразу.
 */
export function failuresSource(
  dataDir: string,
  run: Systemctl = runSystemctl,
): Source {
  const check: Source["check"] = async (since) => {
    const { now = Date.now(), failuresSeenUpToMs = 0 } = since ?? {};
    let states;
    try {
      states = await unitStates(run);
    } catch (error) {
      const silent = error instanceof SystemctlFailed;
      return { items: [], error: message(error), silent };
    }
    const items: WatchItem[] = [];
    for (const { unit, timer, failing, essence, at, note } of states.units) {
      const key = `failure:${unit}`;
      if (!failing) alertResolved(dataDir, key);
      else if (
        (!timer || at > failuresSeenUpToMs) &&
        alertDue(dataDir, key, essence, now)
      )
        items.push({
          key,
          unread: 1,
          from: {},
          note,
          failure: { essence, at },
        });
    }
    return { items, error: states.error };
  };
  return { name: "timers", prefix: "failure:", always: true, check };
}

/** Непочиненные сбои для Brief: открытые провалы Ивы и таймеры, чей последний выход не 0. */
export async function unfixedFailures(
  dataDir: string,
  now: number,
  run: Systemctl = runSystemctl,
): Promise<string[]> {
  const lines: string[] = [];
  try {
    for (const f of await openFailures({ dir: dataDir, now }))
      lines.push(`${f.source} ${f.name}: ${f.reason}`);
    const { units, error } = await unitStates(run);
    for (const u of units) if (u.timer && u.failing) lines.push(u.note);
    if (error) lines.push(`failures check failed: ${error}`);
  } catch (error) {
    // Нет systemctl (macOS) — таймеров нет, это не сбой проверки.
    if (!(error instanceof SystemctlMissing))
      lines.push(`failures check failed: ${message(error)}`);
  }
  return lines;
}
