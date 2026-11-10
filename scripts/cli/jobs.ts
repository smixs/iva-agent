// `iva jobs ack <name>` — закрыть незакрытый провал расписания (T20 п.3). Команда нужна
// ровно одна: без неё провал закрывался бы только успешным перезапуском, а «я посмотрела,
// чинить нечего» сказать нечем. Ставит acked=true на последней строке-провале имени.
//
// `iva jobs skip memory-night <date>` — закрыть день ночной памяти без разбора: день, трижды
// не разобранный ночью, ждёт этого решения (scripts/lib/rollup-attempts.ts). Под тем же
// .memory.lock, что ночь (путь из agent/lib/schedule-paths.ts), код ставит в хвост сырого дня
// ту же отметку конца, что ставит скилл, коммитит vault и стирает попытки дня. Отказ коммита —
// код 1 и попытки на месте: повтор команды доводит коммит.
//
// `iva jobs status` — состояние каждого Job по записи (agent/lib/job-state.ts): бронь в
// data/rollup-status.json и последний факт в data/jobs.json. Только чтение.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveVaultDir } from "../../packages/vault-dir/index.ts";
import { readEnvFresh } from "../lib/env-file.ts";
import { resolveTimeZone } from "../../packages/timezone/index.ts";
// `import type` стирается при компиляции: таблица фактов живёт в authored tree, а
// `iva jobs` обязан грузиться и там, где agent/ нет (scripts/authored-tree-guard.test.ts),
// поэтому значения берутся динамическим импортом внутри команды.
import type { ackFacts, JobFact } from "#lib/job-facts.ts";
import type { JobState } from "#lib/job-state.ts";
import type { commitVaultWrite } from "#lib/vault-commit.ts";
import type { underMemoryLock } from "../lib/memory-lock.ts";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

type ReadEnv = typeof readEnvFresh;

type JobsDependencies = {
  readonly ack?: typeof ackFacts;
  readonly commit?: typeof commitVaultWrite;
  readonly readEnv?: ReadEnv;
  readonly now?: () => Date;
  readonly lock?: typeof underMemoryLock;
};

const USAGE =
  "usage: iva jobs ack <name> | iva jobs skip memory-night <YYYY-MM-DD> | iva jobs status";

const iso = (at: number) => new Date(at).toISOString();

function lastLine(last: JobFact | null): string {
  if (last === null) return "no fact";
  if (last.ok) return `last ok at ${iso(last.finishedAt)}`;
  const reason = last.error ?? "no reason";
  return `last ${last.acked ? "closed failure" : "failure"} (${reason}) at ${iso(last.finishedAt)}`;
}

/** Строка `iva jobs status`: имя, состояние брони, последний факт. */
export function jobStatusLine(name: string, job: JobState): string {
  const reservation = job.reservation;
  const held =
    reservation.kind === "none"
      ? ""
      : ` since ${iso(reservation.since)}${reservation.kind === "owned" ? ` (pid ${reservation.ownerPid})` : ""}`;
  return `${name}: ${job.state}${held}; ${lastLine(job.last)}`;
}

function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function isCalendarDate(date: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(date) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  );
}

// Отметка конца дня, которую читает ночь. Тихий день без транскрипта ночь тоже берёт
// (вчера — всегда): закрыть его можно только той же отметкой, и файл дня создаётся из неё.
// Закрыт ли день, судит правило самой ночи (markedDone: отметка в хвосте).
function markSkipped(
  raw: string,
  now: Date,
  markedDone: (text: string) => boolean,
): void {
  const exists = existsSync(raw);
  if (exists) {
    const text = readFileSync(raw, "utf8");
    if (
      markedDone(text) &&
      /<!-- processed: skipped by owner\b[^\r\n]*-->\s*$/u.test(text)
    )
      return;
  }
  if (!exists) mkdirSync(dirname(raw), { recursive: true });
  appendFileSync(
    raw,
    `\n<!-- processed: skipped by owner ${now.toISOString()} -->\n`,
    "utf8",
  );
}

export function createJobsCommand(
  runtime: CliRuntime,
  dependencies: JobsDependencies = {},
) {
  const { ENV_PATH, ROOT, bad, dataDirAbs, ok } = runtime;
  const readEnv = dependencies.readEnv ?? readEnvFresh;

  async function ack(name: string): Promise<void> {
    const facts = await import("#lib/job-facts.ts");
    const env = await readEnv(ENV_PATH);
    const closed = await (dependencies.ack ?? facts.ackFacts)(
      facts.jobFactsFile(dataDirAbs(env)),
      name,
    );
    if (closed === 0) {
      bad(`no open failure for ${name}`);
      return;
    }
    ok(`closed ${closed} open failure(s) for ${name}`);
  }

  async function skipDay(date: string): Promise<void> {
    const { memoryLockPath } = await import("#lib/schedule-paths.ts");
    const lock =
      dependencies.lock ??
      (await import("../lib/memory-lock.ts")).underMemoryLock;
    const locked = lock(memoryLockPath(ROOT));
    if (locked !== null) {
      process.exitCode = locked;
      return;
    }
    const env = await readEnv(ENV_PATH);
    const now = (dependencies.now ?? (() => new Date()))();
    const timeZone = resolveTimeZone(env.ASSISTANT_TIMEZONE);
    const today = localDate(now, timeZone);
    if (!isCalendarDate(date) || date >= today)
      throw new Error(
        `${date} is not a finished day in ${timeZone} (today is ${today})`,
      );
    const vault = resolveVaultDir(ROOT, env.ASSISTANT_VAULT_DIR);
    const raw = join(vault, "daily", `${date}.md`);
    const { markedDone } = await import("../memory/night-input.ts");
    markSkipped(raw, now, markedDone);
    const commit =
      dependencies.commit ??
      (await import("#lib/vault-commit.ts")).commitVaultWrite;
    const committed = await commit(
      `file daily/${date}.md: skipped by owner`,
      [raw],
      vault,
    );
    if (!committed.ok)
      throw new Error(
        `${date} is marked done, but the vault commit failed (${committed.reason}) — run the command again`,
      );
    const { clearDay } = await import("../lib/rollup-attempts.ts");
    clearDay(join(dataDirAbs(env), "rollup-attempts.json"), date);
    ok(`closed ${date} without processing; the night leaves it alone`);
  }

  async function status(): Promise<void> {
    const { jobFactsFile, readFactsSync } = await import("#lib/job-facts.ts");
    const { jobState } = await import("#lib/job-state.ts");
    const { DEFAULT_TIMEOUT_MS, readStatus } =
      await import("#lib/schedule-runner.ts");
    const { PROACTIVE_SCHEDULE, PROACTIVE_TIMEOUT_MS, SCHEDULE_CRON } =
      await import("#lib/schedule-table.ts");
    const dir = dataDirAbs(await readEnv(ENV_PATH));
    const entries = readStatus(join(dir, "rollup-status.json"));
    const facts = readFactsSync(jobFactsFile(dir));
    const now = (dependencies.now ?? (() => new Date()))().getTime();
    for (const name of [...Object.keys(SCHEDULE_CRON), PROACTIVE_SCHEDULE]) {
      const job = jobState(name, {
        entry: entries[name],
        facts,
        now,
        deadlineMs:
          name === PROACTIVE_SCHEDULE
            ? PROACTIVE_TIMEOUT_MS
            : DEFAULT_TIMEOUT_MS,
      });
      ok(jobStatusLine(name, job));
    }
  }

  return async function cmdJobs(args: readonly string[]): Promise<void> {
    const [subcommand, name, date] = args;
    if (subcommand === "status" && name === undefined) return await status();
    if (subcommand === "ack" && name) return await ack(name);
    if (subcommand === "skip" && name === "memory-night" && date)
      return await skipDay(date);
    throw new Error(USAGE);
  };
}
