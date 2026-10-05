export const USERBOT_IMPORT_TIMEOUT_MS = 10_000;

interface UserbotSyncOptions {
  readonly pythonPath: string;
  readonly requirementsFile: string;
  readonly requirementsText: string;
  readonly requireHashes?: boolean;
}

export function userbotSyncArgs({
  pythonPath,
  requirementsFile,
  requirementsText,
  requireHashes = true,
}: UserbotSyncOptions): string[] {
  const hasHashes = requirementsText.includes("--hash=sha256:");
  if (requireHashes && !hasHashes)
    throw new Error(
      "userbot: requirements.lock не содержит hashes — переустанови актуальную версию Iva",
    );

  return [
    "pip",
    "sync",
    "--python",
    pythonPath,
    ...(requireHashes ? ["--require-hashes", "--strict"] : []),
    requirementsFile,
  ];
}
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/** Same fallback as install.sh: a non-login PATH need not contain ~/.local/bin. */
export function resolveUv(
  pathValue = process.env.PATH ?? "",
  home = homedir(),
): string | null {
  for (const dir of [
    ...pathValue.split(delimiter).filter(Boolean),
    join(home, ".local/bin"),
  ]) {
    const file = resolve(dir, "uv");
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      // Missing, dangling symlink or non-executable: try the next installation.
    }
  }
  return null;
}
