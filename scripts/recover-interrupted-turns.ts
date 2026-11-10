import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirSetting, resolveDataDir } from "../packages/data-dir/index.ts";
import { recoverInterruptedSessionState } from "./lib/wf-store.ts";

// Runs as ExecStartPre: a failed recovery is one journal line, never a service that
// cannot start. Bridge still closes the interrupted turn once its record goes stale.
try {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const dataDir = resolveDataDir(
    root,
    dataDirSetting(process.env.ASSISTANT_DATA_DIR),
  );
  const recovered = recoverInterruptedSessionState(root, dataDir);
  if (recovered.interrupted > 0) {
    console.log(
      `retired workflow state after ${recovered.interrupted} interrupted turn(s)`,
    );
  }
} catch (error) {
  console.error(
    `interrupted-turn recovery failed, starting anyway: ${error instanceof Error ? error.message : String(error)}`,
  );
}
