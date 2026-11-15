import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { validateTimeZone as validateAuthored } from "@iva/timezone";
import {
  systemTimeZoneName,
  validateTimeZone,
} from "../../packages/timezone/index.ts";

// Оба дерева соблюдают один контракт: authored tree проверяет зону на старте сервера,
// scripts/ — когда Doctor пишет юниты без каталога agent/. Пакет один; сверяются два пути
// к нему — имя пакета (инструкции authored tree) и относительный путь (все остальные).
const CASES: readonly [unknown, string | null][] = [
  [" Asia/Tashkent ", "Asia/Tashkent"],
  ["Mars/Olympus", null],
  [undefined, null],
  ["", null],
  ["   ", null],
  ["UTC", "UTC"],
  // Регистр `Intl` прощает, systemd — нет: `OnCalendar=*-*-* 05:00:00 europe/moscow`
  // не поднимает таймер. Наружу поэтому уходит канон, а не то, что ввёл пользователь.
  ["europe/moscow", "Europe/Moscow"],
  ["Europe/Moscow", "Europe/Moscow"],
  // Бэкслеш не разделитель зоны ни для кого: такой ввод остаётся отказом.
  ["europe\\moscow", null],
];

// Канонические зоны текущей ICU: вход из этого списка обязан вернуться собой.
const ZONES = Intl.supportedValuesOf("timeZone");

const PADDING = fc.constantFrom("", " ", "  ", "\t", "\n", " ", " ");

void test("authored and operational validators agree for arbitrary input (seed 190000)", () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.jsonValue()), (input) => {
      assert.equal(validateAuthored(input), validateTimeZone(input));
    }),
    { seed: 190_000, numRuns: 1_000 },
  );
});

for (const [input, expected] of CASES) {
  void test(`timezone validation agrees on ${JSON.stringify(input)}`, () => {
    assert.equal(validateTimeZone(input), expected);
    assert.equal(validateAuthored(input), expected);
  });
}

void test("validation is idempotent for every input", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.string(), fc.string({ unit: "binary" })),
      (input) => {
        const once = validateTimeZone(input);
        assert.equal(validateTimeZone(once), once);
      },
    ),
    { seed: 190_001, numRuns: 1_000 },
  );
});

void test("case and padding never move a canonical zone", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...ZONES),
      fc.constantFrom<(value: string) => string>(
        (value) => value,
        (value) => value.toUpperCase(),
        (value) => value.toLowerCase(),
      ),
      PADDING,
      PADDING,
      (zone, vary, before, after) => {
        assert.equal(validateTimeZone(`${before}${vary(zone)}${after}`), zone);
      },
    ),
    { seed: 190_002, numRuns: 2_000 },
  );
});

void test("arbitrary input yields a zone Intl accepts, or nothing", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.string(), fc.string({ unit: "binary" })),
      (input) => {
        const zone = validateTimeZone(input);
        if (zone === null) return;
        // Канон стабилен и годится для systemd, TZ= и любого потребителя Intl.
        assert.equal(zone, zone.trim());
        assert.equal(validateTimeZone(zone), zone);
        assert.doesNotThrow(() =>
          new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0),
        );
      },
    ),
    { seed: 190_003, numRuns: 1_000 },
  );
});

void test("the system name of a zone is a zone Intl accepts and a second pass changes nothing", () => {
  fc.assert(
    fc.property(fc.constantFrom(...ZONES), (zone) => {
      const name = systemTimeZoneName(zone);
      assert.equal(systemTimeZoneName(name), name);
      assert.notEqual(validateTimeZone(name), null);
      // Only the legacy spelling moves: Intl takes the new one back to the same zone.
      if (name !== zone) assert.equal(validateTimeZone(name), zone);
    }),
    { seed: 190_004, numRuns: 500 },
  );
  assert.equal(systemTimeZoneName("Europe/Kiev"), "Europe/Kyiv");
  assert.equal(systemTimeZoneName("Asia/Tashkent"), "Asia/Tashkent");
});

void test("the system name follows the zone files the host has, the table is only the fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-zoneinfo-"));
  try {
    const put = (name: string) => {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), "TZif2");
    };
    const kiev = { zoneinfoDir: dir, configured: "Europe/Kiev" };
    // Neither spelling exists: the table.
    assert.equal(systemTimeZoneName("Europe/Kiev", kiev), "Europe/Kyiv");
    put("Europe/Kiev");
    assert.equal(systemTimeZoneName("Europe/Kiev", kiev), "Europe/Kiev");
    // Without the owner's spelling the modern name still wins when present.
    put("Europe/Kyiv");
    assert.equal(
      systemTimeZoneName("Europe/Kiev", { zoneinfoDir: dir }),
      "Europe/Kyiv",
    );
    assert.equal(systemTimeZoneName("Europe/Kiev", kiev), "Europe/Kiev");
    // A traversal-shaped spelling is never looked up, even if the file exists.
    writeFileSync(join(dir, "..", `${basename(dir)}-evil`), "x");
    for (const configured of [`../${basename(dir)}-evil`, "/etc/passwd", ""])
      assert.equal(
        systemTimeZoneName("Europe/Kiev", { zoneinfoDir: dir, configured }),
        "Europe/Kyiv",
      );
    // A missing directory falls back to the table.
    assert.equal(
      systemTimeZoneName("Europe/Kiev", {
        zoneinfoDir: join(dir, "nope"),
        configured: "Europe/Kiev",
      }),
      "Europe/Kyiv",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-evil`, { force: true });
  }
});
