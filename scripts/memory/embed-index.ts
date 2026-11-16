// Строит сайдкар-индекс эмбеддингов для hybrid-поиска: vault/.index/embeddings.json.
// Запускается вручную или ночным brain.ts (только при MEMORY_SEARCH_MODE=hybrid).
//   node --env-file-if-exists=.env scripts/memory/embed-index.ts
//
// Эмбеддит карточки/саммари через один внешний ключ (Jina/DeepInfra, см. agent/lib/embeddings.ts),
// пишет { model, vectors: { "<vault-rel-path>": number[] } }. Локальной модели/RAM нет.
// Индекс — производный, не в vault (markdown остаётся портируемым); потерялся — пересобери.
// Текст карточки берём из agent/lib/card-index.ts — там же его берут BM25-колонки
// memory_search: в hybrid обе половины обязаны индексировать ОДНО и то же.
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  mkdirSync,
  renameSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  embedTexts,
  embeddingModelName,
  embeddingProviderName,
  hasEmbeddingKey,
} from "../../agent/lib/embeddings.ts";
import { embedText } from "../../agent/lib/card-index.ts";
import { gitEnv } from "../../agent/lib/vault-commit.ts";
import { vaultDirOrExit } from "../lib/vault-boundary.ts";
import { vaultMarkdownFiles } from "../../packages/vault-walk/index.ts";

let vaultCache: string | null = null;
// Лениво: неверная настройка вольта всплывает на первом использовании, где её ловит
// граница процесса — одна строка причины и код 1, а не стек на импорте модуля.
const VAULT = (): string => (vaultCache ??= vaultDirOrExit());
const SCOPE = ["cards", "summaries", "weekly", "monthly", "yearly"];

// `.index/` — производный кэш, в ночной бэкап vault ему не место. Шаблон .gitignore
// закрывает новые vault; установленные до правила закрывает сам писатель: строка в
// .git/info/exclude читается check-ignore так же, как .gitignore владельца, но его
// файл не трогается и в бэкап не уезжает. Уже закоммиченный кэш ignore не вытеснит —
// снимаем с учёта: файл остаётся на диске, а в историю и remote он больше не пишется.
// Любой отказ — строка в журнал, ночь не роняется.
function keepIndexOutOfBackup(vault: string): void {
  const git = (args: readonly string[]) =>
    spawnSync("git", [...args], {
      cwd: vault,
      encoding: "utf8",
      env: gitEnv(),
    });
  const excludeAt = git(["rev-parse", "--git-path", "info/exclude"]);
  if (excludeAt.status !== 0) return; // vault не репозиторий — и бэкапа нет
  try {
    const file = resolve(vault, excludeAt.stdout.trim());
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {
      /* exclude ещё нет */
    }
    const present = new Set(current.split("\n").map((line) => line.trim()));
    if (!present.has(".index") && !present.has(".index/")) {
      const next = `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}.index/\n`;
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, next, "utf8");
      renameSync(tmp, file);
    }
  } catch (error) {
    console.error(
      `embed-index: не смог исключить .index из бэкапа: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Попавший под git кэш снимается с учёта; staged-удаление от прошлой неудачи — коммитим.
  if (
    git(["ls-files", "-z", "--", ".index"]).stdout !== "" &&
    git(["rm", "-r", "--cached", "--quiet", "--", ".index"]).status !== 0
  )
    return;
  // Коммитим всё застейдженное — но только если застейджено ровно удаление `.index`:
  // чужой застейдженный набор (Obsidian-git, руки владельца) в наш коммит не попадает.
  const staged = git(["diff", "--cached", "--name-only", "-z"]).stdout;
  const ours = staged.split("\0").filter((path) => path !== "");
  if (
    ours.length === 0 ||
    !ours.every((path) => path === ".index" || path.startsWith(".index/"))
  )
    return;
  const message = "brain: untrack derived .index cache";
  if (git(["commit", "--quiet", "-m", message]).status === 0) return;
  const retried = git([
    "-c",
    "user.name=Iva",
    "-c",
    "user.email=iva@localhost",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
  if (retried.status !== 0)
    console.error(
      `embed-index: не смог снять .index с учёта: ${(retried.stderr || retried.stdout || "git commit failed").trim().split("\n")[0]}`,
    );
}

keepIndexOutOfBackup(VAULT());

if (!hasEmbeddingKey()) {
  console.error(
    "embed-index: no JINA_API_KEY / DEEPINFRA_API_KEY — nothing to build (base mode uses BM25).",
  );
  process.exit(0);
}

// Ночь проверяет свой вывод на необработанный ENOENT, поэтому причина идёт без префикса
// "Error:" и без стека.
function unreadable(dir: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`embed-index: не смог прочитать каталог (${dir}): ${detail}`);
}

const files: string[] = [];
for (const d of SCOPE) {
  const abs = join(VAULT(), d);
  try {
    if (statSync(abs).isDirectory())
      files.push(...vaultMarkdownFiles(abs, { onUnreadable: unreadable }));
  } catch {
    /* нет директории */
  }
}

if (files.length === 0) {
  console.error("embed-index: no cards/summaries found — nothing to embed.");
  process.exit(0);
}

// Форма индекса на диске. `model`/`count`/`vectors` — как было (memory_search читает
// только vectors). Добавлены `embedModel` и `hashes`: по ним видно, какие карточки уже
// посчитаны ЭТОЙ моделью и не изменились с прошлой ночи. Индекс без этих полей (собранный
// прежней версией) просто считается несовпавшим — тогда ночь пересчитает всё один раз.
interface EmbedIndex {
  model: string;
  embedModel: string;
  count: number;
  vectors: Record<string, number[]>;
  hashes: Record<string, string>;
}

const INDEX_PATH = join(VAULT(), ".index", "embeddings.json");

function loadPrevious(): EmbedIndex | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const prev = parsed as Partial<EmbedIndex>;
    // Векторы разных моделей несравнимы — сменился провайдер или модель, старое не годится.
    if (
      prev.model !== embeddingProviderName() ||
      prev.embedModel !== embeddingModelName()
    )
      return null;
    if (
      typeof prev.vectors !== "object" ||
      prev.vectors === null ||
      typeof prev.hashes !== "object" ||
      prev.hashes === null
    )
      return null;
    return prev as EmbedIndex;
  } catch {
    return null; // нет файла или он битый — считаем с нуля
  }
}

const previous = loadPrevious();
const index: EmbedIndex = {
  model: embeddingProviderName(),
  embedModel: embeddingModelName(),
  count: files.length,
  vectors: {},
  hashes: {},
};

// Что реально надо посчитать: карточка новая либо её текст изменился. Ключ — хэш ТЕКСТА,
// который уходит в эмбеддинг, а не mtime: `git pull` и ночной Brain переставляют mtime и
// на неизменившихся файлах, а платим мы за вызов модели.
const pending: Array<{ path: string; text: string }> = [];
for (const file of files) {
  const path = relative(VAULT(), file).split(sep).join("/");
  const text = embedText(file, readFileSync(file, "utf8"));
  // Битая карточка не останавливает ночной индекс: её пропускают с именем в журнале.
  if (text === null) continue;
  const hash = createHash("sha1").update(text).digest("hex");
  index.hashes[path] = hash;
  const reusable =
    previous && previous.hashes[path] === hash && previous.vectors[path];
  // Записи удалённых карточек не переносятся: индекс собирается из нынешнего списка файлов.
  if (reusable) index.vectors[path] = reusable;
  else pending.push({ path, text });
}

console.log(
  `embed-index: ${files.length} docs via ${embeddingProviderName()}, ` +
    `${pending.length} to embed, ${files.length - pending.length} reused …`,
);

if (pending.length) {
  const vectors = await embedTexts(pending.map((item) => item.text));
  pending.forEach((item, i) => {
    if (vectors[i]) index.vectors[item.path] = vectors[i];
    else delete index.hashes[item.path]; // не посчиталось — не помечаем как готовое
  });
}

// Запись через tmp+rename: оборванная посреди записи ночь не должна оставить обрезанный
// JSON вместо рабочего индекса (ADR-0002 — данные не теряются).
mkdirSync(join(VAULT(), ".index"), { recursive: true });
const tmp = `${INDEX_PATH}.tmp`;
writeFileSync(tmp, JSON.stringify(index), "utf8");
renameSync(tmp, INDEX_PATH);
console.log(
  `embed-index: wrote ${Object.keys(index.vectors).length} vectors → ${VAULT()}/.index/embeddings.json`,
);
process.exit(0);
