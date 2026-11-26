import { stableNodeExecutable } from "./node-executable.ts";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isIvaProcess, processCommand } from "./process-command.ts";
import { createVersionStore, parseVersionName } from "./version-store.ts";

/** The one command users have on their PATH; rewritten at most once, by the bridge. */
export const SHIM_PATH = join(homedir(), ".local/bin/iva");

export type Install = {
  /** `version` - already on the immutable layout; `checkout` - still a git working tree. */
  readonly kind: "version" | "checkout";
  readonly home: string;
  /** How units and the shim must address the tree: never a collectable directory. */
  readonly root: string;
};

/** Where a path really leads, or the path itself when nothing is there yet. */
export function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Where a version directory is reachable from without naming the version. */
export function stableRoot(dir: string): string {
  const current = join(dirname(dirname(dir)), "current");
  return real(current) === real(dir) ? current : dir;
}

/** Tell an installed version apart from a plain checkout by its position on disk. */
export function classifyRoot(root: string): Install {
  const dir = real(root);
  const parent = dirname(dir);
  if (basename(parent) === "versions" && parseVersionName(basename(dir)))
    return { kind: "version", home: dirname(parent), root: stableRoot(dir) };
  return { kind: "checkout", home: dir, root: dir };
}

/** A checkout its owner marked as a working tree of their own, beside `package.json`. */
export const DEV_MARKER = ".iva-dev";

/**
 * Every version and every checkout is an installation the updater updates. One file
 * says otherwise: `.iva-dev` in the root of a checkout, which its owner writes to keep
 * `iva update` out of a tree they build themselves.
 *
 * Nothing else is read - not which shim sits on PATH, not which node it names, not how
 * many branches the tree has. Every one of those called an installation a developer's
 * checkout the first time node moved or a rollback left a `release/<v>` branch behind,
 * and that is the one state the updater exists to repair.
 */
export function isManagedInstall(install: Install): boolean {
  return (
    install.kind === "version" || !existsSync(join(install.home, DEV_MARKER))
  );
}

/**
 * Exact generated-shim grammar: the refresh replaces an existing command only when it is
 * byte-for-byte the script it would write - for whichever node that script names. The
 * node is deliberately not compared: a shim written for a node that has since moved
 * still leads into this installation, and leaving it alone is the command `iva` dying
 * the moment the checkout it pointed at becomes a version (13.09.2026).
 */
function isOwnedShim(shim: string, home: string): boolean {
  const lines = shim.split("\n");
  const exec = (line: string | undefined): string | null =>
    /^exec "([^"\\$`\r\n]+)" "\$IVA_ROOT\/bin\/iva\.mjs" "\$@"$/u.exec(
      line ?? "",
    )?.[1] ?? null;
  const data = (line: string | undefined): string | null => {
    const match = /^IVA_DATA="((?:[^"\\$`\r\n]|\\[\\"$`])*)"$/u.exec(
      line ?? "",
    );
    return match ? match[1].replace(/\\([\\"$`])/gu, "$1") : null;
  };

  // Older installations ran their checkout directly before the version bridge.
  const direct = /^exec "([^"\\$`\r\n]+)" "([^"\\$`\r\n]+)" "\$@"$/u.exec(
    lines[1] ?? "",
  );
  if (lines.length === 3 && lines[0] === "#!/usr/bin/env bash" && direct) {
    const target = direct[2];
    return (
      basename(target) === "iva.mjs" &&
      basename(dirname(target)) === "bin" &&
      real(dirname(dirname(target))) === real(home) &&
      lines[2] === ""
    );
  }

  const root = /^IVA_ROOT="([^"\\$`\r\n]+)"$/u.exec(lines[1] ?? "");
  if (!root || real(root[1]) !== real(home)) return false;
  const writtenHome = root[1];

  if (lines.length === 19) {
    const writtenData = data(lines[2]);
    const node = exec(lines[17]);
    return (
      writtenData !== null &&
      node !== null &&
      shim === shimScript(writtenHome, node, writtenData)
    );
  }

  // The previous release had no IVA_DATA snapshot and always read home/data.
  const node = exec(lines[16]);
  if (lines.length !== 18 || node === null) return false;
  const expected = shimScript(
    writtenHome,
    node,
    join(writtenHome, "data"),
  ).split("\n");
  expected.splice(2, 1);
  expected[5] = expected[5].replace(
    "$IVA_DATA/active.json",
    "$IVA_ROOT/data/active.json",
  );
  return shim === expected.join("\n");
}

type OpenShim =
  | { readonly kind: "missing" | "foreign" }
  | {
      readonly kind: "file";
      readonly fd: number;
      readonly text: string;
      readonly dev: bigint;
      readonly ino: bigint;
    };

function closeShim(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // The read proof or fully fsynced publication already defines the outcome.
  }
}

/** Open one exact regular-file entry, never a symlink target. */
function openShim(path: string): OpenShim {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "foreign" };
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) {
      closeShim(fd);
      return { kind: "foreign" };
    }
    return {
      kind: "file",
      fd,
      text: readFileSync(fd, "utf8"),
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch {
    closeShim(fd);
    return { kind: "foreign" };
  }
}

function sameOpenShim(
  path: string,
  opened: Extract<OpenShim, { kind: "file" }>,
): boolean {
  try {
    const stat = lstatSync(path, { bigint: true });
    return (
      stat.isFile() &&
      stat.nlink === 1n &&
      stat.dev === opened.dev &&
      stat.ino === opened.ino
    );
  } catch (error) {
    console.error(
      `version-layout: не смог сличить shim с открытым дескриптором (${path}): ${String(error)}`,
    );
    return false;
  }
}

type ClaimedShim = { readonly directory: string; readonly path: string };

/** Вернуть перенесённую запись на шим-путь: ссылку переименованием, файл жёсткой ссылкой. */
function putBack(previous: string, shimPath: string): void {
  if (lstatSync(previous).isSymbolicLink()) {
    // rename перезаписал бы то, что успело появиться на пути; жёсткая ссылка на симлинк
    // не везде ссылка на него самого, поэтому занятый путь - отказ, как и для файла.
    let taken = true;
    try {
      lstatSync(shimPath);
    } catch {
      taken = false;
    }
    if (taken) throw new Error(`EEXIST: ${shimPath} is taken`);
    renameSync(previous, shimPath);
    return;
  }
  linkSync(previous, shimPath);
  unlinkSync(previous);
}

function restoreClaim(claim: ClaimedShim, shimPath: string): boolean {
  try {
    putBack(claim.path, shimPath);
    rmdirSync(claim.directory);
    return true;
  } catch (error) {
    console.error(
      `version-layout: не смог вернуть shim на место (${shimPath}): ${String(error)}`,
    );
    return false;
  }
}

/** Имя каталога-заявки: pid виден снаружи, по нему убираем осиротевшие заявки. */
function claimDirectoryName(): string {
  return `.iva-shim-refresh-${process.pid}-${randomUUID()}`;
}

/** Час: заявка живёт миллисекунды, поэтому давняя не может принадлежать живому ходу. */
export const SHIM_CLAIM_TTL_MS = 60 * 60 * 1000;

/** Новый формат заявки: pid, разделитель и uuid. Старый (mkdtemp) разделителя не имеет. */
const SHIM_CLAIM_NAME =
  /^\.iva-shim-refresh-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Живой процесс? EPERM тоже значит «жив»: чужой пользователь — не смерть (QA Н3). */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Убрать каталог-заявку, не потеряв шим. Если шима на месте нет, а в заявке лежит его
 * копия (`previous`), она — единственная: сначала возвращаем шим, потом убираем каталог.
 */
function discardClaim(claim: string, shimPath: string): void {
  const previous = join(claim, "previous");
  try {
    // Файл или ссылка - что перенёс оборванный ход, то и возвращается: чужой симлинк,
    // подменивший шим между проверкой и переносом, иначе пропадал бы с PATH.
    const copy = !lstatSync(previous).isDirectory();
    let shimThere = true;
    try {
      lstatSync(shimPath);
    } catch {
      shimThere = false;
    }
    if (copy && !shimThere) putBack(previous, shimPath);
  } catch {
    // Копии нет — убираем каталог как есть.
  }
  rmSync(claim, { recursive: true, force: true });
}

/**
 * Убрать заявки оборванных обновлений шима, чужие для этого процесса.
 *
 * Новый формат (`pid-uuid`) разбирается целиком, а не `parseInt` по префиксу: старые
 * имена вида `2avFo0` читались как pid 2 и сносились сразу (QA Б2). Возраст решает
 * раньше живости: заявку старше часа убираем даже при живом pid, в том числе нашем,
 * — столько заявка не живёт, pid переиспользован. Свежую заявку живого нашего
 * процесса не трогаем, заявку мёртвого или чужого pid убираем. Старый формат без
 * разделителя судим только по возрасту.
 */
function sweepStaleShimClaims(directory: string, shimPath: string): void {
  const prefix = ".iva-shim-refresh-";
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const claim = join(directory, name);
    let age: number;
    try {
      age = now - statSync(claim).mtimeMs;
    } catch {
      continue;
    }
    const parsed = SHIM_CLAIM_NAME.exec(name);
    let remove = false;
    if (parsed) {
      const owner = Number(parsed[1]);
      if (age >= SHIM_CLAIM_TTL_MS) remove = true;
      else if (owner === process.pid)
        continue; // Своя свежая заявка: не трогаем.
      else if (!processIsAlive(owner)) remove = true;
      else if (!isIvaProcess(processCommand(owner))) remove = true;
    } else if (age >= SHIM_CLAIM_TTL_MS) {
      remove = true; // Старый формат: pid в имени нет, решает только возраст.
    }
    if (remove) discardClaim(claim, shimPath);
  }
}

/** Move the exact inspected entry aside before publishing a replacement. */
function claimOpenShim(
  shimPath: string,
  opened: Extract<OpenShim, { kind: "file" }>,
): ClaimedShim | null {
  const directory = join(dirname(shimPath), claimDirectoryName());
  mkdirSync(directory, { mode: 0o700 });
  const claim = { directory, path: join(directory, "previous") };
  try {
    renameSync(shimPath, claim.path);
  } catch (cause) {
    rmdirSync(directory);
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  if (sameOpenShim(claim.path, opened)) return claim;
  if (!restoreClaim(claim, shimPath))
    throw new Error(
      `shim ownership changed; foreign entry kept at ${claim.path}`,
    );
  return null;
}

function removeClaim(claim: ClaimedShim): void {
  unlinkSync(claim.path);
  rmdirSync(claim.directory);
}

function preserveClaim(claim: ClaimedShim, shimPath: string): string {
  const recovery = `${shimPath}.iva-recovery-${randomUUID()}`;
  try {
    renameSync(claim.directory, recovery);
    return recovery;
  } catch (cause) {
    throw new Error(
      `failed to preserve displaced shim from ${claim.path} at ${recovery}`,
      { cause },
    );
  }
}

/**
 * The git directory to ask about upstream: the mirror once one exists, and on the
 * immutable layout nothing else - git discovery climbs parents, so falling back to
 * a home without a repository answers about whatever repo `$HOME` happens to be in.
 */
export function gitRootFor(install: Install): string {
  const mirror = join(install.home, "repo");
  return install.kind === "version" || existsSync(mirror)
    ? mirror
    : install.home;
}

/**
 * What to ask about upstream from a tree the code is running out of, on either
 * layout: which repository answers, and which commit counts as installed. On the
 * immutable layout the mirror's own HEAD moves with the remote, so the running
 * version has to name its commit or the check compares upstream against itself.
 */
export function upstreamQuery(root: string): { root: string; head: string } {
  const install = classifyRoot(root);
  const active = createVersionStore(install.home).currentName();
  return {
    root: gitRootFor(install),
    head: (active && parseVersionName(active)?.sha) || "HEAD",
  };
}

/**
 * Whether `moduleUrl` is the module the process was started with. Both sides are
 * resolved: a string compare lies on macOS and below `current`.
 */
export function isEntrypoint(moduleUrl: string): boolean {
  const invoked = process.argv[1];
  return invoked ? real(invoked) === real(fileURLToPath(moduleUrl)) : false;
}

/**
 * A shim that resolves paths and nothing else, so only its owned path snapshot changes: the
 * active version, else the tree it was installed from (what a half-finished bridge
 * leaves), else the one settled on last, else the newest built - a lost `current`
 * must take neither the repair command nor the release with it, and a name sorts
 * by string, not by release. install.sh writes the same script.
 */
function shellDoubleQuoted(value: string): string {
  if (/[\0\r\n]/u.test(value))
    throw new Error("shell path contains NUL or a newline");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

export function shimScript(
  home: string,
  node: string,
  dataDir: string,
): string {
  return [
    "#!/bin/sh",
    `IVA_ROOT="${home}"`,
    `IVA_DATA=${shellDoubleQuoted(dataDir)}`,
    'if [ -f "$IVA_ROOT/current/bin/iva.mjs" ]; then',
    '  IVA_ROOT="$IVA_ROOT/current"',
    'elif [ ! -f "$IVA_ROOT/bin/iva.mjs" ]; then',
    `  settled=$(sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p' "$IVA_DATA/active.json" 2>/dev/null)`,
    '  if [ -n "$settled" ] && [ -f "$IVA_ROOT/versions/$settled/bin/iva.mjs" ]; then',
    '    IVA_ROOT="$IVA_ROOT/versions/$settled"',
    "  else",
    '    for candidate in $(ls -t "$IVA_ROOT/versions" 2>/dev/null); do',
    '      [ -f "$IVA_ROOT/versions/$candidate/bin/iva.mjs" ] || continue',
    '      IVA_ROOT="$IVA_ROOT/versions/$candidate"',
    "      break",
    "    done",
    "  fi",
    "fi",
    `exec "${node}" "$IVA_ROOT/bin/iva.mjs" "$@"`,
    "",
  ].join("\n");
}

/**
 * True when the shim path is held by something that is not a shim of ours: a symlink,
 * a hard link, an unreadable entry or a plain file of the owner's. Свободный путь и наш
 * шим (хоть под другим node) - не чужие: их обновление пишет само.
 */
export function shimIsForeign(shimPath: string, home: string): boolean {
  const opened = openShim(shimPath);
  if (opened.kind !== "file") return opened.kind === "foreign";
  try {
    return !isOwnedShim(opened.text, home);
  } finally {
    closeShim(opened.fd);
  }
}

/**
 * Симлинк на шим-пути - наш, когда он ведёт внутрь установки: его оставил прежний
 * установщик или сам владелец, и после перевода на версии он указывал бы на снесённый
 * `bin/iva.mjs` - команда `iva` умирает (шим переписывается до сноса чекаута, поэтому
 * цель ещё жива). Ссылка наружу - чужая программа, её не трогаем.
 * Возвращает текст ссылки, чтобы замена проверила, что двигает ровно её.
 */
function shimLinksIntoInstall(shimPath: string, home: string): string | null {
  let link: string;
  try {
    if (!lstatSync(shimPath).isSymbolicLink()) return null;
    link = readlinkSync(shimPath);
  } catch {
    return null;
  }
  // Только цель, которую realpath проходит целиком, судится: битый предок, цикл или
  // недоступный каталог не доказывают, куда ссылка ведёт, - такую не трогаем.
  let target: string;
  try {
    target = realpathSync(resolve(dirname(shimPath), link));
  } catch {
    return null;
  }
  const root = real(home);
  return target === root || target.startsWith(`${root}${sep}`) ? link : null;
}

/**
 * Заменить такую ссылку сгенерированным шимом тем же протоколом, что и файл: сначала
 * ссылка переезжает в каталог-заявку одним `rename`, там сверяется, что это та самая
 * ссылка (чужой файл, появившийся на пути между проверкой и заменой, уезжает обратно
 * нетронутым), и только потом шим создаётся на её месте с O_EXCL.
 */
function replaceLinkedShim(
  shimPath: string,
  link: string,
  desired: string,
): boolean {
  const directory = join(dirname(shimPath), claimDirectoryName());
  mkdirSync(directory, { mode: 0o700 });
  const claim = { directory, path: join(directory, "previous") };
  try {
    renameSync(shimPath, claim.path);
  } catch (cause) {
    rmdirSync(directory);
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
  const moved = (() => {
    try {
      return (
        lstatSync(claim.path).isSymbolicLink() &&
        readlinkSync(claim.path) === link
      );
    } catch {
      return false;
    }
  })();
  if (moved && createShimExclusive(shimPath, desired)) {
    removeClaim(claim);
    return true;
  }
  if (!restoreClaim(claim, shimPath))
    throw new Error(
      `shim ownership changed; foreign entry kept at ${claim.path}`,
    );
  return false;
}

/** Refresh an Iva-owned shim without replacing another program at the same path. */
export function refreshOwnedShim(
  shimPath: string,
  home: string,
  node: string,
  dataDir: string,
): boolean {
  const desired = shimScript(home, stableNodeExecutable(node), dataDir);
  // Заявки, оставшиеся от оборванных обновлений, убираем до всего остального: иначе
  // они копятся в ~/.local/bin навсегда.
  sweepStaleShimClaims(dirname(shimPath), shimPath);
  const opened = openShim(shimPath);
  if (opened.kind === "foreign") {
    const link = shimLinksIntoInstall(shimPath, home);
    return link !== null && replaceLinkedShim(shimPath, link, desired);
  }
  if (opened.kind === "file") {
    const claim = (() => {
      try {
        if (opened.text === desired) return null;
        if (!isOwnedShim(opened.text, home)) return null;
        if (!sameOpenShim(shimPath, opened)) return null;
        return claimOpenShim(shimPath, opened);
      } finally {
        closeShim(opened.fd);
      }
    })();
    if (!claim) return false;
    try {
      const published = createShimExclusive(shimPath, desired);
      if (published) removeClaim(claim);
      else preserveClaim(claim, shimPath);
      return published;
    } catch (cause) {
      if (!restoreClaim(claim, shimPath))
        throw new Error(`failed to restore owned shim from ${claim.path}`, {
          cause,
        });
      throw cause;
    }
  }

  mkdirSync(dirname(shimPath), { recursive: true });
  return createShimExclusive(shimPath, desired);
}

function createShimExclusive(shimPath: string, desired: string): boolean {
  let fd: number;
  try {
    fd = openSync(
      shimPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o755,
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw cause;
  }
  let created: Extract<OpenShim, { kind: "file" }> | null = null;
  try {
    const stat = fstatSync(fd, { bigint: true });
    created = {
      kind: "file" as const,
      fd,
      text: "",
      dev: stat.dev,
      ino: stat.ino,
    };
    writeAllSync(fd, desired);
    fchmodSync(fd, 0o755);
    fsyncSync(fd);
    return sameOpenShim(shimPath, created);
  } catch (cause) {
    if (created && sameOpenShim(shimPath, created)) unlinkSync(shimPath);
    throw cause;
  } finally {
    closeShim(fd);
  }
}

function writeAllSync(fd: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) throw new Error("shim write made no progress");
    offset += written;
  }
}
