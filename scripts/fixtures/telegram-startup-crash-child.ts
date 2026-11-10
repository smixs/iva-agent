import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadOffset, saveOffset } from "../poller/offset.ts";
import { acquireTelegramProcessLock } from "../poller/process-lock.ts";
import { prepareTelegramStartup } from "../poller/startup-state.ts";

const [mode, directory] = process.argv.slice(2);
if (!mode || !directory) {
  throw new Error(
    "usage: child <hold-before-marker|hold-after-marker|hold-after-drop|hold-after-offset|probe> <directory>",
  );
}
const markerFile = join(directory, "telegram-backlog-drop.json");
const offsetFile = join(directory, "telegram-offset.json");
const guardIdentity = `startup-crash-${process.pid}`;
const lease = await acquireTelegramProcessLock({
  testGuard: {
    identity: guardIdentity,
    directory: join(directory, ".guard"),
  },
});
const prepare = () =>
  prepareTelegramStartup(lease, {
    markerFile,
    loadOffsetImpl: () => loadOffset({ file: offsetFile }),
  });

if (mode === "probe") {
  let outcome: "DROP" | "RESUME" | "AMBIGUOUS";
  try {
    const startup = await prepare();
    outcome = startup.firstRun ? "DROP" : "RESUME";
  } catch (error) {
    if (
      error instanceof Error &&
      /marker exists without an offset/u.test(error.message)
    ) {
      outcome = "AMBIGUOUS";
    } else {
      throw error;
    }
  } finally {
    await lease.close();
  }
  process.stdout.write(`${outcome}\n`);
} else {
  if (mode !== "hold-before-marker") {
    const startup = await prepare();
    if (!startup.firstRun) throw new Error("fixture expected a first run");
  }
  if (mode === "hold-after-drop") {
    writeFileSync(join(directory, "drop-attempted"), "attempted\n");
  } else if (mode === "hold-after-offset") {
    await saveOffset(101, { file: offsetFile });
  } else if (mode !== "hold-before-marker" && mode !== "hold-after-marker") {
    throw new Error(`unknown mode: ${mode}`);
  }
  writeFileSync(join(directory, "boundary-ready"), `${mode}\n`);
  setInterval(() => {}, 60_000);
}
