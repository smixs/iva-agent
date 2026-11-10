// Где лежит плагин и что о нём известно (ADR-0009).
//
// Папка плагинов одна — `data/custom/plugins/<name>/`. Плагин живёт в Custom layer,
// поэтому переживает `iva update` и не трогает Authored tree. Файл состояния один —
// `data/custom/plugins.json`: намерение (что владелец поставил) и факт (какой sha
// стоит) лежат рядом, отдельного lock-файла нет. Файл — источник истины: `iva plugin
// sync` восстанавливает по нему установку, если папку снесли или инсталляцию переехали.
//
// `PLUGIN_DATA` (`data/plugin-data/<name>/`) обязан переживать обновление плагина
// (спека §9.1), поэтому лежит рядом, а не внутри, и при `remove` не удаляется.
//
// Чтение НИЧЕГО не пишет. Это правило, а не деталь: состояние читает каждый ход
// агента, и «починка» битого файла на горячем пути однажды уже означала бы, что
// владелец теряет список плагинов молча, посреди разговора. Битую запись выбрасываем,
// битый файл отдаём вызывающему как ошибку — решать, что с ним делать, ему.
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { saveJsonAtomic } from "./json-store.ts";
import { pluginNameProblem } from "./plugin-reader.ts";
import { isRecord } from "../../packages/guards/index.ts";

/**
 * Loopback-порты, выданные плагину: по одному на MCP proxy и на сервис (ADR-0009).
 * Ключ — имя сервера в `mcp.json` или имя папки сервиса. Выдаются один раз, при
 * `iva plugin trust`, и живут до `remove`: порт в юните и порт в connection-файле
 * обязаны совпадать, а «переназначить порт» — это два переписанных файла и рестарт.
 */
export type PluginPorts = Readonly<Record<string, { readonly port: number }>>;

/** Первый порт для плагинов; ниже — порты самой Ивы (8723) и userbot (8724). */
export const FIRST_PLUGIN_PORT = 8730;
export const RESERVED_PLUGIN_PORTS: readonly number[] = [8723, 8724];
const MAX_PORT = 65535;

export type PluginEntry = {
  readonly name: string;
  /** Строка источника ровно в том виде, в каком её ввёл владелец. */
  readonly source: string;
  /** Что отслеживаем: ветка, тег, sha или `HEAD`; для локальной папки — пусто. */
  readonly ref: string;
  /** Что стоит: sha коммита; для локальной папки — пусто. */
  readonly sha: string;
  /** Отпечаток содержимого папки на момент установки; пусто — неизвестен. */
  readonly digest: string;
  readonly enabled: boolean;
  /** Разрешение поднимать MCP-серверы плагина. Тумблер отдельный (ADR-0009). */
  readonly trusted: boolean;
  readonly installedAt: string;
  /**
   * Имя Marketplace, через который плагин нашли по имени. Прямая установка из
   * git-источника или папки поля не имеет: провенанс — это факт, а не заготовка.
   */
  readonly marketplace?: string;
  /** Порт MCP proxy на каждый `stdio`-сервер `mcp.json`. Нет поля — не выдано. */
  readonly mcp?: PluginPorts;
  /** Порт каждого сервиса `sh.iva/services/<svc>/`. Нет поля — не выдано. */
  readonly services?: PluginPorts;
};

export type PluginsState = {
  readonly marketplaces: readonly string[];
  readonly plugins: readonly PluginEntry[];
  /** Когда владельцу один раз показали принятый риск ADR-0008. */
  readonly riskNoticeShownAt?: string;
};

/** Что дало чтение файла: состояние всегда, ошибка — если файл не читается. */
export type PluginsStateRead = {
  readonly state: PluginsState;
  readonly damaged: Error | null;
};

export const EMPTY_PLUGINS_STATE: PluginsState = {
  marketplaces: [],
  plugins: [],
};

/** Каталог с плагинами: `data/custom/plugins/`. */
export function pluginsDir(dataDir: string): string {
  return join(dataDir, "custom", "plugins");
}

/** Корень одного плагина: `data/custom/plugins/<name>/`. */
export function pluginRoot(dataDir: string, name: string): string {
  return join(pluginsDir(dataDir), name);
}

/** `PLUGIN_DATA` плагина: переживает и обновление, и удаление плагина. */
export function pluginDataDir(dataDir: string, name: string): string {
  return join(dataDir, "plugin-data", name);
}

/**
 * Конфиг eve Extension этого плагина: `data/custom/plugins/<name>.config.json`.
 * Лежит РЯДОМ с папкой плагина, а не внутри: папку переписывает `update`, а значения
 * владельца обязаны это пережить (ADR-0009). Читается в рантайме
 * (agent/lib/plugin-config.ts), в сборку не запекается.
 */
export function pluginConfigFile(dataDir: string, name: string): string {
  return join(pluginsDir(dataDir), `${name}.config.json`);
}

/**
 * Env MCP-серверов и сервисов плагина: `data/custom/plugins/<name>.env`. Лежит
 * рядом с папкой, как и конфиг: секреты владельца переписывать `update`-ом нельзя.
 */
export function pluginEnvFile(dataDir: string, name: string): string {
  return join(pluginsDir(dataDir), `${name}.env`);
}

/**
 * Что годится в имя сервера `mcp.json` или папки сервиса, когда из него делается
 * имя файла и имя systemd-юнита. Ключи `mcp.json` спека не ограничивает, а `../` в
 * имени сервера — это путь наружу; юниты проверяют то же правило своей копией
 * (scripts/lib/plugin-units.ts), и равенство копий пинует его тест.
 */
export const SAFE_PLUGIN_PART = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Файл токена MCP proxy: `data/plugin-data/<name>/mcp-<server>.token`. */
export function pluginTokenFile(
  dataDir: string,
  name: string,
  server: string,
): string {
  if (!SAFE_PLUGIN_PART.test(server))
    throw new Error(`unusable MCP server name: ${JSON.stringify(server)}`);
  return join(pluginDataDir(dataDir, name), `mcp-${server}.token`);
}

/** Файл состояния: `data/custom/plugins.json`. */
export function pluginsStateFile(dataDir: string): string {
  return join(dataDir, "custom", "plugins.json");
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Выданные порты как они лежат в файле. Мусор выпадает молча, как и битая запись:
 * порт, которого мы не понимаем, — это порт, которого нет, и следующий `trust`
 * выдаст его заново. Пустая карта не хранится вовсе — поля просто нет.
 */
function normalizePorts(raw: unknown): PluginPorts | undefined {
  if (!isRecord(raw)) return undefined;
  const ports: Record<string, { port: number }> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key || !isRecord(value)) continue;
    const port = value.port;
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > MAX_PORT
    )
      continue;
    ports[key] = { port };
  }
  return Object.keys(ports).length > 0 ? ports : undefined;
}

function normalizeEntry(raw: unknown): PluginEntry | null {
  if (!isRecord(raw)) return null;
  if (pluginNameProblem(raw.name) !== null) return null;
  const mcp = normalizePorts(raw.mcp);
  const services = normalizePorts(raw.services);
  return {
    name: raw.name as string,
    source: string(raw.source),
    ref: string(raw.ref),
    sha: string(raw.sha),
    digest: string(raw.digest),
    // Отсутствующий тумблер читается как «включён»: запись есть — плагин поставлен.
    enabled: raw.enabled !== false,
    trusted: raw.trusted === true,
    installedAt: string(raw.installedAt),
    ...(string(raw.marketplace)
      ? { marketplace: raw.marketplace as string }
      : {}),
    ...(mcp ? { mcp } : {}),
    ...(services ? { services } : {}),
  };
}

/**
 * Каждый порт, уже занятый записями состояния. Выдача нового порта смотрит сюда, а
 * не на сокеты: занятость решает файл состояния, иначе выключенный плагин отдал бы
 * свой порт соседу и вернулся с чужим (ADR-0009: порты стабильны до `remove`).
 */
export function takenPluginPorts(state: PluginsState): Set<number> {
  const taken = new Set<number>(RESERVED_PLUGIN_PORTS);
  for (const entry of state.plugins)
    for (const ports of [entry.mcp, entry.services])
      for (const value of Object.values(ports ?? {})) taken.add(value.port);
  return taken;
}

/**
 * Первый свободный порт от `from` вверх, не занятый ничем из `taken`. Сокеты не
 * проверяются: порт, который сейчас занят чужим процессом, всё равно наш, и юнит
 * поднимется, когда тот уйдёт — а «подвинуть плагин» стоило бы пересборки версии.
 */
export function freePluginPort(
  taken: ReadonlySet<number>,
  from: number = FIRST_PLUGIN_PORT,
): number {
  let port = Math.max(from, FIRST_PLUGIN_PORT);
  while (taken.has(port)) port += 1;
  if (port > MAX_PORT)
    throw new Error("no free loopback port left for a plugin");
  return port;
}

/** Любой JSON → состояние. Никогда не кидает: битая запись просто выпадает. */
export function normalizePluginsState(raw: unknown): PluginsState {
  if (!isRecord(raw)) return EMPTY_PLUGINS_STATE;
  const marketplaces = Array.isArray(raw.marketplaces)
    ? raw.marketplaces.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const seen = new Set<string>();
  const plugins: PluginEntry[] = [];
  if (Array.isArray(raw.plugins)) {
    for (const item of raw.plugins) {
      const entry = normalizeEntry(item);
      if (!entry || seen.has(entry.name)) continue;
      seen.add(entry.name);
      plugins.push(entry);
    }
  }
  plugins.sort((a, b) => (a.name < b.name ? -1 : 1));
  return {
    marketplaces,
    plugins,
    ...(typeof raw.riskNoticeShownAt === "string"
      ? { riskNoticeShownAt: raw.riskNoticeShownAt }
      : {}),
  };
}

/**
 * Состояние из конкретного файла, без единой записи на диск. Файла нет — пустое
 * состояние без ошибки; файл битый — пустое состояние ПЛЮС ошибка, а сам файл
 * остаётся лежать как есть: его ещё чинить.
 */
export async function readPluginsStateFile(
  file: string,
): Promise<PluginsStateRead> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: EMPTY_PLUGINS_STATE, damaged: null };
    return {
      state: EMPTY_PLUGINS_STATE,
      damaged: new Error(`${file} unreadable: ${(error as Error).message}`),
    };
  }
  try {
    return { state: normalizePluginsState(JSON.parse(raw)), damaged: null };
  } catch (error) {
    return {
      state: EMPTY_PLUGINS_STATE,
      damaged: new Error(
        `${file} is not valid JSON (${(error as Error).message}) — fix it or run: iva plugin sync`,
      ),
    };
  }
}

/**
 * Тот же текст без лишних запятых: дубли, висячая перед `}`/`]` и ведущая сразу
 * после `[`/`{`. Сканер идёт по символам и знает про строки, поэтому запятая внутри
 * `"a,,b"` остаётся на месте — чинить надо разметку, а не данные владельца.
 */
function withoutStrayCommas(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (inString) {
      out += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      out += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < raw.length && /\s/u.test(raw[next])) next++;
      if (raw[next] === "," || raw[next] === "}" || raw[next] === "]") continue;
      let previous = out.length - 1;
      while (previous >= 0 && /\s/u.test(out[previous])) previous--;
      if (previous < 0 || out[previous] === "[" || out[previous] === "{")
        continue;
    }
    out += character;
  }
  return out;
}

/**
 * Спасти состояние из файла, который уже не читается как JSON. Сначала честный
 * разбор, затем один проход починки разметки. Ничего не вышло — `null`, и решать,
 * что делать дальше, вызывающему.
 */
export async function salvagePluginsStateFile(
  file: string,
): Promise<PluginsState | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  for (const text of [raw, withoutStrayCommas(raw)]) {
    try {
      return normalizePluginsState(JSON.parse(text));
    } catch {
      // Следующая попытка; последняя вернёт null.
    }
  }
  return null;
}

/** То же для инсталляции: `data/custom/plugins.json`. */
export function readPluginsStateSafe(
  dataDir: string,
): Promise<PluginsStateRead> {
  return readPluginsStateFile(pluginsStateFile(dataDir));
}

/**
 * Состояние для команды владельца: битый файл — ошибка наружу. Команда, которая
 * молча пошла бы дальше на пустом состоянии, сказала бы «плагин не установлен» про
 * стоящий плагин и предложила поставить его заново поверх.
 */
export async function readPluginsState(dataDir: string): Promise<PluginsState> {
  const { state, damaged } = await readPluginsStateSafe(dataDir);
  if (damaged) throw damaged;
  return state;
}

/** Атомарная запись состояния (tmp + rename): читатель не увидит полуфайл. */
export async function writePluginsState(
  dataDir: string,
  state: PluginsState,
): Promise<void> {
  const file = pluginsStateFile(dataDir);
  await mkdir(dirname(file), { recursive: true });
  await saveJsonAtomic(file, normalizePluginsState(state));
}

/**
 * Hand `name` a port for every MCP server and service it declares, keeping the ones it
 * already has. Pure: the caller writes the state it gets back.
 *
 * A proxy gets the first free port from 8730 up. A service gets the port its
 * `service.json` asks for when nothing else holds it, and the first free one otherwise -
 * the author's number is a preference, not a claim on the machine.
 *
 * Ports already handed out are never moved and never dropped, not even for a server the
 * plugin no longer declares: the number lives in a generated connection and in a unit
 * file, and taking it back would mean rewriting both to gain one port.
 */
export function assignPluginPorts(
  state: PluginsState,
  wanted: {
    readonly name: string;
    /** MCP servers that need a proxy port, by name. */
    readonly mcp: readonly string[];
    /** Services that need a port, by name, with the port each one asks for. */
    readonly services: Readonly<Record<string, number>>;
  },
): PluginsState {
  const entry = findPlugin(state, wanted.name);
  if (!entry) return state;
  const taken = takenPluginPorts(state);
  const mcp: Record<string, { port: number }> = { ...(entry.mcp ?? {}) };
  const services: Record<string, { port: number }> = {
    ...(entry.services ?? {}),
  };
  for (const server of [...wanted.mcp].sort()) {
    if (mcp[server]) continue;
    const port = freePluginPort(taken);
    taken.add(port);
    mcp[server] = { port };
  }
  for (const service of Object.keys(wanted.services).sort()) {
    if (services[service]) continue;
    const asked = wanted.services[service];
    const usable =
      Number.isInteger(asked) &&
      asked >= 1 &&
      asked <= MAX_PORT &&
      !taken.has(asked);
    const port = usable ? asked : freePluginPort(taken);
    taken.add(port);
    services[service] = { port };
  }
  return upsertPlugin(state, {
    ...entry,
    ...(Object.keys(mcp).length ? { mcp } : {}),
    ...(Object.keys(services).length ? { services } : {}),
  });
}

export function findPlugin(
  state: PluginsState,
  name: string,
): PluginEntry | undefined {
  return state.plugins.find((entry) => entry.name === name);
}

/** Добавить или заменить запись. Чистая функция: состояние не мутируется. */
export function upsertPlugin(
  state: PluginsState,
  entry: PluginEntry,
): PluginsState {
  return {
    ...state,
    plugins: [
      ...state.plugins.filter((item) => item.name !== entry.name),
      entry,
    ].sort((a, b) => (a.name < b.name ? -1 : 1)),
  };
}

export function removePlugin(state: PluginsState, name: string): PluginsState {
  return {
    ...state,
    plugins: state.plugins.filter((entry) => entry.name !== name),
  };
}

export function enabledPlugins(state: PluginsState): readonly PluginEntry[] {
  return state.plugins.filter((entry) => entry.enabled);
}
