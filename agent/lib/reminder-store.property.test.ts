/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Свойства таблицы напоминаний: главное из них — «разовая строка срабатывает ровно один раз»
// при любой последовательности тиков, включая задвоенные, запоздалые и ушедшие назад по
// часам. Якоря контракта — в reminder-store.test.ts.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import fc from "fast-check";
import type { Reminder } from "./reminder-store.ts";

const P1_SEED = 20260912;
const P2_SEED = 20260913;
const P3_SEED = 20260914;
const RUNS = { numRuns: 150 };

const root = mkdtempSync(join(tmpdir(), "iva-reminders-pbt-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });

const { add, fireDue, list, reminderFile, sweepFired, recordDelivery } =
  await import("./reminder-store.ts");
const { saveJsonAtomic } = await import("./json-store.ts");

let caseDir = "";
beforeEach(() => {
  caseDir = mkdtempSync(join(root, "case-"));
  process.env.ASSISTANT_DATA_DIR = caseDir;
});
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

function row(
  id: string,
  nextRunAtMs: number,
  over: Partial<Reminder> = {},
): Reminder {
  return {
    id,
    text: `напоминание ${id}`,
    chat: null,
    schedule: { kind: "at", atMs: nextRunAtMs },
    nextRunAtMs,
    createdAt: nextRunAtMs,
    status: "pending",
    firedAt: null,
    delivered: null,
    error: null,
    ...over,
  };
}

function seed(rows: Reminder[]): Promise<void> {
  return saveJsonAtomic(
    reminderFile(),
    { schemaVersion: 2, rows },
    { mode: 0o600 },
  );
}

function stored(): Reminder[] {
  return (
    JSON.parse(readFileSync(reminderFile(), "utf8")) as { rows: Reminder[] }
  ).rows;
}

test(`P1: разовая строка срабатывает ровно один раз при любых тиках (seed ${P1_SEED})`, async () => {
  const OFFSET = fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: -3, max: 3 }) },
    { weight: 1, arbitrary: fc.integer({ min: -1_000_000, max: 1_000_000 }) },
  );
  const TICKS = fc.array(fc.integer({ min: 0, max: 60_000 }), {
    minLength: 1,
    maxLength: 12,
  });

  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1_000_000, max: 2_000_000_000_000 }),
      fc.array(OFFSET, { minLength: 1, maxLength: 8 }),
      TICKS,
      async (now, offsets, tickOffsets) => {
        const rows = offsets.map((offset, index) =>
          row(
            `r${index}`,
            Math.max(0, now + offset),
            index % 2 === 0
              ? {}
              : // половина строк уже сработала ранее: срабатывание у них тоже одно
                { status: "fired" as const, firedAt: now - 1000 },
          ),
        );
        await seed(rows);

        const firedIds: string[] = [];
        const sortedTicks = [...tickOffsets].sort((a, b) => a - b);
        for (const offset of sortedTicks) {
          const claimed = await fireDue(now + offset, 10);
          firedIds.push(...claimed.map((r) => r.id));
          // Каждый тик либо берёт строку, либо нет; повторного взятия быть не может.
          assert.equal(
            new Set(claimed.map((r) => r.id)).size,
            claimed.length,
            "один тик взял строку дважды",
          );
          for (const fired of claimed) {
            assert.ok(
              fired.nextRunAtMs <= now + offset,
              "взята строка из будущего",
            );
          }
        }

        assert.equal(
          new Set(firedIds).size,
          firedIds.length,
          `строка сработала дважды: ${firedIds.join(", ")}`,
        );

        const after = stored();
        for (const before of rows) {
          const nowRow = after.find((r) => r.id === before.id);
          assert.ok(nowRow, `строка ${before.id} потеряна`);
          const firstTickAt = [
            now + tickOffsets[0],
            ...sortedTicks.map((o) => now + o),
          ]
            .filter((t) => t >= before.nextRunAtMs)
            .sort((a, b) => a - b)[0];
          if (before.status === "fired") {
            assert.equal(
              nowRow.firedAt,
              before.firedAt,
              "чужой firedAt переписан",
            );
            assert.equal(nowRow.status, "fired");
          } else if (firstTickAt !== undefined) {
            assert.equal(
              nowRow.status,
              "fired",
              "пора — а строка не сработала",
            );
            assert.equal(
              nowRow.firedAt,
              firstTickAt,
              "firedAt не первого срока",
            );
          } else {
            assert.equal(nowRow.status, "pending", "сработала раньше срока");
            assert.equal(nowRow.firedAt, null);
          }
        }
        return true;
      },
    ),
    { seed: P1_SEED, numRuns: 120 },
  );
});

test(`P2: повторяющаяся строка на каждом сроке уезжает строго вперёд (seed ${P2_SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 }),
      fc.integer({ min: 1, max: 6 }),
      async (now, fires) => {
        await seed([]);
        await add({
          id: "cron",
          text: "по утрам",
          schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
          nextRunAtMs: now,
        });

        let previous = now;
        for (let i = 0; i < fires; i++) {
          const claimed = await fireDue(previous, 10);
          assert.deepEqual(
            claimed.map((r) => r.id),
            ["cron"],
          );
          const [current] = await list();
          assert.equal(current.status, "pending");
          assert.equal(current.firedAt, previous);
          assert.ok(
            current.nextRunAtMs > previous,
            `срок не вырос: ${current.nextRunAtMs} <= ${previous}`,
          );
          // Пока срок в будущем, строка не берётся.
          assert.deepEqual(await fireDue(current.nextRunAtMs - 1, 10), []);
          await recordDelivery(current.id, {
            firedAt: current.firedAt,
            delivered: true,
            error: null,
          });
          previous = current.nextRunAtMs;
        }
        return true;
      },
    ),
    { seed: P2_SEED, numRuns: 60 },
  );
});

test(`P3: мусорные вызовы не портят таблицу (seed ${P3_SEED})`, async () => {
  const junk = fc.oneof(
    fc.integer({ min: -2_000_000_000, max: 2_000_000_000 }),
    fc.constant(Number.MAX_SAFE_INTEGER),
    fc.constant(-1),
    fc.constant(NaN),
  );
  await fc.assert(
    fc.asyncProperty(junk, async (value) => {
      await seed([row("a", 1_000_000), row("b", 2_000_000)]);

      const attempt = async (call: () => Promise<unknown>): Promise<void> => {
        let failed = false;
        try {
          await call();
        } catch (error) {
          failed = true;
          assert.ok(error instanceof Error, "отказ не был ошибкой");
          assert.ok(
            /must be|not found/u.test(error.message),
            `отказ без причины: ${error.message}`,
          );
        }
        // Файл после любого вызова остаётся валидной таблицей: писатель либо записал
        // целиком, либо не тронул её.
        const parsed: unknown = JSON.parse(
          readFileSync(reminderFile(), "utf8"),
        );
        assert.ok(
          typeof parsed === "object" && parsed !== null,
          "таблица сломана",
        );
        assert.equal(
          (parsed as { schemaVersion: number }).schemaVersion,
          2,
          "версия схемы потеряна",
        );
        assert.ok(
          Array.isArray((parsed as { rows: unknown[] }).rows),
          "нет rows",
        );
        void failed;
      };

      await attempt(() => fireDue(value, 10));
      await attempt(() => fireDue(1_000_000, value));
      await attempt(() => sweepFired(value));
      return true;
    }),
    { seed: P3_SEED, numRuns: RUNS.numRuns },
  );
});
