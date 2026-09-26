/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Подсказка «нажмите /new»: пороги 50, 75 и 90 % окна, каждый не больше одного раза за
// сессию, и только после хода, ответ которого дошёл до чата.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  CONTEXT_FILL_THRESHOLDS,
  contextFillHintText,
  contextFillPercent,
  markReplyDelivered,
  nextContextFill,
  recordStepContext,
  resetContextFillForTests,
  returnContextFillHint,
  takeContextFillHint,
} from "./context-fill.ts";

const SEED = 20260926;
const WINDOW = 100_000;

test("процент — вход шага к окну, вниз до целого, не выше 100", () => {
  assert.equal(contextFillPercent(49_999, WINDOW), 49);
  assert.equal(contextFillPercent(50_000, WINDOW), 50);
  assert.equal(contextFillPercent(250_000, WINDOW), 100);
  for (const [tokens, window] of [
    [Number.NaN, WINDOW],
    [-1, WINDOW],
    [Infinity, WINDOW],
    [1000, 0],
    [1000, Number.NaN],
    [1000, -5],
    [undefined, WINDOW],
    ["1000", WINDOW],
  ] as const)
    assert.equal(
      contextFillPercent(tokens, window),
      null,
      `${tokens}/${window}`,
    );
});

test("80 % сразу после 40 % отмечает 50 и 75 одним разом, 90 ещё впереди", () => {
  let state = nextContextFill(0, 40);
  assert.deepEqual(state, { highest: 0, crossed: null });
  state = nextContextFill(state.highest, 80);
  assert.deepEqual(state, { highest: 75, crossed: 75 });
  assert.deepEqual(nextContextFill(state.highest, 85), {
    highest: 75,
    crossed: null,
  });
  assert.deepEqual(nextContextFill(state.highest, 95), {
    highest: 90,
    crossed: 90,
  });
});

test(`пороги: каждый не больше раза за сессию, отмечены ровно достигнутые (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(fc.integer({ min: 0, max: 100 }), fc.constant(null)), {
        maxLength: 40,
      }),
      (percents) => {
        let highest = 0;
        const fired: number[] = [];
        for (const percent of percents) {
          const next = nextContextFill(highest, percent);
          assert.ok(next.highest >= highest, "состояние не откатывается");
          if (next.crossed !== null) {
            assert.equal(next.crossed, next.highest);
            fired.push(
              ...CONTEXT_FILL_THRESHOLDS.filter(
                (t) => t > highest && t <= next.highest,
              ),
            );
          } else assert.equal(next.highest, highest);
          highest = next.highest;
        }
        assert.equal(new Set(fired).size, fired.length, "порог дважды");
        const peak = Math.max(
          0,
          ...percents.filter((p): p is number => p !== null),
        );
        assert.deepEqual(
          fired.sort((a, b) => a - b),
          CONTEXT_FILL_THRESHOLDS.filter((t) => t <= peak),
          "отмечены ровно пороги, которые контекст достиг",
        );
      },
    ),
    { seed: SEED, numRuns: 500 },
  );
});

test(`мусор в расходе или окне подсказки не даёт (seed ${SEED})`, () => {
  resetContextFillForTests();
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constantFrom(
          Number.NaN,
          -1,
          -0.5,
          Infinity,
          undefined,
          null,
          "90000",
        ),
        fc.double({ max: -Number.MIN_VALUE }),
      ),
      fc.oneof(
        fc.constantFrom(0, Number.NaN, -1, Infinity),
        fc.integer({ min: 1, max: 1_000_000 }),
      ),
      (tokens, window) => {
        const session = `junk-${String(tokens)}-${window}`;
        recordStepContext(session, tokens);
        markReplyDelivered(session, "turn_0");
        assert.equal(takeContextFillHint(session, "turn_0", window), null);
      },
    ),
    { seed: SEED, numRuns: 200 },
  );
});

test("подсказка только для хода, ответ которого доставлен, и один раз на порог", () => {
  resetContextFillForTests();
  recordStepContext("s1", 60_000);
  assert.equal(
    takeContextFillHint("s1", "turn_1", WINDOW),
    null,
    "не доставлен",
  );
  markReplyDelivered("s1", "turn_1");
  assert.equal(takeContextFillHint("s1", "turn_2", WINDOW), null, "чужой ход");
  assert.deepEqual(takeContextFillHint("s1", "turn_1", WINDOW), {
    percent: 60,
    previous: 0,
  });
  markReplyDelivered("s1", "turn_2");
  recordStepContext("s1", 70_000);
  assert.equal(takeContextFillHint("s1", "turn_2", WINDOW), null, "50 уже был");
  markReplyDelivered("s1", "turn_3");
  recordStepContext("s1", 91_000);
  assert.deepEqual(takeContextFillHint("s1", "turn_3", WINDOW), {
    percent: 91,
    previous: 50,
  });
  assert.equal(takeContextFillHint("s1", "turn_3", WINDOW), null, "ход забран");
});

test("подсказка, не дошедшая до чата, возвращает порог следующему ходу", () => {
  resetContextFillForTests();
  recordStepContext("s-back", 80_000);
  markReplyDelivered("s-back", "turn_1");
  const hint = takeContextFillHint("s-back", "turn_1", WINDOW);
  assert.deepEqual(hint, { percent: 80, previous: 0 });
  returnContextFillHint("s-back", hint.previous);
  markReplyDelivered("s-back", "turn_2");
  assert.deepEqual(takeContextFillHint("s-back", "turn_2", WINDOW), {
    percent: 80,
    previous: 0,
  });
});

test("новая сессия после /new начинает пороги заново", () => {
  resetContextFillForTests();
  recordStepContext("old", 95_000);
  markReplyDelivered("old", "turn_5");
  assert.equal(takeContextFillHint("old", "turn_5", WINDOW)?.percent, 95);
  recordStepContext("new", 52_000);
  markReplyDelivered("new", "turn_0");
  assert.equal(takeContextFillHint("new", "turn_0", WINDOW)?.percent, 52);
});

test("текст называет процент и /new", () => {
  const text = contextFillHintText(76);
  assert.match(text, /76/);
  assert.match(text, /\/new/);
});
