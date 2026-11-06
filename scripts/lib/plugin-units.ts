import { systemdEnvironmentSegment } from "./systemd-values.ts";
import { launchdPlan } from "./launchd-plist.ts";
import { unitPath, launchdLabel } from "./launchd.ts";
/**
 * The systemd units of a plugin: one MCP proxy per stdio server, one unit per declared
 * service (ADR-0009).
 *
 * Units are generated here rather than shipped in `deploy/`, because there is nothing to
 * ship: their names and their arguments come from what the owner installed, which no
 * release can know. The bodies are written by hand for the same reason `ivaServiceBody()`
 * is - a template with placeholders would be a second language to get wrong - and every
 * value that reaches an `ExecStart=` goes through the systemd escaper first.
 *
 * Nothing here reads the authored tree at load time (ADR-0003): the caller hands over
 * what it already read, and the plan is a pure function of that. It is also the only
 * shape a test needs - a plan and a fake systemctl, no live units.
 */
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  realpathSync,
  renameSync,
  linkSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { systemdExecWords, systemdEnvironmentWords } from "./systemd-values.ts";
import { pluginPlistFields } from "./launchd-plist.ts";
import {
  markPluginUnit,
  pluginUnitPayload,
  pluginUnitScope,
  readPluginUnitMarker,
  scopedPluginUnitName,
  type PluginUnitIdentity,
  type PluginUnitScope,
  UNIT_PART,
} from "./plugin-unit-scope.ts";
export { pluginUnitScope, UNIT_PART };
export type { PluginUnitScope };
import { servicePath } from "../../packages/claude-command/index.ts";
import { systemdExecArgument } from "./systemd-control.ts";

type Say = (message: string) => void;

/** Candidate names only. Permission to change a unit comes from the inspector. */
export const PLUGIN_UNIT_RE = /^iva-(?:mcp|plugin)-.+\.service$/u;
/** One unit to be on disk, with the body it must have. */
export type PluginUnit = {
  readonly unit: string;
  readonly body: string;
  /** Which plugin it belongs to - what a message about it has to name. */
  readonly plugin: string;
  readonly identity: PluginUnitIdentity;
  readonly port: number;
};

/** What the units of the installation should be, and what could not be turned into one. */
export type PluginUnitPlan = {
  readonly scope: PluginUnitScope;
  readonly units: readonly PluginUnit[];
  readonly diagnostics: readonly string[];
};

function scopedIdentity(
  scope: PluginUnitScope,
  kind: PluginUnitIdentity["kind"],
  plugin: string,
  part: string,
): PluginUnitIdentity {
  return { scope, kind, plugin, part, layout: "scoped" };
}
/** The unit of the MCP proxy for one server of one plugin. */
export function mcpUnitName(
  plugin: string,
  server: string,
  scope: PluginUnitScope,
): string {
  return scopedPluginUnitName(scopedIdentity(scope, "mcp", plugin, server));
}

/** The unit of one declared service of one plugin. */
export function serviceUnitName(
  plugin: string,
  service: string,
  scope: PluginUnitScope,
): string {
  return scopedPluginUnitName(
    scopedIdentity(scope, "service", plugin, service),
  );
}

/**
 * Why this name cannot go into a unit name, or null. A plugin name is already restricted
 * by the spec, but a key in `mcp.json` and a folder under `sh.iva/services/` are not: a
 * server called `../../evil` would name a file outside the unit directory.
 */
export function unitPartProblem(kind: string, part: string): string | null {
  return UNIT_PART.test(part)
    ? null
    : `the ${kind} ${JSON.stringify(part)} cannot become a systemd unit: use letters, digits, ".", "-" and "_", starting with a letter or a digit`;
}

/** The body of an MCP proxy unit. */
export function mcpProxyUnitBody({
  plugin,
  server,
  port,
  tokenFile,
  root,
  node,
  nodeBinDir,
  dataDirEnvironment,
}: {
  readonly plugin: string;
  readonly server: string;
  readonly port: number;
  readonly tokenFile: string;
  /** The installation root; on the immutable layout this is the `current` symlink, so a
   * flip moves the proxy onto the new version without rewriting the unit. */
  readonly root: string;
  readonly node: string;
  readonly nodeBinDir: string;
  /** `ASSISTANT_DATA_DIR=…`, already escaped - the same one every other unit carries. */
  readonly dataDirEnvironment: string;
}): string {
  const argument = (value: string): string => systemdExecArgument(value);
  return [
    "[Unit]",
    `Description=Iva MCP proxy for ${plugin}/${server}`,
    "After=network-online.target",
    "",
    "[Service]",
    // The token file and whatever the MCP server writes stay private, exactly as the
    // userbot proxy's session does.
    "UMask=0077",
    `WorkingDirectory=${root}`,
    `ExecStart=/usr/bin/env ${dataDirEnvironment} ${argument(node)} ${argument(
      join(root, "services/mcp-proxy/serve.ts"),
    )} --plugin ${argument(plugin)} --server ${argument(server)} --port ${port} --token-file ${argument(tokenFile)}`,
    // No EnvironmentFile: the proxy must not have the installation's secrets to pass on.
    // User-installed CLI tools precede older global copies; npx still finds Node.
    `Environment="PATH=${servicePath(systemdEnvironmentSegment(nodeBinDir), "%h")}"`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** The body of a plugin service unit. */
export function pluginServiceUnitBody({
  plugin,
  service,
  command,
  args,
  port,
  pluginRoot,
  pluginData,
  dataDir,
  nodeBinDir,
}: {
  readonly plugin: string;
  readonly service: string;
  /** One token: a bare name found on PATH, or a `./`-path inside the service folder. */
  readonly command: string;
  /** Placeholders already expanded. */
  readonly args: readonly string[];
  /** The port Iva handed the service; it must listen on loopback only. */
  readonly port: number;
  readonly pluginRoot: string;
  readonly pluginData: string;
  /** Iva's data directory: where a service reads `trace/` from. */
  readonly dataDir: string;
  readonly nodeBinDir: string;
}): string {
  const argument = (value: string): string => systemdExecArgument(value);
  const workingDirectory = join(pluginRoot, "sh.iva/services", service);
  // A bare name is looked up on PATH by `env`; a `./`-path is the author's own file and
  // is run by its absolute path, because systemd has no cwd-relative ExecStart.
  const executable = command.startsWith("./")
    ? argument(join(workingDirectory, command.slice(2)))
    : `/usr/bin/env ${argument(command)}`;
  return [
    "[Unit]",
    `Description=Iva plugin service ${plugin}/${service}`,
    "After=network-online.target",
    "",
    "[Service]",
    "UMask=0077",
    `WorkingDirectory=${workingDirectory}`,
    `ExecStart=${executable}${args.length ? ` ${args.map(argument).join(" ")}` : ""}`,
    // The whole environment a service gets, and nothing of the agent's (ADR-0009).
    systemdEnvironment("IVA_SERVICE_PORT", String(port)),
    systemdEnvironment("IVA_DATA_DIR", dataDir),
    systemdEnvironment("PLUGIN_ROOT", pluginRoot),
    systemdEnvironment("PLUGIN_DATA", pluginData),
    // `%h` is ours and stays a specifier; only the node directory is escaped.
    `Environment="PATH=${servicePath(systemdEnvironmentSegment(nodeBinDir), "%h")}"`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * One untrusted segment of an `Environment=` value. `Environment=` is not `ExecStart=`:
 * systemd does no `$` expansion here (that happens where the command runs), so a `$` is
 * left alone, while `%` is still a specifier and a literal one has to be doubled.
 * Backslash and quote are escaped because the value ends up inside quotes, and NUL or a
 * newline is refused outright - the unit file is line-based, and a value that breaks the
 * line writes a directive nobody authored.
 */

/**
 * One whole `Environment=` directive, quoted. The quotes are the point: without them a
 * data directory with a space in it reaches the service cut at the space
 * (`/home/user/my box/iva/data` → `/home/user/my`), which is how a plugin service silently reads
 * the wrong directory.
 */
function systemdEnvironment(key: string, value: string): string {
  return `Environment="${key}=${systemdEnvironmentSegment(value)}"`;
}

/** What the caller already read about one plugin: enough to plan its units. */
export type PluginUnitSource = {
  readonly name: string;
  readonly enabled: boolean;
  readonly trusted: boolean;
  /** `PLUGIN_ROOT`: `data/custom/plugins/<name>`. */
  readonly root: string;
  /** `PLUGIN_DATA`: `data/plugin-data/<name>`. */
  readonly data: string;
  /** The stdio MCP servers of the plugin, with the port each was handed. */
  readonly mcp: readonly {
    readonly server: string;
    readonly port: number | undefined;
    readonly tokenFile: string;
  }[];
  /** The declared services of the plugin, with the port each was handed. */
  readonly services: readonly {
    readonly service: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly port: number | undefined;
  }[];
};

type PluginUnitPlanOptions = {
  readonly scope: PluginUnitScope;
  readonly plugins: readonly PluginUnitSource[];
  readonly root: string;
  readonly node: string;
  readonly nodeBinDir: string;
  readonly dataDir: string;
  readonly dataDirEnvironment: string;
};

function markPlannedUnits(units: readonly PluginUnit[]): PluginUnit[] {
  return units.map((unit) => ({
    ...unit,
    body: markPluginUnit(unit.body, unit.identity),
  }));
}

/**
 * Every unit the installation should have right now. A plugin contributes units only
 * while it is enabled AND trusted: `enabled` is the text in the prompt, `trusted` is a
 * process on the machine, and one switch for both was rejected in ADR-0009.
 */
export function pluginUnitPlan(options: PluginUnitPlanOptions): PluginUnitPlan {
  const { scope, plugins } = options;
  const units: PluginUnit[] = [];
  const diagnostics: string[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled || !plugin.trusted) continue;
    const named = unitPartProblem("plugin", plugin.name);
    if (named) {
      diagnostics.push(named);
      continue;
    }
    for (const server of plugin.mcp) {
      const problem = unitPartProblem("MCP server", server.server);
      if (problem) {
        diagnostics.push(`plugin ${plugin.name}: ${problem}`);
        continue;
      }
      if (server.port === undefined) {
        diagnostics.push(
          `plugin ${plugin.name}: the MCP server ${JSON.stringify(server.server)} has no port yet - run: iva plugin trust ${plugin.name}`,
        );
        continue;
      }
      units.push({
        plugin: plugin.name,
        unit: mcpUnitName(plugin.name, server.server, scope),
        identity: scopedIdentity(scope, "mcp", plugin.name, server.server),
        port: server.port,
        body: mcpProxyUnitBody({
          plugin: plugin.name,
          server: server.server,
          port: server.port,
          tokenFile: server.tokenFile,
          root: options.root,
          node: options.node,
          nodeBinDir: options.nodeBinDir,
          dataDirEnvironment: options.dataDirEnvironment,
        }),
      });
    }
    for (const service of plugin.services) {
      const problem = unitPartProblem("service", service.service);
      if (problem) {
        diagnostics.push(`plugin ${plugin.name}: ${problem}`);
        continue;
      }
      if (service.port === undefined) {
        diagnostics.push(
          `plugin ${plugin.name}: the service ${JSON.stringify(service.service)} has no port yet - run: iva plugin trust ${plugin.name}`,
        );
        continue;
      }
      units.push({
        plugin: plugin.name,
        unit: serviceUnitName(plugin.name, service.service, scope),
        identity: scopedIdentity(
          scope,
          "service",
          plugin.name,
          service.service,
        ),
        port: service.port,
        body: pluginServiceUnitBody({
          plugin: plugin.name,
          service: service.service,
          command: service.command,
          args: service.args,
          port: service.port,
          pluginRoot: plugin.root,
          pluginData: plugin.data,
          dataDir: options.dataDir,
          nodeBinDir: options.nodeBinDir,
        }),
      });
    }
  }
  // One unit name for two plugins: `a-b` with the server `c` and `a` with the server
  // `b-c` both want `iva-mcp-a-b-c.service`. Writing it twice would give one plugin the
  // other's process under its own name, so neither is written and both are named - the
  // same answer as two plugins on one connection file (scripts/lib/plugin-build.ts).
  const owner = new Map<string, string>();
  for (const unit of units) {
    const first = owner.get(unit.unit);
    owner.set(unit.unit, first === undefined ? unit.plugin : "");
  }
  const kept = units.filter((unit) => {
    if (owner.get(unit.unit) !== "") return true;
    const both = [
      ...new Set(
        units
          .filter((other) => other.unit === unit.unit)
          .map((other) => other.plugin),
      ),
    ].sort();
    const said = `plugins ${both.join(" and ")} both want the unit ${unit.unit}; neither is installed - remove one: iva plugin remove <name>`;
    if (!diagnostics.includes(said)) diagnostics.push(said);
    return false;
  });
  return {
    scope,
    units: markPlannedUnits(kept),
    diagnostics,
  };
}

/** What one reconcile did, so the command that asked can say it in one line. */
export type PluginUnitReconcile = {
  readonly written: readonly string[];
  readonly started: readonly string[];
  /** Units whose body changed, so the running process had to be replaced. */
  readonly restarted: readonly string[];
  /** Restart calls attempted by this reconcile, including failed confirmation. */
  readonly restartAttempted: readonly string[];
  readonly removed: readonly string[];
  readonly failures: readonly string[];
};

/**
 * Make the unit directory say what the plan says: write what belongs there, `enable
 * --now` it, and take away every plugin unit that no longer belongs.
 *
 * A unit that will not come up is a failure of that unit and of nothing else: the plugin
 * beside it still gets its own, and the state on disk was decided before this ran. The
 * caller reports the failures; it does not roll the state back, because a proxy that does
 * not start is a thing to fix, not a reason to un-trust a plugin behind the owner's back.
 */
type UnitManager = {
  readonly activate: (units: readonly string[]) => void;
  readonly restart: (units: readonly string[]) => void;
  readonly disableNow: (units: readonly string[]) => void;
  readonly daemonReload: () => unknown;
  readonly resetFailed: (units?: readonly string[]) => unknown;
  readonly query: (...args: string[]) => {
    readonly code: number;
    readonly out: string;
  };
};
type ReconcileOptions = {
  readonly plan: PluginUnitPlan;
  readonly unitDir: string;
  readonly systemd: UnitManager;
  readonly ensureDataDir?: (plugin: string) => void;
  readonly log?: Say;
  readonly manager?: "systemd" | "launchd";
  readonly root?: string;
  /** Only the current explicit plugin update's changed names may replace active legacy payloads. */
  readonly moved?: readonly string[];
};
export type PluginUnitOwner = {
  readonly name: string;
  readonly mcp?: Readonly<Record<string, { readonly port: number }>>;
  readonly services?: Readonly<Record<string, { readonly port: number }>>;
};
type UnitRef = { readonly identity: PluginUnitIdentity; readonly port: number };
type OpenUnit = {
  readonly body: string;
  readonly ino: bigint;
  readonly dev: bigint;
};
type OwnedUnit = UnitRef &
  OpenUnit & { readonly unit: string; readonly active: boolean };
export type PluginUnitInventory = {
  readonly actual: ReadonlyMap<string, OwnedUnit>;
  readonly conflicts: ReadonlySet<string>;
  readonly failures: readonly string[];
};
type InspectOptions = {
  readonly scope: PluginUnitScope;
  readonly unitDir: string;
  readonly systemd: Pick<UnitManager, "query">;
  readonly entries?: readonly PluginUnitOwner[];
  readonly units?: readonly UnitRef[];
  readonly manager?: "systemd" | "launchd";
};
const failureText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export const pluginUnitKey = (
  identity: Pick<PluginUnitIdentity, "kind" | "plugin" | "part">,
): string => JSON.stringify([identity.kind, identity.plugin, identity.part]);

/** Canonicalize existing paths; missing descendants still have a canonical parent. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" ||
      dirname(path) === path
    )
      throw error;
    return join(canonical(dirname(path)), basename(path));
  }
}
export function canonicalPluginScope(data: string): PluginUnitScope {
  return pluginUnitScope(realpathSync(data));
}
function entryRefs(
  entries: readonly PluginUnitOwner[],
  scope: PluginUnitScope,
): UnitRef[] {
  return entries.flatMap((entry) =>
    (["mcp", "services"] as const).flatMap((field) =>
      Object.entries(entry[field] ?? {}).map(([part, { port }]) => ({
        port,
        identity: {
          scope,
          kind: field === "mcp" ? ("mcp" as const) : ("service" as const),
          plugin: entry.name,
          part,
          layout: "scoped" as const,
        },
      })),
    ),
  );
}
export function pluginUnitNames(
  entry: PluginUnitOwner,
  scope: PluginUnitScope,
): string[] {
  return entryRefs([entry], scope).map((ref) =>
    scopedPluginUnitName(ref.identity),
  );
}
function openUnit(file: string): OpenUnit | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n)
      throw new Error("unit must be a regular, unlinked file");
    return { body: readFileSync(fd, "utf8"), ino: stat.ino, dev: stat.dev };
  } finally {
    closeSync(fd);
  }
}
function sameUnit(file: string, prior: OpenUnit | null): boolean {
  const now = openUnit(file);
  return prior === null
    ? now === null
    : now?.ino === prior.ino &&
        now.dev === prior.dev &&
        now.body === prior.body;
}
function rawUnitNames(unitDir: string): string[] {
  if (!existsSync(unitDir)) return [];
  return readdirSync(unitDir)
    .map((name) =>
      /^app\.iva\.iva-(mcp|plugin)-.+\.plist$/u.test(name)
        ? `${name.slice(8, -6)}.service`
        : name,
    )
    .filter((name) => PLUGIN_UNIT_RE.test(name))
    .sort();
}
type UnitFields = {
  workingDirectory: string;
  exec: string[];
  environment: Record<string, string>;
};
function bodyFields(body: string): UnitFields {
  if (body.startsWith("<?xml")) return pluginPlistFields(body);
  const one = (key: string): string => {
    const values = body
      .split("\n")
      .filter((line) => line.startsWith(`${key}=`));
    if (values.length !== 1) throw new Error(`missing or duplicate ${key}`);
    return values[0].slice(key.length + 1);
  };
  const environment: Record<string, string> = {};
  for (const line of body
    .split("\n")
    .filter((line) => line.startsWith("Environment="))) {
    for (const item of systemdEnvironmentWords(line.slice(12))) {
      const split = item.indexOf("=");
      const key = item.slice(0, split);
      if (Object.hasOwn(environment, key))
        throw new Error(`duplicate environment ${key}`);
      environment[key] = item.slice(split + 1);
    }
  }
  return {
    workingDirectory: one("WorkingDirectory"),
    exec: systemdExecWords(one("ExecStart")),
    environment,
  };
}
function option(words: readonly string[], key: string): string {
  const positions = words.flatMap((word, index) =>
    word === key ? [index] : [],
  );
  if (positions.length !== 1 || words[positions[0] + 1] === undefined)
    throw new Error(`missing or duplicate ${key}`);
  return words[positions[0] + 1];
}
function dataArgument(
  words: readonly string[],
  environment: Record<string, string>,
): string {
  const data = words.filter((word) => word.startsWith("ASSISTANT_DATA_DIR="));
  if (data.length > 1) throw new Error("duplicate ASSISTANT_DATA_DIR");
  const value = data[0]?.slice(19) ?? environment.ASSISTANT_DATA_DIR;
  if (!value) throw new Error("missing ASSISTANT_DATA_DIR");
  return canonical(value);
}
function fieldsMatch(fields: UnitFields, ref: UnitRef): boolean {
  const { identity, port } = ref;
  const { scope, plugin, part, kind } = identity;
  if (kind === "mcp")
    return (
      dataArgument(fields.exec, fields.environment) === scope.dataRoot &&
      canonical(option(fields.exec, "--token-file")) ===
        join(scope.dataRoot, "plugin-data", plugin, `mcp-${part}.token`) &&
      option(fields.exec, "--port") === String(port)
    );
  return (
    canonical(fields.workingDirectory) ===
      join(scope.dataRoot, "custom/plugins", plugin, "sh.iva/services", part) &&
    canonical(fields.environment.PLUGIN_DATA ?? "") ===
      join(scope.dataRoot, "plugin-data", plugin) &&
    fields.environment.IVA_SERVICE_PORT === String(port)
  );
}
function bodyPort(fields: UnitFields, identity: PluginUnitIdentity): number {
  return Number(
    identity.kind === "mcp"
      ? option(fields.exec, "--port")
      : fields.environment.IVA_SERVICE_PORT,
  );
}
function property(options: InspectOptions, unit: string, key: string): string {
  const result = options.systemd.query(
    "show",
    unit,
    `--property=${key}`,
    "--value",
  );
  if (result.code !== 0) throw new Error(`could not inspect ${unit}: ${key}`);
  return result.out;
}
function loadedMatches(
  options: InspectOptions,
  unit: string,
  ref: UnitRef,
): boolean {
  if (ref.identity.kind === "service")
    return (
      canonical(property(options, unit, "WorkingDirectory")) ===
      join(
        options.scope.dataRoot,
        "custom/plugins",
        ref.identity.plugin,
        "sh.iva/services",
        ref.identity.part,
      )
    );
  const raw = property(options, unit, "ExecStart");
  const argv = /argv\[\]=(.*?)(?: ;|;|$)/u.exec(raw)?.[1] ?? raw;
  return fieldsMatch(
    { workingDirectory: "", exec: systemdExecWords(argv), environment: {} },
    ref,
  );
}
function state(options: InspectOptions, unit: string): string {
  const value = property(options, unit, "LoadState");
  if (value !== "loaded" && value !== "not-found")
    throw new Error(`${unit}: unknown loaded state`);
  return value;
}
function legacyRef(
  options: InspectOptions,
  unit: string,
  opened: OpenUnit,
  { expected, fields }: { expected: readonly UnitRef[]; fields: UnitFields },
): UnitRef | null {
  if (opened.body.includes("IvaPluginUnitOwner="))
    throw new Error("invalid marker");
  if (expected.length !== 1) throw new Error("ambiguous legacy key");
  const ref = {
    ...expected[0],
    identity: { ...expected[0].identity, layout: "legacy" as const },
  };
  if (scopedPluginUnitName(ref.identity) !== unit)
    throw new Error("unmarked scoped file");
  if (fieldsMatch(fields, ref)) return ref;
  const data =
    ref.identity.kind === "service"
      ? fields.environment.IVA_DATA_DIR
      : dataArgument(fields.exec, fields.environment);
  if (data && canonical(data) !== options.scope.dataRoot) return null;
  throw new Error("legacy fields do not prove this data owner");
}
function verifiedUnit(
  options: InspectOptions,
  unit: string,
  opened: OpenUnit,
  { ref, fields }: { ref: UnitRef; fields: UnitFields },
): OwnedUnit {
  if (!fieldsMatch(fields, ref)) throw new Error("unit payload data mismatch");
  const loaded = state(options, unit);
  if (loaded === "not-found" && ref.identity.layout === "legacy")
    throw new Error("legacy loaded owner unavailable");
  if (loaded === "loaded" && !loadedMatches(options, unit, ref))
    throw new Error("loaded data owner differs from file");
  return {
    ...ref,
    ...opened,
    unit,
    active: options.systemd.query("is-active", unit).out === "active",
  };
}
function inspectCandidate(
  options: InspectOptions,
  unit: string,
  expected: readonly UnitRef[],
): OwnedUnit | null {
  const opened = openUnit(unitPath(unit, options.unitDir, options.manager));
  if (!opened) {
    if (expected.length && state(options, unit) !== "not-found")
      throw new Error("loaded unit has no owned file");
    return null;
  }
  const marker = readPluginUnitMarker(opened.body, unit);
  if (marker && marker.scope.id !== options.scope.id) return null;
  if (!marker && !expected.length) return null;
  const fields = bodyFields(opened.body);
  const ref = marker
    ? { identity: marker, port: bodyPort(fields, marker) }
    : legacyRef(options, unit, opened, { expected, fields });
  return ref ? verifiedUnit(options, unit, opened, { ref, fields }) : null;
}
function inspectionCandidates(options: InspectOptions): Map<string, UnitRef[]> {
  const refs = options.units ?? entryRefs(options.entries ?? [], options.scope);
  const candidates = new Map<string, UnitRef[]>();
  for (const ref of refs)
    for (const layout of ["scoped", "legacy"] as const) {
      const name = scopedPluginUnitName({ ...ref.identity, layout });
      candidates.set(name, [...(candidates.get(name) ?? []), ref]);
    }
  return candidates;
}
/** One inventory and one actual-name map, shared by reconcile and all consumers. */
export function inspectPluginUnits(
  options: InspectOptions,
): PluginUnitInventory {
  const candidates = inspectionCandidates(options);
  const actual = new Map<string, OwnedUnit>();
  const conflicts = new Set<string>();
  const failures: string[] = [];
  for (const unit of new Set([
    ...rawUnitNames(options.unitDir),
    ...candidates.keys(),
  ])) {
    const expected = candidates.get(unit) ?? [];
    try {
      const owned = inspectCandidate(options, unit, expected);
      if (!owned) continue;
      const key = pluginUnitKey(owned.identity);
      if (actual.has(key)) {
        conflicts.add(key);
        throw new Error("two owned representations");
      }
      actual.set(key, owned);
    } catch (error) {
      for (const ref of expected) conflicts.add(pluginUnitKey(ref.identity));
      failures.push(`${unit}: ownership unknown: ${failureText(error)}`);
    }
  }
  for (const key of conflicts) actual.delete(key);
  return { actual, conflicts, failures };
}
export function resolvedPluginUnitName(
  identity: PluginUnitIdentity,
  inventory: PluginUnitInventory,
): string | undefined {
  const key = pluginUnitKey(identity);
  if (inventory.conflicts.has(key)) return undefined;
  return inventory.actual.get(key)?.unit ?? scopedPluginUnitName(identity);
}
export function installedPluginUnits(options: InspectOptions): string[] {
  return [...inspectPluginUnits(options).actual.values()]
    .map((unit) => unit.unit)
    .sort();
}
export function runningPluginUnits(options: InspectOptions): string[] {
  const refs = options.units ?? entryRefs(options.entries ?? [], options.scope);
  const wanted = new Set(refs.map((ref) => pluginUnitKey(ref.identity)));
  return [...inspectPluginUnits(options).actual.values()]
    .filter((unit) => unit.active && wanted.has(pluginUnitKey(unit.identity)))
    .map((unit) => unit.unit);
}
function publish(file: string, body: string, prior: OpenUnit | null): void {
  const temp = join(dirname(file), `.iva-plugin-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, body, { flag: "wx", mode: 0o644 });
    if (!sameUnit(file, prior))
      throw new Error("unit changed since inspection");
    if (prior) renameSync(temp, file);
    else {
      linkSync(temp, file);
      unlinkSync(temp);
    }
  } finally {
    rmSync(temp, { force: true });
  }
}
function removeOwnedUnit(options: ReconcileOptions, unit: OwnedUnit): void {
  const { plan, unitDir, systemd, manager = "systemd" } = options;
  const file = unitPath(unit.unit, unitDir, manager);
  const inspected = { ...options, scope: plan.scope };
  if (
    !sameUnit(file, unit) ||
    (state(inspected, unit.unit) === "loaded" &&
      !loadedMatches(inspected, unit.unit, unit))
  )
    throw new Error("stale unit ownership changed");
  systemd.disableNow([unit.unit]);
  if (
    !["inactive", "failed", "unknown"].includes(
      systemd.query("is-active", unit.unit).out,
    )
  )
    throw new Error("unit did not stop");
  if (!sameUnit(file, unit)) throw new Error("unit changed during stop");
  resetUnitFailure(systemd, unit.unit);
  rmSync(file);
  systemd.daemonReload();
}
function resetUnitFailure(
  systemd: ReconcileOptions["systemd"],
  unit: string,
): void {
  try {
    systemd.resetFailed([unit]);
  } catch {
    return; // Resetting a previous failure is optional.
  }
}
function renderPluginUnit(
  unit: string,
  body: string,
  options: ReconcileOptions,
  before: OwnedUnit | null,
): string {
  if (
    before?.active &&
    before.identity.layout === "legacy" &&
    !options.moved?.includes(before.identity.plugin)
  )
    return markPluginUnit(before.body, before.identity);
  if (options.manager !== "launchd") return body;
  return launchdPlan([{ unit, body }], { root: options.root ?? "" }).get(
    launchdLabel(unit),
  )!;
}
function writePlannedUnit(
  options: ReconcileOptions,
  planned: PluginUnit,
  before: OwnedUnit | null,
) {
  const identity = before?.identity ?? planned.identity;
  const unit = before?.unit ?? planned.unit;
  const body = markPluginUnit(pluginUnitPayload(planned.body), identity);
  const rendered = renderPluginUnit(unit, body, options, before);
  const file = unitPath(unit, options.unitDir, options.manager);
  if (Buffer.byteLength(basename(file)) > 255)
    throw new Error("plugin unit filename exceeds 255 bytes");
  const changed =
    before !== null &&
    pluginUnitPayload(before.body) !== pluginUnitPayload(rendered);
  const written = before?.body !== rendered;
  if (written) publish(file, rendered, before);
  return { unit, changed, written };
}
function applyPlannedUnit(
  options: ReconcileOptions,
  planned: PluginUnit,
  before: OwnedUnit | null,
  done: { [K in keyof PluginUnitReconcile]: string[] },
): void {
  const { unit, changed, written } = writePlannedUnit(options, planned, before);
  if (written) done.written.push(unit);
  if (before?.active && !changed) return;
  options.ensureDataDir?.(planned.plugin);
  options.systemd.daemonReload();
  resetUnitFailure(options.systemd, unit);
  options.systemd.activate([unit]);
  done.started.push(unit);
  if (changed) {
    done.restartAttempted.push(unit);
    options.systemd.restart([unit]);
    done.restarted.push(unit);
  }
}
export function reconcilePluginUnits(
  options: ReconcileOptions,
): PluginUnitReconcile {
  const { plan, unitDir } = options;
  mkdirSync(unitDir, { recursive: true });
  const inspected = inspectPluginUnits({
    ...options,
    scope: plan.scope,
    units: plan.units,
  });
  const wanted = new Set(
    plan.units.map((unit) => pluginUnitKey(unit.identity)),
  );
  const done = {
    written: [] as string[],
    started: [] as string[],
    restarted: [] as string[],
    restartAttempted: [] as string[],
    removed: [] as string[],
    failures: [...inspected.failures],
  };
  for (const [key, unit] of inspected.actual) {
    if (wanted.has(key)) continue;
    try {
      removeOwnedUnit(options, unit);
      done.removed.push(unit.unit);
    } catch (error) {
      done.failures.push(`${unit.unit}: ${failureText(error)}`);
    }
  }
  for (const planned of plan.units.filter(
    (unit) => !inspected.conflicts.has(pluginUnitKey(unit.identity)),
  )) {
    const key = pluginUnitKey(planned.identity);
    const before = inspected.actual.get(key) ?? null;
    const name = resolvedPluginUnitName(planned.identity, inspected)!;
    try {
      applyPlannedUnit(options, planned, before, done);
    } catch (error) {
      done.failures.push(`${name}: ${failureText(error)}`);
    }
  }
  if (done.removed.length)
    options.log?.(
      `removed ${done.removed.length} plugin unit(s) that no longer belong`,
    );
  return done;
}
