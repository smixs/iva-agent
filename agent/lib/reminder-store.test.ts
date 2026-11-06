/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Якоря контракта таблицы напоминаний: один переход pending → fired, факт в той же строке,
// версия схемы, границы сроков и права файла. Путь к файлу считается на каждом вызове,
// поэтому ASSISTANT_DATA_DIR меняется до импорта модуля и ещё раз перед каждым тестом
// (образец trace.property.test.ts:23-26).
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { quarantineDamagedRecord } from "./damaged-record.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { beforeEach } from "node:test";
import type { Reminder, ReminderInput } from "./reminder-store.ts";

const root = mkdtempSync(join(tmpdir(), "iva-reminders-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });

const {
  REMINDER_FIRED_KEEP_MS,
  REMINDER_SCHEMA_VERSION,
  ReminderStoreError,
  add,
  fireDue,
  list,
  recordDelivery,
  reminderFile,
  remove,
  recordTurnSession,
  sweepFired,
} = await import("./reminder-store.ts");
const { saveJsonAtomic } = await import("./json-store.ts");
const { zonedParts } = await import("./zoned-time.ts");

let caseDir = "";
beforeEach(() => {
  caseDir = mkdtempSync(join(root, "case-"));
  process.env.ASSISTANT_DATA_DIR = caseDir;
});
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

/** Валидная строка таблицы; поля перекрываются точечно. */
function row(over: Partial<Reminder> & { id: string }): Reminder {
  return {
    id: over.id,
    text: over.text ?? `напоминание ${over.id}`,
    chat: over.chat ?? null,
    schedule: over.schedule ?? { kind: "at", atMs: over.nextRunAtMs ?? 1 },
    nextRunAtMs: over.nextRunAtMs ?? 1,
    createdAt: over.createdAt ?? 1,
    status: over.status ?? "pending",
    firedAt: over.firedAt ?? null,
    delivered: over.delivered ?? null,
    error: over.error ?? null,
  };
}

/** Кладёт таблицу в файл напрямую: тесту нужны состояния, недостижимые через add. */
function seed(
  rows: unknown[],
  version = REMINDER_SCHEMA_VERSION,
): Promise<void> {
  return saveJsonAtomic(
    reminderFile(),
    { schemaVersion: version, rows },
    { mode: 0o600 },
  );
}

function table(): { schemaVersion: number; rows: Reminder[] } {
  return JSON.parse(readFileSync(reminderFile(), "utf8")) as {
    schemaVersion: number;
    rows: Reminder[];
  };
}

function files(): string[] {
  return readdirSync(dirname(reminderFile())).sort();
}

test("две параллельные ставки не срабатывают дважды", async () => {
  const now = 1_000_000;
  await seed([
    row({ id: "a", nextRunAtMs: now - 3 }),
    row({ id: "b", nextRunAtMs: now - 2 }),
    row({ id: "c", nextRunAtMs: now - 1 }),
  ]);

  const [first, second] = await Promise.all([
    fireDue(now, 10),
    fireDue(now, 10),
  ]);

  assert.equal(first.length + second.length, 3);
  assert.equal(new Set([...first, ...second].map((r) => r.id)).size, 3);
  const rows = table().rows;
  for (const fired of rows) {
    assert.equal(fired.status, "fired");
    assert.equal(fired.firedAt, now);
    assert.equal(fired.delivered, null);
  }
});

test("битый JSON: бэкап и ошибка, не пустой список", async () => {
  writeFileSync(reminderFile(), "{broken");

  await assert.rejects(list(), /damaged/);
  assert.equal(existsSync(reminderFile()), false);

  const backups = files().filter((n) =>
    n.startsWith("reminders.json.corrupt-"),
  );
  assert.equal(backups.length, 1);
  assert.equal(
    readFileSync(join(dirname(reminderFile()), backups[0]), "utf8"),
    "{broken",
  );
});

test("срок берётся по границе включительно, разовая строка срабатывает ровно раз", async () => {
  const now = 5_000_000;
  await seed([
    row({ id: "A", nextRunAtMs: now - 1 }),
    row({ id: "B", nextRunAtMs: now }),
    row({ id: "C", nextRunAtMs: now + 1 }),
  ]);

  const first = await fireDue(now, 10);
  assert.deepEqual(
    first.map((r) => r.id),
    ["A", "B"],
  );
  assert.equal(first[0].firedAt, now);

  // Повторный тик в ту же минуту и через час не берёт разовые снова.
  assert.deepEqual(await fireDue(now, 10), []);
  const later = await fireDue(now + 3_600_000, 10);
  assert.deepEqual(
    later.map((r) => r.id),
    ["C"],
  );
});

test("повторяющаяся строка сама уезжает на следующий срок и остаётся pending", async () => {
  const now = 7_000_000;
  await add({
    id: "cron",
    text: "по утрам",
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    nextRunAtMs: now,
  });

  const fired = await fireDue(now, 10);
  assert.deepEqual(
    fired.map((r) => r.id),
    ["cron"],
  );
  const [stored] = await list();
  assert.equal(stored.status, "pending", "повторяющаяся ждёт следующий срок");
  assert.equal(stored.firedAt, now, "факт срабатывания при строке");
  assert.ok(stored.nextRunAtMs > now, "срок уехал в будущее");
  const next = zonedParts(stored.nextRunAtMs, "UTC");
  assert.equal(next.hh, 8, "расписание 0 8 * * * даёт 08:00 UTC");
  assert.equal(next.mm, 0);

  // Тот же срок второй раз не берётся: следующий тик пуст.
  assert.deepEqual(await fireDue(stored.nextRunAtMs - 1, 10), []);
  const nextFire = await fireDue(stored.nextRunAtMs, 10);
  assert.deepEqual(
    nextFire.map((r) => r.id),
    ["cron"],
  );
});

test("строка помнит чат и тему, а строка без поля чата читается с chat = null", async () => {
  await add({
    id: "topic",
    text: "в теме",
    chat: { id: "-100123", threadId: "835397" },
    schedule: { kind: "at", atMs: 5 },
  });
  const [stored] = await list();
  assert.deepEqual(stored?.chat, { id: "-100123", threadId: "835397" });

  // Таблица, записанная до появления поля: ключа chat в строке нет вовсе.
  const legacy = row({ id: "old", nextRunAtMs: 6 }) as unknown as Record<
    string,
    unknown
  >;
  delete legacy.chat;
  await saveJsonAtomic(reminderFile(), {
    schemaVersion: REMINDER_SCHEMA_VERSION,
    rows: [legacy],
  });
  const [read] = await list();
  assert.equal(read?.id, "old");
  assert.equal(read?.chat, null);

  // Кривой чат - ошибка строки, не тихий null.
  await assert.rejects(
    add({
      id: "bad",
      text: "x",
      chat: { id: "", threadId: null },
      schedule: { kind: "at", atMs: 7 },
    }),
    ReminderStoreError,
  );
});

test("факт доставки живёт в строке своего срабатывания", async () => {
  const now = 9_000_000;
  await add({
    id: "one",
    text: "разовое",
    schedule: { kind: "at", atMs: now },
  });
  await fireDue(now, 10);

  const [fired] = await list();
  assert.ok(fired);
  await recordDelivery("one", {
    firedAt: fired.firedAt,
    delivered: true,
    error: null,
  });
  let [stored] = await list();
  assert.equal(stored.delivered, true);
  assert.equal(stored.error, null);

  await recordDelivery("one", {
    firedAt: fired.firedAt,
    delivered: false,
    error: "400 chat not found",
  });
  [stored] = await list();
  assert.equal(stored.delivered, false);
  assert.equal(stored.error, "400 chat not found");
  assert.equal(stored.status, "fired");
  assert.equal(stored.firedAt, now);

  await assert.rejects(
    recordDelivery("nope", { firedAt: null, delivered: true, error: null }),
    /nope/,
  );
});

test("строка помнит сессию хода, а запоздалый ход старого срока её не переписывает", async () => {
  const now = 11_000_000;
  await add({
    id: "one",
    text: "долгая работа",
    schedule: { kind: "at", atMs: now },
  });
  const [fired] = await fireDue(now, 10);
  assert.ok(fired);
  assert.equal(fired.sessionId, null, "до хода сессии нет");

  const stamped = await recordTurnSession("one", {
    firedAt: fired.firedAt,
    sessionId: "sess-1",
  });
  assert.equal(stamped.sessionId, "sess-1");
  assert.equal(
    (await list())[0]?.sessionId,
    "sess-1",
    "сессию хода видит тик: по ней снимается запись чата",
  );

  // Ход прошлого срока опоздал: его сессия — не сессия текущего срока.
  const lines: string[] = [];
  const ignored = await recordTurnSession(
    "one",
    { firedAt: fired.firedAt! - 1, sessionId: "sess-old" },
    { log: (...args: unknown[]) => lines.push(args.map(String).join(" ")) },
  );
  assert.equal(ignored.sessionId, "sess-1");
  assert.equal((await list())[0]?.sessionId, "sess-1");
  assert.ok(
    lines.some((line) => line.includes("turn session for firedAt")),
    lines.join("\n"),
  );

  await assert.rejects(
    recordTurnSession("nope", { firedAt: fired.firedAt, sessionId: "sess-1" }),
    /nope/,
  );
});

test("строка без поля sessionId (таблица старой версии) читается как «хода не было»", async () => {
  const legacy = row({ id: "old", nextRunAtMs: 8 }) as unknown as Record<
    string,
    unknown
  >;
  delete legacy.sessionId;
  await saveJsonAtomic(reminderFile(), {
    schemaVersion: REMINDER_SCHEMA_VERSION,
    rows: [legacy],
  });
  const [read] = await list();
  assert.equal(read?.sessionId, null);

  // Кривая сессия сохраняется в карантине вместе со строкой.
  await saveJsonAtomic(reminderFile(), {
    schemaVersion: REMINDER_SCHEMA_VERSION,
    rows: [{ ...row({ id: "old", nextRunAtMs: 8 }), sessionId: "" }],
  });
  assert.deepEqual(await list(), []);
  const [copy] = files().filter((name) => name.includes(".damaged-"));
  assert.equal(
    (
      JSON.parse(readFileSync(join(caseDir, copy), "utf8")) as {
        record: { sessionId: unknown };
      }
    ).record.sessionId,
    "",
  );
});

test("результат старого срока не переписывает факт нового и уходит в журнал", async () => {
  const now = 10_000_000;
  await add({
    id: "cron",
    text: "отчёт",
    schedule: { kind: "cron", expr: "*/10 * * * *", tz: "UTC" },
    nextRunAtMs: now,
  });
  const [first] = await fireDue(now, 10);
  await recordDelivery(first.id, {
    firedAt: first.firedAt,
    delivered: true,
    error: null,
  });
  const [second] = await fireDue(first.nextRunAtMs, 10);
  assert.ok(first && second);

  const lines: string[] = [];
  const log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  await recordDelivery(
    "cron",
    { firedAt: first.firedAt, delivered: false, error: "late failure" },
    { log },
  );
  const [row] = await list();
  assert.equal(row?.firedAt, second.firedAt);
  assert.equal(
    row?.delivered,
    null,
    "старый провал не тронул факт нового срока",
  );
  assert.equal(row?.error, null, "старая причина не тронула факт нового срока");
  assert.equal(lines.length, 1, "отброшенный результат объяснён в журнале");
  assert.match(lines[0], /ignored/u);
});

test("сработавшая разовая строка живёт сутки и убирается тиком", async () => {
  const now = Date.now();
  await seed([
    row({ id: "old", status: "fired", firedAt: now - REMINDER_FIRED_KEEP_MS }),
    row({
      id: "fresh",
      status: "fired",
      firedAt: now - REMINDER_FIRED_KEEP_MS + 1,
    }),
    row({ id: "cron", nextRunAtMs: now + 1000 }),
  ]);

  assert.equal(await sweepFired(now), 1);
  assert.deepEqual(
    (await list()).map((r) => r.id),
    ["fresh", "cron"],
  );
  assert.equal(await sweepFired(now), 0, "второй проход пуст");
});

test("schemaVersion новее кода — явная ошибка", async () => {
  const before = `{\n  "schemaVersion": ${REMINDER_SCHEMA_VERSION + 1},\n  "rows": []\n}`;
  writeFileSync(reminderFile(), before);

  await assert.rejects(list(), /schemaVersion 3.*newer/);
  assert.equal(readFileSync(reminderFile(), "utf8"), before);

  await assert.rejects(
    add({ id: "n1", text: "текст", schedule: { kind: "at", atMs: 1 } }),
    ReminderStoreError,
  );
  assert.equal(readFileSync(reminderFile(), "utf8"), before);
  assert.deepEqual(files(), ["reminders.json"]);
});

test("файл версии 1 переводится: срок и текст живут, режимы и аренда отброшены", async () => {
  const now = Date.now();
  await seed(
    [
      {
        id: "old-one-shot",
        text: "старое разовое",
        mode: "agent",
        schedule: { kind: "at", atMs: now + 60_000 },
        nextRunAtMs: now + 60_000,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        deliver: { chatId: "42" },
        leaseUntilMs: null,
        deliveredKey: null,
      },
      {
        id: "old-cron",
        text: "старое повторяющееся",
        mode: "verbatim",
        schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
        nextRunAtMs: now + 120_000,
        lastRunAtMs: now - 60_000,
        lastStatus: "failed",
        lastError: "400 chat not found",
        deliver: { chatId: "42" },
        leaseUntilMs: null,
        deliveredKey: "k",
      },
      {
        id: "old-fired",
        text: "уже пыталось сработать",
        mode: "verbatim",
        schedule: { kind: "at", atMs: now - 60_000 },
        nextRunAtMs: now - 60_000,
        lastRunAtMs: now - 60_000,
        lastStatus: "failed",
        lastError: "boom",
        deliver: { chatId: "42" },
        leaseUntilMs: null,
        deliveredKey: null,
      },
    ],
    1,
  );

  const rows = await list();
  assert.deepEqual(
    rows.map((r) => r.id),
    ["old-fired", "old-one-shot", "old-cron"],
  );
  const fired = rows.find((r) => r.id === "old-fired");
  assert.ok(fired);
  assert.equal(
    fired.status,
    "fired",
    "разовое уже сработало — второй раз нельзя",
  );
  assert.equal(fired.delivered, false);
  assert.equal(fired.error, "boom");
  const cron = rows.find((r) => r.id === "old-cron");
  assert.ok(cron);
  assert.equal(cron.status, "pending", "повторяющееся ждёт свой срок");
  assert.equal(cron.delivered, false);
  assert.equal(cron.error, "400 chat not found");
  assert.equal(cron.createdAt > 0, true);
  // После первой мутации файл уже версии 2.
  await recordDelivery("old-cron", {
    firedAt: cron.firedAt,
    delivered: false,
    error: "wake",
  });
  assert.equal(table().schemaVersion, REMINDER_SCHEMA_VERSION);
});

test("add отвергает мусор и не трогает файл", async () => {
  const now = 13_000_000;
  await seed([row({ id: "base", nextRunAtMs: now })]);
  const before = readFileSync(reminderFile(), "utf8");

  const ok: ReminderInput = {
    id: "n1",
    text: "текст",
    schedule: { kind: "at", atMs: now },
  };
  const cases: Array<[string, unknown, RegExp]> = [
    ["дубликат id", { ...ok, id: "base" }, /id/],
    ["пустой text", { ...ok, text: "" }, /text/],
    ["пустой text из пробелов", { ...ok, text: "   " }, /text/],
    ["чужой mode из старой схемы", { ...ok, mode: "loud" }, /mode/],
    [
      "чужое поле deliver из старой схемы",
      { ...ok, deliver: { chatId: "42" } },
      /deliver/,
    ],
    [
      "cron без nextRunAtMs",
      { ...ok, schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" } },
      /nextRunAtMs/,
    ],
    ["at с nextRunAtMs", { ...ok, nextRunAtMs: now + 1 }, /nextRunAtMs/],
    [
      "expr из четырёх полей",
      {
        ...ok,
        schedule: { kind: "cron", expr: "0 8 * *", tz: "UTC" },
        nextRunAtMs: now,
      },
      /expr/,
    ],
    [
      "неизвестная таймзона",
      {
        ...ok,
        schedule: { kind: "cron", expr: "0 8 * * *", tz: "Mars/Olympus" },
        nextRunAtMs: now,
      },
      /tz/,
    ],
  ];

  for (const [name, input, message] of cases) {
    await assert.rejects(
      add(input as ReminderInput),
      (error: Error) =>
        error instanceof ReminderStoreError && message.test(error.message),
      name,
    );
    assert.equal(readFileSync(reminderFile(), "utf8"), before, name);
  }
});

test("расписание, которое croner не берёт, не крутит строку: fired с причиной", async () => {
  const now = 15_000_000;
  await add({
    id: "bad",
    text: "сломанное расписание",
    schedule: { kind: "cron", expr: "99 * * * *", tz: "UTC" },
    nextRunAtMs: now,
  });

  const fired = await fireDue(now, 10);
  assert.deepEqual(
    fired.map((r) => r.id),
    ["bad"],
  );
  const [stored] = await list();
  assert.equal(stored.status, "fired", "второй раз не сработает");
  assert.equal(stored.delivered, false);
  assert.match(String(stored.error), /^cron: /u);
  assert.deepEqual(await fireDue(now + 3_600_000, 10), []);
});

test("жизненный цикл, права файла и remove", async () => {
  const now = 17_000_000;
  const once = await add({
    id: "one-shot",
    text: "разовое",
    schedule: { kind: "at", atMs: now },
  });
  assert.equal(once.nextRunAtMs, now);
  assert.equal(once.status, "pending");
  assert.equal(once.createdAt > 0, true);
  assert.equal(statSync(reminderFile()).mode & 0o777, 0o600);

  await fireDue(now, 10);
  const [stored] = await list();
  assert.equal(stored.status, "fired");
  await recordDelivery("one-shot", {
    firedAt: stored.firedAt,
    delivered: true,
    error: null,
  });
  assert.equal((await list())[0].delivered, true);

  const removed = await remove("one-shot");
  assert.equal(removed.id, "one-shot");
  assert.deepEqual(await list(), []);

  await assert.rejects(remove("nope"), /nope/);
  await assert.rejects(fireDue(-1, 10), /nowMs/);
  await assert.rejects(fireDue(now, 0), /limit/);
  assert.equal(statSync(reminderFile()).mode & 0o777, 0o600);
});

test("миграция v1: не срабатывавшее мигрирует без факта, не провалом", async () => {
  const now = Date.now();
  await seed(
    [
      {
        id: "never-ran",
        text: "не срабатывало",
        mode: "verbatim",
        schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
        nextRunAtMs: now + 120_000,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
      },
    ],
    1,
  );

  const rows = await list();
  const found = rows.find((r) => r.id === "never-ran");
  assert.ok(found);
  assert.equal(found.status, "pending");
  assert.equal(found.firedAt, null);
  assert.equal(
    found.delivered,
    null,
    "несрабатывавшее — нет факта доставки, а не провал",
  );
  assert.equal(found.error, null);
});

test("POISON reminders quarantine invalid and duplicate rows once before the next write", async (t) => {
  const good = row({ id: "keep" });
  const bad = [
    null,
    { ...good, id: "bad", text: "private reminder", foreign: true },
    { ...good, text: "duplicate secret" },
  ];
  await seed([good, ...bad, row({ id: "next" })]);
  const logs: string[] = [];
  t.mock.method(console, "error", (...parts: unknown[]) =>
    logs.push(parts.map(String).join(" ")),
  );
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      (await list()).map((r) => r.id),
      ["keep", "next"],
    );
  const copies = files().filter((name) =>
    /\.damaged-[a-f0-9]{16}\.json$/.test(name),
  );
  assert.equal(copies.length, 3);
  assert.equal(logs.length, 3);
  assert.ok(
    logs.every(
      (line) =>
        !line.includes("private reminder") &&
        !line.includes("duplicate secret"),
    ),
  );
  assert.deepEqual(
    copies
      .map(
        (name) =>
          (
            JSON.parse(readFileSync(join(caseDir, name), "utf8")) as {
              record: unknown;
            }
          ).record,
      )
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [...bad].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
  await remove("next");
  assert.deepEqual(table().rows, [{ ...good, sessionId: null }]);
});

test("damaged record copies are private, exclusive and omit values from logs", () => {
  const file = join(caseDir, "state.json");
  const entry = {
    reason: "bad row",
    label: "fixture",
    record: { text: "private text", n: 1, missing: null, rows: [] },
  };
  const logs: string[] = [];
  const log = (...parts: unknown[]) => logs.push(parts.map(String).join(" "));
  const path = quarantineDamagedRecord(file, entry, log);
  assert.ok(path);
  assert.match(path, /\.damaged-[a-f0-9]{16}\.json$/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), entry);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(quarantineDamagedRecord(file, entry, log), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /copied to/);
  assert.ok(logs[0].includes("text") && logs[0].includes("string"));
  assert.equal(logs[0].includes("private text"), false);
  assert.deepEqual(files(), [path.split("/").at(-1)]);
});

test("failed damaged-record publication preserves source and blocks reminder mutation", async (t) => {
  const original = fs.linkSync;
  t.mock.method(fs, "linkSync", (...args: Parameters<typeof fs.linkSync>) => {
    if (String(args[1]).includes(".damaged-")) throw new Error("copy failed");
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await seed([row({ id: "keep" }), null]);
  const before = readFileSync(reminderFile(), "utf8");
  await assert.rejects(remove("keep"), /copy failed/);
  assert.equal(readFileSync(reminderFile(), "utf8"), before);
  assert.deepEqual(files(), ["reminders.json"]);
});
