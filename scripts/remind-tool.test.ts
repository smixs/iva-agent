import assert from "node:assert/strict";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { ToolContext } from "eve/tools";
import fc from "fast-check";

import type {
  RemindAdded,
  RemindFailure,
  RemindListed,
  RemindRemoved,
} from "../agent/tools/remind.ts";

// Тесты тулов живут в scripts/: файл рядом с тулами eve счёл бы ещё одним тулом и сборка
// упала бы. Хук резолвинга идёт первым — тулы тянут соседей NodeNext-спецификаторами.
import "./lib/ts-esm-hooks.ts";
import { tempDir } from "./fixtures/temp-dir.ts";

const NOW = Date.UTC(2026, 8, 12, 5, 0, 0); // 10:00 в Asia/Tashkent

const dataDir = tempDir("iva-remind-tool-");
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.ASSISTANT_TIMEZONE = "Asia/Tashkent";
process.env.TELEGRAM_DIGEST_CHAT_ID = "555";
process.env.TELEGRAM_ALLOWED_USER_IDS = "";

const { default: remind } = await import("../agent/tools/remind.ts");
const { list, reminderFile } = await import("../agent/lib/reminder-store.ts");

// Второй аргумент execute — контекст хода; тестам тулов он не нужен, а eve типизирует
// ответ тула как «значение или поток». Тул напоминаний отвечает значением, и обёртки
// возвращают вызывающему именно его.
const ctx = {} as unknown as ToolContext;

type Input = Parameters<typeof remind.execute>[0];

const addReminder = (input: Omit<Input, "action">) =>
  remind.execute({ ...input, action: "add" }, ctx) as Promise<
    RemindAdded | RemindFailure
  >;
const listReminders = () =>
  remind.execute({ action: "list" }, ctx) as Promise<
    RemindListed | RemindFailure
  >;
const removeReminder = (input: Omit<Input, "action">) =>
  remind.execute({ ...input, action: "remove" }, ctx) as Promise<
    RemindRemoved | RemindFailure
  >;

function resetState(): void {
  process.env.ASSISTANT_TIMEZONE = "Asia/Tashkent";
  process.env.TELEGRAM_DIGEST_CHAT_ID = "555";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "";
  rmSync(reminderFile(), { force: true });
  rmSync(join(dataDir, "reminders.tick"), { force: true });
  for (const name of readdirSync(dataDir)) {
    if (name.includes(".corrupt-"))
      rmSync(join(dataDir, name), { force: true });
  }
}

/** Пульс тика — mtime файла data/reminders.tick. */
function writePulse(atMs: number): void {
  const file = join(dataDir, "reminders.tick");
  writeFileSync(file, `${atMs}\n`);
  const at = new Date(atMs);
  utimesSync(file, at, at);
}

/** Отметка замороженного времени: тул считает срок от Date.now(). */
function frozenNow(t: TestContext): void {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
}

void test("add stores a one-time reminder and answers with the owner-zone time", async (t) => {
  resetState();
  frozenNow(t);

  const answer = await addReminder({ text: "позвонить", at: "in 30m" });
  if (!answer.ok) assert.fail(answer.error);
  assert.equal(answer.now, "2026-09-12 10:00");
  assert.equal(answer.reminder.next_run_at, "2026-09-12 10:30");
  assert.equal(answer.reminder.timezone, "Asia/Tashkent");
  assert.equal(answer.reminder.kind, "at");
  assert.equal(answer.reminder.delivered, null);
  assert.equal(answer.reminder.fired_at, null);
  assert.equal(answer.scheduler.alive, false);
  assert.match(answer.scheduler.warning ?? "", /has not ticked yet/u);

  const rows = await list();
  assert.equal(rows.length, 1);
  const schedule = rows[0].schedule;
  if (schedule.kind !== "at") assert.fail("expected an at schedule");
  assert.equal(schedule.atMs, NOW + 1_800_000);
  // Сессия идущего хода: созданной строке её ещё нет — null, а не пустая строка
  // (старые таблицы без поля читаются так же: agent/lib/reminder-store.test.ts).
  assert.equal(rows[0].sessionId, null);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "chat",
    "createdAt",
    "delivered",
    "error",
    "firedAt",
    "id",
    "nextRunAtMs",
    "schedule",
    "sessionId",
    "status",
    "text",
  ]);

  writePulse(NOW - 60_000);
  const fresh = await addReminder({ text: "ещё раз", at: "in 45m" });
  if (!fresh.ok) assert.fail(fresh.error);
  assert.equal(fresh.scheduler.alive, true);
  assert.equal(fresh.scheduler.last_tick_at, "2026-09-12 09:59");
  assert.equal(fresh.scheduler.warning, undefined);

  // Постаревший пульс: строка всё равно записана, но модель обязана предупредить, что
  // диспетчер не тикает.
  writePulse(NOW - 10 * 60_000);
  const stale = await addReminder({ text: "простояло", at: "in 1h" });
  if (!stale.ok) assert.fail(stale.error);
  assert.equal(stale.scheduler.alive, false);
  assert.match(stale.scheduler.warning ?? "", /has not ticked since/u);

  rmSync(join(dataDir, "reminders.tick"), { force: true });
  const noPulse = await addReminder({ text: "без пульса", at: "in 1h" });
  if (!noPulse.ok) assert.fail(noPulse.error);
  assert.equal(noPulse.scheduler.alive, false);
  assert.match(noPulse.scheduler.warning ?? "", /has not ticked yet/u);

  // Долг QA T5a: ownerTimeZone вызывается тулом, а кривая зона даёт фолбэк resolveTimeZone,
  // не исключение и не хостовую зону.
  process.env.ASSISTANT_TIMEZONE = "Mars/Olympus";
  const fallback = await addReminder({ text: "в UTC", at: "in 30m" });
  if (!fallback.ok) assert.fail(fallback.error);
  assert.equal(fallback.reminder.timezone, "UTC");
});

void test("add stores a repeating reminder with the first run computed by code", async (t) => {
  resetState();
  frozenNow(t);

  const answer = await addReminder({
    text: "стендап",
    cron: "0 9 * * 1-5",
  });
  if (!answer.ok) assert.fail(answer.error);
  assert.equal(answer.reminder.kind, "cron");
  assert.equal(answer.reminder.cron, "0 9 * * 1-5");
  assert.equal(answer.reminder.next_run_at, "2026-09-14 09:00");

  const rows = await list();
  assert.equal(rows.length, 1);
  const schedule = rows[0].schedule;
  if (schedule.kind !== "cron") assert.fail("expected a cron schedule");
  assert.equal(schedule.tz, "Asia/Tashkent");
  assert.equal(rows[0].nextRunAtMs, Date.UTC(2026, 8, 14, 4));
});

void test("the model cannot choose the recipient: адресат не хранится в строке", async (t) => {
  resetState();
  frozenNow(t);

  const injected = await addReminder({
    text: "x",
    at: "in 5m",
    chatId: "999",
    deliver: { chatId: "999" },
    threadId: 7,
  } as never);
  if (!injected.ok) assert.fail(injected.error);
  const rows = await list();
  assert.equal(rows.length, 1);
  assert.equal(
    "deliver" in rows[0],
    false,
    "адресат берётся из .env в момент срабатывания, а не из строки",
  );

  // Владельца берут из .env: сначала чат дайджеста, иначе первый из allowlist.
  process.env.TELEGRAM_DIGEST_CHAT_ID = "";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "123, 456";
  const allowlisted = await addReminder({ text: "y", at: "in 5m" });
  if (!allowlisted.ok) assert.fail(allowlisted.error);
  assert.equal((await list()).length, 2);

  process.env.TELEGRAM_ALLOWED_USER_IDS = " , ";
  const refused = await addReminder({ text: "z", at: "in 5m" });
  if (refused.ok) assert.fail("expected no owner chat");
  assert.match(refused.error, /no owner chat/u);
  assert.equal((await list()).length, 2);
});

void test("a broken table is an error, not a success", async (t) => {
  resetState();
  frozenNow(t);

  writeFileSync(reminderFile(), "{broken");
  const added = await addReminder({ text: "x", at: "in 5m" });
  if (added.ok) assert.fail("expected a damaged table error");
  assert.match(added.error, /damaged/u);

  writeFileSync(reminderFile(), "{broken");
  const listed = await listReminders();
  if (listed.ok) assert.fail("expected a damaged table error");
  assert.match(listed.error, /damaged/u);

  writeFileSync(reminderFile(), "{broken");
  const removed = await removeReminder({ id: "r-000000" });
  if (removed.ok) assert.fail("expected a damaged table error");
  assert.match(removed.error, /damaged/u);

  assert.equal(existsSync(reminderFile()), false);
  const siblings = readdirSync(dataDir).filter((name) =>
    name.includes(".corrupt-"),
  );
  assert.equal(siblings.length, 1);
});

void test("list and remove", async (t) => {
  resetState();
  frozenNow(t);

  for (const input of [
    { text: "через три часа", at: "in 3h" },
    { text: "через час", at: "in 1h" },
    { text: "утренний", cron: "0 9 * * *" },
  ]) {
    const added = await addReminder(input);
    if (!added.ok) assert.fail(added.error);
  }

  const listed = await listReminders();
  if (!listed.ok) assert.fail(listed.error);
  assert.equal(listed.count, 3);
  assert.deepEqual(
    listed.reminders.map((row) => row.text),
    ["через час", "через три часа", "утренний"],
  );
  assert.deepEqual(
    listed.reminders.map((row) => row.delivered),
    [null, null, null],
  );
  assert.equal(listed.timezone, "Asia/Tashkent");

  const first = listed.reminders[0];
  const removed = await removeReminder({ id: first.id });
  if (!removed.ok) assert.fail(removed.error);
  assert.equal(removed.removed.id, first.id);
  assert.equal(removed.removed.text, "через час");

  const again = await removeReminder({ id: first.id });
  if (again.ok) assert.fail("expected a missing id error");
  assert.match(again.error, new RegExp(first.id, "u"));

  const both = await addReminder({
    text: "x",
    at: "in 1h",
    cron: "0 9 * * *",
  });
  if (both.ok) assert.fail("expected exactly one of at or cron");
  assert.match(both.error, /exactly one of at or cron/u);

  const neither = await addReminder({ text: "x" });
  if (neither.ok) assert.fail("expected exactly one of at or cron");
  assert.match(neither.error, /at \(one-time\) or cron \(repeating/u);
});

void test("action decides what the call does, and each action needs its own fields", async (t) => {
  resetState();
  frozenNow(t);

  // Поля разового напоминания при action: "list" не создают строку: ход решает action,
  // а не набор переданных полей.
  const listedWithAddFields = await remind.execute(
    { action: "list", text: "не ставить", at: "in 30m" },
    ctx,
  );
  assert.deepEqual(listedWithAddFields, {
    ok: true,
    count: 0,
    now: "2026-09-12 10:00",
    timezone: "Asia/Tashkent",
    reminders: [],
    scheduler: {
      alive: false,
      last_tick_at: null,
      warning:
        "the reminders dispatcher has not ticked yet on this server; the reminder is stored and fires once it runs - tell the user",
    },
  });
  assert.equal((await list()).length, 0);

  // Снятие по id не ставит напоминание, даже если пришли поля add.
  const added = await addReminder({ text: "снять", at: "in 1h" });
  if (!added.ok) assert.fail(added.error);
  const removed = await remind.execute(
    { action: "remove", id: added.reminder.id, text: "ещё", at: "in 2h" },
    ctx,
  );
  assert.deepEqual(removed, {
    ok: true,
    removed: { id: added.reminder.id, text: "снять" },
  });
  assert.equal((await list()).length, 0);

  const noText = await addReminder({ at: "in 30m" });
  if (noText.ok) assert.fail("expected a missing text error");
  assert.match(noText.error, /add needs text/u);
  assert.equal((await list()).length, 0);

  const noId = await removeReminder({});
  if (noId.ok) assert.fail("expected a missing id error");
  assert.match(noId.error, /remove needs id/u);
});

void test("the three old tool names are gone from the code, the instructions and the docs", () => {
  const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
  // Датированные записи не переименовываются: CHANGELOG и docs/adr фиксируют решение тем
  // языком, каким его приняли, и дописываются разделом «Обновление».
  const skipDirs = new Set(["node_modules", ".git", "adr"]);
  const textFile = /\.(?:ts|mjs|md|txt|html|json)$/u;
  const oldName = /remind_(?:add|list|remove)/u;

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory())
        return skipDirs.has(entry.name) ? [] : walk(path);
      return entry.isFile() && textFile.test(entry.name) ? [path] : [];
    });

  const files = ["agent", "scripts", "docs"]
    .map((dir) => join(root, dir))
    .flatMap(walk)
    .concat(join(root, "CONTEXT.md"));

  const offenders = files.filter((file) => {
    if (statSync(file).size > 2_000_000) return false;
    return oldName.test(readFileSync(file, "utf8"));
  });
  assert.deepEqual(
    offenders.map((file) => file.slice(root.length)),
    [],
    "три тула напоминаний свёрнуты в один remind с полем action",
  );
});

// Отказ remind обязан сказать, что исправить: какое поле пришло не так, какое ждали, и
// одним вызовом-образцом показать исправленный ход. Образец - последний кусок текста после
// «Example: », он обязан разбираться как JSON: модель копирует его буквально.
function exampleCall(error: string): Record<string, unknown> {
  const marker = "Example: ";
  const at = error.lastIndexOf(marker);
  assert.notEqual(at, -1, `no example call in: ${error}`);
  const parsed: unknown = JSON.parse(error.slice(at + marker.length));
  assert.equal(typeof parsed, "object", error);
  return parsed as Record<string, unknown>;
}

/** Образец add: text и ровно одно из at/cron, других полей нет. */
function assertAddExample(error: string): Record<string, unknown> {
  const call = exampleCall(error);
  assert.equal(call.action, "add", error);
  assert.equal(typeof call.text, "string", error);
  assert.equal("at" in call !== "cron" in call, true, error);
  assert.deepEqual(
    Object.keys(call).filter(
      (key) => !["action", "text", "at", "cron"].includes(key),
    ),
    [],
    error,
  );
  return call;
}

void test("every remind refusal names the field and carries one example call", async (t) => {
  resetState();
  frozenNow(t);

  // Живой провал 0.4.2: модель слала at словами и заглушки в cron/id - 135 отказов подряд.
  const both = await addReminder({
    text: "позвонить",
    at: "завтра в 8 утра",
    cron: "0 8 22 9 *",
    id: "x",
  });
  if (both.ok) assert.fail("expected a refusal");
  assert.match(both.error, /at="завтра в 8 утра"/u);
  assert.match(both.error, /cron="0 8 22 9 \*"/u);
  assert.match(both.error, /no empty string or placeholder/u);
  // at словами не разбирается - оставлять надо cron, и образец его и несёт.
  assert.equal(assertAddExample(both.error).cron, "0 8 22 9 *");

  const fillerCron = await addReminder({ text: "x", at: "in 30m", cron: ":" });
  if (fillerCron.ok) assert.fail("expected a refusal");
  assert.match(fillerCron.error, /cron=":"/u);
  assert.equal(assertAddExample(fillerCron.error).at, "in 30m");

  const unreadableBoth = await addReminder({
    text: "x",
    at: "через 3 минуты",
    cron: ":",
  });
  if (unreadableBoth.ok) assert.fail("expected a refusal");
  // Ни одно не годится: образец - разовое напоминание в поддерживаемой форме, а текст
  // называет, почему at не прочитан.
  assert.match(unreadableBoth.error, /at: unsupported form "через 3 минуты"/u);
  assert.equal(assertAddExample(unreadableBoth.error).at, "in 30m");

  const neither = await addReminder({ text: "x", id: "r-1" });
  if (neither.ok) assert.fail("expected a refusal");
  assert.match(neither.error, /got text, id="r-1"/u);
  assertAddExample(neither.error);

  const noText = await addReminder({ cron: "0 9 * * *" });
  if (noText.ok) assert.fail("expected a refusal");
  assert.match(noText.error, /\btext\b/u);
  assert.equal(assertAddExample(noText.error).cron, "0 9 * * *");

  const badAt = await addReminder({ text: "x", at: "завтра" });
  if (badAt.ok) assert.fail("expected a refusal");
  assert.match(badAt.error, /^at: /u);
  assert.equal(assertAddExample(badAt.error).at, "in 30m");

  const pastAt = await addReminder({ text: "x", at: "2026-09-01 09:00" });
  if (pastAt.ok) assert.fail("expected a refusal");
  assert.match(pastAt.error, /^at: .*in the past/u);
  assertAddExample(pastAt.error);

  for (const cron of [":", "0 9 * *", "* * * * *", "0/7 * * * *"]) {
    const badCron = await addReminder({ text: "x", cron });
    if (badCron.ok) assert.fail(`expected a refusal for ${cron}`);
    assert.match(badCron.error, /^cron/u, cron);
    assert.equal(assertAddExample(badCron.error).cron, "0 9 * * 1-5", cron);
  }

  const noId = await removeReminder({ text: "x" });
  if (noId.ok) assert.fail("expected a refusal");
  assert.match(noId.error, /\bid\b/u);
  assert.match(noId.error, /\{"action":"list"\}/u);
  assert.deepEqual(exampleCall(noId.error), {
    action: "remove",
    id: "r-1a2b3c",
  });

  const unknown = await removeReminder({ id: "." });
  if (unknown.ok) assert.fail("expected a refusal");
  assert.match(unknown.error, /^id "\.": /u);
  assert.match(unknown.error, /\{"action":"list"\}/u);
  assert.equal(exampleCall(unknown.error).action, "remove");

  assert.equal((await list()).length, 0, "no refusal stores a row");
});

// Seed в имени теста: провал воспроизводится подстановкой его же в fc.assert.
const REFUSAL_SEED = 20260924;

void test(`remind add: any mix of at, cron, id and text either succeeds or names the field with an example (seed ${String(REFUSAL_SEED)})`, async (t) => {
  resetState();
  frozenNow(t);
  const filler = fc.oneof(
    fc.constantFrom(":", ".", ",", " ", "x", "null", "__omit__", "0 0 0 0 0"),
    fc.string({ minLength: 1, maxLength: 12 }),
  );
  const at = fc.oneof(
    fc.constantFrom("in 30m", "14:30", "2026-09-14 09:00", "завтра в 8 утра"),
    filler,
  );
  const cron = fc.oneof(fc.constantFrom("0 9 * * 1-5", "0 8 22 9 *"), filler);
  await fc.assert(
    fc.asyncProperty(
      fc.record(
        { text: fc.constantFrom("позвонить"), at, cron, id: filler },
        { requiredKeys: [] },
      ),
      async (input) => {
        const answer = await addReminder(input);
        if (answer.ok) return;
        assert.match(answer.error, /\b(?:at|cron|text)\b/u);
        assertAddExample(answer.error);
      },
    ),
    { numRuns: 150, seed: REFUSAL_SEED },
  );
});
