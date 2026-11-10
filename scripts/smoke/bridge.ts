// Real Bridge loop with its existing isolated process-lease seam.
import { main } from "../poller/main.ts";
import { acquireTelegramProcessLock } from "../poller/process-lock.ts";
import { join } from "node:path";

await main({
  acquireProcessLockImpl: () =>
    acquireTelegramProcessLock({
      testGuard: {
        identity: `smoke-${process.pid}`,
        directory: join(process.env.HOME!, "bridge-guard"),
      },
    }),
});
