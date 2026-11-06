// Память под git: одна успешная правка = один локальный коммит разрешённых git путей в
// репозитории vault. Новые ignored файлы остаются на диске, шов называет их вне бэкапа.
// Единственный шов, через который писатели памяти (write_card,
// write_file, ночной Rollup) оставляют след в истории; `git add -A` ночного Brain
// остаётся подметальщиком и подбирает то, что коммит сделать не смог.
//
// Замок индекса git общий на весь репозиторий, поэтому коммиты этого процесса идут по
// одному, а чужой (ночной) коммит пережидается коротким ожиданием. Замок индекса,
// брошенный убитым коммитом, опознаётся по возрасту - как замки расписаний и карточек -
// и снимается: иначе ни одна следующая правка, ни Brain больше не коммитятся.
//
// Ни один отказ здесь не роняет ход: файл уже записан, причина уходит в журнал одной
// строкой. Без remote локальные коммиты есть; push остаётся делом ночного Brain.
//
// Git зовётся своим окружением (см. gitEnv) и с литеральными путями: и то и другое - граница
// репозитория, а не удобство. Чужой GIT_DIR уводит коммит в чужую историю, а имя файла с `*`
// без литерального пути становится глобом и забирает в коммит файлы владельца.
//
// Обновлятор берёт этот модуль динамическим импортом: он обязан грузиться на установке без
// агентского дерева (scripts/authored-tree-guard.test.ts), а сам шов не ищет vault - его
// называет вызывающий, который свой vault уже разрешил.
import { execFile } from "node:child_process";
import { lstatSync, realpathSync, rmSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  readNightSettings,
  nightSettingsFile,
  setNightSetting,
  nightRaised,
  nightSaveFailed,
  type NightNotice,
} from "./memory-night-constants.ts";

/** Сколько ждать освобождения индекса: сосед коммитит за десятки миллисекунд. */
const INDEX_WAIT_MS = [60, 120, 240, 480];
/** Запас после потолка времени git: сосед мог поднять срок только в памяти. */
const INDEX_LOCK_GRACE_MS = 15_000;
const INDEX_LOCK = "index.lock";
export const vaultGitNotices: NightNotice[] = [];
export let vaultGitCeiling:
  { value: number; raises: number; atMax: boolean } | undefined;
const gitRecovery = new Map<string, { raises: number; timeout: number }>();
/** В vault может не быть identity (headless VPS, свежий образ): коммитим от Ивы через
 * `-c`, конфиг владельца не трогаем. */
const IVA_IDENTITY = ["-c", "user.name=Iva", "-c", "user.email=iva@localhost"];
const REASON_CAP = 200;
const LOG_PREFIX = "[vault-commit]";
/** Бит записи индекса: файл добавлен без содержимого (`git add -N`). */
const INTENT_TO_ADD = 0x2000_0000;
/** Пустой блоб: с ним в индексе лежит и `add -N`, и честно застейдженный пустой файл. */
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const ZERO_OBJECT = "0".repeat(40);

/** Что наследуется от процесса: git ищет себя и конфиг владельца. Белый список, а не чёрный
 * список запрещённых GIT_*: чужой `GIT_DIR` (его оставляет после себя git-хук или
 * `rebase --exec`) увёл бы коммит в другой репозиторий, `GIT_INDEX_FILE` - в чужой индекс,
 * `GIT_OBJECT_DIRECTORY` - в чужую базу объектов, `GIT_CEILING_DIRECTORIES` - мимо vault. */
const GIT_ENV_KEEP =
  /^(?:PATH|HOME|TMPDIR|TMP|TEMP|USERPROFILE|SystemRoot|ComSpec|PATHEXT|LANG|LANGUAGE|TZ|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM)$|^LC_/u;

/** `GIT_LITERAL_PATHSPECS` шов ставит сам: без него имя файла с `*`, `?` или `[` становится
 * глобом и забирает в коммит соседние файлы владельца. Язык сообщений git - тоже свой: шов
 * узнаёт занятый индекс и «нечего коммитить» по английскому тексту, а на VPS с русской
 * локалью git отвечает по-русски. */
export function gitEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && GIT_ENV_KEEP.test(name)) env[name] = value;
  }
  return { ...env, GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C", LANGUAGE: "C" };
}

/** Занятый индекс - это именно `File exists`; отказ по правам печатает тот же
 * `index.lock` в тексте ошибки, и ждать секунду впустую на нём нечего. */
const INDEX_BUSY =
  /index\.lock[^\n]*File exists|Another git process seems to be running/u;
const IDENTITY_MISSING = /tell me who you are|user\.name|user\.email/iu;
const NOTHING_TO_COMMIT =
  /nothing to commit|nothing added to commit|no changes added to commit/u;
/** Строка-подсказка git: она идёт после причины, и в журнал уезжала именно она. */
const HINT_LINE = /^hint:/u;

export type VaultCommit =
  | {
      readonly ok: true;
      readonly committed: boolean;
      /** Почему коммита нет, если его не должно быть (чужой репозиторий, нечего коммитить). */
      readonly reason?: string;
      /** Пути вне бэкапа по правилам ignore владельца, относительно vault. */
      readonly skipped?: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

type GitRun = {
  /** Код выхода git; строка — отказ самого запуска (например
   * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`), он не схлопывается в «git не найден». */
  readonly code: number | string;
  readonly err: string;
  readonly out: string;
  /** Убит по таймауту: `code` при этом пуст, и без флага причина выходила ложной. */
  readonly timeout: boolean;
  readonly timeoutMs?: number;
};

function detail(run: GitRun): string {
  return `${run.err}\n${run.out}`.trim();
}

function gitOnce(
  args: readonly string[],
  cwd: string,
  timeout: number,
  input?: string,
): Promise<GitRun> {
  return new Promise((done) => {
    const child = execFile(
      "git",
      [...args],
      { cwd, env: gitEnv(), timeout, windowsHide: true },
      (error, stdout, stderr) => {
        const failed = error !== null;
        done({
          code: failed ? exitCode(error) : 0,
          err: failed ? `${stderr}${error.message}` : stderr,
          out: stdout,
          timeout: killed(error),
          timeoutMs: timeout,
        });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** Один повтор той же команды; поднятия общие для всех вызовов git этого процесса. */
async function git(
  args: readonly string[],
  cwd: string,
  input?: string,
): Promise<GitRun> {
  const file = nightSettingsFile();
  const { values } = readNightSettings(file);
  const state = gitRecovery.get(file) ?? {
    raises: 0,
    timeout: values.gitTimeoutMs,
  };
  const timeout = Math.min(
    values.maxGitTimeoutMs,
    Math.max(values.gitTimeoutMs, state.timeout),
  );
  const first = await gitOnce(args, cwd, timeout, input);
  if (!first.timeout) return first;
  if (
    timeout >= values.maxGitTimeoutMs ||
    state.raises >= values.raisesPerNight
  ) {
    vaultGitCeiling = {
      value: timeout,
      raises: state.raises,
      atMax: timeout >= values.maxGitTimeoutMs,
    };
    return first;
  }
  state.raises++;
  state.timeout = Math.min(values.maxGitTimeoutMs, timeout * 2);
  gitRecovery.set(file, state);
  const raised = nightRaised("gitTimeoutMs", timeout, state.timeout);
  vaultGitNotices.push(raised);
  console.error(`${LOG_PREFIX} ${raised[1]}`);
  const retryTimeout = state.timeout;
  try {
    setNightSetting("gitTimeoutMs", retryTimeout, file);
    state.timeout = 0;
  } catch {
    const failed = nightSaveFailed("gitTimeoutMs");
    vaultGitNotices.push(failed);
    console.error(`${LOG_PREFIX} ${failed[1]}`);
  }
  const retried = await gitOnce(args, cwd, retryTimeout, input);
  if (
    retried.timeout &&
    (retryTimeout >= values.maxGitTimeoutMs ||
      state.raises >= values.raisesPerNight)
  )
    vaultGitCeiling = {
      value: retryTimeout,
      raises: state.raises,
      atMax: retryTimeout >= values.maxGitTimeoutMs,
    };
  return retried;
}

/** Убитый по таймауту процесс приходит с пустым кодом и `killed`. */
function killed(error: unknown): boolean {
  return (error as { killed?: unknown } | null)?.killed === true;
}

/** 127 у отсутствующего в PATH git (`ENOENT` спавна): код выхода и «команды нет» - разные
 * причины; прочий строковый код Node (буфер, сигнал) остаётся строкой. */
function exitCode(error: unknown): number | string {
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return 127;
  return typeof code === "number" || typeof code === "string" ? code : 127;
}

/** Причина отказа одной строкой: git печатает причину первой, а подсказку (`hint:`) после
 * неё, поэтому берём первую строку, которая не подсказка. */
function reasonOf(run: GitRun): string {
  if (run.timeout)
    return `git не ответил за ${String(run.timeoutMs! / 1000)} с`;
  if (run.code === 127) return "git не найден в PATH";
  const lines = detail(run)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !HINT_LINE.test(line));
  // Строковый код раннера (буфер, сигнал) — сам код и первая строка, что git успел сказать.
  const reason =
    typeof run.code === "string"
      ? `${run.code}: ${lines[0] ?? ""}`
      : (lines[0] ?? `git вышел с кодом ${String(run.code)}`);
  return reason.slice(0, REASON_CAP);
}

const sleep = (ms: number) =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/** Брошенный замок индекса снимаем, живой не трогаем. Возврат: что-то сняли. */
function clearStaleIndexLock(vault: string): boolean {
  const lock = join(vault, ".git", INDEX_LOCK);
  try {
    const staleAfter =
      readNightSettings().values.maxGitTimeoutMs + INDEX_LOCK_GRACE_MS;
    if (Date.now() - statSync(lock).mtimeMs < staleAfter) return false;
  } catch {
    return false;
  }
  try {
    rmSync(lock, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Занятый индекс - не отказ правки: короткое ожидание, снятие огрызка, повтор. */
async function withIndexRetry(
  vault: string,
  run: () => Promise<GitRun>,
): Promise<GitRun> {
  let result = await run();
  if (result.code === 0 || !INDEX_BUSY.test(detail(result))) return result;
  if (clearStaleIndexLock(vault)) result = await run();
  for (const wait of INDEX_WAIT_MS) {
    if (result.code === 0 || !INDEX_BUSY.test(detail(result))) return result;
    await sleep(wait);
    result = await run();
  }
  return result;
}

/** Коммит от Ивы, если в vault нет identity владельца. Пути названы и здесь: коммит без
 * pathspec забирает весь индекс, а индекс в vault общий с владельцем. */
async function commitWith(
  vault: string,
  message: string,
  paths: readonly string[],
): Promise<GitRun> {
  const plain = await git(
    ["commit", "-q", "-m", message, "--", ...paths],
    vault,
  );
  if (plain.code === 0 || !IDENTITY_MISSING.test(detail(plain))) return plain;
  return git(
    [...IVA_IDENTITY, "commit", "-q", "-m", message, "--", ...paths],
    vault,
  );
}

function realOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Удалением считаем только доказанно отсутствующий путь. lstat видит и оборванную
 * ссылку: git rm --cached с файлом на диске — выбор владельца, не удаление файла. */
function absent(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) === undefined;
  } catch {
    return false;
  }
}

/** Путь в виде, который понимает `git add`, или null - путь вне vault. Удалённый файл и
 * оборванная ссылка реального пути не имеют: берём реальный путь каталога и имя как есть.
 * Иначе vault за символической ссылкой (`/var` на macOS) терял такой путь молча: корень
 * vault уже реальный, а путь файла ещё нет. Каталога тоже нет - путь берём как есть. */
function vaultPath(vault: string, path: string): string | null {
  const full = resolve(path);
  const parent = realOf(dirname(full));
  const real =
    realOf(full) ?? (parent === null ? full : join(parent, basename(full)));
  const rel = relative(vault, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel;
}

type RepoCheck =
  { readonly kind: "own" } | { readonly kind: "skip"; readonly reason: string };

/** Положительный ответ про свой репозиторий не меняется: он уже есть вокруг vault. Кэш снимает
 * спавн `rev-parse` с каждой записи. Отрицательный ответ не кэшируется - репозиторий вокруг
 * каталога может появиться позже (`git init` в vault, `init-vault`). */
const ownRepositories = new Set<string>();

/** Свой ли это репозиторий: шов коммитит только в vault, иначе память легла бы в историю
 * репозитория кода, который двигает обновлятор. Отказ git называет себя сам, а найденный
 * корень выше vault называем как есть: он не обязательно чужой, но коммитить в него нельзя. */
async function checkRepository(vault: string): Promise<RepoCheck> {
  if (ownRepositories.has(vault)) return { kind: "own" };
  const run = await git(["rev-parse", "--show-toplevel"], vault);
  if (run.code !== 0) return { kind: "skip", reason: reasonOf(run) };
  const root = run.out.trim();
  const owner = realOf(root) ?? root;
  if (owner === vault) {
    ownRepositories.add(vault);
    return { kind: "own" };
  }
  return { kind: "skip", reason: `репозиторий выше vault: ${owner}` };
}

/** Запись индекса по нашему пути в снимке: что вернуть, если коммит не состоялся. */
type IndexEntry = {
  readonly intentToAdd: boolean;
  /** Строка `ls-files -s -z` целиком: её же понимает `update-index --index-info`. */
  readonly record: string;
};

/** Помета «добавлено без содержимого» видна только в флагах записи индекса: в снимке её надо
 * сохранить, иначе после неудачного коммита чужой `git add -N` превращается в застейдженный
 * пустой файл и следующий коммит уносит его пустым. */
async function markedIntentToAdd(
  vault: string,
  path: string,
): Promise<boolean> {
  const run = await git(["ls-files", "--debug", "--", path], vault);
  const flags = /flags: ([0-9a-f]+)/u.exec(run.out)?.[1];
  return (
    flags !== undefined && (Number.parseInt(flags, 16) & INTENT_TO_ADD) !== 0
  );
}

/** Записи индекса по нашим путям до `git add`, или null - индекс прочитать не удалось. Без
 * снимка лучше не трогать индекс вовсе, чем вернуть его наугад. */
async function indexEntries(
  vault: string,
  paths: readonly string[],
): Promise<Map<string, IndexEntry> | null> {
  const run = await git(["ls-files", "-s", "-z", "--", ...paths], vault);
  if (run.code !== 0) return null;
  const entries = new Map<string, IndexEntry>();
  for (const record of run.out.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab <= 0) continue;
    const path = record.slice(tab + 1);
    const object = record.slice(0, tab).split(" ")[1];
    const empty =
      object === EMPTY_BLOB && (await markedIntentToAdd(vault, path));
    entries.set(path, { intentToAdd: empty, record });
  }
  return entries;
}

/** Вернуть индекс по нашим путям как было: одной пачкой, снимком записей. Чужой индекс (другие
 * пути) не трогаем - он не наш; путь, которого в снимке не было, снимается нулевым режимом, а
 * стадии конфликта слияния возвращаются тем же форматом, в каком лежали. */
async function restoreIndex(
  vault: string,
  paths: readonly string[],
  before: ReadonlyMap<string, IndexEntry>,
): Promise<void> {
  const payload: string[] = [];
  const intent: string[] = [];
  for (const path of paths) {
    const entry = before.get(path);
    // Помета «без содержимого» снимается вместе с записью: `git add -N` поверх уже
    // застейдженного файла - это no-op, поэтому сначала убираем нашу запись, потом ставим
    // помету заново.
    if (entry !== undefined && !entry.intentToAdd)
      payload.push(`${entry.record}\0`);
    else {
      payload.push(`0 ${ZERO_OBJECT}\t${path}\0`);
      if (entry !== undefined) intent.push(path);
    }
  }
  if (payload.length > 0)
    await git(["update-index", "-z", "--index-info"], vault, payload.join(""));
  for (const path of intent) await git(["add", "-N", "-f", "--", path], vault);
}

function vaultRoot(root: string): string | null {
  try {
    return realpathSync(root);
  } catch {
    return null;
  }
}

/** Коммиты этого процесса идут по одному: два параллельных `git add` одного хода бились
 * бы за общий индекс, а он принадлежит всему репозиторию. */
let commitQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const queued = commitQueue.then(task, task);
  commitQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

async function commitPaths(
  vault: string,
  message: string,
  paths: readonly string[],
): Promise<VaultCommit> {
  const repo = await checkRepository(vault);
  if (repo.kind === "skip")
    return { ok: true, committed: false, reason: repo.reason };
  const before = await indexEntries(vault, paths);
  if (before === null)
    return { ok: false, reason: "не удалось прочитать индекс vault" };
  // Ignore исключает только новые файлы. Уже взятый под git файл остаётся в истории,
  // даже если владелец позже исключил его родительский каталог (git 2.52 отказывает
  // обычному add такого пути). -f получает только точные пути, уже лежащие в индексе.
  const deleted = await git(
    [
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=D",
      "-z",
      "--",
      ...paths,
    ],
    vault,
  );
  if (deleted.code !== 0) return { ok: false, reason: reasonOf(deleted) };
  const removed = new Set(deleted.out.split("\0").filter(Boolean));
  const tracked = paths.filter((path) => before.has(path));
  const deletions = paths.filter(
    (path) => removed.has(path) && absent(join(vault, path)),
  );
  const deleting = new Set(deletions);
  const untracked = paths.filter(
    (path) => !before.has(path) && !deleting.has(path),
  );
  // check-ignore читает имена, не pathspec: эта команда не поддерживает
  // GIT_LITERAL_PATHSPECS. NUL-stdin сохраняет переводы строк и имена с глобами.
  const ignored = untracked.length
    ? await git(
        ["--no-literal-pathspecs", "check-ignore", "-z", "--stdin"],
        vault,
        `${untracked.join("\0")}\0`,
      )
    : { code: 1, out: "", err: "", timeout: false };
  if (ignored.code !== 0 && ignored.code !== 1)
    return { ok: false, reason: reasonOf(ignored) };
  const skipped = ignored.out.split("\0").filter(Boolean);
  const excluded = new Set(skipped);
  const included = untracked.filter((path) => !excluded.has(path));
  const accepted = [...tracked, ...deletions, ...included];
  if (!accepted.length) return { ok: true, committed: false, skipped };
  let staged: GitRun = { code: 0, err: "", out: "", timeout: false };
  // Уже застейдженное удаление не надо добавлять повторно: записи в индексе больше
  // нет, add отказывает, а commit -- <путь> законно коммитит само удаление.
  for (const [force, batch] of [
    [true, tracked],
    [false, included],
  ] as const) {
    if (!batch.length) continue;
    staged = await withIndexRetry(vault, () =>
      git(["add", ...(force ? ["-f"] : []), "--", ...batch], vault),
    );
    if (staged.code !== 0) break;
  }
  if (staged.code !== 0) {
    // `git add` стейджит часть путей до отказа (игнорируемый путь, пропавший путь), поэтому
    // индекс возвращается и здесь, а не только на отказе коммита.
    await restoreIndex(vault, accepted, before);
    return { ok: false, reason: reasonOf(staged) };
  }
  const committed = await withIndexRetry(vault, () =>
    commitWith(vault, message, accepted),
  );
  if (committed.code === 0)
    return {
      ok: true,
      committed: true,
      ...(skipped.length ? { skipped } : {}),
    };
  // Коммит не состоялся (hook, отказ git): бросок не должен остаться в индексе, иначе его
  // подметёт чужой коммит или следующий наш.
  await restoreIndex(vault, accepted, before);
  // Правка не изменила ни одного байта - коммитить нечего, и это не отказ.
  if (NOTHING_TO_COMMIT.test(detail(committed)))
    return {
      ok: true,
      committed: false,
      ...(skipped.length ? { skipped } : {}),
    };
  return { ok: false, reason: reasonOf(committed) };
}

/**
 * Закоммитить правку памяти: сообщение вида `card <slug>: UPDATE`, `file <путь>: write`
 * и пути, которые эта правка затронула. Пути вне vault молча пропускаются, отказ git
 * уходит в журнал одной строкой и никогда не роняет ход. `root` - тот vault, о котором
 * идёт речь: шов его не угадывает, а получает от вызывающего, который уже знает свой.
 */
export async function commitVaultWrite(
  message: string,
  paths: readonly string[],
  root: string,
): Promise<VaultCommit> {
  const vault = vaultRoot(root);
  const rel =
    vault === null
      ? []
      : paths
          .map((path) => vaultPath(vault, path))
          .filter((path): path is string => path !== null);
  if (vault === null || rel.length === 0) return { ok: true, committed: false };
  const outcome = await serialized(() => commitPaths(vault, message, rel));
  if (outcome.reason !== undefined)
    console.error(`${LOG_PREFIX} ${message}: ${outcome.reason}`);
  if (outcome.ok && outcome.skipped?.length)
    console.error(
      `${LOG_PREFIX} ${message}: вне git-бэкапа по ignore: ${JSON.stringify(outcome.skipped)}`,
    );
  return outcome;
}

/** HEAD vault тем же раннером (таймаут, окружение, разбор отказа). Отказ — исключение. */
export async function vaultHead(root: string): Promise<string> {
  const run = await git(["rev-parse", "HEAD"], root);
  if (run.code !== 0) throw new Error(`${root}: ${reasonOf(run)}`);
  return run.out.trim();
}

/** Текст пути в коммите vault; null — пути в этом коммите нет. Предназначено для обычного
 * blob: тип записи не проверяется, каталог, gitlink и symlink функция не различает (ls-tree их
 * перечислит, show отдаст что есть). «Нет пути» решает не текст
 * stderr (при пропавшем объекте коммита `git show` печатает ту же фразу), а `ls-tree`: код 0 и
 * пустой вывод — пути нет; код 0 и строка — путь есть, дальше `show`, и любой его отказ (битый
 * блоб, таймаут, переполнение буфера раннера) — исключение; код ≠ 0 (битая ревизия, пропавший
 * объект коммита) — исключение. В пустоту память не откатывается. */
export async function vaultShow(
  root: string,
  sha: string,
  path: string,
): Promise<string | null> {
  const entry = await git(["ls-tree", sha, "--", path], root);
  if (entry.code !== 0)
    throw new Error(`git ls-tree ${sha} -- ${path}: ${reasonOf(entry)}`);
  if (entry.out.trim() === "") return null;
  const run = await git(["show", `${sha}:${path}`], root);
  if (run.code !== 0)
    throw new Error(`git show ${sha}:${path}: ${reasonOf(run)}`);
  return run.out;
}

/** Ночной подметальщик: закоммитить всё незакоммиченное в vault - днём это делают писатели, а
 * он подбирает то, что осталось. Механизм тот же, что у правки: свой репозиторий, своё
 * окружение, пути литералами. */
export async function commitVaultSweep(
  message: string,
  root: string,
): Promise<VaultCommit> {
  try {
    const paths = await changedVaultPaths(root, true);
    if (paths.length === 0) return { ok: true, committed: false };
    return await commitVaultWrite(message, paths, root);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Снимок «до» и результат «после» чужой работы над vault: чистку карточек делает не
 * агент, а чужой процесс (обновлятор ждёт её, меню узнаёт о конце ходом раннера), поэтому
 * шов отдаёт две половины пары, а не оборачивает работу. Обе половины называют только
 * затронутые пути и не роняют вызвавшего; имена коммитов собираются здесь, чтобы у обоих
 * потребителей они были одной формы. */
export interface VaultWritePair {
  readonly after: () => Promise<void>;
  readonly before: () => Promise<void>;
}

export function vaultWritePair(label: string, root: string): VaultWritePair {
  const commit = async (what: string): Promise<void> => {
    const paths = await changedVaultPaths(root);
    if (paths.length > 0)
      await commitVaultWrite(`${label}: vault ${what}`, paths, root);
  };
  return { after: () => commit("cleanup"), before: () => commit("snapshot") };
}

/** Записи-статуса git без кавычек: с `-z` пути идут как есть, переименование несёт два. */
function statusPaths(output: string): string[] {
  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[1] === "R") index += 1;
  }
  return paths;
}

/** Незакоммиченные пути vault: паре нужен снимок «до» и результат работы, а `add -A` в шве
 * запрещён - коммит обязан называть свои пути. */
async function changedVaultPaths(
  root: string,
  strict = false,
): Promise<string[]> {
  const vault = vaultRoot(root);
  if (vault === null) return [];
  const run = await git(["status", "--porcelain", "-z", "-uall"], vault);
  if (run.code !== 0) {
    if (strict) throw new Error(reasonOf(run));
    return [];
  }
  return statusPaths(run.out).map((path) => join(vault, path));
}
