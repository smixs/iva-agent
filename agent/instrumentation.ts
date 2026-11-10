// Server-start hook (eve auto-discovers this file and runs it before any agent code).
// Two jobs, both side effects, no telemetry actually configured here:
//
//   1. TZ fallback so the process' local time (used by cron-parsed schedules below, which
//      fire in the process's OWN local time — eve schedules carry no timezone of their
//      own) matches ASSISTANT_TIMEZONE instead of defaulting to the host's system TZ.
//   2. fire-and-forget the systemd → eve-schedules migration (retire the old memory-rollup
//      timers, catch up a missed period). This is the one reliable point in the codebase
//      that always runs on the NEW server, even right after an `iva update` executed by
//      the OLD CLI process (started through the permanent bin/iva.mjs shim) doesn't
//      know about eve schedules at all.
//
// setup() runs before eve's own HTTP listener is guaranteed to be accepting connections.
// A catch-up run spawns scripts/memory/night.ts, which calls the configured model
// against that same listener immediately — spawning it too early is a bare "connection
// refused", not a retryable rollup failure. So the migration itself is only kicked off
// after polling the local health route (the same probeEveHealth used by `iva update`'s
// post-restart check) confirms the listener is actually up, bounded to ~2 minutes; if it
// never comes up in time, this boot's catch-up is skipped (logged) rather than run
// blind — the next boot's migration retries it exactly as it would any other stale period.
//
// recordInputs/recordOutputs: false — this file's mere presence implicitly enables eve's
// authored-telemetry path (see eve/docs/guides/instrumentation.md) and disables the
// zero-config local dev tracer; since no OTel exporter is registered below, telemetry is
// otherwise inert, but a stray default of `true` would still turn on payload capture we
// never asked for. Keep `eve dev` startup unaffected — verified by `timeout 30 npx eve dev`.
import { join } from "node:path";
import { defineInstrumentation } from "eve/instrumentation";
import { PROBE_FLAG, probeEveHealth } from "./lib/eve-health.ts";
import { dataDir as configuredDataDir } from "./lib/data-dir.ts";
import { runScheduleMigration } from "./lib/schedule-migration.ts";
import { resolveTimeZone, validateTimeZone } from "./lib/timezone.ts";

const log = (...args: unknown[]) =>
  console.log(new Date().toISOString(), ...args);

const LISTENER_READY_TIMEOUT_MS = 120_000;

export default defineInstrumentation({
  recordInputs: false,
  recordOutputs: false,
  setup() {
    // Every non-TS child spawned by a turn inherits one canonical absolute path.
    process.env.ASSISTANT_DATA_DIR = configuredDataDir();

    // Nitro's schedule runner reads the process timezone. Validate before assigning TZ:
    // process.env stringifies every value, and an unknown zone would make every Intl
    // consumer throw a RangeError.
    const rawTz = process.env.ASSISTANT_TIMEZONE;
    const tz = resolveTimeZone(rawTz);
    if (rawTz?.trim() && validateTimeZone(rawTz) === null) {
      log(
        `schedule-migration: invalid timezone ${rawTz} — falling back to UTC`,
      );
    }
    process.env.ASSISTANT_TIMEZONE = tz;
    process.env.TZ = tz;

    // `iva update` starts this same server from a candidate version to prove it comes
    // up, then throws the candidate away if it does not. That start must stay passive:
    // the migration retires systemd units and can spawn a rollup, on behalf of code the
    // installation has not accepted. The real start right after the flip runs it.
    if (process.env[PROBE_FLAG]) {
      log(
        "schedule-migration: skipped, this start is an update's health probe",
      );
      return;
    }

    // Never let this block or fail server startup: wrap synchronously, and treat the
    // whole async chain below as fire-and-forget with its own catch.
    try {
      const root = process.cwd();
      const dataDir = process.env.ASSISTANT_DATA_DIR;
      // Always loopback, deliberately NOT derived from ASSISTANT_HOST: the listener is
      // bound to 127.0.0.1 by iva.service (`eve start --host 127.0.0.1`) regardless of
      // what ASSISTANT_HOST says, and probeEveHealth only accepts loopback hostnames. A
      // self-host ASSISTANT_HOST pointed at a public domain or LAN address would
      // otherwise make the probe reject instantly on every boot, permanently disabling
      // catch-up — the exact Persistent=true replacement this file exists to provide.
      const port = process.env.IVA_PORT ?? "8723";
      const healthUrl = `http://127.0.0.1:${port}/eve/v1/health`;

      (async () => {
        try {
          await probeEveHealth(healthUrl, {
            timeoutMs: LISTENER_READY_TIMEOUT_MS,
          });
        } catch (error) {
          log(
            "schedule-migration: HTTP listener not ready within",
            `${LISTENER_READY_TIMEOUT_MS}ms — skipping this boot's catch-up (next boot retries):`,
            error instanceof Error ? error.message : String(error),
          );
          return;
        }
        await runScheduleMigration({
          statusPath: join(dataDir, "rollup-status.json"),
          tz,
          root,
          nodeBin: process.execPath,
          log,
        });
      })().catch((error: unknown) => {
        log(
          "schedule-migration failed:",
          error instanceof Error ? error.message : String(error),
        );
      });
    } catch (error) {
      log(
        "schedule-migration setup failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  },
});
