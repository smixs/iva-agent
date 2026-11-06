import { defineTool } from "eve/tools";
import { z } from "zod";
import { readdir, readFile, stat } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { embedTexts, cosine, hasEmbeddingKey } from "../lib/embeddings.js";
import { cardIndex, cardTitle } from "../lib/card-index.js";
import { resolveVaultDir } from "@iva/vault-dir";
import { vaultDirErrorText } from "../lib/vault-error.ts";

// node:sqlite — встроенный модуль (Node 24+). В ESM нет глобального require, поэтому
// поднимаем его через createRequire; грузим лениво внутри bm25Search (с fallback, если нет).
const nodeRequire = createRequire(import.meta.url);

// Поиск по долговременной памяти (vault). Заменяет «сырой grep» из MAP-протокола:
// BM25-ранжирование через встроенный node:sqlite FTS5 (ноль внешних зависимостей, ноль
// нативной сборки) + бесплатный graph-реранк по готовому vault/.graph/vault-graph.json
// (его пишет autograph graph.py каждую ночь). Деградирует мягко: любой сбой движка →
// подстрочный fallback, ход НЕ падает.

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  ".cache",
  ".graph",
  ".index",
  ".trash",
]);
const DEFAULT_DIRS = ["cards", "summaries", "weekly", "monthly", "yearly"];
const MAX_SNIPPET = 240;

interface Doc {
  // КОНТРАКТ ПУТЕЙ: vault-relative, без ведущего "./" — ровно в таком виде путь уезжает
  // в hits[].file. read_file умеет резолвить такие пути от ASSISTANT_VAULT_DIR (см.
  // agent/tools/read_file.ts); менять формат в одиночку нельзя — иначе ENOENT у модели.
  path: string;
  title: string;
  meta: string; // ключевые скалярные поля фронтматтера (name/company/role/description/aliases…)
  body: string; // тело без раздела «## History»
  history: string; // раздел «## History»: ищется только с history
  tags: string;
  status: string;
  confidence: string;
  source: string;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      await walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
}

// Разобранная карточка вместе со СНИМКОМ файла, по которому её узнают в следующий раз.
interface CachedDoc {
  mtimeNs: bigint;
  size: bigint;
  doc: Doc;
}

// Кэш живёт в модуле: ход агента вызывает поиск по нескольку раз, а vault между вызовами
// обычно не меняется. Ключ — абсолютный путь файла.
const docCache = new Map<string, CachedDoc>();

// Счётчики для тестов: сколько карточек реально прочитано с диска и сколько раз собран
// FTS-индекс. Больше их никто не читает — это единственный способ отличить попадание в
// кэш от повторной работы, не меряя время.
export const cacheStats = { fileReads: 0, indexBuilds: 0 };

export interface LoadedDocs {
  docs: Doc[];
  // Отпечаток набора файлов: по нему кэшируется собранный FTS-индекс.
  signature: string;
}

export async function loadDocs(scopeDirs: string[]): Promise<LoadedDocs> {
  const vault = resolveVaultDir(process.cwd());
  // scope приходит в тул свободными строками — их пишет МОДЕЛЬ, а её может завести
  // содержимое чужого сообщения. join(vault, "../..") уводил обход за пределы vault:
  // поиск читал бы .env, ключи и чужие репозитории, а куски их строк уезжали бы модели
  // в snippet. Каждый элемент резолвим и берём только те, что лежат внутри корня;
  // остальные молча отбрасываем — тул целиком построен на мягкой деградации, и ход
  // из-за кривого scope падать не должен.
  const root = resolve(vault);
  const roots = scopeDirs
    .map((dir) => resolve(root, dir))
    .filter((abs) => abs === root || abs.startsWith(root + sep));
  const files: string[] = [];
  for (const abs of roots) {
    try {
      if ((await stat(abs)).isDirectory()) await walk(abs, files);
    } catch {
      /* нет такой директории — пропускаем */
    }
  }
  // Vault меняется и ИЗВНЕ процесса — ночной Brain пишет карточки, `git pull` подтягивает
  // чужие. Поэтому кэш опирается не на своё знание о записях, а на снимок каждого файла:
  // mtime (наносекунды — bigint, чтобы две правки в одну миллисекунду не слились) плюс
  // размер. stat — один syscall без чтения содержимого, он на порядок дешевле readFile
  // с разбором frontmatter, и перечитывается ровно та карточка, чей снимок разъехался.
  const docs: Doc[] = [];
  const seen = new Set<string>();
  const fingerprint = createHash("sha1").update(vault).update("\n");
  for (const file of files) {
    let stats;
    try {
      stats = statSync(file, { bigint: true });
    } catch {
      continue; // файл исчез между обходом и снимком
    }
    seen.add(file);
    fingerprint
      .update(file)
      .update("\n")
      .update(String(stats.mtimeNs))
      .update("\n")
      .update(String(stats.size))
      .update("\n");

    const cached = docCache.get(file);
    if (
      cached &&
      cached.mtimeNs === stats.mtimeNs &&
      cached.size === stats.size
    ) {
      docs.push(cached.doc);
      continue;
    }

    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    cacheStats.fileReads++;
    const rel = relative(vault, file).split(sep).join("/");
    // Карточку, которую владелец сломал руками, пропускаем поимённо: одна кривая
    // кавычка не имеет права отменить поиск по всем остальным.
    const indexed = cardIndex(text, rel);
    if (indexed === null) continue;
    const { fm, meta, body } = indexed;
    const parts = splitHistory(body);
    const doc: Doc = {
      path: rel,
      title: cardTitle(rel) || rel,
      meta,
      body: parts.body.slice(0, 8000),
      history: parts.history.slice(0, 8000),
      tags: fm.tags || "",
      status: (fm.status || "").toLowerCase(),
      confidence: (fm.confidence || "").toUpperCase(),
      source: fm.source || "",
    };
    docCache.set(file, { mtimeNs: stats.mtimeNs, size: stats.size, doc });
    docs.push(doc);
  }
  // Удалённая карточка не должна держать память вечно. Чистим только то, что лежит в
  // просмотренных сейчас каталогах: вызов с узким scope не обязан выбрасывать из кэша
  // карточки, на которые он просто не смотрел.
  for (const file of docCache.keys())
    if (!seen.has(file) && roots.some((dir) => file.startsWith(dir + sep)))
      docCache.delete(file);

  return { docs, signature: fingerprint.digest("hex") };
}

// Раздел «## History» (до следующего «## ») — старые строки карточки. Без history поиск
// по ним не идёт: иначе карточка находится по тому, что уже неверно.
const HISTORY_HEADING = /^##[ \t]+(?:history|история)[ \t]*$/im;

export function splitHistory(body: string): { body: string; history: string } {
  const head = HISTORY_HEADING.exec(body);
  if (!head) return { body, history: "" };
  const rest = body.slice(head.index + head[0].length);
  const next = /^## /m.exec(rest);
  const end = next ? next.index : rest.length;
  return {
    body: body.slice(0, head.index) + rest.slice(end),
    history: rest.slice(0, end),
  };
}

// ё и е — одна буква и в карточке, и в запросе: «Аксёнов» находится по «Аксенов».
export const normalizeText = (text: string): string =>
  text.toLowerCase().replaceAll("ё", "е");

// Лёгкий стеммер русского: с конца слова снимается самое длинное окончание, после которого
// остаётся основа не короче трёх букв (у трёхбуквенного слова — двух: «Ивы» → «ив»). Дальше
// основа ищется по началу, как и раньше: «Ильёй» → «иль» находит «Илья». Латиница не меняется.
const RU_ENDINGS = [
  "иями",
  "ями",
  "ами",
  "ого",
  "его",
  "ому",
  "ему",
  "ыми",
  "ими",
  "ией",
  "ием",
  "иях",
  "ая",
  "яя",
  "ое",
  "ее",
  "ие",
  "ые",
  "ий",
  "ый",
  "ой",
  "ей",
  "ем",
  "ом",
  "ам",
  "ям",
  "ах",
  "ях",
  "ую",
  "юю",
  "ым",
  "им",
  "ов",
  "ев",
  "ья",
  "ью",
  "ия",
  "ию",
  "ии",
  "а",
  "я",
  "о",
  "е",
  "и",
  "ы",
  "у",
  "ю",
  "ь",
  "й",
];

export function stemRussian(token: string): string {
  if (!/^[а-я]+$/.test(token)) return token;
  const min = token.length <= 3 ? 2 : 3;
  for (const ending of RU_ENDINGS)
    if (token.endsWith(ending) && token.length - ending.length >= min)
      return token.slice(0, -ending.length);
  return token;
}

// Слова, по которым запрос сам смотрит в прошлое карточек.
const HISTORY_WORDS = /^(?:раньше|был|была|было|были|до|истори[яиюей]*)$/;

// Токены запроса — язык-АГНОСТИЧНО: любые буквенно-цифровые последовательности (Unicode),
// уникальные. Никаких стоп-слов и порогов длины: значимость слова определяется его редкостью
// в самом вольте (IDF, см. searchMemory), а не языковыми списками. Частое слово на любом языке
// (the / с / 的 / und) само получит нулевой вес.
function queryWords(query: string): string[] {
  return normalizeText(query).match(/[\p{L}\p{N}]+/gu) || [];
}

function contentTokens(query: string): string[] {
  return [...new Set(queryWords(query).map(stemRussian))];
}

// Токены → FTS5 MATCH: каждый как префиксный терм (морфология универсальна — суффиксы русского,
// финского, турецкого; для изолирующих языков префикс = точное совпадение), объединяем через OR.
// Шум от коротких общих префиксов гасит IDF-взвешенный coverage, а не порог длины.
function toFtsQuery(tokens: string[]): string {
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

type GraphNodes = Record<string, { incoming?: string[]; outgoing?: string[] }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isGraphNodes(value: unknown): value is GraphNodes {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (node) =>
      isRecord(node) &&
      (node.incoming === undefined || isStringArray(node.incoming)) &&
      (node.outgoing === undefined || isStringArray(node.outgoing)),
  );
}

function isVectorIndex(value: unknown): value is Record<string, number[]> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (vector) =>
      Array.isArray(vector) &&
      vector.every(
        (component) =>
          typeof component === "number" && Number.isFinite(component),
      ),
  );
}

// Читаем ночной adjacency-граф (autograph graph.py). ASSISTANT_GRAPH_PATH — override для тестов.
function loadGraph(): GraphNodes {
  const path =
    process.env.ASSISTANT_GRAPH_PATH ||
    join(resolveVaultDir(process.cwd()), ".graph", "vault-graph.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return {};
    return isGraphNodes(parsed.nodes) ? parsed.nodes : {};
  } catch (error) {
    console.error(
      `[memory] не смог прочитать граф vault (${path}): ${String(error)}`,
    );
    return {};
  }
}

// Link-distance (node_distance-реранк): min число хопов от каждого узла до ближайшего якоря.
// Якоря — топ-BM25-хиты (сущности, о которых запрос). BFS по обе стороны рёбер, кап maxHops.
function bfsDistances(
  graph: GraphNodes,
  anchors: string[],
  maxHops: number,
): Map<string, number> {
  const dist = new Map<string, number>();
  let frontier: string[] = [];
  for (const a of anchors) {
    if (graph[a]) {
      dist.set(a, 0);
      frontier.push(a);
    }
  }
  for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      const n = graph[node];
      if (!n) continue;
      for (const nb of [...(n.outgoing ?? []), ...(n.incoming ?? [])]) {
        if (!dist.has(nb)) {
          dist.set(nb, hop);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

// --- Плагин: dense-слой + RRF (только MEMORY_SEARCH_MODE=hybrid) --------------------------

// Персистентный индекс эмбеддингов (сайдкар vault/.index/embeddings.json), строит embed-index.ts.
function loadEmbedIndex(): Record<string, number[]> | null {
  try {
    const raw = readFileSync(
      join(resolveVaultDir(process.cwd()), ".index", "embeddings.json"),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    return isVectorIndex(parsed.vectors) ? parsed.vectors : null;
  } catch (error) {
    console.error(
      `[memory] не смог прочитать индекс эмбеддингов: ${String(error)}`,
    );
    return null;
  }
}

// Dense-ранжирование: эмбеддинг ЗАПРОСА (1 вызов) + косинус к закэшированным векторам карточек.
async function denseRanked(
  query: string,
  docs: Doc[],
  limit: number,
  signal?: AbortSignal,
): Promise<string[] | null> {
  const index = loadEmbedIndex();
  if (!index) return null;
  const [qvec] = await embedTexts([query], { signal });
  if (!qvec) return null;
  const scored: Array<{ path: string; s: number }> = [];
  for (const doc of docs) {
    const v = index[doc.path];
    if (v) scored.push({ path: doc.path, s: cosine(qvec, v) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.path);
}

// RRF: сливаем несколько ранжированных списков по 1/(K+rank), игнорируя сырые скоры
// (BM25 unbounded, косинус [-1,1] — взвешивать нельзя, RRF снимает проблему).
function rrfFuse(lists: string[][], limit: number, K = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((path, i) =>
      score.set(path, (score.get(path) ?? 0) + 1 / (K + i)),
    );
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map((e) => e[0]);
}

function snippet(body: string, tokens: string[]): string {
  const lower = normalizeText(body);
  let at = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = at === -1 ? 0 : Math.max(0, at - 60);
  return body
    .slice(start, start + MAX_SNIPPET)
    .replace(/\s+/g, " ")
    .trim();
}

interface Hit {
  file: string;
  score: number;
  status: string;
  confidence: string;
  snippet: string;
}

// Возвращаем ПУТИ в порядке релевантности (лучший первым). Абсолютный bm25-скор для
// маленьких похожих карточек микроскопичен и нестабилен → дальше ранжируем по рангу (RRF-style),
// а не по сырому скору. Это же готовит слияние с dense-списком в плагине (RRF).

// Собранный FTS-индекс переживает вызов: пересборка с нуля на каждый запрос — это INSERT
// каждой карточки заново, самая дорогая часть поиска. Живёт ровно один индекс — на тот
// набор файлов, чей отпечаток совпал; изменился vault — прежний индекс закрывается.
// Плата — резидентная память: на вольте в 2000 карточек (≈8 МБ) кэш карточек вместе с
// индексом держат порядка 40 МБ. Раньше столько же выделялось и освобождалось на КАЖДЫЙ
// запрос; теперь память занята постоянно, но её порядок тот же.
let indexCache: {
  signature: string;
  db: import("node:sqlite").DatabaseSync;
} | null = null;

function ftsIndex(
  docs: Doc[],
  signature: string,
): import("node:sqlite").DatabaseSync {
  if (indexCache && indexCache.signature === signature) return indexCache.db;
  // node:sqlite встроен в Node 24+, грузится без флага (проверено). createRequire — т.к. ESM.
  const { DatabaseSync } = nodeRequire(
    "node:sqlite",
  ) as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE VIRTUAL TABLE d USING fts5(path UNINDEXED, title, meta, tags, body, history)",
    );
    const ins = db.prepare(
      "INSERT INTO d(path, title, meta, tags, body, history) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const doc of docs)
      ins.run(
        doc.path,
        ...[doc.title, doc.meta, doc.tags, doc.body, doc.history].map(
          normalizeText,
        ),
      );
  } catch (error) {
    // Недостроенный индекс не кэшируем и старый (рабочий) не трогаем — вызывающий уйдёт
    // в наивный поиск, а следующий вызов попробует собрать заново.
    db.close();
    throw error;
  }
  cacheStats.indexBuilds++;
  indexCache?.db.close();
  indexCache = { signature, db };
  return db;
}

// BM25 через node:sqlite FTS5. Бросает — вызывающий ловит и уходит в fallback.
function bm25Search(
  docs: Doc[],
  signature: string,
  ftsQuery: string,
  limit: number,
  history: boolean,
): string[] {
  const db = ftsIndex(docs, signature);
  const match = history ? ftsQuery : `{title meta tags body} : (${ftsQuery})`;
  // Веса колонок: title/meta важнее tags важнее body (bm25 меньше = релевантнее → ORDER BY asc).
  const rows = db
    .prepare(
      "SELECT path FROM d WHERE d MATCH ? ORDER BY bm25(d, 5.0, 5.0, 2.0, 1.0) LIMIT ?",
    )
    .all(match, limit * 4) as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

// Текст карточки для подстрочных проверок — тот же, что видит FTS при этом history.
function haystack(doc: Doc, history: boolean): string {
  return normalizeText(
    [doc.title, doc.meta, doc.tags, doc.body, history ? doc.history : ""].join(
      " ",
    ),
  );
}

// Fallback без sqlite: частота токенов, порядок по убыванию (грубо, но ход не падает).
function naiveSearch(
  docs: Doc[],
  tokens: string[],
  history: boolean,
): string[] {
  const scored: Array<{ path: string; s: number }> = [];
  for (const doc of docs) {
    const hay = haystack(doc, history);
    let s = 0;
    for (const t of tokens) {
      let idx = hay.indexOf(t);
      while (idx !== -1) {
        s += normalizeText(doc.title).includes(t) ? 3 : 1;
        idx = hay.indexOf(t, idx + t.length);
      }
    }
    if (s > 0) scored.push({ path: doc.path, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.path);
}

// Потолок запроса: цена поиска растёт с числом уникальных слов (каждый токен проходит по
// всем карточкам), и запрос в 100 000 токенов держал ход 14-25 с. Отказ явный — модель
// разобьёт запрос сама; тихое усечение молча меняло бы ответ на другой вопрос.
const MAX_QUERY_TOKENS = 64;
const MAX_QUERY_CHARS = 4000;

// Ответ тула: считается один раз, чтобы отказ и результат не разъезжались по форме.
type MemoryAnswer = {
  count: number;
  engine?: string;
  hits: Hit[];
  note?: string;
  ok?: boolean;
  error?: string;
};

function rejectLongQuery(detail: string): MemoryAnswer {
  return {
    count: 0,
    engine: "rejected",
    hits: [],
    note:
      `Запрос слишком длинный (${detail}): потолок ${MAX_QUERY_TOKENS} слов и ` +
      `${MAX_QUERY_CHARS} знаков — разбей запрос на несколько коротких`,
  };
}

// Потолки судятся до чтения вольта: отказ обязан быть дешёвым.
function tokenizeQuery(
  query: string,
): { tokens: string[] } | { rejected: MemoryAnswer } {
  if (query.length > MAX_QUERY_CHARS)
    return { rejected: rejectLongQuery(`${query.length} знаков`) };
  const tokens = contentTokens(query);
  if (tokens.length > MAX_QUERY_TOKENS)
    return { rejected: rejectLongQuery(`${tokens.length} слов`) };
  return { tokens };
}

// BM25 (FTS5) → пути в порядке релевантности, с мягкой деградацией в наивный поиск.
function rankByBm25(
  docs: Doc[],
  signature: string,
  tokens: string[],
  topN: number,
  history: boolean,
): { ranked: string[]; engine: string } {
  try {
    const ftsQuery = toFtsQuery(tokens);
    const ranked = ftsQuery
      ? bm25Search(docs, signature, ftsQuery, topN, history)
      : [];
    if (ranked.length > 0) return { ranked, engine: "bm25" };
    return {
      ranked: naiveSearch(docs, tokens, history),
      engine: "naive-empty-bm25",
    };
  } catch (error) {
    console.error(`[memory] BM25 упал, ищу наивно: ${String(error)}`);
    return {
      ranked: naiveSearch(docs, tokens, history),
      engine: "naive-fallback",
    };
  }
}

// Плагин: hybrid = BM25 ⊕ dense через RRF. Только при MEMORY_SEARCH_MODE=hybrid и наличии
// ключа/индекса. Любой сбой (нет ключа/индекса, сеть, отмена хода) → тихо остаёмся на чистом BM25.
async function mergeDense(
  ranked: string[],
  engine: string,
  input: { query: string; docs: Doc[]; topN: number; signal?: AbortSignal },
): Promise<{ ranked: string[]; engine: string }> {
  if (process.env.MEMORY_SEARCH_MODE !== "hybrid" || !hasEmbeddingKey())
    return { ranked, engine };
  try {
    const dense = await denseRanked(
      input.query,
      input.docs,
      input.topN * 4,
      input.signal,
    );
    if (!dense || dense.length === 0) return { ranked, engine };
    return {
      ranked: rrfFuse([ranked, dense], input.topN * 4),
      engine: "hybrid-rrf",
    };
  } catch {
    return { ranked, engine }; // fallback на BM25 — engine остаётся как есть
  }
}

// Веса терминов: язык-агностичное взвешивание — вес = IDF термина в самом вольте (частое слово
// на ЛЮБОМ языке — the/с/的/und — редкое → большое). Haystack каждой карточки считается один раз.
type TermWeights = {
  tokens: string[];
  hayByPath: Map<string, string>;
  idf: Map<string, number>;
  idfTotal: number;
};

function termWeights(
  tokens: string[],
  docs: Doc[],
  history: boolean,
): TermWeights {
  const hayByPath = new Map<string, string>();
  for (const doc of docs) hayByPath.set(doc.path, haystack(doc, history));
  const idf = new Map<string, number>();
  for (const t of tokens) {
    let dfc = 0;
    for (const h of hayByPath.values()) if (h.includes(t)) dfc++;
    idf.set(t, Math.log((docs.length + 1) / (dfc + 1)) + 1); // сглажённый, >0; редкий термин → вес↑
  }
  const idfTotal = tokens.reduce((s, t) => s + (idf.get(t) ?? 0), 0) || 1;
  return { tokens, hayByPath, idf, idfTotal };
}

// Coverage: доля ВЕСА (не количества) терминов запроса, покрытых карточкой. Документ, совпавший
// лишь по одному общему токену («rush»→«Rushana»), покрывает малый вес → уступает тому, кто
// покрыл редкие, различающие термины. Работает на любом языке без списков — вес даёт корпус.
function coverage(path: string, weights: TermWeights): number {
  if (weights.tokens.length === 0) return 1;
  const hay = weights.hayByPath.get(path) || "";
  let s = 0;
  for (const t of weights.tokens)
    if (hay.includes(t)) s += weights.idf.get(t) ?? 0;
  return s / weights.idfTotal;
}

// Близость к якорю: 0 хопов ×1.5, 1 хоп ×1.3, 2 хопа ×1.15, недостижим ×1.
const PROXIMITY = [1.5, 1.3, 1.15];
const proximityOf = (hops: number | undefined): number =>
  hops === undefined ? 1 : (PROXIMITY[hops] ?? 1.15);

// Ранговый скор (RRF-style, K=60) плюс графовый recall: сильные соседи якорей (1 хоп), которых
// лексика не подняла, добавляются с маленьким базовым скором — граф даёт recall, а не только реранк.
function baseScores(
  ranked: string[],
  dist: Map<string, number>,
  K: number,
): Map<string, number> {
  const baseScore = new Map<string, number>();
  ranked.forEach((path, i) => baseScore.set(path, 1 / (K + i)));
  const NEIGHBOR_BASE = 1 / (K + ranked.length + 5);
  for (const [noext, hop] of dist) {
    if (hop === 1 && !baseScore.has(noext + ".md"))
      baseScore.set(noext + ".md", NEIGHBOR_BASE);
  }
  return baseScore;
}

// Отменённое и заменённое видно только с history; неактивное — в выдаче, но ниже.
const HIDDEN = new Set(["superseded", "archived", "cancelled", "reverted"]);
const INACTIVE = "inactive";

// Link-distance реранк: якоря = топ-3 BM25-хита; BFS даёт близость каждой карточки к теме.
function scoreHits(input: {
  ranked: string[];
  engine: string;
  docs: Doc[];
  tokens: string[];
  topN: number;
  history: boolean;
}): MemoryAnswer {
  const K = 60;
  const graph = loadGraph();
  const anchors = input.ranked.slice(0, 3).map((p) => p.replace(/\.md$/, ""));
  const dist = bfsDistances(graph, anchors, 2);
  const baseScore = baseScores(input.ranked, dist, K);
  const weights = termWeights(input.tokens, input.docs, input.history);
  const byPath = new Map(input.docs.map((d) => [d.path, d]));
  const scored: Hit[] = [];
  for (const [path, s0] of baseScore) {
    const doc = byPath.get(path);
    if (!doc || (HIDDEN.has(doc.status) && !input.history)) continue;
    const noext = path.replace(/\.md$/, "");
    const incoming = graph[noext]?.incoming?.length ?? 0;
    // Coverage — сильный множитель (0.3..1.3): покрыл весь смысл запроса → буст, один из многих → штраф.
    const cov = 0.3 + coverage(doc.path, weights);
    let score =
      s0 *
      cov *
      proximityOf(dist.get(noext)) *
      (1 + Math.min(incoming, 10) * 0.03);
    if (doc.status === INACTIVE) score *= 0.3;
    scored.push({
      file: doc.path,
      score: Number(score.toFixed(6)),
      status: doc.status,
      confidence: doc.confidence,
      snippet: snippet(
        input.history && doc.history ? doc.body + "\n" + doc.history : doc.body,
        input.tokens,
      ),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return {
    count: scored.length,
    engine: input.engine,
    hits: scored.slice(0, input.topN),
  };
}

async function searchMemoryInner(
  {
    query,
    limit,
    scope,
    history,
  }: {
    query: string;
    limit?: number;
    scope?: string[];
    history?: boolean;
  },
  signal?: AbortSignal,
): Promise<MemoryAnswer> {
  const parsed = tokenizeQuery(query);
  if ("rejected" in parsed) return parsed.rejected;
  const past =
    history ?? queryWords(query).some((word) => HISTORY_WORDS.test(word));
  const topN = limit ?? 12;
  const { docs, signature } = await loadDocs(
    scope && scope.length ? scope : DEFAULT_DIRS,
  );
  if (docs.length === 0)
    return { count: 0, hits: [] as Hit[], note: "vault пуст или недоступен" };
  const bm25 = rankByBm25(docs, signature, parsed.tokens, topN, past);
  const merged = await mergeDense(bm25.ranked, bm25.engine, {
    query,
    docs,
    topN,
    signal,
  });
  return scoreHits({
    ranked: merged.ranked,
    engine: merged.engine,
    docs,
    tokens: parsed.tokens,
    topN,
    history: past,
  });
}

export default defineTool({
  description:
    "Поиск по долговременной памяти (карточки и саммари) вместо grep — первым делом " +
    "на «что я знаю про X», «как звали…», «когда решили…». Клади в ОДИН запрос все " +
    "известные написания сразу — русское и латинское, транслит, разговорное имя, — и " +
    "основную форму слова: русские окончания снимаются, ё = е, слово ищется по " +
    "началу; опечатка запросом не лечится. Раздел «## History» и карточки " +
    "superseded/archived/cancelled/reverted видны только с history: true " +
    "(включается сам, если в запросе «раньше», «было», «история», «до»). Возвращает " +
    "{ file, score, status, confidence, snippet }; открывай 1–3 лучших через read_file; " +
    "INFERRED — осторожно.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Запрос: слова/имена/темы (до 64 слов)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Хитов (по умолчанию 8)"),
    scope: z
      .array(z.string())
      .optional()
      .describe(
        "Поддиректории vault (по умолчанию cards, summaries, weekly/monthly/yearly)",
      ),
    history: z
      .boolean()
      .optional()
      .describe("Искать и в прошлом: раздел History и отменённые карточки"),
  }),
  execute: searchMemory,
});

/**
 * Точка входа тула: неверная настройка каталога вольта — отказ `ok:false` с текстом
 * резолвера, а не исключение на границе фреймворка. ctx — контекст хода от eve:
 * отменённый ход обрывает и поход в сеть за эмбеддингом запроса.
 */
export async function searchMemory(
  input: {
    query: string;
    limit?: number;
    scope?: string[];
    history?: boolean;
  },
  ctx?: { abortSignal?: AbortSignal },
): Promise<MemoryAnswer> {
  try {
    return await searchMemoryInner(input, ctx?.abortSignal);
  } catch (error) {
    const text = vaultDirErrorText(error);
    if (text !== null)
      return {
        count: 0,
        engine: "rejected",
        hits: [],
        note: text,
        ok: false,
        error: text,
      };
    throw error;
  }
}
