import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  join,
  posix,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import {
  isAuthoredPath,
  instructionSlotCollision,
  isInstructionSlotPath,
  isLivePath,
} from "./authored-paths.ts";

export { isAuthoredPath };

const CUSTOM_SCHEMA = "iva-custom/v1" as const;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
// Слоты, которые слой забирает из рабочего дерева и кладёт в сборку. Скиллов здесь нет:
// их читает с диска резолвер agent/skills/custom.ts, и второй путь к тем же файлам был бы
// задвоением (docs/extending.md). Остальные слоты — код, ему сборка нужна.
// Слот agent/instructions/ наполняется только из data/custom: правка встроенного файла в
// checkout остаётся обычным локальным патчем, а не заменой слота.
const AUTHORED_PATHSPECS = [
  "agent/instructions.md",
  "agent/connections",
  "agent/tools",
  "agent/subagents",
] as const;

// Деревья исходников, из которых собран рантайм. Список один и живёт здесь: модуль
// одного дерева импортирует соседнее (`agent/lib/data-dir.ts` → `packages/data-dir`),
// и снапшот, потерявший такое дерево, даёт [UNRESOLVED_IMPORT] на первом же старте
// сервиса. Полноту списка держит страж в scripts/authored-tree-guard.test.ts.
export const RUNTIME_SOURCE_TREES = ["agent", "scripts", "packages"] as const;

const ConflictSchema = z.strictObject({
  localSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  recoveryDir: z.string().min(1),
});

const EntrySchema = z.strictObject({
  originSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  localSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  baseBlob: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  tombstone: z.boolean(),
  conflict: ConflictSchema.optional(),
});

const ManifestSchema = z.strictObject({
  schema: z.literal(CUSTOM_SCHEMA),
  updatedAt: z.string(),
  entries: z.record(z.string(), EntrySchema),
});

export type CustomManifest = z.infer<typeof ManifestSchema>;
export type MaterializedCustomLayer = {
  readonly dataDir: string;
  readonly pendingDir: string;
  readonly manifest: CustomManifest;
  readonly conflicts: string[];
  readonly recoveryDir: string | null;
  readonly runtimeRoot: string;
};

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function emptyManifest(): CustomManifest {
  return {
    schema: CUSTOM_SCHEMA,
    updatedAt: new Date(0).toISOString(),
    entries: {},
  };
}

function customRoot(dataDir: string): string {
  return join(dataDir, "custom");
}

function safeChild(base: string, relative: string): string {
  const basePath = resolve(base);
  const target = resolve(base, relative);
  if (target !== basePath && !target.startsWith(`${basePath}${sep}`))
    throw new Error(`unsafe customization path: ${relative}`);
  return target;
}

function writePrivateFile(path: string, contents: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeManifest(dataDir: string, manifest: CustomManifest): void {
  const root = customRoot(dataDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const path = join(root, "manifest.json");
  const temp = join(root, `.manifest-${randomUUID()}.tmp`);
  writePrivateFile(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

export function readCustomManifest(dataDir: string): CustomManifest {
  const path = join(customRoot(dataDir), "manifest.json");
  if (!existsSync(path)) return emptyManifest();
  if (!lstatSync(path).isFile())
    throw new Error("custom manifest must be a regular file");
  return ManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function gitBuffer(root: string, args: readonly string[]): Buffer | null {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout ?? "");
}

function gitText(root: string, args: readonly string[]): string | null {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout : null;
}

function revisionFile(
  root: string,
  revision: string,
  path: string,
): Buffer | null {
  return gitBuffer(root, ["show", `${revision}:${path}`]);
}

function nulPaths(value: string | null): string[] {
  return (value ?? "")
    .split("\0")
    .filter((path) => path.length > 0 && isAuthoredPath(path));
}

function storeBaseBlob(
  dataDir: string,
  contents: Buffer | null,
): string | null {
  if (contents === null) return null;
  const hash = sha256(contents);
  const path = join(customRoot(dataDir), "bases", hash);
  if (!existsSync(path)) writePrivateFile(path, contents);
  return hash;
}

function canonicalPath(dataDir: string, path: string): string {
  if (!isAuthoredPath(path)) throw new Error(`not an authored path: ${path}`);
  return safeChild(customRoot(dataDir), path);
}

function setCanonicalFile(
  dataDir: string,
  path: string,
  contents: Buffer | null,
): void {
  const target = canonicalPath(dataDir, path);
  if (contents === null) {
    rmSync(target, { force: true });
    return;
  }
  writePrivateFile(target, contents);
}

function canonicalFiles(dataDir: string): string[] {
  const agentRoot = join(customRoot(dataDir), "agent");
  if (!existsSync(agentRoot)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`customization symlinks are not allowed: ${absolute}`);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile())
        throw new Error(`customization must be a regular file: ${absolute}`);
      const path = posix.join("agent", relativePosix(agentRoot, absolute));
      if (!isAuthoredPath(path))
        throw new Error(
          `custom directory contains a non-authored path: ${path}`,
        );
      files.push(path);
    }
  };
  visit(agentRoot);
  return files.sort();
}

function relativePosix(base: string, path: string): string {
  const basePath = resolve(base);
  const target = resolve(path);
  if (!target.startsWith(`${basePath}${sep}`))
    throw new Error("customization file is outside its canonical root");
  return target
    .slice(basePath.length + 1)
    .split(sep)
    .join("/");
}

export function captureCustomLayer({
  root,
  dataDir,
  baseRevision,
  stashRevision,
}: {
  root: string;
  dataDir: string;
  baseRevision: string;
  stashRevision?: string;
}): { paths: string[]; manifest: CustomManifest } {
  const manifest = readCustomManifest(dataDir);
  const tracked = stashRevision
    ? nulPaths(
        gitText(root, [
          "diff",
          "--name-only",
          "-z",
          baseRevision,
          stashRevision,
          "--",
          ...AUTHORED_PATHSPECS,
        ]),
      )
    : [];
  const untrackedRevision = stashRevision
    ? gitText(root, ["rev-parse", "--verify", `${stashRevision}^3`])?.trim()
    : undefined;
  const untracked = untrackedRevision
    ? nulPaths(
        gitText(root, [
          "ls-tree",
          "-r",
          "--name-only",
          "-z",
          untrackedRevision,
          "--",
          ...AUTHORED_PATHSPECS,
        ]),
      )
    : [];
  const trackedSet = new Set(tracked);
  const paths = [...new Set([...tracked, ...untracked])].sort();

  for (const path of paths) {
    const previousConflict = manifest.entries[path]?.conflict;
    const base = revisionFile(root, baseRevision, path);
    const local = revisionFile(
      root,
      trackedSet.has(path) ? (stashRevision ?? "") : (untrackedRevision ?? ""),
      path,
    );
    const baseBlob = storeBaseBlob(dataDir, base);
    setCanonicalFile(dataDir, path, local);
    manifest.entries[path] = {
      originSha256: base === null ? null : sha256(base),
      localSha256: local === null ? null : sha256(local),
      baseBlob,
      tombstone: local === null,
      ...(previousConflict ? { conflict: previousConflict } : {}),
    };
  }

  for (const path of canonicalFiles(dataDir)) {
    if (manifest.entries[path]) continue;
    const base = revisionFile(root, baseRevision, path);
    if (isInstructionSlotPath(path) && base !== null)
      throw instructionSlotCollision(path);
    const local = readOptional(canonicalPath(dataDir, path));
    if (local === null) continue;
    manifest.entries[path] = {
      originSha256: base === null ? null : sha256(base),
      localSha256: sha256(local),
      baseBlob: storeBaseBlob(dataDir, base),
      tombstone: false,
    };
  }

  for (const [path, entry] of Object.entries(manifest.entries)) {
    if (!isAuthoredPath(path))
      throw new Error(`manifest contains a non-authored path: ${path}`);
    if (paths.includes(path)) continue;
    const pathOnDisk = canonicalPath(dataDir, path);
    if (existsSync(pathOnDisk)) {
      const contents = readFileSync(pathOnDisk);
      entry.localSha256 = sha256(contents);
      entry.tombstone = false;
    } else {
      entry.localSha256 = null;
      entry.tombstone = true;
    }
  }

  manifest.updatedAt = new Date().toISOString();
  writeManifest(dataDir, manifest);
  return { paths, manifest };
}

function readOptional(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile())
    throw new Error(`customization path is not a regular file: ${path}`);
  return readFileSync(path);
}

function equalContents(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function isText(contents: Buffer): boolean {
  return !contents.includes(0);
}

function mergeText(
  pendingDir: string,
  local: Buffer,
  base: Buffer,
  upstream: Buffer,
): Buffer | null {
  const mergeDir = mkdtempSync(join(pendingDir, ".merge-"));
  try {
    const localPath = join(mergeDir, "local");
    const basePath = join(mergeDir, "base");
    const upstreamPath = join(mergeDir, "upstream");
    writeFileSync(localPath, local);
    writeFileSync(basePath, base);
    writeFileSync(upstreamPath, upstream);
    const result = spawnSync(
      "git",
      ["merge-file", "-p", localPath, basePath, upstreamPath],
      {
        cwd: mergeDir,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: GIT_MAX_BUFFER,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) return null;
    return Buffer.isBuffer(result.stdout)
      ? result.stdout
      : Buffer.from(result.stdout ?? "");
  } finally {
    rmSync(mergeDir, { recursive: true, force: true });
  }
}

function applyToTree(
  root: string,
  path: string,
  contents: Buffer | null,
): void {
  if (!isAuthoredPath(path)) throw new Error(`not an authored path: ${path}`);
  const target = safeChild(root, path);
  if (contents === null) {
    rmSync(target, { force: true });
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function archiveConflictSide(
  recoveryDir: string,
  side: "base" | "local" | "upstream",
  path: string,
  contents: Buffer | null,
): void {
  if (contents === null) return;
  writePrivateFile(safeChild(join(recoveryDir, side), path), contents);
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function materializeCustomLayer({
  root,
  dataDir,
  targetRevision,
  now = new Date(),
}: {
  root: string;
  dataDir: string;
  targetRevision: string;
  now?: Date;
}): MaterializedCustomLayer {
  const current = readCustomManifest(dataDir);
  const manifest = ManifestSchema.parse(structuredClone(current));
  const custom = customRoot(dataDir);
  mkdirSync(custom, { recursive: true, mode: 0o700 });
  // Оборванный materialize (краш/сигнал между материализацией и commit/discard)
  // оставляет .pending-<random> в custom/ навсегда: следующий запуск создаёт новый,
  // а старый не метёт. Материализация на одном data-dir сериализована сборкой или
  // обновлением, поэтому сметаем всё незакоммиченное до создания своего каталога.
  for (const entry of readdirSync(custom, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(".pending-")) continue;
    rmSync(join(custom, entry.name), { recursive: true, force: true });
  }
  // Слот не может занять имя встроенного файла, приехавшего релизом позже; проверка стоит
  // до .pending-, чтобы отказ не оставлял мусора рядом с каноническими файлами.
  for (const [path, entry] of Object.entries(manifest.entries)) {
    if (!isInstructionSlotPath(path) || entry.tombstone) continue;
    if (readOptional(safeChild(root, path)) !== null)
      throw instructionSlotCollision(path);
  }
  const pendingDir = mkdtempSync(join(custom, ".pending-"));
  const currentAgent = join(custom, "agent");
  const pendingAgent = join(pendingDir, "agent");
  if (existsSync(currentAgent))
    cpSync(currentAgent, pendingAgent, {
      recursive: true,
      preserveTimestamps: true,
    });

  const conflicts: string[] = [];
  let recoveryDir: string | null = null;
  for (const path of Object.keys(manifest.entries).sort()) {
    if (!isAuthoredPath(path))
      throw new Error(`manifest contains a non-authored path: ${path}`);
    const entry = manifest.entries[path];
    if (!entry) continue;
    // У файла слота нет апстрим-предка: он целиком принадлежит владельцу. Убрал или
    // переименовал - хранить нечего, запись уходит из манифеста. Иначе одноимённый файл
    // апстрима материализовался бы как «файл владельца» и следующая сборка упала бы на
    // коллизии, которую владелец уже разрешил.
    if (
      isInstructionSlotPath(path) &&
      entry.tombstone &&
      entry.baseBlob === null
    ) {
      delete manifest.entries[path];
      continue;
    }
    const base = entry.baseBlob
      ? readOptional(join(custom, "bases", entry.baseBlob))
      : null;
    if (entry.baseBlob && base === null)
      throw new Error(`missing customization base blob: ${entry.baseBlob}`);
    const sourcePath = canonicalPath(dataDir, path);
    const local = entry.tombstone ? null : readOptional(sourcePath);
    if (!entry.tombstone && local === null)
      throw new Error(`customization source is missing: ${path}`);
    const upstream = readOptional(safeChild(root, path));
    const localHash = local === null ? null : sha256(local);
    const unresolved =
      entry.conflict !== undefined && entry.conflict.localSha256 === localHash;
    let materialized: Buffer | null = upstream;
    let conflict = false;

    if (!unresolved) {
      const localChanged = !equalContents(local, base);
      const upstreamChanged = !equalContents(upstream, base);
      if (!localChanged) {
        materialized = upstream;
      } else if (!upstreamChanged || equalContents(local, upstream)) {
        materialized = local;
      } else if (
        local !== null &&
        base !== null &&
        upstream !== null &&
        isText(local) &&
        isText(base) &&
        isText(upstream)
      ) {
        const merged = mergeText(pendingDir, local, base, upstream);
        if (merged === null) conflict = true;
        else materialized = merged;
      } else {
        conflict = true;
      }
    }

    const upstreamBlob = storeBaseBlob(dataDir, upstream);
    entry.originSha256 = upstream === null ? null : sha256(upstream);
    entry.baseBlob = upstreamBlob;

    if (unresolved) {
      recoveryDir ??= entry.conflict?.recoveryDir ?? null;
      entry.localSha256 = localHash;
      entry.tombstone = local === null;
      conflicts.push(path);
      continue;
    }

    if (conflict) {
      recoveryDir ??= join(
        dataDir,
        "update-conflicts",
        `${timestamp(now)}-custom-${targetRevision.slice(0, 12)}`,
      );
      mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
      archiveConflictSide(recoveryDir, "base", path, base);
      archiveConflictSide(recoveryDir, "local", path, local);
      archiveConflictSide(recoveryDir, "upstream", path, upstream);
      entry.localSha256 = localHash;
      entry.tombstone = local === null;
      entry.conflict = { localSha256: localHash, recoveryDir };
      conflicts.push(path);
      continue;
    }

    // Скилл в дерево не кладём — его отдаёт резолвер прямо из data/custom. Так же
    // markdown-правила владельца: их читает с диска agent/instructions/30-owner-rules.ts.
    // Правило одно с версией (isLivePath). Скиллы остаются файлами пользователя и
    // переживают обновление. Исключение одно: удаление встроенного скилла. Динамика
    // умеет перекрыть одноимённый скилл, но не убрать его, поэтому tombstone
    // по-прежнему правит дерево.
    if (!isLivePath(path) || materialized === null)
      applyToTree(root, path, materialized);
    const pendingPath = safeChild(pendingDir, path);
    if (materialized === null) rmSync(pendingPath, { force: true });
    else writePrivateFile(pendingPath, materialized);
    entry.localSha256 = materialized === null ? null : sha256(materialized);
    entry.tombstone = materialized === null;
    if (!unresolved) delete entry.conflict;
  }

  manifest.updatedAt = now.toISOString();
  writePrivateFile(
    join(pendingDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (recoveryDir) {
    writePrivateFile(
      join(recoveryDir, "report.json"),
      `${JSON.stringify(
        {
          schema: "iva-update-conflicts/v1",
          createdAt: now.toISOString(),
          targetRevision,
          conflicts: conflicts.map((path) => ({ path })),
        },
        null,
        2,
      )}\n`,
    );
  }
  const runtimeDigest = createHash("sha256")
    .update("runtime-layout-v3")
    .update(targetRevision)
    .update(JSON.stringify(manifest.entries))
    .digest("hex")
    .slice(0, 16);
  const runtimes = join(custom, "runtimes");
  const runtimeRoot = join(
    runtimes,
    `${targetRevision.slice(0, 12)}-${runtimeDigest}`,
  );
  if (!existsSync(runtimeRoot)) {
    mkdirSync(runtimes, { recursive: true, mode: 0o700 });
    const stagedRuntime = mkdtempSync(join(runtimes, ".staging-"));
    try {
      // Authored agent modules import runtime helpers across tree boundaries
      // (../scripts, ../../packages). Keep that source topology intact after
      // the disposable update worktree is removed, otherwise Eve cannot bundle
      // the promoted agent on the next service start. A tree the checkout does
      // not carry (minimal fixtures, stripped archives) has nothing to copy.
      for (const tree of RUNTIME_SOURCE_TREES) {
        const source = join(root, tree);
        if (existsSync(source))
          cpSync(source, join(stagedRuntime, tree), {
            recursive: true,
            preserveTimestamps: true,
          });
      }
      renameSync(stagedRuntime, runtimeRoot);
    } catch (error) {
      rmSync(stagedRuntime, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    dataDir,
    pendingDir,
    manifest,
    conflicts,
    recoveryDir,
    runtimeRoot,
  };
}

function replaceBuffer(
  contents: Buffer,
  search: Buffer,
  replacement: Buffer,
): Buffer {
  if (search.length === 0) return contents;
  const chunks: Buffer[] = [];
  let start = 0;
  for (let index = contents.indexOf(search, start); index >= 0;) {
    chunks.push(contents.subarray(start, index), replacement);
    start = index + search.length;
    index = contents.indexOf(search, start);
  }
  if (start === 0) return contents;
  chunks.push(contents.subarray(start));
  return Buffer.concat(chunks);
}

function replaceAllBuffers(contents: Buffer, from: string, to: string): Buffer {
  const escapedFrom = Buffer.from(JSON.stringify(from).slice(1, -1));
  const escapedTo = Buffer.from(JSON.stringify(to).slice(1, -1));
  const escaped = replaceBuffer(contents, escapedFrom, escapedTo);
  return replaceBuffer(escaped, Buffer.from(from), Buffer.from(to));
}

export function rebaseBuildOutput({
  outputDir,
  buildRoot,
  appRoot,
  agentRoot,
}: {
  outputDir: string;
  buildRoot: string;
  appRoot: string;
  agentRoot?: string;
}): void {
  const buildAgent = join(buildRoot, "agent");
  const targetAgent = agentRoot
    ? join(agentRoot, "agent")
    : join(appRoot, "agent");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (![".js", ".json", ".map", ".mjs", ".txt"].includes(extname(path)))
        continue;
      const contents = readFileSync(path);
      if (!contents.includes(Buffer.from(buildRoot))) continue;
      const agentRebased = replaceAllBuffers(contents, buildAgent, targetAgent);
      const appRebased = replaceAllBuffers(agentRebased, buildRoot, appRoot);
      writeFileSync(path, appRebased);
    }
  };
  visit(outputDir);
}

export function discardCustomLayer(result: MaterializedCustomLayer): void {
  rmSync(result.pendingDir, { recursive: true, force: true });
}

export function archiveInvalidCustomLayer({
  dataDir,
  targetRevision,
  error,
  now = new Date(),
}: {
  dataDir: string;
  targetRevision: string;
  error: unknown;
  now?: Date;
}): string {
  const recoveryDir = join(
    dataDir,
    "update-conflicts",
    `${timestamp(now)}-custom-layer-invalid-${targetRevision.slice(0, 12)}`,
  );
  mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
  const manifestPath = join(customRoot(dataDir), "manifest.json");
  if (existsSync(manifestPath) && lstatSync(manifestPath).isFile())
    archiveConflictSide(
      recoveryDir,
      "local",
      "custom/manifest.json",
      readFileSync(manifestPath),
    );
  const detail = error instanceof Error ? error.message : String(error);
  writePrivateFile(
    join(recoveryDir, "report.json"),
    `${JSON.stringify(
      {
        schema: "iva-update-conflicts/v1",
        createdAt: now.toISOString(),
        targetRevision,
        reason: "custom-layer-invalid",
        detail,
        conflicts: [{ path: "custom/manifest.json" }],
      },
      null,
      2,
    )}\n`,
  );
  return recoveryDir;
}

export function commitCustomLayer(result: MaterializedCustomLayer): void {
  const custom = customRoot(result.dataDir);
  const currentAgent = join(custom, "agent");
  const pendingAgent = join(result.pendingDir, "agent");
  const backupAgent = join(custom, `.agent-backup-${randomUUID()}`);
  let backedUp = false;
  let installedPending = false;
  try {
    if (existsSync(currentAgent)) {
      renameSync(currentAgent, backupAgent);
      backedUp = true;
    }
    if (existsSync(pendingAgent)) {
      renameSync(pendingAgent, currentAgent);
      installedPending = true;
    }
    writeManifest(result.dataDir, result.manifest);
  } catch (error) {
    if (installedPending)
      rmSync(currentAgent, { recursive: true, force: true });
    if (backedUp && existsSync(backupAgent))
      renameSync(backupAgent, currentAgent);
    throw error;
  }

  try {
    rmSync(backupAgent, { recursive: true, force: true });
    rmSync(result.pendingDir, { recursive: true, force: true });
    const runtimes = join(custom, "runtimes");
    if (existsSync(runtimes)) {
      const keep = new Set(
        readdirSync(runtimes, { withFileTypes: true })
          .filter(
            (entry) =>
              entry.isDirectory() &&
              /^[0-9a-f]{12}-[0-9a-f]{16}$/.test(entry.name),
          )
          .map((entry) => ({
            name: entry.name,
            mtimeMs: statSync(join(runtimes, entry.name)).mtimeMs,
          }))
          .sort((left, right) => right.mtimeMs - left.mtimeMs)
          .slice(0, 5)
          .map(({ name }) => name),
      );
      keep.add(basename(result.runtimeRoot));
      for (const entry of readdirSync(runtimes, { withFileTypes: true }))
        if (
          entry.isDirectory() &&
          /^[0-9a-f]{12}-[0-9a-f]{16}$/.test(entry.name) &&
          !keep.has(entry.name)
        )
          rmSync(join(runtimes, entry.name), { recursive: true, force: true });
    }
    const bases = join(custom, "bases");
    if (existsSync(bases)) {
      const referenced = new Set(
        Object.values(result.manifest.entries).flatMap((entry) =>
          entry.baseBlob ? [entry.baseBlob] : [],
        ),
      );
      for (const entry of readdirSync(bases, { withFileTypes: true }))
        if (
          entry.isFile() &&
          /^[0-9a-f]{64}$/.test(entry.name) &&
          !referenced.has(entry.name)
        )
          rmSync(join(bases, entry.name), { force: true });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`custom layer cleanup deferred: ${detail}\n`);
  }
}

export function resolveCustomConflict({
  dataDir,
  path,
  side,
}: {
  dataDir: string;
  path: string;
  side: "base" | "local" | "upstream" | "edited";
}): { path: string; side: "base" | "local" | "upstream" | "edited" } {
  if (!isAuthoredPath(path)) throw new Error(`not an authored path: ${path}`);
  const manifest = readCustomManifest(dataDir);
  const entry = manifest.entries[path];
  if (!entry?.conflict) throw new Error(`no unresolved conflict for ${path}`);
  const recoveryRoot = resolve(dataDir, "update-conflicts");
  const recoveryDir = resolve(entry.conflict.recoveryDir);
  if (!recoveryDir.startsWith(`${recoveryRoot}${sep}`))
    throw new Error("customization recovery path is outside update-conflicts");
  let chosen: Buffer | null;
  if (side === "edited") {
    chosen = readOptional(canonicalPath(dataDir, path));
    const chosenHash = chosen === null ? null : sha256(chosen);
    if (chosenHash === entry.conflict.localSha256)
      throw new Error("edit the canonical customization before resolving it");
  } else {
    chosen = readOptional(safeChild(join(recoveryDir, side), path));
  }
  setCanonicalFile(dataDir, path, chosen);
  entry.localSha256 = chosen === null ? null : sha256(chosen);
  entry.tombstone = chosen === null;
  delete entry.conflict;
  manifest.updatedAt = new Date().toISOString();
  writeManifest(dataDir, manifest);
  return { path, side };
}

export function listCustomConflicts(dataDir: string): Array<{
  path: string;
  recoveryDir: string;
  tombstone: boolean;
}> {
  const manifest = readCustomManifest(dataDir);
  return Object.entries(manifest.entries)
    .flatMap(([path, entry]) =>
      entry.conflict
        ? [
            {
              path,
              recoveryDir: entry.conflict.recoveryDir,
              tombstone: entry.tombstone,
            },
          ]
        : [],
    )
    .sort((left, right) => left.path.localeCompare(right.path));
}
