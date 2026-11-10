// Минутный тик диспетчера напоминаний: забрать созревшие строки таблицы и отдать каждую
// своему ребёнку scripts/reminders/fire.ts. Ход агента и отправка живут в
// scripts/: authored tree не может импортировать транспорт Telegram и клиента eve
// (scripts/authored-tree-guard.test.ts), поэтому тик спавнит скрипт по имени.
//
// Взятие строки — один атомарный переход pending → fired внутри fireDue: повторное
// срабатывание невозможно по построению, поэтому у тика нет ни аренды, ни повторов, ни
// ожидания ребёнка перед следующим тиком. Ребёнок только дописывает факт в строку; если он
// не запустился или умер, не сказав факта, тик пишет delivered=false с причиной по коду
// выхода — и на этом всё, второго захода у строки нет.
//
// Тик живёт в процессе агента и умирает вместе с ним. Своих идущих детей он держит в памяти
// (TickMemory): такое срабатывание срок жизни не закрывает. Строку, которую взял упавший агент,
// следующий тик закрывает причиной, когда срок жизни истёк. Alert о ней тик отдаёт ребёнку на
// каждом проходе, пока дроссель Alert (packages/alert-state) не хранит факт отправки: падение
// между причиной и ребёнком долг не стирает. Текст напоминания заново не уходит
// (specs/ReminderLifecycle.tla).
//
// Пульс тика — mtime файла data/reminders.tick: он обновляется после удачного взятия, и по
// нему `iva doctor` и remind list говорят, жив ли диспетчер.
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import {
  ReminderStoreError,
  commandFile,
  commandTimeoutMs,
  reminderFile,
  abandonedAlertKey,
  closeAbandoned,
  fireDue,
  list,
  owesAlert,
  recordDelivery,
  sweepFired,
  type Reminder,
} from "./reminder-store.ts";
import { alertDue } from "../../packages/alert-state/index.ts";
import { listChatStatuses, setChatStatusIf } from "./run-status.ts";
import {
  runScheduledJob,
  type RunScheduledJobOptions,
  type RunScheduledJobResult,
} from "./schedule-runner.ts";

/** Строк за тик; остальное заберёт следующий тик. */
export const REMINDER_CLAIM_LIMIT = 5;
/** Срок ребёнка с Alert о брошенной строке: одной отправке в Telegram его хватает с запасом. */
const ALERT_TIMEOUT_MS = 120_000;
/** Тик старше этого — планировщик не жив. */
export const REMINDER_TICK_STALE_MS = 3 * 60_000;

export function tickPulseFile(dir: string = dataDir()): string {
  return join(dir, "reminders.tick");
}

/** Пульс: mtime — единственное, что важно; содержимое нужно человеку, читающему файл. */
export function touchTickPulse(nowMs: number): void {
  writeFileSync(tickPulseFile(), `${nowMs}\n`, { mode: 0o600 });
}

/**
 * Когда тик бился в последний раз; null — файла нет, то есть тик ещё не проходил.
 * Каталог данных - явный параметр для процессов, чей cwd не корень установки (doctor
 * из diagnose.sh): иначе пульс искался не там и доктор врал «ещё не тикал» (14.09.2026).
 */
export function readTickPulse(dir?: string): number | null {
  try {
    return statSync(tickPulseFile(dir)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Дети этого процесса агента, которые ещё идут: ребёнок срабатывания и ребёнок с Alert, по
 * ключу «файл, id, firedAt». Память умирает вместе с агентом; после перезапуска действует срок.
 */
export type TickMemory = {
  readonly firing: Set<string>;
  readonly alerting: Set<string>;
};
const memory: TickMemory = { firing: new Set(), alerting: new Set() };
const childKey = (file: string, row: Reminder) =>
  `${file}\0${row.id}\0${row.firedAt}`;

export interface ReminderTickOptions {
  readonly command?: boolean;
  /** Finish admission before returning to the minute Schedule, not the child turn. */
  readonly dispatchOnly?: boolean;
  readonly nowMs?: number;
  readonly limit?: number;
  readonly root?: string;
  readonly nodeBin?: string;
  readonly runJob?: typeof runScheduledJob;
  readonly log?: (...args: unknown[]) => void;
  /** Шов теста: свежая память — перезапуск агента. */
  readonly memory?: TickMemory;
}

export interface ReminderTickResult {
  readonly claimed: number;
  readonly spawned: number;
  readonly filled: number;
  readonly swept: number;
  readonly error?: string;
}

/** Всё, чем живёт один тик: значения по умолчанию разбираются один раз, до работы. */
type TickWiring = {
  readonly nowMs: number;
  readonly limit: number;
  readonly root: string;
  readonly nodeBin: string;
  readonly runJob: typeof runScheduledJob;
  readonly log: (...args: unknown[]) => void;
  readonly memory: TickMemory;
};

function tickWiring(options: ReminderTickOptions): TickWiring {
  return {
    nowMs: options.nowMs ?? Date.now(),
    limit: options.limit ?? REMINDER_CLAIM_LIMIT,
    root: options.root ?? process.cwd(),
    nodeBin: options.nodeBin ?? process.execPath,
    runJob: options.runJob ?? runScheduledJob,
    log:
      options.log ??
      ((...args: unknown[]) => console.log(new Date().toISOString(), ...args)),
    memory: options.memory ?? memory,
  };
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Чем закончился ребёнок, по полям результата runScheduledJob. */
function fireFailure(result: RunScheduledJobResult): string {
  if (result.error !== undefined)
    return `fire process failed to start: ${message(result.error)}`;
  if (result.signal) return `fire process killed by ${result.signal}`;
  return `fire process exited ${result.code ?? "unknown"}`;
}

/**
 * Запуск ребёнка. Настоящий runScheduledJob никогда не бросает; двойник в тесте — может,
 * причём и синхронно. Любой бросок значит одно: ребёнок не сказал факта.
 */
async function fireOnce(
  options: RunScheduledJobOptions,
  runJob: typeof runScheduledJob,
): Promise<RunScheduledJobResult> {
  try {
    return await runJob(options);
  } catch (error) {
    return { skipped: false, ok: false, code: null, signal: null, error };
  }
}

/** Запись факта в строку; false — запись не сдалась, и причина осталась в журнале. */
async function recordOutcome(
  row: Reminder,
  outcome: {
    readonly delivered: boolean | null;
    readonly error: string | null;
  },
  log: (...args: unknown[]) => void,
  file: string,
): Promise<boolean> {
  try {
    await recordDelivery(
      row.id,
      { firedAt: row.firedAt, ...outcome },
      { log, file },
    );
    return true;
  } catch (error) {
    if (error instanceof ReminderStoreError) {
      log(`reminders: ${row.id} outcome not recorded: ${message(error)}`);
      return false;
    }
    throw error;
  }
}

/**
 * Снять запись хода сработавшей строки: убитый ребёнок (SIGKILL) свой `finally` не отработает,
 * и чат до получаса оставался бы «занятым» — мост буферизовал бы владельца, а потом жнец
 * сбросил бы сессию чата. Признак своей записи один — её `sessionId`: его пишет ребёнок
 * перед ходом (scripts/reminders/fire.ts). Ход владельца, забравший чат, пишет свою сессию,
 * поэтому CAS не пройдёт и чужая запись останется целой.
 */
function releaseReminderStatus(
  row: Reminder,
  log: (...args: unknown[]) => void,
): void {
  const sessionId = row.sessionId;
  if (sessionId === null || sessionId === undefined) return;
  try {
    for (const { chatKey, status } of listChatStatuses()) {
      if (status.sessionId !== sessionId) continue;
      setChatStatusIf(
        chatKey,
        { sessionId },
        { status: "idle", sessionId: null, turnId: null, draftId: null },
      );
    }
  } catch (error) {
    log(`reminders: ${row.id} run-status not cleared: ${message(error)}`);
  }
}

/** Срабатывание считается идущим, пока его продолжение не дописало исход. */
async function fireRow(
  row: Reminder,
  file: string,
  command: boolean,
  wiring: TickWiring,
): Promise<"spawned" | "filled" | null> {
  const key = childKey(file, row);
  wiring.memory.firing.add(key);
  try {
    return await fireAndFill(row, file, command, wiring);
  } finally {
    wiring.memory.firing.delete(key);
  }
}

async function fireAndFill(
  row: Reminder,
  file: string,
  command: boolean,
  { root, nodeBin, runJob, log }: TickWiring,
): Promise<"spawned" | "filled" | null> {
  const result = await fireOnce(
    {
      name: `reminder-${row.id}`,
      argv: command
        ? ["scripts/reminders/command.ts", row.id, String(row.firedAt)]
        : ["scripts/reminders/fire.ts", row.id],
      root,
      nodeBin,
      // Commands have a deadline; prompt turns keep their inactivity watchdog.
      timeoutMs: command ? commandTimeoutMs(row) + 10_000 : null,
      killGraceMs: command ? 0 : undefined,
      log,
    },
    runJob,
  );
  const after = (await list(file)).find((candidate) => candidate.id === row.id);
  if (after === undefined || after.delivered !== null) {
    log(
      `reminders: ${row.id} fired (delivered=${after?.delivered ?? "row gone"})`,
    );
    return "spawned";
  }
  // Ребёнок отработал и вышел 0, а факта нет: текст мог уйти, а запись не состояться
  // (лок таблицы занят) — сказать «не дошло» про такую строку нельзя. Факт остаётся
  // невидимым, причина названа явно, и доктор говорит о ней иначе, чем о провале.
  if (result.ok && !result.skipped) {
    const recorded = await recordOutcome(
      row,
      { delivered: null, error: "delivery fact not recorded" },
      log,
      file,
    );
    if (!recorded) return null;
    releaseReminderStatus(after, log);
    log(`reminders: ${row.id} delivery fact not recorded`);
    return "filled";
  }
  // Ребёнок не сказал факта: причина — по коду выхода. Больше за эту строку не берёмся.
  const failure =
    command && Date.now() >= (row.firedAt ?? 0) + commandTimeoutMs(row) + 10_000
      ? "timeout"
      : fireFailure(result);
  const recorded = await recordOutcome(
    row,
    { delivered: false, error: failure },
    log,
    file,
  );
  if (!recorded) return null;
  releaseReminderStatus(after, log);
  log(`reminders: ${row.id} not delivered: ${failure}`);
  return "filled";
}

/**
 * Alert о брошенной строке: ребёнок перечитывает строку, шлёт и пишет факт в дроссель Alert.
 * Пока он идёт, следующий проход второго не зовёт.
 */
async function alertAbandoned(
  row: Reminder,
  file: string,
  command: boolean,
  { root, nodeBin, runJob, log, memory: { alerting } }: TickWiring,
): Promise<null> {
  const key = childKey(file, row);
  alerting.add(key);
  const result = await fireOnce(
    {
      name: `reminder-${row.id}-abandoned`,
      argv: command
        ? [
            "scripts/reminders/command.ts",
            row.id,
            String(row.firedAt),
            "abandoned",
          ]
        : ["scripts/reminders/fire.ts", row.id, "abandoned"],
      root,
      nodeBin,
      timeoutMs: ALERT_TIMEOUT_MS,
      log,
    },
    runJob,
  ).finally(() => alerting.delete(key));
  if (!result.ok)
    log(
      `reminders: ${row.id} abandoned, alert not sent: ${fireFailure(result)}`,
    );
  return null;
}

/** Закрытые строки без факта Alert и без идущего ребёнка с Alert: им Alert должен сейчас. */
function owedAlerts(
  rows: readonly Reminder[],
  file: string,
  command: boolean,
  alerting: ReadonlySet<string>,
): Reminder[] {
  return rows.filter((row) => {
    if (!owesAlert(row) || alerting.has(childKey(file, row))) return false;
    const { key, essence } = abandonedAlertKey(row, command);
    return alertDue(dataDir(), key, essence);
  });
}

/**
 * Один тик. Никогда не бросает наружу: это обработчик расписания, как и runScheduledJob —
 * сбой самого тика не должен ронять ход планировщика.
 */
export async function runReminderTick(
  options: ReminderTickOptions = {},
): Promise<ReminderTickResult> {
  const wiring = tickWiring(options);
  const { nowMs, limit, log, memory } = wiring;
  const command = options.command ?? false;

  const file = options.command ? commandFile() : reminderFile();
  let rows: Reminder[];
  try {
    rows = await fireDue(nowMs, limit, file);
  } catch (error) {
    const failure = message(error);
    log(`reminders: tick failed: ${failure}`);
    return { claimed: 0, spawned: 0, filled: 0, swept: 0, error: failure };
  }

  // Пульс — после удачного взятия: битая таблица значит, что сроки не разносятся, и
  // «диспетчер жив» было бы враньём.
  touchTickPulse(nowMs);

  let swept = 0;
  try {
    swept = options.command ? 0 : await sweepFired(nowMs);
  } catch (error) {
    log(`reminders: sweep failed: ${message(error)}`);
  }

  // После взятия и уборки: закрытая сейчас строка доживает до следующего тика, и ребёнок
  // с Alert успевает её прочитать. Долг Alert читается из таблицы, а не из закрытых сейчас.
  let abandoned: Reminder[] = [];
  let owed: Reminder[] = [];
  try {
    abandoned = await closeAbandoned(nowMs, file, (row) =>
      memory.firing.has(childKey(file, row)),
    );
    owed = owedAlerts(await list(file), file, command, memory.alerting);
  } catch (error) {
    log(`reminders: closing abandoned rows failed: ${message(error)}`);
  }

  if (rows.length > 0)
    log(
      `reminders: tick claimed ${rows.length}: ${rows.map((row) => row.id).join(", ")}`,
    );
  if (abandoned.length > 0)
    log(
      `reminders: tick closed ${abandoned.length} abandoned: ${abandoned.map((row) => row.id).join(", ")}`,
    );

  let spawned = 0;
  let filled = 0;

  const completion = Promise.allSettled([
    ...rows.map((row) => fireRow(row, file, command, wiring)),
    ...owed.map((row) => alertAbandoned(row, file, command, wiring)),
  ]).then((outcomes) => {
    outcomes.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        if (outcome.value === "spawned") spawned += 1;
        if (outcome.value === "filled") filled += 1;
        return;
      }
      filled += 1;
      log(
        `reminders: ${rows[index]?.id} tick handler threw: ${message(outcome.reason)}`,
      );
    });
  });
  if (!options.dispatchOnly) await completion;
  return { claimed: rows.length, spawned, filled, swept };
}
