/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Namespace плагина, чтение стора и генерация mount'а. Сборка версии с плагином целиком
// проверяется харнесом апдейтера (scripts/lib/version-update.test.ts); здесь — куски,
// у которых есть свои границы: отображение имени в имя файла и отчёт о том, что
// пропущено.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ свойства: fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import {
  MCP_SCHEMA_URL,
  PLUGIN_SCHEMA_URL,
  pluginNameProblem,
} from "#lib/plugin-reader.ts";
import {
  pluginMode,
  readPluginsState,
  type PluginMode,
} from "#lib/plugin-store.ts";
import {
  codePlugins,
  connectionNameProblem,
  connectionSource,
  disableCodePlugin,
  mountSource,
  namespaceProblem,
  namespaceTaken,
  pluginArtifacts,
  pluginArtifactsPresent,
  pluginConnectionFile,
  pluginConnectionName,
  pluginDirectory,
  pluginMount,
  pluginNamespace,
  pluginsMissingArtifacts,
  type CodePlugin,
} from "./plugin-build.ts";

const worlds: string[] = [];
after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function world(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-plugin-build-"));
  worlds.push(dir);
  return dir;
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/** Папка плагина в сторе плюс запись о нём. */
function plant(
  data: string,
  name: string,
  {
    code = true,
    config,
    mcp,
  }: {
    code?: boolean;
    config?: string;
    mcp?: Record<string, unknown>;
  } = {},
): void {
  write(
    data,
    `custom/plugins/${name}/plugin.json`,
    JSON.stringify({
      $schema: PLUGIN_SCHEMA_URL,
      name,
      version: "1.0.0",
      description: "Demo plugin.",
      // Ключ обязателен для обоих видов `sh.iva/` (ADR-0009, решение 12).
      ...(code ? { extensions: { "sh.iva": {} } } : {}),
    }),
  );
  if (mcp)
    write(
      data,
      `custom/plugins/${name}/mcp.json`,
      JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers: mcp }),
    );
  if (code) {
    write(
      data,
      `custom/plugins/${name}/sh.iva/package.json`,
      JSON.stringify({
        name,
        eve: { extension: { source: "./extension", dist: "./dist/extension" } },
      }),
    );
    write(
      data,
      `custom/plugins/${name}/sh.iva/tsconfig.json`,
      '{ "include": ["extension/**/*.ts"] }\n',
    );
  }
  if (config !== undefined)
    write(data, `custom/plugins/${name}.config.json`, config);
}

function state(
  data: string,
  entries: readonly {
    name: string;
    enabled?: boolean;
    trusted?: boolean;
    mcp?: Record<string, { port: number }>;
  }[],
): void {
  write(
    data,
    "custom/plugins.json",
    JSON.stringify({
      marketplaces: [],
      plugins: entries.map((entry) => ({
        name: entry.name,
        source: `/tmp/${entry.name}`,
        ref: "",
        sha: "",
        digest: "",
        enabled: entry.enabled ?? true,
        trusted: entry.trusted ?? false,
        ...(entry.mcp ? { mcp: entry.mcp } : {}),
        installedAt: "2026-08-17T00:00:00.000Z",
      })),
    }),
  );
}

test("a namespace is the plugin name with dots and dashes folded to underscores", () => {
  assert.equal(pluginNamespace("trace"), "trace");
  assert.equal(pluginNamespace("my-tool"), "my_tool");
  assert.equal(pluginNamespace("sh.iva.trace"), "sh_iva_trace");
  assert.equal(pluginMount("my-tool"), "agent/extensions/my_tool.ts");
  assert.equal(pluginDirectory("my-tool"), "plugins/my-tool");
});

test("a name eve cannot use as a mount file is refused, not bent into shape", () => {
  // Имя плагина по спеке может начинаться с цифры, а mount у eve — только с буквы.
  assert.equal(namespaceProblem("trace"), null);
  assert.equal(namespaceProblem("my-tool"), null);
  assert.match(namespaceProblem("7zip") ?? "", /eve accepts a letter/u);
  assert.match(namespaceProblem("a".repeat(65)) ?? "", /64 characters/u);
});

test("two names that fold onto one namespace name each other", () => {
  assert.equal(namespaceTaken("my-tool", ["my.tool", "other"]), "my.tool");
  assert.equal(namespaceTaken("my-tool", ["my-tool"]), null); // сам себе не помеха
  assert.equal(namespaceTaken("my-tool", ["other"]), null);
});

test("the mount eve reads names the plugin package and reads its config at load", () => {
  const source = mountSource({
    name: "my-tool",
    root: "/data/custom/plugins/my-tool",
    namespace: "my_tool",
    mount: pluginMount("my-tool"),
    directory: pluginDirectory("my-tool"),
    digest: "abc",
    config: "",
    extension: true,
    connections: [],
  });
  // Форма, которую eve разбирает статически: `export default <ident>(…)` плюс импорт
  // того же имени по относительному спецификатору.
  assert.match(
    source,
    /^import extension from "\.\.\/\.\.\/plugins\/my-tool\/sh\.iva\/\.";$/mu,
  );
  assert.match(
    source,
    /^export default extension\(readPluginConfig\("my-tool"\)\);$/mu,
  );
  assert.match(source, /do not edit/u);
});

test("only the enabled plugins with code are what a version carries", async () => {
  const data = join(world(), "data");
  plant(data, "trace", { config: '{"level":"debug"}\n' });
  plant(data, "skills-only", { code: false });
  plant(data, "off");
  state(data, [
    { name: "trace" },
    { name: "skills-only" },
    { name: "off", enabled: false },
  ]);

  const { plugins, diagnostics } = await codePlugins(data);

  assert.deepEqual(
    plugins.map((plugin) => plugin.name),
    ["trace"],
  );
  assert.deepEqual(diagnostics, []);
  const [trace] = plugins;
  assert.equal(trace.mount, "agent/extensions/trace.ts");
  assert.equal(trace.directory, "plugins/trace");
  assert.equal(trace.config, '{"level":"debug"}\n');
  assert.match(trace.digest, /^[a-f0-9]{64}$/u);
});

test("a plugin the reader refuses is left out of the build and named", async () => {
  const data = join(world(), "data");
  plant(data, "trace");
  write(data, "custom/plugins/broken/plugin.json", "{oh no");
  state(data, [{ name: "trace" }, { name: "broken" }, { name: "gone" }]);

  const { plugins, diagnostics } = await codePlugins(data);

  assert.deepEqual(
    plugins.map((plugin) => plugin.name),
    ["trace"],
  );
  assert.equal(diagnostics.length, 2, diagnostics.join("\n"));
  assert.ok(
    diagnostics.every((line) => /is left out of this build/u.test(line)),
    diagnostics.join("\n"),
  );
});

test("a damaged plugins.json leaves the build with no plugins and says so", async () => {
  const data = join(world(), "data");
  write(data, "custom/plugins.json", "{not json");

  const { plugins, diagnostics } = await codePlugins(data);

  assert.deepEqual(plugins, []);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /left out of this build/u);
});

test("switching a plugin off is one field in plugins.json", async () => {
  const data = join(world(), "data");
  plant(data, "trace");
  state(data, [{ name: "trace" }]);

  assert.equal(await disableCodePlugin(data, "trace"), true);
  assert.equal((await readPluginsState(data)).plugins[0].enabled, false);
  // Второй раз выключать нечего, и файл не переписывается зря.
  assert.equal(await disableCodePlugin(data, "trace"), false);
  assert.equal(await disableCodePlugin(data, "absent"), false);
});

test("PluginMode UpdateGrantsNothing: the update's switch-off only ever takes a mode down", async () => {
  // Четыре режима — весь вход: обновление выключает плагин, чей код не собрался, и
  // больше ничего в паре тумблеров не трогает. Включить или доверить оно не может.
  const after: Record<PluginMode, PluginMode> = {
    full: "paused",
    "no-processes": "off",
    paused: "paused",
    off: "off",
  };
  for (const enabled of [true, false])
    for (const trusted of [true, false]) {
      const data = join(world(), "data");
      plant(data, "trace");
      state(data, [{ name: "trace", enabled, trusted }]);
      const before = pluginMode({ enabled, trusted });

      assert.equal(await disableCodePlugin(data, "trace"), enabled, before);

      const [entry] = (await readPluginsState(data)).plugins;
      assert.equal(pluginMode(entry), after[before], before);
    }
});

test("any name the spec allows either maps to a mount eve accepts or is refused", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,20}[a-z0-9]$/u),
        fc.stringMatching(/^[a-z0-9]$/u),
        fc.string(),
      ),
      (name) => {
        // Свойство только про имена, которые ридер вообще принимает.
        if (pluginNameProblem(name) !== null) return true;
        const namespace = pluginNamespace(name);
        if (namespaceProblem(name) !== null) return true;
        assert.match(namespace, /^[a-z][a-z0-9_]{0,63}$/u);
        // Имя файла — один сегмент пути: ни разделителей, ни точек.
        assert.equal(pluginMount(name), `agent/extensions/${namespace}.ts`);
        assert.equal(namespace.includes("/"), false);
        assert.equal(namespace.includes("."), false);
        return true;
      },
    ),
  );
});

test("names collide exactly when their folded forms are equal", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[a-z][a-z0-9.-]{0,10}[a-z0-9]$/u),
      fc.stringMatching(/^[a-z][a-z0-9.-]{0,10}[a-z0-9]$/u),
      (first, second) => {
        fc.pre(
          pluginNameProblem(first) === null &&
            pluginNameProblem(second) === null &&
            first !== second,
        );
        const folded = pluginNamespace(first) === pluginNamespace(second);
        assert.equal(namespaceTaken(first, [second]) !== null, folded);
        assert.equal(namespaceTaken(second, [first]) !== null, folded);
        return true;
      },
    ),
  );
});

test("a connection is named after the plugin and the server, folded for eve", () => {
  assert.equal(pluginConnectionName("trace", "viewer"), "mcp-trace--viewer");
  // Точки и подчёркивания складываются в дефис: eve принимает только его.
  assert.equal(
    pluginConnectionName("sh.iva.trace", "my_srv"),
    "mcp-sh-iva-trace--my-srv",
  );
  // Имя плагина по спеке может начинаться с цифры, а имя connection у eve — нет.
  assert.equal(pluginConnectionName("7zip", "cli"), "mcp-7zip--cli");
  assert.equal(
    pluginConnectionFile("trace", "viewer"),
    "agent/connections/mcp-trace--viewer.ts",
  );
  assert.equal(connectionNameProblem("trace", "viewer"), null);
  assert.equal(connectionNameProblem("7zip", "cli"), null);
  assert.match(
    connectionNameProblem("trace", "!!") ?? "",
    /has no letters or digits in its name/u,
  );
  assert.match(
    connectionNameProblem("trace", "s".repeat(70)) ?? "",
    /64 characters/u,
  );
});

test("a proxied server reads its bearer from the token file at every call", () => {
  const source = connectionSource({
    plugin: "trace",
    server: "viewer",
    description: 'MCP server "viewer" of the plugin trace',
    url: "http://127.0.0.1:8730/mcp",
    tokenFile: true,
  });
  assert.match(source, /url: "http:\/\/127\.0\.0\.1:8730\/mcp"/u);
  assert.match(source, /pluginTokenFile\(dataDir\(\), "trace", "viewer"\)/u);
  assert.match(
    source,
    /getToken: \(\) => Promise\.resolve\(\{ token: token\(\) \}\)/u,
  );
  assert.match(source, /do not edit/u);
  // Env плагина проксированному серверу через заголовки не передаётся.
  assert.doesNotMatch(source, /expandPluginEnv/u);
});

test("a remote server keeps its own url and expands its headers from the env file", () => {
  const source = connectionSource({
    plugin: "weather",
    server: "api",
    description: "d",
    url: "https://api.test/mcp",
    tokenFile: false,
    headers: { Authorization: "Bearer ${WEATHER_TOKEN}", "X-Plain": "yes" },
  });
  assert.match(source, /url: "https:\/\/api\.test\/mcp"/u);
  assert.match(
    source,
    /"Authorization": \(\) => expandPluginEnv\("weather", "Bearer \$\{WEATHER_TOKEN\}"\)/u,
  );
  assert.match(
    source,
    /"X-Plain": \(\) => expandPluginEnv\("weather", "yes"\)/u,
  );
  // Токена у удалённого сервера нет: он не за нашим прокси.
  assert.doesNotMatch(source, /pluginTokenFile/u);
});

test("connections are generated only for a plugin that is enabled and trusted", async () => {
  const data = join(world(), "data");
  const servers = {
    local: { type: "stdio", command: "node", args: ["server.mjs"] },
    api: {
      type: "streamable-http",
      url: "https://api.test/mcp",
      headers: { Authorization: "Bearer ${API_KEY}" },
    },
  };
  plant(data, "trusted-one", { code: false, mcp: servers });
  plant(data, "untrusted-one", { code: false, mcp: servers });
  state(data, [
    { name: "trusted-one", trusted: true, mcp: { local: { port: 8731 } } },
    { name: "untrusted-one", trusted: false, mcp: { local: { port: 8732 } } },
  ]);

  const { plugins, diagnostics } = await codePlugins(data);
  assert.deepEqual(diagnostics, []);
  // Плагин без доверия не попадает в версию вовсе: ни connection, ни имени.
  assert.deepEqual(
    plugins.map((plugin) => plugin.name),
    ["trusted-one"],
  );
  const [trusted] = plugins;
  // Плагин без Extension версию несёт, но mount и копию — нет.
  assert.equal(trusted.extension, false);
  assert.deepEqual(
    trusted.connections.map((connection) => connection.file),
    [
      "agent/connections/mcp-trusted-one--api.ts",
      "agent/connections/mcp-trusted-one--local.ts",
    ],
  );
  const local = trusted.connections.find(
    (connection) => connection.server === "local",
  );
  assert.match(local?.source ?? "", /url: "http:\/\/127\.0\.0\.1:8731\/mcp"/u);
  // Описание плагина уходит в connection: по нему модель и выбирает сервер.
  assert.match(local?.source ?? "", /Demo plugin\./u);
});

test("a proxied server without a port is named instead of pointed at nothing", async () => {
  const data = join(world(), "data");
  plant(data, "trace", {
    code: false,
    mcp: {
      viewer: { type: "stdio", command: "node" },
      "!!": { type: "stdio", command: "node" },
    },
  });
  state(data, [{ name: "trace", trusted: true }]);

  const { plugins, diagnostics } = await codePlugins(data);
  assert.deepEqual(plugins, []);
  assert.deepEqual(diagnostics.length, 2, diagnostics.join("\n"));
  assert.match(diagnostics.join("\n"), /iva plugin trust trace/u);
  assert.match(diagnostics.join("\n"), /has no letters or digits in its name/u);
});

test("two plugins on one connection name generate neither", async () => {
  const data = join(world(), "data");
  const mcp = { srv: { type: "streamable-http", url: "https://a.test/mcp" } };
  plant(data, "my-tool", { code: false, mcp });
  plant(data, "my.tool", { code: false, mcp });
  state(data, [
    { name: "my-tool", trusted: true },
    { name: "my.tool", trusted: true },
  ]);

  const { plugins, diagnostics } = await codePlugins(data);
  assert.deepEqual(plugins, []);
  assert.match(
    diagnostics.join("\n"),
    /on the same connection mcp-my-tool--srv/u,
  );
});

test("any server name either maps to a connection eve accepts or is refused", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,20}[a-z0-9]$/u),
      fc.string(),
      (name, server) => {
        fc.pre(pluginNameProblem(name) === null);
        if (connectionNameProblem(name, server) !== null) return true;
        const connection = pluginConnectionName(name, server);
        assert.match(connection, /^[a-z][a-z0-9-]{0,63}$/u);
        // Имя файла — один сегмент пути: ни разделителей, ни точек.
        assert.equal(connection.includes("/"), false);
        assert.equal(connection.includes("."), false);
        assert.equal(
          pluginConnectionFile(name, server),
          `agent/connections/${connection}.ts`,
        );
        return true;
      },
    ),
  );
});

function codePluginFixture(opts: {
  name: string;
  extension: boolean;
  servers?: readonly string[];
}): CodePlugin {
  const connections = (opts.servers ?? []).map((server) => ({
    server,
    name: pluginConnectionName(opts.name, server),
    file: pluginConnectionFile(opts.name, server),
    source: "",
  }));
  return {
    name: opts.name,
    root: `/data/custom/plugins/${opts.name}`,
    namespace: pluginNamespace(opts.name),
    mount: pluginMount(opts.name),
    directory: pluginDirectory(opts.name),
    digest: "x",
    config: "",
    extension: opts.extension,
    connections,
  };
}

function plantArtifact(dir: string, path: string): void {
  write(dir, path, "export default 1;\n");
}

test("MCP-only plugin with its connection file passes pluginsMissingArtifacts", () => {
  const dir = world();
  const mcp = codePluginFixture({
    name: "demo-mcp",
    extension: false,
    servers: ["demo"],
  });
  plantArtifact(dir, mcp.connections[0].file);
  assert.deepEqual(pluginArtifacts(mcp), [mcp.connections[0].file]);
  assert.equal(pluginArtifactsPresent(dir, mcp), true);
  assert.deepEqual(pluginsMissingArtifacts(dir, [mcp]), []);
});

test("MCP-only plugin without its connection file is missing artifacts", () => {
  const dir = world();
  const mcp = codePluginFixture({
    name: "demo-mcp",
    extension: false,
    servers: ["demo"],
  });
  assert.equal(pluginArtifactsPresent(dir, mcp), false);
  assert.deepEqual(pluginsMissingArtifacts(dir, [mcp]), ["demo-mcp"]);
});

test("Plugin with eve Extension without its mount is missing artifacts", () => {
  const dir = world();
  // Mount is required of a Plugin with eve Extension, not of an MCP-only Plugin.
  const extension = codePluginFixture({ name: "trace", extension: true });
  plantArtifact(dir, join(extension.directory, "package.json"));
  assert.deepEqual(pluginArtifacts(extension), [
    extension.mount,
    extension.directory,
  ]);
  assert.deepEqual(pluginsMissingArtifacts(dir, [extension]), ["trace"]);
});

test("Plugin with eve Extension without its built directory is missing artifacts", () => {
  const dir = world();
  const extension = codePluginFixture({ name: "trace", extension: true });
  plantArtifact(dir, extension.mount);
  assert.deepEqual(pluginsMissingArtifacts(dir, [extension]), ["trace"]);
});

test("mixed plugin without one connection file is missing artifacts", () => {
  const dir = world();
  const mixed = codePluginFixture({
    name: "mixed",
    extension: true,
    servers: ["one", "two"],
  });
  plantArtifact(dir, mixed.mount);
  plantArtifact(dir, join(mixed.directory, "package.json"));
  plantArtifact(dir, mixed.connections[0].file);
  assert.deepEqual(pluginsMissingArtifacts(dir, [mixed]), ["mixed"]);
});

test("mixed plugin with every artifact passes pluginsMissingArtifacts", () => {
  const dir = world();
  const mixed = codePluginFixture({
    name: "mixed",
    extension: true,
    servers: ["one", "two"],
  });
  plantArtifact(dir, mixed.mount);
  plantArtifact(dir, join(mixed.directory, "package.json"));
  for (const connection of mixed.connections)
    plantArtifact(dir, connection.file);
  assert.deepEqual(pluginArtifacts(mixed), [
    mixed.mount,
    mixed.directory,
    mixed.connections[0].file,
    mixed.connections[1].file,
  ]);
  assert.deepEqual(pluginsMissingArtifacts(dir, [mixed]), []);
});
