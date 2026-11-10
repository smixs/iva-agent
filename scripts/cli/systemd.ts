import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  generateAssistantBearer,
  isAssistantBearer,
} from "../lib/assistant-auth.ts";
import {
  cleanupSystemdUnits,
  systemdExecArgument,
} from "../lib/systemd-control.ts";
import { resolveTimeZone, validateTimeZone } from "../lib/timezone.ts";
import type { createCliRuntime } from "./runtime.ts";
import { resolveVaultDir } from "../../packages/vault-dir/index.ts";
import { servicePath } from "../../packages/claude-command/index.ts";
import { writeLaunchdUnits } from "../lib/launchd-plist.ts";
import { launchdUnitPath, unloadLaunchd } from "../lib/launchd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

// The escaper lives in the systemd seam now, beside the unit-name rule; it is re-exported
// here because that is where every caller already looks for it.
export { systemdExecArgument };

type QuietOptions = {
  readonly quiet?: boolean;
};

type WriteUnitsOptions = {
  readonly ensureBearer?: boolean;
  readonly skipUnits?: readonly string[];
};

type RestartServicesOptions = {
  readonly afterUnitWrite?: () => void;
  readonly skipUnits?: readonly string[];
};

class CliSystemdLifecycle {
  private readonly runtime: CliRuntime;

  constructor(runtime: CliRuntime) {
    this.runtime = runtime;
  }

  // Existing installs gain the server-side bearer on their next unit refresh/update.
  // The same migration also repairs .env permissions because it contains every runtime secret.
  ensureAssistantBearer(options: QuietOptions = {}): boolean {
    if (!existsSync(this.runtime.ENV_PATH)) return false;
    // Both repairs run every time: the array is built before some() looks at it.
    const changed = [this.repairBearer(), this.protectEnvFile()].some(Boolean);
    return this.announce(
      changed,
      options,
      ".env protected and internal bearer configured",
    );
  }

  announce(changed: boolean, options: QuietOptions, message: string): boolean {
    if (changed && !options.quiet) this.runtime.ok(message);
    return changed;
  }

  // A valid bearer is kept; a duplicated one collapses to a single line; anything else
  // is replaced by a fresh one.
  repairBearer(): boolean {
    const bearer = (this.runtime.readEnv().ASSISTANT_BEARER || "").trim();
    if (!this.bearerNeedsWrite(bearer)) return false;
    this.runtime.writeEnvVars({ ASSISTANT_BEARER: this.usableBearer(bearer) });
    return true;
  }

  bearerNeedsWrite(bearer: string): boolean {
    return !isAssistantBearer(bearer) || this.bearerLineCount() !== 1;
  }

  usableBearer(bearer: string): string {
    return isAssistantBearer(bearer) ? bearer : generateAssistantBearer();
  }

  bearerLineCount(): number {
    return (
      readFileSync(this.runtime.ENV_PATH, "utf8").match(
        /^\s*ASSISTANT_BEARER\s*=/gm,
      )?.length ?? 0
    );
  }

  protectEnvFile(): boolean {
    if ((statSync(this.runtime.ENV_PATH).mode & 0o777) === 0o600) return false;
    chmodSync(this.runtime.ENV_PATH, 0o600);
    return true;
  }

  // Same regex-validated timezone both this.writeUnits() (substituted into the deploy/ timer
  // templates' __TIMEZONE__) and this.ivaServiceBody() (Environment=TZ=, since the eve schedules
  // in agent/schedules/memory-*.ts carry no timezone of their own and fire in the process's
  // local time) need — one place so the fallback/validation rule can't drift between them.
  configuredTimezone(): string {
    const raw = this.runtime.readEnv().ASSISTANT_TIMEZONE;
    return raw?.trim() ? this.explicitTimezone(raw) : resolveTimeZone(raw);
  }

  // Only a name systemd can carry unquoted is accepted, and then only one Intl knows.
  explicitTimezone(raw: string): string {
    return this.shapedTimezone(raw) || this.rejectedTimezone(raw);
  }

  shapedTimezone(raw: string): string | null {
    return /^[A-Za-z0-9_+/-]+$/.test(raw) ? validateTimeZone(raw) : null;
  }

  rejectedTimezone(raw: string): string {
    this.runtime.warn(
      `invalid ASSISTANT_TIMEZONE=${JSON.stringify(raw)}; using UTC`,
    );
    return resolveTimeZone(raw);
  }

  canonicalDataDirEnvironment(): string {
    return systemdExecArgument(
      `ASSISTANT_DATA_DIR=${this.runtime.dataDirAbs()}`,
    );
  }

  // ── systemd units: single source of truth ───────────────────────────────
  ivaServiceBody(): string {
    // PATH with the node directory (= npm global bin under nvm), Restart=always.
    const port = (
      this.runtime.readEnv().IVA_PORT || this.runtime.DEFAULT_PORT
    ).trim();
    const timezone = this.configuredTimezone();
    return [
      "[Unit]",
      "Description=Iva",
      "After=network-online.target",
      "",
      "[Service]",
      // Everything eve creates (vault, transcripts, data/) must not be world-readable:
      // the system umask (022 on Ubuntu) would expose it to every user on the box.
      "UMask=0077",
      "OOMPolicy=continue",
      "KillMode=control-group",
      `WorkingDirectory=${this.runtime.ROOT}`,
      `EnvironmentFile=${this.runtime.ROOT}/.env`,
      // Стартуем через `eve start`, а НЕ напрямую `node .output/server/index.mjs`: eve start
      // вызывает prewarmBuiltAppSandboxes() и собирает шаблон песочницы ДО приёма трафика. Сырой
      // index.mjs prewarm не делает → первое же вложение падает SandboxTemplateNotProvisionedError
      // (шаблона нет в .eve/sandbox-cache). Ключ шаблона — контент-хеш, после iva update он меняется,
      // поэтому provision обязан идти на каждом старте, а не разово. eve start остаётся foreground.
      // --host: bind to loopback only. eve's auth strategy localDev() treats a request as local
      // by the hostname of request.url — i.e. by the client's own Host header — so a server bound
      // to 0.0.0.0 hands local-dev rights (and with them a sandbox-free `bash` on the host) to
      // anyone who can reach the port and sends `Host: 127.0.0.1`. The port is only ever consumed
      // locally: telegram-poll, the sweep and the memory scripts all talk to 127.0.0.1.
      // Env is not enough here — `eve start` takes options.host ?? "0.0.0.0" and overwrites
      // HOST/NITRO_HOST for the spawned .output/server/index.mjs, so the flag is what binds.
      // "-": even a recovery script that cannot load must not keep Iva down.
      `ExecStartPre=-/usr/bin/env ${this.canonicalDataDirEnvironment()} ${this.runtime.NODE} ${this.runtime.ROOT}/scripts/recover-interrupted-turns.ts`,
      `ExecStart=/usr/bin/env ${this.canonicalDataDirEnvironment()} ${this.runtime.NODE} ${this.runtime.ROOT}/node_modules/eve/bin/eve.js start --host 127.0.0.1`,
      `Environment=PORT=${port}`,
      `Environment=TZ=${timezone}`,
      `Environment=PATH=${servicePath(this.runtime.NODE_BIN_DIR, "%h")}`,
      "Environment=AGENT_BROWSER_MAX_OUTPUT=24000",
      // world-local queue delivers turnWorkflow messages via an HTTP self-call guarded by
      // undici headers/body timeouts that default to 30 seconds; any agent turn longer than
      // that gets falsely marked undelivered and redelivered while the original handler is
      // still running — two concurrent turns, two slightly different Telegram replies.
      // One hour matches the longest tool-heavy turns.
      "Environment=WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS=3600000",
      "Environment=WORKFLOW_LOCAL_BODY_TIMEOUT_MS=3600000",
      "Restart=always",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
  }

  // One-time (idempotent) perms migration for installs created before UMask=0077: the
  // secrets file and the data dir were world-readable under the default umask 022.
  // Runs from writeUnits — i.e. on every install/update — so old installs self-heal.
  hardenPerms(): void {
    // Каждая цель — независимо: сбой на .env не должен отменять миграцию data/ (и наоборот).
    // Предупреждаем, но установку юнитов не срываем: юниты сами несут UMask=0077, а сорванный
    // writeUnits оставил бы систему вовсе без юнитов — хуже, чем старые права.
    this.tightenIfPresent(() => this.runtime.ENV_PATH, 0o600, ".env");
    this.tightenIfPresent(this.runtime.dataDirAbs, 0o700, "data/");
    // Стор воркфлоу несёт транскрипты диалогов, vault — саму память; оба старше UMask-фикса
    // могли быть созданы world-readable. chmod только верхнего уровня (закрывает traversal).
    const vaultDir = resolveVaultDir(
      this.runtime.ROOT,
      this.runtime.readEnv().ASSISTANT_VAULT_DIR,
    );
    for (const path of [
      join(this.runtime.ROOT, ".eve"),
      join(this.runtime.ROOT, ".workflow-data"),
      vaultDir,
    ])
      this.tightenIfPresent(
        () => path,
        0o700,
        relative(this.runtime.ROOT, path),
      );
  }

  // The path is resolved inside the try: reading .env for the data dir can fail too, and
  // that must not cancel the other targets.
  tightenIfPresent(target: () => string, mode: number, label: string): void {
    try {
      const path = target();
      if (existsSync(path)) chmodSync(path, mode);
    } catch (error) {
      this.runtime.warn(
        `perms migration (${label}) failed: ${(error as { message: string }).message}`,
      );
    }
  }

  // Writes iva.service + all deploy/iva-*.{service,timer} with placeholder substitution. daemon-reload.
  writeUnits(options: WriteUnitsOptions = {}): string[] {
    this.protectSecrets(options);
    if (this.runtime.systemd.manager === "launchd") {
      const deploy = join(this.runtime.ROOT, "deploy");
      const fill = this.unitPlaceholders();
      return writeLaunchdUnits(
        [
          { unit: "iva.service", body: this.ivaServiceBody() },
          ...readdirSync(deploy)
            .filter((file) =>
              this.isDeployUnit(file, new Set(options.skipUnits)),
            )
            .map((unit) => ({
              unit,
              body: fill(readFileSync(join(deploy, unit), "utf8")),
            })),
        ],
        this.runtime.UNIT_DIR,
        { root: this.runtime.ROOT, node: this.runtime.NODE },
      );
    }
    mkdirSync(this.runtime.UNIT_DIR, { recursive: true });
    writeFileSync(
      join(this.runtime.UNIT_DIR, "iva.service"),
      this.ivaServiceBody(),
    );
    const written = [
      "iva.service",
      ...this.writeDeployUnits(new Set(options.skipUnits)),
    ];
    this.reloadUnits();
    return written;
  }

  protectSecrets(options: WriteUnitsOptions): void {
    this.hardenPerms();
    if (options.ensureBearer !== false)
      this.ensureAssistantBearer({ quiet: true });
  }

  writeDeployUnits(skipped: ReadonlySet<string>): string[] {
    const deploy = join(this.runtime.ROOT, "deploy");
    const fill = this.unitPlaceholders();
    return readdirSync(deploy)
      .filter((file) => this.isDeployUnit(file, skipped))
      .map((file) => {
        const template = readFileSync(join(deploy, file), "utf8");
        writeFileSync(join(this.runtime.UNIT_DIR, file), fill(template));
        return file;
      });
  }

  isDeployUnit(file: string, skipped: ReadonlySet<string>): boolean {
    return /^iva-.*\.(service|timer)$/.test(file) && !skipped.has(file);
  }

  // Resolved once per write, so every unit of one run carries the same values.
  unitPlaceholders(): (template: string) => string {
    const timezone = this.configuredTimezone();
    const dataDirEnvironment = this.canonicalDataDirEnvironment();
    return (template) =>
      template
        .replaceAll("__PROJECT_DIR__", this.runtime.ROOT)
        .replaceAll("__NODE_BIN__", this.runtime.NODE)
        .replaceAll("__PYTHON_BIN__", this.runtime.VENV_PY)
        .replaceAll("__DATA_DIR_ENV__", dataDirEnvironment)
        .replaceAll("__TIMEZONE__", timezone);
  }

  reloadUnits(): void {
    if (this.runtime.hasSystemd()) this.runtime.systemd.daemonReload();
  }

  unitCleanupSteps() {
    return {
      disable: (unit: string) => this.runtime.systemd.disableNow([unit]),
      remove: (unit: string) => {
        if (this.runtime.systemd.manager === "launchd")
          unloadLaunchd(unit, this.runtime.UNIT_DIR);
        rmSync(
          this.runtime.systemd.manager === "launchd"
            ? launchdUnitPath(unit, this.runtime.UNIT_DIR)
            : join(this.runtime.UNIT_DIR, unit),
        );
      },
      reload: () => this.runtime.systemd.daemonReload(),
      reset: () => this.runtime.systemd.resetFailed(),
    };
  }

  // The first service runs the in-process schedules; it must be up for them to fire.
  requireScheduleOwner(message: string): void {
    const owner = this.runtime.SERVICES[0];
    if (!owner || !this.runtime.systemd.isActive(owner))
      throw new Error(message);
  }

  activateUnits(): void {
    this.runtime.systemd.activate([
      ...this.runtime.SERVICES,
      ...this.runtime.TIMERS,
    ]);
  }

  removeUnits(): string[] {
    if (!existsSync(this.runtime.UNIT_DIR)) return [];
    if (this.runtime.systemd.manager === "launchd") {
      const units = readdirSync(this.runtime.UNIT_DIR)
        .filter((file) => /^app\.iva\.[A-Za-z0-9_.@:-]+\.plist$/u.test(file))
        .map((file) => `${file.slice(8, -6)}.service`);
      return cleanupSystemdUnits({ units, ...this.unitCleanupSteps() });
    }
    const units = readdirSync(this.runtime.UNIT_DIR).filter((file) =>
      /^iva.*\.(service|timer)$/.test(file),
    );
    return cleanupSystemdUnits({ units, ...this.unitCleanupSteps() });
  }

  // Any restart via `iva` first regenerates the unit → Environment=PORT always equals
  // the current IVA_PORT from .env. Without this, editing IVA_PORT + restart would leave the server
  // on the old port (the unit was already baked) while clients read the new one — the same desync.
  restartServices(options: RestartServicesOptions = {}): void {
    this.writeUnits({ skipUnits: options.skipUnits });
    options.afterUnitWrite?.();
    this.runtime.systemd.restart(this.runtime.SERVICES);
    this.requireScheduleOwner("iva.service is not active after unit restart");
  }

  api() {
    return {
      ensureAssistantBearer: this.ensureAssistantBearer.bind(this),
      writeUnits: this.writeUnits.bind(this),
      activateUnits: this.activateUnits.bind(this),
      removeUnits: this.removeUnits.bind(this),
      restartServices: this.restartServices.bind(this),
    };
  }
}

export function createCliSystemd(runtime: CliRuntime) {
  return new CliSystemdLifecycle(runtime).api();
}
