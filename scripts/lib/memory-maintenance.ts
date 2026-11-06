import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { resolve } from "node:path";

// Keep headroom below GitHub's hard 100 MB blob limit so the nightly backup
// cannot create history that the remote will reject.
export const GITHUB_BLOB_GUARD_BYTES = 90 * 1024 * 1024;
export const MEMORY_REPORT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

interface GitCommandResult {
  status?: number | null;
  code?: number | null;
  stdout?: string;
  stderr?: string;
}

type FileInfo = Pick<Stats, "isFile" | "isSymbolicLink" | "size">;

export interface OversizeWorkingTreeFile {
  path: string;
  size: number;
}

interface OversizeScanOptions {
  vaultPath: string;
  runGit: (args: string[]) => GitCommandResult;
  stat?: (path: string) => FileInfo;
  limitBytes?: number;
}

type MemoryProblemKey = "fixed" | "review" | "duplicates" | "skipped_oversize";

export interface MemoryReportProblem {
  key: MemoryProblemKey;
  count: number;
}

export type MemoryMaintenanceReportResult =
  | { status: "missing" | "stale" | "invalid"; problems: [] }
  | { status: "fresh"; problems: MemoryReportProblem[] };

function commandStatus(result: GitCommandResult | null | undefined): number {
  return result?.status ?? result?.code ?? 1;
}

function firstNonEmptyLine(text: string | null | undefined): string {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export function scanOversizeWorkingTreeFiles({
  vaultPath,
  runGit,
  stat = lstatSync,
  limitBytes = GITHUB_BLOB_GUARD_BYTES,
}: OversizeScanOptions): OversizeWorkingTreeFile[] {
  const listed = runGit([
    "ls-files",
    "--others",
    "--modified",
    "--exclude-standard",
    "-z",
  ]);
  if (commandStatus(listed) !== 0) {
    const detail = firstNonEmptyLine(listed?.stderr);
    throw new Error(`git ls-files failed${detail ? `: ${detail}` : ""}`);
  }

  const paths = [
    ...new Set(
      String(listed.stdout ?? "")
        .split("\0")
        .filter(Boolean),
    ),
  ];
  const oversized: OversizeWorkingTreeFile[] = [];
  for (const path of paths) {
    let info;
    try {
      info = stat(resolve(vaultPath, path));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue; // deleted between git listing and stat
      throw error;
    }
    // lstat measures the blob stored for a symlink, not the file it points outside the vault to.
    if (!info.isFile() && !info.isSymbolicLink()) continue;
    if (info.size > limitBytes) oversized.push({ path, size: info.size });
  }
  return oversized;
}

// Карточки и MOC пишутся «временный файл рядом + rename». Убитый сигналом писатель
// оставляет такой файл на диске, а ночь делает `git add -A` — огрызок уехал бы в историю
// vault как настоящая карточка. Шаблонный vault-template/.gitignore до живых вольтов не
// доезжает: init-vault копирует его только в ПУСТОЙ каталог, а проблема есть на каждой
// установке. Поэтому строчки досылает сама ночь, перед git add.
// Два шаблона, потому что писателей два: python (tempfile.mkstemp → tmpXXXX.tmp) и
// TypeScript (agent/lib/fs-atomic.ts → <файл>.tmp-<pid>-<uuid>).
const TMP_IGNORE_PATTERNS = ["*.tmp", "*.tmp-*"] as const;
const TMP_IGNORE_HEADER =
  "# unfinished atomic writes (temp files of an interrupted writer)";

/**
 * Дописывает в `.gitignore` вольта шаблоны временных файлов, если их там нет.
 * Только ДОПИСЫВАЕТ: чужой .gitignore не перезаписывается и ни одна его строка не
 * удаляется (ADR-0002 — файл пользовательский). Возвращает true, если что-то дописано.
 */
export function ensureVaultGitignore(vaultPath: string): boolean {
  const file = resolve(vaultPath, ".gitignore");
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch (error) {
    // Только ENOENT значит «файла нет». Нечитаемый .gitignore (EACCES/EIO) не
    // перезаписываем: иначе правила владельца исчезают молча, а ночной git add -A
    // их уже не видит. ENOENT — файла нет, остальное — ошибка.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT") {
      console.error(
        `[memory] vault .gitignore is unreadable (${String(code)}); left untouched`,
      );
      return false;
    }
  }
  const present = new Set(current.split("\n").map((line) => line.trim()));
  const missing = TMP_IGNORE_PATTERNS.filter(
    (pattern) => !present.has(pattern),
  );
  if (missing.length === 0) return false;

  const separator =
    current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  const next = `${current}${separator}${TMP_IGNORE_HEADER}\n${missing.join("\n")}\n`;
  // Через tmp+rename: оборванная дозапись не имеет права оставить от .gitignore огрызок.
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    return false;
  }
}

export function memoryReportProblems(report: unknown): MemoryReportProblem[] {
  if (!report || typeof report !== "object" || Array.isArray(report)) return [];
  const fields = report as Record<string, unknown>;
  const keys: readonly MemoryProblemKey[] = [
    "fixed",
    "review",
    "duplicates",
    "skipped_oversize",
  ];
  return keys.flatMap((key) => {
    const count = fields[key];
    return typeof count === "number" && Number.isFinite(count) && count !== 0
      ? [{ key, count }]
      : [];
  });
}

export function readMemoryMaintenanceReport(
  reportPath: string,
  {
    now = Date.now(),
    maxAgeMs = MEMORY_REPORT_MAX_AGE_MS,
  }: {
    now?: number;
    maxAgeMs?: number;
  } = {},
): MemoryMaintenanceReportResult {
  if (!existsSync(reportPath)) return { status: "missing", problems: [] };
  try {
    const ageMs = now - statSync(reportPath).mtimeMs;
    if (ageMs >= maxAgeMs) return { status: "stale", problems: [] };
    const report: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      return { status: "invalid", problems: [] };
    }
    return { status: "fresh", problems: memoryReportProblems(report) };
  } catch {
    return { status: "invalid", problems: [] };
  }
}

export function recordSkippedOversize(
  reportPath: string,
  count: number,
): boolean {
  if (!existsSync(reportPath)) return false;
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return false;
  }
  if (!report || typeof report !== "object" || Array.isArray(report))
    return false;
  const fields = report as Record<string, unknown>;

  const tmp = `${reportPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(
      tmp,
      `${JSON.stringify({ ...fields, skipped_oversize: count }, null, 2)}\n`,
      "utf8",
    );
    chmodSync(tmp, statSync(reportPath).mode & 0o777);
    renameSync(tmp, reportPath);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort: preserve the report update failure */
    }
    return false;
  }
}
