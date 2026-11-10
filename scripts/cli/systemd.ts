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
import { writeEnvAtomicSync } from "../lib/env-file.ts";
import {
  BRAIN_ENTRYPOINT,
  LEGACY_BRAIN_ENTRYPOINT,
  LEGACY_BRAIN_UNITS,
  LEGACY_MEMORY_UNITS,
} from "../lib/legacy-memory-units.ts";
import {
  cleanupSystemdUnits,
  systemdExecArgument,
} from "../lib/systemd-control.ts";
import {
  resolveTimeZone,
  validateTimeZone,
} from "../../packages/timezone/index.ts";
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
  readonly deferBrainMigration?: boolean;
  readonly ensureBearer?: boolean;
  readonly skipUnits?: readonly string[];
};

type RestartServicesOptions = {
  readonly afterUnitWrite?: () => void;
  readonly deferBrainMigration?: boolean;
  readonly deferMemoryMigration?: boolean;
  readonly skipUnits?: readonly string[];
};

type MemoryCleanupOptions = {
  readonly requireActiveOwner?: boolean;
  readonly strict?: boolean;
};

type BrainCleanupOptions = {
  readonly activateNewTimer?: boolean;
};

type PortMigration = {
  readonly port: string;
  /** ASSISTANT_HOST is the old :3000 default and moves to the new port. */
  readonly moveHost: boolean;
};

/**
 * `.env` text with `IVA_PORT` appended after the last non-empty line. Every other line
 * stays as it is, except a stale :3000 `ASSISTANT_HOST`, which would keep clients on
 * the taken port.
 */
function withIvaPort(raw: string, migration: PortMigration): string {
  const appended = `${raw.replace(/\n*$/, "\n")}IVA_PORT=${migration.port}\n`;
  return migration.moveHost
    ? appended.replace(
        /^(\s*ASSISTANT_HOST\s*=).*$/m,
        `$1http://127.0.0.1:${migration.port}`,
      )
    : appended;
}

function portMigrationMessage(migration: PortMigration): string {
  const moved = migration.moveHost ? ", ASSISTANT_HOST moved off :3000" : "";
  return `.env migrated → IVA_PORT=${migration.port}${moved}`;
}

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
    if (!options.deferBrainMigration) this.removeLegacyBrainUnits(written);
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

  // The unit names from `names` that are installed; none without this.runtime.systemd.
  installedUnits(names: readonly string[]): string[] {
    return this.runtime.hasSystemd()
      ? names.filter((unit) =>
          existsSync(
            this.runtime.systemd.manager === "launchd"
              ? launchdUnitPath(unit, this.runtime.UNIT_DIR)
              : join(this.runtime.UNIT_DIR, unit),
          ),
        )
      : [];
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

  // The Brain rename: iva-memory-doctor.{service,timer} → iva-brain.{service,timer}. deploy/
  // ships only the new pair, so the copy loop above never overwrites or removes the old one —
  // this retires it by exact name on ordinary this.writeUnits() calls (doctor/config/restart/
  // install.sh), so every install migrates without a dedicated command. The quiesced updater
  // defers retirement until its captured enabled/active state is restored onto the new pair.
  //
  // Order is the whole point. The nightly vault care must never be absent, not even for the
  // window between two steps of an update that dies halfway:
  //   1. BOTH new units must be written to this.runtime.UNIT_DIR by THIS run (daemon-reload already done).
  //      The timer alone is not a nightly job: a half-unpacked deploy/ can carry either file
  //      without the other, and a timer whose iva-brain.service is missing fires at 05:00 into
  //      nothing — while looking migrated. A service without its timer never fires at all.
  //   2. and, on ordinary CLI paths, the timer enabled+active,
  //   3. only then may the old pair be disabled and deleted.
  // Any failure in 1–2 keeps the old units: a duplicated nightly run is harmless (both take
  // the same .memory.lock), a missing one costs the user a night of memory care.
  // The kept-unit half of the same guarantee. The legacy pair was written by an install made
  // before the rename, so its ExecStart names scripts/memory/doctor.ts — a file THIS tree no
  // longer ships (it is scripts/memory/brain.ts now), and this.writeUnits() runs on the already
  // updated tree (update.ts calls it from postCommit). So every path that keeps the old unit
  // as the safety net would otherwise keep a unit that fails at 05:00 with "Cannot find
  // module" — the lost night the ordering above exists to prevent. Repoint it in place, by
  // the exact old path only, so an operator-edited unit keeps everything else it says.
  // Silent on its own: the callers that keep the pair report it, the one that retires the
  // pair right after has nothing to report.
  repointLegacyBrainUnits(stale: readonly string[]): string[] {
    const repointed = stale.filter((unit) => this.repointLegacyBrainUnit(unit));
    if (repointed.length) this.runtime.systemd.daemonReload();
    return repointed;
  }

  repointLegacyBrainUnit(unit: string): boolean {
    const path = join(this.runtime.UNIT_DIR, unit);
    // unreadable — nothing safe to rewrite, and the cleanup after still tries
    const body = this.readUnit(path);
    if (!body?.includes(LEGACY_BRAIN_ENTRYPOINT)) return false;
    return this.rewriteUnit(
      unit,
      body.replaceAll(LEGACY_BRAIN_ENTRYPOINT, BRAIN_ENTRYPOINT),
    );
  }

  readUnit(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  rewriteUnit(unit: string, body: string): boolean {
    try {
      writeFileSync(join(this.runtime.UNIT_DIR, unit), body);
      return true;
    } catch (error) {
      this.runtime.warn(
        `could not repoint ${unit} at ${BRAIN_ENTRYPOINT}: ${(error as { message: string }).message}`,
      );
      return false;
    }
  }

  removeLegacyBrainUnits(
    written: readonly string[],
    options: BrainCleanupOptions = {},
  ): string[] {
    const stale = this.installedUnits(LEGACY_BRAIN_UNITS);
    if (!stale.length) return [];
    return this.retireBrainPair(stale, written, options);
  }

  retireBrainPair(
    stale: readonly string[],
    written: readonly string[],
    options: BrainCleanupOptions,
  ): string[] {
    // Before anything else: whatever the steps below decide, a kept unit must be able to run.
    const repointed = this.repointLegacyBrainUnits(stale);
    const blocker = this.brainPairBlocker(written, options);
    if (!blocker) return this.cleanupBrainUnits(stale, repointed);
    this.runtime.warn(`skipping legacy brain-unit cleanup — ${blocker}`);
    this.reportKeptBrainUnits(repointed);
    return [];
  }

  // Why the old pair must stay this run, or null when it may go.
  brainPairBlocker(
    written: readonly string[],
    options: BrainCleanupOptions,
  ): string | null {
    const missing = this.missingBrainUnits(written);
    if (missing.length)
      return `${missing.join(" and ")} not installed yet (run \`iva doctor\`, then it will run automatically)`;
    return options.activateNewTimer === false ? null : this.brainTimerBlocker();
  }

  missingBrainUnits(written: readonly string[]): string[] {
    return [this.runtime.BRAIN_SERVICE, this.runtime.BRAIN_TIMER].filter(
      (unit) =>
        !written.includes(unit) ||
        !existsSync(join(this.runtime.UNIT_DIR, unit)),
    );
  }

  brainTimerBlocker(): string | null {
    try {
      this.runtime.systemd.activate([this.runtime.BRAIN_TIMER]);
      return null;
    } catch (error) {
      return `${this.runtime.BRAIN_TIMER} did not come up: ${(error as { message: string }).message}`;
    }
  }

  cleanupBrainUnits(
    stale: readonly string[],
    repointed: readonly string[],
  ): string[] {
    try {
      return cleanupSystemdUnits({ units: stale, ...this.unitCleanupSteps() });
    } catch (error) {
      this.runtime.warn(
        `legacy brain-unit cleanup incomplete: ${(error as { message: string }).message}`,
      );
      this.reportKeptBrainUnits(repointed);
      return [...stale];
    }
  }

  reportKeptBrainUnits(repointed: readonly string[]): void {
    if (repointed.length)
      this.runtime.ok(
        `kept ${repointed.join(", ")} — repointed at ${BRAIN_ENTRYPOINT}, so tonight's vault care still runs`,
      );
  }

  // Existing installs may still carry the 8 retired iva-memory-{daily,weekly,monthly,yearly}
  // unit files (deploy/ no longer ships them, so the copy loop above never overwrites or
  // removes them on its own). `iva update`/`iva doctor` both call this.writeUnits() on every run,
  // so this self-heals every existing install onto eve schedules without a dedicated
  // migration command — by exact name only, so an unrelated self-host timer is never touched.
  // Guards against tearing down the old systemd safety net while running a BUILD that
  // predates the eve-schedules migration — e.g. .output/ wasn't rebuilt yet after an
  // `iva update` pulled this change (this.writeUnits() runs before the build step in some
  // call paths). Without this check, a stale build would lose its memory rollups
  // entirely (old timers gone, new eve schedules not actually in the bundle) until the
  // next successful build. A shallow recursive text scan for markers unique to the
  // COMPILED schedules is enough — bare "memory-daily" is NOT unique enough: instrumentation.ts
  // always imports agent/lib/schedule-migration.ts, whose LEGACY_MEMORY_UNITS array contains
  // the string "iva-memory-daily.service", which itself contains "memory-daily" as a substring
  // — that would make the marker match on every build regardless of whether the schedules
  // themselves actually compiled. Nitro's schedule-task wrapper embeds each schedule's own
  // source path ("schedules/memory-daily.ts") in its description string, which cannot
  // appear anywhere else.
  //
  // ALL FOUR memory-* markers are required, not just one: a partial build (e.g. one
  // schedule file failed to compile, or a build got interrupted mid-write) could contain
  // memory-daily.ts's marker while missing weekly/monthly/yearly — a single-marker check
  // would then let this.removeLegacyMemoryUnits() tear down the OLD systemd timers for periods
  // that have no working in-process replacement in THIS build, losing those rollups
  // entirely rather than just delaying the migration one more boot.
  private readonly BUILD_SCHEDULE_MARKERS = ["schedules/memory-night.ts"];
  private readonly BUILD_SCAN_MAX_FILE_BYTES = 15_000_000;
  private readonly NOTHING = Buffer.alloc(0);
  buildHasSchedules(): boolean {
    const outputServer = join(this.runtime.ROOT, ".output/server");
    if (!existsSync(outputServer)) return false;
    try {
      return this.missingScheduleMarkers(outputServer).size === 0;
    } catch {
      return false;
    }
  }

  missingScheduleMarkers(outputServer: string): Set<string> {
    const remaining = new Set(this.BUILD_SCHEDULE_MARKERS);
    for (const path of readdirSync(outputServer, {
      recursive: true,
    }) as string[]) {
      if (remaining.size === 0) break;
      this.strikeMarkers(remaining, this.scannableContent(outputServer, path));
    }
    return remaining;
  }

  // Markers can land in different files (each schedule may compile to its own
  // _virtual/*.schedule.mjs, or all get inlined into one bundle) — check every
  // still-missing marker against every file rather than stopping at the first hit.
  strikeMarkers(remaining: Set<string>, content: Buffer): void {
    for (const marker of remaining)
      if (content.includes(marker)) remaining.delete(marker);
  }

  // .output/server is the WHOLE server bundle plus every vendored dependency — a
  // miss (the common case: doctor/writeUnits runs on every `iva update`) would
  // otherwise mean synchronously reading tens to hundreds of MB. The markers can only
  // ever land in Nitro's own compiled JS/JSON output, never in a vendored asset.
  // Anything else reads as empty.
  scannableContent(outputServer: string, path: string): Buffer {
    const full = join(outputServer, path);
    if (!/\.(mjs|cjs|js|json)$/.test(path)) return this.NOTHING;
    return this.isScannableFile(full) ? this.readOrNothing(full) : this.NOTHING;
  }

  isScannableFile(full: string): boolean {
    try {
      const stat = statSync(full);
      return stat.isFile() && stat.size <= this.BUILD_SCAN_MAX_FILE_BYTES;
    } catch {
      return false;
    }
  }

  // Buffer — no need to decode as UTF-8 just to substring-search; unreadable is not
  // where a schedule name would live anyway.
  readOrNothing(full: string): Buffer {
    try {
      return readFileSync(full);
    } catch {
      return this.NOTHING;
    }
  }

  removeLegacyMemoryUnits(options: MemoryCleanupOptions = {}): string[] {
    const units = this.installedUnits(LEGACY_MEMORY_UNITS);
    if (!units.length) return [];
    return this.retireMemoryUnits(units, options);
  }

  retireMemoryUnits(units: string[], options: MemoryCleanupOptions): string[] {
    if (!this.buildHasSchedules()) {
      this.runtime.warn(
        "skipping legacy memory-timer cleanup — the current build doesn't contain the eve schedules yet (rebuild with `iva doctor` or `npm run build`, then it will run automatically)",
      );
      return [];
    }
    if (options.requireActiveOwner)
      this.requireScheduleOwner(
        "legacy memory schedules have no active committed service owner",
      );
    return this.cleanupMemoryUnits(units, options.strict === true);
  }

  // The first service runs the in-process schedules; it must be up for them to fire.
  requireScheduleOwner(message: string): void {
    const owner = this.runtime.SERVICES[0];
    if (!owner || !this.runtime.systemd.isActive(owner))
      throw new Error(message);
  }

  cleanupMemoryUnits(units: string[], strict: boolean): string[] {
    try {
      return cleanupSystemdUnits({ units, ...this.unitCleanupSteps() });
    } catch (error) {
      this.runtime.warn(
        `legacy memory-timer cleanup incomplete: ${(error as { message: string }).message}`,
      );
      if (strict) throw error;
      return units;
    }
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

  // Migrate old installs to IVA_PORT. Idempotent: on the first `iva update`
  // after switching to the new scheme it guarantees the variable and keeps the server
  // (Environment=PORT=$IVA_PORT) from drifting away from clients (whose default is ASSISTANT_HOST).
  migrateEnv(options: QuietOptions = {}): boolean {
    const migration = this.portMigration();
    if (!migration) return false;
    writeEnvAtomicSync(
      this.runtime.ENV_PATH,
      withIvaPort(readFileSync(this.runtime.ENV_PATH, "utf8"), migration),
    );
    return this.announce(true, options, portMigrationMessage(migration));
  }

  // null: no .env, or already on the new scheme — leave it alone.
  portMigration(): PortMigration | null {
    if (!existsSync(this.runtime.ENV_PATH)) return null;
    const env = this.runtime.readEnv();
    return env.IVA_PORT ? null : this.portFor(env.ASSISTANT_HOST);
  }

  // old default :3000 → new default 8723; custom local host → its port; otherwise the default
  portFor(host = ""): PortMigration {
    const moveHost = host === this.runtime.OLD_DEFAULT_HOST;
    return {
      port: moveHost ? this.runtime.DEFAULT_PORT : this.localPort(host),
      moveHost,
    };
  }

  localPort(host: string): string {
    return (
      host.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/i)?.[1] ??
      this.runtime.DEFAULT_PORT
    );
  }

  // Any restart via `iva` first regenerates the unit → Environment=PORT always equals
  // the current IVA_PORT from .env. Without this, editing IVA_PORT + restart would leave the server
  // on the old port (the unit was already baked) while clients read the new one — the same desync.
  restartServices(options: RestartServicesOptions = {}): void {
    this.writeUnits({
      deferBrainMigration: options.deferBrainMigration,
      skipUnits: options.skipUnits,
    });
    options.afterUnitWrite?.();
    this.runtime.systemd.restart(this.runtime.SERVICES);
    this.requireScheduleOwner("iva.service is not active after unit restart");
    this.settleMemoryUnits(options);
  }

  // The old timers remain the recovery owner until the compiled schedules and
  // their freshly restarted process owner have both been proved.
  settleMemoryUnits(options: RestartServicesOptions): void {
    if (!options.deferMemoryMigration) this.removeLegacyMemoryUnits();
  }

  /** Retire recovery units only after the updater commits the live service. */
  retireLegacyMemoryUnits(): string[] {
    return this.removeLegacyMemoryUnits({
      requireActiveOwner: true,
      strict: true,
    });
  }

  retireDeferredBrainUnits(): string[] {
    return this.removeLegacyBrainUnits(
      [this.runtime.BRAIN_SERVICE, this.runtime.BRAIN_TIMER],
      {
        activateNewTimer: false,
      },
    );
  }

  api() {
    return {
      ensureAssistantBearer: this.ensureAssistantBearer.bind(this),
      writeUnits: this.writeUnits.bind(this),
      activateUnits: this.activateUnits.bind(this),
      removeUnits: this.removeUnits.bind(this),
      retireDeferredBrainUnits: this.retireDeferredBrainUnits.bind(this),
      retireLegacyMemoryUnits: this.retireLegacyMemoryUnits.bind(this),
      migrateEnv: this.migrateEnv.bind(this),
      restartServices: this.restartServices.bind(this),
    };
  }
}

export function createCliSystemd(runtime: CliRuntime) {
  return new CliSystemdLifecycle(runtime).api();
}
