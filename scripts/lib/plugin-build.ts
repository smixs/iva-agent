/**
 * The code of a plugin inside the build of a version (ADR-0009).
 *
 * A plugin's code is an eve Extension under `sh.iva/`, and the only place it is ever
 * built is a version build: copy the plugin into the version, install its production
 * dependencies, build the extension with the version's own eve, and generate the mount
 * that makes eve pick it up. Nothing here starts, flips or restarts anything - the rails
 * are the updater's (scripts/lib/version-update.ts), so a plugin arrives the same way a
 * release does: build, probe, flip, restart.
 *
 * The plugin store lives in the authored tree, which `iva` and the updater's second half
 * must load without (ADR-0003, scripts/authored-tree-guard.test.ts). Everything from
 * `agent/` is therefore reached through `tryLoadPluginCore()`, and a missing tree is a
 * diagnostic, not a crash: a version that cannot read its plugins still builds.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginMcpServer } from "#lib/plugin-reader.ts";
import { tryLoadPluginCore } from "./plugin-core.ts";
/**
 * Форма запуска внешней команды. Своя подпись, а не импорт `Runner` из
 * `version-update.ts`: тот зовёт этот модуль как значение, и стёртый `import type` всё
 * равно замыкал цикл (madge видит и типовые рёбра, B4b).
 */
type Runner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<{ readonly code: number; readonly output: string }>;

type Say = (message: string) => void;

/** Folder eve reads mounts from; the file name in it is the namespace. */
const MOUNT_DIR = "agent/extensions";
/** Folder eve reads connections from; the file name in it is the connection name. */
const CONNECTION_DIR = "agent/connections";
/**
 * What eve 0.51.1 accepts as a connection file name (its CONNECTION_SLUG_PATTERN):
 * lowercase letters, digits and dashes, starting with a letter. No underscores and no
 * dots - so `<namespace>__<server>` is not a name eve would register. Verified against
 * the installed package on 2026-09-04.
 */
const CONNECTION_SLUG = /^[a-z][a-z0-9-]{0,63}$/u;
/**
 * Prefix of every generated connection. It keeps a plugin off the names Iva authors
 * herself (`telegram-userbot`), and it makes a plugin whose name starts with a digit -
 * which the spec allows and eve's first-letter rule does not - nameable at all.
 */
const CONNECTION_PREFIX = "mcp-";
/** Separator between the plugin part and the server part; neither part can contain it. */
const CONNECTION_JOIN = "--";
/** Where a version keeps the copies it builds plugin code from. */
const PLUGIN_DIR = "plugins";
/** The namespace folder of a plugin's code, as ADR-0009 pins it. */
const CODE_DIR = "sh.iva";
/** The version's own eve: a plugin is always built by the eve that will run it. */
const EVE_BIN = "node_modules/.bin/eve";
const EVE_BUILD = ["extension", "build"];
/**
 * What a plugin's own dependencies are installed with.
 *
 * `--omit=peer` is the load-bearing flag. eve's own extension scaffold declares `eve` in
 * `peerDependencies`, and npm installs peers by default: without the flag, a plugin whose
 * only dependency is that peer gets a second copy of eve of its own, and its extension is
 * then built against that eve instead of the one about to run it - the compatibility
 * ADR-0009 promises. Declaring is enough for eve: its package boundary resolves the
 * declaration up the tree and finds the version's own eve (verified on 0.51.1 on
 * 2026-09-04).
 */
const PLUGIN_INSTALL = ["--omit=dev", "--omit=peer", "--no-audit", "--no-fund"];
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"];
/**
 * The lowercase subset of eve 0.51.1's EXTENSION_SLUG_PATTERN. Agent Plugin names are
 * lowercase already. Verified against the installed package on 2026-09-04.
 */
const MOUNT_SLUG = /^[a-z][a-z0-9_]{0,63}$/u;
/** Enough of a failed step to explain it, little enough to fit a chat message. */
const OUTPUT_TAIL = 4000;

/** One generated eve connection: the MCP server of a plugin as the agent sees it. */
export type PluginConnection = {
  /** The server's name in `mcp.json`. */
  readonly server: string;
  /** The connection name eve derives from the file name. */
  readonly name: string;
  /** The file inside a version: `agent/connections/<name>.ts`. */
  readonly file: string;
  readonly source: string;
};

export type CodePlugin = {
  readonly name: string;
  /** The plugin in the Custom layer: `data/custom/plugins/<name>`. */
  readonly root: string;
  /** Mount file name, and therefore the prefix of every tool the plugin contributes. */
  readonly namespace: string;
  /** The mount inside a version: `agent/extensions/<ns>.ts`. */
  readonly mount: string;
  /** The copy inside a version: `plugins/<name>`. */
  readonly directory: string;
  /** Digest of the folder as it lies now - what the version is built from. */
  readonly digest: string;
  /** `<name>.config.json` as written, or "" - part of what names the version. */
  readonly config: string;
  /**
   * Does the plugin carry an eve Extension to build (`sh.iva/package.json`)? A plugin
   * with only MCP servers is here for its connections and has no mount and no copy.
   */
  readonly extension: boolean;
  /** The connections this plugin contributes; empty unless it is enabled and trusted. */
  readonly connections: readonly PluginConnection[];
};

export type CodePlugins = {
  readonly plugins: readonly CodePlugin[];
  /** Everything skipped, by name: a plugin left out silently is a lost capability. */
  readonly diagnostics: readonly string[];
};

/** One plugin the build refused, with the output that says why. */
export type PluginFailure = {
  readonly name: string;
  /** Which content failed: a changed plugin is a new problem and speaks at once. */
  readonly digest: string;
  readonly reason: string;
};

/** The mount namespace of a plugin: its name with `.` and `-` folded to `_`. */
export function pluginNamespace(name: string): string {
  return name.replace(/[.-]/gu, "_");
}

/** The mount of a plugin inside a version, relative to its root. */
export function pluginMount(name: string): string {
  return `${MOUNT_DIR}/${pluginNamespace(name)}.ts`;
}

/** The copy of a plugin inside a version, relative to its root. */
export function pluginDirectory(name: string): string {
  return `${PLUGIN_DIR}/${name}`;
}

/**
 * Why this plugin cannot carry code, or null. The mount file name is the namespace,
 * and eve accepts a letter first and then letters, digits and underscores - a plugin
 * name is allowed to start with a digit, so this is a real refusal, not a formality.
 */
export function namespaceProblem(name: string): string | null {
  const namespace = pluginNamespace(name);
  return MOUNT_SLUG.test(namespace)
    ? null
    : `${name} cannot carry code: its extension mount would be named ${JSON.stringify(namespace)}, and eve accepts a letter followed by letters, digits or underscores, up to 64 characters`;
}

/**
 * Why this plugin's code cannot be built here, or null. Both answers are the plugin's
 * own shape, so they are given at install time rather than by a build that fails later.
 *
 * The tsconfig is not our taste: `eve extension build` emits declarations with `tsc` and
 * a file list, and `tsc` refuses that outright (TS5112) when it finds a tsconfig up the
 * tree - which it always does here, because the plugin is copied INSIDE a version and
 * Iva's own tsconfig sits at its root. A plugin that ships one (as `eve extension init`
 * writes it) builds; a plugin without one fails with a message about our tree, not theirs.
 */
export function pluginCodeProblem(root: string, name: string): string | null {
  const namespace = namespaceProblem(name);
  if (namespace) return namespace;
  return existsSync(join(root, CODE_DIR, "tsconfig.json"))
    ? null
    : `${name} carries code without ${CODE_DIR}/tsconfig.json, and eve cannot build declarations without one - ask the author to run: eve extension init`;
}

/** Everything eve does not accept in a name folded to a single dash. */
function folded(part: string): string {
  return part
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/**
 * The connection name of one MCP server: `mcp-<plugin>--<server>`, both parts folded
 * into what eve accepts as a file name. The model sees it in every tool of that server
 * (`connection__mcp-trace--viewer__…`), so it is a name, not a hash.
 */
export function pluginConnectionName(name: string, server: string): string {
  return `${CONNECTION_PREFIX}${folded(name)}${CONNECTION_JOIN}${folded(server)}`;
}

/** The connection file of one MCP server inside a version, relative to its root. */
export function pluginConnectionFile(name: string, server: string): string {
  return `${CONNECTION_DIR}/${pluginConnectionName(name, server)}.ts`;
}

/**
 * Why this MCP server cannot become a connection here, or null. eve names connections
 * after their files and accepts lowercase letters, digits and dashes only, so a server
 * called `Echo Server` or one whose folded name is empty is refused by name rather
 * than silently registered as something else.
 */
export function connectionNameProblem(
  name: string,
  server: string,
): string | null {
  // Nothing eve can use left after the folding: a name of its own is what makes the
  // server addressable at all, and `mcp-<plugin>--` is not one.
  if (!folded(server))
    return `the MCP server ${JSON.stringify(server)} has no letters or digits in its name, so it cannot become a connection`;
  const connection = pluginConnectionName(name, server);
  return CONNECTION_SLUG.test(connection)
    ? null
    : `the MCP server ${JSON.stringify(server)} would be the connection ${JSON.stringify(connection)}, and eve accepts a lowercase letter followed by lowercase letters, digits or dashes, up to 64 characters`;
}

/**
 * Who else folds onto the namespace of `name`, or null. `a.b` and `a-b` are two
 * plugins and one mount file, so they may not be installed together: silently keeping
 * one of them would switch the other off without saying so. Asked at install time, so
 * the answer belongs to the command that caused it rather than to a later build.
 */
export function namespaceTaken(
  name: string,
  installed: readonly string[],
): string | null {
  const namespace = pluginNamespace(name);
  return (
    installed.find(
      (other) => other !== name && pluginNamespace(other) === namespace,
    ) ?? null
  );
}

/**
 * The connections of one plugin, or the reasons there are none. Written only for a
 * plugin that is enabled AND trusted (ADR-0009): `enabled` turns on the text in the
 * prompt, `trusted` turns on processes and outbound calls, and a connection is the
 * second kind - even an `sse` server is a token of the owner's leaving the machine.
 */
function pluginConnections({
  name,
  servers,
  ports,
  description,
  diagnostics,
}: {
  readonly name: string;
  readonly servers: Readonly<Record<string, PluginMcpServer>>;
  /** The loopback port handed to each proxied server, from `plugins.json`. */
  readonly ports: Readonly<Record<string, { readonly port: number }>>;
  /** The plugin's own description, so `connection_search` has something to match. */
  readonly description: string | undefined;
  readonly diagnostics: string[];
}): PluginConnection[] {
  const connections: PluginConnection[] = [];
  const taken = new Map<string, string>();
  for (const [server, declared] of Object.entries(servers).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const problem = connectionNameProblem(name, server);
    if (problem) {
      diagnostics.push(`plugin ${name}: ${problem}`);
      continue;
    }
    const connection = pluginConnectionName(name, server);
    const owner = taken.get(connection);
    if (owner !== undefined) {
      diagnostics.push(
        `plugin ${name}: the MCP servers ${JSON.stringify(owner)} and ${JSON.stringify(server)} both become the connection ${connection}; neither is generated`,
      );
      continue;
    }
    taken.set(connection, server);
    const port = ports[server]?.port;
    if (declared.type === "stdio" && port === undefined) {
      diagnostics.push(
        `plugin ${name}: the MCP server ${JSON.stringify(server)} has no port yet - run: iva plugin trust ${name}`,
      );
      continue;
    }
    connections.push({
      server,
      name: connection,
      file: pluginConnectionFile(name, server),
      source: connectionSource({
        plugin: name,
        server,
        description: `MCP server ${JSON.stringify(server)} of the plugin ${name}${description ? `: ${description}` : ""}`,
        url:
          declared.type === "stdio"
            ? `http://127.0.0.1:${port ?? 0}/mcp`
            : declared.url,
        tokenFile: declared.type === "stdio",
        ...(declared.type !== "stdio" && declared.headers
          ? { headers: declared.headers }
          : {}),
      }),
    });
  }
  return connections;
}

/**
 * The enabled plugins a version has to carry: those with code to build and those with
 * MCP servers to connect to. Read from the store, never from the digest recorded at
 * install time: a folder edited in place is a different version, and the owner who
 * edited it expects the next build to carry the edit.
 */
export async function codePlugins(dataDir: string): Promise<CodePlugins> {
  const loaded = await tryLoadPluginCore();
  if (!loaded)
    return {
      plugins: [],
      diagnostics: [
        "plugin code is left out of this build: the agent tree is missing",
      ],
    };
  const { readPlugin, pluginTreeDigest } = loaded.reader;
  const {
    enabledPlugins,
    pluginConfigFile,
    pluginMode,
    pluginRoot,
    readPluginsStateSafe,
  } = loaded.store;
  const diagnostics: string[] = [];
  const { state, damaged } = await readPluginsStateSafe(dataDir);
  if (damaged)
    diagnostics.push(
      `plugin code is left out of this build: ${damaged.message}`,
    );
  const plugins: CodePlugin[] = [];
  for (const entry of enabledPlugins(state)) {
    const root = pluginRoot(dataDir, entry.name);
    const report = await readPlugin(root);
    if (!report.manifest) {
      diagnostics.push(
        `plugin ${entry.name} is left out of this build: ${report.diagnostics.at(-1) ?? "the folder is not a usable plugin"}`,
      );
      continue;
    }
    // A plugin with unusable code is left out whole: its connections would be half a
    // plugin, and half a plugin is worse than none (the same rule as `disableCodePlugin`).
    if (report.code) {
      const problem = pluginCodeProblem(root, entry.name);
      if (problem) {
        diagnostics.push(
          `plugin ${entry.name} is left out of this build: ${problem}`,
        );
        continue;
      }
    }
    const connections =
      pluginMode(entry) === "full"
        ? pluginConnections({
            name: entry.name,
            servers: report.mcp,
            ports: entry.mcp ?? {},
            description: report.manifest.description,
            diagnostics,
          })
        : [];
    // Neither code nor connections: nothing about this plugin is in a version, and its
    // skills are live anyway.
    if (!report.code && connections.length === 0) continue;
    let digest: string;
    try {
      digest = await pluginTreeDigest(root);
    } catch (error) {
      diagnostics.push(
        `plugin ${entry.name} is left out of this build: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    let config = "";
    try {
      config = await readFile(pluginConfigFile(dataDir, entry.name), "utf8");
    } catch {
      // No config file is the normal case; an unreadable one is an empty config,
      // exactly as the runtime reader treats it (agent/lib/plugin-config.ts).
    }
    plugins.push({
      name: entry.name,
      root,
      namespace: pluginNamespace(entry.name),
      mount: pluginMount(entry.name),
      directory: pluginDirectory(entry.name),
      digest,
      config,
      extension: report.code,
      connections,
    });
  }
  // Two names on one mount file: neither is built, and both are named. `add` refuses
  // such a pair (`namespaceTaken`); this is the second lock, for a pair that reached
  // the store another way - a restored `plugins.json`, a folder put there by hand.
  const names = plugins
    .filter((plugin) => plugin.extension)
    .map((plugin) => plugin.name);
  const kept = plugins.filter((plugin) => {
    const other = plugin.extension ? namespaceTaken(plugin.name, names) : null;
    if (other === null) return true;
    diagnostics.push(
      `plugins ${plugin.name} and ${other} want the same extension mount ${plugin.namespace}.ts; neither is built - remove one: iva plugin remove <name>`,
    );
    return false;
  });
  // The same trap one level up: two plugins whose folded names meet in one connection
  // file. Neither is generated, both are named - a file written twice would leave the
  // owner with one plugin's tools under the other's name.
  const owners = new Map<string, string>();
  for (const plugin of kept)
    for (const connection of plugin.connections) {
      const owner = owners.get(connection.name);
      if (owner === undefined) owners.set(connection.name, plugin.name);
      else if (owner !== plugin.name) owners.set(connection.name, "");
    }
  const clean = kept.map((plugin) => {
    const connections = plugin.connections.filter((connection) => {
      if (owners.get(connection.name) !== "") return true;
      diagnostics.push(
        `plugins on the same connection ${connection.name}; it is not generated - remove one: iva plugin remove <name>`,
      );
      return false;
    });
    return connections.length === plugin.connections.length
      ? plugin
      : { ...plugin, connections };
  });
  return {
    plugins: clean.filter(
      (plugin) => plugin.extension || plugin.connections.length > 0,
    ),
    diagnostics,
  };
}

/**
 * The generated mount: what makes eve load the plugin's extension. eve reads it
 * statically for the package specifier and evaluates it at start, so the shape is its
 * (`export default <name>(...)` with a matching import), and the config is a call
 * rather than a value - the owner's settings are not the version's to bake in.
 *
 * The specifiers are held in variables so that this file contains no `import ... from
 * "..."` of its own to be mistaken for one: the walks that read the tree for its
 * imports would follow the text of a generated mount as if it were code here
 * (scripts/lib/version-update.test.ts, scripts/authored-tree-guard.test.ts).
 */
export function mountSource(plugin: CodePlugin): string {
  // The trailing `/.` is load-bearing on eve 0.51.1. Without it, the authored asset
  // loader reads the dotted `sh.iva` directory as an `.iva` asset and fails with EISDIR.
  // Discovery resolves the same canonical package root, while the bundler sees a package.
  const code = `"../../${plugin.directory}/${CODE_DIR}/."`;
  const reader = `"../lib/plugin-config.ts"`;
  return [
    `// Generated by Iva from data/custom/plugins/${plugin.name} - do not edit.`,
    `// Every version build writes this file again (ADR-0009). The config is read at`,
    `// load time from data/custom/plugins/${plugin.name}.config.json, never baked in.`,
    `import extension from ${code};`,
    `import { readPluginConfig } from ${reader};`,
    ``,
    `export default extension(readPluginConfig("${plugin.name}"));`,
    ``,
  ].join("\n");
}

/**
 * The generated connection: what makes eve reach an MCP server of a plugin. One file per
 * server, written into the version beside the mount, because `agent/connections/` is
 * read by eve's own discovery and nothing else registers a connection.
 *
 * Nothing about the owner's installation is baked in beyond the port and the URL the
 * plugin itself declares: the bearer of a proxied server is read from its token file at
 * every call, and a `${VAR}` inside a header comes out of `<name>.env` at every call too.
 * Both are the same rule as `agent/connections/telegram-userbot.ts` - a value that has
 * to be there before the agent starts is a value that needs a restart to change.
 *
 * The specifiers are held in variables for the same reason `mountSource` holds them: the
 * walks that read this tree for its imports would otherwise follow the text of a
 * generated file as if it were an import of this module.
 */
export function connectionSource(spec: {
  readonly plugin: string;
  readonly server: string;
  readonly description: string;
  /** `http://127.0.0.1:<port>/mcp` for a proxied server, the declared URL otherwise. */
  readonly url: string;
  /** A proxied server authenticates with the token file the proxy shares. */
  readonly tokenFile: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}): string {
  const connections = `"eve/connections"`;
  const fs = `"node:fs"`;
  const dataDirModule = `"../lib/data-dir.ts"`;
  const storeModule = `"../lib/plugin-store.ts"`;
  const configModule = `"../lib/plugin-config.ts"`;
  const plugin = JSON.stringify(spec.plugin);
  const server = JSON.stringify(spec.server);
  const headers = Object.entries(spec.headers ?? {});
  const lines = [
    `// Generated by Iva from data/custom/plugins/${spec.plugin}/mcp.json - do not edit.`,
    `// Every version build writes this file again (ADR-0009); it exists only while the`,
    `// plugin is enabled and trusted.`,
    `import { defineMcpClientConnection } from ${connections};`,
  ];
  if (spec.tokenFile)
    lines.push(
      `import { readFileSync } from ${fs};`,
      `import { dataDir } from ${dataDirModule};`,
      `import { pluginTokenFile } from ${storeModule};`,
    );
  if (headers.length)
    lines.push(`import { expandPluginEnv } from ${configModule};`);
  lines.push(``);
  if (spec.tokenFile)
    lines.push(
      `// Read at every call: the proxy writes its token when the owner trusts the plugin,`,
      `// and the agent must not need a restart to notice.`,
      `function token(): string {`,
      `  try {`,
      `    return readFileSync(`,
      `      pluginTokenFile(dataDir(), ${plugin}, ${server}),`,
      `      "utf8",`,
      `    ).trim();`,
      `  } catch {`,
      `    return "";`,
      `  }`,
      `}`,
      ``,
    );
  lines.push(
    `export default defineMcpClientConnection({`,
    `  url: ${JSON.stringify(spec.url)},`,
    `  description: ${JSON.stringify(spec.description)},`,
  );
  if (spec.tokenFile)
    lines.push(
      `  auth: { getToken: () => Promise.resolve({ token: token() }) },`,
    );
  if (headers.length) {
    lines.push(`  headers: {`);
    for (const [key, value] of headers)
      lines.push(
        `    ${JSON.stringify(key)}: () => expandPluginEnv(${plugin}, ${JSON.stringify(value)}),`,
      );
    lines.push(`  },`);
  }
  lines.push(`});`, ``);
  return lines.join("\n");
}

/**
 * Give the built package a `main`, in the COPY inside the version and never in the store.
 *
 * `eve extension build` writes an `exports` map and no `main`. Discovery is happy with
 * that - it only needs a package.json next to the mount specifier - but the bundler is
 * not: rolldown applies `exports` to bare specifiers only, so a relative mount resolves
 * through `main`, and without one the whole agent build dies with UNRESOLVED_IMPORT on
 * the generated mount (verified on eve 0.51.1 on 2026-09-04). Pointing the mount straight at
 * `dist/index.mjs` instead is not the fix: then discovery finds no package and the
 * extension is never mounted at all.
 *
 * Returns the entry it wrote, or null when the build left nothing to point at.
 */
function pointMainAtTheBuild(code: string): string | null {
  const file = join(code, "package.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  const dot = (manifest.exports as Record<string, unknown> | undefined)?.["."];
  const entry =
    typeof dot === "string"
      ? dot
      : typeof manifest.main === "string"
        ? manifest.main
        : ((dot as Record<string, unknown> | undefined)?.import ??
          (dot as Record<string, unknown> | undefined)?.default);
  if (typeof entry !== "string" || !existsSync(join(code, entry))) return null;
  if (manifest.main === entry) return entry; // The author already pointed it there.
  writeFileSync(
    file,
    `${JSON.stringify({ ...manifest, main: entry }, null, 2)}\n`,
  );
  return entry;
}

/**
 * Every file of the plugin a finished version must contain. A build that is missing one
 * of them did not carry the plugin, whatever the version is named after - the mount is
 * how eve loads its code, and a connection file is how eve reaches its MCP server.
 */
export function pluginArtifacts(plugin: CodePlugin): string[] {
  return [
    ...(plugin.extension ? [plugin.mount, plugin.directory] : []),
    ...plugin.connections.map((connection) => connection.file),
  ];
}

/** Whether every required artifact of this plugin exists in a finished version. */
export function pluginArtifactsPresent(
  dir: string,
  plugin: CodePlugin,
): boolean {
  return pluginArtifacts(plugin).every((artifact) =>
    existsSync(join(dir, artifact)),
  );
}

/**
 * Names of plugins whose required artifacts are absent from a finished version.
 * Same set `builtWith()` already uses: a mount is required only of a Plugin with
 * eve Extension, and every generated connection file is required of an MCP server.
 */
export function pluginsMissingArtifacts(
  dir: string,
  plugins: readonly CodePlugin[],
): string[] {
  return plugins
    .filter((plugin) => !pluginArtifactsPresent(dir, plugin))
    .map((plugin) => plugin.name);
}

/** Take a plugin out of a staged version: the copy, the mount, its connections. */
export function removePluginFromVersion(
  versionDir: string,
  plugin: CodePlugin,
): void {
  rmSync(join(versionDir, plugin.mount), { force: true });
  rmSync(join(versionDir, plugin.directory), {
    recursive: true,
    force: true,
  });
  for (const connection of plugin.connections)
    rmSync(join(versionDir, connection.file), { force: true });
}

/** The generated connections of one plugin, written into a staged version. */
function writePluginConnections(
  versionDir: string,
  plugin: CodePlugin,
  log: Say,
): void {
  for (const connection of plugin.connections) {
    const file = join(versionDir, connection.file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, connection.source);
  }
  if (plugin.connections.length)
    log(
      `connected ${plugin.name} to ${plugin.connections.map((connection) => connection.server).join(", ")}`,
    );
}

/**
 * Put one plugin into a staged version: the connections always, and for a plugin with
 * code the copy, its dependencies, the extension build and the mount. Returns the
 * failing step's own output rather than throwing - the caller decides whether one plugin
 * may fail a build (`iva update`) or must not (`iva plugin add`).
 */
export async function buildPluginExtension({
  versionDir,
  plugin,
  run,
  log = () => {},
}: {
  readonly versionDir: string;
  readonly plugin: CodePlugin;
  readonly run: Runner;
  readonly log?: Say;
}): Promise<{ ok: true } | { ok: false; output: string }> {
  const loaded = await tryLoadPluginCore();
  if (!loaded)
    return {
      ok: false,
      output: "the agent tree is missing, so the plugin cannot be copied",
    };
  const failed = (what: string, output: string) => ({
    ok: false as const,
    output: `${what}:\n${output.slice(-OUTPUT_TAIL)}`,
  });
  const target = join(versionDir, plugin.directory);
  removePluginFromVersion(versionDir, plugin);
  // Connections are generated files and nothing else: no install, no build step, so a
  // plugin that only carries MCP servers costs a version its files and nothing more.
  writePluginConnections(versionDir, plugin, log);
  if (!plugin.extension) return { ok: true };
  try {
    // The walk-copy of the installer: it rejects symlinks instead of following one
    // out of the store, and the executable bit of a plugin's scripts survives.
    await loaded.install.copyPluginTree(plugin.root, target);
  } catch (error) {
    return failed(
      `copying the plugin ${plugin.name} into the version`,
      error instanceof Error ? error.message : String(error),
    );
  }
  const code = join(target, CODE_DIR);
  const pinned = LOCKFILES.some((name) => existsSync(join(code, name)));
  if (!pinned)
    log(
      `plugin ${plugin.name} ships no package-lock.json; its dependencies are resolved fresh`,
    );
  const install = await run(
    "npm",
    [pinned ? "ci" : "install", ...PLUGIN_INSTALL],
    code,
  );
  if (install.code !== 0)
    return failed(
      `installing the dependencies of the plugin ${plugin.name}`,
      install.output,
    );
  const built = await run(join(versionDir, EVE_BIN), EVE_BUILD, code);
  if (built.code !== 0)
    return failed(`building the extension of ${plugin.name}`, built.output);
  const entry = pointMainAtTheBuild(code);
  if (entry === null)
    return failed(
      `building the extension of ${plugin.name}`,
      `eve extension build left no package entry in ${CODE_DIR}/package.json to import`,
    );
  const mount = join(versionDir, plugin.mount);
  mkdirSync(dirname(mount), { recursive: true });
  writeFileSync(mount, mountSource(plugin));
  log(`built the code of ${plugin.name} as ${plugin.namespace} (${entry})`);
  return { ok: true };
}

/**
 * Switch a plugin off in `plugins.json`, because its code will not build. The skills
 * of a plugin go with its code: half a plugin in the prompt is worse than none, and
 * the owner is told by the Alert that comes with this (ADR-0007).
 */
export async function disableCodePlugin(
  dataDir: string,
  name: string,
): Promise<boolean> {
  const loaded = await tryLoadPluginCore();
  if (!loaded) return false;
  const { findPlugin, readPluginsStateSafe, upsertPlugin, writePluginsState } =
    loaded.store;
  const { state, damaged } = await readPluginsStateSafe(dataDir);
  if (damaged) return false;
  const entry = findPlugin(state, name);
  if (!entry || !entry.enabled) return false;
  await writePluginsState(
    dataDir,
    upsertPlugin(state, { ...entry, enabled: false }),
  );
  return true;
}
