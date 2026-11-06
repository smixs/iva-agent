import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { systemdEnvironmentWords, systemdExecWords } from "./systemd-values.ts";
import { markPluginUnit, readPluginUnitMarker } from "./plugin-unit-scope.ts";

type UnitBody = { unit: string; body: string };
type PlistOptions = {
  root: string;
  node?: string;
  home?: string;
  now?: Date;
  control?: (args: string[]) => { code: number; out: string };
};
type Value = string | number | boolean | Value[] | { [key: string]: Value };
const ignored = new Set([
  "Description",
  "After",
  "Wants",
  "WantedBy",
  "OOMPolicy",
  "KillMode",
]);
const supported = new Set([
  "ExecStart",
  "ExecStartPre",
  "ExecStartPost",
  "Environment",
  "EnvironmentFile",
  "WorkingDirectory",
  "UMask",
  "Restart",
  "RestartSec",
  "Type",
  "TimeoutStartSec",
  "OnCalendar",
  "Persistent",
]);

function stableNode(path: string): string {
  return path.replace(
    /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/u,
    "$1/opt/$2/bin/node",
  );
}

function plistControl(args: string[]): { code: number; out: string } {
  const result = spawnSync("launchctl", args, {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status !== 0)
    throw new Error(
      `launchctl ${args.join(" ")} failed: ${result.stderr || result.error?.message}`,
    );
  return { code: 0, out: result.stdout };
}

export function launchdLabel(unit: string): string {
  if (!/^[A-Za-z0-9_.@:-]+(?:\.service|\.timer)?$/u.test(unit))
    throw new Error(`invalid unit: ${unit}`);
  return `app.iva.${unit.replace(/\.(service|timer)$/u, "")}`;
}

function directives(unit: UnitBody): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const raw of unit.body.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || /^[#;[]/u.test(line)) continue;
    const match = /^([A-Za-z]+)=(.*)$/u.exec(line);
    if (!match || (!supported.has(match[1]) && !ignored.has(match[1])))
      throw new Error(`${unit.unit}: unsupported directive ${line}`);
    if (ignored.has(match[1])) continue;
    const values = result.get(match[1]) ?? [];
    values.push(match[2]);
    result.set(match[1], values);
  }
  return result;
}

function xml(value: Value): string {
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (typeof value === "number") return `<integer>${value}</integer>`;
  if (typeof value === "string") return `<string>${escapeXml(value)}</string>`;
  if (Array.isArray(value)) return `<array>${value.map(xml).join("")}</array>`;
  return `<dict>${Object.entries(value)
    .map(([key, item]) => `<key>${escapeXml(key)}</key>${xml(item)}`)
    .join("")}</dict>`;
}
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Only the fixed fields emitted for plugin ownership, not a general plist parser. */
export function pluginPlistFields(body: string): {
  workingDirectory: string;
  exec: string[];
  environment: Record<string, string>;
} {
  const text = (value: string) =>
    value.replace(
      /&(amp|lt|gt|quot|apos);/gu,
      (_, entity: string) =>
        ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity]!,
    );
  const one = (key: string, tag: string): string => {
    const matches = [
      ...body.matchAll(
        new RegExp(`<key>${key}</key>\\s*<${tag}>([\\s\\S]*?)</${tag}>`, "gu"),
      ),
    ];
    if (matches.length !== 1)
      throw new Error(`missing or duplicate plist ${key}`);
    return matches[0][1];
  };
  const environment: Record<string, string> = {};
  const env = one("EnvironmentVariables", "dict");
  for (const match of env.matchAll(
    /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/gu,
  )) {
    const key = text(match[1]);
    if (Object.hasOwn(environment, key))
      throw new Error(`duplicate plist environment ${key}`);
    environment[key] = text(match[2]);
  }
  return {
    workingDirectory: text(one("WorkingDirectory", "string")),
    environment,
    exec: [
      ...one("ProgramArguments", "array").matchAll(
        /<string>([^<]*)<\/string>/gu,
      ),
    ].map((match) => text(match[1])),
  };
}

function zonedParts(date: Date, timeZone: string): Record<string, number> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
}

export function calendarInterval(
  value: string,
  now = new Date(),
  targetZone = systemTimeZone(),
): { Hour: number; Minute: number } {
  const match = /^\*-\*-\* (\d{2}):(\d{2}):(\d{2}) ([A-Za-z0-9_+/-]+)$/u.exec(
    value,
  );
  if (
    !match ||
    Number(match[1]) > 23 ||
    Number(match[2]) > 59 ||
    Number(match[3]) !== 0
  )
    throw new Error(`unsupported OnCalendar: ${value}`);
  const zone = match[4];
  const today = zonedParts(now, zone);
  const target = Date.UTC(
    today.year,
    today.month - 1,
    today.day,
    Number(match[1]),
    Number(match[2]),
  );
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(instant), zone);
    instant +=
      target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  const local = zonedParts(new Date(instant), targetZone);
  return { Hour: local.hour, Minute: local.minute };
}

function systemTimeZone(): string {
  // The caller can have TZ from Iva's EnvironmentFile. launchd uses the Mac's zone.
  try {
    return (
      realpathSync("/etc/localtime").split("zoneinfo/")[1] ||
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}

export function nextCalendarRun(
  hour: number,
  minute: number,
  now = new Date(),
): string {
  const zone = systemTimeZone();
  const today = zonedParts(now, zone);
  const instant = (day: number) => {
    const target = Date.UTC(today.year, today.month - 1, day, hour, minute);
    let value = target;
    for (let i = 0; i < 3; i++) {
      const p = zonedParts(new Date(value), zone);
      value +=
        target -
        Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    }
    return value;
  };
  const first = instant(today.day);
  return new Date(
    first > now.getTime() ? first : instant(today.day + 1),
  ).toISOString();
}

function command(value: string, home: string): string[] {
  const args = systemdExecWords(value, home);
  const flock = args.indexOf("/usr/bin/flock");
  if (flock >= 0) {
    if (args[flock + 1] !== "-w")
      throw new Error(`unsupported flock: ${value}`);
    args.splice(flock, 2, "/usr/bin/lockf", "-t");
  }
  if (args.some((arg) => /(?:^|\/)systemctl$/u.test(arg)))
    throw new Error(`unsupported systemctl command: ${value}`);
  return args.map(stableNode);
}

class UnitTranslation {
  readonly service: UnitBody;
  readonly options: PlistOptions;
  readonly fields: Map<string, string[]>;
  readonly home: string;
  constructor(service: UnitBody, options: PlistOptions) {
    this.service = service;
    this.options = options;
    this.fields = directives(service);
    this.home = options.home ?? homedir();
  }
  one(key: string): string | undefined {
    const values = this.fields.get(key);
    if (values && values.length !== 1)
      throw new Error(`${this.service.unit}: duplicate ${key}`);
    return values?.[0];
  }
  environment(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of this.fields.get("Environment") ?? [])
      for (const item of systemdEnvironmentWords(line, this.home)) {
        const equals = item.indexOf("=");
        if (equals < 1)
          throw new Error(`${this.service.unit}: invalid Environment`);
        env[item.slice(0, equals)] = item.slice(equals + 1);
      }
    return env;
  }
  main(env: Record<string, string>): string[] {
    const start = this.one("ExecStart");
    if (!start) throw new Error(`${this.service.unit}: missing ExecStart`);
    const main = command(start, this.home);
    if (main[0] === "/usr/bin/env") {
      main.shift();
      while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(main[0] ?? "")) {
        const item = main.shift()!;
        const equals = item.indexOf("=");
        env[item.slice(0, equals)] = item.slice(equals + 1);
      }
    }
    if (!main.length) throw new Error(`${this.service.unit}: empty ExecStart`);
    if (env.PATH)
      env.PATH = env.PATH.replace(
        /\/usr\/local\/bin(?=:|$)/u,
        "/usr/local/bin:/opt/homebrew/bin",
      ).replace(/(^|:)\/bin(?=:|$)/u, "$1/bin:/usr/sbin:/sbin");
    main[0] = stableNode(main[0]);
    return main;
  }
  auxiliaries(key: string) {
    return (this.fields.get(key) ?? []).flatMap((value) => {
      if (
        key === "ExecStartPost" &&
        value ===
          "-/usr/bin/systemctl --user enable --now iva-update-check.timer"
      )
        return [];
      return [
        {
          ignore: value.startsWith("-"),
          args: command(value.replace(/^-/, ""), this.home),
        },
      ];
    });
  }
  timeout(): number | undefined {
    const timeout = this.one("TimeoutStartSec");
    if (this.one("Type") && this.one("Type") !== "oneshot")
      throw new Error(`${this.service.unit}: unsupported Type`);
    if (timeout && (!/^\d+$/u.test(timeout) || Number(timeout) < 1))
      throw new Error(`${this.service.unit}: invalid TimeoutStartSec`);
    return timeout ? Number(timeout) : undefined;
  }
  restart(): string | undefined {
    const restart = this.one("Restart");
    if (restart && !["always", "on-failure", "no"].includes(restart))
      throw new Error(`${this.service.unit}: unsupported Restart`);
    return restart;
  }
  permissions(): Record<string, Value> {
    if (!this.one("UMask")) return {};
    if (this.one("UMask") !== "0077")
      throw new Error(`${this.service.unit}: unsupported UMask`);
    return { Umask: 63 };
  }
  keepAlive(): Record<string, Value> {
    const restart = this.restart();
    if (restart !== "always" && restart !== "on-failure") return {};
    const seconds = Number(this.one("RestartSec") ?? "0.1");
    if (!Number.isFinite(seconds) || seconds < 0)
      throw new Error(`${this.service.unit}: invalid RestartSec`);
    return {
      KeepAlive: restart === "always" ? true : { SuccessfulExit: false },
      ThrottleInterval: Math.max(Math.ceil(seconds), 1),
    };
  }
  plist(): Record<string, Value> {
    const env = this.environment();
    const main = this.main(env);
    const envFile = this.one("EnvironmentFile")?.replaceAll("%h", this.home);
    const config = {
      envFile,
      pre: this.auxiliaries("ExecStartPre"),
      post: this.auxiliaries("ExecStartPost"),
      timeoutSeconds: this.timeout(),
    };
    const label = launchdLabel(this.service.unit);
    const log = join(this.home, "Library/Logs/Iva", label.slice(8));
    return {
      Label: label,
      ProgramArguments: [
        stableNode(this.options.node ?? process.execPath),
        ...(envFile ? [`--env-file-if-exists=${envFile}`] : []),
        join(this.options.root, "scripts/lib/launchd-run.ts"),
        JSON.stringify(config),
        ...main,
      ],
      EnvironmentVariables: { ...env, HOME: this.home },
      ExitTimeOut: 30,
      WorkingDirectory:
        this.one("WorkingDirectory")?.replaceAll("%h", this.home) ??
        this.options.root,
      RunAtLoad: ["always", "on-failure"].includes(this.restart() ?? ""),
      StandardOutPath: `${log}.out.log`,
      StandardErrorPath: `${log}.err.log`,
      ...this.permissions(),
      ...this.keepAlive(),
    };
  }
}

export function unitToPlist(
  service: UnitBody,
  timer: UnitBody | undefined,
  options: PlistOptions,
): string {
  const plist = new UnitTranslation(service, options).plist();
  if (timer) {
    const calendar = directives(timer).get("OnCalendar");
    if (calendar?.length !== 1)
      throw new Error(`${timer.unit}: missing or duplicate OnCalendar`);
    try {
      plist.StartCalendarInterval = calendarInterval(calendar[0], options.now);
    } catch (error) {
      throw new Error(`${timer.unit}: ${String(error)}`, { cause: error });
    }
  }
  const payload = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${xml(plist)}</plist>\n`;
  const identity = readPluginUnitMarker(service.body, service.unit);
  return identity ? markPluginUnit(payload, identity) : payload;
}

export function launchdPlan(
  units: readonly UnitBody[],
  options: PlistOptions,
): Map<string, string> {
  const services = new Map<string, UnitBody>();
  const timers = new Map<string, UnitBody>();
  for (const unit of units) {
    const label = launchdLabel(unit.unit);
    const target = unit.unit.endsWith(".timer") ? timers : services;
    if (target.has(label))
      throw new Error(`${unit.unit}: duplicate label ${label}`);
    target.set(label, unit);
  }
  for (const [label, timer] of timers)
    if (!services.has(label))
      throw new Error(`${timer.unit}: timer without service`);
  return new Map(
    [...services].map(([label, service]) => [
      label,
      unitToPlist(service, timers.get(label), options),
    ]),
  );
}

export function writeLaunchdUnits(
  units: readonly UnitBody[],
  unitDir: string,
  options: PlistOptions,
): string[] {
  const plan = launchdPlan(units, options);
  const logDir = join(options.home ?? homedir(), "Library/Logs/Iva");
  mkdirSync(unitDir, { recursive: true });
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700);
  const control = options.control ?? plistControl;
  const domain = `gui/${process.getuid!()}`;
  const explicitlyEnabled = enabledLabels(control, domain);
  for (const [label, body] of plan) {
    const destination = join(unitDir, `${label}.plist`);
    writePlist(destination, body);
    if (!explicitlyEnabled.has(label)) {
      const result = control(["disable", `${domain}/${label}`]);
      if (result.code !== 0)
        throw new Error(`launchctl disable ${label} failed: ${result.out}`);
    }
  }
  return units.map((unit) => unit.unit);
}

function enabledLabels(
  control: NonNullable<PlistOptions["control"]>,
  domain: string,
): Set<string | undefined> {
  const overrides = control(["print-disabled", domain]);
  if (
    overrides.code !== 0 ||
    !/^disabled services = \{[^]*\}\s*$/u.test(overrides.out.trim())
  )
    throw new Error(
      `launchctl print-disabled ${domain} failed: ${overrides.out}`,
    );
  return new Set(
    overrides.out
      .split("\n")
      .map((line) => /^\s*"([^"]+)" => enabled\s*$/u.exec(line)?.[1]),
  );
}

function writePlist(destination: string, body: string): void {
  const temp = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, body, { flag: "wx", mode: 0o644 });
    if (process.platform === "darwin") {
      const lint = spawnSync("plutil", ["-lint", temp], { encoding: "utf8" });
      if (lint.status !== 0)
        throw new Error(
          `${destination}: plutil -lint failed: ${lint.stderr || lint.stdout || lint.error?.message}`,
        );
    }
    renameSync(temp, destination);
  } finally {
    rmSync(temp, { force: true });
  }
}
