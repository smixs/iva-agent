// Карантин вместо необратимого rm для reset-состояния: rename в соседний
// *.trash-<штамп> (атомарно в пределах одной ФС) с ротацией старых карантинов.
// Даёт откат после случайного reset: припаркованные сессии возвращаются обратным
// переименованием, пока карантин не вытеснен ротацией.
import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { throughLink } from "./link-target.ts";

export const TRASH_KEEP = 2;

function hasErrorCode(error: unknown, code: string): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === code;
}

function pathStat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

// file/dir → path.trash-<stamp>. Одна операция reset передаёт общий stamp; если такой
// карантин уже есть, суффикс не даёт затереть предыдущую копию.
export function quarantinePath(
  link: string,
  stamp = new Date().toISOString().replace(/[:.]/g, "-"),
): string | null {
  const path = throughLink(link);
  const stat = pathStat(path);
  if (!stat) return null;
  const base = `${path}.trash-${stamp}`;
  let dest = base;
  for (let collision = 1; pathStat(dest); collision++)
    dest = `${base}-${collision}`;

  // Права едут вместе с inode после rename. Закрываем источник заранее: при сбое chmod
  // исходник остаётся на месте, а вызывающий reset честно отмечает incomplete.
  if (stat.isDirectory()) chmodSync(path, 0o700);
  else if (stat.isFile()) chmodSync(path, 0o600);
  renameSync(path, dest);
  // Ссылка не должна повиснуть: mkdir через висящий симлинк — ENOENT, и сервис,
  // который сам создаёт свой стор при старте, после reset уже не поднимется.
  if (path !== link && stat.isDirectory())
    mkdirSync(path, { recursive: true, mode: 0o700 });
  pruneTrash(path);
  return dest;
}

// Старое имя остаётся публичным alias для существующих вызовов и тестов.
export function quarantineDir(dir: string, stamp?: string): string | null {
  return quarantinePath(dir, stamp);
}

/** Session state that an update retires before the new version starts. */
export function sessionStateTargets(root: string, dataDir: string): string[] {
  let rollupSessions: string[];
  try {
    rollupSessions = readdirSync(dataDir)
      .filter((name) => /^rollup-session-.+\.json$/u.test(name))
      .sort()
      .map((name) => join(dataDir, name));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    rollupSessions = [];
  }
  return [
    join(root, ".eve", ".workflow-data"),
    join(root, ".workflow-data"),
    ...rollupSessions,
  ];
}

// A record recovery or an update already marked (updatedAt 0) waits for Bridge, not
// for another quarantine: every live status write stamps Date.now().
function isInterruptedRun(parsed: unknown): parsed is Record<string, unknown> {
  const run = parsed as { status?: unknown; updatedAt?: unknown } | null;
  return run?.status === "running" && run.updatedAt !== 0;
}

function interruptedRunStatusFiles(dataDir: string): string[] {
  const dir = join(dataDir, "run-status.d");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
    .filter((file) => {
      try {
        return isInterruptedRun(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        return false;
      }
    });
}

function writeRunStatusAtomicSync(path: string, value: unknown): void {
  const parent = dirname(path);
  let temporaryPath = "";
  let fileDescriptor: number | undefined;

  for (let collision = 0; fileDescriptor === undefined; collision++) {
    temporaryPath = join(
      parent,
      `.${basename(path)}.tmp-${process.pid}-${Date.now()}-${collision}`,
    );
    try {
      fileDescriptor = openSync(temporaryPath, "wx", 0o600);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) continue;
      throw error;
    }
  }

  try {
    fchmodSync(fileDescriptor, 0o600);
    writeFileSync(fileDescriptor, JSON.stringify(value), "utf8");
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporaryPath, path);
    temporaryPath = "";
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    if (temporaryPath) rmSync(temporaryPath, { force: true });
  }
}

function nextGeneration(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value + 1
    : 1;
}

/**
 * Make only interrupted runs immediately reapable after an update clears sessions.
 * `retired` — the workflow store is gone for good (startup recovery): an interrupted
 * compaction is then simply free. An update keeps the mark instead: a rollback restores
 * the store, and the restarted writers must still see the interrupted session.
 */
export function rewriteRunStatusesForUpdate(
  dataDir: string,
  retired = false,
): number {
  let rewritten = 0;
  for (const file of interruptedRunStatusFiles(dataDir)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      // A turn Bridge finished since the scan must not be re-armed.
      if (!isInterruptedRun(parsed)) continue;
      // An interrupted compaction between turns carried no request from the owner: once
      // its session is retired the record is simply free again, with a reset tombstone.
      // Bridge has nothing to close and nothing to tell.
      const stamp = Date.now();
      writeRunStatusAtomicSync(
        file,
        retired && parsed.compacting === true
          ? {
              status: "idle",
              generation: nextGeneration(parsed.generation),
              updatedAt: stamp,
              resetAt: stamp,
            }
          : { ...parsed, status: "running", updatedAt: 0 },
      );
      rewritten++;
    } catch (error) {
      // One damaged chat record must not block the update or its healthy neighbors;
      // a record that cannot be written is named in the journal.
      if (!(error instanceof SyntaxError))
        console.error(
          `run-status ${basename(file)} not marked interrupted: ${(error as Error).message}`,
        );
    }
  }
  return rewritten;
}

/** Retire the workflow store only when the previous Iva process died mid-turn. */
export function recoverInterruptedSessionState(
  root: string,
  dataDir: string,
  stamp = new Date().toISOString().replace(/[:.]/g, "-"),
): { interrupted: number; quarantined: string[] } {
  const interrupted = interruptedRunStatusFiles(dataDir).length;
  if (interrupted === 0) return { interrupted: 0, quarantined: [] };

  const moved: Array<{ path: string; trash: string }> = [];
  try {
    for (const target of [
      join(root, ".eve", ".workflow-data"),
      join(root, ".workflow-data"),
    ]) {
      const path = throughLink(target);
      const trash = quarantinePath(target, stamp);
      if (trash) moved.push({ path, trash });
    }
  } catch (error) {
    for (const { path, trash } of moved.reverse()) {
      rmSync(path, { recursive: true, force: true });
      renameSync(trash, path);
    }
    throw error;
  }
  rewriteRunStatusesForUpdate(dataDir, true);
  return { interrupted, quarantined: moved.map(({ trash }) => trash) };
}

/** Inbound Telegram input belongs to reset, never to an update. */
export function queuedInputTargets(dataDir: string): string[] {
  return [join(dataDir, "telegram-queue.json")];
}

// Полный reset должен атомарно вывести из обращения workflow, status и очередь.
export function resetStateTargets(root: string, dataDir: string): string[] {
  return [
    ...sessionStateTargets(root, dataDir),
    join(dataDir, "run-status.d"),
    join(dataDir, "run-status.json"),
    ...queuedInputTargets(dataDir),
  ];
}

// Оставляет keep свежих карантинов path (ISO-штампы сортируются лексикографически).
export function pruneTrash(path: string, keep = TRASH_KEEP): void {
  const prefix = `${basename(path)}.trash-`;
  let names: string[];
  try {
    names = readdirSync(dirname(path))
      .filter((name) => name.startsWith(prefix))
      .sort();
  } catch {
    return;
  }
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    rmSync(join(dirname(path), name), { recursive: true, force: true });
  }
}
