import { accessSync, constants, realpathSync } from "node:fs";
import { join } from "node:path";

/** Persist a Homebrew opt link only when it identifies the current executable. */
export function stableNodeExecutable(
  node: string,
  platform = process.platform,
): string {
  if (platform !== "darwin") return node;
  const match = /^(.*)\/Cellar\/(node(?:@[^/]+)?)\/[^/]+\/bin\/node$/u.exec(
    node,
  );
  if (!match) return node;
  const candidate = join(match[1], "opt", match[2], "bin", "node");
  try {
    accessSync(candidate, constants.X_OK);
    if (realpathSync(candidate) === realpathSync(node)) return candidate;
  } catch {
    // The Cellar installation may be unlinked or the opt link may be missing.
  }
  throw new Error(
    `Cannot persist Homebrew Node.js path: ${candidate} does not resolve to ${node}`,
  );
}
