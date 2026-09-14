import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseFrontmatterOrSkip } from "./frontmatter.ts";
import { resolveTimeZone } from "./timezone.ts";

// Ссылки [[…]], которые ведут в никуда. Модель пишет их с опечаткой в слаге, с выдуманной
// транслитерацией или на карточку, которой никогда не создавали, — и это не косметика:
// битая ссылка сразу режет health score графа, а ночной graph.fix чинит только то, что
// однозначно резолвится, остальное копится. Поэтому отказ на записи, детерминированный.
//
// Резолв обязан совпадать с ночным обходом один в один, иначе отказ будет ложным:
// scripts/autograph/common.py (walk_vault, build_link_index, normalize_link_target,
// resolve_link_target) и scripts/autograph/graph.py (build_graph, expected_future_link).

const IGNORE_DIRS = new Set([
  ".obsidian",
  "attachments",
  ".git",
  ".graph",
  ".claude",
  ".trash",
  "backup",
  "archive",
  "__pycache__",
]);

// Вложения: заметка может законно кончаться на суффикс вложения (voice.ogg.md), поэтому
// исключение работает только ПОСЛЕ неудачного резолва — так же, как в build_graph.
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

const WIKILINK = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;
const DAY_MS = 86_400_000;

interface LinkIndex {
  exact: Set<string>;
  uniqueSuffix: Set<string>;
  ambiguousSuffix: Set<string>;
  uniqueStem: Set<string>;
  ambiguousStem: Set<string>;
  uniqueTitle: Set<string>;
  ambiguousTitle: Set<string>;
}

/** Все .md под корнем vault'а, кроме IGNORE_DIRS, как rel-пути через «/». */
function walkVault(vaultDir: string): string[] {
  const results: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // нечитаемый каталог — как будто его нет, проверка не падает на нём
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        visit(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(
          relative(vaultDir, join(dir, entry.name)).split(sep).join("/"),
        );
      }
    }
  };
  visit(vaultDir);
  return results;
}

/** Ключ ссылки по H1: NFC, один пробел, нижний регистр (python normalize_title). */
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
  unique: Set<string>,
  ambiguous: Set<string>,
  key: string,
): void {
  if (ambiguous.has(key)) return;
  if (unique.has(key)) {
    // Второй владелец того же ключа: python переносит его в ambiguous_*, и резолв
    // такой цели даёт None — неоднозначная ссылка считается неразрешённой.
    unique.delete(key);
    ambiguous.add(key);
    return;
  }
  unique.add(key);
}

function buildLinkIndex(vaultDir: string, extraPaths: string[]): LinkIndex {
  const index: LinkIndex = {
    exact: new Set(),
    uniqueSuffix: new Set(),
    ambiguousSuffix: new Set(),
    uniqueStem: new Set(),
    ambiguousStem: new Set(),
    uniqueTitle: new Set(),
    ambiguousTitle: new Set(),
  };
  // Ключ везде — путь БЕЗ .md: иначе своя же карточка попадает в индекс дважды, её stem
  // становится неоднозначным, и ссылка файла на самого себя читается как битая.
  const paths = walkVault(vaultDir).map((rel) =>
    rel.endsWith(".md") ? rel.slice(0, -3) : rel,
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
    addKey(index.uniqueStem, index.ambiguousStem, stem);
    for (let i = 1; i < parts.length - 1; i += 1) {
      addKey(
        index.uniqueSuffix,
        index.ambiguousSuffix,
        parts.slice(i).join("/"),
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
    if (key) addKey(index.uniqueTitle, index.ambiguousTitle, key);
  }
  return index;
}

/** python normalize_link_target. */
function normalizeLinkTarget(target: string): string {
  let value = target.replace(/\\/g, "").trim();
  const hash = value.indexOf("#");
  if (hash !== -1) value = value.slice(0, hash).trim();
  if (value.endsWith(".md")) value = value.slice(0, -3);
  if (value.startsWith("vault/")) value = value.slice(6);
  return value;
}

/** python resolve_link_target: точный путь → уникальный суффикс → уникальный stem → H1. */
function isResolved(target: string, index: LinkIndex): boolean {
  if (!target) return false;
  if (index.exact.has(target)) return true;
  if (index.uniqueSuffix.has(target)) return true;
  if (index.ambiguousSuffix.has(target)) return false;
  if (target.includes("/")) return false;
  if (index.uniqueStem.has(target)) return true;
  if (index.ambiguousStem.has(target)) return false;
  const titleKey = normalizeTitle(target);
  return index.uniqueTitle.has(titleKey);
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

/** date.fromisocalendar: null там, где python бросает ValueError (недели 0/53 без 53-й). */
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
export function monthOfWeek(week: string): string | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) return null;
  const [year, number] = match.slice(1).map(Number);
  const thursday = fromIsoCalendar(year, number, 4);
  if (thursday === null) return null;
  const date = new Date(thursday);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}`;
}

/**
 * python expected_future_link: отсутствующий родитель роллапа (daily → свой weekly,
 * weekly → monthly, monthly → yearly) битой ссылкой не считается, пока день создания
 * не прошёл. День создания включительно.
 */
function expectedFutureLink(
  source: string,
  target: string,
  today: number,
): boolean {
  const daily = /^summaries\/daily\/(\d{4}-\d{2}-\d{2})$/.exec(source);
  if (daily) {
    const week = weekOfDay(daily[1]);
    if (week === null) return false;
    const [year, number] = week.split("-W").map(Number);
    const monday = fromIsoCalendar(year, number, 1);
    if (monday === null) return false;
    return target === `weekly/${week}` && today <= monday + 7 * DAY_MS;
  }

  const weekly = /^weekly\/(\d{4}-W\d{2})$/.exec(source);
  if (weekly) {
    const month = monthOfWeek(weekly[1]);
    if (month === null) return false;
    const [year, number] = month.split("-").map(Number);
    // Date.UTC считает месяцы с нуля, поэтому `number` — уже первое число следующего.
    return target === `monthly/${month}` && today <= Date.UTC(year, number, 1);
  }

  const monthly = /^monthly\/(\d{4})-(\d{2})$/.exec(source);
  if (monthly) {
    const [year, month] = monthly.slice(1).map(Number);
    if (!isRealDate(year, month, 1)) return false;
    return (
      target === `yearly/${pad(year, 4)}` && today <= Date.UTC(year + 1, 0, 1)
    );
  }

  return false;
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

/** Цели wikilinks из текста: без alias и без #якоря, в порядке появления. */
export function wikilinkTargets(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(WIKILINK)) {
    const anchor = match[1].indexOf("#");
    const target = (
      anchor === -1 ? match[1] : match[1].slice(0, anchor)
    ).trim();
    if (target) targets.push(target);
  }
  return targets;
}

/** Элемент `related`: путь/слаг, иногда в скобках и с alias'ом. */
export function relatedTarget(raw: string): string {
  const value = raw.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
  return value.split("|")[0].trim();
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
  const index = buildLinkIndex(options.vaultDir, [options.source]);
  const today = options.today ?? todayUtc();
  const unresolved: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawTargets) {
    const target = normalizeLinkTarget(raw);
    if (isResolved(target, index)) continue;
    const lower = raw.toLowerCase();
    if (EMBED_EXTS.some((ext) => lower.endsWith(ext))) continue;
    if (expectedFutureLink(options.source, target, today)) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    unresolved.push(target);
  }
  return unresolved;
}

/** Текст отказа — один на оба тула: одинаковая ошибка не должна читаться по-разному. */
export function brokenLinksError(targets: readonly string[]): string {
  return (
    `Ссылки ведут в никуда: ${targets.map((t) => `[[${t}]]`).join(", ")}. Ничего не записано. ` +
    "Сначала создай карточку через write_card или напиши без [[ ]]; " +
    "точный путь проверь через memory_search/read_file."
  );
}
