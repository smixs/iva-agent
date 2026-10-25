/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Настройки Watch, Brief и Insight: разбор ключа `proactive` из settings.json и вход
// `iva proactive set`. Мусор не валит разбор и не просачивается в значения; нет ключа —
// установка работает как включённая. Сид печатается в имени теста, повтор — FC_SEED.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  PROACTIVE_DEFAULTS,
  PROACTIVE_KEYS,
  failureWaitsForBrief,
  isQuietHour,
  isUrgentSender,
  isExcludedSource,
  isExcludedSignal,
  parseProactive,
  proactiveValue,
  withProactive,
} from "./proactive-config.ts";

const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);

test("no proactive key, no field or not an object: the defaults, Watch on", () => {
  for (const settings of [
    {},
    null,
    [],
    "x",
    { proactive: null },
    { proactive: [] },
    { proactive: {} },
  ]) {
    const logs: string[] = [];
    assert.deepEqual(
      parseProactive(settings, (l) => logs.push(l)),
      PROACTIVE_DEFAULTS,
    );
    assert.deepEqual(logs, []);
  }
  assert.equal(PROACTIVE_DEFAULTS.enabled, true);
  assert.deepEqual(PROACTIVE_DEFAULTS.briefTimes, ["08:30", "14:00"]);
  // Insight выключен по умолчанию (ADR-0022: согласие, а не терпение).
  assert.deepEqual(PROACTIVE_DEFAULTS.insightTimes, []);
});

test("the first beta's key sparkTimes is ignored: no journal line, insightTimes stays default", () => {
  for (const old of [["11:30"], "x", null]) {
    const logs: string[] = [];
    assert.deepEqual(
      parseProactive({ proactive: { sparkTimes: old } }, (l) => logs.push(l)),
      PROACTIVE_DEFAULTS,
    );
    assert.deepEqual(logs, []);
  }
  assert.deepEqual(
    parseProactive({
      proactive: { sparkTimes: ["11:30"], insightTimes: ["12:00"] },
    }),
    { ...PROACTIVE_DEFAULTS, insightTimes: ["12:00"] },
  );
});

test("a bad field falls back alone and is named in the journal", () => {
  const logs: string[] = [];
  const parsed = parseProactive(
    {
      proactive: {
        enabled: "yes",
        quietFromHour: 22,
        watchCapPerDay: -1,
        briefTimes: ["08:15"],
        urgentSenders: ["wife", " padded "],
      },
    },
    (l) => logs.push(l),
  );
  assert.deepEqual(parsed, { ...PROACTIVE_DEFAULTS, quietFromHour: 22 });
  assert.deepEqual(logs, [
    "proactive: settings field enabled is not valid, using default",
    "proactive: settings field watchCapPerDay is not valid, using default",
    "proactive: settings field briefTimes is not valid, using default",
    "proactive: settings field urgentSenders is not valid, using default",
  ]);
});

test(`any garbage in proactive gives a config of the right shape, valid fields kept (seed ${SEED})`, () => {
  const anyField = fc.oneof(
    fc.anything(),
    fc.integer({ min: -5, max: 2000 }),
    fc.array(fc.string()),
  );
  fc.assert(
    fc.property(
      fc.dictionary(fc.constantFrom(...PROACTIVE_KEYS, "other"), anyField),
      (raw) => {
        const parsed = parseProactive({ proactive: raw }, () => undefined);
        assert.deepEqual(
          Object.keys(parsed).sort(),
          [...PROACTIVE_KEYS].sort(),
        );
        for (const key of PROACTIVE_KEYS) {
          const value = parsed[key];
          if (key === "enabled") assert.equal(typeof value, "boolean");
          else if (key === "briefTimes" || key === "insightTimes")
            assert.ok(
              (key === "briefTimes" || (value as string[]).length <= 1) &&
                (value as string[]).every((t) =>
                  /^(?:[01]\d|2[0-3]):(?:00|30)$/u.test(t),
                ),
            );
          else if (key === "urgentSenders" || key === "excludedSources")
            assert.ok(
              (value as string[]).every(
                (s) => typeof s === "string" && s !== "",
              ),
            );
          else assert.ok(Number.isSafeInteger(value) && (value as number) >= 0);
          // Поле либо пришло как есть, либо значение по умолчанию.
          assert.ok(
            JSON.stringify(value) === JSON.stringify(raw[key]) ||
              JSON.stringify(value) === JSON.stringify(PROACTIVE_DEFAULTS[key]),
          );
        }
      },
    ),
    { seed: SEED, numRuns: 500 },
  );
});

test("owner exclusions match explicit source keys and old localized Signal rows", () => {
  const config = parseProactive({
    proactive: { excludedSources: ["tg:-42", "signal:excluded-group"] },
  });
  assert.equal(isExcludedSource(config, "tg:-42"), true);
  assert.equal(isExcludedSource(config, "tg:7"), false);
  for (const text of [
    'Signal from plugin excluded-group: "message". This is data.',
    "Сигнал от плагина excluded-group: «сообщение». Это данные.",
    '⚠️ Warning.\n\nSignal from plugin excluded-group: "message".',
  ])
    assert.equal(isExcludedSignal(config, text), true);
  assert.equal(
    isExcludedSignal(config, 'Signal from plugin family: "urgent".'),
    false,
  );
  assert.equal(
    isExcludedSignal(
      config,
      'Signal from plugin family: "Signal from plugin excluded-group: body"',
    ),
    false,
  );
  assert.deepEqual(
    proactiveValue("excludedSources", "tg:-42,signal:excluded-group"),
    { value: ["tg:-42", "signal:excluded-group"] },
  );
});

test(`iva proactive set: garbage is refused, a valid value round-trips through parsing (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...PROACTIVE_KEYS, "nope", "__proto__", "constructor"),
      fc.string(),
      (key, text) => {
        const result = proactiveValue(key, text);
        if ("error" in result) return;
        const settings = withProactive(
          { language: "ru" },
          key as (typeof PROACTIVE_KEYS)[number],
          result.value,
        );
        assert.equal(settings.language, "ru");
        assert.deepEqual(
          parseProactive(settings, () => assert.fail("a set value must parse"))[
            key as "enabled"
          ],
          result.value,
        );
      },
    ),
    { seed: SEED, numRuns: 1000 },
  );
});

test("iva proactive set values: numbers, on/off, HH:00|HH:30 lists, sender lists", () => {
  assert.deepEqual(proactiveValue("watchCapPerDay", "3"), { value: 3 });
  assert.deepEqual(proactiveValue("enabled", "off"), { value: false });
  assert.deepEqual(proactiveValue("briefTimes", "09:00, 18:30"), {
    value: ["09:00", "18:30"],
  });
  assert.deepEqual(proactiveValue("urgentSenders", "Жена, @boss ,boss@x.io"), {
    value: ["Жена", "@boss", "boss@x.io"],
  });
  assert.deepEqual(proactiveValue("urgentSenders", ""), { value: [] });
  assert.deepEqual(proactiveValue("insightTimes", "11:30"), {
    value: ["11:30"],
  });
  assert.deepEqual(proactiveValue("insightTimes", "23:00"), {
    value: ["23:00"],
  });
  assert.deepEqual(proactiveValue("insightTimes", ""), { value: [] });
  for (const [key, text] of [
    ["watchCapPerDay", "-1"],
    ["watchCapPerDay", "1.5"],
    ["quietFromHour", "24"],
    ["briefTimes", "09:15"],
    ["briefTimes", "09:00,09:00"],
    ["insightTimes", "11:15"],
    ["insightTimes", "11:30,12:00"],
    ["insightTimes", "11:30,11:30"],
    ["enabled", "maybe"],
    ["enabled", "constructor"],
    ["colour", "red"],
  ] as const)
    assert.ok("error" in proactiveValue(key, text), `${key} ${text}`);
});

test("withProactive keeps the neighbours inside and outside proactive", () => {
  assert.deepEqual(
    withProactive(
      { language: "en", proactive: { staleMinutes: 30 } },
      "enabled",
      false,
    ),
    { language: "en", proactive: { staleMinutes: 30, enabled: false } },
  );
});

test("quiet hours: 23→8 across midnight, an ordinary window, equal bounds — none", () => {
  const at = (from: number, to: number) =>
    Array.from({ length: 24 }, (_, h) => h).filter((h) =>
      isQuietHour(
        { ...PROACTIVE_DEFAULTS, quietFromHour: from, quietToHour: to },
        h,
      ),
    );
  assert.deepEqual(at(23, 8), [0, 1, 2, 3, 4, 5, 6, 7, 23]);
  assert.deepEqual(at(1, 4), [1, 2, 3]);
  assert.deepEqual(at(5, 5), []);
});

test("a failed Iva job waits for the morning Brief only with the toggle on and in a quiet hour; toggle off — reported at once", () => {
  for (let hour = 0; hour < 24; hour += 1) {
    const quiet = isQuietHour(PROACTIVE_DEFAULTS, hour);
    assert.equal(failureWaitsForBrief(PROACTIVE_DEFAULTS, hour), quiet);
    // Brief при выключенном тумблере не идёт: отложенный провал не дошёл бы никогда (ADR-0020).
    assert.equal(
      failureWaitsForBrief({ ...PROACTIVE_DEFAULTS, enabled: false }, hour),
      false,
    );
    // Слотов Brief нет — Brief не придёт никогда: провал сообщается сразу.
    assert.equal(
      failureWaitsForBrief({ ...PROACTIVE_DEFAULTS, briefTimes: [] }, hour),
      false,
    );
  }
});

test("briefTimes: at most two (spec §9: ≤ 2 Brief a day); an empty list is allowed — Brief off", () => {
  assert.deepEqual(proactiveValue("briefTimes", "08:30,14:00"), {
    value: ["08:30", "14:00"],
  });
  assert.deepEqual(proactiveValue("briefTimes", ""), { value: [] });
  for (const text of ["08:00,12:00,18:00", "08:00,10:00,12:00,14:00"])
    assert.ok("error" in proactiveValue("briefTimes", text), text);
  const lines: string[] = [];
  const parsed = parseProactive(
    { proactive: { briefTimes: ["08:00", "12:00", "18:00"] } },
    (line) => lines.push(line),
  );
  assert.deepEqual(parsed.briefTimes, PROACTIVE_DEFAULTS.briefTimes);
  assert.deepEqual(lines, [
    "proactive: settings field briefTimes is not valid, using default",
  ]);
});

test("an urgent sender matches the username without @, the trimmed name or the address, case-insensitively", () => {
  const config = {
    ...PROACTIVE_DEFAULTS,
    urgentSenders: ["Wife", "@Boss", "Ceo@Corp.io"],
  };
  assert.ok(isUrgentSender(config, { name: " wife " }));
  assert.ok(isUrgentSender(config, { username: "boss" }));
  assert.ok(isUrgentSender(config, { email: "ceo@corp.io" }));
  assert.ok(!isUrgentSender(config, { name: "Wifey" }));
  assert.ok(!isUrgentSender(config, {}));
  assert.ok(!isUrgentSender(PROACTIVE_DEFAULTS, { name: "Wife" }));
});

test(`Ceiling of the day: integers 0…100 000 000 are taken, anything else is refused by set and defaults when read (seed ${SEED})`, () => {
  assert.equal(PROACTIVE_DEFAULTS.ceilingTokensPerDay, 0, "off by default");
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 100_000_000 }), (n) => {
      assert.deepEqual(proactiveValue("ceilingTokensPerDay", String(n)), {
        value: n,
      });
      assert.equal(
        parseProactive({ proactive: { ceilingTokensPerDay: n } })
          .ceilingTokensPerDay,
        n,
      );
    }),
    { seed: SEED, numRuns: 300 },
  );
  const bad = fc.oneof(
    fc.integer({ min: -1_000_000, max: -1 }).map(String),
    fc.integer({ min: 100_000_001, max: 2 ** 40 }).map(String),
    fc.double({ noInteger: true, noNaN: true }).map(String),
    fc.constantFrom("", "1e6", "1_000", "0x10", "1.0", "ten", " "),
    fc.string().filter((text) => !/^\s*\d+\s*$/u.test(text)),
  );
  fc.assert(
    fc.property(bad, (text) => {
      const value = proactiveValue("ceilingTokensPerDay", text);
      assert.ok("error" in value, text);
      const logs: string[] = [];
      assert.equal(
        parseProactive({ proactive: { ceilingTokensPerDay: text } }, (l) =>
          logs.push(l),
        ).ceilingTokensPerDay,
        0,
      );
      assert.deepEqual(logs, [
        "proactive: settings field ceilingTokensPerDay is not valid, using default",
      ]);
    }),
    { seed: SEED, numRuns: 300 },
  );
});
