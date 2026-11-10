import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { AtomicWriteOptions } from "../../agent/lib/fs-atomic.ts";
import {
  resolveDataDir,
  VERSION_DIRECTORY_PATTERN,
} from "../../packages/data-dir/index.ts";
import { parseEnvText } from "./env-file.ts";
import { processCommand } from "./process-command.ts";
import { resolveVaultDir } from "../../packages/vault-dir/index.ts";

const INCOMPLETE = ".iva-incomplete";
const SETTLED = "active.json";
const LIVE_FAILURES = "live-failures.json";
/** Enough for the versions on disk and the releases a box works through. */
const FAILURES_KEPT = 8;
const LOCK = "update.lock";
const STALE_LOCK_PREFIX = `${LOCK}.stale-`;
const STALE_LOCK_RETENTION_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 60 * 60 * 1000;
const OWNER_PUBLICATION_MS = 5_000;
const FLIP_PREFIX = ".current.iva-flip-";
/** Names in `home` that only an interrupted update can leave behind. */
const LEFTOVER = [FLIP_PREFIX, ".probe-"];
// eslint-disable-next-line @typescript-eslint/unbound-method -- Intl.Collator compare is a bound getter.
const VERSION_ORDER = new Intl.Collator("en", { numeric: true }).compare;
/** What a version borrows from the installation; the rest of `.eve` is a build cache. */
export const STATE_DIRS = ["data", "vault", ".eve/.workflow-data"];
/** Where older builds kept the workflow store: linked where one is, never created. */
export const LEGACY_STATE_DIRS = [".workflow-data"];
/** The active version plus one to roll back to; a build takes the rollback slot. Disks on these boxes are small. */
export const KEEP = 2;

type ActiveStateV1 = {
  readonly schema: "iva-active/v1";
  readonly version: string;
  readonly settledAt?: string;
};

type ActiveStateV2 = {
  readonly schema: "iva-active/v2";
  readonly version: string;
  readonly previous?: string;
  readonly settledAt: string;
  readonly cleanupPending?: boolean;
};

export type ActiveState = ActiveStateV1 | ActiveStateV2;

export type ActiveStateRead =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly state: ActiveState }
  | { readonly kind: "corrupt-or-unreadable"; readonly reason: string };

type CurrentStateRead =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly name: string }
  | { readonly kind: "corrupt-or-unowned"; readonly reason: string };

type VersionStoreOptions = {
  /** Fault seam for the active marker's canonical atomic writer. */
  readonly activeWriteOptions?: AtomicWriteOptions;
};

type AtomicWriter = Pick<
  typeof import("../../agent/lib/fs-atomic.ts"),
  "writeFileAtomicSync"
>;

const require = createRequire(import.meta.url);

function atomicWriter(): AtomicWriter {
  // The CLI must still load on a broken install whose authored tree is absent.
  // Mutation requires the canonical writer and fails closed if that tree is gone.
  return require("../../agent/lib/fs-atomic.ts") as AtomicWriter;
}

/** Where an installation keeps things; state and the mirror outlive every version. */
export function layoutFor(home: string) {
  const env = join(home, ".env");
  // The installation's own .env says where its state is - `iva config` writes those
  // paths absolute - and the lock, the markers and the customization live in it.
  // Asking anything else builds a version beside the state the service reads.
  let values: Record<string, string> = {};
  try {
    values = parseEnvText(readFileSync(env, "utf8"));
  } catch {
    // No readable .env: the directories beside the installation are the answer.
  }
  return {
    home,
    repo: join(home, "repo"),
    versions: join(home, "versions"),
    current: join(home, "current"),
    data: resolveDataDir(home, values.ASSISTANT_DATA_DIR),
    vault: resolveVaultDir(home, values.ASSISTANT_VAULT_DIR),
    env,
    // Already parsed to find the state directories; handed back so the updater does not
    // read and parse the same file again to check one more value.
    values,
  };
}

/** Release, commit and a digest of the user's files; `build` numbers rebuilds of one. */
export function versionName(
  version: string,
  sha: string,
  overlay: string | null = null,
  build = 1,
): string {
  const tail = `${overlay ? `+${overlay}` : ""}${build > 1 ? `~${build}` : ""}`;
  return `${version}-${sha.slice(0, 12)}${tail}`;
}

export function parseVersionName(name: string) {
  const match = VERSION_DIRECTORY_PATTERN.exec(name);
  if (!match) return null;
  return {
    version: match[1],
    sha: match[2],
    overlay: match[3] ?? null,
    build: match[4] ? Number(match[4]) : 1,
  };
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length <= allowed.length && keys.every((key) => allowed.includes(key))
  );
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch (error) {
    console.error(
      `version-store: не смог разобрать timestamp ${JSON.stringify(value)}: ${String(error)}`,
    );
    return false;
  }
}

function validActiveState(value: unknown): value is ActiveState {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const state = value as Record<string, unknown>;
  if (typeof state.version !== "string" || !parseVersionName(state.version))
    return false;
  if (state.schema === "iva-active/v1")
    return (
      exactKeys(state, ["schema", "version", "settledAt"]) &&
      (state.settledAt === undefined || isoTimestamp(state.settledAt))
    );
  if (state.schema !== "iva-active/v2") return false;
  if (
    !exactKeys(state, [
      "schema",
      "version",
      "previous",
      "settledAt",
      "cleanupPending",
    ]) ||
    !isoTimestamp(state.settledAt) ||
    (state.cleanupPending !== undefined &&
      typeof state.cleanupPending !== "boolean")
  )
    return false;
  return (
    state.previous === undefined ||
    (typeof state.previous === "string" &&
      state.previous !== state.version &&
      parseVersionName(state.previous) !== null)
  );
}

/** A missing marker is first-install state; every existing invalid marker is explicit. */
export function readActiveState(path: string): ActiveStateRead {
  let regularFile: boolean;
  try {
    regularFile = lstatSync(path).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "missing" };
    return {
      kind: "corrupt-or-unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!regularFile)
    return {
      kind: "corrupt-or-unreadable",
      reason: "active state marker is not a regular file",
    };
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return {
      kind: "corrupt-or-unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isUtf8(bytes))
    return { kind: "corrupt-or-unreadable", reason: "invalid UTF-8" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return {
      kind: "corrupt-or-unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return validActiveState(parsed)
    ? { kind: "valid", state: parsed }
    : { kind: "corrupt-or-unreadable", reason: "invalid active state schema" };
}

/** The release a directory is a build of; two builds of one release run the same code. */
export function releaseOf(name: string): string {
  const at = parseVersionName(name);
  return at ? versionName(at.version, at.sha, at.overlay) : name;
}

/** Explicit state references always win; candidate order only fills spare slots. */
export function retainedVersions(
  finished: readonly string[],
  references: readonly (string | null | undefined)[],
  keep: number,
): string[] {
  const available = new Set(finished);
  const retained = new Set(
    references.filter(
      (name): name is string => typeof name === "string" && available.has(name),
    ),
  );
  const target = Math.max(keep, retained.size, 1);
  for (const name of finished) {
    if (retained.size >= target) break;
    retained.add(name);
  }
  return [...retained];
}

/**
 * What a version is built out of: the commit and the user's files. Two builds
 * with one key run the same code, so what one of them did to the service the
 * other does again - the build number is the only thing that tells them apart.
 */
function inputsOf(name: string): string | null {
  const at = parseVersionName(name);
  return at ? `${at.sha}+${at.overlay ?? ""}` : null;
}

/** Through a file, not a pipe: two joined processes are a second failure mode. */
function unpack(command: string, args: string[], cwd: string): void {
  const done = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (!done.error && done.status === 0) return;
  const why = done.error?.message ?? (done.stderr || "").trim();
  throw new Error(`materialize failed: ${why || command}`);
}

/**
 * Immutable version directories plus one symlink saying which runs. Every mutation
 * is confined to a directory nothing points at, or is one atomic rename, so an
 * interruption leaves garbage and never half a changed installation.
 */
export function createVersionStore(
  home: string,
  { activeWriteOptions }: VersionStoreOptions = {},
) {
  const layout = layoutFor(home);

  function activeState(): ActiveState | null {
    const path = join(layout.data, SETTLED);
    const result = readActiveState(path);
    if (result.kind === "missing") return null;
    if (result.kind === "valid") return result.state;
    throw new Error(`active.json is corrupt or unreadable: ${result.reason}`);
  }

  const writeActiveState = (body: ActiveState): void =>
    writeJson(join(layout.data, SETTLED), body, activeWriteOptions);

  const versionDir = (name: string): string => {
    if (!parseVersionName(name)) throw new Error(`invalid version: ${name}`);
    return join(layout.versions, name);
  };

  /** A directory without the marker is a version; with it, it is garbage. */
  const isComplete = (name: string): boolean =>
    existsSync(join(layout.versions, name)) &&
    !existsSync(join(layout.versions, name, INCOMPLETE));

  const names = (): string[] => {
    try {
      return readdirSync(layout.versions).sort();
    } catch {
      return [];
    }
  };

  /** Finished versions in deterministic release order, newest first. */
  function list(): string[] {
    return names()
      .filter((name) => parseVersionName(name) && isComplete(name))
      .sort((a, b) => VERSION_ORDER(b, a));
  }

  /** Missing is first-install state; every existing unowned object is explicit. */
  function readCurrentState(): CurrentStateRead {
    let target: string;
    let versions: string;
    try {
      if (!lstatSync(layout.current).isSymbolicLink())
        return {
          kind: "corrupt-or-unowned",
          reason: "current path is not a symlink",
        };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { kind: "missing" };
      return {
        kind: "corrupt-or-unowned",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      target = realpathSync(layout.current);
    } catch (error) {
      return {
        kind: "corrupt-or-unowned",
        reason: `current symlink is dangling or unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    try {
      versions = realpathSync(layout.versions);
    } catch (error) {
      return {
        kind: "corrupt-or-unowned",
        reason: `versions directory is unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (dirname(target) !== versions)
      return {
        kind: "corrupt-or-unowned",
        reason: "current symlink target is outside versions",
      };
    const name = target.slice(versions.length + 1);
    let directory: boolean;
    try {
      directory = statSync(target).isDirectory();
    } catch (error) {
      return {
        kind: "corrupt-or-unowned",
        reason: `current symlink target is unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (!parseVersionName(name) || !directory)
      return {
        kind: "corrupt-or-unowned",
        reason: "current symlink target is not a version directory",
      };
    if (!isComplete(name))
      return {
        kind: "corrupt-or-unowned",
        reason: "current symlink target is not a complete version",
      };
    return { kind: "valid", name };
  }

  /** The active version; null only when the `current` path itself is missing. */
  function currentName(): string | null {
    const state = readCurrentState();
    if (state.kind === "missing") return null;
    if (state.kind === "valid") return state.name;
    throw new Error(`current is foreign or corrupt: ${state.reason}`);
  }

  function previousName(): string | null {
    const active = currentName();
    const state = activeState();
    for (const candidate of [
      state?.schema === "iva-active/v2" ? state.previous : undefined,
      state?.version,
    ]) {
      if (
        typeof candidate === "string" &&
        candidate !== active &&
        isComplete(candidate)
      )
        return candidate;
    }
    return list().find((name) => name !== active) ?? null;
  }

  /** A free directory for the next build of a release, beside the running one. */
  function nextBuild(release: string): string {
    const at = parseVersionName(release);
    if (!at) throw new Error(`invalid version: ${release}`);
    for (let build = 1; build <= 99; build++) {
      const name = versionName(at.version, at.sha, at.overlay, build);
      if (!existsSync(join(layout.versions, name))) return name;
    }
    throw new Error(`too many builds of ${release} on disk`);
  }

  /** Claim a version directory. Fails loudly rather than touching anything live. */
  function stage(name: string): string {
    const dir = versionDir(name);
    if (name === currentName())
      throw new Error(`version ${name} is already active`);
    mkdirSync(layout.versions, { recursive: true });
    try {
      mkdirSync(dir);
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(`version ${name} already exists`, { cause: caught });
      throw caught;
    }
    mkdirSync(join(dir, INCOMPLETE));
    return dir;
  }

  function complete(name: string): void {
    rmSync(join(versionDir(name), INCOMPLETE), {
      recursive: true,
      force: true,
    });
  }

  /** Empty a staged version so it can be rebuilt without losing the claim on it. */
  function reset(name: string): string {
    const dir = versionDir(name);
    if (isComplete(name)) throw new Error(`version ${name} is complete`);
    for (const entry of readdirSync(dir))
      if (entry !== INCOMPLETE)
        rmSync(join(dir, entry), { recursive: true, force: true });
    return dir;
  }

  /** Point `current` at a finished version with one rename. */
  function activate(name: string): void {
    activeState(); // Existing invalid state blocks every live mutation.
    currentName(); // Existing foreign state belongs to someone else.
    const dir = versionDir(name);
    if (!isComplete(name)) throw new Error(`version ${name} is incomplete`);
    linkState(dir); // Whatever a killed probe aimed them at, back at the install.

    const flip = join(home, `${FLIP_PREFIX}${process.pid}-${Date.now()}`);
    rmSync(flip, { recursive: true, force: true });
    symlinkSync(dir, flip);
    try {
      // rename() replaces the symlink atomically. A different filesystem object
      // is foreign state: refuse it and leave manual repair to the operator.
      const link = layout.current;
      currentName();
      renameSync(flip, link);
    } catch (error) {
      rmSync(flip, { recursive: true, force: true });
      throw error;
    }
  }

  /** Flipped, migrated, restarted: an update is owed while this and `current` disagree. */
  function settled(): string | null {
    return activeState()?.version ?? null;
  }

  /** Commit one served version and retain the last served version as its rollback. */
  function settle(
    name: string,
    options: {
      readonly cleanupPending?: boolean;
      readonly previous?: string | null;
    } = {},
  ): void {
    const before = activeState();
    const previous = [
      options.previous,
      before?.version,
      before?.schema === "iva-active/v2" ? before.previous : undefined,
    ].find(
      (candidate): candidate is string =>
        typeof candidate === "string" &&
        candidate !== name &&
        isComplete(candidate),
    );
    mkdirSync(layout.data, { recursive: true });
    writeActiveState({
      schema: "iva-active/v2",
      version: name,
      ...(previous ? { previous } : {}),
      settledAt: new Date().toISOString(),
      ...(options.cleanupPending ? { cleanupPending: true } : {}),
    });
  }

  /** Cleanup is retryable debt after a version has already served and committed. */
  function cleanupPending(name: string): boolean {
    const state = activeState();
    return (
      state?.schema === "iva-active/v2" &&
      state.version === name &&
      state.cleanupPending === true
    );
  }

  /** Clear only the debt belonging to the still-settled version. */
  function finishCleanup(name: string): void {
    const state = activeState();
    if (state?.schema !== "iva-active/v2" || state.version !== name)
      throw new Error(`cleanup state changed from ${name}`);
    const finished = { ...state };
    delete finished.cleanupPending;
    writeActiveState(finished);
  }

  /**
   * When the installation last finished a move. The only evidence an update ran
   * that survives the process which ran it, for a job too old to name the version
   * it started on. A marker written before this field carries no time at all.
   */
  function settledAt(): string | null {
    return activeState()?.settledAt ?? null;
  }

  function liveFailures(): string[] {
    const failed = readJson(join(layout.data, LIVE_FAILURES)).failed;
    return Array.isArray(failed)
      ? failed.filter((key): key is string => typeof key === "string")
      : [];
  }

  /**
   * Has this code already been flipped in and left the service dead? A build that
   * did is not one to install again: it takes the installation down for a whole
   * health deadline and rolls back, every time, for as long as it is on disk.
   */
  function liveFailed(name: string): boolean {
    const key = inputsOf(name);
    return key !== null && liveFailures().includes(key);
  }

  /** What the service did on the version just flipped in, by what it was built from. */
  function recordLive(name: string, ok: boolean): void {
    const key = inputsOf(name);
    if (key === null) return;
    const before = liveFailures();
    const kept = before.filter((one) => one !== key);
    if (ok && kept.length === before.length) return; // Nothing to forget.
    if (!ok) kept.push(key);
    mkdirSync(layout.data, { recursive: true });
    writeJson(join(layout.data, LIVE_FAILURES), {
      schema: "iva-live-failures/v1",
      failed: kept.slice(-FAILURES_KEPT),
    });
  }

  /** Remove what an interrupted update can leave behind. Never touches a version. */
  function sweep(): string[] {
    activeState(); // Never delete leftovers while rollback state is untrusted.
    currentName(); // Never clean an installation whose live owner is untrusted.
    const stale = names().filter(
      (name) => parseVersionName(name) && !isComplete(name),
    );
    for (const name of stale)
      rmSync(join(layout.versions, name), { recursive: true, force: true });
    for (const name of readdirSync(home).sort()) {
      if (!LEFTOVER.some((prefix) => name.startsWith(prefix))) continue;
      rmSync(join(home, name), { recursive: true, force: true });
      stale.push(name);
    }
    for (const entry of readdirSync(layout.data, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(STALE_LOCK_PREFIX))
        continue;
      const path = join(layout.data, entry.name);
      if (
        Date.now() - statSync(path).mtimeMs <= STALE_LOCK_RETENTION_MS ||
        held(path)
      )
        continue;
      rmSync(path, { recursive: true, force: true });
      stale.push(entry.name);
    }
    return stale;
  }

  /**
   * Keep every state reference by default, or only `current` when a build needs
   * the rollback slot, then fill the requested count deterministically.
   */
  function gc(
    keep: number,
    options: { readonly references?: "state" | "current" } = {},
  ): string[] {
    const state = activeState();
    const active = currentName();
    const finished = list();
    const kept = new Set(
      retainedVersions(
        finished,
        options.references === "current"
          ? [active]
          : [
              active,
              state?.version,
              state?.schema === "iva-active/v2" ? state.previous : null,
            ],
        keep,
      ),
    );
    const removed = finished.filter((name) => !kept.has(name));
    for (const name of removed)
      rmSync(join(layout.versions, name), { recursive: true, force: true });
    return removed.sort();
  }

  /** Make `current` valid again after a manual edit or a crash. */
  function heal(): string | null {
    const state = activeState();
    const active = currentName();
    if (active) return active;
    // Not the newest on disk: after a rollback that one is the rejected version.
    const chosen = state?.version ?? null;
    const pick = list().find((name) => name === chosen) ?? list()[0];
    if (!pick) return null;
    activate(pick);
    return pick;
  }

  /** Fill a staged directory with the exact tree of one commit, without git state. */
  async function materialize(at: { sha: string; dir: string }): Promise<void> {
    await Promise.resolve();
    const archive = join(at.dir, ".iva-archive.tar");
    const args = ["archive", "--format=tar", `--output=${archive}`, at.sha];
    try {
      unpack("git", args, layout.repo);
      unpack("tar", ["-x", "-f", archive], at.dir);
    } finally {
      rmSync(archive, { force: true });
    }
  }

  /** What a link inside a version leads to: the .env may put data or the vault anywhere. */
  const stateAt = (name: string, root: string): string => {
    if (root !== home) return join(root, name); // A probe's scratch is plain names.
    if (name === "data") return layout.data;
    if (name === "vault") return layout.vault;
    return join(home, name);
  };

  /** State outlives versions: `stateHome` is the installation, or scratch for a probe. */
  function linkState(dir: string, stateHome: string = home): void {
    const links = STATE_DIRS.map((name): [string, string] => [
      name,
      stateAt(name, stateHome),
    ]);
    for (const name of LEGACY_STATE_DIRS) {
      // Cleared even where nothing replaces it, or a link from an earlier pass
      // survives into a probe aimed at live state. Asked of the install, never
      // the scratch: a box without a legacy store never grows one.
      rmSync(join(dir, name), { recursive: true, force: true });
      if (existsSync(join(home, name)))
        links.push([name, join(stateHome, name)]);
    }
    for (const [, target] of links) mkdirSync(target, { recursive: true });
    // The .env is the installation's in both modes: a probe under a configuration
    // nobody runs proves nothing, and `iva config` writes through to the real file.
    links.push([".env", layout.env]);
    for (const [name, target] of links) {
      const link = join(dir, name);
      rmSync(link, { recursive: true, force: true });
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link);
    }
  }

  /**
   * State for a probe: a real start re-enqueues what the installation is doing.
   * Beside the versions, never inside the one being proved, or a kill mid-check
   * hands the next sweep a good version to delete.
   */
  function sandboxState(name: string): string {
    const scratch = join(home, `.probe-${process.pid}-${Date.now()}`);
    linkState(versionDir(name), scratch);
    return scratch;
  }

  return {
    layout,
    list,
    currentName,
    previousName,
    nextBuild,
    stage,
    reset,
    complete,
    activate,
    settled,
    settle,
    cleanupPending,
    finishCleanup,
    settledAt,
    liveFailed,
    recordLive,
    sweep,
    gc,
    heal,
    materialize,
    linkState,
    sandboxState,
  };
}

/** A JSON file that may be missing or corrupt; an unreadable one is empty. */
export function readJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return (parsed as Record<string, unknown> | null) ?? {};
  } catch {
    return {};
  }
}

/** Durable atomic JSON marker using the project's single canonical writer. */
export function writeJson(
  path: string,
  body: unknown,
  options: AtomicWriteOptions = {},
): void {
  atomicWriter().writeFileAtomicSync(path, `${JSON.stringify(body)}\n`, {
    ...options,
    mode: 0o600,
  });
}

export type UpdateLock = { readonly path: string; release(): void };

type LockOwner = {
  readonly pid?: number;
  readonly command?: string;
  readonly startedAt?: string;
};

function ownerOf(path: string): LockOwner {
  const owner = readJson(join(path, "owner.json"));
  return {
    pid: typeof owner.pid === "number" ? owner.pid : undefined,
    command: typeof owner.command === "string" ? owner.command : undefined,
    startedAt:
      typeof owner.startedAt === "string" ? owner.startedAt : undefined,
  };
}

function ownerPid(path: string): number | undefined {
  return ownerOf(path).pid;
}

/** Живой ли процесс: EPERM - чужой пользователь, а не смерть. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Тот ли это процесс, что брал замок. Спросить команду не удалось (чужой пользователь,
 * `ps` недоступен) - считаем, что тот: чужое обновление не перешагивают по догадке.
 */
function sameCommand(owner: LockOwner & { readonly command: string }): boolean {
  const running = processCommand(owner.pid ?? 0).trim();
  return running === "" || running === owner.command.trim();
}

/** Возраст замка: по времени его взятия, а если его нет - по mtime каталога. */
function fresh(path: string, owner: LockOwner, staleMs = STALE_MS): boolean {
  const takenAt = owner.startedAt ? Date.parse(owner.startedAt) : Number.NaN;
  if (!Number.isNaN(takenAt)) return Date.now() - takenAt < staleMs;
  try {
    return Date.now() - statSync(path).mtimeMs < staleMs;
  } catch {
    return true; // A lock that cannot be read is not one to walk over.
  }
}

/** Write down who holds the lock; only that process may drop it again. */
function own(path: string): UpdateLock {
  const startedAt = new Date().toISOString();
  writeJson(join(path, "owner.json"), {
    pid: process.pid,
    startedAt,
    command: processCommand(process.pid).trim(),
  });
  return {
    path,
    // Never another process's lock: a handoff ends with the successor holding it.
    release: () => {
      if (ownerPid(path) === process.pid)
        rmSync(path, { recursive: true, force: true });
    },
  };
}

/** Take over a held lock: the process that finishes an update is the one that owns it. */
export function adoptUpdateLock(dataDir: string): UpdateLock {
  const path = join(dataDir, LOCK);
  mkdirSync(path, { recursive: true });
  return own(path);
}

/**
 * Whether a lock that exists still counts. A lock whose owner is gone is stale at
 * once - a SIGKILLed update must not block the retry cleaning up after it.
 *
 * Одного `kill(pid, 0)` мало: после перезагрузки тот же номер носит чужой процесс, и
 * замок оборванного обновления держал бы установку вечно - `iva update` отвечал бы
 * «Обновление уже идёт», повтор моста и repair.sh упирались бы в него, а лечилось бы
 * это удалением `data/update.lock` руками. Поэтому у живого pid сверяется команда,
 * которую владелец записал. Замок старого формата команды не несёт - его, как и
 * нечитаемого владельца, судит возраст.
 */
function held(path: string): boolean {
  const owner = ownerOf(path);
  if (owner.pid === undefined) return fresh(path, owner);
  if (!pidAlive(owner.pid)) return false;
  if (owner.command === undefined) return fresh(path, owner);
  return sameCommand({ ...owner, command: owner.command });
}

/**
 * Is an update running, asked without taking anything. For the processes that only
 * launch one - the bridge behind /update - so that the updater it starts is the
 * single owner of the lock, rather than inheriting one nobody will release.
 */
export function updateRunning(dataDir: string): boolean {
  const path = join(dataDir, LOCK);
  return existsSync(path) && held(path);
}

function ownerContents(path: string): string | null {
  try {
    return readFileSync(join(path, "owner.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Serialize updates with mkdir; reclaim an abandoned owner by rename and compare.
 * An ownerless mkdir has a short publication grace, checked again after rename.
 * A third contender can claim the empty path before a fresh owner's directory is
 * restored; a legacy contender still removes by path. These residual windows are
 * witnesses in UpdateLock.tla and tracked in docs/tech-debt.md.
 */
export function acquireUpdateLock(dataDir: string): UpdateLock | null {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, LOCK);
  const claim = (): UpdateLock => {
    mkdirSync(path);
    return own(path);
  };
  try {
    return claim();
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code !== "EEXIST") throw caught;
  }
  let expected: string | null;
  try {
    expected = ownerContents(path);
  } catch {
    return null;
  }
  if (expected === null ? fresh(path, {}, OWNER_PUBLICATION_MS) : held(path))
    return null;
  const stale = join(dataDir, `${STALE_LOCK_PREFIX}${randomUUID()}`);
  try {
    renameSync(path, stale);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let unchanged = false;
  try {
    unchanged =
      ownerContents(stale) === expected &&
      (expected !== null || !fresh(stale, {}, OWNER_PUBLICATION_MS));
  } catch (error) {
    console.error(`cannot verify moved update lock ${stale}: ${String(error)}`);
  }
  if (!unchanged) {
    try {
      renameSync(stale, path);
    } catch (error) {
      console.error(
        `update lock owner changed; kept ${stale}: ${String(error)}`,
      );
    }
    return null;
  }
  rmSync(stale, { recursive: true, force: true });
  try {
    return claim();
  } catch {
    return null;
  }
}
