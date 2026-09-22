import { CORE_CAP } from "./core-cap.ts";

type Section = "user" | "preferences" | "goals" | "pointers";

interface CoreLine {
  readonly content: string;
  readonly ending: string;
  section: Section | null;
  sectionId: number;
  heading: boolean;
  removed: boolean;
  replacement: string | null;
}

interface PreferenceCandidate {
  readonly line: CoreLine;
  readonly index: number;
  readonly date: string | null;
}

// Заголовок секции CORE: ровно `## `, не `###`. Один источник для классификации секций
// и для сторожа, который сравнивает файл до и после ночного хода.
const HEADING = /^##[ \t]+(.+?)[ \t]*$/u;

const SECTION_KIND = new Map<string, Section>([
  ["Пользователь", "user"],
  ["User", "user"],
  ["Предпочтения", "preferences"],
  ["Preferences", "preferences"],
  ["Активные цели (≤3)", "goals"],
  ["Active goals (≤3)", "goals"],
  // Existing vaults may have lost the hint while keeping the canonical section name.
  ["Активные цели", "goals"],
  ["Active goals", "goals"],
  ["Указатели", "pointers"],
  ["Pointers", "pointers"],
]);

function linesOf(text: string): CoreLine[] {
  const lines: CoreLine[] = [];
  let start = 0;

  while (start < text.length) {
    let contentEnd = start;
    while (
      contentEnd < text.length &&
      text[contentEnd] !== "\n" &&
      text[contentEnd] !== "\r"
    ) {
      contentEnd += 1;
    }

    let rawEnd = contentEnd;
    if (text[rawEnd] === "\r" && text[rawEnd + 1] === "\n") rawEnd += 2;
    else if (text[rawEnd] === "\r" || text[rawEnd] === "\n") rawEnd += 1;

    lines.push({
      content: text.slice(start, contentEnd),
      ending: text.slice(contentEnd, rawEnd),
      section: null,
      sectionId: -1,
      heading: false,
      removed: false,
      replacement: null,
    });
    start = rawEnd;
  }

  return lines;
}

function classifySections(lines: CoreLine[]): void {
  let section: Section | null = null;
  let sectionId = 0;

  for (const line of lines) {
    const heading = HEADING.exec(line.content);
    if (heading) {
      section = SECTION_KIND.get(heading[1]) ?? null;
      sectionId += 1;
      line.heading = true;
    }
    line.section = section;
    line.sectionId = sectionId;
  }
}

function isBullet(line: CoreLine): boolean {
  return !line.heading && /^-(?:[ \t]+|$)/.test(line.content);
}

function render(lines: readonly CoreLine[]): string {
  let out = "";
  for (const line of lines) {
    if (line.removed) continue;
    out += line.replacement ?? `${line.content}${line.ending}`;
  }
  return out;
}

function enforceGoalLimit(lines: CoreLine[]): void {
  const seen = new Map<number, number>();
  for (const line of lines) {
    if (line.section !== "goals" || !isBullet(line)) continue;
    const count = seen.get(line.sectionId) ?? 0;
    seen.set(line.sectionId, count + 1);
    if (count >= 3) line.removed = true;
  }
}

function preferenceEvictionOrder(
  lines: readonly CoreLine[],
): PreferenceCandidate[] {
  return lines
    .map((line, index) => {
      if (line.section !== "preferences" || !isBullet(line)) return null;
      const date =
        /^-[ \t]+(\d{4}-\d{2}(?:-\d{2})?)\b/.exec(line.content)?.[1] ?? null;
      return { line, index, date };
    })
    .filter((item): item is PreferenceCandidate => item !== null)
    .sort((a, b) => {
      if (a.date === null && b.date !== null) return -1;
      if (a.date !== null && b.date === null) return 1;
      if (a.date !== b.date) return (a.date ?? "") < (b.date ?? "") ? -1 : 1;
      return a.index - b.index;
    });
}

function longestMutableBullet(lines: readonly CoreLine[]): CoreLine | null {
  let longest: CoreLine | null = null;
  for (const line of lines) {
    if (
      line.removed ||
      !isBullet(line) ||
      line.section === null ||
      line.section === "pointers"
    ) {
      continue;
    }
    if (!longest || line.content.length > longest.content.length)
      longest = line;
  }
  return longest;
}

function truncateToCap(lines: CoreLine[]): string {
  const current = render(lines);
  const excess = current.length - CORE_CAP;
  if (excess <= 0) return current;

  const line = longestMutableBullet(lines);
  // Keep one ellipsis. If protected content alone makes the cap impossible, leave this
  // phase untouched so another clamp call cannot progressively eat additional bullets.
  if (!line || line.content.length - 1 < excess) return current;

  let prefixLength = line.content.length - excess - 1;
  // Do not leave an unpaired high surrogate when the cut crosses an emoji/code point.
  if (
    prefixLength > 0 &&
    /[\uD800-\uDBFF]/.test(line.content[prefixLength - 1]) &&
    /[\uDC00-\uDFFF]/.test(line.content[prefixLength])
  ) {
    prefixLength -= 1;
  }
  if (prefixLength < 2) {
    line.removed = true;
    return render(lines);
  }
  line.replacement = `${line.content.slice(0, prefixLength)}…${line.ending}`;
  return render(lines);
}

/**
 * Deterministically shrink CORE.md without ever cutting headings, pointers or unknown
 * sections. Files already within the cap are returned byte-for-byte unchanged.
 */
export function clampCore(text: string): string {
  if (typeof text !== "string")
    throw new TypeError("clampCore expects a string");
  if (text.length <= CORE_CAP) return text;

  const lines = linesOf(text);
  classifySections(lines);
  enforceGoalLimit(lines);

  const current = render(lines);
  if (current.length <= CORE_CAP) return current;

  // Длину ведём вычитанием: render() на каждую вытесняемую строку делал сжатие
  // квадратичным (4× вход ≈ 15× времени), а clampCore зовётся на каждом ходу,
  // пока CORE больше потолка.
  let length = current.length;
  for (const item of preferenceEvictionOrder(lines)) {
    if (item.line.removed) continue;
    item.line.removed = true;
    length -= item.line.content.length + item.line.ending.length;
    if (length <= CORE_CAP) return render(lines);
  }

  return truncateToCap(lines);
}

// Строка указателя на последний обработанный день. Обе локали заголовка секции знает
// SECTION_KIND выше; здесь — обе локали самой метки. Значение (путь до сводки) кончается
// на первом пробеле или `·`, поэтому хвост строки («· Индекс: MOC.md») переживает правку
// байт в байт, а старое значение с префиксом `vault/` заменяется целиком.
const LAST_DAY_LABEL =
  /^(\s*[-*][ \t]+(?:Последний день|Last day)[ \t]*:[ \t]*)([^\s·]*)(.*)$/u;
const DAILY_SUMMARY_PREFIX = "summaries/daily/";
// Канонический вид секции из Shape (core-format.md) — на случай, когда её нет вовсе.
const POINTERS_HEADING = "## Указатели";
const LAST_DAY_LABEL_TEXT = "- Последний день: ";

function newlineOf(lines: readonly CoreLine[]): string {
  for (const line of lines) if (line.ending !== "") return line.ending;
  return "\n";
}

/**
 * Проставить в CORE указатель на последний обработанный день. Дату код знает точно, а
 * «перепиши CORE целиком» — самый частый способ потерять чужие секции, поэтому указатель
 * ведёт код, а не модель: правится ровно одна строка, всё остальное байт в байт.
 *
 * Нет строки — она дописывается в секцию указателей; нет секции — секция дописывается в
 * конец. Мусор на входе (пустой файл, файл без заголовков, CRLF) не бросает: указатель
 * всё равно оказывается на месте, и повторный вызов уже ничего не меняет.
 */
export function setLastDayPointer(text: string, isoDate: string): string {
  if (typeof text !== "string")
    throw new TypeError("setLastDayPointer expects a string");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(isoDate))
    throw new TypeError(`setLastDayPointer expects YYYY-MM-DD, got ${isoDate}`);

  const value = `${DAILY_SUMMARY_PREFIX}${isoDate}`;
  const bullet = `${LAST_DAY_LABEL_TEXT}${value}`;
  const lines = linesOf(text);
  classifySections(lines);

  let anchor: CoreLine | null = null;
  for (const line of lines) {
    if (line.section !== "pointers") continue;
    if (line.content.trim() !== "") anchor = line;
    // Первая строка-указатель и есть указатель: вторую такую же трогать нечем — какая из
    // них правда, знает только автор файла.
    const found = LAST_DAY_LABEL.exec(line.content);
    if (!found) continue;
    // Значения не было («- Последний день: · Индекс: …») — вернуть пробел, который иначе
    // склеил бы путь с хвостом.
    const tail =
      found[3] === "" || /^\s/u.test(found[3]) ? found[3] : ` ${found[3]}`;
    const next = `${found[1]}${value}${tail}`;
    if (next === line.content) return text;
    line.replacement = `${next}${line.ending}`;
    return render(lines);
  }

  const newline = newlineOf(lines);
  if (anchor) {
    // Секция есть, строки нет: дописываем её последней содержательной строкой секции,
    // сохраняя стиль переводов строки самого файла (в том числе их отсутствие в конце).
    anchor.replacement = `${anchor.content}${anchor.ending || newline}${bullet}${anchor.ending}`;
    return render(lines);
  }

  let out = text;
  if (out !== "" && !out.endsWith(newline)) out += newline;
  if (out !== "" && !out.endsWith(`${newline}${newline}`)) out += newline;
  return `${out}${POINTERS_HEADING}${newline}${newline}${bullet}${newline}`;
}

export interface CoreDamage {
  /** Заголовки `## `, которые были до хода и пропали после (без самих решёток). */
  readonly lostHeadings: readonly string[];
  /** Уцелевшие заголовки `## `, у которых непустое тело стало пустым. */
  readonly hollowedHeadings: readonly string[];
  /** Файл был непустым и стал пустым. */
  readonly emptied: boolean;
  readonly damaged: boolean;
}

/** Имя заголовка `## ` → текст его тела: строки до следующего `## ` или конца файла. */
function sectionsOf(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (heading === null) return;
    const joined = body.join("\n");
    const previous = sections.get(heading);
    sections.set(
      heading,
      previous === undefined ? joined : `${previous}\n${joined}`,
    );
  };
  for (const line of linesOf(text)) {
    const next = HEADING.exec(line.content);
    if (next) {
      flush();
      heading = next[1];
      body = [];
    } else if (heading !== null) {
      body.push(line.content);
    }
  }
  flush();
  return sections;
}

/**
 * Насколько заголовок похож на другой. Считаем общие слова и общие пары слов (bigram-ки)
 * нормализованными на длину; ровно одна формула для обеих сторон, чтобы и «слегка
 * перефразировали», и «дописали уточнение» вели себя симметрично. Пустые стороны — 0.
 */
function headingSimilarity(a: string, b: string): number {
  const words = (value: string): string[] =>
    value
      .toLowerCase()
      .split(/[^a-zа-яё0-9]+/u)
      .filter(Boolean);
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const bigrams = (list: string[]): string[] =>
    list.length === 1
      ? [`*${list[0]}*`]
      : list.slice(0, -1).map((word, index) => `${word} ${list[index + 1]}`);
  const sets = (list: string[]): Set<string> => new Set(list);
  const intersect = (x: readonly string[], y: readonly string[]): number => {
    const ys = sets([...y]);
    let count = 0;
    for (const item of x) if (ys.has(item)) count += 1;
    return count;
  };
  const ba = bigrams(wa);
  const bb = bigrams(wb);
  const numerator = 2 * (intersect(wa, wb) + intersect(ba, bb));
  const denominator = wa.length + wb.length + ba.length + bb.length;
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Порог: ниже — считаем секцию потерянной, выше — переименованием (ночным сжатием). */
const RENAME_SIMILARITY = 0.45;

/** Заголовок из `after`, который можно считать переименованием `before`. */
function bestRenameMatch(
  before: string,
  afterHeadings: readonly string[],
  taken: ReadonlySet<string>,
): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const candidate of afterHeadings) {
    if (taken.has(candidate)) continue;
    const score = headingSimilarity(before, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= RENAME_SIMILARITY ? best : null;
}

/**
 * Что ночной ход снёс в CORE: сравнение файла до и после. Судим по заголовкам и телам
 * секций, а не по строкам — правка строк это работа ночи, а исчезнувшая секция или
 * опустевшее тело под уцелевшим заголовком (в том числе пользовательские, которых нет
 * в шаблоне) это потеря данных, которую откатывает код (ADR-0002).
 */
export function coreDamage(before: string, after: string): CoreDamage {
  const beforeSections = sectionsOf(before);
  const afterSections = sectionsOf(after);
  const afterHeadings = [...afterSections.keys()];

  // Переименования: заголовок до → достаточно похожий заголовок после. Каждый заголовок
  // после может быть парой только одного пропавшего (жадный по лучшей похожести).
  const renamed = new Map<string, string>();
  const taken = new Set<string>();
  for (const heading of beforeSections.keys()) {
    const match = bestRenameMatch(heading, afterHeadings, taken);
    if (!match) continue;
    renamed.set(heading, match);
    taken.add(match);
  }

  const lostHeadings = [...beforeSections.keys()].filter(
    (heading) => !afterSections.has(heading) && !renamed.has(heading),
  );
  const hollowedHeadings = [...beforeSections.keys()].filter((heading) => {
    const afterName = afterSections.has(heading) ? heading : renamed.get(heading);
    if (afterName === undefined) return false;
    const kept = afterSections.get(afterName);
    return (
      (beforeSections.get(heading) as string).trim() !== "" &&
      kept !== undefined &&
      kept.trim() === ""
    );
  });
  const emptied = before.trim() !== "" && after.trim() === "";
  return {
    lostHeadings,
    hollowedHeadings,
    emptied,
    damaged: lostHeadings.length > 0 || hollowedHeadings.length > 0 || emptied,
  };
}
