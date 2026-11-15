/**
 * Marketplace: a list of plugins in a git repository, name to source.
 *
 * The file is `.agents/plugins/marketplace.json` in the convention of Codex
 * (ADR-0009): one `name`, then `plugins[]` with `name`, `source` and an optional
 * `description`. A list in a repository is all it is: no central place, no
 * moderation, nobody's approval to publish. Ours by default is `smixs/iva-plugins`;
 * the owner adds his own next to it.
 *
 * Two rules shape everything here.
 *
 * The file is UNTRUSTED input. It arrives from a repository nobody vetted, so the
 * parser never throws, never trusts a type, and never lets one broken entry take
 * the file down with it: a plugin whose source cannot be used is skipped by name,
 * with a diagnostic, and the rest of the list keeps working. Sources we do not
 * install (`npm`) and fields we do not read (`policy`, `interface`, anything new)
 * are ignored the same way - out loud.
 *
 * A resolved entry becomes a plugin SOURCE STRING, not a special install path.
 * `plugins.json` records source strings and `iva plugin sync` replays them, so an
 * entry that could only be installed "through the marketplace" would be an entry
 * that cannot be restored. That is why a `local` path becomes a subdirectory of the
 * marketplace repository pinned to the commit we read the list at.
 *
 * Nothing here reaches into the authored tree: the CLI has to run on an
 * installation whose `agent/` is missing (ADR-0003), so the git runner arrives as a
 * type-only import and the caller passes its own.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GitRunner } from "./plugin-install.ts";
import {
  isScpLikeUrl,
  parsePluginSource,
  positional,
  type PluginSource,
} from "./plugin-source.ts";
import { isRecord } from "../../packages/guards/index.ts";

/** Ours, implicit while the owner's list is empty (ADR-0009). */
export const DEFAULT_MARKETPLACE = "smixs/iva-plugins";

/** Where the list lives inside the repository - the convention of Codex. */
export const MARKETPLACE_FILE = ".agents/plugins/marketplace.json";

/** Where a marketplace source says one plugin comes from. */
export type MarketplaceEntrySource =
  /** A path inside the marketplace repository itself. */
  | { readonly kind: "local"; readonly path: string }
  /** A repository of its own. */
  | {
      readonly kind: "url";
      readonly url: string;
      readonly ref: string | null;
      readonly sha: string | null;
    }
  /** A subdirectory of another repository. */
  | {
      readonly kind: "git-subdir";
      readonly url: string;
      readonly path: string;
      readonly ref: string | null;
      readonly sha: string | null;
    };

export type MarketplaceEntry = {
  readonly name: string;
  readonly description: string;
  readonly source: MarketplaceEntrySource;
};

export type Marketplace = {
  /** `null` - the file is unusable as a whole; diagnostics say why. */
  readonly name: string | null;
  readonly entries: readonly MarketplaceEntry[];
  /** Everything skipped or ignored, by name. No silent losses. */
  readonly diagnostics: readonly string[];
};

/** English first, Russian second - the CLI passes its own (`#lib/i18n.ts`). */
export type Translate = (en: string, ru: string) => string;

/** The marketplace repository a `local` entry is resolved against. */
export type MarketplaceRepo = {
  /** Git URL of the repository holding the list. */
  readonly url: string;
  /** Commit lying in the cache: what a `local` entry gets pinned to. */
  readonly sha: string;
};

export type MarketplaceCache = {
  readonly path: string;
  /** Commit in the cache; empty when there is nothing cached at all. */
  readonly sha: string;
  /** The remote could not be reached and the cached copy is what we have. */
  readonly stale: boolean;
  /** Why the refresh failed, one line; `null` when it did not. */
  readonly problem: string | null;
};

/**
 * A bare plugin name, optionally with the marketplace to take it from. `null`
 * means "this is not a name" - the caller hands the string to the source parser.
 *
 * This is routing, not validation: whether the name is a legal plugin name is
 * decided by the manifest the install reads (§5.5, agent/lib/plugin-reader.ts).
 * No source form can be mistaken for a name - every one of them carries a `/`,
 * a `:` or a leading `.`, `~`, `/`.
 */
const SIMPLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
// Квалификатор `<имя>@<чей список>` — имя Marketplace ИЛИ строка его источника.
// Двоеточие и второй `@` исключены: с ними строка была бы законной формой источника
// (`git@host:path`), и запрос имени украл бы её.
const QUALIFIER = /^[^\s:@]+$/u;
const NAME_REQUEST = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:@([^\s:@]+))?$/u;

/** Годится ли строка источника в квалификатор, который владелец может набрать. */
export function isMarketplaceQualifier(value: string): boolean {
  return QUALIFIER.test(value);
}

export function parseMarketplaceRequest(
  raw: string,
): { readonly name: string; readonly marketplace: string | null } | null {
  const match = NAME_REQUEST.exec(raw.trim());
  if (!match) return null;
  return { name: match[1], marketplace: match[2] ?? null };
}

/** A string field that is present and not empty, or null. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** `ref`/`sha`: a string, or absent - `null` is how the convention writes "none". */
function pinField(
  value: unknown,
  field: string,
): { readonly value: string | null } | { readonly problem: string } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== "string")
    return { problem: `${field} must be a string` };
  return { value: value.trim() || null };
}

/**
 * Which URLs a marketplace may name, as a list of what is allowed.
 *
 * A blacklist would be the wrong shape here: the file is untrusted, so the question
 * is not "which schemes are dangerous" but "which ones do we know are safe to hand
 * to git for a stranger". `file://` is the reason the rule exists - it points the
 * install at a repository on the owner's own disk and runs that repository's
 * `upload-pack` hooks; `http://` hands the plugin's bytes to whoever answers first.
 * A `local` entry is not affected: it names a folder of the marketplace repository
 * itself, so its URL is the one we already fetched the list from.
 */
const ALLOWED_URL_SCHEMES = ["https://", "ssh://"] as const;

function remoteUrlProblem(url: string): string | null {
  const value = url.trim().toLowerCase();
  if (ALLOWED_URL_SCHEMES.some((scheme) => value.startsWith(scheme)))
    return null;
  if (isScpLikeUrl(url)) return null;
  return `source.url ${JSON.stringify(url)} is not a remote repository; a marketplace may name only https://, ssh:// or git@host:path`;
}

const ENTRY_FIELDS = new Set(["name", "source", "description"]);
const MARKETPLACE_FIELDS = new Set(["name", "plugins"]);
const SOURCE_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  local: new Set(["source", "path"]),
  url: new Set(["source", "url", "ref", "sha"]),
  "git-subdir": new Set(["source", "url", "path", "ref", "sha"]),
};

/**
 * A path inside a repository: relative, POSIX, no climbing out. `./x` is how the
 * convention writes it and means the same as `x`.
 */
function insidePath(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("~"))
    return null;
  const parts = trimmed.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

/** One `source` value: the parsed form, or the reason it cannot be used. */
function parseEntrySource(
  raw: unknown,
  diagnostics: string[],
  label: string,
): MarketplaceEntrySource | string {
  if (typeof raw === "string") {
    const path = insidePath(raw);
    return path
      ? { kind: "local", path }
      : `source ${JSON.stringify(raw)} is not a path inside the marketplace`;
  }
  if (!isRecord(raw)) return "source must be a string or an object";

  const kind = raw.source;
  if (typeof kind !== "string") return "source.source must be a string";
  // npm is a real form of the convention and not a plugin folder: Iva installs
  // folders (ADR-0008), so the entry is skipped by name rather than half-read.
  if (kind === "npm")
    return "npm sources are not installed by Iva, only plugin folders";
  const allowed = SOURCE_FIELDS[kind];
  if (!allowed) return `unknown source type ${JSON.stringify(kind)}`;
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key))
      diagnostics.push(`${label}: source field ${JSON.stringify(key)} ignored`);
  }

  if (kind === "local") {
    const path = text(raw.path);
    if (!path) return "source.path must be a string";
    const inside = insidePath(path);
    return inside
      ? { kind: "local", path: inside }
      : `source.path ${JSON.stringify(path)} is not a path inside the marketplace`;
  }

  const url = text(raw.url);
  if (!url) return "source.url must be a string";
  const urlProblem = remoteUrlProblem(url);
  if (urlProblem) return urlProblem;
  const ref = pinField(raw.ref, "source.ref");
  if ("problem" in ref) return ref.problem;
  const sha = pinField(raw.sha, "source.sha");
  if ("problem" in sha) return sha.problem;

  if (kind === "url")
    return { kind: "url", url, ref: ref.value, sha: sha.value };

  const path = text(raw.path);
  if (!path) return "source.path must be a string";
  const inside = insidePath(path);
  if (!inside)
    return `source.path ${JSON.stringify(path)} is not a path inside the repository`;
  return {
    kind: "git-subdir",
    url,
    path: inside,
    ref: ref.value,
    sha: sha.value,
  };
}

/**
 * Any JSON into a marketplace. Never throws: an unusable file gives `name: null`,
 * an unusable entry is skipped by name, and every loss shows up in diagnostics.
 */
export function parseMarketplace(raw: unknown): Marketplace {
  const diagnostics: string[] = [];
  const rejected = (why: string): Marketplace => ({
    name: null,
    entries: [],
    diagnostics: [...diagnostics, why],
  });
  if (!isRecord(raw)) return rejected("must be a JSON object");
  const name = text(raw.name);
  if (!name) return rejected("name must be a non-empty string");
  // Имя списка — то, чем владелец его называет в `add <плагин>@<список>`. Имя с
  // пробелом или двоеточием набрать нельзя, значит плагины такого списка недостижимы:
  // отказываем файлу, а не оставляем его наполовину рабочим.
  if (!SIMPLE_NAME.test(name))
    return rejected(
      `name ${JSON.stringify(name)} must be letters, digits, dots and dashes, starting alphanumeric`,
    );

  for (const key of Object.keys(raw)) {
    if (!MARKETPLACE_FIELDS.has(key))
      diagnostics.push(`field ${JSON.stringify(key)} ignored`);
  }
  if (raw.plugins === undefined)
    return { name, entries: [], diagnostics: [...diagnostics, "no plugins"] };
  if (!Array.isArray(raw.plugins))
    return {
      name,
      entries: [],
      diagnostics: [...diagnostics, "plugins must be an array; none read"],
    };

  const entries: MarketplaceEntry[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.plugins.entries()) {
    const position = `plugins[${index}]`;
    if (!isRecord(item)) {
      diagnostics.push(`${position} skipped: not an object`);
      continue;
    }
    const entryName = text(item.name);
    // Имя записи — ключ поиска, а не путь: в файловую систему оно не попадает
    // (папку плагина называет манифест). Поэтому проверка мягкая.
    if (!entryName || !SIMPLE_NAME.test(entryName)) {
      diagnostics.push(`${position} skipped: name must be a plain plugin name`);
      continue;
    }
    if (seen.has(entryName)) {
      diagnostics.push(`${entryName} skipped: the name is listed twice`);
      continue;
    }
    for (const key of Object.keys(item)) {
      if (!ENTRY_FIELDS.has(key))
        diagnostics.push(`${entryName}: field ${JSON.stringify(key)} ignored`);
    }
    if (item.source === undefined) {
      diagnostics.push(`${entryName} skipped: no source`);
      continue;
    }
    const source = parseEntrySource(item.source, diagnostics, entryName);
    if (typeof source === "string") {
      diagnostics.push(`${entryName} skipped: ${source}`);
      continue;
    }
    seen.add(entryName);
    entries.push({
      name: entryName,
      description: text(item.description) ?? "",
      source,
    });
  }
  return { name, entries, diagnostics };
}

/** The list out of a cached marketplace repository. Never throws. */
async function readMarketplace(cache: string): Promise<Marketplace> {
  const file = join(cache, ...MARKETPLACE_FILE.split("/"));
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      name: null,
      entries: [],
      diagnostics: [
        code === "ENOENT"
          ? `no ${MARKETPLACE_FILE} in the repository`
          : `${MARKETPLACE_FILE} unreadable: ${(error as Error).message}`,
      ],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      name: null,
      entries: [],
      diagnostics: [
        `${MARKETPLACE_FILE} is not valid JSON (${(error as Error).message})`,
      ],
    };
  }
  return parseMarketplace(parsed);
}

/** Where every cached marketplace lives. Never outside the data directory. */
function marketplaceCacheRoot(dataDir: string): string {
  return join(dataDir, "marketplace-cache");
}

/**
 * A directory name for one source string: the readable part of it plus a digest
 * of the whole. The sanitizer leaves only `[A-Za-z0-9._-]` and collapses repeated
 * dots, so a slug holds neither a separator nor `..` and can never be `.` or `..`
 * itself; the digest keeps two sources that sanitize alike out of one directory.
 */
export function marketplaceSlug(source: string): string {
  const readable = source
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/\.{2,}/gu, ".")
    .replace(/^[.-]+/u, "")
    .slice(0, 40);
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 8);
  return `${readable || "marketplace"}-${digest}`;
}

export function marketplaceCachePath(dataDir: string, source: string): string {
  return join(marketplaceCacheRoot(dataDir), marketplaceSlug(source));
}

/**
 * The URL git is asked for. A local marketplace is a git repository too, and
 * `file://` is what makes it one source form instead of two: the plugin source
 * strings resolved out of it stay strings a later `sync` can replay.
 */
function marketplaceRepoUrl(source: PluginSource): string {
  return source.kind === "local"
    ? `file://${resolve(source.path)}`
    : source.url;
}

function firstLine(output: string): string {
  return (
    output
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

/** What lies in the cache right now, without asking the network. Empty - nothing does. */
function cachedMarketplaceSha(git: GitRunner, cache: string): string {
  if (!existsSync(join(cache, ".git"))) return "";
  const head = git(["rev-parse", "HEAD"], cache);
  return head.code === 0 ? head.out.trim() : "";
}

/**
 * Bring the cached copy of a marketplace up to date, shallow.
 *
 * One road for the first fetch and every later one - `init`, `remote add`,
 * `fetch --depth 1`, `checkout FETCH_HEAD` - which is the same road the installer
 * drives (`plugin-install.ts`), minus the blob filter: the list itself is a blob,
 * and a lazy one would need the network exactly where there is none. A failed
 * fetch over a warm cache is not an error: the cached list is served and told to
 * be stale.
 */
function refreshMarketplaceCache(
  git: GitRunner,
  dataDir: string,
  source: string,
  parsed: PluginSource,
): MarketplaceCache {
  const path = marketplaceCachePath(dataDir, source);
  const url = marketplaceRepoUrl(parsed);
  const ref = parsed.kind === "git" && parsed.ref ? parsed.ref : "HEAD";
  positional([url, ref]);

  const failed = (why: string): MarketplaceCache => {
    const sha = cachedMarketplaceSha(git, path);
    return { path, sha, stale: sha !== "", problem: why || "git failed" };
  };

  if (!existsSync(join(path, ".git"))) {
    // Половина инициализации от прерванного прогона: начинаем заново, а не поверх.
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { recursive: true });
    const started = git(["init", "-q"], path);
    if (started.code !== 0)
      return failed(firstLine(started.err || started.out));
    const remote = git(
      ["remote", "add", "--", "origin", ...positional([url])],
      path,
    );
    if (remote.code !== 0) return failed(firstLine(remote.err || remote.out));
  }

  const fetched = git(
    ["fetch", "--depth", "1", "--", "origin", ...positional([ref])],
    path,
  );
  if (fetched.code !== 0) return failed(firstLine(fetched.err || fetched.out));
  const checked = git(["checkout", "-q", "FETCH_HEAD"], path);
  if (checked.code !== 0) return failed(firstLine(checked.err || checked.out));
  const sha = cachedMarketplaceSha(git, path);
  if (!sha) return failed("the fetched commit could not be read");
  return { path, sha, stale: false, problem: null };
}

// Только https: `owner/repo` разворачивается обратно именно в него, поэтому свернуть
// туда ssh- или scp-адрес значило бы молча сменить транспорт — и приватный репозиторий
// после этого спрашивал бы пароль там, где владелец дал ключ.
const GITHUB_HTTPS_REPO =
  /^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/u;

/**
 * `owner/repo` when the URL is a GitHub repository. The shorthand is what the
 * owner types and reads, so a resolved source uses it whenever it can - and only
 * when the result really parses, which keeps the source grammar the one authority
 * on what a shorthand may hold.
 */
function withSubdir(url: string, path: string): string {
  const match = GITHUB_HTTPS_REPO.exec(url);
  if (match) {
    const candidate = `${match[1]}/${match[2]}/${path}`;
    try {
      parsePluginSource(candidate);
      return candidate;
    } catch {
      // Не выражается shorthand'ом — остаётся форма URL с разделителем `//`.
    }
  }
  return `${url}//${path}`;
}

/**
 * A source string as a git source, or an error. A Marketplace may only point at
 * repositories: `{"source":"url","url":"./plugins/x"}` parses perfectly well as a
 * local folder, and honouring it would let an untrusted file install from a path
 * on the owner's disk - and have `sync` replay that path forever. Found by the
 * property test, not by reading the code.
 */
function gitSource(written: string): PluginSource {
  const parsed = parsePluginSource(written);
  if (parsed.kind !== "git")
    throw new Error(
      `${JSON.stringify(written)} is a local path, and a marketplace may only point at a repository`,
    );
  return parsed;
}

/**
 * One marketplace entry as a plugin source. Throws when the entry cannot be
 * expressed as one - the caller reports that as a skipped entry, by name.
 *
 * A `local` entry is pinned to the commit the list was read at: the marketplace
 * says "this folder of mine", and the folder only means one thing at one commit.
 */
export function marketplaceEntrySource(
  entry: MarketplaceEntry,
  repo: MarketplaceRepo,
): PluginSource {
  const source = entry.source;
  if (source.kind === "local") {
    if (!repo.sha)
      throw new Error(
        "the marketplace has no cached commit to pin its own folder to",
      );
    return gitSource(`${withSubdir(repo.url, source.path)}@${repo.sha}`);
  }
  // sha пинует, ref отслеживает; когда нет ни того, ни другого — HEAD источника.
  const pin = source.sha ?? source.ref;
  const at = pin ? `@${pin}` : "";
  return gitSource(
    source.kind === "url"
      ? `${source.url}${at}`
      : `${withSubdir(source.url, source.path)}${at}`,
  );
}

/** Один Marketplace целиком: что записано, что лежит в кэше, что прочитано. */
export type LoadedMarketplace = {
  /** Строка источника ровно как в `plugins.json`. */
  readonly recorded: string;
  /** Имя из файла, а пока файла нет — сама строка источника. */
  readonly label: string;
  readonly market: Marketplace;
  /** URL и коммит кэша: то, к чему пинуется запись `local`. Нет кэша — `null`. */
  readonly repo: MarketplaceRepo | null;
  readonly stale: boolean;
  readonly problem: string | null;
};

const EMPTY: Marketplace = { name: null, entries: [], diagnostics: [] };

/** Список владельца; пустой означает наш Marketplace по умолчанию (ADR-0009). */
export function marketplaceSources(
  recorded: readonly string[],
): readonly string[] {
  return recorded.length ? recorded : [DEFAULT_MARKETPLACE];
}

/**
 * Один Marketplace с диска. Кэш обновляется только когда команда за этим и
 * пришла (`add <name>`, `list --available`) — `marketplace list` печатает то, что
 * уже лежит, и в сеть не идёт.
 */
export async function loadMarketplace(
  git: GitRunner,
  dataDir: string,
  recorded: string,
  refresh: boolean,
): Promise<LoadedMarketplace> {
  let parsed: PluginSource;
  try {
    parsed = parsePluginSource(recorded);
  } catch (error) {
    return {
      recorded,
      label: recorded,
      market: EMPTY,
      repo: null,
      stale: false,
      problem: (error as Error).message,
    };
  }
  const path = marketplaceCachePath(dataDir, recorded);
  const cache = refresh
    ? refreshMarketplaceCache(git, dataDir, recorded, parsed)
    : {
        path,
        sha: cachedMarketplaceSha(git, path),
        stale: false,
        problem: null,
      };
  const market = cache.sha ? await readMarketplace(cache.path) : EMPTY;
  return {
    recorded,
    label: market.name ?? recorded,
    market,
    repo: cache.sha
      ? { url: marketplaceRepoUrl(parsed), sha: cache.sha }
      : null,
    stale: cache.stale,
    problem: cache.problem,
  };
}

export async function loadMarketplaces(
  git: GitRunner,
  dataDir: string,
  recorded: readonly string[],
  refresh: boolean,
): Promise<readonly LoadedMarketplace[]> {
  const all: LoadedMarketplace[] = [];
  for (const source of marketplaceSources(recorded))
    all.push(await loadMarketplace(git, dataDir, source, refresh));
  return all;
}

/**
 * Имя → источник плагина. Одно имя в двух Marketplace остаётся выбором владельца:
 * молча взять первый значило бы поставить чужой плагин под знакомым именем.
 */
export function resolveMarketplacePlugin(
  all: readonly LoadedMarketplace[],
  request: { readonly name: string; readonly marketplace: string | null },
  translate: Translate = (en) => en,
): {
  readonly source: PluginSource;
  readonly marketplace: string;
  readonly name: string;
} {
  // Квалификатор называет список либо именем из файла, либо строкой источника: имя
  // живёт в чужом файле и может смениться, а источник записал сам владелец.
  const searched = request.marketplace
    ? all.filter(
        (one) =>
          one.market.name === request.marketplace ||
          one.recorded === request.marketplace,
      )
    : all;
  if (request.marketplace && searched.length === 0)
    throw new Error(
      translate(
        `no marketplace named ${JSON.stringify(request.marketplace)} — iva plugin marketplace list`,
        `маркетплейса ${JSON.stringify(request.marketplace)} в списке нет — iva plugin marketplace list`,
      ),
    );
  const hits = searched.flatMap((one) => {
    const entry = one.market.entries.find((item) => item.name === request.name);
    return entry ? [{ one, entry }] : [];
  });
  if (hits.length === 0)
    throw new Error(
      translate(
        `no marketplace offers a plugin named ${JSON.stringify(request.name)} — iva plugin list --available`,
        `ни один маркетплейс не предлагает плагин ${JSON.stringify(request.name)} — iva plugin list --available`,
      ),
    );
  if (hits.length > 1) {
    // Две записи под одним именем — подсказка обязана называть источники, иначе
    // `add <имя>@<имя списка>` привёл бы ровно к этому же отказу.
    const labels = hits.map((hit) => hit.one.label);
    const clash = new Set(labels).size !== labels.length;
    const named = hits.map((hit) =>
      clash ? `${hit.one.label} (${hit.one.recorded})` : hit.one.label,
    );
    const qualifier = clash ? hits[0].one.recorded : hits[0].one.label;
    // Строку источника со схемой набрать квалификатором нельзя: тогда выход — снять
    // один из списков, и это тоже надо сказать, а не оставить владельца в тупике.
    const how = isMarketplaceQualifier(qualifier)
      ? translate(
          `pick one: iva plugin add ${request.name}@${qualifier}`,
          `выбери один: iva plugin add ${request.name}@${qualifier}`,
        )
      : translate(
          `drop one of them: iva plugin marketplace remove ${qualifier}`,
          `сними один из них: iva plugin marketplace remove ${qualifier}`,
        );
    throw new Error(
      translate(
        `${request.name} is offered by ${named.join(" and ")} — ${how}`,
        `${request.name} предлагают ${named.join(" и ")} — ${how}`,
      ),
    );
  }
  const [{ one, entry }] = hits;
  if (!one.repo)
    throw new Error(
      translate(
        `${one.label} has no cached list — run: iva plugin list --available`,
        `у ${one.label} нет прочитанного списка — запусти: iva plugin list --available`,
      ),
    );
  try {
    return {
      source: marketplaceEntrySource(entry, one.repo),
      marketplace: one.label,
      name: entry.name,
    };
  } catch (error) {
    throw new Error(
      translate(
        `${one.label} offers ${entry.name}, but its source cannot be used: ${(error as Error).message}`,
        `${one.label} предлагает ${entry.name}, но её источник непригоден: ${(error as Error).message}`,
      ),
      { cause: error },
    );
  }
}
