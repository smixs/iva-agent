/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Юниты плагина: тела, план и reconcile против фейкового systemctl. Живых юнитов здесь
// нет и быть не может — фейк ведёт своё состояние (`enabled`/`active`) ровно как
// `systemctl --user`, и все проверки идут по файлам в каталоге юнитов и по вызовам.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ свойства: fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  linkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import fc from "fast-check";
import {
  pluginUnitPayload,
  markPluginUnit,
  scopedPluginUnitName,
  readPluginUnitMarker,
} from "./plugin-unit-scope.ts";
import { runLaunchd, unitPath } from "./launchd.ts";
import {
  launchdPlan,
  launchdLabel,
  pluginPlistFields,
} from "./launchd-plist.ts";
import { SAFE_PLUGIN_PART } from "#lib/plugin-store.ts";
import { createSystemdControl } from "./systemd-control.ts";
import {
  installedPluginUnits,
  mcpProxyUnitBody,
  mcpUnitName,
  pluginServiceUnitBody,
  pluginUnitNames,
  pluginUnitPlan,
  reconcilePluginUnits,
  runningPluginUnits,
  serviceUnitName,
  UNIT_PART,
  pluginUnitScope,
  inspectPluginUnits,
  pluginUnitKey,
  unitPartProblem,
  type PluginUnitSource,
} from "./plugin-units.ts";

const worlds: string[] = [];
after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function world(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-plugin-units-"));
  worlds.push(dir);
  return dir;
}

/**
 * `systemctl --user` как его видит systemd-control: состояние в памяти, журнал вызовов,
 * и один юнит, который отказывается подниматься, — этим проверяется, что сосед всё равно
 * получает свой.
 */
function fakeSystemctl({
  broken,
  unitDir = "",
  loaded,
}: { broken?: string; unitDir?: string; loaded?: Map<string, string> } = {}) {
  const calls: string[] = [];
  const enabled = new Set<string>();
  const active = new Set<string>();
  const control = createSystemdControl({
    run: (args) => {
      calls.push(args.join(" "));
      const [action, ...rest] = args;
      const unit = rest.filter((value) => !value.startsWith("--")).at(0) ?? "";
      switch (action) {
        case "show": {
          const file = join(unitDir, unit);
          const body =
            loaded?.get(unit) ??
            (existsSync(file) ? readFileSync(file, "utf8") : "");
          const prop = rest
            .find((arg) => arg.startsWith("--property="))
            ?.slice(11);
          if (prop === "LoadState")
            return { code: 0, out: body ? "loaded" : "not-found" };
          return {
            code: 0,
            out:
              body
                .split("\n")
                .find((line) => line.startsWith(`${prop}=`))
                ?.slice(String(prop).length + 1) ?? "",
          };
        }
        case "enable":
          if (unit === broken) return { code: 1, out: "job failed" };
          enabled.add(unit);
          if (rest.includes("--now")) active.add(unit);
          return { code: 0, out: "" };
        case "disable":
          enabled.delete(unit);
          active.delete(unit);
          return { code: 0, out: "" };
        case "restart":
          active.add(unit);
          return { code: 0, out: "" };
        case "stop":
          active.delete(unit);
          return { code: 0, out: "" };
        case "is-enabled":
          return enabled.has(unit)
            ? { code: 0, out: "enabled" }
            : { code: 1, out: "disabled" };
        case "is-active":
          return active.has(unit)
            ? { code: 0, out: "active" }
            : { code: 3, out: "inactive" };
        default:
          return { code: 0, out: "" };
      }
    },
  });
  return { control, calls, enabled, active };
}

const NODE = "/home/user/.nvm/versions/node/v24.5.0/bin/node";
const NODE_BIN = "/home/user/.nvm/versions/node/v24.5.0/bin";
const ROOT = "/home/user/iva/current";
const DATA = join(realpathSync(world()), "data");
mkdirSync(DATA);
const scope = pluginUnitScope(DATA);
const scoped = (text: string) =>
  text.replace(/iva-(mcp|plugin)-/gu, (prefix) => `${prefix}${scope.id}-`);

function source0(overrides: Partial<PluginUnitSource> = {}): PluginUnitSource {
  return {
    name: "trace",
    enabled: true,
    trusted: true,
    root: `${DATA}/custom/plugins/trace`,
    data: `${DATA}/plugin-data/trace`,
    mcp: [],
    services: [],
    ...overrides,
  };
}

function plan(plugins: readonly PluginUnitSource[]) {
  return pluginUnitPlan({
    scope,
    plugins,
    root: ROOT,
    node: NODE,
    nodeBinDir: NODE_BIN,
    dataDir: DATA,
    dataDirEnvironment: `"ASSISTANT_DATA_DIR=${DATA}"`,
  });
}

test("a unit is named after the plugin and the server or the service", () => {
  assert.equal(
    mcpUnitName("trace", "viewer", scope),
    scoped("iva-mcp-trace-viewer.service"),
  );
  assert.equal(
    serviceUnitName("trace", "viewer", scope),
    scoped("iva-plugin-trace-viewer.service"),
  );
  assert.equal(unitPartProblem("MCP server", "viewer"), null);
  assert.equal(unitPartProblem("MCP server", "my.srv_1-2"), null);
  // Имя-путь наружу не становится именем юнита ни при каких условиях.
  assert.match(
    unitPartProblem("MCP server", "../../evil") ?? "",
    /cannot become a systemd unit/u,
  );
  assert.match(unitPartProblem("service", "a b") ?? "", /letters, digits/u);
  assert.match(unitPartProblem("service", "") ?? "", /letters, digits/u);
});

test("the MCP proxy unit runs the proxy of the running version, with no secrets", () => {
  const body = mcpProxyUnitBody({
    plugin: "trace",
    server: "viewer",
    port: 8731,
    tokenFile: `${DATA}/plugin-data/trace/mcp-viewer.token`,
    root: ROOT,
    node: NODE,
    nodeBinDir: NODE_BIN,
    dataDirEnvironment: `"ASSISTANT_DATA_DIR=${DATA}"`,
  });
  assert.match(
    body,
    new RegExp(
      `^ExecStart=/usr/bin/env "ASSISTANT_DATA_DIR=${DATA}" "${NODE}" "${ROOT}/services/mcp-proxy/serve.ts" --plugin "trace" --server "viewer" --port 8731 --token-file "${DATA}/plugin-data/trace/mcp-viewer.token"$`,
      "mu",
    ),
  );
  // ROOT — это `current`: flip переносит прокси на новую версию без правки юнита.
  assert.match(body, new RegExp(`^WorkingDirectory=${ROOT}$`, "mu"));
  assert.match(body, /^Restart=on-failure$/mu);
  assert.match(body, /^RestartSec=5$/mu);
  assert.match(body, /^UMask=0077$/mu);
  assert.match(body, /^After=network-online\.target$/mu);
  assert.match(body, /^WantedBy=default\.target$/mu);
  assert.match(
    body,
    new RegExp(`^Environment="PATH=%h/.local/bin:${NODE_BIN}:`, "mu"),
  );
  // Ни одного секрета инсталляции: EnvironmentFile у прокси нет.
  assert.doesNotMatch(body, /EnvironmentFile/u);
  assert.doesNotMatch(body, /TELEGRAM|OPENAI|ASSISTANT_BEARER/u);
});

test("a plugin service gets its port, its paths, and nothing of the agent's", () => {
  const body = pluginServiceUnitBody({
    plugin: "trace",
    service: "viewer",
    command: "node",
    args: ["server.mjs", `${DATA}/plugin-data/trace/state`],
    port: 8726,
    pluginRoot: `${DATA}/custom/plugins/trace`,
    pluginData: `${DATA}/plugin-data/trace`,
    dataDir: DATA,
    nodeBinDir: NODE_BIN,
  });
  assert.match(
    body,
    new RegExp(
      `^WorkingDirectory=${DATA}/custom/plugins/trace/sh\\.iva/services/viewer$`,
      "mu",
    ),
  );
  assert.match(
    body,
    new RegExp(
      `^ExecStart=/usr/bin/env "node" "server.mjs" "${DATA}/plugin-data/trace/state"$`,
      "mu",
    ),
  );
  // Ровно четыре значения плюс PATH — контракт сервиса плагина (ADR-0009).
  assert.deepEqual(
    body.split("\n").filter((line) => line.startsWith("Environment=")),
    [
      'Environment="IVA_SERVICE_PORT=8726"',
      `Environment="IVA_DATA_DIR=${DATA}"`,
      `Environment="PLUGIN_ROOT=${DATA}/custom/plugins/trace"`,
      `Environment="PLUGIN_DATA=${DATA}/plugin-data/trace"`,
      `Environment="PATH=%h/.local/bin:${NODE_BIN}:/usr/local/bin:/usr/bin:/bin"`,
    ],
  );
  assert.doesNotMatch(body, /EnvironmentFile/u);
  assert.match(body, /^Restart=on-failure$/mu);

  // `./`-команда — файл автора, и запускается по абсолютному пути: у systemd нет
  // ExecStart относительно cwd.
  const own = pluginServiceUnitBody({
    plugin: "trace",
    service: "viewer",
    command: "./serve.mjs",
    args: [],
    port: 8726,
    pluginRoot: `${DATA}/custom/plugins/trace`,
    pluginData: `${DATA}/plugin-data/trace`,
    dataDir: DATA,
    nodeBinDir: NODE_BIN,
  });
  assert.match(
    own,
    new RegExp(
      `^ExecStart="${DATA}/custom/plugins/trace/sh\\.iva/services/viewer/serve\\.mjs"$`,
      "mu",
    ),
  );
});

test("only an enabled and trusted plugin has units at all", () => {
  const mcp = [
    {
      server: "viewer",
      port: 8731,
      tokenFile: `${DATA}/plugin-data/trace/mcp-viewer.token`,
    },
  ];
  assert.deepEqual(
    plan([source0({ mcp })]).units.map((unit) => unit.unit),
    [scoped("iva-mcp-trace-viewer.service")],
  );
  assert.deepEqual(plan([source0({ mcp, trusted: false })]).units, []);
  assert.deepEqual(plan([source0({ mcp, enabled: false })]).units, []);
});

test("a name or a port that cannot make a unit is named instead of guessed", () => {
  const planned = plan([
    source0({
      mcp: [
        {
          server: "a b",
          port: 8731,
          tokenFile: `${DATA}/plugin-data/trace/mcp-viewer.token`,
        },
        {
          server: "viewer",
          port: undefined,
          tokenFile: `${DATA}/plugin-data/trace/mcp-viewer.token`,
        },
      ],
      services: [
        { service: "../evil", command: "node", args: [], port: 8726 },
        { service: "viewer", command: "node", args: [], port: undefined },
      ],
    }),
  ]);
  assert.deepEqual(planned.units, []);
  assert.deepEqual(planned.diagnostics, [
    'plugin trace: the MCP server "a b" cannot become a systemd unit: use letters, digits, ".", "-" and "_", starting with a letter or a digit',
    'plugin trace: the MCP server "viewer" has no port yet - run: iva plugin trust trace',
    'plugin trace: the service "../evil" cannot become a systemd unit: use letters, digits, ".", "-" and "_", starting with a letter or a digit',
    'plugin trace: the service "viewer" has no port yet - run: iva plugin trust trace',
  ]);
});

test("reconcile writes what belongs, starts it, and takes away what does not", () => {
  const home = world();
  const unitDir = join(home, "systemd");
  mkdirSync(unitDir, { recursive: true });
  // Юниты самой Ивы и чужого сервиса в том же каталоге: их трогать нельзя.
  writeFileSync(join(unitDir, "iva.service"), "[Service]\n");
  writeFileSync(join(unitDir, "iva-telegram-poll.service"), "[Service]\n");
  writeFileSync(join(unitDir, "unrelated.service"), "[Service]\n");
  // След прошлой раскладки: этот плагин снят.
  writeFileSync(
    join(unitDir, scoped("iva-mcp-old-server.service")),
    "[Service]\n",
  );
  writeFileSync(
    join(unitDir, scoped("iva-plugin-old-svc.service")),
    "[Service]\n",
  );

  const { control, calls } = fakeSystemctl({ unitDir });
  const created: string[] = [];
  const planned = plan([
    source0({
      mcp: [
        {
          server: "viewer",
          port: 8731,
          tokenFile: `${DATA}/plugin-data/trace/mcp-viewer.token`,
        },
      ],
      services: [
        { service: "web", command: "node", args: ["server.mjs"], port: 8726 },
      ],
    }),
  ]);

  const done = reconcilePluginUnits({
    plan: planned,
    unitDir,
    systemd: control,
    ensureDataDir: (plugin) => created.push(plugin),
    log: () => {},
  });

  assert.deepEqual(done.written, [
    scoped("iva-mcp-trace-viewer.service"),
    scoped("iva-plugin-trace-web.service"),
  ]);
  assert.deepEqual(done.started, done.written);
  assert.deepEqual(done.removed, []);
  assert.deepEqual(done.failures, []);
  // PLUGIN_DATA создаётся до старта юнита: сам юнит его не создаёт.
  assert.deepEqual(created, ["trace", "trace"]);
  assert.deepEqual(
    readdirSync(unitDir).sort(),
    [
      scoped("iva-mcp-trace-viewer.service"),
      scoped("iva-plugin-trace-web.service"),
      scoped("iva-mcp-old-server.service"),
      scoped("iva-plugin-old-svc.service"),
      "iva-telegram-poll.service",
      "iva.service",
      "unrelated.service",
    ].sort(),
  );
  assert.match(
    readFileSync(join(unitDir, scoped("iva-mcp-trace-viewer.service")), "utf8"),
    /--port 8731/u,
  );
  // An unknown unit name alone never authorizes disable or removal.
  assert.equal(
    calls.includes(scoped("disable --now iva-mcp-old-server.service")),
    false,
  );
  assert.ok(calls.includes("daemon-reload"), calls.join("\n"));

  // Второй прогон с пустым планом уносит и наши юниты, и только их.
  const empty = reconcilePluginUnits({
    plan: plan([]),
    unitDir,
    systemd: control,
  });
  assert.deepEqual(empty.removed, [
    scoped("iva-mcp-trace-viewer.service"),
    scoped("iva-plugin-trace-web.service"),
  ]);
  assert.deepEqual(
    readdirSync(unitDir).sort(),
    [
      scoped("iva-mcp-old-server.service"),
      scoped("iva-plugin-old-svc.service"),
      "iva-telegram-poll.service",
      "iva.service",
      "unrelated.service",
    ].sort(),
  );
  assert.deepEqual(
    installedPluginUnits({ scope, unitDir, systemd: control }),
    [],
  );
});

test("a unit that will not come up is reported and its neighbour still starts", () => {
  const unitDir = join(world(), "systemd");
  const { control } = fakeSystemctl({
    unitDir,
    broken: scoped("iva-mcp-trace-viewer.service"),
  });
  const done = reconcilePluginUnits({
    plan: plan([
      source0({
        mcp: [
          {
            server: "viewer",
            port: 8731,
            tokenFile: `${DATA}/plugin-data/trace/mcp-viewer.token`,
          },
        ],
        services: [{ service: "web", command: "node", args: [], port: 8726 }],
      }),
    ]),
    unitDir,
    systemd: control,
  });
  assert.deepEqual(done.started, [scoped("iva-plugin-trace-web.service")]);
  assert.equal(done.failures.length, 1);
  assert.ok(
    done.failures[0].startsWith(`${scoped("iva-mcp-trace-viewer.service")}: `),
  );
  // Файл всё равно на диске: чинить причину, а не искать, куда он делся.
  assert.ok(existsSync(join(unitDir, scoped("iva-mcp-trace-viewer.service"))));
});

test("the two copies of the plugin-part rule agree", () => {
  // Правило имени живёт в двух местах (юниты не грузят authored tree) — они обязаны
  // совпадать байт в байт, иначе `trust` примет имя, которое юнит потом отвергнет.
  assert.equal(UNIT_PART.source, SAFE_PLUGIN_PART.source);
  fc.assert(
    fc.property(fc.string(), (part) => {
      assert.equal(UNIT_PART.test(part), SAFE_PLUGIN_PART.test(part));
      return true;
    }),
  );
});

test("a data directory with a space or a percent survives into Environment=", () => {
  const odd = "/home/user/my box/100% iva/data";
  const body = pluginServiceUnitBody({
    plugin: "trace",
    service: "web",
    command: "node",
    args: ["server.mjs"],
    port: 8726,
    pluginRoot: `${odd}/custom/plugins/trace`,
    pluginData: `${odd}/plugin-data/trace`,
    dataDir: odd,
    nodeBinDir: "/opt/node bin",
  });
  // Кавычки — весь смысл: без них сервис получил бы `/home/user/my`, а `%` systemd съел бы
  // как спецификатор. `$` в `Environment=` не раскрывается, поэтому не трогается.
  assert.deepEqual(
    body.split("\n").filter((line) => line.startsWith("Environment=")),
    [
      'Environment="IVA_SERVICE_PORT=8726"',
      'Environment="IVA_DATA_DIR=/home/user/my box/100%% iva/data"',
      'Environment="PLUGIN_ROOT=/home/user/my box/100%% iva/data/custom/plugins/trace"',
      'Environment="PLUGIN_DATA=/home/user/my box/100%% iva/data/plugin-data/trace"',
      'Environment="PATH=%h/.local/bin:/opt/node bin:/usr/local/bin:/usr/bin:/bin"',
    ],
  );
  // `%h` в нашей части PATH остаётся спецификатором: удваивается только чужое значение.
  const dollar = pluginServiceUnitBody({
    plugin: "trace",
    service: "web",
    command: "node",
    args: [],
    port: 8726,
    pluginRoot: "/r",
    pluginData: '/d/$HOME/"quoted"\\back',
    dataDir: "/d",
    nodeBinDir: "/n",
  });
  assert.match(
    dollar,
    /^Environment="PLUGIN_DATA=\/d\/\$HOME\/\\"quoted\\"\\\\back"$/mu,
  );
  assert.throws(
    () =>
      pluginServiceUnitBody({
        plugin: "trace",
        service: "web",
        command: "node",
        args: [],
        port: 8726,
        pluginRoot: "/r",
        pluginData: "/d/line\nbreak",
        dataDir: "/d",
        nodeBinDir: "/n",
      }),
    /NUL or a newline/u,
  );
});

test("a rewritten unit is restarted, an unchanged one is left running", () => {
  const unitDir = join(world(), "systemd");
  const { control, calls } = fakeSystemctl({ unitDir });
  const planned = () =>
    plan([
      source0({
        services: [{ service: "web", command: "node", args: [], port: 8726 }],
      }),
    ]);

  const first = reconcilePluginUnits({
    plan: planned(),
    unitDir,
    systemd: control,
  });
  // Первый прогон только поднимает: рестартовать нечего.
  assert.deepEqual(first.started, [scoped("iva-plugin-trace-web.service")]);
  assert.deepEqual(first.restarted, []);

  // Тот же план — тот же файл: работающий юнит не трогаем.
  calls.length = 0;
  const again = reconcilePluginUnits({
    plan: planned(),
    unitDir,
    systemd: control,
  });
  assert.deepEqual(again.restarted, []);
  assert.equal(
    calls.includes(scoped("restart iva-plugin-trace-web.service")),
    false,
    calls.join("\n"),
  );

  // Автор поменял `service.json`: тело юнита другое, и `enable --now` работающий
  // процесс не заменит — нужен рестарт.
  calls.length = 0;
  const changed = reconcilePluginUnits({
    plan: plan([
      source0({
        services: [
          { service: "web", command: "node", args: ["--quiet"], port: 8726 },
        ],
      }),
    ]),
    unitDir,
    systemd: control,
  });
  assert.deepEqual(changed.restarted, [scoped("iva-plugin-trace-web.service")]);
  assert.ok(
    calls.indexOf(scoped("enable --now iva-plugin-trace-web.service")) <
      calls.indexOf(scoped("restart iva-plugin-trace-web.service")),
    calls.join("\n"),
  );
  assert.match(
    readFileSync(join(unitDir, scoped("iva-plugin-trace-web.service")), "utf8"),
    /--quiet/u,
  );
});

test("one unit name for two plugins installs neither and names both", () => {
  // `a-b` с сервером `c` и `a` с сервером `b-c` дают одно имя юнита.
  const planned = pluginUnitPlan({
    scope,
    plugins: [
      source0({
        name: "a-b",
        root: `${DATA}/custom/plugins/a-b`,
        data: `${DATA}/plugin-data/a-b`,
        mcp: [{ server: "c", port: 8730, tokenFile: "/t1" }],
      }),
      source0({
        name: "a",
        root: `${DATA}/custom/plugins/a`,
        data: `${DATA}/plugin-data/a`,
        mcp: [{ server: "b-c", port: 8731, tokenFile: "/t2" }],
      }),
      // Сервисы — то же правило и то же имя.
      source0({
        name: "x-y",
        root: `${DATA}/custom/plugins/x-y`,
        data: `${DATA}/plugin-data/x-y`,
        services: [{ service: "z", command: "node", args: [], port: 8732 }],
      }),
      source0({
        name: "x",
        root: `${DATA}/custom/plugins/x`,
        data: `${DATA}/plugin-data/x`,
        services: [{ service: "y-z", command: "node", args: [], port: 8733 }],
      }),
      // Сосед без коллизии остаётся.
      source0({
        mcp: [{ server: "viewer", port: 8734, tokenFile: "/t3" }],
      }),
    ],
    root: ROOT,
    node: NODE,
    nodeBinDir: NODE_BIN,
    dataDir: DATA,
    dataDirEnvironment: `"ASSISTANT_DATA_DIR=${DATA}"`,
  });

  assert.deepEqual(
    planned.units.map((unit) => unit.unit),
    [scoped("iva-mcp-trace-viewer.service")],
  );
  assert.deepEqual(planned.diagnostics, [
    scoped(
      "plugins a and a-b both want the unit iva-mcp-a-b-c.service; neither is installed - remove one: iva plugin remove <name>",
    ),
    scoped(
      "plugins x and x-y both want the unit iva-plugin-x-y-z.service; neither is installed - remove one: iva plugin remove <name>",
    ),
  ]);
});

test("the units of one plugin resolve to owned running representations", () => {
  const unitDir = join(world(), "systemd");
  const fake = fakeSystemctl({ unitDir });
  const planned = plan([
    source0({
      services: [{ service: "web", command: "node", args: [], port: 8726 }],
    }),
  ]);
  reconcilePluginUnits({ plan: planned, unitDir, systemd: fake.control });
  const entry = {
    name: "trace",
    services: { web: { port: 8726 }, gone: { port: 8727 } },
  };
  assert.deepEqual(pluginUnitNames(entry, scope), [
    scoped("iva-plugin-trace-web.service"),
    scoped("iva-plugin-trace-gone.service"),
  ]);
  assert.deepEqual(pluginUnitNames({ name: "bare" }, scope), []);
  assert.deepEqual(
    runningPluginUnits({
      scope,
      entries: [entry],
      unitDir,
      systemd: fake.control,
    }),
    [scoped("iva-plugin-trace-web.service")],
  );
  assert.deepEqual(
    runningPluginUnits({ scope, entries: [], unitDir, systemd: fake.control }),
    [],
    "a marked running unit excluded by the caller is not restarted",
  );
  fake.active.clear();
  assert.deepEqual(
    runningPluginUnits({
      scope,
      entries: [entry],
      unitDir,
      systemd: fake.control,
    }),
    [],
  );
});

for (const kind of ["service", "mcp"] as const)
  for (const drift of ["comment", "arguments"] as const)
    for (const marked of [false, true])
      test(`scope retains active legacy ${kind} ${drift} drift ${marked ? "marked" : "unmarked"} with metadata only`, () => {
        const unitDir = join(world(), "units");
        mkdirSync(unitDir);
        const fake = fakeSystemctl({ unitDir });
        const planned = plan([
          source0(
            kind === "service"
              ? {
                  services: [
                    { service: "web", command: "node", args: [], port: 8726 },
                  ],
                }
              : {
                  mcp: [
                    {
                      server: "viewer",
                      port: 8730,
                      tokenFile: `${DATA}/plugin-data/trace/mcp-viewer.token`,
                    },
                  ],
                },
          ),
        ]);
        const unit = planned.units[0],
          legacy = unit.unit.replace(`${scope.id}-`, "");
        const payload =
          drift === "comment"
            ? `${pluginUnitPayload(unit.body)}# pre-existing legacy comment\n`
            : pluginUnitPayload(unit.body).replace(
                /^(ExecStart=.+)$/mu,
                "$1 --legacy-option",
              );
        writeFileSync(
          join(unitDir, legacy),
          marked
            ? markPluginUnit(payload, { ...unit.identity, layout: "legacy" })
            : payload,
        );
        fake.active.add(legacy);
        fake.enabled.add(legacy);
        const migrated = reconcilePluginUnits({
          plan: planned,
          unitDir,
          systemd: fake.control,
        });
        assert.deepEqual(migrated.failures, []);
        assert.equal(
          pluginUnitPayload(readFileSync(join(unitDir, legacy), "utf8")),
          payload,
        );
        assert.equal(
          readPluginUnitMarker(
            readFileSync(join(unitDir, legacy), "utf8"),
            legacy,
          )?.layout,
          "legacy",
        );
        assert.equal(existsSync(join(unitDir, unit.unit)), false);
        assert.equal(fake.active.has(legacy), true);
        assert.deepEqual(
          fake.calls.filter((call) =>
            /^(restart|stop|enable|disable|reset-failed|daemon-reload)( |$)/u.test(
              call,
            ),
          ),
          [],
        );
        fake.calls.length = 0;
        assert.deepEqual(
          reconcilePluginUnits({
            plan: planned,
            unitDir,
            systemd: fake.control,
          }).written,
          [],
        );
        const inventory = inspectPluginUnits({
          scope,
          unitDir,
          units: planned.units,
          systemd: fake.control,
        });
        assert.equal(
          inventory.actual.get(pluginUnitKey(unit.identity))?.unit,
          legacy,
        );
        assert.deepEqual(
          runningPluginUnits({
            scope,
            unitDir,
            units: planned.units,
            systemd: fake.control,
          }),
          [legacy],
        );
      });
for (const kind of ["service", "mcp"] as const)
  for (const layout of ["scoped", "legacy"] as const)
    test(`scope rejects loaded B behind an owned ${layout} ${kind} file in restart and removal`, () => {
      const unitDir = join(world(), "units"),
        loaded = new Map<string, string>();
      const fake = fakeSystemctl({ unitDir, loaded });
      const planned = plan([
        source0(
          kind === "service"
            ? {
                services: [
                  { service: "web", command: "node", args: [], port: 8726 },
                ],
              }
            : {
                mcp: [
                  {
                    server: "viewer",
                    port: 8730,
                    tokenFile: `${DATA}/plugin-data/trace/mcp-viewer.token`,
                  },
                ],
              },
        ),
      ]);
      reconcilePluginUnits({ plan: planned, unitDir, systemd: fake.control });
      const original = planned.units[0];
      const identity = { ...original.identity, layout };
      const unit = {
        ...original,
        identity,
        unit: scopedPluginUnitName(identity),
      };
      if (layout === "legacy") {
        rmSync(join(unitDir, original.unit));
        fake.active.delete(original.unit);
        writeFileSync(
          join(unitDir, unit.unit),
          markPluginUnit(pluginUnitPayload(original.body), identity),
        );
        fake.active.add(unit.unit);
      }
      const file = join(unitDir, unit.unit),
        before = readFileSync(file, "utf8");
      loaded.set(unit.unit, before.replaceAll(DATA, `${DATA}-foreign`));
      fake.calls.length = 0;
      assert.deepEqual(
        runningPluginUnits({
          scope,
          unitDir,
          units: planned.units,
          systemd: fake.control,
        }),
        [],
      );
      const removed = reconcilePluginUnits({
        plan: plan([]),
        unitDir,
        systemd: fake.control,
      });
      assert.deepEqual(removed.removed, []);
      assert.equal(readFileSync(file, "utf8"), before);
      assert.equal(fake.active.has(unit.unit), true);
      assert.deepEqual(
        fake.calls.filter((call) =>
          /^(restart|stop|enable|disable|reset-failed)( |$)/u.test(call),
        ),
        [],
      );
    });
for (const collision of [
  "foreign-body",
  "symlink",
  "hardlink",
  "unknown-legacy",
] as const)
  test(`scope preserves ${collision} under an expected unit name`, () => {
    const dir = world(),
      unitDir = join(dir, "units");
    mkdirSync(unitDir);
    const fake = fakeSystemctl({ unitDir });
    const planned = plan([
      source0({
        services: [{ service: "web", command: "node", args: [], port: 8726 }],
      }),
    ]);
    const unit = planned.units[0];
    const file = join(
      unitDir,
      collision === "unknown-legacy"
        ? unit.unit.replace(`${scope.id}-`, "")
        : unit.unit,
    );
    const foreign = join(dir, "foreign");
    writeFileSync(foreign, "foreign bytes\n");
    if (collision === "symlink") symlinkSync(foreign, file);
    else if (collision === "hardlink") linkSync(foreign, file);
    else
      writeFileSync(
        file,
        collision === "unknown-legacy"
          ? "[Service]\n"
          : unit.body.replace(DATA, `${DATA}-B`),
      );
    const before = readFileSync(file, "utf8");
    fake.active.add(basename(file));
    const result = reconcilePluginUnits({
      plan: planned,
      unitDir,
      systemd: fake.control,
    });
    assert.ok(result.failures.length > 0);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(readFileSync(foreign, "utf8"), "foreign bytes\n");
    assert.deepEqual(
      fake.calls.filter((call) =>
        /^(restart|stop|enable|disable|reset-failed)( |$)/u.test(call),
      ),
      [],
    );
  });
test("scope failed stop retains the file and blocks a replacement listener", () => {
  const unitDir = join(world(), "units");
  const fake = fakeSystemctl({ unitDir });
  const planned = plan([
    source0({
      services: [{ service: "web", command: "node", args: [], port: 8726 }],
    }),
  ]);
  reconcilePluginUnits({ plan: planned, unitDir, systemd: fake.control });
  const unit = planned.units[0].unit,
    before = readFileSync(join(unitDir, unit), "utf8");
  const result = reconcilePluginUnits({
    plan: plan([]),
    unitDir,
    systemd: {
      ...fake.control,
      disableNow() {
        throw new Error("stop failed");
      },
    },
  });
  assert.deepEqual(result.removed, []);
  assert.equal(fake.active.has(unit), true);
  assert.equal(readFileSync(join(unitDir, unit), "utf8"), before);
});

function removalFixture(
  kind: "service" | "mcp",
  manager: "systemd" | "launchd",
  interrupted: boolean,
  layout: "scoped" | "legacy" = "scoped",
) {
  const unitDir = join(world(), "units");
  mkdirSync(unitDir);
  const planned = plan([
    source0(
      kind === "service"
        ? {
            services: [
              { service: "web", command: "node", args: [], port: 8726 },
            ],
          }
        : {
            mcp: [
              {
                server: "viewer",
                port: 8730,
                tokenFile: `${DATA}/plugin-data/trace/mcp-viewer.token`,
              },
            ],
          },
    ),
  ]);
  const original = planned.units[0];
  const identity = { ...original.identity, layout };
  const unit = {
    ...original,
    identity,
    unit: scopedPluginUnitName(identity),
    body: markPluginUnit(pluginUnitPayload(original.body), identity),
  };
  const body =
    manager === "systemd"
      ? unit.body
      : launchdPlan([unit], { root: ROOT }).get(launchdLabel(unit.unit))!;
  const file = unitPath(unit.unit, unitDir, manager);
  writeFileSync(file, body);
  const loaded = new Map([[unit.unit, interrupted ? unit.body : ""]]);
  const fake = fakeSystemctl({ unitDir, loaded });
  if (interrupted) fake.active.add(unit.unit);
  let jobLoaded = interrupted,
    disabled = false,
    crash = interrupted;
  const calls: string[][] = [];
  const control =
    manager === "systemd"
      ? fake.control
      : createSystemdControl({
          manager: "launchd",
          run: (args) =>
            runLaunchd(args, {
              unitDir,
              uid: 501,
              waitMs: 5,
              run: (argv) => {
                calls.push([...argv]);
                const [action, target] = argv;
                if (action === "print" && target === "gui/501")
                  return { code: 0, out: "" };
                if (action === "print") {
                  if (
                    !jobLoaded ||
                    target !== `gui/501/${launchdLabel(unit.unit)}`
                  )
                    return { code: 113, out: "" };
                  const fields = pluginPlistFields(body);
                  const env = Object.entries(fields.environment)
                    .map(([key, value]) => `\t\t${key} => ${value}`)
                    .join("\n");
                  return {
                    code: 0,
                    out: `gui/501/${launchdLabel(unit.unit)} = {\n\tstate = running\n\tpid = 123\n\tworking directory = ${fields.workingDirectory}\n\targuments = {\n${fields.exec.map((word) => `\t\t${word}`).join("\n")}\n\t}\n\tenvironment = {\n${env}\n\t}\n}\n`,
                  };
                }
                if (action === "print-disabled")
                  return {
                    code: 0,
                    out: `disabled services = {\n${disabled ? `\t"${launchdLabel(unit.unit)}" => disabled\n` : ""}}`,
                  };
                if (action === "disable") disabled = true;
                if (action === "bootout") jobLoaded = false;
                return { code: 0, out: "" };
              },
            }),
        });
  const effects: string[] = [];
  const systemd = {
    ...control,
    daemonReload: () => {
      effects.push("reload");
      return control.daemonReload();
    },
    resetFailed: (names?: readonly string[]) => {
      effects.push("reset");
      return control.resetFailed(names);
    },
    activate: (names: readonly string[]) => {
      effects.push("activate");
      return control.activate(names);
    },
    restart: (names: readonly string[]) => {
      effects.push("restart");
      return control.restart(names);
    },
    disableNow: (names: readonly string[]) => {
      effects.push("disable");
      control.disableNow(names);
      loaded.set(unit.unit, "");
      if (crash) {
        crash = false;
        throw new Error("interrupted after manager stop, before unlink");
      }
    },
  };
  return { unitDir, planned, unit, file, body, systemd, calls, effects };
}
for (const manager of ["systemd", "launchd"] as const)
  for (const kind of ["service", "mcp"] as const)
    for (const interrupted of [false, true])
      test(`owned scoped ${manager} ${kind} removal ${interrupted ? "retries interrupted stop" : "accepts not-found with existing file"}`, () => {
        const fixture = removalFixture(kind, manager, interrupted);
        const { unitDir, file, body, unit, systemd } = fixture;
        if (interrupted) {
          const first = reconcilePluginUnits({
            plan: plan([]),
            unitDir,
            systemd,
            manager,
            root: ROOT,
          });
          assert.deepEqual(first.removed, []);
          assert.match(
            first.failures.join("\n"),
            /interrupted after manager stop/u,
          );
          assert.equal(readFileSync(file, "utf8"), body);
        }
        const result = reconcilePluginUnits({
          plan: plan([]),
          unitDir,
          systemd,
          manager,
          root: ROOT,
        });
        assert.deepEqual(result.failures, []);
        assert.deepEqual(result.removed, [unit.unit]);
        assert.equal(existsSync(file), false);
        if (manager === "launchd")
          assert.ok(
            fixture.calls.some(
              (args) =>
                args[0] === "print" &&
                args[1].includes(launchdLabel(unit.unit)),
            ),
            "real backend received print 113 from fake",
          );
      });
for (const kind of ["service", "mcp"] as const)
  test(`unloaded legacy ${kind} is never adopted`, () => {
    const fixture = removalFixture(kind, "systemd", false);
    const { unitDir, unit, file, systemd } = fixture;
    const legacy = unit.unit.replace(`${scope.id}-`, "");
    writeFileSync(join(unitDir, legacy), pluginUnitPayload(unit.body));
    rmSync(file);
    const control = {
      ...systemd,
      query: (...args: string[]) =>
        args.includes("--property=LoadState")
          ? { code: 0, out: "not-found" }
          : systemd.query(...args),
    };
    const result = reconcilePluginUnits({
      plan: fixture.planned,
      unitDir,
      systemd: control,
    });
    assert.ok(result.failures.length);
    assert.equal(existsSync(file), false);
    assert.equal(
      readFileSync(join(unitDir, legacy), "utf8"),
      pluginUnitPayload(unit.body),
    );
  });

for (const kind of ["service", "mcp"] as const)
  test(`unknown loaded state preserves scoped ${kind}`, () => {
    const { unitDir, unit, file, body, systemd } = removalFixture(
      kind,
      "systemd",
      false,
    );
    const control = {
      ...systemd,
      query: (...args: string[]) =>
        args.includes("--property=LoadState")
          ? { code: 0, out: "error" }
          : systemd.query(...args),
      disableNow: () => {
        throw new Error("unknown ownership must not reach stop");
      },
    };
    const result = reconcilePluginUnits({
      plan: plan([]),
      unitDir,
      systemd: control,
    });
    assert.equal(result.removed.length, 0);
    assert.match(result.failures.join("\n"), /unknown loaded state/u);
    assert.equal(readFileSync(file, "utf8"), body);
    assert.equal(result.removed.includes(unit.unit), false);
  });

for (const kind of ["service", "mcp"] as const)
  for (const marked of [false, true])
    test(`launchd retained legacy ${kind} preserves plist args/comment ${marked ? "marked" : "unmarked"}`, () => {
      const fixture = removalFixture(kind, "launchd", true, "legacy");
      const { unitDir, unit, file, systemd, calls } = fixture;
      const payload =
        pluginUnitPayload(fixture.body).replace(
          "</array>",
          "<string>--retained-option</string></array>",
        ) + "<!-- retained legacy comment -->\n";
      writeFileSync(
        file,
        marked ? markPluginUnit(payload, unit.identity) : payload,
      );
      for (let repeat = 0; repeat < 2; repeat++) {
        calls.length = 0;
        fixture.effects.length = 0;
        const result = reconcilePluginUnits({
          plan: fixture.planned,
          unitDir,
          systemd,
          manager: "launchd",
          root: ROOT,
        });
        assert.deepEqual(result.failures, []);
        assert.deepEqual(result.started, []);
        assert.deepEqual(result.restarted, []);
        assert.deepEqual(result.restartAttempted, []);
        assert.deepEqual(fixture.effects, []);
        assert.equal(pluginUnitPayload(readFileSync(file, "utf8")), payload);
        assert.deepEqual(
          readPluginUnitMarker(readFileSync(file, "utf8"), unit.unit),
          unit.identity,
        );
        assert.ok(
          calls.every((args) => args[0] === "print"),
          JSON.stringify(calls),
        );
        assert.equal(
          existsSync(
            unitPath(fixture.planned.units[0].unit, unitDir, "launchd"),
          ),
          false,
        );
      }
    });

test("restart result separates attempted calls from confirmed success and continues its neighbour", () => {
  const unitDir = join(world(), "units"),
    fake = fakeSystemctl({ unitDir });
  const first = plan([
    source0({
      services: [{ service: "web", command: "node", args: ["v1"], port: 8726 }],
    }),
  ]);
  reconcilePluginUnits({ plan: first, unitDir, systemd: fake.control });
  const next = plan([
    source0({
      services: [
        { service: "web", command: "node", args: ["v2"], port: 8726 },
        { service: "extra", command: "node", args: [], port: 8727 },
      ],
    }),
  ]);
  const unit = first.units[0].unit;
  const systemd = {
    ...fake.control,
    restart: (units: readonly string[]) => {
      fake.control.restart(units);
      throw new Error("confirmation lost after accepted restart");
    },
  };
  const result = reconcilePluginUnits({ plan: next, unitDir, systemd });
  assert.deepEqual(result.restartAttempted, [unit]);
  assert.deepEqual(result.restarted, []);
  assert.match(result.failures.join("\n"), /confirmation lost/u);
  assert.ok(fake.active.has(next.units[1].unit));
  assert.ok(result.started.includes(next.units[1].unit));
});
