/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Brief на шве runProactiveTick (спека проактивности, T2): слоты в зоне владельца, заявка
// briefDone до хода, «Утро: новых дел нет» для утреннего слота, окно 3 часа. По строке таблицы
// отказов на тест; в конце PBT на последовательностях тиков со сдвигом 0–90 с, пропусками,
// отказами записи и хода (сид в имени теста, повтор — FC_SEED=<сид>).
import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import fc from "fast-check";

const ROOT = mkdtempSync(join(tmpdir(), "iva-proactive-brief-"));
process.env.ASSISTANT_DATA_DIR = join(ROOT, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { PROACTIVE_DEFAULTS } = await import("#lib/proactive-config.ts");
const { dueBrief, runProactiveTick } = await import("./tick.ts");
const { writeProactiveState } = await import("./state.ts");
import type { ProactiveConfig } from "#lib/proactive-config.ts";
import type { ReminderTurn } from "../lib/reminder-turn.ts";
import type { WatchItem } from "./precheck.ts";
import type { ProactiveState } from "./state.ts";
import type { TickDeps } from "./tick.ts";

const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Зона владельца UTC+5 без перехода на летнее время: 08:30 у него — 03:30 UTC. */
const ZONE = "Asia/Tashkent";
/** 2026-10-05 00:00 по зоне владельца. */
const MIDNIGHT = Date.UTC(2026, 9, 4, 19, 0);
const at = (hh: number, mm = 0) => MIDNIGHT + hh * HOUR + mm * MIN;
const DAY = "2026-10-05";

for (const english of [false, true])
  test(`empty-response turn.failed gives a readable Brief failure, English=${english}`, async () => {
    const { reminderFromEvents } =
      await import("../fixtures/reminder-events.test-fixture.ts");
    const h = harness();
    h.english = english;
    h.reply = await reminderFromEvents([
      {
        type: "turn.failed",
        data: {
          message: "The model did not return a response",
          details: { semanticErrorId: "empty-model-response" },
        },
      },
      { type: "session.waiting" },
    ]);
    assert.equal(await runProactiveTick(at(8, 30), h.deps), 1);
    assert.deepEqual(h.sent, [
      {
        source: "brief",
        part: english
          ? "The model gave no response. The review was not prepared; I'll try next time."
          : "Модель не дала ответа — обзор не собран, попробую в следующий раз.",
      },
    ]);
    assert.ok(h.logs.some((l) => l.includes("brief turn failed:")));
  });

type Sent = { readonly part: string; readonly source: string };

type Harness = {
  readonly deps: TickDeps;
  readonly statePath: string;
  readonly prompts: string[];
  readonly sent: Sent[];
  readonly logs: string[];
  reply: ReminderTurn | Error;
  config: ProactiveConfig;
  english: boolean;
  items: WatchItem[];
};

function turn(
  message: string | undefined,
  status: ReminderTurn["status"] = "completed",
): ReminderTurn {
  return {
    status,
    ...(message === undefined ? {} : { message }),
    feedback: () => Promise.resolve(),
  };
}

function harness(overrides: Partial<TickDeps> = {}): Harness {
  const dir = mkdtempSync(join(ROOT, "run-"));
  const h: Harness = {
    statePath: join(dir, "proactive.json"),
    prompts: [],
    sent: [],
    logs: [],
    reply: turn("Доброе утро."),
    config: PROACTIVE_DEFAULTS,
    english: false,
    items: [],
    deps: undefined as unknown as TickDeps,
  };
  (h as { deps: TickDeps }).deps = {
    config: () => h.config,
    timeZone: ZONE,
    statePath: h.statePath,
    sources: [
      {
        name: "telegram",
        prefix: "tg:",
        check: () => Promise.resolve({ items: h.items, error: null }),
      },
    ],
    runTurn: (prompt) => {
      h.prompts.push(prompt);
      return h.reply instanceof Error
        ? Promise.reject(h.reply)
        : Promise.resolve(h.reply);
    },
    send: (part, source) => {
      h.sent.push({ part, source });
      return Promise.resolve({ ok: true, error: "" });
    },
    translate: () =>
      Promise.resolve((english: string, russian: string) =>
        h.english ? english : russian,
      ),
    log: (line) => h.logs.push(line),
    ...overrides,
  };
  return h;
}

const readState = (h: Harness) =>
  JSON.parse(readFileSync(h.statePath, "utf8")) as ProactiveState;

/** Состояние «прогоны уже были»: первый прогон смотрит источники и на :30. */
async function seed(h: Harness, patch: Partial<ProactiveState> = {}) {
  const { initialState } = await import("./state.ts");
  await writeProactiveState(h.statePath, {
    ...initialState(at(0)),
    ...patch,
  });
}

const briefPrompts = (h: Harness) =>
  h.prompts.filter((p) => p.startsWith("Brief:"));

test("08:30 in the owner's zone: the morning Brief, QUIET forbidden, parts go out one by one", async () => {
  const h = harness();
  await seed(h);
  h.reply = turn("Обзор дня.\n<!-- iva:next -->\nОтветь Ивану до 12:00.");
  assert.equal(await runProactiveTick(at(8, 30), h.deps), 0);
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0] ?? "", /^Brief: slot 0 .*Follow the brief skill/u);
  assert.match(h.prompts[0] ?? "", /QUIET is not allowed/u);
  assert.match(h.prompts[0] ?? "", /written in Russian/u);
  assert.match(h.prompts[0] ?? "", /^Previous Brief: yesterday 14:00\.$/mu);
  assert.deepEqual(h.sent, [
    { part: "Обзор дня.", source: "brief" },
    { part: "Ответь Ивану до 12:00.", source: "brief" },
  ]);
  assert.deepEqual(readState(h).briefDone, { day: DAY, slots: [0] });
  // Brief не ход Watch: пределы Watch он не тратит.
  assert.deepEqual(readState(h).modelWakes, { day: "", count: 0 });
  assert.deepEqual(readState(h).wakes, { day: "", count: 0 });
});

test("the morning slot returns QUIET, nothing or only separators: the code sends «Утро: новых дел нет» and a journal line", async () => {
  for (const reply of [
    "QUIET",
    " QUIET \n",
    "",
    undefined,
    "<!-- iva:next -->",
  ]) {
    const h = harness();
    await seed(h);
    h.reply = turn(reply);
    assert.equal(await runProactiveTick(at(8, 30), h.deps), 0);
    assert.deepEqual(h.sent, [
      { part: "Утро: новых дел нет", source: "brief" },
    ]);
    assert.ok(
      h.logs.includes(
        "proactive: morning brief was empty, sent the nothing-new line",
      ),
    );
  }
  const english = harness();
  await seed(english);
  english.english = true;
  english.reply = turn("QUIET");
  await runProactiveTick(at(8, 30), english.deps);
  assert.deepEqual(english.sent, [
    { part: "Morning: nothing new", source: "brief" },
  ]);
  // Слот 0 — в любое время суток: владелец перенёс утренний Brief на вечер.
  const evening = harness();
  await seed(evening);
  evening.config = { ...PROACTIVE_DEFAULTS, briefTimes: ["21:00"] };
  evening.reply = turn("QUIET");
  await runProactiveTick(at(21), evening.deps);
  assert.deepEqual(evening.sent, [
    { part: "Утро: новых дел нет", source: "brief" },
  ]);
});

test("14:00: QUIET allowed and sends nothing; a text goes out", async () => {
  const h = harness();
  await seed(h, { briefDone: { day: DAY, slots: [0] } });
  h.reply = turn("QUIET");
  assert.equal(await runProactiveTick(at(14), h.deps), 0);
  assert.match(h.prompts[0] ?? "", /^Brief: slot 1 /u);
  assert.match(h.prompts[0] ?? "", /Return QUIET if there is nothing/u);
  assert.match(h.prompts[0] ?? "", /^Previous Brief: today 08:30\.$/mu);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(readState(h).briefDone, { day: DAY, slots: [0, 1] });

  const said = harness();
  await seed(said, { briefDone: { day: DAY, slots: [0] } });
  said.reply = turn("Встреча в 15:00 перенесена.");
  await runProactiveTick(at(14), said.deps);
  assert.deepEqual(said.sent, [
    { part: "Встреча в 15:00 перенесена.", source: "brief" },
  ]);
});

test("Brief uses configured previous slots and falls back to daily when no earlier claim exists", async () => {
  const morning = harness();
  morning.config = { ...PROACTIVE_DEFAULTS, briefTimes: ["09:00", "17:30"] };
  await seed(morning);
  await runProactiveTick(at(9), morning.deps);
  assert.match(
    briefPrompts(morning)[0] ?? "",
    /^Previous Brief: yesterday 17:30\.$/mu,
  );

  const later = harness();
  later.config = {
    ...PROACTIVE_DEFAULTS,
    briefTimes: ["09:00", "17:30"],
  };
  await seed(later, { briefDone: { day: DAY, slots: [0] } });
  await runProactiveTick(at(17, 30), later.deps);
  assert.match(
    briefPrompts(later)[0] ?? "",
    /^Previous Brief: today 09:00\.$/mu,
  );

  const missing = harness();
  await seed(missing, { briefDone: { day: "2026-10-04", slots: [0] } });
  await runProactiveTick(at(14), missing.deps);
  assert.doesNotMatch(briefPrompts(missing)[0] ?? "", /Previous Brief:/u);
});

test("briefDone claim: two runs of one slot give one Brief; the next day the slot is new again", async () => {
  const h = harness();
  await seed(h);
  assert.equal(await runProactiveTick(at(8, 30), h.deps), 0);
  assert.equal(await runProactiveTick(at(8, 31), h.deps), 0);
  assert.equal(await runProactiveTick(at(9), h.deps), 0);
  assert.equal(briefPrompts(h).length, 1);
  assert.equal(await runProactiveTick(at(24 + 8, 30), h.deps), 0);
  assert.equal(briefPrompts(h).length, 2);
  assert.deepEqual(readState(h).briefDone, {
    day: "2026-10-06",
    slots: [0],
  });
});

test("the Brief turn fails: no Brief for the slot, Watch still runs, the run ends with an error", async () => {
  const h = harness();
  await seed(h, {
    seen: { "tg:1": { firstSeenMs: at(7), unread: 1, reported: false } },
  });
  h.config = { ...PROACTIVE_DEFAULTS, briefTimes: ["09:00"] };
  h.items = [{ key: "tg:1", unread: 1, from: { name: "Иван" } }];
  let calls = 0;
  Object.assign(h.deps, {
    runTurn: (prompt: string) => {
      h.prompts.push(prompt);
      calls++;
      return calls === 1
        ? Promise.reject(new Error("provider unreachable"))
        : Promise.resolve(turn("Иван ждёт ответа."));
    },
  });
  assert.equal(await runProactiveTick(at(9), h.deps), 1);
  assert.equal(h.prompts.length, 2);
  assert.match(h.prompts[1] ?? "", /^Watch:/u);
  assert.deepEqual(h.sent, [{ part: "Иван ждёт ответа.", source: "watch" }]);
  assert.ok(
    h.logs.some(
      (l) => l === "proactive: brief turn failed: provider unreachable",
    ),
  );
  // Заявка стояла до хода: следующий тик Brief этого слота не повторяет.
  assert.deepEqual(readState(h).briefDone, { day: DAY, slots: [0] });
  assert.equal(await runProactiveTick(at(9, 30), h.deps), 0);
  assert.equal(briefPrompts(h).length, 1);

  // Лимит сессии и отмена — тоже провал хода.
  for (const reply of [
    { ...turn("limit"), status: "failed" as const, sessionLimit: true },
    { ...turn(undefined), cancelled: true },
  ]) {
    const other = harness();
    await seed(other);
    other.reply = reply;
    assert.equal(await runProactiveTick(at(8, 30), other.deps), 1);
    assert.deepEqual(other.sent, []);
  }
});

test("Telegram refuses every part of the Brief: the run ends with exit 1 (a failure fact, as the digest in 0.4.11); one part reaching is not an error", async () => {
  const h = harness({
    send: (part, source) => {
      h.sent.push({ part, source });
      return Promise.resolve({ ok: false, error: "Telegram 502" });
    },
  });
  await seed(h);
  assert.equal(await runProactiveTick(at(8, 30), h.deps), 1);
  assert.ok(h.logs.some((l) => l.includes("Telegram 502")));

  let calls = 0;
  const partial = harness({
    send: (part, source) => {
      partial.sent.push({ part, source });
      calls++;
      return Promise.resolve(
        calls === 1
          ? { ok: false, error: "Telegram 502" }
          : { ok: true, error: "" },
      );
    },
  });
  await seed(partial);
  partial.reply = turn("Обзор.\n<!-- iva:next -->\nСчёт ждёт оплаты.");
  assert.equal(await runProactiveTick(at(8, 30), partial.deps), 0);

  // QUIET днём — нечего слать, это не провал.
  const quiet = harness();
  await seed(quiet);
  quiet.reply = turn("QUIET");
  assert.equal(await runProactiveTick(at(14), quiet.deps), 0);
});

test("the briefDone claim write fails: no Brief turn, Watch still runs, the run ends with an error, the next tick repeats", async () => {
  let writes = 0;
  const h = harness({
    writeState: async (path, state) => {
      writes++;
      if (writes === 1) throw new Error("ENOSPC: no space left on device");
      await writeProactiveState(path, state);
    },
  });
  await seed(h);
  h.config = { ...PROACTIVE_DEFAULTS, briefTimes: ["09:00"] };
  assert.equal(await runProactiveTick(at(9), h.deps), 1);
  assert.deepEqual(briefPrompts(h), []);
  assert.ok(h.logs.some((l) => /brief claim not recorded: ENOSPC/u.test(l)));
  assert.ok(h.logs.includes("proactive: nothing new, model not woken"));
  assert.equal(await runProactiveTick(at(9, 30), h.deps), 0);
  assert.equal(briefPrompts(h).length, 1);
});

test("late by more than 3 hours: the slot is skipped; exactly 3 hours still counts", async () => {
  const late = harness();
  await seed(late);
  assert.equal(await runProactiveTick(at(11, 31), late.deps), 0);
  assert.deepEqual(late.prompts, []);
  assert.deepEqual(readState(late).briefDone, { day: "", slots: [] });

  const edge = harness();
  await seed(edge);
  assert.equal(await runProactiveTick(at(11, 30), edge.deps), 0);
  assert.equal(briefPrompts(edge).length, 1);
  // До своего времени слот не наступает.
  const early = harness();
  await seed(early);
  await runProactiveTick(at(8, 29), early.deps);
  assert.deepEqual(early.prompts, []);
});

test("several slots due at once: one Brief for the latest, the earlier ones are marked without a turn", async () => {
  const h = harness();
  await seed(h);
  h.config = { ...PROACTIVE_DEFAULTS, briefTimes: ["09:00", "08:30"] };
  assert.equal(await runProactiveTick(at(9), h.deps), 0);
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0] ?? "", /^Brief: slot 0 /u);
  assert.deepEqual(readState(h).briefDone, { day: DAY, slots: [0, 1] });
  assert.equal(await runProactiveTick(at(9, 30), h.deps), 0);
  assert.equal(h.prompts.length, 1);
});

test("«Сама пишет» off: no Brief; quiet hours and the Watch caps do not hold a Brief back", async () => {
  const off = harness();
  await seed(off);
  off.config = { ...PROACTIVE_DEFAULTS, enabled: false };
  assert.equal(await runProactiveTick(at(8, 30), off.deps), 0);
  assert.deepEqual(off.prompts, []);

  const night = harness();
  await seed(night, {
    wakes: { day: DAY, count: 99 },
    modelWakes: { day: DAY, count: 99 },
  });
  night.config = { ...PROACTIVE_DEFAULTS, briefTimes: ["23:30"] };
  assert.equal(await runProactiveTick(at(23, 30), night.deps), 0);
  assert.equal(briefPrompts(night).length, 1);
});

test("the very first run at :30 still marks everything unread as reported", async () => {
  const h = harness();
  h.config = { ...PROACTIVE_DEFAULTS, briefTimes: [] };
  h.items = [{ key: "tg:1", unread: 2, from: { name: "Иван" } }];
  assert.equal(await runProactiveTick(at(10, 30), h.deps), 0);
  assert.equal(readState(h).seen["tg:1"]?.reported, true);
  // Дальше :30 — не тик Watch.
  h.items = [{ key: "tg:1", unread: 5, from: { name: "Иван" } }];
  await runProactiveTick(at(11, 30), h.deps);
  assert.equal(readState(h).seen["tg:1"]?.unread, 2);
});

test("dueBrief: the window is [time, time + 3 h] of the owner's day", () => {
  const times = ["08:30", "14:00"];
  assert.equal(dueBrief(times, [], { hour: 8, minute: 29 }), null);
  assert.deepEqual(dueBrief(times, [], { hour: 8, minute: 30 }), {
    due: [0],
    slot: 0,
  });
  assert.deepEqual(dueBrief(times, [], { hour: 11, minute: 30 }), {
    due: [0],
    slot: 0,
  });
  assert.equal(dueBrief(times, [], { hour: 11, minute: 31 }), null);
  assert.equal(dueBrief(times, [0], { hour: 9, minute: 0 }), null);
  assert.deepEqual(dueBrief(["08:30", "10:00"], [0], { hour: 10, minute: 1 }), {
    due: [0, 1],
    slot: 1,
  });
});

// ── PBT ────────────────────────────────────────────────────────────────────────────────

type Tick = {
  readonly skip: boolean;
  readonly jitterMs: number;
  readonly claimFails: boolean;
  readonly reply: "text" | "quiet" | "fail";
};

const tick: fc.Arbitrary<Tick> = fc.record({
  skip: fc.boolean(),
  jitterMs: fc.integer({ min: 0, max: 90_000 }),
  claimFails: fc.boolean(),
  reply: fc.constantFrom("text" as const, "quiet" as const, "fail" as const),
});

const HALF_HOURS = Array.from(
  { length: 48 },
  (_, i) =>
    `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 === 0 ? "00" : "30"}`,
);

const briefTimes = fc.uniqueArray(fc.constantFrom(...HALF_HOURS), {
  minLength: 1,
  maxLength: 2,
});

const minuteOf = (time: string) =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

test(`Brief: one per slot on any sequence of late, skipped and failing ticks (seed ${SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(
      briefTimes,
      fc.array(tick, { minLength: 96, maxLength: 96 }),
      fc.boolean(),
      async (times, ticks, faultless) => {
        const turns: Array<{ day: number; slot: number; minute: number }> = [];
        const sends: Array<{ day: number; slot: number }> = [];
        let current: { day: number; slot: number } | null = null;
        let failNextWrite = false;
        const statePath = join(mkdtempSync(join(ROOT, "pbt-")), "p.json");
        const deps = (t: Tick, day: number, minute: number): TickDeps => ({
          config: () => ({ ...PROACTIVE_DEFAULTS, briefTimes: times }),
          timeZone: ZONE,
          statePath,
          sources: [],
          writeState: async (path, state) => {
            if (failNextWrite) {
              failNextWrite = false;
              throw new Error("EIO");
            }
            await writeProactiveState(path, state);
          },
          runTurn: (prompt) => {
            const slot = Number(/^Brief: slot (\d+) /u.exec(prompt)?.[1]);
            current = { day, slot };
            turns.push({ day, slot, minute });
            return Promise.resolve(
              t.reply === "fail"
                ? turn("boom", "failed")
                : turn(t.reply === "quiet" ? "QUIET" : "Обзор."),
            );
          },
          send: (_part, source) => {
            assert.equal(source, "brief");
            if (current) sends.push(current);
            return Promise.resolve({ ok: true, error: "" });
          },
          translate: () =>
            Promise.resolve((_english: string, russian: string) => russian),
          log: () => undefined,
        });
        for (const [i, t] of ticks.entries()) {
          const day = Math.floor(i / 48);
          const tickMinute = (i % 48) * 30;
          if (!faultless && t.skip) continue;
          current = null;
          failNextWrite = !faultless && t.claimFails;
          const now =
            Math.floor((MIDNIGHT + i * 30 * MIN + t.jitterMs) / MIN) * MIN;
          await runProactiveTick(now, deps(t, day, tickMinute));
        }
        // Один Brief на слот в день.
        const keys = turns.map((x) => `${x.day}:${x.slot}`);
        assert.equal(new Set(keys).size, keys.length, "two Briefs for a slot");
        for (const x of turns) {
          const since = x.minute - minuteOf(times[x.slot] ?? "");
          // Ход только в окне слота: от его времени до +3 ч того же дня.
          assert.ok(since >= 0 && since <= 180, "a Brief outside its window");
        }
        // Утренний слот, ход которого вернул текст или QUIET, всегда что-то прислал.
        const morning = turns.filter((x) => x.slot === 0);
        for (const x of morning)
          if (
            !sends.some((s) => s.day === x.day && s.slot === 0) &&
            ticks[x.day * 48 + x.minute / 30]?.reply !== "fail"
          )
            assert.fail("the morning Brief was silent");
        // Без пропусков и отказов каждый слот получает Brief каждый день: его тик — в его
        // же минуте, а более поздний слот того же тика забирает его только внутри окна.
        if (faultless)
          for (const day of [0, 1])
            for (const [slot, time] of times.entries()) {
              const covered = turns.some(
                (x) =>
                  x.day === day &&
                  (x.slot === slot ||
                    (x.minute >= minuteOf(time) &&
                      x.minute - minuteOf(time) <= 180)),
              );
              assert.ok(
                covered,
                `day ${day} slot ${slot} (${time}) got no Brief`,
              );
            }
      },
    ),
    { seed: SEED, numRuns: 60 },
  );
});

for (const english of [false, true])
  test(`r339 brief step ceiling reaches the owner, English=${english}`, async () => {
    const { failedModelEvents, reminderFromEvents } =
      await import("../fixtures/reminder-events.test-fixture.ts");
    const h = harness();
    h.english = english;
    h.reply = await reminderFromEvents(failedModelEvents());
    assert.equal(await runProactiveTick(at(8, 30), h.deps), 1);
    assert.deepEqual(
      h.sent.map((s) => s.part),
      [
        english
          ? "The review was not prepared. Stopped after 40 steps without a final summary."
          : "Обзор не собран. Остановилась на 40 шагах и не успела подвести итог.",
      ],
    );
  });
