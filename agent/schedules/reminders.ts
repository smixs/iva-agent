// Reminders dispatcher (docs/reminders.md): ticks every second, claims the
// due rows of data/reminders.json and hands each one to scripts/reminders/fire.ts in its
// own child process (the authored tree cannot import the Telegram transport, see
// scripts/authored-tree-guard.test.ts). No runScheduledJob status entry: the reminder table
// is the state, and a missed tick costs nothing - whatever is overdue is claimed next second.
import { defineSchedule } from "eve/schedules";
import { REMINDER_TICK_CRON } from "../lib/schedule-table.js";
import { runReminderTick } from "../lib/reminder-tick.js";

import { runHelperTick } from "../lib/helper-tick.js";

import { dispatchModelAuth } from "../lib/model-auth-dispatch.js";

let lastMaintenanceMinute: number | null = null;
let helperStep: Promise<void> | null = null;
export default defineSchedule({
  cron: REMINDER_TICK_CRON,
  run({ waitUntil }) {
    const minute = Math.floor(Date.now() / 60_000);
    const maintenance = minute !== lastMaintenanceMinute;
    lastMaintenanceMinute = minute;
    waitUntil(Promise.allSettled([runReminderTick({ dispatchOnly: true })]));
    if (!maintenance) return;
    // Maintenance must not hold Nitro's scheduled task while a Telegram Alert waits.
    // Both operations own their existing serialization and run only once per minute.
    void dispatchModelAuth();
    void runReminderTick({ command: true, dispatchOnly: true }).catch((error) =>
      console.error("command tick:", error),
    );
    helperStep ??= runHelperTick()
      .catch((error) => console.error("helper tick:", error))
      .finally(() => {
        helperStep = null;
      });
  },
});
