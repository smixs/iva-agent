// Дневной сторож (T20 п.4): если за сутки есть провалы расписаний, а агент ни разу не
// проснулся (wake падал или хода не было), владелец получает одно сообщение в сутки.
// Политик и повторов в коде нет: состояние одного сообщения — lastSentAt в
// data/jobs-watchdog.json, а само сообщение отправляет дневное расписание.
// Провал — последний факт имени по состоянию Job (agent/lib/job-state.ts, через
// openJobFailures, общий с Brief и ходом агента). Брони расписаний сторож не читает и не пишет.
import { readFileSync } from "node:fs";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";
import { jobFactsFile, readFactsSync, type JobFact } from "#lib/job-facts.ts";
import {
  OPEN_FAILURES_WINDOW_MS,
  openJobFailures,
  type OpenFailure,
} from "#lib/open-failures.ts";
import type { Translate } from "./job-wake.ts";

export const WATCHDOG_SEND_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class JobWatchdogError extends Error {}

export interface WatchdogState {
  readonly lastSentAt: number;
}

export function watchdogStateFile(dataDir: string): string {
  return `${dataDir}/jobs-watchdog.json`;
}

/** Нет файла — null (ещё не отправляли); битый — явная ошибка, а не «никогда». */
export function readWatchdogState(file: string): WatchdogState | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new JobWatchdogError(
      `${file} unreadable: ${(error as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new JobWatchdogError(
      `${file} damaged (invalid JSON): ${(error as Error).message}`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Number.isSafeInteger((parsed as WatchdogState).lastSentAt)
  )
    throw new JobWatchdogError(`${file} is not a watchdog state`);
  return { lastSentAt: (parsed as WatchdogState).lastSentAt };
}

/**
 * Состоявшийся ход агента ПОСЛЕ этого момента: ответ (в том числе пустой или отложенный до утра
 * Brief — `empty` с признаком `deferred`: ход ночью был, агент жив), а не провал.
 * Сравнение идёт с временем провала, а не с суточным окном: ход, который был до провала,
 * о нём ничего не знал, а на следующем суточном тике провал уже выпадал из окна — и
 * страховка не уходила никогда (проверка T20, раунд 3).
 */
export function agentTurnSeen(
  facts: readonly JobFact[],
  since: number,
): boolean {
  return facts.some(
    (fact) =>
      fact.wake !== null &&
      fact.wake.status !== "failed" &&
      // Ход с записанной причиной (ответ не доехал) состоявшимся не считается: владелец
      // его не видел, значит страховка ещё нужна.
      fact.wake.error === null &&
      fact.wake.at >= since,
  );
}

export function watchdogMessage(
  failures: readonly OpenFailure[],
  tr: Translate,
): string {
  // Число двоеточием, а не согласованием: «1 провалов» владелец читает как есть.
  return tr(
    `scheduled jobs failed in the last 24h: ${failures.length}; the agent is not responding; run: iva doctor`,
    `за сутки провалов расписаний: ${failures.length}; агент не отвечает; iva doctor`,
  );
}

/**
 * Таблица фактов не читается: агент в этом состоянии тоже не просыпается (пробуждение
 * начинается со чтения строки), поэтому страховка обязана сказать владельцу — иначе она
 * мертва ровно там, где заведена (слепая приёмка T20).
 */
export function watchdogUnreadableMessage(tr: Translate): string {
  return tr(
    "the schedule facts table cannot be read, so the agent cannot wake with a fact; run: iva doctor",
    "таблица фактов расписаний не читается, агент не может проснуться с фактом; iva doctor",
  );
}

/**
 * Текст к отправке или null. `facts === null` — таблица не читается: это отдельная причина
 * с тем же суточным дросселем. Дроссель проверяется первым: он один на обе причины.
 */
export function watchdogDecision({
  facts,
  now,
  lastSentAt,
  tr,
}: {
  readonly facts: readonly JobFact[] | null;
  readonly now: number;
  readonly lastSentAt: number | null;
  readonly tr: Translate;
}): string | null {
  // Окно считается только вперёд: метка из будущего (часы откатили) значит «не отправляли»,
  // иначе сторож молчал бы до той даты.
  const sentAge = lastSentAt === null ? null : now - lastSentAt;
  if (sentAge !== null && sentAge >= 0 && sentAge < WATCHDOG_SEND_INTERVAL_MS)
    return null;
  if (facts === null) return watchdogUnreadableMessage(tr);
  // Страховка — о провалах последних суток (её текст так и говорит); провал старше остаётся
  // открытым для Brief и doctor (ADR-0020), но второй страховки не будит.
  const failures = openJobFailures(facts).filter(
    (failure) => now - failure.at <= OPEN_FAILURES_WINDOW_MS,
  );
  if (failures.length === 0) return null;
  const latestFailureAt = Math.max(...failures.map((failure) => failure.at));
  if (agentTurnSeen(facts, latestFailureAt)) return null;
  return watchdogMessage(failures, tr);
}

export interface WatchdogDeps {
  readonly dataDir: string;
  readonly tr: Translate;
  readonly send: (text: string) => Promise<boolean>;
  readonly now?: () => number;
  readonly log?: (...args: unknown[]) => void;
}

/** Один прогон сторожа: решить, отправить, отметить. Возвращает текст или null. */
export async function runJobWatchdog(
  deps: WatchdogDeps,
): Promise<string | null> {
  const now = (deps.now ?? Date.now)();
  const log =
    deps.log ??
    ((...args: unknown[]) => console.log(new Date().toISOString(), ...args));
  const stateFile = watchdogStateFile(deps.dataDir);
  // Ни таблица, ни собственное состояние не имеют права уронить страховку: нечитаемая
  // таблица — это её повод сработать, а испорченный дроссель значит «не отправляли»
  // (следующая удачная отправка перезапишет файл).
  let facts: JobFact[] | null = null;
  try {
    facts = readFactsSync(jobFactsFile(deps.dataDir));
  } catch (error) {
    log(
      `watchdog: facts table unreadable — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let state: WatchdogState | null = null;
  let repaired = false;
  try {
    state = readWatchdogState(stateFile);
  } catch (error) {
    // Файл есть, но не читается. Испорченный, но записываемый дроссель восстанавливаем
    // меткой «сейчас» и всё равно шлём один раз — иначе страховка молчала бы вместе с
    // файлом. Не записывается (каталог, права): молчим, иначе владелец получит второе
    // сообщение за сутки (T30 №6).
    const reason = error instanceof Error ? error.message : String(error);
    try {
      writeFileAtomicSync(
        stateFile,
        JSON.stringify({ lastSentAt: now }, null, 2),
        { mode: 0o600 },
      );
      repaired = true;
      log(`watchdog: state repaired, sending once — ${reason}`);
    } catch (writeError) {
      log(
        `watchdog: state unreadable and not writable, message suppressed — ${reason} ` +
          `(${writeError instanceof Error ? writeError.message : String(writeError)})`,
      );
      return null;
    }
  }
  const message = watchdogDecision({
    facts,
    now,
    // Восстановленное состояние уже несёт метку «сейчас»: решает сам повод, а не дроссель.
    lastSentAt: repaired ? null : (state?.lastSentAt ?? null),
    tr: deps.tr,
  });
  if (message === null) {
    log("watchdog: nothing to send");
    return null;
  }
  const sent = await deps.send(message);
  if (!sent) {
    // Отказ транспорта — провал запуска, а не тихий возврат: точка входа обязана выйти
    // ненулём, иначе запуск сторожа записывается успешным, хотя владелец ничего не получил
    // (слепая приёмка T20 по v6). Метку не ставим: суточное окно считается от состоявшейся
    // отправки, и следующий запуск попробует снова.
    log("watchdog: message not sent — will retry on the next run");
    throw new Error(`watchdog: message not sent: ${message}`);
  }
  if (!repaired)
    writeFileAtomicSync(
      stateFile,
      JSON.stringify({ lastSentAt: now }, null, 2),
      { mode: 0o600 },
    );
  log(`watchdog: sent "${message}"`);
  return message;
}
