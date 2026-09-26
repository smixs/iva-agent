/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; the send double keeps the async Bot API boundary. */
// Подсказка «нажмите /new»: процент — вход последнего шага к бюджету (доля окна, на которой
// eve сжимает историю); уровень 50, 75 или 90. Строка уходит, когда уровень выше показанного,
// и фиксируется только после успешной отправки; сжатие истории освобождает уровни.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import fc from "fast-check";
import { COMPACTION_THRESHOLD_PERCENT } from "./compaction.ts";
import * as fill from "./context-fill.ts";
import { noticeSender } from "./outbox.ts";
import { stepInputTokens } from "./usage.ts";

// Хук расхода пишет data/usage.jsonl — во временный каталог, не в данные checkout.
const dataDir = mkdtempSync(join(tmpdir(), "iva-context-fill-unit-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));
// Хук тянет соседей NodeNext-спецификаторами (.js) — резолв-хук ставится до его импорта.
await import("../../scripts/lib/ts-esm-hooks.ts");
const usageHook = (await import("../hooks/usage.ts")).default as unknown as {
  events: Record<string, (event: unknown, ctx: unknown) => void>;
};
/** Шаг через настоящий хук расхода: так в карту попадает только то, что хук пропустил. */
const hookStep = (id: string, usage: unknown) =>
  usageHook.events["step.completed"](
    { data: { stepIndex: 0, turnId: "turn_1", usage } },
    { session: { id }, channel: { kind: "channel:telegram" } },
  );

const SEED = 20260926;
const WINDOW = 100_000;
// Бюджет 70 000: процент p даёт вход p × 700 токенов ровно.
const tokensAt = (pct: number) => pct * 700;
let seq = 0;
const sessionId = () => `ctx-fill-${++seq}`;

/** Отправка-двойник: помнит строки; fail — отказ Bot API исключением. */
function sender(fail = false) {
  const lines: string[] = [];
  const send = noticeSender(async (text: string) => {
    if (fail) throw new Error("sendMessage refused");
    lines.push(text);
  });
  return { lines, send };
}

/** Ход в порядке канала: turn.started, ответ доставлен, вход последнего шага, подсказка. */
async function turn(
  id: string,
  tokens: number | null,
  send = sender(),
  open = true,
) {
  if (open) fill.openContextFill(id);
  fill.markReplyDelivered(id);
  fill.recordStepContext(id, tokens);
  await fill.notifyContextFill(id, WINDOW, send.send);
  return send.lines;
}

test("процент — вход шага к бюджету, вниз до целого, не выше 100", () => {
  assert.equal(fill.contextFillPercent(35_000, WINDOW), 50);
  assert.equal(fill.contextFillPercent(34_999, WINDOW), 49);
  // Бюджет 100 (окно 143): 57 / 100 * 100 === 56.99999999999999, деление первым теряло процент.
  assert.equal(fill.contextFillPercent(57, 143), 57);
  assert.equal(fill.contextFillPercent(140_000, WINDOW), 100);
  assert.equal(fill.contextFillPercent(10, 0), null);
});

test("бюджет — доля окна, на которой eve сжимает историю", () => {
  assert.equal(COMPACTION_THRESHOLD_PERCENT, 0.7);
  assert.equal(
    fill.contextFillPercent(WINDOW * COMPACTION_THRESHOLD_PERCENT, WINDOW),
    100,
  );
  assert.equal(fill.contextFillPercent(91_750, 131_072), 100);
  assert.equal(fill.contextFillPercent(45_875, 131_072), 50);
});

test("скачок через порог сразу после 40 % показывает старший уровень один раз, промежуточный пропускается", async () => {
  assert.deepEqual(
    [40, 80, 85, 95].map((pct) => fill.contextFillLevel(pct)),
    [0, 75, 75, 90],
  );
  const id = sessionId();
  assert.deepEqual(await turn(id, tokensAt(40)), []);
  assert.deepEqual(await turn(id, tokensAt(80)), [
    fill.contextFillHintText(80),
  ]);
  assert.deepEqual(await turn(id, tokensAt(85)), [], "75 уже показан");
  assert.deepEqual(await turn(id, tokensAt(95)), [
    fill.contextFillHintText(95),
  ]);
});

test("падение ниже 50 % бюджета пороги не взводит: взводит только сжатие истории", async () => {
  const id = sessionId();
  assert.equal((await turn(id, tokensAt(90))).length, 1);
  assert.deepEqual(await turn(id, tokensAt(40)), []);
  assert.deepEqual(await turn(id, tokensAt(55)), [], "после спада без сжатия");
  fill.rearmContextFill(id);
  assert.deepEqual(await turn(id, tokensAt(55)), [
    fill.contextFillHintText(55),
  ]);
  assert.deepEqual(await turn(id, null), [], "неизвестно — ничего");
});

test("в карте только сессии, открытые каналом: шаги чужой сессии не создают запись", async () => {
  const id = sessionId();
  assert.deepEqual(await turn(id, tokensAt(85), sender(), false), []);
  fill.rearmContextFill(id);
  assert.deepEqual(await turn(id, tokensAt(85), sender(), false), [], "снова");
  fill.openContextFill(id);
  assert.equal((await turn(id, tokensAt(85))).length, 1);
});

test("шаг без расхода сбрасывает контекст в «неизвестно»: подсказки нет", async () => {
  const id = sessionId();
  fill.openContextFill(id);
  fill.recordStepContext(id, tokensAt(85));
  assert.deepEqual(await turn(id, null), []);
  assert.equal((await turn(id, tokensAt(85))).length, 1);
});

test("после сжатия истории (compaction.completed) подъём снова напоминает", async () => {
  const id = sessionId();
  assert.equal((await turn(id, tokensAt(94))).length, 1);
  assert.equal((await turn(id, tokensAt(28))).length, 0);
  usageHook.events["compaction.completed"]({ data: {} }, { session: { id } });
  assert.deepEqual(await turn(id, tokensAt(62)), [
    fill.contextFillHintText(62),
  ]);
  assert.equal((await turn(id, tokensAt(62))).length, 0, "50 снова показан");
});

test("карта не ограничена мусором: в неё идёт только вход шага больше нуля", () => {
  for (const inputTokens of [0, undefined, null, Number.NaN, -1, 1.5, "90"])
    assert.equal(stepInputTokens({ inputTokens }), null, String(inputTokens));
  assert.equal(stepInputTokens(undefined), null);
  assert.equal(stepInputTokens({ inputTokens: 56_000 }), 56_000);
});

test("пороги: нулевой шаг между ходами на 80 % их не взводит, подсказка не больше одной", async () => {
  const id = sessionId();
  assert.equal((await turn(id, tokensAt(80))).length, 1);
  assert.equal((await turn(id, tokensAt(80))).length, 0);
  fill.openContextFill(id);
  fill.markReplyDelivered(id);
  hookStep(id, { inputTokens: 0, outputTokens: 0 });
  const { lines, send } = sender();
  await fill.notifyContextFill(id, WINDOW, send);
  assert.deepEqual(lines, [], "нулевой шаг — неизвестно");
  assert.equal((await turn(id, tokensAt(80))).length, 0, "80 % не повторился");
  fill.rearmContextFill(id);
  assert.equal(
    (await turn(id, tokensAt(80))).length,
    1,
    "только сжатие взводит",
  );
});

test("границы уровня: 49 и 50, 74 и 75, 89 и 90, выше бюджета — 90", () => {
  assert.equal(fill.contextFillLevel(49), 0);
  assert.equal(fill.contextFillLevel(50), 50);
  assert.equal(fill.contextFillLevel(74), 50);
  assert.equal(fill.contextFillLevel(75), 75);
  assert.equal(fill.contextFillLevel(89), 75);
  assert.equal(fill.contextFillLevel(90), 90);
  assert.equal(
    fill.contextFillLevel(fill.contextFillPercent(99_000, WINDOW) ?? 0),
    90,
  );
});

test(`уровень монотонен по проценту и меняется ровно на 50, 75, 90 (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 100 }),
      (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        assert.ok(fill.contextFillLevel(lo) <= fill.contextFillLevel(hi));
        assert.ok([0, 50, 75, 90].includes(fill.contextFillLevel(a)));
        assert.equal(
          fill.contextFillLevel(a) !== fill.contextFillLevel(a - 1),
          [50, 75, 90].includes(a),
        );
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
});

// Валидация одна — на границе хука: мусор провайдера не становится контекстом.
test(`мусор в расходе шага подсказки не даёт и порог не тратит (seed ${SEED})`, async () => {
  const junk = fc.constantFrom(
    0,
    Number.NaN,
    -1,
    -0.5,
    1.5,
    Infinity,
    "90000",
    null,
    undefined,
  );
  await fc.assert(
    fc.asyncProperty(junk, async (inputTokens) => {
      const id = sessionId();
      fill.openContextFill(id);
      assert.equal((await turn(id, 36_400)).length, 1, "50 отмечен");
      fill.openContextFill(id);
      fill.markReplyDelivered(id);
      hookStep(id, { inputTokens, outputTokens: 5 });
      const { lines, send } = sender();
      await fill.notifyContextFill(id, WINDOW, send);
      assert.deepEqual(lines, [], `мусор ${String(inputTokens)} дал подсказку`);
      // Мусор — «неизвестно», а не ноль: 50 не звучит снова.
      assert.equal((await turn(id, 36_400)).length, 0);
    }),
    { seed: SEED, numRuns: 40 },
  );
});

test("подсказка только для хода, ответ которого доставлен, и один раз на порог", async () => {
  const id = sessionId();
  fill.openContextFill(id);
  fill.recordStepContext(id, 42_000);
  const { lines, send } = sender();
  await fill.notifyContextFill(id, WINDOW, send);
  assert.deepEqual(lines, [], "не доставлен");
  fill.markReplyDelivered(id);
  fill.openContextFill(id);
  fill.recordStepContext(id, 42_000);
  await fill.notifyContextFill(id, WINDOW, send);
  assert.deepEqual(lines, [], "доставка прошлого хода не в счёт");
  fill.markReplyDelivered(id);
  await fill.notifyContextFill(id, WINDOW, send);
  assert.deepEqual(lines, [fill.contextFillHintText(60)]);
  await fill.notifyContextFill(id, WINDOW, send);
  assert.equal(lines.length, 1, "уровень уже показан");
  assert.deepEqual(await turn(id, 49_000), [], "50 уже был");
  assert.deepEqual(await turn(id, 63_700), [fill.contextFillHintText(91)]);
  await fill.notifyContextFill(id, WINDOW, send);
  assert.equal(lines.length, 1, "повтор хода молчит");
});

test("подсказка, не дошедшая до чата, возвращает порог следующему ходу", async () => {
  const id = sessionId();
  assert.deepEqual(await turn(id, 60_000, sender(true)), []);
  assert.deepEqual(await turn(id, 60_000), [fill.contextFillHintText(85)]);
  assert.equal((await turn(id, 60_000)).length, 0, "дошла — всё");
});

test("новая сессия после /new начинает пороги заново", async () => {
  const old = sessionId();
  const fresh = sessionId();
  assert.deepEqual(await turn(old, 66_500), [fill.contextFillHintText(95)]);
  assert.deepEqual(await turn(fresh, 36_400), [fill.contextFillHintText(52)]);
});

test("текст называет процент и /new", () => {
  const text = fill.contextFillHintText(76);
  assert.match(text, /76/);
  assert.match(text, /\/new/);
});
