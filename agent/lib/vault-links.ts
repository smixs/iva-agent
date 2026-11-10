import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { parseFrontmatterOrSkip } from "./frontmatter.ts";
import { resolveTimeZone } from "../../packages/timezone/index.ts";
import { vaultMarkdownFiles } from "../../packages/vault-walk/index.ts";

// Ссылки [[…]], которые ведут в никуда. Модель пишет их с опечаткой в слаге, с выдуманной
// транслитерацией или на карточку, которой никогда не создавали, — и это не косметика:
// битая ссылка сразу режет health score графа, а ночной graph.fix чинит только то, что
// однозначно резолвится, остальное копится. Поэтому отказ на записи, детерминированный.
//
// Резолв один на запись и на ночной граф: scripts/memory/graph.ts строит рёбра этим же
// индексом (vaultLinks), поэтому ссылка, принятая на записи, ночью не становится битой.

// Вложения: заметка может законно кончаться на суффикс вложения (voice.ogg.md), поэтому
// исключение работает только ПОСЛЕ неудачного резолва.
const EMBED_EXTS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".svg",
  ".pdf",
  ".mp3",
  ".mp4",
  ".webp",
  ".ogg",
  ".opus",
  ".m4a",
  ".wav",
];
const DAY_MS = 86_400_000;

// Ключ → rel-путь карточки без .md. Ключ с двумя владельцами лежит в ambiguous*.
interface LinkIndex {
  exact: Set<string>;
  uniqueSuffix: Map<string, string>;
  ambiguousSuffix: Set<string>;
  uniqueStem: Map<string, string>;
  ambiguousStem: Set<string>;
  uniqueTitle: Map<string, string>;
  ambiguousTitle: Set<string>;
}

/** Ключ ссылки по H1: NFC, один пробел, нижний регистр. */
function normalizeTitle(text: string): string {
  return text
    .normalize("NFC")
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ")
    .toLowerCase();
}

/** Первый H1 тела карточки. Битый frontmatter = заголовка нет, файл не пропадает из индекса. */
function extractTitle(content: string, path: string): string | null {
  const parsed = parseFrontmatterOrSkip(content, path, () => {});
  if (parsed === null) return null;
  for (const line of parsed.body.split("\n")) {
    const match = /^#\s+(\S.*?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return null;
}

function addKey(
  unique: Map<string, string>,
  ambiguous: Set<string>,
  key: string,
  id: string,
): void {
  if (ambiguous.has(key)) return;
  if (unique.has(key)) {
    // Второй владелец того же ключа: неоднозначная ссылка считается неразрешённой.
    unique.delete(key);
    ambiguous.add(key);
    return;
  }
  unique.set(key, id);
}

function buildLinkIndex(
  vaultDir: string,
  extraPaths: readonly string[],
): LinkIndex {
  const index: LinkIndex = {
    exact: new Set(),
    uniqueSuffix: new Map(),
    ambiguousSuffix: new Set(),
    uniqueStem: new Map(),
    ambiguousStem: new Set(),
    uniqueTitle: new Map(),
    ambiguousTitle: new Set(),
  };
  // Ключ везде — путь БЕЗ .md: иначе своя же карточка попадает в индекс дважды, её stem
  // становится неоднозначным, и ссылка файла на самого себя читается как битая.
  // Нечитаемый каталог обход пропускает: проверка ссылок на нём не падает. Карточки в
  // archive и backup — цели ссылок, как и остальные; attachments в индекс не идёт: цель
  // `attachments/…` принимается проверкой файла на диске.
  const paths = vaultMarkdownFiles(vaultDir, { skip: ["attachments"] }).map(
    (file) => relative(vaultDir, file).split(sep).join("/").slice(0, -3),
  );
  const seen = new Set(paths);
  for (const extra of extraPaths) {
    const relNoExt = extra.endsWith(".md") ? extra.slice(0, -3) : extra;
    if (!seen.has(relNoExt)) {
      seen.add(relNoExt);
      paths.push(relNoExt);
    }
  }

  for (const relNoExt of paths) {
    index.exact.add(relNoExt);

    const parts = relNoExt.split("/");
    const stem = parts[parts.length - 1];
    addKey(index.uniqueStem, index.ambiguousStem, stem, relNoExt);
    for (let i = 1; i < parts.length - 1; i += 1) {
      addKey(
        index.uniqueSuffix,
        index.ambiguousSuffix,
        parts.slice(i).join("/"),
        relNoExt,
      );
    }

    let content: string;
    try {
      content = readFileSync(join(vaultDir, `${relNoExt}.md`), "utf8");
    } catch {
      continue; // нечитаемый файл: путь и stem уже в индексе, заголовка просто нет
    }
    const title = extractTitle(content, relNoExt);
    if (title === null) continue;
    const key = normalizeTitle(title);
    if (key) addKey(index.uniqueTitle, index.ambiguousTitle, key, relNoExt);
  }
  return index;
}

/** Цель без `\`, якоря, `.md` и ведущего `vault/`. */
function normalizeLinkTarget(target: string): string {
  let value = target.replace(/\\/g, "").trim();
  const hash = value.indexOf("#");
  if (hash !== -1) value = value.slice(0, hash).trim();
  if (value.endsWith(".md")) value = value.slice(0, -3);
  if (value.startsWith("vault/")) value = value.slice(6);
  return value;
}

/** Карточка, на которую ведёт цель: точный путь → уникальный суффикс → уникальный stem → H1. */
function resolveCard(target: string, index: LinkIndex): string | null {
  if (!target) return null;
  if (index.exact.has(target)) return target;
  const bySuffix = index.uniqueSuffix.get(target);
  if (bySuffix !== undefined) return bySuffix;
  if (index.ambiguousSuffix.has(target)) return null;
  if (target.includes("/")) return null;
  const byStem = index.uniqueStem.get(target);
  if (byStem !== undefined) return byStem;
  if (index.ambiguousStem.has(target)) return null;
  return index.uniqueTitle.get(normalizeTitle(target)) ?? null;
}

const pad = (value: number, width: number): string =>
  String(value).padStart(width, "0");

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isoCalendar(time: number): { year: number; week: number } {
  const weekday = (new Date(time).getUTCDay() + 6) % 7; // понедельник = 0
  const thursday = time + (3 - weekday) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return { year, week };
}

/** День ISO-недели; null для недели, которой в году нет (0-я, 53-я в 52-недельном году). */
function fromIsoCalendar(
  year: number,
  week: number,
  weekday: number,
): number | null {
  const jan4 = Date.UTC(year, 0, 4);
  const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  const time = week1Monday + ((week - 1) * 7 + (weekday - 1)) * DAY_MS;
  const iso = isoCalendar(time);
  return iso.year === year && iso.week === week ? time : null;
}

/**
 * ISO-неделя, которой принадлежит день: `YYYY-Www` — тот weekly, на который ссылается
 * вверх daily-summary. `null`, если такого дня нет в календаре.
 */
export function weekOfDay(day: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const [year, month, date] = match.slice(1).map(Number);
  if (!isRealDate(year, month, date)) return null;
  const iso = isoCalendar(Date.UTC(year, month - 1, date));
  return `${pad(iso.year, 4)}-W${pad(iso.week, 2)}`;
}

/**
 * Месяц, которому принадлежит ISO-неделя: месяц её четверга — так эту связь читает
 * граф. `null` для недели, которой в году нет (53-я в 52-недельном году).
 */
function monthOfWeek(week: string): string | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) return null;
  const [year, number] = match.slice(1).map(Number);
  const thursday = fromIsoCalendar(year, number, 4);
  if (thursday === null) return null;
  const date = new Date(thursday);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}`;
}

/** Родитель роллапа и последний день, до которого его отсутствие — норма. */
interface FutureParent {
  target: string;
  deadline: number;
}

/** daily → свой weekly: до понедельника следующей недели включительно. */
function dailyParent(source: string): FutureParent | null {
  const daily = /^summaries\/daily\/(\d{4}-\d{2}-\d{2})$/.exec(source);
  const week = daily ? weekOfDay(daily[1]) : null;
  if (week === null) return null;
  const [year, number] = week.split("-W").map(Number);
  const monday = fromIsoCalendar(year, number, 1);
  if (monday === null) return null;
  return { target: `weekly/${week}`, deadline: monday + 7 * DAY_MS };
}

/** weekly → monthly: до первого числа следующего месяца включительно. */
function weeklyParent(source: string): FutureParent | null {
  const weekly = /^weekly\/(\d{4}-W\d{2})$/.exec(source);
  const month = weekly ? monthOfWeek(weekly[1]) : null;
  if (month === null) return null;
  const [year, number] = month.split("-").map(Number);
  // Date.UTC считает месяцы с нуля, поэтому `number` — уже первое число следующего.
  return { target: `monthly/${month}`, deadline: Date.UTC(year, number, 1) };
}

/** monthly → yearly: до 1 января следующего года включительно. */
function monthlyParent(source: string): FutureParent | null {
  const monthly = /^monthly\/(\d{4})-(\d{2})$/.exec(source);
  if (!monthly) return null;
  const [year, month] = monthly.slice(1).map(Number);
  if (!isRealDate(year, month, 1)) return null;
  return {
    target: `yearly/${pad(year, 4)}`,
    deadline: Date.UTC(year + 1, 0, 1),
  };
}

/**
 * Отсутствующий родитель роллапа (daily → свой weekly, weekly → monthly, monthly → yearly)
 * битой ссылкой не считается, пока день создания не прошёл. День создания включительно.
 */
function expectedFutureLink(
  source: string,
  target: string,
  today: number,
): boolean {
  const parent =
    dailyParent(source) ?? weeklyParent(source) ?? monthlyParent(source);
  return (
    parent !== null && target === parent.target && today <= parent.deadline
  );
}

function todayUtc(): number {
  const stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(process.env.ASSISTANT_TIMEZONE),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [year, month, day] = stamp.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Вложение валидно, только если ровно этот файл лежит внутри vault обычным файлом. Расширение не важно: DOCX и любой будущий тип не
 * должны становиться битыми из-за того, что их нет в списке медиа. Абсолютный путь, `..`
 * и симлинк на любом шаге пути — отказ, иначе ссылка вывела бы проверку за корень.
 */
function isExistingAttachment(vaultDir: string, target: string): boolean {
  const root = realPathOrNull(vaultDir);
  const parts = safeParts(target);
  if (root === null || parts === null) return false;
  let candidate = root;
  for (const part of parts) {
    candidate = join(candidate, part);
    if (lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink())
      return false;
  }
  const real = realPathOrNull(candidate);
  if (real === null || !isInside(root, real)) return false;
  return statSync(real, { throwIfNoEntry: false })?.isFile() ?? false;
}

function realPathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Сегменты пути: пустые и «.» схлопнуты; абсолютный путь и «..» — null. */
function safeParts(target: string): string[] | null {
  if (isAbsolute(target)) return null;
  const parts = target.split("/").filter((part) => part !== "" && part !== ".");
  return parts.length === 0 || parts.includes("..") ? null : parts;
}

function isInside(root: string, path: string): boolean {
  const inside = relative(root, path);
  return !inside.startsWith("..") && !isAbsolute(inside);
}

/** Сырые цели [[ссылок]] текста: без подписи после `|` и якоря после `#`. */
export function linkTargetsIn(text: string): string[] {
  return [...text.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/gu)]
    .map((match) => match[1].split("#", 1)[0].trim())
    .filter(Boolean);
}

/** Куда ведёт ссылка: `card` — rel-путь карточки без .md; null и не `broken` — принята без
 * карточки (файл вложения, медиа по расширению, ещё не созданный родитель роллапа). */
export interface LinkVerdict {
  readonly target: string;
  readonly card: string | null;
  readonly broken: boolean;
}

/**
 * Индекс ссылок vault на один проход: его правилом write_card и write_file отказывают на
 * записи, им же ночной граф строит рёбра. `extraPaths` — карточки, которых на диске ещё
 * нет (записываемый файл при ADD): ссылка на них разрешена.
 */
export function vaultLinks(
  vaultDir: string,
  options: { extraPaths?: readonly string[]; today?: number } = {},
): {
  readonly cards: readonly string[];
  judge(raw: string, source: string): LinkVerdict;
} {
  const index = buildLinkIndex(vaultDir, options.extraPaths ?? []);
  const today = options.today ?? todayUtc();
  return {
    cards: [...index.exact],
    judge(raw, source) {
      const target = normalizeLinkTarget(raw);
      const card = resolveCard(target, index);
      if (card !== null) return { target, card, broken: false };
      // Порядок важен: сначала точный файл вложения, потом список медиа.
      const accepted =
        (target.startsWith("attachments/") &&
          isExistingAttachment(vaultDir, target)) ||
        EMBED_EXTS.some((ext) => raw.toLowerCase().endsWith(ext)) ||
        expectedFutureLink(source, target, today);
      return { target, card: null, broken: !accepted };
    },
  };
}

/**
 * Цели, которые не резолвятся ни в один файл vault'а. `source` — rel-путь записываемого
 * файла без .md: он нужен для future-link роллапа и делает ссылку на самого себя
 * разрешённой (при ADD карточки на диске ещё нет).
 */
export function unresolvedLinkTargets(
  rawTargets: readonly string[],
  options: { vaultDir: string; source: string; today?: number },
): string[] {
  if (rawTargets.length === 0) return [];
  const links = vaultLinks(options.vaultDir, {
    extraPaths: [options.source],
    today: options.today,
  });
  const unresolved = new Set<string>();
  for (const raw of rawTargets) {
    const verdict = links.judge(raw, options.source);
    if (verdict.broken) unresolved.add(verdict.target);
  }
  return [...unresolved];
}

export function brokenLinksIn(
  text: string,
  options: { vaultDir: string; source: string },
): string | null {
  const targets = unresolvedLinkTargets(linkTargetsIn(text), options);
  return targets.length
    ? `Ссылки ведут в никуда: ${targets.map((target) => `[[${target}]]`).join(", ")}. Ничего не записано. ` +
        "Сначала создай карточку через write_card или напиши без [[ ]]; точный путь проверь через memory_search/read_file."
    : null;
}
