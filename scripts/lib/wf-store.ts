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
import { throughLink } from "./version-layout.ts";

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

/** Make only interrupted runs immediately reapable after an update clears sessions. */
export function rewriteRunStatusesForUpdate(dataDir: string): void {
  const dir = join(dataDir, "run-status.d");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        continue;
      // An update interrupts an in-flight turn, not an idle or terminal chat. Rewriting
      // every saved record re-arms the stale-run notification after every plugin build,
      // even when the owner has sent nothing and there is no session to reset.
      if ((parsed as { status?: unknown }).status !== "running") continue;
      writeRunStatusAtomicSync(file, {
        ...parsed,
        status: "running",
        updatedAt: 0,
      });
    } catch {
      // One damaged chat record must not block the update or its healthy neighbors.
    }
  }
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
