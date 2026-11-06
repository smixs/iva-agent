import { modelAuthSuccessLine, modelAuthProvider } from "#lib/model-auth.ts";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { setTimeout as pause } from "node:timers/promises";
import { resolveVaultDir } from "@iva/vault-dir";
import { resolveDataDir } from "#lib/data-dir.ts";
import { resolveTimeZone } from "#lib/timezone.ts";
import { readSettings } from "#lib/settings.ts";
import {
  commitVaultSweep,
  commitVaultWrite,
  vaultGitNotices,
  vaultGitCeiling,
} from "#lib/vault-commit.ts";
import { writeFileAtomicSync as writeAtomic } from "#lib/fs-atomic.ts";
import { imageRefsIn } from "#lib/attachment-ref.ts";
import { SECTION_KIND, setLastDayPointer } from "#lib/core-clamp.ts";
import { coreExcess, textHash, writeCore } from "#lib/core-write.ts";
import { hasUnclosedFence } from "#lib/card-text.ts";
import * as cs from "#lib/card-store.ts";
import * as fm from "#lib/frontmatter.ts";
import * as limits from "#lib/memory-night-constants.ts";
import { underMemoryLock } from "../lib/memory-lock.ts";
import { resolveStopAt } from "../lib/rollup-turn.ts";
import * as attempts from "../lib/rollup-attempts.ts";
import * as notice from "../lib/notice-policy.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";
import * as input from "./night-input.ts";
import type { DayEntry } from "./night-input.ts";

// Ночь (ADR-0016): код ведёт круг день → Card → связи → CORE, модель только судит.
// Каждая запись атомарна и коммитится; кэш дня спасает от второго платного вызова после
// обрыва. Строки факта Job — stderr; Alert и Report — швом Notice.

const root = process.cwd();
const dataDir = resolveDataDir(root, process.env.ASSISTANT_DATA_DIR);
const settings = readSettings(join(dataDir, "settings.json"));
const nightSettings = limits.readNightSettings(join(dataDir, "settings.json"));
if ((settings.memory as { night?: unknown } | undefined)?.night === "off") {
  console.error("memory-night: выключено");
  process.exit(0);
}
const vault = resolveVaultDir(root);
const locked = underMemoryLock(join(root, ".memory.lock"));
if (locked !== null) process.exit(locked);

const ATTEMPTS = join(dataDir, "rollup-attempts.json");
const CACHE_DIR = join(dataDir, "memory", "night");
const CORE_TEMPLATE =
  "# CORE\n\n## Пользователь\n\n## Предпочтения\n\n## Активные цели\n";
const DAY_MS = 86_400_000;
const jobs: string[] = [];
// Card этой ночи для Report: новые и дополненные фактом.
const tally = { created: new Set<string>(), updated: new Set<string>() };
// Alert — парой en/ru: текст на языке владельца, суть для дросселя — английская строка.
const alerts: Array<[string, string]> = [];
let T: notice.Translate = (_english, russian) => russian;
let call!: typeof import("./night-call.ts");
let signal!: AbortSignal;

// ── Схемы ответов: одна форма, терпимые; src — всегда список (строка принимается) ─────
const src = input.srcList;
const text = z.string().min(1);
const list = <T extends z.ZodType>(item: T) => z.array(item).default([]);
const cardType = z.enum(Object.keys(cs.TYPE_DIR) as [string, ...string[]]);
const newCard = z.object({
  name: text,
  type: cardType.catch("note"),
  description: z.string().default(""),
});
const dayAnswer = z.object({
  gist: z.string().default(""),
  topics: list(z.string()),
  points: list(z.object({ text, src })),
  new_cards: list(newCard),
  facts: list(
    z.object({ card: text, text, src, quote: z.string().default("") }),
  ),
  aliases: list(z.object({ card: text, alias: text, src })),
  links: list(z.object({ a: text, b: text, src })),
  core: list(z.object({ text, src })),
});
type DayAnswer = z.infer<typeof dayAnswer>;
type NewCard = z.infer<typeof newCard>;
const nullable = z.string().nullish();
const truthCard = z.object({
  card: text,
  truth: nullable.refine((value) => !value || !cs.compiledTruthError(value), {
    message: "Compiled Truth содержит H1/H2 или незакрытый блок кода",
  }),
  description: nullable,
  status: nullable,
});
type TruthCard = z.infer<typeof truthCard>;
const truthAnswer = z.object({ cards: list(truthCard) });
const coreAnswer = z.object({
  sections: list(z.object({ section: text, text: z.string() })),
});
type CoreAnswer = z.infer<typeof coreAnswer>;

// ── Кэш дня ──────────────────────────────────────────────────────────────────────────
type Candidate = { id: string; text: string; source: string };
/** pre — хеш файла при чтении для B (CAS), post — хеш записанного ночью. */
type Truth = { pre: string; answer?: TruthCard; post?: string; done?: boolean };
interface Pass {
  readonly from: number;
  readonly upto: number;
  /** Хеш выжимки при открытии прохода; null — файла ещё нет. */
  readonly summaryHash?: string | null;
  /** Ответы A по частям дня; выжимка — из последнего. */
  a?: DayAnswer[];
  /** Частичный A отдельно: читатель 0.5.5 видит только полный pass.a. */
  progress?: { inputHash: string; answers: DayAnswer[] };
  /** Имя новой Card → путь: пишется до создания файла, повтор берёт ту же Card. */
  created: Record<string, string>;
  applied?: boolean;
  truth?: string[];
  b: Record<string, Truth>;
}
interface DayCache {
  readonly v: 1;
  readonly date: string;
  through: number;
  prefixHash: string;
  touched: string[];
  core: Candidate[];
  /** Факты неписуемых Card: дописываются, когда Card поправили. */
  pending?: Record<string, string[]>;
  pass?: Pass;
  /** Хеш последней выжимки, записанной ночью; сохраняется и после закрытия дня. */
  writtenSummaryHash?: string;
  completedAt?: string;
}

/** Запись ночи — коммит разрешённых git путей; ignore новых файлов явно виден в
 * журнале шва и не отменяет обработку. false — отказ git, следующая ночь повторит. */
const commit = async (message: string, files: string[]) =>
  (await commitVaultWrite(message, files, vault)).ok;

const cacheFile = (date: string) => join(CACHE_DIR, `${date}.json`);

/** Нет файла — нет кэша; битый или нечитаемый — отказ ночи: в нём ответы и факты. */
function readCache(date: string): DayCache | null {
  const file = cacheFile(date);
  if (!existsSync(file)) return null;
  const broken = `кэш ${date} не читается: ${file}; поправь или удали файл`;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as DayCache | null;
    const valid = value?.v === 1 && value.date === date;
    if (valid && Number.isSafeInteger(value.through)) {
      // 0.5.6 оставлял применённых кандидатов рядом с отдельным флагом.
      const { coreDone, ...cache } = value as DayCache & { coreDone?: boolean };
      return { ...cache, core: coreDone ? [] : cache.core };
    }
  } catch (error) {
    throw new Error(`${broken}: ${String(error)}`, { cause: error });
  }
  throw new Error(broken);
}

function writeCache(cache: DayCache): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeAtomic(cacheFile(cache.date), `${JSON.stringify(cache)}\n`, {
    mode: 0o600,
  });
}

const cacheDates = () =>
  existsSync(CACHE_DIR)
    ? readdirSync(CACHE_DIR).flatMap(
        (name) => /^(\d{4}-\d{2}-\d{2})\.json$/u.exec(name)?.[1] ?? [],
      )
    : [];

// ── Card ─────────────────────────────────────────────────────────────────────────────
interface Card {
  readonly card: string;
  readonly file: string;
  readonly name: string;
  readonly aliases: string[];
  readonly fields: fm.FmFields;
  readonly body: string;
  readonly raw: string;
  readonly parsed: fm.ParsedFrontmatter;
}

const cardFile = (card: string) => join(vault, `${card}.md`);
const str = (fields: fm.FmFields | null | undefined, key: string) =>
  typeof fields?.[key] === "string" ? fields[key] : "";
const logDate = (row: string) =>
  /^- (\d{4}-\d{2}-\d{2}):/u.exec(row)?.[1] ?? "";
const namesOf = (card: Card) =>
  [card.name, basename(card.file, ".md"), ...card.aliases].map(
    cs.normalizeName,
  );
function readCard(card: string): Card | null {
  const file = cardFile(card);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      jobs.push(`${card}: не читается, пропущена: ${String(error)}`);
    return null;
  }
  const parsed = fm.parseFrontmatterOrSkip(raw, file, (row) => jobs.push(row));
  if (!parsed) return null;
  const { body, fields = {} } = parsed;
  const name = cs.extractH1(body) ?? basename(file, ".md");
  const aliases = cs.aliasList(fields?.aliases);
  return { card, file, name, aliases, fields: fields ?? {}, body, raw, parsed };
}

const readCards = () =>
  cs
    .listCardFiles(vault)
    .flatMap((file) => readCard(file.slice(vault.length + 1, -3)) ?? []);

/** Card пишутся под замком дневного write_card (сверка хеша и запись — одна секция). */
const underCardLock = <T>(work: () => Promise<T>) =>
  cs.withCardLock(vault, work);

/** Card, которую ночь может дописать: frontmatter цел, фенсы закрыты, Log один. */
function writable(card: string): Card | null {
  const found = readCard(card);
  if (!found || hasUnclosedFence(found.body)) return null;
  return cs.sectionRows(found.body, "Log") === null ? null : found;
}

/** Факты в Log без повторов (сравнение без даты и указателя). */
function withFacts(body: string, rows: readonly string[]): string {
  const log = cs.sectionRows(body, "Log") ?? [];
  const keys = new Set(log.map(cs.logFactKey));
  const fresh = [...new Set(rows)].filter(
    (row) => !keys.has(cs.logFactKey(row)),
  );
  return fresh.length
    ? cs.replaceH2Sections(body, "Log", [...log, ...fresh])
    : body;
}

// ── Отложенные факты неписуемых Card живут в кэше дня ────────────────────────────
function queuePending(cache: DayCache, card: string, rows: readonly string[]) {
  cache.pending = {
    ...cache.pending,
    [card]: [...(cache.pending?.[card] ?? []), ...rows],
  };
  writeCache(cache);
  alerts.push([
    `Fix Card ${card}: frontmatter, code block or Log; facts are waiting`,
    `Поправь Card ${card}: frontmatter, блок кода или Log; факты ждут`,
  ]);
}

async function applyPending(): Promise<void> {
  for (const cache of cacheDates().flatMap((date) => readCache(date) ?? []))
    await underCardLock(() => applyCachePending(cache));
}

async function applyCachePending(cache: DayCache): Promise<void> {
  for (const [card, rows] of Object.entries(cache.pending ?? {})) {
    const found = writable(card);
    if (!found) {
      alerts.push([
        `Fix Card ${card}: facts are waiting`,
        `Поправь Card ${card}: факты ждут`,
      ]);
      continue;
    }
    const next = fm.renderCardDocument(
      found.parsed,
      found.fields,
      withFacts(found.body, rows),
    );
    if (readIf(found.file) !== found.raw) {
      deferred.add(cache.date);
      jobs.push(`${card}: Card changed after read; pending facts stay cached`);
      continue;
    }
    writeAtomic(found.file, next);
    if (!(await commit(`${card}: pending facts`, [found.file])))
      throw new Error(`${card}: отложенные факты не закоммичены`);
    delete cache.pending![card];
    writeCache(cache);
  }
}

// ── Step 1: день (вызов A) ───────────────────────────────────────────────────────────
const localDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(process.env.ASSISTANT_TIMEZONE),
  }).format(new Date());
const skill = (name: string) =>
  readFileSync(
    join(root, "scripts/memory/instructions/night", `${name}.md`),
    "utf8",
  );
const dailyFile = (date: string) => join(vault, "daily", `${date}.md`);
const summaryFile = (date: string) =>
  join(vault, "summaries/daily", `${date}.md`);
const shift = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

/** Известные Card: совпавшие по имени целиком — подробно; остальные contact, project
 * и свежие decision/idea — коротким индексом. */
function knownFor(cards: readonly Card[], dayText: string, date: string) {
  const haystack = ` ${cs.normalizeName(dayText)} `;
  return cards.flatMap((card) => {
    const type = str(card.fields, "type");
    const short = { card: card.card, type, name: card.name };
    if (namesOf(card).some((n) => n.length >= 3 && haystack.includes(` ${n} `)))
      return {
        ...short,
        aliases: card.aliases,
        description: str(card.fields, "description").slice(0, 160),
        truth: cs.truthOf(card.body).slice(0, 300),
      };
    const fresh = str(card.fields, "created") >= shift(date, -30);
    const active = fresh && str(card.fields, "status") !== "superseded";
    return ["contact", "project"].includes(type) || active ? [short] : [];
  });
}

/** Имя Card из ответа → путь существующей Card или имя новой; `cards/<папка>/<x>` —
 * это Card `<x>`. Неизвестное имя остаётся как есть и отпадает при проверке. */
const CARD_PATH = /^cards\/[^/]+\//u;
function cardName(name: string, cards: Card[], fresh: string[]): string {
  if (cards.some((card) => card.card === name)) return name;
  const key = cs.normalizeName(name.replace(CARD_PATH, ""));
  const made = fresh.find((item) => cs.normalizeName(item) === key);
  const found = cards.filter((card) => namesOf(card).includes(key));
  return made ?? (found.length === 1 ? found[0].card : name);
}

/** Строго только то, без чего запись опасна: Card существует или новая, у факта
 * цитата из реплики владельца (строка Log ведёт на эту реплику). Негодное отбрасывается
 * по одному (строка в факте Job); неизвестные номера реплик отпадают. */
function usable(raw: DayAnswer, entries: DayEntry[], cards: Card[]) {
  const new_cards = raw.new_cards.map((item) => ({
    ...item,
    name: item.name.replace(CARD_PATH, ""),
  }));
  const fresh = new_cards.map((item) => item.name);
  const name = (value: string) => cardName(value, cards, fresh);
  const ref = <T extends { card: string }>(i: T) => ({
    ...i,
    card: name(i.card),
  });
  const answer = {
    ...raw,
    new_cards,
    facts: raw.facts.map(ref),
    aliases: raw.aliases.map(ref),
    links: raw.links.map((l) => ({ ...l, a: name(l.a), b: name(l.b) })),
  };
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const names = new Set([...cards.map((card) => card.card), ...fresh]);
  const said = (ids: string[], quote: string) =>
    ids.find((id) => input.quoteBelongsTo(byId.get(id)!, quote));
  type Item = { src: string[] };
  const keep = <T extends Item>(
    items: T[],
    ok: (item: T) => boolean = () => true,
    ownerOnly = false,
  ) =>
    items.flatMap((item) => {
      const found = {
        ...item,
        src: item.src.filter(
          (id) =>
            byId.has(id) && (!ownerOnly || byId.get(id)?.origin === "owner"),
        ),
      };
      if (found.src.length > 0 && ok(found)) return [found];
      jobs.push(`отброшено: ${JSON.stringify(item)}`);
      return [];
    });
  // Реплика с цитатой — первой: на неё ведёт строка Log.
  const quoted = (f: DayAnswer["facts"][number]) => {
    const at = said(f.src, f.quote);
    if (at) f.src = [at, ...f.src.filter((id) => id !== at)];
    return names.has(f.card) && at !== undefined;
  };
  return {
    ...answer,
    points: keep(answer.points),
    facts: keep(answer.facts, quoted),
    aliases: keep(
      answer.aliases,
      (a) => names.has(a.card) && said(a.src, a.alias) !== undefined,
    ),
    links: keep(answer.links, (l) => names.has(l.a) && names.has(l.b)),
    core: keep(answer.core, undefined, true),
  };
}

/** Ответ A без выжимки при репликах владельца — не по форме (повтор с текстом ошибки). */
function summarized(answer: DayAnswer): void {
  if (!answer.gist.trim() && !answer.points.length)
    throw new Error("нет выжимки дня: нужны gist или points");
}

/** A по частям дня; часть видит выжимку предыдущих и пишет выжимку всего дня. */
async function askDay(
  cache: DayCache,
  day: DayEntry[],
  cards: Card[],
  context: string[],
) {
  const { date, pass } = { date: cache.date, pass: cache.pass! };
  const inputHash = input.canonicalHash(day);
  pass.progress ??= { inputHash, answers: [] };
  if (pass.progress.inputHash !== inputHash)
    throw new OwnerEditConflict(
      `день ${date} изменён во время разбора; прогресс сохранён, день ждёт восстановления входа`,
    );
  const answers = pass.progress.answers;
  const remaining = input
    .splitEntries(day, limits.PART_SIZE)
    .slice(answers.length);
  for (const entries of remaining) {
    const text = [...entries.map((entry) => entry.text), ...context].join("\n");
    const known = knownFor(cards, text, date);
    const earlier_parts = answers.map((answer) => answer.gist);
    const data = { date, entries, known, previous: context[0], earlier_parts };
    const ask = { skill: skill("day"), input: data, schema: dayAnswer, signal };
    let kept!: DayAnswer; // выжимка проверяется после отбрасывания негодного
    const validate = (raw: DayAnswer) =>
      summarized((kept = usable(raw, day, cards)));
    await call.callBySchema({ ...ask, validate });
    answers.push(kept);
    writeCache(cache);
  }
  return answers;
}

// ── Step 2–3: Card и связи ───────────────────────────────────────────────────────────
function mergeAliases(draft: Draft, values: string[]): void {
  const aliases = cs.aliasList(draft.fields.aliases);
  for (const value of values.map((alias) => cs.sanitizeField(alias, 80)))
    if (
      !aliases.map(cs.aliasKey).includes(cs.aliasKey(value)) &&
      aliases.length < cs.ALIASES_MAX
    )
      aliases.push(value);
  if (aliases.length) draft.fields.aliases = aliases;
}
type Draft = {
  file: string;
  fields: fm.FmFields;
  body: string;
  before: string;
  parsed: fm.ParsedFrontmatter;
};

class OwnerEditConflict extends Error {}
const deferred = new Set<string>();

/** Card дня в памяти до записи: читается раз, пишется одним коммитом шага. */
class Day {
  readonly drafts = new Map<string, Draft | null>();
  readonly cards = readCards();
  readonly touched = new Set<string>();
  readonly times: Map<string, string>;
  readonly cache: DayCache;
  constructor(cache: DayCache, entries: DayEntry[]) {
    this.cache = cache;
    this.times = new Map(entries.map((entry) => [entry.id, entry.time]));
  }

  draft(card: string, create?: () => Draft): Draft | null {
    if (!this.drafts.has(card)) {
      const found = writable(card);
      const fresh = create && !existsSync(cardFile(card)) ? create() : null;
      this.drafts.set(card, found ? { ...found, before: found.raw } : fresh);
    }
    return this.drafts.get(card)!;
  }

  write(): string[] {
    return [...this.drafts.values()].flatMap((draft) => {
      const next = draft
        ? fm.renderCardDocument(draft.parsed, draft.fields, draft.body)
        : "";
      if (!draft || next === draft.before) return [];
      mkdirSync(dirname(draft.file), { recursive: true });
      if ((readIf(draft.file) ?? "") !== draft.before)
        throw new OwnerEditConflict(
          `${draft.file}: Card changed after read; cached facts wait for the next night`,
        );
      writeAtomic(draft.file, next);
      draft.before = next;
      return [draft.file];
    });
  }

  /** Путь новой Card: из кэша дня или по свободному имени; занятое имя — `Имя (D)` и
   * Alert. На месте лежит чужой файл — его путь без черновика: файл не затирается, факты
   * ждут в pending под этим путём. */
  newCard(item: NewCard): string {
    const { pass, date } = { pass: this.cache.pass!, date: this.cache.date };
    const key = cs.normalizeName(item.name);
    let name = cs.sanitizeField(item.name, 160);
    const path = (n: string) =>
      `cards/${cs.TYPE_DIR[item.type]}/${cs.slugify(n)}`;
    // Занято: то же имя у Card или по пути новой лежит читаемая Card с другим именем.
    const taken = this.cards.some(
      (card) => namesOf(card).includes(key) || card.card === path(name),
    );
    if (!pass.created[key]) {
      if (taken)
        alerts.push([
          `Looks like a duplicate: ${item.name}. Merge the Cards?`,
          `Похоже на дубль: ${item.name}. Склеить Card?`,
        ]);
      const card = path(taken ? `${name} (${date})` : name);
      if (existsSync(cardFile(card))) return card;
      pass.created[key] = card;
      writeCache(this.cache);
    }
    const card = pass.created[key];
    if (card !== path(name)) name = `${name} (${date})`;
    const [type, source] = [item.type, `daily/${date}.md`];
    const description = cs.sanitizeField(item.description);
    const fields = { type, description, tags: [type], status: "active" };
    Object.assign(fields, { created: date, source });
    const body = `# ${name}\n\n## Log\n\n## Related\n\n## History\n`;
    const file = cardFile(card);
    this.draft(card, () => ({
      file,
      fields,
      body,
      before: "",
      parsed: fm.parseFrontmatter(""),
    }));
    return card;
  }

  cardOf(answer: DayAnswer, name: string): string | null {
    if (this.cards.some((card) => card.card === name)) return name;
    const item = answer.new_cards.find((card) => card.name === name);
    return item ? this.newCard(item) : null;
  }

  /** Факты и алиасы в Card; неписуемая Card — факты в pending и Alert. */
  facts(answer: DayAnswer): void {
    const date = this.cache.date;
    const row = (fact: DayAnswer["facts"][number]) =>
      `- ${date}: ${cs.sanitizeField(fact.text)} · [[daily/${date}]] ${this.times.get(fact.src[0])}`;
    const names = [...answer.facts, ...answer.aliases].map((item) => item.card);
    for (const name of new Set(names)) {
      const rows = answer.facts.filter((f) => f.card === name).map(row);
      const card = this.cardOf(answer, name);
      const draft = card ? this.draft(card) : null;
      if (!draft) {
        if (card && rows.length) queuePending(this.cache, card, rows);
        continue;
      }
      draft.body = withFacts(draft.body, rows);
      const aliases = answer.aliases.filter((item) => item.card === name);
      mergeAliases(
        draft,
        aliases.map((alias) => alias.alias),
      );
      if (rows.length) this.touched.add(card!);
    }
  }

  /** Концы связи: обе Card есть или создаются этой ночью и пишутся; Card ради связи,
   * которая не запишется, не создаётся. */
  ends(answer: DayAnswer, link: { a: string; b: string }) {
    const before = new Set(this.drafts.keys());
    const [a, b] = [this.cardOf(answer, link.a), this.cardOf(answer, link.b)];
    const [da, db] = [a && this.draft(a), b && this.draft(b)];
    if (da && db && a !== b)
      return [
        [da, b!],
        [db, a!],
      ] as const;
    // Отказ: черновики, заведённые только этой проверкой, не пишутся.
    for (const card of this.drafts.keys())
      if (!before.has(card)) this.drafts.delete(card);
    return null;
  }

  /** Связь пишется в Related обеих Card. */
  links(answer: DayAnswer): void {
    for (const link of answer.links) {
      const pairs = this.ends(answer, link);
      if (!pairs) {
        jobs.push(`связь ${link.a} ↔ ${link.b} не записана: Card не пишется`);
        continue;
      }
      for (const [draft, other] of pairs) {
        const related = cs.sectionRows(draft.body, "Related") ?? [];
        if (related.length < limits.RELATED_MAX)
          draft.body = cs.mergeRelated(draft.body, [other]);
        else jobs.push(`${other}: Related заполнен`);
      }
    }
  }
}

/** B получает Card с новым фактом и Card с truth_pending ≤ D. */
function truthCandidates(touched: ReadonlySet<string>, date: string): string[] {
  const due = (card: Card) => {
    const since = str(card.fields, "truth_pending");
    if (str(card.fields, "truth_date") > date) return false; // правда новее дня
    return touched.has(card.card) || (since !== "" && since <= date);
  };
  return readCards()
    .filter(due)
    .map((card) => card.card);
}

async function applyCards(
  cache: DayCache,
  entries: DayEntry[],
): Promise<boolean> {
  const day = new Day(cache, entries);
  for (const answer of cache.pass!.a!) day.facts(answer);
  const files = day.write();
  for (const answer of cache.pass!.a!) day.links(answer);
  files.push(...day.write());
  if (!(await commit(`memory day ${cache.date}: Card`, files))) return false;
  // Новая — любая записанная Card этой ночи (и ради связи), а не только та, где лёг факт.
  const created = new Set(Object.values(cache.pass!.created));
  for (const card of created)
    if (existsSync(cardFile(card))) tally.created.add(card);
  for (const card of day.touched)
    if (!created.has(card)) tally.updated.add(card);
  cache.touched = [...new Set([...cache.touched, ...day.touched])];
  cache.pass!.truth = truthCandidates(day.touched, cache.date);
  return true;
}

// ── Step 2: правда Card (вызов B) ────────────────────────────────────────────────────
/** Card для B: поля frontmatter, правда, хвост Log и факты с truth_pending по день D. */
function truthInput(card: Card, date: string) {
  const log = cs.sectionRows(card.body, "Log") ?? [];
  const since = str(card.fields, "truth_pending") || date;
  const facts = log.filter(
    (row) => logDate(row) >= since && logDate(row) <= date,
  );
  const truth = cs.truthOf(card.body);
  return {
    card: card.card,
    fields: card.fields,
    truth,
    log: log.slice(-10),
    facts,
  };
}

/** Прогон B: день (пишется в кэш дня) или Card с truth_pending без нового дня. */
type TruthRun = {
  readonly date: string;
  readonly pass: Pick<Pass, "truth" | "b">;
  save(): void;
};
/** Card, по которым B уже прошёл этой ночью. */
const judged = new Set<string>();

async function askTruth(run: TruthRun): Promise<void> {
  const { pass, date } = run;
  const waiting = (pass.truth ?? []).filter((card) => !pass.b[card]);
  for (let at = 0; at < waiting.length; at += limits.CARDS_PER_TRUTH_CALL) {
    const batch = waiting
      .slice(at, at + limits.CARDS_PER_TRUTH_CALL)
      .flatMap((card) => readCard(card) ?? []);
    const cards = batch.map((card) => truthInput(card, date));
    const data = { date, statuses: cs.cardStatuses(vault), cards };
    const ask = {
      skill: skill("card"),
      input: data,
      schema: truthAnswer,
      signal,
    };
    let answer: TruthCard[] = [];
    try {
      answer = (await call.callBySchema(ask)).cards;
    } catch (error) {
      if (!(error instanceof call.NightSchemaError)) throw error;
      jobs.push(`${date}: ответ B не по форме, правда ждёт следующей ночи`);
    }
    for (const card of batch)
      pass.b[card.card] = {
        pre: textHash(card.raw),
        answer: answer.find((a) => a.card === card.card),
      };
    run.save();
  }
}

/** Статус из ответа B. Статус, поставленный днём по слову владельца (status_date), ночь
 * того же или более раннего дня не меняет: новое слово о нём приходит только следующими днями.
 * Статус вне schema.json для типа Card не пишется — то же правило, что у write_card днём. */
function nightStatus(card: Card, answer: TruthCard, date: string): string {
  if (!answer.status || str(card.fields, "status_date") >= date) return "";
  // Сверяется точный ответ модели, как у write_card днём; пишется разрешённое схемой значение.
  const allowed = cs.cardStatuses(vault)[str(card.fields, "type")] ?? [
    "active",
  ];
  return allowed.includes(answer.status) ? answer.status : "";
}

/** Card по ответу B: правда и description целиком, прежнее дословно в History. */
function truthApplied(
  card: Card,
  answer: TruthCard,
  date: string,
): string | null {
  const fields: fm.FmFields = { ...card.fields, truth_date: date };
  delete fields.truth_pending;
  let body = card.body;
  const moved: string[] = [];
  if (typeof answer.truth === "string") {
    const next = cs.compiledTruthInput(answer.truth);
    moved.push(...cs.disappearedLines(cs.truthOf(body), next));
    body = cs.withTruth(body, next);
  }
  const before = str(card.fields, "description");
  const description = cs.sanitizeField(answer.description ?? "") || before;
  if (before && description !== before) moved.push(before);
  if (description) fields.description = description;
  const status = nightStatus(card, answer, date);
  if (status) fields.status = status;
  const history = cs.sectionRows(body, "History");
  if (history === null) return null;
  const rows = moved.map(
    (line) => `- ${date}: ${line} (сменено: [[daily/${date}]])`,
  );
  return fm.renderCardDocument(
    card.parsed,
    fields,
    rows.length
      ? cs.replaceH2Sections(body, "History", [...history, ...rows])
      : body,
    ["truth_pending"],
  );
}

/** CAS: файл тот же, что при чтении для B, — правка целиком. Иначе правка человека
 * побеждает: ответ стирается, Card получает truth_pending, B — следующей ночью. */
function applyTruthCard(run: TruthRun, card: string, entry: Truth) {
  const current = readCard(card);
  const hash = current ? textHash(current.raw) : "";
  if (entry.done || hash === entry.post) return null;
  const answer = hash === entry.pre ? entry.answer : undefined;
  const next = answer ? truthApplied(current!, answer, run.date) : null;
  if (next === null) return giveUp(run, card, entry, current);
  entry.post = textHash(next);
  run.save();
  if (next === current!.raw) return null;
  const latest = readCard(card);
  if (!latest || textHash(latest.raw) !== hash)
    return giveUp(run, card, entry, latest);
  writeAtomic(latest.file, next);
  return current!.file;
}

/** Ответ не применим (правка человека, неоднозначная History, нет ответа): ответ
 * стирается, Card получает truth_pending. */
function giveUp(
  run: TruthRun,
  card: string,
  entry: Truth,
  current: Card | null,
) {
  if (!current || textHash(current.raw) !== entry.pre)
    alerts.push([
      `${card}: Compiled Truth was changed by a person; the night did not overwrite it`,
      `${card}: Compiled Truth изменён человеком, ночь его не перетёрла`,
    ]);
  delete entry.answer;
  entry.done = true;
  run.save();
  const latest = readCard(card);
  const pending = str(latest?.fields, "truth_pending");
  if (!latest || (pending && pending <= run.date)) return null;
  const fields = { ...latest.fields, truth_pending: run.date };
  writeAtomic(
    latest.file,
    fm.renderCardDocument(latest.parsed, fields, latest.body),
  );
  return latest.file;
}

/** B, затем CAS и запись под замком дневных писателей. */
async function applyTruth(run: TruthRun): Promise<boolean> {
  await askTruth(run);
  const entries = Object.entries(run.pass.b);
  entries.forEach(([card]) => judged.add(card));
  return await underCardLock(async () => {
    const files = entries.flatMap(
      ([card, entry]) => applyTruthCard(run, card, entry) ?? [],
    );
    const message = `memory day ${run.date}: Compiled Truth`;
    if (!(await commit(message, files))) return false;
    for (const [, entry] of entries) entry.done = true;
    run.save();
    return true;
  });
}

/** Card с truth_pending: B каждой ночью по вчерашний день, что бы ни осталось в очереди
 * (старые дни потом — только в Log). Правда, ждущая дольше трёх ночей, — Alert (по полю,
 * без своего состояния). */
async function retryTruth(today: string): Promise<void> {
  const cards = readCards().filter(
    (card) => str(card.fields, "truth_pending") && !judged.has(card.card),
  );
  for (const card of cards) {
    const since = str(card.fields, "truth_pending");
    if (since < shift(today, -3))
      alerts.push([
        `${card.card}: the truth has been waiting since ${since}; step B did not manage it`,
        `${card.card}: правда ждёт с ${since}; B не справился`,
      ]);
  }
  if (!cards.length) return;
  const pass = { truth: cards.map((card) => card.card), b: {} };
  const run = { date: shift(today, -1), pass, save: () => {} };
  try {
    if (!(await applyTruth(run))) jobs.push("правда Card не закоммичена");
  } catch (error) {
    if (!(error instanceof call.NightCeilingError)) throw error;
    jobs.push("правда Card ждёт: предел ночи");
  }
}

// ── Выжимка дня: пишется последней, вместе с отметкой конца в сыром дне ─────────────
function summaryOf(cache: DayCache, entries: DayEntry[], raw: string): string {
  const { date, pass } = { date: cache.date, pass: cache.pass! };
  const last = pass.a!.at(-1);
  const time = new Map(entries.map((entry) => [entry.id, entry.time]));
  const at = (src: string[]) => src.map((id) => time.get(id)).join(", ");
  const points = (last?.points ?? []).map(
    (point) => `- ${point.text} · [[daily/${date}]] ${at(point.src)}`,
  );
  const cards = cache.touched.map((card) => `- [[${card}]]`);
  const files = [...new Set(imageRefsIn(raw))].map((path) => `- [[${path}]]`);
  const attached = files.length ? ["", "## Вложения", "", ...files] : [];
  const listed = cards.length ? cards : ["- Нет"];
  const body = [`# ${date}`, "", ...points, "", "## Карточки дня", ""];
  const inputs = entries.slice(pass.from, pass.upto);
  const topics = last?.topics ?? [];
  const fields = {
    type: "daily-summary",
    date,
    description: last?.gist || `Нет своих реплик за ${date}`,
    topics,
    tags: topics.length ? topics : ["daily"],
    input_hash: input.stepHash("A", call.nightModelName, skill("day"), inputs),
  };
  const text = [...body, ...listed, ...attached, ""].join("\n");
  return input.summaryText(fields, text);
}

async function finishDay(
  cache: DayCache,
  entries: DayEntry[],
  raw: string,
  expectedSummary: string | null,
) {
  const { date, pass } = { date: cache.date, pass: cache.pass! };
  const [summary, daily] = [summaryFile(date), dailyFile(date)];
  mkdirSync(dirname(summary), { recursive: true });
  const nextSummary = summaryOf(cache, entries, raw);
  const currentSummary = readIf(summary);
  // Сверяем с опубликованной выжимкой, даже если вход или модель ночи сменились.
  if (
    currentSummary !== nextSummary &&
    (summaryHashOf(currentSummary) !==
      (cache.writtenSummaryHash ?? expectedSummary) ||
      (cache.writtenSummaryHash === undefined &&
        currentSummary !== null &&
        (cache.completedAt !== undefined ||
          input.summaryEdited(currentSummary))))
  )
    throw new OwnerEditConflict(
      `выжимка ${date} изменена вручную; день ждёт владельца: верни выжимку или выполни iva jobs skip memory-night ${date}`,
    );
  writeAtomic(summary, nextSummary);
  cache.writtenSummaryHash = textHash(nextSummary);
  writeCache(cache);
  // Совместимая отметка конца дня: старая ночь после отката не переразбирает день.
  const shim = `\n<!-- processed: memory-night ${date} -->\n`;
  if (!input.markedDone(readFileSync(daily, "utf8")))
    appendFileSync(daily, shim);
  if (!(await commit(`memory day ${date}: ready`, [summary, daily])))
    return false;
  const time = new Map(entries.map((entry) => [entry.id, entry.time]));
  pass
    .a!.flatMap((answer) => answer.core)
    .forEach((item, index) => {
      const id = `${date}:${pass.from}:${index + 1}`;
      const source = `[[daily/${date}]] ${time.get(item.src[0])}`;
      cache.core.push({ id, text: item.text, source });
    });
  cache.through = pass.upto;
  cache.prefixHash = input.prefixHash(entries, pass.upto);
  cache.completedAt = new Date().toISOString();
  delete cache.pass;
  writeCache(cache);
  attempts.clearDay(ATTEMPTS, date);
  return true;
}

// ── День целиком ─────────────────────────────────────────────────────────────────────
function openPass(
  date: string,
  entries: DayEntry[],
  summaryHash: string | null,
): DayCache | null {
  const cache = readCache(date);
  if (cache?.pass) return cache;
  if (cache && entries.length <= cache.through) return null;
  const base = cache ?? {
    ...{ v: 1 as const, date, through: 0, touched: [], core: [] },
    prefixHash: input.prefixHash(entries, 0),
  };
  const from = base.through;
  const pass = { from, upto: entries.length, summaryHash, created: {}, b: {} };
  const next: DayCache = { ...base, pass };
  // Кэш пишется до вызова: не пишется — вызова нет (иначе обрыв дал бы второй вызов).
  writeCache(next);
  return next;
}

function fail(row: string): false {
  jobs.push(row);
  return false;
}

const readIf = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8") : null;

const summaryHashOf = (summary: string | null) =>
  summary === null ? null : textHash(summary);

function gistOf(date: string): string {
  const text = readIf(summaryFile(date));
  const fields =
    text === null
      ? null
      : fm.parseFrontmatterOrSkip(text, summaryFile(date))?.fields;
  return str(fields, "description");
}

/** Вызов A для прохода дня; поздний хвост видит выжимку дня и тронутые днём Card. */
async function askPass(cache: DayCache, entries: DayEntry[]) {
  const pass = cache.pass!;
  const part = entries.slice(pass.from, pass.upto);
  if (!pass.progress && !part.some((entry) => entry.origin === "owner"))
    return [];
  const cards = readCards();
  const seen = cards.filter((card) => cache.touched.includes(card.card));
  const context = [
    pass.from ? gistOf(cache.date) : "",
    ...seen.map((c) => c.name),
  ];
  return await askDay(cache, part, cards, context);
}

async function processDay(date: string): Promise<boolean> {
  const raw = readIf(dailyFile(date));
  if (raw === null) return !fail(`${date}: нет данных`);
  const summaryHash = summaryHashOf(readIf(summaryFile(date)));
  const entries = input.parseDay(raw);
  const cache = openPass(date, entries, summaryHash);
  if (!cache?.pass) return true;
  cache.pass.a ??= await askPass(cache, entries);
  delete cache.pass.progress;
  writeCache(cache);
  const cards = () => applyCards(cache, entries);
  if (!cache.pass.applied && !(await underCardLock(cards)))
    return fail(`${date}: Card не закоммичены`);
  cache.pass.applied = true;
  writeCache(cache);
  const save = () => writeCache(cache);
  if (!(await applyTruth({ date, pass: cache.pass, save })))
    return fail(`${date}: правда не закоммичена`);
  const expectedSummary =
    cache.pass.summaryHash === undefined ? summaryHash : cache.pass.summaryHash;
  if (await finishDay(cache, entries, raw, expectedSummary)) return true;
  return fail(`${date}: выжимка не закоммичена`);
}

/** Нужен ли дню разбор. Выжимка без body_hash (старая ночь) — день готов: граница
 * перехода; правленая руками — не трогается. */
function dayTodo(date: string): boolean {
  const raw = readFileSync(dailyFile(date), "utf8");
  const cache = readCache(date);
  const entries = input.parseDay(raw);
  if (/<!-- processed: skipped by owner\b[^\r\n]*-->\s*$/u.test(raw))
    return false;
  if (cache?.pass) return true;
  if (cache && input.prefixHash(entries, cache.through) !== cache.prefixHash)
    return fail(
      `день ${date} изменён после разбора; удали ${cacheFile(date)} и запусти ночь за ${date}`,
    );
  const summary = readIf(summaryFile(date));
  if (summary !== null && input.summaryEdited(summary))
    return fail(
      `выжимка ${date} изменена вручную; день не разбирается: верни body_hash или выполни iva jobs skip memory-night ${date}`,
    );
  if (cache) return entries.length > cache.through;
  return summary === null && !input.markedDone(raw);
}

function dayQueue(today: string): string[] {
  const tried = attempts.readAttempts(ATTEMPTS);
  const dir = join(vault, "daily");
  const dates = existsSync(dir) ? readdirSync(dir) : [];
  return dates
    .flatMap((name) => /^(\d{4}-\d{2}-\d{2})\.md$/u.exec(name)?.[1] ?? [])
    .filter((date) => date < today && !attempts.isExhausted(tried[date]))
    .sort()
    .filter(dayTodo);
}

// ── Step 4: CORE (вызов C) ───────────────────────────────────────────────────────────
/** Ночью меняются только разделы шаблона CORE; разделы владельца и указатели — нет. */
const editable = (head: string) =>
  ["user", "preferences", "goals"].includes(
    SECTION_KIND.get(head.slice(3).trim()) ?? "",
  );
const coreParts = (core: string) => core.split(/^(?=## )/mu);

function coreSections(core: string): Record<string, string> {
  const parts = coreParts(core).map((part) => part.split("\n"));
  const kept = parts.filter(
    ([head]) => head.startsWith("## ") && editable(head),
  );
  return Object.fromEntries(
    kept.map(([head, ...rows]) => [
      head.slice(3).trim(),
      rows.filter((row) => row.trim()).join("\n"),
    ]),
  );
}

/** CORE с разделами из ответа C целиком; длина сверх лимита — повтор с «освободи N». */
function coreApplied(before: string, answer: CoreAnswer): string {
  const next = coreParts(before).map((part) => {
    const head = part.split("\n", 1)[0];
    const text = answer.sections.find(
      (item) => `## ${item.section}` === head.trim(),
    )?.text;
    if (text === undefined || !editable(head)) return part;
    const rows = text
      .split("\n")
      .filter((row) => row.trim() && !row.startsWith("#"));
    return `${head}\n\n${rows.map((row) => `${row}\n`).join("")}\n`;
  });
  const excess = coreExcess(before, next.join(""), "night");
  if (excess > 0)
    throw new Error(`CORE длиннее лимита: освободи ${excess} знаков`);
  return next.join("");
}

/** Ответ C, применённый к CORE; null — отказ формы или Ceiling, кандидаты ждут. */
async function askCore(before: string, candidates: Candidate[]) {
  const data = { sections: coreSections(before), candidates };
  const validate = (value: CoreAnswer) => void coreApplied(before, value);
  const ask = {
    skill: skill("core"),
    input: data,
    schema: coreAnswer,
    signal,
    validate,
  };
  try {
    return coreApplied(before, await call.callBySchema(ask));
  } catch (error) {
    const known =
      error instanceof call.NightSchemaError ||
      error instanceof call.NightCeilingError;
    if (!known) throw error;
    alerts.push([
      `CORE was not updated, the candidates wait for the next night: ${error.message}`,
      `CORE не обновлён, кандидаты ждут следующей ночи: ${error.message}`,
    ]);
    return null;
  }
}

/** Дни с кандидатами CORE, ещё не применёнными. */
const coreWaiting = () =>
  cacheDates()
    .flatMap((date) => readCache(date) ?? [])
    .filter((cache) => !cache.pass && cache.core.length);

async function runCore(lastDay: string | undefined): Promise<void> {
  const waiting = coreWaiting();
  const before = readIf(join(vault, "CORE.md")) ?? "";
  const base = before || CORE_TEMPLATE;
  const candidates = waiting.flatMap((cache) => cache.core);
  const asked = candidates.length ? await askCore(base, candidates) : null;
  const written = await writeNightCore(before, asked ?? base, lastDay);
  if (!written || asked === null) return;
  for (const cache of waiting) writeCache({ ...cache, core: [] });
}

/** CORE ночи с указателем «Последний день»; пустой шаблон без правок не создаётся. */
async function writeNightCore(before: string, draft: string, lastDay?: string) {
  const next = lastDay ? setLastDayPointer(draft, lastDay) : draft;
  if (next === CORE_TEMPLATE) return false;
  const date = lastDay ?? localDate();
  const reason = `night ${date}`;
  const expectedHash = textHash(before);
  const result = await writeCore({
    vault,
    next,
    reason,
    date,
    expectedHash,
    mode: "night",
  });
  if (!result.ok) jobs.push(`CORE не записан: ${result.error}`);
  return result.ok;
}

// ── Alert и Report — существующим швом Notice (дроссель alertDue, Outbox) ───────────
function telegram() {
  const [bot, chat] = [process.env.TELEGRAM_BOT_TOKEN, notificationChat()];
  return bot && chat
    ? (body: string) =>
        sendTelegramHtml(bot, chat, body, { trace: { source: "rollup" } })
    : null;
}

/** essence — стабильный факт: язык и счётчик поднятий не делают проблему новой. */
async function notify(
  key: string,
  english: string,
  russian: string,
  essence = english,
) {
  const [send, body] = [telegram(), T(english, russian)];
  await notice.alertOnce(dataDir, key, essence, async () => {
    const sent = send ? await send(body) : { ok: false, error: "нет чата" };
    if (!sent.ok)
      console.error(`memory-night alert ${key}: ${body} (${sent.error})`);
    return sent.ok;
  });
}

async function report(done: readonly string[], failedDays: number) {
  const send = telegram();
  const text =
    notice.nightReport(T, {
      days: done.map((date) => ({ date, gist: gistOf(date) })),
      created: tally.created.size,
      updated: [...tally.updated].filter((card) => !tally.created.has(card))
        .length,
      failedDays,
      problems: jobs.length > 0,
    }) + recoveryText();
  const delivery = await notice.deliverMemoryReport({
    dataDir,
    settings,
    ranBefore: notice.rollupRanBefore(dataDir, vault),
    report: text,
    tr: T,
    send: send ? { report: send, notice: send } : null,
  });
  if (delivery.status === "failed")
    console.error(`memory-night: Report: ${delivery.error}\n${text}`);
}

const recoveryNotices = () => [
  ...vaultGitNotices,
  ...(call?.nightCeiling.notices ?? []),
];
const recoveryText = () =>
  recoveryNotices().length
    ? `\n\n${recoveryNotices()
        .map((pair) => T(...pair))
        .join("\n")}`
    : "";

async function ceilingAlerts() {
  for (const key of call?.nightCeiling.blocked ?? []) {
    const state = call.nightCeiling;
    const atMax = state.limits[key] === state.limits[limits.NIGHT_MAX[key]];
    const command = `iva night set ${atMax ? limits.NIGHT_MAX[key] : "raisesPerNight"}`;
    const [en, ru] = limits.nightLimitName(key);
    await notify(
      `night-ceiling-${key}`,
      `Night memory reached its ${en} limit = ${state.limits[key]}; raised limits ${state.raises} time(s). Raise the ceiling with ${command} VALUE or shorten the days.`,
      `Ночь памяти упёрлась в предел ${ru} = ${state.limits[key]}; поднимала пределы ${state.raises} раз. Подними потолок командой ${command} ЧИСЛО или сократи дни.`,
      `night ceiling ${key} = ${state.limits[key]}`,
    );
  }
  if (vaultGitCeiling) {
    const { value, raises, atMax } = vaultGitCeiling;
    const command = `iva night set ${atMax ? "maxGitTimeoutMs" : "raisesPerNight"}`;
    await notify(
      "night-ceiling-git",
      `Night memory reached the git wait limit = ${value} ms; raised it ${raises} time(s). Raise the ceiling with ${command} VALUE or shorten the days.`,
      `Ночь памяти упёрлась в предел ожидания git = ${value} мс; поднимала его ${raises} раз. Подними потолок командой ${command} ЧИСЛО или сократи дни.`,
      `night ceiling gitTimeoutMs = ${value}`,
    );
  }
}

/** Вчера нет сырого дня, а в usage.jsonl есть ходы чата — транскрипт не записался. */
function transcriptLost(today: string): string {
  const [day, usage] = [shift(today, -1), join(dataDir, "usage.jsonl")];
  if (existsSync(dailyFile(day)) || !existsSync(usage)) return "";
  const chat = (row: string) => !row.includes('"source":"memory-night"');
  const rows = readFileSync(usage, "utf8").split("\n");
  return rows.some((row) => row.includes(`"ts":"${day}`) && chat(row))
    ? day
    : "";
}

async function alertsAtEnd(today: string, left: string[], fallbacks: string[]) {
  const tried = attempts.readAttempts(ATTEMPTS);
  const paused = Object.keys(tried).filter((d) =>
    attempts.isExhausted(tried[d]),
  );
  const old = left.filter((date) => date < shift(today, -7));
  const lost = transcriptLost(today);
  const pausedText = (tr: notice.Translate) =>
    attempts.dayPausedAlert(tr, paused, tried);
  const english: notice.Translate = (en) => en;
  const russian: notice.Translate = (_en, ru) => ru;
  const pending = (tr: notice.Translate) =>
    alerts.map((pair) => tr(...pair)).join("\n");
  const all: Array<[string, unknown, string, string]> = [
    [
      attempts.DAY_PAUSED_ALERT_KEY,
      paused.length,
      pausedText(english),
      pausedText(russian),
    ],
    [
      "night-fallback",
      fallbacks.length,
      `Periods built without the model: ${fallbacks.join(", ")}`,
      `Периоды собраны без модели: ${fallbacks.join(", ")}`,
    ],
    ["night-pending", alerts.length, pending(english), pending(russian)],
    [
      "night-tail",
      old.length,
      `The night queue holds days older than 7 days: ${old.join(", ")}. Check iva jobs. To release a day, run iva jobs skip memory-night <date> or restore its summary.`,
      `Очередь ночи старше 7 дней: ${old.join(", ")}. Проверь iva jobs. Чтобы освободить день, выполни iva jobs skip memory-night <дата> или верни выжимку.`,
    ],
    [
      "night-transcript",
      lost,
      `There is no raw day for ${lost}, although the chat worked. Check vault/daily.`,
      `За ${lost} нет сырого дня, хотя чат работал. Проверь vault/daily.`,
    ],
  ];
  for (const [key, due, en, ru] of all) if (due) await notify(key, en, ru);
}

// ── Ночь ─────────────────────────────────────────────────────────────────────────────
function cleanupCaches(): void {
  for (const cache of cacheDates().flatMap((date) => readCache(date) ?? [])) {
    const age = Date.now() - Date.parse(cache.completedAt ?? "");
    const pending = Object.keys(cache.pending ?? {}).length;
    const waiting = cache.pass || pending || cache.core.length;
    if (waiting || !(age >= limits.CACHE_DAYS * DAY_MS)) continue;
    try {
      rmSync(cacheFile(cache.date));
    } catch (error) {
      jobs.push(`кэш ${cache.date} не очищен: ${String(error)}`);
    }
  }
}

const attemptDay = (date: string, reason: attempts.AttemptReason) =>
  attempts.addAttempt(ATTEMPTS, date, reason, new Date().toISOString());

async function processDayWithAttempts(date: string): Promise<boolean> {
  for (let reconnect = 0; ; reconnect++) {
    try {
      const complete = await processDay(date);
      if (!complete) attemptDay(date, "day-unfinished");
      return complete;
    } catch (error) {
      if (!(error instanceof call.NightTransientError)) throw error;
      const delay = [5_000, 30_000, 120_000][Math.min(reconnect, 2)];
      jobs.push(
        `${date}: связь с моделью оборвалась; продолжаю через ${delay / 1_000} с`,
      );
      await pause(delay, undefined, { signal });
    }
  }
}

async function runDays(dates: readonly string[]) {
  const done: string[] = [];
  let code = 0;
  for (const date of dates.filter((date) => !deferred.has(date))) {
    try {
      if (!(await processDayWithAttempts(date))) return { done, code: 1 };
      done.push(date);
    } catch (error) {
      if (error instanceof OwnerEditConflict) {
        jobs.push(`${date}: ${error.message}`);
        continue;
      }
      if (error instanceof call.NightCeilingError) {
        console.error(`memory-night: обрез пределом ночи на ${date}`);
        return { done, code: 1 };
      }
      if (!(error instanceof call.NightSchemaError)) throw error;
      code = 1;
      attemptDay(date, "no-report");
      jobs.push(`${date}: ответ A не по форме после повтора: ${error.message}`);
    }
  }
  return { done, code };
}

/** У потолка отказ сообщает ceilingAlerts; обычный отказ sweep сохраняет свой Alert. */
async function failSweep(reason: string): Promise<never> {
  const why = `vault не закоммичен до ночи: ${reason}`;
  if (!vaultGitCeiling)
    await notify(
      "night-sweep",
      `Night memory did not start: the vault is not committed before the night: ${reason}${recoveryText()}`,
      `Ночь памяти не началась: ${why}${recoveryText()}`,
      `night sweep: ${reason}`,
    );
  throw new Error(why);
}

async function night(manual: string | undefined): Promise<number> {
  T = await notice.noticeTranslator();
  for (const invalid of nightSettings.invalid)
    jobs.push(
      T(
        `Night settings: ${invalid}; using defaults.`,
        `Настройки ночи: ${invalid}; применены значения по умолчанию.`,
      ),
    );
  const sweep = await commitVaultSweep("memory-night: до ночи", vault);
  if (!sweep.ok) await failSweep(sweep.reason);
  try {
    call = await import("./night-call.ts");
    Object.assign(call.nightCeiling.limits, nightSettings.values);
  } catch (error) {
    await notify(
      "night-model",
      `Night memory cannot start the model: ${String(error)}`,
      `Ночная память не запускает модель: ${String(error)}`,
    );
    throw error;
  }
  const { buildReadyPeriods } = await import("./night-periods.ts");
  await applyPending();
  const today = localDate();
  const ask = { skill: skill("period"), model: call.nightModelName, signal };
  const paused = () => {
    const tried = attempts.readAttempts(ATTEMPTS);
    return new Set(
      Object.keys(tried).filter((d) => attempts.isExhausted(tried[d])),
    );
  };
  const periods = async (): Promise<string[]> =>
    manual
      ? []
      : buildReadyPeriods(vault, today, { ...ask, paused: paused() }, jobs);
  const fallbacks = await periods();
  const tried = attempts.readAttempts(ATTEMPTS);
  const queue = manual
    ? [manual]
    : dayQueue(today).slice(0, limits.DAYS_PER_NIGHT);
  const ready = queue.filter((date) => !attempts.isExhausted(tried[date]));
  const { done, code } = await runDays(ready);
  const queueLeft = dayQueue(today);
  await retryTruth(today);
  await runCore(done.at(-1));
  fallbacks.push(...(await periods()));
  cleanupCaches();
  await alertsAtEnd(today, queueLeft, fallbacks);
  const recovered = recoveryNotices();
  if (recovered.length) {
    const summary = [
      `Night memory: ${done.length} day(s) folded, ${queueLeft.length} queued; raised model limits ${call.nightCeiling.raises} time(s).`,
      `Ночь памяти: свёрнуто дней ${done.length}, в очереди ${queueLeft.length}; пределы модели поднимала ${call.nightCeiling.raises} раз.`,
    ] as const;
    call.nightCeiling.notices.push(summary);
  }
  if (done.length || recovered.length)
    await report(done, ready.length - done.length);
  const { calls, inputTokens, unknownUsage, usageLost } = call.ceiling;
  if (usageLost) jobs.push(`usage.jsonl не записан: ${usageLost}`);
  const usage = `${calls} call(s), ${inputTokens} input tokens`;
  const unknown = unknownUsage
    ? T(
        ", provider did not return usage (usage unknown)",
        ", провайдер не отдал usage (usage unknown)",
      )
    : "";
  console.error(`memory-night: ${done.length} day(s), ${usage}${unknown}`);
  return code;
}

function reportModelAuthSuccess(): void {
  if (call?.modelSuccessAt !== undefined)
    console.error(
      modelAuthSuccessLine(modelAuthProvider(), call.modelSuccessAt),
    );
}

async function main(): Promise<number> {
  const manual = process.argv[2];
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(manual ?? "") ? manual : "";
  if (manual !== undefined && (!date || shift(date, 0) !== date)) {
    console.error("Usage: night.ts [YYYY-MM-DD]");
    return 1;
  }
  const controller = new AbortController();
  signal = controller.signal;
  const stopAt = resolveStopAt(process.env.IVA_JOB_STOP_AT, Date.now());
  const stop = () => controller.abort(new Error("memory-night deadline"));
  const timer = setTimeout(stop, Math.max(1, stopAt - Date.now()));
  try {
    return await night(manual);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`memory-night: ${message}`);
    return 1;
  } finally {
    clearTimeout(timer);
    await ceilingAlerts();
    for (const pair of recoveryNotices()) jobs.push(T(...pair));
    for (const row of jobs) console.error(`memory-night: ${row}`);
    reportModelAuthSuccess();
  }
}

process.exitCode = await main();
