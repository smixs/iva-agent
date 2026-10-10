import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import {
  awaitHealthy as defaultAwaitHealthy,
  servicePort,
} from "../lib/health-probe.ts";
import { LEGACY_BRAIN_UNITS } from "../lib/legacy-memory-units.ts";
import { SystemdControlError } from "../lib/systemd-control.ts";
import { classifyRoot } from "../lib/version-layout.ts";
import { betaOf } from "../lib/update-channel.ts";
import { createVersionStore, parseVersionName } from "../lib/version-store.ts";
import { builtWith, versionOverlay } from "../lib/version-update.ts";
import {
  quarantinePath as defaultQuarantinePath,
  resetStateTargets as defaultResetStateTargets,
} from "../lib/wf-store.ts";
import type { createCliRuntime } from "./runtime.ts";
import type { createCliSystemd } from "./systemd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type CliSystemd = ReturnType<typeof createCliSystemd>;

type ServiceCommandDependencies = {
  readonly now?: () => Date;
  readonly quarantinePath?: typeof defaultQuarantinePath;
  readonly resetStateTargets?: typeof defaultResetStateTargets;
  readonly exit?: (code: number) => never;
  readonly awaitHealthy?: typeof defaultAwaitHealthy;
  readonly recoverUserbot?: () => Promise<unknown>;
};

/** Create the service commands without touching the filesystem, processes, or systemd. */
export function createServiceCommands(
  runtime: CliRuntime,
  systemdLifecycle: Pick<CliSystemd, "activateUnits" | "restartServices">,
  dependencies: ServiceCommandDependencies = {},
) {
  const {
    ROOT,
    ENV_PATH,
    UNIT_DIR,
    SERVICES,
    TIMERS,
    ok,
    warn,
    bad,
    step,
    run,
    systemd,
    dataDirAbs,
    requireSystemd,
  } = runtime;
  const { activateUnits, restartServices } = systemdLifecycle;
  const now = dependencies.now ?? (() => new Date());
  const quarantinePath = dependencies.quarantinePath ?? defaultQuarantinePath;
  const resetStateTargets =
    dependencies.resetStateTargets ?? defaultResetStateTargets;
  const exit =
    dependencies.exit ?? ((code: number): never => process.exit(code));
  const awaitHealthy = dependencies.awaitHealthy ?? defaultAwaitHealthy;

  function cmdStatus(): void {
    const updates = betaOf(ROOT) ? "beta" : "stable";
    console.log(`updates: ${updates} (iva beta / iva stable)`);
    requireSystemd();
    run("systemctl", [
      "--user",
      "status",
      "--no-pager",
      "-n",
      "5",
      ...SERVICES,
    ]);
    // The exact timers this version installs, not a glob: `iva-memory-*` was written for
    // the rollup timers that no longer exist, and it silently stopped matching the nightly
    // unit the moment it was renamed to iva-brain.timer. A pre-rename nightly timer still on
    // disk is listed too: when the migration had to keep it (removeLegacyBrainUnits), THAT is
    // the unit carrying the nightly vault care, and a status hiding it hides the lost night.
    const keptNightlyTimers = LEGACY_BRAIN_UNITS.filter(
      (unit) => unit.endsWith(".timer") && existsSync(join(UNIT_DIR, unit)),
    );
    for (const unit of keptNightlyTimers)
      warn(
        `${unit} still installed — the Brain rename did not finish; run: iva doctor`,
      );
    run("systemctl", [
      "--user",
      "list-timers",
      "--no-pager",
      ...TIMERS,
      ...keptNightlyTimers,
    ]);
  }

  // Not `async`: `requireSystemd` and the restart itself must throw synchronously,
  // the way every other service command does (scripts/cli/main.ts, dispatchCli).
  // After the restart, userbot readiness and reading the version's plugins await.
  function cmdRestart(): Promise<void> {
    requireSystemd();
    restartServices(); // regenerate the unit before restart → PORT stays in sync with IVA_PORT in .env
    ok("Restarted: iva + telegram-poll");
    return (dependencies.recoverUserbot?.() ?? Promise.resolve()).then(
      warnUnbuiltCustom,
    );
  }

  /**
   * A restart runs the version that is installed; it never builds one. Editing
   * `data/custom` therefore changes nothing until the version containing it is
   * built, and silence is the worst possible answer to somebody who has just
   * written a skill and restarted to see it work.
   */
  async function warnUnbuiltCustom(): Promise<void> {
    // Only versions carry a build; on a checkout `iva restart` must not shell out
    // to git to learn what it can see for itself.
    const install = classifyRoot(ROOT);
    if (install.kind !== "version") return;
    const store = createVersionStore(install.home);
    const active = store.currentName();
    if (!active) return;
    const customDir = join(store.layout.data, "custom");
    // The plugins carrying code are half of what names a version (ADR-0009), so an
    // installed plugin that no build has seen yet reads exactly like an edited skill.
    const { digest, plugins } = await versionOverlay(store.layout.data);
    if (parseVersionName(active)?.overlay !== digest) {
      warn(
        "data/custom changed since this version was built - run: iva update",
      );
      return;
    }
    // The version carries the digest of a customization that then failed to
    // build or start, so the stock tree was installed under that name. Nothing
    // about the digest says so - only the files in the tree do - and this is the
    // case where a user is most sure their skill should be running.
    if (
      digest &&
      builtWith(
        join(store.layout.versions, active),
        active,
        customDir,
        plugins,
      ) !== "applied"
    )
      warn(
        "data/custom is not in the version that runs: it did not build or start - fix it and run: iva update",
      );
  }

  // Full reset: stop services, quarantine workflow + Telegram control state, bring it back up.
  // A plain restart
  // does NOT cure a stuck/bloated run — on startup eve re-enqueues all pending/running
  // runs ("Re-enqueued N active run(s) on startup"). We clean while the server is stopped
  // (otherwise we'd delete files out from under a live process). Wipes ALL parked dialogs.
  // Current eve keeps the store in .eve/.workflow-data; the bare .workflow-data is where
  // older versions kept it — clear both so reset works across eve upgrades. Busy markers and
  // the bridge queue are part of the same transaction: neither may leak into a fresh workflow.
  function cmdReset(): void {
    requireSystemd();
    step("Full reset: stopping services…");
    // Fail closed: quarantining the store under a live eve corrupts state and resurrects
    // the very runs we're clearing — if stop failed, don't touch anything.
    try {
      systemd.stop(SERVICES);
    } catch (error) {
      bad(
        `${(error as { readonly message: string }).message} Workflow and Telegram control state left untouched`,
      );
      exit(1);
    }
    let found = false;
    let failed = false;
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    for (const target of resetStateTargets(ROOT, dataDirAbs())) {
      try {
        // Quarantine (rename → *.trash-<stamp>) instead of rm: undo-able until rotated out.
        const dest = quarantinePath(target, stamp);
        if (!dest) continue;
        found = true;
        ok(
          `${relative(ROOT, target)} → ${relative(ROOT, dest)} — reset state quarantined`,
        );
      } catch (error) {
        failed = true;
        warn(
          `failed to quarantine ${relative(ROOT, target)}: ${(error as { readonly message: string }).message}`,
        );
      }
    }
    if (!found && !failed)
      ok("workflow and Telegram control state already empty");
    let restartError: unknown = null;
    try {
      restartServices();
    } catch (error) {
      restartError = error;
    }
    if (restartError) {
      bad((restartError as { readonly message: string }).message);
    }
    if (failed)
      bad(
        "Reset INCOMPLETE — old workflow or Telegram control state may still be active",
      );
    if (failed || restartError) exit(1);
    ok("Restarted: iva + telegram-poll");
  }

  function cmdStart(): void {
    requireSystemd();
    activateUnits();
    ok("Started and enabled at boot");
  }

  function cmdStop(): void {
    requireSystemd();
    systemd.stop(SERVICES);
    ok("Stopped");
  }

  /**
   * Prove the agent came back, for a caller whose only other evidence is that
   * `restart` was accepted — which a unit in a restart loop grants every time.
   * Not async on purpose: a missing systemd is refused before any waiting starts.
   */
  function cmdAwaitHealthy(): Promise<void> {
    requireSystemd();
    const unit = SERVICES[0];
    if (!unit) throw new Error("no service to wait for");
    const port = servicePort(ENV_PATH);
    return awaitHealthy({
      unit,
      port,
      state: () => systemd.query("is-active", unit).out,
    }).then((result) => {
      if (!result.ok)
        throw new SystemdControlError(
          `${unit} did not come up: ${result.log}`,
          {
            unit,
          },
        );
      ok(`${unit} is active and answering on port ${port}`);
    });
  }

  function cmdLogs(args: readonly string[]): void {
    requireSystemd();
    const unit = args.includes("poll")
      ? "iva-telegram-poll.service"
      : "iva.service";
    run("journalctl", ["--user", "-u", unit, "-f", "-n", "50"]);
  }

  return {
    cmdStatus,
    cmdRestart,
    cmdReset,
    cmdStart,
    cmdStop,
    cmdLogs,
    cmdAwaitHealthy,
  };
}
