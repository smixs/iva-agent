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
import fc from "fast-check";
import { agentTurnSeen, watchdogDecision } from "./job-watchdog.ts";
import {
  fixButtonData,
  jobWakePrompt,
  runJobWake,
  type Translate,
  type WakeTurnResult,
} from "./job-wake.ts";
import { tempDir } from "../fixtures/temp-dir.ts";

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const tr: Translate = (_en, ru) => ru;

function file(): string {
  return jobFactsFile(tempDir("t20-wake-"));
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

test("текст хода: провал — причина владельцу и кнопка «Починить», без тапа не чинить; ok — молчать", () => {
  const failed = jobWakePrompt(fact(), tr);
  assert.match(failed, /memory-daily/u);
  assert.match(failed, /провал/u);
  assert.match(failed, /exited 1/u);
  assert.match(failed, /Пока ничего не чини/u);
  assert.match(failed, /Чини только после тапа владельца/u);
  assert.match(
    failed,
    /<tg-button type="callback_data" data="Починить: memory-daily">Починить<\/tg-button>/u,
  );
  assert.doesNotMatch(failed, /починить сам/u);
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

test("ход упёрся в лимит сессии eve: причина остаётся в строке факта для сторожа", async () => {
  const factsFile = file();
  await recordFact(factsFile, fact(), NOW);
  const sent: string[] = [];
  const status = await runJobWake("memory-daily", NOW - 1000, {
    factsFile,
    tr,
    runTurn: () =>
      Promise.resolve({
        status: "failed",
        message: "the turn hit the eve session token limit",
      }),
    send: (text) => {
      sent.push(text);
      return Promise.resolve(true);
    },
    now: () => NOW + 5,
    log: () => {},
  });
  assert.equal(status, "failed");
  assert.deepEqual(sent, [], "устаревший текст хода владельцу не уходит");
  const wake = (await readFacts(factsFile))[0]?.wake;
  assert.equal(wake?.status, "failed");
  assert.match(wake?.error ?? "", /turn failed: .*session token limit/u);
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
  // Отправка — через шов sendHtml (по умолчанию sendTelegramHtml); поведение точки входа держит
  // scripts/jobs/wake.test.ts.
  assert.match(entry, /sendHtml = deps\.sendHtml \?\? sendTelegramHtml/u);
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

test("успешное расписание сообщает failed, когда запись результата недоступна", async () => {
  const facts = file();
  await recordFact(facts, fact({ ok: true, error: null, exitCode: 0 }), NOW);
  let calls = 0;
  const status = await runJobWake("memory-daily", NOW - 1000, {
    factsFile: facts,
    tr,
    runTurn: () => {
      calls += 1;
      return Promise.resolve({ status: "completed", message: "" });
    },
    send: () => Promise.resolve(true),
    recordWake: () => Promise.reject(new Error("durable write rejected")),
    now: () => NOW + 5,
    log: () => {},
  });
  assert.equal(status, "failed");
  assert.equal(calls, 0);
});

// Разбор строки jobs.json из 0.4.11 (3ad563e4, agent/lib/job-facts.ts:89-118) — копия: строку,
// которую пишет новая версия, старая обязана принять, иначе откат стирает отложенный провал.
function isFactAt3ad563e4(value: unknown): boolean {
  const isSafeInt = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v);
  const isWake = (v: unknown) => {
    if (typeof v !== "object" || v === null) return false;
    const wake = v as Record<string, unknown>;
    return (
      isSafeInt(wake.at) &&
      (wake.status === "answered" ||
        wake.status === "empty" ||
        wake.status === "failed") &&
      (wake.error === null || typeof wake.error === "string")
    );
  };
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.name === "string" &&
    f.name.length > 0 &&
    isSafeInt(f.startedAt) &&
    isSafeInt(f.finishedAt) &&
    (f.finishedAt as number) >= (f.startedAt as number) &&
    typeof f.ok === "boolean" &&
    (f.error === null || typeof f.error === "string") &&
    (f.exitCode === null || isSafeInt(f.exitCode)) &&
    typeof f.tail === "string" &&
    typeof f.acked === "boolean" &&
    (f.wake === null || isWake(f.wake))
  );
}

test("провал в тихие часы: ход идёт, но ничего не шлём, исход «отложен до утра» (deferred), сторож видит живого агента", async () => {
  const factsFile = file();
  await recordFact(factsFile, fact({ name: "memory-night" }), NOW);
  const sent: string[] = [];
  const turns: string[] = [];
  const logs: string[] = [];
  const status = await runJobWake("memory-night", NOW - 1000, {
    factsFile,
    tr,
    runTurn: (prompt) => {
      turns.push(prompt);
      return Promise.resolve({ status: "completed", message: "сломалось" });
    },
    send: (text) => {
      sent.push(text);
      return Promise.resolve(true);
    },
    quiet: (now) => now === NOW + 5,
    now: () => NOW + 5,
    log: (...args) => logs.push(args.join(" ")),
  });
  assert.equal(status, "deferred");
  // Ход идёт и ночью: только он доказывает сторожу, что агент жив (иначе страховка молчит).
  assert.equal(turns.length, 1);
  assert.deepEqual(sent, []);
  const facts = await readFacts(factsFile);
  // На диске — старый статус и необязательный признак: откат на 0.4.11 строку не теряет.
  assert.deepEqual(facts[0]?.wake, {
    at: NOW + 5,
    status: "empty",
    error: null,
    deferred: true,
  });
  const raw = JSON.parse(readFileSync(factsFile, "utf8")) as unknown[];
  assert.equal(raw.filter(isFactAt3ad563e4).length, raw.length);
  assert.match(logs.join("\n"), /deferred to the morning brief/u);
  // Провал остаётся открытым (его закрывает успех или ack), а сторож молчит: агент жив.
  assert.equal(facts[0]?.ok, false);
  assert.equal(agentTurnSeen(facts, NOW), true);
  assert.equal(
    watchdogDecision({ facts, now: NOW + 4 * 3_600_000, lastSentAt: null, tr }),
    null,
  );
});

test("провал в тихие часы, а агент не отвечает (ход упал или бросил) → исход failed, сторож говорит", async () => {
  const turns: Array<() => Promise<WakeTurnResult>> = [
    () => Promise.resolve({ status: "failed", message: "model down" }),
    () => Promise.reject(new Error("connect ECONNREFUSED")),
  ];
  for (const runTurn of turns) {
    const factsFile = file();
    await recordFact(factsFile, fact({ name: "memory-night" }), NOW);
    const sent: string[] = [];
    const status = await runJobWake("memory-night", NOW - 1000, {
      factsFile,
      tr,
      runTurn,
      send: (text) => {
        sent.push(text);
        return Promise.resolve(true);
      },
      quiet: () => true,
      now: () => NOW + 5,
      log: () => {},
    });
    assert.equal(status, "failed");
    assert.deepEqual(sent, []);
    const facts = await readFacts(factsFile);
    assert.equal(facts[0]?.wake?.status, "failed");
    assert.notEqual(facts[0]?.wake?.error, null);
    assert.equal(agentTurnSeen(facts, NOW), false);
    assert.match(
      watchdogDecision({
        facts,
        now: NOW + 4 * 3_600_000,
        lastSentAt: null,
        tr,
      }) ?? "",
      /агент не отвечает/u,
    );
  }
});

test("вне тихих часов провал будит ход, как раньше", async () => {
  const factsFile = file();
  await recordFact(factsFile, fact(), NOW);
  const sent: string[] = [];
  const asked: number[] = [];
  const status = await runJobWake("memory-daily", NOW - 1000, {
    factsFile,
    tr,
    runTurn: () =>
      Promise.resolve({ status: "completed", message: "сломалось" }),
    send: (text) => {
      sent.push(text);
      return Promise.resolve(true);
    },
    quiet: (now) => {
      asked.push(now);
      return false;
    },
    now: () => NOW + 5,
    log: () => {},
  });
  assert.equal(status, "answered");
  assert.deepEqual(sent, ["сломалось"]);
  assert.deepEqual(asked, [NOW + 5]);
});

const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);

test(`PBT: data кнопки «Починить» — префикс и имя, не длиннее 64 байт (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.string({ unit: "grapheme", maxLength: 80 }), (name) => {
      for (const t of [tr, ((en: string) => en) as Translate]) {
        const full = t(`Fix: ${name}`, `Починить: ${name}`);
        const data = fixButtonData(name, t);
        assert.ok(Buffer.byteLength(data) <= 64, data);
        assert.ok(data.startsWith(t("Fix: ", "Починить: ")), data);
        assert.ok(full.startsWith(data), data);
        if (Buffer.byteLength(full) <= 64) assert.equal(data, full);
      }
    }),
    { seed: SEED },
  );
});
