// Чтение папки формата Agent Plugins 1.0.0 — единственное место, где Ива решает,
// что в плагине есть и что из него принимается.
//
// Спека (agent-plugins.org/specification) исполняется буквально: закрытая схема
// `plugin.json`, ровно два нефатальных нарушения (лишнее поле верхнего уровня и
// `extensions` не объект), `mcp.json` закрытый и с версией `$schema` как у манифеста,
// containment всех путей. Схема НИКОГДА не тянется из сети: валидация локальная,
// иначе установка плагина зависела бы от чужого сайта (спека это запрещает прямым
// MUST NOT). Список скиллов живёт отдельно, в plugin-skills.ts: его читает и живой
// резолвер, и ответ должен быть один.
//
// Строже спеки в двух местах, как NanoClaw (спека это разрешает): симлинки внутри
// плагина отвергаем целиком (lstat, без единого follow), и держим потолки
// 2000 записей / 50 МБ / 16 уровней. Дешевле объяснить автору плагина отказ, чем
// разбирать, куда ушёл симлинк на `~/.ssh`.
//
// Отчёт вместо исключения: функция НИКОГДА не кидает наружу. Битая компонента не
// валит остальные — плагин с поломанным `mcp.json` обязан отдать свои скиллы.
// Границы отказа от узкой к широкой (§4.1 спеки): манифест вне корня → плагин
// отклонён; фиксированное место компоненты не того типа → выключена компонента;
// `SKILL.md` не на месте → пропущен один скилл; путь записи MCP вне корня →
// пропущена одна запись.
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import {
  errorCode,
  listPluginSkills,
  type PluginSkillRef,
} from "./plugin-skills.ts";
import { isRecord } from "../../packages/guards/index.ts";

export const PLUGIN_SCHEMA_URL =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA_URL =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PLUGIN_MANIFEST_FILE = "plugin.json";
const PLUGIN_MCP_FILE = "mcp.json";

/** Наш reverse-domain namespace: ключ в `extensions` и папка в корне (ADR-0009). */
export const IVA_NAMESPACE = "sh.iva";
/** Что делает `sh.iva/` кодом: манифест пакета eve Extension. */
const CODE_MANIFEST = "package.json";
/** Слот сервисов внутри нашего namespace: `sh.iva/services/<svc>/service.json`. */
const SERVICES_DIR = "services";
const SERVICE_FILE = "service.json";
const SERVICE_FIELDS = new Set(["command", "args", "port"]);
/** Порт сервиса: только непривилегированный, только реальный. */
const MIN_SERVICE_PORT = 1024;
const MAX_SERVICE_PORT = 65535;

// Потолки против абьюза, а не рекомендация по размеру: настоящий плагин — это
// несколько десятков файлов.
export const MAX_PLUGIN_ENTRIES = 2000;
export const MAX_PLUGIN_BYTES = 50 * 1024 * 1024;
export const MAX_PLUGIN_DEPTH = 16;

const NAME_MAX = 64;
// Регэксп спеки §5.5 без lookahead: запрет `--` и `..` проверяется отдельно —
// так сообщение об отказе называет конкретную причину.
const NAME_BODY = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

const MANIFEST_STRING_FIELDS = [
  "version",
  "description",
  "homepage",
  "repository",
  "license",
] as const;
const MANIFEST_FIELDS = new Set<string>([
  "$schema",
  "name",
  "author",
  "keywords",
  "extensions",
  ...MANIFEST_STRING_FIELDS,
]);
const AUTHOR_FIELDS = new Set(["name", "email", "url"]);
const STDIO_FIELDS = new Set(["type", "command", "args", "env", "cwd"]);
const REMOTE_FIELDS = new Set(["type", "url", "headers"]);

export type PluginManifest = {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  /** Namespace → payload. Чужие namespace хранятся, но не валидируются (§8.1). */
  readonly extensions: Readonly<Record<string, unknown>>;
};

export type PluginMcpServer =
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly cwd?: string;
    }
  | {
      readonly type: "streamable-http" | "sse";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

/**
 * Долгоживущий сервис плагина: объявление `sh.iva/services/<svc>/service.json`.
 * Ива поднимает его юнитом рядом с агентом (ADR-0009) и сообщает выданный порт
 * через `IVA_SERVICE_PORT`; `port` здесь — тот, который просит автор.
 */
export type PluginService = {
  readonly command: string;
  readonly args?: readonly string[];
  readonly port: number;
};

export type PluginReport = {
  readonly root: string;
  /** `null` — плагин отклонён целиком; тогда компонент нет ни одного. */
  readonly manifest: PluginManifest | null;
  readonly skills: readonly PluginSkillRef[];
  /** Принятые серверы `mcp.json`; пусто, когда файла нет или компонента невалидна. */
  readonly mcp: Readonly<Record<string, PluginMcpServer>>;
  /** Есть ли в плагине eve Extension: `sh.iva/package.json` (ADR-0009). */
  readonly code: boolean;
  /** Принятые сервисы `sh.iva/services/<svc>/service.json`. */
  readonly services: Readonly<Record<string, PluginService>>;
  /** Всё, что пропущено или проигнорировано, — поимённо, без молчаливых потерь. */
  readonly diagnostics: readonly string[];
};

export type PluginFile = {
  /** Путь относительно корня плагина, POSIX-разделители. */
  readonly path: string;
  readonly size: number;
  readonly mode: number;
};

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Проверка имени плагина по §5.5 спеки. Возвращает причину отказа или null. */
export function pluginNameProblem(name: unknown): string | null {
  if (typeof name !== "string") return "name must be a string";
  if (name.length < 1 || name.length > NAME_MAX)
    return `name must be 1-${NAME_MAX} characters`;
  if (name.includes("--") || name.includes(".."))
    return 'name must not contain "--" or ".."';
  if (!NAME_BODY.test(name))
    return "name must be lowercase letters, digits, hyphens and periods, starting and ending alphanumeric";
  return null;
}

/**
 * Обход дерева плагина с проверкой каждой записи. Возвращает обычные файлы.
 * Кидает на первом же симлинке, спецфайле или пробитом потолке — вызывающий обязан
 * считать это отказом всему плагину.
 *
 * Каталог `.git` в КОРНЕ пропускается: папка плагина из git-источника — это
 * checkout на запиненном sha (ADR-0009), и служебные объекты git плагину
 * не принадлежат.
 */
export async function walkPluginTree(
  root: string,
): Promise<readonly PluginFile[]> {
  const resolvedRoot = resolve(root);
  let rootStat;
  try {
    rootStat = await lstat(resolvedRoot);
  } catch (error) {
    throw new Error(`plugin root unreadable: ${reason(error)}`, {
      cause: error,
    });
  }
  if (!rootStat.isDirectory())
    throw new Error("plugin root must be a regular directory");

  const files: PluginFile[] = [];
  // Каталоги считаются наравне с файлами: бомба из пустых папок обязана пробить
  // тот же потолок, что бомба из файлов.
  let entries = 0;
  let bytes = 0;

  async function visit(relativeDir: string, depth: number): Promise<void> {
    const absoluteDir = relativeDir
      ? join(resolvedRoot, relativeDir)
      : resolvedRoot;
    let listing: Dirent[];
    try {
      listing = await readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`${relativeDir || "."} unreadable: ${reason(error)}`, {
        cause: error,
      });
    }
    for (const entry of listing.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (!relativeDir && entry.name === ".git") continue;
      if (entry.isSymbolicLink())
        throw new Error(`${path} is a symlink; symlinks are not allowed`);
      if (depth + 1 > MAX_PLUGIN_DEPTH)
        throw new Error(`${path} is deeper than ${MAX_PLUGIN_DEPTH} levels`);
      entries += 1;
      if (entries > MAX_PLUGIN_ENTRIES)
        throw new Error(`more than ${MAX_PLUGIN_ENTRIES} entries`);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile())
        throw new Error(`${path} is not a regular file or directory`);
      const stat = await lstat(join(absoluteDir, entry.name));
      files.push({ path, size: stat.size, mode: stat.mode });
      bytes += stat.size;
      if (bytes > MAX_PLUGIN_BYTES)
        throw new Error(`total size exceeds ${MAX_PLUGIN_BYTES} bytes`);
    }
  }

  await visit("", 0);
  return files;
}

/**
 * Отпечаток содержимого папки плагина: пути, бит запуска и байты каждого файла.
 * По нему `iva plugin update` узнаёт, что папку правили руками, — одинаково для
 * git-источника, подпапки и локальной копии.
 */
export async function pluginTreeDigest(root: string): Promise<string> {
  const files = await walkPluginTree(root);
  const digest = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const content = createHash("sha256")
      .update(await readFile(join(root, ...file.path.split("/"))))
      .digest("hex");
    digest.update(
      `${file.path}\0${file.mode & 0o111 ? "x" : "-"}\0${content}\n`,
    );
  }
  return digest.digest("hex");
}

/**
 * Путь внутри корня — или null. Симлинков в дереве уже нет (их отверг обход),
 * поэтому containment проверяется лексически, без единого follow.
 */
function containedPath(root: string, candidate: string): string | null {
  const resolvedRoot = resolve(root);
  const target = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(resolvedRoot, candidate);
  if (target === resolvedRoot) return target;
  const inside = relative(resolvedRoot, target);
  if (
    !inside ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  )
    return null;
  return target;
}

/** Лезет ли относительный путь наверх, каким бы ни был его корень. */
function climbsOut(path: string): boolean {
  const normalized = posix.normalize(path);
  return normalized === ".." || normalized.startsWith("../");
}

/** Разбор `plugin.json`. Фатальное нарушение — исключение. */
function parsePluginManifest(
  raw: unknown,
  diagnostics: string[],
): PluginManifest {
  if (!isRecord(raw))
    throw new Error(`${PLUGIN_MANIFEST_FILE} must be a JSON object`);

  if (raw.$schema !== PLUGIN_SCHEMA_URL)
    throw new Error(
      `${PLUGIN_MANIFEST_FILE} $schema must be ${JSON.stringify(PLUGIN_SCHEMA_URL)}`,
    );

  const nameProblem = pluginNameProblem(raw.name);
  if (nameProblem) throw new Error(`${PLUGIN_MANIFEST_FILE} ${nameProblem}`);

  for (const field of MANIFEST_STRING_FIELDS) {
    if (raw[field] !== undefined && typeof raw[field] !== "string")
      throw new Error(`${PLUGIN_MANIFEST_FILE} ${field} must be a string`);
  }
  if (raw.keywords !== undefined) {
    if (
      !Array.isArray(raw.keywords) ||
      !raw.keywords.every((keyword) => typeof keyword === "string")
    )
      throw new Error(
        `${PLUGIN_MANIFEST_FILE} keywords must be an array of strings`,
      );
  }
  if (raw.author !== undefined) {
    if (!isRecord(raw.author))
      throw new Error(`${PLUGIN_MANIFEST_FILE} author must be an object`);
    for (const [key, value] of Object.entries(raw.author)) {
      if (!AUTHOR_FIELDS.has(key))
        throw new Error(
          `${PLUGIN_MANIFEST_FILE} author has unknown field ${JSON.stringify(key)}`,
        );
      if (typeof value !== "string")
        throw new Error(
          `${PLUGIN_MANIFEST_FILE} author.${key} must be a string`,
        );
    }
  }

  // §5.2 и §8.1 — ровно два нефатальных нарушения: сообщить и проигнорировать.
  let extensions: Record<string, unknown> = {};
  if (raw.extensions !== undefined) {
    if (isRecord(raw.extensions)) extensions = raw.extensions;
    else
      diagnostics.push(
        `${PLUGIN_MANIFEST_FILE}: extensions is not an object; ignored`,
      );
  }
  // Чужой namespace не валидируем вовсе (§8.1), свой — обязан быть объектом.
  if (IVA_NAMESPACE in extensions && !isRecord(extensions[IVA_NAMESPACE])) {
    diagnostics.push(
      `${PLUGIN_MANIFEST_FILE}: extensions["${IVA_NAMESPACE}"] is not an object; ignored`,
    );
    extensions = Object.fromEntries(
      Object.entries(extensions).filter(([key]) => key !== IVA_NAMESPACE),
    );
  }
  for (const key of Object.keys(raw)) {
    if (!MANIFEST_FIELDS.has(key))
      diagnostics.push(
        `${PLUGIN_MANIFEST_FILE}: unknown field ${JSON.stringify(key)} ignored`,
      );
  }

  return {
    name: raw.name as string,
    ...(typeof raw.version === "string" ? { version: raw.version } : {}),
    ...(typeof raw.description === "string"
      ? { description: raw.description }
      : {}),
    extensions,
  };
}

/**
 * Причина, по которой значение не годится в `command`, или null. Правило одно на
 * оба места, где Ива запускает чужой процесс: `stdio` в `mcp.json` (§7.2.1 спеки) и
 * сервис в `sh.iva/services/<svc>/service.json` (ADR-0009). `command` — ОДИН токен:
 * голое имя (ищется в `PATH`) или `./`-путь внутри `root`. Ни шелл-строки, ни
 * раскрытия плейсхолдеров. Ведущий дефис отвергаем сами: такой «исполняемый файл»
 * приезжает опцией в чужой разбор аргументов, и запускать его никто не собирается.
 */
function executableProblem(root: string, command: unknown): string | null {
  if (typeof command !== "string" || !command)
    return "command must be a string";
  if (/\s/u.test(command)) return "command must be a single token";
  if (command.startsWith("-")) return "command must not start with a dash";
  if (command.includes("${"))
    return "command does not expand ${PLUGIN_ROOT}/${PLUGIN_DATA}";
  if (command.startsWith("./")) {
    const target = containedPath(root, command);
    if (!target) return "command escapes the plugin root";
    if (target === resolve(root))
      return "command must name a file, not the root";
    return null;
  }
  if (command.includes("/") || command.includes("\\"))
    return "command must be a bare executable name or a ./-relative path";
  if (command === "." || command === "..")
    return "command must name an executable";
  return null;
}

/**
 * Раскрыть `${PLUGIN_ROOT}` и `${PLUGIN_DATA}` — ОДИН проход, без рекурсии
 * (ADR-0009). Значение, приехавшее из подстановки, дальше не разбирается: иначе
 * содержимое `<name>.env` решало бы, какие пути видит чужой процесс.
 *
 * Единственное место правила: подставляют и прокси (`services/mcp-proxy/proxy.ts`), и
 * команда, которая пишет юниты (она читает плагин через `loadPluginCore()`).
 */
export function expandPluginPlaceholders(
  value: string,
  paths: { readonly root: string; readonly data: string },
): string {
  return value.replaceAll(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/gu, (_, key) =>
    key === "PLUGIN_ROOT" ? paths.root : paths.data,
  );
}

/** Разбор одной записи `mcpServers`: сервер или причина пропуска строкой. */
function parseMcpServer(
  root: string,
  entry: unknown,
): PluginMcpServer | string {
  if (!isRecord(entry)) return "not an object";
  const type = entry.type;
  if (type !== "stdio" && type !== "streamable-http" && type !== "sse")
    return 'type must be "stdio", "streamable-http" or "sse"';

  const allowed = type === "stdio" ? STDIO_FIELDS : REMOTE_FIELDS;
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) return `unknown field ${JSON.stringify(key)}`;
  }

  if (type !== "stdio") {
    if (typeof entry.url !== "string") return "url must be a string";
    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      return "url must be an absolute http(s) URL";
    }
    // Дальше — дословные MUST спеки §7.2.1: абсолютный http(s), без user info и
    // фрагмента, http только на loopback, имена заголовков не повторяются в другом
    // регистре. Своей политики здесь нет.
    if (url.protocol !== "https:" && url.protocol !== "http:")
      return "url must be an absolute http(s) URL";
    if (url.username || url.password)
      return "url must not contain user information";
    if (url.hash) return "url must not contain a fragment";
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      /^127\.\d+\.\d+\.\d+$/u.test(url.hostname);
    if (url.protocol === "http:" && !loopback)
      return "http is allowed only for loopback URLs";
    const headers = entry.headers;
    if (headers !== undefined) {
      if (!isRecord(headers)) return "headers must be an object of strings";
      const seen = new Set<string>();
      for (const [key, value] of Object.entries(headers)) {
        if (typeof value !== "string")
          return `header ${JSON.stringify(key)} must be a string`;
        const lower = key.toLowerCase();
        if (seen.has(lower))
          return `header ${JSON.stringify(key)} is repeated in another casing`;
        seen.add(lower);
      }
    }
    return {
      type,
      url: entry.url,
      ...(isRecord(headers)
        ? { headers: headers as Record<string, string> }
        : {}),
    };
  }

  const commandProblem = executableProblem(root, entry.command);
  if (commandProblem) return commandProblem;
  const command = entry.command as string;

  const args = entry.args;
  if (args !== undefined) {
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
      return "args must be an array of strings";
  }
  const env = entry.env;
  if (env !== undefined) {
    if (!isRecord(env)) return "env must be an object of strings";
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string")
        return `env ${JSON.stringify(key)} must be a string`;
      if (key === "PLUGIN_ROOT" || key === "PLUGIN_DATA")
        return `env must not define ${JSON.stringify(key)}; the client sets it`;
    }
  }
  const cwd = entry.cwd;
  if (cwd !== undefined) {
    if (typeof cwd !== "string") return "cwd must be a string";
    if (cwd === "${PLUGIN_DATA}" || cwd.startsWith("${PLUGIN_DATA}/")) {
      // Абсолютный путь PLUGIN_DATA знает только клиент в рантайме, но подъём
      // наружу виден уже лексически — спека требует держаться внутри и здесь.
      const inside = cwd.slice("${PLUGIN_DATA}".length).replace(/^\//u, "");
      if (inside && climbsOut(inside))
        return "cwd escapes the plugin data directory";
    } else if (cwd === "${PLUGIN_ROOT}" || cwd.startsWith("${PLUGIN_ROOT}/")) {
      const inside = cwd.slice("${PLUGIN_ROOT}".length).replace(/^\//u, "");
      if (inside && !containedPath(root, inside))
        return "cwd escapes the plugin root";
    } else if (cwd.startsWith("./")) {
      if (!containedPath(root, cwd)) return "cwd escapes the plugin root";
    } else {
      return "cwd must be ./-relative, ${PLUGIN_ROOT}- or ${PLUGIN_DATA}-rooted";
    }
  }

  return {
    type,
    command,
    ...(Array.isArray(args) ? { args } : {}),
    ...(isRecord(env) ? { env: env as Record<string, string> } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
  };
}

async function readMcp(
  root: string,
  diagnostics: string[],
): Promise<Readonly<Record<string, PluginMcpServer>>> {
  const file = join(root, PLUGIN_MCP_FILE);
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      diagnostics.push(`${PLUGIN_MCP_FILE}: unreadable: ${reason(error)}`);
    return {};
  }
  const skip = (why: string): Record<string, PluginMcpServer> => {
    diagnostics.push(`${PLUGIN_MCP_FILE}: ${why}; MCP component skipped`);
    return {};
  };
  if (!stat.isFile()) return skip("not a regular file");

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    return skip(`not valid JSON (${reason(error)})`);
  }
  if (!isRecord(raw)) return skip("not a JSON object");
  if (raw.$schema !== MCP_SCHEMA_URL)
    return skip(`$schema must be ${JSON.stringify(MCP_SCHEMA_URL)}`);
  const unknown = Object.keys(raw).find(
    (key) => key !== "$schema" && key !== "mcpServers",
  );
  if (unknown !== undefined)
    return skip(
      `allows exactly $schema and mcpServers (found ${JSON.stringify(unknown)})`,
    );
  if (!isRecord(raw.mcpServers)) return skip("mcpServers must be an object");

  const servers: Record<string, PluginMcpServer> = {};
  for (const [name, entry] of Object.entries(raw.mcpServers)) {
    const server = parseMcpServer(root, entry);
    if (typeof server === "string")
      diagnostics.push(
        `${PLUGIN_MCP_FILE}: server ${JSON.stringify(name)} skipped: ${server}`,
      );
    else servers[name] = server;
  }
  return servers;
}

/** Разбор одного `service.json`: сервис или причина пропуска строкой. */
function parseService(folder: string, raw: unknown): PluginService | string {
  if (!isRecord(raw)) return "not a JSON object";
  for (const key of Object.keys(raw)) {
    if (!SERVICE_FIELDS.has(key)) return `unknown field ${JSON.stringify(key)}`;
  }
  // Команда ищется от папки сервиса, а не от корня плагина: `./`-путь в объявлении
  // читается рядом с ним, как это делает и сам сервис своим cwd.
  const problem = executableProblem(folder, raw.command);
  if (problem) return problem;
  const args = raw.args;
  if (args !== undefined) {
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
      return "args must be an array of strings";
  }
  const port = raw.port;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < MIN_SERVICE_PORT ||
    port > MAX_SERVICE_PORT
  )
    return `port must be an integer between ${MIN_SERVICE_PORT} and ${MAX_SERVICE_PORT}`;
  return {
    command: raw.command as string,
    ...(Array.isArray(args) ? { args } : {}),
    port,
  };
}

/**
 * Сервисы плагина: непосредственные дети `sh.iva/services/`, в каждом
 * `service.json`. Рекурсии нет — то же правило, что у `skills/`. Битое объявление
 * пропускается поимённо: соседний сервис поднимается.
 */
async function readServices(
  root: string,
  diagnostics: string[],
): Promise<Readonly<Record<string, PluginService>>> {
  const dir = join(root, IVA_NAMESPACE, SERVICES_DIR);
  const label = `${IVA_NAMESPACE}/${SERVICES_DIR}`;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      diagnostics.push(`${label}: unreadable: ${reason(error)}`);
    return {};
  }
  const services: Record<string, PluginService> = {};
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const folder = join(dir, entry.name);
    const file = join(folder, SERVICE_FILE);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      diagnostics.push(
        `${label}/${entry.name}: skipped: ${
          errorCode(error) === "ENOENT"
            ? `no ${SERVICE_FILE}`
            : `${SERVICE_FILE} unreadable (${reason(error)})`
        }`,
      );
      continue;
    }
    const service = parseService(folder, raw);
    if (typeof service === "string") {
      diagnostics.push(`${label}/${entry.name}: skipped: ${service}`);
      continue;
    }
    services[entry.name] = service;
  }
  return services;
}

/**
 * Прочитать папку плагина. Никогда не кидает: отчёт с `manifest: null` — это
 * отказ плагину целиком, диагностики объясняют причину.
 */
export async function readPlugin(root: string): Promise<PluginReport> {
  const resolvedRoot = resolve(root);
  const diagnostics: string[] = [];
  const rejected = (why: string): PluginReport => ({
    root: resolvedRoot,
    manifest: null,
    skills: [],
    mcp: {},
    code: false,
    services: {},
    diagnostics: [...diagnostics, why],
  });

  try {
    // Containment и потолки — ДО чтения содержимого: враждебное дерево
    // (симлинк на `~/.ssh`, файл на 10 ГБ) отвергается, не открыв ни одной цели.
    await walkPluginTree(resolvedRoot);

    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(
        await readFile(join(resolvedRoot, PLUGIN_MANIFEST_FILE), "utf8"),
      );
    } catch (error) {
      return rejected(
        errorCode(error) === "ENOENT"
          ? `not an agent plugin: no ${PLUGIN_MANIFEST_FILE} in ${resolvedRoot}`
          : `${PLUGIN_MANIFEST_FILE} unreadable: ${reason(error)}`,
      );
    }
    const manifest = parsePluginManifest(rawManifest, diagnostics);
    const listing = await listPluginSkills(resolvedRoot);
    diagnostics.push(...listing.diagnostics);
    const mcp = await readMcp(resolvedRoot, diagnostics);

    // `sh.iva/` двух видов (ADR-0009): eve Extension — это `sh.iva/package.json`,
    // сервисы — папки `sh.iva/services/<svc>/` с `service.json`. Одного без другого
    // достаточно: первый реальный плагин (`trace`) несёт только сервис.
    let hasNamespaceDir = false;
    try {
      hasNamespaceDir = (
        await lstat(join(resolvedRoot, IVA_NAMESPACE))
      ).isDirectory();
    } catch {
      // Папки нет — плагин без нашего кода и сервисов, обычное дело.
    }
    // Ключ в `extensions` — заявка автора на наш namespace, и без неё папка не
    // читается: `sh.iva/` без ключа могла приехать от клиента, который её и понимает.
    const declared = IVA_NAMESPACE in manifest.extensions;
    if (hasNamespaceDir && !declared)
      diagnostics.push(
        `${IVA_NAMESPACE}/: ignored: ${PLUGIN_MANIFEST_FILE} does not declare extensions["${IVA_NAMESPACE}"]`,
      );
    const ours = hasNamespaceDir && declared;
    let code = false;
    if (ours) {
      try {
        code = (
          await lstat(join(resolvedRoot, IVA_NAMESPACE, CODE_MANIFEST))
        ).isFile();
      } catch {
        // Нет манифеста пакета — значит нет и eve Extension: плагин без кода.
      }
    }

    return {
      root: resolvedRoot,
      manifest,
      skills: listing.skills,
      mcp,
      code,
      services: ours ? await readServices(resolvedRoot, diagnostics) : {},
      diagnostics,
    };
  } catch (error) {
    return rejected(reason(error));
  }
}
