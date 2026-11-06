import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchdLabel, nextCalendarRun } from "./launchd-plist.ts";
import { systemdExecArgument } from "./systemd-values.ts";
export { launchdLabel };

export const GUI_REQUIRED =
  "macOS: войдите в систему на экране этого Mac — службы Ивы живут в вашей сессии";
type Result = { code: number; out: string; err?: string };
type Options = {
  unitDir?: string;
  uid?: number;
  run?: (args: readonly string[]) => Result;
  waitMs?: number;
};
type LaunchdState = {
  valid: boolean;
  state: string;
  pid: number | null;
  lastExit: number | null;
};
const EMPTY: LaunchdState = {
  valid: false,
  state: "",
  pid: null,
  lastExit: null,
};
const OK: Result = { code: 0, out: "" };

function printFields(lines: string[]): Record<string, string> | null {
  let depth = 0;
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const match = /^\t(state|pid|last exit code) = (.+)$/u.exec(line);
    if (depth === 1 && match) fields[match[1]] = match[2];
    if (/\{\s*$/u.test(line)) depth++;
    if (/^\s*\}$/u.test(line)) depth--;
    if (depth < 0) return null;
  }
  return depth === 0 ? fields : null;
}

function integer(value: string | undefined): number | null {
  if (!value || !/^-?\d+$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export function parseLaunchctlPrint(out: string): LaunchdState {
  const lines = out.trimEnd().split("\n");
  if (!/^gui\/\d+\/app\.iva[.-][^\s]+ = \{$/u.test(lines[0] ?? ""))
    return EMPTY;
  if (lines.at(-1) !== "}") return EMPTY;
  const fields = printFields(lines);
  if (!fields?.state) return EMPTY;
  const pid = integer(fields.pid);
  return {
    valid: true,
    state: fields.state,
    pid: pid !== null && pid > 0 ? pid : null,
    lastExit: integer(fields["last exit code"]),
  };
}

function pluginLoadedField(output: string, property: string): string {
  if (property === "WorkingDirectory") {
    const values = [...output.matchAll(/^\tworking directory = (.+)$/gmu)];
    if (values.length !== 1)
      throw new Error("plugin loaded WorkingDirectory unavailable");
    return values[0][1];
  }
  if (property !== "ExecStart")
    throw new Error("unsupported plugin ownership property");
  const args = /\targuments = \{\n([\s\S]*?)\n\t\}/u.exec(output)?.[1];
  const data = /^\t\tASSISTANT_DATA_DIR => (.+)$/mu.exec(output)?.[1];
  if (args === undefined || data === undefined)
    throw new Error("plugin loaded data arguments unavailable");
  const words = args
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return ["/usr/bin/env", `ASSISTANT_DATA_DIR=${data}`, ...words]
    .map(systemdExecArgument)
    .join(" ");
}

function launchctl(args: readonly string[]): Result {
  const result = spawnSync("launchctl", args, {
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    code: result.status ?? 127,
    out: result.stdout ?? "",
    err: result.stderr || result.error?.message || "",
  };
}

function domainFailure(
  run: (args: readonly string[]) => Result,
  domain: string,
): Result | null {
  const result = run(["print", domain]);
  if (result.code === 0) return null;
  return {
    code: 1,
    out:
      result.code === 127
        ? `launchctl print ${domain} failed: ${result.err || result.out}`
        : GUI_REQUIRED,
  };
}

export function launchdUnitPath(
  unit: string,
  unitDir = join(homedir(), "Library/LaunchAgents"),
): string {
  return join(unitDir, `${launchdLabel(unit)}.plist`);
}

export function unitPath(
  unit: string,
  dir: string,
  manager: "systemd" | "launchd" = "systemd",
): string {
  return manager === "launchd" ? launchdUnitPath(unit, dir) : join(dir, unit);
}

class LaunchdUnit {
  readonly unit: string;
  readonly options: Options;
  readonly run: (args: readonly string[]) => Result;
  readonly domain: string;
  readonly label: string;
  readonly target: string;
  readonly path: string;
  readonly keepAlive: boolean;
  readonly timer: boolean;
  readonly stopWaitMs: number;
  constructor(unit: string, options: Options) {
    this.unit = unit;
    this.options = options;
    this.run = options.run ?? launchctl;
    this.domain = `gui/${options.uid ?? process.getuid!()}`;
    this.label = launchdLabel(unit);
    this.target = `${this.domain}/${this.label}`;
    this.path = launchdUnitPath(unit, options.unitDir);
    this.keepAlive =
      existsSync(this.path) &&
      readFileSync(this.path, "utf8").includes("<key>KeepAlive</key>");
    this.timer = unit.endsWith(".timer");
    const exitTimeout = existsSync(this.path)
      ? /<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/u.exec(
          readFileSync(this.path, "utf8"),
        )?.[1]
      : undefined;
    this.stopWaitMs = options.waitMs ?? (Number(exitTimeout ?? 30) + 5) * 1000;
  }
  requireDomain(): void {
    const failure = domainFailure(this.run, this.domain);
    if (failure) throw new Error(failure.out);
  }
  inspect() {
    const result = this.run(["print", this.target]);
    if (result.code === 113) return { loaded: false, state: EMPTY };
    const state = parseLaunchctlPrint(result.out);
    if (result.code !== 0 || !state.valid)
      throw new Error(
        result.err || result.out || `invalid launchctl print ${this.target}`,
      );
    return { loaded: true, state };
  }
  show(property?: string): Result {
    if (property && /^iva-(mcp|plugin)-/u.test(this.unit))
      return this.pluginProperty(property);
    return { code: 0, out: existsSync(this.path) ? "loaded" : "not-found" };
  }
  pluginProperty(property: string): Result {
    const result = this.run(["print", this.target]);
    if (result.code === 113)
      return { code: 0, out: property === "LoadState" ? "not-found" : "" };
    if (result.code !== 0 || !parseLaunchctlPrint(result.out).valid)
      throw new Error("plugin loaded definition is unavailable");
    if (property === "LoadState") return { code: 0, out: "loaded" };
    return { code: 0, out: pluginLoadedField(result.out, property) };
  }

  enabled(): Result {
    if (!existsSync(this.path)) return { code: 1, out: "" };
    const result = this.run(["print-disabled", this.domain]);
    const out = result.out.trim();
    if (
      result.code !== 0 ||
      !out.startsWith("disabled services = {") ||
      !out.endsWith("}")
    )
      throw new Error(
        result.err || result.out || "invalid print-disabled output",
      );
    const disabled = out
      .split("\n")
      .some((line) => line.trim() === `"${this.label}" => disabled`);
    return { code: disabled ? 1 : 0, out: disabled ? "disabled" : "enabled" };
  }
  active(): Result {
    const { loaded, state } = this.inspect();
    if (!loaded) return { code: 3, out: "inactive" };
    if (this.timer) return { code: 0, out: "active" };
    if (this.keepAlive)
      return state.state === "running"
        ? { code: 0, out: "active" }
        : { code: 3, out: "activating" };
    return state.pid === null
      ? { code: 3, out: "inactive" }
      : { code: 0, out: "active" };
  }
  failed(): Result {
    const { loaded, state } = this.inspect();
    const failed =
      loaded &&
      state.pid === null &&
      state.lastExit !== null &&
      state.lastExit !== 0;
    return { code: failed ? 0 : 1, out: failed ? "failed" : "inactive" };
  }
  alreadyApplied(args: string[], code: number): boolean {
    // The mini probe gave 5 for duplicate bootstrap, but 5 is also a generic I/O error.
    if (args[0] === "bootstrap" && code === 5) {
      const current = this.inspect();
      return current.loaded && !this.stopping(current.state);
    }
    if (args[0] === "bootout" && code === 3)
      return this.run(["print", this.target]).code === 113;
    if (args[0] === "kill" && code === 113)
      return this.run(["print", this.target]).code === 113;
    return false;
  }
  checked(args: string[]): void {
    const result = this.run(args);
    if (result.code === 0 || this.alreadyApplied(args, result.code)) return;
    throw new Error(
      `launchctl ${args.join(" ")} failed: ${result.err || result.out}`,
    );
  }
  bootstrap(): void {
    this.checked(["bootstrap", this.domain, this.path]);
  }
  unload(): void {
    this.checked(["bootout", this.target]);
    this.waitFor("bootout", () => !this.inspect().loaded, this.stopWaitMs);
  }
  stopping(state: LaunchdState): boolean {
    return /^(?:SIG|stopping)/iu.test(state.state);
  }
  waitFor(action: string, ready: () => boolean, timeout: number): void {
    const end = Date.now() + timeout;
    do {
      if (ready()) return;
      if (Date.now() >= end) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    } while (Date.now() <= end);
    throw new Error(
      `launchctl ${action} ${this.label} failed: ${this.keepAlive && ["restart", "start", "enable"].includes(action) ? "did not become running" : "postcondition timed out"}`,
    );
  }
  load(): void {
    let current = this.inspect();
    if (this.stopping(current.state)) {
      this.waitFor("bootout", () => !this.inspect().loaded, this.stopWaitMs);
      current = this.inspect();
    }
    if (!current.loaded) this.bootstrap();
    this.waitFor(
      "bootstrap",
      () => {
        const next = this.inspect();
        return next.loaded && !this.stopping(next.state);
      },
      this.options.waitMs ?? 10_000,
    );
  }
  waitRunning(action: string): void {
    if (!this.keepAlive) return;
    let pid: number | null = null;
    let since = 0;
    this.waitFor(
      action,
      () => {
        const state = this.inspect().state;
        if (state.state !== "running" || state.pid === null) {
          pid = null;
          return false;
        }
        if (state.pid !== pid) {
          pid = state.pid;
          since = Date.now();
        }
        return Date.now() - since >= 1000;
      },
      this.options.waitMs ?? 10_000,
    );
  }
  enable(now: boolean): void {
    this.checked(["enable", this.target]);
    if (this.enabled().code !== 0)
      throw new Error(
        `launchctl enable ${this.label} failed: remained disabled`,
      );
    if (!now) return;
    this.load();
    this.waitRunning("enable");
  }
  disable(now: boolean): void {
    this.checked(["disable", this.target]);
    if (this.enabled().out !== "disabled")
      throw new Error(
        `launchctl disable ${this.label} failed: remained enabled`,
      );
    if (now) this.unload();
  }
  stop(): void {
    if (this.timer || this.keepAlive) {
      this.unload();
      return;
    }
    const current = this.inspect();
    if (current.state.pid !== null) {
      this.checked(["kill", "SIGTERM", this.target]);
      this.waitFor(
        "stop",
        () => this.inspect().state.pid === null,
        this.stopWaitMs,
      );
    }
  }
  start(): void {
    this.load();
    if (!this.timer && !this.keepAlive)
      this.checked(["kickstart", this.target]);
    this.waitRunning("start");
  }
  restart(): void {
    if (this.timer || this.keepAlive) {
      this.unload();
      this.load();
    } else {
      this.load();
      this.checked(["kickstart", "-k", this.target]);
    }
    this.waitRunning("restart");
  }
}

export function runLaunchd(
  args: readonly string[],
  options: Options = {},
): Result {
  const run = options.run ?? launchctl;
  const domain = `gui/${options.uid ?? process.getuid!()}`;
  const failure = domainFailure(run, domain);
  if (failure) return failure;
  const action = args[0] ?? "";
  if (["daemon-reload", "reset-failed"].includes(action)) return OK;
  const unit = args.slice(1).find((arg) => !arg.startsWith("-"));
  const known = [
    "show",
    "is-enabled",
    "is-active",
    "is-failed",
    "enable",
    "disable",
    "start",
    "stop",
    "restart",
  ];
  if (!known.includes(action))
    return { code: 1, out: `unsupported on macOS: ${action}` };
  if (!unit) return { code: 1, out: `missing unit: ${action}` };
  try {
    return dispatchLaunchd(
      new LaunchdUnit(unit, options),
      action,
      args.includes("--now"),
      args.find((arg) => arg.startsWith("--property="))?.slice(11),
    );
  } catch (error) {
    return {
      code: 1,
      out: launchdError(error),
    };
  }
}

function launchdError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dispatchLaunchd(
  control: LaunchdUnit,
  action: string,
  now: boolean,
  property?: string,
): Result {
  const queries: Record<string, () => Result> = {
    show: () => control.show(property),
    "is-enabled": () => control.enabled(),
    "is-active": () => control.active(),
    "is-failed": () => control.failed(),
  };
  if (queries[action]) return queries[action]();
  const mutations: Record<string, () => void> = {
    enable: () => control.enable(now),
    disable: () => control.disable(now),
    start: () => control.start(),
    stop: () => control.stop(),
    restart: () => control.restart(),
  };
  mutations[action]();
  return OK;
}

export function unloadLaunchd(unit: string, unitDir?: string): void {
  const control = new LaunchdUnit(unit, { unitDir });
  control.requireDomain();
  control.unload();
}

function calendarNext(file: string): string | null {
  if (!existsSync(file)) return null;
  const calendar =
    /<key>StartCalendarInterval<\/key><dict>(.*?)<\/dict>/su.exec(
      readFileSync(file, "utf8"),
    )?.[1] ?? "";
  const hour = /<key>Hour<\/key><integer>(\d+)<\/integer>/u.exec(calendar)?.[1];
  const minute = /<key>Minute<\/key><integer>(\d+)<\/integer>/u.exec(
    calendar,
  )?.[1];
  return hour && minute ? nextCalendarRun(Number(hour), Number(minute)) : null;
}

export function describeLaunchd(
  units: readonly string[],
  options: Options = {},
) {
  const run = options.run ?? launchctl;
  const domain = `gui/${options.uid ?? process.getuid!()}`;
  return units.map((unit) => {
    const result = run(["print", `${domain}/${launchdLabel(unit)}`]);
    const state = parseLaunchctlPrint(result.out);
    const loaded = result.code === 0 && state.valid;
    return {
      unit,
      label: launchdLabel(unit),
      loaded,
      running: loaded && state.state === "running",
      pid: state.pid,
      lastExit: state.lastExit,
      nextRun: loaded
        ? calendarNext(launchdUnitPath(unit, options.unitDir))
        : null,
    };
  });
}
