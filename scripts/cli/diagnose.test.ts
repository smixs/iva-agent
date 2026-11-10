// `iva diagnose` — один пакет улик для issue или группы поддержки. Два контракта:
//  1) `redact` — чистая функция: в результате не остаётся ни одного секрета (property),
//     плюс примеры на токен бота, chat id владельца и e-mail;
//  2) команда на фикстуре каталога данных: файл создан, все разделы на месте, а значения
//     фикстурного .env, текст напоминания, содержимое карточки и текст ошибки хода в пакет
//     не попали. Доктор внутри зовётся настоящий — он и есть половина улик.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: seed в имени теста; при провале подставь ещё и path:
// fc.assert(prop, { seed: SEED, path }).
import "../fixtures/systemd-env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import fc from "fast-check";
import {
  ISSUE_URL_BYTES,
  REDACTED,
  createDiagnoseCommand,
} from "./diagnose.ts";
import { createDoctorCommand } from "./doctor.ts";
import { createCliRuntime } from "./runtime.ts";
import { createCliSystemd } from "./systemd.ts";
import { createSystemdControl } from "../lib/systemd-control.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SystemdLifecycle = ReturnType<typeof createCliSystemd>;

const NO_COLOR = { g: "", y: "", r: "", c: "", b: "", d: "", x: "" };
const NOW = new Date("2026-09-12T15:04:07.000Z");
const TOKEN = "123456789:AAF3xK9mQ7vR2sT5uW8yZ1bC4dE6fG0hI2j";
const OWNER_ID = "987654321";
const BEARER = "Bq7".repeat(15);
const SUPPORT_URL = "https://t.me/+iva-support-chat";
// Пароль внутри ключа `.env.example`, в имени которого нет ни одного слова-приметы.
const URL_PASSWORD = "bpass1111";
const BASE_URL = `https://buser:${URL_PASSWORD}@api.example.com/v1`;
const REMINDER_TEXT = "напомни про подарок для Ани";
// Токен, которого нет в .env: его обязан поймать шаблон, а не список значений.
const FOREIGN_TOKEN = "444555666:BBForeignTokenJJJabcdefghijklmnopqrs";
const CARD_TEXT = "в карточке лежит секретное содержимое";
const FAILURE_MESSAGE = "секретное сообщение о провале хода";

function lifecycle(): SystemdLifecycle {
  return {
    ensureAssistantBearer: () => false,
    writeUnits: () => [],
    activateUnits: () => undefined,
    removeUnits: () => [],
    migrateEnv: () => false,
    restartServices: () => undefined,
  };
}

async function sandbox(t: TestContext): Promise<{
  root: string;
  data: string;
  env: Record<string, string>;
}> {
  const root = await mkdtemp(join(tmpdir(), "iva-cli-diagnose-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".output/server"), { recursive: true });
  writeFileSync(join(root, ".output/server/index.mjs"), "export {};\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "iva",
      version: "9.9.9",
      dependencies: { eve: "1.2.3" },
    }),
  );
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const env = {
    MODEL_PROVIDER: "ollama",
    ASSISTANT_DATA_DIR: "data",
    ASSISTANT_VAULT_DIR: "vault",
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_ALLOWED_USER_IDS: OWNER_ID,
    ASSISTANT_BEARER: BEARER,
    SUPPORT_CHAT_URL: SUPPORT_URL,
    CUSTOM_BASE_URL: BASE_URL,
    TINY_KEY: "xq7",
  };
  writeFileSync(
    join(root, ".env"),
    `${Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
  return { root, data, env };
}

function runtimeFor(
  root: string,
  data: string,
  env: Record<string, string>,
  printed: string[],
  journal: { code: number; out: string; err: string },
  warnings: string[] = [],
): CliRuntime {
  return {
    ...createCliRuntime(root),
    C: NO_COLOR,
    dataDirAbs: () => data,
    readEnv: () => env,
    hasSystemd: () => false,
    gitHead: () => "abc1234",
    cap: () => journal,
    ok: (message) => void printed.push(message),
    warn: (message) => void warnings.push(message),
  };
}

await test("пакет на фикстуре данных: все разделы, ни одного секрета и текста владельца", async (t) => {
  const { root, data, env } = await sandbox(t);
  const old = NOW.getTime() - 60 * 60 * 1000;
  writeFileSync(
    join(data, "reminders.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      rows: [
        {
          id: "rem-run-failed",
          text: REMINDER_TEXT,
          schedule: { kind: "at", atMs: old },
          nextRunAtMs: old + 60_000,
          createdAt: old - 60_000,
          status: "fired",
          firedAt: old,
          delivered: false,
          error: `sendMessage 400: Bad Request: ${REMINDER_TEXT}`,
        },
        {
          id: "rem-run-ok",
          text: REMINDER_TEXT,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Almaty" },
          nextRunAtMs: NOW.getTime() + 60 * 60 * 1000,
          createdAt: old - 60_000,
          status: "pending",
          firedAt: old + 60_000,
          delivered: true,
          error: null,
        },
        {
          // id задаёт владелец: текстовый слаг не имеет права уехать в issue.
          id: "напомни-про-подарок-IDMARK",
          text: REMINDER_TEXT,
          schedule: { kind: "at", atMs: old },
          nextRunAtMs: old,
          createdAt: old - 60_000,
          status: "pending",
          firedAt: null,
          delivered: null,
          error: null,
        },
        {
          id: "rem-future-only",
          text: REMINDER_TEXT,
          schedule: { kind: "at", atMs: old },
          nextRunAtMs: NOW.getTime() + 2 * 60 * 60 * 1000,
          createdAt: old - 60_000,
          status: "pending",
          firedAt: null,
          delivered: null,
          error: null,
        },
      ],
    })}\n`,
  );
  mkdirSync(join(data, "trace"), { recursive: true });
  writeFileSync(
    join(data, "trace/2026-09-12.jsonl"),
    [
      JSON.stringify({
        ts: "2026-09-12T14:00:00.000Z",
        turn: "turn_0",
        session: "s1",
        source: "telegram",
        kind: "eve",
        name: "turn.failed",
        data: { code: "rate_limit", message: FAILURE_MESSAGE },
      }),
      JSON.stringify({
        ts: "2026-09-12T14:30:00.000Z",
        turn: "turn_1",
        session: "s1",
        source: "telegram",
        kind: "outbox",
        name: "failed",
        data: {
          ok: false,
          delivered: 0,
          error: FAILURE_MESSAGE,
          errorCode: `LONG_CODE_${"z".repeat(120)}`,
        },
      }),
      JSON.stringify({
        ts: "2026-09-10T10:00:00.000Z",
        turn: "tg:1:1",
        session: "s2",
        source: "telegram",
        kind: "eve",
        name: "turn.failed",
        data: { code: "stale_failure" },
      }),
      "",
    ].join("\n"),
  );
  const logDir = join(data, "logs");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(logDir, "update-2026-09-12T10-00-00-000Z.log"),
    `ASSISTANT_BEARER=${BEARER}\n` +
      `GET https://api.telegram.org/bot${FOREIGN_TOKEN}/sendMessage failed\n` +
      // Ключи без слова-приметы в имени: инвайт-ссылка целой строкой и пароль из
      // CUSTOM_BASE_URL отдельным словом — так их и пишет апстрим в журнал.
      `support chat ${SUPPORT_URL} unreachable\n` +
      `custom provider rejected password ${URL_PASSWORD} end\n` +
      // Настройки внутри путей: вырезание не имеет права съесть data и vault.
      "read vault/MEMORY.md and data/trace/2026-09-12.jsonl\n",
  );
  mkdirSync(join(data, "custom/agent/instructions"), { recursive: true });
  mkdirSync(join(data, "custom/agent/skills/my-skill"), { recursive: true });
  writeFileSync(join(data, "custom/agent/instructions/rules.md"), CARD_TEXT);
  writeFileSync(join(data, "custom/agent/skills/my-skill/SKILL.md"), CARD_TEXT);
  const printed: string[] = [];
  const journal = { code: 1, out: "", err: "journalctl not found" };

  await createDiagnoseCommand(
    runtimeFor(root, data, env, printed, journal),
    lifecycle(),
    { now: () => NOW },
  )();

  const path = join(data, "diagnose", "2026-09-12T15-04-07-000Z.md");
  assert.deepEqual(printed, [`Diagnose package: ${path}`]);
  assert.ok(existsSync(path), "пакет создан по напечатанному пути");
  const text = readFileSync(path, "utf8");
  for (const leak of [
    TOKEN,
    FOREIGN_TOKEN,
    "xq7",
    OWNER_ID,
    BEARER,
    SUPPORT_URL,
    BASE_URL,
    URL_PASSWORD,
    REMINDER_TEXT,
    CARD_TEXT,
    FAILURE_MESSAGE,
  ])
    assert.ok(!text.includes(leak), `утечка в пакете: ${leak}`);
  for (const section of [
    "# Iva diagnose package",
    "## Versions",
    "## Host",
    "## iva doctor",
    "## Service journal (last 200 lines)",
    "## Reminders (last 24h and overdue; id = sha256/8)",
    "## Failures (last 24h)",
    "## Custom layer (file names only)",
  ])
    assert.ok(text.includes(section), `нет раздела ${section}`);
  assert.match(
    text,
    /- redaction: 7 values from \.env, pattern rules always on/u,
    "пакет обязан сказать, чем и по какому списку он вырезал",
  );
  assert.match(text, /- iva: 9\.9\.9 \(git abc1234\)/);
  assert.match(text, /- eve: 1\.2\.3/);
  assert.match(text, /- node: v\d+/);
  assert.match(text, /Node \d+\.\d+\.\d+/, "в пакете вывод настоящего доктора");
  assert.match(text, /Summary: \d+ ok/);
  assert.match(
    text,
    /^- data dir: .*\/data$/mu,
    "слово data в пути каталога обязано остаться: это конфиг, а не секрет",
  );
  assert.match(
    text,
    /newest log file data\/logs\/update-2026-09-12T10-00-00-000Z\.log/u,
    "нет journalctl — взят новейший файл журнала, и путь к нему не разъеден",
  );
  assert.match(
    text,
    /read vault\/MEMORY\.md and data\/trace\/2026-09-12\.jsonl/u,
    "настройки-каталоги остаются словами в путях журнала, а не пометками",
  );
  assert.match(
    text,
    /40e768f6 · due .* · last .* · delivered no · error sendMessage 400/,
  );
  assert.match(text, /e26d255a · due .* · delivered yes/);
  assert.match(text, /fe3584b2 · due .* · delivered never/);
  for (const rawId of [
    "rem-run-failed",
    "rem-run-ok",
    "rem-overdue",
    "напомни-про-подарок-IDMARK",
    "IDMARK",
  ])
    assert.ok(
      !text.includes(rawId),
      `id строки напоминания уехал в пакет: ${rawId}`,
    );
  assert.match(
    text,
    /^- [0-9a-f]{8} · due .* · delivered never · error /mu,
    "id в пакете — короткий хеш",
  );
  assert.ok(
    !text.includes("rem-future-only"),
    "нет фактов и не просрочено — не в пакете",
  );
  // Сбои суток — классом и ходом, без текста причины (FAILURE_MESSAGE выше не в пакете).
  assert.match(
    text,
    /^- 1× turn · rate_limit · last 2026-09-12T14:00:00\.000Z · s1\/turn_0$/mu,
  );
  assert.match(
    text,
    /^- 1× outbox · failed · last 2026-09-12T14:30:00\.000Z · s1\/turn_1$/mu,
  );
  assert.ok(!text.includes("LONG_CODE"), "код доставки — не класс сбоя");
  assert.ok(!text.includes("stale_failure"), "провал старше суток не в пакете");
  assert.ok(!text.includes("## Turn"), "без --turn раздела хода нет");
  assert.ok(text.includes("instructions/rules.md"));
  assert.ok(text.includes("skills/my-skill/SKILL.md"));
  assert.ok(
    text.includes(REDACTED),
    "вырезание оставило пометку, а не пустоту",
  );
});

await test("пакет не несёт id и текст провала напоминания, когда доктор их видит", async (t) => {
  const { root, data, env } = await sandbox(t);
  const slug = "напомни-про-подарок-IDMARK";
  const phrase = "секретная фраза для Ани";
  const hash8 = (value: string) =>
    createHash("sha256").update(value).digest("hex").slice(0, 8);
  // Живая ветка доктора (она есть только с systemd): строка провала уезжает в раздел
  // «## iva doctor» пакета как есть, поэтому её текст — половина контракта утечки.
  const now = Date.now();
  writeFileSync(
    join(data, "reminders.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      rows: [
        {
          id: slug,
          text: REMINDER_TEXT,
          schedule: { kind: "at", atMs: now - 120_000 },
          nextRunAtMs: now - 120_000,
          createdAt: now - 180_000,
          status: "fired",
          firedAt: now - 60_000,
          delivered: false,
          error: `sendMessage 400: Bad Request: ${phrase}`,
        },
      ],
    })}\n`,
  );
  writeFileSync(join(data, "reminders.tick"), `${now}\n`);
  const units = join(root, "units");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "iva.service"), "[Service]\n");
  const printed: string[] = [];
  const doctorRuntime = {
    ...runtimeFor(root, data, env, printed, { code: 1, out: "", err: "" }),
    SERVICES: [],
    TIMERS: [],
    UNIT_DIR: units,
    hasSystemd: () => true,
    systemd: createSystemdControl({
      run: (args) => {
        if (args[0] === "is-enabled") return { code: 0, out: "enabled" };
        if (args[0] === "is-active") return { code: 0, out: "active" };
        return { code: 1, out: "" };
      },
    }),
  };
  // Доктор читает стор от cwd + ASSISTANT_DATA_DIR; каталог данных теста надо свести с runtime.
  const previousDataDir = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = data;
  try {
    await createDiagnoseCommand(doctorRuntime, lifecycle(), {
      now: () => NOW,
    })();
    // Битый стор: причина отказа несёт JSON строки (у него в id и text — слова владельца),
    // поэтому в пакет идёт только класс ошибки, а не `error.message`.
    writeFileSync(
      join(data, "reminders.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        rows: [
          {
            id: slug,
            text: phrase,
            schedule: { kind: "at", atMs: now },
            nextRunAtMs: now,
            createdAt: now,
            status: "fired",
            firedAt: now,
            delivered: "yes",
            error: null,
          },
        ],
      })}\n`,
    );
    const before = readFileSync(join(data, "reminders.json"), "utf8");
    await createDiagnoseCommand(doctorRuntime, lifecycle(), {
      now: () => new Date(NOW.getTime() + 1_000),
    })();
    assert.equal(readFileSync(join(data, "reminders.json"), "utf8"), before);
  } finally {
    if (previousDataDir === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previousDataDir;
  }
  const text = readFileSync(
    join(data, "diagnose", "2026-09-12T15-04-07-000Z.md"),
    "utf8",
  );
  assert.match(text, /## iva doctor/u);
  assert.match(
    text,
    new RegExp(`reminders: #${hash8(slug)} .*sendMessage 400`, "u"),
    "строка доктора в пакете — хеш id и код ошибки",
  );
  for (const leak of [slug, "IDMARK", phrase])
    assert.ok(
      !text.includes(leak),
      `в пакете остался текст владельца: ${leak}`,
    );

  assert.deepEqual(
    readdirSync(data).filter((name) => name.includes(".damaged-")),
    [],
  );
  const brokenTable = readFileSync(
    join(data, "diagnose", "2026-09-12T15-04-08-000Z.md"),
    "utf8",
  );
  assert.match(
    brokenTable,
    /reminders: table unreadable \(ReminderStoreError\)/u,
  );
  assert.ok(
    !brokenTable.includes("IDMARK") && !brokenTable.includes(phrase),
    "причина отказа стора унесла слова владельца в пакет",
  );
});

await test("секрет, записанный .env доктором во время прогона, тоже вырезается", async (t) => {
  const { root, data, env } = await sandbox(t);
  const printed: string[] = [];
  // Доктор правит .env на ходу (в живом прогоне он заводит ASSISTANT_BEARER): список
  // секретов, прочитанный только ДО прогона, выпустил бы свежий ключ в пакет.
  const freshBearer = "FreshBearerFromDoctorAAA999";
  const beforeDoctor = { ...env };
  delete beforeDoctor.ASSISTANT_BEARER;
  const readEnv = (() => {
    let calls = 0;
    return () => {
      calls += 1;
      return calls === 1
        ? beforeDoctor
        : { ...env, ASSISTANT_BEARER: freshBearer };
    };
  })();
  const runtime: CliRuntime = {
    ...runtimeFor(root, data, env, printed, { code: 1, out: "", err: "" }),
    readEnv,
  };

  await createDiagnoseCommand(runtime, lifecycle(), { now: () => NOW })();

  const text = readFileSync(
    join(data, "diagnose", "2026-09-12T15-04-07-000Z.md"),
    "utf8",
  );
  assert.ok(
    !text.includes(freshBearer),
    "секрет, записанный доктором во время прогона, уехал в пакет",
  );
  assert.match(text, /- redaction: 7 values from \.env/u);
});

await test("без .env пакет говорит об этом, а шаблонные правила всё равно работают", async (t) => {
  const { root, data, env } = await sandbox(t);
  rmSync(join(root, ".env"), { force: true });
  const logDir = join(data, "logs");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(logDir, "update-2026-09-12T10-00-00-000Z.log"),
    `GET https://api.telegram.org/bot${FOREIGN_TOKEN}/sendMessage 401\n`,
  );
  const printed: string[] = [];
  const warnings: string[] = [];
  const noEnv = { ...env, TINY_KEY: "" };

  await createDiagnoseCommand(
    runtimeFor(
      root,
      data,
      noEnv,
      printed,
      { code: 1, out: "", err: "" },
      warnings,
    ),
    lifecycle(),
    { now: () => NOW },
  )();

  const text = readFileSync(
    join(data, "diagnose", "2026-09-12T15-04-07-000Z.md"),
    "utf8",
  );
  assert.match(
    text,
    /- redaction: \.env not found — only the pattern rules were applied \(bot token, keys of known formats, telegram ids, e-mail\); values of keys are NOT in the cut list/u,
    "отсутствие .env обязано быть сказано в пакете, а не молчать",
  );
  assert.ok(
    warnings.some((line) => line.includes("No .env")),
    "команда обязана сказать об этом и в выводе",
  );
  assert.ok(!text.includes(FOREIGN_TOKEN), "шаблон режет токен и без .env");
  assert.ok(text.includes("bot<redacted>/sendMessage"));
});

await test("битые данные не мешают пакету: разделы честно говорят, чего нет", async (t) => {
  const { root, data, env } = await sandbox(t);
  writeFileSync(join(data, "reminders.json"), "{not json");
  const printed: string[] = [];

  await createDiagnoseCommand(
    runtimeFor(root, data, env, printed, {
      code: 1,
      out: "",
      err: "",
    }),
    lifecycle(),
    { now: () => NOW },
  )();

  const path = join(data, "diagnose", "2026-09-12T15-04-07-000Z.md");
  assert.deepEqual(printed, [`Diagnose package: ${path}`]);
  const text = readFileSync(path, "utf8");
  assert.match(text, /- reminders\.json is not valid JSON/);
  assert.ok(
    existsSync(join(data, "reminders.json")),
    "диагностика читает битый reminders.json, а не переносит его",
  );
  assert.match(
    text,
    /## Failures \(last 24h\)\n- no failures in the last day/u,
  );
  assert.match(text, /journalctl unavailable \(no journalctl on this host\)/);
  assert.match(text, /## Custom layer \(file names only\)\n- \(none\)/);
});

await test("таблица фактов расписаний видна в пакете, секрет из хвоста — нет", async (t) => {
  const { root, data, env } = await sandbox(t);
  const { jobFactsFile, recordFact } = await import("#lib/job-facts.ts");
  const finishedAt = NOW.getTime() - 60 * 60 * 1000;
  await recordFact(
    jobFactsFile(data),
    {
      name: "memory-night",
      startedAt: finishedAt - 1000,
      finishedAt,
      ok: false,
      error: "exited 1",
      exitCode: 1,
      tail: `provider ${URL_PASSWORD} rejected`,
      acked: false,
      wake: null,
    },
    finishedAt,
  );
  const printed: string[] = [];
  await createDiagnoseCommand(
    runtimeFor(root, data, env, printed, {
      code: 1,
      out: "",
      err: "journalctl not found",
    }),
    lifecycle(),
    { now: () => NOW },
  )();
  const text = readFileSync(
    join(data, "diagnose", "2026-09-12T15-04-07-000Z.md"),
    "utf8",
  );
  assert.match(text, /## Schedules \(facts table/u);
  assert.match(text, /memory-night: провал \(exited 1\)/u);
  assert.match(text, /незакрытый провал: memory-night/u);
  // Первые три якоря печатает и доктор; хвост запуска с отступом — только секция расписаний.
  // Без этого якоря мутация `schedules: ""` оставляла тест зелёным (T30 v2, §2).
  assert.match(
    text,
    new RegExp(`^  provider ${REDACTED} rejected$`, "mu"),
    "секция расписаний обязана печатать хвост незакрытого провала",
  );
  assert.ok(!text.includes(URL_PASSWORD), "секрет из хвоста уехал в пакет");
});

/**
 * Установка, которой нужен каждый ремонт доктора: нет `.output`, нет юнитов, сервис и
 * таймер выключены, слушатель открыт наружу, bearer «заведён заново». `calls` пишет
 * каждое действие, которое что-то меняет.
 */
async function brokenInstall(t: TestContext) {
  const { root, data, env } = await sandbox(t);
  rmSync(join(root, ".output"), { recursive: true, force: true });
  const units = join(root, "units");
  mkdirSync(units, { recursive: true });
  const calls: string[] = [];
  const base = runtimeFor(root, data, env, [], { code: 1, out: "", err: "" });
  const runtime: CliRuntime = {
    ...base,
    SERVICES: ["iva.service"],
    TIMERS: ["iva-update-check.timer"],
    UNIT_DIR: units,
    hasSystemd: () => true,
    run: ((_command: string, args: readonly string[]) => {
      calls.push(`run ${args.join(" ")}`);
      return { status: 1 };
    }) as unknown as CliRuntime["run"],
    cap: (command, args) =>
      command === "ss"
        ? {
            code: 0,
            out: `LISTEN 0 511 0.0.0.0:${base.DEFAULT_PORT} 0.0.0.0:*`,
            err: "",
          }
        : base.cap(command, args),
    systemd: createSystemdControl({
      run: (args) => {
        if (args[0] === "is-enabled" || args[0] === "is-active")
          return { code: 3, out: "inactive" };
        calls.push(args.join(" "));
        return { code: 0, out: "" };
      },
    }),
  };
  const spy: SystemdLifecycle = {
    ...lifecycle(),
    ensureAssistantBearer: () => (calls.push("ensureAssistantBearer"), true),
    writeUnits: () => (calls.push("writeUnits"), []),
    activateUnits: () => void calls.push("activateUnits"),
    migrateEnv: () => (calls.push("migrateEnv"), false),
  };
  return { data, runtime, spy, calls };
}

await test("iva diagnose ничего не чинит, а iva doctor из терминала чинит как раньше", async (t) => {
  const { data, runtime, spy, calls } = await brokenInstall(t);
  const previousDataDir = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = data;
  try {
    await createDiagnoseCommand(runtime, spy, { now: () => NOW })();
    assert.deepEqual([...calls], [], "diagnose что-то изменил");
    const text = readFileSync(
      join(data, "diagnose", "2026-09-12T15-04-07-000Z.md"),
      "utf8",
    );
    assert.match(
      text,
      /## iva doctor\n+(?:```\n)?read-only: nothing was repaired/u,
    );
    for (const what of [
      "check the internal bearer and .env permissions",
      "add IVA_PORT to .env if missing",
      "run npm run build",
      "install and start the systemd units",
      "activate iva.service",
      "restart iva.service on loopback",
      "enable iva-update-check.timer",
    ])
      assert.ok(
        text.includes(`! would ${what} — run iva doctor in a terminal`),
        `нет строки would ${what}`,
      );

    await createDoctorCommand({ ...runtime, bad: () => undefined }, spy, {
      exit: () => undefined,
      log: () => undefined,
      sleep: () => Promise.resolve(),
    })();
  } finally {
    if (previousDataDir === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previousDataDir;
  }
  for (const call of [
    "ensureAssistantBearer",
    "migrateEnv",
    "run run build",
    "writeUnits",
    "activateUnits",
    "enable --now iva.service",
    "restart iva.service",
    "enable --now iva-update-check.timer",
  ])
    assert.ok(calls.includes(call), `doctor не сделал: ${call}`);
  assert.equal(
    calls.filter((call) => call === "restart iva.service").length,
    2,
    "bearer и открытый слушатель — два перезапуска",
  );
});

// --- `iva diagnose --turn <session>/<turn>` ---------------------------------------------------

const OWNER_TEXT = "напомни маме про OWNERMARK";
type TraceEvent = {
  readonly ts: string;
  readonly session?: string;
  readonly turn?: string;
  readonly kind?: string;
  readonly name: string;
  readonly data?: Record<string, unknown>;
};

function writeTurn(data: string, events: readonly TraceEvent[]): void {
  mkdirSync(join(data, "trace"), { recursive: true });
  writeFileSync(
    join(data, "trace/2026-09-12.jsonl"),
    `${events
      .map(({ session = "A", turn = "turn_0", kind = "eve", ...rest }) =>
        JSON.stringify({
          session,
          turn,
          kind,
          source: "telegram",
          data: {},
          ...rest,
        }),
      )
      .join("\n")}\n`,
  );
}

/** Раздел `## Turn` пакета и раскодированные части адреса issue. */
function turnOf(text: string) {
  const from = text.indexOf("\n## Turn ");
  return text.slice(from + 1, text.indexOf("\n## Host\n"));
}
function decoded(url: string) {
  const parsed = new URL(url);
  return {
    origin: `${parsed.origin}${parsed.pathname}`,
    title: parsed.searchParams.get("title") ?? "",
    body: parsed.searchParams.get("body") ?? "",
  };
}

async function diagnoseTurn(
  t: TestContext,
  events: readonly TraceEvent[],
  argv: readonly string[] = ["--turn", "A/turn_0"],
  setup: (sandboxed: { root: string; data: string }) => void = () => {},
) {
  const { root, data, env } = await sandbox(t);
  setup({ root, data });
  writeTurn(data, events);
  const printed: string[] = [];
  await createDiagnoseCommand(
    runtimeFor(root, data, env, printed, { code: 1, out: "", err: "" }),
    lifecycle(),
    { now: () => NOW },
  )(argv);
  const path = join(data, "diagnose", "2026-09-12T15-04-07-000Z.md");
  const text = readFileSync(path, "utf8");
  const url = readFileSync(path.replace(/\.md$/u, ".issue-url"), "utf8");
  return { root, data, path, text, url, printed };
}

const SKELETON: readonly TraceEvent[] = [
  { ts: "2026-09-12T14:00:00.000Z", name: "turn.started" },
  {
    ts: "2026-09-12T14:00:00.100Z",
    name: "message.received",
    data: { message: OWNER_TEXT, parts: 1 },
  },
  {
    ts: "2026-09-12T14:00:01.000Z",
    name: "actions.requested",
    data: {
      stepIndex: 0,
      actions: [{ kind: "tool-call", callId: "c1", toolName: "bash" }],
      args: [{ command: `echo ${OWNER_TEXT}` }],
    },
  },
  {
    ts: "2026-09-12T14:00:02.000Z",
    name: "action.result",
    data: {
      stepIndex: 0,
      status: "completed",
      callId: "c1",
      toolName: "bash",
      exitCode: 2,
      failure: "exit 2",
      outChars: 90,
      result: JSON.stringify({
        exitCode: 2,
        stderr: `${OWNER_TEXT}\nls: /nonexistent-iva-check: No such file or directory\n`,
        stdout: OWNER_TEXT,
      }),
    },
  },
  {
    ts: "2026-09-12T14:00:03.000Z",
    name: "message.completed",
    data: { finishReason: "stop", message: OWNER_TEXT },
  },
  {
    ts: "2026-09-12T14:00:03.500Z",
    session: "",
    turn: `tg:${OWNER_ID}:42`,
    kind: "inbound",
    name: "received",
    data: { chatId: OWNER_ID, text: OWNER_TEXT },
  },
  {
    ts: "2026-09-12T14:00:04.000Z",
    name: "step.failed",
    data: {
      code: "MODEL_CALL_FAILED",
      message: "429 провайдер занят",
      details: { body: OWNER_TEXT },
    },
  },
  {
    ts: "2026-09-12T14:00:05.000Z",
    name: "turn.failed",
    data: {
      code: "MODEL_CALL_FAILED",
      message: "429 провайдер занят",
      details: {
        stack: `Error: ${OWNER_TEXT}\n    at call (/x/index.mjs:1:2)\n    at run (/x/index.mjs:3:4)`,
      },
    },
  },
  {
    ts: "2026-09-12T14:00:00.500Z",
    session: "B",
    name: "action.result",
    data: { toolName: "b_only_tool", failure: "error" },
  },
];

await test("--turn A/turn_0: the skeleton of that turn right after the versions, no text of the owner, and an issue url built from the package", async (t) => {
  const { path, text, url, printed } = await diagnoseTurn(t, SKELETON);
  assert.ok(
    text.indexOf("## Versions") < text.indexOf("## Turn A/turn_0") &&
      text.indexOf("## Turn A/turn_0") < text.indexOf("## Host"),
    "раздел хода — сразу после версий",
  );
  const turn = turnOf(text);
  assert.ok(turn.length <= 3000 + "## Turn A/turn_0\n".length);
  assert.ok(!turn.includes("b_only_tool"), "ход другой сессии с тем же turn_0");
  assert.ok(
    !turn.includes("OWNERMARK"),
    `текст владельца в разделе хода:\n${turn}`,
  );
  assert.ok(!turn.includes(OWNER_ID), "chatId в разделе хода");
  assert.ok(!turn.includes("inbound.received"), "швы чата без хода не идут");
  assert.match(
    turn,
    /^14:00:02\.000 eve\.action\.result toolName=bash status=completed failure=exit 2 exitCode=2 stepIndex=0 outChars=90\n {2}error: ls: \/nonexistent-iva-check: No such file or directory$/mu,
  );
  assert.match(
    turn,
    /^14:00:01\.000 eve\.actions\.requested stepIndex=0 tool=bash$/mu,
  );
  assert.match(
    turn,
    /^14:00:04\.000 eve\.step\.failed code=MODEL_CALL_FAILED\n {2}error: 429 провайдер занят\n14:00:05/mu,
    "details объектом без stack — ни строки",
  );
  assert.match(
    turn,
    /^ {2}error: 429 провайдер занят\n {2}at call \(\/x\/index\.mjs:1:2\)\n {2}at run \(\/x\/index\.mjs:3:4\)$/mu,
  );
  assert.deepEqual(printed, [`Diagnose package: ${path}`, `issue-url: ${url}`]);
  const issue = decoded(url);
  assert.equal(issue.origin, "https://github.com/smixs/iva-agent/issues/new");
  assert.equal(issue.title, "[iva] bash: exit 2 (9.9.9)");
  const full =
    "\n\nFull package: data/diagnose/2026-09-12T15-04-07-000Z.md on the owner's machine";
  assert.ok(issue.body.endsWith(full));
  const head = issue.body.slice(0, -full.length);
  assert.ok(text.startsWith(head), "тело issue — префикс записанного пакета");
  assert.ok(head.endsWith(turn.trimEnd()), "в теле — весь раздел хода");
  assert.ok(url.length <= ISSUE_URL_BYTES);
});

await test("--turn: the home folder is ~ in the whole package and in the issue url", async (t) => {
  const previous = process.env.HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  });
  const { root, text, url } = await diagnoseTurn(
    t,
    [
      {
        ts: "2026-09-12T14:00:02.000Z",
        name: "action.result",
        data: { toolName: "read_file", failure: "error", error: "" },
      },
    ],
    ["--turn", "A/turn_0"],
    ({ root }) => {
      process.env.HOME = root;
    },
  );
  assert.match(text, /^- data dir: ~\/data$/mu);
  assert.ok(!text.includes(root), "домашний каталог в пакете");
  assert.ok(!decoded(url).body.includes(root), "домашний каталог в issue");
  assert.match(decoded(url).body, /^- data dir: ~\/data$/mu);
});

await test("--turn: a turn of 300 events with Cyrillic errors keeps the section within 3000 and the url within ISSUE_URL_BYTES, the failure line stays", async (t) => {
  const events: TraceEvent[] = Array.from({ length: 300 }, (_, i) =>
    i === 150
      ? {
          ts: `2026-09-12T14:00:00.${String(i).padStart(3, "0")}Z`,
          name: "turn.failed",
          data: { code: "IVA_MIDDLE", message: "середина хода упала" },
        }
      : {
          ts: `2026-09-12T14:00:00.${String(i).padStart(3, "0")}Z`,
          name: "action.result",
          data: {
            toolName: "web_fetch",
            failure: i % 3 === 0 ? "error" : undefined,
            error: `страница не открылась номер ${i} ${"ж".repeat(40)}`,
          },
        },
  );
  const { text, url } = await diagnoseTurn(t, events);
  const turn = turnOf(text);
  assert.ok(
    turn.length <= 3000 + "## Turn A/turn_0\n".length,
    `${turn.length}`,
  );
  assert.ok(url.length <= ISSUE_URL_BYTES, `${url.length}`);
  const body = decoded(url).body;
  assert.ok(text.startsWith(body.slice(0, body.indexOf("\n\nFull package"))));
  assert.match(body, /## Turn A\/turn_0/u);
  const roomy = await diagnoseTurn(t, events.slice(140, 160));
  assert.match(turnOf(roomy.text), /error: середина хода упала/u);
  const middle = await diagnoseTurn(
    t,
    events.map((event, i) => (i === 150 ? event : { ...event, data: {} })),
  );
  assert.match(
    turnOf(middle.text),
    /turn\.failed code=IVA_MIDDLE\n {2}error: середина хода упала/u,
  );
  assert.match(turnOf(middle.text), /… \d+ events/u);
  assert.ok(turnOf(middle.text).length <= 3000 + "## Turn A/turn_0\n".length);
});

await test("--turn without a value or not a pair: usage error before the package; an unknown turn — «no turn», the package is written", async (t) => {
  for (const argv of [["--turn"], ["--turn", "x"], ["--turn", "/b"]]) {
    const { root, data, env } = await sandbox(t);
    await assert.rejects(
      createDiagnoseCommand(
        runtimeFor(root, data, env, [], { code: 1, out: "", err: "" }),
        lifecycle(),
        { now: () => NOW },
      )(argv),
      /^Error: usage: iva diagnose \[--turn <session>\/<turn>\]$/u,
    );
    assert.ok(!existsSync(join(data, "diagnose")), "пакет не собирался");
  }
  const { text, url } = await diagnoseTurn(t, SKELETON, ["--turn", "A/turn_9"]);
  assert.match(
    text,
    /## Turn A\/turn_9\n- no turn A\/turn_9 in the journal\n/u,
  );
  assert.equal(decoded(url).title, "[iva] turn A/turn_9 (9.9.9)");
});

await test("--turn: a selector of 6000 characters still gives a url within ISSUE_URL_BYTES", async (t) => {
  const session = "s".repeat(6000);
  const { url } = await diagnoseTurn(t, SKELETON, [
    "--turn",
    `${session}/turn_0`,
  ]);
  assert.ok(url.length <= ISSUE_URL_BYTES, `${url.length}`);
  assert.ok(decoded(url).title.startsWith("[iva] turn sss"));
});

await test("--turn: a key from a plugin's .env is cut from the package and the issue url", async (t) => {
  const PLUGIN_KEY = "plg-7f3a9c2e5b1d4f6a8c0e";
  const events = SKELETON.map((event) =>
    event.name === "action.result" && event.session === undefined
      ? {
          ...event,
          data: {
            ...event.data,
            result: JSON.stringify({
              exitCode: 22,
              stderr: `curl: (22) 401 https://api.x.com/v1?token=${PLUGIN_KEY}\n`,
              stdout: "",
            }),
          },
        }
      : event,
  );
  const { text, url, printed } = await diagnoseTurn(
    t,
    events,
    undefined,
    ({ data }) => {
      mkdirSync(join(data, "custom/plugins"), { recursive: true });
      writeFileSync(
        join(data, "custom/plugins/weather.env"),
        `WEATHER_TOKEN=${PLUGIN_KEY}\nMODE=fast\n`,
      );
    },
  );
  assert.ok(turnOf(text).includes("curl: (22) 401"), turnOf(text));
  assert.ok(!text.includes(PLUGIN_KEY), "ключ плагина в пакете");
  assert.ok(!decoded(url).body.includes(PLUGIN_KEY), "ключ плагина в issue");
  assert.ok(!printed.join("\n").includes(PLUGIN_KEY));
  assert.match(
    text,
    /- redaction: \d+ values from \.env and 1 from plugin \.env files, pattern rules always on/u,
  );
});

await test("--turn: a key of a known format that is in no .env is cut from the package and the issue url", async (t) => {
  // Находка Q4 волны Trace: ключ `sk-…` напечатал инструмент, в `.env` его нет — список
  // секретов о нём не знает, режет только таблица форматов пакета secret-redaction.
  // Задом наперёд: защита GitHub от утечек не пропускает ключ в тексте теста.
  const FOREIGN_KEY = [..."d4b2e0c8a6f4d1b5-e2c9a3f7_nGiErOf4Q-jorp-ks"]
    .reverse()
    .join("");
  const events = SKELETON.map((event) =>
    event.name === "action.result" && event.session === undefined
      ? {
          ...event,
          data: {
            ...event.data,
            result: JSON.stringify({
              exitCode: 22,
              stderr: `curl: (22) 401 -H "Authorization: Bearer ${FOREIGN_KEY}" key=${FOREIGN_KEY}\n`,
              stdout: "",
            }),
          },
        }
      : event,
  );
  const { text, url, printed } = await diagnoseTurn(t, events);
  assert.ok(turnOf(text).includes("curl: (22) 401"), turnOf(text));
  assert.ok(!text.includes(FOREIGN_KEY), "ключ в пакете");
  assert.ok(!url.includes(FOREIGN_KEY), "ключ в адресе issue");
  assert.ok(!decoded(url).body.includes(FOREIGN_KEY), "ключ в теле issue");
  assert.ok(
    !decoded(url).title.includes(FOREIGN_KEY),
    "ключ в заголовке issue",
  );
  assert.ok(!printed.join("\n").includes(FOREIGN_KEY));
  assert.ok(decoded(url).body.includes("curl: (22) 401"), decoded(url).body);
});

const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);

await test(`PBT: secrets of .env and text of the owner in every content field of the turn — none of .env in the section or the url, the owner's text only on error lines (seed ${SEED})`, async (t) => {
  const previous = process.env.HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  });
  const secret = fc.stringMatching(/^[A-Za-z0-9]{12,24}$/u);
  const words = fc.string({ unit: "grapheme", maxLength: 40 });
  await fc.assert(
    fc.asyncProperty(
      fc.array(secret, { minLength: 1, maxLength: 3 }),
      fc.array(fc.tuple(fc.integer({ min: 0, max: 5 }), words), {
        minLength: 1,
        maxLength: 12,
      }),
      async (secrets, shapes) => {
        const env = Object.fromEntries(
          secrets.map((value, i) => [`PBT_${i}_API_KEY`, value]),
        );
        const leak = (i: number, extra: string) =>
          `${extra} OWNERMARK${i} ${secrets[i % secrets.length]} ${extra}`;
        const events: TraceEvent[] = shapes.map(([shape, extra], i) => {
          const ts = `2026-09-12T14:00:${String(i).padStart(2, "0")}.000Z`;
          const text = leak(i, extra);
          const content = {
            message: text,
            text,
            args: [{ command: text }],
            input: text,
            output: text,
            reasoning: text,
            details: { stack: `${text}\n    at f (/x.js:1:1)`, body: text },
          };
          const data = [
            {
              toolName: "bash",
              failure: "exit 1",
              result: JSON.stringify({
                exitCode: 1,
                stderr: text,
                stdout: text,
              }),
            },
            { toolName: "bash", failure: "error", error: text, result: text },
            { code: "X", ...content },
            { finishReason: "stop", ...content },
            { toolName: "grep", result: text, error: text },
            {
              stepIndex: i,
              actions: [{ toolName: "bash", input: text }],
              ...content,
            },
          ][shape];
          const name =
            [
              "action.result",
              "action.result",
              "turn.failed",
              "message.completed",
              "action.result",
              "actions.requested",
            ][shape] ?? "x";
          return { ts, name, data: { ...data } };
        });
        const { root, data } = await sandbox(t);
        process.env.HOME = root;
        writeTurn(data, events);
        const printed: string[] = [];
        await createDiagnoseCommand(
          {
            ...runtimeFor(
              root,
              data,
              { ...env, ASSISTANT_DATA_DIR: "data" },
              printed,
              { code: 1, out: "", err: "" },
            ),
          },
          lifecycle(),
          { now: () => NOW },
        )(["--turn", "A/turn_0"]);
        const text = readFileSync(
          join(data, "diagnose", "2026-09-12T15-04-07-000Z.md"),
          "utf8",
        );
        const url = readFileSync(
          join(data, "diagnose", "2026-09-12T15-04-07-000Z.issue-url"),
          "utf8",
        );
        const issue = decoded(url);
        for (const where of [turnOf(text), issue.body, issue.title]) {
          for (const value of secrets)
            assert.ok(!where.includes(value), `секрет .env: ${value}`);
          assert.ok(!where.includes(root), "домашний каталог");
          for (const line of where.split("\n"))
            if (!line.startsWith("  error: "))
              assert.ok(
                !line.includes("OWNERMARK"),
                `текст владельца вне error: ${line}`,
              );
        }
        assert.ok(url.length <= ISSUE_URL_BYTES);
        rmSync(root, { recursive: true, force: true });
      },
    ),
    { seed: SEED, numRuns: 25 },
  );
});
