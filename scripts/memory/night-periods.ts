import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { weekOfDay } from "#lib/vault-links.ts";
import { commitVaultWrite } from "#lib/vault-commit.ts";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";
import { parseFrontmatterOrSkip } from "#lib/frontmatter.ts";
import * as input from "./night-input.ts";
import {
  callBySchema,
  NightCeilingError,
  NightSchemaError,
} from "./night-call.ts";

// Неделя, месяц (календарный), год: один вызов на период, когда он кончился и готов
// каждый ребёнок. Ответ не по форме — выжимка из description детей (mode: fallback),
// следующая ночь пересобирает её моделью; изменённый вход детей — тоже.

type Period = "weekly" | "monthly" | "yearly";
type Child = { id: string; path?: string };
const periodAnswer = z.object({
  gist: z.string().default(""),
  topics: z.array(z.string()).default([]),
  points: z
    .array(z.object({ text: z.string().min(1), src: input.srcList }))
    .default([]),
});

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const pad = (value: number) => String(value).padStart(2, "0");

/** Дни ребёнка: неделя `YYYY-Www`, месяц `YYYY-MM` или сам день. */
function daysOf(id: string): string[] {
  const week = /^(\d{4})-W(\d{2})$/u.exec(id);
  if (week) {
    const jan4 = Date.UTC(Number(week[1]), 0, 4);
    const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
    const start = monday + (Number(week[2]) - 1) * 7 * DAY_MS;
    return Array.from({ length: 7 }, (_, index) => iso(start + index * DAY_MS));
  }
  if (id.length !== 7) return [id];
  const [year, month] = id.split("-").map(Number);
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => `${id}-${pad(index + 1)}`);
}

/** Дети периода: дни недели; недели, целиком лежащие в месяце, и краевые дни; месяцы. */
export function periodChildIds(period: Period, id: string): string[] {
  if (period === "weekly") return daysOf(id);
  if (period === "yearly")
    return Array.from({ length: 12 }, (_, i) => `${id}-${pad(i + 1)}`);
  const weeks = new Map<string, string[]>();
  for (const day of daysOf(id))
    weeks.set(weekOfDay(day)!, [...(weeks.get(weekOfDay(day)!) ?? []), day]);
  return [...weeks].flatMap(([week, days]) =>
    days.length === 7 ? [week] : days,
  );
}

/** День с данными: есть выжимка или ночь его ещё разберёт. Закрытый без выжимки —
 * отметка в хвосте (iva jobs skip) или пауза после трёх попыток — данных не даст. */
function dayHasData(vault: string, day: string, paused: ReadonlySet<string>) {
  if (existsSync(join(vault, "summaries/daily", `${day}.md`))) return true;
  const raw = join(vault, "daily", `${day}.md`);
  if (!existsSync(raw) || paused.has(day)) return false;
  return !input.markedDone(readFileSync(raw, "utf8"));
}

/** Готовые дети или null. Ребёнок без файла, у которого ни один день не даст данных
 * (нет сырого дня, день закрыт или на паузе), — «нет данных». */
export function periodChildren(
  vault: string,
  period: Period,
  id: string,
  paused: ReadonlySet<string> = new Set(),
): Child[] | null {
  const children: Child[] = [];
  for (const child of periodChildIds(period, id)) {
    const path = child.includes("W")
      ? `weekly/${child}`
      : child.length === 7
        ? `monthly/${child}`
        : `summaries/daily/${child}`;
    if (existsSync(join(vault, `${path}.md`)))
      children.push({ id: child, path });
    else if (daysOf(child).some((day) => dayHasData(vault, day, paused)))
      return null;
    else children.push({ id: child });
  }
  return children.some((child) => child.path) ? children : null;
}

function summaryOf(vault: string, child: Child): string {
  const file = join(vault, `${child.path}.md`);
  const fields = child.path
    ? parseFrontmatterOrSkip(readFileSync(file, "utf8"), file)?.fields
    : null;
  return typeof fields?.description === "string" ? fields.description : "";
}

/** paused — дни на паузе после трёх попыток: выжимки у них не будет. */
/** Вход ребёнка для хеша родителя: input_hash файла ночи, иначе сам файл. Поздняя
 * выжимка дня меняет вход недели, а за ней месяца и года при прежнем description. */
function childInput(vault: string, child: Child): string {
  if (!child.path) return "";
  const file = join(vault, `${child.path}.md`);
  const text = readFileSync(file, "utf8");
  const hash = parseFrontmatterOrSkip(text, file)?.fields?.input_hash;
  if (typeof hash === "string") return hash;
  return createHash("sha256").update(text).digest("hex");
}

type Ask = {
  skill: string;
  model: string;
  signal: AbortSignal;
  paused: ReadonlySet<string>;
};

/** Собирать ли: файла нет; или файл ночи (body_hash) с другим входом или fallback.
 * Правленый владельцем не трогается (строка Job); без body_hash — старая ночь, готов. */
function due(file: string, hash: string, jobs: string[], label: string) {
  if (!existsSync(file)) return true;
  const text = readFileSync(file, "utf8");
  const fields = parseFrontmatterOrSkip(text, file)?.fields;
  if (typeof fields?.body_hash !== "string") return false;
  if (!input.summaryEdited(text))
    return fields.input_hash !== hash || fields.mode === "fallback";
  jobs.push(`${label} изменён вручную; период не пересобирается`);
  return false;
}

async function buildPeriod(
  vault: string,
  [period, id]: [Period, string],
  ask: Ask,
  jobs: string[],
) {
  const file = join(vault, period, `${id}.md`);
  const children = periodChildren(vault, period, id, ask.paused);
  if (!children) return null;
  const values = children.map((child) => ({
    id: child.id,
    missing: !child.path,
    summary: summaryOf(vault, child),
  }));
  const inputs = children.map((child) => childInput(vault, child));
  const hash = input.stepHash(period, ask.model, ask.skill, [values, inputs]);
  const expected = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (!due(file, hash, jobs, `${period} ${id}`)) return null;
  let answer: z.infer<typeof periodAnswer>;
  let fallback = false;
  try {
    const input = { period, id, children: values };
    answer = await callBySchema({
      skill: ask.skill,
      input,
      schema: periodAnswer,
      signal: ask.signal,
    });
  } catch (error) {
    if (!(error instanceof NightSchemaError)) throw error;
    fallback = true;
    const text = (value: (typeof values)[number]) =>
      value.summary || `Нет данных за ${value.id}`;
    answer = {
      gist: "",
      topics: [],
      points: values.map((value) => ({ text: text(value), src: [value.id] })),
    };
  }
  const paths = new Map(children.map((child) => [child.id, child.path]));
  const points = answer.points.map((point) => {
    const links = point.src.flatMap((src) =>
      paths.get(src) ? [`[[${paths.get(src)}]]`] : [],
    );
    return `- ${point.text}${links.length ? ` · ${links.join(", ")}` : ""}`;
  });
  const down = children.map((child) =>
    child.path ? `- [[${child.path}]]` : `- нет данных за ${child.id}`,
  );
  const body = [
    `# ${id}`,
    "",
    ...points,
    "",
    "## Период",
    "",
    ...down,
    "",
  ].join("\n");
  const fields = {
    type: `${period}-summary`,
    period: id,
    description: answer.gist || id,
    topics: answer.topics,
    tags: answer.topics.length ? answer.topics : [period],
    input_hash: hash,
    ...(fallback ? { mode: "fallback" } : {}),
  };
  mkdirSync(dirname(file), { recursive: true });
  const next = input.summaryText(fields, body);
  if ((existsSync(file) ? readFileSync(file, "utf8") : null) !== expected) {
    jobs.push(`${period} ${id} изменён вручную; период не пересобирается`);
    return null;
  }
  writeFileAtomicSync(file, next);
  if (!(await commitVaultWrite(`${period} ${id}: night`, [file], vault)).ok)
    throw new Error(`${period} ${id} не закоммичен`);
  return fallback ? `${period}/${id}` : "";
}

/** К месяцам и годам списка — все их недели и месяцы, даже старше окна: собирать ли
 * каждого, решает due() по хешу (нет файла или изменился вход). */
function withChildren(found: Map<string, [Period, string]>): void {
  const add = (period: Period, id: string) =>
    found.set(`${period}/${id}`, [period, id]);
  const of = (kind: Period) =>
    [...found.values()]
      .filter(([period]) => period === kind)
      .flatMap(([period, id]) => periodChildIds(period, id));
  for (const month of of("yearly")) add("monthly", month);
  for (const child of of("monthly"))
    if (child.includes("W")) add("weekly", child);
}

/** Периоды, кончившиеся до сегодня, с днями в последних 35: недели, месяцы, годы,
 * каждый вид от старших к новым. Дети периодов в окне (месяцы года, недели месяца)
 * добавлены, даже старше окна: иначе период ждал бы их вечно и не видел их правок. */
function finishedPeriods(today: string): Array<[Period, string]> {
  const found = new Map<string, [Period, string]>();
  for (let back = 35; back >= 1; back--) {
    const day = iso(Date.parse(`${today}T00:00:00Z`) - back * DAY_MS);
    const ids: Array<[Period, string, string]> = [
      ["weekly", weekOfDay(day)!, daysOf(weekOfDay(day)!).at(-1)!],
      ["monthly", day.slice(0, 7), daysOf(day.slice(0, 7)).at(-1)!],
      ["yearly", day.slice(0, 4), `${day.slice(0, 4)}-12-31`],
    ];
    for (const [period, id, last] of ids)
      if (last < today) found.set(`${period}/${id}`, [period, id]);
  }
  withChildren(found);
  const rank = (period: Period) =>
    ["weekly", "monthly", "yearly"].indexOf(period);
  return [...found.values()].sort(([a], [b]) => rank(a) - rank(b));
}

/** Периоды, которые эта ночь уже собирала. */
const tried = new Set<string>();

/** Готовые периоды, которых нет или чей вход изменился; сбой периода не роняет ночь, а
 * идёт строкой в факт Job, предел ночи останавливает сборку. Возвращает периоды,
 * собранные без модели. */
export async function buildReadyPeriods(
  vault: string,
  today: string,
  ask: Ask,
  jobs: string[],
): Promise<string[]> {
  const fallbacks: string[] = [];
  // Второй проход ночи не трогает собранное этой ночью: fallback пересобирает следующая.
  const periods = finishedPeriods(today).filter((p) => !tried.has(p.join("/")));
  for (const period of periods)
    try {
      const made = await buildPeriod(vault, period, ask, jobs);
      if (made !== null) tried.add(period.join("/"));
      if (made) fallbacks.push(made);
    } catch (error) {
      tried.add(period.join("/"));
      jobs.push(`${period.join(" ")} не собран: ${String(error)}`);
      if (error instanceof NightCeilingError) break;
    }
  return fallbacks;
}
