/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registrations. */
// Один путь к data/alert-state.json — packages/alert-state. Сторонний читатель или писатель
// с собственным замком теряет чужую отметку дросселя (та же гонка, что закрыт замок пакета),
// поэтому имя файла и замка известно только пакету: страж ниже краснеет на литерале вне него.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

test("alert-state path literals live only inside packages/alert-state", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const offenders = tracked.filter(
    (file) =>
      (file.startsWith("agent/") || file.startsWith("scripts/")) &&
      !file.endsWith(".test.ts") &&
      /alert-state\.(?:json|lock)/u.test(
        readFileSync(join(ROOT, file), "utf8"),
      ),
  );
  assert.deepEqual(offenders, [], "alert-state path outside the package");
});

const dir = mkdtempSync(join(tmpdir(), "iva-alert-state-"));
process.env.ASSISTANT_DATA_DIR = dir;
const { clearCommandAlert } = await import("../agent/lib/reminder-store.ts");
const { readAlertState, recordAlert } = await import(
  "../packages/alert-state/index.ts"
);
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("clearCommandAlert drops only the schedule-<id> record", (t) => {
  const home = mkdtempSync(join(dir, "case-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.ASSISTANT_DATA_DIR = home;
  recordAlert(home, "schedule-c-9", "abandoned", 1);
  recordAlert(home, "schedule-c-7", "abandoned", 2);
  recordAlert(home, "model-auth-fact:claude", "{}", 3);
  clearCommandAlert("c-9");
  assert.deepEqual(Object.keys(readAlertState(home)).sort(), [
    "model-auth-fact:claude",
    "schedule-c-7",
  ]);
});

test("clearCommandAlert on an empty install creates no state file", (t) => {
  const home = mkdtempSync(join(dir, "case-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.ASSISTANT_DATA_DIR = home;
  clearCommandAlert("c-9");
  assert.equal(existsSync(join(home, "alert-state.json")), false);
});
