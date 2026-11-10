import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./lib/version-layout.ts";
import { z } from "zod";
import {
  listCustomConflicts,
  resolveCustomConflict,
} from "./lib/custom-layer.ts";
import { resolveDataDir } from "../packages/data-dir/index.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SideSchema = z.enum(["base", "local", "upstream", "edited"]);

function dataDir(): string {
  return resolveDataDir(ROOT);
}

export function runCustomRecovery(args: readonly string[]): void {
  const [command = "status", path, rawSide] = args;
  const customDataDir = dataDir();
  if (command === "status") {
    let conflicts: ReturnType<typeof listCustomConflicts> = [];
    let manifestError: string | undefined;
    try {
      conflicts = listCustomConflicts(customDataDir);
    } catch (error) {
      manifestError = error instanceof Error ? error.message : String(error);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: "iva-custom-recovery/v1",
          customRoot: join(customDataDir, "custom"),
          conflicts,
          ...(manifestError ? { manifestError } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  try {
    if (command !== "resolve" || !path || !rawSide)
      throw new Error(
        "usage: custom-recovery.ts status | resolve <agent/path> <base|local|upstream|edited>",
      );
    const side = SideSchema.parse(rawSide);
    const resolved = resolveCustomConflict({
      dataDir: customDataDir,
      path,
      side,
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        ...resolved,
        next: "Follow update-recovery: Activate corrected sources for this installation",
      })}\n`,
    );
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
}

if (isEntrypoint(import.meta.url)) runCustomRecovery(process.argv.slice(2));
