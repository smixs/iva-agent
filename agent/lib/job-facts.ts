// Таблица фактов расписаний: одна строка на каждый запуск в data/jobs.json. Пишет её
// schedule-runner в конце запуска; читают agent/instructions/40-open-failures.ts,
// `iva doctor` и дневной сторож. Строка говорит, что запускалось, когда, чем кончилось,
// почему и хвост журнала без секретов.
//
// Status-файл расписаний (rollup-status.json) остаётся только гвардам: «идёт сейчас» и
// «последний успех». История запусков — здесь, об одном запуске не два источника правды.
//
// Форма строки — контракт: битая строка пропускается (файл пишем мы сами, не пользователь),
// а чужой корень файла — явная ошибка: молча ответить «запусков не было» значило бы
// выключить и провалы, и сторожа.
import { copyFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  redact,
  secretValuesFromEnv,
} from "../../packages/secret-redaction/index.ts";
import { dataDir } from "./data-dir.ts";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "./json-store.ts";
import { isSafeInteger } from "../../packages/guards/index.ts";

/** Сколько живёт строка: старше — удаляется при записи. */
export const JOB_FACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Последние строки журнала в факте (п.1 спеки T20). */
export const JOB_TAIL_LINES = 20;
export const JOB_TAIL_MAX_CHARS = 4000;

export class JobFactsError extends Error {}

export interface JobWake {
  readonly at: number;
  readonly status: "answered" | "empty" | "failed";
  readonly error: string | null;
  /**
   * Провал в тихие часы: ход был (status `empty`), ответ не слали, провал стоит первым в утреннем
   * Brief. Отдельным необязательным полем, а не значением status: разбор 0.4.11 лишних полей не
   * проверяет, и откат строку не теряет.
   */
  readonly deferred?: true;
}

export interface JobFact {
  readonly name: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly ok: boolean;
  readonly error: string | null;
  readonly exitCode: number | null;
  readonly tail: string;
  readonly acked: boolean;
  readonly wake: JobWake | null;
}

export function jobFactsFile(dir: string = dataDir()): string {
  return join(dir, "jobs.json");
}

/**
 * Хвост для факта: последние 20 строк stderr без секретов. Хвост едет дальше двумя путями —
 * в data/jobs.json и в текст хода пробуждения, откуда модель может процитировать его
 * владельцу, — поэтому правило вырезания здесь ровно то же, что у пакета улик `iva diagnose`
 * (packages/secret-redaction/index.ts): значение любого ключа, кроме настроечных, пароль из
 * userinfo URL, ключ известного формата (токен бота, `sk-…`, `ghp_…`, JWT и другие) в любом
 * месте строки, личный id рядом с меткой и e-mail. Свой шаблон здесь был слабее и пропускал
 * токен внутри `bot<token>` и пароль в `CUSTOM_BASE_URL` (слепая приёмка T20). По длине значения не фильтруем: трёхсимвольный
 * секрет — тоже секрет, а служебные переменные самого процесса (HOME, PWD, USER, PATH,
 * SHLVL) общее правило знает по именам и не режет.
 */
export function jobTail(
  tail: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const named: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (typeof value === "string") named[name] = value;
  const text = redact(tail, secretValuesFromEnv(named));
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-JOB_TAIL_LINES);
  const joined = lines.join("\n");
  return joined.length > JOB_TAIL_MAX_CHARS
    ? joined.slice(joined.length - JOB_TAIL_MAX_CHARS)
    : joined;
}

function isWake(value: unknown): value is JobWake {
  if (typeof value !== "object" || value === null) return false;
  const wake = value as Record<string, unknown>;
  return (
    isSafeInteger(wake.at) &&
    (wake.status === "answered" ||
      wake.status === "empty" ||
      wake.status === "failed") &&
    (wake.error === null || typeof wake.error === "string") &&
    (wake.deferred === undefined || wake.deferred === true)
  );
}

function isFact(value: unknown): value is JobFact {
  if (typeof value !== "object" || value === null) return false;
  const fact = value as Record<string, unknown>;
  return (
    typeof fact.name === "string" &&
    fact.name.length > 0 &&
    isSafeInteger(fact.startedAt) &&
    isSafeInteger(fact.finishedAt) &&
    fact.finishedAt >= fact.startedAt &&
    typeof fact.ok === "boolean" &&
    (fact.error === null || typeof fact.error === "string") &&
    (fact.exitCode === null || isSafeInteger(fact.exitCode)) &&
    typeof fact.tail === "string" &&
    typeof fact.acked === "boolean" &&
    (fact.wake === null || isWake(fact.wake))
  );
}

/**
 * Валидные строки таблицы; чужой корень — ошибка с путём. Битая строка пропускается, но не
 * молча: она может быть единственным следом провала, а тишина о пропаже — худший исход из
 * возможных (проверка T20, раунд 3). Копию файла перед перезаписью откладывает запись.
 */
export function parseFacts(
  value: unknown,
  file: string,
  log: (line: string) => void = console.error,
): JobFact[] {
  if (!Array.isArray(value))
    throw new JobFactsError(`${file} is not a job facts array`);
  const facts = value.filter(isFact);
  if (facts.length !== value.length)
    log(
      `job facts: ${file} — ${value.length - facts.length} row(s) not in the form, skipped`,
    );
  return facts;
}

/** Синхронное чтение для инструкции хода: нет файла — пусто, битый — ошибка. */
export function readFactsSync(file: string): JobFact[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new JobFactsError(`${file} unreadable: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new JobFactsError(
      `${file} damaged (invalid JSON): ${(error as Error).message}`,
    );
  }
  return parseFacts(parsed, file);
}

export async function readFacts(file: string): Promise<JobFact[]> {
  return parseFacts(await loadJsonStrict<unknown>(file, []), file);
}

function rotated(facts: readonly JobFact[], now: number): JobFact[] {
  const alive = facts.filter(
    (fact) => now - fact.finishedAt <= JOB_FACT_RETENTION_MS,
  );
  return alive.length === facts.length ? [...facts] : alive;
}

async function withFacts<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const token = await acquireLock(`${file}.lock`);
  try {
    return await fn();
  } finally {
    releaseLock(`${file}.lock`, token);
  }
}

/**
 * Чтение перед записью: испорченный файл не повод терять факт запуска. Потеря факта тут
 * стоит дорого — без строки не будет и пробуждения агента, а чужой корень (валидный JSON,
 * но не массив) не лечился никогда: каждый следующий запуск снова терял факт. Невалидный
 * JSON `loadJsonStrict` уже откладывает в `<файл>.corrupt-<метка>` сам и только сообщает об
 * этом ошибкой; чужой корень откладываем здесь тем же способом. Остальные ошибки чтения
 * (права, ввод-вывод) идут наружу: молча начать таблицу заново значило бы потерять её.
 */
async function readFactsForWrite(
  file: string,
  now: number,
): Promise<JobFact[]> {
  try {
    const parsed = await loadJsonStrict<unknown>(file, []);
    const facts = parseFacts(parsed, file);
    // Битые строки перезапись потеряет насовсем, поэтому файл сначала копируется рядом:
    // живые строки остаются в работе, а испорченная запись переживает запись и видна.
    if (
      Array.isArray(parsed) &&
      parsed.length !== facts.length &&
      !quarantine(file, "copy", now)
    )
      throw new JobFactsError(
        `${file}: broken row not kept aside, not rewriting`,
      );
    return facts;
  } catch (error) {
    if (error instanceof JobFactsError) {
      // Начать таблицу заново можно только после состоявшегося карантина: иначе перезапись
      // уничтожит и повреждение, и то, что лежало рядом с ним.
      if (!quarantine(file, "move", now)) throw error;
      return [];
    }
    // Битый JSON `loadJsonStrict` откладывает сам. Верим не тексту ошибки, а файлу: пока
    // оригинал на месте, перезаписывать его нельзя.
    if (!existsSync(file)) return [];
    throw error;
  }
}

/**
 * Отложить испорченный файл рядом, как это делает json-store для битого JSON. `"copy"` —
 * когда живые строки нужны дальше: рядом остаётся копия, а работа идёт с самим файлом.
 */
function quarantine(file: string, how: "move" | "copy", now: number): boolean {
  const stamp = new Date(now).toISOString().replace(/[:.]/gu, "-");
  const aside = `${file}.corrupt-${stamp}`;
  try {
    if (how === "copy") copyFileSync(file, aside);
    else renameSync(file, aside);
    console.error(`job facts: ${file} kept aside as ${aside}`);
    return true;
  } catch (error) {
    // Отказ карантина — не повод терять данные: говорим и отдаём решение вызвавшему.
    console.error(
      `job facts: ${file} could not be kept aside as ${aside} — ${(error as Error).message}`,
    );
    return false;
  }
}

/**
 * Записать факт запуска: ротация старше 7 дней и добавление строки под локом. `afterFailure` —
 * записать, только если последний факт этого имени провал (успех его закрывает); false —
 * строка не добавлена.
 */
export async function recordFact(
  file: string,
  fact: JobFact,
  now: number = Date.now(),
  { afterFailure = false }: { readonly afterFailure?: boolean } = {},
): Promise<boolean> {
  return withFacts(file, async () => {
    const existing = await readFactsForWrite(file, now);
    if (afterFailure && latestFact(existing, fact.name)?.ok !== false)
      return false;
    await saveJsonAtomic(file, [...rotated(existing, now), fact], {
      mode: 0o600,
    });
    return true;
  });
}

/**
 * Записать исход хода агента в строку запуска; false — строки уже нет (или её исход уже
 * записан, а звали с `onlyIfMissing`). `onlyIfMissing` нужен раннеру: он видит смерть
 * ребёнка пробуждения снаружи и не должен затирать исход, который сам ход уже записал.
 */
export async function recordWake(
  file: string,
  name: string,
  startedAt: number,
  wake: JobWake,
  onlyIfMissing = false,
): Promise<boolean> {
  return withFacts(file, async () => {
    // Чтение перед записью, как у recordFact: битую строку сначала откладываем рядом,
    // иначе перезапись исхода хода унесла бы единственный след порчи (T30 №1).
    const facts = await readFactsForWrite(file, Date.now());
    let found = false;
    const next = facts.map((fact) => {
      if (fact.name !== name || fact.startedAt !== startedAt) return fact;
      if (onlyIfMissing && fact.wake !== null) return fact;
      found = true;
      return { ...fact, wake };
    });
    if (found) await saveJsonAtomic(file, next, { mode: 0o600 });
    return found;
  });
}

/**
 * Закрыть провалы имени вручную: `iva jobs ack <name>`. Возвращает, сколько строк
 * закрыто. Закрывается только последний провал имени — он и есть незакрытый.
 */
export async function ackFacts(file: string, name: string): Promise<number> {
  return withFacts(file, async () => {
    // Карантин битой строки — и здесь: ack перезаписывает таблицу целиком (T30 №1).
    const facts = await readFactsForWrite(file, Date.now());
    const latest = latestFact(facts, name);
    // Незакрытый провал имени — это ровно последняя строка, если она провал.
    if (!latest || latest.ok || latest.acked) return 0;
    await saveJsonAtomic(
      file,
      facts.map((fact) =>
        fact.name === name &&
        fact.startedAt === latest.startedAt &&
        !fact.ok &&
        !fact.acked
          ? { ...fact, acked: true }
          : fact,
      ),
      { mode: 0o600 },
    );
    return 1;
  });
}

/** Последняя строка имени по finishedAt (порядок в файле может быть любым). */
export function latestFact(
  facts: readonly JobFact[],
  name: string,
): JobFact | null {
  let latest: JobFact | null = null;
  for (const fact of facts) {
    if (fact.name !== name) continue;
    // При равном finishedAt (две записи в одну миллисекунду) решает более поздний старт, а
    // не порядок строк в файле: иначе свежий провал мог спрятаться за старым успехом.
    if (
      !latest ||
      fact.finishedAt > latest.finishedAt ||
      (fact.finishedAt === latest.finishedAt &&
        fact.startedAt > latest.startedAt)
    )
      latest = fact;
  }
  return latest;
}
