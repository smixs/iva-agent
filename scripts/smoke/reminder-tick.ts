// Test entry for the dispatcher called by agent/schedules/reminders.ts.
import { fireDue } from "../../agent/lib/reminder-store.ts";
import { runReminderTick } from "../../agent/lib/reminder-tick.ts";
const nowMs = Number(process.argv[2]);
if (process.argv[3] === "capture") {
  console.log(JSON.stringify(await fireDue(nowMs, 5)));
} else {
  const result = await runReminderTick({ nowMs });
  console.log(JSON.stringify(result));
  if (result.error) process.exitCode = 1;
}
