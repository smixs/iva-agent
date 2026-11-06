import { observeModelAuth } from "#lib/model-auth-alert.ts";
import { modelAuthText } from "#lib/model-auth.ts";
/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import "../fixtures/no-host-anthropic.ts";
import "../fixtures/systemd-env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  MODEL_PROVIDER_NAMES,
  invalidModelProviderMessage,
} from "#lib/model-provider.ts";
import { jobFactsFile, recordFact } from "#lib/job-facts.ts";
import { PLUGIN_SCHEMA_URL } from "#lib/plugin-reader.ts";
import {
  pluginConfigFile,
  pluginRoot,
  writePluginsState,
} from "#lib/plugin-store.ts";
import {
  canonicalPluginScope,
  mcpProxyUnitBody,
  pluginServiceUnitBody,
} from "../lib/plugin-units.ts";
import { markPluginUnit } from "../lib/plugin-unit-scope.ts";
import { createSystemdControl } from "../lib/systemd-control.ts";
import { acquireUpdateLock, createVersionStore } from "../lib/version-store.ts";
import { authoredTreeMissing, createDoctorCommand } from "./doctor.ts";
import { createCliRuntime } from "./runtime.ts";
import { createCliSystemd } from "./systemd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SystemdLifecycle = ReturnType<typeof createCliSystemd>;

const NO_COLOR = { g: "", y: "", r: "", c: "", b: "", d: "", x: "" };

async function sandbox(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iva-cli-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".output/server"), { recursive: true });
  writeFileSync(join(root, ".output/server/index.mjs"), "export {};\n");
  return root;
}

function completeEnv(): Record<string, string> {
  return {
    OLLAMA_API_KEY: "ollama-key",
    OLLAMA_MODEL: "model",
    DEEPGRAM_API_KEY: "deepgram-key",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    TELEGRAM_ALLOWED_USER_IDS: "1",
    ASSISTANT_BEARER: "b".repeat(43),
    TAVILY_API_KEY: "tavily-key",
  };
}

function lifecycle(
  overrides: Partial<SystemdLifecycle> = {},
): SystemdLifecycle {
  return {
    ensureAssistantBearer: () => false,
    writeUnits: () => [],
    activateUnits: () => undefined,
    removeUnits: () => [],
    retireDeferredBrainUnits: () => [],
    retireLegacyMemoryUnits: () => [],
    migrateEnv: () => false,
    restartServices: () => undefined,
    ...overrides,
  };
}

function installDoctorVersion(
  store: ReturnType<typeof createVersionStore>,
  name: string,
): string {
  const dir = store.stage(name);
  mkdirSync(join(dir, ".output/server"), { recursive: true });
  writeFileSync(join(dir, ".output/server/index.mjs"), "export {};\n");
  store.linkState(dir);
  store.complete(name);
  return dir;
}

async function doctorOutput(root: string): Promise<{
  events: Array<[string, string]>;
  summaryLogs: unknown[][];
}> {
  const events: Array<[string, string]> = [];
  const summaryLogs: unknown[][] = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    hasSystemd: () => false,
  };
  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    log: (...args) => summaryLogs.push(args),
    exit: () => undefined,
  })();
  return { events, summaryLogs };
}

test("doctor explains a Google CLI GLIBC failure and prints the pinned repair command", async (t) => {
  const root = await sandbox(t);
  const warnings: string[] = [];
  const runtime = createCliRuntime(root);
  await createDoctorCommand(
    {
      ...runtime,
      readEnv: completeEnv,
      hasSystemd: () => false,
      ok: () => undefined,
      bad: () => undefined,
      warn: (message) => warnings.push(message),
      cap: (command, args, options) =>
        command.endsWith("gws")
          ? { code: 1, out: "", err: "version GLIBC_2.39 not found" }
          : runtime.cap(command, args, options),
    },
    lifecycle(),
    { nodeVersion: "24.21.0", log: () => undefined, exit: () => undefined },
  )();
  assert.ok(
    warnings.some(
      (line) =>
        line.includes("Google CLI requires a newer glibc") &&
        line.includes('bash install.sh --update-gws "$HOME/.local"'),
    ),
  );
});

/** Доктор с подменённым каталогом данных: правила владельца читаются из своего sandbox. */
async function ownerRulesEvents(
  root: string,
  data: string,
): Promise<Array<[string, string]>> {
  const events: Array<[string, string]> = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    dataDirAbs: () => data,
    hasSystemd: () => false,
  };
  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    log: () => undefined,
    exit: () => undefined,
  })();
  return events;
}

/**
 * Доктор с живым systemd (стаб) и своим каталогом данных. Возвращает события команды,
 * отобранные по примете начала строки; пустая примета — все.
 */
async function systemdDoctorEvents(
  root: string,
  {
    now,
    queue,
    queueRaw,
    statuses = [],
    envText,
    messagePrefix = "bridge backlog:",
  }: {
    now: number;
    queue?: unknown;
    queueRaw?: string;
    envText?: string;
    messagePrefix?: string;
    statuses?: Array<{
      chatKey: string;
      status: { status?: string; updatedAt?: number };
    }>;
  },
): Promise<Array<[string, string]>> {
  const data = join(root, "data");
  const units = join(root, "units");
  if (envText !== undefined) writeFileSync(join(root, ".env"), envText);
  mkdirSync(data, { recursive: true });
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "iva.service"), "[Service]\n");
  if (queueRaw !== undefined) {
    writeFileSync(join(data, "telegram-queue.json"), queueRaw);
  } else if (queue !== undefined) {
    writeFileSync(join(data, "telegram-queue.json"), JSON.stringify(queue));
  }
  const events: Array<[string, string]> = [];
  const systemd = createSystemdControl({
    run: (args) => {
      if (args[0] === "is-enabled") return { code: 0, out: "enabled" };
      if (args[0] === "is-active") return { code: 0, out: "active" };
      return { code: 1, out: "" };
    },
  });
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    UNIT_DIR: units,
    SERVICES: [],
    TIMERS: [],
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    dataDirAbs: () => data,
    hasSystemd: () => true,
    systemd,
    cap: (command) =>
      command === "ss"
        ? {
            code: 0,
            out: "LISTEN 0 511 127.0.0.1:8723 0.0.0.0:*",
            err: "",
          }
        : { code: 1, out: "", err: "" },
  };
  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    now: () => now,
    telegramInboxFile: join(data, "telegram-inbox.json"),
    telegramQueueFile: join(data, "telegram-queue.json"),
    listChatStatusesImpl: () => statuses,
    log: () => undefined,
    exit: () => undefined,
  })();
  return events.filter(([, message]) => message.startsWith(messagePrefix));
}

/** Доктор на каталоге с напоминаниями: возвращает события, начинающиеся с "reminders". */
async function remindersEvents(
  root: string,
  {
    now,
    pulseAgoMs,
    rows = [],
    brokenTable,
    logs,
  }: {
    now: number;
    pulseAgoMs: number | null;
    rows?: Array<{
      id: string;
      firedAt: number | null;
      error: string | null;
      delivered?: boolean | null;
    }>;
    brokenTable?: string;
    // Сводка и разделители идут через log, а не ok/warn/bad — их ловит эта тетрадь.
    logs?: string[];
  },
): Promise<Array<[string, string]>> {
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  // Стор и тик считают путь от cwd + ASSISTANT_DATA_DIR (agent/lib/data-dir.ts), а доктор
  // спрашивает каталог данных у runtime — в тесте их надо свести.
  const previousDataDir = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = data;
  writeFileSync(
    join(data, "reminders.json"),
    brokenTable ??
      JSON.stringify({
        schemaVersion: 2,
        rows: rows.map((row) => ({
          id: row.id,
          text: `напоминание ${row.id}`,
          schedule: { kind: "at", atMs: now - 60_000 },
          nextRunAtMs: now - 60_000,
          createdAt: now - 120_000,
          status: "fired",
          firedAt: row.firedAt,
          delivered:
            row.delivered === undefined ? row.error === null : row.delivered,
          error: row.error,
        })),
      }),
  );
  const pulseFile = join(data, "reminders.tick");
  if (pulseAgoMs === null) {
    rmSync(pulseFile, { force: true });
  } else {
    writeFileSync(pulseFile, `${now - pulseAgoMs}\n`);
    const at = new Date(now - pulseAgoMs);
    utimesSync(pulseFile, at, at);
  }
  const units = join(root, "units");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "iva.service"), "[Service]\n");
  const events: Array<[string, string]> = [];
  const systemd = createSystemdControl({
    run: (args) => {
      if (args[0] === "is-enabled") return { code: 0, out: "enabled" };
      if (args[0] === "is-active") return { code: 0, out: "active" };
      return { code: 1, out: "" };
    },
  });
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    UNIT_DIR: units,
    SERVICES: [],
    TIMERS: [],
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    dataDirAbs: () => data,
    hasSystemd: () => true,
    systemd,
    cap: (command) =>
      command === "ss"
        ? { code: 0, out: "LISTEN 0 511 127.0.0.1:8723 0.0.0.0:*", err: "" }
        : { code: 1, out: "", err: "" },
  };
  try {
    await createDoctorCommand(runtime, lifecycle(), {
      nodeVersion: "24.19.0",
      now: () => now,
      log: (...args: unknown[]) => void logs?.push(args.map(String).join(" ")),
      exit: () => undefined,
    })();
  } finally {
    if (previousDataDir === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previousDataDir;
  }
  return events.filter(([, message]) => message.startsWith("reminders"));
}

test("doctor показывает провалы напоминаний за сутки и пульс тика", async (t) => {
  const root = await sandbox(t);
  const now = Date.now();
  // id задаёт владелец, а текст ошибки несёт тело ответа Telegram: строке доктора — а она
  // же уезжает в пакет diagnose — остаются только хеш id и код ошибки.
  const slug = "напомни-про-подарок";
  const phrase = "private phrase for Anya";
  const hash8 = (value: string) =>
    createHash("sha256").update(value).digest("hex").slice(0, 8);

  // Свежий пульс и один провал за сутки.
  const fresh = await remindersEvents(root, {
    now,
    pulseAgoMs: 30_000,
    rows: [
      {
        id: slug,
        firedAt: now - 3_600_000,
        error: `sendMessage 400: ${phrase}`,
      },
      {
        id: "r2",
        firedAt: now - 30 * 3_600_000,
        error: "старое, не показываем",
      },
      { id: "r3", firedAt: now - 60_000, error: null },
      {
        id: "r4",
        firedAt: now - 120_000,
        error: "delivery fact not recorded",
        delivered: null,
      },
      {
        id: "r5",
        firedAt: now - 180_000,
        error: "agent wake failed: boom",
        delivered: true,
      },
    ],
  });
  assert.ok(
    fresh.some(
      ([kind, message]) => kind === "ok" && /dispatcher ticked/u.test(message),
    ),
    JSON.stringify(fresh),
  );
  assert.ok(
    fresh.some(
      ([kind, message]) =>
        kind === "warn" &&
        message.includes(`#${hash8(slug)}`) &&
        /sendMessage 400/u.test(message),
    ),
    JSON.stringify(fresh),
  );
  for (const leak of [slug, phrase, "напомни"])
    assert.equal(
      fresh.some(([, message]) => message.includes(leak)),
      false,
      `в строке доктора остался текст владельца: ${leak}`,
    );
  assert.equal(
    fresh.some(([, message]) => message.includes(hash8("r2"))),
    false,
    "провал старше суток не показываем",
  );
  assert.equal(
    fresh.some(([, message]) => message.includes(hash8("r3"))),
    false,
    "успешную строку не показываем",
  );
  // Незаписанный факт — не провал доставки: строка доктора называет его иначе.
  const marker = fresh.find(([, message]) => message.includes(hash8("r4")));
  assert.ok(marker, JSON.stringify(fresh));
  assert.match(marker[1], /the delivery fact was not recorded/u);
  assert.equal(
    /did not go out/u.test(marker[1]),
    false,
    "невидимый факт назван провалом доставки",
  );
  // А записанный факт с ошибкой позднего шага — не «не дошло».
  const later = fresh.find(([, message]) => message.includes(hash8("r5")));
  assert.ok(later, JSON.stringify(fresh));
  assert.match(later[1], /went out, a later step failed/u);
  assert.equal(/did not go out/u.test(later[1]), false);

  // Тик молчит десять минут.
  const stale = await remindersEvents(root, {
    now,
    pulseAgoMs: 10 * 60_000,
    rows: [],
  });
  assert.ok(
    stale.some(
      ([kind, message]) =>
        kind === "warn" && /has not ticked for 10m/u.test(message),
    ),
    JSON.stringify(stale),
  );

  // Пульса нет вовсе.
  const none = await remindersEvents(root, { now, pulseAgoMs: null, rows: [] });
  assert.ok(
    none.some(
      ([kind, message]) =>
        kind === "warn" && /has not ticked yet/u.test(message),
    ),
    JSON.stringify(none),
  );
});

// Сводка считает раздел, а не число строк: список провалов — одно предупреждение, как у
// расписаний (doctor.ts:644-647). Двойной счёт в цикле давал Summary с лишними warn.
test("список провалов напоминаний добавляет сводке одно предупреждение", async (t) => {
  const now = Date.now();
  const failures = [
    { id: "r1", firedAt: now - 60_000, error: "sendMessage 400: first" },
    { id: "r2", firedAt: now - 120_000, error: "sendMessage 400: second" },
  ];
  const summaryOf = async (rows: typeof failures) => {
    const root = await sandbox(t);
    const logs: string[] = [];
    await remindersEvents(root, { now, pulseAgoMs: 30_000, rows, logs });
    const summary = logs.find((line) => line.startsWith("Summary:"));
    assert.ok(summary, `сводка не напечатана: ${JSON.stringify(logs)}`);
    return summary;
  };
  const warns = (line: string): number => {
    const match = /· (\d+) warn ·/u.exec(line);
    assert.ok(match, `в сводке нет счётчика warn: ${line}`);
    return Number(match[1]);
  };
  const withFailures = warns(await summaryOf(failures));
  const withoutFailures = warns(await summaryOf([]));
  assert.equal(
    withFailures - withoutFailures,
    1,
    "два провала напоминаний дали сводке не одно предупреждение, как на базе",
  );
});

test("doctor читает битую таблицу, не унося файл владельца в карантин", async (t) => {
  const root = await sandbox(t);
  const now = Date.now();
  const events = await remindersEvents(root, {
    now,
    pulseAgoMs: 30_000,
    brokenTable: "{not json",
  });
  assert.ok(
    events.some(
      ([kind, message]) =>
        kind === "warn" && message.startsWith("reminders: table unreadable"),
    ),
    JSON.stringify(events),
  );
  const data = join(root, "data");
  assert.ok(
    existsSync(join(data, "reminders.json")),
    "доктор перенёс файл владельца",
  );
  assert.deepEqual(
    readdirSync(data).filter((name) => name.includes(".corrupt-")),
    [],
    "карантин создан",
  );
});

test("doctor reports a damaged reminder row and preserves data files", async (t) => {
  const root = await sandbox(t);
  const raw = JSON.stringify({ schemaVersion: 2, rows: [null] });
  const events = await remindersEvents(root, {
    now: 1000000,
    pulseAgoMs: 30000,
    brokenTable: raw,
  });
  const data = join(root, "data");
  assert.deepEqual(readdirSync(data).sort(), [
    "reminders.json",
    "reminders.tick",
  ]);
  assert.equal(readFileSync(join(data, "reminders.json"), "utf8"), raw);
  assert.ok(
    events.some(
      ([kind, message]) =>
        kind === "warn" && message.startsWith("reminders: table unreadable"),
    ),
  );
});

test("non-systemd doctor preserves exact counter and exit semantics", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const events: Array<[string, string]> = [];
  const summaryLogs: unknown[][] = [];
  const exitCodes: number[] = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    log: (...args) => summaryLogs.push(args),
    exit: (code) => exitCodes.push(code),
  })();

  assert.deepEqual(events, [
    ["ok", "Node 24.19.0"],
    ["ok", ".env filled in (provider: ollama)"],
    ["ok", "web_search: tavily"],
    ["ok", "memory_search: grep"],
    ["ok", "Build in place (.output)"],
    [
      "warn",
      "systemd unavailable (not Linux) — skipping service and timer checks",
    ],
  ]);
  assert.deepEqual(summaryLogs, [
    [],
    ["Summary: 5 ok · 0 warn · 0 fixed · 0 fail"],
  ]);
  assert.deepEqual(exitCodes, [0]);
});

test("doctor warns about an old Telegram bridge backlog item", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");

  assert.deepEqual(
    await systemdDoctorEvents(root, {
      now: 1_000_000,
      queue: {
        version: 1,
        queues: {
          "1:": [
            {
              version: 1,
              updateId: 212,
              enqueuedAt: 340_000,
              update: { update_id: 212 },
            },
          ],
        },
      },
    }),
    [
      [
        "warn",
        "bridge backlog: oldest item 11m old — check: journalctl --user -u iva-telegram-poll; use /stop or iva restart",
      ],
    ],
  );
});

// Предупреждение о строках .env, которые сервис и команда прочитают по-разному.
// Разбор идёт по СЫРОЙ строке файла: по разобранному значению `ab#cd` выглядит как
// безобидное `ab`, и главный случай был бы не виден.
test("doctor names the .env lines the service and the CLI read differently", async (t) => {
  const root = await sandbox(t);

  assert.deepEqual(
    await systemdDoctorEvents(root, {
      now: 1_000_000,
      messagePrefix: ".env lines",
      envText: [
        "CUSTOM_API_KEY=ab#cd",
        "ASSISTANT_VAULT_DIR=вольт",
        // Закавычено целиком: оба парсера отдают `tg ` — доктору сказать нечего.
        'TELEGRAM_BOT_TOKEN="tg "',
        "my.key=1",
        "IVA_PORT=8723",
        "# комментарий",
        "",
      ].join("\n"),
    }),
    [
      [
        "warn",
        ".env lines the service and the CLI may read differently: " +
          "CUSTOM_API_KEY (one of # \" ' ` \\), " +
          "ASSISTANT_VAULT_DIR (a character outside ASCII), " +
          "my.key (a name the service cannot use)" +
          " — re-enter them: iva config",
      ],
    ],
  );
});

// Контроль: на здоровом .env предупреждения нет вовсе, иначе тест выше держал бы ноль.
test("doctor stays silent when every .env line is unambiguous", async (t) => {
  const root = await sandbox(t);

  assert.deepEqual(
    await systemdDoctorEvents(root, {
      now: 1_000_000,
      messagePrefix: ".env lines",
      envText: "CUSTOM_API_KEY=sk-live_ABC-123\nIVA_PORT=8723\n",
    }),
    [],
  );
});

test("doctor reports a clear bridge backlog when queue files are missing", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");

  assert.deepEqual(await systemdDoctorEvents(root, { now: 1_000_000 }), [
    ["ok", "bridge backlog: clear"],
  ]);
});

test("doctor warns when a Telegram bridge queue file is corrupt", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const queueFile = join(root, "data", "telegram-queue.json");
  const events = await systemdDoctorEvents(root, {
    now: 1_000_000,
    queueRaw: "{not json",
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.[0], "warn");
  assert.ok(events[0]?.[1].startsWith("bridge backlog:"));
  assert.ok(events[0]?.[1].includes(`${queueFile} unreadable`));
  assert.equal(
    events.some(([, message]) => message === "bridge backlog: clear"),
    false,
  );
});

test("doctor treats a running chat without updatedAt as stuck", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");

  assert.deepEqual(
    await systemdDoctorEvents(root, {
      now: 1_000_000,
      statuses: [{ chatKey: "1:", status: { status: "running" } }],
    }),
    [
      [
        "warn",
        "bridge backlog: 1 stuck chat(s) — check: journalctl --user -u iva-telegram-poll; use /stop or iva restart",
      ],
    ],
  );
});

test("doctor keeps workflow counts when one run file is unreadable", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const store = join(root, ".eve", ".workflow-data");
  mkdirSync(join(store, "runs"), { recursive: true });
  mkdirSync(join(store, "hooks"), { recursive: true });
  writeFileSync(join(store, "runs/running.json"), '{"status":"running"}');
  writeFileSync(join(store, "runs/waiting.json"), '{"status":"waiting"}');
  writeFileSync(join(store, "runs/damaged.json"), "{not json");
  writeFileSync(join(store, "hooks/reminder.json"), "{}");
  const events: Array<[string, string]> = [];
  const systemd = createSystemdControl({
    run: () => ({ code: 1, out: "" }),
  });
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    UNIT_DIR: join(root, "units"),
    SERVICES: [],
    TIMERS: [],
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    dataDirAbs: () => join(root, "data"),
    hasSystemd: () => true,
    systemd,
    cap: () => ({ code: 1, out: "", err: "" }),
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    log: () => undefined,
    exit: () => undefined,
  })();

  assert.deepEqual(
    events.filter(([, message]) => message.startsWith("workflow store")),
    [
      [
        "ok",
        "workflow store: 2 runs (running 1, waiting 1); 1 hook files, 1 unreadable",
      ],
    ],
  );
});

test("doctor names iva reset when stale running workflows pile up", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const store = join(root, ".eve", ".workflow-data");
  mkdirSync(join(store, "runs"), { recursive: true });
  for (let index = 0; index < 7; index++)
    writeFileSync(
      join(store, `runs/run-${index}.json`),
      '{"status":"running"}',
    );
  const events: Array<[string, string]> = [];
  const systemd = createSystemdControl({
    run: () => ({ code: 1, out: "" }),
  });
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    UNIT_DIR: join(root, "units"),
    SERVICES: [],
    TIMERS: [],
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    dataDirAbs: () => join(root, "data"),
    hasSystemd: () => true,
    systemd,
    cap: () => ({ code: 1, out: "", err: "" }),
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    log: () => undefined,
    exit: () => undefined,
  })();

  const [line] = events.filter(([, message]) =>
    message.startsWith("workflow store"),
  );
  assert.equal(line?.[0], "warn");
  assert.match(line?.[1] ?? "", /running count 7 exceeds 5/u);
  assert.match(line?.[1] ?? "", /iva reset/u);
});

test("doctor accepts a custom embedding endpoint for hybrid memory search", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const events: Array<[string, string]> = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: () => ({
      ...completeEnv(),
      MEMORY_SEARCH_MODE: "hybrid",
      MEMORY_EMBED_URL: " https://embeddings.example.test/v1 ",
    }),
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.0.0",
    log: () => undefined,
    exit: () => undefined,
  })();

  assert.deepEqual(
    events.filter(([, message]) => message.startsWith("memory_search:")),
    [["ok", "memory_search: hybrid"]],
  );
});

test("doctor warns when hybrid memory search has no embedding source", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const events: Array<[string, string]> = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: () => ({
      ...completeEnv(),
      MEMORY_SEARCH_MODE: "hybrid",
    }),
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.0.0",
    log: () => undefined,
    exit: () => undefined,
  })();

  assert.deepEqual(
    events.filter(([, message]) => message.startsWith("memory_search:")),
    [
      [
        "warn",
        "memory_search: MEMORY_SEARCH_MODE=hybrid but no JINA_API_KEY/DEEPINFRA_API_KEY/MEMORY_EMBED_URL — falls back to BM25",
      ],
    ],
  );
});

test("missing env remains a failure while the systemd warning stays uncounted", async (t) => {
  const root = await sandbox(t);
  const events: Array<[string, string]> = [];
  const summaryLogs: unknown[][] = [];
  const exitCodes: number[] = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: () => ({}),
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.0.0",
    log: (...args) => summaryLogs.push(args),
    exit: (code) => exitCodes.push(code),
  })();

  assert.deepEqual(events, [
    ["ok", "Node 24.0.0"],
    ["bad", ".env missing — run: iva config"],
    ["ok", "Build in place (.output)"],
    [
      "warn",
      "systemd unavailable (not Linux) — skipping service and timer checks",
    ],
  ]);
  assert.deepEqual(summaryLogs, [
    [],
    ["Summary: 2 ok · 0 warn · 0 fixed · 1 fail"],
  ]);
  assert.deepEqual(exitCodes, [1]);
});

test("doctor keeps the initial env snapshot but reads the migrated listener port fresh", async (t) => {
  const root = await sandbox(t);
  const unitDir = join(root, "units");
  const vault = join(root, "vault-initial");
  mkdirSync(unitDir);
  mkdirSync(vault);
  writeFileSync(join(unitDir, "iva.service"), "[Service]\n");
  writeFileSync(join(root, ".env"), "present=true\n");

  const initialEnv = {
    ...completeEnv(),
    ASSISTANT_DATA_DIR: "data-initial",
    ASSISTANT_VAULT_DIR: "vault-initial",
  };
  const migratedEnv = { IVA_PORT: "9123" };
  const calls: string[] = [];
  const dataDirInputs: Array<Partial<Record<string, string>>> = [];
  const listenerArgs: Array<readonly string[]> = [];
  const exitCodes: number[] = [];
  let readCount = 0;
  const systemd = createSystemdControl({
    run: (args) => {
      if (args[0] === "is-enabled") return { code: 0, out: "enabled" };
      if (args[0] === "is-active") return { code: 0, out: "active" };
      return { code: 0, out: "" };
    },
  });
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    UNIT_DIR: unitDir,
    SERVICES: [],
    BRAIN_SERVICE: "iva-brain.service",
    BRAIN_TIMER: "iva-brain.timer",
    TIMERS: [],
    C: NO_COLOR,
    ok: () => undefined,
    warn: () => undefined,
    bad: () => undefined,
    hasSystemd: () => true,
    systemd,
    readEnv: () => {
      readCount++;
      calls.push(readCount === 1 ? "read-initial" : "read-fresh");
      return readCount === 1 ? initialEnv : migratedEnv;
    },
    dataDirAbs: (env = initialEnv) => {
      dataDirInputs.push(env);
      calls.push("data-dir");
      return join(root, "data-initial");
    },
    cap: (command, args) => {
      if (command.endsWith("gws"))
        return { code: 0, out: "gws 0.22.5", err: "" };
      if (command === "ss") {
        calls.push("inspect-listener");
        listenerArgs.push(args);
        return {
          code: 0,
          out: "LISTEN 0 511 127.0.0.1:9123 0.0.0.0:*",
          err: "",
        };
      }
      assert.equal(command, "git");
      return { code: 0, out: "git@example.test:vault.git", err: "" };
    },
  };
  const systemdLifecycle = lifecycle({
    ensureAssistantBearer: () => {
      calls.push("ensure-bearer");
      return false;
    },
    migrateEnv: () => {
      calls.push("migrate-env");
      return true;
    },
    writeUnits: () => {
      calls.push("write-units");
      return [];
    },
  });

  await createDoctorCommand(runtime, systemdLifecycle, {
    nodeVersion: "24.19.0",
    log: () => undefined,
    exit: (code) => exitCodes.push(code),
  })();

  assert.equal(readCount, 2);
  assert.ok(calls.indexOf("read-initial") < calls.indexOf("migrate-env"));
  assert.ok(calls.indexOf("migrate-env") < calls.indexOf("read-fresh"));
  assert.ok(calls.indexOf("read-fresh") < calls.indexOf("inspect-listener"));
  assert.deepEqual(listenerArgs, [["-H", "-ltn", "sport", "=", ":9123"]]);
  assert.equal(dataDirInputs.length, 1);
  assert.strictEqual(dataDirInputs[0], initialEnv);
  assert.deepEqual(exitCodes, [0]);
});

test("opencode diagnostics preserve required-key order", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "MODEL_PROVIDER=opencode\n");
  const failures: string[] = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: () => undefined,
    warn: () => undefined,
    bad: (message) => failures.push(message),
    readEnv: () => ({ MODEL_PROVIDER: "opencode" }),
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.0.0",
    log: () => undefined,
    exit: () => undefined,
  })();

  assert.equal(
    failures[0],
    ".env incomplete, missing: OPENCODE_API_KEY, OPENCODE_MODEL, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, ASSISTANT_BEARER — run: iva config",
  );
});

test("doctor reports an update that flipped but never finished", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "iva-cli-doctor-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const name = "0.3.15-abcdefabcdef";
  const dir = join(home, "versions", name);
  mkdirSync(join(dir, ".output/server"), { recursive: true });
  writeFileSync(join(dir, ".output/server/index.mjs"), "export {};\n");
  writeFileSync(join(dir, ".env"), "present=true\n");
  mkdirSync(join(home, "data"), { recursive: true });
  symlinkSync(dir, join(home, "current"));

  const events: Array<[string, string]> = [];
  const root = join(home, "current");
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    hasSystemd: () => false,
  };
  const doctor = createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    log: () => undefined,
    exit: () => undefined,
  });

  await doctor();
  const unfinished = (): boolean =>
    events.some(([, message]) => message.includes(`update to ${name} never`));
  assert.ok(unfinished(), JSON.stringify(events));

  // Once the installation records the move, there is nothing left to report.
  createVersionStore(home).settle(name);
  events.length = 0;
  await doctor();
  assert.equal(unfinished(), false, JSON.stringify(events));
});

test("doctor removes leftover, incomplete, and surplus versions", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "iva-cli-doctor-cleanup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  writeFileSync(join(home, ".env"), "present=true\n");
  const store = createVersionStore(home);
  const rollback = "0.3.14-141414141414";
  const surplus = "0.3.13-131313131313";
  const current = "0.3.15-151515151515";
  for (const name of [rollback, surplus, current])
    installDoctorVersion(store, name);
  store.activate(rollback);
  store.settle(rollback);
  store.activate(current);
  store.settle(current);
  const incomplete = "0.3.16-161616161616";
  const incompleteDir = store.stage(incomplete);
  writeFileSync(join(incompleteDir, "partial"), "partial\n");
  const leftover = ".probe-dead";
  mkdirSync(join(home, leftover));

  const { events, summaryLogs } = await doctorOutput(store.layout.current);

  const removed = events.filter(
    ([kind, message]) => kind === "ok" && message.startsWith("removed "),
  );
  assert.equal(removed.length, 1, JSON.stringify(events));
  for (const name of [incomplete, leftover, surplus])
    assert.ok(removed[0][1].includes(name), removed[0][1]);
  assert.equal(existsSync(incompleteDir), false);
  assert.equal(existsSync(join(home, leftover)), false);
  assert.equal(existsSync(join(store.layout.versions, surplus)), false);
  assert.ok(
    events.some(
      ([kind, message]) =>
        kind === "ok" &&
        /^versions on disk: 2 \(current .+, rollback .+\) — .+ free$/u.test(
          message,
        ),
    ),
    JSON.stringify(events),
  );
  assert.ok(
    summaryLogs.some(
      (entry) => typeof entry[0] === "string" && /1 fixed/u.test(entry[0]),
    ),
    JSON.stringify(summaryLogs),
  );
});

test("doctor skips version cleanup while an update holds the lock", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "iva-cli-doctor-lock-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  writeFileSync(join(home, ".env"), "present=true\n");
  const store = createVersionStore(home);
  const previous = "0.3.14-141414141414";
  const surplus = "0.3.13-131313131313";
  const current = "0.3.15-151515151515";
  for (const name of [previous, surplus, current])
    installDoctorVersion(store, name);
  store.activate(previous);
  store.settle(previous);
  store.activate(current);
  store.settle(current);
  const leftover = join(home, ".probe-held");
  mkdirSync(leftover);
  const lock = acquireUpdateLock(join(home, "data"));
  assert.ok(lock);
  t.after(() => lock.release());

  const { events } = await doctorOutput(store.layout.current);

  assert.ok(
    events.some(
      (event) =>
        event[0] === "warn" &&
        event[1] === "update in progress — version cleanup skipped",
    ),
    JSON.stringify(events),
  );
  assert.equal(existsSync(join(store.layout.versions, surplus)), true);
  assert.equal(existsSync(leftover), true);
});

test("doctor reports corrupt version state without removing anything", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "iva-cli-doctor-corrupt-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  writeFileSync(join(home, ".env"), "present=true\n");
  const store = createVersionStore(home);
  const previous = "0.3.14-141414141414";
  const surplus = "0.3.13-131313131313";
  const current = "0.3.15-151515151515";
  for (const name of [previous, surplus, current])
    installDoctorVersion(store, name);
  store.activate(previous);
  store.settle(previous);
  store.activate(current);
  store.settle(current);
  const leftover = join(home, ".probe-corrupt");
  mkdirSync(leftover);
  writeFileSync(join(store.layout.data, "active.json"), "{junk\n");
  const before = readdirSync(store.layout.versions);

  const { events } = await doctorOutput(store.layout.current);

  assert.ok(
    events.some(
      ([kind, message]) =>
        kind === "bad" && /^version cleanup failed/u.test(message),
    ),
    JSON.stringify(events),
  );
  assert.deepEqual(readdirSync(store.layout.versions), before);
  assert.equal(existsSync(leftover), true);
});

test("doctor keeps every referenced version while an update is unfinished", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "iva-cli-doctor-unsettled-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  writeFileSync(join(home, ".env"), "present=true\n");
  const store = createVersionStore(home);
  const previous = "0.3.13-131313131313";
  const recorded = "0.3.14-141414141414";
  const current = "0.3.15-151515151515";
  for (const name of [previous, recorded, current])
    installDoctorVersion(store, name);
  store.activate(previous);
  store.settle(previous);
  store.activate(recorded);
  store.settle(recorded);
  store.activate(current);

  const { events } = await doctorOutput(store.layout.current);

  assert.ok(
    events.some(
      ([kind, message]) =>
        kind === "warn" && message.includes(`update to ${current} never`),
    ),
    JSON.stringify(events),
  );
  assert.ok(
    events.some(
      ([kind, message]) =>
        kind === "ok" && message.startsWith("versions on disk: 3 "),
    ),
    JSON.stringify(events),
  );
  assert.equal(store.list().length, 3);
});

test("doctor rejects an invalid model provider instead of diagnosing Ollama", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "MODEL_PROVIDER=ollmaa\n");
  const failures: string[] = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: () => undefined,
    warn: () => undefined,
    bad: (message) => failures.push(message),
    readEnv: () => ({ MODEL_PROVIDER: "ollmaa" }),
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.0.0",
    log: () => undefined,
    exit: () => undefined,
  })();

  assert.equal(failures[0], invalidModelProviderMessage("ollmaa"));
  assert.equal(
    failures.some((message) => message.includes("OLLAMA_")),
    false,
  );
});

// Доктор и рантайм обязаны принимать один и тот же набор имён и объяснять отказ одним
// предложением: разъедься они, доктор объявил бы .env здоровым перед сервисом, который
// на этом же значении отказывается стартовать, — и починку искали бы не там.
test("doctor accepts exactly the provider names the runtime accepts", async (t) => {
  async function diagnose(provider: string): Promise<string[]> {
    const root = await sandbox(t);
    writeFileSync(join(root, ".env"), `MODEL_PROVIDER=${provider}\n`);
    const failures: string[] = [];
    const runtime: CliRuntime = {
      ...createCliRuntime(root),
      C: NO_COLOR,
      ok: () => undefined,
      warn: () => undefined,
      bad: (message) => failures.push(message),
      readEnv: () => ({ ...completeEnv(), MODEL_PROVIDER: provider }),
      hasSystemd: () => false,
    };
    await createDoctorCommand(runtime, lifecycle(), {
      nodeVersion: "24.0.0",
      log: () => undefined,
      exit: () => undefined,
    })();
    return failures;
  }

  for (const name of MODEL_PROVIDER_NAMES) {
    const failures = await diagnose(name);
    assert.deepEqual(
      failures.filter((message) =>
        message.startsWith("Invalid MODEL_PROVIDER"),
      ),
      [],
      name,
    );
  }
  for (const value of [
    "ollmaa",
    " ollama",
    "ollama ",
    "OLLAMA",
    "оllama",
    "__proto__",
  ]) {
    assert.equal(
      (await diagnose(value))[0],
      invalidModelProviderMessage(value),
      JSON.stringify(value),
    );
  }
});

// Свой эндпоинт держится на двух строках .env: адрес и модель. Ключ — нет: локальный
// сервер живёт без авторизации, и требовать его значило бы объявлять рабочую установку
// сломанной. Проверка — тем же списком, что читает мастер (providerEnvKeys).
test("doctor asks a custom provider for its endpoint and model, not for a key", async (t) => {
  async function diagnose(env: Record<string, string>): Promise<string[]> {
    const root = await sandbox(t);
    writeFileSync(join(root, ".env"), "MODEL_PROVIDER=custom\n");
    const failures: string[] = [];
    const runtime: CliRuntime = {
      ...createCliRuntime(root),
      C: NO_COLOR,
      ok: () => undefined,
      warn: () => undefined,
      bad: (message) => failures.push(message),
      readEnv: () => ({
        ...completeEnv(),
        MODEL_PROVIDER: "custom",
        ...env,
      }),
      hasSystemd: () => false,
    };
    await createDoctorCommand(runtime, lifecycle(), {
      nodeVersion: "24.0.0",
      log: () => undefined,
      exit: () => undefined,
    })();
    return failures.filter((message) => message.startsWith(".env incomplete"));
  }

  assert.deepEqual(await diagnose({ CUSTOM_MODEL: "some-model" }), [
    ".env incomplete, missing: CUSTOM_BASE_URL — run: iva config",
  ]);
  assert.deepEqual(
    await diagnose({ CUSTOM_BASE_URL: "https://api.example.com/v1" }),
    [".env incomplete, missing: CUSTOM_MODEL — run: iva config"],
  );
  // Пробельное значение — это «не задано», как и у всех остальных ключей.
  assert.deepEqual(
    await diagnose({ CUSTOM_BASE_URL: "  ", CUSTOM_MODEL: " " }),
    [
      ".env incomplete, missing: CUSTOM_BASE_URL, CUSTOM_MODEL — run: iva config",
    ],
  );
  // Адрес и модель есть, ключа нет — установка полная.
  assert.deepEqual(
    await diagnose({
      CUSTOM_BASE_URL: "https://api.example.com/v1",
      CUSTOM_MODEL: "some-model",
    }),
    [],
  );
});

// --- Раздел «Plugins» (ADR-0009) -----------------------------------------------

function plantStorePlugin(
  data: string,
  name: string,
  manifest: string = JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name }),
  /** Что ещё лежит в папке плагина: `mcp.json`, `sh.iva/...` и прочее. */
  files: Record<string, string> = {},
): void {
  const root = pluginRoot(data, name);
  mkdirSync(join(root, "skills/alpha"), { recursive: true });
  writeFileSync(join(root, "plugin.json"), manifest);
  writeFileSync(
    join(root, "skills/alpha/SKILL.md"),
    "---\nname: alpha\ndescription: Do the alpha work.\n---\n\nBody.\n",
  );
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

/** `mcp.json` плагина: сервера ровно те, что передали. */
function mcpJson(servers: Record<string, unknown>): string {
  return JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: servers,
  });
}

/** Прогоняет доктора без systemd и отдаёт только строки про плагины. */
async function pluginEvents(root: string): Promise<Array<[string, string]>> {
  const events: Array<[string, string]> = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    hasSystemd: () => false,
  };
  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    log: () => undefined,
    exit: () => undefined,
  })();
  return events.filter(([, message]) => message.startsWith("plugin"));
}

test("doctor stays silent about plugins on an installation that has none", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");

  assert.deepEqual(await pluginEvents(root), []);
});

test("doctor reports each installed plugin and what it carries", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const data = join(root, "data");
  plantStorePlugin(data, "demo");
  plantStorePlugin(data, "quiet");
  await writePluginsState(data, {
    marketplaces: [],
    plugins: [
      {
        name: "demo",
        source: "./demo",
        ref: "",
        sha: "",
        digest: "",
        enabled: true,
        trusted: false,
        installedAt: "2026-08-17T12:00:00.000Z",
      },
      {
        name: "quiet",
        source: "./quiet",
        ref: "",
        sha: "",
        digest: "",
        enabled: false,
        trusted: false,
        installedAt: "2026-08-17T12:00:00.000Z",
      },
    ],
  });

  assert.deepEqual(await pluginEvents(root), [
    ["ok", "plugin demo: 1 skills"],
    ["ok", "plugin quiet (disabled): 1 skills"],
  ]);
});

test("doctor names a plugin missing from disk and points at sync", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const data = join(root, "data");
  await writePluginsState(data, {
    marketplaces: [],
    plugins: [
      {
        name: "gone",
        source: "./gone",
        ref: "",
        sha: "",
        digest: "",
        enabled: true,
        trusted: false,
        installedAt: "2026-08-17T12:00:00.000Z",
      },
    ],
  });

  assert.deepEqual(await pluginEvents(root), [
    [
      "bad",
      "plugin gone is missing from data/custom/plugins/ — run: iva plugin sync",
    ],
  ]);
});

test("doctor reports an unreadable manifest and a folder nobody recorded", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const data = join(root, "data");
  plantStorePlugin(data, "broken", JSON.stringify({ name: "broken" }));
  plantStorePlugin(data, "stray");
  await writePluginsState(data, {
    marketplaces: [],
    plugins: [
      {
        name: "broken",
        source: "./broken",
        ref: "",
        sha: "",
        digest: "",
        enabled: true,
        trusted: false,
        installedAt: "2026-08-17T12:00:00.000Z",
      },
    ],
  });

  const events = await pluginEvents(root);
  assert.equal(events.length, 2);
  assert.equal(events[0][0], "bad");
  assert.match(
    events[0][1],
    /plugin broken is unreadable: .*\$schema must be/u,
  );
  assert.deepEqual(events[1], [
    "warn",
    "plugin folder stray is not in plugins.json — run: iva plugin sync",
  ]);
});

test("doctor reports a damaged plugins.json instead of reading past it", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const data = join(root, "data");
  plantStorePlugin(data, "demo");
  mkdirSync(join(data, "custom"), { recursive: true });
  writeFileSync(join(data, "custom", "plugins.json"), "{ broken");

  const events = await pluginEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "bad");
  assert.match(events[0][1], /plugins\.json is unusable: .*not valid JSON/u);
});

test("doctor sees the leftovers of an interrupted install that its dot filter hides", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const data = join(root, "data");
  mkdirSync(join(pluginRoot(data, ".staging-xyz")), { recursive: true });
  mkdirSync(join(pluginRoot(data, ".replaced-ab12")), { recursive: true });

  assert.deepEqual(await pluginEvents(root), [
    [
      "warn",
      "plugin folder .replaced-ab12 is a leftover of an interrupted install — run: iva plugin sync",
    ],
    [
      "warn",
      "plugin folder .staging-xyz is a leftover of an interrupted install — run: iva plugin sync",
    ],
  ]);
});

test("doctor says whether an enabled plugin's code is in the version that runs", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "iva-cli-doctor-version-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  writeFileSync(join(home, ".env"), "present=true\n");
  const store = createVersionStore(home);
  const name = "0.3.24-abcdefabcdef+11223344";
  const dir = store.stage(name);
  mkdirSync(join(dir, ".output/server"), { recursive: true });
  writeFileSync(join(dir, ".output/server/index.mjs"), "export {};\n");
  store.linkState(dir);
  store.complete(name);
  store.activate(name);
  const data = join(home, "data");
  // Заявка на namespace плюс `sh.iva/package.json` — это и есть код (ADR-0009).
  plantStorePlugin(
    data,
    "carrier",
    JSON.stringify({
      $schema: PLUGIN_SCHEMA_URL,
      name: "carrier",
      extensions: { "sh.iva": {} },
    }),
  );
  mkdirSync(join(pluginRoot(data, "carrier"), "sh.iva"), { recursive: true });
  writeFileSync(
    join(pluginRoot(data, "carrier"), "sh.iva/package.json"),
    "{}\n",
  );
  await writePluginsState(data, {
    marketplaces: [],
    plugins: [
      {
        name: "carrier",
        source: "./carrier",
        ref: "",
        sha: "",
        digest: "",
        enabled: true,
        trusted: false,
        installedAt: "2026-08-17T12:00:00.000Z",
      },
    ],
  });

  // Плагин стоит, а версия собрана без него: тулов плагина у агента нет.
  assert.deepEqual(await pluginEvents(dir), [
    ["ok", "plugin carrier: 1 skills, code"],
    [
      "warn",
      "plugin carrier: built into current version: no — run: iva update",
    ],
  ]);

  // Сборка версии оставляет копию плагина и его mount — доктор видит ровно их.
  mkdirSync(join(dir, "plugins/carrier"), { recursive: true });
  mkdirSync(join(dir, "agent/extensions"), { recursive: true });
  writeFileSync(
    join(dir, "agent/extensions/carrier.ts"),
    "export default 1;\n",
  );

  assert.deepEqual(await pluginEvents(dir), [
    ["ok", "plugin carrier: 1 skills, code"],
    ["ok", "plugin carrier: built into current version: yes"],
  ]);
});

test("an unknown plugin unit is preserved without claiming its owner", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const unitDir = join(root, "systemd");
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, "iva-mcp-gone-srv.service"), "[Service]\n");

  const events: Array<[string, string]> = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    UNIT_DIR: unitDir,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    hasSystemd: () => true,
  };
  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    log: () => undefined,
    exit: () => undefined,
  })();

  assert.deepEqual(
    events.filter(([, message]) => message.startsWith("iva-mcp-")),
    [],
  );
});

test("doctor checks the plugin units and the health of every MCP proxy", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const data = join(root, "data");
  const unitDir = join(root, "systemd");
  mkdirSync(unitDir, { recursive: true });
  // Живой прокси: настоящий сервер на loopback, отвечающий как `/health` прокси.
  const alive = createServer((request, response) => {
    response
      .writeHead(request.url === "/health" ? 200 : 404, {
        "content-type": "application/json",
      })
      .end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((settle) => alive.listen(0, "127.0.0.1", settle));
  t.after(() => new Promise<void>((settle) => alive.close(() => settle())));
  const answering = (alive.address() as { port: number }).port;
  // Порт, на котором никто не слушает: юнит active, а сервера за ним нет.
  const silent = createServer();
  await new Promise<void>((settle) => silent.listen(0, "127.0.0.1", settle));
  const dead = (silent.address() as { port: number }).port;
  await new Promise<void>((settle) => silent.close(() => settle()));

  // Плагин объявляет ровно два stdio-сервера и один сервис. `dropped` — сервер, который
  // автор убрал из `mcp.json`, а порт за ним в `plugins.json` остался: юнита ему не
  // положено, и требовать его было бы вечной строкой, которую нечем починить.
  plantStorePlugin(
    data,
    "trace",
    JSON.stringify({
      $schema: PLUGIN_SCHEMA_URL,
      name: "trace",
      extensions: { "sh.iva": {} },
    }),
    {
      "mcp.json": mcpJson({
        alive: { type: "stdio", command: "node" },
        quiet: { type: "stdio", command: "node" },
        // Удалённый сервер прокси не требует и юнита не получает.
        remote: { type: "streamable-http", url: "https://a.test/mcp" },
      }),
      "sh.iva/services/web/service.json": JSON.stringify({
        command: "node",
        port: 8726,
      }),
    },
  );
  await writePluginsState(data, {
    marketplaces: [],
    plugins: [
      {
        name: "trace",
        source: "./trace",
        ref: "",
        sha: "",
        digest: "",
        enabled: true,
        trusted: true,
        installedAt: "2026-08-17T12:00:00.000Z",
        mcp: {
          alive: { port: answering },
          quiet: { port: dead },
          dropped: { port: 8799 },
          remote: { port: 8798 },
        },
        services: { web: { port: 8726 }, gone: { port: 8727 } },
      },
    ],
  });
  const proxy = (plugin: string, server: string, port: number) =>
    mcpProxyUnitBody({
      plugin,
      server,
      port,
      tokenFile: join(data, "plugin-data", plugin, `mcp-${server}.token`),
      root,
      node: process.execPath,
      nodeBinDir: dirname(process.execPath),
      dataDirEnvironment: `"ASSISTANT_DATA_DIR=${data}"`,
    });
  writeFileSync(
    join(unitDir, "iva-mcp-trace-alive.service"),
    proxy("trace", "alive", answering),
  );
  writeFileSync(
    join(unitDir, "iva-mcp-trace-quiet.service"),
    proxy("trace", "quiet", dead),
  );
  writeFileSync(
    join(unitDir, "iva-plugin-trace-web.service"),
    pluginServiceUnitBody({
      plugin: "trace",
      service: "web",
      command: "node",
      args: [],
      port: 8726,
      pluginRoot: join(data, "custom/plugins/trace"),
      pluginData: join(data, "plugin-data/trace"),
      dataDir: data,
      nodeBinDir: dirname(process.execPath),
    }),
  );
  writeFileSync(
    join(unitDir, "iva-mcp-orphan-srv.service"),
    markPluginUnit(proxy("orphan", "srv", 8787), {
      scope: canonicalPluginScope(data),
      kind: "mcp",
      plugin: "orphan",
      part: "srv",
      layout: "legacy",
    }),
  );
  const query = (...args: string[]) => {
    const [action, unit] = args,
      file = join(unitDir, unit),
      body = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (action === "is-active")
      return {
        code: unit === "iva-plugin-trace-web.service" ? 3 : 0,
        out: unit === "iva-plugin-trace-web.service" ? "inactive" : "active",
      };
    const prop = args.find((arg) => arg.startsWith("--property="))?.slice(11);
    return {
      code: 0,
      out:
        prop === "LoadState"
          ? body
            ? "loaded"
            : "not-found"
          : (body
              .split("\n")
              .find((line) => line.startsWith(`${prop}=`))
              ?.slice(String(prop).length + 1) ?? ""),
    };
  };

  const events: Array<[string, string]> = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    UNIT_DIR: unitDir,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    hasSystemd: () => true,
    systemd: {
      ...createCliRuntime(root).systemd,
      query,
      isActive: (unit: string) => unit !== "iva-plugin-trace-web.service",
      isEnabled: () => true,
    },
  };
  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    log: () => undefined,
    exit: () => undefined,
  })();

  const said = events.filter(([, message]) =>
    /plugin|iva-mcp|iva-plugin/u.test(message),
  );
  assert.deepEqual(said, [
    ["ok", "plugin trace: 1 skills, 3 mcp"],
    [
      "ok",
      `plugin trace: iva-mcp-trace-alive.service answers on 127.0.0.1:${answering}`,
    ],
    [
      "warn",
      `plugin trace: iva-mcp-trace-quiet.service runs but does not answer on 127.0.0.1:${dead} — check: journalctl --user -u iva-mcp-trace-quiet.service -n 100 --no-pager`,
    ],
    [
      "bad",
      "plugin trace: iva-plugin-trace-web.service is not running — check: journalctl --user -u iva-plugin-trace-web.service -n 100 --no-pager",
    ],
    [
      "warn",
      "iva-mcp-orphan-srv.service belongs to no enabled and trusted plugin — run: iva plugin sync",
    ],
  ]);
  // Порт в `plugins.json` без объявления в плагине юнита не требует: ни у сервера,
  // которого автор убрал из `mcp.json` (`dropped`), ни у удалённого (`remote`, ему
  // прокси не нужен), ни у сервиса, чьей папки больше нет (`gone`).
  const everything = events.map(([, message]) => message).join("\n");
  assert.doesNotMatch(everything, /dropped/u);
  assert.doesNotMatch(everything, /iva-mcp-trace-remote/u);
  assert.doesNotMatch(everything, /iva-plugin-trace-gone/u);
});

// Конфиг плагина правит владелец руками, и до сих пор его ошибку не называла ни одна
// поверхность: рантайм молча брал пустой конфиг, сборка — тоже. Доктор существует ровно
// для таких находок.
test("doctor names a plugin config the owner cannot have meant", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const data = join(root, "data");
  plantStorePlugin(data, "trace");
  writeFileSync(pluginConfigFile(data, "trace"), '{"level": "debug",');
  await writePluginsState(data, {
    marketplaces: [],
    plugins: [
      {
        name: "trace",
        source: "./trace",
        ref: "",
        sha: "",
        digest: "",
        enabled: true,
        trusted: false,
        installedAt: "2026-08-17T12:00:00.000Z",
      },
    ],
  });

  const events = await pluginEvents(root);
  const damaged = events.filter(([, message]) =>
    message.includes("trace.config.json"),
  );
  assert.equal(damaged.length, 1, "ровно одна строка про испорченный конфиг");
  assert.equal(damaged[0][0], "bad");
  assert.match(damaged[0][1], /trace\.config\.json is unusable: .*JSON/iu);
});

test("doctor says nothing about a plugin whose config is valid or absent", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const data = join(root, "data");
  plantStorePlugin(data, "trace");
  plantStorePlugin(data, "quiet");
  writeFileSync(pluginConfigFile(data, "trace"), '{"level": "debug"}');
  await writePluginsState(data, {
    marketplaces: [],
    plugins: ["trace", "quiet"].map((name) => ({
      name,
      source: `./${name}`,
      ref: "",
      sha: "",
      digest: "",
      enabled: true,
      trusted: false,
      installedAt: "2026-08-17T12:00:00.000Z",
    })),
  });

  const events = await pluginEvents(root);
  assert.deepEqual(
    events.filter(([, message]) => message.includes("unusable")),
    [],
    "исправный и отсутствующий конфиг доктор не комментирует",
  );
});

test("doctor counts the owner rules", async (t) => {
  const root = await sandbox(t);
  const data = join(root, "data");
  const rules = "- no emoji\n- one paragraph per reply\n";
  mkdirSync(join(data, "custom/agent/instructions"), { recursive: true });
  writeFileSync(join(data, "custom/agent/instructions/rules.md"), rules);

  const events = await ownerRulesEvents(root, data);

  assert.ok(
    events.some(
      ([level, message]) =>
        level === "ok" &&
        message === `owner rules: 1 file, ${rules.length} chars`,
    ),
  );
  assert.ok(!events.some(([, message]) => message.includes("deprecated")));
});

test("doctor names the deprecated replacement and an oversized rules file", async (t) => {
  const root = await sandbox(t);
  const data = join(root, "data");
  mkdirSync(join(data, "custom/agent/instructions"), { recursive: true });
  writeFileSync(join(data, "custom/agent/instructions.md"), "replacement\n");
  writeFileSync(
    join(data, "custom/agent/instructions/rules.md"),
    "x".repeat(4100),
  );

  const events = await ownerRulesEvents(root, data);

  assert.ok(
    events.some(
      ([level, message]) => level === "warn" && /deprecated/u.test(message),
    ),
  );
  assert.ok(
    events.some(
      ([level, message]) => level === "warn" && /4000/u.test(message),
    ),
  );
});

// T20 п.5: раздел «расписания» доктора собран из таблицы фактов — проводка до вывода
// команды, а не только сам отчёт (его формат держит scripts/cli/doctor-schedule.test.ts).
test("doctor names a failed schedule run and its open failure", async (t) => {
  const root = await sandbox(t);
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const finishedAt = Date.now() - 1000;
  await recordFact(
    jobFactsFile(data),
    {
      name: "memory-night",
      startedAt: finishedAt - 1000,
      finishedAt,
      ok: false,
      error: "exited 1",
      exitCode: 1,
      tail: "rollup daily: agent returned no report",
      acked: false,
      wake: null,
    },
    finishedAt,
  );

  // Пустая примета = все события команды: раздел расписаний говорит по-русски и с двух
  // разных начал («расписание …», «незакрытый провал: …»).
  const events = await systemdDoctorEvents(root, {
    now: finishedAt + 1000,
    messagePrefix: "",
  });

  assert.ok(
    events.some(
      ([level, message]) =>
        level === "warn" &&
        /расписание memory-night: провал \(exited 1\)/u.test(message),
    ),
    "последний запуск имени виден как провал",
  );
  assert.ok(
    events.some(
      ([level, message]) =>
        level === "warn" &&
        /незакрытый провал: memory-night .*iva jobs ack memory-night/u.test(
          message,
        ),
    ),
    "незакрытый провал назван с командой закрытия",
  );
});

// T30 §2: раздел расписаний виден и без systemd (jobs.json есть на любой установке).
test("doctor без systemd печатает раздел расписаний по таблице фактов", async (t) => {
  const root = await sandbox(t);
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const { jobFactsFile, recordFact } = await import("#lib/job-facts.ts");
  const finishedAt = Date.now() - 1000;
  await recordFact(
    jobFactsFile(data),
    {
      name: "memory-night",
      startedAt: finishedAt - 1000,
      finishedAt,
      ok: false,
      error: "exited 1",
      exitCode: 1,
      tail: "rollup daily: no report",
      acked: false,
      wake: null,
    },
    finishedAt,
  );
  const { events } = await doctorOutput(root);
  assert.ok(
    events.some(
      ([level, message]) =>
        level === "warn" &&
        /расписание memory-night: провал \(exited 1\)/u.test(message),
    ),
    `раздела расписаний без systemd нет: ${JSON.stringify(events)}`,
  );
  assert.ok(
    events.some(
      ([level, message]) =>
        level === "warn" &&
        /незакрытый провал: memory-night .*iva jobs ack memory-night/u.test(
          message,
        ),
    ),
    "незакрытый провал не назван",
  );
});

// T30 №9: чужая ERR_MODULE_NOT_FOUND (пропал packages/*) — не «нет agent/».
test("T30 №9: authoredTreeMissing различает дерево и пакет", () => {
  const foreign = Object.assign(
    new Error(
      'Cannot find module "/tmp/x/packages/secret-redaction/index.ts" imported from /tmp/x/scripts/cli/doctor.ts',
    ),
    { code: "ERR_MODULE_NOT_FOUND" },
  );
  assert.equal(
    authoredTreeMissing(foreign),
    false,
    "пропажа пакета выдана за отсутствие authored tree",
  );
  const authored = Object.assign(
    new Error('Cannot find module "#lib/job-facts.ts"'),
    { code: "ERR_PACKAGE_IMPORT_NOT_DEFINED" },
  );
  assert.equal(authoredTreeMissing(authored), true);
});

async function doctorOutputPastSystemdGate(
  root: string,
): Promise<Array<[string, string]>> {
  // Секция rollup-status.json стоит ниже раннего выхода systemd, поэтому
  // штатный doctorOutput (hasSystemd: false) до неё не доходит и на Linux, и
  // на macOS. Здесь та же обвязка, но systemd есть: двойник отвечает, что всё
  // выключено/не найдено, и секции идут дальше своим ходом.
  const events: Array<[string, string]> = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    hasSystemd: () => true,
    systemd: {
      query: () => ({ code: 1, out: "", err: "" }),
      isEnabled: () => false,
      isActive: () => false,
      activate: () => undefined,
      resetFailed: () => undefined,
      restart: () => undefined,
      daemonReload: () => undefined,
    } as never,
  };
  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    log: () => {},
    exit: () => undefined,
  })();
  return events;
}

test("rollup-status свежий и здоровый — строка ok", async (t) => {
  const root = await sandbox(t);
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(
    join(root, "data/rollup-status.json"),
    JSON.stringify({
      "memory-night": { lastSuccessAt: Date.now(), lastExitCode: 0 },
    }),
  );

  const events = await doctorOutputPastSystemdGate(root);
  assert.ok(
    events.some(
      ([level, message]) =>
        level === "ok" &&
        /memory-night schedule last succeeded 0h ago/u.test(message),
    ),
    `нет ok-строки свежего расписания: ${JSON.stringify(events)}`,
  );
});

test("rollup-status старый и с провалом — строки предупреждения", async (t) => {
  const root = await sandbox(t);
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(
    join(root, "data/rollup-status.json"),
    JSON.stringify({
      "memory-night": {
        lastSuccessAt: Date.now() - 30 * 60 * 60 * 1000,
        lastExitCode: 1,
      },
    }),
  );

  const events = await doctorOutputPastSystemdGate(root);
  assert.ok(
    events.some(
      ([level, message]) =>
        level === "warn" &&
        /memory-night schedule hasn't succeeded in 30h \(> 26h\)/u.test(
          message,
        ),
    ),
    `нет warn-строки протухшего расписания: ${JSON.stringify(events)}`,
  );
  assert.ok(
    events.some(
      ([level, message]) =>
        level === "warn" &&
        /memory-night schedule's last run exited 1/u.test(message),
    ),
    `нет warn-строки кода провала: ${JSON.stringify(events)}`,
  );
});

// ─── вендор claude: ключа нет, вход живёт в чужом CLI ────────────────────────────────
// Ключа в .env у него нет вовсе, поэтому «заполнено» — ещё не «работает»: доктор обязан
// назвать команду установки, команду входа и план из `claude auth status`. Фейковый CLI
// стоит на месте настоящего: контракт у них один — `auth status` отвечает JSON.

/** Фейковый `claude`: на `auth status` печатает заданный JSON, на остальное молчит. */
function fakeClaude(t: TestContext, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-fake-claude-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "claude");
  writeFileSync(
    file,
    `#!/usr/bin/env node\nif (process.argv[2] === "auth") process.stdout.write(${JSON.stringify(body)});\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

async function diagnoseClaude(
  t: TestContext,
  env: Record<string, string>,
  prepare?: (root: string) => void,
): Promise<{ bad: string[]; ok: string[] }> {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "MODEL_PROVIDER=claude\n");
  prepare?.(root);
  const bad: string[] = [];
  const ok: string[] = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => ok.push(message),
    warn: () => undefined,
    bad: (message) => bad.push(message),
    readEnv: () => ({
      ...completeEnv(),
      MODEL_PROVIDER: "claude",
      CLAUDE_MODEL: "claude-fable-5-1",
      ...env,
    }),
    hasSystemd: () => false,
  };
  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.0.0",
    log: () => undefined,
    exit: () => undefined,
  })();
  return { bad, ok };
}

test("doctor sends a claude installation to the CLI install and to its login", async (t) => {
  // Пустой HOME: `~/.local/bin` из PATH сервиса пуст, `claude` искать негде.
  const previousHome = process.env.HOME;
  process.env.HOME = await sandbox(t);
  t.after(() => {
    process.env.HOME = previousHome;
  });
  const missing = await diagnoseClaude(t, { CLAUDE_COMMAND: "" });
  assert.equal(
    missing.bad.filter((message) => message.includes("Claude Code CLI")).length,
    1,
    JSON.stringify(missing),
  );
  assert.match(
    missing.bad.join("\n"),
    /npm install -g --prefix ~\/\.local @anthropic-ai\/claude-code/u,
  );
  // Заданный CLAUDE_COMMAND называется сам: ставить CLI заново тут не поможет.
  const broken = await diagnoseClaude(t, {
    CLAUDE_COMMAND: "/nonexistent/claude",
  });
  assert.match(
    broken.bad.join("\n"),
    /CLAUDE_COMMAND=\/nonexistent\/claude is not found or not executable \(PATH: /u,
  );
  assert.equal(
    broken.bad.some((message) => message.includes("npm install")),
    false,
  );

  const loggedOut = await diagnoseClaude(t, {
    CLAUDE_COMMAND: fakeClaude(t, '{"loggedIn":false}'),
  });
  assert.match(loggedOut.bad.join("\n"), /claude auth login/u);
  assert.equal(
    loggedOut.bad.some((message) => message.includes("npm install")),
    false,
    "установленный CLI объявлен неустановленным",
  );
});

test("doctor reports the plan of a signed-in claude CLI", async (t) => {
  const ready = await diagnoseClaude(t, {
    CLAUDE_COMMAND: fakeClaude(t, '{"loggedIn":true,"subscriptionType":"max"}'),
  });
  assert.deepEqual(
    ready.ok.filter((message) => message.includes("Claude Code CLI")),
    ["Claude Code CLI: signed in (plan: max)"],
  );
  assert.equal(
    ready.bad.some((message) => message.includes("Claude")),
    false,
  );
});

// Чужая авторизация в .env увела бы подписку на чужой счёт, поэтому доктор называет её
// так же, как рантайм: имя переменной, без значения.
test("doctor names a foreign auth variable instead of reporting claude as healthy", async (t) => {
  const poisoned = await diagnoseClaude(t, {
    ANTHROPIC_API_KEY: "sk-ant-not-printed",
    CLAUDE_COMMAND: fakeClaude(t, '{"loggedIn":true,"subscriptionType":"max"}'),
  });
  const joined = poisoned.bad.join("\n");
  assert.match(joined, /ANTHROPIC_API_KEY/u);
  assert.equal(
    joined.includes("sk-ant-not-printed"),
    false,
    "значение утекло в отчёт",
  );
});

test("repair 13/15: missing lsof is unknown and macOS doctor names Iva jobs", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "IVA_PORT=8723\n");
  const unitDir = join(root, "LaunchAgents");
  mkdirSync(unitDir);
  writeFileSync(join(unitDir, "app.iva.iva.plist"), "fixture");
  const events: string[] = [];
  const base = createCliRuntime(root);
  const runtime: CliRuntime = {
    ...base,
    UNIT_DIR: unitDir,
    SERVICES: [],
    TIMERS: [],
    C: NO_COLOR,
    hasSystemd: () => true,
    readEnv: completeEnv,
    systemd: createSystemdControl({
      manager: "launchd",
      run: () => ({ code: 0, out: "active" }),
    }),
    cap: (command) =>
      command === "lsof"
        ? base.cap("lsof", [], {
            env: { ...base.childEnv, PATH: "/iva-test-empty-path" },
          })
        : { code: 0, out: "", err: "" },
    ok: (m) => events.push(m),
    warn: (m) => events.push(m),
    bad: (m) => events.push(m),
  };
  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.21.0",
    log: () => {},
    exit: () => {},
  })();
  assert.ok(
    events.some((m) => m.includes("lsof unavailable")),
    events.join("\n"),
  );
  assert.ok(
    events.some((m) => m.includes("задания Ивы installed")),
    events.join("\n"),
  );
});

test("doctor fails on last-call authentication evidence even with a signed-in Claude CLI", async (t) => {
  const at = Date.parse("2026-10-21T01:33:00Z");
  const ready = await diagnoseClaude(
    t,
    {
      CLAUDE_COMMAND: fakeClaude(
        t,
        '{"loggedIn":true,"subscriptionType":"max"}',
      ),
    },
    (root) =>
      observeModelAuth(join(root, "data"), {
        provider: "claude",
        at,
        failed: true,
        answers: true,
      }),
  );
  assert.ok(
    ready.bad.includes(
      modelAuthText("claude", "ru", { since: at, answers: true }),
    ),
  );
  assert.equal(
    ready.ok.some((message) => message.includes("signed in")),
    false,
  );
});
