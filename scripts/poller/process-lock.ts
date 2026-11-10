import { lockCommand as platformLockCommand } from "#lib/lock-command.ts";
import { randomUUID } from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncReturns,
} from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "#lib/fs-atomic.ts";

const OWNER_SCHEMA = "iva-telegram-poll-owner/v2";
const HOLDER_SCHEMA = "iva-telegram-poll-holder/v2";
const HOLDER_MARKER_PREFIX = "iva-telegram-poll-holder-v2=";
const PROCESS_START_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-3]?[0-9] [0-2][0-9]:[0-5][0-9]:[0-6][0-9] [0-9]{4}$/u;
const HOLDER_READY = "IVA_TELEGRAM_LOCKED\n";
const HOLDER_SOURCE =
  `process.stdout.write(${JSON.stringify(HOLDER_READY)});` +
  "process.stdin.resume();" +
  "process.stdin.on('end',()=>process.exit(0));" +
  "process.stdin.on('error',()=>process.exit(0));";

const processUid = typeof process.getuid === "function" ? process.getuid() : 0;
export const TELEGRAM_PROCESS_RESOURCE = `telegram:${processUid}`;
export const TELEGRAM_PROCESS_GUARD_BASE = join(
  "/tmp",
  `iva-telegram-poll-${processUid}`,
);

export type TelegramProcessOwner = {
  schema: typeof OWNER_SCHEMA;
  pid: number;
  processStart: string;
  nonce: string;
};

export type TelegramProcessLease = {
  owner: TelegramProcessOwner;
  resource: string;
  guardRoot: string;
  lockFile: string;
  guardOwnerFile: string;
  holderPid: number;
  close(): Promise<void>;
};

export type TelegramGuardHolder = {
  schema: typeof HOLDER_SCHEMA;
  resource: string;
  pid: number;
  processStart: string;
  nonce: string;
};

type TestGuard = {
  /** Explicit isolation seam for tests; production always uses the uid resource. */
  identity: string;
  directory: string;
};

type SpawnSyncImpl = (
  command: string,
  args: readonly string[],
  options: { encoding: "utf8"; env: NodeJS.ProcessEnv },
) => SpawnSyncReturns<string>;
type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;
type LiveGuardHolder = { holderPid: number; holder: TelegramGuardHolder };

const activeLeases = new WeakSet<TelegramProcessLease>();

export function assertTelegramProcessLease(lease: TelegramProcessLease): void {
  if (!activeLeases.has(lease)) {
    throw new Error("Telegram startup requires an active process lease");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTelegramProcessOwner(raw: string): TelegramProcessOwner {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    parsed.schema !== OWNER_SCHEMA ||
    !Number.isSafeInteger(parsed.pid) ||
    (parsed.pid as number) <= 0 ||
    typeof parsed.processStart !== "string" ||
    !PROCESS_START_PATTERN.test(parsed.processStart) ||
    typeof parsed.nonce !== "string" ||
    !/^[0-9a-f]{32}$/u.test(parsed.nonce) ||
    Object.keys(parsed).length !== 4
  ) {
    throw new Error("invalid Telegram process owner schema");
  }
  return parsed as TelegramProcessOwner;
}

function validGuardResource(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (/^telegram:[0-9]+$/u.test(value) ||
      /^test:[a-z0-9][a-z0-9-]{0,63}$/u.test(value))
  );
}

export function parseTelegramGuardHolderMarker(
  marker: string,
): TelegramGuardHolder {
  if (!marker.startsWith(HOLDER_MARKER_PREFIX)) {
    throw new Error("invalid Telegram guard holder marker");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(
        marker.slice(HOLDER_MARKER_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    );
  } catch {
    throw new Error("invalid Telegram guard holder marker");
  }
  if (
    !isRecord(parsed) ||
    parsed.schema !== HOLDER_SCHEMA ||
    !validGuardResource(parsed.resource) ||
    !Number.isSafeInteger(parsed.pid) ||
    (parsed.pid as number) <= 0 ||
    typeof parsed.processStart !== "string" ||
    !PROCESS_START_PATTERN.test(parsed.processStart) ||
    typeof parsed.nonce !== "string" ||
    !/^[0-9a-f]{32}$/u.test(parsed.nonce) ||
    Object.keys(parsed).length !== 5
  ) {
    throw new Error("invalid Telegram guard holder marker");
  }
  return parsed as TelegramGuardHolder;
}

function holderMarker(holder: TelegramGuardHolder): string {
  return `${HOLDER_MARKER_PREFIX}${Buffer.from(JSON.stringify(holder)).toString("base64url")}`;
}

export function readProcessStartIdentity(
  pid: number,
  spawnSyncImpl: SpawnSyncImpl = spawnSync,
): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const result = spawnSyncImpl(
    "/bin/ps",
    ["-o", "lstart=", "-p", String(pid)],
    {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    },
  );
  if (result.error) throw result.error;
  const identity = result.stdout.trim().replace(/\s+/gu, " ");
  if (result.status !== 0) {
    if (!identity) return null;
    throw new Error(
      `/bin/ps failed while reading process ${pid}: ${result.stderr.trim()}`,
    );
  }
  if (!PROCESS_START_PATTERN.test(identity)) {
    throw new Error(`invalid process start identity for PID ${pid}`);
  }
  return identity;
}

function lockCommand(
  lockFile: string,
  node: string,
  platform: NodeJS.Platform,
  timeoutMs: number,
  marker: string,
): { command: string; args: string[] } {
  const command =
    platform === "darwin"
      ? undefined
      : ["/usr/bin/flock", "/bin/flock"].find(existsSync);
  if (platform !== "darwin" && !command)
    throw new Error("Telegram process guard requires lockf or flock");
  const lock = platformLockCommand(
    {
      file: lockFile,
      waitSeconds: Math.max(1, Math.ceil(timeoutMs / 1_000)),
      command,
    },
    platform,
  );
  return {
    command: lock.command,
    args: [
      ...lock.args,
      node,
      "--input-type=module",
      "-e",
      HOLDER_SOURCE,
      marker,
    ],
  };
}

function liveGuardHolders(
  resource: string,
  processStartImpl: (pid: number) => string | null,
  spawnSyncImpl: SpawnSyncImpl = spawnSync,
): LiveGuardHolder[] {
  const result = spawnSyncImpl(
    "/bin/ps",
    ["-axo", "pid=,ppid=,command=", "-ww"],
    {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `/bin/ps failed while reading Telegram guard holders: ${result.stderr.trim()}`,
    );
  }
  const holders: LiveGuardHolder[] = [];
  for (const line of result.stdout.split("\n")) {
    const processLine = /^\s*([0-9]+)\s+([0-9]+)\s+(.+)$/u.exec(line);
    if (!processLine) continue;
    const markerMatch = new RegExp(
      `(?:^|\\s)(${HOLDER_MARKER_PREFIX}[A-Za-z0-9_-]+)(?=\\s|$)`,
      "u",
    ).exec(processLine[3]);
    if (!markerMatch) continue;
    const holder = parseTelegramGuardHolderMarker(markerMatch[1]);
    if (holder.resource !== resource) continue;
    if (Number(processLine[2]) !== holder.pid) continue;
    if (processStartImpl(holder.pid) !== holder.processStart) continue;
    holders.push({ holderPid: Number(processLine[1]), holder });
  }
  return holders;
}

function assertNoOtherGuardHolder(
  resource: string,
  ownNonce: string | null,
  processStartImpl: (pid: number) => string | null,
  listImpl: (
    resource: string,
    processStartImpl: (pid: number) => string | null,
  ) => LiveGuardHolder[],
): void {
  const conflict = listImpl(resource, processStartImpl).find(
    ({ holder }) => holder.nonce !== ownNonce,
  );
  if (conflict) {
    throw new Error(
      `Telegram poll process lock is held by active PID ${conflict.holder.pid}`,
    );
  }
}

export function telegramProcessOwnerIsLive(
  owner: TelegramProcessOwner,
  processStartImpl: (pid: number) => string | null = readProcessStartIdentity,
): boolean {
  return processStartImpl(owner.pid) === owner.processStart;
}

async function existingGuardOwner(
  file: string,
): Promise<TelegramProcessOwner | null> {
  try {
    return parseTelegramProcessOwner(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw new Error(`cannot verify Telegram guard owner ${file}`, {
      cause: error,
    });
  }
}

async function waitForLease(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolveLease, rejectLease) => {
    let output = "";
    let errors = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectLease(error);
      else resolveLease();
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes(HOLDER_READY)) finish();
    });
    child.stderr?.on("data", (chunk: string) => {
      errors = (errors + chunk).slice(-2_000);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      finish(
        new Error(
          `Telegram poll process lock is held by another owner (code=${String(code)}, signal=${String(signal)}${errors ? `: ${errors.trim()}` : ""})`,
        ),
      );
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("timed out acquiring Telegram process lock"));
    }, timeoutMs);
  });
}

async function sameDirectory(
  logical: string,
  physical: string,
  identity: { dev: bigint; ino: bigint },
): Promise<boolean> {
  const [mapped, metadata] = await Promise.all([
    realpath(logical),
    stat(physical, { bigint: true }),
  ]);
  return (
    mapped === physical &&
    metadata.dev === identity.dev &&
    metadata.ino === identity.ino
  );
}

function guardContext(testGuard: TestGuard | undefined): {
  resource: string;
  directory: string;
} {
  if (testGuard === undefined) {
    return {
      resource: TELEGRAM_PROCESS_RESOURCE,
      directory: TELEGRAM_PROCESS_GUARD_BASE,
    };
  }
  const resource = `test:${testGuard.identity}`;
  if (!validGuardResource(resource)) {
    throw new Error("invalid test Telegram guard identity");
  }
  return { resource, directory: testGuard.directory };
}

export async function acquireTelegramProcessLock({
  testGuard,
  pid = process.pid,
  nonce = randomUUID().replaceAll("-", ""),
  platform = process.platform,
  node = process.execPath,
  timeoutMs = 5_000,
  processStartImpl = readProcessStartIdentity,
  listGuardHoldersImpl = liveGuardHolders,
  spawnImpl = spawn,
  writeOwnerImpl = (file: string, data: string) =>
    writeFileAtomic(file, data, { mode: 0o600 }),
  onLeaseLost = (error: Error) => {
    console.error("telegram-poll fatal:", error);
    process.exit(1);
  },
}: {
  testGuard?: TestGuard;
  pid?: number;
  nonce?: string;
  platform?: NodeJS.Platform;
  node?: string;
  timeoutMs?: number;
  processStartImpl?: (pid: number) => string | null;
  listGuardHoldersImpl?: (
    resource: string,
    processStartImpl: (pid: number) => string | null,
  ) => LiveGuardHolder[];
  spawnImpl?: SpawnImpl;
  writeOwnerImpl?: (file: string, data: string) => Promise<void>;
  onLeaseLost?: (error: Error) => void;
} = {}): Promise<TelegramProcessLease> {
  const { resource, directory } = guardContext(testGuard);
  const processStart = processStartImpl(pid);
  if (processStart === null) {
    throw new Error(`cannot identify Telegram poll process PID ${pid}`);
  }
  const owner = parseTelegramProcessOwner(
    JSON.stringify({ schema: OWNER_SCHEMA, pid, processStart, nonce }),
  );
  assertNoOtherGuardHolder(
    resource,
    null,
    processStartImpl,
    listGuardHoldersImpl,
  );

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const guardMetadata = await lstat(directory);
  if (
    !guardMetadata.isDirectory() ||
    (typeof process.getuid === "function" &&
      guardMetadata.uid !== process.getuid()) ||
    (guardMetadata.mode & 0o077) !== 0
  ) {
    throw new Error(
      "Telegram process guard base is not a private owned directory",
    );
  }
  const guardRoot = await realpath(directory);
  const physicalMetadata = await stat(guardRoot, { bigint: true });
  const guardIdentity = {
    dev: physicalMetadata.dev,
    ino: physicalMetadata.ino,
  };
  const lockFile = join(guardRoot, "telegram-poll.lock");
  const guardOwnerFile = join(guardRoot, "telegram-poll-owner.json");
  const holder = parseTelegramGuardHolderMarker(
    holderMarker({
      schema: HOLDER_SCHEMA,
      resource,
      pid,
      processStart,
      nonce,
    }),
  );
  const command = lockCommand(
    lockFile,
    node,
    platform,
    timeoutMs,
    holderMarker(holder),
  );
  const child = spawnImpl(command.command, command.args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childClosed = new Promise<void>((resolveClose) => {
    child.once("close", () => resolveClose());
  });
  let intentionalClose = false;
  let leaseActive = false;
  let lease: TelegramProcessLease | null = null;
  let holderExit: {
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  const holderExitError = (
    exit: { code: number | null; signal: NodeJS.Signals | null },
    phase: string,
  ) =>
    new Error(
      `Telegram process lock holder exited ${phase} (code=${String(exit.code)}, signal=${String(exit.signal)})`,
    );
  child.once("exit", (code, signal) => {
    holderExit = { code, signal };
    const wasActive = leaseActive;
    leaseActive = false;
    if (lease !== null) activeLeases.delete(lease);
    if (!intentionalClose && wasActive) {
      onLeaseLost(holderExitError(holderExit, "unexpectedly"));
    }
  });
  const close = async (): Promise<void> => {
    if (intentionalClose) return;
    intentionalClose = true;
    leaseActive = false;
    if (lease !== null) activeLeases.delete(lease);
    child.stdin?.end();
    await childClosed;
  };

  try {
    await waitForLease(child, timeoutMs + 1_000);
    if (holderExit !== null) {
      throw holderExitError(holderExit, "during acquisition");
    }
    if (child.pid === undefined) {
      throw new Error("Telegram process lock holder has no PID");
    }
    assertNoOtherGuardHolder(
      resource,
      nonce,
      processStartImpl,
      listGuardHoldersImpl,
    );
    if (!(await sameDirectory(directory, guardRoot, guardIdentity))) {
      throw new Error("Telegram process guard root changed during acquisition");
    }
    const previousOwner = await existingGuardOwner(guardOwnerFile);
    if (
      previousOwner !== null &&
      previousOwner.nonce !== nonce &&
      previousOwner.pid !== pid &&
      telegramProcessOwnerIsLive(previousOwner, processStartImpl)
    ) {
      throw new Error(
        `Telegram poll process lock is held by active PID ${previousOwner.pid}`,
      );
    }
    await writeOwnerImpl(guardOwnerFile, `${JSON.stringify(owner)}\n`);
    if (holderExit !== null) {
      throw holderExitError(holderExit, "during acquisition");
    }
    if (!(await sameDirectory(directory, guardRoot, guardIdentity))) {
      throw new Error("Telegram process guard root changed after owner write");
    }
    const publishedOwner = await existingGuardOwner(guardOwnerFile);
    if (
      publishedOwner === null ||
      JSON.stringify(publishedOwner) !== JSON.stringify(owner)
    ) {
      throw new Error("Telegram process guard owner changed after publication");
    }
    assertNoOtherGuardHolder(
      resource,
      nonce,
      processStartImpl,
      listGuardHoldersImpl,
    );
  } catch (error) {
    await close();
    throw error;
  }
  if (child.pid === undefined) {
    await close();
    throw new Error("Telegram process lock holder has no PID");
  }
  if (holderExit !== null) {
    await close();
    throw holderExitError(holderExit, "during acquisition");
  }
  lease = {
    owner,
    resource,
    guardRoot,
    lockFile,
    guardOwnerFile,
    holderPid: child.pid,
    close,
  };
  leaseActive = true;
  activeLeases.add(lease);
  return lease;
}
