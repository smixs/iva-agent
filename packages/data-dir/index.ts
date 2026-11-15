import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const PRERELEASE_IDENTIFIER =
  "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = `${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?`;

export const VERSION_DIRECTORY_PATTERN = new RegExp(
  `^(${SEMVER})-([0-9a-f]{12})(?:\\+([0-9a-f]{8}))?(?:~(\\d+))?$`,
  "u",
);

export function dataDirSetting(configured: string | undefined): string {
  return configured?.trim() || "data";
}

/** The real path, or the path itself when it does not exist yet. */
export function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Installation anchor, preserving the caller's checkout and `current` spelling. */
export function installationHome(root: string): string {
  const lexical = resolve(root);
  const actual = physical(lexical);
  if (
    existsSync(resolve(actual, ".git")) ||
    basename(dirname(actual)) !== "versions" ||
    !VERSION_DIRECTORY_PATTERN.test(basename(actual))
  )
    return lexical;
  if (basename(lexical) === "current") return dirname(lexical);
  if (
    basename(dirname(lexical)) === "versions" &&
    VERSION_DIRECTORY_PATTERN.test(basename(lexical))
  )
    return dirname(dirname(lexical));
  return dirname(dirname(actual));
}

/** Canonical ASSISTANT_DATA_DIR contract for every Iva process. */
export function resolveDataDir(root: string, configured?: string): string {
  const value =
    arguments.length > 1 ? configured : process.env.ASSISTANT_DATA_DIR;
  return resolve(installationHome(root), dataDirSetting(value));
}
