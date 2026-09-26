/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; the send double keeps the async Bot API boundary. */
// Подсказка «нажмите /new»: заполнение считается от бюджета (доля окна, на которой eve
// сжимает историю), пороги 50, 75 и 90 % — по разу за цикл заполнения; падение ниже 50 %
// взводит их заново. Порог заявляется до отправки и освобождается, если строка не ушла.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import fc from "fast-check";
import { COMPACTION_THRESHOLD_PERCENT } from "./compaction.ts";
import * as fill from "./context-fill.ts";
import { noticeSender } from "./outbox.ts";

// Хук расхода пишет data/usage.jsonl — во временный каталог, не в данные checkout.
const dataDir = mkdtempSync(join(tmpdir(), "iva-context-fill-unit-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));
// Хук тянет соседей NodeNext-спецификаторами (.js) — резолв-хук ставится до его импорта.
await import("../../scripts/lib/ts-esm-hooks.ts");
const usageHook = (await import("../hooks/usage.ts")).default as unknown as {
  events: Record<string, (event: unknown, ctx: unknown) => void>;
};

const SEED = 20260926;
const WINDOW = 100_000;
const BUDGET = 70_000;
const THRESHOLDS = [50, 75, 90];
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

/** Ход, ответ которого дошёл: отметка доставки, вход последнего шага, подсказка. */
async function turn(
  id: string,
  turnId: string,
  tokens: number | null,
  send = sender(),
) {
  fill.markReplyDelivered(id, turnId);
  fill.recordStepContext(id, tokens);
  await fill.notifyContextFill(id, turnId, WINDOW, send.send);
  return send.lines;
}

test("процент — вход шага к бюджету, вниз до целого, не выше 100", () => {
  assert.equal(fill.contextFillPercent(35_000, BUDGET), 50);
  assert.equal(fill.contextFillPercent(34_999, BUDGET), 49);
  // 57 / 100 * 100 === 56.99999999999999: деление первым теряло процент.
  assert.equal(fill.contextFillPercent(57, 100), 57);
  assert.equal(fill.contextFillPercent(140_000, BUDGET), 100);
  assert.equal(fill.contextFillPercent(10, 0), null);
});

test("бюджет — доля окна, на которой eve сжимает историю", () => {
  assert.equal(
    fill.contextBudget(WINDOW),
    Math.floor(WINDOW * COMPACTION_THRESHOLD_PERCENT),
  );
  assert.equal(fill.contextBudget(WINDOW), BUDGET);
  assert.equal(fill.contextBudget(131_072), 91_750);
});

test("80 % сразу после 40 % отмечает 50 и 75 одним разом, 90 ещё впереди", () => {
  let state = fill.nextContextFill(0, 40);
  assert.deepEqual(state, { highest: 0, crossed: null });
  state = fill.nextContextFill(state.highest, 80);
  assert.deepEqual(state, { highest: 75, crossed: 75 });
  assert.deepEqual(fill.nextContextFill(state.highest, 85), {
    highest: 75,
    crossed: null,
  });
  assert.deepEqual(fill.nextContextFill(state.highest, 95), {
    highest: 90,
    crossed: 90,
  });
});

test("падение ниже 50 % бюджета взводит пороги заново", () => {
  assert.deepEqual(fill.nextContextFill(90, 40), { highest: 0, crossed: null });
  assert.deepEqual(fill.nextContextFill(0, 55), { highest: 50, crossed: 50 });
  assert.deepEqual(fill.nextContextFill(75, null), {
    highest: 75,
    crossed: null,
  });
});

test("в карте только сессии, открытые каналом: шаги чужой сессии не создают запись", async () => {
  const id = sessionId();
  assert.deepEqual(await turn(id, "turn_1", 60_000), []);
  assert.deepEqual(await turn(id, "turn_2", 60_000), [], "и следующий ход");
  fill.openContextFill(id);
  assert.equal((await turn(id, "turn_3", 60_000)).length, 1);
});

test("шаг без расхода сбрасывает контекст в «неизвестно»: подсказки нет", async () => {
  const id = sessionId();
  fill.openContextFill(id);
  fill.recordStepContext(id, 60_000);
  assert.deepEqual(await turn(id, "turn_1", null), []);
  assert.equal((await turn(id, "turn_2", 60_000)).length, 1);
});

test("после сжатия истории ниже 50 % подъём снова напоминает", async () => {
  const id = sessionId();
  fill.openContextFill(id);
  assert.equal((await turn(id, "turn_1", 66_000)).length, 1);
  assert.equal((await turn(id, "turn_2", 20_000)).length, 0);
  assert.deepEqual(await turn(id, "turn_3", 36_000), [
    fill.contextFillHintText(51),
  ]);
});

test("карта держит не больше 256 сессий: самая давняя уходит", async () => {
  const first = sessionId();
  fill.openContextFill(first);
  for (let i = 0; i < 256; i++) fill.openContextFill(sessionId());
  assert.deepEqual(await turn(first, "turn_1", 60_000), []);
});

test(`пороги: каждый не больше раза за цикл заполнения, отмечены ровно достигнутые (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(fc.integer({ min: 0, max: 100 }), fc.constant(null)), {
        maxLength: 60,
      }),
      (percents) => {
        let highest = 0;
        let cycle: { fired: number[]; peak: number } = { fired: [], peak: 0 };
        const check = () => {
          assert.equal(new Set(cycle.fired).size, cycle.fired.length);
          assert.deepEqual(
            [...cycle.fired].sort((a, b) => a - b),
            THRESHOLDS.filter((t) => t <= cycle.peak),
          );
        };
        for (const percent of percents) {
          if (percent !== null && percent < 50) {
            check();
            cycle = { fired: [], peak: 0 };
          } else if (percent !== null)
            cycle.peak = Math.max(cycle.peak, percent);
          const next = fill.nextContextFill(highest, percent);
          // Без перехода порога состояние прежнее, кроме перевзвода ниже 50 %.
          const rearmed = percent !== null && percent < 50;
          if (percent === null)
            assert.deepEqual(next, { highest, crossed: null }, "null — ничего");
          else if (percent < 50)
            assert.equal(next.highest, 0, "ниже 50 % пороги взведены");
          else assert.ok(next.highest >= highest, "в цикле не откатывается");
          if (next.crossed !== null) {
            assert.equal(next.crossed, next.highest);
            cycle.fired.push(
              ...THRESHOLDS.filter((t) => t > highest && t <= next.highest),
            );
          } else assert.equal(next.highest, rearmed ? 0 : highest);
          highest = next.highest;
        }
        assert.equal(
          new Set(cycle.fired).size,
          cycle.fired.length,
          "порог дважды",
        );
        assert.deepEqual(
          [...cycle.fired].sort((a, b) => a - b),
          THRESHOLDS.filter((t) => t <= cycle.peak),
          "отмечены ровно пороги, которые контекст достиг",
        );
      },
    ),
    { seed: SEED, numRuns: 500 },
  );
});

// Валидация одна — на границе хука: мусор провайдера не становится контекстом.
test(`мусор в расходе шага подсказки не даёт и порог не тратит (seed ${SEED})`, async () => {
  const junk = fc.constantFrom(
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
      assert.equal((await turn(id, "turn_0", 36_400)).length, 1, "50 отмечен");
      fill.markReplyDelivered(id, "turn_1");
      usageHook.events["step.completed"](
        {
          data: {
            stepIndex: 0,
            turnId: "turn_1",
            usage: { inputTokens, outputTokens: 5 },
          },
        },
        { session: { id }, channel: { kind: "channel:telegram" } },
      );
      const { lines, send } = sender();
      await fill.notifyContextFill(id, "turn_1", WINDOW, send);
      assert.deepEqual(lines, [], `мусор ${String(inputTokens)} дал подсказку`);
      // Мусор — «неизвестно», а не ноль: пороги не взведены, 50 не звучит снова.
      assert.equal((await turn(id, "turn_2", 36_400)).length, 0);
    }),
    { seed: SEED, numRuns: 40 },
  );
});

test("подсказка только для хода, ответ которого доставлен, и один раз на порог", async () => {
  const id = sessionId();
  fill.openContextFill(id);
  fill.recordStepContext(id, 42_000);
  const { lines, send } = sender();
  await fill.notifyContextFill(id, "turn_1", WINDOW, send);
  assert.deepEqual(lines, [], "не доставлен");
  fill.markReplyDelivered(id, "turn_1");
  await fill.notifyContextFill(id, "turn_2", WINDOW, send);
  assert.deepEqual(lines, [], "чужой ход");
  await fill.notifyContextFill(id, "turn_1", WINDOW, send);
  assert.deepEqual(lines, [fill.contextFillHintText(60)]);
  await fill.notifyContextFill(id, "turn_1", WINDOW, send);
  assert.equal(lines.length, 1, "ход забран");
  assert.deepEqual(await turn(id, "turn_2", 49_000), [], "50 уже был");
  assert.deepEqual(await turn(id, "turn_3", 63_700), [
    fill.contextFillHintText(91),
  ]);
  await fill.notifyContextFill(id, "turn_3", WINDOW, send);
  assert.equal(lines.length, 1, "повтор хода молчит");
});

test("подсказка, не дошедшая до чата, возвращает порог следующему ходу", async () => {
  const id = sessionId();
  fill.openContextFill(id);
  assert.deepEqual(await turn(id, "turn_1", 60_000, sender(true)), []);
  assert.deepEqual(await turn(id, "turn_2", 60_000), [
    fill.contextFillHintText(85),
  ]);
  assert.equal((await turn(id, "turn_3", 60_000)).length, 0, "дошла — всё");
});

test("новая сессия после /new начинает пороги заново", async () => {
  const old = sessionId();
  const fresh = sessionId();
  fill.openContextFill(old);
  assert.deepEqual(await turn(old, "turn_5", 66_500), [
    fill.contextFillHintText(95),
  ]);
  fill.openContextFill(fresh);
  assert.deepEqual(await turn(fresh, "turn_0", 36_400), [
    fill.contextFillHintText(52),
  ]);
});

test("текст называет процент и /new", () => {
  const text = fill.contextFillHintText(76);
  assert.match(text, /76/);
  assert.match(text, /\/new/);
});
