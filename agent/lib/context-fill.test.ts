/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; the send double keeps the async Bot API boundary. */
// Подсказка «нажмите /new»: процент — вход последнего шага к бюджету (доля окна, на которой
// eve сжимает историю); уровень 50, 75 или 90. Строка уходит, когда уровень выше показанного,
// и фиксируется только после успешной отправки; ниже 50 % показанный уровень снова 0.
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

test("80 % сразу после 40 % отмечает 50 и 75 одним разом, 90 ещё впереди", async () => {
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

test("падение ниже 50 % бюджета взводит пороги заново", async () => {
  const id = sessionId();
  assert.equal((await turn(id, tokensAt(90))).length, 1);
  assert.deepEqual(await turn(id, tokensAt(40)), []);
  assert.deepEqual(await turn(id, tokensAt(55)), [
    fill.contextFillHintText(55),
  ]);
  assert.deepEqual(await turn(id, null), [], "неизвестно — не спад");
});

test("в карте только сессии, открытые каналом: шаги чужой сессии не создают запись", async () => {
  const id = sessionId();
  assert.deepEqual(await turn(id, tokensAt(85), sender(), false), []);
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

test("после сжатия истории ниже 50 % подъём снова напоминает", async () => {
  const id = sessionId();
  assert.equal((await turn(id, tokensAt(94))).length, 1);
  assert.equal((await turn(id, tokensAt(28))).length, 0);
  assert.deepEqual(await turn(id, tokensAt(51)), [
    fill.contextFillHintText(51),
  ]);
});

test("карта не ограничена 256 сессий: самая давняя сессия остаётся", async () => {
  const first = sessionId();
  fill.openContextFill(first);
  for (let i = 0; i < 300; i++) fill.openContextFill(sessionId());
  assert.equal((await turn(first, tokensAt(60), sender(), false)).length, 1);
});

test(`пороги: каждый не больше раза за цикл заполнения, отмечены ровно достигнутые (seed ${SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          pct: fc.oneof(fc.integer({ min: 0, max: 100 }), fc.constant(null)),
          fail: fc.boolean(),
        }),
        { maxLength: 40 },
      ),
      async (steps) => {
        const id = sessionId();
        let shown = 0;
        // Цикл заполнения — от спада ниже 50 % до следующего: уровни, ушедшие в чат, и пик.
        let cycle = { fired: [] as number[], peak: 0 };
        const check = () => {
          assert.equal(new Set(cycle.fired).size, cycle.fired.length, "дважды");
          assert.ok(
            cycle.fired.every((l, i) => i === 0 || l > cycle.fired[i - 1]),
            "уровень в цикле откатился",
          );
          // Последним ушёл ровно уровень пика цикла.
          assert.equal(
            Math.max(0, ...cycle.fired),
            fill.contextFillLevel(cycle.peak),
            "отмечен ровно достигнутый уровень",
          );
        };
        for (const { pct, fail } of steps) {
          const send = sender(fail);
          await turn(id, pct === null ? null : tokensAt(pct), send);
          if (pct === null) {
            assert.deepEqual(send.lines, [], "неизвестно — ничего");
            continue;
          }
          if (pct < 50) {
            check();
            cycle = { fired: [], peak: 0 };
            shown = 0;
          }
          cycle.peak = Math.max(cycle.peak, pct);
          const level = fill.contextFillLevel(pct);
          const expected = level > shown && !fail;
          assert.deepEqual(
            send.lines,
            expected ? [fill.contextFillHintText(pct)] : [],
            `pct ${pct}, показан ${shown}`,
          );
          assert.ok(send.lines.length <= 1, "за ход не больше строки");
          assert.equal(fill.contextFillPercent(tokensAt(pct), WINDOW), pct);
          // Доставка хода забрана: повтор того же хода молчит.
          await fill.notifyContextFill(id, WINDOW, send.send);
          assert.equal(send.lines.length, expected ? 1 : 0, "повтор хода");
          if (level > shown && fail) {
            // Отказ уровень не тратит: следующий ход с тем же входом его показывает.
            const retry = sender();
            await turn(id, tokensAt(pct), retry);
            assert.deepEqual(retry.lines, [fill.contextFillHintText(pct)]);
          }
          if (level > shown) cycle.fired.push((shown = level));
        }
        check();
        const last = sender();
        await turn(id, tokensAt(100), last);
        assert.equal(
          last.lines.length,
          shown < 90 ? 1 : 0,
          "100 % после цикла",
        );
      },
    ),
    { seed: SEED, numRuns: 300 },
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
      await fill.notifyContextFill(id, WINDOW, send);
      assert.deepEqual(lines, [], `мусор ${String(inputTokens)} дал подсказку`);
      // Мусор — «неизвестно», а не ноль: пороги не взведены, 50 не звучит снова.
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
