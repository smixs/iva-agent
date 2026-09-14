/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations. */
// Пробуждение агента после запуска расписания (T20 п.2): пустой ответ ничего не шлёт,
// провальный — уходит владельцу, провал самого хода — факт в таблице.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  jobFactsFile,
  readFacts,
  recordFact,
  type JobFact,
} from "#lib/job-facts.ts";
import { jobWakePrompt, runJobWake, type Translate } from "./job-wake.ts";

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const tr: Translate = (_en, ru) => ru;

function file(): string {
  return jobFactsFile(mkdtempSync(join(tmpdir(), "t20-wake-")));
}

function fact(overrides: Partial<JobFact> = {}): JobFact {
  return {
    name: "memory-daily",
    startedAt: NOW - 1000,
    finishedAt: NOW,
    ok: false,
    error: "exited 1",
    exitCode: 1,
    tail: "card broken",
    acked: false,
    wake: null,
    ...overrides,
  };
}

test("текст хода: провал посылает чинить, ok — молчать и ответить пустым", () => {
  const failed = jobWakePrompt(fact(), tr);
  assert.match(failed, /memory-daily/u);
  assert.match(failed, /провал/u);
  assert.match(failed, /exited 1/u);
  assert.match(failed, /починить сам/u);
  assert.match(failed, /card broken/u);

  const ok = jobWakePrompt(fact({ ok: true, error: null, exitCode: 0 }), tr);
  assert.match(ok, /ок/u);
  assert.match(ok, /ответь пустым/u);
  assert.doesNotMatch(ok, /починить сам/u);
});

test("пустой ответ ничего не отправляет, факт говорит empty", async () => {
  const factsFile = file();
  await recordFact(factsFile, fact(), NOW);
  const sent: string[] = [];
  const status = await runJobWake("memory-daily", NOW - 1000, {
    factsFile,
    tr,
    runTurn: () => Promise.resolve({ status: "completed", message: "  \n " }),
    send: (text) => {
      sent.push(text);
      return Promise.resolve(true);
    },
    now: () => NOW + 5,
    log: () => {},
  });
  assert.equal(status, "empty");
  assert.deepEqual(sent, []);
  assert.equal((await readFacts(factsFile))[0]?.wake?.status, "empty");
});

test("waiting — нормальный конец хода: сессия ждёт следующего сообщения", async () => {
  // Прод c1 13.09: eve не шлёт `session.completed` — после хода сессия остаётся ждать, и
  // `reduceTurnEvents` даёт `waiting`. Пробуждение считало это провалом («turn waiting»)
  // на каждом ходу.
  const factsFile = file();
  await recordFact(factsFile, fact(), NOW);
  const sent: string[] = [];
  const status = await runJobWake("memory-daily", NOW - 1000, {
    factsFile,
    tr,
    runTurn: () => Promise.resolve({ status: "waiting", message: "  \n " }),
    send: (text) => {
      sent.push(text);
      return Promise.resolve(true);
    },
    now: () => NOW + 5,
    log: () => {},
  });
  assert.equal(status, "empty");
  assert.deepEqual(sent, []);
  assert.equal((await readFacts(factsFile))[0]?.wake?.status, "empty");
});

test("status failed остаётся провалом хода", async () => {
  const factsFile = file();
  await recordFact(factsFile, fact(), NOW);
  const status = await runJobWake("memory-daily", NOW - 1000, {
    factsFile,
    tr,
    runTurn: () => Promise.resolve({ status: "failed", message: "" }),
    send: () => Promise.resolve(true),
    now: () => NOW + 5,
    log: () => {},
  });
  assert.equal(status, "failed");
  const wake = (await readFacts(factsFile))[0]?.wake;
  assert.equal(wake?.status, "failed");
  assert.match(wake?.error ?? "", /turn failed/u);
});

test("непустой ответ уходит владельцу, факт говорит answered", async () => {
  const factsFile = file();
  await recordFact(factsFile, fact(), NOW);
  const sent: string[] = [];
  const status = await runJobWake("memory-daily", NOW - 1000, {
    factsFile,
    tr,
    runTurn: () =>
      Promise.resolve({ status: "completed", message: " всё сломалось" }),
    send: (text) => {
      sent.push(text);
      return Promise.resolve(true);
    },
    now: () => NOW + 5,
    log: () => {},
  });
  assert.equal(status, "answered");
  assert.deepEqual(sent, ["всё сломалось"]);
  assert.equal((await readFacts(factsFile))[0]?.wake?.status, "answered");
});

test("провал хода остаётся фактом с причиной", async () => {
  const factsFile = file();
  await recordFact(factsFile, fact(), NOW);
  const status = await runJobWake("memory-daily", NOW - 1000, {
    factsFile,
    tr,
    runTurn: () => Promise.reject(new Error("no activity for 180000ms")),
    send: () => Promise.resolve(true),
    now: () => NOW + 5,
    log: () => {},
  });
  assert.equal(status, "failed");
  const wake = (await readFacts(factsFile))[0]?.wake;
  assert.equal(wake?.status, "failed");
  assert.match(wake?.error ?? "", /no activity/u);
});

test("отказ доставки — провал хода, а не состоявшийся ответ", async () => {
  // Проверка v6 (HIGH-2): владелец не получил ни ответа агента, ни страховки — ход
  // помечался «answered», и сторож считал его состоявшимся.
  const factsFile = file();
  await recordFact(factsFile, fact(), NOW);
  const status = await runJobWake("memory-daily", fact().startedAt, {
    factsFile,
    tr,
    runTurn: () =>
      Promise.resolve({ status: "completed", message: "сломалось" }),
    send: () => Promise.resolve(false),
    now: () => NOW,
    log: () => {},
  });
  assert.equal(status, "failed");
  const [written] = await readFacts(factsFile);
  assert.equal(written?.wake?.status, "failed");
  assert.match(written?.wake?.error ?? "", /refus|отказ/iu);
});

test("исключение транспорта — тоже провал хода, причина в строке", async () => {
  const factsFile = file();
  await recordFact(factsFile, fact(), NOW);
  const status = await runJobWake("memory-daily", NOW - 1000, {
    factsFile,
    tr,
    runTurn: () => Promise.resolve({ status: "completed", message: "привет" }),
    send: () => Promise.reject(new Error("telegram 500")),
    now: () => NOW + 5,
    log: () => {},
  });
  assert.equal(status, "failed");
  const wake = (await readFacts(factsFile))[0]?.wake;
  assert.equal(wake?.status, "failed");
  assert.match(wake?.error ?? "", /telegram 500/u);
});

test("строки нет — будить нечего, исход failed", async () => {
  const factsFile = file();
  await recordFact(factsFile, fact(), NOW);
  const status = await runJobWake("memory-daily", NOW + 1, {
    factsFile,
    tr,
    runTurn: () => Promise.resolve({ status: "completed", message: "x" }),
    send: () => Promise.resolve(true),
    log: () => {},
  });
  assert.equal(status, "failed");
  assert.equal((await readFacts(factsFile))[0]?.wake, null);
});

test("точка входа wake.ts зовёт общий ход и шлёт ответ кодом", () => {
  const entry = readFileSync(
    fileURLToPath(new URL("../jobs/wake.ts", import.meta.url)),
    "utf8",
  );
  assert.match(entry, /runJobWake\(/u);
  assert.match(entry, /runReminderTurn\(/u);
  assert.match(entry, /sendTelegramHtml\(/u);
});

// T30 №10: отказ записи исхода хода — failed, иначе сторож шлёт второе сообщение.
test("T30 №10: отказ записи исхода — failed, а не answered", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-wake-ro-"));
  const facts = join(root, "jobs.json");
  await recordFact(facts, fact(), NOW);
  chmodSync(root, 0o555);
  try {
    const sent: string[] = [];
    const status = await runJobWake("memory-daily", NOW - 1000, {
      factsFile: facts,
      tr: (en: string) => en,
      runTurn: async () => ({ status: "completed", message: "готово" }),
      send: async (text: string) => {
        sent.push(text);
        return true;
      },
      now: () => NOW,
      log: () => {},
    });
    assert.equal(status, "failed", "отказ записи исхода выдан за ответ");
    assert.equal(sent.length, 1);
  } finally {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

test("успешное расписание не открывает модельный ход и фиксируется как empty", async () => {
  const factsFile = file();
  await recordFact(
    factsFile,
    fact({ ok: true, error: null, exitCode: 0 }),
    NOW,
  );
  let calls = 0;
  const status = await runJobWake("memory-daily", NOW - 1000, {
    factsFile,
    tr,
    runTurn: () => {
      calls += 1;
      return Promise.resolve({ status: "completed", message: "" });
    },
    send: () => Promise.resolve(true),
    now: () => NOW + 5,
    log: () => {},
  });
  assert.equal(status, "empty");
  assert.equal(calls, 0);
  assert.equal((await readFacts(factsFile))[0]?.wake?.status, "empty");
});
