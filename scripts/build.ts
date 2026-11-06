import {
  resolveMemoryNightTime,
  memoryNightBuildSettings,
  MEMORY_NIGHT_BUILD_FILE,
  MEMORY_NIGHT_CONFIG_FILE,
} from "../agent/lib/memory-night-time.ts";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveInvalidCustomLayer,
  captureCustomLayer,
  commitCustomLayer,
  discardCustomLayer,
  materializeCustomLayer,
  readCustomManifest,
  rebaseBuildOutput,
  type MaterializedCustomLayer,
} from "./lib/custom-layer.ts";
import { resolveDataDir } from "./lib/data-dir.ts";
import { classifyRoot, isEntrypoint } from "./lib/version-layout.ts";
import { vaultDirOrExit } from "./lib/vault-boundary.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BUILD_ROOT = join(ROOT, ".iva-build");
const EXCLUDED_TOP_LEVEL = new Set([
  ".git",
  ".claude",
  ".iva-build",
  ".iva-update",
  ".worktrees",
  ".output",
  ".eve",
  ".workflow-data",
  "attachments",
  "data",
  "implementation-notes.md",
  "LEARNINGS.md",
  "node_modules",
  "notes",
  "vault",
]);

function dataDir(): string {
  return resolveDataDir(ROOT);
}

function copySourceTree(staging: string): void {
  const privateRoots = [resolve(dataDir()), vaultDirOrExit(ROOT)];
  const isPrivateRoot = (source: string): boolean => {
    const absolute = resolve(source);
    return privateRoots.some(
      (privateRoot) =>
        absolute === privateRoot || absolute.startsWith(`${privateRoot}${sep}`),
    );
  };
  for (const name of readdirSync(ROOT)) {
    if (EXCLUDED_TOP_LEVEL.has(name)) continue;
    if (
      name === ".env" ||
      (name.startsWith(".env.") && name !== ".env.example")
    )
      continue;
    const sourceRoot = join(ROOT, name);
    if (isPrivateRoot(sourceRoot) || lstatSync(sourceRoot).isSymbolicLink())
      continue;
    cpSync(sourceRoot, join(staging, name), {
      recursive: true,
      preserveTimestamps: true,
      filter(source) {
        if (lstatSync(source).isSymbolicLink()) return false;
        const path = relative(ROOT, source);
        const first = path.split(sep, 1)[0] ?? "";
        return !EXCLUDED_TOP_LEVEL.has(first) && !isPrivateRoot(source);
      },
    });
  }
}

function promoteOutput(staging: string): string | null {
  const built = join(staging, ".output");
  if (!existsSync(built)) throw new Error("build produced no output");
  const live = join(ROOT, ".output");
  const backup = existsSync(live)
    ? join(ROOT, `.output.iva-build-backup-${Date.now()}`)
    : null;
  if (backup) renameSync(live, backup);
  try {
    renameSync(built, live);
  } catch (error) {
    if (backup && existsSync(backup)) renameSync(backup, live);
    throw error;
  }
  return backup;
}

function restoreOutput(backup: string | null): void {
  rmSync(join(ROOT, ".output"), { recursive: true, force: true });
  if (backup && existsSync(backup)) renameSync(backup, join(ROOT, ".output"));
}

function promoteAgentSummary(staging: string): string | null {
  const built = join(staging, ".eve/agent-summary.json");
  const liveDir = join(ROOT, ".eve");
  const live = join(liveDir, "agent-summary.json");
  mkdirSync(liveDir, { recursive: true });
  const backup = existsSync(live)
    ? join(liveDir, `agent-summary.iva-build-backup-${Date.now()}.json`)
    : null;
  if (backup) renameSync(live, backup);
  try {
    renameSync(built, live);
  } catch (error) {
    if (backup && existsSync(backup)) renameSync(backup, live);
    throw error;
  }
  return backup;
}

function restoreAgentSummary(backup: string | null): void {
  rmSync(join(ROOT, ".eve/agent-summary.json"), { force: true });
  if (backup && existsSync(backup))
    renameSync(backup, join(ROOT, ".eve/agent-summary.json"));
}

function buildWithCustomLayer(): void {
  const nightTime = resolveMemoryNightTime(process.env.MEMORY_NIGHT_TIME);
  mkdirSync(BUILD_ROOT, { recursive: true });
  const staging = mkdtempSync(join(BUILD_ROOT, "staging-"));
  let materialized: MaterializedCustomLayer | null = null;
  let invalidRecoveryDir: string | null = null;
  let outputBackup: string | null = null;
  let summaryBackup: string | null = null;
  let outputPromoted = false;
  let summaryPromoted = false;
  try {
    copySourceTree(staging);
    if (existsSync(join(ROOT, "node_modules")))
      symlinkSync(
        join(ROOT, "node_modules"),
        join(staging, "node_modules"),
        "dir",
      );
    if (existsSync(join(ROOT, ".env")))
      symlinkSync(join(ROOT, ".env"), join(staging, ".env"));

    // An installed version is an immutable tree that already has the user's
    // customization overlaid into it, and it owns no git metadata - so the
    // legacy custom layer has nothing to do here. Asking anyway would be worse
    // than useless: git discovery climbs out of the version into whatever
    // checkout the installation still has above it, and the answer would rebase
    // this version's output onto a runtime directory outside the version, on a
    // revision that is not this version's.
    if (classifyRoot(ROOT).kind === "checkout") {
      const customDataDir = resolve(dataDir());
      let head = "";
      try {
        head = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      } catch {
        // Release archives without Git metadata still support a clean core build.
      }
      let hasCustomizations = false;
      if (head)
        try {
          captureCustomLayer({
            root: ROOT,
            dataDir: customDataDir,
            baseRevision: head,
          });
          hasCustomizations =
            Object.keys(readCustomManifest(customDataDir).entries).length > 0;
        } catch (error) {
          invalidRecoveryDir = archiveInvalidCustomLayer({
            dataDir: customDataDir,
            targetRevision: head,
            error,
          });
        }
      if (hasCustomizations) {
        materialized = materializeCustomLayer({
          root: staging,
          dataDir: customDataDir,
          targetRevision: head,
        });
      }
    }

    const nightSettings = join(staging, MEMORY_NIGHT_BUILD_FILE);
    writeFileSync(nightSettings, memoryNightBuildSettings(nightTime));
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const built = spawnSync(npm, ["run", "build:core"], {
      cwd: staging,
      env: { ...process.env, ASSISTANT_DATA_DIR: dataDir() },
      stdio: "inherit",
    });
    if (built.error) throw built.error;
    if (built.status !== 0) throw new Error("core build failed");
    copyFileSync(
      nightSettings,
      join(staging, ".output", MEMORY_NIGHT_CONFIG_FILE),
    );
    rebaseBuildOutput({
      outputDir: join(staging, ".output"),
      buildRoot: staging,
      appRoot: ROOT,
      agentRoot: materialized?.runtimeRoot,
    });
    outputBackup = promoteOutput(staging);
    outputPromoted = true;
    if (existsSync(join(staging, ".eve/agent-summary.json"))) {
      summaryBackup = promoteAgentSummary(staging);
      summaryPromoted = true;
    }
    if (materialized) {
      commitCustomLayer(materialized);
      materialized = null;
    }
    if (invalidRecoveryDir)
      process.stderr.write(
        `custom layer is invalid; built core only; recovery: ${invalidRecoveryDir}\n`,
      );
    try {
      if (summaryBackup) rmSync(summaryBackup, { force: true });
      if (outputBackup) rmSync(outputBackup, { recursive: true, force: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`build artifact cleanup deferred: ${detail}\n`);
    }
  } catch (error) {
    if (summaryPromoted) restoreAgentSummary(summaryBackup);
    if (outputPromoted) restoreOutput(outputBackup);
    if (materialized) discardCustomLayer(materialized);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (isEntrypoint(import.meta.url)) buildWithCustomLayer();
