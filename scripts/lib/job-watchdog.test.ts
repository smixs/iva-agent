/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations. */
// Дневной сторож (T20 п.4): одно сообщение в сутки, когда провалы есть, а агент молчит.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { jobFactsFile, recordFact, type JobFact } from "#lib/job-facts.ts";
import {
  WATCHDOG_SEND_INTERVAL_MS,
  readWatchdogState,
  runJobWatchdog,
  watchdogDecision,
  watchdogMessage,
  watchdogStateFile,
} from "./job-watchdog.ts";
import { tempDir } from "../fixtures/temp-dir.ts";

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const tr = (_en: string, ru: string) => ru;

function fact(overrides: Partial<JobFact> = {}): JobFact {
  return {
    name: "memory-night",
    startedAt: NOW - 2 * HOUR,
    finishedAt: NOW - 2 * HOUR + 1000,
    ok: false,
    error: "exited 1",
    exitCode: 1,
    tail: "",
    acked: false,
    wake: null,
    ...overrides,
  };
}

function dir(): string {
  return tempDir("t20-watchdog-");
}

test("провал есть, ходов нет — одно сообщение с числом и doctor", () => {
  assert.equal(
    watchdogMessage([{ source: "job", name: "x", at: NOW, reason: "r" }], tr),
    "за сутки провалов расписаний: 1; агент не отвечает; iva doctor",
  );
  const message = watchdogDecision({
    facts: [fact()],
    now: NOW,
    lastSentAt: null,
    tr,
  });
  assert.match(message ?? "", /провалов расписаний: 1/u);
  assert.match(message ?? "", /iva doctor/u);
});

test("состоявшийся ход агента (в том числе пустой) отменяет страховку", () => {
  for (const status of ["answered", "empty"] as const) {
    assert.equal(
      watchdogDecision({
        facts: [fact({ wake: { at: NOW - HOUR, status, error: null } })],
        now: NOW,
        lastSentAt: null,
        tr,
      }),
      null,
      status,
    );
  }
  assert.match(
    watchdogDecision({
      facts: [
        fact({
          wake: { at: NOW - HOUR, status: "failed", error: "turn stuck" },
        }),
      ],
      now: NOW,
      lastSentAt: null,
      tr,
    }) ?? "",
    /не отвечает/u,
    "провал пробуждения — агент не отвечает",
  );
});

test("ход до провала не гасит провал: страховка уходит", () => {
  // Проверка T20 (раунд 3): агент отвечал 23 часа назад, а провал случился час назад и его
  // пробуждение упало. Раньше старый ход гасил свежий провал, а на следующем суточном тике
  // провал уже выпадал из окна — сообщение не уходило никогда.
  const message = watchdogDecision({
    facts: [
      fact({
        name: "memory-night",
        startedAt: NOW - 23 * HOUR,
        finishedAt: NOW - 23 * HOUR + 1000,
        ok: true,
        error: null,
        exitCode: 0,
        wake: { at: NOW - 23 * HOUR + 2000, status: "answered", error: null },
      }),
      fact({
        name: "jobs-watchdog",
        startedAt: NOW - HOUR,
        finishedAt: NOW - HOUR + 1000,
        wake: null,
      }),
    ],
    now: NOW,
    lastSentAt: null,
    tr,
  });
  assert.match(message ?? "", /провалов расписаний: 1/u);
});

test("без провалов и после отправки сообщения не шлём", () => {
  assert.equal(
    watchdogDecision({
      facts: [fact({ ok: true, error: null })],
      now: NOW,
      lastSentAt: null,
      tr,
    }),
    null,
  );
  assert.equal(
    watchdogDecision({
      facts: [fact()],
      now: NOW,
      lastSentAt: NOW - HOUR,
      tr,
    }),
    null,
    "не чаще одного в сутки",
  );
  assert.match(
    watchdogDecision({
      facts: [fact()],
      now: NOW,
      lastSentAt: NOW - WATCHDOG_SEND_INTERVAL_MS - HOUR,
      tr,
    }) ?? "",
    /провалов/u,
    "сутки прошли — можно снова",
  );
});

test("запуск сторожа: отправка один раз, состояние пишется после успеха", async () => {
  const dataDir = dir();
  await recordFact(jobFactsFile(dataDir), fact(), NOW);
  const sent: string[] = [];
  const first = await runJobWatchdog({
    dataDir,
    tr,
    send: (text) => {
      sent.push(text);
      return Promise.resolve(true);
    },
    now: () => NOW,
    log: () => {},
  });
  assert.match(first ?? "", /провалов/u);
  assert.equal(sent.length, 1);
  assert.equal(readWatchdogState(watchdogStateFile(dataDir))?.lastSentAt, NOW);

  const second = await runJobWatchdog({
    dataDir,
    tr,
    send: () => {
      throw new Error("must not send twice");
    },
    now: () => NOW + HOUR,
    log: () => {},
  });
  assert.equal(second, null);
});

test("неудачная отправка — отказ наружу, метка не ставится", async () => {
  // Проверка v6 (HIGH-3): раньше отказ транспорта возвращался как обычный текст, точка
  // входа финишировала нулём, и запуск сторожа записывался успешным.
  const dataDir = dir();
  await recordFact(jobFactsFile(dataDir), fact(), NOW);
  await assert.rejects(
    () =>
      runJobWatchdog({
        dataDir,
        tr,
        send: () => Promise.resolve(false),
        now: () => NOW,
        log: () => {},
      }),
    /not sent|не отправлено/iu,
  );
  assert.equal(readWatchdogState(watchdogStateFile(dataDir)), null);
});

test("недоехавший ответ агента не считается состоявшимся ходом", () => {
  // Проверка v6 (HIGH-2): ответ есть, но владелец его не получил — страховка обязана уйти.
  assert.match(
    watchdogDecision({
      facts: [
        fact({
          wake: {
            at: NOW - 1000,
            status: "answered",
            error: "telegram send was refused",
          },
        }),
      ],
      now: NOW,
      lastSentAt: null,
      tr,
    }) ?? "",
    /не отвечает/u,
  );
});

test("метка из будущего (откат часов) не глушит страховку", () => {
  // Проверка v6 (MEDIUM-2): отрицательный возраст метки проходил проверку окна.
  assert.match(
    watchdogDecision({
      facts: [fact()],
      now: NOW,
      lastSentAt: NOW + 365 * 24 * HOUR,
      tr,
    }) ?? "",
    /провалов расписаний: 1/u,
  );
});

test("нечитаемая таблица: сторож говорит о ней, и тоже раз в сутки", async () => {
  // Слепая приёмка T20 (F2): при чужом корне таблицы агент проснуться не может, и сторож
  // раньше падал до всякого решения — страховка умирала ровно в своём состоянии.
  const dataDir = dir();
  writeFileSync(jobFactsFile(dataDir), JSON.stringify({ "memory-night": {} }));
  const sent: string[] = [];
  const first = await runJobWatchdog({
    dataDir,
    tr,
    send: (text) => {
      sent.push(text);
      return Promise.resolve(true);
    },
    now: () => NOW,
    log: () => {},
  });
  assert.match(first ?? "", /таблица фактов расписаний не читается/u);
  assert.match(first ?? "", /iva doctor/u);
  assert.equal(sent.length, 1);

  const second = await runJobWatchdog({
    dataDir,
    tr,
    send: () => {
      throw new Error("must not send twice");
    },
    now: () => NOW + HOUR,
    log: () => {},
  });
  assert.equal(second, null);
});

test("битое состояние сторожа не глушит сообщение о провале", async () => {
  // Состояние — это только дроссель. Если оно испорчено, страховка обязана сработать (и
  // перезаписать файл), а не молчать вместе с ним.
  const dataDir = dir();
  await recordFact(jobFactsFile(dataDir), fact(), NOW);
  writeFileSync(watchdogStateFile(dataDir), "{ not json");
  const sent: string[] = [];
  const message = await runJobWatchdog({
    dataDir,
    tr,
    send: (text) => {
      sent.push(text);
      return Promise.resolve(true);
    },
    now: () => NOW,
    log: () => {},
  });
  assert.match(message ?? "", /провалов расписаний: 1/u);
  assert.equal(sent.length, 1);
  assert.equal(readWatchdogState(watchdogStateFile(dataDir))?.lastSentAt, NOW);
});

test("битое состояние сторожа — явная ошибка, нет файла — null", () => {
  const file = join(dir(), "jobs-watchdog.json");
  assert.equal(readWatchdogState(file), null);
  writeFileSync(file, "{");
  assert.throws(() => readWatchdogState(file), /damaged/u);
  writeFileSync(file, JSON.stringify({ lastSentAt: "вчера" }));
  assert.throws(() => readWatchdogState(file), /not a watchdog state/u);
});

test("точка входа watchdog.ts шлёт владельцу кодом через тот же сторож", () => {
  const entry = readFileSync(
    fileURLToPath(new URL("../jobs/watchdog.ts", import.meta.url)),
    "utf8",
  );
  assert.match(entry, /runJobWatchdog\(/u);
  assert.match(entry, /sendTelegramHtml\(/u);
});

// T30 №6: существующее, но нечитаемое состояние — не «никогда не отправляли».
test("T30 №6: нечитаемое состояние дросселя не рождает второе сообщение", async () => {
  const root = dir();
  await recordFact(jobFactsFile(root), fact(), NOW);
  mkdirSync(join(root, "jobs-watchdog.json"), { recursive: true });
  const sent: string[] = [];
  const send = async (text: string) => {
    sent.push(text);
    return true;
  };
  const first = await runJobWatchdog({
    dataDir: root,
    tr: (en: string) => en,
    send,
    now: () => NOW,
    log: () => {},
  });
  const second = await runJobWatchdog({
    dataDir: root,
    tr: (en: string) => en,
    send,
    now: () => NOW + 60 * 60 * 1000,
    log: () => {},
  });
  assert.equal(first, null, "первый прогон отправил при нечитаемом состоянии");
  assert.equal(second, null);
  assert.deepEqual(sent, [], "сообщение ушло при нечитаемом состоянии");
});

test("сторож молчит о провале снятого расписания", () => {
  for (const name of [
    "memory-daily",
    "memory-weekly",
    "memory-monthly",
    "memory-yearly",
  ])
    assert.equal(
      watchdogDecision({
        facts: [fact({ name })],
        now: NOW,
        lastSentAt: null,
        tr,
      }),
      null,
      name,
    );
});
