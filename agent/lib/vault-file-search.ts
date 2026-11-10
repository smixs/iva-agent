import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveVaultDir } from "@iva/vault-dir";
import { TECHNICAL_DIRS } from "../../packages/vault-walk/index.ts";

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.split(sep).join("/");
  let expression = "";
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        expression += "(?:.*)";
        index++;
        if (normalized[index + 1] === "/") index++;
      } else {
        expression += "[^/]*";
      }
    } else if (char === "?") {
      expression += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(char)) {
      expression += `\\${char}`;
    } else {
      expression += char;
    }
  }
  return new RegExp(`^${expression}$`);
}

// Относительный путь тулов чтения (read_file, grep, glob) считается от корня vault, а
// write_file и bash — от корня проекта. Модель путает контракты и подаёт `vault/daily/x.md`,
// который от корня vault становится vault/vault/daily/x.md → ENOENT (#199, #242). Если
// такого пути в vault нет, а тот же путь от рабочего каталога указывает ВНУТРЬ vault,
// берём его: оба прочтения ведут в один vault, настоящий vault/vault/ по-прежнему первичен.
export function resolveVaultToolPath(path: string): string {
  if (isAbsolute(path)) return path;
  const vault = resolveVaultDir(process.cwd());
  const fromVault = resolve(vault, path);
  if (existsSync(fromVault)) return fromVault;
  const fromCwd = resolve(process.cwd(), path);
  const inside = relative(vault, fromCwd);
  const withinVault =
    inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
  return withinVault && existsSync(fromCwd) ? fromCwd : fromVault;
}

export function resolveVaultToolRoot(path?: string): string {
  return path === undefined
    ? resolveVaultDir(process.cwd())
    : resolveVaultToolPath(path);
}

// Граница одного вызова grep и glob: 29.09.2026 на c1 grep по /home/user обходил дом 4,5
// минуты, ход сняли по тишине через 180 с. 20 000 файлов — в 5,6 раза больше vault владельца
// (3537 файлов, grep по нему за 1 с). Граница достигнута — отдаём найденное с подсказкой.
const WALK_MAX_FILES = 20_000;
const WALK_TIME_MS = 20_000;
export const WALK_HINT =
  "просмотрены не все файлы: путь слишком широк, сузь путь или шаблон";

export type WalkBound = ReturnType<typeof walkBound>;

export function walkBound(signal?: AbortSignal, maxFiles = WALK_MAX_FILES) {
  const deadline = Date.now() + WALK_TIME_MS;
  return { deadline, maxFiles, signal, truncated: false };
}

// Срок вышел или ход снят (ctx.abortSignal eve): обход неполон.
function outOfTime(bound: WalkBound): boolean {
  const over = bound.signal?.aborted === true || Date.now() >= bound.deadline;
  if (over) bound.truncated = true;
  return over;
}

// Каталог, ещё не пройденный по реальному пути (цикл симлинков), или null.
async function unvisitedEntries(dir: string, visited: Set<string>) {
  try {
    const canonical = await realpath(dir);
    if (visited.has(canonical)) return null;
    visited.add(canonical);
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function* walk(
  dir: string,
  visited: Set<string>,
  bound: WalkBound,
): AsyncGenerator<string> {
  for (const entry of (await unvisitedEntries(dir, visited)) ?? []) {
    if (outOfTime(bound)) return;
    const full = join(dir, entry.name);
    // Симлинк судим по цели; битый пропускаем.
    const info = entry.isSymbolicLink()
      ? await stat(full).catch(() => null)
      : entry;
    if (info?.isFile()) yield full;
    else if (info?.isDirectory() && !skippedDir(entry.name))
      yield* walk(full, visited, bound);
  }
}

function skippedDir(name: string): boolean {
  return TECHNICAL_DIRS.has(name) || name.includes(".trash-");
}

// Файлы по одному, пока граница не достигнута: работа потребителя между ними (чтение grep)
// идёт в тот же срок.
export async function* eachFile(
  root: string,
  bound: WalkBound,
): AsyncGenerator<string> {
  let seen = 0;
  for await (const file of walk(root, new Set(), bound)) {
    if (seen++ === bound.maxFiles) {
      bound.truncated = true;
      return;
    }
    yield file;
  }
}

export async function walkFiles(
  root: string,
  bound = walkBound(),
): Promise<string[]> {
  const files: string[] = [];
  for await (const file of eachFile(root, bound)) files.push(file);
  return files;
}
