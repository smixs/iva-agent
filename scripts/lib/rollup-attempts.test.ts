// Попытки дня: «три наблюдённых отказа» и файл попыток. Свойство: при провале fast-check
// печатает `{ seed, path }` — подставь вторым аргументом fc.assert.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import {
  addAttempt,
  clearDay,
  dayPausedAlert,
  isExhausted,
  MAX_FAILED_ATTEMPTS,
  readAttempts,
  type AttemptReason,
} from "./rollup-attempts.ts";

const SEED = 20260926;
const reason = fc.constantFrom<AttemptReason>("no-report", "day-unfinished");
const at = fc
  .integer({ min: Date.parse("2026-01-01"), max: Date.parse("2027-01-01") })
  .map((ms) => new Date(ms).toISOString());

void test(`a day waits for the owner after three observed failures, however long ago (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.array(fc.record({ at, reason }), { maxLength: 8 }),
      fc.array(at, { maxLength: 8 }),
      (list, cutsAt) => {
        assert.equal(isExhausted(list), list.length >= MAX_FAILED_ATTEMPTS);
        const cuts = cutsAt.map((at) => ({ at, reason: "cut" as const }));
        assert.equal(
          isExhausted([...cuts, ...list, ...cuts]),
          list.length >= MAX_FAILED_ATTEMPTS,
          "legacy ceiling cuts preserve the remaining day attempts",
        );
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
  assert.equal(MAX_FAILED_ATTEMPTS, 3);
  assert.equal(isExhausted(undefined), false);
  assert.equal(
    isExhausted(
      Array(3).fill({ at: "2026-09-26T01:00:00.000Z", reason: "cut" }),
    ),
    false,
  );
});

void test("attempts add up per day with their cause, a cleared day leaves the others, a damaged file is an error", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-rollup-attempts-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const file = join(dir, "rollup-attempts.json");
  assert.deepEqual(readAttempts(file), {});
  const legacy = {
    "2026-09-24": [{ at: "2026-09-26T01:00:00.000Z", reason: "cut" }],
  };
  writeFileSync(file, JSON.stringify(legacy));
  assert.deepEqual(readAttempts(file), legacy);
  addAttempt(file, "2026-09-24", "no-report", "2026-09-26T02:00:00.000Z");
  addAttempt(file, "2026-09-23", "day-unfinished", "2026-09-26T02:00:00.000Z");
  clearDay(file, "2026-09-23");
  clearDay(file, "2026-09-01");
  assert.deepEqual(readAttempts(file), {
    "2026-09-24": [
      { at: "2026-09-26T01:00:00.000Z", reason: "cut" },
      { at: "2026-09-26T02:00:00.000Z", reason: "no-report" },
    ],
  });
  for (const damaged of [
    "[]",
    "{not json",
    '{"d":["2026-09-26T01:00:00.000Z"]}',
    '{"d":[{"at":"x","reason":"cut"}]}',
    '{"d":[{"at":"2026-09-26T01:00:00.000Z","reason":"crash"}]}',
  ]) {
    writeFileSync(file, damaged);
    assert.throws(
      () => readAttempts(file),
      /is not a rollup attempts map/u,
      damaged,
    );
  }
});

void test("the paused-day alert names the last cause and the command that closes each day", () => {
  const ru = (_en: string, russian: string): string => russian;
  const text = dayPausedAlert(ru, ["2026-09-23", "2026-09-24"], {
    "2026-09-23": [
      { at: "2026-09-24T04:00:00.000Z", reason: "no-report" },
      { at: "2026-09-25T04:00:00.000Z", reason: "cut" },
    ],
    "2026-09-24": [
      { at: "2026-09-25T04:00:00.000Z", reason: "day-unfinished" },
    ],
  });
  assert.match(text, /не разобрались 3 раза подряд/u);
  assert.match(
    text,
    /2026-09-23: ход кончился без отчёта\niva jobs skip memory-night 2026-09-23/u,
  );
  assert.match(
    text,
    /2026-09-24: отчёт пришёл, а день не закрыт\niva jobs skip memory-night 2026-09-24/u,
  );
  assert.doesNotMatch(text, /пределом ночи/u);
});
