import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { createSystemdControl } from "./systemd-control.ts";
import { serviceManager } from "./service-manager.ts";
import {
  runLaunchd,
  parseLaunchctlPrint,
  GUI_REQUIRED,
  describeLaunchd,
} from "./launchd.ts";
import {
  unitToPlist,
  launchdPlan,
  writeLaunchdUnits,
  calendarInterval,
  pluginPlistFields,
} from "./launchd-plist.ts";
import {
  systemdExecArgument,
  systemdExecWords,
  systemdEnvironmentSegment,
} from "./systemd-values.ts";
import { mcpProxyUnitBody, pluginServiceUnitBody } from "./plugin-units.ts";
import {
  pluginUnitScope,
  scopedPluginUnitName,
  markPluginUnit,
  readPluginUnitMarker,
} from "./plugin-unit-scope.ts";
import { classifyLsofListeners } from "./listener-security.ts";
import { bindProbe, lsofProbe, PortChecker, PortSelector } from "./ports.ts";

const codes = JSON.parse(
  readFileSync(
    new URL("../fixtures/launchctl-codes.json", import.meta.url),
    "utf8",
  ),
) as {
  bootstrapLoaded: number;
  bootoutUnloaded: number;
  printUnloaded: number;
  killUnloaded: number;
};
const seed = 20261017;
void test("calendar conversion uses the requested zone independently of the caller TZ", () => {
  assert.deepEqual(
    calendarInterval(
      "*-*-* 05:00:00 Asia/Tashkent",
      new Date("2026-10-17T12:00:00Z"),
      "UTC",
    ),
    { Hour: 0, Minute: 0 },
  );
  assert.deepEqual(
    calendarInterval(
      "*-*-* 10:00:00 UTC",
      new Date("2026-10-17T12:00:00Z"),
      "Asia/Tashkent",
    ),
    { Hour: 15, Minute: 0 },
  );
});
const print = (state: string, pid = false, exit = 0) =>
  `gui/501/app.iva.iva = {\n\tstate = ${state}\n${pid ? "\tpid = 123\n" : ""}\tlast exit code = ${exit}\n}\n`;

void test("manager selection keeps systemctl ahead of the host platform", () => {
  assert.equal(
    serviceManager({ platform: "darwin", systemctlOnPath: () => true }),
    "systemd",
  );
  assert.equal(
    serviceManager({ platform: "darwin", systemctlOnPath: () => false }),
    "launchd",
  );
  assert.equal(
    serviceManager({ platform: "linux", systemctlOnPath: () => false }),
    null,
  );
});

void test("missing launchctl names the failed command, while a missing GUI domain asks for login", () => {
  const missing = runLaunchd(["daemon-reload"], {
    uid: 501,
    run: () => ({ code: 127, out: "", err: "spawnSync launchctl ENOENT" }),
  });
  assert.equal(missing.code, 1);
  assert.match(missing.out, /launchctl print gui\/501 failed.*ENOENT/u);
  assert.deepEqual(
    runLaunchd(["daemon-reload"], {
      uid: 501,
      run: () => ({ code: 1, out: "" }),
    }),
    { code: 1, out: GUI_REQUIRED },
  );
});

void test("launchd verbs, throttled writers and pair calendars follow spec 3.2", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-launchd-control-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "app.iva.iva.plist"), "<key>KeepAlive</key><true/>");
  writeFileSync(
    join(dir, "app.iva.iva-brain.plist"),
    "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>5</integer><key>Minute</key><integer>0</integer></dict>",
  );
  let loaded = false;
  let state = "waiting";
  let pid = false;
  let exit = 0;
  let domain = true;
  let disabled = false;
  let fault = "";
  const calls: string[][] = [];
  const run = (args: readonly string[]) => {
    calls.push([...args]);
    const verb = args[0];
    if (verb === "print" && args[1] === "gui/501")
      return { code: domain ? 0 : 1, out: "" };
    if (verb === "print")
      return loaded
        ? { code: 0, out: print(state, pid, exit) }
        : { code: codes.printUnloaded, out: "" };
    if (verb === "print-disabled")
      return {
        code: 0,
        out: `disabled services = {\n${disabled ? '\t"app.iva.iva" => disabled\n' : ""}}\n`,
      };
    if (verb === fault) return { code: 9, out: "failure" };
    if (verb === "bootstrap") {
      if (loaded) return { code: codes.bootstrapLoaded, out: "already loaded" };
      loaded = true;
      state = "running";
      pid = true;
    }
    if (verb === "bootout") {
      if (!loaded) return { code: codes.bootoutUnloaded, out: "not loaded" };
      loaded = false;
      pid = false;
    }
    if (verb === "kill") {
      if (!loaded) return { code: codes.killUnloaded, out: "not loaded" };
      pid = false;
      state = "waiting";
    }
    if (verb === "kickstart") {
      pid = true;
      state = "running";
    }
    if (verb === "disable") disabled = true;
    if (verb === "enable") disabled = false;
    return { code: 0, out: "" };
  };
  const query = (...args: string[]) =>
    runLaunchd(args, { run, unitDir: dir, uid: 501, waitMs: 1500 });
  const control = createSystemdControl({
    run: (args) => query(...args),
    manager: "launchd",
  });
  assert.deepEqual(query("daemon-reload"), { code: 0, out: "" });
  assert.deepEqual(query("reset-failed", "iva.service"), { code: 0, out: "" });
  assert.equal(
    query("show", "--property=LoadState", "--value", "iva.service").out,
    "loaded",
  );
  assert.equal(query("show", "absent.service").out, "not-found");
  control.activate(["iva.service"]);
  assert.equal(query("is-active", "iva.service").out, "active");
  calls.length = 0;
  control.restart(["iva.service"]);
  assert.deepEqual(
    calls
      .filter((c) => ["bootout", "bootstrap", "kickstart"].includes(c[0]))
      .map((c) => c[0]),
    ["bootout", "bootstrap"],
  );
  state = "waiting";
  pid = false;
  exit = 9;
  assert.deepEqual(query("is-active", "iva.service"), {
    code: 3,
    out: "activating",
  });
  assert.deepEqual(query("is-failed", "iva.service"), {
    code: 0,
    out: "failed",
  });
  assert.equal(query("stop", "iva.service").code, 0);
  assert.equal(loaded, false);
  assert.equal(query("stop", "iva.service").code, 0);
  assert.equal(query("stop", "iva-brain.service").code, 0);
  assert.equal(query("start", "--no-block", "iva-brain.service").code, 0);
  assert.equal(query("stop", "iva-brain.service").code, 0);
  assert.equal(loaded, true);
  assert.equal(pid, false);
  assert.equal(query("is-active", "iva-brain.timer").out, "active");
  calls.length = 0;
  assert.equal(query("restart", "iva-brain.timer").code, 0);
  assert.equal(
    calls.some((c) => c[0] === "kickstart"),
    false,
  );
  calls.length = 0;
  assert.equal(query("restart", "iva-brain.service").code, 0);
  assert.ok(calls.some((c) => c.join(" ").startsWith("kickstart -k ")));
  assert.equal(query("stop", "iva-brain.timer").code, 0);
  assert.equal(loaded, false);
  assert.equal(query("disable", "--now", "iva.service").code, 0);
  assert.equal(query("is-enabled", "iva.service").out, "disabled");
  fault = "enable";
  assert.throws(
    () => control.activate(["iva.service"]),
    /launchctl enable.*failed/u,
  );
  fault = "disable";
  assert.throws(
    () => control.disableNow(["iva.service"]),
    /launchctl disable.*failed/u,
  );
  domain = false;
  assert.deepEqual(query("daemon-reload"), { code: 1, out: GUI_REQUIRED });
  domain = true;
  assert.equal(query("list-units").out, "unsupported on macOS: list-units");
  assert.equal(
    describeLaunchd(["iva-brain.timer"], { run, uid: 501, unitDir: dir })[0]
      .loaded,
    false,
  );
});

void test("a KeepAlive process that exits during bootstrap fails restart with a log hint", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-launchd-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "app.iva.iva.plist"), "<key>KeepAlive</key><true/>");
  let loaded = false;
  const run = (args: readonly string[]) => {
    if (args[0] === "bootout") loaded = false;
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "print" && args[1] !== "gui/501")
      return loaded
        ? { code: 0, out: print("waiting", false, 1) }
        : { code: 113, out: "" };
    return { code: 0, out: "" };
  };
  const control = createSystemdControl({
    manager: "launchd",
    run: (args) =>
      runLaunchd(args, { run, unitDir: dir, uid: 501, waitMs: 1500 }),
  });
  assert.throws(
    () => control.restart(["iva.service"]),
    /did not become running.*tail -n 100.*iva.out.log/u,
  );
});

void test("generic bootstrap 5 and corrupt print never grant a successful restart", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-launchd-fault-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "app.iva.iva.plist"), "<key>KeepAlive</key><true/>");
  const run = (args: readonly string[]) =>
    args[0] === "print" && args[1] === "gui/501"
      ? { code: 0, out: "" }
      : args[0] === "bootstrap"
        ? { code: codes.bootstrapLoaded, out: "I/O error" }
        : { code: codes.printUnloaded, out: "" };
  assert.equal(
    runLaunchd(["start", "iva.service"], {
      run,
      uid: 501,
      unitDir: dir,
      waitMs: 1500,
    }).code,
    1,
  );
  const corrupt = (args: readonly string[]) => ({
    code: 0,
    out: args[1] === "gui/501" ? "" : "state = running",
  });
  assert.equal(
    runLaunchd(["is-active", "iva.service"], {
      run: corrupt,
      uid: 501,
      unitDir: dir,
    }).code,
    1,
  );
});

void test("a concurrent bootstrap and a disappearing oneshot are idempotent after print readback", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-launchd-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "app.iva.iva.plist"), "<key>KeepAlive</key><true/>");
  let loaded = false;
  const run = (args: readonly string[]) => {
    if (args[0] === "print" && args[1] === "gui/501")
      return { code: 0, out: "" };
    if (args[0] === "bootstrap") {
      loaded = true; // The other writer won after our initial print.
      return { code: codes.bootstrapLoaded, out: "already loaded" };
    }
    if (args[0] === "kill") {
      loaded = false; // The timer was unloaded after we read its pid.
      return { code: codes.killUnloaded, out: "not loaded" };
    }
    return loaded
      ? { code: 0, out: print("running", true) }
      : { code: codes.printUnloaded, out: "" };
  };
  const options = { run, uid: 501, unitDir: dir, waitMs: 1500 };
  assert.deepEqual(runLaunchd(["start", "iva.service"], options), {
    code: 0,
    out: "",
  });
  assert.deepEqual(runLaunchd(["stop", "iva-brain.service"], options), {
    code: 0,
    out: "",
  });
  assert.equal(loaded, false);
});

void test(`print parser rejects arbitrary garbage and every truncated record (seed ${seed})`, () => {
  fc.assert(
    fc.property(fc.string(), (value) =>
      assert.notEqual(parseLaunchctlPrint(value).state, "running"),
    ),
    { seed },
  );
  const valid = print("running", true);
  for (let i = 0; i < valid.trimEnd().length; i++)
    assert.equal(parseLaunchctlPrint(valid.slice(0, i)).valid, false);
  assert.equal(parseLaunchctlPrint(valid).state, "running");
});

function plistJson(xml: string): Record<string, unknown> {
  const result = spawnSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "--", "-"],
    { input: xml, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

void test(
  `unit escaping round-trips through real plist XML (seed ${seed})`,
  { skip: process.platform !== "darwin" },
  () => {
    const values = fc
      .array(
        fc.constantFrom(
          "a",
          " ",
          "$",
          "%",
          "h",
          '"',
          "\\",
          "<",
          "&",
          "я",
          "東",
          "🙂",
        ),
        { maxLength: 64 },
      )
      .map((parts) => parts.join(""));
    fc.assert(
      fc.property(values, (value) => {
        const xml = unitToPlist(
          {
            unit: "iva-test.service",
            body: `ExecStart=${systemdExecArgument(process.execPath)} ${systemdExecArgument(value)}\nEnvironment="TEST=${systemdEnvironmentSegment(value)}"\n`,
          },
          undefined,
          { root: "/fixture/current", home: "/fixture/home" },
        );
        const parsed = plistJson(xml);
        assert.equal((parsed.ProgramArguments as string[]).at(-1), value);
        assert.equal(
          (parsed.EnvironmentVariables as Record<string, string>).TEST,
          value,
        );
      }),
      { seed, numRuns: 100 },
    );
  },
);

void test("unit plans reject unknown or ambiguous directives before writing, preserve old plists on failure", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-plist-plan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = {
    unit: "iva-test.service",
    body: "ExecStart=/bin/true\nType=oneshot\n",
  };
  const options = {
    root: "/fixture/current",
    home: dir,
    control: () => ({ code: 0, out: "disabled services = {\n}\n" }),
  };
  assert.throws(
    () =>
      launchdPlan(
        [{ ...service, body: service.body + "Invented=yes\n" }],
        options,
      ),
    /iva-test.service/u,
  );
  assert.throws(
    () =>
      launchdPlan(
        [{ unit: "iva-test.timer", body: "OnCalendar=*-*-* 05:00:00 UTC" }],
        options,
      ),
    /timer without service/u,
  );
  assert.throws(() => launchdPlan([service, service], options), /duplicate/u);
  const units = join(dir, "Library/LaunchAgents");
  writeLaunchdUnits([service], units, options);
  const path = join(units, "app.iva.iva-test.plist");
  const before = readFileSync(path, "utf8");
  assert.throws(() =>
    writeLaunchdUnits(
      [{ ...service, body: service.body + "Unknown=yes" }],
      units,
      options,
    ),
  );
  assert.equal(readFileSync(path, "utf8"), before);
  assert.deepEqual(readdirSync(units), ["app.iva.iva-test.plist"]);
  assert.equal(statSync(join(dir, "Library/Logs/Iva")).mode & 0o777, 0o700);
});

void test(
  "plist lint and directory failures preserve the installed plist and name the failing path",
  { skip: process.platform !== "darwin" },
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "iva-plist-refusal-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const service = {
      unit: "iva-test.service",
      body: "ExecStart=/bin/true\nType=oneshot\n",
    };
    const units = join(dir, "units");
    const options = {
      root: "/fixture/current",
      home: dir,
      control: () => ({ code: 0, out: "disabled services = {\n}\n" }),
    };
    writeLaunchdUnits([service], units, options);
    const installed = join(units, "app.iva.iva-test.plist");
    const before = readFileSync(installed, "utf8");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "plutil"),
      "#!/bin/sh\necho 'lint refused' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    const prior = process.env.PATH;
    process.env.PATH = bin;
    try {
      assert.throws(
        () => writeLaunchdUnits([service], units, options),
        /app\.iva\.iva-test\.plist: plutil -lint failed: lint refused/u,
      );
    } finally {
      process.env.PATH = prior;
    }
    assert.equal(readFileSync(installed, "utf8"), before);
    assert.deepEqual(readdirSync(units), ["app.iva.iva-test.plist"]);
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "keep");
    assert.throws(
      () => writeLaunchdUnits([service], join(blocked, "units"), options),
      /not-a-directory/u,
    );
    assert.throws(
      () => writeLaunchdUnits([service], units, { ...options, home: blocked }),
      /not-a-directory/u,
    );
    assert.equal(readFileSync(installed, "utf8"), before);
  },
);

void test("an unavailable lsof leaves port ownership unknown and bind decides occupancy", async (t) => {
  const spawn = t.mock.method(childProcess, "spawnSync", () => ({
    status: null,
    stdout: null,
    stderr: null,
    error: Object.assign(new Error("lsof missing"), { code: "ENOENT" }),
  }));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.deepEqual(await lsofProbe.check(8723), {
    occupied: false,
    holder: "неизвестно (lsof недоступен)",
  });
  assert.equal(
    spawn.mock.calls[0].arguments[0],
    process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
  );

  const server = net.createServer();
  t.after(() => server.close());
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "0.0.0.0", () =>
      resolve((server.address() as net.AddressInfo).port),
    );
  });
  const checker = new PortChecker([bindProbe, lsofProbe]);
  assert.deepEqual(await checker.check(port), {
    port,
    occupied: true,
    holders: ["bind: порт занят"],
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.deepEqual(await checker.check(port), {
    port,
    occupied: false,
    holders: [],
  });
});

void test(
  "a free probe port stays free with the original launchd PATH without sbin",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const plist = plistJson(
      unitToPlist(
        {
          unit: "iva-test.service",
          body: `ExecStart=/usr/bin/env PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin ${process.execPath} /fixture/main.ts`,
        },
        undefined,
        { root: "/fixture", home: "/fixture/home" },
      ),
    );
    const env = plist.EnvironmentVariables as Record<string, string>;
    const server = net.createServer();
    t.after(() => server.close());
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "0.0.0.0", () =>
        resolve((server.address() as net.AddressInfo).port),
      );
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const prior = process.env.PATH;
    process.env.PATH = env.PATH.split(":")
      .filter((path) => path !== "/usr/sbin" && path !== "/sbin")
      .join(":");
    try {
      assert.equal(
        process.env.PATH,
        "/fixture/home/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
      );
      assert.equal(
        await new PortSelector(
          new PortChecker([bindProbe, lsofProbe]),
        ).firstFree(port, 1),
        port,
      );
    } finally {
      process.env.PATH = prior;
    }
    assert.equal(
      env.PATH,
      "/fixture/home/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
  },
);

void test(
  "lsof reports a real listening process under the restricted launchd PATH",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const server = net.createServer();
    t.after(() => server.close());
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "0.0.0.0", () =>
        resolve((server.address() as net.AddressInfo).port),
      );
    });
    const prior = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      const result = await lsofProbe.check(port);
      assert.equal(result.occupied, true);
      assert.match(result.holder ?? "", /\(LISTEN\)/u);
      assert.match(
        result.holder ?? "",
        new RegExp(`\\b${process.pid}\\b`, "u"),
      );
    } finally {
      process.env.PATH = prior;
    }
  },
);

void test(
  "every shipped deploy unit and generated plugin unit translates and passes plutil",
  { skip: process.platform !== "darwin" },
  () => {
    const root = join(import.meta.dirname, "../..");
    const units = readdirSync(join(root, "deploy"))
      .filter((file) => /\.(service|timer)$/u.test(file))
      .map((unit) => ({
        unit,
        body: readFileSync(join(root, "deploy", unit), "utf8")
          .replaceAll("__PROJECT_DIR__", "/fixture/current")
          .replaceAll("__NODE_BIN__", process.execPath)
          .replaceAll("__PYTHON_BIN__", "/usr/bin/python3")
          .replaceAll("__DATA_DIR_ENV__", '"ASSISTANT_DATA_DIR=/fixture/data"')
          .replaceAll("__TIMEZONE__", "UTC"),
      }));
    const plan = launchdPlan(units, { root: "/fixture/current" });
    for (const xml of plan.values()) plistJson(xml);
    for (const body of [
      mcpProxyUnitBody({
        plugin: "x",
        server: "a",
        port: 1234,
        tokenFile: "/fixture/token",
        root: "/fixture/current",
        node: process.execPath,
        nodeBinDir: "/usr/local/bin",
        dataDirEnvironment: '"ASSISTANT_DATA_DIR=/fixture/data"',
      }),
      pluginServiceUnitBody({
        plugin: "x",
        service: "a",
        port: 1234,
        command: "node",
        args: ["serve.ts"],
        pluginRoot: "/fixture/plugin",
        pluginData: "/fixture/data",
        dataDir: "/fixture/data",
        nodeBinDir: "/usr/local/bin",
      }),
    ])
      plistJson(
        unitToPlist({ unit: "iva-plugin-x-a.service", body }, undefined, {
          root: "/fixture/current",
        }),
      );
  },
);

void test(`lsof exposes wildcard listeners and treats garbage conservatively (seed ${seed})`, () => {
  for (const [host, expected] of [
    ["127.0.0.1", "loopback"],
    ["[::1]", "loopback"],
    ["*", "exposed"],
    ["[::]", "exposed"],
  ] as const)
    assert.equal(
      classifyLsofListeners(
        `node 123 u 1u IPv4 0 0t0 TCP ${host}:8723 (LISTEN)`,
        8723,
      ),
      expected,
    );
  fc.assert(
    fc.property(fc.string(), (value) =>
      assert.notEqual(classifyLsofListeners(value, 8723), "loopback"),
    ),
    { seed },
  );
});

void test("plugin ownership survives plist translation with the exact data anchor", () => {
  const scope = pluginUnitScope("/data/a");
  const identity = {
    scope,
    kind: "service",
    plugin: "trace",
    part: "web",
    layout: "scoped",
  } as const;
  const unit = scopedPluginUnitName(identity);
  const body = pluginServiceUnitBody({
    plugin: "trace",
    service: "web",
    port: 9000,
    pluginRoot: "/data/a/custom/plugins/trace",
    command: "node",
    args: ["web.ts"],
    pluginData: "/data/a/plugin-data/trace",
    dataDir: "/data/a",
    nodeBinDir: "/node/bin",
  });
  const xml = unitToPlist(
    { unit, body: markPluginUnit(body, identity) },
    undefined,
    { root: "/code/a" },
  );
  assert.deepEqual(readPluginUnitMarker(xml, unit), identity);
  assert.equal(
    pluginPlistFields(xml).workingDirectory,
    "/data/a/custom/plugins/trace/sh.iva/services/web",
  );
  assert.equal(
    pluginPlistFields(xml).environment.PLUGIN_DATA,
    "/data/a/plugin-data/trace",
  );
  assert.equal(readPluginUnitMarker(xml.replace("9000", "9001"), unit), null);
});

void test("plugin loaded proof reads only observable launchctl data fields and fails closed", () => {
  const unit = "iva-mcp-scope-trace-api.service";
  const calls: string[][] = [];
  let output = `gui/501/app.iva.iva-mcp-scope-trace-api = {
\tstate = running
\tpid = 123
\tworking directory = /data/a
\targuments = {
\t\t/node
\t\t/proxy.ts
\t\t--token-file
\t\t/data/a/plugin-data/trace/mcp-api.token
\t\t--port
\t\t9000
\t}
\tenvironment = {
\t\tASSISTANT_DATA_DIR => /data/a
\t}
}
`;
  const query = (property: string) =>
    runLaunchd(["show", unit, `--property=${property}`, "--value"], {
      uid: 501,
      run: (args) => {
        calls.push([...args]);
        return { code: 0, out: args[1] === "gui/501" ? "" : output };
      },
    });
  assert.equal(query("LoadState").out, "loaded");
  assert.equal(query("WorkingDirectory").out, "/data/a");
  assert.deepEqual(systemdExecWords(query("ExecStart").out), [
    "/usr/bin/env",
    "ASSISTANT_DATA_DIR=/data/a",
    "/node",
    "/proxy.ts",
    "--token-file",
    "/data/a/plugin-data/trace/mcp-api.token",
    "--port",
    "9000",
  ]);
  output = print("running", true);
  assert.equal(query("WorkingDirectory").code, 1);
  assert.equal(query("ExecStart").code, 1);
  assert.ok(calls.every((args) => args[0] === "print"));
  assert.deepEqual(
    runLaunchd(["show", unit, "--property=LoadState", "--value"], {
      uid: 501,
      run: (args) => ({ code: args[1] === "gui/501" ? 0 : 113, out: "" }),
    }),
    { code: 0, out: "not-found" },
  );
});
