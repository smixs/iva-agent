import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GITHUB_BLOB_GUARD_BYTES,
  ensureVaultGitignore,
  memoryReportProblems,
  readMemoryMaintenanceReport,
  recordSkippedOversize,
  scanOversizeWorkingTreeFiles,
} from "./memory-maintenance.ts";

void test("oversize scan checks modified and untracked non-ignored files before staging", () => {
  let args: string[] | undefined;
  const sizes = new Map([
    ["/vault/cards/large.md", GITHUB_BLOB_GUARD_BYTES + 1],
    ["/vault/cards/small.md", GITHUB_BLOB_GUARD_BYTES],
  ]);
  const files = scanOversizeWorkingTreeFiles({
    vaultPath: "/vault",
    runGit(nextArgs) {
      args = nextArgs;
      return {
        status: 0,
        stdout: "cards/large.md\0cards/small.md\0cards/large.md\0",
      };
    },
    stat(path) {
      return {
        isFile: () => true,
        isSymbolicLink: () => false,
        size: sizes.get(path)!,
      };
    },
  });

  assert.deepEqual(args, [
    "ls-files",
    "--others",
    "--modified",
    "--exclude-standard",
    "-z",
  ]);
  assert.deepEqual(files, [
    { path: "cards/large.md", size: GITHUB_BLOB_GUARD_BYTES + 1 },
  ]);
});

void test("oversize scan fails closed when git cannot enumerate the working tree", () => {
  assert.throws(
    () =>
      scanOversizeWorkingTreeFiles({
        vaultPath: "/vault",
        runGit: () => ({
          status: 128,
          stderr: "fatal: not a git repository\n",
        }),
      }),
    /git ls-files failed: fatal: not a git repository/,
  );
});

void test("memory report surfaces known non-zero problem counters and tolerates other shapes", () => {
  assert.deepEqual(
    memoryReportProblems({
      score: 90,
      total: 12,
      valid: 8,
      fixed: 2,
      review: 1,
      duplicates: 0,
      skipped_oversize: 3,
      future_field: { count: 99 },
    }),
    [
      { key: "fixed", count: 2 },
      { key: "review", count: 1 },
      { key: "skipped_oversize", count: 3 },
    ],
  );
  assert.deepEqual(memoryReportProblems({}), []);
  assert.deepEqual(memoryReportProblems(null), []);
});

void test("memory report freshness and oversize marker are durable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iva-memory-report-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reportPath = join(dir, "enforce-report.json");
  const now = Date.now();

  assert.deepEqual(readMemoryMaintenanceReport(reportPath, { now }), {
    status: "missing",
    problems: [],
  });

  await writeFile(reportPath, '{"review": 2}\n');
  assert.deepEqual(readMemoryMaintenanceReport(reportPath, { now }), {
    status: "fresh",
    problems: [{ key: "review", count: 2 }],
  });

  assert.equal(recordSkippedOversize(reportPath, 4), true);
  const storedReport: unknown = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(storedReport, {
    review: 2,
    skipped_oversize: 4,
  });

  const stale = new Date(now - 48 * 60 * 60 * 1000);
  await utimes(reportPath, stale, stale);
  assert.deepEqual(readMemoryMaintenanceReport(reportPath, { now }), {
    status: "stale",
    problems: [],
  });
});

// Живой vault свой .gitignore не получает: init-vault копирует шаблон только в ПУСТОЙ
// каталог. Значит шаблоны временных файлов досылает сама ночь — перед `git add -A`,
// только дозаписью и идемпотентно.
void test("the nightly gitignore step appends temp patterns without touching what is there", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iva-vault-gitignore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, ".gitignore");

  // 1. Файла нет — создаётся с обоими шаблонами.
  assert.equal(ensureVaultGitignore(root), true);
  const created = await readFile(file, "utf8");
  assert.match(created, /^\*\.tmp$/mu);
  assert.match(created, /^\*\.tmp-\*$/mu);
  assert.equal(created.startsWith("\n"), false, "без пустой первой строки");

  // 2. Идемпотентность: ещё два прогона ничего не пишут и ничего не меняют.
  for (const attempt of [1, 2]) {
    assert.equal(ensureVaultGitignore(root), false, `прогон ${attempt + 1}`);
    assert.equal(await readFile(file, "utf8"), created);
  }

  // 3. Чужой .gitignore: дописываем в конец, прежнее содержимое цело байт в байт.
  const existing = ".graph/\n.trash/\n\n# личное\nsecret-notes/\n";
  await writeFile(file, existing);
  assert.equal(ensureVaultGitignore(root), true);
  const appended = await readFile(file, "utf8");
  assert.equal(
    appended.slice(0, existing.length),
    existing,
    "прежние строки не тронуты",
  );
  assert.match(appended, /^\*\.tmp$/mu);
  assert.match(appended, /^\*\.tmp-\*$/mu);
  assert.equal(ensureVaultGitignore(root), false, "повтор — no-op");
  assert.equal(await readFile(file, "utf8"), appended);

  // 4. Файл без завершающего перевода строки не склеивается с нашим блоком.
  await writeFile(file, ".graph/");
  assert.equal(ensureVaultGitignore(root), true);
  const glued = await readFile(file, "utf8");
  assert.match(glued, /^\.graph\/$/mu);

  // 5. Частичный набор: не хватает только второго шаблона — дописывается он один.
  await writeFile(file, "*.tmp\n");
  assert.equal(ensureVaultGitignore(root), true);
  const partial = await readFile(file, "utf8");
  assert.equal(partial.match(/^\*\.tmp$/gmu)?.length, 1, "дубля не появилось");
  assert.match(partial, /^\*\.tmp-\*$/mu);
});

// То же самое, но настоящим git'ом и настоящими именами временных файлов обоих
// писателей: после шага ночи `git add -A` не забирает огрызки, но забирает карточки.
void test("after the nightly step git add -A skips temp leftovers in a live vault", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iva-vault-gitadd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  await mkdir(join(root, "cards"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".graph/\n");
  for (const name of [
    "cards/tmpjsxhjx4o.tmp",
    "cards/ivan.md.tmp-23940-c9d1d4da-9f4c-477f-ac92-7972aedd15ea",
    "cards/ivan.md",
    "MOC.md",
  ])
    await writeFile(join(root, name), "x\n");

  ensureVaultGitignore(root);
  git("add", "-A");
  const staged = git("diff", "--cached", "--name-only")
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(staged, [".gitignore", "MOC.md", "cards/ivan.md"]);
});
