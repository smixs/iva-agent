/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// CI guard for the systemd-timers -> eve-schedules migration (see CHANGELOG.md
// Unreleased, docs/deploy.md, agent/lib/schedule-migration.ts): catches a future
// change that accidentally reintroduces one of the retired deploy/ unit files, or
// silently changes the shape of agent/schedules/ (a stray extra/missing file there
// changes what `eve info` reports and what schedule-migration.ts's catch-up covers).
import { strict as assert } from "node:assert";
import test from "node:test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("deploy/ contains none of the 8 retired iva-memory-{daily,weekly,monthly,yearly} unit files", () => {
  const files = readdirSync(join(ROOT, "deploy"));
  const retired = files.filter((f) =>
    /^iva-memory-(daily|weekly|monthly|yearly)\.(service|timer)$/.test(f),
  );
  assert.deepEqual(
    retired,
    [],
    "these units moved to agent/schedules/*.ts — see agent/lib/schedule-migration.ts",
  );
  // Brain is the one memory-related unit that stays on systemd on purpose, and it ships
  // under that name only: the pre-rename pair is retired by scripts/lib/legacy-memory-units.ts,
  // so re-adding it to deploy/ would resurrect what the migration deletes.
  assert.ok(files.includes("iva-brain.service"));
  assert.ok(files.includes("iva-brain.timer"));
  assert.deepEqual(
    files.filter((f) => f.startsWith("iva-memory-doctor.")),
    [],
  );
});

test("agent/schedules/ contains exactly the 4 expected eve schedules", () => {
  const files = readdirSync(join(ROOT, "agent/schedules")).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".md"),
  );
  assert.deepEqual(
    [...files].sort(),
    [
      "jobs-watchdog.ts",
      "memory-night.ts",
      "proactive.ts",
      "reminders.ts",
    ].sort(),
  );
});
