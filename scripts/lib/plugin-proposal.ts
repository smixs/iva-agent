// Предложение плагина: копия, которую модель собрала (`iva plugin propose`), лежит в
// `data/plugin-proposals/<name>-<digest12>/` и ждёт тапа владельца. Плагин с `mcp.json` или
// `sh.iva/` ставит не модель, а Bridge по тапу «Установить» (ADR-0009): тап забирает копию
// атомарным `rename` в `.taken-<digest12>/`, сверяет её хеш дерева с тем, что был в сообщении,
// и запускает `iva plugin install-proposal` вне хода модели.
//
// Модуль общий для CLI и моста и потому стоит на node:fs: CLI обязан грузиться без authored
// tree (scripts/authored-tree-guard.test.ts), поэтому отпечаток дерева приходит параметром
// (`pluginTreeDigest` из agent/lib/plugin-reader.ts у обоих вызывающих).
import {
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { escapeRichText } from "./telegram-buttons.ts";
import { redactNotice } from "./notice.ts";

type Translate = (english: string, russian: string) => string;

export const PROPOSAL_CALLBACK_PREFIX = "iva_plugin:ok:";
/** Предложение и забранная копия живут сутки: дальше тап отвечает «устарело». */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const TAKEN_PREFIX = ".taken-";
const STAGING_PREFIX = ".staging-";
const DIGEST12 = /^[a-f0-9]{12}$/u;
const MAX_COMMAND_LINES = 10;
const MAX_LINE = 120;
const MAX_REASON = 300;

export function proposalsDir(dataDir: string): string {
  return join(dataDir, "plugin-proposals");
}

export function proposalFolder(name: string, digest12: string): string {
  return `${name}-${digest12}`;
}

export function takenDir(dir: string, digest12: string): string {
  return join(dir, `${TAKEN_PREFIX}${digest12}`);
}

/** Путь папки черновика, из которой собрано предложение: он станет `source` плагина. */
export function fromFile(dir: string, digest12: string): string {
  return join(dir, `.from-${digest12}`);
}

export function stagingPrefix(dir: string): string {
  return join(dir, STAGING_PREFIX);
}

/**
 * Плагин, который ставится только через предложение: несёт `mcp.json` или `sh.iva/`.
 * Смотрим на сами записи, а не на разобранный отчёт: битый `mcp.json` — тоже MCP.
 */
export function carriesCodeOrMcp(root: string): boolean {
  return ["mcp.json", "sh.iva"].some((entry) => {
    try {
      lstatSync(join(root, entry));
      return true;
    } catch {
      return false;
    }
  });
}

/** `iva_plugin:ok:<digest12>` → digest12; всё остальное не наш вид. */
export function parseProposalCallback(data: string): string | null {
  if (!data.startsWith(PROPOSAL_CALLBACK_PREFIX)) return null;
  const digest12 = data.slice(PROPOSAL_CALLBACK_PREFIX.length);
  return DIGEST12.test(digest12) ? digest12 : null;
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function ageMs(path: string, nowMs: number): number {
  return nowMs - mtimeMs(path);
}

/** Время папки; её нет — минус бесконечность (возраст бесконечный). */
function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

/** Имя плагина по папке предложения с этим digest12; null — такого нет. */
export function findProposal(dir: string, digest12: string): string | null {
  const suffix = `-${digest12}`;
  const folder = entries(dir).find(
    (entry) =>
      !entry.startsWith(".") &&
      entry.endsWith(suffix) &&
      entry.length > suffix.length,
  );
  return folder ? folder.slice(0, -suffix.length) : null;
}

/**
 * Предложения, забранные копии и брошенные staging старше суток уходят. Время папки здесь
 * — исключение из запрета «удаление по mtime» (ADR-0009): удаляется только копия, исходник
 * остаётся у модели. `.taken-*` получает время тапа, поэтому идущая установка свою копию
 * сутки не теряет.
 */
export function sweepProposals(dir: string, nowMs: number): void {
  for (const entry of entries(dir)) {
    const path = join(dir, entry);
    if (ageMs(path, nowMs) > PROPOSAL_TTL_MS)
      rmSync(path, { recursive: true, force: true });
  }
}

export type TakeOutcome =
  | {
      readonly status: "taken";
      readonly name: string;
      readonly path: string;
      /** Время propose (папки до stamp): возврат копии ставит его обратно. */
      readonly proposedMs: number;
    }
  | { readonly status: "stale"; readonly name: string | null };

/**
 * Забрать предложение под установку. Сначала `rename` — он один на два тапа подряд, — потом
 * сверка того, что забрано: возраст и хеш дерева. Возраст считается от propose, затем копия
 * получает время тапа: уборка следующего propose не снесёт её посреди установки. Не сошлось
 * — копия удаляется, установки нет.
 */
export async function takeProposal(options: {
  readonly dir: string;
  readonly digest12: string;
  readonly nowMs: number;
  readonly digest: (root: string) => Promise<string>;
}): Promise<TakeOutcome> {
  const { dir, digest12, nowMs, digest } = options;
  const name = findProposal(dir, digest12);
  if (name === null) return { status: "stale", name: takenName(dir, digest12) };
  const taken = takenDir(dir, digest12);
  try {
    renameSync(join(dir, proposalFolder(name, digest12)), taken);
  } catch {
    // ENOENT — забрал соседний тап; ENOTEMPTY/EEXIST — его копия ещё ставится.
    return { status: "stale", name };
  }
  // От rename до stamp — без await: второй тап того же Bridge не должен увидеть копию между
  // ними, иначе он примет чужую свежую `.taken-*` за свою (specs/PluginProposal.tla).
  const proposedMs = mtimeMs(taken);
  const fresh = nowMs - proposedMs <= PROPOSAL_TTL_MS && stamp(taken, nowMs);
  const same = fresh && (await digestOf(taken, digest)) === digest12;
  if (same) return { status: "taken", name, path: taken, proposedMs };
  rmSync(taken, { recursive: true, force: true });
  return { status: "stale", name };
}

/** Время тапа на забранной копии; `false` — копии уже нет или её не тронуть. */
function stamp(path: string, atMs: number): boolean {
  try {
    const at = new Date(atMs);
    utimesSync(path, at, at);
    return true;
  } catch {
    return false;
  }
}

/** Имя плагина, чью копию уже забрал соседний тап, — для ответа второму тапу. */
function takenName(dir: string, digest12: string): string | null {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(takenDir(dir, digest12), "plugin.json"), "utf8"),
    );
    const name = (manifest as { name?: unknown } | null)?.name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

async function digestOf(
  root: string,
  digest: (root: string) => Promise<string>,
): Promise<string | null> {
  try {
    return (await digest(root)).slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * Установщик не запустился — копия возвращается на место со временем propose (`proposedMs`
 * из TakeOutcome), тап можно повторить до конца тех же суток: неудачный тап срок не продлевает.
 * `false` — вернуть некуда или нечего, или время не встало (такая копия удаляется): следующий
 * propose соберёт копию заново.
 */
export function returnProposal(
  dir: string,
  name: string,
  digest12: string,
  proposedMs: number,
): boolean {
  const folder = join(dir, proposalFolder(name, digest12));
  try {
    renameSync(takenDir(dir, digest12), folder);
  } catch {
    return false;
  }
  if (stamp(folder, proposedMs)) return true;
  rmSync(folder, { recursive: true, force: true });
  return false;
}

// ── Тексты владельцу (spec v4 §10, пары переводчика Notice) ──

function clip(line: string): string {
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

/** Что плагин будет запускать: не больше 10 строк по 120 знаков, остаток — числом. */
export function commandLines(
  tr: Translate,
  composition: {
    readonly commands: readonly string[];
    readonly code: boolean;
  },
): string[] {
  const lines = [...composition.commands];
  if (composition.code)
    lines.push(
      tr(
        "extension code inside Iva's process",
        "код расширения в процессе Ивы",
      ),
    );
  const shown = lines.slice(0, MAX_COMMAND_LINES).map(clip);
  const rest = lines.length - shown.length;
  if (rest > 0) shown.push(tr(`… and ${rest} more`, `… и ещё ${rest}`));
  return shown;
}

export function proposalText(
  tr: Translate,
  name: string,
  commands: readonly string[],
  files: number,
): string {
  const run = commands.join("; ");
  return tr(
    `Plugin ${name} asks to be installed. It will run: ${run}. Files: ${files}. Installing will restart me for a minute.`,
    `Плагин ${name} просит установку. Будет запускать: ${run}. Файлов: ${files}. Установка перезапустит меня на минуту.`,
  );
}

/** Optional plain README sections; their text follows the proposal's screen and Gate. */
export async function proposalReadmeLines(
  tr: Translate,
  root: string,
): Promise<string[]> {
  let readme: string;
  try {
    readme = readFileSync(join(root, "README.md"), "utf8");
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const [en, ru] of [
    ["Keys", "Ключи"],
    ["Network", "Сеть"],
  ]) {
    const section = new RegExp(
      `^## ${en}\\r?\\n([\\s\\S]*?)(?=^#{1,6}[ \\t]+|(?![\\s\\S]))`,
      "mu",
    ).exec(readme)?.[1];
    // Drop tag/link delimiters before escaping: classic screens also parse button tags.
    const plain = (section ?? "")
      .replace(/[\\`<>[\]]/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
    const chars = Array.from(await redactNotice(plain));
    const value = escapeRichText(
      chars.length > MAX_LINE
        ? `${chars.slice(0, MAX_LINE - 1).join("")}…`
        : chars.join(""),
    );
    if (value) lines.push(tr(`${en}: ${value}`, `${ru}: ${value}`));
  }
  return lines;
}

export function installButtonLabel(tr: Translate): string {
  return tr("Install", "Установить");
}

export function installedText(tr: Translate, name: string): string {
  return tr(`Plugin ${name} installed`, `Плагин ${name} установлен`);
}

export function notInstalledText(
  tr: Translate,
  name: string,
  reason: string,
): string {
  const why = reason.slice(0, MAX_REASON);
  return tr(
    `Plugin ${name} was not installed: ${why}`,
    `Плагин ${name} не установился: ${why}`,
  );
}

export function staleReason(tr: Translate): string {
  return tr("the proposal is out of date", "предложение устарело");
}
