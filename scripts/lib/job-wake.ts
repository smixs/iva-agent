// Пробуждение агента после запуска расписания (T20 п.2). Вызывается ребёнком
// scripts/jobs/wake.ts: читает строку факта, собирает текст хода, запускает ход агента и
// возвращает владельцу только непустой ответ. Исход хода (ответил / ответил пустым /
// провалился) приписывается строке запуска — по нему дневной сторож понимает, что агент
// не отвечает.
//
// Никаких политик повторов здесь нет: провал хода — факт, а не повод будить снова.
import {
  recordWake,
  readFacts,
  type JobFact,
  type JobWake,
} from "#lib/job-facts.ts";

export type Translate = (english: string, russian: string) => string;

export type WakeTurnResult = {
  readonly status: "completed" | "failed" | "waiting";
  readonly message?: string;
};

export interface JobWakeDeps {
  readonly factsFile: string;
  readonly tr: Translate;
  readonly runTurn: (prompt: string) => Promise<WakeTurnResult>;
  readonly send: (text: string) => Promise<boolean>;
  readonly now?: () => number;
  readonly log?: (...args: unknown[]) => void;
}

/** Текст хода: что случилось, что делать на ok и что на провале, плюс хвост журнала. */
export function jobWakePrompt(fact: JobFact, tr: Translate): string {
  const outcome = fact.ok ? tr("ok", "ок") : tr("failed", "провал");
  const reason = fact.error ?? tr("no reason recorded", "причина не записана");
  const instruction = fact.ok
    ? tr(
        "Nothing is broken: do nothing and answer with an empty message, without thinking.",
        "Всё в порядке: ничего не делай и ответь пустым, без размышлений.",
      )
    : tr(
        "Try to fix it yourself (restart with `iva ...`, fix the file), then tell the owner what broke and what you did.",
        "Попробуй починить сам (перезапустить командой `iva ...`, поправить файл), потом скажи владельцу, что сломалось и что ты сделала.",
      );
  const head = `${tr("Scheduled job", "Расписание")} ${fact.name} ${tr("finished", "завершилось")}: ${outcome}, ${reason} (exit=${fact.exitCode ?? "n/a"}).`;
  const tail = fact.tail
    ? `\n${tr("Log tail", "Хвост журнала")}:\n${fact.tail}`
    : "";
  return `${head}\n${instruction}${tail}`;
}

/**
 * Один ход по факту. Возвращает исход хода; строка факта всегда получает его (кроме
 * случая, когда строки уже нет, — тогда пробуждение не к чему приписать).
 */
export async function runJobWake(
  name: string,
  startedAt: number,
  deps: JobWakeDeps,
): Promise<JobWake["status"]> {
  const now = deps.now ?? Date.now;
  const log =
    deps.log ??
    ((...args: unknown[]) => console.log(new Date().toISOString(), ...args));
  const facts = await readFacts(deps.factsFile);
  const fact =
    facts.find((row) => row.name === name && row.startedAt === startedAt) ??
    null;
  if (!fact) {
    log(`wake: ${name}@${startedAt} is not in the facts table`);
    return "failed";
  }

  if (fact.ok) {
    const recorded = await recordOutcome(deps, name, startedAt, {
      at: now(),
      status: "empty",
      error: null,
    });
    log(`wake: ${name} succeeded; no agent turn needed`);
    return recorded ? "empty" : "failed";
  }

  let message: string;
  try {
    const turn = await deps.runTurn(jobWakePrompt(fact, deps.tr));
    // Провал — только `failed`. `waiting` — нормальный конец хода: eve не шлёт
    // `session.completed`, после хода сессия остаётся ждать следующего сообщения
    // (прод c1 13.09: каждое пробуждение падало как «turn waiting»).
    if (turn.status === "failed") throw new Error(`turn ${turn.status}`);
    message = (turn.message ?? "").trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await recordOutcome(deps, name, startedAt, {
      at: now(),
      status: "failed",
      error: reason,
    });
    log(`wake: ${name} turn failed: ${reason}`);
    return "failed";
  }

  if (message.length === 0) {
    const recorded = await recordOutcome(deps, name, startedAt, {
      at: now(),
      status: "empty",
      error: null,
    });
    log(`wake: ${name} answered with an empty message`);
    // Исход не записался — ход для сторожа не состоялся: иначе он видит wake=null и шлёт
    // второе сообщение владельцу (T30 №10).
    return recorded ? "empty" : "failed";
  }

  let sendError: string | null = null;
  try {
    if (!(await deps.send(message))) sendError = "telegram send was refused";
  } catch (error) {
    sendError = error instanceof Error ? error.message : String(error);
  }
  // Ответ, который не доехал, — провал хода, а не состоявшийся ответ: владелец не получил
  // ничего, и страховка обязана считать такой ход не бывшим (слепая приёмка T20 по v6).
  const recorded = await recordOutcome(deps, name, startedAt, {
    at: now(),
    status: sendError === null ? "answered" : "failed",
    error: sendError,
  });
  log(
    sendError
      ? `wake: ${name} answered, but the owner did not get it: ${sendError}`
      : `wake: ${name} answered the owner`,
  );
  // Несданный исход = ход не состоялся для сторожа (T30 №10).
  if (!recorded) return "failed";
  return sendError === null ? "answered" : "failed";
}

async function recordOutcome(
  deps: JobWakeDeps,
  name: string,
  startedAt: number,
  wake: JobWake,
): Promise<boolean> {
  try {
    await recordWake(deps.factsFile, name, startedAt, wake);
    return true;
  } catch (error) {
    // Запись исхода не сдалась: для сторожа хода не было, поэтому вызывающий обязан
    // вернуть failed, а не выдать отправку за состоявшийся ход (T30 №10).
    const log = deps.log ?? console.error;
    log(
      `wake: could not record the outcome of ${name}@${startedAt}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
