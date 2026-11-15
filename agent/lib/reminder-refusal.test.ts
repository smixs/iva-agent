/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  addFieldsRefusal,
  planSchedule,
  removeFieldsRefusal,
  unknownIdRefusal,
  type AddFields,
} from "./reminder-refusal.ts";

// Зона владельца в примерах — Ташкент (UTC+5, без перехода на летнее время),
// now = 2026-09-12T05:00:00Z, суббота, 10:00 на стене.
const TASHKENT = "Asia/Tashkent";
const NOW = Date.UTC(2026, 8, 12, 5, 0);
const SEED = 20260924;

/** Образец вызова из отказа: JSON-объект после «Example: », которым отказ кончается.
 * Показанные значения идут через JSON.stringify, их кавычки экранированы, поэтому
 * `Example: {"action":` внутри значения не встречается. */
function example(refusal: string): Record<string, unknown> {
  const marker = 'Example: {"action":';
  const at = refusal.lastIndexOf(marker);
  assert.ok(at >= 0, `в отказе нет образца вызова: ${refusal}`);
  const parsed: unknown = JSON.parse(refusal.slice(at + "Example: ".length));
  assert.ok(typeof parsed === "object" && parsed !== null, refusal);
  return parsed as Record<string, unknown>;
}

/** Отказ add, который обязан быть: null здесь — провал теста. */
function refusalOf(fields: AddFields): string {
  const refusal = addFieldsRefusal(fields, NOW, TASHKENT);
  assert.ok(
    refusal !== null,
    `поля ${JSON.stringify(fields)} прошли без отказа`,
  );
  return refusal;
}

test("addFieldsRefusal пропускает text и ровно одно из at/cron", () => {
  assert.equal(
    addFieldsRefusal({ text: "call", at: "in 30m" }, NOW, TASHKENT),
    null,
  );
  assert.equal(
    addFieldsRefusal({ text: "call", cron: "0 9 * * 1-5" }, NOW, TASHKENT),
    null,
  );
});

test("addFieldsRefusal без text называет поле и берёт пришедший срок в образец", () => {
  const withCron = refusalOf({ cron: "0 9 * * *" });
  assert.ok(withCron.startsWith("add needs text"), withCron);
  assert.ok(withCron.includes('got cron="0 9 * * *"'), withCron);
  assert.deepEqual(example(withCron), {
    action: "add",
    content: "task",
    text: "<what to do at the due time>",
    cron: "0 9 * * *",
  });

  const bare = refusalOf({});
  assert.ok(bare.includes("got only action"), bare);
  assert.deepEqual(example(bare), {
    action: "add",
    content: "task",
    text: "<what to do at the due time>",
    at: "in 30m",
  });
});

test("addFieldsRefusal без расписания называет at и cron, text повторяет как есть", () => {
  const refusal = refusalOf({ text: "call mom" });
  assert.ok(refusal.startsWith("add needs a schedule: at"), refusal);
  assert.ok(refusal.includes("cron"), refusal);
  assert.ok(refusal.includes("got text"), refusal);
  assert.deepEqual(example(refusal), {
    action: "add",
    content: "task",
    text: "call mom",
    at: "in 30m",
  });
});

test("addFieldsRefusal при at и cron сразу оставляет то поле, что читается", () => {
  const keepCron = refusalOf({
    text: "standup",
    at: "every weekday",
    cron: "0 9 * * 1-5",
  });
  assert.ok(keepCron.startsWith("add takes exactly one of at or cron"));
  assert.ok(keepCron.includes("Keep cron"), keepCron);
  assert.deepEqual(example(keepCron), {
    action: "add",
    content: "task",
    text: "standup",
    cron: "0 9 * * 1-5",
  });

  const keepAt = refusalOf({
    text: "standup",
    at: "14:30",
    cron: "0 9 * * 1-5",
  });
  assert.ok(keepAt.includes("Keep at"), keepAt);
  assert.deepEqual(example(keepAt), {
    action: "add",
    content: "task",
    text: "standup",
    at: "14:30",
  });

  const neither = refusalOf({ text: "standup", at: "soon", cron: "x" });
  assert.ok(neither.includes("Keep at"), neither);
  assert.ok(neither.includes('at: unsupported form "soon"'), neither);
  assert.deepEqual(example(neither), {
    action: "add",
    content: "task",
    text: "standup",
    at: "in 30m",
  });
});

test("отказ показывает длинное значение началом, длинный text — упоминанием", () => {
  const longAt = "a".repeat(80);
  const refusal = refusalOf({
    text: "t".repeat(201),
    at: longAt,
    cron: "0 9 * * *",
  });
  assert.ok(refusal.includes(`at="${"a".repeat(60)}…"`), refusal);
  assert.ok(!refusal.includes(longAt), refusal);
  assert.equal(example(refusal).text, "<the same text>");
});

test("planSchedule считает срок сам: at — момент, cron — ближайший запуск", () => {
  assert.deepEqual(planSchedule({ text: "x", at: "in 30m" }, NOW, TASHKENT), {
    schedule: { kind: "at", atMs: NOW + 30 * 60_000 },
  });
  assert.deepEqual(planSchedule({ text: "x", at: "14:30" }, NOW, TASHKENT), {
    schedule: { kind: "at", atMs: Date.UTC(2026, 8, 12, 9, 30) },
  });
  assert.deepEqual(
    planSchedule({ text: "x", cron: " 0  9 * * 1-5 " }, NOW, TASHKENT),
    {
      schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: TASHKENT },
      nextRunAtMs: Date.UTC(2026, 8, 14, 4, 0),
    },
  );
});

test("planSchedule на негодный at отвечает отказом с полем и образцом", () => {
  const form = planSchedule({ text: "x", at: "tomorrow" }, NOW, TASHKENT);
  assert.ok("refusal" in form);
  assert.ok(form.refusal.startsWith('at: unsupported form "tomorrow"'));
  assert.ok(form.refusal.includes("Put the user's own time"), form.refusal);
  assert.deepEqual(example(form.refusal), {
    action: "add",
    content: "task",
    text: "x",
    at: "in 30m",
  });

  const past = planSchedule(
    { text: "x", at: "2026-09-01 09:00" },
    NOW,
    TASHKENT,
  );
  assert.ok("refusal" in past);
  assert.ok(past.refusal.startsWith("at: "), past.refusal);
  assert.ok(past.refusal.includes("is in the past"), past.refusal);
  assert.ok(past.refusal.includes('"in 30m", "14:30"'), past.refusal);
});

test("planSchedule на негодный cron называет cron и значение без служебного префикса", () => {
  const fields = planSchedule({ text: "x", cron: "* * * *" }, NOW, TASHKENT);
  assert.ok("refusal" in fields);
  assert.ok(
    fields.refusal.startsWith(
      'cron "* * * *": expr must have exactly 5 fields',
    ),
    fields.refusal,
  );
  assert.ok(!fields.refusal.includes("schedule:"), fields.refusal);
  assert.deepEqual(example(fields.refusal), {
    action: "add",
    content: "task",
    text: "x",
    cron: "0 9 * * 1-5",
  });

  const often = planSchedule({ text: "x", cron: "* * * * *" }, NOW, TASHKENT);
  assert.ok("refusal" in often);
  assert.ok(
    often.refusal.startsWith(
      'cron "* * * * *": fires more often than every 10 minutes',
    ),
    often.refusal,
  );
});

test("remove: отказ называет id, откуда его взять, и даёт образец", () => {
  const missing = removeFieldsRefusal({});
  assert.ok(missing.startsWith("remove needs id, got only action"), missing);
  assert.ok(missing.includes('{"action":"list"}'), missing);
  assert.deepEqual(example(missing), { action: "remove", id: "r-1a2b3c" });

  const unknown = unknownIdRefusal("r-zzz");
  assert.ok(unknown.startsWith('id "r-zzz": no such reminder'), unknown);
  assert.ok(unknown.includes('{"action":"list"}'), unknown);
  assert.deepEqual(example(unknown), { action: "remove", id: "r-1a2b3c" });
});

const field = fc.option(fc.string({ maxLength: 80 }), { nil: undefined });

test(`addFieldsRefusal: null ровно при text и одном сроке, иначе образец add с одним сроком (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.record({
        text: fc.option(fc.string({ maxLength: 260 }), { nil: undefined }),
        at: fc.oneof(field, fc.constantFrom("in 30m", "14:30")),
        cron: fc.oneof(field, fc.constant("0 9 * * 1-5")),
        id: field,
      }),
      (raw) => {
        const fields = Object.fromEntries(
          Object.entries(raw).filter(([, v]) => v !== undefined),
        ) as AddFields;
        const refusal = addFieldsRefusal(fields, NOW, TASHKENT);
        const valid =
          fields.text !== undefined &&
          (fields.at === undefined) !== (fields.cron === undefined);
        assert.equal(refusal === null, valid);
        if (refusal === null) return;
        const call = example(refusal);
        assert.equal(call.action, "add");
        assert.equal("at" in call !== "cron" in call, true);
        if (fields.text !== undefined)
          assert.equal(
            call.text,
            fields.text.length <= 200 ? fields.text : "<the same text>",
          );
      },
    ),
    { seed: SEED, numRuns: 400 },
  );
});

test(`planSchedule: любой at или cron — срок или отказ по своему полю, без исключений (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.record({ at: fc.string({ maxLength: 40 }) }),
        fc.record({
          at: fc.integer({ min: 1, max: 600 }).map((m) => `in ${m}m`),
        }),
        fc.record({ cron: fc.string({ maxLength: 40 }) }),
        fc.record({
          cron: fc
            .tuple(
              fc.integer({ min: 0, max: 59 }),
              fc.integer({ min: 0, max: 23 }),
            )
            .map(([m, h]) => `${m} ${h} * * *`),
        }),
      ),
      (when: { at?: string; cron?: string }) => {
        const plan = planSchedule({ text: "x", ...when }, NOW, TASHKENT);
        const kind = when.at === undefined ? "cron" : "at";
        if ("refusal" in plan) {
          assert.ok(plan.refusal.startsWith(`${kind}`), plan.refusal);
          const call = example(plan.refusal);
          assert.equal(call.action, "add");
          assert.ok(kind in call, plan.refusal);
          return;
        }
        assert.equal(plan.schedule.kind, kind);
        if (plan.schedule.kind === "at") {
          assert.ok(plan.schedule.atMs > NOW);
          const minutes = /^in (\d+)m$/u.exec(when.at ?? "");
          if (minutes)
            assert.equal(plan.schedule.atMs, NOW + Number(minutes[1]) * 60_000);
        } else {
          assert.ok((plan.nextRunAtMs ?? 0) > NOW);
        }
      },
    ),
    { seed: SEED, numRuns: 400 },
  );
});
