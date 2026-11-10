/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// «Незакрытые провалы» (T20 п.3, ADR-0020): закрытие успехом и ack, окно суток у напоминаний,
// напоминания рядом с расписаниями, пустой блок.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";

import {
  OPEN_FAILURES_WINDOW_MS,
  openFailures,
  openFailuresFrom,
  openFailuresMarkdown,
  openJobFailures,
  openReminderFailures,
} from "./open-failures.ts";
import {
  jobFactsFile,
  readFactsSync,
  recordFact,
  type JobFact,
} from "./job-facts.ts";
import type { Reminder } from "./reminder-store.ts";
import { tempDir } from "../../scripts/fixtures/temp-dir.ts";

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function fact(overrides: Partial<JobFact> = {}): JobFact {
  return {
    name: "memory-night",
    startedAt: NOW - 1000,
    finishedAt: NOW,
    ok: true,
    error: null,
    exitCode: 0,
    tail: "",
    acked: false,
    wake: null,
    ...overrides,
  };
}

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "r1",
    text: "позвонить",
    chat: null,
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    nextRunAtMs: NOW,
    createdAt: NOW - 2 * HOUR,
    status: "pending",
    firedAt: NOW - HOUR,
    delivered: false,
    error: "TELEGRAM_BOT_TOKEN is missing",
    ...overrides,
  };
}

test("провал расписания открыт, закрывается успехом и ack", () => {
  const failed = fact({ ok: false, error: "exited 1" });
  assert.deepEqual(
    openJobFailures([failed]).map((entry) => entry.name),
    ["memory-night"],
  );
  assert.equal(
    openJobFailures([failed, fact({ ok: true, finishedAt: NOW + 1 })]).length,
    0,
    "поздний успех закрывает",
  );
  assert.equal(
    openJobFailures([
      fact({
        ok: false,
        error: "exited 1",
        finishedAt: NOW - 2 * HOUR,
        acked: true,
      }),
    ]).length,
    0,
    "ack закрывает",
  );
});

// ADR-0020: непочиненный сбой называется в утреннем Brief каждый день до починки. Провал задания
// открыт, пока он последний факт своего имени, не закрыт ack и строка жива в jobs.json (ротация —
// 7 дней); суточного окна у задания нет. Прежний тест закреплял окно и с ADR расходился.
test("провал старше суток открыт, пока не починен (успех) и не закрыт ack; пустой список — пусто", () => {
  const old = fact({
    ok: false,
    error: "exited 1",
    finishedAt: NOW - 3 * OPEN_FAILURES_WINDOW_MS,
  });
  assert.deepEqual(
    openJobFailures([old]).map((entry) => entry.name),
    ["memory-night"],
  );
  assert.equal(
    openJobFailures([old, fact({ finishedAt: NOW - HOUR })]).length,
    0,
  );
  assert.equal(openJobFailures([{ ...old, acked: true }]).length, 0);
  assert.equal(openJobFailures([]).length, 0);
});

// Путь потребителя (Brief через openFailures, инструкция 40-open-failures): здесь `now` задан,
// и суточное окно, вернись оно в openFailuresFrom, спрятало бы провал. Прежний тест звал
// openJobFailures без `now` и окно не видел.
test("провал задания старше суток без успеха и ack виден потребителю (openFailuresFrom и openFailures)", async () => {
  const old = fact({
    ok: false,
    error: "exited 1",
    startedAt: NOW - 3 * OPEN_FAILURES_WINDOW_MS - 1000,
    finishedAt: NOW - 3 * OPEN_FAILURES_WINDOW_MS,
  });
  assert.deepEqual(
    openFailuresFrom([old], [], NOW).map((entry) => entry.name),
    ["memory-night"],
  );
  const dir = tempDir("iva-open-failures-old-");
  await recordFact(jobFactsFile(dir), old, NOW);
  const fromDisk = await openFailures({
    dir,
    now: NOW,
    readReminders: () => Promise.resolve([]),
  });
  assert.deepEqual(
    fromDisk.map((entry) => entry.name),
    ["memory-night"],
  );
});

test("причина без error не исчезает", () => {
  const [failure] = openJobFailures([fact({ ok: false, error: null })]);
  assert.equal(failure?.reason, "провал без причины");
});

test("провал напоминания виден по error и firedAt", () => {
  const open = openReminderFailures([reminder()], NOW);
  assert.equal(open.length, 1);
  assert.equal(open[0]?.name, "reminder-r1");
  assert.match(open[0]?.reason ?? "", /TELEGRAM_BOT_TOKEN/u);
  // Доехало без причины, ещё ни разу не срабатывала, сработала позавчера — не провал.
  assert.equal(
    openReminderFailures([reminder({ delivered: true, error: null })], NOW)
      .length,
    0,
  );
  assert.equal(
    openReminderFailures([reminder({ firedAt: null })], NOW).length,
    0,
  );
  assert.equal(
    openReminderFailures([reminder({ firedAt: NOW - 2 * day() })], NOW).length,
    0,
  );
});

function day(): number {
  return 24 * HOUR;
}

test("доставленное напоминание с записью ошибки не считается провалом", () => {
  // Проверка T20 (раунд 3): ход пробуждения мог упасть уже ПОСЛЕ доставки текста, и строка
  // несёт причину при delivered=true. Спека считает провалом именно недоставку.
  assert.deepEqual(
    openReminderFailures(
      [reminder({ delivered: true, error: "agent wake failed: turn stuck" })],
      NOW,
    ),
    [],
  );
  assert.equal(
    openReminderFailures(
      [reminder({ delivered: false, error: "TELEGRAM_BOT_TOKEN is missing" })],
      NOW,
    ).length,
    1,
  );
});

test("оба источника рядом, старые провалы первыми", () => {
  const failures = openFailuresFrom(
    [fact({ ok: false, error: "exited 3", finishedAt: NOW - 30 * 60 * 1000 })],
    [reminder({ firedAt: NOW - 2 * HOUR })],
    NOW,
  );
  assert.deepEqual(
    failures.map((entry) => entry.source),
    ["reminder", "job"],
  );
});

test("блок для промпта: пусто — пустая строка, иначе имя, время и причина", () => {
  assert.equal(openFailuresMarkdown([]), "");
  const text = openFailuresMarkdown(
    openFailuresFrom(
      [fact({ ok: false, error: "exited 1" })],
      [reminder()],
      NOW,
    ),
  );
  assert.match(text, /^## Незакрытые провалы\n/u);
  assert.match(text, /memory-night/u);
  assert.match(text, /iva jobs ack memory-night/u);
  assert.match(text, /reminder-r1/u);
});

test("openFailures читает факты с диска и напоминания из источника", async () => {
  const dir = tempDir("t20-open-");
  await recordFact(
    jobFactsFile(dir),
    fact({ ok: false, error: "exited 2" }),
    NOW,
  );
  const failures = await openFailures({
    dir,
    now: NOW,
    readReminders: () => Promise.resolve([reminder()]),
  });
  assert.deepEqual(failures.map((entry) => entry.name).sort(), [
    "memory-night",
    "reminder-r1",
  ]);
});

test("битая таблица фактов приходит в ход текстом, а не исключением", async () => {
  const dir = tempDir("t20-broken-");
  writeFileSync(jobFactsFile(dir), "{");
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  try {
    const instruction = await import("../instructions/40-open-failures.ts");
    const resolve = instruction.default.events["turn.started"];
    assert.ok(resolve, "инструкция слушает turn.started");
    const resolved = await resolve(null, {} as never);
    const markdown = (resolved as { markdown?: string } | null)?.markdown ?? "";
    assert.match(markdown, /Источник провалов не читается/u);
    assert.match(markdown, /jobs\.json/u);
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
  }
});

test("динамическая инструкция 40-open-failures несёт блок в ход", async () => {
  // Проводка до хода: инструкция читает таблицу из ASSISTANT_DATA_DIR и отдаёт блок
  // сама, без аргументов. Напоминаний в каталоге нет — провал расписания приходит один.
  const dir = tempDir("t20-instruction-");
  const now = Date.now();
  await recordFact(
    jobFactsFile(dir),
    fact({
      ok: false,
      error: "exited 2",
      startedAt: now - 2000,
      finishedAt: now - 1000,
    }),
    now,
  );
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  try {
    const instruction = await import("../instructions/40-open-failures.ts");
    const resolve = instruction.default.events["turn.started"];
    assert.ok(resolve, "инструкция слушает turn.started");
    const resolved = await resolve(null, {} as never);
    const markdown = (resolved as { markdown?: string } | null)?.markdown ?? "";
    assert.match(markdown, /^## Незакрытые провалы\n/u);
    assert.match(markdown, /memory-night.*exited 2/u);
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
  }
});

// T30 №7: блок инструкции не растёт без предела — число и длина причин ограничены.
test("T30 №7: блок инструкции ограничен по числу и длине", () => {
  const failures = Array.from({ length: 100 }, (_, index) => ({
    source: "job" as const,
    name: `job-${index}`,
    at: NOW,
    reason: "x".repeat(100_000),
  }));
  const block = openFailuresMarkdown(failures);
  assert.ok(block.length <= 6000, `блок распух: ${block.length} знаков`);
  assert.match(block, /job-0/);
});

// Хвост блока не зовёт `iva doctor`: в ходе его не запустить (сторож), а список провалов
// лежит в data/jobs.json.
test("21 провал: хвост блока называет data/jobs.json, а не iva doctor", () => {
  const failures = Array.from({ length: 21 }, (_, index) => ({
    source: "job" as const,
    name: `job-${index}`,
    at: NOW,
    reason: "exited 1",
  }));
  const tail = openFailuresMarkdown(failures).split("\n").at(-1) ?? "";
  assert.match(tail, /и ещё 1 провалов/u);
  assert.match(tail, /data\/jobs\.json/u);
  assert.doesNotMatch(tail, /iva doctor/u);
});

// Ремонт (Sol P2): снятые расписания (memory-daily, -weekly, -monthly, -yearly) остаются в
// jobs.json, но провалом не считаются нигде: ни в инструкции хода, ни у сторожа, ни в doctor.
test("снятое расписание не попадает в открытые провалы и в инструкцию хода", async () => {
  const dir = tempDir("t20-open-retired-");
  for (const name of [
    "memory-daily",
    "memory-weekly",
    "memory-monthly",
    "memory-yearly",
  ])
    await recordFact(
      jobFactsFile(dir),
      fact({
        name,
        ok: false,
        error: "exited 1",
        exitCode: 1,
        startedAt: NOW - HOUR,
        finishedAt: NOW - HOUR + 1,
      }),
      NOW,
    );
  assert.deepEqual(openJobFailures(readFactsSync(jobFactsFile(dir))), []);
  const failures = await openFailures({
    dir,
    now: NOW,
    readReminders: () => Promise.resolve([]),
  });
  assert.equal(openFailuresMarkdown(failures), "");
});
