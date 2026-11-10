// T20 п.1-2: запуск расписания оставляет факт по политике задания (по умолчанию каждый), а
// после факта зовётся пробуждение.
// Прогон интеграционный, как в schedule-runner.test.ts: настоящий ребёнок-node с
// --env-file=.env, а пробуждение подменено шпионом.
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readFacts } from "./job-facts.ts";
import { runScheduledJob } from "./schedule-runner.ts";
import { tempDir } from "../../scripts/fixtures/temp-dir.ts";

async function scaffold(): Promise<string> {
  const root = tempDir("iva-runner-facts-");
  await writeFile(join(root, ".env"), "", "utf8");
  return root;
}

void test("успех: факт записан, пробуждение позвано со startedAt строки", async () => {
  const root = await scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  const statusPath = join(root, "data/rollup-status.json");
  const factsPath = join(root, "data/jobs.json");
  await mkdir(join(root, "data"), { recursive: true });
  const woken: Array<[string, number]> = [];

  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    factsPath,
    wakeImpl: (name, startedAt) => {
      woken.push([name, startedAt]);
    },
    log: () => {},
  });

  assert.equal(result.ok, true);
  const facts = await readFacts(factsPath);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.name, "memory-daily");
  assert.equal(facts[0]?.ok, true);
  assert.equal(facts[0]?.error, null);
  assert.equal(facts[0]?.exitCode, 0);
  assert.deepEqual(woken, [["memory-daily", facts[0]?.startedAt]]);
});

void test("провал: факт с причиной и хвостом, пробуждение всё равно зовётся", async () => {
  const root = await scaffold();
  await writeFile(
    join(root, "fail.ts"),
    'process.stderr.write("boom: card is broken\\n"); process.exit(7);\n',
  );
  const statusPath = join(root, "data/rollup-status.json");
  const factsPath = join(root, "data/jobs.json");
  await mkdir(join(root, "data"), { recursive: true });
  const woken: string[] = [];

  const result = await runScheduledJob({
    name: "digest",
    argv: ["fail.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    factsPath,
    wakeImpl: (name) => {
      woken.push(name);
    },
    log: () => {},
  });

  assert.equal(result.ok, false);
  const [fact] = await readFacts(factsPath);
  assert.equal(fact?.ok, false);
  assert.equal(fact?.error, "exited 7");
  assert.match(fact?.tail ?? "", /boom: card is broken/u);
  assert.deepEqual(woken, ["digest"]);
});

void test("хвост факта не несёт пароль из окружения запуска", async () => {
  // Репро слепой приёмки T20 (a4): ребёнок печатает URL с паролем, значение лежит в
  // окружении запуска под ключом без слова-приметы — в data/jobs.json пароля быть не должно.
  const root = await scaffold();
  await writeFile(
    join(root, "leak.ts"),
    'process.stderr.write("provider " + process.env.CUSTOM_BASE_URL + " rejected\\n");\n' +
      // Пароль отдельным словом, без `@`: так его не спасёт ни одна форма, кроме правила
      // «значение ключа .env — секрет» (иначе пароль вырезал бы шаблон e-mail). Печать в
      // stderr: в факт идёт причина, а не отчёт скрипта (спека T20 п.1).
      'process.stderr.write("upstream says bpass1111 is wrong\\n"); process.exit(3);\n',
  );
  const factsPath = join(root, "data/jobs.json");
  await mkdir(join(root, "data"), { recursive: true });

  await runScheduledJob({
    name: "digest",
    argv: ["leak.ts"],
    root,
    nodeBin: process.execPath,
    factsPath,
    env: {
      ...process.env,
      CUSTOM_BASE_URL: "https://buser:bpass1111@api.example.com/v1",
    },
    wakeImpl: () => {},
    log: () => {},
  });

  const [written] = await readFacts(factsPath);
  assert.ok(written, "факт записан");
  assert.ok(
    !written.tail.includes("bpass1111"),
    `пароль доехал до таблицы фактов: ${written.tail}`,
  );
  assert.ok(written.tail.includes("<redacted>"), written.tail);
});

void test("провал ребёнка пробуждения виден в журнале и в строке факта", async () => {
  // Слепая приёмка T20 (F4): ребёнок отвязан (detached, stdio ignore), и раньше его провал
  // (нет wake.ts, ENOENT, ненулевой код) не попадал никуда — ни строки, ни отметки.
  const root = await scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  const factsPath = join(root, "data/jobs.json");
  await mkdir(join(root, "data"), { recursive: true });
  const lines: string[] = [];

  await runScheduledJob({
    name: "memory-daily",
    argv: ["ok.ts"],
    root, // в этом корне нет scripts/jobs/wake.ts — ребёнок умрёт сам
    nodeBin: process.execPath,
    factsPath,
    log: (...args) => lines.push(args.map(String).join(" ")),
  });

  // Ребёнок живёт своей жизнью: ждём его исход, но недолго.
  let wake = null;
  for (let attempt = 0; attempt < 60 && wake === null; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    wake = (await readFacts(factsPath))[0]?.wake ?? null;
  }
  assert.equal(
    wake?.status,
    "failed",
    `исход пробуждения: ${JSON.stringify(wake)}`,
  );
  assert.match(wake?.error ?? "", /.+/u, "причина провала не записана");
  assert.ok(
    lines.some((line) => /wake/iu.test(line) && /memory-daily/u.test(line)),
    `в журнале нет строки про пробуждение: ${lines.join(" | ")}`,
  );
});

void test("секрет на границе обрезки хвоста не доезжает до таблицы", async () => {
  // Проверка T20 (раунд 3): хвост резался по 4000 знаков ДО вырезания, граница рассекала
  // значение, и суффикс секрета лежал в jobs.json (а оттуда ехал в текст пробуждения).
  const root = await scaffold();
  await writeFile(
    join(root, "loud.ts"),
    'process.stderr.write(process.env.CUSTOM_API_KEY + "y".repeat(3990) + "\\n"); process.exit(4);\n',
  );
  const factsPath = join(root, "data/jobs.json");
  await mkdir(join(root, "data"), { recursive: true });

  await runScheduledJob({
    name: "digest",
    argv: ["loud.ts"],
    root,
    nodeBin: process.execPath,
    factsPath,
    env: { ...process.env, CUSTOM_API_KEY: "sk-live-VERY-SECRET-1234" },
    wakeImpl: () => {},
    log: () => {},
  });

  const [written] = await readFacts(factsPath);
  assert.ok(written, "факт записан");
  assert.ok(
    !/ECRET-1234/u.test(written.tail),
    `суффикс секрета в хвосте: ${written.tail.slice(0, 80)}`,
  );
  assert.match(written.tail, /<redacted>/u);
});

void test("хвост факта — причина из stderr, а не отчёт из stdout", async () => {
  // Спека T20 п.1: в факте «последние 20 строк stderr». Отчёт скрипта в stdout вытеснял
  // причину провала из хвоста и стоил токенов на пробуждении (проверка T20, раунд 3).
  const root = await scaffold();
  await writeFile(
    join(root, "mixed.ts"),
    'process.stderr.write("REAL-REASON: disk full\\n");\n' +
      'process.stdout.write("STDOUT-REPORT " + "z".repeat(5000) + "\\n");\n' +
      "process.exit(5);\n",
  );
  const factsPath = join(root, "data/jobs.json");
  await mkdir(join(root, "data"), { recursive: true });

  await runScheduledJob({
    name: "memory-daily",
    argv: ["mixed.ts"],
    root,
    nodeBin: process.execPath,
    factsPath,
    wakeImpl: () => {},
    log: () => {},
  });

  const [written] = await readFacts(factsPath);
  assert.ok(written, "факт записан");
  assert.match(written.tail, /REAL-REASON: disk full/u);
  assert.ok(
    !written.tail.includes("STDOUT-REPORT"),
    `отчёт stdout в хвосте факта: ${written.tail.slice(0, 80)}`,
  );
});

void test("wake:false пишет факт, но не будит", async () => {
  const root = await scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  const statusPath = join(root, "data/rollup-status.json");
  const factsPath = join(root, "data/jobs.json");
  await mkdir(join(root, "data"), { recursive: true });
  let woken = 0;

  await runScheduledJob({
    name: "jobs-watchdog",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    factsPath,
    wake: false,
    wakeImpl: () => {
      woken += 1;
    },
    log: () => {},
  });

  assert.equal((await readFacts(factsPath)).length, 1);
  assert.equal(woken, 0);
});

void test("факт не записался — запуск не успешный, причина в журнале", async () => {
  // Проверка v6 (HIGH-1): раннер глотал отказ записи, возвращал ok:true и писал
  // lastSuccessAt, хотя строки в таблице нет и пробуждение не пошло.
  const root = await scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  const lines: string[] = [];

  // T30 №5: провал записи обязательного факта — отказ запуска, а не поле в исполненном
  // промиса: иначе waitUntil видит успех, а строки и пробуждения нет.
  await assert.rejects(
    () =>
      runScheduledJob({
        name: "memory-daily",
        argv: ["ok.ts"],
        root,
        nodeBin: process.execPath,
        statusPath,
        // Путь, по которому записи не быть: каталог данных — это файл.
        factsPath: join(root, "ok.ts", "jobs.json"),
        wakeImpl: () => {},
        log: (...args) => lines.push(args.map(String).join(" ")),
      }),
    (error: unknown) => error instanceof Error,
    "запуск без факта обязан отклоняться",
  );
  assert.ok(
    lines.some((line) => /fact not recorded/u.test(line)),
    `в журнале нет причины: ${lines.join(" | ")}`,
  );
  const status = JSON.parse(await readFile(statusPath, "utf8")) as Record<
    string,
    { lastSuccessAt?: number }
  >;
  assert.equal(
    status["memory-daily"]?.lastSuccessAt,
    undefined,
    "последний успех записан при потерянном факте",
  );
});

void test("без factsPath ни факта, ни пробуждения (доставка напоминаний)", async () => {
  const root = await scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  let woken = 0;

  await runScheduledJob({
    name: "reminder-abc",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    wakeImpl: () => {
      woken += 1;
    },
    log: () => {},
  });

  assert.equal(woken, 0);
});

void test("T30 №8: поздний stderr после exit доезжает до факта", async () => {
  const root = await scaffold();
  await mkdir(join(root, "data"), { recursive: true });
  const child = new EventEmitter() as EventEmitter & {
    readonly pid: number;
    readonly stdout: PassThrough;
    readonly stderr: PassThrough;
    readonly kill: () => boolean;
  };
  Object.assign(child, {
    pid: 424242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  const running = runScheduledJob({
    name: "late-stderr",
    argv: ["-e", ""],
    root,
    nodeBin: process.execPath,
    factsPath: join(root, "data/jobs.json"),
    wake: false,
    env: {},
    spawnImpl: (() => child) as never,
    log: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  child.stdout.write("EARLY-REASON\n");
  child.emit("exit", 0, null);
  child.stderr.write("LATE-REASON\n");
  child.emit("close", 0, null);
  const result = await running;
  assert.equal(result.ok, true);
  const rows = await readFacts(join(root, "data/jobs.json"));
  assert.match(
    rows[0].tail,
    /LATE-REASON/u,
    `поздняя причина не в факте: ${rows[0].tail}`,
  );
});
