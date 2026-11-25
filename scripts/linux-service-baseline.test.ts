import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { snapshot } from "node:test";
import { fileURLToPath } from "node:url";
import { plantCliTree } from "./fixtures/cli-tree.ts";
import { stableNodeExecutable } from "./lib/node-executable.ts";
import { mcpProxyUnitBody, pluginServiceUnitBody } from "./lib/plugin-units.ts";
import { SystemdControlError } from "./lib/systemd-control.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
snapshot.setResolveSnapshotPath(() =>
  join(ROOT, "scripts/fixtures/linux-service-baseline.snapshot"),
);

// Captured on 5e9615b1 before adding another unit manager. Only fixture paths and
// the Node installation path are normalized. Failure text excludes Node's stack and
// version banner, which change with source line numbers and the local Node version.
void test("Linux units, control argv and journal hints retain the release baseline", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-linux-baseline-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "iva");
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const trace = join(dir, "calls.jsonl");
  const state = join(dir, "state.json");
  mkdirSync(home);
  mkdirSync(bin);
  await plantCliTree(ROOT, project);
  writeFileSync(
    join(project, ".env"),
    `IVA_PORT=8723\nASSISTANT_TIMEZONE=UTC\nASSISTANT_BEARER=${"a".repeat(43)}\n`,
    { mode: 0o600 },
  );
  // Both executable names use one fake. The trace records argv as JSON arrays,
  // including --user, rather than shell-joining arguments and losing their boundaries.
  const fake = join(dir, "fake.ts");
  writeFileSync(
    fake,
    `import {appendFileSync, existsSync, readFileSync, writeFileSync} from "node:fs";
const [command, ...args] = process.argv.slice(2);
appendFileSync(process.env.IVA_BASELINE_TRACE, JSON.stringify([command, ...args])+"\\n");
if (command === "journalctl") process.exit(0);
const [, action, ...rest] = args;
const unit = rest.find(a => a.endsWith(".service") || a.endsWith(".timer"));
const path = process.env.IVA_BASELINE_STATE;
const states = existsSync(path) ? JSON.parse(readFileSync(path,"utf8")) : {};
const item = states[unit] ?? {active:false, enabled:false};
if (process.env.IVA_BASELINE_FAIL === action) process.exit(7);
switch(action) {
case "show": console.log(states[unit] ? "loaded" : "not-found"); break;
case "is-active": console.log(item.active ? "active" : "inactive"); process.exit(item.active ? 0 : 3);
case "is-enabled": console.log(item.enabled ? "enabled" : "disabled"); process.exit(item.enabled ? 0 : 1);
case "enable": item.enabled=true; if(rest.includes("--now")) item.active=true; break;
case "disable": item.enabled=false; if(rest.includes("--now")) item.active=false; break;
case "start": case "restart": item.active=true; break;
case "stop": item.active=false; break;
}
if (unit) states[unit]=item;
writeFileSync(path, JSON.stringify(states));
`,
  );
  for (const command of ["systemctl", "journalctl"]) {
    const path = join(bin, command);
    writeFileSync(
      path,
      `#!/bin/sh\nexec '${process.execPath}' '${fake}' '${command}' "$@"\n`,
    );
    chmodSync(path, 0o755);
  }
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    NO_COLOR: "1",
    TERM: "dumb",
    AGENT_LANGUAGE: "en",
    ASSISTANT_DATA_DIR: join(project, "data"),
    IVA_BASELINE_TRACE: trace,
    IVA_BASELINE_STATE: state,
  };
  const nodeBinDirs = [
    dirname(process.execPath),
    dirname(stableNodeExecutable(process.execPath)),
  ];
  const normalize = (value: string): string =>
    value
      .replaceAll(realpathSync(dir), "<fixture>")
      .replaceAll(dir, "<fixture>")
      .replaceAll(nodeBinDirs[0], "<node-bin>")
      .replaceAll(nodeBinDirs[1], "<node-bin>");
  const calls = (): string[][] => {
    const text = existsSync(trace) ? readFileSync(trace, "utf8").trim() : "";
    return text
      ? (JSON.parse(`[${text.split("\n").join(",")}]`) as string[][])
      : [];
  };
  const run = (
    argv: readonly string[],
    extra: Readonly<Record<string, string>> = {},
  ) => {
    writeFileSync(trace, "");
    const result = spawnSync(process.execPath, argv, {
      cwd: project,
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.ifError(result.error);
    return {
      code: result.status,
      out: normalize(result.stdout),
      err: normalize(result.stderr),
      calls: calls(),
    };
  };
  const cli = (args: string[], extra?: Readonly<Record<string, string>>) =>
    run([join(project, "bin/iva.mjs"), ...args], extra);
  const install = cli(["_install-units"]);
  assert.equal(install.code, 0, install.err);
  const unitDir = join(home, ".config/systemd/user");
  const units = Object.fromEntries(
    readdirSync(unitDir)
      .sort()
      .map((unit) => [
        unit,
        normalize(readFileSync(join(unitDir, unit), "utf8")),
      ]),
  );
  const activate = cli(["_activate-units"]);
  const restart = cli(["restart"]);
  const status = cli(["status"]);
  const logs = cli(["logs"]);
  const pollLogs = cli(["logs", "poll"]);
  const failedRestartResult = cli(["restart"], {
    IVA_BASELINE_FAIL: "restart",
  });
  const failureLine = failedRestartResult.err
    .split("\n")
    .find((line) => line.startsWith("SystemdControlError: "));
  assert.ok(failureLine, failedRestartResult.err);
  const failedRestart = { ...failedRestartResult, err: failureLine };
  for (const result of [activate, restart, status, logs, pollLogs])
    assert.equal(result.code, 0, result.err);
  assert.equal(failedRestart.code, 1);

  writeFileSync(
    state,
    JSON.stringify({
      "iva.service": { active: true, enabled: true },
      "iva-telegram-poll.service": { active: true, enabled: true },
      "iva-brain.service": { active: false, enabled: false },
      "iva-brain.timer": { active: true, enabled: true },
      "iva-telegram-userbot.service": { active: true, enabled: false },
    }),
  );
  const quiesceRestore = run([
    "--input-type=module",
    "-e",
    `import {createCliRuntime} from ${JSON.stringify(join(ROOT, "scripts/cli/runtime.ts"))};
import {captureOptionalWriterState,stopWriterUnits,restoreOptionalWriterState} from ${JSON.stringify(join(ROOT, "scripts/update-finish.ts"))};
const runtime=createCliRuntime(${JSON.stringify(project)});
const before=captureOptionalWriterState(runtime);
stopWriterUnits(runtime,before);
restoreOptionalWriterState(runtime,before);
console.log(JSON.stringify(before));`,
  ]);
  assert.equal(quiesceRestore.code, 0, quiesceRestore.err);
  const telegramRestart = run([
    "--input-type=module",
    "-e",
    `import {sc} from ${JSON.stringify(join(ROOT, "scripts/poller/transport.ts"))};
console.log(await sc("restart","iva.service","iva-telegram-poll.service"));`,
  ]);
  assert.equal(telegramRestart.code, 0, telegramRestart.err);
  t.assert.snapshot({
    units,
    install,
    activate,
    restart,
    status,
    logs,
    pollLogs,
    failedRestart,
    quiesceRestore,
    telegramRestart,
  });
});

void test("Linux plugin unit bodies and failure hints retain the release baseline", (t) => {
  // Explicitly select Linux semantics even when this baseline runs on macOS.
  const bin = mkdtempSync(join(tmpdir(), "iva-linux-hints-"));
  const originalPath = process.env.PATH;
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(bin, { recursive: true, force: true });
  });
  const nodeBinDir = "/fixture/node-bin";
  const root = "/fixture/iva/current";
  const proxy = mcpProxyUnitBody({
    plugin: "example",
    server: "stdio",
    port: 12345,
    tokenFile: "/fixture/iva/data/proxy.token",
    root,
    node: `${nodeBinDir}/node`,
    nodeBinDir,
    dataDirEnvironment: '"ASSISTANT_DATA_DIR=/fixture/iva/data"',
  });
  const service = pluginServiceUnitBody({
    plugin: "example",
    service: "web",
    command: "node",
    args: ["serve.ts", "a b", "$value", "50%", '<&"\\ю>'],
    port: 12346,
    pluginRoot: "/fixture/iva/data/custom/plugins/example",
    pluginData: "/fixture/iva/data/plugins/example",
    dataDir: "/fixture/iva/data",
    nodeBinDir,
  });
  const hints = [
    "iva.service",
    "iva-telegram-poll.service",
    "iva-brain.service",
    "iva-mcp-example-stdio.service",
    "iva-plugin-example-web.service",
  ].map((unit) => new SystemdControlError("failed", { unit, code: 7 }).message);
  t.assert.snapshot({ proxy, service, hints });
});
