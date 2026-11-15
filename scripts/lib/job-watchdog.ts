// Дневной сторож (T20 п.4): если за сутки есть провалы расписаний, а агент ни разу не
// проснулся (wake падал или хода не было), владелец получает одно сообщение в сутки.
// Политик и повторов в коде нет: состояние одного сообщения — lastSentAt в
// data/jobs-watchdog.json, а само сообщение отправляет дневное расписание.
// Провал — последний факт имени по состоянию Job (agent/lib/job-state.ts, через
// openJobFailures, общий с Brief и ходом агента). Брони расписаний сторож не читает и не пишет.
import { readFileSync } from "node:fs";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";
import {
  jobFactsFile,
  latestFact,
  readFactsSync,
  type JobFact,
} from "#lib/job-facts.ts";
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
  facts: readonly JobFact[] = [],
): string {
  const names: Record<string, string> = {
    "memory-night": tr("Night memory", "Ночная обработка памяти"),
    "jobs-watchdog": tr("Schedule check", "Проверка расписаний"),
    proactive: tr("Review and updates", "Обзор и новости"),
  };
  const lines = failures.map((failure) => {
    const fact = latestFact(facts, failure.name);
    const reason = watchdogReason(fact?.tail ?? "", failure.reason, tr);
    const when = new Date(failure.at)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/u, " UTC");
    return `${names[failure.name] ?? failure.name} — ${when}: ${reason}.`;
  });
  if (failures.some((failure) => failure.name === "memory-night"))
    lines.push(
      tr(
        "Some memory summaries are still pending. Source entries are preserved; the next night will retry them automatically.",
        "Часть сводок памяти ещё не готова. Исходные записи сохранены; следующая ночь автоматически повторит сборку.",
      ),
    );
  lines.push(
    tr(
      "Iva did not wake to handle the failure. To check it now, run iva doctor and send Iva: check the failed schedules.",
      "Ива не проснулась разобрать провал. Для проверки сейчас выполни iva doctor и напиши Иве: проверь упавшие расписания.",
    ),
  );
  return lines.join("\n");
}

/** Translate known causes, keeping provider traces and raw payloads out of the notice. */
function watchdogReason(tail: string, error: string, tr: Translate): string {
  const causes: Array<[RegExp, string]> = [
    [/overloaded/iu, tr("the model is overloaded", "модель перегружена")],
    [
      /invalid.*key|\b401\b|insufficient.quota/iu,
      tr(
        "the model rejected access or the account quota was exhausted",
        "модель отклонила доступ или исчерпана квота аккаунта",
      ),
    ],
    [
      /\b429\b|rate.?limit/iu,
      tr(
        "the model request rate limit was reached",
        "провайдер временно ограничил частоту запросов",
      ),
    ],
    [
      /terminated|ECONNRESET|fetch failed|connection.*lost|связь.*оборвалась/iu,
      tr(
        "the connection to the model was interrupted",
        "связь с моделью оборвалась",
      ),
    ],
    [
      /\b5\d{2}\b/iu,
      tr(
        "the model service is temporarily unavailable",
        "сервис модели временно недоступен",
      ),
    ],
  ];
  for (const line of `${error}\n${tail}`.split("\n").reverse()) {
    const cause = causes.find(([pattern]) => pattern.test(line));
    if (cause) return cause[1];
  }
  if (/deadline|ceiling/iu.test(`${error}\n${tail}`))
    return tr(
      "the night time or request limit was reached",
      "достигнут предел времени или запросов ночи",
    );
  return tr(
    "the command ended with an error; details are in iva logs",
    "команда завершилась с ошибкой; подробности в iva logs",
  );
}

/**
 * Таблица фактов не читается: агент в этом состоянии тоже не просыпается (пробуждение
 * начинается со чтения строки), поэтому страховка обязана сказать владельцу — иначе она
 * мертва ровно там, где заведена (слепая приёмка T20).
 */
export function watchdogUnreadableMessage(tr: Translate): string {
  return tr(
    "Iva cannot read the schedule run history, so it cannot check the results or wake to handle a failure. Run iva doctor and ask Iva to check the schedule history.",
    "Ива не смогла прочитать историю запусков расписаний: проверить итоги и проснуться для разбора провала сейчас невозможно. Выполни iva doctor и попроси Иву проверить историю расписаний.",
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
  return watchdogMessage(failures, tr, facts);
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
